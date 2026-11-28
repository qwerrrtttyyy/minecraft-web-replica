import type { NodeConfig } from './BehaviorTree';
import { cfg, Node, NodeStatus } from './Node';
import type { TickContext } from './Node';
import { Perception } from './Perception';

/** 玩家在距离内且无固体遮挡 → Success。 */
export class CanSeePlayer extends Node {
  readonly maxDist: number;
  constructor(config: NodeConfig | number = 16) { super(); this.maxDist = typeof config === 'object' && config !== null ? cfg(config, 'maxDist', 16) : config; }
  tick(ctx: TickContext): NodeStatus {
    return new Perception(ctx.world).canSee(ctx.entity, { pos: ctx.playerPos }, this.maxDist) ? NodeStatus.Success : NodeStatus.Failure;
  }
}

/** 到指定目标（player / 黑板位置）距离 < dist → Success。 */
export class DistanceLt extends Node {
  readonly target: string; readonly dist: number; readonly blackboardKey: string; readonly horizontal: boolean;
  constructor(config: NodeConfig | string = 'player', dist?: number, blackboardKey?: string) {
    super();
    if (typeof config === 'object' && config !== null) { this.target = cfg(config, 'target', 'player'); this.dist = cfg(config, 'dist', 16); this.blackboardKey = cfg(config, 'blackboardKey', 'target'); this.horizontal = cfg(config, 'horizontal', false); }
    else { this.target = config; this.dist = dist ?? 16; this.blackboardKey = blackboardKey ?? 'target'; this.horizontal = false; }
  }
  tick(ctx: TickContext): NodeStatus {
    let tx = ctx.playerPos.x, ty = ctx.playerPos.y, tz = ctx.playerPos.z;
    if (this.target === 'blackboard') {
      const t = ctx.blackboard.get<{ x: number; y: number; z: number }>(this.blackboardKey);
      if (!t) return NodeStatus.Failure;
      tx = t.x; ty = t.y; tz = t.z;
    }
    const dx = ctx.entity.pos.x - tx; const dy = ctx.entity.pos.y - ty; const dz = ctx.entity.pos.z - tz;
    const d = this.horizontal ? Math.hypot(dx, dz) : Math.hypot(dx, dy, dz);
    return d < this.dist ? NodeStatus.Success : NodeStatus.Failure;
  }
}

/** 血量百分比 < pct → Success（血量从黑板 hp/maxHp 读取）。 */
export class HealthPctLt extends Node {
  readonly pct: number;
  constructor(config: NodeConfig | number = 0.5) { super(); this.pct = typeof config === 'object' && config !== null ? cfg(config, 'pct', 0.5) : config; }
  tick(ctx: TickContext): NodeStatus {
    const hp = ctx.blackboard.get<number>('hp'); const maxHp = ctx.blackboard.get<number>('maxHp');
    if (hp === undefined || maxHp === undefined || maxHp <= 0) return NodeStatus.Failure;
    return hp / maxHp < this.pct ? NodeStatus.Success : NodeStatus.Failure;
  }
}

export class IsDay extends Node { tick(ctx: TickContext): NodeStatus { return ctx.daylight > 0.55 ? NodeStatus.Success : NodeStatus.Failure; } }
export class IsNight extends Node { tick(ctx: TickContext): NodeStatus { return ctx.daylight < 0.35 ? NodeStatus.Success : NodeStatus.Failure; } }

/** 脚底方块在液体 id 列表中 → Success。 */
export class IsInWater extends Node {
  readonly liquidBlockIds: number[];
  constructor(config: NodeConfig | number[] = []) {
    super();
    if (Array.isArray(config)) this.liquidBlockIds = config;
    else if (typeof config === 'object' && config !== null) this.liquidBlockIds = cfg(config, 'liquidBlockIds', []);
    else this.liquidBlockIds = [];
  }
  tick(ctx: TickContext): NodeStatus { return new Perception(ctx.world).isInWater(ctx.entity, this.liquidBlockIds) ? NodeStatus.Success : NodeStatus.Failure; }
}

export class IsOnGround extends Node { tick(ctx: TickContext): NodeStatus { return ctx.blackboard.get<boolean>('onGround') === true ? NodeStatus.Success : NodeStatus.Failure; } }
export class HasTarget extends Node { tick(ctx: TickContext): NodeStatus { return ctx.blackboard.has('target') ? NodeStatus.Success : NodeStatus.Failure; } }

/** 黑板目标到实体距离 ≤ range → Success。 */
export class TargetInRange extends Node {
  readonly range: number;
  constructor(config: NodeConfig | number = 1) { super(); this.range = typeof config === 'object' && config !== null ? cfg(config, 'range', 1) : config; }
  tick(ctx: TickContext): NodeStatus {
    const t = ctx.blackboard.get<{ x: number; y: number; z: number }>('target');
    if (!t) return NodeStatus.Failure;
    return Math.hypot(ctx.entity.pos.x - t.x, ctx.entity.pos.y - t.y, ctx.entity.pos.z - t.z) <= this.range ? NodeStatus.Success : NodeStatus.Failure;
  }
}

/** 黑板键值严格相等 → Success。 */
export class BlackboardEq extends Node {
  readonly key: string; readonly value: unknown;
  constructor(config: NodeConfig | string = '', value?: unknown) {
    super();
    if (typeof config === 'string') { this.key = config; this.value = value; }
    else { this.key = cfg(config, 'key', ''); this.value = cfg(config, 'value', undefined); }
  }
  tick(ctx: TickContext): NodeStatus { return ctx.blackboard.get(this.key) === this.value ? NodeStatus.Success : NodeStatus.Failure; }
}

/** 贪婪扩展能到达目标格 → Success。 */
export class CanReach extends Node {
  readonly x: number; readonly y: number; readonly z: number;
  constructor(config: NodeConfig | number = 0, y?: number, z?: number) {
    super();
    if (typeof config === 'number') { this.x = config; this.y = y ?? 0; this.z = z ?? 0; }
    else { this.x = cfg(config, 'x', 0); this.y = cfg(config, 'y', 0); this.z = cfg(config, 'z', 0); }
  }
  tick(ctx: TickContext): NodeStatus { return new Perception(ctx.world).canReach(ctx.entity, this.x, this.y, this.z) ? NodeStatus.Success : NodeStatus.Failure; }
}
