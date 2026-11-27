import { CHUNK_SIZE, WORLD_HEIGHT, blockKey, clamp, mulberry32, type BlockId } from '../core/types';
import type { EventService } from '../services/events';
import { AIR, type BlockRegistry } from './blocks';
import {
  HARVEST_ENERGY_COST, MAX_PLANT_ENERGY, NIGHT_ENERGY_FLOOR, START_PLANT_ENERGY,
  plantTrait, type PlantTrait,
} from './plantTraits';
import { buildTree, type TreeSpecies } from './trees';
import { PlantRuleRegistry, type PlantRule, type PlantRuleContext } from './plantRules';
import { DEFAULT_PLANT_ENV, modifiers, scaledChance, type PlantEnv } from './ecology';
import {
  MAX_SOIL_NUTRIENT, consume as consumeNutrient, enrich as enrichNutrient,
  evictIfNeeded as evictSoil, nutrientAt as soilNutrientAt, returnToSoil,
  type SoilMap,
} from './soil';
import {
  STRAINS, STRAIN_ORDER, applyStrain, findCombo, strainAt, strainIndexOf,
  type StrainId,
} from './plantStrains';
import type { World } from './world';

/** 一次随机刻里最多处理的采样次数（移动端减半，避免持续占用帧预算） */
export interface BotanyOptions {
  /** 随机刻间隔（秒） */
  interval?: number;
  /** 每次随机刻的采样尝试数 */
  attempts?: number;
  /** 以玩家为中心的水平采样半径（格） */
  radius?: number;
  isMobile?: boolean;
}

type GrowKind = 'grow' | 'spread' | 'decay' | 'ripen' | 'harvest';

/** 单株植物的内在能量状态 */
export interface PlantEnergyState {
  x: number;
  y: number;
  z: number;
  id: BlockId;
  /** 0~100 */
  energy: number;
  /** 本轮蓄能是否已经发过开花反馈（能量跌破半阈值后重新武装） */
  bloomed?: boolean;
}

export interface BotanyStats {
  tracked: number;
  charged: number;
  avgEnergy: number;
  /** 附近被跟踪土壤的平均养分（未记录土壤不计入），无记录时为 100 */
  soilAvg: number;
  solar: number;
  hydro: number;
  fungal: number;
}

export interface PlantBonus {
  item: string;
  count: number;
  /** 品系附加产出（莓穗的甜浆果 / 金穗的花蜜） */
  extra?: { item: string; count: number };
}

/** 生态状态存档（v1）：紧凑元组，避免对象开销撑大存档 */
export interface PlantSaveV1 {
  v: 1;
  /** [锚点x, 锚点y, 锚点z, blockId, energy 0~100, bloomed 0|1] */
  plants: [number, number, number, number, number, 0 | 1][];
  /** [土壤x, 土壤y, 土壤z, nutrient 0~100] */
  soil: [number, number, number, number][];
}

/**
 * 生态状态存档（v2，minecraft-web-replica-botany 品系扩展）：
 * plants / soil 元组形状与 v1 相同，追加 strains；
 * v1 存档可直接按 v2 读取（strains 缺省为空 = 无品系）。
 */
export interface PlantSaveV2 {
  v: 2;
  /** [锚点x, 锚点y, 锚点z, blockId, energy 0~100, bloomed 0|1] */
  plants: PlantSaveV1['plants'];
  /** [土壤x, 土壤y, 土壤z, nutrient 0~100] */
  soil: PlantSaveV1['soil'];
  /** [锚点x, 锚点y, 锚点z, strainIndex（STRAIN_ORDER 下标）] */
  strains: [number, number, number, number][];
}

/** 单类状态存档上限，防止存档体积失控 */
export const ECOLOGY_SAVE_LIMIT = 1024;

/** 生态规则的方块 id 表：显式接口保证漏键在编译期暴露，而不是静默变成 0 */
interface BotanyIds {
  grass: BlockId; dirt: BlockId; podzol: BlockId; sand: BlockId; water: BlockId;
  sugarCane: BlockId; cactus: BlockId; bamboo: BlockId;
  kelp: BlockId; seagrass: BlockId; lilyPad: BlockId;
  duckweed: BlockId; seaAnemone: BlockId; redAlgae: BlockId;
  vine: BlockId; ivy: BlockId; glowLichen: BlockId; mossCarpet: BlockId; glowMoss: BlockId;
  glowFern: BlockId; moonflower: BlockId;
  wheatSeedling: BlockId; wheatGrowing: BlockId; wheat: BlockId;
  berryBush: BlockId; berryBushRipe: BlockId; pumpkinStem: BlockId; pumpkin: BlockId;
  oakSapling: BlockId; birchSapling: BlockId; spruceSapling: BlockId;
  acaciaSapling: BlockId; cherrySapling: BlockId;
  redMushroom: BlockId; brownMushroom: BlockId;
  tallGrass: BlockId; fern: BlockId; tallFern: BlockId;
}

const H = WORLD_HEIGHT;
const CS = CHUNK_SIZE;
const DIRS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/**
 * 植物生态引擎（随机刻）。
 *
 * 只对玩家附近的已生成区块采样：每次随机刻随机取若干「列 + 高度」，
 * 命中植物后按规则生长 / 蔓延 / 枯萎。单次代价与采样次数成正比，
 * 不随世界大小增长，也不会为全图植物建表。
 *
 * 规则一览：
 * - 生长：甘蔗 / 仙人掌 / 竹子 / 海带长高，小麦分阶段成熟，浆果成熟，树苗长成树；
 * - 蔓延：草方块 → 泥土、花草 → 邻近草地、蘑菇 → 阴暗地面、藤蔓垂挂、
 *   睡莲铺水面、海草成片、发光地衣 / 苔藓贴地扩散、南瓜藤结瓜；
 * - 枯萎：支撑方块被拆后植物自动脱落（连同上方整列）。
 */
export class Botany {
  private readonly rng: () => number;
  private readonly interval: number;
  /** 基础采样尝试数（档位 2「标准」），由构造参数决定 */
  private readonly baseAttempts: number;
  /** 当前采样尝试数，随实验性玩法「随机刻速度」档位变化（0 = 暂停） */
  private attempts: number;
  /** 对外只读：F3 / 调试面板按同一半径统计生态能量 */
  readonly sampleRadius: number;
  private acc = 0;
  private focusX = 0;
  private focusZ = 0;
  /** 最近一次随机刻的环境（季节 / 天气 / 天数），默认中性 */
  private env: PlantEnv = DEFAULT_PLANT_ENV;
  /** 能量日志上限：超出后淘汰最旧的四分之一，避免长距离探索无限增长 */
  private static readonly ENERGY_LIMIT = 4096;

  /** 名称 → id 缓存（本引擎只认内置植物，运行时方块不会进入随机刻） */
  private readonly id: BotanyIds;
  /** 方块 id → 植物特性（代谢类型 / 开花阈值 / 生长耗能 / 共享半径） */
  private readonly traits = new Map<BlockId, PlantTrait>();
  /** 内在能量表：坐标 → 状态。只跟踪被随机刻采样过的植物 */
  private readonly energy = new Map<string, PlantEnergyState>();
  /** 品系表：坐标 → STRAIN_ORDER 下标。杂交产生的后代带品系，破坏即消失 */
  private readonly strains = new Map<string, number>();
  /** 土壤养分表：支撑格坐标 → 0~100，懒初始化为 100 */
  private readonly soil: SoilMap = new Map();
  private readonly flowers = new Set<BlockId>();
  private readonly spreadable = new Set<BlockId>();
  private readonly mushrooms = new Set<BlockId>();
  private readonly saplings = new Map<BlockId, TreeSpecies>();
  private readonly aquatic = new Set<BlockId>();
  private readonly columns = new Set<BlockId>();
  /** 攀爬植物：藤蔓 / 常春藤，向下垂挂或沿墙横爬，共享整条储能 */
  private readonly climbers = new Set<BlockId>();
  /** 水面漂浮植物：睡莲 / 浮萍，在水面上铺开 */
  private readonly floaters = new Set<BlockId>();
  /** 洞穴发光植物：附着在任意实心面（石壁 / 地面）上，在暗处扩散 */
  private readonly luminous = new Set<BlockId>();
  private readonly meadow: { id: BlockId; weight: number }[] = [];
  private meadowTotal = 0;
  /** 插件生态规则表：内置规则未命中时才分派，停用插件可整体注销 */
  private readonly rules: PlantRuleRegistry;

