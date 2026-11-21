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
import type { PlantTrait } from '../../world/plantTraits';
import type { PlantRule } from '../../world/plantRules';

export const EXPANSION_PLUGIN_ID = 'core:botany-expansion';
/** 扩展方块 id 起点：内置方块已占用 1~138（v1.6.0 移植植物顺延 111~138），必须末位追加且不超过 255 */
export const EXPANSION_FIRST_ID = 139;
/** 单列生成权重累加的上界；插件据此先做一次廉价 roll 过滤再查世界 */
export const SPAWN_ROLL_CEILING = 0.04;

type Painter = (
  setPixel: (x: number, y: number, hex: number, alpha?: number) => void,
  rng: () => number,
) => void;

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
  paint: Painter;
}

const nectar = { item: 'item:nectar', count: 1 };

/**
 * 6 种新植物（id 120~125）。
 * 代谢类型沿用 plantTraits.ts 的 solar / hydro / fungal 三分类，
 * 因此自动接入蓄能、开花、根系共享与采集结算，无需改 Botany 的能量模型。
 */
export const EXPANSION_PLANTS: readonly ExpansionPlant[] = [
  {
    name: 'thistle', label: '蓟', id: 120,
    trait: { metabolism: 'solar', bloom: 80, growthCost: 18, shareRadius: 2, sharePower: 12, harvest: nectar },
    spawn: { plains: 0.008, forest: 0.004 },
    paint: (set) => {
      for (let y = 9; y < 16; y++) set(8, y, 0x4a7c3f);
      for (let y = 3; y < 9; y++) {
        set(7, y, 0x8a5cc8); set(8, y, 0xa77bdd); set(9, y, 0x7b4dbb);
        if (y % 2 === 0) { set(6, y, 0x9b6bd0); set(10, y, 0x6f43ad); }
      }
      set(8, 2, 0xc9a2e8);
    },
  },
  {
    name: 'cattail', label: '香蒲', id: 121,
    trait: { metabolism: 'hydro', bloom: 70, growthCost: 16, shareRadius: 2, sharePower: 10 },
    spawn: { beach: 0.02, plains: 0.012, forest: 0.008 },
    nearWater: true, waterPlant: true,
    paint: (set) => {
      for (let y = 4; y < 16; y++) set(8, y, 0x4c7a3a);
      for (let y = 2; y < 7; y++) { set(7, y, 0x6b4526); set(8, y, 0x8a5a2f); set(9, y, 0x5c3a20); }
      for (let y = 9; y < 16; y++) { set(5, y, 0x3f6b32); set(11, y, 0x356028); }
    },
  },
  {
    name: 'glow_mushroom', label: '荧光菇', id: 122,
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
      set(6, 5, 0xd8fff4); set(9, 6, 0xd8fff4);
    },
  },
  {
    name: 'frost_bloom', label: '霜花', id: 123,
    trait: { metabolism: 'solar', bloom: 75, growthCost: 20, shareRadius: 2, sharePower: 10, harvest: nectar },
    spawn: { alpine: 0.012 },
    paint: (set) => {
      for (let y = 9; y < 16; y++) set(8, y, 0x5f8f6a);
      const petals = [[8, 3], [5, 5], [11, 5], [4, 8], [12, 8], [6, 11], [10, 11]];
      for (const [x, y] of petals) { set(x, y, 0xdff2ff); set(x, y + 1, 0xa9d8f5); }
      set(8, 7, 0xfff3b0); set(8, 8, 0xffe27a);
    },
  },
  {
    name: 'ember_fern', label: '余烬蕨', id: 124,
    trait: { metabolism: 'fungal', bloom: 60, growthCost: 12, shareRadius: 2, sharePower: 10 },
    spawn: { forest: 0.006, taiga: 0.006 },
    paint: (set) => {
      for (let y = 4; y < 16; y++) {
        set(8, y, 0x8a3a24);
        const w = Math.max(0, 4 - Math.floor((16 - y) / 3));
        for (let d = 1; d <= w; d++) { set(8 - d, y, 0xc45a2a); set(8 + d, y, 0xa8441f); }
      }
    },
  },
  {
    name: 'moonlotus', label: '月莲', id: 125,
    trait: { metabolism: 'hydro', bloom: 80, growthCost: 18, shareRadius: 2, sharePower: 12, harvest: nectar },
    spawn: { ocean: 0.006, beach: 0.01 },
    nearWater: true, waterPlant: true,
    paint: (set) => {
      for (let x = 3; x < 13; x++) { set(x, 12, 0x2f6f8a); set(x, 13, 0x245b73); }
      for (let x = 4; x < 12; x++) {
        for (let y = 6; y < 11; y++) {
          if (Math.abs(x - 8) <= 11 - y) set(x, y, y < 8 ? 0xd7e9ff : 0x8fb8e8);
        }
      }
      set(8, 8, 0xfff6c9); set(7, 9, 0xf2e2a8); set(9, 9, 0xf2e2a8);
    },
  },
];

export const EXPANSION_PLANT_COUNT = EXPANSION_PLANTS.length;

export function expansionBlockInput(p: ExpansionPlant): BlockInput {
  return {
    id: p.id,
    name: p.name, label: p.label, shape: 'cross',
    solid: false, opaque: false, liquid: false, transparentPass: false,
    lightEmission: p.lightEmission ?? 0, hardness: 0, sound: 'plant',
    waterPlant: p.waterPlant,
    tiles: { top: p.name, bottom: p.name, side: p.name },
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
  return ctx.neighbors(ctx.x, ctx.y, ctx.z)
    .filter(([, ny]) => ny === ctx.y) as [number, number, number][];
}

/**
 * 3 条生态规则，全部通过 CraftAPI.botany.registerRule 注入。
 * Botany 在内置规则未命中时才分派，因此不会改动既有 57 组生态回归。
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
];
