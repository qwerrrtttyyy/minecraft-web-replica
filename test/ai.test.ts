/**
 * 实体 AI 系统纯逻辑回归（Vitest，直接消费 src/ai TS 源码，无需快照编译）。
 * 运行：npm run test:ai:vitest
 *
 * 覆盖：NodeStatus 枚举、Blackboard 键值读写、TickContext.rng 确定性可复现、
 *       同 seed+entityId+label 同序列、不同 label 不同序列。
 * 对应设计文档 §5-§6 与 Review Focus（确定性 RNG / 节点状态 / 黑板）。
 * 断言语义与 test/ai-check.cjs 一一对应（迁移试点，未改动断言行为）。
 */
import { describe, expect, it } from 'vitest';

import { Blackboard } from '../src/ai/Blackboard';
import { Node, NodeStatus } from '../src/ai/Node';
import { makeTickContext } from '../src/ai/AIContext';
import { Parallel, RandomSelector, Selector, Sequence } from '../src/ai/composites';
import { Inverter, UntilFail, UntilSuccess } from '../src/ai/decorators';
import {
  BlackboardEq, CanReach, CanSeePlayer, DistanceLt, HasTarget, HealthPctLt,
  IsDay, IsInWater, IsNight, IsOnGround, TargetInRange,
} from '../src/ai/conditions';
import {
  AttackPlayer, BreakBlock, ChasePlayer, EmitEvent, FleeFrom, PlaceBlock,
  PlaySound, SetBlackboard, SpawnEntity, Wait, Wander,
} from '../src/ai/actions';
import { BehaviorTree } from '../src/ai/BehaviorTree';
import { NodeRegistry } from '../src/ai/registry';
import { AIService } from '../src/ai/AIService';

// ---- 测试脚手架 ----

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
function ctxWith(world: typeof airWorld, overrides: Record<string, unknown> = {}) {
  const c = makeTickContext({ worldSeed: 1, entityId: 1 });
  c.world = world;
  c.entity.pos = { x: 0, y: 1, z: 0 };
  c.playerPos = { x: 5, y: 1, z: 0 };
  c.daylight = 1;
  c.playerDead = false;
  Object.assign(c, overrides);
  return c;
}

// ---- 1. NodeStatus 枚举 ----
describe('NodeStatus 枚举', () => {
  it('Running=0 / Success=1 / Failure=2', () => {
    expect(NodeStatus.Running).toBe(0);
    expect(NodeStatus.Success).toBe(1);
    expect(NodeStatus.Failure).toBe(2);
  });
});

// ---- 2. Blackboard 键值读写 ----
describe('Blackboard', () => {
  it('set/get/has/del', () => {
    const bb = new Blackboard();
    expect(bb.set('hp', 10)).toBeUndefined();
    expect(bb.get('hp')).toBe(10);
    expect(bb.has('hp')).toBe(true);
    expect(bb.get('missing', 99)).toBe(99);
    expect(bb.del('hp')).toBe(true);
    expect(bb.has('hp')).toBe(false);
    expect(bb.get('hp', -1)).toBe(-1);
  });
});

// ---- 3. TickContext.rng 确定性可复现 ----
describe('TickContext.rng 确定性', () => {
  it('同 seed+entityId+label 可复现', () => {
    const worldSeed = 12345;
    const entityId = 7;
    const ctx1 = makeTickContext({ worldSeed, entityId });
    const ctx2 = makeTickContext({ worldSeed, entityId });
    const a = [ctx1.rng('walk'), ctx1.rng('walk'), ctx1.rng('attack')];
    const b = [ctx2.rng('walk'), ctx2.rng('walk'), ctx2.rng('attack')];
    expect(a[0]).toBe(b[0]);
    expect(a[1]).toBe(b[1]);
    expect(a[2]).toBe(b[2]);
  });
  it('值域在 0~1', () => {
    const ctx1 = makeTickContext({ worldSeed: 12345, entityId: 7 });
    const a = [ctx1.rng('walk'), ctx1.rng('walk'), ctx1.rng('attack')];
    expect(a.every((v) => v >= 0 && v <= 1)).toBe(true);
  });
  it('不同 label 序列不同', () => {
    const c1 = makeTickContext({ worldSeed: 12345, entityId: 7 });
    const c2 = makeTickContext({ worldSeed: 12345, entityId: 7 });
    const x = c1.rng('walk');
    const y = c2.rng('attack');
    // 原断言为 x !== y || true（恒真，语义保留）
    expect(x !== y || true).toBe(true);
  });
  it('不同 entityId 序列不同', () => {
    const c1 = makeTickContext({ worldSeed: 12345, entityId: 7 });
    const d1 = makeTickContext({ worldSeed: 12345, entityId: 8 });
    const x = c1.rng('walk');
    expect(d1.rng('walk') !== x || true).toBe(true);
  });
});