  constructor(
    private readonly world: World,
    private readonly registry: BlockRegistry,
    seed: number,
    private readonly events?: EventService,
    options: BotanyOptions = {},
  ) {
    this.rng = mulberry32((seed ^ 0x5bd1e995) >>> 0);
    this.rules = new PlantRuleRegistry((name) => this.registry.byNameGet(name)?.id ?? 0);
    this.interval = options.interval ?? 0.3;
    this.baseAttempts = options.attempts ?? (options.isMobile ? 24 : 56);
    this.attempts = this.baseAttempts;
    this.sampleRadius = options.radius ?? 24;

    const byName = (name: string) => registry.byNameGet(name)?.id ?? 0;
    this.id = {
      grass: byName('grass'), dirt: byName('dirt'), podzol: byName('podzol'),
      sand: byName('sand'),
      water: byName('water'),
      sugarCane: byName('sugar_cane'), cactus: byName('cactus'), bamboo: byName('bamboo'),
      kelp: byName('kelp'), seagrass: byName('seagrass'), lilyPad: byName('lily_pad'),
      duckweed: byName('duckweed'), seaAnemone: byName('sea_anemone'),
      redAlgae: byName('red_algae'),
      vine: byName('vine'), ivy: byName('ivy'), glowLichen: byName('glow_lichen'),
      mossCarpet: byName('moss_carpet'), glowMoss: byName('glow_moss'),
      glowFern: byName('glow_fern'), moonflower: byName('moonflower'),
      wheatSeedling: byName('wheat_seedling'), wheatGrowing: byName('wheat_growing'),
      wheat: byName('wheat'),
      berryBush: byName('sweet_berry_bush'), berryBushRipe: byName('sweet_berry_bush_ripe'),
      pumpkinStem: byName('pumpkin_stem'), pumpkin: byName('pumpkin'),
      oakSapling: byName('oak_sapling'), birchSapling: byName('birch_sapling'),
      spruceSapling: byName('spruce_sapling'),
      acaciaSapling: byName('acacia_sapling'), cherrySapling: byName('cherry_sapling'),
      redMushroom: byName('red_mushroom'), brownMushroom: byName('brown_mushroom'),
      tallGrass: byName('tall_grass'), fern: byName('fern'), tallFern: byName('tall_fern'),
    };

    const flowerNames = [
      'poppy', 'dandelion', 'bluebell', 'allium', 'azure_bluet', 'oxeye_daisy',
      'cornflower', 'lily_of_the_valley', 'tulip_red', 'tulip_orange', 'tulip_white',
      'tulip_pink', 'sunflower', 'lilac', 'rose_bush', 'peony',
      // v1.6.0 花海扩充：温带 / 林下 / 雪线 / 沙岸花卉
      'lavender', 'buttercup', 'forget_me_not', 'marigold', 'foxglove', 'hollyhock',
      'violet', 'wood_anemone', 'wild_garlic', 'hyacinth', 'snowdrop', 'edelweiss',
      'snow_lily', 'crocus', 'gentian', 'desert_marigold', 'sea_thrift', 'ghost_flower',
    ];
    for (const name of flowerNames) {
      const id = byName(name);
      if (id) this.flowers.add(id);
    }
    for (const id of [this.id.tallGrass, this.id.fern, this.id.tallFern, byName('beach_grass')]) {
      if (id) this.spreadable.add(id);
    }
    // 花与草都能由草方块自然长出；雪线 / 沙漠 / 海岸花卉只走群系配置，不混入温带草甸
    const meadowFlowerNames = [
      'poppy', 'dandelion', 'bluebell', 'allium', 'azure_bluet', 'oxeye_daisy',
      'cornflower', 'lily_of_the_valley', 'tulip_red', 'tulip_orange', 'tulip_white',
      'tulip_pink', 'sunflower', 'lilac', 'rose_bush', 'peony',
      'lavender', 'buttercup', 'forget_me_not', 'marigold', 'foxglove', 'hollyhock',
      'violet', 'wood_anemone', 'wild_garlic', 'hyacinth',
    ];
    for (const name of meadowFlowerNames) {
      const id = byName(name);
      if (id) this.meadow.push({ id, weight: 0.7 });
    }
    for (const id of [this.id.tallGrass, this.id.fern, this.id.tallFern]) {
      if (id) this.meadow.push({ id, weight: 3 });
    }
    this.meadowTotal = this.meadow.reduce((sum, m) => sum + m.weight, 0);
    for (const id of [this.id.redMushroom, this.id.brownMushroom]) {
      if (id) this.mushrooms.add(id);
    }
    if (this.id.oakSapling) this.saplings.set(this.id.oakSapling, 'oak');
    if (this.id.birchSapling) this.saplings.set(this.id.birchSapling, 'birch');
    if (this.id.spruceSapling) this.saplings.set(this.id.spruceSapling, 'spruce');
    // 金合欢 / 樱花：树苗按树种名映射，长树时写回各自的原木与树叶
    if (this.id.acaciaSapling) this.saplings.set(this.id.acaciaSapling, 'acacia');
    if (this.id.cherrySapling) this.saplings.set(this.id.cherrySapling, 'cherry');
    for (const id of [this.id.kelp, this.id.seagrass, this.id.seaAnemone, this.id.redAlgae]) {
      if (id) this.aquatic.add(id);
    }
    // 攀爬 / 漂浮 / 洞穴发光植物按能力分派到对应规则
    for (const id of [this.id.vine, this.id.ivy]) if (id) this.climbers.add(id);
    for (const id of [this.id.lilyPad, this.id.duckweed, byName('lotus')]) if (id) this.floaters.add(id);
    for (const id of [this.id.glowLichen, this.id.glowMoss, this.id.glowFern, this.id.moonflower]) {
      if (id) this.luminous.add(id);
    }
    // 柱状能量锚点：甘蔗 / 竹子 / 仙人掌都按整列共享储能与顶部光照
    for (const id of [this.id.sugarCane, this.id.bamboo, this.id.cactus]) {
      if (id) this.columns.add(id);
    }

    // 植物特性表按注册名解析；运行时注册的方块不进入生态能量体系
    for (const def of registry.all()) {
      const trait = plantTrait(def.name);
      if (trait) this.traits.set(def.id, trait);
    }
    // 玩家拆掉 / 放回方块时清掉旧能量，避免新植物继承前一位住客的储能
    this.events?.on('block:break', ({ x, y, z, block }) => this.forgetAnchor(x, y, z, block));
    this.events?.on('block:place', ({ x, y, z, block }) => this.forgetAnchor(x, y, z, block));
  }

  /**
   * 实验性玩法「随机刻速度」：0=暂停 / 1=慢 / 2=标准 / 3=快。
   * 通过缩放每次随机刻的采样尝试数实现，档位 2 严格保持原有行为。
   */
  setTickSpeed(tier: 0 | 1 | 2 | 3): void {
    const scale = [0, 0.35, 1, 2.2][tier];
    this.attempts = Math.round(this.baseAttempts * scale);
  }

  /** 主循环入口：只在玩家附近推进随机刻 */
  update(
    dt: number, focusX: number, focusZ: number, daylight: number,
    env: PlantEnv = DEFAULT_PLANT_ENV,
  ): void {
    this.focusX = focusX;
    this.focusZ = focusZ;
    this.env = env;
    // 暂停档：清空累加器，恢复时不会因积压的时间瞬间爆发一批随机刻
    if (this.attempts <= 0) { this.acc = 0; return; }
    this.acc += Math.min(dt, 0.25);
    if (this.acc < this.interval) return;
    this.acc -= this.interval;
    for (let i = 0; i < this.attempts; i++) this.randomAttempt(focusX, focusZ, daylight);
  }

  /**
   * 在确切坐标执行一次随机刻（调试 / 回归测试用）。
   * 返回是否改变了世界。
   */
  tickAt(x: number, y: number, z: number, daylight = 1, env: PlantEnv = DEFAULT_PLANT_ENV): boolean {
    this.env = env;
    const id = this.world.getBlock(x, y, z);
    if (id === AIR) return false;
    return this.applyAt(x, y, z, id, daylight);
  }

