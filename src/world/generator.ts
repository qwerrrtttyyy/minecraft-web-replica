import {
  CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL, clamp, lerp, smoothstep, mulberry32,
  type BlockId,
} from '../core/types';
import { Noise } from './noise';
import { buildTree, type TreeSpecies } from './trees';

/**
 * 生成器构造所需的「按名查 id」能力（BlockRegistry 的结构子集）。
 * Worker 内没有注册表实例，用纯数据表等价替代（见 blockIdSource）。
 */
export interface BlockIdSource {
  byNameGet(name: string): { readonly id: BlockId } | undefined;
}

/** 纯数据 id 表 → BlockIdSource：供 Worker 复刻 DefaultGenerator 使用 */
export function blockIdSource(ids: Record<string, BlockId>): BlockIdSource {
  return {
    byNameGet(name) {
      const id = ids[name];
      return id === undefined ? undefined : { id };
    },
  };
}

/**
 * 世界生成器接口（扩展点：CraftAPI.setGenerator 可整体替换地形算法）。
 * biomeAt / columnInfo 为可选能力，自定义生成器可不实现。
 */
export interface IWorldGenerator {
  readonly seed: number;
  generateChunk(cx: number, cz: number, data: Uint8Array): void;
  surfaceHeight(x: number, z: number): number;
  biomeAt?(x: number, z: number): BiomeId;
  columnInfo?(x: number, z: number): ColumnInfo;
}

export type BiomeId =
  | 'ocean' | 'beach' | 'desert' | 'plains' | 'forest' | 'taiga' | 'alpine'
  | 'mesa' | 'swamp' | 'savanna' | 'cherry'
  // 11 → 18 群系扩展：仅在末尾追加，既有 11 项顺序不动（存档 / 诊断按字符串记录 biome 名）
  | 'jungle' | 'snowy_tundra' | 'mushroom_grove' | 'bamboo_grove'
  | 'dark_forest' | 'birch_forest' | 'snowy_taiga';

/** 地表一列的自然属性（不依赖区块是否已生成） */
export interface ColumnInfo {
  x: number;
  z: number;
  /** 地形高度（不含水、树、玩家建筑） */
  height: number;
  biome: BiomeId;
  /** 0~1，温度 */
  temperature: number;
  /** 0~1，湿度 */
  humidity: number;
  /** 0 平坦 ~ 1 陡峭 */
  slope: number;
}

/** 可调地形参数：构造时传入可整体换风格，也可做「平坦世界」等预设 */
export interface TerrainOptions {
  /** 域扭曲强度，打散值噪声的轴对齐方格感 */
  warp: number;
  baseHeight: number;
  continentAmp: number;
  hillAmp: number;
  mountainLift: number;
  mountainRidgeAmp: number;
  riverDepth: number;
  /** 出生点最低地形高出海平面的格数（平滑衰减，保证任意种子都能落在陆地） */
  spawnUplift: number;
  spawnRadius: number;
  /** 各群系每 6×6 格生成一棵树的概率 */
  treeDensity: Partial<Record<BiomeId, number>>;
  /** 矿脉数量倍率，0 可关闭矿物 */
  oreRichness: number;
}

export const DEFAULT_TERRAIN: TerrainOptions = {
  warp: 26,
  baseHeight: 32,
  continentAmp: 19,
  hillAmp: 8,
  mountainLift: 16,
  mountainRidgeAmp: 27,
  riverDepth: 7,
  spawnUplift: 3,
  spawnRadius: 82,
  treeDensity: {
    plains: 0.08, forest: 0.42, taiga: 0.34, alpine: 0.05,
    mesa: 0, swamp: 0.1, savanna: 0.06, cherry: 0.3,
    // 11 → 18 群系扩展：雪原 / 竹林无乔木，其余按设计表逐群系给值
    jungle: 0.38, snowy_tundra: 0, mushroom_grove: 0.18, bamboo_grove: 0,
    dark_forest: 0.45, birch_forest: 0.4, snowy_taiga: 0.3,
  },
  oreRichness: 1,
};

/**
 * 生成阶段：generateChunk 严格按此顺序执行。
 * 顺序本身是契约——矿石只替换石头，树木先于花草，装饰不能覆盖树冠。
 */
export const TERRAIN_STAGES = ['columns', 'ores', 'trees', 'decorate'] as const;
export type TerrainStage = (typeof TERRAIN_STAGES)[number];

/**
 * 群系配置表：地表 / 填充 / 装饰 / 浅滩黏土 / 仙人掌 / 甘蔗收进一张表，
 * 柱状生成与装饰阶段只读这张表，新增群系或地表方块不再散落在 if 分支里。
 */
export interface BiomeProfile {
  /** 地表方块名 */
  surface: string;
  /** 地表下 3 层方块名 */
  filler: string;
  /** 地表装饰权重（每列命中概率 = 权重之和） */
  plants: readonly { name: string; weight: number }[];
  /** 浅水海床生成黏土的概率（0 关闭） */
  clayChance: number;
  /** 沙漠每列生成仙人掌的概率（0 关闭） */
  cactusChance: number;
  /** 临水浅岸生成甘蔗的概率（0 关闭） */
  caneChance: number;
  /** 树种权重（缺省不生成树；是否生成仍由 treeDensity 决定） */
  trees?: readonly { species: TreeSpecies; weight: number }[];
  /** 水下植物（海草 / 海带 / 海葵 / 红藻）权重 */
  waterPlants?: readonly { name: string; weight: number }[];
  /** 水下植物命中概率（0 关闭） */
  waterPlantChance?: number;
  /** 浅水水面漂浮植物权重（睡莲 / 浮萍），为空时回退到睡莲 */
  floaters?: readonly { name: string; weight: number }[];
  /** 浅水水面生成漂浮植物的概率（0 关闭） */
  lilyChance?: number;
  /**
   * 花圃：以六格网格点为圆心成片生成花卉。
   * 一片花圃以同一花色为主，偶有混色，视觉效果比逐列随机更像「花海」。
   */
  flowerBeds?: {
    chance: number;
    radius: number;
    plants: readonly { name: string; weight: number }[];
  };
  /** 地下弱光植物权重（荧光苔 / 月光花 / 荧光蕨） */
  cavePlants?: readonly { name: string; weight: number }[];
  /** 地下弱光植物每列命中概率（0 关闭） */
  caveChance?: number;
  /** 地表生成南瓜的概率（0 关闭） */
  pumpkinChance?: number;
  /**
   * 层状填充方块（恶地彩色陶瓦）：按深度循环分层，替代 filler / stone；
   * 缺省走普通「石头 + 3 层 filler」地层。
   */
  strata?: readonly string[];
}

