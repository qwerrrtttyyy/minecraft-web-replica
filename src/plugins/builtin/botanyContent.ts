/**
 * 植物扩展包内容（v1.4.3）——纯数据 + 纯函数，不含任何引擎运行时依赖。
 *
 * 单独成文件的原因：scripts/build-test-snapshot.mjs 会把它编译成 CommonJS
 * 快照，test/botany-rules-check.cjs 可以直接 require 同一份数据，避免
 * 「测试里的植物和线上插件里的植物不是同一份定义」。
 *
 * 所有纹理沿用项目约定：代码逐像素绘制 16×16，不含任何原版资源。
 */
import type { BlockInput } from '../../world/blocks';
import type { BiomeId } from '../../world/generator';
import type { PlantRule } from '../../world/plantRules';
import type { PlantTrait } from '../../world/plantTraits';

export const EXPANSION_PLUGIN_ID = 'core:botany-expansion';
/**
 * 扩展方块 id 起点：内置方块已占用 1~158（v1.7.0 内容植物扩充末位 id=158），
 * 插件植物从 159 起末位追加，当前已用 159~168；必须 ≤255（Uint8Array 存储）。
 * 旧注释写「内置 1~138 / FIRST_ID=139」是 1.6.0 前的口径，现已过期。
 */
export const EXPANSION_FIRST_ID = 159;
/** 单列生成权重累加的上界；插件据此先做一次廉价 roll 过滤再查世界 */
export const SPAWN_ROLL_CEILING = 0.04;

type Painter = (setPixel: (x: number, y: number, hex: number, alpha?: number) => void, rng: () => number) => void;

export interface ExpansionPlant {
  name: string;
  label: string;
  /** 显式固定 id，保证存档 edits 差分在插件重启后仍指向同一方块 */
  id: number;
  trait: PlantTrait;
  /** 群系 → 每列生成权重（0 / 缺省表示不生成） */
  spawn: Partial<Record<BiomeId, number>>;
  /** 只在紧邻水体时生成 */
  nearWater?: boolean;
  /** 自发光 0~15 */
  lightEmission?: number;
  /** 水生植物：占据水格，玩家在其中仍视为入水 */
  waterPlant?: boolean;
  /**
   * 十字面可视高度（0~1，默认 1）。mesher 的 aSway 按此高度从底部 0 渐变到顶部，
   * 新 4 种植物用它做「立面攀援 / 矮丛 / 穗高 / 花盘」的几何差异化，不新增 shader 通道。
   */
  crossHeight?: number;
  paint: Painter;
}

const nectar = { item: 'item:nectar', count: 1 };
/** 缢丝花采集：复用 survival.ts 已有的 glow_spore key，不新增 item */
const glowSpore = { item: 'item:glow_spore', count: 1 };
/** 风信草采集：复用已有的 wheat_seeds key */
const wheatSeeds = { item: 'item:wheat_seeds', count: 1 };
/** 日晷花采集：复用 nectar key，用 ×2 的数量体现其蓄能优势 */
const nectarDouble = { item: 'item:nectar', count: 2 };

// ---- 机制阈值：Trait 与规则共用，避免同一数字散落在多处 ----
/** 缢丝花 bloom：trait 与「无宿主不得越界」判定共用 */
const PARASITE_BLOOM = 70;
/** 日晷花 bloom：trait 与「正午成熟」判定共用 */
const SUNDIAL_BLOOM = 84;

/** 攀墙藤：随机刻向上攀援的概率上界 */
const CLIMB_CHANCE = 0.08;
/** 攀墙藤：相对地表的最高攀爬格数（y ≤ surface + 6） */
const CLIMB_MAX_HEIGHT = 6;
/** 攀墙藤：攀援成功后的向光增益 */
const CLIMB_LIGHT_BONUS = 2;