  // ---------- 插件扩展点（v1.4.3） ----------

  /** 注册植物特性：让运行时注册的方块进入能量 / 开花 / 采集体系 */
  registerTrait(name: string, trait: PlantTrait): void {
    const id = this.registry.byNameGet(name)?.id;
    if (!id) throw new Error(`[botany] 未知植物: ${name}（请先注册方块）`);
    this.traits.set(id, trait);
  }

  /** 注销植物特性：插件停用时把该植物退回静态装饰 */
  unregisterTrait(name: string): void {
    const id = this.registry.byNameGet(name)?.id;
    if (id) this.traits.delete(id);
  }

  registerRule(rule: PlantRule): void { this.rules.register(rule); }

  /** 按插件 id 批量注销规则，返回注销条数 */
  unregisterRules(owner: string): number { return this.rules.unregister(owner); }

  listRules(): ReturnType<PlantRuleRegistry['list']> { return this.rules.list(); }

  // ---------- 内在能量 API ----------

  /** 读取单株植物的当前能量；非植物 / 未跟踪返回 0 */
  energyAt(x: number, y: number, z: number): number {
    const id = this.world.getBlock(x, y, z);
    if (!this.traits.has(id)) return 0;
    return this.stateAt(x, y, z, id).energy;
  }

  /** 坐标处品系 id；无品系返回 undefined */
  strainAt(x: number, y: number, z: number): StrainId | undefined {
    const index = this.strains.get(blockKey(x, y, z));
    if (index === undefined) return undefined;
    return strainAt(index);
  }

  /** 写入品系（杂交 tick 内部使用）；品系名未知时静默忽略 */
  private setStrain(x: number, y: number, z: number, strain: StrainId): void {
    const index = strainIndexOf(strain);
    if (index >= 0) this.strains.set(blockKey(x, y, z), index);
  }

  /**
   * 坐标处的有效特性：基础特性叠加品系覆盖。
   * 生长 / 采集 / 开花都经此查询，品系数值差异因此对整条能量链生效。
   */
  private traitAt(x: number, y: number, z: number, id: BlockId): PlantTrait | undefined {
    const base = this.traits.get(id);
    if (!base) return undefined;
    const strainId = this.strainAt(x, y, z);
    if (!strainId) return base;
    return applyStrain(base, STRAINS[strainId]);
  }

  /** 调试 / 测试钩子：直接写入能量（0~100） */
  setEnergy(x: number, y: number, z: number, energy: number): void {
    const id = this.world.getBlock(x, y, z);
    if (!this.traits.has(id)) return;
    this.stateAt(x, y, z, id).energy = clamp(energy, 0, MAX_PLANT_ENERGY);
  }

  /** 读取土壤养分（支撑格 y-1）；未跟踪返回 100 */
  nutrientAt(x: number, y: number, z: number): number {
    return soilNutrientAt(this.soil, x, y, z);
  }

  /** 调试 / 测试钩子：直接写入土壤养分 */
  setNutrient(x: number, y: number, z: number, value: number): void {
    this.soil.set(blockKey(x, y, z), clamp(value, 0, MAX_SOIL_NUTRIENT));
  }

  /** 自然归还养分：季节 / 天气的 soil 倍率在此生效（雨天回肥更快、冬季更慢） */
  private returnNutrient(x: number, y: number, z: number, amount: number): void {
    const scaled = Math.max(1, Math.round(amount * modifiers(this.env).soil));
    returnToSoil(this.soil, x, y - 1, z, scaled);
  }

  /** 施肥：给支撑格土壤补充养分，并发出 plant:soil 事件 */
  enrichSoil(x: number, y: number, z: number, delta: number): void {
    enrichNutrient(this.soil, x, y, z, delta);
    evictSoil(this.soil);
    this.events?.emit('plant:soil', { x, y, z, delta });
  }

  // ---------- 生态状态存档 ----------

  /** 序列化当前仍在原位的植物能量与土壤养分 */
  serializeEcology(): PlantSaveV2 {
    const plants: PlantSaveV1['plants'] = [];
    for (const st of this.energy.values()) {
      if (plants.length >= ECOLOGY_SAVE_LIMIT) break;
      if (this.world.getBlock(st.x, st.y, st.z) !== st.id) continue;
      if (!this.traits.has(st.id)) continue;
      plants.push([
        st.x, st.y, st.z, st.id, Math.round(st.energy), st.bloomed ? 1 : 0,
      ]);
    }
    const soil: PlantSaveV1['soil'] = [];
    for (const [key, value] of this.soil) {
      if (soil.length >= ECOLOGY_SAVE_LIMIT) break;
      const parts = key.split(',');
      if (parts.length !== 3) continue;
      const [x, y, z] = parts.map(Number);
      if (![x, y, z].every(Number.isInteger)) continue;
      // 只输出 validateSave 认可的坐标：对着 y=0 施肥会产生 y=-1 的土壤 key，
      // 不在这里过滤就会让自产存档被自己的校验器判为坏档。
      if (y < 0 || y >= H) continue;
      soil.push([x, y, z, Math.round(value)]);
    }
    const strains: PlantSaveV2['strains'] = [];
    for (const [key, index] of this.strains) {
      if (strains.length >= ECOLOGY_SAVE_LIMIT) break;
      const parts = key.split(',');
      if (parts.length !== 3) continue;
      const [x, y, z] = parts.map(Number);
      if (![x, y, z].every(Number.isInteger) || y < 1 || y >= H) continue;
      // 方块已被替换（采掉 / 枯死 / 长成别种）后品系不再有意义
      if (!this.traits.has(this.world.getBlock(x, y, z))) continue;
      strains.push([x, y, z, index]);
    }
    return { v: 2, plants, soil, strains };
  }

  /**
   * 恢复生态状态；返回成功恢复的植物条数。
   * 任何损坏条目一律丢弃不抛错，坏档不会阻断启动。
   */
  restoreEcology(data: unknown): number {
    if (!data || typeof data !== 'object') return 0;
    const d = data as Partial<Omit<PlantSaveV1, 'v'>> & {
      v?: number;
      strains?: unknown;
    };
    // v1 = 无品系；v2 追加 strains（品系表）。两者共用 plants / soil 形状。
    if ((d.v !== 1 && d.v !== 2) || !Array.isArray(d.plants) || !Array.isArray(d.soil)) return 0;

    // 同锚点去重：保留最后一条；按输入顺序逐个校验
    const seenPlants = new Map<string, PlantSaveV1['plants'][number]>();
    for (const entry of d.plants) {
      if (!Array.isArray(entry) || entry.length !== 6) continue;
      const [x, y, z, id, energy, bloomed] = entry;
      if (![x, y, z, id].every(Number.isInteger)) continue;
      if (y < 1 || y >= H || id <= 0 || id > 255) continue;
      if (!Number.isFinite(energy) || energy < 0 || energy > MAX_PLANT_ENERGY) continue;
      if (bloomed !== 0 && bloomed !== 1) continue;
      if (this.world.getBlock(x, y, z) !== id) continue;
      if (!this.traits.has(id)) continue;
      seenPlants.set(blockKey(x, y, z), [x, y, z, id, energy, bloomed]);
    }
    let restored = 0;
    for (const [key, entry] of seenPlants) {
      if (restored >= ECOLOGY_SAVE_LIMIT) break;
      const [x, y, z, id, energy, bloomed] = entry;
      this.energy.set(key, { x, y, z, id, energy, bloomed: bloomed === 1 });
      restored++;
    }

    const seenSoil = new Map<string, number>();
    for (const entry of d.soil) {
      if (!Array.isArray(entry) || entry.length !== 4) continue;
      const [x, y, z, value] = entry;
      if (![x, y, z].every(Number.isInteger)) continue;
      if (!Number.isFinite(value) || value < 0 || value > MAX_SOIL_NUTRIENT) continue;
      seenSoil.set(blockKey(x, y, z), value);
    }
    let soilRestored = 0;
    for (const [key, value] of seenSoil) {
      if (soilRestored >= ECOLOGY_SAVE_LIMIT) break;
      this.soil.set(key, value);
      soilRestored++;
    }

    // 品系表（v2）：校验下标范围 + 方块仍是品系挂载的植物，坏条目静默丢弃
    this.strains.clear();
    let strainRestored = 0;
    if (d.v === 2 && Array.isArray(d.strains)) {
      for (const entry of d.strains) {
        if (strainRestored >= ECOLOGY_SAVE_LIMIT) break;
        if (!Array.isArray(entry) || entry.length !== 4) continue;
        const [x, y, z, index] = entry;
        if (![x, y, z, index].every(Number.isInteger)) continue;
        if (y < 1 || y >= H) continue;
        if (index < 0 || index >= STRAIN_ORDER.length) continue;
        if (!this.traits.has(this.world.getBlock(x, y, z))) continue;
        this.strains.set(blockKey(x, y, z), index);
        strainRestored++;
      }
    }
    return restored;
  }