export const BIOME_PROFILES: Readonly<Record<BiomeId, BiomeProfile>> = {
  ocean: {
    surface: 'sand', filler: 'sand', plants: [],
    clayChance: 0.5, cactusChance: 0, caneChance: 0,
    waterPlants: [
      { name: 'seagrass', weight: 0.35 }, { name: 'kelp', weight: 0.2 },
      { name: 'red_algae', weight: 0.25 }, { name: 'sea_anemone', weight: 0.2 },
    ],
    waterPlantChance: 0.2,
    floaters: [{ name: 'lily_pad', weight: 0.72 }, { name: 'duckweed', weight: 0.28 }],
    lilyChance: 0.035,
  },
  beach: {
    surface: 'sand', filler: 'sand',
    // 沙滩本身不长花草，但临水处是甘蔗最自然的落脚点；海岸草与海石竹只成片点缀
    plants: [{ name: 'beach_grass', weight: 0.02 }, { name: 'sea_thrift', weight: 0.012 }],
    clayChance: 0, cactusChance: 0, caneChance: 0.08,
    flowerBeds: {
      chance: 0.04, radius: 1,
      plants: [{ name: 'sea_thrift', weight: 3 }, { name: 'beach_grass', weight: 2 }],
    },
  },
  desert: {
    surface: 'sand', filler: 'sand',
    // 沙石地层：沙层之下按深度间隔出现砂岩 / 切制砂岩 / 平滑砂岩，
    // 仍以沙为主，不改变地表外观与仙人掌生成规则。
    strata: ['sand', 'sandstone', 'sand', 'sand', 'cut_sandstone', 'sand', 'smooth_sandstone', 'sand'],
    plants: [
      { name: 'dead_bush', weight: 0.006 }, { name: 'desert_marigold', weight: 0.004 },
      { name: 'yucca', weight: 0.0025 }, { name: 'ghost_flower', weight: 0.0012 },
    ],
    clayChance: 0, cactusChance: 0.02, caneChance: 0,
    flowerBeds: {
      chance: 0.05, radius: 1,
      plants: [{ name: 'desert_marigold', weight: 3 }, { name: 'ghost_flower', weight: 1 }],
    },
  },
  plains: {
    surface: 'grass', filler: 'dirt',
    plants: [
      { name: 'tall_grass', weight: 0.05 }, { name: 'poppy', weight: 0.012 },
      { name: 'dandelion', weight: 0.012 }, { name: 'fern', weight: 0.006 },
      { name: 'azure_bluet', weight: 0.012 }, { name: 'oxeye_daisy', weight: 0.012 },
      { name: 'cornflower', weight: 0.01 }, { name: 'tulip_red', weight: 0.006 },
      { name: 'tulip_orange', weight: 0.005 }, { name: 'tulip_white', weight: 0.005 },
      { name: 'tulip_pink', weight: 0.005 }, { name: 'bluebell', weight: 0.006 },
      { name: 'allium', weight: 0.004 }, { name: 'sunflower', weight: 0.004 },
      { name: 'lavender', weight: 0.012 }, { name: 'buttercup', weight: 0.014 },
      { name: 'forget_me_not', weight: 0.012 }, { name: 'marigold', weight: 0.008 },
      { name: 'violet', weight: 0.01 }, { name: 'foxglove', weight: 0.003 },
      { name: 'hollyhock', weight: 0.003 },
      // v1.7.0：经济作物零星野化在平原
      { name: 'cotton_bush', weight: 0.0035 }, { name: 'grape_vine', weight: 0.0025 },
    ],
    clayChance: 0, cactusChance: 0, caneChance: 0.025,
    trees: [{ species: 'oak', weight: 1 }], pumpkinChance: 0.0015,
    flowerBeds: {
      chance: 0.16, radius: 2,
      plants: [
        { name: 'lavender', weight: 3 }, { name: 'buttercup', weight: 3 },
        { name: 'forget_me_not', weight: 2 }, { name: 'violet', weight: 2 },
        { name: 'marigold', weight: 2 }, { name: 'oxeye_daisy', weight: 2 },
        { name: 'cornflower', weight: 1 }, { name: 'poppy', weight: 1 },
        { name: 'foxglove', weight: 1 },
      ],
    },
  },
  forest: {
    surface: 'grass', filler: 'dirt',
    plants: [
      { name: 'tall_grass', weight: 0.06 }, { name: 'poppy', weight: 0.01 },
      { name: 'dandelion', weight: 0.01 }, { name: 'fern', weight: 0.01 },
      { name: 'tall_fern', weight: 0.012 },
      { name: 'lily_of_the_valley', weight: 0.012 }, { name: 'bluebell', weight: 0.012 },
      { name: 'rose_bush', weight: 0.006 }, { name: 'lilac', weight: 0.005 },
      { name: 'peony', weight: 0.005 },
      { name: 'red_mushroom', weight: 0.004 }, { name: 'brown_mushroom', weight: 0.004 },
      { name: 'wood_anemone', weight: 0.008 }, { name: 'wild_garlic', weight: 0.007 },
      { name: 'hyacinth', weight: 0.005 }, { name: 'ivy', weight: 0.0015 },
      // v1.7.0：葡萄藤与兰花长在林下
      { name: 'grape_vine', weight: 0.0035 }, { name: 'orchid', weight: 0.003 },
    ],
    clayChance: 0, cactusChance: 0, caneChance: 0.03,
    trees: [{ species: 'oak', weight: 0.65 }, { species: 'birch', weight: 0.35 }],
    pumpkinChance: 0.001,
    flowerBeds: {
      chance: 0.14, radius: 2,
      plants: [
        { name: 'wood_anemone', weight: 3 }, { name: 'bluebell', weight: 2 },
        { name: 'lily_of_the_valley', weight: 2 }, { name: 'forget_me_not', weight: 2 },
        { name: 'wild_garlic', weight: 2 }, { name: 'hyacinth', weight: 1 },
        { name: 'poppy', weight: 1 },
      ],
    },
    cavePlants: [
      // 权重总和不得超过 1：生成按 [0,1) 均匀分布顺序累加选取
      { name: 'glow_moss', weight: 0.37 }, { name: 'glow_fern', weight: 0.22 },
      { name: 'moonflower', weight: 0.15 },
      // v1.7.0：发光虫菌是荧光火把的野外来源
      { name: 'glow_cordyceps', weight: 0.26 },
    ],
    caveChance: 0.06,
  },
  taiga: {
    surface: 'podzol', filler: 'dirt',
    plants: [
      { name: 'tall_grass', weight: 0.01 }, { name: 'fern', weight: 0.025 },
      { name: 'tall_fern', weight: 0.03 }, { name: 'poppy', weight: 0.004 },
      { name: 'lily_of_the_valley', weight: 0.004 },
      { name: 'red_mushroom', weight: 0.004 }, { name: 'brown_mushroom', weight: 0.006 },
      { name: 'sweet_berry_bush', weight: 0.008 },
      { name: 'lingonberry_bush', weight: 0.01 }, { name: 'snowdrop', weight: 0.006 },
    ],
    clayChance: 0, cactusChance: 0, caneChance: 0.02,
    trees: [{ species: 'spruce', weight: 1 }],
    flowerBeds: {
      chance: 0.1, radius: 2,
      plants: [
        { name: 'snowdrop', weight: 3 }, { name: 'lingonberry_bush', weight: 2 },
        { name: 'fern', weight: 2 }, { name: 'wild_garlic', weight: 1 },
      ],
    },
    cavePlants: [
      // 权重总和不得超过 1：生成按 [0,1) 均匀分布顺序累加选取
      { name: 'glow_moss', weight: 0.37 }, { name: 'glow_fern', weight: 0.22 },
      { name: 'moonflower', weight: 0.15 },
      // v1.7.0：发光虫菌是荧光火把的野外来源
      { name: 'glow_cordyceps', weight: 0.26 },
    ],
    caveChance: 0.055,
  },
  alpine: {
    surface: 'snow', filler: 'dirt',
    plants: [
      { name: 'edelweiss', weight: 0.012 }, { name: 'crocus', weight: 0.014 },
      { name: 'gentian', weight: 0.008 }, { name: 'snow_lily', weight: 0.007 },
      { name: 'snowdrop', weight: 0.006 },
      // v1.7.0：山鼠尾草点缀高山草甸
      { name: 'sage', weight: 0.005 },
    ],
    clayChance: 0, cactusChance: 0, caneChance: 0,
    trees: [{ species: 'spruce', weight: 1 }],
    flowerBeds: {
      chance: 0.2, radius: 2,
      plants: [
        { name: 'crocus', weight: 3 }, { name: 'edelweiss', weight: 3 },
        { name: 'snow_lily', weight: 2 }, { name: 'gentian', weight: 2 },
      ],
    },
    cavePlants: [
      // 权重总和不得超过 1：生成按 [0,1) 均匀分布顺序累加选取
      { name: 'glow_moss', weight: 0.37 }, { name: 'glow_fern', weight: 0.22 },
      { name: 'moonflower', weight: 0.15 },
      // v1.7.0：发光虫菌是荧光火把的野外来源
      { name: 'glow_cordyceps', weight: 0.26 },
    ],
    caveChance: 0.055,
  },
  mesa: {
    surface: 'red_sand', filler: 'terracotta_orange',
    strata: ['terracotta_red', 'terracotta_orange', 'terracotta_yellow', 'terracotta_white', 'terracotta_blue'],
    plants: [{ name: 'dead_bush', weight: 0.01 }],
    clayChance: 0, cactusChance: 0.015, caneChance: 0,
  },
  swamp: {
    surface: 'mud', filler: 'mud',
    // 植物只用地形装饰允许出现在沼泽的名单（fern / 蘑菇因乔木与生态指示角色留出）
    plants: [
      { name: 'moss_carpet', weight: 0.05 }, { name: 'tall_grass', weight: 0.03 },
      // v1.7.0：沼泽是稻与猪笼草的原生地
      { name: 'rice_plant', weight: 0.006 }, { name: 'pitcher_plant', weight: 0.004 },
    ],
    clayChance: 0, cactusChance: 0, caneChance: 0.06,
    lilyChance: 0.03,
    floaters: [{ name: 'lily_pad', weight: 0.7 }, { name: 'duckweed', weight: 0.18 },
      { name: 'lotus', weight: 0.12 }],
    trees: [{ species: 'oak', weight: 1 }],
  },
  savanna: {
    surface: 'dry_grass', filler: 'dirt',
    plants: [
      { name: 'tall_grass', weight: 0.05 }, { name: 'dead_bush', weight: 0.004 },
      // v1.7.0：辣椒丛适应干热气候
      { name: 'chili_bush', weight: 0.0045 },
    ],
    clayChance: 0, cactusChance: 0, caneChance: 0,
    trees: [{ species: 'acacia', weight: 1 }],
  },
  cherry: {
    surface: 'grass', filler: 'dirt',
    plants: [
      { name: 'tall_grass', weight: 0.03 }, { name: 'moss_carpet', weight: 0.03 },
      { name: 'poppy', weight: 0.006 }, { name: 'dandelion', weight: 0.006 },
      // v1.7.0：兰花开在樱花林下
      { name: 'orchid', weight: 0.004 },
    ],
    clayChance: 0, cactusChance: 0, caneChance: 0.02,
    trees: [{ species: 'cherry', weight: 1 }],
  },

  // ---------- 11 → 18 群系扩展（零新方块 id / 零新 tile） ----------
  // 以下 7 项全部复用已注册方块，仅靠表层 / 填充 / 植物 / 树种组合做区分。
  jungle: {
    surface: 'grass', filler: 'dirt',
    plants: [
      { name: 'bamboo', weight: 0.03 }, { name: 'tall_fern', weight: 0.02 },
      { name: 'vine', weight: 0.012 }, { name: 'fern', weight: 0.01 },
      { name: 'moss_carpet', weight: 0.02 },
    ],
    clayChance: 0, cactusChance: 0, caneChance: 0.03,
    trees: [{ species: 'oak', weight: 1 }],
  },
  snowy_tundra: {
    surface: 'snow', filler: 'dirt',
    plants: [
      { name: 'snowdrop', weight: 0.01 }, { name: 'edelweiss', weight: 0.008 },
      { name: 'snow_lily', weight: 0.006 },
    ],
    clayChance: 0, cactusChance: 0, caneChance: 0,
    // 新群系花圃权重按设计表口径取相对权重，总和 ≤ 1
    flowerBeds: {
      chance: 0.1, radius: 2,
      plants: [
        { name: 'snowdrop', weight: 0.5 }, { name: 'edelweiss', weight: 0.3 },
        { name: 'snow_lily', weight: 0.2 },
      ],
    },
  },
  mushroom_grove: {
    surface: 'grass', filler: 'dirt',
    plants: [
      { name: 'red_mushroom', weight: 0.02 }, { name: 'brown_mushroom', weight: 0.02 },
      { name: 'moss_carpet', weight: 0.04 }, { name: 'glow_moss', weight: 0.02 },
      { name: 'ivy', weight: 0.004 },
    ],
    clayChance: 0, cactusChance: 0, caneChance: 0,
    trees: [{ species: 'oak', weight: 1 }],
    cavePlants: [
      // 权重总和不得超过 1：生成按 [0,1) 均匀分布顺序累加选取
      { name: 'glow_moss', weight: 0.37 }, { name: 'glow_fern', weight: 0.22 },
      { name: 'moonflower', weight: 0.15 }, { name: 'glow_cordyceps', weight: 0.26 },
    ],
    caveChance: 0.06,
  },
  bamboo_grove: {
    surface: 'grass', filler: 'dirt',
    plants: [
      { name: 'bamboo', weight: 0.06 }, { name: 'tall_grass', weight: 0.03 },
      { name: 'sugar_cane', weight: 0.01 }, { name: 'vine', weight: 0.01 },
    ],
    clayChance: 0, cactusChance: 0, caneChance: 0.04,
  },
  dark_forest: {
    surface: 'grass', filler: 'dirt',
    plants: [
      { name: 'ivy', weight: 0.006 }, { name: 'moss_carpet', weight: 0.03 },
      { name: 'red_mushroom', weight: 0.008 }, { name: 'brown_mushroom', weight: 0.008 },
      { name: 'fern', weight: 0.012 },
    ],
    clayChance: 0, cactusChance: 0, caneChance: 0,
    trees: [{ species: 'oak', weight: 0.7 }, { species: 'birch', weight: 0.3 }],
    cavePlants: [
      // 权重总和不得超过 1：生成按 [0,1) 均匀分布顺序累加选取
      { name: 'glow_moss', weight: 0.37 }, { name: 'glow_fern', weight: 0.22 },
      { name: 'moonflower', weight: 0.15 }, { name: 'glow_cordyceps', weight: 0.26 },
    ],
    caveChance: 0.06,
  },
  birch_forest: {
    surface: 'grass', filler: 'dirt',
    plants: [
      { name: 'fern', weight: 0.015 }, { name: 'tall_grass', weight: 0.03 },
      { name: 'azure_bluet', weight: 0.008 }, { name: 'lily_of_the_valley', weight: 0.006 },
    ],
    clayChance: 0, cactusChance: 0, caneChance: 0,
    trees: [{ species: 'birch', weight: 1 }],
  },
  snowy_taiga: {
    surface: 'podzol', filler: 'dirt',
    plants: [
      { name: 'snowdrop', weight: 0.01 }, { name: 'lingonberry_bush', weight: 0.012 },
      { name: 'fern', weight: 0.02 }, { name: 'tall_fern', weight: 0.02 },
    ],
    clayChance: 0, cactusChance: 0, caneChance: 0,
    trees: [{ species: 'spruce', weight: 1 }],
    flowerBeds: {
      chance: 0.1, radius: 2,
      plants: [
        { name: 'snowdrop', weight: 0.6 }, { name: 'lingonberry_bush', weight: 0.4 },
      ],
    },
    cavePlants: [
      // 权重总和不得超过 1：生成按 [0,1) 均匀分布顺序累加选取
      { name: 'glow_moss', weight: 0.37 }, { name: 'glow_fern', weight: 0.22 },
      { name: 'moonflower', weight: 0.15 }, { name: 'glow_cordyceps', weight: 0.26 },
    ],
    caveChance: 0.06,
  },
};

