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
  shape: 'cube' | 'cross' | 'slab' | 'candle';
  opaque: boolean;
  cullSame: boolean;
  liquid: boolean;
  transparentPass: boolean;
  lightEmission: number;
  tiles: { top: string; bottom: string; side: string };
  /** 群系染色（草 / 叶 / 藤蔓）：灰度纹理，shader 按世界坐标噪声乘群系色 */
  tint: boolean;
  /** 十字面植物的可视高度（0~1，默认 1）：只影响几何，不改变碰撞 */
  crossHeight: number;
}

export const AIR_MESH_DEF: MeshBlockDef = {
  id: 0, name: 'air', shape: 'cube', opaque: false, cullSame: false,
  liquid: false, transparentPass: false, lightEmission: 0,
  tiles: { top: '', bottom: '', side: '' }, tint: false, crossHeight: 1,
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
  /**
   * 自发光是否并入不透明通道（aTint=2）。
   * false = 保留独立的 emissive 通道，仅作为实验对照（?emerge=0），默认 true。
   */
  mergeEmissive: boolean;
  /** 配置版本，用于诊断与缓存失效 */
  revision: number;
}

/** mesher 唯一的数据访问入口。坐标均为区块局部坐标，lx/lz ∈ [-1, CS] */
export interface MeshSource {
  getId(lx: number, y: number, lz: number): BlockId;
  def(id: BlockId): MeshBlockDef;
  isOpaque(id: BlockId): boolean;
  /** 天空光 0~15（未加载区块按露天返回 15） */
  getSkyLight(lx: number, y: number, lz: number): number;
  /** 方块光 0~15 */
  getBlockLight(lx: number, y: number, lz: number): number;
  /**
   * 该坐标的数据来源是否可信（可选，缺省视为 true）。
   * 液体面在邻居来源未知时保守不生成，避免 halo 缺失被当作空气而产生虚假水面。
   */
  isKnown?(lx: number, y: number, lz: number): boolean;
  uv(tile: string): UVRect;
  readonly greedy: boolean;
  /** 自发光是否并入不透明通道（与 MeshConfig.mergeEmissive 同步） */
  readonly mergeEmissive: boolean;
}

/** 单区块方块数据快照：1 格 halo，索引 ((y*W + lz+1)*W + lx+1)，W = CS+2 */
export interface MeshSnapshot {
  cx: number;
  cz: number;
  data: Uint8Array;
  sky: Uint8Array;
  block: Uint8Array;
  /**
   * 1 = 该 halo 格来自真实已生成区块；0 = 邻居缺失，data 里的 0 只是空气占位。
   * 与 data 同尺寸同索引。旧调用方缺此字段时 SnapshotMeshSource 按全已知兼容。
   */
  known: Uint8Array;
}

/**
 * 收集期的动态数组几何（顶点打包后的布局，每顶点 11 个 float）：
 * position(3) + uv(2) + shade(1) + light(2) + tile(2) + flags(1) = 44 字节。
 * 旧布局每顶点 15 个 float（60 字节），其中 color 三分量同值、tile 的 du/dv 全图集一致，
 * 纯冗余 —— 详见 docs/EXPERIMENTS.md 实验 E1。
 */
/**
 * 收集期的几何数组：普通 number[]（历史路径）或预分配 typed array（去 GC 路径）。
 * 两者都能被 packMesh 直接消费；typed array 的多余容量由 GeoArrays.used 标出。
 */
export type GeoArray = number[] | Float32Array | Uint32Array;

export interface GeoArrays {
  positions: GeoArray;
  /** 局部 UV：普通面 0..1，合并面 0..w / 0..h（shader 内 fract 平铺） */
  uvs: GeoArray;
  /** 每顶点明暗（面定向 × AO，0~1）：RGB 三通道同值，只需 1 个分量 */
  shade: GeoArray;
  /** 每顶点天空光 / 方块光（0~1），shader 据此叠加昼夜与方块光源 */
  lights: GeoArray;
  /** 每顶点图集 tile 起点 u0,v0；tile 尺寸全图集一致，走 shader uniform */
  tile: GeoArray;
  /** 每顶点开关：0 普通、1 群系染色、2 自发光（不受光照与染色影响） */
  tints: GeoArray;
  /** 每顶点风摆权重（0~1）：普通方块为 0，十字面植物由底部 0 渐变到顶部（= 植物高度） */
  sways: GeoArray;
  indices: number[] | Uint32Array;
  /**
   * 预分配 typed array 时各分量的「已写入元素数」。
   * typed array 的 length 等于容量（可能远大于实际写入数），必须靠 used 才知道
   * 哪些元素是真实几何；未声明的分量按整个数组打包。
   * 普通 number[] 的 length 即已写入数，不需要填写 used（填了也忽略）。
   */
  used?: {
    positions?: number;
    uvs?: number;
    shade?: number;
    lights?: number;
    tile?: number;
    tints?: number;
    sways?: number;
    indices?: number;
  };
}

