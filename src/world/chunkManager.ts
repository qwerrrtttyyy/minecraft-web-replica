import * as THREE from 'three';
import MeshWorker from './mesh.worker?worker&inline';
import { createWorkerPool } from './workerPool';
import { CHUNK_SIZE, chunkKey, type System } from '../core/types';
import type { EventService } from '../services/events';
import type { World } from './world';
import type { TextureAtlas } from '../gfx/atlas';
import { meshChunk } from './mesher';
import { buildMeshConfig, buildMeshSnapshot, WorldMeshSource } from './meshSource';
import { installTiledAtlas } from './tiledAtlas';
import {
  MESH_CHANNELS, packMesh,
  type MeshConfig, type MeshStats, type PackedGeo, type PackedMesh,
  type WorkerResponse,
} from './meshTypes';

interface ChunkMeshes {
  opaque?: THREE.Mesh;
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
/** initialLoad 等待 Worker 的兜底超时（ms），超时自动降级主线程 */
const LOAD_TIMEOUT_MS = 15000;

export interface ChunkManagerOptions {
  /** 强制主线程同步网格化（对照基准 / 调试 / file:// 回退） */
  forceMainThread?: boolean;
  /** 关闭 Greedy Meshing（对照基准） */
  greedy?: boolean;
  /** 网格化 Worker 池大小覆盖（默认按 navigator.hardwareConcurrency 推断，?workers=N 传入） */
  workers?: number;
}

const buildGeo = (p: PackedGeo): THREE.BufferGeometry => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(p.uvs, 2));
  g.setAttribute('color', new THREE.BufferAttribute(p.colors, 3));
  // 每顶点天空光 / 方块光，shader 与昼夜系数、太阳色一起决定最终亮度
  g.setAttribute('aLight', new THREE.BufferAttribute(p.lights, 2));
  // 每个顶点的图集 tile 区域，shader 用 fract(局部UV) 平铺
  g.setAttribute('aTileRect', new THREE.BufferAttribute(p.tiles, 4));
  g.setIndex(new THREE.BufferAttribute(p.indices, 1));
  g.computeBoundingSphere();
  return g;
};

/** 把天空光/方块光注入 MeshBasicMaterial：天空光随昼夜变化，方块光恒定 */
interface ChunkShader {
  uniforms: Record<string, THREE.IUniform>;
  vertexShader: string;
  fragmentShader: string;
}

