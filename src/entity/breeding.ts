/**
 * 繁殖规则（纯逻辑，无 three / DOM）：食物白名单、求爱伙伴选择、可繁殖判定。
 *
 * 状态字段（age / loveTimer / cooldown）挂在 Entity 上；这里只做规则判定，
 * 因此本模块可以脱离渲染编译进快照测试。
 */
import { BREED_FOODS } from '../core/tuning';
import type { Entity } from './entity';

/** 材料标识（方块名 / item:xxx）是否是该生物的繁殖食物 */
export function isBreedFood(typeId: string, material: string): boolean {
  return (BREED_FOODS[typeId] ?? []).includes(material);
}

/**
 * 在 mateRadius 内找求爱伙伴：同类、成体、正在求爱、冷却结束；
 * 按实体 id 升序稳定选择第一个，保证同种子同状态结果一致。
 */
export function pickMate(self: Entity, others: readonly Entity[], radius: number): Entity | null {
  const candidates = others.filter((o) =>
    o !== self &&
    !o.hostile &&
    o.type.id === self.type.id &&
    !o.baby &&
    o.loveTimer > 0 &&
    o.cooldown <= 0 &&
    self.pos.distanceTo(o.pos) <= radius,
  );
  candidates.sort((a, b) => a.id - b.id);
  return candidates[0] ?? null;
}

/** 双方同类、均为成体、均处于求爱窗口且冷却结束 */
export function canBreed(a: Entity, b: Entity): boolean {
  return a !== b &&
    !a.hostile && !b.hostile &&
    a.type.id === b.type.id &&
    !a.baby && !b.baby &&
    a.loveTimer > 0 && b.loveTimer > 0 &&
    a.cooldown <= 0 && b.cooldown <= 0;
}
