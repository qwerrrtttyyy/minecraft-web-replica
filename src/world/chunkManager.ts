import * as THREE from 'three';
import type { GenThreads } from '../core/options';
import {
  CHUNK_SIZE,
  chunkKey,
  parseChunkKey,
  parseSectionKey,
  SECTION_HEIGHT,
  SECTIONS,
  type System,
  sectionKey,
  WORLD_HEIGHT,
} from '../core/types';
import type { TextureAtlas } from '../gfx/atlas';
import type { EventService } from '../services/events';
import { selectEvictions } from './chunkRetention';
import type { IWorldGenerator, TerrainOptions } from './generator';
import MeshWorker from './mesh.worker?worker&inline';
import { meshChunk } from './mesher';
import { buildMeshConfig, buildMeshSnapshot, WorldMeshSource } from './meshSource';
import {
  type GenResult,
  isStaleConfigRevision,
  MESH_CHANNELS,
  type MeshConfig,
  type MeshStats,
  type PackedGeo,
  type PackedMesh,
  packMesh,
  type SnapshotBuffers,
  type WorkerResponse,
} from './meshTypes';
import { installTiledAtlas } from './tiledAtlas';
import { createWorkerPool } from './workerPool';
import type { World } from './world';

/**
 * world.generator 可被 Worker 逐位复刻时的结构标记。
 * 自定义生成器（CraftAPI.setGenerator / 插件）没有这个标记，仍走主线程同步生成。
 */
interface WorkerGeneratable {
  readonly supportsWorkerGeneration: true;
  readonly workerConfig: { seed: number; ids: Record<string, number>; options: TerrainOptions };
}

/** 生成通道回传：结果或错误 */
type GenResponse = GenResult | Extract<WorkerResponse, { type: 'error' }>;

/** 结构识别「可被 Worker 复刻」的生成器；自定义生成器返回 null，保持主线程同步 */
function asWorkerGeneratable(gen: IWorldGenerator): WorkerGeneratable | null {
  const g = gen as Partial<WorkerGeneratable>;
  return g.supportsWorkerGeneration === true && g.workerConfig ? (g as WorkerGeneratable) : null;
}

interface ChunkMeshes {
  /** 该段当前几何的 quad 数：驻留统计在替换 / 卸载时做加减，避免累计值冒充当前开销 */
  quads: number;
  opaque?: THREE.Mesh;
  /** 仅对照路径（?emerge=0）下存在 */
  emissive?: THREE.Mesh;
  transparent?: THREE.Mesh;
  water?: THREE.Mesh;
}

interface InFlight {
  generation: number;
  /** M06：派发时的配置版本，用于丢弃 configRevision 之后到达的旧结果 */
  configRevision: number;
  /** 只有等待完成的调用方（预载）才需要 Promise；流式调度路径为 null，避免每帧白建 Promise */
  promise: Promise<void> | null;
  resolve: () => void;
}

/** 在途生成任务：key -> 代次与 Promise（异步生成路径） */
interface PendingGen {
  generation: number;
  promise: Promise<void>;
  resolve: () => void;
}

/** 每帧数据生成的时间预算（ms）：仅主线程同步回退路径适用 */
const GEN_BUDGET_MS = 4;
/** 每帧向生成池派发的区块数（Worker 路径开销极小，限流只为控制 pending 规模） */
const MAX_GEN_DISPATCH_PER_FRAME = 3;
/** 在途生成任务上限：超过后暂停派发新生成，优先让已有结果落地 */
const MAX_PENDING_GEN = 24;
/** 每帧最多派发多少个网格任务（section 粒度：18 段 ≈ 3.6 列；Worker 化后主线程只做快照与通信） */
const MAX_DISPATCH_PER_FRAME = 18;
/** 每帧允许派发的「视野外」刷新任务上限：玩家背对的方向给首次网格化让路 */
const MAX_OFFVIEW_DISPATCH_PER_FRAME = 6;
/**
 * 每帧「边界刷新」类派发总上限（不分视野）。
 * 生成一个新区块会回脏最多 8 个已网格化的邻居（边界面 AO / 角点光要重算），
 * 实测移动时这类刷新占了派发量的 ~71%，把首次网格化挤到排队 —— 限流保新鲜内容优先。
 */
const MAX_REFRESH_DISPATCH_PER_FRAME = 8;
/** 视野判定：区块中心相对相机的方向与视线点积高于此值视为视野内 */
const VIEW_DOT_THRESHOLD = 0.2;
/** dirty + 在途任务积压上限：超过后暂停生成，优先消化网格队列 */
export const BACKLOG_LIMIT = 80;
/** initialLoad 等待 Worker 的兜底超时（ms），超时自动降级主线程 */
const LOAD_TIMEOUT_MS = 15000;
/** 视距之外的驻留区块上限（可通过 ?maxChunks=N 覆盖） */
const DEFAULT_MAX_RESIDENT = 512;
/** 缓冲区硬外沿相对视距的额外圈数：超出后无条件卸载 */
const DEFAULT_RETENTION_MARGIN = 8;
/** 区块最短驻留时间（秒）：缓冲区 LRU 淘汰的前置条件 */
const DEFAULT_MIN_RESIDENCY_SEC = 10;

export interface ChunkManagerOptions {
  /** 强制主线程同步网格化（对照基准 / 调试 / file:// 回退） */
  forceMainThread?: boolean;
  /** 关闭 Greedy Meshing（对照基准） */
  greedy?: boolean;
  /** 自发光并入不透明通道（默认 true）；false = 保留独立 emissive 通道，仅作实验对照 */
  mergeEmissive?: boolean;
  /** 网格化 Worker 池大小覆盖（默认按 navigator.hardwareConcurrency 推断，?workers=N 传入） */
  workers?: number;
  /** 地形生成 Worker 池大小覆盖（默认取 min(2, 网格池-1)，?genWorkers=N 传入；0 = 不启用） */
  genWorkers?: number;
  /** 相机：用于透明通道按几何距离排序（不传则退化为固定 renderOrder） */
  camera?: THREE.Camera;
  /** 驻留区块总上限（视距内优先保留），默认 512；URL ?maxChunks=N */
  maxChunks?: number;
  /** 缓冲区硬外沿相对视距的额外圈数，默认 8 */
  retentionMargin?: number;
  /** 区块最短驻留秒数（缓冲区 LRU 淘汰前置条件），默认 10 */
  minResidencySec?: number;
}

/**
 * 区块网格的解析包围球半径：所有顶点都在本地 16×H×16 盒内，
 * 取盒的外接球（中心 8,H/2,8）比 computeBoundingSphere 逐顶点扫描更快，且对剔除而言足够紧。
 */
const SECTION_BOUND_RADIUS = Math.hypot(CHUNK_SIZE / 2, SECTION_HEIGHT / 2, CHUNK_SIZE / 2);

const buildGeo = (p: PackedGeo): THREE.BufferGeometry => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(p.uvs, 2));
  // 每顶点明暗（面定向 × AO）：RGB 三通道同值，单分量即可
  g.setAttribute('aShade', new THREE.BufferAttribute(p.shade, 1));
  // 每顶点天空光 / 方块光，shader 与昼夜系数、太阳色一起决定最终亮度
  g.setAttribute('aLight', new THREE.BufferAttribute(p.lights, 2));
  // 每个顶点的图集 tile 起点，shader 用 fract(局部UV) × uTileSize 平铺
  g.setAttribute('aTileOrigin', new THREE.BufferAttribute(p.tile, 2));
  // 每个顶点的开关：0 普通 / 1 群系染色 / 2 自发光（不受光照与染色影响）
  g.setAttribute('aTint', new THREE.BufferAttribute(p.tints, 1));
  // 每个顶点的风摆权重（0~1）：底部 0 / 顶部随植物高度，只对十字面植物生效
  g.setAttribute('aSway', new THREE.BufferAttribute(p.sways, 1));
  g.setIndex(new THREE.BufferAttribute(p.indices, 1));
  // 解析包围球（局部坐标）：替代逐顶点 computeBoundingSphere，移动场景每次重网格都省一次 O(顶点数) 扫描
  g.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(CHUNK_SIZE / 2, SECTION_HEIGHT / 2, CHUNK_SIZE / 2),
    SECTION_BOUND_RADIUS,
  );
  return g;
};