function injectLight(shader: ChunkShader, daylight: { value: number }, sunTint: { value: THREE.Color }) {
  shader.uniforms.uDaylight = daylight;
  shader.uniforms.uSunTint = sunTint;
  shader.vertexShader = 'attribute vec2 aLight;\nvarying vec2 vLight;\n' + shader.vertexShader.replace(
    '#include <begin_vertex>',
    '#include <begin_vertex>\n\tvLight = aLight;',
  );
  shader.fragmentShader = 'varying vec2 vLight;\nuniform float uDaylight;\nuniform vec3 uSunTint;\n' + shader.fragmentShader.replace(
    '#include <color_fragment>',
    `#include <color_fragment>
    float skyPart = vLight.x * uDaylight;
    float lit = max(skyPart, vLight.y);
    float blockLit = smoothstep(0.0, 0.08, vLight.y - skyPart);
    vec3 skyTint = mix(vec3(0.56, 0.65, 0.94), vec3(1.0), clamp(uDaylight * 1.35, 0.0, 1.0));
    vec3 lightTint = mix(skyTint * uSunTint, vec3(1.0), blockLit);
    diffuseColor.rgb *= (0.07 + 0.93 * lit) * lightTint;`,
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
    opaque: THREE.MeshBasicMaterial; emissive: THREE.MeshBasicMaterial;
    transparent: THREE.MeshBasicMaterial; water: THREE.MeshBasicMaterial;
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
  private poolSize = 0;
  private mode: 'worker' | 'main' = 'worker';
  private greedyOption: boolean;
  private config: MeshConfig | null = null;
  private configRevision = 0;
  private generation = 0;
  private inFlight = new Map<string, InFlight>();
  private pendingResults: WorkerResponse[] = [];
  private totals: MeshStats & { chunks: number } = { quads: 0, vertices: 0, merged: 0, ms: 0, chunks: 0 };

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
    this.materials = {
      opaque: new THREE.MeshBasicMaterial({ map: atlas.texture, vertexColors: true, alphaTest: 0.5 }),
      emissive: new THREE.MeshBasicMaterial({ map: atlas.texture, vertexColors: true, alphaTest: 0.5 }),
      transparent: new THREE.MeshBasicMaterial({
        map: atlas.texture, vertexColors: true, transparent: true, opacity: 0.8,
        depthWrite: false, side: THREE.DoubleSide,
      }),
      water: new THREE.MeshBasicMaterial({
        map: atlas.texture, vertexColors: true, transparent: true, opacity: 0.78,
        depthWrite: false, side: THREE.DoubleSide,
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
      shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec3 wPos = (modelMatrix * vec4(position, 1.0)).xyz;
        transformed.y += sin(wPos.x * 0.9 + uTime * 1.7) * 0.028 + cos(wPos.z * 1.1 + uTime * 1.3) * 0.028;`,
      );
    };
    // 四个通道统一安装图集平铺（会串联 water 已有的 onBeforeCompile）
    for (const ch of MESH_CHANNELS) installTiledAtlas(this.materials[ch]);

    if (options.forceMainThread) {
      this.mode = 'main';
    } else {
      this.spawnWorkers(ChunkManager.decidePoolSize(options.workers));
    }
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
      w.onmessage = (e: MessageEvent<WorkerResponse>) => { this.pendingResults.push(e.data); };
      w.onerror = (e) => {
        console.warn('[mesher] Worker 运行失败，回退主线程同步网格化：', e.message);
        this.fallbackToMain();
      };
      this.workers.push(w);
      this.busy.push(0);
      this.workerConfig.push(-1);
    }
    this.poolSize = this.workers.length;
  }

  /** 销毁当前 Worker 池；在途任务立即改由主线程补算，避免 Promise 永挂 */
  private teardownWorkers(): void {
    for (const w of this.workers) { try { w.terminate(); } catch { /* 已销毁 */ } }
    this.workers = [];
    this.busy = [];
    this.workerConfig = [];
    this.poolSize = 0;
    // 旧池的回传消息不能再计入新池的 busy / config，直接丢弃
    this.pendingResults.length = 0;
    const pending = [...this.inFlight.entries()];
    this.inFlight.clear();
    for (const [key, rec] of pending) {
      const [cx, cz] = key.split(',').map(Number);
      this.applySync(cx, cz);
      rec.resolve();
    }
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
  get meshCount() { return this.meshes.size; }
  get isLoading() { return this.loading; }
  get mesherMode(): 'worker' | 'main' { return this.mode; }
  get workerCount(): number { return this.workers.length; }
  get inFlightCount() { return this.inFlight.size; }
  get meshStats() { return { ...this.totals }; }
  /** 运行时诊断：所有 Worker 是否都已确认当前配置 */
  get configReady(): boolean {
    if (this.config === null) return false;
    if (this.mode === 'main') return true;
    return this.workers.length > 0 &&
      this.workers.every((_, i) => this.workerConfig[i] === this.configRevision);
  }
  get configRevisionValue(): number { return this.configRevision; }
  /** 运行时诊断：该区块是否已有网格 / 是否在途 */
  hasMesh(cx: number, cz: number): boolean { return this.meshes.has(chunkKey(cx, cz)); }
  hasInFlight(cx: number, cz: number): boolean { return this.inFlight.has(chunkKey(cx, cz)); }
  get greedy() { return this.getConfig().greedy; }
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
      this.config = buildMeshConfig(this.world.registry, this.atlas, this.greedyOption, this.configRevision);
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
    const promise = new Promise<void>((r) => { resolve = r; });
    this.inFlight.set(key, { generation, promise, resolve });

    if (this.mode === 'main') {
      this.applySync(cx, cz);
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
        [snapshot.data.buffer, snapshot.sky.buffer, snapshot.block.buffer],
      );
    }
    return promise;
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
        this.applySync(msg.cx, msg.cz);
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
    const make = (geo: PackedGeo | null, mat: THREE.Material, order: number): THREE.Mesh | undefined => {
      if (!geo || geo.indices.length === 0) return undefined;
      const mesh = new THREE.Mesh(buildGeo(geo), mat);
      mesh.position.set(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);
      mesh.renderOrder = order;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.scene.add(mesh);
      return mesh;
    };
    const entry: ChunkMeshes = {
      opaque: make(data.opaque, this.materials.opaque, 0),
      emissive: make(data.emissive, this.materials.emissive, 0),
      transparent: make(data.transparent, this.materials.transparent, 2),
      water: make(data.water, this.materials.water, 2),
    };
    this.meshes.set(key, entry);
    this.events.emit('chunk:meshed', { cx, cz });
  }

  update(dt: number) {
    this.waterTime.value += dt;
    this.drainResults();
    if (this.loading) return;

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
      this.events.emit('stream:backpressure', { dirty: backlog });
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
      list.sort((a, b) =>
        (a[0] - cx) ** 2 + (a[1] - cz) ** 2 - ((b[0] - cx) ** 2 + (b[1] - cz) ** 2));
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
    const limit = R + 2;
    for (const [key, chunk] of [...this.world.chunks]) {
      if (Math.abs(chunk.cx - cx) <= limit && Math.abs(chunk.cz - cz) <= limit) continue;
      const rec = this.inFlight.get(key);
      if (rec) { this.inFlight.delete(key); rec.resolve(); }
      const m = this.meshes.get(key);
      if (m) {
        this.disposeMeshes(m);
        this.meshes.delete(key);
      }
      this.world.chunks.delete(key);
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
          onProgress?.((i + 1) / list.length * 0.5);
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
