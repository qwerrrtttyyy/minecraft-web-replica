/**
 * 堆肥桶等级编码（v1.6 植物深化）。
 *
 * 堆肥等级直接编码进方块 id（110 空 → 117 填满 7 → 118 成熟），
 * 于是等级天然随 world.edits 差分持久化，不需要另建状态表、存档字段或清理逻辑。
 * 纯数据 + 纯函数，不依赖 World / DOM / three.js。
 */
import type { BlockId } from '../core/types';

export const COMPOSTER_ID = 110;
export const COMPOSTER_READY_ID = 118;
/** 成熟后由 8 个等级降至 0（空桶） */
export const COMPOST_LEVELS = 8;

/** 可堆肥物品 → 增加的等级数 */
export const COMPOST_VALUES: Readonly<Record<string, number>> = {
  'item:wheat_seeds': 1,
  'item:apple': 1,
  tall_grass: 1,
  fern: 1,
  tall_fern: 1,
  dead_bush: 1,
  oak_leaves: 1,
  birch_leaves: 1,
  spruce_leaves: 1,
  wheat: 2,
  'item:sweet_berries': 2,
};

/** block id → 堆肥等级（非堆肥桶返回 -1） */
export function levelOf(id: BlockId): number {
  if (id < COMPOSTER_ID || id > COMPOSTER_READY_ID) return -1;
  if (id === COMPOSTER_READY_ID) return COMPOST_LEVELS;
  return id - COMPOSTER_ID;
}

/** 等级 → block id */
export function idOf(level: number): BlockId {
  if (level >= COMPOST_LEVELS) return COMPOSTER_READY_ID;
  return COMPOSTER_ID + Math.max(0, level);
}

/**
 * 往桶里投放一个物品，返回新的 block id；
 * 满级或不可堆肥物品返回 null（调用方不应消耗物品）。
 */
export function nextId(id: BlockId, itemKey: string): BlockId | null {
  const level = levelOf(id);
  if (level < 0 || level >= COMPOST_LEVELS) return null;
  const value = COMPOST_VALUES[itemKey];
  if (!value) return null;
  return idOf(level + value);
}

/** 成熟桶可收取的肥料物品名；未成熟返回 null */
export function harvestOf(id: BlockId): string | null {
  return id === COMPOSTER_READY_ID ? 'item:fertilizer' : null;
}