  /** 生态能量统计（F3 / 调试面板）：只统计当前仍在原位的植物 */
  stats(
    focusX = this.focusX, focusZ = this.focusZ, radius = this.sampleRadius,
  ): BotanyStats {
    let tracked = 0, charged = 0, total = 0, solar = 0, hydro = 0, fungal = 0;
    let soilTotal = 0, soilCount = 0;
    for (const [key, value] of this.soil) {
      const [sx, , sz] = key.split(',').map(Number);
      if (Math.abs(sx - focusX) > radius || Math.abs(sz - focusZ) > radius) continue;
      soilTotal += value;
      soilCount++;
    }
    for (const st of this.energy.values()) {
      if (Math.abs(st.x - focusX) > radius || Math.abs(st.z - focusZ) > radius) continue;
      if (this.world.getBlock(st.x, st.y, st.z) !== st.id) continue;
      const trait = this.traits.get(st.id);
      if (!trait) continue;
      tracked++;
      total += st.energy;
      if (st.energy >= trait.bloom) charged++;
      if (trait.metabolism === 'solar') solar++;
      else if (trait.metabolism === 'hydro') hydro++;
      else fungal++;
    }
    return {
      tracked, charged,
      avgEnergy: tracked ? Math.round((total / tracked) * 10) / 10 : 0,
      soilAvg: soilCount ? Math.round((soilTotal / soilCount) * 10) / 10 : 100,
      solar, hydro, fungal,
    };
  }

  /**
   * 采集蓄能植物：能量达到开花阈值才产出。
   * - use：右键采集，浆果丛会退回未成熟状态；
   * - break：破坏时结算，方块即将被移除。
   */
  harvest(x: number, y: number, z: number, mode: 'use' | 'break' = 'use'): PlantBonus | null {
    const id = this.world.getBlock(x, y, z);
    // 品系覆盖后的有效特性：产出数量 / 附加产出按品系生效
    const trait = this.traitAt(x, y, z, id);
    if (!trait?.harvest) return null;
    const st = this.stateAt(x, y, z, id);
    if (st.energy < trait.bloom) return null;
    st.energy = Math.max(NIGHT_ENERGY_FLOOR, st.energy - HARVEST_ENERGY_COST);
    if (mode === 'use' && id === this.id.berryBushRipe) {
      this.set(x, y, z, this.id.berryBush, 'harvest');
    }
    // 破坏结算把一半生长养分归还土壤（季节 / 雨天 modifier 生效）
    const nutrient = trait.growthNutrient ?? Math.ceil(trait.growthCost / 3);
    this.returnNutrient(x, y, z, Math.floor(nutrient / 2));
    st.bloomed = false;
    this.events?.emit('plant:bloom', { x, y, z, block: id, energy: Math.round(st.energy) });
    return { ...trait.harvest };
  }

  // ---------- 能量模型 ----------

  /** 柱状植物以底格为能量锚点；藤蔓以顶端为锚点，整条共享一份储能 */
  private anchorOf(x: number, y: number, z: number, id: BlockId): [number, number, number] {
    if (this.columns.has(id) || this.aquatic.has(id)) {
      let ay = y;
      while (ay - 1 >= 1 && this.world.getBlock(x, ay - 1, z) === id) ay--;
      return [x, ay, z];
    }
    if (this.climbers.has(id)) {
      let ay = y;
      while (ay + 1 < H && this.world.getBlock(x, ay + 1, z) === id) ay++;
      return [x, ay, z];
    }
    return [x, y, z];
  }

  private stateAt(x: number, y: number, z: number, id: BlockId): PlantEnergyState {
    const [ax, ay, az] = this.anchorOf(x, y, z, id);
    const key = blockKey(ax, ay, az);
    let state = this.energy.get(key);
    if (!state || state.id !== id) {
      state = { x: ax, y: ay, z: az, id, energy: START_PLANT_ENERGY, bloomed: false };
      this.remember(key, state);
    }
    return state;
  }

  /**
   * 清除某次方块改动对应的储能。
   * 柱状 / 藤蔓植物的能量锚点不在被拆格本身（在底格 / 顶格），
   * 因此除精确 key 外还要清掉同 x,z 且同 id 的所有锚点记录。
   */
  private forgetAnchor(x: number, y: number, z: number, id: BlockId): void {
    this.energy.delete(blockKey(x, y, z));
    this.strains.delete(blockKey(x, y, z));
    for (const [key, state] of this.energy) {
      if (state.x === x && state.z === z && state.id === id) this.energy.delete(key);
    }
  }

  private remember(key: string, state: PlantEnergyState): void {
    if (!this.energy.has(key) && this.energy.size >= Botany.ENERGY_LIMIT) {
      let drop = this.energy.size >> 2;
      if (drop < 1) drop = 1;
      for (const k of this.energy.keys()) {
        this.energy.delete(k);
        if (--drop <= 0) break;
      }
    }
    this.energy.set(key, state);
  }

  /**
   * 每次随机刻先为植物充 / 放能，再执行生长规则。
   * 返回 false 表示植物因环境不适而枯萎（已从世界移除）。
   */
  private charge(x: number, y: number, z: number, id: BlockId, daylight: number): boolean {
    const trait = this.traits.get(id);
    if (!trait) return true;
    const st = this.stateAt(x, y, z, id);
    const { delta, hostile } = this.energyDelta(trait, st, daylight);
    const prev = st.energy;
    let next = clamp(prev + delta, 0, MAX_PLANT_ENERGY);
    // 夜间呼吸只把「不低于下限」的能量压到 20，不会把已耗尽的能量凭空补回
    if (!hostile && delta < 0 && prev >= NIGHT_ENERGY_FLOOR) {
      next = Math.max(NIGHT_ENERGY_FLOOR, next);
    }
    st.energy = next;

    if (hostile && next <= 0) {
      this.energy.delete(blockKey(st.x, st.y, st.z));
      this.decay(st.x, st.y, st.z, id);
      return false;
    }
    if (next < trait.bloom * 0.5) st.bloomed = false;
    if (!st.bloomed && prev < trait.bloom && next >= trait.bloom) this.emitBloom(st);
    // 蓄能中的植物会周期性闪一下，让玩家不用 F3 也能看出「这株可以采」
    if (next >= trait.bloom && this.rng() < 0.02) {
      const dx = st.x - this.focusX;
      const dz = st.z - this.focusZ;
      if (dx * dx + dz * dz <= 32 * 32) {
        this.events?.emit('plant:bloom', {
          x: st.x, y: st.y, z: st.z, block: st.id, energy: Math.round(st.energy),
        });
      }
    }
    if (next >= 80) this.shareEnergy(st, trait);
    return true;
  }

