import {
  EXTENSION_POINTS,
  type AttackPayload,
  type ExtensionRegistry,
  type HookStack,
  type MiningPayload,
  type UseItemPayload,
} from '../services/plugins/extensions';
import { equipmentDef } from './equipment';

/**
 * 玩家行为扩展点的纯逻辑适配层（A2-5）。
 *
 * Player 只调用这里的函数：无处理器时返回与旧版逐项相等的数值（徒手挖掘耗时 /
 * 徒手伤害 3 / 不截断右键），工具档位、护甲穿戴等玩法全部由插件注册处理器实现。
 */

export const BASE_ATTACK = 3;
const MIN_MINE_TIME = 0.06;

export function baseMiningTime(hardness: number): number {
  return Math.max(MIN_MINE_TIME, hardness * 1.1);
}

/** 手持物是工具 / 武器时返回装备 id；盔甲、方块与普通物品返回 null */
export function heldToolId(stack: HookStack | null | undefined): string | null {
  if (!stack || stack.kind !== 'item') return null;
  const def = equipmentDef(String(stack.id));
  return def && !def.slot ? def.id : null;
}

export interface MiningResult {
  time: number;
  harvest: boolean;
}

export function resolveMining(
  ext: ExtensionRegistry | null | undefined,
  block: { name: string; hardness: number; sound: string },
  toolId: string | null,
): MiningResult {
  const time = baseMiningTime(block.hardness);
  if (!ext?.has(EXTENSION_POINTS.PLAYER_MINING)) return { time, harvest: true };
  const { payload } = ext.reduce<MiningPayload>(EXTENSION_POINTS.PLAYER_MINING, {
    block: block.name,
    hardness: block.hardness,
    sound: block.sound,
    toolId,
    time,
    harvest: true,
  });
  const t = Number.isFinite(payload.time) && payload.time > 0 ? payload.time : time;
  return { time: Math.max(MIN_MINE_TIME, t), harvest: payload.harvest !== false };
}

export function resolveAttack(
  ext: ExtensionRegistry | null | undefined,
  toolId: string | null,
  target: string,
): number {
  if (!ext?.has(EXTENSION_POINTS.PLAYER_ATTACK)) return BASE_ATTACK;
  const { payload } = ext.reduce<AttackPayload>(EXTENSION_POINTS.PLAYER_ATTACK, {
    amount: BASE_ATTACK,
    toolId,
    target,
  });
  return Number.isFinite(payload.amount) ? Math.max(0, payload.amount) : BASE_ATTACK;
}

/** 返回 true 表示插件已处理这次右键，Player 不再走默认的放置 / 进食流程 */
export function resolveUseItem(ext: ExtensionRegistry | null | undefined, stack: HookStack): boolean {
  if (!ext?.has(EXTENSION_POINTS.PLAYER_USE_ITEM)) return false;
  const key = stack.kind === 'block' ? `b:${stack.id}` : `i:${stack.id}`;
  const { payload } = ext.reduce<UseItemPayload>(EXTENSION_POINTS.PLAYER_USE_ITEM, {
    stack: { kind: stack.kind, id: stack.id },
    key,
    handled: false,
  });
  return payload.handled === true;
}

export function notifyUsedTool(
  ext: ExtensionRegistry | null | undefined,
  toolId: string | null,
  action: 'mine' | 'attack',
): void {
  if (!toolId || !ext?.has(EXTENSION_POINTS.PLAYER_USED_TOOL)) return;
  ext.emit(EXTENSION_POINTS.PLAYER_USED_TOOL, { toolId, key: `i:${toolId}`, action });
}
