/**
 * 天候纯逻辑（四季与天候内容更新）。
 *
 * 刻意不依赖 three.js / DOM / World：既能被天气系统复用，也能被测试快照
 * 直接 require 做纯逻辑回归。
 *
 * 关键约束：不修改 ecology.ts 的 Weather 类型与 weatherAt(seed, day) 签名 ——
 * test/plant-energy-check.cjs 锁死了双参确定性，植物侧继续读粗粒度天气。
 */

import { WEATHER } from '../core/tuning';
import { clamp } from '../core/types';
import { type Season, type Weather, weatherAt } from './ecology';

/** 完整天气形态：保留旧的 clear/rain，追加 snow / thunder */
export type WeatherKind = Weather | 'snow' | 'thunder';

/** 实际降水形态（雷暴归入雨） */
export type Precipitation = 'none' | 'rain' | 'snow';

export interface WeatherSnapshot {
  /** 累计游戏日 */
  day: number;
  kind: WeatherKind;
  form: Precipitation;
  /** 降水强度 0~1 */
  intensity: number;
  /** 环境亮度因子 0~1：唯一变暗源，方块光/实体光/云雾共用 */
  darkness: number;
  /** 雷暴闪光 0~1 */
  flash: number;
}

/** 确定性的天气目标快照；flash 由闪电边沿单独注入，常态为 0 */
export function weatherTarget(seed: number, day: number, temperature: number, season: Season): WeatherSnapshot {
  const form = precipitationForm(temperature, season, weatherAt(seed, day));
  const kind = weatherKindAt(seed, day, temperature, season);
  const intensity = WEATHER.intensity[kind];
  return { day, kind, form, intensity, darkness: weatherFactor(kind, 0), flash: 0 };
}

/** 粗粒度天气 → 降水形态：冬季或低温下雪，否则基础为 rain 时下雨 */
export function precipitationForm(temperature: number, season: Season, base: Weather): Precipitation {
  if (base === 'clear') return 'none';
  if (season === 'winter' || temperature < WEATHER.snowTemperature) return 'snow';
  return 'rain';
}

/** 复合天气类型：晴/雨/雪/雷暴，全部由 seed+day+温度+季节确定性推导 */
export function weatherKindAt(seed: number, day: number, temperature: number, season: Season): WeatherKind {
  const form = precipitationForm(temperature, season, weatherAt(seed, day));
  if (form === 'none') return 'clear';
  if (form === 'snow') return 'snow';
  return lightningRoll(seed, day, 0) < WEATHER.thunderChance ? 'thunder' : 'rain';
}

/**
 * 唯一变暗源：按天气取基础亮度，闪电时向 1 插值。
 * 方块光、实体光、云雾三处必须都乘这个返回值，避免"地块暗、实体亮"。
 */
export function weatherFactor(kind: WeatherKind, flash = 0): number {
  const base = WEATHER.darkness[kind] ?? 1;
  return clamp(base + (1 - base) * clamp(flash, 0, 1), 0, 1);
}

/** 稳定整数哈希（0~1）：同 seed/day/tick 恒定，无 Math.random */
export function lightningRoll(seed: number, day: number, tick: number): number {
  let h =
    (seed ^
      Math.imul(Math.max(0, Math.floor(day)), 0x9e3779b1) ^
      Math.imul(Math.max(0, Math.floor(tick)), 0x85ebca6b)) |
    0;
  h = Math.imul(h ^ (h >>> 16), 0xc2b2ae35) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 该节拍是否触发闪电（只在雷暴天调用） */
export function isLightning(seed: number, day: number, tick: number): boolean {
  return lightningRoll(seed, day, tick) < WEATHER.lightningChance;
}

/**
 * 指数逼近天气状态：两个半步 ≈ 一个整步，intensity/darkness/flash 帧率无关。
 * kind/form 原子切换（不做插值），day 取目标值。
 */
export function approachWeather(current: WeatherSnapshot, target: WeatherSnapshot, dt: number): WeatherSnapshot {
  const f = 1 - Math.exp(-WEATHER.blend * Math.max(0, dt));
  return {
    day: target.day,
    kind: target.kind,
    form: target.form,
    intensity: current.intensity + (target.intensity - current.intensity) * f,
    darkness: current.darkness + (target.darkness - current.darkness) * f,
    flash: current.flash + (target.flash - current.flash) * f,
  };
}