/** 把天空光/方块光注入 MeshBasicMaterial：天空光随昼夜变化，方块光恒定 */
interface ChunkShader {
  uniforms: Record<string, THREE.IUniform>;
  vertexShader: string;
  fragmentShader: string;
}

/**
 * 群系植被染色（草 / 叶 / 藤蔓）：灰度纹理 × 世界坐标噪声群系色。
 *
 * 纹理在图集里画成灰度（atlas.ts 的 gray()），这里按世界 XZ 的双层值噪声
 * 在「冷绿 / 基准绿 / 暖黄绿」之间平滑过渡，模拟群系色带；每株植物之间再叠
 * 一层中频噪声打散边界。aTint 顶点属性做门控（只有 tint 方块参与），
 * 草方块侧面的泥土保留彩色，用饱和度掩膜只染灰度条带。
 *
 * aTint 同时兼作「自发光」开关（=2）：萤石 / 南瓜灯 / 火把不再单独开通道，
 * 而是复用不透明材质，shader 见到 2 就跳过光照与染色。
 */
const FOLIAGE_GLSL = `
float foliageHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float foliageNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(foliageHash(i), foliageHash(i + vec2(1.0, 0.0)), f.x),
    mix(foliageHash(i + vec2(0.0, 1.0)), foliageHash(i + vec2(1.0, 1.0)), f.x),
    f.y);
}
vec3 foliageTint(vec2 wxz) {
  float band = foliageNoise(wxz * 0.012);
  // 注意：patch 是 GLSL ES 保留字（细分着色器），不可作变量名
  float patchN = foliageNoise(wxz * 0.055 + 17.3);
  vec3 cool = vec3(0.72, 1.06, 0.70);
  vec3 base = vec3(0.92, 1.18, 0.58);
  vec3 warm = vec3(1.12, 1.14, 0.50);
  vec3 t = mix(cool, base, smoothstep(0.25, 0.62, band));
  t = mix(t, warm, smoothstep(0.58, 0.88, band));
  return t * (1.0 - 0.10 * patchN);
}
`;

/**
 * 对照路径（?emerge=0）专用的旧 emissive 材质注入：只乘面定向 × AO，不参与光照。
 * 与 v1.5.1 的独立 emissive 通道行为一致，用于 E3 的 A/B 对照。
 */
function injectLegacyEmissive(shader: ChunkShader) {
  shader.vertexShader =
    'attribute float aShade;\nvarying float vShade;\n' +
    shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvShade = aShade;');
  shader.fragmentShader =
    'varying float vShade;\n' +
    shader.fragmentShader.replace(
      '#include <color_fragment>',
      '#include <color_fragment>\n\tdiffuseColor.rgb *= vShade;',
    );
}

function injectLight(shader: ChunkShader, daylight: { value: number }, sunTint: { value: THREE.Color }) {
  shader.uniforms.uDaylight = daylight;
  shader.uniforms.uSunTint = sunTint;
  shader.vertexShader =
    'attribute vec2 aLight;\nattribute float aTint;\nattribute float aShade;\nvarying vec2 vLight;\nvarying float vTint;\nvarying float vShade;\nvarying vec3 vFolPos;\n' +
    shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n\tvLight = aLight;\n\tvTint = aTint;\n\tvShade = aShade;\n\tvFolPos = (modelMatrix * vec4(position, 1.0)).xyz;',
    );
  shader.fragmentShader =
    'varying vec2 vLight;\nvarying float vTint;\nvarying float vShade;\nvarying vec3 vFolPos;\nuniform float uDaylight;\nuniform vec3 uSunTint;\n' +
    FOLIAGE_GLSL +
    shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
    // 顶点开关：1 = 群系染色，2 = 自发光（等价于旧的独立 emissive 材质）
    float unlit = step(1.5, vTint);
    // 植被掩膜：必须在光照染色之前采样饱和度，否则天空/太阳色会把灰度误判成彩色
    float folMx = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b));
    float folMn = min(diffuseColor.r, min(diffuseColor.g, diffuseColor.b));
    float folMask = (1.0 - unlit) * step(0.5, vTint)
      * (1.0 - smoothstep(0.10, 0.22, folMx > 0.0 ? (folMx - folMn) / folMx : 0.0));
    vec3 folTint = foliageTint(vFolPos.xz);
    float skyPart = vLight.x * uDaylight;
    float lit = max(skyPart, vLight.y);
    float blockLit = smoothstep(0.0, 0.08, vLight.y - skyPart);
    vec3 skyTint = mix(vec3(0.56, 0.65, 0.94), vec3(1.0), clamp(uDaylight * 1.35, 0.0, 1.0));
    vec3 lightTint = mix(skyTint * uSunTint, vec3(1.0), blockLit);
    // 自发光不参与光照，但保留面定向 × AO 的明暗（与旧 emissive 通道的观感一致）
    diffuseColor.rgb *= mix(vShade * (0.07 + 0.93 * lit) * lightTint, vec3(vShade), unlit);
    diffuseColor.rgb *= mix(vec3(1.0), folTint, folMask);`,
    );
}

/**
 * 植物风摆：aSway 为每顶点权重（底部 0 → 顶部 = 植物高度）。
 * 位移完全由世界坐标 + 时间驱动，因此相邻区块的接缝处相位连续；
 * 普通方块 aSway=0，水面与地形不受影响。
 */
function injectSway(shader: ChunkShader, time: { value: number }) {
  shader.uniforms.uSwayTime = time;
  shader.vertexShader =
    'attribute float aSway;\nuniform float uSwayTime;\n' +
    shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
    if (aSway > 0.0) {
      vec3 swayPos = (modelMatrix * vec4(position, 1.0)).xyz;
      float phase = swayPos.x * 0.63 + swayPos.z * 0.71;
      transformed.x += sin(uSwayTime * 1.35 + phase) * aSway * 0.055;
      transformed.z += cos(uSwayTime * 1.12 + phase * 1.27) * aSway * 0.038;
    }`,
    );
}

/**
 * 区块流式加载：按玩家位置生成 / 网格化 / 卸载。
 *
 * v1.3.0：网格化默认在 Worker 中执行（?worker&inline 的 Blob Worker，
 * 兼容单文件 file:// 产物）。主线程每帧只做：生成区块数据、构建 halo 快照、
 * 派发任务、收割结果、建 GPU 几何。若 Worker 无法创建或报错，自动回退
 * 主线程同步路径，保证 dist/index.html 双击仍可玩。
 *
 * v1.3.0：网格化 Worker 升级为**池**（默认 min(hardwareConcurrency-1, 4)，
 * ?workers=N 可覆盖），用 least-busy 把任务摊到多个 Worker，解除单 Worker 吞吐上限；
 * 任一 Worker 失败即整体回退主线程。结果按 wid 回显计数，保证计数与派发一致。
 */
export class ChunkManager implements System {
  readonly name = 'chunks';
  renderDistance: number;
  /** 驻留区块总上限（视距内区块不因上限被淘汰） */
  readonly maxResident: number;
  private readonly retentionMargin: number;
  private readonly minResidencySec: number;
  /** 已释放资源标记：dispose() 幂等，update() 在释放后不再调度 */
  private disposed = false;
  readonly materials: {
    opaque: THREE.MeshBasicMaterial;
    /** 仅 ?emerge=0 对照路径使用 */
    emissive: THREE.MeshBasicMaterial;
    transparent: THREE.MeshBasicMaterial;
    water: THREE.MeshBasicMaterial;
  };
  /** 昼夜强度（0~1），由 Sky 每帧写入 shader */
  readonly lightUniform = { value: 1 };
  /** 太阳颜色，日出/日落时给天空光染色 */
  readonly sunTint = { value: new THREE.Color(1, 1, 1) };
  private waterTime = { value: 0 };
  private meshes = new Map<string, ChunkMeshes>();
  private centerX = 0;
  private centerZ = 0;
  private genSpiral: [number, number][] = [];
  private spiralRadius = -1;
  /** initialLoad() 期间为 true：主循环不得并发消费 dirty */
  private loading = false;

