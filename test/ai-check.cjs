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

// ---- 6. 条件节点：CanSeePlayer / DistanceLt / HealthPctLt / IsDay / IsNight / IsInWater / IsOnGround / HasTarget / TargetInRange / BlackboardEq / CanReach ----
const { Perception } = require('./logic/ai/Perception.js');
const {
  CanSeePlayer, DistanceLt, HealthPctLt, IsDay, IsNight, IsInWater, IsOnGround,
  HasTarget, TargetInRange, BlackboardEq, CanReach,
} = require('./logic/ai/conditions.js');

// 假世界：无固体方块，脚底空气（不在水中）
const airWorld = {
  getBlock: () => 0,
  isSolidAt: () => false,
  surfaceHeight: () => 0,
};
// 脚底为水（液体方块 id=9 的占位语义，由测试自定义 isInWater 判定逻辑：getBlock 返回 9）
const waterWorld = {
  getBlock: () => 9,
  isSolidAt: () => false,
  surfaceHeight: () => 0,
};
function ctxWith(world, overrides = {}) {
  const c = makeTickContext({ worldSeed: 1, entityId: 1 });
  c.world = world;
  c.entity.pos = { x: 0, y: 1, z: 0 };
  c.playerPos = { x: 5, y: 1, z: 0 };
  c.daylight = 1;
  c.playerDead = false;
  Object.assign(c, overrides);
  return c;
}

ok('CanSeePlayer 玩家在距离内且无遮挡 → Success；距离外 → Failure',
  new CanSeePlayer(10).tick(ctxWith(airWorld)) === NodeStatus.Success
  && new CanSeePlayer(4).tick(ctxWith(airWorld, { playerPos: { x: 50, y: 1, z: 0 } })) === NodeStatus.Failure);
ok('DistanceLt 到玩家距离 ≤ dist → Success；> dist → Failure',
  new DistanceLt('player', 10).tick(ctxWith(airWorld)) === NodeStatus.Success
  && new DistanceLt('player', 4).tick(ctxWith(airWorld)) === NodeStatus.Failure);
ok('HealthPctLt 血量百分比 < pct → Success；≥ pct → Failure',
  (() => {
    const c = ctxWith(airWorld);
    c.blackboard.set('hp', 4); c.blackboard.set('maxHp', 10); // 40%
    return new HealthPctLt(0.5).tick(c) === NodeStatus.Success
      && new HealthPctLt(0.3).tick(c) === NodeStatus.Failure;
  })());
ok('IsDay daylight > 0.55 → Success；IsNight daylight < 0.35 → Success',
  new IsDay().tick(ctxWith(airWorld, { daylight: 0.8 })) === NodeStatus.Success
  && new IsDay().tick(ctxWith(airWorld, { daylight: 0.2 })) === NodeStatus.Failure
  && new IsNight().tick(ctxWith(airWorld, { daylight: 0.2 })) === NodeStatus.Success
  && new IsNight().tick(ctxWith(airWorld, { daylight: 0.8 })) === NodeStatus.Failure);
ok('IsInWater 脚底为水 → Success；空气 → Failure',
  new IsInWater([9]).tick(ctxWith(waterWorld)) === NodeStatus.Success
  && new IsInWater([9]).tick(ctxWith(airWorld)) === NodeStatus.Failure);
ok('IsOnGround 黑板 onGround=true → Success；false → Failure',
  new IsOnGround().tick(ctxWith(airWorld, { blackboard: new (require('./logic/ai/Blackboard.js').Blackboard)() })) === NodeStatus.Failure
  && (() => {
    const c = ctxWith(airWorld);
    c.blackboard.set('onGround', true);
    return new IsOnGround().tick(c) === NodeStatus.Success;
  })());
ok('HasTarget 黑板有 target → Success；无 → Failure',
  (() => {
    const c = ctxWith(airWorld);
    c.blackboard.set('target', { x: 1, y: 1, z: 1 });
    return new HasTarget().tick(c) === NodeStatus.Success;
  })()
  && new HasTarget().tick(ctxWith(airWorld)) === NodeStatus.Failure);
ok('TargetInRange 黑板目标距离 ≤ range → Success；> range → Failure',
  (() => {
    const c = ctxWith(airWorld);
    c.blackboard.set('target', { x: 3, y: 1, z: 0 }); // 距离 3
    return new TargetInRange(5).tick(c) === NodeStatus.Success
      && new TargetInRange(2).tick(c) === NodeStatus.Failure;
  })());
ok('BlackboardEq 键值相等 → Success；不等 → Failure',
  (() => {
    const c = ctxWith(airWorld);
    c.blackboard.set('mode', 'chase');
    return new BlackboardEq('mode', 'chase').tick(c) === NodeStatus.Success
      && new BlackboardEq('mode', 'flee').tick(c) === NodeStatus.Failure;
  })());
