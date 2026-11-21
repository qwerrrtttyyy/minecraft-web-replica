/**
 * 土壤养分场（v1.6 植物深化）。
 *
 * 与内在能量并行的第二资源：能量来自光照 / 水体 / 阴暗，养分来自土壤本身。
 * 未记录的土壤返回 100（天然肥沃），因此既有生态测试无需改动即可保持中性。
 *
 * 纯数据 + 纯函数，不依赖 World / DOM / three.js。
 */
import { blockKey, clamp } from '../core/types';

export const MAX_SOIL_NUTRIENT = 100;
/** 土壤养分表上限，与 Botany 的能量表上限独立 */
export const SOIL_LIMIT = 1024;

/** 土壤坐标 → 养分（0~100），由 Botany 独占持有并传入各函数 */
export type SoilMap = Map<string, number>;

export function nutrientAt(soil: SoilMap | undefined, x: number, y: number, z: number): number {
  return soil?.get(blockKey(x, y, z)) ?? MAX_SOIL_NUTRIENT;
}

export function consume(soil: SoilMap, x: number, y: number, z: number, amount: number): void {
  const key = blockKey(x, y, z);
  soil.set(key, clamp((soil.get(key) ?? MAX_SOIL_NUTRIENT) - amount, 0, MAX_SOIL_NUTRIENT));
}

export function enrich(soil: SoilMap, x: number, y: number, z: number, amount: number): void {
  const key = blockKey(x, y, z);
  soil.set(key, clamp((soil.get(key) ?? MAX_SOIL_NUTRIENT) + amount, 0, MAX_SOIL_NUTRIENT));
}

export function returnToSoil(soil: SoilMap, x: number, y: number, z: number, amount: number): void {
  enrich(soil, x, y, z, amount);
}

/** 超出上限时淘汰最早插入的四分之一（与能量表同策略） */
export function evictIfNeeded(soil: SoilMap): void {
  if (soil.size < SOIL_LIMIT) return;
  let drop = soil.size >> 2;
  if (drop < 1) drop = 1;
  for (const key of soil.keys()) {
    soil.delete(key);
    if (--drop <= 0) break;
  }
}