  // ---- Worker 调度状态 ----
  private workers: Worker[] = [];
  /** 每个 Worker 当前在途任务数，用于 least-busy 派发 */
  private busy: number[] = [];
  /** 每个 Worker 已确认的配置 revision（-1 表示尚未收到 config） */
  private workerConfig: number[] = [];
  private mode: 'worker' | 'main' = 'worker';
  private greedyOption: boolean;
  private mergeEmissiveOption: boolean;
  private config: MeshConfig | null = null;
  private configRevision = 0;
  private generation = 0;
  private inFlight = new Map<string, InFlight>();
  /** 视距外的脏标记暂存区：驻留网格可能在 R+2..R+8，配置失效后仍需靠近时重网格化 */
  private deferredDirty = new Set<string>();

  // ---- 地形生成 Worker 池（与网格化池相互独立，避免互相抢活）----
  private genWorkers: Worker[] = [];
  /** 每个生成 Worker 当前在途任务数，用于 least-busy 派发 */
  private genBusy: number[] = [];
  /** main = 同步回退（自定义生成器 / 池构造失败 / 运行期错误） */
  private genMode: 'worker' | 'main' = 'main';
  /** 复刻生成器所需配置（构造期一次性取自 world.generator） */
  private genConfig: WorkerGeneratable['workerConfig'] | null = null;
  /** world.generator 是否可被 Worker 复刻（自定义生成器为 false，永远走主线程） */
  private genSupported = false;
  private pendingGen = new Map<string, PendingGen>();
  private pendingResults: WorkerResponse[] = [];
  private totals: MeshStats & { chunks: number } = { quads: 0, vertices: 0, merged: 0, ms: 0, chunks: 0 };

  // ---- 透明通道按几何距离排序（解决玻璃/水叠加穿帮） ----
  private camera: THREE.Camera | null = null;
  private sortTmp = new THREE.Vector3();
  private camWorld = new THREE.Vector3();
  private lastSortCam = new THREE.Vector3(Infinity, Infinity, Infinity);
  private sortAcc = 0;
  private backpressureAcc = 0;
  private sortDirty = true;
  /** 列级「是否已有任意 section 网格」：meshCount / 诊断统计用，避免每次遍历 5 个 section */
  private readonly meshedColumns = new Set<string>();
  /** 自愈扫描节流：每 0.25s 一次，不必每帧翻 512 列 × 5 段 */
  private healAcc = 0;
  /**
   * 快照缓冲池：Worker 用完把 data/sky/block 原路 transfer 回来，
   * 下一帧派发直接复用。池上限 = 同时在途任务的合理峰值，避免无限增长。
   */
  private readonly snapshotPool: SnapshotBuffers[] = [];
  /** 当前驻留几何的 quad / 顶点数：替换与卸载时加减，供诊断使用 */
  private residentQuads = 0;
  private residentVertices = 0;
  /** 实验性玩法「透明排序」：false 时不做距离排序，透明网格用固定 renderOrder=2 */
  transparentSortEnabled = true;
  private sortWasEnabled = true;
  private transparentOrderCache: { key: string; pass: 'transparent' | 'water'; dist: number; order: number }[] = [];