/** 缢丝花：每 tick 扫描水平邻格的概率上界 */
const PARASITE_SCAN_CHANCE = 0.1;
/** 缢丝花：宿主能量 ≤ 该值即停止吸取并退回营养体 */
const PARASITE_HOST_FLOOR = 15;
/** 缢丝花：单次从宿主抽走的能量 */
const PARASITE_DRAIN = 4;
/** 缢丝花：单次自身补能的标准值（尚未触及 85 上限时） */
const PARASITE_GAIN = 6;
/** 缢丝花：自身能量硬上限（框架 boost 只钳 0~100，规则内再钳到 85） */
const PARASITE_SELF_CAP = 85;

/** 风信草：基础传播概率上界（再乘季节倍率，故实际概率恒 ≤ 0.05） */
const WIND_SPREAD_CHANCE = 0.05;
/** 风信草：沿下风最多传播的格数 */
const WIND_SPREAD_DISTANCE = 2;

/** 日晷花：黎明窗口 [0.15, 0.4) 的蓄能加成 */
const PHASE_NIGHT_END = 0.15;
const PHASE_DAWN_END = 0.4;
const SUNDIAL_DAWN_GAIN = 8;
/** 日晷花：黄昏窗口 [0.25, 0.5) 的播种概率上界 */
const PHASE_DUSK_START = 0.25;
const PHASE_DUSK_END = 0.5;
const SUNDIAL_SPREAD_CHANCE = 0.04;
/** 日晷花：正午窗口 [0.7, 1] 才允许成熟 */
const PHASE_NOON_START = 0.7;

/**
 * 10 种新植物（id 159~168，顺延在内置方块 148~158 之后）。
 * 代谢类型沿用 plantTraits.ts 的 solar / hydro / fungal 三分类，
 * 因此自动接入蓄能、开花、根系共享与采集结算，无需改 Botany 的能量模型。
 * 新增 165~168 分别占据垂直 / 能量 / 方向 / 时间四个正交生态轴。
 */