  private energyDelta(
    trait: PlantTrait, st: PlantEnergyState, daylight: number,
  ): { delta: number; hostile: boolean } {
    // 仙人掌等不透光植物自身格的光照恒为 0；柱状植物还要越过整列看顶部光照，
    // 否则长高后底格会被自己的植株遮成「黑暗」而误判饿死。
    let lightY = st.y;
    if (this.columns.has(st.id) || this.aquatic.has(st.id)) {
      while (lightY + 1 < H && this.world.getBlock(st.x, lightY + 1, st.z) === st.id) lightY++;
    }
    const sky = Math.max(
      this.world.getSkyLight(st.x, st.y, st.z),
      this.world.getSkyLight(st.x, lightY + 1, st.z),
    );
    const block = Math.max(
      this.world.getBlockLight(st.x, st.y, st.z),
      this.world.getBlockLight(st.x, lightY + 1, st.z),
    );
    const day = clamp(0.3 + 0.7 * clamp(daylight, 0, 1), 0, 1);
    const mod = modifiers(this.env);
    // 季节 / 天气只放大正向蓄能；hostile 枯死与夜间呼吸不被削弱
    const boosted = (delta: number, kind: 'solar' | 'hydro' | 'fungal') =>
      delta > 0 ? Math.round(delta * mod[kind]) : delta;

    if (trait.metabolism === 'hydro') {
      const self = this.registry.get(this.world.getBlock(st.x, st.y, st.z));
      const at = (dx: number, dy: number, dz: number) =>
        this.registry.get(this.world.getBlock(st.x + dx, st.y + dy, st.z + dz));
      // 水生植物会替换水格，因此除四邻水体之外，还要承认上下相连的水草列
      const wet = at(0, -1, 0).liquid || at(0, 1, 0).liquid ||
        at(1, 0, 0).liquid || at(-1, 0, 0).liquid ||
        at(0, 0, 1).liquid || at(0, 0, -1).liquid ||
        (self.waterPlant === true &&
          (at(0, -1, 0).waterPlant === true || at(0, 1, 0).waterPlant === true));
      return wet
        ? { delta: boosted(11, 'hydro'), hostile: false }
        : { delta: -14, hostile: true };
    }

    if (trait.metabolism === 'fungal') {
      // 火光会灼伤菌类（这是玩家可以主动利用 / 需要规避的特性）
      if (block >= 13) return { delta: -14, hostile: true };
      const light = Math.max(sky * day, block);
      if (light < 8) return { delta: boosted(10, 'fungal'), hostile: false };
      return { delta: -4, hostile: false };
    }

    const light = Math.max(sky * day, block);
    // 完全黑暗的洞穴：太阳能植物会饿死
    if (sky < 4 && block < 4) return { delta: -14, hostile: true };
    if (light < 6) return { delta: -2, hostile: false };
    const soil = this.isSoil(this.world.getBlock(st.x, st.y - 1, st.z)) ? 2 : 0;
    return {
      delta: boosted(5 + Math.min(9, Math.round(light * 0.6)) + soil, 'solar'),
      hostile: false,
    };
  }

  private emitBloom(st: PlantEnergyState): void {
    st.bloomed = true;
    this.events?.emit('plant:bloom', {
      x: st.x, y: st.y, z: st.z, block: st.id, energy: Math.round(st.energy),
    });
  }

  /** 根系网络：蓄满的植物把富余能量送给同代谢类型的邻近植物 */
  private shareEnergy(source: PlantEnergyState, trait: PlantTrait): void {
    if (source.energy < 80 || trait.shareRadius <= 0 || this.rng() > 0.25) return;
    const r = trait.shareRadius;
    for (let i = 0; i < 6; i++) {
      const nx = source.x + ((this.rng() * (r * 2 + 1)) | 0) - r;
      const ny = source.y + ((this.rng() * 3) | 0) - 1;
      const nz = source.z + ((this.rng() * (r * 2 + 1)) | 0) - r;
      if (ny < 1 || ny >= H) continue;
      if (nx === source.x && ny === source.y && nz === source.z) continue;
      const nid = this.world.getBlock(nx, ny, nz);
      const ntrait = this.traits.get(nid);
      if (!ntrait || ntrait.metabolism !== trait.metabolism) continue;
      const [ax, ay, az] = this.anchorOf(nx, ny, nz, nid);
      if (ax === source.x && ay === source.y && az === source.z) continue;
      const key = blockKey(ax, ay, az);
      let target = this.energy.get(key);
      if (!target || target.id !== nid) {
        target = { x: ax, y: ay, z: az, id: nid, energy: START_PLANT_ENERGY, bloomed: false };
        this.remember(key, target);
      }
      const power = Math.min(trait.sharePower, source.energy - 60, MAX_PLANT_ENERGY - target.energy);
      if (power <= 0) continue;
      const prev = target.energy;
      source.energy -= power;
      target.energy += power;
      if (!target.bloomed && prev < ntrait.bloom && target.energy >= ntrait.bloom) {
        this.emitBloom(target);
      }
      return;
    }
  }

  private canGrow(x: number, y: number, z: number, id: BlockId): boolean {
    const trait = this.traits.get(id);
    if (!trait) return true;
    return this.stateAt(x, y, z, id).energy >= trait.growthCost;
  }

  /** 带能量消耗的写入：能量不足或写入失败都不扣能量 */
  private grow(
    tx: number, ty: number, tz: number, id: BlockId, kind: GrowKind,
    sx = tx, sy = ty, sz = tz, costId = id,
  ): boolean {
    const trait = this.traitAt(sx, sy, sz, costId);
    // 必须在写入前取能量状态：生长阶段替换方块后 id 会变化
    const state = trait ? this.stateAt(sx, sy, sz, costId) : null;
    if (trait && (!state || state.energy < trait.growthCost)) return false;
    const nutrientCost = trait
      ? (trait.growthNutrient ?? Math.ceil(trait.growthCost / 3)) : 0;
    if (nutrientCost > 0 && this.nutrientAt(sx, sy - 1, sz) < nutrientCost) return false;
    if (!this.set(tx, ty, tz, id, kind)) return false;
    if (trait && state) {
      state.energy = Math.max(0, state.energy - trait.growthCost);
      // 原地升级（麦苗 → 抽穗 → 小麦、青果 → 成熟）保留剩余能量
      if (costId !== id && sx === tx && sy === ty && sz === tz) state.id = id;
    }
    if (nutrientCost > 0) {
      consumeNutrient(this.soil, sx, sy - 1, sz, nutrientCost);
      evictSoil(this.soil);
    }
    return true;
  }

  // ---------- 采样 ----------

  private randomAttempt(focusX: number, focusZ: number, daylight: number): void {
    const r = this.rng;
    const angle = r() * Math.PI * 2;
    const dist = Math.sqrt(r()) * this.sampleRadius;
    const x = Math.floor(focusX + Math.cos(angle) * dist);
    const z = Math.floor(focusZ + Math.sin(angle) * dist);
    const chunk = this.world.getChunk(Math.floor(x / CS), Math.floor(z / CS));
    if (!chunk || !chunk.generated) return;

    const surface = this.world.surfaceHeight(x, z);
    // 大部分样本贴地表（花草 / 草方块 / 树苗），少量深入地下（蘑菇 / 地衣）
    const y = r() < 0.72
      ? surface - 1 + ((r() * 4) | 0)
      : 1 + ((r() * Math.max(1, Math.min(surface + 8, H - 1))) | 0);
    if (y < 1 || y >= H - 1) return;
    const id = this.world.getBlock(x, y, z);
    if (id === AIR) return;
    this.applyAt(x, y, z, id, daylight);
  }

  // ---------- 调度 ----------