  constructor(
    private world: World,
    private scene: THREE.Scene,
    private atlas: TextureAtlas,
    private events: EventService,
    renderDistance: number,
    options: ChunkManagerOptions = {},
  ) {
    this.renderDistance = renderDistance;
    const requestedCap = options.maxChunks ?? DEFAULT_MAX_RESIDENT;
    const requestedMargin = options.retentionMargin ?? DEFAULT_RETENTION_MARGIN;
    const requestedResidency = options.minResidencySec ?? DEFAULT_MIN_RESIDENCY_SEC;
    this.maxResident = Number.isFinite(requestedCap) ? Math.max(1, Math.floor(requestedCap)) : DEFAULT_MAX_RESIDENT;
    this.retentionMargin = Number.isFinite(requestedMargin)
      ? Math.max(2, Math.floor(requestedMargin))
      : DEFAULT_RETENTION_MARGIN;
    this.minResidencySec = Number.isFinite(requestedResidency)
      ? Math.max(0, requestedResidency)
      : DEFAULT_MIN_RESIDENCY_SEC;
    this.greedyOption = options.greedy ?? true;
    this.mergeEmissiveOption = options.mergeEmissive ?? true;
    this.camera = options.camera ?? null;
    this.materials = {
      // 明暗走 aShade 单分量，不再需要 vertexColors
      opaque: new THREE.MeshBasicMaterial({ map: atlas.texture, alphaTest: 0.5 }),
      // 仅在对照路径（?emerge=0）下被使用；默认路径不自发光几何，不会编译出 program
      emissive: new THREE.MeshBasicMaterial({ map: atlas.texture, alphaTest: 0.5 }),
      transparent: new THREE.MeshBasicMaterial({
        map: atlas.texture,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
      water: new THREE.MeshBasicMaterial({
        map: atlas.texture,
        transparent: true,
        opacity: 0.78,
        // N4：显式声明深度测试；保持 depthWrite:false / DoubleSide 以维持水下可读性
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    };
    // 不透明 / 半透明通道：烘焙光照 + 昼夜天空光
    for (const mat of [this.materials.opaque, this.materials.transparent]) {
      mat.onBeforeCompile = (shader) => injectLight(shader, this.lightUniform, this.sunTint);
    }
    // 水面：光照 + 世界坐标驱动的微波动画（跨区块连续）
    this.materials.water.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.waterTime;
      injectLight(shader, this.lightUniform, this.sunTint);
      shader.vertexShader =
        'uniform float uTime;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
        vec3 wPos = (modelMatrix * vec4(position, 1.0)).xyz;
        // N4：把波动夹紧到 ±0.02，水面顶点不再越过方块边界形成细蓝边 / 与岩石近共面闪烁。
        // 动画节奏、透明度与高光保持不变（Q5）。
        float wave = sin(wPos.x * 0.9 + uTime * 1.7) * 0.028 + cos(wPos.z * 1.1 + uTime * 1.3) * 0.028;
        transformed.y += clamp(wave, -0.02, 0.02);`,
        );
    };
    // 对照路径的旧 emissive 通道：只乘面明暗，不参与光照
    if (!this.mergeEmissiveOption) {
      this.materials.emissive.onBeforeCompile = (shader) => injectLegacyEmissive(shader);
    }
    // 植物风摆：不透明 / 半透明通道（v1.5.1 起自发光已并入不透明，无需单独注入）；
    // 水面另有波动，不叠加
    for (const ch of ['opaque', 'transparent'] as const) {
      const prev = this.materials[ch].onBeforeCompile;
      this.materials[ch].onBeforeCompile = (shader, renderer) => {
        prev?.call(this.materials[ch], shader, renderer);
        injectSway(shader, this.waterTime);
      };
    }
    // 各通道统一安装图集平铺（会串联 water 已有的 onBeforeCompile）
    for (const ch of MESH_CHANNELS) installTiledAtlas(this.materials[ch]);

    if (options.forceMainThread) {
      this.mode = 'main';
    } else {
      this.spawnWorkers(ChunkManager.decidePoolSize(options.workers));
    }
    this.getConfig(); // 建立低频配置并向所有 Worker 下发
    // 地形生成池：仅当 world.generator 可被 Worker 逐位复刻且未强制主线程时启用；
    // 自定义生成器（插件替换）没有标记，保持主线程同步生成，行为完全不变。
    const generatable = asWorkerGeneratable(this.world.generator);
    this.genSupported = !!generatable;
    if (!options.forceMainThread && generatable) {
      // ids 必须给全量表：构造器除 30 个规范名外，群系 profile 还会按名查 surface /
      // filler / plants / strata 等，只带 this.ids 会让这些查询在 Worker 里退化成 0
      const cfg = generatable.workerConfig;
      const ids: Record<string, number> = {};
      for (const b of this.world.registry.all()) ids[b.name] = b.id;
      this.genConfig = { seed: cfg.seed, ids, options: cfg.options };
      this.spawnGenWorkers(ChunkManager.decideGenPoolSize(options.genWorkers, this.workers.length));
    }
  }

  /** 建立 Worker 池；构造不完整时整体回退主线程，不留「部分 Worker」残池 */
  private spawnWorkers(want: number): void {
    // 构造期失败统一由 createWorkerPool 回滚：不再留下「部分 Worker + worker 模式」的残池
    const pool = createWorkerPool(MeshWorker, want);
    if (pool.partial) {
      console.warn('[mesher] Worker 池构造不完整，整体回退主线程同步网格化');
      this.fallbackToMain();
      return;
    }
    this.mode = 'worker';
    for (const w of pool.workers) {
      w.onmessage = (e: MessageEvent<WorkerResponse>) => {
        this.pendingResults.push(e.data);
      };
      w.onerror = (e) => {
        console.warn('[mesher] Worker 运行失败，回退主线程同步网格化：', e.message);
        this.fallbackToMain();
      };
      this.workers.push(w);
      this.busy.push(0);
      this.workerConfig.push(-1);
    }
  }

  /** 推断生成 Worker 池规模：默认从网格池里匀出 1~2 个，避免小核机开太多线程 */
  private static decideGenPoolSize(override: number | undefined, meshWorkers: number): number {
    if (override !== undefined) return Math.max(0, Math.min(4, Math.floor(override)));
    return Math.max(1, Math.min(2, Math.max(1, meshWorkers - 1)));
  }

  /** 建立生成 Worker 池；构造不完整时整体回退主线程同步生成（不影响网格化池） */
  private spawnGenWorkers(want: number): void {
    if (want <= 0) return;
    const pool = createWorkerPool(MeshWorker, want);
    if (pool.partial) {
      console.warn('[worldgen] 生成 Worker 池构造不完整，回退主线程同步生成');
      return;
    }
    this.genMode = 'worker';
    const cfg = this.genConfig as WorkerGeneratable['workerConfig'];
    for (const w of pool.workers) {
      // 两个池共用 pendingResults 缓冲，靠消息上的 channel 分流
      w.onmessage = (e: MessageEvent<WorkerResponse>) => {
        this.pendingResults.push(e.data);
      };
      w.onerror = (e) => {
        console.warn('[worldgen] 生成 Worker 运行失败，回退主线程同步生成：', e.message);
        this.fallbackGenToMain();
      };
      this.genWorkers.push(w);
      this.genBusy.push(0);
    }
    for (let i = 0; i < this.genWorkers.length; i++) {
      this.genWorkers[i].postMessage({ type: 'genConfig', config: cfg, wid: i });
    }
  }

  /**
   * 运行期调整地形生成线程（设置页）：
   * auto 按当前网格池规模推断，0 = 主线程同步。切换会先结算在途任务再重建池。
   */
  setGenThreads(spec: GenThreads): void {
    this.teardownGenWorkers();
    this.genMode = 'main';
    if (!this.genSupported || !this.genConfig) return;
    const want = spec === 'auto' ? ChunkManager.decideGenPoolSize(undefined, Math.max(1, this.workers.length)) : spec;
    if (want <= 0) return;
    this.spawnGenWorkers(want);
  }

  /** 销毁生成池；在途生成任务立即结算，区块由同步路径重新认领 */
  private teardownGenWorkers(): void {
    for (const w of this.genWorkers) {
      try {
        w.terminate();
      } catch {
        /* 已销毁 */
      }
    }
    this.genWorkers = [];
    this.genBusy = [];
    // 只丢弃生成通道的回传，网格池的消息必须保留
    this.pendingResults = this.pendingResults.filter((m) => {
      if (m.type === 'genResult') return false;
      if (m.type === 'error' && m.channel === 'gen') return false;
      return true;
    });
    for (const rec of this.pendingGen.values()) rec.resolve();
    this.pendingGen.clear();
  }

  /** 生成池整体失效：后续区块改由主线程同步生成 */
  private fallbackGenToMain(): void {
    if (this.genMode === 'main') return;
    this.genMode = 'main';
    this.teardownGenWorkers();
  }

  /** 销毁当前 Worker 池；在途任务立即改由主线程补算，避免 Promise 永挂 */
  private teardownWorkers(): void {
    for (const w of this.workers) {
      try {
        w.terminate();
      } catch {
        /* 已销毁 */
      }
    }
    this.workers = [];
    this.busy = [];
    this.workerConfig = [];
    // 旧池的回传消息不能再计入新池的 busy / config，直接丢弃
    this.pendingResults.length = 0;
    const pending = [...this.inFlight.entries()];
    this.inFlight.clear();
    for (const [key, rec] of pending) {
      const [cx, sy, cz] = parseSectionKey(key);
      this.applySync(cx, sy, cz);
      rec.resolve();
    }
    // 重建池后必须让 getConfig() 重新下发配置：新 Worker 的 config 初始为 null，
    // 只有收到 config 才会排空 mesh.worker.ts 的 queued。若这里不置空，
    // getConfig() 会直接返回旧对象、不触发 postConfig()，新池将永远收不到配置。
    this.config = null;
  }

  /**
   * 开发者设置：运行期调整网格化线程数。
   * 0 = 主线程同步网格化；1~8 = 重建对应规模的 Worker 池。
   * 重建期间在途任务由主线程补算，已有网格保留，不会丢区块。
   */
  setWorkerPoolSize(want: number): void {
    const n = Math.max(0, Math.min(8, Math.floor(want)));
    if (n === 0) {
      if (this.mode !== 'main') this.fallbackToMain();
      return;
    }
    if (this.mode === 'worker' && this.workers.length === n) return;
    this.teardownWorkers();
    this.spawnWorkers(n);
    this.getConfig();
  }

  /** 自动档推荐的 Worker 池规模（设置页展示用） */
  recommendedPoolSize(): number {
    return ChunkManager.decidePoolSize(undefined);
  }

  // ---- 可观测状态（调试面板 / 自动化测试 / 性能基准） ----
  get meshCount() {
    return this.meshedColumns.size;
  }
  /** 已网格化的 section 数（诊断用：一列最多 5 个） */
  get sectionMeshCount() {
    return this.meshes.size;
  }
  /** 当前驻留区块总数（诊断 / 基准用） */
  get residentCount() {
    return this.world.chunks.size;
  }
  get isLoading() {
    return this.loading;
  }
  get mesherMode(): 'worker' | 'main' {
    return this.mode;
  }
  get workerCount(): number {
    return this.workers.length;
  }
  get inFlightCount() {
    return this.inFlight.size;
  }
  /** 在途地形生成任务数（诊断 / 基准用） */
  get genPendingCount() {
    return this.pendingGen.size;
  }
  /** 生成 Worker 池规模（诊断用；0 = 未启用 / 已回退） */
  get genWorkerCount() {
    return this.genWorkers.length;
  }
  /** 地形生成通道：worker = 异步，main = 主线程同步回退 */
  get generationMode(): 'worker' | 'main' {
    return this.genMode;
  }
  get meshStats() {
    // quads / vertices / chunks 反映「当前驻留几何」，用于诊断每区块 quad 预算；
    // merged / ms 是累计工作量，排查合并收益与耗时用。
    return {
      ...this.totals,
      quads: this.residentQuads,
      vertices: this.residentVertices,
      chunks: this.meshedColumns.size,
    };
  }
  /** 运行时诊断：所有 Worker 是否都已确认当前配置 */
  get configReady(): boolean {
    if (this.config === null) return false;
    if (this.mode === 'main') return true;
    return this.workers.length > 0 && this.workers.every((_, i) => this.workerConfig[i] === this.configRevision);
  }
  get configRevisionValue(): number {
    return this.configRevision;
  }
  /** 运行时诊断：该区块是否已有网格 / 是否在途 */
  hasMesh(cx: number, cz: number): boolean {
    return this.meshedColumns.has(chunkKey(cx, cz));
  }
  hasInFlight(cx: number, cz: number): boolean {
    for (let sy = 0; sy < SECTIONS; sy++) {
      if (this.inFlight.has(sectionKey(cx, sy, cz))) return true;
    }
    return false;
  }
  /** 透明/水通道的当前排序结果（按几何中心到相机距离远→近），用于调试与自动化断言 */
  get transparentOrder() {
    return this.transparentOrderCache.map((e) => ({ ...e }));
  }
  /** 排序条目数：调试面板只读长度，不必为拿长度复制整张表 */
  get transparentOrderCount() {
    return this.transparentOrderCache.length;
  }
  /** 每个 Worker 当前在途任务数（诊断用） */
  get workerBusy(): number[] {
    return [...this.busy];
  }
  get greedy() {
    return this.getConfig().greedy;
  }
  set greedy(v: boolean) {
    if (this.greedyOption === v) return;
    this.greedyOption = v;
    this.invalidateConfig();
  }

  /**
   * 方块/纹理注册变化后必须调用，否则 Worker 仍用旧元数据。
   *
   * v1.3.2 修复：旧实现只把 config 置 null 后调用 postConfig()，而 postConfig
   * 在 config 为 null 时会直接返回 —— Worker 永远收不到新配置；Worker 派发路径
   * 又不会调用 getConfig()。现在立即重建并下发，同时把所有已有网格重新入队。
   */
  invalidateConfig(): void {
    this.config = null;
    this.configRevision++;
    this.getConfig(); // 重建 + postConfig 下发给所有 Worker
    for (const key of this.meshes.keys()) this.world.dirty.add(key);
  }

  private getConfig(): MeshConfig {
    if (!this.config) {
      this.config = buildMeshConfig(
        this.world.registry,
        this.atlas,
        this.greedyOption,
        this.configRevision,
        this.mergeEmissiveOption,
      );
      this.postConfig();
    }
    return this.config;
  }

  private postConfig(): void {
    if (this.workers.length && this.config) {
      for (let i = 0; i < this.workers.length; i++) {
        this.workers[i].postMessage({ type: 'config', config: this.config, wid: i });
      }
    }
  }

  /**
   * 推断 Worker 池大小：默认按 CPU 核数留 1 给主线程、上限 4（避免小核机反而更慢）；
   * 传 override（?workers=N）时直接取 1..8 的夹紧值，便于基准对照。
   */
  private static decidePoolSize(override?: number): number {
    if (override && override >= 1) return Math.min(Math.max(1, Math.floor(override)), 8);
    const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    return Math.max(1, Math.min(hc - 1, 4));
  }

  private takeSnapshots(): SnapshotBuffers | undefined {
    return this.snapshotPool.pop();
  }

  private recycleSnapshots(buffers: ArrayBuffer[] | undefined): void {
    if (!buffers || buffers.length < 3 || this.snapshotPool.length >= 12) return;
    const data = new Uint8Array(buffers[0]);
    const sky = new Uint8Array(buffers[1]);
    const block = new Uint8Array(buffers[2]);
    // 尺寸不符（配置变更 / 旧版本回传）就不回收，宁可丢给 GC
    if (data.length !== sky.length || data.length !== block.length) return;
    const expected = (CHUNK_SIZE + 2) * (SECTION_HEIGHT + 2) * (CHUNK_SIZE + 2);
    if (data.length !== expected) return;
    this.snapshotPool.push({ data, sky, block });
  }

  /** 选最空闲的 Worker（在途任务数最少），并记一笔在途 */
  private pickWorker(): number {
    let best = 0;
    for (let i = 1; i < this.busy.length; i++) if (this.busy[i] < this.busy[best]) best = i;
    this.busy[best]++;
    return best;
  }

  private fallbackToMain(): void {
    if (this.mode === 'main') return;
    this.mode = 'main';
    this.teardownWorkers();
  }

  setCenter(x: number, z: number) {
    this.centerX = Math.floor(x / CHUNK_SIZE);
    this.centerZ = Math.floor(z / CHUNK_SIZE);
  }

  /** 生成螺旋顺序（由近及远） */
  private spiral(radius: number): [number, number][] {
    if (this.spiralRadius === radius) return this.genSpiral;
    const list: [number, number][] = [];
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (dx * dx + dz * dz <= radius * radius + 1) list.push([dx, dz]);
      }
    }
    list.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));
    this.genSpiral = list;
    this.spiralRadius = radius;
    return list;
  }

  /**
   * 请求一个区块的网格；同一 key 在途时复用记录（代次去重）。
   * wantPromise=false（流式调度的常态）时不分配 Promise，只有预载等待才要。
   */
  private requestMesh(cx: number, cz: number, sy: number, wantPromise = false): Promise<void> | null {
    const key = sectionKey(cx, sy, cz);
    const existing = this.inFlight.get(key);
    if (existing) return wantPromise ? (existing.promise ?? this.adoptInFlight(existing)) : null;
    const generation = ++this.generation;
    const configRevision = this.configRevision;
    let resolve: () => void = () => {};
    const promise = wantPromise
      ? new Promise<void>((r) => {
          resolve = r;
        })
      : null;
    this.inFlight.set(key, { generation, configRevision, promise, resolve });
    // 网格调度是"有意义访问"：刷新 LRU 时钟，让缓冲区保留玩家真正看过的区块
    this.world.touchChunk(cx, cz);

    if (this.mode === 'main') {
      // H05：主线程路径必须兜住异常——applySync 抛错时若不释放 inFlight，
      // 该 key 永久卡在途，backlog 涨满后整条生成流停摆（initialLoad 则永挂黑屏）
      try {
        this.applySync(cx, sy, cz);
      } catch (e) {
        console.error(`[mesher] 主线程网格化失败 (${cx},${sy},${cz})，跳过该分段：`, e);
      }
      this.inFlight.delete(key);
      resolve();
    } else {
      // 防御性保证：任何 Worker 任务发出前，配置已构建并下发。
      // （invalidateConfig 现在会立即重建，但这里兜住未来新增的调用路径）
      this.getConfig();
      const wid = this.pickWorker();
      const snapshot = buildMeshSnapshot(this.world, cx, cz, sy, this.takeSnapshots());
      // known 为 null（9 格全已知）时不转移，Worker 侧按全已知处理
      const transfer = [snapshot.data.buffer, snapshot.sky.buffer, snapshot.block.buffer];
      if (snapshot.known) transfer.push(snapshot.known.buffer);
      this.workers[wid].postMessage(
        { type: 'mesh', cx, cz, sy, generation, configRevision, snapshot, wid },
        // N4：known 位图与 data 同步转移，避免 Worker 侧收到丢失/复制的来源信息
        transfer,
      );
    }
    return promise;
  }

  /** 给已在途但没有 Promise 的记录补一个等待者（预载与流式派发撞车时） */
  private adoptInFlight(rec: InFlight): Promise<void> {
    let done!: () => void;
    const promise = new Promise<void>((r) => {
      done = r;
    });
    const prev = rec.resolve;
    rec.resolve = () => {
      prev();
      done();
    };
    rec.promise = promise;
    return promise;
  }

  /**
   * 尝试派发一个脏区块（三段优先级循环共用）。
   * 未生成 / 已在途的保留脏标记等下一帧；返回是否真正发出。
   */
  private tryDispatch(cx: number, sy: number, cz: number): boolean {
    const key = sectionKey(cx, sy, cz);
    // 未生成的区块保留脏标记等下一帧
    if (!this.world.getChunk(cx, cz)?.generated) return false;
    if (this.inFlight.has(key)) return false;
    this.world.dirty.delete(key);
    this.requestMesh(cx, cz, sy);
    return true;
  }

  /**
   * 请求一个区块的地形数据。Worker 模式异步入队；同步回退直接 ensureChunk。
   * 同一 key 在途时复用 Promise（代次去重）。
   */
  private requestGenerate(cx: number, cz: number): Promise<void> {
    const key = chunkKey(cx, cz);
    const existing = this.pendingGen.get(key);
    if (existing) return existing.promise;
    if (this.genMode !== 'worker') {
      try {
        this.world.ensureChunk(cx, cz);
      } catch (e) {
        console.error(`[worldgen] 主线程同步生成失败 (${cx}, ${cz})：`, e);
      }
      return Promise.resolve();
    }
    const generation = ++this.generation;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.pendingGen.set(key, { generation, promise, resolve });
    const wid = this.pickGenWorker();
    this.genWorkers[wid].postMessage({ type: 'gen', cx, cz, generation, wid });
    return promise;
  }

  /** 选最空闲的生成 Worker（在途任务数最少），并记一笔在途 */
  private pickGenWorker(): number {
    let best = 0;
    for (let i = 1; i < this.genBusy.length; i++) if (this.genBusy[i] < this.genBusy[best]) best = i;
    this.genBusy[best]++;
    return best;
  }

  /**
   * 处理生成通道回传：落地 data / 丢弃过期与已卸载区块 / 失败回退主线程补算。
   * 结果与请求跨帧配对，因此过期代次直接丢，不能沿用网格通道的“重排 dirty”策略。
   */
  private drainGen(msg: GenResponse): void {
    if (msg.wid != null && this.genBusy[msg.wid] > 0) this.genBusy[msg.wid]--;
    const key = chunkKey(msg.cx, msg.cz);
    const rec = this.pendingGen.get(key);
    if (!rec || rec.generation !== msg.generation) {
      // genConfig 初始化失败的广播错误（合成坐标 0,0）：整体回退主线程生成
      if (msg.type === 'error' && msg.cx === 0 && msg.cz === 0) this.fallbackGenToMain();
      return;
    }
    this.pendingGen.delete(key);
    if (msg.type === 'genResult') {
      // 已被同步路径抢先生成（回退窗口）：丢弃 Worker 结果，避免重复初始化
      if (this.world.chunks.has(key)) {
        rec.resolve();
        return;
      }
      try {
        this.world.acceptGeneratedChunk(msg.cx, msg.cz, msg.data);
      } catch (e) {
        console.error(`[worldgen] 生成结果落地失败 (${msg.cx}, ${msg.cz})，主线程补算：`, e);
        try {
          this.world.ensureChunk(msg.cx, msg.cz);
        } catch {
          /* 已记录，跳过该区块 */
        }
      }
    } else {
      console.error('[worldgen] 区块生成失败，主线程补算：', msg.message);
      try {
        this.world.ensureChunk(msg.cx, msg.cz);
      } catch {
        /* 已记录，跳过该区块 */
      }
    }
    rec.resolve();
  }

  /** 收割 Worker 回传：丢弃过期代次与已卸载区块 */
  private drainResults(): void {
    if (this.pendingResults.length === 0) return;
    // 交换空数组替代 splice(0)：省掉每帧一次 O(n) 元素拷贝与临时数组分配
    const batch = this.pendingResults;
    this.pendingResults = [];
    for (const msg of batch) {
      // 配置回执不占派发计数，先处理并跳过
      if (msg.type === 'config-ack') {
        if (this.workerConfig[msg.wid] !== undefined) this.workerConfig[msg.wid] = msg.revision;
        continue;
      }
      // 生成通道：独立队列与在途表，先行分流
      if (msg.channel === 'gen') {
        this.drainGen(msg);
        continue;
      }
      // 先回收快照内存，再做任何可能 continue 的判定
      this.recycleSnapshots(msg.snapshotBuffers);
      // 每条回传消息都对应一次派发计数：无论结果是否过期都要回退，
      // 否则「区块卸载后旧结果晚到」会让 busy 计数永久偏高（v1.3.2 修复）。
      if (msg.wid != null && this.busy[msg.wid] > 0) this.busy[msg.wid]--;
      const key = sectionKey(msg.cx, msg.sy ?? 0, msg.cz);
      const rec = this.inFlight.get(key);
      if (!rec || rec.generation !== msg.generation) continue;
      this.inFlight.delete(key);
      // M06：派发后 invalidateConfig() 使配置失效 → 这份结果用的是旧方块元数据，
      // 必须丢弃并重新入队（这些 key 已从 dirty 移除，invalidateConfig 只重排已有网格）
      if (isStaleConfigRevision(msg.configRevision, this.configRevision)) {
        this.world.dirty.add(key);
        rec.resolve();
        continue;
      }
      if (msg.type === 'result') {
        if (this.world.getChunk(msg.cx, msg.cz)?.generated) {
          const firstOfColumn = !this.meshedColumns.has(chunkKey(msg.cx, msg.cz));
          this.applyPacked(key, msg.cx, msg.sy, msg.cz, msg.mesh);
          this.accumulate(msg.stats, firstOfColumn);
        }
      } else {
        console.error('[mesher] 区块网格化失败，主线程补算：', msg.message);
        try {
          this.applySync(msg.cx, msg.sy ?? 0, msg.cz);
        } catch (e) {
          console.error(`[mesher] 主线程补算失败 (${msg.cx}, ${msg.cz})，跳过该区块：`, e);
        }
      }
      rec.resolve();
    }
  }

  /** 累计网格统计；chunks 按「列」计数（诊断用它算每区块 quad 均值，按段算会偏小 5 倍） */
  private accumulate(s: MeshStats, countColumn = false): void {
    this.totals.quads += s.quads;
    this.totals.vertices += s.vertices;
    this.totals.merged += s.merged;
    this.totals.ms += s.ms;
    if (countColumn) this.totals.chunks++;
  }

  /** 主线程同步网格化（降级路径 / Worker 单区块失败兜底 / 基准对照） */
  private applySync(cx: number, sy: number, cz: number): void {
    const src = new WorldMeshSource(this.world, cx * CHUNK_SIZE, cz * CHUNK_SIZE, this.getConfig());
    const out = meshChunk(src, sy * SECTION_HEIGHT, SECTION_HEIGHT);
    const { mesh } = packMesh(out);
    const firstOfColumn = !this.meshedColumns.has(chunkKey(cx, cz));
    this.applyPacked(sectionKey(cx, sy, cz), cx, sy, cz, mesh);
    this.accumulate(out.stats, firstOfColumn);
  }

  private applyPacked(key: string, cx: number, sy: number, cz: number, data: PackedMesh): void {
    const old = this.meshes.get(key);
    if (old) {
      this.residentQuads -= old.quads;
      this.residentVertices -= old.quads * 4;
      this.disposeMeshes(old);
    }
    const make = (geo: PackedGeo | null, mat: THREE.Material, order: number): THREE.Mesh | undefined => {
      if (!geo || geo.indices.length === 0) return undefined;
      const mesh = new THREE.Mesh(buildGeo(geo), mat);
      // 顶点 y 已归一到 section 内 0..16，这里只负责抬到世界高度
      mesh.position.set(cx * CHUNK_SIZE, sy * SECTION_HEIGHT, cz * CHUNK_SIZE);
      mesh.renderOrder = order;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.scene.add(mesh);
      return mesh;
    };
    const firstOfColumn = !this.meshedColumns.has(chunkKey(cx, cz));
    const quads =
      (data.opaque?.indices.length ?? 0) / 6 +
      (data.emissive?.indices.length ?? 0) / 6 +
      (data.transparent?.indices.length ?? 0) / 6 +
      (data.water?.indices.length ?? 0) / 6;
    const entry: ChunkMeshes = {
      quads,
      opaque: make(data.opaque, this.materials.opaque, 0),
      // 对照路径的独立 emissive 通道；默认路径 data.emissive 恒为 null
      emissive: this.mergeEmissiveOption ? undefined : make(data.emissive, this.materials.emissive, 1),
      transparent: make(data.transparent, this.materials.transparent, 2),
      water: make(data.water, this.materials.water, 2),
    };
    this.meshes.set(key, entry);
    this.residentQuads += quads;
    this.residentVertices += quads * 4;
    this.meshedColumns.add(chunkKey(cx, cz));
    this.sortDirty = true;
    // 事件保持「每列一次」的旧语义：插件监听它做区块级刷新，5 段各发一次会放大 5 倍
    if (firstOfColumn) this.events.emit('chunk:meshed', { cx, cz });
  }

  /**
   * 透明通道（玻璃/水）按几何包围球中心 + mesh 位置到相机距离远→近排序，
   * 递增写入 renderOrder，解决「透明原点是区块坐标而非真实几何中心」导致的叠加穿帮。
   * 相机位移超 0.25 格或网格变化（sortDirty）时才重算，平时 0.1s 节流一次。
   */
  private sortTransparent(): void {
    if (!this.camera) return;
    const cam = this.camera.getWorldPosition(this.camWorld);
    if (!this.sortDirty && cam.distanceToSquared(this.lastSortCam) < 0.25 * 0.25) return;
    this.lastSortCam.copy(cam);
    this.sortDirty = false;

    const items: { key: string; pass: 'transparent' | 'water'; mesh: THREE.Mesh; dist: number }[] = [];
    for (const [key, entry] of this.meshes) {
      for (const pass of ['transparent', 'water'] as const) {
        const mesh = entry[pass];
        if (!mesh) continue;
        this.sortTmp.copy(mesh.position);
        const bs = mesh.geometry.boundingSphere;
        if (bs) this.sortTmp.add(bs.center);
        items.push({ key, pass, mesh, dist: this.sortTmp.distanceTo(cam) });
      }
    }
    items.sort((a, b) => b.dist - a.dist || a.key.localeCompare(b.key) || a.pass.localeCompare(b.pass));
    this.transparentOrderCache = items.map((it, i) => {
      const order = 10 + i;
      it.mesh.renderOrder = order;
      return { key: it.key, pass: it.pass, dist: it.dist, order };
    });
  }

  update(dt: number) {
    if (this.disposed) return;
    this.waterTime.value += dt;
    this.world.time += dt;
    this.drainResults();
    if (this.loading) return;
    // 透明排序开关：关闭瞬间把透明/水网格复位到默认 renderOrder（对照未排序效果），
    // 只复位一次；重新开启后由 sortTransparent() 恢复按距离排序。
    if (!this.transparentSortEnabled && this.sortWasEnabled) {
      this.sortWasEnabled = false;
      for (const entry of this.meshes.values()) {
        if (entry.transparent) entry.transparent.renderOrder = 2;
        if (entry.water) entry.water.renderOrder = 2;
      }
      this.transparentOrderCache = [];
    } else if (this.transparentSortEnabled) {
      // 从关闭切回开启时强制重排：否则相机未移动 0.25 格时 sortTransparent 会早退，
      // 透明网格一直停在关闭时写入的固定 renderOrder=2。
      if (!this.sortWasEnabled) this.sortDirty = true;
      this.sortWasEnabled = true;
      this.sortAcc += dt;
      if (this.sortAcc >= 0.1) {
        this.sortAcc = 0;
        this.sortTransparent();
      }
    }

    const R = this.renderDistance;
    const cx = this.centerX;
    const cz = this.centerZ;
    const margin = R + 1;

    // 0) 远处脏标记回队：之前 discard 会让驻留网格永久保留旧配置 / 旧方块数据
    for (const key of this.deferredDirty) {
      const [x, , z] = parseSectionKey(key);
      if (Math.abs(x - cx) <= margin && Math.abs(z - cz) <= margin) {
        this.deferredDirty.delete(key);
        this.world.dirty.add(key);
      }
    }

    // 0a) 兜底自愈：视距内「已生成但无网格、且没有在途任务」的 section 重新入队。
    // 扫描成本是 5×驻留区块，降到每 0.25s 一次；玩家移动一帧看不出一帧的差别。
    this.healAcc += dt;
    if (this.healAcc >= 0.25) {
      this.healAcc = 0;
      const genKey = (x: number, z: number) => chunkKey(x, z);
      for (const chunk of this.world.chunks.values()) {
        if (!chunk.generated) continue;
        if (Math.abs(chunk.cx - cx) > margin || Math.abs(chunk.cz - cz) > margin) continue;
        // 生成在途时结果落地会自己标脏，不必在这里重复入队
        if (this.pendingGen.has(genKey(chunk.cx, chunk.cz))) continue;
        for (let sy = 0; sy < SECTIONS; sy++) {
          const key = sectionKey(chunk.cx, sy, chunk.cz);
          if (!this.meshes.has(key) && !this.inFlight.has(key) && !this.world.dirty.has(key)) {
            this.world.dirty.add(key);
          }
        }
      }
    }

    // 1) 数据生成（背压：dirty + 在途网格任务积压时停止继续生成）
    const backlog = this.world.dirty.size + this.inFlight.size;
    if (backlog >= BACKLOG_LIMIT) {
      // M02：背压事件加 0.5s 节流，不再每帧重发
      this.backpressureAcc += dt;
      if (this.backpressureAcc >= 0.5) {
        this.backpressureAcc = 0;
        this.events.emit('stream:backpressure', { dirty: backlog });
      }
    } else {
      const genStart = performance.now();
      let genDispatched = 0;
      for (const [dx, dz] of this.spiral(R)) {
        const key = chunkKey(cx + dx, cz + dz);
        const chunk = this.world.getChunk(cx + dx, cz + dz);
        if (chunk?.generated) continue;
        if (this.pendingGen.has(key)) continue; // 异步在途，等回传
        if (genDispatched >= MAX_GEN_DISPATCH_PER_FRAME) break;
        if (this.pendingGen.size >= MAX_PENDING_GEN) break;
        this.requestGenerate(cx + dx, cz + dz);
        genDispatched++;
        // Worker 路径只发消息不吃主线程预算；同步回退仍守时间预算
        if (this.genMode !== 'worker' && performance.now() - genStart > GEN_BUDGET_MS) break;
        if (this.world.dirty.size + this.inFlight.size >= BACKLOG_LIMIT) break;
      }
    }

    // 2) 派发网格任务：三段优先级 + 每帧限量，避免消息风暴。
    //    实测（SwiftShader 浏览器探针）：移动时 71% 的派发是「已网格化的边界刷新」
    //    （ensureChunk 生成新块后会回脏 8 个邻居重算边界面 AO/角点光），
    //    其中 62% 还在视锥外 —— 它们挤占了真正的新区块，造成近处 pop-in。
    //    因此顺序固定为：① 首次网格化（视野内外皆可，按距离）
    //                    ② 视野内的边界刷新
    //                    ③ 视野外的边界刷新（每帧至多 MAX_OFFVIEW 个）
    if (this.world.dirty.size > 0) {
      // 视线水平分量（缺相机时退化为全视野）
      let fwdX = 0;
      let fwdZ = -1;
      if (this.camera) {
        const dir = this.camera.getWorldDirection(this.sortTmp);
        const len = Math.hypot(dir.x, dir.z);
        if (len > 1e-6) {
          fwdX = dir.x / len;
          fwdZ = dir.z / len;
        }
      }
      const camX = this.camera ? this.camera.position.x : 0;
      const camZ = this.camera ? this.camera.position.z : 0;

      interface DirtyEntry {
        x: number;
        sy: number;
        z: number;
        d2: number;
        refresh: boolean;
        out: boolean;
      }
      const list: DirtyEntry[] = [];
      for (const key of this.world.dirty) {
        const [x, sy, z] = parseSectionKey(key);
        if (Math.abs(x - cx) > margin || Math.abs(z - cz) > margin) {
          // 远处脏标记暂存而非丢弃：invalidateConfig / 光照 flush 会标记缓冲区里的驻留
          // 网格，直接丢弃会让它们一直用旧几何，走近也不会修复（已有网格不触发自愈）。
          this.world.dirty.delete(key);
          this.deferredDirty.add(key);
          continue;
        }
        // 视野判定：区块中心（+8 偏移指块中心）与视线方向的点积
        const dx = x * CHUNK_SIZE + 8 - camX;
        const dz = z * CHUNK_SIZE + 8 - camZ;
        const dist = Math.hypot(dx, dz);
        const dot = dist > 1e-6 ? (dx * fwdX + dz * fwdZ) / dist : 1;
        list.push({
          x,
          sy,
          z,
          d2: (x - cx) ** 2 + (z - cz) ** 2,
          refresh: this.meshes.has(key),
          out: dot < VIEW_DOT_THRESHOLD,
        });
      }
      list.sort(
        (a, b) => (a.refresh ? 1 : 0) - (b.refresh ? 1 : 0) || (a.out ? 1 : 0) - (b.out ? 1 : 0) || a.d2 - b.d2,
      );

      let dispatched = 0;
      let refresh = 0;
      let offview = 0;
      // ① 首次网格化最优先（不区分视野，保证流式加载不断档）
      for (const it of list) {
        if (dispatched >= MAX_DISPATCH_PER_FRAME) break;
        if (it.refresh) continue;
        if (!this.tryDispatch(it.x, it.sy, it.z)) continue;
        dispatched++;
      }
      // ② 视野内的边界刷新
      for (const it of list) {
        if (dispatched >= MAX_DISPATCH_PER_FRAME || refresh >= MAX_REFRESH_DISPATCH_PER_FRAME) break;
        if (!it.refresh || it.out) continue;
        if (!this.tryDispatch(it.x, it.sy, it.z)) continue;
        dispatched++;
        refresh++;
      }
      // ③ 视野外的边界刷新：双重限流，玩家回头前还有第 0 步兜底重排
      for (const it of list) {
        if (
          dispatched >= MAX_DISPATCH_PER_FRAME ||
          refresh >= MAX_REFRESH_DISPATCH_PER_FRAME ||
          offview >= MAX_OFFVIEW_DISPATCH_PER_FRAME
        )
          break;
        if (!it.refresh || !it.out) continue;
        if (!this.tryDispatch(it.x, it.sy, it.z)) continue;
        dispatched++;
        refresh++;
        offview++;
      }
    }

    // 3) 卸载：三层驻留策略（视距必留 / 缓冲区 LRU / 硬外沿必卸）
    // M02：Map 迭代中删除条目是安全的，无需每帧全量拷贝。
    const keepRadius = R + 2;
    const keys = selectEvictions(this.world.chunks, {
      centerX: cx,
      centerZ: cz,
      keepRadius,
      hardRadius: R + this.retentionMargin,
      maxResident: this.maxResident,
      minResidencySec: this.minResidencySec,
      now: this.world.time,
    });
    for (const key of keys) {
      const chunk = this.world.chunks.get(key);
      if (!chunk) continue;
      for (let sy = 0; sy < SECTIONS; sy++) {
        const rec = this.inFlight.get(sectionKey(chunk.cx, sy, chunk.cz));
        if (rec) {
          this.inFlight.delete(sectionKey(chunk.cx, sy, chunk.cz));
          rec.resolve();
        }
      }
      // 生成在途的区块被卸载：结算 Promise，Worker 晚到的结果由 drainGen 丢弃
      const grec = this.pendingGen.get(key);
      if (grec) {
        this.pendingGen.delete(key);
        grec.resolve();
      }
      for (let sy = 0; sy < SECTIONS; sy++) {
        const sk = sectionKey(chunk.cx, sy, chunk.cz);
        const m = this.meshes.get(sk);
        if (!m) continue;
        this.residentQuads -= m.quads;
        this.residentVertices -= m.quads * 4;
        this.disposeMeshes(m);
        this.meshes.delete(sk);
        this.sortDirty = true;
      }
      this.meshedColumns.delete(key);
      // 先让光照引擎的区块缓存失效，再删除数据：否则重建后 BFS 可能写入旧对象。
      this.world.light.invalidate(chunk.cx, chunk.cz);
      this.world.unloadChunk(key);
      for (let sy = 0; sy < SECTIONS; sy++) this.world.dirty.delete(sectionKey(chunk.cx, sy, chunk.cz));
      // deferredDirty 存的是 section key，卸载时要整列 5 个都清掉
      for (let sy = 0; sy < SECTIONS; sy++) this.deferredDirty.delete(sectionKey(chunk.cx, sy, chunk.cz));
      this.events.emit('chunk:unloaded', { cx: chunk.cx, cz: chunk.cz });
    }
  }

  private disposeMeshes(m: ChunkMeshes) {
    for (const mesh of [m.opaque, m.emissive, m.transparent, m.water]) {
      if (!mesh) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
  }

  /**
   * M05：顶层资源释放。Worker 终止、在途 Promise 结算、网格几何 / 材质释放；
   * 幂等，调用后 update() 直接返回。供页面卸载与调试钩子使用。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const rec of this.inFlight.values()) rec.resolve();
    this.inFlight.clear();
    this.deferredDirty.clear();
    this.teardownGenWorkers();
    this.pendingResults.length = 0;
    for (const [key, m] of this.meshes) {
      this.disposeMeshes(m);
      this.meshes.delete(key);
    }
    this.meshes.clear();
    this.meshedColumns.clear();
    this.transparentOrderCache.length = 0;
    // inFlight 已清空，teardownWorkers 不会触发主线程补算
    this.teardownWorkers();
    for (const mat of Object.values(this.materials)) mat.dispose();
  }

  /**
   * 启动时预载出生点周围：先生成全部数据，再把所有网格任务派发出去并等待回传。
   * Worker 化后必须等待，否则进度条走完但屏幕是空的。
   */
  async initialLoad(x: number, z: number, radius: number, onProgress?: (p: number) => void) {
    this.loading = true;
    try {
      this.setCenter(x, z);
      const cx = this.centerX;
      const cz = this.centerZ;
      const list = this.spiral(radius);
      // 生成阶段：Worker 模式一次把整圈请求发出去（等回传）；同步回退逐块 ensureChunk
      const genPromises: Promise<void>[] = [];
      for (let i = 0; i < list.length; i++) {
        const [dx, dz] = list[i];
        genPromises.push(this.requestGenerate(cx + dx, cz + dz));
        if (i % 3 === 2) {
          onProgress?.(((i + 1) / list.length) * 0.5);
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      const genDeadline = performance.now() + LOAD_TIMEOUT_MS;
      while (this.pendingGen.size > 0 && performance.now() < genDeadline) {
        this.drainResults();
        await new Promise((r) => setTimeout(r, 0));
      }
      if (this.pendingGen.size > 0) {
        console.warn('[worldgen] 预载生成等待超时，回退主线程同步生成');
        this.fallbackGenToMain();
      }
      await Promise.all(genPromises);

      const promises: Promise<void>[] = [];
      for (const [dx, dz] of list) {
        const colX = cx + dx;
        const colZ = cz + dz;
        for (let sy = 0; sy < SECTIONS; sy++) this.world.dirty.delete(sectionKey(colX, sy, colZ));
        // 一列 5 个 section 都完成才算这一列预载完成，进度按列走
        const parts: Promise<void>[] = [];
        for (let sy = 0; sy < SECTIONS; sy++) {
          parts.push(this.requestMesh(colX, colZ, sy, true) as Promise<void>);
        }
        promises.push(Promise.all(parts).then(() => undefined));
      }
      let done = 0;
      for (const p of promises) {
        void p.then(() => {
          done++;
          onProgress?.(0.5 + (done / promises.length) * 0.5);
        });
      }

      const deadline = performance.now() + LOAD_TIMEOUT_MS;
      while (this.inFlight.size > 0 && performance.now() < deadline) {
        this.drainResults();
        await new Promise((r) => setTimeout(r, 0));
      }
      if (this.inFlight.size > 0) {
        console.warn('[mesher] 预载等待超时，回退主线程同步网格化');
        this.fallbackToMain();
      }
      this.drainResults();
      onProgress?.(1);
    } finally {
      this.loading = false;
    }
  }

  /** 切换渲染距离时清理多余网格 */
  setRenderDistance(r: number) {
    this.renderDistance = r;
    this.spiralRadius = -1;
  }
}
