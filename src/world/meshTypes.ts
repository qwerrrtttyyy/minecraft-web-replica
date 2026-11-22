import type { BlockId } from '../core/types';

/**
 * 顶点字节口径 —— 全项目唯一来源（T1 前置 gate）。
 *
 * 在统一之前，仓库里同时存在「注释 11 float / 44 B」与「实际 12 float / 48 B」两套说法，
 * 实验闸门按 44 B 判定，导致 E1 必然误判失败。这里把两档口径收敛为常量：
 * 任何引用方（buildGeo / experiment / mesher 断言 / 文档）都从这里派生，不得再写死 12 / 44 / 48。
 *
 * 布局恒等式：各 attribute 分量之和 === VERTEX_FLOATS（基线）。
 * T3 起 aLight 的 sky/block 两分量各取 0~15 整数，打包进一个 float 的高/低 4 位；
 * 每顶点少 1 个 float，即 VERTEX_BYTES → VERTEX_BYTES_QUANTIZED（48 B → 44 B）。
 * 基线常量保留为历史对照口径，实际生效档由 ACTIVE_LIGHT_FLOATS 派生。
 */
export const VERTEX_FLOATS = 12 as const;
/** T1 基线：12 float × 4 B = 48 B（aLight 两个 float），仅作历史对照 */
export const VERTEX_BYTES = VERTEX_FLOATS * Float32Array.BYTES_PER_ELEMENT;
/** aLight 位域量化档：11 float / 44 B，T3 起为实际生效档 */
export const VERTEX_BYTES_QUANTIZED = VERTEX_BYTES - Float32Array.BYTES_PER_ELEMENT;

/** T1 基线 attribute 布局（aLight 占 2 个 float），供对照与恒等式校验 */
export const VERTEX_ATTRIBUTES = {
  position: 3,
  uv: 2,
  aShade: 1,
  aLight: 2,
  aTileOrigin: 2,
  aTint: 1,
  aSway: 1,
} as const;

/**
 * 当前生效的 aLight 分量数（T3 起恒为 1）。
 * mesher 与 Worker 共用同一份打包代码，因此不存在「按档位切两套算法」的分支。
 */
export const ACTIVE_LIGHT_FLOATS = 1 as const;

/** 当前生效的 attribute 布局：把基线的 aLight=2 替换为量化档的 1 */
export const VERTEX_ATTRIBUTES_ACTIVE = {
  ...VERTEX_ATTRIBUTES,
  aLight: ACTIVE_LIGHT_FLOATS,
} as const;

/** 当前生效的每顶点 float 数与字节数（11 / 44），由布局对象推导，不写死 11 / 44 */
export const VERTEX_FLOATS_ACTIVE = VERTEX_FLOATS - VERTEX_ATTRIBUTES.aLight + VERTEX_ATTRIBUTES_ACTIVE.aLight;
export const VERTEX_BYTES_ACTIVE = VERTEX_FLOATS_ACTIVE * Float32Array.BYTES_PER_ELEMENT;

/** 光照等级档数：sky / block 各 0~15，共 16 档 */
export const LIGHT_LEVELS = 16 as const;

/**
 * 把归一化到 0~1 的 sky/block 光照打包为一个 float（整数 0~255）。
 *
 * 编码：packed = skyLevel * 16 + blockLevel。
 * sky/block 在 mesher 里本就是 0~15 的整数（角点 4 格均值四舍五入），
 * 因此位域编码**无损**；Float32 可精确表示 0~255 的整数。
 * shader 侧用 floor(packed / 16) 与 mod(packed, 16) 解码后除以 15 还原 0~1。
 */
export function packLightLevels(sky01: number, block01: number): number {
  const sky = Math.max(0, Math.min(LIGHT_LEVELS - 1, Math.round(sky01 * (LIGHT_LEVELS - 1))));
  const block = Math.max(0, Math.min(LIGHT_LEVELS - 1, Math.round(block01 * (LIGHT_LEVELS - 1))));
  return sky * LIGHT_LEVELS + block;
}

/** packLightLevels 的逆运算，供测试与调试解码；返回 0~15 的整数档位 */
export function unpackLight(packed: number): [number, number] {
  const v = Math.round(packed);
  return [Math.floor(v / LIGHT_LEVELS), v % LIGHT_LEVELS];
}

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
  /** 群系染色（草 / 叶 / 藤蔓）：灰度纹理，shader 按世界坐标噪声乘群系色 */
  tint: boolean;
  /** 十字面植物的可视高度（0~1，默认 1）：只影响几何，不改变碰撞 */
  crossHeight: number;
}

