/**
 * 内容体系数值中心（C01）。
 *
 * 既有数值原样搬入（种群 / 交互距离），新数值全部来自内容体系设计文档 §6.1：
 * 以后放松上限、调食物 / 掉落 / 繁殖参数只改这一处，各调用方零改动。
 * 纯数据模块：不依赖 three / DOM，可编译进快照测试。
 */

/** 既有种群上限原样搬入 */
export const POPULATION = { targetDay: 6, targetNight: 9, hostileCap: 4, cap: 24 } as const;

export const BREED = {
  loveDuration: 30,      // 秒：求爱状态有效窗口
  cooldown: 120,         // 秒：双亲冷却
  growTime: 120,         // 秒：幼崽长成
  babyScale: 0.55,
  mateRadius: 8,
  feedReach: 4.2,        // 复用 player.ts 的 ENTITY_REACH
} as const;

export const DROPS = {
  pickupRadius: 1.2,
  pickupDelay: 0.4,
  mergeRadius: 0.8,
  stackLimit: 999,
  lifetime: 300,         // 秒，仅 playing 计时
  scale: 0.28,
  spin: 1.5,             // rad/s
  bobAmp: 0.08,
  bobSpeed: 3,
  waterSink: 0.6,        // 入水终端下沉速度（格/秒）
  scatter: 0.35,         // 生成时水平散开半径
  popSpeed: 2.2,
} as const;

/** 键是 EntityType id，值是材料标识（方块名 / item:xxx），与 inventoryKeyToMaterial 同口径 */
export const BREED_FOODS: Record<string, string[]> = {
  pig: ['wheat', 'item:apple', 'item:sweet_berries'],
  sheep: ['item:wheat_seeds', 'tall_grass', 'fern', 'dandelion'],
  cow: ['wheat', 'tall_grass', 'fern', 'dandelion', 'item:apple'],
  chicken: ['item:wheat_seeds', 'item:sweet_berries', 'seagrass'],
  rabbit: [
    'dandelion', 'poppy', 'tulip_red', 'tulip_orange', 'tulip_white',
    'tulip_pink', 'cornflower', 'bluebell', 'allium', 'azure_bluet',
    'oxeye_daisy', 'lily_of_the_valley', 'sunflower', 'lilac',
    'rose_bush', 'peony', 'dead_bush',
  ],
};

/**
 * 新动物的属性与掉落（新物品一律 item: 前缀，保证与既有物品同键可堆叠）。
 * 猪 / 羊的既有数值由 C02 从 entity.ts 原样补入，这里先只放三种新动物。
 */
export const ANIMALS = {
  cow: {
    width: 0.9, height: 1.4, speed: 0.9, health: 10, weight: 3,
    drops: [
      { name: 'item:leather', min: 1, max: 2 },
      { name: 'item:beef', min: 1, max: 2 },
    ],
  },
  chicken: {
    width: 0.5, height: 0.7, speed: 1.1, health: 4, weight: 2,
    drops: [
      { name: 'item:feather', min: 1, max: 2 },
      { name: 'item:egg' },
    ],
  },
  rabbit: {
    width: 0.6, height: 0.6, speed: 1.4, health: 3, weight: 2,
    drops: [{ name: 'item:rabbit_meat' }],
  },
  // 猪 / 羊既有数值与掉落原样补入（C02），用于被动动物加权生成表；实体注册仍沿用 entity.ts 原定义
  pig: {
    width: 0.9, height: 0.95, speed: 1.15, health: 8, weight: 3,
    drops: [
      { name: 'item:porkchop' }, { name: 'item:fertilizer', chance: 0.12 },
      { name: 'item:leather', chance: 0.5 },
    ],
  },
  sheep: {
    width: 0.9, height: 1.15, speed: 1.0, health: 8, weight: 3,
    drops: [
      { name: 'white_wool' }, { name: 'item:fertilizer', chance: 0.12 },
      { name: 'item:leather', chance: 0.3 },
    ],
  },
};

/**
 * 可食物品的饥饿 / 饱和度数值中心（PR2 完整饱和度）。
 *
 * saturation 采用近似系数 food * 0.6（保留 1 位小数），并非原版精确值，
 * 目的是让「饱和度缓冲」在数值上可预测、便于后续只改这一处调参。
 * 不可食物品（煤炭 / 皮革 / 羽毛 / 玫瑰果等）不列入本表。
 */