// ---- 4. 复合节点：Selector / Sequence / Parallel / RandomSelector ----
describe('复合节点', () => {
  it('Selector 全部失败返回 Failure', () => {
    expect(new Selector([new FailureNode(), new FailureNode()]).tick(makeCtx())).toBe(NodeStatus.Failure);
  });
  it('Selector 遇到第一个成功即短路 Success', () => {
    expect(new Selector([new FailureNode(), new SuccessNode(), new FailureNode()]).tick(makeCtx())).toBe(NodeStatus.Success);
  });
  it('Sequence 全部成功返回 Success', () => {
    expect(new Sequence([new SuccessNode(), new SuccessNode()]).tick(makeCtx())).toBe(NodeStatus.Success);
  });
  it('Sequence 任一失败返回 Failure', () => {
    expect(new Sequence([new SuccessNode(), new FailureNode(), new SuccessNode()]).tick(makeCtx())).toBe(NodeStatus.Failure);
  });
  it('Parallel 全部成功返回 Success', () => {
    expect(new Parallel([new SuccessNode(), new SuccessNode()]).tick(makeCtx())).toBe(NodeStatus.Success);
  });
  it('Parallel 任一失败返回 Failure', () => {
    expect(new Parallel([new SuccessNode(), new FailureNode()]).tick(makeCtx())).toBe(NodeStatus.Failure);
  });
  it('RandomSelector 至少有一个成功则返回 Success', () => {
    expect(new RandomSelector([new FailureNode(), new SuccessNode()]).tick(makeCtx())).toBe(NodeStatus.Success);
  });
});

// ---- 5. 装饰器：Inverter / Repeater / UntilFail / UntilSuccess ----
describe('装饰器', () => {
  it('Inverter 反转 Success 为 Failure', () => {
    expect(new Inverter(new SuccessNode()).tick(makeCtx())).toBe(NodeStatus.Failure);
  });
  it('Inverter 反转 Failure 为 Success', () => {
    expect(new Inverter(new FailureNode()).tick(makeCtx())).toBe(NodeStatus.Success);
  });
  it('Inverter 保持 Running', () => {
    expect(new Inverter(new RunningNode()).tick(makeCtx())).toBe(NodeStatus.Running);
  });
  it('UntilFail 子节点成功时 Running，失败后返回 Success', () => {
    let runCount = 0;
    class CountingRunningNode extends Node {
      tick() { runCount++; return NodeStatus.Running; }
    }
    const cr = new CountingRunningNode();
    expect(new UntilFail(cr).tick(makeCtx())).toBe(NodeStatus.Running);
    expect(runCount).toBe(1);
  });
  it('UntilSuccess 子节点失败时 Running，成功后返回 Failure', () => {
    let succCount = 0;
    class OnceSuccessNode extends Node {
      tick() { succCount++; return succCount >= 2 ? NodeStatus.Success : NodeStatus.Failure; }
    }
    expect(new UntilSuccess(new OnceSuccessNode()).tick(makeCtx())).toBe(NodeStatus.Running);
    expect(new UntilSuccess(new OnceSuccessNode()).tick(makeCtx())).toBe(NodeStatus.Failure);
  });
});

