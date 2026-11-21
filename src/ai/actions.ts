import { Node, NodeStatus, TickContext } from './Node';

type AnyApi = { [key: string]: any };

function apiOf(ctx: TickContext): AnyApi {
  return (ctx.api as AnyApi) ?? {};
}

/** 面向玩家并向前移动；距离 ≤ stopDist 时返回 Success，否则 Running。 */
export class ChasePlayer extends Node {
  constructor(public readonly speed: number = 1, public readonly stopDist: number = 2) { super(); }
  tick(ctx: TickContext): NodeStatus {
    const d = Math.hypot(ctx.entity.pos.x - ctx.playerPos.x, ctx.entity.pos.z - ctx.playerPos.z);
    return d <= this.stopDist ? NodeStatus.Success : NodeStatus.Running;
  }
}

/** 远离目标直到距离 ≥ minDist 时返回 Success，否则 Running。 */
export class FleeFrom extends Node {
  constructor(public readonly target: 'player' = 'player', public readonly speed: number = 1, public readonly minDist: number = 8) { super(); }
  tick(ctx: TickContext): NodeStatus {
    const d = Math.hypot(ctx.entity.pos.x - ctx.playerPos.x, ctx.entity.pos.z - ctx.playerPos.z);
    return d >= this.minDist ? NodeStatus.Success : NodeStatus.Running;
  }
}

/** 冷却结束且在攻击距离内时发事件并返回 Success，否则 Running。 */
export class AttackPlayer extends Node {
  private attackTimer = 0;
  constructor(
    public readonly damage: number = 3,
    public readonly cooldown: number = 1.05,
    public readonly attackRange: number = 1.8,
  ) { super(); }
  tick(ctx: TickContext): NodeStatus {
    this.attackTimer = Math.max(0, this.attackTimer - ctx.dt);
    const d = Math.hypot(ctx.entity.pos.x - ctx.playerPos.x, ctx.entity.pos.z - ctx.playerPos.z);
    if (d <= this.attackRange && this.attackTimer <= 0) {
      this.attackTimer = this.cooldown;
      ctx.events.emit('survival:damage', { amount: this.damage, cause: 'AI AttackPlayer' });
      return NodeStatus.Success;
    }
    return NodeStatus.Running;
  }
  reset(): void { this.attackTimer = 0; }
}

/** 随机走停（替代原 Entity.state='idle|walk'），持续返回 Running。 */
export class Wander extends Node {
  private state: 'idle' | 'walk' = 'idle';
  private timer = 0;
  constructor(
    public readonly speed: number = 1,
    public readonly idleMin: number = 1.5,
    public readonly idleMax: number = 3.5,
    public readonly walkMin: number = 2,
    public readonly walkMax: number = 4,
  ) { super(); }
  tick(ctx: TickContext): NodeStatus {
    this.timer -= ctx.dt;
    if (this.timer <= 0) {
      if (this.state === 'idle') {
        this.state = 'walk';
        this.timer = this.walkMin + ctx.rng('wander') * (this.walkMax - this.walkMin);
      } else {
        this.state = 'idle';
        this.timer = this.idleMin + ctx.rng('wander') * (this.idleMax - this.idleMin);
      }
    }
    return NodeStatus.Running;
  }
  reset(): void { this.state = 'idle'; this.timer = 0; }
}

/** 面向目标并持续指定秒数后返回 Success。 */
export class LookAt extends Node {
  private timer = 0;
  constructor(public readonly target: 'player' = 'player', public readonly duration: number = 1) { super(); }
  tick(ctx: TickContext): NodeStatus {
    this.timer += ctx.dt;
    return this.timer >= this.duration ? NodeStatus.Success : NodeStatus.Running;
  }
  reset(): void { this.timer = 0; }
}

/** 等待指定秒数后返回 Success。 */
export class Wait extends Node {
  private timer = 0;
  constructor(public readonly seconds: number) { super(); }
  tick(ctx: TickContext): NodeStatus {
    this.timer += ctx.dt;
    return this.timer >= this.seconds ? NodeStatus.Success : NodeStatus.Running;
  }
  reset(): void { this.timer = 0; }
}

/** 发送游戏事件后返回 Success。 */
export class EmitEvent extends Node {
  constructor(public readonly event: string, public readonly payload: unknown = undefined) { super(); }
  tick(ctx: TickContext): NodeStatus {
    ctx.events.emit(this.event, this.payload);
    return NodeStatus.Success;
  }
}

/** 写黑板后返回 Success。 */
export class SetBlackboard extends Node {
  constructor(public readonly key: string, public readonly value: unknown) { super(); }
  tick(ctx: TickContext): NodeStatus {
    ctx.blackboard.set(this.key, this.value);
    return NodeStatus.Success;
  }
}

/** 按 chance 概率生成实体（经 api.spawnEntity，需 world:write 权限）。 */
export class SpawnEntity extends Node {
  constructor(public readonly typeId: string, public readonly offset: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }, public readonly chance: number = 1) { super(); }
  tick(ctx: TickContext): NodeStatus {
    if (ctx.rng('spawn') < this.chance) {
      apiOf(ctx).spawnEntity?.(this.typeId, this.offset, this.chance);
    }
    return NodeStatus.Success;
  }
}

/** 经 api.breakBlock 破坏方块（需 world:write 权限）。 */
export class BreakBlock extends Node {
  constructor(public readonly x: number, public readonly y: number, public readonly z: number) { super(); }
  tick(ctx: TickContext): NodeStatus {
    apiOf(ctx).breakBlock?.(this.x, this.y, this.z);
    return NodeStatus.Success;
  }
}

/** 经 api.placeBlock 放置方块（需 world:write 权限）。 */
export class PlaceBlock extends Node {
  constructor(public readonly x: number, public readonly y: number, public readonly z: number, public readonly blockId: number) { super(); }
  tick(ctx: TickContext): NodeStatus {
    apiOf(ctx).placeBlock?.(this.x, this.y, this.z, this.blockId);
    return NodeStatus.Success;
  }
}

/** 经 api.playSound 播放音效。 */
export class PlaySound extends Node {
  constructor(public readonly sound: string, public readonly volume: number = 1) { super(); }
  tick(ctx: TickContext): NodeStatus {
    apiOf(ctx).playSound?.(this.sound, this.volume);
    return NodeStatus.Success;
  }
}