export const EXPANSION_PLANTS: readonly ExpansionPlant[] = [
  {
    name: 'thistle',
    label: '蓟',
    id: 159,
    trait: { metabolism: 'solar', bloom: 80, growthCost: 18, shareRadius: 2, sharePower: 12, harvest: nectar },
    spawn: { plains: 0.008, forest: 0.004 },
    paint: (set) => {
      for (let y = 9; y < 16; y++) set(8, y, 0x4a7c3f);
      for (let y = 3; y < 9; y++) {
        set(7, y, 0x8a5cc8);
        set(8, y, 0xa77bdd);
        set(9, y, 0x7b4dbb);
        if (y % 2 === 0) {
          set(6, y, 0x9b6bd0);
          set(10, y, 0x6f43ad);
        }
      }
      set(8, 2, 0xc9a2e8);
    },
  },
  {
    name: 'cattail',
    label: '香蒲',
    id: 160,
    trait: { metabolism: 'hydro', bloom: 70, growthCost: 16, shareRadius: 2, sharePower: 10 },
    spawn: { beach: 0.02, plains: 0.012, forest: 0.008 },
    nearWater: true,
    waterPlant: true,
    paint: (set) => {
      for (let y = 4; y < 16; y++) set(8, y, 0x4c7a3a);
      for (let y = 2; y < 7; y++) {
        set(7, y, 0x6b4526);
        set(8, y, 0x8a5a2f);
        set(9, y, 0x5c3a20);
      }
      for (let y = 9; y < 16; y++) {
        set(5, y, 0x3f6b32);
        set(11, y, 0x356028);
      }
    },
  },
  {
    name: 'glow_mushroom',
    label: '荧光菇',
    id: 161,
    trait: { metabolism: 'fungal', bloom: 65, growthCost: 14, shareRadius: 3, sharePower: 16, hub: true },
    spawn: { forest: 0.005, taiga: 0.004 },
    lightEmission: 5,
    paint: (set) => {
      for (let y = 9; y < 16; y++) set(8, y, 0xd8e8d0);
      for (let y = 4; y < 9; y++) {
        for (let x = 4; x < 12; x++) {
          if (Math.abs(x - 8) <= y - 3) set(x, y, y < 6 ? 0x6ff0d8 : 0x2fc4b0);
        }
      }
      set(6, 5, 0xd8fff4);
      set(9, 6, 0xd8fff4);
    },
  },
  {
    name: 'frost_bloom',
    label: '霜花',
    id: 162,
    trait: { metabolism: 'solar', bloom: 75, growthCost: 20, shareRadius: 2, sharePower: 10, harvest: nectar },
    spawn: { alpine: 0.012 },
    paint: (set) => {
      for (let y = 9; y < 16; y++) set(8, y, 0x5f8f6a);
      const petals = [
        [8, 3],
        [5, 5],
        [11, 5],
        [4, 8],
        [12, 8],
        [6, 11],
        [10, 11],
      ];
      for (const [x, y] of petals) {
        set(x, y, 0xdff2ff);
        set(x, y + 1, 0xa9d8f5);
      }
      set(8, 7, 0xfff3b0);
      set(8, 8, 0xffe27a);
    },
  },
  {
    name: 'ember_fern',
    label: '余烬蕨',
    id: 163,
    trait: { metabolism: 'fungal', bloom: 60, growthCost: 12, shareRadius: 2, sharePower: 10 },
    spawn: { forest: 0.006, taiga: 0.006 },
    paint: (set) => {
      for (let y = 4; y < 16; y++) {
        set(8, y, 0x8a3a24);
        const w = Math.max(0, 4 - Math.floor((16 - y) / 3));
        for (let d = 1; d <= w; d++) {
          set(8 - d, y, 0xc45a2a);
          set(8 + d, y, 0xa8441f);
        }
      }
    },
  },
  {
    name: 'moonlotus',
    label: '月莲',
    id: 164,
    trait: { metabolism: 'hydro', bloom: 80, growthCost: 18, shareRadius: 2, sharePower: 12, harvest: nectar },
    spawn: { ocean: 0.006, beach: 0.01 },
    nearWater: true,
    waterPlant: true,
    paint: (set) => {
      for (let x = 3; x < 13; x++) {
        set(x, 12, 0x2f6f8a);
        set(x, 13, 0x245b73);
      }
      for (let x = 4; x < 12; x++) {
        for (let y = 6; y < 11; y++) {
          if (Math.abs(x - 8) <= 11 - y) set(x, y, y < 8 ? 0xd7e9ff : 0x8fb8e8);
        }
      }
      set(8, 8, 0xfff6c9);
      set(7, 9, 0xf2e2a8);
      set(9, 9, 0xf2e2a8);
    },
  },
  // ---- 以下 4 种为本批新增（165~168）：垂直 / 能量 / 方向 / 时间四轴 ----
  {
    // 攀墙藤：贴实心墙面向上攀援，越高越向光；paint 用单侧气生根暗示「贴墙」方向。
    name: 'climbing_vine',
    label: '攀墙藤',
    id: 165,
    trait: {
      metabolism: 'solar',
      bloom: 76,
      growthCost: 16,
      shareRadius: 2,
      sharePower: 11,
      harvest: nectar,
    },
    spawn: { forest: 0.006, taiga: 0.004, plains: 0.002 },
    // 顶满整格：沿墙攀援需要最高的几何与最大的顶部风摆权重
    crossHeight: 1,
    paint: (set) => {
      // 主茎：下半深褐、上半褐绿，体现「越高越向光」
      for (let y = 0; y < 16; y++) set(8, y, y < 5 ? 0x5a4326 : 0x4f6b32);
      // 贴墙侧气生根：每隔 3 行向左伸出 2 像素
      for (let y = 2; y < 15; y += 3) {
        set(7, y, 0x6b5233);
        set(6, y, 0x7a5f3b);
      }
      // 顶部两片亮叶：左右对称、由外向内渐亮
      for (let d = 1; d <= 3; d++) {
        set(8 - d, 14 - d, 0x8fd05a);
        set(8 + d, 14 - d, 0x7cc04b);
        set(8 - d, 15 - d, 0xa6e070);
        set(8 + d, 15 - d, 0x92d45f);
      }
      set(8, 15, 0xb6e884);
    },
  },
  {
    // 缢丝花：苍白缠绕茎 + 指向邻格的暗红吸器；无宿主时靠 decay tile 表达闭合花冠。
    name: 'parasite_bloom',
    label: '缢丝花',
    id: 166,
    trait: {
      metabolism: 'fungal',
      bloom: PARASITE_BLOOM,
      growthCost: 12,
      shareRadius: 1,
      sharePower: 6,
      harvest: glowSpore,
    },
    spawn: { forest: 0.005, taiga: 0.003 },
    // 矮花冠：贴地缠绕，风摆幅度最小
    crossHeight: 0.6,
    paint: (set) => {
      // 缠绕茎：每 4 行左右交替一格，形成 S 形
      for (let y = 0; y < 12; y++) set(y % 4 < 2 ? 8 : 9, y, 0xd9d2c4);
      // 暗红吸器：分别指向左右邻格的两对短刺
      set(7, 3, 0x8f2f38);
      set(6, 3, 0xa63c45);
      set(10, 5, 0x8f2f38);
      set(11, 5, 0xa63c45);
      // 不对称花冠：右侧花瓣比左侧少一层
      for (let d = 1; d <= 3; d++) {
        set(8 - d, 13, 0xe6d9d2);
        set(8 + d, 13, 0xcfb9b4);
        set(8 - d, 12, 0xf1e6df);
        if (d <= 2) set(8 + d, 12, 0xdcc5bf);
      }
      set(8, 14, 0x7d2b33);
      set(8, 15, 0x9a3a42);
    },
  },
  {
    // 风信草：茎顶穗固定向右（下风侧）倾斜，成熟穗头转浅金。
    name: 'windseed_grass',
    label: '风信草',
    id: 167,
    trait: {
      metabolism: 'solar',
      bloom: 68,
      growthCost: 14,
      shareRadius: 2,
      sharePower: 9,
      harvest: wheatSeeds,
    },
    spawn: { plains: 0.01, beach: 0.006, alpine: 0.004 },
    // 高穗：穗头高于普通花草，顶部风摆倾斜最明显
    crossHeight: 0.95,
    paint: (set) => {
      // 主茎：越高越向右倾
      for (let y = 0; y < 12; y++) set(7 + Math.floor(y / 5), y, 0x5f8f3f);
      // 叶片沿风向排列：左叶短、右叶长
      for (let y = 2; y < 11; y += 3) {
        const x = 7 + Math.floor(y / 5);
        set(x - 1, y, 0x74a64b);
        set(x + 1, y, 0x86b955);
        set(x + 2, y, 0x9ac968);
      }
      // 穗头：向右上倾斜的浅金色穗
      for (let d = 0; d < 4; d++) {
        set(9 + d, 12 + Math.floor(d / 2), d % 2 ? 0xe8cf72 : 0xf2dd8c);
        set(8 + d, 14, 0xd9be62);
      }
      set(8, 15, 0xf6e6a4);
    },
  },
  {
    // 日晷花：金色放射花瓣 + 深色花盘，同一 tile 内外圈做暖→冷渐层。
    name: 'sundial_flower',
    label: '日晷花',
    id: 168,
    trait: {
      metabolism: 'solar',
      bloom: SUNDIAL_BLOOM,
      growthCost: 20,
      shareRadius: 2,
      sharePower: 12,
      harvest: nectarDouble,
    },
    spawn: { plains: 0.004, forest: 0.003, alpine: 0.003 },
    // 中等花茎：花盘抬升但不过分遮挡邻近花草
    crossHeight: 0.75,
    paint: (set) => {
      // 花茎与两片叶
      for (let y = 0; y < 10; y++) set(8, y, 0x4e7c39);
      set(7, 5, 0x6b9c4b);
      set(9, 7, 0x76a852);
      // 放射花瓣：外圈暖金、内圈浅金
      const petals: [number, number][] = [
        [8, 8],
        [8, 9],
        [5, 10],
        [11, 10],
        [4, 12],
        [12, 12],
        [6, 14],
        [10, 14],
      ];
      for (const [x, y] of petals) {
        set(x, y, 0xf5cf5c);
        set(x + (x < 8 ? 1 : x > 8 ? -1 : 0), y + (y < 12 ? 1 : -1), 0xffe08a);
      }
      // 外圈冷暖渐层：左半偏暖橙、右半偏冷金
      for (let x = 5; x <= 11; x++) {
        set(x, 11, x < 8 ? 0xe89a3c : 0xf0b64a);
        set(x, 13, x < 8 ? 0xf3d06a : 0xd9c452);
      }
      // 深色花盘
      set(8, 12, 0x5b3a1e);
      set(7, 12, 0x734825);
      set(9, 12, 0x734825);
      set(8, 11, 0x6b4423);
      set(8, 13, 0x6b4423);
    },
  },
];

