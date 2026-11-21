import { Node, NodeStatus, TickContext } from './Node';
import { Perception } from './Perception';

/** 玩家在距离内且无固体遮挡 → Success。 */
export class CanSeePlayer extends Node {
  constructor(public readonly maxDist = 16) { super(); }
  tick(ctx: TickContext): NodeStatus {
    const perception = new Perception(ctx.world);
    return perception.canSee(ctx.entity, { pos: ctx.playerPos }, this.maxDist)
      ? NodeStatus.Success : NodeStatus.Failure;
  }
}

/** 到指定目标（player / 黑板位置）距离 < dist → Success。 */
export class DistanceLt extends Node {
  constructor(
    public readonly target: 'player' | 'blackboard' = 'player',
    public readonly dist: number = 16,
    public readonly blackboardKey = 'target',
  ) { super(); }
  tick(ctx: TickContext): NodeStatus {
    let tx = ctx.playerPos.x, ty = ctx.playerPos.y, tz = ctx.playerPos.z;
    if (this.target === 'blackboard') {
      const t = ctx.blackboard.get<{ x: number; y: number; z: number }>(this.blackboardKey);
      if (!t) return NodeStatus.Failure;
      tx = t.x; ty = t.y; tz = t.z;
    }
    const d = Math.hypot(ctx.entity.pos.x - tx, ctx.entity.pos.y - ty, ctx.entity.pos.z - tz);
    return d < this.dist ? NodeStatus.Success : NodeStatus.Failure;
  }
}

/** 血量百分比 < pct → Success（血量从黑板 hp/maxHp 读取）。 */
export class HealthPctLt extends Node {
  constructor(public readonly pct: number) { super(); }
  tick(ctx: TickContext): NodeStatus {
    const hp = ctx.blackboard.get<number>('hp');
    const maxHp = ctx.blackboard.get<number>('maxHp');
    if (hp === undefined || maxHp === undefined || maxHp <= 0) return NodeStatus.Failure;
    return hp / maxHp < this.pct ? NodeStatus.Success : NodeStatus.Failure;
  }
}

/** 日照强度 > 0.55 → Success。 */
export class IsDay extends Node {
  tick(ctx: TickContext): NodeStatus {
    return ctx.daylight > 0.55 ? NodeStatus.Success : NodeStatus.Failure;
  }
}

/** 日照强度 < 0.35 → Success。 */
export class IsNight extends Node {
  tick(ctx: TickContext): NodeStatus {
    return ctx.daylight < 0.35 ? NodeStatus.Success : NodeStatus.Failure;
  }
}

/** 脚底方块在液体 id 列表中 → Success。 */
export class IsInWater extends Node {
  constructor(public readonly liquidBlockIds: number[] = []) { super(); }
  tick(ctx: TickContext): NodeStatus {
    const perception = new Perception(ctx.world);
    return perception.isInWater(ctx.entity, this.liquidBlockIds) ? NodeStatus.Success : NodeStatus.Failure;
  }
}

/** 黑板 onGround 为 true → Success。 */
export class IsOnGround extends Node {
  tick(ctx: TickContext): NodeStatus {
    return ctx.blackboard.get<boolean>('onGround') === true ? NodeStatus.Success : NodeStatus.Failure;
  }
}

/** 黑板中存在 target → Success。 */
export class HasTarget extends Node {
  tick(ctx: TickContext): NodeStatus {
    return ctx.blackboard.has('target') ? NodeStatus.Success : NodeStatus.Failure;
  }
}

/** 黑板目标到实体距离 ≤ range → Success。 */
export class TargetInRange extends Node {
  constructor(public readonly range: number) { super(); }
  tick(ctx: TickContext): NodeStatus {
    const t = ctx.blackboard.get<{ x: number; y: number; z: number }>('target');
    if (!t) return NodeStatus.Failure;
    const d = Math.hypot(ctx.entity.pos.x - t.x, ctx.entity.pos.y - t.y, ctx.entity.pos.z - t.z);
    return d <= this.range ? NodeStatus.Success : NodeStatus.Failure;
  }
}

/** 黑板键值严格相等 → Success。 */
export class BlackboardEq extends Node {
  constructor(public readonly key: string, public readonly value: unknown) { super(); }
  tick(ctx: TickContext): NodeStatus {
    return ctx.blackboard.get(this.key) === this.value ? NodeStatus.Success : NodeStatus.Failure;
  }
}

/** 贪婪扩展能到达目标格 → Success。 */
export class CanReach extends Node {
  constructor(public readonly x: number, public readonly y: number, public readonly z: number) { super(); }
  tick(ctx: TickContext): NodeStatus {
    const perception = new Perception(ctx.world);
    return perception.canReach(ctx.entity, this.x, this.y, this.z) ? NodeStatus.Success : NodeStatus.Failure;
  }
}
