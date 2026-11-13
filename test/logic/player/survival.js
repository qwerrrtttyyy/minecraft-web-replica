"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SurvivalState = exports.stackKey = exports.blockKeyOf = exports.itemKey = exports.ITEMS = exports.MAX_BREATH = exports.MAX_HUNGER = exports.MAX_HEALTH = void 0;
exports.parseKey = parseKey;
const types_1 = require("../core/types");
/**
 * 生存模式状态机：生命 / 饥饿 / 氧气 / 背包 / 进食 / 死亡与重生。
 * 纯逻辑层，不依赖 three.js 与 DOM，便于测试与替换 UI。
 */
exports.MAX_HEALTH = 20;
exports.MAX_HUNGER = 20;
exports.MAX_BREATH = 15;
exports.ITEMS = {
    apple: { name: 'apple', label: '苹果', tile: 'apple', food: 4 },
    porkchop: { name: 'porkchop', label: '生猪排', tile: 'porkchop', food: 6 },
};
const itemKey = (name) => `i:${name}`;
exports.itemKey = itemKey;
const blockKeyOf = (id) => `b:${id}`;
exports.blockKeyOf = blockKeyOf;
const stackKey = (s) => (s.kind === 'block' ? (0, exports.blockKeyOf)(s.id) : (0, exports.itemKey)(s.id));
exports.stackKey = stackKey;
function parseKey(key) {
    return key.startsWith('i:')
        ? { kind: 'item', id: key.slice(2) }
        : { kind: 'block', id: Number(key.slice(2)) };
}
class SurvivalState {
    constructor(events, registry) {
        this.events = events;
        this.registry = registry;
        this.mode = 'survival';
        this.health = exports.MAX_HEALTH;
        this.hunger = exports.MAX_HUNGER;
        this.breath = exports.MAX_BREATH;
        this.dead = false;
        this.deathCause = '';
        this.spawn = { x: 0.5, y: 40, z: 0.5 };
        /** key -> 数量，key 形如 b:12 / i:apple */
        this.inventory = new Map();
        this.exhaustion = 0;
        this.regenAcc = 0;
        this.starveAcc = 0;
        this.drownAcc = 0;
        this.iframes = 0;
    }
    get isSurvival() {
        return this.mode === 'survival';
    }
    // ---------- 背包 ----------
    addBlock(id, count = 1) {
        if (!this.isSurvival)
            return;
        const def = this.registry.get(id);
        if (def.id === 0 || count <= 0)
            return;
        this.addKey((0, exports.blockKeyOf)(id), count);
    }
    addItem(name, count = 1) {
        if (!this.isSurvival)
            return;
        if (!exports.ITEMS[name] || count <= 0)
            return;
        this.addKey((0, exports.itemKey)(name), count);
    }
    /** 按掉落表名加入背包：'self' 需调用方换成方块名 */
    addDrop(name, count = 1) {
        if (name.startsWith('item:'))
            this.addItem(name.slice(5), count);
        else if (exports.ITEMS[name])
            this.addItem(name, count); // CraftAPI.survival.give('apple') 也能用
        else {
            const def = this.registry.byNameGet(name);
            if (def)
                this.addBlock(def.id, count);
        }
    }
    addKey(key, count) {
        const n = (0, types_1.clamp)((this.inventory.get(key) ?? 0) + count, 0, 999);
        this.inventory.set(key, n);
        this.events.emit('inventory:change', { key, count: n });
    }
    countKey(key) {
        return this.inventory.get(key) ?? 0;
    }
    countStack(s) {
        return this.countKey((0, exports.stackKey)(s));
    }
    has(s, n = 1) {
        return !this.isSurvival || this.countStack(s) >= n;
    }
    /** 生存模式消耗 1 个；创造模式永远成功 */
    consume(s, n = 1) {
        if (!this.isSurvival)
            return true;
        const key = (0, exports.stackKey)(s);
        const have = this.countKey(key);
        if (have < n)
            return false;
        this.addKey(key, -n);
        if (this.countKey(key) <= 0)
            this.inventory.delete(key);
        return true;
    }
    ownedBlockIds() {
        const ids = [];
        for (const [key, n] of this.inventory) {
            if (!key.startsWith('b:') || n <= 0)
                continue;
            const id = Number(key.slice(2));
            if (this.registry.get(id).id === id)
                ids.push(id);
        }
        return ids;
    }
    // ---------- 生命 ----------
    damage(amount, cause = '未知', useIframes = true) {
        if (!this.isSurvival || this.dead || amount <= 0)
            return false;
        if (useIframes) {
            if (this.iframes > 0)
                return false;
            this.iframes = 0.32;
        }
        this.health = Math.max(0, this.health - amount);
        this.events.emit('survival:damage', { amount, health: this.health, cause });
        if (this.health <= 0)
            this.die(cause);
        return true;
    }
    heal(amount) {
        this.health = (0, types_1.clamp)(this.health + amount, 0, exports.MAX_HEALTH);
    }
    die(cause) {
        if (this.dead)
            return;
        this.dead = true;
        this.deathCause = cause;
        this.events.emit('survival:death', { cause });
    }
    respawn(pos) {
        this.health = exports.MAX_HEALTH;
        this.hunger = exports.MAX_HUNGER;
        this.breath = exports.MAX_BREATH;
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
    exhaust(amount) {
        if (!this.isSurvival)
            return;
        this.exhaustion += amount;
    }
    eat(name) {
        const item = exports.ITEMS[name];
        if (!this.isSurvival || !item?.food)
            return false;
        if (this.hunger >= exports.MAX_HUNGER)
            return false;
        this.hunger = (0, types_1.clamp)(this.hunger + item.food, 0, exports.MAX_HUNGER);
        this.events.emit('survival:eat', { item: name, hunger: this.hunger });
        this.heal(1);
        return true;
    }
    tick(dt, ctx) {
        this.iframes = Math.max(0, this.iframes - dt);
        if (!this.isSurvival) {
            this.health = exports.MAX_HEALTH;
            this.hunger = exports.MAX_HUNGER;
            this.breath = exports.MAX_BREATH;
            return;
        }
        if (this.dead)
            return;
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
        }
        else {
            this.breath = Math.min(exports.MAX_BREATH, this.breath + dt * 4);
            this.drownAcc = 0;
        }
        // 饥饿消耗（疾跑 > 挖掘 > 行走）
        let drain = 0;
        if (ctx.mining)
            drain += 0.09;
        if (ctx.moving)
            drain += ctx.sprinting ? 0.2 : 0.06;
        this.exhaustion += drain * dt;
        while (this.exhaustion >= 4) {
            this.exhaustion -= 4;
            this.hunger = Math.max(0, this.hunger - 1);
        }
        // 饱食回血 / 饥饿掉血
        if (this.hunger >= 18 && this.health < exports.MAX_HEALTH) {
            this.regenAcc += dt;
            if (this.regenAcc >= 4) {
                this.regenAcc = 0;
                this.heal(1);
            }
        }
        else {
            this.regenAcc = 0;
        }
        if (this.hunger <= 0) {
            this.starveAcc += dt;
            if (this.starveAcc >= 4) {
                this.starveAcc = 0;
                this.damage(1, '饥饿', false);
            }
        }
        else {
            this.starveAcc = 0;
        }
    }
    // ---------- 存档 ----------
    serialize() {
        return {
            health: this.health,
            hunger: this.hunger,
            breath: this.breath,
            inventory: [...this.inventory.entries()],
            spawn: { ...this.spawn },
        };
    }
    restore(data) {
        if (!data)
            return;
        if (typeof data.health === 'number')
            this.health = (0, types_1.clamp)(data.health, 0, exports.MAX_HEALTH);
        if (typeof data.hunger === 'number')
            this.hunger = (0, types_1.clamp)(data.hunger, 0, exports.MAX_HUNGER);
        if (typeof data.breath === 'number')
            this.breath = (0, types_1.clamp)(data.breath, 0, exports.MAX_BREATH);
        if (Array.isArray(data.inventory)) {
            this.inventory.clear();
            for (const [k, v] of data.inventory) {
                if (typeof k === 'string' && typeof v === 'number' && v > 0)
                    this.inventory.set(k, v);
            }
        }
        if (data.spawn)
            this.spawn = { ...data.spawn };
        this.dead = this.health <= 0;
    }
    resetInventory() {
        this.inventory.clear();
    }
}
exports.SurvivalState = SurvivalState;