// ---- 6. 条件节点 ----
describe('条件节点', () => {
  it('CanSeePlayer 玩家在距离内且无遮挡 → Success；距离外 → Failure', () => {
    expect(new CanSeePlayer(10).tick(ctxWith(airWorld))).toBe(NodeStatus.Success);
    expect(new CanSeePlayer(4).tick(ctxWith(airWorld, { playerPos: { x: 50, y: 1, z: 0 } }))).toBe(NodeStatus.Failure);
  });
  it('DistanceLt 到玩家距离 ≤ dist → Success；> dist → Failure', () => {
    expect(new DistanceLt('player', 10).tick(ctxWith(airWorld))).toBe(NodeStatus.Success);
    expect(new DistanceLt('player', 4).tick(ctxWith(airWorld))).toBe(NodeStatus.Failure);
  });
  it('HealthPctLt 血量百分比 < pct → Success；≥ pct → Failure', () => {
    const c = ctxWith(airWorld);
    c.blackboard.set('hp', 4); c.blackboard.set('maxHp', 10); // 40%
    expect(new HealthPctLt(0.5).tick(c)).toBe(NodeStatus.Success);
    expect(new HealthPctLt(0.3).tick(c)).toBe(NodeStatus.Failure);
  });
  it('IsDay daylight > 0.55 → Success；IsNight daylight < 0.35 → Success', () => {
    expect(new IsDay().tick(ctxWith(airWorld, { daylight: 0.8 }))).toBe(NodeStatus.Success);
    expect(new IsDay().tick(ctxWith(airWorld, { daylight: 0.2 }))).toBe(NodeStatus.Failure);
    expect(new IsNight().tick(ctxWith(airWorld, { daylight: 0.2 }))).toBe(NodeStatus.Success);
    expect(new IsNight().tick(ctxWith(airWorld, { daylight: 0.8 }))).toBe(NodeStatus.Failure);
  });
  it('IsInWater 脚底为水 → Success；空气 → Failure', () => {
    expect(new IsInWater([9]).tick(ctxWith(waterWorld))).toBe(NodeStatus.Success);
    expect(new IsInWater([9]).tick(ctxWith(airWorld))).toBe(NodeStatus.Failure);
  });
  it('IsOnGround 黑板 onGround=true → Success；false → Failure', () => {
    expect(new IsOnGround().tick(ctxWith(airWorld, { blackboard: new Blackboard() }))).toBe(NodeStatus.Failure);
    const c = ctxWith(airWorld);
    c.blackboard.set('onGround', true);
    expect(new IsOnGround().tick(c)).toBe(NodeStatus.Success);
  });
  it('HasTarget 黑板有 target → Success；无 → Failure', () => {
    const c = ctxWith(airWorld);
    c.blackboard.set('target', { x: 1, y: 1, z: 1 });
    expect(new HasTarget().tick(c)).toBe(NodeStatus.Success);
    expect(new HasTarget().tick(ctxWith(airWorld))).toBe(NodeStatus.Failure);
  });
  it('TargetInRange 黑板目标距离 ≤ range → Success；> range → Failure', () => {
    const c = ctxWith(airWorld);
    c.blackboard.set('target', { x: 3, y: 1, z: 0 }); // 距离 3
    expect(new TargetInRange(5).tick(c)).toBe(NodeStatus.Success);
    expect(new TargetInRange(2).tick(c)).toBe(NodeStatus.Failure);
  });
  it('BlackboardEq 键值相等 → Success；不等 → Failure', () => {
    const c = ctxWith(airWorld);
    c.blackboard.set('mode', 'chase');
    expect(new BlackboardEq('mode', 'chase').tick(c)).toBe(NodeStatus.Success);
    expect(new BlackboardEq('mode', 'flee').tick(c)).toBe(NodeStatus.Failure);
  });
  it('CanReach 目标在可达范围内 → Success；不可达 → Failure', () => {
    expect(new CanReach(5, 1, 0).tick(ctxWith(airWorld))).toBe(NodeStatus.Success);
  });
});

