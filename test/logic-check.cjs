const assert = require('node:assert');
const { SurvivalState, MAX_HUNGER } = require('./logic/player/survival.js');
const { EventBus } = require('./logic/core/events.js');
const { rollDrops } = require('./logic/world/drops.js');

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
s.health = 1;
s.iframes = 0;
assert.equal(s.damage(5, 'fatal'), true);
assert.equal(s.dead, true);

// 序列化 / 恢复
s.health = 12;
s.dead = false;
const snap = s.serialize();
const s2 = new SurvivalState(new EventBus(), registry);
s2.restore(snap);
assert.equal(s2.health, 12);
assert.equal(s2.countKey('i:apple'), 2);
assert.equal(s2.countKey('b:5'), 4);
assert.equal(s2.dead, false);

// tick：饥饿消耗与氧气（饱和度缓冲：先扣 saturation，hunger 暂不变）
const s3 = new SurvivalState(new EventBus(), registry);
s3.mode = 'survival';
for (let i = 0; i < 200; i++) s3.tick(0.1, { moving: true, sprinting: true, mining: false, underwater: false });
assert.ok(s3.saturation < MAX_HUNGER, 'sprinting should drain saturation first');
assert.equal(s3.hunger, MAX_HUNGER, 'saturation buffer should keep hunger unchanged');
for (let i = 0; i < 200; i++) s3.tick(0.1, { moving: false, sprinting: false, mining: false, underwater: true });
assert.equal(s3.breath, 0, 'breath should deplete underwater');

// 饱和度：进食叠加 / 上限 / exhaustion 顺序 / 回血门槛 / 存档往返
{
  const s = new SurvivalState(new EventBus(), registry);
  s.hunger = 10;
  s.saturation = 0;
  assert.equal(s.eat('apple'), true);
  assert.equal(s.hunger, 14);
  assert.equal(s.saturation, 2.4, 'eat adds saturation');

  const capped = new SurvivalState(new EventBus(), registry);
  capped.hunger = 4;
  capped.saturation = 8;
  capped.eat('porkchop');
  assert.equal(capped.hunger, 10);
  assert.equal(capped.saturation, 10, 'saturation must not exceed current hunger');

  const dry = new SurvivalState(new EventBus(), registry);
  dry.hunger = 20;
  dry.saturation = 0;
  for (let i = 0; i < 250; i++) dry.tick(0.1, { moving: true, sprinting: true, mining: false, underwater: false });
  assert.equal(dry.saturation, 0);
  assert.equal(dry.hunger, 19, 'exhaustion drains hunger once saturation is empty');

  const noSat = new SurvivalState(new EventBus(), registry);
  noSat.health = 10;
  noSat.hunger = 19;
  noSat.saturation = 0;
  let heals = 0;
  const origHeal = noSat.heal.bind(noSat);
  noSat.heal = (a) => {
    heals++;
    origHeal(a);
  };
  for (let i = 0; i < 200; i++) noSat.tick(0.1, { moving: false, sprinting: false, mining: false, underwater: false });
  assert.equal(heals, 0, 'regen requires saturation > 0');
  assert.equal(noSat.health, 10);

  const s4 = new SurvivalState(new EventBus(), registry);
  s4.hunger = 12;
  s4.saturation = 3.2;
  const snap = s4.serialize();
  assert.equal(snap.saturation, 3.2);
  const s5 = new SurvivalState(new EventBus(), registry);
  s5.restore(snap);
  assert.equal(s5.saturation, 3.2, 'saturation round-trips through save');
  const s6 = new SurvivalState(new EventBus(), registry);
  s6.saturation = 5;
  s6.restore({ health: 10, hunger: 10, breath: 15, inventory: [], spawn: { x: 0, y: 40, z: 0 } });
  assert.equal(s6.saturation, MAX_HUNGER, 'legacy save without saturation restores to MAX_HUNGER');
}

// 确定性掉落（P02）：同 seed+source 可复现，概率 / 数量区间 / 条件可测
{
  const specs = [
    { name: 'item:apple', chance: 0.5 },
    { name: 'item:fertilizer', chance: 1, min: 2, max: 4 },
  ];
  const ctx = { seed: 20261115, source: 'b:3,20,5' };
  assert.deepEqual(rollDrops(specs, ctx), rollDrops(specs, ctx), 'same seed+source must produce identical drops');
  assert.ok(rollDrops([{ name: 'x', chance: 0 }], ctx).length === 0, 'chance 0 drops nothing');
  assert.ok(rollDrops([{ name: 'x', chance: 1 }], ctx).length === 1, 'chance 1 always drops');
  const counts = [];
  for (let i = 0; i < 60; i++) {
    const got = rollDrops([{ name: 'x', chance: 1, min: 2, max: 4 }], { ...ctx, source: `b:${i},0,0` });
    counts.push(got[0].count);
  }
  assert.ok(
    counts.every((c) => c >= 2 && c <= 4),
    'count range must be respected',
  );
  assert.ok(new Set(counts).size > 1, 'count range must actually vary');
  assert.ok(
    rollDrops([{ name: 'x', chance: 1, nightOnly: true }], { ...ctx, daylight: 1 }).length === 0,
    'nightOnly must not drop in daylight',
  );
  assert.ok(
    rollDrops([{ name: 'x', chance: 1, biome: 'forest' }], { ...ctx, biome: 'plains' }).length === 0,
    'biome condition must filter',
  );
}

console.log(
  'PASS 生存状态机纯逻辑回归：addDrop/count/consume/eat/damage/iframes/serialize/tick/确定性掉落 共 9 组断言',
);