export const AIR_MESH_DEF: MeshBlockDef = {
  id: 0,
  name: 'air',
  shape: 'cube',
  opaque: false,
  cullSame: false,
  liquid: false,
  transparentPass: false,
  lightEmission: 0,
  tiles: { top: '', bottom: '', side: '' },
  tint: false,
  crossHeight: 1,
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
  /**
   * E4 边界光修复：越出本区块的角点采样优先走 MeshSource.crossChunkLight。
   * false = 现状（halo 边界即止）；变更经 invalidateConfig + ACK 下发。
   */
  boundaryLightFix: boolean;
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
  /** E4 开关（与 MeshConfig.boundaryLightFix 同步） */
  readonly boundaryLightFix: boolean;
  /**
   * E4 可选回调：角点采样越出本区块 [0, CS-1] 时取真实邻块光照。
   * 坐标为**区块局部坐标**（与 getSkyLight/getBlockLight 同口径），由各 source 自行换算世界坐标。
   * Worker 侧 SnapshotMeshSource 只用 1 格 halo 快照实现，绝不 import World / three。
   */
  crossChunkLight?(lx: number, y: number, lz: number, channel: 'sky' | 'block'): number;
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
 * 收集期的动态数组几何（顶点打包后的布局）。
 *
 * 当前基线为 VERTEX_FLOATS 个 float / VERTEX_BYTES 字节：
 * position(3) + uv(2) + shade(1) + light(2) + tile(2) + tint(1) + sway(1)。
 * aLight 量化档把 light 由 2 个 float 合并为 1 个位域 float，变为
 * VERTEX_BYTES_QUANTIZED 字节（见 src/world/meshTypes.ts 顶部常量）。
 * 更早的布局每顶点 15 个 float（60 字节），其中 color 三分量同值、tile 的 du/dv
 * 全图集一致，纯冗余 —— 详见 docs/EXPERIMENTS.md 实验 E1。
 */
export interface GeoArrays {
  positions: number[];
  /** 局部 UV：普通面 0..1，合并面 0..w / 0..h（shader 内 fract 平铺） */
  uvs: number[];
  /** 每顶点明暗（面定向 × AO，0~1）：RGB 三通道同值，只需 1 个分量 */
  shade: number[];
  /**
   * 每顶点天空光 / 方块光（0~1），shader 据此叠加昼夜与方块光源。
   * 基线档写 2 个 float（sky, block）；量化档（T3）把两分量各取 0~15 整数，
   * 打包进 1 个 float 的高/低 4 位，shader 用 mod/floor 解码，档位数与布局见
   * VERTEX_ATTRIBUTES.aLight 与 VERTEX_BYTES_QUANTIZED。
   */
  lights: number[];
  /** 每顶点图集 tile 起点 u0,v0；tile 尺寸全图集一致，走 shader uniform */
  tile: number[];
  /** 每顶点开关：0 普通、1 群系染色、2 自发光（不受光照与染色影响） */
  tints: number[];
  /** 每顶点风摆权重（0~1）：普通方块为 0，十字面植物由底部 0 渐变到顶部（= 植物高度） */
  sways: number[];
  indices: number[];
}

export interface ChunkMeshData {
  opaque: GeoArrays | null;
  /** 仅 mergeEmissive=false 时才有内容（实验对照） */
  emissive: GeoArrays | null;
  transparent: GeoArrays | null;
  water: GeoArrays | null;
}

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

/** 把动态数组打包为 Transferable 视图；transfer 数组仅在 Worker 回传时需要 */
export function packMesh(d: ChunkMeshData): { mesh: PackedMesh; transfer: ArrayBuffer[] } {
  const transfer: ArrayBuffer[] = [];
  const pack = (g: GeoArrays | null): PackedGeo | null => {
    if (!g || g.indices.length === 0) return null;
    const p = new Float32Array(g.positions);
    const u = new Float32Array(g.uvs);
    const s = new Float32Array(g.shade);
    const l = new Float32Array(g.lights);
    const t = new Float32Array(g.tile);
    const tn = new Float32Array(g.tints);
    const sw = new Float32Array(g.sways);
    const i = new Uint32Array(g.indices);
    transfer.push(p.buffer, u.buffer, s.buffer, l.buffer, t.buffer, tn.buffer, sw.buffer, i.buffer);
    return { positions: p, uvs: u, shade: s, lights: l, tile: t, tints: tn, sways: sw, indices: i };
  };
  return {
    mesh: {
      opaque: pack(d.opaque),
      emissive: pack(d.emissive),
      transparent: pack(d.transparent),
      water: pack(d.water),
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

export type WorkerRequest = { type: 'config'; config: MeshConfig; wid: number } | MeshRequest;

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
  | { type: 'config-ack'; wid: number; revision: number }
  | { type: 'error'; wid: number; cx: number; cz: number; generation: number; message: string };

/** 非 config-ack 的 Worker 回传（结果 / 错误），含 cx/cz/generation */
export type ChunkWorkerMessage = Exclude<WorkerResponse, { type: 'config-ack' }>;
/** config-ack 单独抽出后，类型上也不再污染结果处理分支 */
export type ConfigAckMessage = Extract<WorkerResponse, { type: 'config-ack' }>;

/** 单帧收割计划（纯数据，可脱离 three 单测） */
export interface DrainPlan {
  /** 配置回执：不占配额，总是优先处理 */
  acks: ConfigAckMessage[];
  /** 本帧最多处理的回传消息（默认 4 条） */
  batch: ChunkWorkerMessage[];
  /** 未处理条目，下一帧仍从队首开始，保证无区块永久饥饿 */
  rest: ChunkWorkerMessage[];
}

/**
 * 制定单帧收割计划：config-ack 优先且不占配额，其余消息按入队顺序取前 limit 条。
 *
 * 纯函数，不碰 busy / inFlight 等可变状态；主线程按计划顺序处理，
 * 过期代次的 busy 回退逻辑保持不变。limit 至少为 1，避免配置为 0 时永久不消费。
 */
export function planDrain(messages: readonly WorkerResponse[], limit: number): DrainPlan {
  const acks: ConfigAckMessage[] = [];
  const rest: ChunkWorkerMessage[] = [];
  for (const msg of messages) {
    if (msg.type === 'config-ack') acks.push(msg);
    else rest.push(msg);
  }
  const take = Math.max(1, Math.floor(limit));
  return { acks, batch: rest.slice(0, take), rest: rest.slice(take) };
}
