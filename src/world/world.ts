import type * as THREE from 'three';
import { CHUNK_SIZE, WORLD_HEIGHT, chunkKey, blockKey, clamp, type BlockId } from '../core/types';
import type { EventService } from '../services/events';
import {
  EXTENSION_POINTS, type ExtensionRegistry, type WorldgenColumnPayload,
} from '../services/plugins/extensions';
import { AIR, type BlockRegistry } from './blocks';
import type { IWorldGenerator } from './generator';
import { LightEngine } from './light';

const CS = CHUNK_SIZE;
const H = WORLD_HEIGHT;

/** 分桶内的编辑记录：坐标在 recordEdit 时解析一次，避免 ensureChunk 反复 split(',') */
interface BlockEdit {
  x: number; y: number; z: number; id: BlockId;
}

export class Chunk {
  readonly data = new Uint8Array(CS * CS * H);
  /** 天空光（0~15），由 LightEngine 维护 */
  readonly sky = new Uint8Array(CS * CS * H);
  /** 方块光（0~15），由 LightEngine 维护 */
  readonly block = new Uint8Array(CS * CS * H);
  generated = false;
  /** 光照是否已初始化 */
  lit = false;
  /** 逻辑时间（秒）：创建 / 最近一次有意义访问，用于 LRU 驻留；不用 Date.now 以保证可复现 */
  createdAt = 0;
  lastTouch = 0;
  constructor(readonly cx: number, readonly cz: number) {}
  idx(x: number, y: number, z: number) {
    return (y * CS + z) * CS + x;
  }
}

export interface RayHit {
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  block: BlockId;
  dist: number;
}

/**
 * 体素世界：区块容器 + 方块读写 + 编辑记录（存档差分）+ 体素射线。
 * 渲染与玩法都只依赖这里暴露的接口。
 */
export class World {
  readonly chunks = new Map<string, Chunk>();
  /** 玩家改动差分：key -> blockId，存档只保存这些 */
  readonly edits = new Map<string, BlockId>();
  /** 待重新网格化的区块 */
  readonly dirty = new Set<string>();
  /** 天空光 / 方块光传播引擎（区块生成与方块变化时增量更新） */
  readonly light: LightEngine;
  /** 逻辑时间（秒）：由 ChunkManager.update 每帧推进，是区块驻留策略的唯一时钟 */
  time = 0;
  /** 累计生成次数 / 卸载后再次生成的次数（用于"区块生存"效果基准） */
  generatedCount = 0;
  regeneratedCount = 0;
  private everGenerated = new Set<string>();
  /** 编辑差分按 chunkKey 分桶，值为已解析的数值坐标：ensureChunk 不再逐条 split 字符串 */
  private editsByChunk = new Map<string, Map<string, BlockEdit>>();
  private bedrockId: BlockId;

  constructor(
    readonly registry: BlockRegistry,
    public generator: IWorldGenerator,
    readonly events: EventService,
    /** v1.6.0：扩展点注册表，可选（不传则无世界生成钩子，旧测试零改动） */
    readonly extensions?: ExtensionRegistry,
  ) {
    this.bedrockId = registry.byNameGet('bedrock')?.id ?? 3;
    this.light = new LightEngine(this);
  }