interface ColumnBase {
  height: number;
  biome: BiomeId;
  temperature: number;
  humidity: number;
}

/** 矿脉描述：只替换石头，biome 存在时限定群系（绿宝石仅高山） */
interface VeinSpec {
  id: number;
  min: number;
  max: number;
  count: number;
  size: number;
  salt: number;
  biome?: BiomeId;
}

interface ResolvedProfile {
  surface: number;
  filler: number;
  plants: { id: number; weight: number }[];
  plantTotal: number;
  clayChance: number;
  cactusChance: number;
  caneChance: number;
  trees: { species: TreeSpecies; weight: number }[];
  treeTotal: number;
  waterPlants: { id: number; weight: number }[];
  waterPlantTotal: number;
  waterPlantChance: number;
  floaters: { id: number; weight: number }[];
  floaterTotal: number;
  lilyChance: number;
  flowerBedChance: number;
  flowerBedRadius: number;
  flowerBedPlants: { id: number; weight: number }[];
  flowerBedTotal: number;
  cavePlants: { id: number; weight: number }[];
  cavePlantTotal: number;
  caveChance: number;
  pumpkinChance: number;
  strataIds: number[];
}

/** 单区块生成的共享上下文：列信息、高度网格与坐标换算只构建一次 */
interface GenContext {
  cx: number;
  cz: number;
  x0: number;
  z0: number;
  cols: ColumnInfo[];
  idx: (x: number, y: number, z: number) => number;
  at: (lx: number, lz: number) => ColumnInfo;
  groundAt: (wx: number, wz: number) => number;
}