export const FOOD_VALUES: Record<string, { food: number; saturation: number }> = {
  apple: { food: 4, saturation: 2.4 },
  porkchop: { food: 6, saturation: 3.6 },
  sweet_berries: { food: 2, saturation: 1.2 },
  nectar: { food: 3, saturation: 1.8 },
  rice: { food: 5, saturation: 3.0 },
  grapes: { food: 2, saturation: 1.2 },
  chili: { food: 3, saturation: 1.8 },
  beef: { food: 7, saturation: 4.2 },
  egg: { food: 3, saturation: 1.8 },
  rabbit_meat: { food: 5, saturation: 3.0 },
  // 熟食：采用远端「矿物→材料→熔炼」口径（熟牛 / 熟猪排 8，熟兔肉 7）
  cooked_beef: { food: 8, saturation: 4.8 },
  cooked_porkchop: { food: 8, saturation: 4.8 },
  cooked_rabbit: { food: 7, saturation: 4.2 },
  garlic: { food: 2, saturation: 1.2 },
  garlic_rice: { food: 8, saturation: 4.8 },
  rose_tea: { food: 6, saturation: 3.6 },
};

/**
 * 新物品的食物值：beef 7 / rabbit_meat 5 / egg 3；煤炭 / 皮革 / 羽毛不可食。
 * 数值从 FOOD_VALUES 派生，避免同一物品两处维护。
 */
export const NEW_ITEMS: Record<string, { food?: number }> = {
  coal: {},
  leather: {},
  beef: { food: FOOD_VALUES.beef.food },
  feather: {},
  egg: { food: FOOD_VALUES.egg.food },
  rabbit_meat: { food: FOOD_VALUES.rabbit_meat.food },
  // ---- 矿物→材料→熔炼闭环（远端新增，与烧炼配方对应）----
  // 原矿由对应矿石方块掉落，需入熔炉烧炼成锭；锭 / 矿物材料均不可食
  raw_iron: {},
  raw_gold: {},
  raw_copper: {},
  iron_ingot: {},
  gold_ingot: {},
  copper_ingot: {},
  diamond: {},
  lapis: {},
  redstone: {},
  emerald: {},
  charcoal: {},
  // 熟肉数值从 FOOD_VALUES 派生，避免与食物数值中心双源
  cooked_porkchop: { food: FOOD_VALUES.cooked_porkchop.food },
  cooked_beef: { food: FOOD_VALUES.cooked_beef.food },
  cooked_rabbit: { food: FOOD_VALUES.cooked_rabbit.food },
};

/**
 * 可燃表（PR3 火焰蔓延）：方块名 → 每次蔓延 tick 的引燃概率（0~1）。
 * 只收录 blocks.ts 真实存在的方块名，分三档（对齐设计契约 §4.1）：
 * - 慢 0.10：原木 / 木板 / 工作台 / 书架
 * - 中 0.30：树叶 / 各色羊毛 / 棉花块
 * - 快 0.50：草方块 / 干草方块 / 仙人掌 / 全部十字面植物
 * 非固体（空气 / 水）、石材、金属矿石等不燃；火焰本身不是可燃方块。
 */
