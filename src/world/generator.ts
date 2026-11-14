import {
  CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL, clamp, lerp, smoothstep, mulberry32,
} from '../core/types';
import { Noise } from './noise';
import type { BlockRegistry } from './blocks';

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
  treeDensity: { plains: 0.08, forest: 0.42, taiga: 0.34 },
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
}

export const BIOME_PROFILES: Readonly<Record<BiomeId, BiomeProfile>> = {
  ocean: {
    surface: 'sand', filler: 'sand', plants: [],
    clayChance: 0.5, cactusChance: 0, caneChance: 0,
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
      { name: 'tall_grass', weight: 0.068 }, { name: 'poppy', weight: 0.022 },
      { name: 'dandelion', weight: 0.02 }, { name: 'fern', weight: 0.01 },
    ],
    clayChance: 0, cactusChance: 0, caneChance: 0.025,
  },
  forest: {
    surface: 'grass', filler: 'dirt',
    plants: [
      { name: 'tall_grass', weight: 0.099 }, { name: 'poppy', weight: 0.032 },
      { name: 'dandelion', weight: 0.029 }, { name: 'fern', weight: 0.012 },
    ],
    clayChance: 0, cactusChance: 0, caneChance: 0.03,
  },
  taiga: {
    surface: 'podzol', filler: 'dirt',
    plants: [
      { name: 'tall_grass', weight: 0.05 }, { name: 'fern', weight: 0.035 },
      { name: 'poppy', weight: 0.016 }, { name: 'dandelion', weight: 0.014 },
    ],
    clayChance: 0, cactusChance: 0, caneChance: 0.02,
  },
  alpine: {
    surface: 'snow', filler: 'dirt', plants: [],
    clayChance: 0, cactusChance: 0, caneChance: 0,
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

  private readonly heightCache = new Map<string, number>();
  private readonly baseCache = new Map<string, ColumnBase>();

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
      coal: id('coal_ore'), iron: id('iron_ore'), gold: id('gold_ore'),
      diamond: id('diamond_ore'), glowstone: id('glowstone'),
      copper: id('copper_ore'), emerald: id('emerald_ore'), lapis: id('lapis_ore'),
      redstone: id('redstone_ore'), granite: id('granite'),
      clay: id('clay'), cactus: id('cactus'), cane: id('sugar_cane'),
    };

    const resolved = {} as Record<BiomeId, ResolvedProfile>;
    for (const biome of Object.keys(BIOME_PROFILES) as BiomeId[]) {
      const p = BIOME_PROFILES[biome];
      const plants = p.plants.map((pl) => ({ id: id(pl.name), weight: pl.weight }));
      resolved[biome] = {
        surface: id(p.surface),
        filler: id(p.filler),
        plants,
        plantTotal: plants.reduce((sum, pl) => sum + pl.weight, 0),
        clayChance: p.clayChance,
        cactusChance: p.cactusChance,
        caneChance: p.caneChance,
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

    let biome: BiomeId;
    if (height < SEA_LEVEL) biome = 'ocean';
    else if (height <= SEA_LEVEL + 1) biome = 'beach';
    else if (alt > 0.55 || (t < 0.2 && height > 50)) biome = 'alpine';
    else if (t < 0.3) biome = 'taiga';
    else if (t > 0.68 && m < 0.45) biome = 'desert';
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

        for (let y = 0; y <= h; y++) {
          let id: number;
          if (y === 0) {
            id = I.bedrock;
          } else if (y < h - 3) {
            id = I.stone;
            const cover = h - y;
            const minCover = 5;
            // 洞穴随「距地表深度」渐隐；水下地层完全不挖，
            // 否则会形成被海水压住的空气袋（玩家游过突然能呼吸、渲染出现水下空洞）
            const fade = h >= SEA_LEVEL ? smoothstep(minCover, minCover + 5, cover) : 0;
            if (fade > 0 && y > 3) {
              const n1 = this.cave.noise3(wx / 26, y / 11, wz / 26);
              const n2 = this.cave2.noise3(wx / 16 + 50, y / 13, wz / 16 - 30);
              const tunnel = 1 - Math.abs(n1);
              if (tunnel > lerp(1.1, 0.905, fade) || n2 > lerp(1.1, 0.6, fade)) id = 0;
            }
          } else if (y < h) {
            id = filler;
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
        if (b.height <= SEA_LEVEL || b.height + 10 >= H) continue;
        if (this.slopeAt(wx, wz) > 0.45) continue;

        // 同一棵树在任何区块里都用同一随机序列，保证跨区块裁剪结果一致
        const rng = mulberry32((Math.imul(wx, 73856093) ^ Math.imul(wz, 19349663) ^ this.seed) | 0);
        const trunk = 4 + ((rng() * 3) | 0);
        const baseY = b.height + 1;
        if (baseY + trunk + 2 >= H) continue;
        const crown = b.biome === 'taiga' ? 1 : 2;

        // 树干：只写本区块内的那一列
        if (wx >= x0 && wx < x0 + CS && wz >= z0 && wz < z0 + CS) {
          const lx = wx - x0;
          const lz = wz - z0;
          for (let dy = 0; dy < trunk; dy++) {
            const yy = baseY + dy;
            if (yy < H) data[idx(lx, yy, lz)] = I.log;
          }
        }

        // 树冠：按世界坐标计算，按本区块范围裁剪
        const topRad = Math.max(1, crown - 1);
        for (let dy = trunk - 2; dy <= trunk + 1; dy++) {
          const rad = dy >= trunk ? topRad : crown;
          for (let dx = -rad; dx <= rad; dx++) {
            for (let dz = -rad; dz <= rad; dz++) {
              if (Math.abs(dx) === rad && Math.abs(dz) === rad && (dy >= trunk || rng() < 0.5)) continue;
              const lx = wx + dx - x0;
              const lz = wz + dz - z0;
              const yy = baseY + dy;
              if (lx < 0 || lx >= CS || lz < 0 || lz >= CS || yy >= H) continue;
              if (yy <= groundAt(wx + dx, wz + dz)) continue;
              const j = idx(lx, yy, lz);
              if (data[j] === 0) data[j] = I.leaves;
            }
          }
        }
      }
    }
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
        // 顶面必须是本群系配置的地表方块：陡坡露石 / 雪线不会被花草覆盖
        if (data[idx(lx, h, lz)] !== profile.surface) continue;
        if (data[idx(lx, h + 1, lz)] !== 0) continue;
        const wx = x0 + lx;
        const wz = z0 + lz;

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
