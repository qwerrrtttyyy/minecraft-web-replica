/**
 * AABB 脱困纯逻辑回归（不依赖 three / World，可直接跑 Node）。
 *
 * 运行：node test/unstuck-check.cjs
 *
 * 验证：
 * 1. 相交方块收集与「贴边不算重叠」的 EPS 语义；
 * 2. 单方块嵌入时求出最小位移并完全脱离；
 * 3. 被实心块包围时能在有界迭代内脱出；
 * 4. 病态地形（全空间实心）不死循环、位移有界、如实返回 resolved=false；
 * 5. 纯函数语义：不修改传入的 pos。
 */
const assert = require('node:assert');
const { overlappingBlocks, isStuck, resolvePenetration } = require('./logic/player/unstuck.js');

const WIDTH = 0.6;
const HEIGHT = 1.8;
let passed = 0;
const ok = (name, cond, extra = '') => {
  assert.ok(cond, `${name}${extra ? ' — ' + extra : ''}`);
  passed++;
  console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
};

const air = () => false;
const solidAt = (x, y, z) => x === 0 && y === 0 && z === 0;

console.log('AABB 脱困回归（最小贯穿量 / 有界迭代 / 纯函数）');
console.log('\n[1] 相交检测与边界语义');

{
  ok('全空气世界不判定卡住', !isStuck({ x: 0.5, y: 10, z: 0.5 }, WIDTH, HEIGHT, air));
  const blocks = overlappingBlocks({ x: 0.5, y: 0, z: 0.5 }, WIDTH, HEIGHT, solidAt);
  ok('单方块嵌入：收集到相交方块坐标', blocks.length === 3 && blocks[0] === 0 && blocks[1] === 0 && blocks[2] === 0,
    JSON.stringify(blocks));
  ok('单方块嵌入：isStuck 为真', isStuck({ x: 0.5, y: 0, z: 0.5 }, WIDTH, HEIGHT, solidAt));
  ok('恰好贴边不算重叠（EPS 收敛）', !isStuck({ x: 1.3, y: 0, z: 0.5 }, WIDTH, HEIGHT, solidAt));
  ok('方块正上方一格不算重叠', !isStuck({ x: 0.5, y: 1.0, z: 0.5 }, WIDTH, HEIGHT, solidAt));
  ok('未生成区块视为空气（远处不误判）', !isStuck({ x: 999, y: 40, z: 999 }, WIDTH, HEIGHT, solidAt));
}

console.log('\n[2] 最小贯穿量求解');

{
  const pos = { x: 0.5, y: 0, z: 0.5 };
  const snapshot = { ...pos };
  const r = resolvePenetration(pos, WIDTH, HEIGHT, solidAt);
  ok('单方块嵌入成功脱困', r.moved && r.resolved, `iter=${r.iterations} d=(${r.dx.toFixed(2)},${r.dy.toFixed(2)},${r.dz.toFixed(2)})`);
  ok('脱困后位置确实不再相交', !isStuck(r, WIDTH, HEIGHT, solidAt));
  ok('位移为最小贯穿量（< 2 格）', Math.hypot(r.dx, r.dy, r.dz) < 2,
    `dist=${Math.hypot(r.dx, r.dy, r.dz).toFixed(3)}`);
  ok('单轮即可求解', r.iterations <= 2, `iter=${r.iterations}`);
  ok('位移增量与起终点自洽',
    Math.abs(r.x - (pos.x + r.dx)) < 1e-9 && Math.abs(r.y - (pos.y + r.dy)) < 1e-9 && Math.abs(r.z - (pos.z + r.dz)) < 1e-9);
  ok('不修改传入的 pos（纯函数）',
    pos.x === snapshot.x && pos.y === snapshot.y && pos.z === snapshot.z);
  ok('无卡住时不移动且 resolved=true', (() => {
    const q = resolvePenetration({ x: 10, y: 40, z: 10 }, WIDTH, HEIGHT, air);
    return !q.moved && q.resolved && q.dx === 0 && q.dy === 0 && q.dz === 0;
  })());
}

console.log('\n[3] 包围 / 病态地形的有界性');

{
  // 3×3×3 实心包围：只有斜向/组合推出才能一次脱出
  const ball = (x, y, z) => Math.abs(x) <= 1 && y >= -1 && y <= 2 && Math.abs(z) <= 1;
  const r = resolvePenetration({ x: 0.5, y: 0, z: 0.5 }, WIDTH, HEIGHT, ball);
  ok('被 3×3×3 实心包围仍能脱出', r.resolved, `iter=${r.iterations} dist=${Math.hypot(r.dx, r.dy, r.dz).toFixed(2)}`);
  ok('包围场景迭代有界（≤10）', r.iterations <= 10, `iter=${r.iterations}`);
  ok('包围场景位移有界（≤128）', Math.hypot(r.dx, r.dy, r.dz) <= 128);
  ok('脱困结果确实脱离实心区', !isStuck(r, WIDTH, HEIGHT, ball));
}
{
  // 全空间实心：无解，但必须有界返回，不能死循环
  const t0 = Date.now();
  const r = resolvePenetration({ x: 0.5, y: 0, z: 0.5 }, WIDTH, HEIGHT, () => true);
  ok('全空间实心如实返回 resolved=false', !r.resolved);
  ok('全空间实心迭代不超过上限', r.iterations <= 10, `iter=${r.iterations}`);
  ok('全空间实心总位移有界', Math.hypot(r.dx, r.dy, r.dz) <= 128,
    `dist=${Math.hypot(r.dx, r.dy, r.dz).toFixed(1)}`);
  ok('全空间实心快速返回（< 1s）', Date.now() - t0 < 1000, `${Date.now() - t0}ms`);
  ok('maxIterations=1 参数生效', (() => {
    const q = resolvePenetration({ x: 0.5, y: 0, z: 0.5 }, WIDTH, HEIGHT, () => true, 1);
    return q.iterations <= 1;
  })());
}

console.log('\n[4] 玩家真实尺寸与多格身体');

{
  // 玩家高 1.8，会同时与 y=0 与 y=1 两格相交；两格都实心时必须一起脱出
  const pillar = (x, y, z) => x === 0 && z === 0 && (y === 0 || y === 1);
  const before = overlappingBlocks({ x: 0.5, y: 0, z: 0.5 }, WIDTH, HEIGHT, pillar);
  ok('1.8 格高的身体同时与上下两格相交', before.length === 6, `blocks=${before.length / 3}`);
  const r = resolvePenetration({ x: 0.5, y: 0, z: 0.5 }, WIDTH, HEIGHT, pillar);
  ok('多格相交也能完全脱出', r.resolved && !isStuck(r, WIDTH, HEIGHT, pillar));
  ok('多格相交位移仍然有界', Math.hypot(r.dx, r.dy, r.dz) < 4,
    `dist=${Math.hypot(r.dx, r.dy, r.dz).toFixed(3)}`);
}

console.log(`\n合计 ${passed} 项全部通过`);