const CACHE_LIMIT = 8192;

/**
 * 缓存超限时淘汰最旧的四分之一，而不是整表清空。
 * 整表清空会把邻区块仍会复用的高度/群系全部丢掉，制造周期性噪声重算尖峰。
 */
function evictOldest<K, V>(cache: Map<K, V>): void {
  if (cache.size < CACHE_LIMIT) return;
  let drop = cache.size >> 2;
  if (drop < 1) drop = 1;
  for (const k of cache.keys()) {
    cache.delete(k);
    if (--drop <= 0) break;
  }
}
const CS = CHUNK_SIZE;
const H = WORLD_HEIGHT;
/** 树冠半径 2，额外留 2 格扫描邻区块的树；甘蔗等岸边装饰也复用该边距 */
const PAD = 4;
const GRID = CS + PAD * 2;
const TREE_CELL = 6;
/** 花圃中心网格：6 格一个候选中心，半径 1~2 格，成片而不重叠 */
const FLOWER_CELL = 6;

/**
 * 默认地形：大陆/海洋 + 域扭曲丘陵 + 脊线山脉 + 河道 + 温度湿度群系
 * + 渐隐洞穴 + 分层矿脉 + 跨区块树木 + 按群系配置表的地表装饰。
 *
 * 设计要点：
 * - 所有特征都由世界坐标 + seed 决定，区块生成顺序不影响结果；
 * - 生成拆成 columns → ores → trees → decorate 四个显式阶段；
 * - 地表方块 / 装饰 / 浅滩黏土 / 仙人掌 / 甘蔗都来自 BIOME_PROFILES 一张表；
 * - 树木按「世界坐标候选点」扫描邻域后裁剪写入本区块，树冠可跨区块连续；
 * - 高度与群系带缓存，整区块只算一次 24×24 列信息。
 */
export class DefaultGenerator implements IWorldGenerator {
  private readonly opt: TerrainOptions;
  private readonly warpNoise: Noise;
  private readonly continent: Noise;
  private readonly hills: Noise;
  private readonly mountain: Noise;
  private readonly river: Noise;
  private readonly temperature: Noise;
  private readonly humidity: Noise;
  private readonly biomeJitter: Noise;
  private readonly cave: Noise;
  private readonly cave2: Noise;
  private readonly ids: Record<string, number>;
  private readonly profiles: Record<BiomeId, ResolvedProfile>;

  /** 生成阶段顺序（测试 / 调试可读） */
  readonly stageNames: readonly TerrainStage[] = TERRAIN_STAGES;
  /** 群系配置表（测试 / 调试可读；方块 id 在构造时解析） */
  readonly biomeProfiles = BIOME_PROFILES;

  /**
   * Worker 侧复刻同一份生成器所需的全部输入（种子 / 方块名→id / 地形参数）。
   * 噪声后端不影响逐位结果：WASM 内核接管前已通过 Object.is 等价自检。
   */
  get workerConfig(): { seed: number; ids: Record<string, BlockId>; options: TerrainOptions } {
    return { seed: this.seed, ids: this.ids, options: this.opt };
  }

  private readonly heightCache = new Map<string, number>();
  private readonly baseCache = new Map<string, ColumnBase>();

  /** 标记本生成器可由 Worker 逐位复刻（自定义生成器无此标记，调用方须回退主线程同步生成） */
  readonly supportsWorkerGeneration = true;

  constructor(
    readonly seed: number,
    ids: BlockIdSource,
    options: Partial<TerrainOptions> = {},
  ) {
    this.opt = {
      ...DEFAULT_TERRAIN,
      ...options,
      treeDensity: { ...DEFAULT_TERRAIN.treeDensity, ...options.treeDensity },
    };
    const n = (salt: number) => new Noise(seed ^ salt);
    this.warpNoise = n(0x1a2b3c4d);
    this.continent = n(0x9e3779b9);
    this.hills = n(0x7f4a7c15);
    this.mountain = n(0x3c6ef372);
    this.river = n(0xd1b54a32);
    this.temperature = n(0x27d4eb2f);
    this.humidity = n(0x165667b1);
    this.biomeJitter = n(0x85ebca6b);
    this.cave = n(0xc2b2ae35);
    this.cave2 = n(0x5bf03675);

    const id = (name: string) => ids.byNameGet(name)?.id ?? 0;
    this.ids = {
      stone: id('stone'), water: id('water'), bedrock: id('bedrock'),
      log: id('oak_log'), leaves: id('oak_leaves'),
      birchLog: id('birch_log'), birchLeaves: id('birch_leaves'),
      spruceLog: id('spruce_log'), spruceLeaves: id('spruce_leaves'),
      coal: id('coal_ore'), iron: id('iron_ore'), gold: id('gold_ore'),
      diamond: id('diamond_ore'), glowstone: id('glowstone'),
      copper: id('copper_ore'), emerald: id('emerald_ore'), lapis: id('lapis_ore'),
      redstone: id('redstone_ore'), granite: id('granite'),
      clay: id('clay'), cactus: id('cactus'), cane: id('sugar_cane'),
      seagrass: id('seagrass'), kelp: id('kelp'), lilyPad: id('lily_pad'),
      pumpkin: id('pumpkin'),
      acaciaLog: id('acacia_log'), acaciaLeaves: id('acacia_leaves'),
      cherryLog: id('cherry_log'), cherryLeaves: id('cherry_leaves'),
    };

    const resolved = {} as Record<BiomeId, ResolvedProfile>;
    for (const biome of Object.keys(BIOME_PROFILES) as BiomeId[]) {
      const p = BIOME_PROFILES[biome];
      const plants = p.plants.map((pl) => ({ id: id(pl.name), weight: pl.weight }));
      const waterPlants = (p.waterPlants ?? []).map((pl) => ({ id: id(pl.name), weight: pl.weight }));
      const trees = [...(p.trees ?? [])];
      const floaters = (p.floaters ?? [{ name: 'lily_pad', weight: 1 }])
        .map((pl) => ({ id: id(pl.name), weight: pl.weight }));
      const flowerBedPlants = (p.flowerBeds?.plants ?? [])
        .map((pl) => ({ id: id(pl.name), weight: pl.weight }));
      const cavePlants = (p.cavePlants ?? []).map((pl) => ({ id: id(pl.name), weight: pl.weight }));
      resolved[biome] = {
        surface: id(p.surface),
        filler: id(p.filler),
        plants,
        plantTotal: plants.reduce((sum, pl) => sum + pl.weight, 0),
        clayChance: p.clayChance,
        cactusChance: p.cactusChance,
        caneChance: p.caneChance,
        trees,
        treeTotal: trees.reduce((sum, t) => sum + t.weight, 0),
        waterPlants,
        waterPlantTotal: waterPlants.reduce((sum, pl) => sum + pl.weight, 0),
        waterPlantChance: p.waterPlantChance ?? 0,
        floaters,
        floaterTotal: floaters.reduce((sum, pl) => sum + pl.weight, 0),
        lilyChance: p.lilyChance ?? 0,
        flowerBedChance: p.flowerBeds?.chance ?? 0,
        flowerBedRadius: p.flowerBeds?.radius ?? 0,
        flowerBedPlants,
        flowerBedTotal: flowerBedPlants.reduce((sum, pl) => sum + pl.weight, 0),
        cavePlants,
        cavePlantTotal: cavePlants.reduce((sum, pl) => sum + pl.weight, 0),
        caveChance: p.caveChance ?? 0,
        pumpkinChance: p.pumpkinChance ?? 0,
        strataIds: (p.strata ?? []).map(id),
      };
    }
    this.profiles = resolved;
  }

