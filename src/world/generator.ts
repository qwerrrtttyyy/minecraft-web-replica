import {
  CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL, clamp, lerp, smoothstep, mulberry32,
} from '../core/types';
import { Noise, NOISE_BATCH_CAPACITY, type NoiseBatchKind, type NoiseBatchOptions } from './noise';
import type { BlockRegistry } from './blocks';
import { buildTree, type TreeSpecies } from './trees';

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

export type BiomeId = 'ocean' | 'beach' | 'desert' | 'plains' | 'forest' | 'taiga' | 'alpine';

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
  treeDensity: { plains: 0.08, forest: 0.42, taiga: 0.34, alpine: 0.05 },
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
  /** 水下植物（海草 / 海带）权重 */
  waterPlants?: readonly { name: string; weight: number }[];
  /** 水下植物命中概率（0 关闭） */
  waterPlantChance?: number;
  /** 浅水水面生成睡莲的概率（0 关闭） */
  lilyChance?: number;
  /** 地表生成南瓜的概率（0 关闭） */
  pumpkinChance?: number;
}

export const BIOME_PROFILES: Readonly<Record<BiomeId, BiomeProfile>> = {
  ocean: {
    surface: 'sand', filler: 'sand', plants: [],
    clayChance: 0.5, cactusChance: 0, caneChance: 0,
    waterPlants: [{ name: 'seagrass', weight: 0.7 }, { name: 'kelp', weight: 0.3 }],
    waterPlantChance: 0.16, lilyChance: 0.01,
  },
  beach: {
    surface: 'sand', filler: 'sand', plants: [],
    // 沙滩本身不长花草，但临水处是甘蔗最自然的落脚点
    clayChance: 0, cactusChance: 0, caneChance: 0.08,
  },
  desert: {
    surface: 'sand', filler: 'sand',
    plants: [{ name: 'dead_bush', weight: 0.006 }],
    clayChance: 0, cactusChance: 0.02, caneChance: 0,
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
    ],
    clayChance: 0, cactusChance: 0, caneChance: 0.025,
    trees: [{ species: 'oak', weight: 1 }], pumpkinChance: 0.0015,
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
    ],
    clayChance: 0, cactusChance: 0, caneChance: 0.03,
    trees: [{ species: 'oak', weight: 0.65 }, { species: 'birch', weight: 0.35 }],
    pumpkinChance: 0.001,
  },
  taiga: {
    surface: 'podzol', filler: 'dirt',
    plants: [
      { name: 'tall_grass', weight: 0.01 }, { name: 'fern', weight: 0.025 },
      { name: 'tall_fern', weight: 0.03 }, { name: 'poppy', weight: 0.004 },
      { name: 'lily_of_the_valley', weight: 0.004 },
      { name: 'red_mushroom', weight: 0.004 }, { name: 'brown_mushroom', weight: 0.006 },
      { name: 'sweet_berry_bush', weight: 0.008 },
    ],
    clayChance: 0, cactusChance: 0, caneChance: 0.02,
    trees: [{ species: 'spruce', weight: 1 }],
  },
  alpine: {
    surface: 'snow', filler: 'dirt', plants: [],
    clayChance: 0, cactusChance: 0, caneChance: 0,
    trees: [{ species: 'spruce', weight: 1 }],
  },
};

interface ColumnBase {
  height: number;
  biome: BiomeId;
  temperature: number;
  humidity: number;
}

/** 高度场组合所需的噪声采样值：逐点与批量两条路径共用同一份组合逻辑 */
interface HeightSamples {
  continent: number;
  detail: number;
  ridge: number;
  river: number;
  wobble: number;
}

