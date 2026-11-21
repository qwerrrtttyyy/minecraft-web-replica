/**
 * 可见悬浮掉落物纯逻辑回归（不需要 WebGL / 浏览器运行时）。
 * 运行：npm run test:drop（需先 npm run test:snapshot）
 *
 * 覆盖：确定性散开、拾取半径 / 延迟边界、同类合并异类不合并、超时与掉出世界、
 * 入水终端下沉与水平衰减、出水恢复重力，以及暂停不推进 age。
 * 对应设计文档 §8 与 Review Focus（合并口径 / 入水出水与边界 / 暂停计时）。
 */
const assert = require('node:assert');
const {
  scatterOffset, canPickup, mergeKey, dropsMerge, shouldDespawn, advanceWater,
} = require('./logic/world/dropLogic.js');
const { DROPS } = require('./logic/core/tuning.js');

const log = (...a) => console.log(...a);
let passed = 0;
function ok(name, cond, extra = '') {
  assert.ok(cond, `${name} ${extra}`);
  passed++;
  log(`PASS  ${name}${extra ? ' — ' + extra : ''}`);
}
function deepEqual(a, b) {
  try { assert.deepStrictEqual(a, b); return true; } catch { return false; }
}

log('可见掉落物回归');

// ---- 1. Review Focus：确定性散开（无新增 Math.random）----
ok('同 seed+source+index 散开可复现',
  deepEqual(scatterOffset(7, 'b:1,2,3', 0), scatterOffset(7, 'b:1,2,3', 0)));
ok('不同 seed / source / index 散开不同',
  !deepEqual(scatterOffset(7, 'b:1,2,3', 0), scatterOffset(8, 'b:1,2,3', 0))
  && !deepEqual(scatterOffset(7, 'b:1,2,3', 0), scatterOffset(7, 'b:1,2,4', 0))
  && !deepEqual(scatterOffset(7, 'b:1,2,3', 0), scatterOffset(7, 'b:1,2,3', 1)));

// ---- 2. 拾取半径与延迟边界 ----
ok('拾取半径与延迟边界',
  canPickup({ x: 0, y: 0, z: 0, age: 0.4 }, { x: 1.19, y: 0, z: 0 })
  && !canPickup({ x: 0, y: 0, z: 0, age: 0.39 }, { x: 1.19, y: 0, z: 0 })
  && !canPickup({ x: 0, y: 0, z: 0, age: 1 }, { x: 1.21, y: 0, z: 0 }));

// ---- 3. Review Focus：掉落物合并口径（同类合并 / 异类不合并）----
ok('同类合并异类不合并',
  mergeKey('item:beef', 2) === mergeKey('item:beef', 3)
  && mergeKey('item:beef', 2) !== mergeKey('item:porkchop', 2));
ok('dropsMerge 同键近距离合并，异键 / 远距离不合并',
  dropsMerge({ name: 'item:beef', count: 1, x: 0, y: 5, z: 0 },
    { name: 'item:beef', count: 2, x: 0.5, y: 5, z: 0 })
  && !dropsMerge({ name: 'item:beef', count: 1, x: 0, y: 5, z: 0 },
    { name: 'item:porkchop', count: 2, x: 0.5, y: 5, z: 0 })
  && !dropsMerge({ name: 'item:beef', count: 1, x: 0, y: 5, z: 0 },
    { name: 'item:beef', count: 2, x: 2, y: 5, z: 0 }));

// ---- 4. 超时与掉出世界消失 ----
ok('超时与掉出世界消失',
  shouldDespawn({ age: 300, y: 5 }) && shouldDespawn({ age: 1, y: -1 })
  && !shouldDespawn({ age: 299, y: 5 }));

// ---- 5. Review Focus：入水终端下沉与水平衰减 ----
const inWater = advanceWater({ vx: 1, vy: -20, vz: 0 }, 0.05, true);
ok('入水终端下沉与水平衰减',
  inWater.vy === -DROPS.waterSink
  && Math.abs(inWater.vx - Math.exp(-8 * 0.05)) < 1e-9
  && Math.abs(inWater.vz) < 1e-9);

// ---- 6. 出水恢复重力 ----
ok('出水恢复重力',
  advanceWater({ vx: 1, vy: -0.6, vz: 0 }, 0.05, false).vy < -0.6);

// ---- 7. Review Focus：暂停不推进 age（dt=0.05 不能靠帧累积绕过）----
const THREE = require('three');
const { DropManager } = require('./logic/entity/droppedItem.js');
const scene = { add() {}, remove() {} };
const atlas = {
  texture: null,
  makeItemGeometry() { return new THREE.BufferGeometry(); },
  makeBlockGeometry() { return new THREE.BufferGeometry(); },
};
const manager = new DropManager({ scene, atlas, seed: 7, world: {}, onPickup() {} });
manager.spawn('item:beef', 1, 0, 5, 0);
const ageBefore = manager.items[0].age;
manager.update(0.05, { x: 0, y: 5, z: 0 }, false);
ok('暂停不推进 age', manager.items.length === 1 && manager.items[0].age === ageBefore);

log(`\n${passed} 项通过`);