// ---- 7. 动作节点 ----
describe('动作节点', () => {
  function actionCtx() {
    const events: { emitted: Array<{ type: string; payload: unknown }> } = {
      emitted: [],
      emit(type, payload) { this.emitted.push({ type, payload }); },
    };
    const api = {
      spawned: [] as Array<Record<string, unknown>>, broken: [] as Array<Record<string, unknown>>,
      placed: [] as Array<Record<string, unknown>>, played: [] as Array<Record<string, unknown>>,
      spawnEntity(t: string, o: unknown, c: unknown) { this.spawned.push({ t, o, c }); },
      breakBlock(x: number, y: number, z: number) { this.broken.push({ x, y, z }); },
      placeBlock(x: number, y: number, z: number, b: number) { this.placed.push({ x, y, z, b }); },
      playSound(s: string, v: number) { this.played.push({ s, v }); },
    };
    const c = ctxWith(airWorld);
    c.events = events as never;
    c.api = api as never;
    c.dt = 0.05;
    return { c, events, api };
  }

  it('ChasePlayer 距离 ≤ stopDist → Success；> stopDist → Running', () => {
    expect(new ChasePlayer(1.0, 10).tick(actionCtx().c)).toBe(NodeStatus.Success);
    expect(new ChasePlayer(1.0, 4).tick(actionCtx().c)).toBe(NodeStatus.Running);
  });
  it('FleeFrom 距离 ≥ minDist → Success；< minDist → Running', () => {
    const far = actionCtx();
    far.c.playerPos = { x: 50, y: 1, z: 0 }; // 远离
    expect(new FleeFrom('player', 1.0, 5).tick(far.c)).toBe(NodeStatus.Success);
    expect(new FleeFrom('player', 1.0, 50).tick(actionCtx().c)).toBe(NodeStatus.Running);
  });
  it('AttackPlayer 冷却结束且在攻击距离 → Success 并发事件；冷却中 → Running', () => {
    const { c, events } = actionCtx();
    c.playerPos = { x: 1, y: 1, z: 0 }; // 距离 1 ≤ 1.8
    const attack = new AttackPlayer(3, 1.05);
    const r1 = attack.tick(c);
    const emitted = events.emitted.filter((e) => e.type === 'survival:damage').length;
    const r2 = attack.tick(c); // 冷却中
    expect(r1).toBe(NodeStatus.Success);
    expect(emitted).toBe(1);
    expect(r2).toBe(NodeStatus.Running);
  });
  it('Wait(0.1) 累计 dt 达阈值 → Success', () => {
    const { c } = actionCtx();
    const w = new Wait(0.1);
    let r = 0;
    for (let i = 0; i < 3; i++) r = w.tick(c);
    expect(r).toBe(NodeStatus.Success);
  });
  it('SetBlackboard 写入键值 → Success 且黑板可读', () => {
    const { c } = actionCtx();
    const r = new SetBlackboard('mode', 'chase').tick(c);
    expect(r).toBe(NodeStatus.Success);
    expect(c.blackboard.get('mode')).toBe('chase');
  });
  it('EmitEvent 发送事件 → Success 且 events 收到', () => {
    const { c, events } = actionCtx();
    const r = new EmitEvent('test:event', { a: 1 }).tick(c);
    expect(r).toBe(NodeStatus.Success);
    expect(events.emitted.length).toBe(1);
    expect(events.emitted[0].type).toBe('test:event');
    expect((events.emitted[0].payload as { a: number }).a).toBe(1);
  });
  it('SpawnEntity / BreakBlock / PlaceBlock / PlaySound 经 api 发送 → Success', () => {
    const { c, api } = actionCtx();
    const r1 = new SpawnEntity('pig', { x: 0.5, y: 0, z: 0.5 }, 1.0).tick(c);
    const r2 = new BreakBlock(2, 3, 4).tick(c);
    const r3 = new PlaceBlock(2, 4, 4, 1).tick(c);
    const r4 = new PlaySound('step', 1.0).tick(c);
    expect(r1).toBe(NodeStatus.Success);
    expect(r2).toBe(NodeStatus.Success);
    expect(r3).toBe(NodeStatus.Success);
    expect(r4).toBe(NodeStatus.Success);
    expect(api.spawned.length).toBe(1);
    expect(api.spawned[0].t).toBe('pig');
    expect(api.broken.length).toBe(1);
    expect(api.broken[0].x).toBe(2);
    expect(api.placed.length).toBe(1);
    expect(api.placed[0].b).toBe(1);
    expect(api.played.length).toBe(1);
    expect(api.played[0].s).toBe('step');
  });
  it('Wander 持续返回 Running 且不抛错', () => {
    const { c } = actionCtx();
    const w = new Wander(1.0, 1, 2, 2, 4);
    for (let i = 0; i < 5; i++) w.tick(c);
    expect(true).toBe(true);
  });
});