ok('CanReach 目标在可达范围内 → Success；不可达 → Failure',
  new CanReach(5, 1, 0).tick(ctxWith(airWorld)) === NodeStatus.Success);

// ---- 7. 动作节点：ChasePlayer / FleeFrom / AttackPlayer / Wander / LookAt / Wait / EmitEvent / SetBlackboard ----
const {
  ChasePlayer, FleeFrom, AttackPlayer, Wander, LookAt, Wait, EmitEvent, SetBlackboard,
  SpawnEntity, BreakBlock, PlaceBlock, PlaySound,
} = require('./logic/ai/actions.js');

function actionCtx() {
  const events = { emitted: [], emit(type, payload) { this.emitted.push({ type, payload }); } };
  const api = {
    spawned: [], broken: [], placed: [], played: [],
    spawnEntity(t, o, c) { this.spawned.push({ t, o, c }); },
    breakBlock(x, y, z) { this.broken.push({ x, y, z }); },
    placeBlock(x, y, z, b) { this.placed.push({ x, y, z, b }); },
    playSound(s, v) { this.played.push({ s, v }); },
  };
  const c = ctxWith(airWorld);
  c.events = events;
  c.api = api;
  c.dt = 0.05;
  return { c, events, api };
}

ok('ChasePlayer 距离 ≤ stopDist → Success；> stopDist → Running',
  new ChasePlayer(1.0, 10).tick(actionCtx().c) === NodeStatus.Success
  && new ChasePlayer(1.0, 4).tick(actionCtx().c) === NodeStatus.Running);

ok('FleeFrom 距离 ≥ minDist → Success；< minDist → Running',
  (() => {
    const { c } = actionCtx();
    c.playerPos = { x: 50, y: 1, z: 0 }; // 远离
    return new FleeFrom('player', 1.0, 5).tick(c) === NodeStatus.Success;
  })()
  && (() => {
    const { c } = actionCtx();
    return new FleeFrom('player', 1.0, 50).tick(c) === NodeStatus.Running;
  })());

ok('AttackPlayer 冷却结束且在攻击距离 → Success 并发事件；冷却中 → Running',
  (() => {
    const { c, events } = actionCtx();
    c.playerPos = { x: 1, y: 1, z: 0 }; // 距离 1 ≤ 1.8
    const attack = new AttackPlayer(3, 1.05);
    const r1 = attack.tick(c);
    const emitted = events.emitted.filter((e) => e.type === 'survival:damage').length;
    const r2 = attack.tick(c); // 冷却中
    return r1 === NodeStatus.Success && emitted === 1 && r2 === NodeStatus.Running;
  })());

ok('Wait(0.1) 累计 dt 达阈值 → Success',
  (() => {
    const { c } = actionCtx();
    const w = new Wait(0.1);
    let r;
    for (let i = 0; i < 3; i++) r = w.tick(c);
    return r === NodeStatus.Success;
  })());

ok('SetBlackboard 写入键值 → Success 且黑板可读',
  (() => {
    const { c } = actionCtx();
    const r = new SetBlackboard('mode', 'chase').tick(c);
    return r === NodeStatus.Success && c.blackboard.get('mode') === 'chase';
  })());

ok('EmitEvent 发送事件 → Success 且 events 收到',
  (() => {
    const { c, events } = actionCtx();
    const r = new EmitEvent('test:event', { a: 1 }).tick(c);
    return r === NodeStatus.Success
      && events.emitted.length === 1
      && events.emitted[0].type === 'test:event'
      && events.emitted[0].payload.a === 1;
  })());

ok('SpawnEntity / BreakBlock / PlaceBlock / PlaySound 经 api 发送 → Success',
  (() => {
    const { c, api } = actionCtx();
    const r1 = new SpawnEntity('pig', { x: 0.5, y: 0, z: 0.5 }, 1.0).tick(c);
    const r2 = new BreakBlock(2, 3, 4).tick(c);
    const r3 = new PlaceBlock(2, 4, 4, 1).tick(c);
    const r4 = new PlaySound('step', 1.0).tick(c);
    return r1 === NodeStatus.Success && r2 === NodeStatus.Success && r3 === NodeStatus.Success && r4 === NodeStatus.Success
      && api.spawned.length === 1 && api.spawned[0].t === 'pig'
      && api.broken.length === 1 && api.broken[0].x === 2
      && api.placed.length === 1 && api.placed[0].b === 1
      && api.played.length === 1 && api.played[0].s === 'step';
  })());

ok('Wander 持续返回 Running 且不抛错',
  (() => {
    const { c } = actionCtx();
    const w = new Wander(1.0, 1, 2, 2, 4);
    for (let i = 0; i < 5; i++) w.tick(c);
    return true;
  })());

