/**
 * 植物特性表（v1.4.1 植物能量体系）。
 *
 * 每种植物不再只是「长出来 / 不掉东西」的装饰：
 * - metabolism 决定能量来源：solar 靠光、hydro 靠水、fungal 靠阴暗；
 * - bloom 是「蓄能开花」阈值，达到后可采集额外产物；
 * - growthCost 是每次生长 / 蔓延消耗的能量，能量不足时规则不会执行；
 * - shareRadius / sharePower 构成根系能量网络，蓄满的植物会把富余能量输送给同类。
 *
 * 纯数据 + 纯函数，不依赖 World / DOM，便于测试与后续扩展新植物。
 */
export type PlantMetabolism = 'solar' | 'hydro' | 'fungal';

export interface PlantHarvest {
  /** 物品名，形如 item:nectar */
  item: string;
  count: number;
}

export interface PlantTrait {
  metabolism: PlantMetabolism;
  /** 蓄能开花阈值（0~100） */
  bloom: number;
  /** 每次生长 / 蔓延消耗的能量 */
  growthCost: number;
  /** 根系共享半径（0 不共享） */
  shareRadius: number;
  /** 单次共享的能量 */
  sharePower: number;
  /** 每次生长 / 蔓延消耗的土壤养分；缺省按 ceil(growthCost/3) 推导 */
  growthNutrient?: number;
  /** 能量枢纽：共享范围更大，是花园的「中心」 */
  hub?: boolean;
  /** 蓄能后右键 / 破坏时额外掉落的物品 */
  harvest?: PlantHarvest;
}

export const MAX_PLANT_ENERGY = 100;
/** 新植物 / 未跟踪植物的初始储能 */
export const START_PLANT_ENERGY = 32;
/** 夜间呼吸的能量下限：不会因为天黑而枯死 */
export const NIGHT_ENERGY_FLOOR = 20;
/** 采集一次消耗的能量 */
export const HARVEST_ENERGY_COST = 45;

const flower: PlantTrait = {
  metabolism: 'solar', bloom: 80, growthCost: 18, shareRadius: 2, sharePower: 12,
  harvest: { item: 'item:nectar', count: 1 },
};

const grass: PlantTrait = { metabolism: 'solar', bloom: 55, growthCost: 12, shareRadius: 1, sharePower: 8 };
const crop: PlantTrait = { metabolism: 'solar', bloom: 80, growthCost: 20, shareRadius: 2, sharePower: 10 };
const sapling: PlantTrait = { metabolism: 'solar', bloom: 90, growthCost: 90, shareRadius: 2, sharePower: 12 };

/** 各植物特性；未列出的方块（空气 / 泥土 / 火把等）不参与能量循环 */
export const PLANT_TRAITS: Readonly<Record<string, PlantTrait>> = {
  // 花卉：蓄能开花后可采集花蜜
  poppy: flower,
  dandelion: flower,
  bluebell: flower,
  allium: flower,
  azure_bluet: flower,
  oxeye_daisy: flower,
  cornflower: flower,
  lily_of_the_valley: flower,
  tulip_red: flower,
  tulip_orange: flower,
  tulip_white: flower,
  tulip_pink: flower,
  lilac: flower,
  rose_bush: flower,
  peony: flower,
  // 向日葵是能量枢纽：共享半径 4、单次 24，给整片花园供能
  sunflower: {
    ...flower, bloom: 90, shareRadius: 4, sharePower: 24, hub: true,
    harvest: { item: 'item:nectar', count: 2 },
  },
  // 草类：低阈值、低消耗，负责把能量网络铺开
  tall_grass: grass,
  fern: grass,
  tall_fern: grass,
  // 作物与灌木
  wheat_seedling: crop,
  wheat_growing: crop,
  wheat: { ...crop, harvest: { item: 'item:wheat_seeds', count: 2 } },
  sweet_berry_bush: { ...crop, bloom: 75, growthCost: 26 },
  sweet_berry_bush_ripe: {
    ...crop, bloom: 75, growthCost: 26,
    harvest: { item: 'item:sweet_berries', count: 2 },
  },
  pumpkin_stem: { metabolism: 'solar', bloom: 75, growthCost: 20, shareRadius: 2, sharePower: 10 },
  // 柱状 / 攀附植物
  sugar_cane: { metabolism: 'solar', bloom: 70, growthCost: 20, shareRadius: 2, sharePower: 10 },
  bamboo: { metabolism: 'solar', bloom: 70, growthCost: 16, shareRadius: 2, sharePower: 12 },
  cactus: { metabolism: 'solar', bloom: 60, growthCost: 14, shareRadius: 1, sharePower: 8 },
  vine: { metabolism: 'solar', bloom: 60, growthCost: 12, shareRadius: 2, sharePower: 10 },
  oak_sapling: sapling,
  birch_sapling: sapling,
  spruce_sapling: sapling,
  // 水生植物：靠水而不是阳光，夜间也能蓄能
  lily_pad: { metabolism: 'hydro', bloom: 70, growthCost: 16, shareRadius: 2, sharePower: 12 },
  seagrass: { metabolism: 'hydro', bloom: 60, growthCost: 12, shareRadius: 2, sharePower: 10 },
  kelp: { metabolism: 'hydro', bloom: 70, growthCost: 18, shareRadius: 2, sharePower: 12 },
  // 真菌：靠阴暗蓄能，暴露在强光下会枯萎
  red_mushroom: { metabolism: 'fungal', bloom: 60, growthCost: 14, shareRadius: 2, sharePower: 12 },
  brown_mushroom: { metabolism: 'fungal', bloom: 60, growthCost: 14, shareRadius: 2, sharePower: 12 },
  // 发光地衣是菌类网络枢纽：光照越暗，供能越强
  glow_lichen: {
    metabolism: 'fungal', bloom: 70, growthCost: 16, shareRadius: 3, sharePower: 16, hub: true,
  },
  moss_carpet: { metabolism: 'fungal', bloom: 50, growthCost: 10, shareRadius: 2, sharePower: 8 },
};

export function plantTrait(name: string): PlantTrait | undefined {
  return PLANT_TRAITS[name];
}
