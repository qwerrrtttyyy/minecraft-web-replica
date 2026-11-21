/**
 * 生存状态机纯逻辑回归（Vitest，直接消费 src TS 源码）。
 * 运行：npm run test:logic:vitest
 * 断言语义与 test/logic-check.cjs 一一对应（迁移，未改动断言行为）。
 */
import { describe, expect, it } from 'vitest';

import { SurvivalState, MAX_HUNGER } from '../src/player/survival';
import { EventBus } from '../src/core/events';
import { rollDrops } from '../src/world/drops';

const registry = {
  get: (id: number) => ({ id, name: id === 5 ? 'dirt' : 'air' }),
  byNameGet: (n: string) => (n === 'dirt' ? { id: 5 } : undefined),
};

describe('生存状态机', () => {
  it('addDrop / countKey / inventory:change 事件', () => {
    const ev = new EventBus();
    const s = new SurvivalState(ev, registry);
    let changes = 0;
    ev.on('inventory:change', () => changes++);

    // P1-9: give('apple') / count('apple') 现在必须可用
    s.addDrop('apple', 3);
    expect(s.countKey('i:apple')).toBe(3);
    s.addDrop('item:porkchop', 2);
    expect(s.countKey('i:porkchop')).toBe(2);
    s.addDrop('dirt', 4);
    expect(s.countKey('b:5')).toBe(4);
    expect(changes).toBe(3);
  });

  it('consume 顺序：先扣再生效；不足时不改变计数', () => {
    const s = new SurvivalState(new EventBus(), registry);
    s.addDrop('apple', 3);
    const stack = { kind: 'item', id: 'apple' };
    expect(s.consume(stack, 1)).toBe(true);
    expect(s.countKey('i:apple')).toBe(2);
    expect(s.consume(stack, 99)).toBe(false);
    expect(s.countKey('i:apple')).toBe(2);
  });

  it('饥饿满时 eat 返回 false，物品不应被扣', () => {
    const s = new SurvivalState(new EventBus(), registry);
    s.addDrop('apple', 2); // 与原脚本一致：进入该场景时苹果为 2
    s.hunger = MAX_HUNGER;
    expect(s.eat('apple')).toBe(false);
    expect(s.countKey('i:apple')).toBe(2);
  });

  it('伤害无敌帧与死亡', () => {
    const s = new SurvivalState(new EventBus(), registry);
    expect(s.damage(4, 'test')).toBe(true);
    expect(s.health).toBe(16);
    expect(s.damage(4, 'test')).toBe(false); // iframes should block
    s.health = 1; s.iframes = 0;
    expect(s.damage(5, 'fatal')).toBe(true);
    expect(s.dead).toBe(true);
  });

  it('序列化 / 恢复', () => {
    const ev = new EventBus();
    const s = new SurvivalState(ev, registry);
    s.addDrop('apple', 3);
    s.addDrop('dirt', 4);
    s.consume({ kind: 'item', id: 'apple' }, 1); // 与原脚本一致：序列化时苹果为 2
    s.damage(4, 'test');
    s.health = 12; s.dead = false;
    const snap = s.serialize();
    const s2 = new SurvivalState(new EventBus(), registry);
    s2.restore(snap);
    expect(s2.health).toBe(12);
    expect(s2.countKey('i:apple')).toBe(2);
    expect(s2.countKey('b:5')).toBe(4);
    expect(s2.dead).toBe(false);
  });

  it('tick：饥饿消耗与氧气', () => {
    const s3 = new SurvivalState(new EventBus(), registry);
    s3.mode = 'survival';
    for (let i = 0; i < 200; i++) s3.tick(0.1, { moving: true, sprinting: true, mining: false, underwater: false });
    expect(s3.hunger).toBeLessThan(MAX_HUNGER);
    for (let i = 0; i < 200; i++) s3.tick(0.1, { moving: false, sprinting: false, mining: false, underwater: true });
    expect(s3.breath).toBe(0);
  });
});

// 确定性掉落（P02）：同 seed+source 可复现，概率 / 数量区间 / 条件可测
describe('确定性掉落 rollDrops', () => {
  const ctx = { seed: 20261115, source: 'b:3,20,5' };
  const specs = [
    { name: 'item:apple', chance: 0.5 },
    { name: 'item:fertilizer', chance: 1, min: 2, max: 4 },
  ];

  it('同 seed+source 必须产出完全一致', () => {
    expect(rollDrops(specs, ctx)).toEqual(rollDrops(specs, ctx));
  });
  it('chance 0 不掉落；chance 1 必掉落', () => {
    expect(rollDrops([{ name: 'x', chance: 0 }], ctx).length).toBe(0);
    expect(rollDrops([{ name: 'x', chance: 1 }], ctx).length).toBe(1);
  });
  it('数量区间 [2,4] 必须遵守且真的会变化', () => {
    const counts: number[] = [];
    for (let i = 0; i < 60; i++) {
      const got = rollDrops([{ name: 'x', chance: 1, min: 2, max: 4 }], { ...ctx, source: `b:${i},0,0` });
      counts.push(got[0].count);
    }
    expect(counts.every((c) => c >= 2 && c <= 4)).toBe(true);
    expect(new Set(counts).size).toBeGreaterThan(1);
  });
  it('nightOnly 白天不掉落', () => {
    expect(rollDrops([{ name: 'x', chance: 1, nightOnly: true }], { ...ctx, daylight: 1 }).length).toBe(0);
  });
  it('biome 条件不满足时不掉落', () => {
    expect(rollDrops([{ name: 'x', chance: 1, biome: 'forest' }], { ...ctx, biome: 'plains' }).length).toBe(0);
  });
});