/** 群系组合所需的噪声采样值 */
interface BaseSamples {
  temperature: number;
  humidity: number;
  jitter: number;
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
  lilyChance: number;
  pumpkinChance: number;
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
 * 洞穴阈值表：cover = h-y ∈ [6,10] 时 fade = smoothstep(5,10,cover)，cover>10 饱和为 1。
 * 模块加载时用同一套 smoothstep / lerp 算好，填方块时只做一次比较，
 * 省掉每格的 smoothstep + 两次 lerp；数值与逐格计算逐位相同。
 */
const CAVE_CUT_TUNNEL = new Float64Array(6);
const CAVE_CUT_CAVE2 = new Float64Array(6);
for (let k = 0; k < 6; k++) {
  const fade = smoothstep(5, 10, 5 + k);
  CAVE_CUT_TUNNEL[k] = lerp(1.1, 0.905, fade);
  CAVE_CUT_CAVE2[k] = lerp(1.1, 0.6, fade);
}

/**
 * 缓存键：坐标对 → 数字键。字符串键要为每列拼模板字符串并做字符串哈希，
 * 实测「576 次 get + 1152 次 set」从 89µs 降到 30µs（约合每区块 60µs）。
 * ±2^25（±3355 万方块）远超可玩范围，键值最大约 2^52，仍是精确整数；
 * 超出该范围退回字符串键，保证任何坐标下都不碰撞、不影响地形。
 */
const KEY_SPAN = 1 << 25;
const KEY_MOD = 1 << 26;

function coordKey(x: number, z: number): number | string {
  if (x > -KEY_SPAN && x < KEY_SPAN && z > -KEY_SPAN && z < KEY_SPAN) {
    return (x + KEY_SPAN) * KEY_MOD + (z + KEY_SPAN);
  }
  return `${x},${z}`;
}

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

/**
 * 批量写入前一次性腾出空间。原先每列都调一次 evictOldest，一个区块 1152 次；
 * 实测这部分占 CPU 采样 4.3%，集中调用后降到两次。
 */
function evictRoom<K, V>(cache: Map<K, V>, incoming: number): void {
  if (cache.size + incoming <= CACHE_LIMIT) return;
  let drop = cache.size >> 2;
  if (drop < incoming) drop = incoming;
  if (drop > cache.size) drop = cache.size;
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

  private readonly heightCache = new Map<number | string, number>();
  private readonly baseCache = new Map<number | string, ColumnBase>();
  /** composeBaseInto 的复用输出对象，避免每列新建一个 ColumnBase */
  private readonly baseScratch: ColumnBase = { height: 0, biome: 'plains', temperature: 0, humidity: 0 };

  /**
   * 批量采样复用缓冲：每区块原本要新建 10 组 Float64Array（约 138KB），
   * 实测分配 + 填充 55µs，复用后 3µs。生成是单线程串行的，可安全复用。
   */
  private readonly batchCoords = new Float64Array(GRID * GRID * 3);
  private readonly batchCont = new Float64Array(GRID * GRID);
  private readonly batchDetail = new Float64Array(GRID * GRID);
  private readonly batchRidge = new Float64Array(GRID * GRID);
  private readonly batchRiver = new Float64Array(GRID * GRID);
  private readonly batchWobble = new Float64Array(GRID * GRID);
  private readonly batchTemp = new Float64Array(GRID * GRID);
  private readonly batchHumid = new Float64Array(GRID * GRID);
  private readonly batchJitter = new Float64Array(GRID * GRID);
  private readonly batchWarpX = new Float64Array(GRID * GRID);
  private readonly batchWarpZ = new Float64Array(GRID * GRID);

  /** 洞穴批量缓冲：一行 16 列 × 最多 57 点 = 912 点，落在内核容量内 */
  private readonly caveCoords = new Float64Array(NOISE_BATCH_CAPACITY * 3);
  private readonly cave2Coords = new Float64Array(NOISE_BATCH_CAPACITY * 3);
  private readonly caveOut = new Float64Array(NOISE_BATCH_CAPACITY);
  private readonly cave2Out = new Float64Array(NOISE_BATCH_CAPACITY);
  /** 每段内逐列元数据，避免第二遍重算群系 / 陡坡 / 黏土判定 */
  private readonly rowStart = new Int32Array(CS);
  private readonly rowHeight = new Int16Array(CS);
  private readonly rowFiller = new Uint8Array(CS);
  private readonly rowTop = new Uint8Array(CS);

  constructor(
    readonly seed: number,
    registry: BlockRegistry,
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

    const id = (name: string) => registry.byNameGet(name)?.id ?? 0;
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
    };

    const resolved = {} as Record<BiomeId, ResolvedProfile>;
    for (const biome of Object.keys(BIOME_PROFILES) as BiomeId[]) {
      const p = BIOME_PROFILES[biome];
      const plants = p.plants.map((pl) => ({ id: id(pl.name), weight: pl.weight }));
      const waterPlants = (p.waterPlants ?? []).map((pl) => ({ id: id(pl.name), weight: pl.weight }));
      const trees = [...(p.trees ?? [])];
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
        lilyChance: p.lilyChance ?? 0,
        pumpkinChance: p.pumpkinChance ?? 0,
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

  /**
   * 高度场组合：唯一实现，逐点（height）与批量（buildContext）只是采样来源不同。
   * 运算顺序与 v1.5.x 完全一致，禁止重排——任何 1 ULP 差异都会改变固定 seed 地形。
   */
  private composeHeight(
    x: number, z: number,
    continent: number, detail: number, ridge: number, river0: number, wobble0: number,
  ): number {
    const o = this.opt;
    const mountMask = smoothstep(0.4, 0.72, ridge) * smoothstep(-0.16, 0.2, continent);

    let h = o.baseHeight + continent * o.continentAmp + detail * o.hillAmp;
    h += mountMask * (o.mountainLift + ridge * o.mountainRidgeAmp);

    // 河道：|n|≈0 的等值线形成蜿蜒低谷。
    // 按「距海平面的高度」平滑淡出，让河谷在海岸自然收口，
    // 而不是用硬阈值在海床上切出一条笔直深沟。
    const river = 1 - Math.abs(river0);
    if (river > 0.93) {
      const landFade = smoothstep(SEA_LEVEL - 1, SEA_LEVEL + 4, h);
      h -= ((river - 0.93) / 0.07) * o.riverDepth * landFade;
    }

    // 出生点保底陆地：把低洼处平滑抬到「海平面 + spawnUplift」。
    // max(0, …) 保证只抬不压、任意 seed 都落在陆地；半径用噪声扰动，岛岸不是正圆。
    const wobble = 1 + 0.35 * wobble0;
    const radius = o.spawnRadius * wobble;
    const r2 = (x * x + z * z) / (radius * radius);
    const target = SEA_LEVEL + o.spawnUplift;
    h += Math.max(0, (target - h) * Math.exp(-1.5 * r2));

    return clamp(Math.floor(h), 4, H - 14);
  }

  /** 逐点采样高度噪声（height() 用）；批量路径用 batchSample 取同一组值 */
  private sampleHeight(x: number, z: number, wx: number, wz: number): HeightSamples {
    return {
      continent: this.continent.fbm2(wx / 220, wz / 220, 3),
      detail: this.hills.fbm2(wx / 52 + 37, wz / 52 - 11, 3),
      ridge: this.mountain.ridged2(wx / 190 - 90, wz / 190 + 40, 3),
      river: this.river.noise2(wx / 110, wz / 110),
      wobble: this.biomeJitter.noise2(x / 45 + 9, z / 45 - 4),
    };
  }

  private height(x: number, z: number): number {
    const key = coordKey(x, z);
    const cached = this.heightCache.get(key);
    if (cached !== undefined) return cached;
    // 列信息里已经包含高度：命中 baseCache 就不再重算、也不再重复写一份 heightCache。
    // buildContext 因此只写 baseCache，每区块少 576 次 set 与一轮淘汰。
    const column = this.baseCache.get(key);
    if (column) return column.height;
    const [wx, wz] = this.warped(x, z);
    const s = this.sampleHeight(x, z, wx, wz);
    const h = this.composeHeight(x, z, s.continent, s.detail, s.ridge, s.river, s.wobble);
    evictOldest(this.heightCache);
    this.heightCache.set(key, h);
    return h;
  }

  /** 公开的地形高度（供水面/出生点/实体生成使用，不受树冠影响） */
  surfaceHeight(x: number, z: number): number {
    return this.height(x, z);
  }

  /** 群系组合：写入调用方提供的对象，逐点与批量两条路径共用（避免每列一行对象字面量） */
  private composeBaseInto(
    height: number, temperature0: number, humidity0: number, jitter0: number, out: ColumnBase,
  ): void {
    const temperature = clamp(0.5 + temperature0 * 1.15, 0, 1);
    const humidity = clamp(0.5 + humidity0 * 1.15, 0, 1);
    // 抖动边界，避免群系分界出现笔直线
    const jitter = jitter0 * 0.06;
    const t = clamp(temperature + jitter, 0, 1);
    const m = clamp(humidity + jitter, 0, 1);
    const alt = smoothstep(46, 60, height);

    let biome: BiomeId;
    if (height < SEA_LEVEL) biome = 'ocean';
    else if (height <= SEA_LEVEL + 1) biome = 'beach';
    else if (alt > 0.55 || (t < 0.2 && height > 50)) biome = 'alpine';
    else if (t < 0.3) biome = 'taiga';
    else if (t > 0.68 && m < 0.45) biome = 'desert';
    else if (m > 0.56) biome = 'forest';
    else biome = 'plains';

    out.height = height;
    out.biome = biome;
    out.temperature = temperature;
    out.humidity = humidity;
  }

  private composeBase(height: number, s: BaseSamples): ColumnBase {
    const out: ColumnBase = { height, biome: 'plains', temperature: 0, humidity: 0 };
    this.composeBaseInto(height, s.temperature, s.humidity, s.jitter, out);
    return out;
  }

  /** 逐点采样群系噪声（base() 用）；批量路径用 batchSample 取同一组值 */
  private sampleBase(x: number, z: number): BaseSamples {
    return {
      temperature: this.temperature.fbm2(x / 300 + 17, z / 300 - 29, 3),
      humidity: this.humidity.fbm2(x / 240 - 71, z / 240 + 13, 3),
      jitter: this.biomeJitter.noise2(x / 22, z / 22),
    };
  }

  private base(x: number, z: number): ColumnBase {
    const key = coordKey(x, z);
    const cached = this.baseCache.get(key);
    if (cached) return cached;

    const height = this.height(x, z);
    const info = this.composeBase(height, this.sampleBase(x, z));
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
    const n = GRID * GRID;
    const cols: ColumnInfo[] = new Array(n);
    const heights = new Int16Array(n);

    // 1) 先吃 baseCache；未命中的列收集起来，按噪声实例分组批量采样。
    //    命中列完全跳过跨界，保证相邻区块重叠的 PAD 边不会重复付费。
    const xs = new Float64Array(n);
    const zs = new Float64Array(n);
    const missIdx = new Int32Array(n);
    let miss = 0;
    for (let gz = 0; gz < GRID; gz++) {
      for (let gx = 0; gx < GRID; gx++) {
        const k = gz * GRID + gx;
        const wx = x0 + gx - PAD;
        const wz = z0 + gz - PAD;
        const cached = this.baseCache.get(coordKey(wx, wz));
        if (cached) {
          // 逐字段展开而不用 ...cached：命中率高，展开会让 V8 走一遍 spread 慢路径，
          // 且显式字段与 miss 分支保持同一隐藏类
          cols[k] = {
            x: wx,
            z: wz,
            height: cached.height,
            biome: cached.biome,
            temperature: cached.temperature,
            humidity: cached.humidity,
            slope: 0,
          };
          heights[k] = cached.height;
        } else {
          xs[miss] = wx;
          zs[miss] = wz;
          missIdx[miss] = k;
          miss++;
        }
      }
    }

    if (miss > 0) {
      // 2) 每类噪声一次批量跨界（miss ≤ 576 < NOISE_BATCH_CAPACITY），输出写进复用缓冲
      const warpX = this.batchWarpX;
      const warpZ = this.batchWarpZ;
      this.batchSampleInto(this.warpNoise, 'noise2', xs, zs, miss, 140, 11, 140, -7, warpX);
      this.batchSampleInto(this.warpNoise, 'noise2', xs, zs, miss, 140, -53, 140, 29, warpZ);
      const amp = this.opt.warp;
      for (let i = 0; i < miss; i++) {
        warpX[i] = xs[i] + amp * warpX[i];
        warpZ[i] = zs[i] + amp * warpZ[i];
      }
      const octaves3: NoiseBatchOptions = { octaves: 3, lacunarity: 2, gain: 0.5 };
      const cont = this.batchCont;
      const detail = this.batchDetail;
      const ridge = this.batchRidge;
      const river = this.batchRiver;
      const wobble = this.batchWobble;
      const temp = this.batchTemp;
      const humid = this.batchHumid;
      const jitter = this.batchJitter;
      this.batchSampleInto(this.continent, 'fbm2', warpX, warpZ, miss, 220, 0, 220, 0, cont, octaves3);
      this.batchSampleInto(this.hills, 'fbm2', warpX, warpZ, miss, 52, 37, 52, -11, detail, octaves3);
      this.batchSampleInto(this.mountain, 'ridged2', warpX, warpZ, miss, 190, -90, 190, 40, ridge, octaves3);
      this.batchSampleInto(this.river, 'noise2', warpX, warpZ, miss, 110, 0, 110, 0, river);
      this.batchSampleInto(this.biomeJitter, 'noise2', xs, zs, miss, 45, 9, 45, -4, wobble);
      // 群系噪声不依赖高度，与高度场一起批量取
      this.batchSampleInto(this.temperature, 'fbm2', xs, zs, miss, 300, 17, 300, -29, temp, octaves3);
      this.batchSampleInto(this.humidity, 'fbm2', xs, zs, miss, 240, -71, 240, 13, humid, octaves3);
      this.batchSampleInto(this.biomeJitter, 'noise2', xs, zs, miss, 22, 0, 22, 0, jitter);

      // 3) 组合逻辑仍走 composeHeight / composeBaseInto，结果与逐点路径逐位一致
      evictRoom(this.baseCache, miss);
      const scratch = this.baseScratch;
      for (let i = 0; i < miss; i++) {
        const x = xs[i];
        const z = zs[i];
        const h = this.composeHeight(x, z, cont[i], detail[i], ridge[i], river[i], wobble[i]);
        this.composeBaseInto(h, temp[i], humid[i], jitter[i], scratch);
        const k = missIdx[i];
        cols[k] = {
          x, z, height: h, biome: scratch.biome, temperature: scratch.temperature, humidity: scratch.humidity, slope: 0,
        };
        heights[k] = h;
        const key = coordKey(x, z);
        // 必须存副本：scratch 是所有列共用的复用对象，直接存会全部指向最后一次写入
        this.baseCache.set(key, {
          height: h, biome: scratch.biome, temperature: scratch.temperature, humidity: scratch.humidity,
        });
      }
    }

    // 4) 坡度差分（与原实现一致）
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

  /**
   * 批量采样辅助：把 (srcX, srcZ) 按「除法 + 偏移」映射到噪声域，一次跨界求值，
   * 结果写进调用方提供的复用缓冲 out[0..count)。
   * 必须用除法而不是乘倒数——x/220 与 x*(1/220) 不是同一浮点运算。
   */
  private batchSampleInto(
    noise: Noise, kind: NoiseBatchKind,
    srcX: Float64Array, srcZ: Float64Array, count: number,
    xDiv: number, xOff: number, zDiv: number, zOff: number,
    out: Float64Array, opts?: NoiseBatchOptions,
  ): void {
    const coords = this.batchCoords;
    for (let i = 0; i < count; i++) {
      coords[i * 3] = srcX[i] / xDiv + xOff;
      coords[i * 3 + 1] = srcZ[i] / zDiv + zOff;
      coords[i * 3 + 2] = 0;
    }
    noise.batch(kind, coords, count, out, opts);
  }

  // ---------- 阶段 1：地形柱 + 水 + 洞穴 ----------

  /**
   * 该高度的列需要洞穴采样的 y 数量。
   * 填方块循环的条件是 `fade > 0 && y > 3`，即 y ∈ [4, h-6]，是连续区间；
   * 水下（h < 海平面）fade 恒为 0，不采样。两处判定必须同步，否则批量下标会错位。
   */
  private caveCount(h: number): number {
    if (h < SEA_LEVEL) return 0;
    const endY = Math.min(h - 6, H - 1);
    return endY < 4 ? 0 : endY - 3;
  }

  private stageColumns(ctx: GenContext, data: Uint8Array): void {
    const { at } = ctx;
    for (let lz = 0; lz < CS; lz++) {
      // 按内核批量容量切段：一行 16 列 × 最多 57 点 = 912 点，正常一段跑完；
      // 若日后世界高度变大，这里会自动多切一段，不会越界。
      let lx0 = 0;
      while (lx0 < CS) {
        let lx1 = lx0;
        let total = 0;
        while (lx1 < CS) {
          const count = this.caveCount(at(lx1, lz).height);
          if (lx1 > lx0 && total + count > NOISE_BATCH_CAPACITY) break;
          total += count;
          lx1++;
        }
        this.emitColumnSegment(ctx, data, lz, lx0, lx1);
        lx0 = lx1;
      }
    }
  }

  /**
   * 一段连续列：先整段批量算洞穴噪声（两次跨界），再逐列填方块。
   * 每个点的 y 顺序、噪声坐标与逐列版本完全一致，结果逐位不变。
   */
  private emitColumnSegment(
    ctx: GenContext, data: Uint8Array, lz: number, lx0: number, lx1: number,
  ): void {
    const I = this.ids;
    const { x0, z0, at } = ctx;
    const coords = this.caveCoords;
    const coords2 = this.cave2Coords;

    // 1) 逐列元数据 + 洞穴采样坐标（黏土随机判定也只算一次，第二遍直接复用）
    let total = 0;
    for (let lx = lx0; lx < lx1; lx++) {
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

      this.rowStart[lx] = total;
      this.rowHeight[lx] = h;
      this.rowFiller[lx] = filler;
      this.rowTop[lx] = top;

      const count = this.caveCount(h);
      if (count > 0) {
        const caveX = wx / 26;
        const caveZ = wz / 26;
        const cave2X = wx / 16 + 50;
        const cave2Z = wz / 16 - 30;
        // 同一列的点必须连续排在一起：内核的「上一格」缓存靠它才能命中
        // （同一列 y 连续时 ~11 个点共用一个格），顺序打乱只是变慢，结果不变
        for (let k = 0; k < count; k++) {
          const i = total + k;
          const y = 4 + k;
          coords[i * 3] = caveX;
          coords[i * 3 + 1] = y / 11;
          coords[i * 3 + 2] = caveZ;
          coords2[i * 3] = cave2X;
          coords2[i * 3 + 1] = y / 13;
          coords2[i * 3 + 2] = cave2Z;
        }
        total += count;
      }
    }

    // 2) 整段两次跨界（原实现每列两次，512 次/区块）
    if (total > 0) {
      this.cave.batch('noise3', coords, total, this.caveOut);
      this.cave2.batch('noise3', coords2, total, this.cave2Out);
    }

    // 3) 填方块：洞穴结果按收集顺序读取。
    //    按 y 区间拆成 5 段，避免逐格判断分支；阈值表取代每格的 smoothstep + 两次 lerp。
    const YSTEP = CS * CS;
    for (let lx = lx0; lx < lx1; lx++) {
      const h = this.rowHeight[lx];
      const filler = this.rowFiller[lx];
      const top = this.rowTop[lx];
      // 与 ctx.idx 同一公式：idx(x,y,z) = y*CS*CS + z*CS + x
      const col = lz * CS + lx;
      data[col] = I.bedrock;

      const stoneEnd = h - 4; // y ≤ h-4 是石壳（原条件 y < h-3）
      const caveEnd = h >= SEA_LEVEL ? h - 6 : 3; // fade>0 且 y>3 → y ∈ [4, h-6]
      for (let y = 1; y <= 3 && y <= stoneEnd; y++) data[y * YSTEP + col] = I.stone;

      let ci = this.rowStart[lx];
      for (let y = 4; y <= caveEnd; y++) {
        const n1 = this.caveOut[ci];
        const n2 = this.cave2Out[ci];
        ci++;
        // 阈值只取决于 cover=h-y ∈ [6,10]，>10 时 fade 饱和为 1
        const k = Math.min(h - y - 5, 5);
        const tunnel = 1 - Math.abs(n1);
        data[y * YSTEP + col] = tunnel > CAVE_CUT_TUNNEL[k] || n2 > CAVE_CUT_CAVE2[k] ? 0 : I.stone;
      }
      for (let y = Math.max(caveEnd + 1, 4); y <= stoneEnd; y++) data[y * YSTEP + col] = I.stone;
      for (let y = Math.max(h - 3, 1); y < h; y++) data[y * YSTEP + col] = filler;
      data[h * YSTEP + col] = top;

      if (h < SEA_LEVEL) {
        for (let y = h + 1; y <= SEA_LEVEL; y++) data[y * YSTEP + col] = I.water;
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
            if (data[j] === I.stone) data[j] = v.id;
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
      s === 'birch' ? I.birchLog : s === 'spruce' ? I.spruceLog : I.log;
    const leafOf = (s: TreeSpecies) =>
      s === 'birch' ? I.birchLeaves : s === 'spruce' ? I.spruceLeaves : I.leaves;

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
            this.hash2i(wx, wz, 0x1a7e) < profile.lilyChance &&
            SEA_LEVEL + 1 < H && data[idx(lx, SEA_LEVEL + 1, lz)] === 0) {
            data[idx(lx, SEA_LEVEL + 1, lz)] = I.lilyPad;
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

  /** 四邻中是否有比自己更低的水面（甘蔗只长在临水浅岸） */
  private nearWater(
    wx: number, wz: number, height: number,
    groundAt: (wx: number, wz: number) => number,
  ): boolean {
    return groundAt(wx + 1, wz) < height || groundAt(wx - 1, wz) < height ||
      groundAt(wx, wz + 1) < height || groundAt(wx, wz - 1) < height;
  }
}
