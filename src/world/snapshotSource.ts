import { CHUNK_SIZE, SECTION_HEIGHT, WORLD_HEIGHT } from '../core/types';
import {
  AIR_MESH_DEF,
  type MeshBlockDef,
  type MeshConfig,
  type MeshSnapshot,
  type MeshSource,
  type UVRect,
  ZERO_UV,
} from './meshTypes';

/**
 * Worker 侧数据源：只依赖纯数据快照，不 import World / TextureAtlas / three，
 * 保证 Worker bundle 不含 WebGL 相关代码。
 */
const SW = CHUNK_SIZE + 2;

export class SnapshotMeshSource implements MeshSource {
  /** id → 是否遮光：AO 采样每面要查 12 次，用字节表代替对象属性链 */
  private readonly opaqueById: Uint8Array;
  /** 快照覆盖的层数：section（18 层）或整列（82 层，测试 / 旧调用方） */
  private readonly sh: number;
  /** 快照首行对应的绝对 y；旧快照（整列、无 y0）按 -1 处理 */
  private readonly y0: number;

  constructor(
    private config: MeshConfig,
    private snapshot: MeshSnapshot,
  ) {
    // 从数据长度反推层数，而不是写死 18：整列快照仍可被同一套逻辑消费
    this.sh = snapshot.data.length / (SW * SW);
    // 无 y0 的旧快照有两种布局：H 行（y0=0，测试构造）与 H+2 行（y0=-1，含上下 halo）
    this.y0 = snapshot.y0 ?? (this.sh === WORLD_HEIGHT ? 0 : -1);
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
    // 快照可能是 section 切片（y0 = sy*16 - 1），入参是绝对 y，这里换算成行号
    const row = y - this.y0;
    if (row < 0 || row >= this.sh) return 0;
    return this.snapshot.data[(row * W + iz) * W + ix];
  }

  /**
   * N4：越界 halo / 缺失邻居的 data 恒为 0，必须能让液体面区分它和真实空气。
   * y 越界是确定的基岩/空气边界，不是来源未知，返回 true 保持原有几何。
   * 旧快照没有 known 字段时按全已知兼容（缺省契约）。
   */
  isKnown(lx: number, y: number, lz: number): boolean {
    if (y < 0 || y >= WORLD_HEIGHT) return true;
    const known = this.snapshot.known;
    if (!known) return true;
    const W = SW;
    const ix = lx + 1;
    const iz = lz + 1;
    if (ix < 0 || ix >= W || iz < 0 || iz >= W) return false;
    const row = y - this.y0;
    if (row < 0 || row >= this.sh) return false;
    return known[(row * W + iz) * W + ix] === 1;
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
    const row = y - this.y0;
    if (row < 0 || row >= this.sh) return 15;
    return this.snapshot.sky[(row * W + iz) * W + ix];
  }

  getBlockLight(lx: number, y: number, lz: number): number {
    if (y < 0 || y >= WORLD_HEIGHT) return 0;
    const W = SW;
    const ix = lx + 1;
    const iz = lz + 1;
    if (ix < 0 || ix >= W || iz < 0 || iz >= W) return 0;
    const row = y - this.y0;
    if (row < 0 || row >= this.sh) return 0;
    return this.snapshot.block[(row * W + iz) * W + ix];
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