export const EXPANSION_PLANT_COUNT = EXPANSION_PLANTS.length;

export function expansionBlockInput(p: ExpansionPlant): BlockInput {
  return {
    id: p.id,
    name: p.name,
    label: p.label,
    shape: 'cross',
    solid: false,
    opaque: false,
    liquid: false,
    transparentPass: false,
    lightEmission: p.lightEmission ?? 0,
    hardness: 0,
    sound: 'plant',
    waterPlant: p.waterPlant,
    tiles: { top: p.name, bottom: p.name, side: p.name },
    crossHeight: p.crossHeight ?? 1,
    drops: [{ name: 'self' }],
  };
}

/**
 * 自然生成选种（纯函数）：roll 为 0~1 的确定性哈希。
 * 按 EXPANSION_PLANTS 顺序累加权重，命中即返回；nearWater 为 false 时
 * 临水物种直接跳过，不会挤占后面物种的权重。
 */
export function planSpawn(biome: string, roll: number, nearWater: boolean): string | null {
  if (roll >= SPAWN_ROLL_CEILING) return null;
  let acc = 0;
  for (const p of EXPANSION_PLANTS) {
    const weight = p.spawn[biome as BiomeId] ?? 0;
    if (weight <= 0) continue;
    if (p.nearWater && !nearWater) continue;
    acc += weight;
    if (roll < acc) return p.name;
  }
  return null;
}

