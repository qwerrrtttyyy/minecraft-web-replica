import * as THREE from 'three';
import { CHUNK_SIZE, chunkKey, type System } from '../core/types';
import type { TextureAtlas } from '../gfx/atlas';
import type { EventService } from '../services/events';
import MeshWorker from './mesh.worker?worker&inline';
import { meshChunk } from './mesher';
import { buildMeshConfig, buildMeshSnapshot, WorldMeshSource } from './meshSource';
import {
  ACTIVE_LIGHT_FLOATS,
  MESH_CHANNELS,
  type MeshConfig,
  type MeshStats,
  type PackedGeo,
  type PackedMesh,
  packMesh,
  planDrain,
  type WorkerResponse,
} from './meshTypes';
import { installTiledAtlas } from './tiledAtlas';
import { createWorkerPool } from './workerPool';
import type { World } from './world';

interface ChunkMeshes {
  opaque?: THREE.Mesh;
  /** 仅对照路径（?emerge=0）下存在 */
  emissive?: THREE.Mesh;
  transparent?: THREE.Mesh;
  water?: THREE.Mesh;
}

interface InFlight {
  generation: number;
  promise: Promise<void>;
  resolve: () => void;
}

/** 每帧数据生成的时间预算（ms） */
const GEN_BUDGET_MS = 4;
/** 每帧最多派发多少个网格任务（Worker 化后主线程只做快照与通信） */
const MAX_DISPATCH_PER_FRAME = 6;
/** dirty + 在途任务积压上限：超过后暂停生成，优先消化网格队列 */
export const BACKLOG_LIMIT = 24;
/** 每帧最多收割多少条 Worker 回传（默认 4，可经 options / setDrainLimit 覆盖） */
export const DEFAULT_DRAIN_LIMIT = 4;
/** initialLoad 等待 Worker 的兜底超时（ms），超时自动降级主线程 */
const LOAD_TIMEOUT_MS = 15000;

/**
 * 一遍扫描顶点求 AABB，再以「中点 + 半对角线 + 余量」构造保守包围球。
 *
 * 相比 three 的 computeBoundingSphere（两遍扫描 + 多次分配），这里只走一遍 position 数组；
 * 又比固定 16×16×80 区块球紧得多，避免球过大导致视锥剔除失效、draw call 反增
 * （E12 实测固定球 renderMs 0.37 → 0.45，已据此改进）。
 * AABB 半对角线必包含全部顶点，因此不会让可见物消失；球挂在几何上，配置重建随几何自然失效。
 */
const cachedSphereFromPositions = (positions: Float32Array): THREE.Sphere => {
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i],
      y = positions[i + 1],
      z = positions[i + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const center = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
  const radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + 1e-3;
  return new THREE.Sphere(center, radius);
};

export interface ChunkManagerOptions {
  /** 强制主线程同步网格化（对照基准 / 调试 / file:// 回退） */
  forceMainThread?: boolean;
  /** 关闭 Greedy Meshing（对照基准） */
  greedy?: boolean;
  /** 自发光并入不透明通道（默认 true）；false = 保留独立 emissive 通道，仅作实验对照 */
  mergeEmissive?: boolean;
  /** 网格化 Worker 池大小覆盖（默认按 navigator.hardwareConcurrency 推断，?workers=N 传入） */
  workers?: number;
  /** 每帧最多收割多少条 Worker 回传（默认 4，0/负数按 1 处理） */
  drainLimit?: number;
  /** 相机：用于透明通道按几何距离排序（不传则退化为固定 renderOrder） */
  camera?: THREE.Camera;
}

type GeoPass = 'opaque' | 'emissive' | 'transparent' | 'water';
type SphereMode = 'cached' | 'exact';

/**
 * 把 Worker 回传的紧凑几何装配为 BufferGeometry（仅主线程调用）。
 *
 * T3 两项优化都集中在这里：
 * - aLight 由 2 个 float 变为 1 个位域 float（见 ACTIVE_LIGHT_FLOATS）；
 * - 不透明 / 自发光通道使用保守包围球常量，不再逐顶点 computeBoundingSphere；
 *   透明 / 水通道保留精确球体，因为它们参与距离排序，不能改变中心点。
 */
