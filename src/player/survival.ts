import type { EventService } from '../services/events';
import type { GameMode, Vec3Like } from '../core/types';
import { clamp } from '../core/types';
import type { BlockId } from '../core/types';
import type { BlockRegistry } from '../world/blocks';

/**
 * 生存模式状态机：生命 / 饥饿 / 氧气 / 背包 / 进食 / 死亡与重生。
 * 纯逻辑层，不依赖 three.js 与 DOM，便于测试与替换 UI。
 */

export const MAX_HEALTH = 20;
export const MAX_HUNGER = 20;
export const MAX_BREATH = 15;

export type StackKind = 'block' | 'item';

/** 快捷栏 / 背包里的一格：方块（数字 id）或物品（字符串名） */
export interface Stack {
  kind: StackKind;
  id: number | string;
}

export interface ItemDefinition {
  name: string;
  label: string;
  /** 图集中的纹理名 */
  tile: string;
  /** 进食恢复的饥饿值（0~20） */
  food?: number;
}

export const ITEMS: Record<string, ItemDefinition> = {
  apple: { name: 'apple', label: '苹果', tile: 'apple', food: 4 },
  porkchop: { name: 'porkchop', label: '生猪排', tile: 'porkchop', food: 6 },
};

export const itemKey = (name: string) => `i:${name}`;
export const blockKeyOf = (id: BlockId) => `b:${id}`;
export const stackKey = (s: Stack) => (s.kind === 'block' ? blockKeyOf(s.id as BlockId) : itemKey(s.id as string));

export function parseKey(key: string): Stack {
  return key.startsWith('i:')
    ? { kind: 'item', id: key.slice(2) }
    : { kind: 'block', id: Number(key.slice(2)) };
}

export interface SurvivalSave {
  health: number;
  hunger: number;
  breath: number;
  inventory: [string, number][];
  spawn: Vec3Like;
}

export interface SurvivalContext {
  moving: boolean;
  sprinting: boolean;
  mining: boolean;
  underwater: boolean;
}

export class SurvivalState {
  mode: GameMode = 'survival';
  health = MAX_HEALTH;
  hunger = MAX_HUNGER;
  breath = MAX_BREATH;
  dead = false;
  deathCause = '';
  spawn: Vec3Like = { x: 0.5, y: 40, z: 0.5 };

  /** key -> 数量，key 形如 b:12 / i:apple */
  readonly inventory = new Map<string, number>();

  private exhaustion = 0;
  private regenAcc = 0;
  private starveAcc = 0;
  private drownAcc = 0;
  private iframes = 0;

  constructor(private events: EventService, private registry: BlockRegistry) {}

  get isSurvival() {
    return this.mode === 'survival';
  }

  // ---------- 背包 ----------

  addBlock(id: BlockId, count = 1) {
    if (!this.isSurvival) return;
    const def = this.registry.get(id);
    if (def.id === 0 || count <= 0) return;
    this.addKey(blockKeyOf(id), count);
  }

  addItem(name: string, count = 1) {
    if (!this.isSurvival) return;
    if (!ITEMS[name] || count <= 0) return;
    this.addKey(itemKey(name), count);
  }

  /** 按掉落表名加入背包：'self' 需调用方换成方块名 */
  addDrop(name: string, count = 1) {
    if (name.startsWith('item:')) this.addItem(name.slice(5), count);
    else if (ITEMS[name]) this.addItem(name, count); // CraftAPI.survival.give('apple') 也能用
    else {
      const def = this.registry.byNameGet(name);
      if (def) this.addBlock(def.id, count);
    }
  }

  private addKey(key: string, count: number) {
    const n = clamp((this.inventory.get(key) ?? 0) + count, 0, 999);
    this.inventory.set(key, n);
    this.events.emit('inventory:change', { key, count: n });
  }

  countKey(key: string) {
    return this.inventory.get(key) ?? 0;
  }

  countStack(s: Stack) {
    return this.countKey(stackKey(s));
  }

  has(s: Stack, n = 1) {
    return !this.isSurvival || this.countStack(s) >= n;
  }

  /** 生存模式消耗 1 个；创造模式永远成功 */
  consume(s: Stack, n = 1) {
    if (!this.isSurvival) return true;
    const key = stackKey(s);
    const have = this.countKey(key);
    if (have < n) return false;
    this.addKey(key, -n);
    if (this.countKey(key) <= 0) this.inventory.delete(key);
    return true;
  }

  ownedBlockIds(): BlockId[] {
    const ids: BlockId[] = [];
    for (const [key, n] of this.inventory) {
      if (!key.startsWith('b:') || n <= 0) continue;
      const id = Number(key.slice(2));
      if (this.registry.get(id).id === id) ids.push(id);
    }
    return ids;
  }