  // ---------- 确定性哈希 ----------

  private hash2i(x: number, z: number, salt: number): number {
    let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(this.seed ^ salt, 144665)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  private hashInt(a: number, b: number, c: number, d: number): number {
    let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^
      Math.imul(c, 83492791) ^ Math.imul(d, 2654435761) ^ this.seed) | 0;
    h = Math.imul(h ^ (h >>> 15), 2246822519);
    h ^= h >>> 13;
    return h >>> 0;
  }

  // ---------- 高度场 ----------

  private warped(x: number, z: number): [number, number] {
    const a = this.opt.warp;
    return [
      x + a * this.warpNoise.noise2(x / 140 + 11, z / 140 - 7),
      z + a * this.warpNoise.noise2(x / 140 - 53, z / 140 + 29),
    ];
  }

  private rawHeight(x: number, z: number, wx: number, wz: number): number {
    const o = this.opt;
    const cont = this.continent.fbm2(wx / 220, wz / 220, 3);
    const detail = this.hills.fbm2(wx / 52 + 37, wz / 52 - 11, 3);
    const ridge = this.mountain.ridged2(wx / 190 - 90, wz / 190 + 40, 3);
    const mountMask = smoothstep(0.4, 0.72, ridge) * smoothstep(-0.16, 0.2, cont);

    let h = o.baseHeight + cont * o.continentAmp + detail * o.hillAmp;
    h += mountMask * (o.mountainLift + ridge * o.mountainRidgeAmp);

    // 河道：|n|≈0 的等值线形成蜿蜒低谷。
    // 按「距海平面的高度」平滑淡出，让河谷在海岸自然收口，
    // 而不是用硬阈值在海床上切出一条笔直深沟。
    const river = 1 - Math.abs(this.river.noise2(wx / 110, wz / 110));
    if (river > 0.93) {
      const landFade = smoothstep(SEA_LEVEL - 1, SEA_LEVEL + 4, h);
      h -= ((river - 0.93) / 0.07) * o.riverDepth * landFade;
    }

    // 出生点保底陆地：把低洼处平滑抬到「海平面 + spawnUplift」。
    // max(0, …) 保证只抬不压、任意 seed 都落在陆地；半径用噪声扰动，岛岸不是正圆。
    const wobble = 1 + 0.35 * this.biomeJitter.noise2(x / 45 + 9, z / 45 - 4);
    const radius = o.spawnRadius * wobble;
    const r2 = (x * x + z * z) / (radius * radius);
    const target = SEA_LEVEL + o.spawnUplift;
    h += Math.max(0, (target - h) * Math.exp(-1.5 * r2));

    return clamp(Math.floor(h), 4, H - 14);
  }

  private height(x: number, z: number): number {
    const key = `${x},${z}`;
    const cached = this.heightCache.get(key);
    if (cached !== undefined) return cached;
    const [wx, wz] = this.warped(x, z);
    const h = this.rawHeight(x, z, wx, wz);
    evictOldest(this.heightCache);
    this.heightCache.set(key, h);
    return h;
  }

  /** 公开的地形高度（供水面/出生点/实体生成使用，不受树冠影响） */
  surfaceHeight(x: number, z: number): number {
    return this.height(x, z);
  }

  private base(x: number, z: number): ColumnBase {
    const key = `${x},${z}`;
    const cached = this.baseCache.get(key);
    if (cached) return cached;

    const height = this.height(x, z);
    const temperature = clamp(0.5 + this.temperature.fbm2(x / 300 + 17, z / 300 - 29, 3) * 1.15, 0, 1);
    const humidity = clamp(0.5 + this.humidity.fbm2(x / 240 - 71, z / 240 + 13, 3) * 1.15, 0, 1);
    // 抖动边界，避免群系分界出现笔直线
    const jitter = this.biomeJitter.noise2(x / 22, z / 22) * 0.06;
    const t = clamp(temperature + jitter, 0, 1);
    const m = clamp(humidity + jitter, 0, 1);
    const alt = smoothstep(46, 60, height);

    // 11 → 18 群系扩展「抢占台账」：既有 11 条谓词与相对顺序一字不改，新规则只插在其间。
    // 级联穷举，新群系必然从旧群系取走格子；优先从宽泛兜底域（forest / plains）细分。
    // | 新规则          | 原本落到 | 理由                                                       |
    // | snowy_tundra    | taiga    | 寒冷干燥低地本应是苔原；taiga 保留中湿低温格                  |
    // | snowy_taiga     | taiga    | 最冷且较湿的格改为积雪针叶林；taiga 保留 0.20 ≤ t < 0.30       |
    // | jungle          | forest   | t>0.68 且 m≥0.62 是湿热阔叶林，原 forest 兜底过宽             |
    // | bamboo_grove    | forest   | cherry 湿度带以上（m>0.70）的暖区，cherry 谓词不变且优先      |
    // | mushroom_grove  | forest   | m>0.70 的温和高地；低海拔高湿仍归 swamp（ swamp 规则在前）    |
    // | dark_forest     | forest   | cherry 带之外的中温高湿林；cherry 谓词不变且优先              |
    // | birch_forest    | plains   | m∈(0.45,0.56] 的温和格从 plains 细化                           |

    let biome: BiomeId;
    if (height < SEA_LEVEL) biome = 'ocean';
    else if (height <= SEA_LEVEL + 1) biome = 'beach';
    // 沼泽：高湿（m>0.62）中温（0.3~0.62）低平（海拔 +8 内）
    else if (m > 0.62 && t >= 0.30 && t <= 0.62 && height <= SEA_LEVEL + 8) biome = 'swamp';
    else if (alt > 0.55 || (t < 0.2 && height > 50)) biome = 'alpine';
    // 新：寒冷干燥低地苔原（抢占 taiga 的干燥低温格）
    else if (t < 0.30 && m < 0.40 && height <= SEA_LEVEL + 12) biome = 'snowy_tundra';
    // 新：最冷且较湿的积雪针叶林（抢占 taiga 的最冷格）
    else if (t < 0.20 && m >= 0.40 && height <= 50) biome = 'snowy_taiga';
    else if (t < 0.3) biome = 'taiga';
    // 恶地：比沙漠更热更干
    else if (t > 0.68 && m < 0.28) biome = 'mesa';
    else if (t > 0.68 && m < 0.45) biome = 'desert';
    // 樱花林：温和至暖 + 高湿度区，优先于高湿群系（湿度阈值靠末端增宽，稀有度归因）
    else if (m >= 0.60 && m < 0.70 && t >= 0.40 && t <= 0.68) biome = 'cherry';
    // 新：湿热阔叶林（原 forest 兜底过宽）
    else if (t > 0.68 && m >= 0.62 && m < 0.78) biome = 'jungle';
    // 新：cherry 湿度带以上的暖区竹林
    else if (t > 0.60 && t <= 0.68 && m > 0.70 && height <= SEA_LEVEL + 16) biome = 'bamboo_grove';
    // 新：m>0.70 的温和高地真菌林；低海拔高湿仍归 swamp
    else if (t >= 0.30 && t <= 0.60 && m > 0.70 && height <= SEA_LEVEL + 20) biome = 'mushroom_grove';
    // 新：cherry 带之外的中温高湿暗林
    else if (t >= 0.30 && t <= 0.55 && m > 0.56 && m <= 0.70 && height <= SEA_LEVEL + 24) biome = 'dark_forest';
    // 新：m∈(0.45,0.56] 的温和格从 plains 细化
    else if (t >= 0.30 && t <= 0.55 && m > 0.45 && m <= 0.56 && height <= SEA_LEVEL + 24) biome = 'birch_forest';
    // 热带草原：暖且湿度中等（0.45~0.62）
    else if (t > 0.6 && m >= 0.45 && m < 0.62) biome = 'savanna';
    else if (m > 0.56) biome = 'forest';
    else biome = 'plains';

    const info: ColumnBase = { height, biome, temperature, humidity };
    evictOldest(this.baseCache);
    this.baseCache.set(key, info);
    return info;
  }

