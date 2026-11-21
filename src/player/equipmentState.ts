import type { EventService } from '../services/events';
import { equipmentDef, type EquipSlot } from './equipment';

/**
 * 装备运行状态：4 个护甲槽 + 背包中装备的耐久。
 *
 * 背包装备不可堆叠（每种最多 1 件），耐久按背包键（'i:<id>'）单独存，
 * 不改 SurvivalState 的 Map<key, count> 结构。穿戴时耐久从背包转入甲槽，
 * 卸下时原样退回。纯逻辑层，不依赖 three.js / DOM。
 */

export interface EquippedItem {
  id: string;
  durability: number;
}

export interface EquipmentSave {
  slots: Partial<Record<EquipSlot, [string, number]>>;
  durability: [string, number][];
}

const SLOTS: EquipSlot[] = ['head', 'chest', 'legs', 'feet'];

export class EquipmentState {
  readonly slots: Record<EquipSlot, EquippedItem | null> = {
    head: null,
    chest: null,
    legs: null,
    feet: null,
  };

  /** 背包装备耐久：'i:iron_sword' -> 剩余耐久 */
  readonly durability = new Map<string, number>();

  constructor(private events: EventService) {}

  /** 当前护甲总点数（未截断，减伤函数在读取时截断到 20） */
  get armorPoints(): number {
    let sum = 0;
    for (const slot of SLOTS) {
      const eq = this.slots[slot];
      if (eq) sum += equipmentDef(eq.id)?.armor ?? 0;
    }
    return sum;
  }

  /** 首次获得装备时初始化耐久；已有则不覆盖 */
  initDurability(key: string, id: string): number {
    const def = equipmentDef(id);
    if (!def) return 0;
    let d = this.durability.get(key);
    if (d === undefined) {
      d = def.durability;
      this.durability.set(key, d);
    }
    return d;
  }

  durabilityOf(key: string): number | null {
    return this.durability.get(key) ?? null;
  }

  /** 背包装备扣耐久；返回 true 表示损坏（调用方需从背包移除） */
  damageHeld(key: string, amount = 1): boolean {
    const d = this.durability.get(key);
    if (d === undefined) return false;
    const next = Math.max(0, d - amount);
    const id = key.startsWith('i:') ? key.slice(2) : key;
    if (next <= 0) {
      this.durability.delete(key);
      this.events.emit('equipment:broken', { id, source: 'held' });
      return true;
    }
    this.durability.set(key, next);
    this.events.emit('equipment:change', { slot: null, id, durability: next });
    return false;
  }

  /** 穿戴：由 SurvivalState 校验背包持有并扣除后再调用 */
  equip(slot: EquipSlot, id: string, durability: number): boolean {
    const def = equipmentDef(id);
    if (!def || def.slot !== slot) return false;
    this.slots[slot] = { id, durability };
    this.events.emit('equipment:change', { slot, id, durability });
    return true;
  }

  /** 卸下：返回原装备与耐久，由 SurvivalState 退回背包 */
  unequip(slot: EquipSlot): EquippedItem | null {
    const eq = this.slots[slot];
    if (!eq) return null;
    this.slots[slot] = null;
    this.events.emit('equipment:change', { slot, id: null, durability: 0 });
    return eq;
  }

  /** 受击：每个已穿甲槽扣耐久，返回本次损坏的装备 id */
  damageArmor(amount = 1): string[] {
    const broken: string[] = [];
    for (const slot of SLOTS) {
      const eq = this.slots[slot];
      if (!eq) continue;
      const next = Math.max(0, eq.durability - amount);
      if (next <= 0) {
        this.slots[slot] = null;
        broken.push(eq.id);
        this.events.emit('equipment:broken', { id: eq.id, source: 'armor' });
      } else {
        this.slots[slot] = { id: eq.id, durability: next };
      }
      this.events.emit('equipment:change', { slot, id: this.slots[slot]?.id ?? null, durability: next });
    }
    return broken;
  }

  clear() {
    for (const slot of SLOTS) this.slots[slot] = null;
    this.durability.clear();
  }

  serialize(): EquipmentSave {
    const slots: Partial<Record<EquipSlot, [string, number]>> = {};
    for (const slot of SLOTS) {
      const eq = this.slots[slot];
      if (eq) slots[slot] = [eq.id, eq.durability];
    }
    return { slots, durability: [...this.durability.entries()] };
  }

  restore(data: Partial<EquipmentSave> | undefined | null) {
    // 旧档无装备字段也必须清空：从新档恢复到旧档时不能残留上次的装备
    this.clear();
    if (!data) return;
    if (data.slots && typeof data.slots === 'object') {
      for (const slot of SLOTS) {
        const entry = data.slots[slot];
        if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
        const def = equipmentDef(entry[0]);
        const dur = typeof entry[1] === 'number' ? entry[1] : def?.durability ?? 1;
        if (def && def.slot === slot && dur > 0) this.slots[slot] = { id: entry[0], durability: dur };
      }
    }
    if (Array.isArray(data.durability)) {
      for (const [k, v] of data.durability) {
        if (typeof k === 'string' && typeof v === 'number' && v > 0) this.durability.set(k, v);
      }
    }
  }
}
