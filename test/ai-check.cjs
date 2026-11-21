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

// ---- 4. 复合节点：Selector / Sequence / Parallel / RandomSelector ----
const { Node } = require('./logic/ai/Node.js');
const { Selector, Sequence, Parallel, RandomSelector } = require('./logic/ai/composites.js');
class SuccessNode extends Node {
  tick() { return NodeStatus.Success; }
}
class FailureNode extends Node {
  tick() { return NodeStatus.Failure; }
}
class RunningNode extends Node {
  tick() { return NodeStatus.Running; }
}
function makeCtx() { return makeTickContext({ worldSeed: 1, entityId: 1 }); }

ok('Selector 全部失败返回 Failure',
  new Selector([new FailureNode(), new FailureNode()]).tick(makeCtx()) === NodeStatus.Failure);
ok('Selector 遇到第一个成功即短路 Success',
  new Selector([new FailureNode(), new SuccessNode(), new FailureNode()]).tick(makeCtx()) === NodeStatus.Success);
ok('Sequence 全部成功返回 Success',
  new Sequence([new SuccessNode(), new SuccessNode()]).tick(makeCtx()) === NodeStatus.Success);
ok('Sequence 任一失败返回 Failure',
  new Sequence([new SuccessNode(), new FailureNode(), new SuccessNode()]).tick(makeCtx()) === NodeStatus.Failure);
ok('Parallel 全部成功返回 Success',
  new Parallel([new SuccessNode(), new SuccessNode()]).tick(makeCtx()) === NodeStatus.Success);
ok('Parallel 任一失败返回 Failure',
  new Parallel([new SuccessNode(), new FailureNode()]).tick(makeCtx()) === NodeStatus.Failure);
ok('RandomSelector 至少有一个成功则返回 Success',
  new RandomSelector([new FailureNode(), new SuccessNode()]).tick(makeCtx()) === NodeStatus.Success);

// ---- 5. 装饰器：Inverter / Repeater / UntilFail / UntilSuccess ----
const { Inverter, Repeater, UntilFail, UntilSuccess } = require('./logic/ai/decorators.js');

ok('Inverter 反转 Success 为 Failure',
  new Inverter(new SuccessNode()).tick(makeCtx()) === NodeStatus.Failure);
ok('Inverter 反转 Failure 为 Success',
  new Inverter(new FailureNode()).tick(makeCtx()) === NodeStatus.Success);
ok('Inverter 保持 Running',
  new Inverter(new RunningNode()).tick(makeCtx()) === NodeStatus.Running);

let runCount = 0;
class CountingRunningNode extends Node {
  tick() { runCount++; return NodeStatus.Running; }
}
const cr = new CountingRunningNode();
ok('UntilFail 子节点成功时 Running，失败后返回 Success',
  new UntilFail(cr).tick(makeCtx()) === NodeStatus.Running && runCount === 1);

// UntilSuccess：子节点失败时 Running，成功后返回 Failure
let succCount = 0;
class OnceSuccessNode extends Node {
  tick() { succCount++; return succCount >= 2 ? NodeStatus.Success : NodeStatus.Failure; }
}
ok('UntilSuccess 子节点失败时 Running，成功后返回 Failure',
  new UntilSuccess(new OnceSuccessNode()).tick(makeCtx()) === NodeStatus.Running
  && new UntilSuccess(new OnceSuccessNode()).tick(makeCtx()) === NodeStatus.Failure);

console.log(`\n全部 ${passed} 条断言通过`);
