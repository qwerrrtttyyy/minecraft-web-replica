/**
 * 季节 / 天气历法（v1.6 植物深化）。
 *
 * 纯数据 + 纯函数，不依赖 World / DOM / three.js：
 * - 6 个游戏日为 1 季，4 季 24 日为一年（dayLength=600s → 一季 60 分钟 realtime）；
 * - 天气由 world seed + 天数哈希推导，不存档也能回档复现；
 * - 倍率表只描述「环境如何影响代谢」，具体作用点留给 Botany。
 *
 * 默认环境（spring / clear）的所有倍率均为 1，保证既有生态行为逐值不变。
 */

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export type Weather = 'clear' | 'rain';

export interface PlantEnv {
  /** 累计游戏日（从 0 开始） */
  day: number;
  season: Season;
  weather: Weather;
}

export interface ModifierSet {
  /** 随机刻生长 / 蔓延概率倍率 */
  growth: number;
  /** 光合（solar）蓄能倍率 */
  solar: number;
  /** 水生（hydro）蓄能倍率 */
  hydro: number;
  /** 真菌（fungal）蓄能倍率 */
  fungal: number;
  /** 土壤养分自然回复倍率 */
  soil: number;
}

/** 一季的游戏日数；一年 4 季 */
export const DAYS_PER_SEASON = 6;
export const DAYS_PER_YEAR = DAYS_PER_SEASON * 4;

const SEASONS: readonly Season[] = ['spring', 'summer', 'autumn', 'winter'];

/** 中性默认：既有生态测试与不传 env 的调用都走这条路径 */
export const DEFAULT_PLANT_ENV: PlantEnv = { day: 0, season: 'spring', weather: 'clear' };

export function seasonAt(day: number): Season {
  const d = Math.max(0, Math.floor(day));
  return SEASONS[Math.floor((d % DAYS_PER_YEAR) / DAYS_PER_SEASON)];
}

/** 稳定整数哈希：同 seed + day 永远得到同一结果 */
export function weatherAt(seed: number, day: number): Weather {
  let h = (seed ^ Math.imul(Math.max(0, Math.floor(day)), 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) | 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) | 0;
  const roll = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  return roll < 0.25 ? 'rain' : 'clear';
}

const SEASON_MODIFIERS: Readonly<Record<Season, ModifierSet>> = {
  spring: { growth: 1, solar: 1, hydro: 1, fungal: 1, soil: 1 },
  summer: { growth: 1.15, solar: 1.15, hydro: 0.9, fungal: 0.9, soil: 1 },
  autumn: { growth: 0.85, solar: 0.9, hydro: 1, fungal: 1.1, soil: 1 },
  winter: { growth: 0.7, solar: 0.55, hydro: 0.7, fungal: 1.25, soil: 0.8 },
};

const RAIN_MODIFIERS: ModifierSet = {
  growth: 1, solar: 0.8, hydro: 1.25, fungal: 1, soil: 1.2,
};

/** 取当前环境的复合倍率；两个来源相乘，默认环境恒为 1 */
export function modifiers(env: PlantEnv): ModifierSet {
  const base = SEASON_MODIFIERS[env.season] ?? SEASON_MODIFIERS.spring;
  if (env.weather !== 'rain') return { ...base };
  return {
    growth: base.growth * RAIN_MODIFIERS.growth,
    solar: base.solar * RAIN_MODIFIERS.solar,
    hydro: base.hydro * RAIN_MODIFIERS.hydro,
    fungal: base.fungal * RAIN_MODIFIERS.fungal,
    soil: base.soil * RAIN_MODIFIERS.soil,
  };
}

/** 生长概率乘倍率后封顶，避免高倍率把随机刻变成必中 */
export function scaledChance(p: number, env: PlantEnv): number {
  return Math.min(0.95, p * modifiers(env).growth);
}