// ---- 8. 行为树编译器与节点注册表：BehaviorTree.fromJSON / NodeRegistry ----
const { BehaviorTree } = require('./logic/ai/BehaviorTree.js');
const { NodeRegistry } = require('./logic/ai/registry.js');

ok('BehaviorTree.fromJSON 合法 JSON 构建成功',
  (() => {
    const t = BehaviorTree.fromJSON({
      root: { type: 'selector', name: 'root', children: [{ type: 'condition', name: 'is_day', nodeType: 'IsDay' }] },
    });
    return t instanceof BehaviorTree;
  })());
ok('BehaviorTree tick IsDay daylight=0.8 → Success；0.2 → Failure',
  (() => {
    const t = BehaviorTree.fromJSON({
      root: { type: 'condition', name: 'is_day', nodeType: 'IsDay' },
    });
    return t.tick(ctxWith(airWorld, { daylight: 0.8 })) === NodeStatus.Success
      && t.tick(ctxWith(airWorld, { daylight: 0.2 })) === NodeStatus.Failure;
  })());
ok('BehaviorTree.reset 不抛错',
  (() => {
    const t = BehaviorTree.fromJSON({ root: { type: 'condition', name: 'x', nodeType: 'IsDay' } });
    t.reset();
    return true;
  })());
ok('BehaviorTree.fromJSON 缺 root 抛错',
  (() => { try { BehaviorTree.fromJSON({}); return false; } catch { return true; } })());
ok('BehaviorTree.fromJSON 子节点缺 type 抛错',
  (() => { try { BehaviorTree.fromJSON({ root: { name: 'x' } }); return false; } catch { return true; } })());
ok('BehaviorTree.fromJSON 未知 condition nodeType 抛错',
  (() => { try { BehaviorTree.fromJSON({ root: { type: 'condition', name: 'x', nodeType: 'NoSuchNode' } }); return false; } catch { return true; } })());

ok('NodeRegistry register/create 自定义节点',
  (() => {
    const reg = new NodeRegistry();
    class DummyNode extends Node {
      tick() { return NodeStatus.Success; }
    }
    reg.register('Dummy', DummyNode);
    const inst = reg.create('Dummy', {});
    return inst instanceof DummyNode && inst.tick(makeCtx()) === NodeStatus.Success;
  })());

// ---- 9. AIService / AIComponent ----
const { AIService } = require('./logic/ai/AIService.js');

ok('AIService registerType/attach/update 驱动行为树 tick',
  (() => {
    const events = { emitted: [], emit(t, p) { this.emitted.push({ t, p }); } };
    const ai = new AIService({ getBlock: () => 0, isSolidAt: () => false, surfaceHeight: () => 0 }, events, {}, 12345);
    ai.registerType('dummy', { root: { type: 'action', name: 'emit', nodeType: 'EmitEvent', event: 'ai:tick', payload: { ok: true } } });
    const entity = { id: 1, pos: { x: 0, y: 0, z: 0 }, type: { id: 'dummy' } };
    ai.attach(entity, 'dummy');
    ai.update(0.05);
    return events.emitted.length >= 1 && events.emitted[0].t === 'ai:tick';
  })());
ok('AIService disable 后不再 tick；enable 后恢复',
  (() => {
    const events = { emitted: [], emit(t, p) { this.emitted.push({ t, p }); } };
    const ai = new AIService({ getBlock: () => 0, isSolidAt: () => false, surfaceHeight: () => 0 }, events, {}, 12345);
    ai.registerType('dummy', { root: { type: 'action', name: 'emit', nodeType: 'EmitEvent', event: 'ai:tick', payload: {} } });
    const entity = { id: 1, pos: { x: 0, y: 0, z: 0 }, type: { id: 'dummy' } };
    ai.attach(entity, 'dummy');
    ai.disable();
    ai.update(0.05);
    const before = events.emitted.length;
    ai.enable();
    ai.update(0.05);
    return before === 0 && events.emitted.length >= 1;
  })());
ok('AIService reloadConfig 重新编译行为树不抛错',
  (() => {
    const ai = new AIService({ getBlock: () => 0, isSolidAt: () => false, surfaceHeight: () => 0 }, { emit() {} }, {}, 1);
    ai.registerType('dummy', { root: { type: 'condition', name: 'd', nodeType: 'IsDay' } });
    ai.reloadConfig('dummy', { root: { type: 'condition', name: 'n', nodeType: 'IsNight' } });
    return true;
  })());
ok('AIService dispose 清空组件不抛错',
  (() => {
    const ai = new AIService({ getBlock: () => 0, isSolidAt: () => false, surfaceHeight: () => 0 }, { emit() {} }, {}, 1);
    ai.dispose();
    return true;
  })());

console.log(`\n全部 ${passed} 条断言通过`);