const buildGeo = (p: PackedGeo, pass: GeoPass, sphereMode: SphereMode): THREE.BufferGeometry => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(p.uvs, 2));
  // 每顶点明暗（面定向 × AO）：RGB 三通道同值，单分量即可
  g.setAttribute('aShade', new THREE.BufferAttribute(p.shade, 1));
  // 每顶点天空光 / 方块光：T3 起为 1 个打包 float，shader 用 floor/mod 解码
  g.setAttribute('aLight', new THREE.BufferAttribute(p.lights, ACTIVE_LIGHT_FLOATS));
  // 每个顶点的图集 tile 起点，shader 用 fract(局部UV) × uTileSize 平铺
  g.setAttribute('aTileOrigin', new THREE.BufferAttribute(p.tile, 2));
  // 每个顶点的开关：0 普通 / 1 群系染色 / 2 自发光（不受光照与染色影响）
  g.setAttribute('aTint', new THREE.BufferAttribute(p.tints, 1));
  // 每个顶点的风摆权重（0~1）：底部 0 / 顶部随植物高度，只对十字面植物生效
  g.setAttribute('aSway', new THREE.BufferAttribute(p.sways, 1));
  g.setIndex(new THREE.BufferAttribute(p.indices, 1));
  if (pass === 'transparent' || pass === 'water' || sphereMode === 'exact') {
    g.computeBoundingSphere();
  } else {
    // 保守球：每个新几何独立一份，配置重建时随几何一起失效，不存在跨 revision 的陈旧缓存
    g.boundingSphere = cachedSphereFromPositions(p.positions);
  }
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

/**
 * 注入烘焙光照 + 群系染色。
 *
 * T3 两项画面侧优化：
 * 1. aLight 现在是 1 个打包 float：sky = floor(v/16)/15，block = mod(v,16)/15。
 *    编码在 mesher（Worker 共用），解码放在顶点着色器，插值仍是逐顶点的平滑光照。
 * 2. 植被染色改为「逐顶点降频」（perVertexFoliage=true，默认）：
 *    原实现每像素调用 foliageTint 两次 foliageNoise = 8 次 hash；
 *    现在同样的 GLSL 只在顶点执行，片元只做插值。噪声波长（~83 / ~18 格）远大于
 *    单个 quad，差异在 E10 的像素判据内；设为 false 可回到逐像素路径做同页 A/B。
 */