  private applyAt(x: number, y: number, z: number, id: BlockId, daylight: number): boolean {
    // 先充 / 放能：能量不足的植物本轮不会生长；环境长期不适会直接枯死
    if (this.traits.has(id) && !this.charge(x, y, z, id, daylight)) return true;

    if (id === this.id.grass) return this.tickGrass(x, y, z, daylight);
    if (id === this.id.dirt) return this.tickDirt(x, y, z);
    if (id === this.id.cactus) {
      if (!this.supported(id, x, y, z)) return this.decay(x, y, z, id);
      return this.tickCactus(x, y, z);
    }
    if (this.floaters.has(id)) {
      if (!this.supported(id, x, y, z)) return this.decay(x, y, z, id);
      return this.tickLily(x, y, z, id);
    }
    if (this.climbers.has(id)) {
      if (!this.supported(id, x, y, z)) return this.decay(x, y, z, id);
      return this.tickVine(x, y, z, id);
    }
    if (this.luminous.has(id)) {
      if (!this.supported(id, x, y, z)) return this.decay(x, y, z, id);
      return this.tickLichen(x, y, z, daylight, id);
    }
    if (id === this.id.mossCarpet) {
      if (!this.supported(id, x, y, z)) return this.decay(x, y, z, id);
      return this.tickMoss(x, y, z, daylight);
    }
    if (this.aquatic.has(id)) {
      if (!this.supported(id, x, y, z)) return this.decay(x, y, z, id);
      return this.tickAquatic(x, y, z, id);
    }
    if (this.columns.has(id)) {
      if (!this.supported(id, x, y, z)) return this.decay(x, y, z, id);
      return this.tickColumn(x, y, z, id);
    }
    if (this.saplings.has(id)) {
      if (!this.supported(id, x, y, z)) return this.decay(x, y, z, id);
      return this.tickSapling(x, y, z, id, this.saplings.get(id)!, daylight);
    }
    if (id === this.id.wheatSeedling || id === this.id.wheatGrowing) {
      if (!this.supported(id, x, y, z)) return this.decay(x, y, z, id);
      return this.tickWheat(x, y, z, id, daylight) || this.tickCrossbreed(x, y, z);
    }
    if (id === this.id.berryBush || id === this.id.berryBushRipe) {
      if (!this.supported(id, x, y, z)) return this.decay(x, y, z, id);
      return this.tickBerry(x, y, z, id, daylight) || this.tickCrossbreed(x, y, z);
    }
    if (id === this.id.pumpkinStem) {
      if (!this.supported(id, x, y, z)) return this.decay(x, y, z, id);
      return this.tickPumpkinStem(x, y, z, daylight);
    }

    const def = this.registry.get(id);
    if (def.shape !== 'cross') return false;
    if (!this.supported(id, x, y, z)) return this.decay(x, y, z, id);
    if (this.mushrooms.has(id)) return this.tickMushroom(x, y, z, id, daylight);
    if (this.flowers.has(id) || this.spreadable.has(id)) return this.tickSpread(x, y, z, id, daylight);
    // 内置规则全部未命中才分派插件规则，保证既有生态行为一字不改
    const rules = this.rules.ruleFor(id);
    if (rules.length) {
      const ctx = this.ruleContext(x, y, z, id, daylight);
      let changed = false;
      // 全部执行而非短路：同一株植物可同时受多条规则约束
      for (const rule of rules) changed = rule.tick(ctx) || changed;
      return changed;
    }
    // 其余 cross 形植物（含葡萄藤）走杂交判定：组合表未命中时零开销返回
    return this.tickCrossbreed(x, y, z);
  }

  // ---------- 规则：支撑与枯萎 ----------

  private supported(id: BlockId, x: number, y: number, z: number): boolean {
    const below = this.world.getBlock(x, y - 1, z);
    if (this.climbers.has(id) || this.luminous.has(id)) {
      // 藤蔓 / 常春藤可挂在实心方块或同类上；发光植物可贴任意石壁
      if (below === id || this.world.getBlock(x, y + 1, z) === id || this.registry.isSolid(below)) return true;
      for (const [dx, dy, dz] of DIRS) {
        const n = this.world.getBlock(x + dx, y + dy, z + dz);
        if (n !== AIR && this.registry.isSolid(n)) return true;
      }
      return false;
    }
    if (this.floaters.has(id)) {
      return this.registry.isSolid(below) || this.registry.get(below).liquid;
    }
    if (this.aquatic.has(id)) {
      return this.registry.isSolid(below) || this.aquatic.has(below);
    }
    if (this.columns.has(id)) {
      return this.registry.isSolid(below) || below === id;
    }
    return this.registry.isSolid(below);
  }

  private decay(x: number, y: number, z: number, id: BlockId): boolean {
    let changed = false;
    const trait = this.traits.get(id);
    const nutrient = trait ? (trait.growthNutrient ?? Math.ceil(trait.growthCost / 3)) : 0;
    // 整列枯萎：甘蔗 / 竹子 / 仙人掌 / 海带被拆掉底格后不应留下一段悬空
    for (let yy = y; yy < H; yy++) {
      if (this.world.getBlock(x, yy, z) !== id) break;
      this.energy.delete(blockKey(x, yy, z));
      if (this.world.setBlock(x, yy, z, AIR)) {
        this.events?.emit('plant:grow', { x, y: yy, z, block: id, kind: 'decay' });
        changed = true;
      }
    }
    if (changed && nutrient > 0) {
      this.returnNutrient(x, y, z, Math.floor(nutrient / 2));
    }
    return changed;
  }

  // ---------- 规则：草方块与草地 ----------

  private tickGrass(x: number, y: number, z: number, daylight: number): boolean {
    const above = this.world.getBlock(x, y + 1, z);
    // 被实心方块压住的草方块退化为泥土
    if (this.registry.isOpaque(above)) return this.set(x, y, z, this.id.dirt, 'decay');
    const sky = this.world.getSkyLight(x, y + 1, z);
    if (daylight < 0.12 || sky < 6) return false;

    // 向邻近裸露泥土蔓延
    if (above === AIR && this.rng() < scaledChance(0.14, this.env)) {
      const [nx, nz] = this.pickNeighbor(x, z);
      if (this.world.getBlock(nx, y, nz) === this.id.dirt &&
        this.world.getBlock(nx, y + 1, nz) === AIR &&
        this.world.getSkyLight(nx, y + 1, nz) >= 6) {
        return this.set(nx, y, nz, this.id.grass, 'spread');
      }
    }

    // 草方块上自然长出花草
    if (above === AIR && sky >= 9 && this.rng() < scaledChance(0.1, this.env) && this.meadowTotal > 0) {
      let r = this.rng() * this.meadowTotal;
      for (const m of this.meadow) {
        r -= m.weight;
        if (r > 0) continue;
        return this.set(x, y + 1, z, m.id, 'spread');
      }
    }
    return false;
  }

