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

/** 新物品的食物值：beef 7 / rabbit_meat 5 / egg 3；煤炭 / 皮革 / 羽毛不可食 */
export const NEW_ITEMS: Record<string, { food?: number }> = {
  coal: {},
  leather: {},
  beef: { food: 7 },
  feather: {},
  egg: { food: 3 },
  rabbit_meat: { food: 5 },
  // ---- 矿物→材料→熔炼闭环（原版忠实向）----
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
  // 熟肉比生肉高 2 点饥饿（原版：生猪排 6→熟猪排 8，生牛肉 7→熟牛肉 8）
  cooked_porkchop: { food: 8 },
  cooked_beef: { food: 8 },
  // ---- 生物 / 弓箭内容更新：全部不可食，统一走材料闭环 ----
  gunpowder: {},
  string: {},
  ink_sac: {},
  flint: {},
  bow: {},
  arrow: {},
};

/**
 * 新增生物属性 / 掉落（内容更新：更多生物）。
 * 键是 EntityType id；被动动物进入 ANIMALS 的加权生成表，敌对生物走夜间生成。
 * 掉落名一律 item: 前缀，与既有物品同键可堆叠。
 */
export const NEW_MOBS = {
  creeper: {
    width: 0.6, height: 1.7, speed: 1.0, health: 12, damage: 0, attackRange: 1.9,
    explodeRadius: 2.6, weight: 3, burnInDay: false,
    drops: [{ name: 'item:gunpowder', min: 1, max: 2 }],
  },
  spider: {
    width: 1.1, height: 0.9, speed: 1.55, health: 12, damage: 3, attackRange: 1.8,
    weight: 3, burnInDay: true,
    drops: [{ name: 'item:string', min: 1, max: 2 }],
  },
  squid: {
    width: 0.8, height: 0.8, speed: 0.55, health: 6, weight: 2,
    aquatic: true,
    drops: [{ name: 'item:ink_sac', min: 1, max: 2 }],
  },
} as const;

/** 远程战斗数值（弓箭）：速度与伤害在单一来源，便于平衡调整 */
export const RANGED = {
  arrowSpeed: 28,
  arrowGravity: 12,
  arrowDamage: 5,
  arrowLifetime: 6,
  bowCooldown: 0.72,
  bowExhaust: 0.06,
} as const;