/** 收集期专用的窄类型：所有分量仍是普通 number[]，因此可 .push。 */
export type MutableGeoArrays = {
  [K in Exclude<keyof GeoArrays, 'used'>]: number[];
};

export interface ChunkMeshData {
  opaque: GeoArrays | null;
  /** 仅 mergeEmissive=false 时才有内容（实验对照） */
  emissive: GeoArrays | null;
  transparent: GeoArrays | null;
  water: GeoArrays | null;
}

/** 收集期窄类型：四通道都是 MutableGeoArrays，结构上可赋值给 ChunkMeshData。 */
export type MutableChunkMeshData = {
  [K in keyof ChunkMeshData]: MutableGeoArrays | null;
};

/** 可转移的紧凑几何（Worker 回传 / 主线程同步路径统一使用） */
export interface PackedGeo {
  positions: Float32Array;
  uvs: Float32Array;
  shade: Float32Array;
  lights: Float32Array;
  tile: Float32Array;
  tints: Float32Array;
  sways: Float32Array;
  indices: Uint32Array;
}

export interface PackedMesh {
  opaque: PackedGeo | null;
  /** 仅 mergeEmissive=false 时才有内容（实验对照） */
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

/** typed array 类型守卫：避免 any，同时保留 subarray 方法 */
const isTypedArray = (a: GeoArray): a is Float32Array | Uint32Array => ArrayBuffer.isView(a);

/**
 * 取「已写入前缀」：typed array 按 used 做 subarray（未声明则取整数组），
 * 普通 number[] 的 length 就是已写入数，原样返回。
 */
const geoView = (a: GeoArray, used?: number): ArrayLike<number> =>
  isTypedArray(a) ? (used === undefined ? a : a.subarray(0, used)) : a;

/** 把动态数组打包为 Transferable 视图；transfer 数组仅在 Worker 回传时需要 */
export function packMesh(d: ChunkMeshData): { mesh: PackedMesh; transfer: ArrayBuffer[] } {
  const transfer: ArrayBuffer[] = [];
  const pack = (g: GeoArrays | null): PackedGeo | null => {
    if (!g || (g.used?.indices ?? g.indices.length) === 0) return null;
    const p = new Float32Array(geoView(g.positions, g.used?.positions));
    const u = new Float32Array(geoView(g.uvs, g.used?.uvs));
    const s = new Float32Array(geoView(g.shade, g.used?.shade));
    const l = new Float32Array(geoView(g.lights, g.used?.lights));
    const t = new Float32Array(geoView(g.tile, g.used?.tile));
    const tn = new Float32Array(geoView(g.tints, g.used?.tints));
    const sw = new Float32Array(geoView(g.sways, g.used?.sways));
    const i = new Uint32Array(geoView(g.indices, g.used?.indices));
    transfer.push(p.buffer, u.buffer, s.buffer, l.buffer, t.buffer, tn.buffer, sw.buffer, i.buffer);
    return { positions: p, uvs: u, shade: s, lights: l, tile: t, tints: tn, sways: sw, indices: i };
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
  /** M06：派发时的配置版本；Worker 原样回显，失效后的结果不得落地 */
  configRevision: number;
  snapshot: MeshSnapshot;
  /** 派发到的 Worker 序号：主线程据此做 least-busy 调度与回传计数 */
  wid: number;
}

export type WorkerRequest =
  | { type: 'config'; config: MeshConfig; wid: number }
  | MeshRequest;

export interface MeshResult {
  type: 'result';
  /** 处理此请求的 Worker 序号（原样回显，用于主线程回传计数） */
  wid: number;
  cx: number;
  cz: number;
  generation: number;
  /** M06：派发时的配置版本（原样回显） */
  configRevision: number;
  mesh: PackedMesh;
  /** 诊断：合并掉的 quad 数 / 总顶点数 */
  stats: MeshStats;
}

export type WorkerResponse =
  | MeshResult
  | { type: 'config-ack'; wid: number; revision: number }
  | {
    type: 'error'; wid: number; cx: number; cz: number; generation: number;
    configRevision: number; message: string;
  };

/**
 * M06：判断 Worker 结果是否因配置失效而过期。
 * 缺字段（旧 Worker / 注入消息）一律视为过期，避免旧方块元数据污染新网格。
 */
export function isStaleConfigRevision(
  msgRevision: number | undefined,
  currentRevision: number,
): boolean {
  return msgRevision === undefined || msgRevision !== currentRevision;
}