  biomeAt(x: number, z: number): BiomeId {
    return this.base(x, z).biome;
  }

  private slopeAt(x: number, z: number): number {
    const d = 2;
    const hx = this.height(x + d, z) - this.height(x - d, z);
    const hz = this.height(x, z + d) - this.height(x, z - d);
    return clamp(Math.hypot(hx, hz) / (2 * d * 1.4), 0, 1);
  }

  /** 供 CraftAPI / 调试使用的完整列信息 */
  columnInfo(x: number, z: number): ColumnInfo {
    const b = this.base(x, z);
    return { x, z, ...b, slope: this.slopeAt(x, z) };
  }

  // ---------- 区块生成 ----------

  generateChunk(cx: number, cz: number, data: Uint8Array): void {
    const ctx = this.buildContext(cx, cz);
    for (const stage of this.stageNames) this.runStage(stage, ctx, data);
  }

  private runStage(stage: TerrainStage, ctx: GenContext, data: Uint8Array): void {
    switch (stage) {
      case 'columns': this.stageColumns(ctx, data); break;
      case 'ores': this.stageOres(ctx, data); break;
      case 'trees': this.stageTrees(ctx, data); break;
      case 'decorate': this.stageDecorate(ctx, data); break;
    }
  }

  /** 一次算出 (16+2×PAD)² 列的地形信息；坡度由高度网格差分，避免逐列重算高度 */
  private buildContext(cx: number, cz: number): GenContext {
    const x0 = cx * CS;
    const z0 = cz * CS;
    const cols: ColumnInfo[] = new Array(GRID * GRID);
    const heights = new Int16Array(GRID * GRID);
    for (let gz = 0; gz < GRID; gz++) {
      for (let gx = 0; gx < GRID; gx++) {
        const wx = x0 + gx - PAD;
        const wz = z0 + gz - PAD;
        const b = this.base(wx, wz);
        const k = gz * GRID + gx;
        heights[k] = b.height;
        cols[k] = { x: wx, z: wz, ...b, slope: 0 };
      }
    }
    for (let gz = 0; gz < GRID; gz++) {
      for (let gx = 0; gx < GRID; gx++) {
        const k = gz * GRID + gx;
        const hx = heights[gz * GRID + Math.min(GRID - 1, gx + 1)] -
          heights[gz * GRID + Math.max(0, gx - 1)];
        const hz = heights[Math.min(GRID - 1, gz + 1) * GRID + gx] -
          heights[Math.max(0, gz - 1) * GRID + gx];
        cols[k].slope = clamp(Math.hypot(hx, hz) / (2 * 1.4), 0, 1);
      }
    }
    return {
      cx, cz, x0, z0, cols,
      idx: (x: number, y: number, z: number) => (y * CS + z) * CS + x,
      at: (lx: number, lz: number) => cols[(lz + PAD) * GRID + lx + PAD],
      groundAt: (wx: number, wz: number) => {
        const gx = wx - x0 + PAD;
        const gz = wz - z0 + PAD;
        if (gx >= 0 && gx < GRID && gz >= 0 && gz < GRID) return heights[gz * GRID + gx];
        return this.height(wx, wz);
      },
    };
  }

  // ---------- 阶段 1：地形柱 + 水 + 洞穴 ----------

  private stageColumns(ctx: GenContext, data: Uint8Array): void {
    const I = this.ids;
    const { x0, z0, at, idx } = ctx;
    for (let lz = 0; lz < CS; lz++) {
      for (let lx = 0; lx < CS; lx++) {
        const c = at(lx, lz);
        const h = c.height;
        const wx = x0 + lx;
        const wz = z0 + lz;
        const profile = this.profiles[c.biome];
        const sandy = c.biome === 'ocean' || c.biome === 'beach' || c.biome === 'desert';
        const snowy = c.biome === 'alpine';
        const steep = c.slope > 0.58;

        // 陡坡露石只作用于非沙质 / 非雪线群系（与旧行为一致）
        let filler = profile.filler;
        let top = profile.surface;
        if (steep && !sandy && !snowy) {
          filler = I.stone;
          top = I.stone;
        }
        // 浅水海床铺黏土：只在海平面下 3 格内的浅滩，深水保持沙床
        if (c.biome === 'ocean' && profile.clayChance > 0 &&
          SEA_LEVEL - h <= 3 && this.hash2i(wx, wz, 0x0c1a) < profile.clayChance) {
          top = I.clay;
        }

        const strata = profile.strataIds;
        // wobble 只依赖列坐标，是列常量：提到 y 循环外，避免每格重复做整数哈希
        const strataWobble = strata.length > 0 ? this.hash2i(wx, wz, 0x7c19) * 1.5 : 0;
        for (let y = 0; y <= h; y++) {
          let id: number;
          if (y === 0) {
            id = I.bedrock;
          } else if (y < h) {
            // 层状地貌（恶地）：按深度循环彩色陶瓦；其余群系保持「石头 + 3 层 filler」
            if (strata.length > 0) {
              id = strata[Math.floor((h - y) / 1.6 + strataWobble) % strata.length];
            } else {
              id = y < h - 3 ? I.stone : filler;
            }
            const cover = h - y;
            const minCover = 5;
            // 洞穴随「距地表深度」渐隐；水下地层完全不挖，
            // 否则会形成被海水压住的空气袋（玩家游过突然能呼吸、渲染出现水下空洞）
            const fade = h >= SEA_LEVEL ? smoothstep(minCover, minCover + 5, cover) : 0;
            if (fade > 0 && y > 3 && cover > 3) {
              const n1 = this.cave.noise3(wx / 26, y / 11, wz / 26);
              const n2 = this.cave2.noise3(wx / 16 + 50, y / 13, wz / 16 - 30);
              const tunnel = 1 - Math.abs(n1);
              if (tunnel > lerp(1.1, 0.905, fade) || n2 > lerp(1.1, 0.6, fade)) id = 0;
            }
          } else {
            id = top;
          }
          data[idx(lx, y, lz)] = id;
        }

        if (h < SEA_LEVEL) {
          for (let y = h + 1; y <= SEA_LEVEL; y++) data[idx(lx, y, lz)] = I.water;
        }
      }
    }
  }