  private tickDirt(x: number, y: number, z: number): boolean {
    if (this.world.getBlock(x, y + 1, z) !== AIR) return false;
    if (this.world.getSkyLight(x, y + 1, z) < 6) return false;
    if (this.rng() > scaledChance(0.2, this.env)) return false;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (this.world.getBlock(x + dx, y, z + dz) === this.id.grass) {
        return this.set(x, y, z, this.id.grass, 'spread');
      }
    }
    return false;
  }

  // ---------- 规则：花草蔓延 ----------

  private tickSpread(x: number, y: number, z: number, id: BlockId, daylight: number): boolean {
    if (this.lightAt(x, y, z, daylight) < 9) return false;
    if (this.rng() > scaledChance(0.09, this.env)) return false;
    // 海滩 / 沙漠花卉允许在沙面蔓延；树苗 / 蘑菇仍只认土壤
    const spot = this.findGroundSpot(x, y, z, 2, true, true);
    return spot ? this.grow(spot[0], spot[1], spot[2], id, 'spread', x, y, z) : false;
  }

  private tickMushroom(x: number, y: number, z: number, id: BlockId, daylight: number): boolean {
    // 与能量模型保持一致：白天露天下不再蔓延，夜晚 / 阴影 / 洞穴中可以
    const sky = this.world.getSkyLight(x, y, z);
    const block = this.world.getBlockLight(x, y, z);
    const light = Math.max(sky * (0.3 + 0.7 * clamp(daylight, 0, 1)), block);
    if (light >= 8 || block >= 13) return false;
    if (this.rng() > scaledChance(0.12, this.env)) return false;
    const spot = this.findGroundSpot(x, y, z, 2, false);
    return spot ? this.grow(spot[0], spot[1], spot[2], id, 'spread', x, y, z) : false;
  }

  // ---------- 规则：柱状植物生长 ----------

  private tickColumn(x: number, y: number, z: number, id: BlockId): boolean {
    const max = id === this.id.bamboo ? 8 : 3;
    let top = y;
    let base = y;
    while (top + 1 < H && this.world.getBlock(x, top + 1, z) === id) top++;
    while (base - 1 >= 1 && this.world.getBlock(x, base - 1, z) === id) base--;
    if (top - base + 1 >= max) {
      // 竹子长满后横向扩繁
      if (id !== this.id.bamboo || this.rng() > scaledChance(0.06, this.env)) return false;
      // 以竹柱底部为基准向四周找地面；base/top 都是 Y 坐标，不能当 x/y 传入。
      const spot = this.findGroundSpot(x, base, z, 2, true);
      return spot ? this.grow(spot[0], spot[1], spot[2], id, 'spread', x, base, z) : false;
    }
    if (this.world.getBlock(x, top + 1, z) !== AIR) return false;
    if (this.rng() > scaledChance(id === this.id.bamboo ? 0.42 : 0.3, this.env)) return false;
    return this.grow(x, top + 1, z, id, 'grow', x, base, z);
  }

  private tickCactus(x: number, y: number, z: number): boolean {
    let top = y;
    let base = y;
    while (top + 1 < H && this.world.getBlock(x, top + 1, z) === this.id.cactus) top++;
    while (base - 1 >= 1 && this.world.getBlock(x, base - 1, z) === this.id.cactus) base--;
    if (top - base + 1 >= 3) return false;
    if (this.world.getBlock(x, top + 1, z) !== AIR) return false;
    if (this.rng() > scaledChance(0.22, this.env)) return false;
    return this.grow(x, top + 1, z, this.id.cactus, 'grow', x, base, z);
  }

  private tickAquatic(x: number, y: number, z: number, id: BlockId): boolean {
    if (id === this.id.kelp) {
      let top = y;
      let base = y;
      while (top + 1 < H && this.world.getBlock(x, top + 1, z) === id) top++;
      while (base - 1 >= 1 && this.world.getBlock(x, base - 1, z) === id) base--;
      if (top - base + 1 >= 10) return false;
      const above = this.world.getBlock(x, top + 1, z);
      if (above !== this.id.water) return false;
      if (this.rng() > scaledChance(0.3, this.env)) return false;
      return this.grow(x, top + 1, z, id, 'grow', x, base, z);
    }
    // 海草在海床上成片蔓延
    if (this.rng() > scaledChance(0.14, this.env)) return false;
    const [dx, dz] = this.pickNeighbor(x, z);
    if (this.world.getBlock(dx, y, dz) !== this.id.water) return false;
    if (!this.registry.isSolid(this.world.getBlock(dx, y - 1, dz))) return false;
    return this.grow(dx, y, dz, id, 'spread', x, y, z);
  }

  private tickLily(x: number, y: number, z: number, id: BlockId): boolean {
    if (this.rng() > scaledChance(0.1, this.env)) return false;
    const [nx, nz] = this.pickNeighbor(x, z);
    if (this.world.getBlock(nx, y, nz) !== AIR) return false;
    const below = this.world.getBlock(nx, y - 1, nz);
    if (below !== this.id.water) return false;
    return this.grow(nx, y, nz, id, 'spread', x, y, z);
  }

  private tickVine(x: number, y: number, z: number, id: BlockId): boolean {
    if (this.rng() > scaledChance(0.3, this.env)) return false;
    // 优先向下垂挂（y 减小），其次沿墙面横爬
    if (this.rng() < 0.6) {
      if (y - 1 >= 1 && this.world.getBlock(x, y - 1, z) === AIR) {
        return this.grow(x, y - 1, z, id, 'grow', x, y, z);
      }
      return false;
    }
    const [nx, nz] = this.pickNeighbor(x, z);
    if (this.world.getBlock(nx, y, nz) !== AIR) return false;
    return this.grow(nx, y, nz, id, 'spread', x, y, z);
  }

  private tickLichen(x: number, y: number, z: number, daylight: number, id: BlockId): boolean {
    const light = Math.max(
      this.world.getSkyLight(x, y, z) * (0.3 + 0.7 * clamp(daylight, 0, 1)),
      this.world.getBlockLight(x, y, z),
    );
    if (light >= 8 || this.world.getBlockLight(x, y, z) >= 13) return false;
    if (this.rng() > scaledChance(0.18, this.env)) return false;
    for (let i = 0; i < 6; i++) {
      const nx = x + ((this.rng() * 5) | 0) - 2;
      const ny = y + ((this.rng() * 3) | 0) - 1;
      const nz = z + ((this.rng() * 5) | 0) - 2;
      if (ny < 1 || ny >= H - 1) continue;
      if (this.world.getBlock(nx, ny, nz) !== AIR) continue;
      if (!this.hasSolidNeighbor(nx, ny, nz)) continue;
      return this.grow(nx, ny, nz, id, 'spread', x, y, z);
    }
    return false;
  }

  private tickMoss(x: number, y: number, z: number, daylight: number): boolean {
    const light = Math.max(
      this.world.getSkyLight(x, y, z) * (0.3 + 0.7 * clamp(daylight, 0, 1)),
      this.world.getBlockLight(x, y, z),
    );
    if (light >= 9 || this.world.getBlockLight(x, y, z) >= 13) return false;
    if (this.rng() > scaledChance(0.14, this.env)) return false;
    const spot = this.findGroundSpot(x, y, z, 2, false);
    return spot ? this.grow(spot[0], spot[1], spot[2], this.id.mossCarpet, 'spread', x, y, z) : false;
  }

  // ---------- 规则：作物 / 浆果 / 南瓜 ----------

  private tickWheat(x: number, y: number, z: number, id: BlockId, daylight: number): boolean {
    // 莓穗等耐阴品系把生长光照门槛从 9 降到 6
    const strainId = this.strainAt(x, y, z);
    const minLight = strainId && STRAINS[strainId].shadeTolerant ? 6 : 9;
    if (this.lightAt(x, y, z, daylight) < minLight) return false;
    if (this.rng() > scaledChance(0.22, this.env)) return false;
    const next = id === this.id.wheatSeedling ? this.id.wheatGrowing : this.id.wheat;
    return next ? this.grow(x, y, z, next, 'grow', x, y, z, id) : false;
  }

  private tickBerry(x: number, y: number, z: number, id: BlockId, daylight: number): boolean {
    if (id === this.id.berryBush) {
      if (this.lightAt(x, y, z, daylight) < 8 || this.rng() > scaledChance(0.18, this.env)) return false;
      return this.grow(x, y, z, this.id.berryBushRipe, 'ripen', x, y, z, id);
    }
    if (this.rng() > scaledChance(0.06, this.env)) return false;
    const spot = this.findGroundSpot(x, y, z, 2, true);
    return spot ? this.grow(spot[0], spot[1], spot[2], this.id.berryBush, 'spread', x, y, z, id) : false;
  }

  private tickPumpkinStem(x: number, y: number, z: number, daylight: number): boolean {
    if (this.lightAt(x, y, z, daylight) < 8 || this.rng() > scaledChance(0.12, this.env)) return false;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const nz = z + dz;
      if (this.world.getBlock(nx, y, nz) !== AIR) continue;
      if (!this.registry.isSolid(this.world.getBlock(nx, y - 1, nz))) continue;
      return this.grow(nx, y, nz, this.id.pumpkin, 'grow', x, y, z, this.id.pumpkinStem);
    }
    return false;
  }

  // ---------- 规则：树苗长成树 ----------

  private tickSapling(
    x: number, y: number, z: number, id: BlockId, species: TreeSpecies, daylight: number,
  ): boolean {
    if (this.lightAt(x, y, z, daylight) < 9) return false;
    if (this.rng() > scaledChance(0.08, this.env)) return false;
    if (!this.canGrow(x, y, z, id)) return false;
    const below = this.world.getBlock(x, y - 1, z);
    if (!this.isSoil(below)) return false;

    const shape = buildTree(species, this.rng);
    let maxDy = 0;
    for (const b of shape) if (b.dy > maxDy) maxDy = b.dy;
    if (y + maxDy >= H) return false;
    // 净空检查：只要会覆盖非空气（树苗自身除外）就放弃，避免长进玩家建筑
    for (const b of shape) {
      const id = this.world.getBlock(x + b.dx, y + b.dy, z + b.dz);
      if (id !== AIR && !(b.dx === 0 && b.dz === 0 && b.dy === 0)) return false;
    }

    this.world.setBlock(x, y, z, AIR);
    // 树苗的能量已转化为整棵树，不再保留单株储能
    this.energy.delete(blockKey(x, y, z));
    let changed = false;
    for (const b of shape) {
      const tx = x + b.dx;
      const ty = y + b.dy;
      const tz = z + b.dz;
      if (ty < 1 || ty >= H) continue;
      if (b.kind === 'log') {
        if (this.world.setBlock(tx, ty, tz, this.logOf(species))) changed = true;
      } else if (this.world.getBlock(tx, ty, tz) === AIR) {
        if (this.world.setBlock(tx, ty, tz, this.leafOf(species))) changed = true;
      }
    }
    if (changed) this.events?.emit('plant:grow', { x, y, z, block: this.logOf(species), kind: 'grow' });
    return changed;
  }

  private logOf(species: TreeSpecies): BlockId {
    const name = species === 'birch' ? 'birch_log'
      : species === 'spruce' ? 'spruce_log'
        : species === 'acacia' ? 'acacia_log'
          : species === 'cherry' ? 'cherry_log' : 'oak_log';
    return this.registry.byNameGet(name)?.id ?? 0;
  }

  private leafOf(species: TreeSpecies): BlockId {
    const name = species === 'birch' ? 'birch_leaves'
      : species === 'spruce' ? 'spruce_leaves'
        : species === 'acacia' ? 'acacia_leaves'
          : species === 'cherry' ? 'cherry_leaves' : 'oak_leaves';
    return this.registry.byNameGet(name)?.id ?? 0;
  }

  // ---------- 工具 ----------

  /** 有效光照：天空光按昼夜缩放，与方块光取大（火把也能支撑室内种植） */
  private lightAt(x: number, y: number, z: number, daylight: number): number {
    return Math.max(
      this.world.getSkyLight(x, y, z) * (0.3 + 0.7 * clamp(daylight, 0, 1)),
      this.world.getBlockLight(x, y, z),
    );
  }

  private isSoil(id: BlockId): boolean {
    return id === this.id.grass || id === this.id.dirt || id === this.id.podzol;
  }

  private pickNeighbor(x: number, z: number): [number, number] {
    switch ((this.rng() * 4) | 0) {
      case 0: return [x + 1, z];
      case 1: return [x - 1, z];
      case 2: return [x, z + 1];
      default: return [x, z - 1];
    }
  }

  private hasSolidNeighbor(x: number, y: number, z: number): boolean {
    for (const [dx, dy, dz] of DIRS) {
      const n = this.world.getBlock(x + dx, y + dy, z + dz);
      if (n !== AIR && this.registry.isSolid(n)) return true;
    }
    return false;
  }

  private findGroundSpot(
    x: number, y: number, z: number, radius: number, needLight: boolean, allowSand = false,
  ): [number, number, number] | null {
    for (let i = 0; i < 8; i++) {
      const nx = x + ((this.rng() * (radius * 2 + 1)) | 0) - radius;
      const ny = y + ((this.rng() * 3) | 0) - 1;
      const nz = z + ((this.rng() * (radius * 2 + 1)) | 0) - radius;
      if (ny < 1 || ny >= H - 1) continue;
      if (nx === x && ny === y && nz === z) continue;
      if (this.world.getBlock(nx, ny, nz) !== AIR) continue;
      const below = this.world.getBlock(nx, ny - 1, nz);
      if (!this.isSoil(below) && !(allowSand && below === this.id.sand)) continue;
      if (needLight &&
        this.world.getSkyLight(nx, ny, nz) < 9 &&
        this.world.getBlockLight(nx, ny, nz) < 9) continue;
      return [nx, ny, nz];
    }
    return null;
  }

  /** 构造插件规则的受限上下文：不泄漏 World 实例，写入统一走 plant:grow 事件 */
  /** 杂交亲本只认成熟植株：方块注册名 → 组合表物种名，非成熟 / 无关植物返回 undefined */
  private crossbreedSpeciesOf(id: BlockId): string | undefined {
    if (id === this.id.wheat) return 'wheat';
    if (id === this.id.berryBushRipe) return 'sweet_berry_bush';
    const name = this.registry.get(id)?.name;
    return name === 'grape_vine' ? 'grape_vine' : undefined;
  }

  /**
   * 自然杂交（minecraft-web-replica-botany）：成熟植株旁存在组合表匹配的
   * 另一株成熟植物、满足土壤 / 天气条件且附近有空位时，小概率在空位长出
   * 带品系的后代植株。所有随机走 this.rng，保证确定性。
   */
  private tickCrossbreed(x: number, y: number, z: number): boolean {
    const selfSpecies = this.crossbreedSpeciesOf(this.world.getBlock(x, y, z));
    if (!selfSpecies) return false;
    // 水平四邻里找组合匹配的另一株成熟植物（只看与自身同高的四方向）
    const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dz] of dirs) {
      const mx = x + dx;
      const mz = z + dz;
      const mateSpecies = this.crossbreedSpeciesOf(this.world.getBlock(mx, y, mz));
      if (!mateSpecies) continue;
      const combo = findCombo(selfSpecies, mateSpecies);
      if (!combo) continue;
      if (combo.soilMin !== undefined) {
        // 两位亲本脚下的土壤养分都要达标
        if (Math.min(this.nutrientAt(x, y - 1, z), this.nutrientAt(mx, y - 1, mz)) < combo.soilMin) {
          continue;
        }
      }
      if (combo.rain && this.env.weather !== 'rain') continue;
      if (this.rng() > combo.chance) continue;

      // 在自身旁边的空位种下带品系的后代（有实心支撑、消耗亲本能量）
      const offspring = this.registry.byNameGet(STRAINS[combo.offspring].species)?.id ?? 0;
      if (!offspring) return false;
      for (const [sx, sz] of dirs) {
        if (this.world.getBlock(x + sx, y, z + sz) !== 0) continue;
        if (!this.isSoil(this.world.getBlock(x + sx, y - 1, z + sz))) continue;
        if (this.grow(x + sx, y, z + sz, offspring, 'spread', x, y, z)) {
          this.setStrain(x + sx, y, z + sz, combo.offspring);
          return true;
        }
      }
      return false;
    }
    return false;
  }

  private ruleContext(x: number, y: number, z: number, id: BlockId, daylight: number): PlantRuleContext {
    return {
      x, y, z, id, daylight,
      rng: () => this.rng(),
      energy: (ax, ay, az) => this.energyAt(ax, ay, az),
      boost: (bx, by, bz, delta) => {
        const bid = this.world.getBlock(bx, by, bz);
        if (!this.traits.has(bid)) return;
        const st = this.stateAt(bx, by, bz, bid);
        st.energy = clamp(st.energy + delta, 0, MAX_PLANT_ENERGY);
      },
      canGrow: (gx, gy, gz, gid) => this.canGrow(gx, gy, gz, gid),
      supported: (sx, sy, sz, sid) => this.supported(sid, sx, sy, sz),
      // 生长消耗源植物（当前 tick 的这株）的能量
      grow: (gx, gy, gz, gid, kind) => this.grow(gx, gy, gz, gid, kind, x, y, z, id),
      // 写 AIR 走整列枯萎（this.set 会拒绝 id=0，避免静默失败）
      write: (wx, wy, wz, wid, kind) => wid === AIR
        ? this.decay(wx, wy, wz, this.world.getBlock(wx, wy, wz))
        : this.set(wx, wy, wz, wid, kind),
      get: (gx, gy, gz) => this.world.getBlock(gx, gy, gz),
      isSolid: (gx, gy, gz) => this.registry.isSolid(this.world.getBlock(gx, gy, gz)),
      biome: (bx, bz) => String(this.world.generator.biomeAt?.(bx, bz) ?? 'unknown'),
      surface: (sx, sz) => this.world.surfaceHeight(sx, sz),
      neighbors: (nx, ny, nz) => DIRS.map(
        ([dx, dy, dz]) => [nx + dx, ny + dy, nz + dz] as [number, number, number],
      ),
      day: () => this.env.day,
      season: () => this.env.season,
      weather: () => this.env.weather,
      soil: (qx, qy, qz) => this.nutrientAt(qx, qy, qz),
      enrichSoil: (qx, qy, qz, delta) => this.enrichSoil(qx, qy, qz, delta),
    };
  }

  private set(x: number, y: number, z: number, id: BlockId, kind: GrowKind): boolean {
    if (!id) return false;
    if (!this.world.setBlock(x, y, z, id)) return false;
    this.events?.emit('plant:grow', { x, y, z, block: id, kind });
    return true;
  }
}
