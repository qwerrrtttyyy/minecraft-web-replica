import type { BlockId } from '../core/types';

/**
 * 网格数据契约（主线程 / Worker 共享）。
 *
 * v1.2.0 的 meshChunk 直接依赖 World + TextureAtlas + BlockRegistry 三个活对象，
 * 无法跨线程传递。这里把「网格化真正需要的能力」收敛成 MeshSource 接口，
 * 并用一份纯数据 MeshConfig + MeshSnapshot 表达它，使得同一份 mesher 算法
 * 既能在主线程同步跑（降级路径），也能在 Worker 里跑（默认路径）。
 */

/** 图集 tile 区域：u0, v0, du, dv（du/dv 为宽高，不是终点坐标） */
export type UVRect = [number, number, number, number];

/** 网格化所需的方块属性（BlockDefinition 的渲染子集） */
export interface MeshBlockDef {
  id: BlockId;
  name: string;
  shape: 'cube' | 'cross';
  opaque: boolean;
  cullSame: boolean;
  liquid: boolean;
  transparentPass: boolean;
  lightEmission: number;
  tiles: { top: string; bottom: string; side: string };
}

export const AIR_MESH_DEF: MeshBlockDef = {
  id: 0, name: 'air', shape: 'cube', opaque: false, cullSame: false,
  liquid: false, transparentPass: false, lightEmission: 0,
  tiles: { top: '', bottom: '', side: '' },
};

export const ZERO_UV: UVRect = [0, 0, 0, 0];

/**
 * 低频配置：注册表元数据 + 图集 UV 表。
 * 只在方块/纹理注册变化时重发，不随每个网格任务传输。
 */
export interface MeshConfig {
  /** id -> 定义；空洞为 air */
  defs: (MeshBlockDef | null)[];
  /** tileName -> uv 区域 */
  uv: Record<string, UVRect>;
  bedrockId: BlockId;
  /** 是否启用 Greedy Meshing（对照基准可关闭） */
  greedy: boolean;
  /** 配置版本，用于诊断与缓存失效 */
  revision: number;
}

/** mesher 唯一的数据访问入口。坐标均为区块局部坐标，lx/lz ∈ [-1, CS] */
export interface MeshSource {
  getId(lx: number, y: number, lz: number): BlockId;
  def(id: BlockId): MeshBlockDef;
  isOpaque(id: BlockId): boolean;
  uv(tile: string): UVRect;
  readonly greedy: boolean;
}

/** 单区块方块数据快照：1 格 halo，索引 ((y*W + lz+1)*W + lx+1)，W = CS+2 */
export interface MeshSnapshot {
  cx: number;
  cz: number;
  data: Uint8Array;
}

/** 收集期的动态数组几何 */
export interface GeoArrays {
  positions: number[];
  /** 局部 UV：普通面 0..1，合并面 0..w / 0..h（shader 内 fract 平铺） */
  uvs: number[];
  colors: number[];
  /** 每顶点 u0,v0,du,dv：shader 据此把局部 UV 映射回图集 tile */
  tiles: number[];
  indices: number[];
}

export interface ChunkMeshData {
  opaque: GeoArrays | null;
  emissive: GeoArrays | null;
  transparent: GeoArrays | null;
  water: GeoArrays | null;
}

/** 可转移的紧凑几何（Worker 回传 / 主线程同步路径统一使用） */
export interface PackedGeo {
  positions: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  tiles: Float32Array;
  indices: Uint32Array;
}

export interface PackedMesh {
  opaque: PackedGeo | null;
  emissive: PackedGeo | null;
  transparent: PackedGeo | null;
  water: PackedGeo | null;
}

export interface MeshStats {
  /** 输出的 quad 总数 */
  quads: number;
  /** 输出的顶点总数 */
  vertices: number;
  /** 因合并而省掉的 quad 数（w*h - 1 累加） */
  merged: number;
  /** 网格化耗时（ms） */
  ms: number;
}

export type MeshChannel = keyof PackedMesh;

export const MESH_CHANNELS: MeshChannel[] = ['opaque', 'emissive', 'transparent', 'water'];

/** 把动态数组打包为 Transferable 视图；transfer 数组仅在 Worker 回传时需要 */
export function packMesh(d: ChunkMeshData): { mesh: PackedMesh; transfer: ArrayBuffer[] } {
  const transfer: ArrayBuffer[] = [];
  const pack = (g: GeoArrays | null): PackedGeo | null => {
    if (!g || g.indices.length === 0) return null;
    const p = new Float32Array(g.positions);
    const u = new Float32Array(g.uvs);
    const c = new Float32Array(g.colors);
    const t = new Float32Array(g.tiles);
    const i = new Uint32Array(g.indices);
    transfer.push(p.buffer, u.buffer, c.buffer, t.buffer, i.buffer);
    return { positions: p, uvs: u, colors: c, tiles: t, indices: i };
  };
  return {
    mesh: {
      opaque: pack(d.opaque), emissive: pack(d.emissive),
      transparent: pack(d.transparent), water: pack(d.water),
    },
    transfer,
  };
}

// ---- Worker 消息协议 ----

export interface MeshRequest {
  type: 'mesh';
  cx: number;
  cz: number;
  /** 代次：同一区块被反复改脏时用于丢弃过期结果 */
  generation: number;
  snapshot: MeshSnapshot;
  /** 派发到的 Worker 序号：主线程据此做 least-busy 调度与回传计数 */
  wid: number;
}

export type WorkerRequest =
  | { type: 'config'; config: MeshConfig }
  | MeshRequest;

export interface MeshResult {
  type: 'result';
  /** 处理此请求的 Worker 序号（原样回显，用于主线程回传计数） */
  wid: number;
  cx: number;
  cz: number;
  generation: number;
  mesh: PackedMesh;
  /** 诊断：合并掉的 quad 数 / 总顶点数 */
  stats: MeshStats;
}

export type WorkerResponse =
  | MeshResult
  | { type: 'error'; wid: number; cx: number; cz: number; generation: number; message: string };