  // ---------- 阶段 2：矿脉 ----------

  private stageOres(ctx: GenContext, data: Uint8Array): void {
    const I = this.ids;
    const veins: VeinSpec[] = [
      { id: I.coal, min: 6, max: 52, count: 16, size: 7, salt: 0x11a },
      { id: I.iron, min: 6, max: 40, count: 10, size: 6, salt: 0x22b },
      { id: I.gold, min: 5, max: 26, count: 5, size: 5, salt: 0x33c },
      { id: I.diamond, min: 4, max: 16, count: 2, size: 4, salt: 0x44d },
      // 深层偶发萤石晶洞，给地下一点自发光
      { id: I.glowstone, min: 8, max: 24, count: 2, size: 3, salt: 0x55e },
      // v1.4.0：铜 / 红石 / 青金石 / 花岗岩随深度分布，绿宝石只在高山
      { id: I.copper, min: 8, max: 50, count: 10, size: 7, salt: 0x66f },
      { id: I.redstone, min: 5, max: 22, count: 6, size: 5, salt: 0x77a },
      { id: I.lapis, min: 6, max: 32, count: 4, size: 5, salt: 0x88b },
      { id: I.emerald, min: 8, max: 42, count: 6, size: 4, salt: 0x99c, biome: 'alpine' },
      { id: I.granite, min: 5, max: 44, count: 8, size: 8, salt: 0xaad },
    ];
    for (const v of veins) {
      if (v.id === 0) continue; // 自定义注册表缺少该方块时静默跳过
      const count = Math.round(v.count * this.opt.oreRichness);
      for (let i = 0; i < count; i++) {
        const rng = mulberry32(this.hashInt(ctx.cx, ctx.cz, v.salt, i));
        const lx = 1 + ((rng() * (CS - 2)) | 0);
        const lz = 1 + ((rng() * (CS - 2)) | 0);
        const wx = ctx.x0 + lx;
        const wz = ctx.z0 + lz;
        if (v.biome && this.biomeAt(wx, wz) !== v.biome) continue;
        // 用本区块中心的地形高度限制矿脉深度，避免穿出海床
        const h = this.height(wx, wz);
        const maxY = Math.min(v.max, h - 5);
        if (maxY < v.min) continue;
        let px = lx;
        let py = v.min + ((rng() * (maxY - v.min + 1)) | 0);
        let pz = lz;
        for (let k = 0; k < v.size; k++) {
          if (px < 0 || px >= CS || pz < 0 || pz >= CS || py < 1 || py >= H) break;
          // 限定群系的矿脉逐格校验，避免矿脉跨过群系边界（绿宝石不跑到山脚）
          if (!v.biome || this.biomeAt(ctx.x0 + px, ctx.z0 + pz) === v.biome) {
            const j = ctx.idx(px, py, pz);
            // 恶地用彩色陶瓦代替石头，允许煤 / 铁等替换底部的陶瓦层（废弃矿井效果）
            const top = data[j];
            const writable = top === I.stone ||
              (ctx.at(px, pz).biome === 'mesa' && top !== 0 && top !== I.bedrock);
            if (writable) data[j] = v.id;
          }
          px += ((rng() * 3) | 0) - 1;
          py += ((rng() * 3) | 0) - 1;
          pz += ((rng() * 3) | 0) - 1;
        }
      }
    }
  }

  // ---------- 阶段 3：跨区块树木 ----------

