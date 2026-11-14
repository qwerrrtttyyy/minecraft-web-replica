import * as THREE from 'three';
import { CHUNK_SIZE, WORLD_HEIGHT, chunkKey, blockKey, clamp, type BlockId } from '../core/types';
import type { EventService } from '../services/events';
import type { BlockRegistry } from './blocks';
import { AIR } from './blocks';
import type { IWorldGenerator } from './generator';
import { LightEngine } from './light';

const CS = CHUNK_SIZE;
const H = WORLD_HEIGHT;

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
  /** 编辑差分按 chunkKey 分桶：ensureChunk 从 O(全档编辑数) 降到 O(本区块编辑数) */
  private editsByChunk = new Map<string, Map<string, BlockId>>();
  private bedrockId: BlockId;

  constructor(
    readonly registry: BlockRegistry,
    public generator: IWorldGenerator,
    readonly events: EventService,
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
    const [x, , z] = k.split(',').map(Number);
    const ck = chunkKey(Math.floor(x / CS), Math.floor(z / CS));
    let bucket = this.editsByChunk.get(ck);
    if (!bucket) {
      bucket = new Map();
      this.editsByChunk.set(ck, bucket);
    }
    bucket.set(k, id);
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
      // 应用玩家编辑差分（分桶后不再扫描全档）
      const x0 = cx * CS;
      const z0 = cz * CS;
      const bucket = this.editsByChunk.get(key);
      if (bucket) {
        for (const [k, id] of bucket) {
          const [x, y, z] = k.split(',').map(Number);
          if (x >= x0 && x < x0 + CS && z >= z0 && z < z0 + CS && y >= 0 && y < H) {
            chunk.data[chunk.idx(x - x0, y, z - z0)] = id;
          }
        }
      }
      chunk.generated = true;
      // 生成 + 存档差分都已落地，再初始化天空光 / 方块光
      this.light.initChunk(chunk);
      // 邻接已网格化区块需要重绘边界面
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
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
    for (let y = start; y >= 0; y--) {
      if (this.registry.isSolid(chunk.data[chunk.idx(lx, y, lz)])) return y;
    }
    // 地形被挖空时，向上找玩家建造的落脚点
    for (let y = start + 1; y < H; y++) {
      if (this.registry.isSolid(chunk.data[chunk.idx(lx, y, lz)])) return y;
    }
    return terrain;
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