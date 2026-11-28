import { CHUNK_SIZE, WORLD_HEIGHT } from '../core/types';
import type { BlockRegistry, BlockShape } from './blocks';
import type { TextureAtlas } from '../gfx/atlas';
import type { World, Chunk } from './world';
import {
  AIR_MESH_DEF, ZERO_UV,
  type MeshBlockDef, type MeshConfig, type MeshSnapshot,
  type MeshSource, type UVRect,
} from './meshTypes';

/**
 * 主线程侧：把活对象（World / TextureAtlas / BlockRegistry）投影为可序列化的
 * MeshConfig + MeshSnapshot。Worker 侧只需 SnapshotMeshSource（见 snapshotSource.ts）。
 */

const CS = CHUNK_SIZE;
const H = WORLD_HEIGHT;
const W = CS + 2;

const toMeshDef = (d: { id: number; name: string; shape: BlockShape; opaque: boolean; cullSame?: boolean; liquid: boolean; transparentPass: boolean; lightEmission: number; tiles: { top: string; bottom: string; side: string }; tint?: boolean; crossHeight?: number }): MeshBlockDef => ({
  id: d.id,
  name: d.name,
  shape: d.shape,
  opaque: d.opaque,
  cullSame: d.cullSame ?? false,
  liquid: d.liquid,
  transparentPass: d.transparentPass,
  lightEmission: d.lightEmission,
  tiles: { top: d.tiles.top, bottom: d.tiles.bottom, side: d.tiles.side },
  tint: d.tint ?? false,
  crossHeight: d.crossHeight ?? 1,
});

/** 构建低频配置。revision 由调用方维护，方块/纹理注册变化时必须重建。 */
export function buildMeshConfig(
  registry: BlockRegistry,
  atlas: TextureAtlas,
  greedy: boolean,
  revision: number,
  mergeEmissive = true,
): MeshConfig {
  const defs: (MeshBlockDef | null)[] = [null];
  for (const d of registry.all()) {
    const m = toMeshDef(d);
    while (defs.length <= m.id) defs.push(null);
    defs[m.id] = m;
  }
  const uv: Record<string, UVRect> = { '': ZERO_UV };
  const addTile = (name: string) => {
    if (!name || uv[name]) return;
    const [u0, v0, u1, v1] = atlas.uv(name);
    uv[name] = [u0, v0, u1 - u0, v1 - v0];
  };
  for (const d of defs) {
    if (!d) continue;
    addTile(d.tiles.top);
    addTile(d.tiles.bottom);
    addTile(d.tiles.side);
  }
  return {
    defs,
    uv,
    bedrockId: registry.byNameGet('bedrock')?.id ?? 3,
    greedy,
    mergeEmissive,
    revision,
  };
}

/**
 * 提取一个区块及其 1 格 halo 的方块数据。
 * 网格化最远只会访问 lx/lz ∈ [-1, CS]（面剔除 + 逐顶点 AO），
 * y ∈ [-1, H] 由 MeshSource 直接返回基岩/空气，无需额外数据。
 *
 * 热路径优化：中心 16×16 按 y 行整段拷贝，halo 直接读 8 个邻居的 data，
 * 不再逐格走 world.getBlock 的字符串 key 查找。
 */
