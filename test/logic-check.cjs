const assert = require('assert');
const { SurvivalState, ITEMS, MAX_HUNGER } = require('./logic/player/survival.js');
const { EventBus } = require('./logic/core/events.js');

const registry = {
  get: (id) => ({ id, name: id === 5 ? 'dirt' : 'air' }),
  byNameGet: (n) => (n === 'dirt' ? { id: 5 } : undefined),
};
const ev = new EventBus();
const s = new SurvivalState(ev, registry);
let changes = 0;
ev.on('inventory:change', () => changes++);

// P1-9: give('apple') / count('apple') 现在必须可用
s.addDrop('apple', 3);
assert.equal(s.countKey('i:apple'), 3, 'give(apple) should add 3');
s.addDrop('item:porkchop', 2);
assert.equal(s.countKey('i:porkchop'), 2);
s.addDrop('dirt', 4);
assert.equal(s.countKey('b:5'), 4);
assert.ok(changes === 3, 'inventory:change emitted');

// consume 顺序：先扣再生效
const stack = { kind: 'item', id: 'apple' };
assert.equal(s.consume(stack, 1), true);
assert.equal(s.countKey('i:apple'), 2);
assert.equal(s.consume(stack, 99), false, 'insufficient stack must fail');
assert.equal(s.countKey('i:apple'), 2, 'failed consume must not change count');

// 饥饿满时 eat 返回 false，物品不应被扣
s.hunger = MAX_HUNGER;
assert.equal(s.eat('apple'), false);
assert.equal(s.countKey('i:apple'), 2);

// 伤害无敌帧与死亡
assert.equal(s.damage(4, 'test'), true);
assert.equal(s.health, 16);
assert.equal(s.damage(4, 'test'), false, 'iframes should block');
s.health = 1; s.iframes = 0;
assert.equal(s.damage(5, 'fatal'), true);
assert.equal(s.dead, true);

// 序列化 / 恢复
s.health = 12; s.dead = false;
const snap = s.serialize();
const s2 = new SurvivalState(new EventBus(), registry);
s2.restore(snap);
assert.equal(s2.health, 12);
assert.equal(s2.countKey('i:apple'), 2);
assert.equal(s2.countKey('b:5'), 4);
assert.equal(s2.dead, false);

// tick：饥饿消耗与氧气
const s3 = new SurvivalState(new EventBus(), registry);
s3.mode = 'survival';
for (let i = 0; i < 200; i++) s3.tick(0.1, { moving: true, sprinting: true, mining: false, underwater: false });
assert.ok(s3.hunger < MAX_HUNGER, 'sprinting should drain hunger');
for (let i = 0; i < 200; i++) s3.tick(0.1, { moving: false, sprinting: false, mining: false, underwater: true });
assert.equal(s3.breath, 0, 'breath should deplete underwater');

console.log('PASS 生存状态机纯逻辑回归：addDrop/count/consume/eat/damage/iframes/serialize/tick 共 8 组断言');
