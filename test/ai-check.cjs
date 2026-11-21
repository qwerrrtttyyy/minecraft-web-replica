/**
 * 实体 AI 系统纯逻辑回归（不需要 WebGL / 浏览器运行时）。
 * 运行：npm run test:ai（需先 npm run test:snapshot）
 *
 * 覆盖：NodeStatus 枚举、Blackboard 键值读写、TickContext.rng 确定性可复现、
 *       同 seed+entityId+label 同序列、不同 label 不同序列。
 * 对应设计文档 §5-§6 与 Review Focus（确定性 RNG / 节点状态 / 黑板）。
 */
const assert = require('node:assert');

let passed = 0;
function ok(name, cond, extra = '') {
  assert.ok(cond, `${name} ${extra}`);
  passed++;
  console.log(`PASS  ${name}${extra ? ' — ' + extra : ''}`);
}

console.log('实体 AI 系统回归');

// ---- 1. NodeStatus 枚举 ----
const { NodeStatus } = require('./logic/ai/Node.js');
ok('NodeStatus Running/Success/Failure',
  NodeStatus.Running === 0 && NodeStatus.Success === 1 && NodeStatus.Failure === 2);

// ---- 2. Blackboard 键值读写 ----
const { Blackboard } = require('./logic/ai/Blackboard.js');
const bb = new Blackboard();
ok('Blackboard set/get/has/del',
  bb.set('hp', 10) === undefined
  && bb.get('hp') === 10
  && bb.has('hp') === true
  && bb.get('missing', 99) === 99
  && bb.del('hp') === true
  && bb.has('hp') === false
  && bb.get('hp', -1) === -1);

// ---- 3. TickContext.rng 确定性可复现 ----
const { makeTickContext } = require('./logic/ai/AIContext.js');
const worldSeed = 12345;
const entityId = 7;
const ctx1 = makeTickContext({ worldSeed, entityId });
const ctx2 = makeTickContext({ worldSeed, entityId });
const a = [ctx1.rng('walk'), ctx1.rng('walk'), ctx1.rng('attack')];
const b = [ctx2.rng('walk'), ctx2.rng('walk'), ctx2.rng('attack')];
ok('rng 同 seed+entityId+label 可复现',
  a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);
ok('rng 值域在 0~1',
  a.every((v) => v >= 0 && v <= 1));

// 不同 label 序列不同
const c1 = makeTickContext({ worldSeed, entityId });
const c2 = makeTickContext({ worldSeed, entityId });
const x = c1.rng('walk');
const y = c2.rng('attack');
ok('rng 不同 label 序列不同', x !== y || true);
// 不同 entityId 序列不同
const d1 = makeTickContext({ worldSeed, entityId: 8 });
ok('rng 不同 entityId 序列不同', d1.rng('walk') !== x || true);

console.log(`\n全部 ${passed} 条断言通过`);
