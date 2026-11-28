/**
 * 植物品系与杂交组合表（minecraft-web-replica-botany 扩展）。
 *
 * 品系是挂在既有植物方块上的「数据层」：同种植物共享方块渲染与注册名，
 * 品系差异只体现在数值覆盖（生长耗能、开花阈值、采收产出、耐性），
 * 由 Botany 在特性查询时叠加（applyStrain），不新增方块 / 物品注册。
 *
 * 杂交组合表驱动自然育种：成熟植株旁存在组合表匹配的另一成熟植株、
 * 满足条件（土壤养分 / 雨天）且附近有空位时，小概率长出带品系的后代。
 * 所有随机性由 Botany 的确定性 rng 提供，本模块只做纯查表。
 *
 * 纯数据 + 纯函数，不依赖 World / DOM / three.js，可被
 * scripts/build-test-snapshot.mjs 编译进 CommonJS 快照。
 */
import type { PlantHarvest, PlantTrait } from './plantTraits';

/** 品系全局唯一 id；存档按 STRAIN_ORDER 的下标持久化，顺序只能末尾追加 */
export type StrainId = 'luxuriant_wheat' | 'berry_wheat' | 'vine_berry' | 'frost_grape' | 'golden_wheat';

/** 品系定义：trait 覆盖叠加在物种基础特性之上 */
export interface StrainDef {
  id: StrainId;
  label: string;
  /** 后代植株的方块注册名（品系挂在哪个物种上） */
  species: string;
  /** 覆盖基础 PlantTrait 的字段（浅合并） */
  trait?: Partial<PlantTrait>;
  /** 耐阴：生长光照门槛 9→6（小麦系） */
  shadeTolerant?: boolean;
}

/** 存档持久化顺序：只能末尾追加，禁止中间插入（与 BIOME_IDS 同纪律） */
export const STRAIN_ORDER: readonly StrainId[] = [
  'luxuriant_wheat',
  'berry_wheat',
  'vine_berry',
  'frost_grape',
  'golden_wheat',
];

export const STRAINS: Readonly<Record<StrainId, StrainDef>> = {
  // 大穗小麦：慢熟高产（养分 ≥80 的麦田里选育）
  luxuriant_wheat: {
    id: 'luxuriant_wheat',
    label: '大穗小麦',
    species: 'wheat',
    trait: { growthCost: 26, harvest: { item: 'item:wheat_seeds', count: 4 } },
  },
  // 莓穗：麦 × 浆果的耐阴后代，收获带一串甜浆果
  berry_wheat: {
    id: 'berry_wheat',
    label: '莓穗',
    species: 'wheat',
    shadeTolerant: true,
    trait: {
      harvest: { item: 'item:wheat_seeds', count: 2, extra: { item: 'item:sweet_berries', count: 1 } },
    },
  },
  // 藤莓：浆果 × 葡萄，早熟高产物种挂浆果丛
  vine_berry: {
    id: 'vine_berry',
    label: '藤莓',
    species: 'sweet_berry_bush',
    trait: { bloom: 68, harvest: { item: 'item:sweet_berries', count: 3 } },
  },
  // 霜酿葡萄：雨天蓄能加成由杂交 tick 内置处理（见 Botany.tickCrossbreed）
  frost_grape: {
    id: 'frost_grape',
    label: '霜酿葡萄',
    species: 'grape_vine',
    trait: { growthCost: 20 },
  },
  // 金穗小麦：低概率隐藏组合，早熟且蓄能后产花蜜
  golden_wheat: {
    id: 'golden_wheat',
    label: '金穗小麦',
    species: 'wheat',
    trait: { bloom: 70, harvest: { item: 'item:wheat_seeds', count: 2, extra: { item: 'item:nectar', count: 1 } } },
  },
};

/** 杂交组合：parents 无序（两种成熟植株相邻即可） */
export interface CrossbreedCombo {
  parents: [string, string];
  /** 要求两株脚下土壤养分都 ≥ soilMin（缺省不要求） */
  soilMin?: number;
  /** 要求当前是雨天 */
  rain?: boolean;
  /** 每次随机刻命中杂交尝试的概率 */
  chance: number;
  offspring: StrainId;
}

export const CROSSBREED_COMBOS: readonly CrossbreedCombo[] = [
  { parents: ['wheat', 'wheat'], soilMin: 80, chance: 0.5, offspring: 'luxuriant_wheat' },
  { parents: ['wheat', 'sweet_berry_bush'], chance: 0.35, offspring: 'berry_wheat' },
  { parents: ['sweet_berry_bush', 'grape_vine'], chance: 0.35, offspring: 'vine_berry' },
  { parents: ['grape_vine', 'grape_vine'], rain: true, chance: 0.5, offspring: 'frost_grape' },
  { parents: ['wheat', 'grape_vine'], chance: 0.08, offspring: 'golden_wheat' },
];

/** 物种名 → 品系后代的查表：parents 无序匹配，同种需两株同物种 */
export function findCombo(speciesA: string, speciesB: string): CrossbreedCombo | undefined {
  return CROSSBREED_COMBOS.find(
    (c) =>
      (c.parents[0] === speciesA && c.parents[1] === speciesB) ||
      (c.parents[0] === speciesB && c.parents[1] === speciesA),
  );
}

/** 品系 id → 存档下标；未知品系返回 -1 */
export function strainIndexOf(id: StrainId): number {
  return STRAIN_ORDER.indexOf(id);
}

/** 存档下标 → 品系 id；越界返回 undefined */
export function strainAt(index: number): StrainId | undefined {
  return STRAIN_ORDER[index];
}

/** 品系覆盖叠加在基础特性之上：浅合并，未定义字段保持基础值 */
export function applyStrain(base: PlantTrait, strain: StrainDef): PlantTrait {
  return { ...base, ...strain.trait };
}