  private stageTrees(ctx: GenContext, data: Uint8Array): void {
    const I = this.ids;
    const { x0, z0, idx, groundAt } = ctx;
    // 多扫一个格子：邻区块中心的树冠可能伸进本区块
    const gx0 = Math.floor((x0 - PAD - TREE_CELL) / TREE_CELL);
    const gx1 = Math.floor((x0 + CS + PAD) / TREE_CELL);
    const gz0 = Math.floor((z0 - PAD - TREE_CELL) / TREE_CELL);
    const gz1 = Math.floor((z0 + CS + PAD) / TREE_CELL);
    const logOf = (s: TreeSpecies) =>
      s === 'birch' ? I.birchLog : s === 'spruce' ? I.spruceLog :
      s === 'acacia' ? I.acaciaLog : s === 'cherry' ? I.cherryLog : I.log;
    const leafOf = (s: TreeSpecies) =>
      s === 'birch' ? I.birchLeaves : s === 'spruce' ? I.spruceLeaves :
      s === 'acacia' ? I.acaciaLeaves : s === 'cherry' ? I.cherryLeaves : I.leaves;

    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const rDen = this.hash2i(gx, gz, 0x7a1c);
        const rJx = this.hash2i(gx, gz, 0x1b33);
        const rJz = this.hash2i(gx, gz, 0x2c47);
        const wx = gx * TREE_CELL + 1 + ((rJx * (TREE_CELL - 2)) | 0);
        const wz = gz * TREE_CELL + 1 + ((rJz * (TREE_CELL - 2)) | 0);
        const b = this.base(wx, wz);
        const density = this.opt.treeDensity[b.biome] ?? 0;
        if (density <= 0 || rDen > density) continue;
        if (b.height <= SEA_LEVEL || b.height + 14 >= H) continue;
        if (this.slopeAt(wx, wz) > 0.45) continue;

        const species = this.pickTreeSpecies(b.biome, this.hash2i(gx, gz, 0x2f61));
        if (!species) continue;

        // 同一棵树在任何区块里都用同一随机序列，保证跨区块裁剪结果一致
        const rng = mulberry32((Math.imul(wx, 73856093) ^ Math.imul(wz, 19349663) ^ this.seed) | 0);
        const shape = buildTree(species, rng);
        const baseY = b.height + 1;
        let maxDy = 0;
        for (const blk of shape) if (blk.dy > maxDy) maxDy = blk.dy;
        if (baseY + maxDy >= H) continue;

        for (const blk of shape) {
          const lx = wx + blk.dx - x0;
          const lz = wz + blk.dz - z0;
          const yy = baseY + blk.dy;
          if (lx < 0 || lx >= CS || lz < 0 || lz >= CS || yy < 1 || yy >= H) continue;
          if (blk.kind === 'log') {
            data[idx(lx, yy, lz)] = logOf(species);
            continue;
          }
          // 树冠不覆盖地形、不覆盖其他树干；只写入空气
          if (yy <= groundAt(wx + blk.dx, wz + blk.dz)) continue;
          const j = idx(lx, yy, lz);
          if (data[j] === 0) data[j] = leafOf(species);
        }
      }
    }
  }

  /** 按群系权重选择树种；该群系没有配置树种时返回 null */
  private pickTreeSpecies(biome: BiomeId, r: number): TreeSpecies | null {
    const p = this.profiles[biome];
    if (p.treeTotal <= 0 || p.trees.length === 0) return null;
    let acc = 0;
    for (const t of p.trees) {
      acc += t.weight;
      if (r < acc) return t.species;
    }
    return p.trees[p.trees.length - 1].species;
  }

  // ---------- 阶段 4：地表装饰（按群系配置表） ----------

  private stageDecorate(ctx: GenContext, data: Uint8Array): void {
    const I = this.ids;
    const { x0, z0, at, idx, groundAt } = ctx;
    for (let lz = 0; lz < CS; lz++) {
      for (let lx = 0; lx < CS; lx++) {
        const c = at(lx, lz);
        const h = c.height;
        if (h + 1 >= H) continue;
        const profile = this.profiles[c.biome];
        const wx = x0 + lx;
        const wz = z0 + lz;

        // 地下弱光植物：深处空气洞穴里成片生长，给地下一点生气（不占用地表装饰）
        if (profile.caveChance > 0 && h > SEA_LEVEL + 6 &&
          this.hash2i(wx, wz, 0xcafe) < profile.caveChance) {
          const span = h - 8;
          if (span > 1) {
            // 一列最多试 4 个深度，命中洞穴空洞就停；避免依赖单个采样点而几乎不生成
            for (let attempt = 0; attempt < 4; attempt++) {
              const y = 4 + ((this.hash2i(wx, wz, 0xcb01 + attempt) * span) | 0);
              if (y < 2 || y >= h - 3) continue;
              const j = idx(lx, y, lz);
              if (data[j] !== 0 || data[idx(lx, y - 1, lz)] === 0) continue;
              let acc = 0;
              const rc = this.hash2i(wx, wz, 0xcb00);
              for (const pl of profile.cavePlants) {
                acc += pl.weight;
                if (rc >= acc) continue;
                data[j] = pl.id;
                break;
              }
              break;
            }
          }
        }

        // 水下装饰：海草 / 海带长在海床上，浅水水面铺睡莲
        if (h < SEA_LEVEL) {
          if (profile.waterPlantTotal > 0 && profile.waterPlantChance > 0 &&
            data[idx(lx, h + 1, lz)] === I.water &&
            this.hash2i(wx, wz, 0x0cea) < profile.waterPlantChance) {
            let acc = 0;
            const r = this.hash2i(wx, wz, 0x0ceb);
            for (const pl of profile.waterPlants) {
              acc += pl.weight;
              if (r >= acc) continue;
              if (pl.id === I.kelp) {
                // 海带成列向上生长，最多长到水面
                const n = 2 + ((this.hash2i(wx, wz, 0x0cec) * 4) | 0);
                for (let k = 0; k < n; k++) {
                  const y = h + 1 + k;
                  if (y > SEA_LEVEL) break;
                  const j = idx(lx, y, lz);
                  if (data[j] !== I.water) break;
                  data[j] = pl.id;
                }
              } else {
                data[idx(lx, h + 1, lz)] = pl.id;
              }
              break;
            }
          }
          if (profile.lilyChance > 0 && SEA_LEVEL - h <= 3 &&
            profile.floaterTotal > 0 &&
            this.hash2i(wx, wz, 0x1a7e) < profile.lilyChance &&
            SEA_LEVEL + 1 < H && data[idx(lx, SEA_LEVEL + 1, lz)] === 0) {
            let acc = 0;
            const rf = this.hash2i(wx, wz, 0x1a7f);
            for (const fl of profile.floaters) {
              acc += fl.weight;
              if (rf >= acc) continue;
              if (fl.id) data[idx(lx, SEA_LEVEL + 1, lz)] = fl.id;
              break;
            }
          }
          continue;
        }

        // 顶面必须是本群系配置的地表方块：陡坡露石 / 雪线不会被花草覆盖
        if (data[idx(lx, h, lz)] !== profile.surface) continue;
        if (data[idx(lx, h + 1, lz)] !== 0) continue;

        // 甘蔗：紧邻水面的浅岸（含与水面同高的沙滩），1~2 格高
        if (profile.caneChance > 0 && h >= SEA_LEVEL && h <= SEA_LEVEL + 3 &&
          this.hash2i(wx, wz, 0x6a1e) < profile.caneChance &&
          this.nearWater(wx, wz, h, groundAt)) {
          const n = this.hash2i(wx, wz, 0x6a1f) < 0.5 ? 2 : 1;
          for (let k = 0; k < n && h + 1 + k < H; k++) {
            const j = idx(lx, h + 1 + k, lz);
            if (data[j] !== 0) break;
            data[j] = I.cane;
          }
          continue;
        }

        if (h <= SEA_LEVEL) continue;

        // 沙漠仙人掌：成列 1~3 格
        if (profile.cactusChance > 0 && c.slope <= 0.35 &&
          this.hash2i(wx, wz, 0xcac7) < profile.cactusChance) {
          const n = 1 + ((this.hash2i(wx, wz, 0xcac8) * 3) | 0);
          for (let k = 0; k < n && h + 1 + k < H; k++) {
            const j = idx(lx, h + 1 + k, lz);
            if (data[j] !== 0) break;
            data[j] = I.cactus;
          }
          continue;
        }

        // 南瓜：草甸 / 森林地表的稀有野生成丛，也是南瓜藤生长机制的种子来源
        if (profile.pumpkinChance > 0 && c.slope <= 0.4 &&
          this.hash2i(wx, wz, 0x9c3d) < profile.pumpkinChance) {
          data[idx(lx, h + 1, lz)] = I.pumpkin;
          continue;
        }

        // 花圃：以网格点为圆心成片生成花卉，同片以同一花色为主，观感更像花海
        if (profile.flowerBedTotal > 0 && c.slope <= 0.5) {
          const bed = this.bedPlantAt(wx, wz, profile);
          if (bed) {
            data[idx(lx, h + 1, lz)] = bed;
            continue;
          }
        }

        if (c.slope > 0.5) continue;
        if (profile.plantTotal <= 0) continue;
        const r = this.hash2i(wx, wz, 0x51ed);
        let acc = 0;
        for (const pl of profile.plants) {
          acc += pl.weight;
          if (r < acc) {
            data[idx(lx, h + 1, lz)] = pl.id;
            break;
          }
        }
      }
    }
  }

  /**
   * 花圃取样：检查本列附近的候选花圃中心，返回命中的花卉 id（0 表示不在花圃内）。
   * 中心与花色全部由世界坐标哈希决定，区块生成顺序不影响结果。
   */
  private bedPlantAt(wx: number, wz: number, profile: ResolvedProfile): number {
    const r = profile.flowerBedRadius;
    if (r <= 0) return 0;
    const gx0 = Math.floor((wx - r) / FLOWER_CELL);
    const gx1 = Math.floor((wx + r) / FLOWER_CELL);
    const gz0 = Math.floor((wz - r) / FLOWER_CELL);
    const gz1 = Math.floor((wz + r) / FLOWER_CELL);
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        if (this.hash2i(gx, gz, 0x7b0c) >= profile.flowerBedChance) continue;
        const cx = gx * FLOWER_CELL + 1 + ((this.hash2i(gx, gz, 0x7b0d) * (FLOWER_CELL - 2)) | 0);
        const cz = gz * FLOWER_CELL + 1 + ((this.hash2i(gx, gz, 0x7b0e) * (FLOWER_CELL - 2)) | 0);
        const d = Math.max(Math.abs(wx - cx), Math.abs(wz - cz));
        if (d > r) continue;
        // 边缘稀疏：花圃轮廓不是方块，边缘按概率留白
        if (d === r && this.hash2i(wx, wz, 0x7b0f) < 0.45) continue;
        // 18% 的植株换成另一花色，避免整片颜色过于机械
        const mixed = this.hash2i(wx, wz, 0x7b10) < 0.18;
        const pick = (mixed ? this.hash2i(wx, wz, 0x7b11) : this.hash2i(gx, gz, 0x7b12)) *
          profile.flowerBedTotal;
        let acc = 0;
        for (const pl of profile.flowerBedPlants) {
          acc += pl.weight;
          if (pick >= acc) continue;
          if (pl.id) return pl.id;
          return 0;
        }
        return profile.flowerBedPlants[profile.flowerBedPlants.length - 1].id;
      }
    }
    return 0;
  }

  /** 四邻中是否有比自己更低的水面（甘蔗只长在临水浅岸） */
  private nearWater(
    wx: number, wz: number, height: number,
    groundAt: (wx: number, wz: number) => number,
  ): boolean {
    return groundAt(wx + 1, wz) < height || groundAt(wx - 1, wz) < height ||
      groundAt(wx, wz + 1) < height || groundAt(wx, wz - 1) < height;
  }
}