/** 坐标哈希：只依赖 world seed 与世界坐标，区块生成顺序不影响结果 */
export function spawnHash(x: number, z: number, seed: number): number {
  let h = (x * 374761393 + z * 668265263 + seed * 1442695041 + 0x5f3a) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 水平四邻的绝对坐标（规则里统一取 y 与自身相同的邻居） */
function horizontal(ctx: Parameters<PlantRule['tick']>[0]): [number, number, number][] {
  return ctx.neighbors(ctx.x, ctx.y, ctx.z).filter(([, ny]) => ny === ctx.y) as [number, number, number][];
}

/** 水平方位向量：+x 为东、+z 为南（与世界坐标约定一致） */
export interface WindVector {
  readonly dx: number;
  readonly dz: number;
}

/** 顺时针轮转的四个基准方位，供「偏一格」做确定性索引运算 */
const CLOCKWISE_DIRECTIONS = ['east', 'south', 'west', 'north'] as const;
type CardinalDirection = (typeof CLOCKWISE_DIRECTIONS)[number];

const DIRECTION_VECTOR: Readonly<Record<CardinalDirection, WindVector>> = {
  east: { dx: 1, dz: 0 },
  south: { dx: 0, dz: 1 },
  west: { dx: -1, dz: 0 },
  north: { dx: 0, dz: -1 },
};

/** 季节基准方位：春东 / 夏南 / 秋西 / 冬北；未知季节按春处理 */
const SEASON_BASE_DIRECTION: Readonly<Record<string, CardinalDirection>> = {
  spring: 'east',
  summer: 'south',
  autumn: 'west',
  winter: 'north',
};

/**
 * 当日风向（纯函数）：季节定基准方位，`day % 3 !== 0` 时顺时针偏一格。
 *
 * 刻意不接收 rng —— 同一 season + day 必然得到同一向量，玩家可据此推断条带方向；
 * 概率只控制「是否传播」，绝不参与「往哪传播」。
 */
export function windDirection(season: string, day: number): WindVector {
  const base = SEASON_BASE_DIRECTION[season] ?? 'east';
  const index = Math.max(0, CLOCKWISE_DIRECTIONS.indexOf(base));
  const offset = day % 3 === 0 ? 0 : 1;
  const shifted = CLOCKWISE_DIRECTIONS[(index + offset) % CLOCKWISE_DIRECTIONS.length] ?? 'east';
  return DIRECTION_VECTOR[shifted];
}

/**
 * 风信草传播概率的季节倍率：调制频率而非方向，且恒 ≤1，
 * 保证实际概率不超过 WIND_SPREAD_CHANCE 的上界。
 */
const SEASON_GROWTH_MULTIPLIER: Readonly<Record<string, number>> = {
  spring: 1,
  summer: 1,
  autumn: 0.8,
  winter: 0.6,
};

/**
 * 8 条生态规则（既有 4 条 + 本批新增 4 条），全部通过 CraftAPI.botany.registerRule 注入。
 * Botany 在内置规则未命中时才分派，因此不会改动既有生态回归。
 */
export const EXPANSION_RULES: readonly PlantRule[] = [
  {
    id: 'core:botany-expansion:cross-pollination',
    owner: EXPANSION_PLUGIN_ID,
    plants: ['thistle', 'frost_bloom'],
    /** 异花传粉：水平相邻存在「另一种非实心植物」时额外蓄能 */
    tick(ctx) {
      if (ctx.rng() > 0.5) return false;
      const hasOther = horizontal(ctx).some(([nx, ny, nz]) => {
        const n = ctx.get(nx, ny, nz);
        return n !== 0 && n !== ctx.id && !ctx.isSolid(nx, ny, nz);
      });
      if (hasOther) ctx.boost(ctx.x, ctx.y, ctx.z, 6);
      return false;
    },
  },
  {
    id: 'core:botany-expansion:nocturnal-bloom',
    owner: EXPANSION_PLUGIN_ID,
    plants: ['glow_mushroom', 'ember_fern', 'moonlotus'],
    /** 夜间开花蔓延：暗光 + 蓄能充足时向邻近可站立空地扩散 */
    tick(ctx) {
      // 三重门槛（深夜 / 接近蓄满 / 低概率）：避免规则持续 setBlock 让流式加载队列无法收敛
      if (ctx.daylight >= 0.25) return false;
      if (ctx.energy(ctx.x, ctx.y, ctx.z) < 90) return false;
      if (!ctx.canGrow(ctx.x, ctx.y, ctx.z, ctx.id) || ctx.rng() > 0.06) return false;
      for (const [nx, ny, nz] of horizontal(ctx)) {
        if (ctx.get(nx, ny, nz) !== 0 || !ctx.isSolid(nx, ny - 1, nz)) continue;
        if (ctx.grow(nx, ny, nz, ctx.id, 'spread')) return true;
      }
      return false;
    },
  },
  {
    id: 'core:botany-expansion:frostline',
    owner: EXPANSION_PLUGIN_ID,
    plants: ['frost_bloom'],
    /** 高山霜线：霜花只在 alpine 且贴近地表存活，其余群系整列枯萎 */
    tick(ctx) {
      const alpine = ctx.biome(ctx.x, ctx.z) === 'alpine';
      const nearSurface = ctx.y >= ctx.surface(ctx.x, ctx.z) - 1;
      if (alpine && nearSurface) return false;
      return ctx.write(ctx.x, ctx.y, ctx.z, 0, 'decay');
    },
  },
  {
    id: 'core:botany-expansion:rain-boost',
    owner: EXPANSION_PLUGIN_ID,
    plants: ['cattail', 'moonlotus'],
    priority: 5,
    /** 雨天给水生植物额外蓄能；深夜 + 蓄能充足 + 低概率三重门槛避免脏标记刷屏 */
    tick(ctx) {
      if (ctx.weather() !== 'rain') return false;
      if (ctx.daylight >= 0.25) return false;
      if (ctx.energy(ctx.x, ctx.y, ctx.z) < 85) return false;
      if (ctx.rng() > 0.05) return false;
      ctx.boost(ctx.x, ctx.y, ctx.z, 6);
      return false;
    },
  },
  {
    id: 'core:botany-expansion:climbing',
    owner: EXPANSION_PLUGIN_ID,
    plants: ['climbing_vine'],
    /**
     * 垂直攀援：只有水平四邻存在实心墙才向上延伸，且不超过地表 +6 格。
     * 无墙时直接返回 false（退化为贴地矮丛），绝不横向蔓延。
     */
    tick(ctx) {
      // 廉价的随机门槛放最前：绝大多数随机刻在这里就返回，避免无谓的世界查询
      if (ctx.rng() > CLIMB_CHANCE) return false;
      // 高度硬上限：目标是 y+1，因此当前 y 达到 surface+6 时不再生长
      if (ctx.y + 1 > ctx.surface(ctx.x, ctx.z) + CLIMB_MAX_HEIGHT) return false;
      if (!ctx.canGrow(ctx.x, ctx.y + 1, ctx.z, ctx.id)) return false;
      if (!horizontal(ctx).some(([nx, ny, nz]) => ctx.isSolid(nx, ny, nz))) return false;
      if (!ctx.grow(ctx.x, ctx.y + 1, ctx.z, ctx.id, 'grow')) return false;
      // 向光增益只写在攀援成功之后，避免「无墙也偷蓄能」
      ctx.boost(ctx.x, ctx.y, ctx.z, CLIMB_LIGHT_BONUS);
      return true;
    },
  },
  {
    id: 'core:botany-expansion:parasitism',
    owner: EXPANSION_PLUGIN_ID,
    plants: ['parasite_bloom'],
    /**
     * 负相互作用：priority = -1（框架越小越先），确保先于默认 0 的异花传粉等规则执行，
     * 避免同株命中多规则时「先加能再被吸」的顺序歧义。
     *
     * 自限由规则内部完成，不修改 PlantRuleContext：boost 只钳 0~100，
     * 这里按 85 上限算出实际可补量（80 → +5，85 → 0），宿主 ≤15 即停吸并退回营养体。
     */
    priority: -1,
    tick(ctx) {
      if (ctx.rng() > PARASITE_SCAN_CHANCE) return false;
      // 邻株 = 水平四邻中非空且非自身的方块；空气与自身都不算宿主
      const plants = horizontal(ctx).filter(([nx, ny, nz]) => {
        const id = ctx.get(nx, ny, nz);
        return id !== 0 && id !== ctx.id;
      });
      if (plants.length === 0) {
        // 无宿主：能量不得越过 bloom，越界则退回不开花的营养体
        if (ctx.energy(ctx.x, ctx.y, ctx.z) > PARASITE_BLOOM) {
          return ctx.write(ctx.x, ctx.y, ctx.z, ctx.id, 'decay');
        }
        return false;
      }
      // 只从仍有能量可供吸取的邻株中取一株（按 neighbors 顺序，结果确定）
      const host = plants.find(([nx, ny, nz]) => ctx.energy(nx, ny, nz) > PARASITE_HOST_FLOOR);
      if (!host) {
        // 邻株尚在但已衰弱到阈值以下：停吸，花冠闭合
        return ctx.write(ctx.x, ctx.y, ctx.z, ctx.id, 'decay');
      }
      const selfEnergy = ctx.energy(ctx.x, ctx.y, ctx.z);
      const gain = Math.min(PARASITE_GAIN, Math.max(0, PARASITE_SELF_CAP - selfEnergy));
      if (gain <= 0) return false;
      ctx.boost(host[0], host[1], host[2], -PARASITE_DRAIN);
      ctx.boost(ctx.x, ctx.y, ctx.z, gain);
      // boost 不改方块，返回 false 与既有「加成类规则」一致
      return false;
    },
  },
  {
    id: 'core:botany-expansion:wind_dispersal',
    owner: EXPANSION_PLUGIN_ID,
    plants: ['windseed_grass'],
    /**
     * 方向轴：风向只由 windDirection(season, day) 决定，与 rng 无关；
     * 概率受季节倍率调制且恒 ≤0.05，只在下风 1~2 格的空地且下方实心时播种。
     */
    tick(ctx) {
      const multiplier = SEASON_GROWTH_MULTIPLIER[ctx.season()] ?? 1;
      if (ctx.rng() > WIND_SPREAD_CHANCE * multiplier) return false;
      const { dx, dz } = windDirection(ctx.season(), ctx.day());
      for (let step = 1; step <= WIND_SPREAD_DISTANCE; step++) {
        const nx = ctx.x + dx * step;
        const nz = ctx.z + dz * step;
        if (ctx.get(nx, ctx.y, nz) !== 0) continue;
        if (!ctx.isSolid(nx, ctx.y - 1, nz)) continue;
        if (ctx.grow(nx, ctx.y, nz, ctx.id, 'spread')) return true;
      }
      return false;
    },
  },
  {
    id: 'core:botany-expansion:circadian_phase',
    owner: EXPANSION_PLUGIN_ID,
    plants: ['sundial_flower'],
    /**
     * 时间轴：按 daylight 分相，每 tick 至多执行一类动作。
     *
     * 判定顺序固定为 夜 → 正午 → 黎明 → 黄昏：PRD 的黎明 [0.15,0.4) 与
     * 黄昏 [0.25,0.5) 在 [0.25,0.4) 重叠，先判定者（黎明）胜出，保证确定性。
     * 夜间直接返回，既不写世界也不 boost。
     */
    tick(ctx) {
      const light = ctx.daylight;
      // 夜：休眠，零写入
      if (light < PHASE_NIGHT_END) return false;
      // 正午：蓄满才允许成熟
      if (light >= PHASE_NOON_START) {
        if (ctx.energy(ctx.x, ctx.y, ctx.z) < SUNDIAL_BLOOM) return false;
        return ctx.write(ctx.x, ctx.y, ctx.z, ctx.id, 'ripen');
      }
      // 黎明：蓄能加成，不改方块
      if (light < PHASE_DAWN_END) {
        ctx.boost(ctx.x, ctx.y, ctx.z, SUNDIAL_DAWN_GAIN);
        return false;
      }
      // 黄昏：低概率向邻近可站立空地播种
      if (light >= PHASE_DUSK_START && light < PHASE_DUSK_END) {
        if (ctx.rng() > SUNDIAL_SPREAD_CHANCE) return false;
        for (const [nx, ny, nz] of horizontal(ctx)) {
          if (ctx.get(nx, ny, nz) !== 0 || !ctx.isSolid(nx, ny - 1, nz)) continue;
          if (ctx.grow(nx, ny, nz, ctx.id, 'spread')) return true;
        }
      }
      // [0.5, 0.7) 为相位空档：不动作，避免与 nocturnal-bloom 的夜间窗口打架
      return false;
    },
  },
];