export const FLAMMABLE: Record<string, number> = {
  // 慢：原木 / 木板 / 木类建材
  oak_log: 0.1, birch_log: 0.1, spruce_log: 0.1, acacia_log: 0.1, cherry_log: 0.1,
  oak_planks: 0.1, birch_planks: 0.1, spruce_planks: 0.1,
  crafting_table: 0.1, bookshelf: 0.1,
  // 中：树叶 / 羊毛 / 棉
  oak_leaves: 0.3, birch_leaves: 0.3, spruce_leaves: 0.3,
  acacia_leaves: 0.3, cherry_leaves: 0.3,
  white_wool: 0.3, red_wool: 0.3, blue_wool: 0.3, yellow_wool: 0.3,
  orange_wool: 0.3, green_wool: 0.3, purple_wool: 0.3, black_wool: 0.3,
  cotton_block: 0.3,
  // 快：草 / 干草 / 仙人掌
  grass: 0.5, dry_grass: 0.5, cactus: 0.5,
  // 快：十字面植物（花卉 / 蕨 / 藤 / 作物 / 树苗 / 菌类 / 水生植物）
  tall_grass: 0.5, poppy: 0.5, dandelion: 0.5,
  red_mushroom: 0.5, brown_mushroom: 0.5, dead_bush: 0.5,
  sugar_cane: 0.5, fern: 0.5, bamboo: 0.5,
  bluebell: 0.5, allium: 0.5, azure_bluet: 0.5, oxeye_daisy: 0.5,
  cornflower: 0.5, lily_of_the_valley: 0.5,
  tulip_red: 0.5, tulip_orange: 0.5, tulip_white: 0.5, tulip_pink: 0.5,
  sunflower: 0.5, lilac: 0.5, rose_bush: 0.5, peony: 0.5, tall_fern: 0.5,
  vine: 0.5, lily_pad: 0.5, glow_lichen: 0.5, moss_carpet: 0.5,
  wheat_seedling: 0.5, wheat_growing: 0.5, wheat: 0.5,
  sweet_berry_bush: 0.5, sweet_berry_bush_ripe: 0.5, pumpkin_stem: 0.5,
  oak_sapling: 0.5, birch_sapling: 0.5, spruce_sapling: 0.5,
  lavender: 0.5, buttercup: 0.5, forget_me_not: 0.5, marigold: 0.5,
  foxglove: 0.5, hollyhock: 0.5, violet: 0.5,
  wood_anemone: 0.5, wild_garlic: 0.5, hyacinth: 0.5, ivy: 0.5, glow_moss: 0.5,
  lingonberry_bush: 0.5, snowdrop: 0.5, edelweiss: 0.5, snow_lily: 0.5,
  crocus: 0.5, gentian: 0.5, yucca: 0.5, desert_marigold: 0.5, ghost_flower: 0.5,
  beach_grass: 0.5, sea_thrift: 0.5, duckweed: 0.5,
  sea_anemone: 0.5, red_algae: 0.5, moonflower: 0.5, glow_fern: 0.5,
  cotton_bush: 0.5, rice_plant: 0.5, grape_vine: 0.5, chili_bush: 0.5,
  lotus: 0.5, orchid: 0.5, sage: 0.5, pitcher_plant: 0.5, glow_cordyceps: 0.5,
  seagrass: 0.5, kelp: 0.5,
};

/**
 * 火焰系统数值中心（PR3）：
 * - lifetime：火焰寿命（秒），实际按 rng ±30% 波动；
 * - spreadScale：蔓延概率全局系数（平衡 / 基准用）；
 * - scanRadius：玩家周围扫描半径（格，水平）；
 * - scanTick：扫描 / 蔓延 / 寿命节拍（秒）；
 * - maxPerTick：每拍最多处理的火源数，避免单帧卡顿；
 * - damageInterval：玩家 / 实体灼烧伤害间隔（秒）；
 * - damage：每次灼烧伤害；
 * - particleBudget：每拍粒子预算（火星 + 烟雾合计），超限跳过，避免火势大时粒子爆炸；
 * - sparkChance / smokeChance：每拍每个热源发射火星 / 烟雾的概率。
 */
export const FIRE = {
  lifetime: 18,
  spreadScale: 1,
  scanRadius: 12,
  scanTick: 0.25,
  maxPerTick: 48,
  damageInterval: 0.5,
  damage: 1,
  particleBudget: 24,
  sparkChance: 0.3,
  smokeChance: 0.5,
} as const;

/**
 * 温暖系统数值中心（PR5 轻量温暖）：
 * - radius：热源扫描切比雪夫半径（格）；
 * - rise / fall：每秒向目标值靠近的比例系数（指数逼近）；
 * - regenThreshold：温暖值达到该值时回血饥饿门槛降低；
 * - regenHunger：温暖时的回血饥饿门槛；
 * - coldHunger：常温（未达阈值）时的回血饥饿门槛；
 * - exhaustionScale：温暖达标时饥饿消耗（exhaustion）的缩放系数（< 1 表示消耗降低）。
 *
 * 只做「靠近热源更暖」的轻量增益，不含体温 / 冻伤 / 寒冷伤害 / 天气联动。
 */
export const WARMTH = {
  radius: 6,
  rise: 0.5,
  fall: 0.25,
  regenThreshold: 50,
  regenHunger: 14,
  coldHunger: 18,
  exhaustionScale: 0.8,
} as const;
