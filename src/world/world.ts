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
      this.chunks.set(key, chunk);
    }
    if (!chunk.generated) {
      this.generator.generateChunk(cx, cz, chunk.data);
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
    return chunk;
  }

  getBlock(x: number, y: number, z: number): BlockId {
    if (y < 0) return this.bedrockId;
    if (y >= H) return AIR;
    const cx = Math.floor(x / CS);
    const cz = Math.floor(z / CS);
    const chunk = this.chunks.get(chunkKey(cx, cz));
    if (!chunk || !chunk.generated) return AIR;
    return chunk.data[chunk.idx(x - cx * CS, y, z - cz * CS)];
  }

  /** 渲染用天空光（未加载 / 未初始化区块按露天处理，避免边界发黑） */
  getSkyLight(x: number, y: number, z: number): number {
    if (y >= H) return 15;
    if (y < 0) return 0;
    const cx = Math.floor(x / CS);
    const cz = Math.floor(z / CS);
    const chunk = this.chunks.get(chunkKey(cx, cz));
    if (!chunk || !chunk.lit) return 15;
    return chunk.sky[chunk.idx(x - cx * CS, y, z - cz * CS)];
  }

  /** 渲染用方块光（未加载区块为 0） */
  getBlockLight(x: number, y: number, z: number): number {
    if (y < 0 || y >= H) return 0;
    const cx = Math.floor(x / CS);
    const cz = Math.floor(z / CS);
    const chunk = this.chunks.get(chunkKey(cx, cz));
    if (!chunk || !chunk.lit) return 0;
    return chunk.block[chunk.idx(x - cx * CS, y, z - cz * CS)];
  }

  /** 物理碰撞用：未加载区块视为实心，防止掉出世界 */
  isSolidAt(x: number, y: number, z: number): boolean {
    if (y < 0) return true;
    if (y >= H) return false;
    const cx = Math.floor(x / CS);
    const cz = Math.floor(z / CS);
    const chunk = this.chunks.get(chunkKey(cx, cz));
    if (!chunk || !chunk.generated) return true;
    return this.registry.isSolid(chunk.data[chunk.idx(x - cx * CS, y, z - cz * CS)]);
  }

  setBlock(x: number, y: number, z: number, id: BlockId, record = true): boolean {
    if (y < 1 || y >= H) return false;
    const cx = Math.floor(x / CS);
    const cz = Math.floor(z / CS);
    const chunk = this.ensureChunk(cx, cz);
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
    // 角格改方块：对角区块的角落顶点 AO / 光照会采样到这一格，必须一并重网格化。
    if (lx === 0 && lz === 0) this.dirty.add(chunkKey(cx - 1, cz - 1));
    if (lx === 0 && lz === CS - 1) this.dirty.add(chunkKey(cx - 1, cz + 1));
    if (lx === CS - 1 && lz === 0) this.dirty.add(chunkKey(cx + 1, cz - 1));
    if (lx === CS - 1 && lz === CS - 1) this.dirty.add(chunkKey(cx + 1, cz + 1));
    return true;
  }

  /**
   * 生成期装饰写入：只改已生成区块的数据，不记录玩家编辑差分、不标脏、
   * 不触发光照增量更新——与 DefaultGenerator.stageDecorate 直接写 data 的语义一致。
   * 网格由 ChunkManager 在本次生成后统一派发，因此新植物会被包含进去。
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