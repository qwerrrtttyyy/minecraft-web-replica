import { NEW_ITEMS } from '../core/tuning';
import type { EventService } from '../services/events';
import { EXTENSION_POINTS } from '../services/plugins/extensions';
import { clamp, type GameMode, type Vec3Like, type BlockId } from '../core/types';
import type { BlockRegistry } from '../world/blocks';
import { EQUIPMENT } from './equipment';

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
  /** 右键时种植的方块名（种子 / 浆果等可种植物品） */
  plant?: string;
}

/** 由装备定义表生成物品条目，保证 id / label / tile 与 EQUIPMENT 单一来源一致 */
const EQUIP_ITEMS: Record<string, ItemDefinition> = {};
for (const def of Object.values(EQUIPMENT)) {
  EQUIP_ITEMS[def.id] = { name: def.id, label: def.label, tile: def.tile };
}

export const ITEMS: Record<string, ItemDefinition> = {
  apple: { name: 'apple', label: '苹果', tile: 'apple', food: 4 },
  porkchop: { name: 'porkchop', label: '生猪排', tile: 'porkchop', food: 6 },
  wheat_seeds: { name: 'wheat_seeds', label: '小麦种子', tile: 'wheat_seeds', plant: 'wheat_seedling' },
  sweet_berries: {
    name: 'sweet_berries', label: '甜浆果', tile: 'sweet_berries', food: 2, plant: 'sweet_berry_bush',
  },
  nectar: { name: 'nectar', label: '花蜜', tile: 'nectar', food: 3 },
  stick: { name: 'stick', label: '木棍', tile: 'stick' },
  /** 堆肥 / 动物掉落的有机肥：给土壤补 35 养分 */
  fertilizer: { name: 'fertilizer', label: '肥料', tile: 'fertilizer' },
  /** 骷髅掉落的骨粉：补 55 养分并给目标植物 15 能量 */
  bone_meal: { name: 'bone_meal', label: '骨粉', tile: 'bone_meal' },
  // v1.7.0：内容植物产出（葡萄可种回，其余按用途进入合成）
  cotton: { name: 'cotton', label: '棉花', tile: 'cotton' },
  rice: { name: 'rice', label: '稻米', tile: 'rice', food: 5 },
  grapes: { name: 'grapes', label: '葡萄', tile: 'grapes', food: 2, plant: 'grape_vine' },
  chili: { name: 'chili', label: '辣椒', tile: 'chili', food: 3 },
  glow_spore: { name: 'glow_spore', label: '荧光孢子', tile: 'glow_spore' },
  /** 内容体系新增物品：食物值统一取自 tuning.ts 的 NEW_ITEMS */
  coal: { name: 'coal', label: '煤炭', tile: 'coal', food: NEW_ITEMS.coal.food },
  leather: { name: 'leather', label: '皮革', tile: 'leather', food: NEW_ITEMS.leather.food },
  beef: { name: 'beef', label: '生牛肉', tile: 'beef', food: NEW_ITEMS.beef.food },
  feather: { name: 'feather', label: '羽毛', tile: 'feather', food: NEW_ITEMS.feather.food },
  egg: { name: 'egg', label: '鸡蛋', tile: 'egg', food: NEW_ITEMS.egg.food },
  rabbit_meat: { name: 'rabbit_meat', label: '兔肉', tile: 'rabbit_meat', food: NEW_ITEMS.rabbit_meat.food },
  // v1.7.0 重点株特化产物：野蒜与玫瑰果及其合成菜式
  garlic: { name: 'garlic', label: '大蒜', tile: 'garlic', food: 2 },
  rose_hips: { name: 'rose_hips', label: '玫瑰果', tile: 'rose_hips' },
  garlic_rice: { name: 'garlic_rice', label: '蒜香米饭', tile: 'garlic_rice', food: 8 },
  rose_tea: { name: 'rose_tea', label: '玫瑰果茶', tile: 'rose_tea', food: 6 },
  ...EQUIP_ITEMS,
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
  /**
   * 实验性玩法「死亡保留物品」（对应 /gamerule keepInventory）。
   * 默认 true 保持项目原有的友好行为；关闭后死亡会清空背包（原版默认行为）。
   */
  keepInventory = true;

  /** key -> 数量，key 形如 b:12 / i:apple */
  readonly inventory = new Map<string, number>();

  private exhaustion = 0;
  private regenAcc = 0;
  private starveAcc = 0;
  private drownAcc = 0;
  private iframes = 0;

  constructor(
    private events: EventService,
    private registry: BlockRegistry,
    /** 可选扩展注册表：注册后伤害结算前经 combat:damage-incoming 管道改写 */
    private extensions?: {
      has(p: string): boolean;
      reduce<P extends object>(p: string, payload: P): { payload: P };
    },
  ) {}

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

  addItem(name: string, count = 1): boolean {
    if (!this.isSurvival) return false;
    if (!ITEMS[name] || count <= 0) return false;
    this.addKey(itemKey(name), count);
    return true;
  }

  /** 按掉落表名加入背包：'self' 需调用方换成方块名；返回是否真的加入 */
  addDrop(name: string, count = 1): boolean {
    if (name.startsWith('item:')) return this.addItem(name.slice(5), count);
    if (ITEMS[name]) return this.addItem(name, count); // CraftAPI.survival.give('apple') 也能用
    const def = this.registry.byNameGet(name);
    if (!def) return false;
    this.addBlock(def.id, count);
    return true;
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
    // 管道扩展点（如护甲减伤）在落账前改写伤害；无处理器时零行为变化
    if (this.extensions?.has(EXTENSION_POINTS.COMBAT_DAMAGE_INCOMING)) {
      const { payload } = this.extensions.reduce(EXTENSION_POINTS.COMBAT_DAMAGE_INCOMING, {
        amount,
        source: cause,
      });
      amount = Math.max(0, payload.amount);
      if (amount <= 0) return false;
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
    // 原版默认：死亡掉落（这里简化为清空背包）；开启 keepInventory 则保留。
    let lost = 0;
    if (!this.keepInventory && this.isSurvival) {
      for (const [key] of this.inventory) {
        this.events.emit('inventory:change', { key, count: 0 });
        lost++;
      }
      this.inventory.clear();
    }
    this.events.emit('survival:death', { cause, itemsLost: lost, keepInventory: this.keepInventory });
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
    // H10：每次回血额外产生消耗（等效 0.75 饥饿点）——满饥饿不再免费永动回血
    if (this.hunger >= 18 && this.health < MAX_HEALTH) {
      this.regenAcc += dt;
      if (this.regenAcc >= 4) {
        this.regenAcc = 0;
        this.exhaustion += 3;
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