function injectLight(
  shader: ChunkShader,
  daylight: { value: number },
  sunTint: { value: THREE.Color },
  perVertexFoliage: boolean,
) {
  shader.uniforms.uDaylight = daylight;
  shader.uniforms.uSunTint = sunTint;
  const vertexFoliage = perVertexFoliage ? `varying vec3 vFolTint;\n${FOLIAGE_GLSL}` : '';
  const vertexBegin =
    '#include <begin_vertex>' +
    '\n\tvLight = vec2(floor(aLight / 16.0) / 15.0, mod(aLight, 16.0) / 15.0);' +
    '\n\tvTint = aTint;\n\tvShade = aShade;' +
    '\n\tvFolPos = (modelMatrix * vec4(position, 1.0)).xyz;' +
    (perVertexFoliage ? '\n\tvFolTint = foliageTint(vFolPos.xz);' : '');
  shader.vertexShader =
    'attribute float aLight;\nattribute float aTint;\nattribute float aShade;\n' +
    'varying vec2 vLight;\nvarying float vTint;\nvarying float vShade;\nvarying vec3 vFolPos;\n' +
    vertexFoliage +
    shader.vertexShader.replace('#include <begin_vertex>', vertexBegin);
  const fragmentPrefix =
    'varying vec2 vLight;\nvarying float vTint;\nvarying float vShade;\n' +
    'varying vec3 vFolPos;\n' +
    (perVertexFoliage ? 'varying vec3 vFolTint;\n' : '') +
    'uniform float uDaylight;\nuniform vec3 uSunTint;\n' +
    (perVertexFoliage ? '' : FOLIAGE_GLSL);
  const fragmentPatch = `#include <color_fragment>
    // 顶点开关：1 = 群系染色，2 = 自发光（等价于旧的独立 emissive 材质）
    float unlit = step(1.5, vTint);
    // 植被掩膜：必须在光照染色之前采样饱和度，否则天空/太阳色会把灰度误判成彩色
    float folMx = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b));
    float folMn = min(diffuseColor.r, min(diffuseColor.g, diffuseColor.b));
    float folMask = (1.0 - unlit) * step(0.5, vTint)
      * (1.0 - smoothstep(0.10, 0.22, folMx > 0.0 ? (folMx - folMn) / folMx : 0.0));
    vec3 folTint = ${perVertexFoliage ? 'vFolTint' : 'foliageTint(vFolPos.xz)'};
    float skyPart = vLight.x * uDaylight;
    float lit = max(skyPart, vLight.y);
    float blockLit = smoothstep(0.0, 0.08, vLight.y - skyPart);
    vec3 skyTint = mix(vec3(0.56, 0.65, 0.94), vec3(1.0), clamp(uDaylight * 1.35, 0.0, 1.0));
    vec3 lightTint = mix(skyTint * uSunTint, vec3(1.0), blockLit);
    // 自发光不参与光照，但保留面定向 × AO 的明暗（与旧 emissive 通道的观感一致）
    diffuseColor.rgb *= mix(vShade * (0.07 + 0.93 * lit) * lightTint, vec3(vShade), unlit);
    diffuseColor.rgb *= mix(vec3(1.0), folTint, folMask);`;
  shader.fragmentShader = fragmentPrefix + shader.fragmentShader.replace('#include <color_fragment>', fragmentPatch);
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
  /** B2 水面片元 uv 扰动幅度（0 = 关闭，相位与顶点微波共用 uTime/waterTime） */
  private waterRipple = { value: 0 };
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
  /** E4 边界光开关：变更走 invalidateConfig + postConfig + ACK 链路 */
  private boundaryLightFixOption = false;
  private config: MeshConfig | null = null;
  private configRevision = 0;
  private generation = 0;
  private inFlight = new Map<string, InFlight>();
  private pendingResults: WorkerResponse[] = [];
  private totals: MeshStats & { chunks: number } = { quads: 0, vertices: 0, merged: 0, ms: 0, chunks: 0 };
  /** T3 限流：单帧收割上限（config-ack 不占配额） */
  private drainLimit = DEFAULT_DRAIN_LIMIT;
  /** T3 收割统计，供 E11 实验读数与诊断面板使用 */
  private drainCounters = { frames: 0, messages: 0, maxPerFrame: 0 };
  /** T3 植被染色档：true 逐顶点（默认），false 逐像素（E10 对照） */
  private foliagePerVertex = true;
  /** T3 包围球档：cached 保守球（默认），exact 逐顶点计算（E12 对照） */
  private sphereMode: SphereMode = 'cached';

  // ---- 透明通道按几何距离排序（解决玻璃/水叠加穿帮） ----
  private camera: THREE.Camera | null = null;
  private sortTmp = new THREE.Vector3();
  private camWorld = new THREE.Vector3();
  private lastSortCam = new THREE.Vector3(Infinity, Infinity, Infinity);
  private sortAcc = 0;
  private backpressureAcc = 0;
  private sortDirty = true;
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
    this.greedyOption = options.greedy ?? true;
    this.mergeEmissiveOption = options.mergeEmissive ?? true;
    this.camera = options.camera ?? null;
    this.drainLimit = Math.max(1, Math.floor(options.drainLimit ?? DEFAULT_DRAIN_LIMIT));
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
        map: atlas.texture, transparent: true, opacity: 0.78,
        // N4：显式声明深度测试；保持 depthWrite:false / DoubleSide 以维持水下可读性
        depthTest: true, depthWrite: false, side: THREE.DoubleSide,
      }),
    };
    // 不透明 / 半透明通道：烘焙光照 + 昼夜天空光
    for (const mat of [this.materials.opaque, this.materials.transparent]) {
      mat.onBeforeCompile = (shader) => injectLight(shader, this.lightUniform, this.sunTint, this.foliagePerVertex);
    }
    // 水面：光照 + 世界坐标驱动的微波动画（跨区块连续）。
    // B2 片元 uv 波纹只改 uv，不叠加第二套时间源：相位仍由 uTime=waterTime 驱动，
    // 冻结场景下 waterTime=0，A/B/D 三档的相位完全相同，噪声底保持 0。
    this.materials.water.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.waterTime;
      shader.uniforms.uRippleAmp = this.waterRipple;
      injectLight(shader, this.lightUniform, this.sunTint, this.foliagePerVertex);
      shader.vertexShader =
        'uniform float uTime;\nvarying vec3 vRippleWorld;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
        vec3 wPos = (modelMatrix * vec4(position, 1.0)).xyz;
        // 片元 uv 波纹的世界坐标相位（与 uTime 共用，冻结时归零）
        vRippleWorld = wPos;
        // N4：把波动夹紧到 ±0.02，水面顶点不再越过方块边界形成细蓝边 / 与岩石近共面闪烁。
        // 动画节奏、透明度与高光保持不变（Q5）。
        float wave = sin(wPos.x * 0.9 + uTime * 1.7) * 0.028 + cos(wPos.z * 1.1 + uTime * 1.3) * 0.028;
        transformed.y += clamp(wave, -0.02, 0.02);`,
        );
      shader.fragmentShader =
        'uniform float uTime;\nuniform float uRippleAmp;\nvarying vec3 vRippleWorld;\n' +
        `vec2 rippleUv(vec2 uv0) {
          vec2 shift = vec2(
            sin(vRippleWorld.x * 3.1 + uTime * 2.0),
            cos(vRippleWorld.z * 2.7 + uTime * 1.7)
          ) * uRippleAmp;
          return uv0 + shift;
        }\n` + shader.fragmentShader;
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
    // 各通道统一安装图集平铺（会串联 water 已有的 onBeforeCompile）；
    // 水面把采样 uv 换成 rippleUv(vMapUv)，其余通道保持原表达式不变。
    for (const ch of MESH_CHANNELS) {
      installTiledAtlas(this.materials[ch], ch === 'water' ? 'rippleUv(vMapUv)' : 'vMapUv');
    }

    if (options.forceMainThread) {
      this.mode = 'main';
    } else {
      this.spawnWorkers(ChunkManager.decidePoolSize(options.workers));
    }
    // E14 实测波纹生效（全局 MAD=0.151）且性能无显著劣化，默认开启保守幅度；
    // 相位共用 waterTime，冻结场景归零，不影响任何同页 A/B 的噪声底。
    this.setWaterRipple(0.01);
    this.getConfig(); // 建立低频配置并向所有 Worker 下发
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
      const [cx, cz] = key.split(',').map(Number);
      this.applySync(cx, cz);
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
    return this.meshes.size;
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
  get meshStats() {
    return { ...this.totals };
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
    return this.meshes.has(chunkKey(cx, cz));
  }
  hasInFlight(cx: number, cz: number): boolean {
    return this.inFlight.has(chunkKey(cx, cz));
  }
  /** 透明/水通道的当前排序结果（按几何中心到相机距离远→近），用于调试与自动化断言 */
  get transparentOrder() {
    return this.transparentOrderCache.map((e) => ({ ...e }));
  }
  /** 每个 Worker 当前在途任务数（诊断用） */
  get workerBusy(): number[] {
    return [...this.busy];
  }
  /** 当前每帧收割上限（E11 读数） */
  get drainLimitValue(): number {
    return this.drainLimit;
  }
  /** 收割统计快照（E11 读数）：帧数 / 累计消息 / 单帧峰值 */
  get drainCountersSnapshot(): { frames: number; messages: number; maxPerFrame: number } {
    return { ...this.drainCounters };
  }
  /** 当前待收割队列长度（E11 观察饥饿用） */
  get pendingResultCount(): number {
    return this.pendingResults.length;
  }
  /** 当前植被染色档（E10 读数） */
  get foliagePerVertexEnabled(): boolean {
    return this.foliagePerVertex;
  }
  /** 当前包围球档（E12 读数） */
  get sphereModeValue(): SphereMode {
    return this.sphereMode;
  }
  /** 当前水面波纹幅度（E14 读数） */
  get waterRippleValue(): number {
    return this.waterRipple.value;
  }
  /** 当前 E4 边界光档位（E16 读数） */
  get boundaryLightFixEnabled(): boolean {
    return this.boundaryLightFixOption;
  }

  /** 运行期调整每帧收割上限；至少 1，防止误配 0 造成永久饥饿 */
  setDrainLimit(limit: number): void {
    this.drainLimit = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : DEFAULT_DRAIN_LIMIT));
  }

  /**
   * 切换群系染色计算档位并触发材质重编译（同页 A/B 用）。
   * 只改 shader，不改几何，因此场景一致性闸门仍然成立。
   */
  setFoliagePerVertex(enabled: boolean): void {
    if (this.foliagePerVertex === enabled) return;
    this.foliagePerVertex = enabled;
    for (const mat of [this.materials.opaque, this.materials.transparent, this.materials.water]) {
      mat.needsUpdate = true;
    }
  }

  /**
   * 切换包围球档位。exact 档重算已有不透明网格的球体，cached 档换回保守球；
   * 透明 / 水通道始终精确，不受影响（距离排序依赖其中心点）。
   */
  setSphereMode(mode: SphereMode): void {
    if (this.sphereMode === mode) return;
    this.sphereMode = mode;
    for (const entry of this.meshes.values()) {
      for (const mesh of [entry.opaque, entry.emissive]) {
        if (!mesh) continue;
        if (mode === 'exact') mesh.geometry.computeBoundingSphere();
        else {
          mesh.geometry.boundingSphere = cachedSphereFromPositions(
            mesh.geometry.attributes.position.array as Float32Array,
          );
        }
      }
    }
  }

  /**
   * B2 开关：设置水面片元 uv 扰动幅度。0 = 关闭（默认），幅度变化只写 uniform，
   * 不触发材质重编译；相位仍由 waterTime 提供，冻结时归零。
   */
  setWaterRipple(amp: number): void {
    this.waterRipple.value = Number.isFinite(amp) ? Math.max(0, Math.min(0.05, amp)) : 0;
  }

  /**
   * E4 开关：越界角点采样改走 MeshSource.crossChunkLight。
   * 配置变更必须经既有 invalidateConfig() 重建 + postConfig() 下发 + ACK 链路。
   */
  setBoundaryLightFix(enabled: boolean): void {
    if (this.boundaryLightFixOption === enabled) return;
    this.boundaryLightFixOption = enabled;
    this.invalidateConfig();
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
        this.boundaryLightFixOption,
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

  /** 请求一个区块的网格；同一 key 在途时复用同一 Promise（代次去重） */
  private requestMesh(cx: number, cz: number): Promise<void> {
    const key = chunkKey(cx, cz);
    const existing = this.inFlight.get(key);
    if (existing) return existing.promise;
    const generation = ++this.generation;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.inFlight.set(key, { generation, promise, resolve });

    if (this.mode === 'main') {
      // H05：主线程路径必须兜住异常——applySync 抛错时若不释放 inFlight，
      // 该 key 永久卡在途，backlog 涨满后整条生成流停摆（initialLoad 则永挂黑屏）
      try {
        this.applySync(cx, cz);
      } catch (e) {
        console.error(`[mesher] 主线程网格化失败 (${cx}, ${cz})，跳过该区块：`, e);
      }
      this.inFlight.delete(key);
      resolve();
    } else {
      // 防御性保证：任何 Worker 任务发出前，配置已构建并下发。
      // （invalidateConfig 现在会立即重建，但这里兜住未来新增的调用路径）
      this.getConfig();
      const wid = this.pickWorker();
      const snapshot = buildMeshSnapshot(this.world, cx, cz);
      this.workers[wid].postMessage(
        { type: 'mesh', cx, cz, generation, snapshot, wid },
        // N4：known 位图与 data 同步转移，避免 Worker 侧收到丢失/复制的来源信息
        [snapshot.data.buffer, snapshot.sky.buffer, snapshot.block.buffer, snapshot.known.buffer],
      );
    }
    return promise;
  }

  /**
   * 收割 Worker 回传：每帧至多处理 drainLimit 条，避免单帧尖峰。
   *
   * - config-ack 由 planDrain 抽出且不占配额，配置确认不会被结果队列饿死；
   * - 未处理条目保留在队首，下一帧继续取前 N 条，任何区块都不会永久饥饿；
   * - 每条回传（含过期代次）仍然回退 busy，保留 v1.3.2 的修复语义；
   * - BACKLOG_LIMIT=24 的背压判定完全不动。
   */
  private drainResults(): void {
    if (this.pendingResults.length === 0) return;
    const plan = planDrain(this.pendingResults, this.drainLimit);
    this.pendingResults = plan.rest;
    for (const msg of plan.acks) {
      if (this.workerConfig[msg.wid] !== undefined) this.workerConfig[msg.wid] = msg.revision;
    }
    this.drainCounters.frames++;
    this.drainCounters.messages += plan.batch.length;
    this.drainCounters.maxPerFrame = Math.max(this.drainCounters.maxPerFrame, plan.batch.length);
    for (const msg of plan.batch) {
      // 每条回传消息都对应一次派发计数：无论结果是否过期都要回退，
      // 否则「区块卸载后旧结果晚到」会让 busy 计数永久偏高（v1.3.2 修复）。
      if (msg.wid != null && this.busy[msg.wid] > 0) this.busy[msg.wid]--;
      const key = chunkKey(msg.cx, msg.cz);
      const rec = this.inFlight.get(key);
      if (!rec || rec.generation !== msg.generation) continue;
      this.inFlight.delete(key);
      if (msg.type === 'result') {
        if (this.world.getChunk(msg.cx, msg.cz)?.generated) {
          this.applyPacked(key, msg.cx, msg.cz, msg.mesh);
          this.accumulate(msg.stats);
        }
      } else {
        console.error('[mesher] 区块网格化失败，主线程补算：', msg.message);
        try {
          this.applySync(msg.cx, msg.cz);
        } catch (e) {
          console.error(`[mesher] 主线程补算失败 (${msg.cx}, ${msg.cz})，跳过该区块：`, e);
        }
      }
      rec.resolve();
    }
  }

  private accumulate(s: MeshStats): void {
    this.totals.quads += s.quads;
    this.totals.vertices += s.vertices;
    this.totals.merged += s.merged;
    this.totals.ms += s.ms;
    this.totals.chunks++;
  }

  /** 主线程同步网格化（降级路径 / Worker 单区块失败兜底 / 基准对照） */
  private applySync(cx: number, cz: number): void {
    const src = new WorldMeshSource(this.world, cx * CHUNK_SIZE, cz * CHUNK_SIZE, this.getConfig());
    const out = meshChunk(src);
    const { mesh } = packMesh(out);
    this.applyPacked(chunkKey(cx, cz), cx, cz, mesh);
    this.accumulate(out.stats);
  }

  private applyPacked(key: string, cx: number, cz: number, data: PackedMesh): void {
    const old = this.meshes.get(key);
    if (old) this.disposeMeshes(old);
    const make = (geo: PackedGeo | null, mat: THREE.Material, order: number, pass: GeoPass): THREE.Mesh | undefined => {
      if (!geo || geo.indices.length === 0) return undefined;
      const mesh = new THREE.Mesh(buildGeo(geo, pass, this.sphereMode), mat);
      mesh.position.set(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);
      mesh.renderOrder = order;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.scene.add(mesh);
      return mesh;
    };
    const entry: ChunkMeshes = {
      opaque: make(data.opaque, this.materials.opaque, 0, 'opaque'),
      // 对照路径的独立 emissive 通道；默认路径 data.emissive 恒为 null
      emissive: this.mergeEmissiveOption ? undefined : make(data.emissive, this.materials.emissive, 1, 'emissive'),
      transparent: make(data.transparent, this.materials.transparent, 2, 'transparent'),
      water: make(data.water, this.materials.water, 2, 'water'),
    };
    this.meshes.set(key, entry);
    this.sortDirty = true;
    this.events.emit('chunk:meshed', { cx, cz });
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
    this.waterTime.value += dt;
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

    // 0) 兜底自愈：视距内「已生成但无网格、且没有在途任务」的区块重新入队
    for (const [key, chunk] of this.world.chunks) {
      if (!chunk.generated) continue;
      if (Math.abs(chunk.cx - cx) > margin || Math.abs(chunk.cz - cz) > margin) continue;
      if (!this.meshes.has(key) && !this.inFlight.has(key)) this.world.dirty.add(key);
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
      for (const [dx, dz] of this.spiral(R)) {
        const key = chunkKey(cx + dx, cz + dz);
        const chunk = this.world.getChunk(cx + dx, cz + dz);
        if (!chunk?.generated) {
          this.world.ensureChunk(cx + dx, cz + dz);
          this.world.dirty.add(key);
          if (this.world.dirty.size + this.inFlight.size >= BACKLOG_LIMIT) break;
          if (performance.now() - genStart > GEN_BUDGET_MS) break;
        }
      }
    }

    // 2) 派发网格任务（近处优先，每帧限量，避免消息风暴）
    if (this.world.dirty.size > 0) {
      const list: [number, number][] = [];
      for (const key of this.world.dirty) {
        const [x, z] = key.split(',').map(Number);
        if (Math.abs(x - cx) > margin || Math.abs(z - cz) > margin) {
          // 远处脏标记直接丢弃，避免长期累积；靠近时会由第 0 步重新入队
          this.world.dirty.delete(key);
          continue;
        }
        list.push([x, z]);
      }
      list.sort((a, b) => (a[0] - cx) ** 2 + (a[1] - cz) ** 2 - ((b[0] - cx) ** 2 + (b[1] - cz) ** 2));
      let dispatched = 0;
      for (const [x, z] of list) {
        if (dispatched >= MAX_DISPATCH_PER_FRAME) break;
        const key = chunkKey(x, z);
        // 未生成的区块保留脏标记等下一帧
        if (!this.world.getChunk(x, z)?.generated) continue;
        if (this.inFlight.has(key)) continue;
        this.world.dirty.delete(key);
        this.requestMesh(x, z);
        dispatched++;
      }
    }

    // 3) 卸载：按 world.chunks 遍历，在途任务一并取消
    // M02：Map 迭代中删除条目是安全（不会重访已删项），无需每帧全量拷贝 441 项
    const limit = R + 2;
    for (const [key, chunk] of this.world.chunks) {
      if (Math.abs(chunk.cx - cx) <= limit && Math.abs(chunk.cz - cz) <= limit) continue;
      const rec = this.inFlight.get(key);
      if (rec) {
        this.inFlight.delete(key);
        rec.resolve();
      }
      const m = this.meshes.get(key);
      if (m) {
        this.disposeMeshes(m);
        this.meshes.delete(key);
        this.sortDirty = true;
      }
      // 先让光照引擎的区块缓存失效，再删除数据：否则重建后 BFS 可能写入旧对象。
      this.world.light.invalidate(chunk.cx, chunk.cz);
      this.world.unloadChunk(key);
      this.world.dirty.delete(key);
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
      for (let i = 0; i < list.length; i++) {
        const [dx, dz] = list[i];
        this.world.ensureChunk(cx + dx, cz + dz);
        if (i % 3 === 2) {
          onProgress?.(((i + 1) / list.length) * 0.5);
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      const promises: Promise<void>[] = [];
      for (const [dx, dz] of list) {
        const key = chunkKey(cx + dx, cz + dz);
        this.world.dirty.delete(key);
        promises.push(this.requestMesh(cx + dx, cz + dz));
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