  getChunk(cx: number, cz: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cz));
  }

  /**
   * M01：热路径单条目区块缓存。getBlock/isSolidAt 被射线（每帧最多 256 步）、
   * 物理、随机刻、爆炸高频调用——命中时免去 chunkKey 字符串构造 + Map 哈希。
   * 失效点：ensureChunk 新建区块、unloadChunk 卸载区块。
   */
  private cacheCx = Number.NaN;
  private cacheCz = Number.NaN;
  private cacheChunk: Chunk | null = null;

  private chunkAt(x: number, z: number): Chunk | null {
    const cx = Math.floor(x / CS);
    const cz = Math.floor(z / CS);
    if (cx !== this.cacheCx || cz !== this.cacheCz) {
      this.cacheCx = cx;
      this.cacheCz = cz;
      this.cacheChunk = this.chunks.get(chunkKey(cx, cz)) ?? null;
    }
    return this.cacheChunk;
  }

  /** 区块卸载（ChunkManager 视距裁剪）：必须让热路径缓存失效 */
  unloadChunk(key: string): void {
    this.chunks.delete(key);
    this.cacheCx = Number.NaN;
  }

  /** 标记区块被"有意义地访问"（网格调度 / 玩家编辑），刷新 LRU 时钟 */
  touchChunk(cx: number, cz: number): void {
    const chunk = this.chunks.get(chunkKey(cx, cz));
    if (chunk) chunk.lastTouch = this.time;
  }

  /** 记录一条玩家编辑，同时维护分桶索引（幂等：同坐标后写覆盖前写） */
  private recordEdit(k: string, id: BlockId): void {
    this.edits.set(k, id);
    // 字符串坐标只在这里解析一次；手写切片避免 split+map 每次分配临时数组
    const i1 = k.indexOf(',');
    const i2 = k.indexOf(',', i1 + 1);
    const x = +k.slice(0, i1);
    const y = +k.slice(i1 + 1, i2);
    const z = +k.slice(i2 + 1);
    const ck = chunkKey(Math.floor(x / CS), Math.floor(z / CS));
    let bucket = this.editsByChunk.get(ck);
    if (!bucket) {
      bucket = new Map();
      this.editsByChunk.set(ck, bucket);
    }
    bucket.set(k, { x, y, z, id });
  }

  /** 批量载入存档差分（组装根调用，禁止绕过本方法直接写 edits） */
  loadEdits(entries: Iterable<readonly [string, BlockId]>): void {
    for (const [k, id] of entries) this.recordEdit(k, id);
  }

  /** 确保区块数据已生成（惰性），并应用存档差分 */
  ensureChunk(cx: number, cz: number): Chunk {
    const key = chunkKey(cx, cz);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = new Chunk(cx, cz);
      chunk.createdAt = this.time;
      chunk.lastTouch = this.time;
      this.chunks.set(key, chunk);
      // M01：热路径缓存可能已把该 key 记成 null（未生成），插入后失效
      this.cacheCx = Number.NaN;
    }
    if (!chunk.generated) {
      this.generatedCount++;
      if (this.everGenerated.has(key)) this.regeneratedCount++;
      else this.everGenerated.add(key);
      this.generator.generateChunk(cx, cz, chunk.data);
      this.finalizeGenerated(cx, cz, chunk);
    }
    return chunk;
  }

  /**
   * Worker 生成路径：接收已算好的地形 data（Worker 只算 data，光照仍在这里初始化），
   * 其余收尾与 ensureChunk 完全一致。已存在同 key 区块时忽略并返回 false。
   */
  acceptGeneratedChunk(cx: number, cz: number, data: Uint8Array): boolean {
    const key = chunkKey(cx, cz);
    if (this.chunks.has(key)) return false;
    const chunk = new Chunk(cx, cz);
    chunk.data.set(data);
    chunk.createdAt = this.time;
    chunk.lastTouch = this.time;
    this.chunks.set(key, chunk);
    // M01：热路径缓存可能已把该 key 记成 null（未生成），插入后失效
    this.cacheCx = Number.NaN;
    this.generatedCount++;
    if (this.everGenerated.has(key)) this.regeneratedCount++;
    else this.everGenerated.add(key);
    this.finalizeGenerated(cx, cz, chunk);
    return true;
  }

  /** 生成落地后的公共收尾：扩展点改写 → 玩家差分 → 光照初始化 → 邻居回脏 */
  private finalizeGenerated(cx: number, cz: number, chunk: Chunk): void {
    const key = chunkKey(cx, cz);
    // v1.6.0：世界生成扩展点。插件（JS / WASM）可在地形落地后改写列内容，
    // 发生在玩家编辑差分与光照初始化之前：编辑仍优先，新方块参与光照计算。
    if (this.extensions?.has(EXTENSION_POINTS.WORLDGEN_COLUMN)) {
      const x0 = cx * CS, z0 = cz * CS;
      const payload: WorldgenColumnPayload = {
        cx, cz, data: chunk.data,
        get: (x, y, z) => {
          if (y < 0 || y >= H) return 0;
          const lx = x - x0, lz = z - z0;
          if (lx < 0 || lx >= CS || lz < 0 || lz >= CS) return 0;
          return chunk.data[chunk.idx(lx, y, lz)];
        },
        set: (x, y, z, id) => {
          if (y < 1 || y >= H) return;
          const lx = x - x0, lz = z - z0;
          if (lx < 0 || lx >= CS || lz < 0 || lz >= CS) return;
          chunk.data[chunk.idx(lx, y, lz)] = id;
        },
      };
      this.extensions.emit(EXTENSION_POINTS.WORLDGEN_COLUMN, payload);
    }
    // 应用玩家编辑差分（分桶后不再扫描全档，也不再逐条 split 坐标字符串）
    const x0 = cx * CS;
    const z0 = cz * CS;
    const bucket = this.editsByChunk.get(key);
    if (bucket) {
      for (const e of bucket.values()) {
        if (e.x >= x0 && e.x < x0 + CS && e.z >= z0 && e.z < z0 + CS &&
            e.y >= 0 && e.y < H) {
          chunk.data[chunk.idx(e.x - x0, e.y, e.z - z0)] = e.id;
        }
      }
    }
    chunk.generated = true;
    // 生成 + 存档差分都已落地，再初始化天空光 / 方块光
    this.light.initChunk(chunk);
    // 邻接已网格化区块需要重绘边界面；对角块也要算，因为 AO / 角点光照会采样对角 halo 格。
    for (const [dx, dz] of [
      [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
    ] as const) {
      const nk = chunkKey(cx + dx, cz + dz);
      if (this.chunks.get(nk)?.generated) this.dirty.add(nk);
    }
    this.events.emit('chunk:generated', { cx, cz });
  }

  getBlock(x: number, y: number, z: number): BlockId {
    if (y < 0) return this.bedrockId;
    if (y >= H) return AIR;
    const chunk = this.chunkAt(x, z);
    if (!chunk || !chunk.generated) return AIR;
    return chunk.data[chunk.idx(x - chunk.cx * CS, y, z - chunk.cz * CS)];
  }

  /** 渲染用天空光（未加载 / 未初始化区块按露天处理，避免边界发黑） */
  getSkyLight(x: number, y: number, z: number): number {
    if (y >= H) return 15;
    if (y < 0) return 0;
    const chunk = this.chunkAt(x, z);
    if (!chunk || !chunk.lit) return 15;
    return chunk.sky[chunk.idx(x - chunk.cx * CS, y, z - chunk.cz * CS)];
  }

  /** 渲染用方块光（未加载区块为 0） */
  getBlockLight(x: number, y: number, z: number): number {
    if (y < 0 || y >= H) return 0;
    const chunk = this.chunkAt(x, z);
    if (!chunk || !chunk.lit) return 0;
    return chunk.block[chunk.idx(x - chunk.cx * CS, y, z - chunk.cz * CS)];
  }

  /** 物理碰撞用：未加载区块视为实心，防止掉出世界 */
  isSolidAt(x: number, y: number, z: number): boolean {
    if (y < 0) return true;
    if (y >= H) return false;
    const chunk = this.chunkAt(x, z);
    if (!chunk || !chunk.generated) return true;
    return this.registry.isSolid(chunk.data[chunk.idx(x - chunk.cx * CS, y, z - chunk.cz * CS)]);
  }

  setBlock(x: number, y: number, z: number, id: BlockId, record = true): boolean {
    if (y < 1 || y >= H) return false;
    const cx = Math.floor(x / CS);
    const cz = Math.floor(z / CS);
    const chunk = this.ensureChunk(cx, cz);
    this.touchChunk(cx, cz);
    const lx = x - cx * CS;
    const lz = z - cz * CS;
    const old = chunk.data[chunk.idx(lx, y, lz)];
    if (old === id) return false;
    chunk.data[chunk.idx(lx, y, lz)] = id;
    if (record) this.recordEdit(blockKey(x, y, z), id);
    // 光照增量更新（会把受影响的区块标脏）
    this.light.updateBlock(x, y, z, old, id);
    this.dirty.add(chunkKey(cx, cz));
    if (lx === 0) this.dirty.add(chunkKey(cx - 1, cz));
    if (lx === CS - 1) this.dirty.add(chunkKey(cx + 1, cz));
    if (lz === 0) this.dirty.add(chunkKey(cx, cz - 1));
    if (lz === CS - 1) this.dirty.add(chunkKey(cx, cz + 1));
    // M07：边角格的光照/网格变化也会影响对角区块的边界面（AO、贪婪合并跨角），
    // 一并标脏避免对角 chunk 渲染错位。
    if (lx === 0 && lz === 0) this.dirty.add(chunkKey(cx - 1, cz - 1));
    if (lx === CS - 1 && lz === 0) this.dirty.add(chunkKey(cx + 1, cz - 1));
    if (lx === 0 && lz === CS - 1) this.dirty.add(chunkKey(cx - 1, cz + 1));
    if (lx === CS - 1 && lz === CS - 1) this.dirty.add(chunkKey(cx + 1, cz + 1));
    return true;
  }

  /**
   * M04：批量写入方块（爆炸等一次性多格改动）。先落所有数据编辑与脏标记，
   * 光照播种延迟到末尾统一排空（deferred flush，配合 M03 的逐帧预算），避免
   * 相邻格的光照回收与重扩散重复触发完整 BFS。返回实际写入的格数。
   */
  setBlocks(entries: readonly [number, number, number, BlockId][]): number {
    let written = 0;
    for (const [x, y, z, id] of entries) {
      if (y < 1 || y >= H) continue;
      const cx = Math.floor(x / CS);
      const cz = Math.floor(z / CS);
      const chunk = this.ensureChunk(cx, cz);
      this.touchChunk(cx, cz);
      const lx = x - cx * CS;
      const lz = z - cz * CS;
      const idx = chunk.idx(lx, y, lz);
      const old = chunk.data[idx];
      if (old === id) continue;
      chunk.data[idx] = id;
      this.recordEdit(blockKey(x, y, z), id);
      this.dirty.add(chunkKey(cx, cz));
      if (lx === 0) this.dirty.add(chunkKey(cx - 1, cz));
      if (lx === CS - 1) this.dirty.add(chunkKey(cx + 1, cz));
      if (lz === 0) this.dirty.add(chunkKey(cx, cz - 1));
      if (lz === CS - 1) this.dirty.add(chunkKey(cx, cz + 1));
      if (lx === 0 && lz === 0) this.dirty.add(chunkKey(cx - 1, cz - 1));
      if (lx === CS - 1 && lz === 0) this.dirty.add(chunkKey(cx + 1, cz - 1));
      if (lx === 0 && lz === CS - 1) this.dirty.add(chunkKey(cx - 1, cz + 1));
      if (lx === CS - 1 && lz === CS - 1) this.dirty.add(chunkKey(cx + 1, cz + 1));
      // 光照延迟到末尾统一刷新（M04 deferred flush，配合 M03 预算帧）
      this.light.queueBlockUpdate(x, y, z, old, id);
      written++;
    }
    // 统一排空光照队列（受 M03 预算限制，可跨帧），并把 touched 并入 dirty
    while (!this.light.step(2)) {}
    this.light.flush();
    return written;
  }

  /**
   * 生成期装饰写入：只改已生成区块的数据，不记录玩家编辑差分、不标脏、
   * 不触发光照增量更新——与 DefaultGenerator.stageDecorate 直接写 data 的语义一致。
   * 网格由 ChunkManager 在本次生成后统一派发，因此新植物会包含在内。
   * 供插件在 chunk:generated 阶段补种，避免污染存档与流式加载队列。
   */
  setBlockGenerated(x: number, y: number, z: number, id: BlockId): boolean {
    if (y < 1 || y >= H) return false;
    const cx = Math.floor(x / CS);
    const cz = Math.floor(z / CS);
    const chunk = this.chunks.get(chunkKey(cx, cz));
    if (!chunk?.generated) return false;
    const lx = x - cx * CS;
    const lz = z - cz * CS;
    const at = chunk.idx(lx, y, lz);
    if (chunk.data[at] === id) return false;
    chunk.data[at] = id;
    return true;
  }

  /**
   * M08：插件装饰写入并初始化光照。语义同 setBlockGenerated，但会为
   * lightEmission > 0 的方块播种方块光并触发一次增量更新，避免插件放置
   * 火把/灯笼等发光方块后不亮。
   */
  setBlockGeneratedWithLight(x: number, y: number, z: number, id: BlockId): boolean {
    if (y < 1 || y >= H) return false;
    const cx = Math.floor(x / CS);
    const cz = Math.floor(z / CS);
    const chunk = this.chunks.get(chunkKey(cx, cz));
    if (!chunk?.generated) return false;
    const lx = x - cx * CS;
    const lz = z - cz * CS;
    const at = chunk.idx(lx, y, lz);
    const old = chunk.data[at];
    if (old === id) return false;
    chunk.data[at] = id;
    // M08：仅对发光方块做方块光增量播种；天空光不受装饰方块影响（除非遮挡，
    // 但装饰阶段只在已生成区块写入，且生成时已由 initChunk 完成天空光）。
    if (this.registry.get(id).lightEmission > 0) {
      this.light.updateBlock(x, y, z, old, id);
    }
    return true;
  }

  /**
   * 地表高度（用于出生点与实体生成）。
   * 从生成器给出的「地形高度」开始向下/向上扫描：
   * 既不会把树冠、草丛当成地面，也仍能识别玩家在地形之上搭建的平台。
   */
  surfaceHeight(x: number, z: number): number {
    const terrain = this.generator.surfaceHeight(x, z);
    const cx = Math.floor(x / CS);
    const cz = Math.floor(z / CS);
    const chunk = this.chunks.get(chunkKey(cx, cz));
    if (!chunk?.generated) return terrain;
    const lx = x - cx * CS;
    const lz = z - cz * CS;
    const start = clamp(terrain, 0, H - 1);
    let lowest = -1;
    for (let y = start; y >= 0; y--) {
      if (this.registry.isSolid(chunk.data[chunk.idx(lx, y, lz)])) {
        lowest = y;
        break;
      }
    }
    // 只挖到基岩时，向下扫描必然停在 y=0；此时优先找玩家在上方搭建的落脚点。
    // （v1.3.2 修复：旧实现无论结果如何都会在向下循环里 return，向上分支不可达）
    if (lowest <= 0) {
      for (let y = start + 1; y < H; y++) {
        if (this.registry.isSolid(chunk.data[chunk.idx(lx, y, lz)])) return y;
      }
    }
    return lowest >= 0 ? lowest : terrain;
  }

  /**
   * 体素射线（Amanatides & Woo DDA）。
   * 忽略空气与液体；草丛/花可被选中。
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): RayHit | null {
    let x = Math.floor(origin.x);
    let y = Math.floor(origin.y);
    let z = Math.floor(origin.z);
    const stepX = dir.x > 0 ? 1 : -1;
    const stepY = dir.y > 0 ? 1 : -1;
    const stepZ = dir.z > 0 ? 1 : -1;
    const tDeltaX = dir.x !== 0 ? Math.abs(1 / dir.x) : Infinity;
    const tDeltaY = dir.y !== 0 ? Math.abs(1 / dir.y) : Infinity;
    const tDeltaZ = dir.z !== 0 ? Math.abs(1 / dir.z) : Infinity;
    let tMaxX = dir.x !== 0 ? (stepX > 0 ? (x + 1 - origin.x) : (origin.x - x)) * tDeltaX : Infinity;
    let tMaxY = dir.y !== 0 ? (stepY > 0 ? (y + 1 - origin.y) : (origin.y - y)) * tDeltaY : Infinity;
    let tMaxZ = dir.z !== 0 ? (stepZ > 0 ? (z + 1 - origin.z) : (origin.z - z)) * tDeltaZ : Infinity;
    let nx = 0, ny = 0, nz = 0;
    let t = 0;
    for (let i = 0; i < 256; i++) {
      const id = this.getBlock(x, y, z);
      if (id !== AIR && !this.registry.get(id).liquid) {
        // t===0 的起点格若只是草丛/花等非实体方块，跳过：否则会返回零法线命中，
        // 导致放置/挖掘落到 (0,0,0) 法线上（异常存档或 API 传送进方块里时会触发）
        if (t > 0 || this.registry.get(id).solid) {
          return { x, y, z, nx, ny, nz, block: id, dist: t };
        }
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX; t = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0;
      } else if (tMaxY < tMaxZ) {
        y += stepY; t = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0;
      } else {
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ;
      }
      if (t > maxDist) return null;
    }
    return null;
  }
}