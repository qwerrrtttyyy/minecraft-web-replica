/**
 * 确定性掉落判定（v1.6）。
 *
 * 之前玩家挖方块与实体死亡各用一次 Math.random()，既不可复现也违反项目
 * 「随机性必须来自 seed」的硬规则。本模块把概率、数量区间、环境条件收进
 * 一个纯函数；调用方只需给出规格表与一个稳定的来源标识。
 *
 * 纯数据 + 纯函数，不依赖 World / DOM / three.js。
 */
import type { DropSpec } from './blocks';

export interface DropContext {
  /** 世界种子 */
  seed: number;
  /** 稳定来源标识：'b:x,y,z' 或 'e:<entityId>:<killSerial>' */
  source: string;
  /** 0~1，供 nightOnly 条件使用 */
  daylight?: number;
  /** 群系名，供 biome 条件使用 */
  biome?: string;
}

export interface RolledDrop {
  name: string;
  count: number;
}

/** 32 位整数哈希：同参数永远同结果，不依赖调用顺序 */
export function dropHash(seed: number, source: string, index: number): number {
  let h = seed | 0;
  for (let i = 0; i < source.length; i++) {
    h = Math.imul(h ^ source.charCodeAt(i), 0x01000193) | 0;
  }
  h = Math.imul(h ^ index, 0x9e3779b1) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) | 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) | 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * 按规格表判定掉落。chance 缺省视为 1；count 缺省为 1；
 * min/max 同时给出时在该闭区间内取整数；nightOnly / biome 为附加过滤。
 */
export function rollDrops(specs: readonly DropSpec[], ctx: DropContext): RolledDrop[] {
  const result: RolledDrop[] = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    if (spec.nightOnly === true && (ctx.daylight ?? 1) >= 0.3) continue;
    if (spec.biome !== undefined && spec.biome !== ctx.biome) continue;
    const hash = dropHash(ctx.seed, ctx.source, i);
    const chance = spec.chance ?? 1;
    if (hash / 4294967296 >= chance) continue;
    let count = spec.count ?? 1;
    if (spec.min !== undefined && spec.max !== undefined && spec.max >= spec.min) {
      count = spec.min + (hash >>> 8) % (spec.max - spec.min + 1);
    }
    result.push({ name: spec.name, count });
  }
  return result;
}