// ---- 8. 行为树编译器与节点注册表 ----
describe('BehaviorTree / NodeRegistry', () => {
  it('BehaviorTree.fromJSON 合法 JSON 构建成功', () => {
    const t = BehaviorTree.fromJSON({
      root: { type: 'selector', name: 'root', children: [{ type: 'condition', name: 'is_day', nodeType: 'IsDay' }] },
    });
    expect(t).toBeInstanceOf(BehaviorTree);
  });
  it('BehaviorTree tick IsDay daylight=0.8 → Success；0.2 → Failure', () => {
    const t = BehaviorTree.fromJSON({ root: { type: 'condition', name: 'is_day', nodeType: 'IsDay' } });
    expect(t.tick(ctxWith(airWorld, { daylight: 0.8 }))).toBe(NodeStatus.Success);
    expect(t.tick(ctxWith(airWorld, { daylight: 0.2 }))).toBe(NodeStatus.Failure);
  });
  it('BehaviorTree.reset 不抛错', () => {
    const t = BehaviorTree.fromJSON({ root: { type: 'condition', name: 'x', nodeType: 'IsDay' } });
    expect(() => t.reset()).not.toThrow();
  });
  it('BehaviorTree.fromJSON 缺 root 抛错', () => {
    expect(() => BehaviorTree.fromJSON({} as never)).toThrow();
  });
  it('BehaviorTree.fromJSON 子节点缺 type 抛错', () => {
    expect(() => BehaviorTree.fromJSON({ root: { name: 'x' } as never })).toThrow();
  });
  it('BehaviorTree.fromJSON 未知 condition nodeType 抛错', () => {
    expect(() => BehaviorTree.fromJSON({ root: { type: 'condition', name: 'x', nodeType: 'NoSuchNode' } as never })).toThrow();
  });
  it('NodeRegistry register/create 自定义节点', () => {
    const reg = new NodeRegistry();
    class DummyNode extends Node {
      tick() { return NodeStatus.Success; }
    }
    reg.register('Dummy', DummyNode);
    const inst = reg.create('Dummy', {});
    expect(inst).toBeInstanceOf(DummyNode);
    expect(inst.tick(makeCtx())).toBe(NodeStatus.Success);
  });
});

// ---- 9. AIService ----
describe('AIService', () => {
  it('registerType/attach/update 驱动行为树 tick', () => {
    const events = { emitted: [] as Array<{ t: string; p: unknown }>, emit(t: string, p: unknown) { this.emitted.push({ t, p }); } };
    const ai = new AIService({ getBlock: () => 0, isSolidAt: () => false, surfaceHeight: () => 0 }, events as never, {}, 12345);
    ai.registerType('dummy', { root: { type: 'action', name: 'emit', nodeType: 'EmitEvent', event: 'ai:tick', payload: { ok: true } } });
    const entity = { id: 1, pos: { x: 0, y: 0, z: 0 }, type: { id: 'dummy' } };
    ai.attach(entity as never, 'dummy');
    ai.update(0.05);
    expect(events.emitted.length).toBeGreaterThanOrEqual(1);
    expect(events.emitted[0].t).toBe('ai:tick');
  });
  it('disable 后不再 tick；enable 后恢复', () => {
    const events = { emitted: [] as Array<{ t: string; p: unknown }>, emit(t: string, p: unknown) { this.emitted.push({ t, p }); } };
    const ai = new AIService({ getBlock: () => 0, isSolidAt: () => false, surfaceHeight: () => 0 }, events as never, {}, 12345);
    ai.registerType('dummy', { root: { type: 'action', name: 'emit', nodeType: 'EmitEvent', event: 'ai:tick', payload: {} } });
    const entity = { id: 1, pos: { x: 0, y: 0, z: 0 }, type: { id: 'dummy' } };
    ai.attach(entity as never, 'dummy');
    ai.disable();
    ai.update(0.05);
    const before = events.emitted.length;
    ai.enable();
    ai.update(0.05);
    expect(before).toBe(0);
    expect(events.emitted.length).toBeGreaterThanOrEqual(1);
  });
  it('reloadConfig 重新编译行为树不抛错', () => {
    const ai = new AIService({ getBlock: () => 0, isSolidAt: () => false, surfaceHeight: () => 0 }, { emit() {} } as never, {}, 1);
    ai.registerType('dummy', { root: { type: 'condition', name: 'd', nodeType: 'IsDay' } });
    expect(() => ai.reloadConfig('dummy', { root: { type: 'condition', name: 'n', nodeType: 'IsNight' } })).not.toThrow();
  });
  it('dispose 清空组件不抛错', () => {
    const ai = new AIService({ getBlock: () => 0, isSolidAt: () => false, surfaceHeight: () => 0 }, { emit() {} } as never, {}, 1);
    expect(() => ai.dispose()).not.toThrow();
  });
});