  // ---------- 生命 ----------

  damage(amount: number, cause = '未知', useIframes = true) {
    if (!this.isSurvival || this.dead || amount <= 0) return false;
    if (useIframes) {
      if (this.iframes > 0) return false;
      this.iframes = 0.32;
    }
    this.health = Math.max(0, this.health - amount);
    this.events.emit('survival:damage', { amount, health: this.health, cause });
    if (this.health <= 0) this.die(cause);
    return true;
  }

  heal(amount: number) {
    this.health = clamp(this.health + amount, 0, MAX_HEALTH);
  }

  private die(cause: string) {
    if (this.dead) return;
    this.dead = true;
    this.deathCause = cause;
    this.events.emit('survival:death', { cause });
  }

  respawn(pos: Vec3Like) {
    this.health = MAX_HEALTH;
    this.hunger = MAX_HUNGER;
    this.breath = MAX_BREATH;
    this.dead = false;
    this.deathCause = '';
    this.exhaustion = 0;
    this.regenAcc = 0;
    this.starveAcc = 0;
    this.drownAcc = 0;
    this.iframes = 1.5;
    this.events.emit('survival:respawn', { position: pos });
  }

  /** 额外消耗（跳跃、攻击等一次性动作） */
  exhaust(amount: number) {
    if (!this.isSurvival) return;
    this.exhaustion += amount;
  }

  eat(name: string) {
    const item = ITEMS[name];
    if (!this.isSurvival || !item?.food) return false;
    if (this.hunger >= MAX_HUNGER) return false;
    this.hunger = clamp(this.hunger + item.food, 0, MAX_HUNGER);
    this.events.emit('survival:eat', { item: name, hunger: this.hunger });
    this.heal(1);
    return true;
  }

  tick(dt: number, ctx: SurvivalContext) {
    this.iframes = Math.max(0, this.iframes - dt);
    if (!this.isSurvival) {
      this.health = MAX_HEALTH;
      this.hunger = MAX_HUNGER;
      this.breath = MAX_BREATH;
      return;
    }
    if (this.dead) return;

    // 氧气
    if (ctx.underwater) {
      this.breath = Math.max(0, this.breath - dt);
      if (this.breath <= 0) {
        this.drownAcc += dt;
        if (this.drownAcc >= 1) {
          this.drownAcc = 0;
          this.damage(2, '溺水', false);
        }
      }
    } else {
      this.breath = Math.min(MAX_BREATH, this.breath + dt * 4);
      this.drownAcc = 0;
    }

    // 饥饿消耗（疾跑 > 挖掘 > 行走）
    let drain = 0;
    if (ctx.mining) drain += 0.09;
    if (ctx.moving) drain += ctx.sprinting ? 0.2 : 0.06;
    this.exhaustion += drain * dt;
    while (this.exhaustion >= 4) {
      this.exhaustion -= 4;
      this.hunger = Math.max(0, this.hunger - 1);
    }

    // 饱食回血 / 饥饿掉血
    if (this.hunger >= 18 && this.health < MAX_HEALTH) {
      this.regenAcc += dt;
      if (this.regenAcc >= 4) {
        this.regenAcc = 0;
        this.heal(1);
      }
    } else {
      this.regenAcc = 0;
    }
    if (this.hunger <= 0) {
      this.starveAcc += dt;
      if (this.starveAcc >= 4) {
        this.starveAcc = 0;
        this.damage(1, '饥饿', false);
      }
    } else {
      this.starveAcc = 0;
    }
  }

  // ---------- 存档 ----------

  serialize(): SurvivalSave {
    return {
      health: this.health,
      hunger: this.hunger,
      breath: this.breath,
      inventory: [...this.inventory.entries()],
      spawn: { ...this.spawn },
    };
  }

  restore(data: Partial<SurvivalSave> | undefined | null) {
    if (!data) return;
    if (typeof data.health === 'number') this.health = clamp(data.health, 0, MAX_HEALTH);
    if (typeof data.hunger === 'number') this.hunger = clamp(data.hunger, 0, MAX_HUNGER);
    if (typeof data.breath === 'number') this.breath = clamp(data.breath, 0, MAX_BREATH);
    if (Array.isArray(data.inventory)) {
      this.inventory.clear();
      for (const [k, v] of data.inventory) {
        if (typeof k === 'string' && typeof v === 'number' && v > 0) this.inventory.set(k, v);
      }
    }
    if (data.spawn) this.spawn = { ...data.spawn };
    this.dead = this.health <= 0;
  }

  resetInventory() {
    this.inventory.clear();
  }
}
