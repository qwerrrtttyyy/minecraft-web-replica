import * as THREE from 'three';
import { CHUNK_SIZE, WORLD_HEIGHT, chunkKey, clamp, type BlockId } from '../core/types';
import type { EventBus } from '../core/events';
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

interface EditEntry {
  /** 生成器原始方块；-1 表示旧存档载入、尚未与生成结果比对 */
  original: BlockId;
  current: BlockId;
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
  /** 玩家改动差分：按区块分桶，只遍历本区块的编辑 */
  private editsByChunk = new Map<string, Map<number, EditEntry>>();
  /** 待重新网格化的区块 */
  readonly dirty = new Set<string>();
  readonly light: LightEngine;
  private bedrockId: BlockId;

  constructor(
    readonly registry: BlockRegistry,
    public generator: IWorldGenerator,
    readonly events: EventBus,
  ) {
    this.bedrockId = registry.byNameGet('bedrock')?.id ?? 3;
    this.light = new LightEngine(this);
  }

  getChunk(cx: number, cz: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cz));
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
      // 应用玩家编辑差分：只遍历本区块那一桶
      const bucket = this.editsByChunk.get(key);
      if (bucket) {
        for (const [index, e] of bucket) {
          if (e.original < 0) e.original = chunk.data[index];
          chunk.data[index] = e.current;
        }
      }
      chunk.generated = true;
      // 生成后立刻初始化天空光/方块光（编辑已经在上面应用）
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
    if (record) this.recordEdit(chunkKey(cx, cz), chunk.idx(lx, y, lz), old, id);
    // 光照增量更新（会把受影响的区块标脏）
    this.light.updateBlock(x, y, z, old, id);
    this.dirty.add(chunkKey(cx, cz));
    if (lx === 0) this.dirty.add(chunkKey(cx - 1, cz));
    if (lx === CS - 1) this.dirty.add(chunkKey(cx + 1, cz));
    if (lz === 0) this.dirty.add(chunkKey(cx, cz - 1));
    if (lz === CS - 1) this.dirty.add(chunkKey(cx, cz + 1));
    return true;
  }

  // ---------- 编辑差分（按区块分桶） ----------

  private recordEdit(ck: string, index: number, oldId: BlockId, newId: BlockId) {
    let bucket = this.editsByChunk.get(ck);
    if (!bucket) {
      bucket = new Map();
      this.editsByChunk.set(ck, bucket);
    }
    const entry = bucket.get(index);
    if (!entry) {
      bucket.set(index, { original: oldId, current: newId });
    } else {
      entry.current = newId;
      // 改回生成器的原始方块后，这条差分已经没有存在价值
      if (entry.original >= 0 && entry.current === entry.original) bucket.delete(index);
    }
    if (bucket.size === 0) this.editsByChunk.delete(ck);
  }

  get editCount(): number {
    let n = 0;
    for (const bucket of this.editsByChunk.values()) n += bucket.size;
    return n;
  }

  /** 从存档载入差分（旧格式：'x,y,z' -> blockId） */
  loadEdits(entries: [string, BlockId][]) {
    for (const [k, id] of entries) {
      if (typeof k !== 'string' || typeof id !== 'number') continue;
      const [x, y, z] = k.split(',').map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      if (y < 0 || y >= H) continue;
      const cx = Math.floor(x / CS);
      const cz = Math.floor(z / CS);
      const ck = chunkKey(cx, cz);
      let bucket = this.editsByChunk.get(ck);
      if (!bucket) {
        bucket = new Map();
        this.editsByChunk.set(ck, bucket);
      }
      const lx = x - cx * CS;
      const lz = z - cz * CS;
      bucket.set((y * CS + lz) * CS + lx, { original: -1, current: id });
    }
  }

  /** 导出为存档格式（'x,y,z' -> blockId），保持 v2 存档兼容 */
  serializeEdits(): [string, BlockId][] {
    const out: [string, BlockId][] = [];
    for (const [ck, bucket] of this.editsByChunk) {
      const [cx, cz] = ck.split(',').map(Number);
      for (const [index, e] of bucket) {
        const y = (index / (CS * CS)) | 0;
        const rest = index - y * CS * CS;
        const lz = (rest / CS) | 0;
        const lx = rest - lz * CS;
        out.push([`${cx * CS + lx},${y},${cz * CS + lz}`, e.current]);
      }
    }
    return out;
  }

  /** 渲染用天空光（未加载区块按露天处理，避免边界发黑） */
  getSkyLight(x: number, y: number, z: number): number {
    if (y >= H) return 15;
    if (y < 0) return 0;
    const cx = Math.floor(x / CS);
    const cz = Math.floor(z / CS);
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c || !c.lit) return 15;
    return c.sky[c.idx(x - cx * CS, y, z - cz * CS)];
  }

  getBlockLight(x: number, y: number, z: number): number {
    if (y >= H || y < 0) return 0;
    const cx = Math.floor(x / CS);
    const cz = Math.floor(z / CS);
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c || !c.lit) return 0;
    return c.block[c.idx(x - cx * CS, y, z - cz * CS)];
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