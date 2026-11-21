import { CHUNK_SIZE, WORLD_HEIGHT } from '../core/types';
import {
  AIR_MESH_DEF, ZERO_UV,
  type MeshBlockDef, type MeshConfig, type MeshSnapshot,
  type MeshSource, type UVRect,
} from './meshTypes';

/**
 * Worker 侧数据源：只依赖纯数据快照，不 import World / TextureAtlas / three，
 * 保证 Worker bundle 不含 WebGL 相关代码。
 */
const SW = CHUNK_SIZE + 2;

export class SnapshotMeshSource implements MeshSource {
  /** id → 是否遮光：AO 采样每面要查 12 次，用字节表代替对象属性链 */
  private readonly opaqueById: Uint8Array;

  constructor(
    private config: MeshConfig,
    private snapshot: MeshSnapshot,
  ) {
    const defs = config.defs;
    const flags = new Uint8Array(defs.length);
    for (let i = 0; i < defs.length; i++) if (defs[i]?.opaque) flags[i] = 1;
    this.opaqueById = flags;
  }

  getId(lx: number, y: number, lz: number): number {
    if (y < 0) return this.config.bedrockId;
    if (y >= WORLD_HEIGHT) return 0;
    const W = SW;
    const ix = lx + 1;
    const iz = lz + 1;
    if (ix < 0 || ix >= W || iz < 0 || iz >= W) return 0;
    return this.snapshot.data[((y * W) + iz) * W + ix];
  }

  def(id: number): MeshBlockDef {
    return this.config.defs[id] ?? AIR_MESH_DEF;
  }

  isOpaque(id: number): boolean {
    return this.opaqueById[id] === 1;
  }

  getSkyLight(lx: number, y: number, lz: number): number {
    if (y >= WORLD_HEIGHT) return 15;
    if (y < 0) return 0;
    const W = SW;
    const ix = lx + 1;
    const iz = lz + 1;
    if (ix < 0 || ix >= W || iz < 0 || iz >= W) return 15;
    return this.snapshot.sky[((y * W) + iz) * W + ix];
  }

  getBlockLight(lx: number, y: number, lz: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return 0;
    const W = SW;
    const ix = lx + 1;
    const iz = lz + 1;
    if (ix < 0 || ix >= W || iz < 0 || iz >= W) return 0;
    return this.snapshot.block[((y * W) + iz) * W + ix];
  }

  uv(tile: string): UVRect {
    return this.config.uv[tile] ?? ZERO_UV;
  }

  get greedy(): boolean {
    return this.config.greedy;
  }

  get mergeEmissive(): boolean {
    return this.config.mergeEmissive;
  }
}