export function buildMeshSnapshot(world: World, cx: number, cz: number): MeshSnapshot {
  const data = new Uint8Array(W * H * W);
  // 未生成邻居按露天处理（与 World.getSkyLight 一致），避免世界边缘发黑
  const sky = new Uint8Array(W * H * W).fill(15);
  const block = new Uint8Array(W * H * W);
  // N4：区分「已知空气」与「邻居未生成时的空气占位」，供液体面保守剔除使用
  const known = new Uint8Array(W * H * W);
  const chunk = world.getChunk(cx, cz);

  // 3×3 邻居一次取齐；缺失 / 未生成的区块在快照里保持 0（等价于 getBlock 返回空气）
  const nb: (Chunk | null)[] = new Array(9);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const c = world.getChunk(cx + dx, cz + dz);
      nb[(dz + 1) * 3 + (dx + 1)] = c && c.generated ? c : null;
    }
  }

  const copy = (dst: Uint8Array, arr: (c: Chunk) => Uint8Array, trackKnown = false) => {
    // 只在写 data 时同步记录来源可信度；缺失邻居保持 0，不被当作已知空气
    const mark = (i: number) => { if (trackKnown) known[i] = 1; };
    // 中心区：每行 16 字节连续
    if (chunk) {
      const src = arr(chunk);
      const centerKnown = chunk.generated;
      for (let y = 0; y < H; y++) {
        const srcRow = y * CS * CS;
        for (let lz = 0; lz < CS; lz++) {
          const s = srcRow + lz * CS;
          const d = (y * W + lz + 1) * W + 1;
          dst.set(src.subarray(s, s + CS), d);
          if (trackKnown && centerKnown) known.fill(1, d, d + CS);
        }
      }
    }

    const north = nb[0] && arr(nb[0]);
    const northMid = nb[1] && arr(nb[1]);
    const northE = nb[2] && arr(nb[2]);
    const midW = nb[3] && arr(nb[3]);
    const midE = nb[5] && arr(nb[5]);
    const south = nb[6] && arr(nb[6]);
    const southMid = nb[7] && arr(nb[7]);
    const southE = nb[8] && arr(nb[8]);

    for (let y = 0; y < H; y++) {
      const yRow = y * CS * CS;
      const dRow = y * W * W;
      // 北 / 南整行（左邻 1 格 + 中邻 16 格 + 右邻 1 格）
      const nBase = dRow;
      const sBase = dRow + (CS + 1) * W;
      // 邻居行：北侧 local z = CS-1，南侧 local z = 0
      const nRow = yRow + (CS - 1) * CS;
      const sRow = yRow;
      if (north) { dst[nBase] = north[nRow + CS - 1]; mark(nBase); }
      if (northMid) { dst.set(northMid.subarray(nRow, nRow + CS), nBase + 1); if (trackKnown) known.fill(1, nBase + 1, nBase + 1 + CS); }
      if (northE) { dst[nBase + CS + 1] = northE[nRow]; mark(nBase + CS + 1); }
      if (south) { dst[sBase] = south[sRow + CS - 1]; mark(sBase); }
      if (southMid) { dst.set(southMid.subarray(sRow, sRow + CS), sBase + 1); if (trackKnown) known.fill(1, sBase + 1, sBase + 1 + CS); }
      if (southE) { dst[sBase + CS + 1] = southE[sRow]; mark(sBase + CS + 1); }

      // 西 / 东两列
      for (let lz = 0; lz < CS; lz++) {
        const d = dRow + (lz + 1) * W;
        const s = yRow + lz * CS;
        if (midW) { dst[d] = midW[s + CS - 1]; mark(d); }
        if (midE) { dst[d + CS + 1] = midE[s]; mark(d + CS + 1); }
      }
    }
  };

  copy(data, (c) => c.data, true);
  copy(sky, (c) => c.sky);
  copy(block, (c) => c.block);
  return { cx, cz, data, sky, block, known };
}

/** 主线程同步路径（Worker 不可用时的降级，也用于基准对照） */
export class WorldMeshSource implements MeshSource {
  constructor(
    private world: World,
    private x0: number,
    private z0: number,
    private config: MeshConfig,
  ) {}

  getId(lx: number, y: number, lz: number): number {
    return this.world.getBlock(this.x0 + lx, y, this.z0 + lz);
  }

  def(id: number): MeshBlockDef {
    return this.config.defs[id] ?? AIR_MESH_DEF;
  }

  isOpaque(id: number): boolean {
    return this.def(id).opaque;
  }

  getSkyLight(lx: number, y: number, lz: number): number {
    return this.world.getSkyLight(this.x0 + lx, y, this.z0 + lz);
  }

  getBlockLight(lx: number, y: number, lz: number): number {
    return this.world.getBlockLight(this.x0 + lx, y, this.z0 + lz);
  }

  /**
   * N4：活世界侧同样要区分「未生成区块的空气占位」与真实空气。
   * 快照路径按 known 位图判断；这里用区块是否 generated 判断，
   * 保证 worker 失败回退主线程时液体面几何与 worker 路径一致。
   */
  isKnown(lx: number, y: number, lz: number): boolean {
    if (y < 0 || y >= H) return true;
    const cx = Math.floor((this.x0 + lx) / CS);
    const cz = Math.floor((this.z0 + lz) / CS);
    return this.world.getChunk(cx, cz)?.generated === true;
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
