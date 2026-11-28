import type { NodeConfig } from './BehaviorTree';
import type { TickContext } from './Node';
import { cfg, Node, NodeStatus } from './Node';

/** 节点可挂载的 CraftAPI 视图：按权限裁剪，方法缺失时静默跳过（api 为 unknown，此处集中一次收窄）。 */
type ApiView = Partial<{
  spawnEntity(typeId: string, offset: Vec3, chance: number): void;
  breakBlock(x: number, y: number, z: number): void;
  placeBlock(x: number, y: number, z: number, blockId: number): void;
  playSound(sound: string, volume: number): void;
}>;
interface Vec3 {
  x: number;
  y: number;
  z: number;
}
function apiOf(ctx: TickContext): ApiView {
  return (ctx.api as ApiView) ?? {};
}

/** 面向玩家并向前移动；距离 ≤ stopDist 时返回 Success，否则 Running。 */
export class ChasePlayer extends Node {
  readonly speed: number;
  readonly stopDist: number;
  readonly speedFar?: number;
  readonly speedClose?: number;
  readonly closeDist: number;
  constructor(config: NodeConfig | number = {}, stopDist?: number) {
    super();
    if (typeof config === 'object' && config !== null) {
      this.speed = cfg(config, 'speed', 1);
      this.stopDist = cfg(config, 'stopDist', 2);
      this.speedFar = cfg<number | undefined>(config, 'speedFar', undefined);
      this.speedClose = cfg<number | undefined>(config, 'speedClose', undefined);
      this.closeDist = cfg(config, 'closeDist', 2.2);
    } else {
      this.speed = config;
      this.stopDist = stopDist ?? 2;
      this.closeDist = 2.2;
    }
  }
  tick(ctx: TickContext): NodeStatus {
    const dx = ctx.playerPos.x - ctx.entity.pos.x;
    const dz = ctx.playerPos.z - ctx.entity.pos.z;
    const d = Math.hypot(dx, dz);
    ctx.blackboard.set('moveYaw', Math.atan2(-dx, -dz));
    if (d <= this.stopDist) {
      ctx.blackboard.set('moving', false);
      ctx.blackboard.set('moveSpeed', 0);
      return NodeStatus.Success;
    }
    let spd = this.speed;
    if (this.speedFar !== undefined && this.speedClose !== undefined)
      spd = d > this.closeDist ? this.speedFar : this.speedClose;
    ctx.blackboard.set('moving', true);
    ctx.blackboard.set('moveSpeed', spd);
    return NodeStatus.Running;
  }
}

/** 远离目标直到距离 ≥ minDist 时返回 Success，否则 Running。 */
export class FleeFrom extends Node {
  readonly target: string;
  readonly speed: number;
  readonly minDist: number;
  constructor(config: NodeConfig | string = 'player', speed?: number, minDist?: number) {
    super();
    if (typeof config === 'object' && config !== null) {
      this.target = cfg(config, 'target', 'player');
      this.speed = cfg(config, 'speed', 1);
      this.minDist = cfg(config, 'minDist', 8);
    } else {
      this.target = config;
      this.speed = speed ?? 1;
      this.minDist = minDist ?? 8;
    }
  }
  tick(ctx: TickContext): NodeStatus {
    const d = Math.hypot(ctx.entity.pos.x - ctx.playerPos.x, ctx.entity.pos.z - ctx.playerPos.z);
    return d >= this.minDist ? NodeStatus.Success : NodeStatus.Running;
  }
}

/** 冷却结束且在攻击距离内时发事件并返回 Success，否则 Running。 */
export class AttackPlayer extends Node {
  readonly damage: number;
  readonly cooldown: number;
  readonly attackRange: number;
  private attackTimer = 0;
  constructor(config: NodeConfig | number = 3, cooldown?: number, attackRange?: number) {
    super();
    if (typeof config === 'object' && config !== null) {
      this.damage = cfg(config, 'damage', 3);
      this.cooldown = cfg(config, 'cooldown', 1.05);
      this.attackRange = cfg(config, 'attackRange', 1.8);
    } else {
      this.damage = config;
      this.cooldown = cooldown ?? 1.05;
      this.attackRange = attackRange ?? 1.8;
    }
  }
  tick(ctx: TickContext): NodeStatus {
    this.attackTimer = Math.max(0, this.attackTimer - ctx.dt);
    const dx = ctx.playerPos.x - ctx.entity.pos.x;
    const dz = ctx.playerPos.z - ctx.entity.pos.z;
    const dy = Math.abs(ctx.playerPos.y - ctx.entity.pos.y);
    const d = Math.hypot(dx, dz);
    ctx.blackboard.set('moveYaw', Math.atan2(-dx, -dz));
    if (d > this.attackRange || dy >= 1.9) {
      ctx.blackboard.set('wantAttack', false);
      return NodeStatus.Failure; // 不在攻击范围，让 chase 接管
    }
    if (this.attackTimer <= 0) {
      this.attackTimer = this.cooldown;
      ctx.blackboard.set('wantAttack', true);
      return NodeStatus.Success;
    }
    ctx.blackboard.set('wantAttack', false);
    return NodeStatus.Running; // 冷却中，保持在攻击位置
  }
  reset(): void {
    this.attackTimer = 0;
  }
}

/** 随机走停，持续返回 Running。 */
export class Wander extends Node {
  readonly speed: number;
  readonly idleMin: number;
  readonly idleMax: number;
  readonly walkMin: number;
  readonly walkMax: number;
  private state: 'idle' | 'walk' = 'idle';
  private timer = 0;
  constructor(config: NodeConfig | number = 1, idleMin?: number, idleMax?: number, walkMin?: number, walkMax?: number) {
    super();
    if (typeof config === 'object' && config !== null) {
      this.speed = cfg(config, 'speed', 1);
      this.idleMin = cfg(config, 'idleMin', 1.5);
      this.idleMax = cfg(config, 'idleMax', 3.5);
      this.walkMin = cfg(config, 'walkMin', 2);
      this.walkMax = cfg(config, 'walkMax', 4);
    } else {
      this.speed = config;
      this.idleMin = idleMin ?? 1.5;
      this.idleMax = idleMax ?? 3.5;
      this.walkMin = walkMin ?? 2;
      this.walkMax = walkMax ?? 4;
    }
  }
  tick(ctx: TickContext): NodeStatus {
    this.timer -= ctx.dt;
    if (this.timer <= 0) {
      if (this.state === 'idle') {
        this.state = 'walk';
        this.timer = this.walkMin + ctx.rng('wander') * (this.walkMax - this.walkMin);
        ctx.blackboard.set('moveYaw', ctx.rng('wanderYaw') * Math.PI * 2);
      } else {
        this.state = 'idle';
        this.timer = this.idleMin + ctx.rng('wander') * (this.idleMax - this.idleMin);
      }
    }
    ctx.blackboard.set('moving', this.state === 'walk');
    ctx.blackboard.set('moveSpeed', this.state === 'walk' ? this.speed : 0);
    return NodeStatus.Running;
  }
  reset(): void {
    this.state = 'idle';
    this.timer = 0;
  }
}

/** 面向目标并持续指定秒数后返回 Success。 */
export class LookAt extends Node {
  readonly target: string;
  readonly duration: number;
  private timer = 0;
  constructor(config: NodeConfig | string = 'player', duration?: number) {
    super();
    if (typeof config === 'object' && config !== null) {
      this.target = cfg(config, 'target', 'player');
      this.duration = cfg(config, 'duration', 1);
    } else {
      this.target = config;
      this.duration = duration ?? 1;
    }
  }
  tick(ctx: TickContext): NodeStatus {
    this.timer += ctx.dt;
    return this.timer >= this.duration ? NodeStatus.Success : NodeStatus.Running;
  }
  reset(): void {
    this.timer = 0;
  }
}

/** 等待指定秒数后返回 Success。 */
export class Wait extends Node {
  readonly seconds: number;
  private timer = 0;
  constructor(config: NodeConfig | number = 1) {
    super();
    this.seconds = typeof config === 'object' && config !== null ? cfg(config, 'seconds', 1) : config;
  }
  tick(ctx: TickContext): NodeStatus {
    this.timer += ctx.dt;
    return this.timer >= this.seconds ? NodeStatus.Success : NodeStatus.Running;
  }
  reset(): void {
    this.timer = 0;
  }
}

/** 发送游戏事件后返回 Success。 */
export class EmitEvent extends Node {
  readonly event: string;
  readonly payload: unknown;
  constructor(config: NodeConfig | string = '', payload?: unknown) {
    super();
    if (typeof config === 'object' && config !== null) {
      this.event = cfg(config, 'event', '');
      this.payload = cfg(config, 'payload', undefined);
    } else {
      this.event = config;
      this.payload = payload;
    }
  }
  tick(ctx: TickContext): NodeStatus {
    ctx.events.emit(this.event, this.payload);
    return NodeStatus.Success;
  }
}

/** 写黑板后返回 Success。 */
export class SetBlackboard extends Node {
  readonly key: string;
  readonly value: unknown;
  constructor(config: any = '', value?: unknown) {
    super();
    if (typeof config === 'object' && config !== null) {
      this.key = cfg(config, 'key', '');
      this.value = cfg(config, 'value', undefined);
    } else {
      this.key = config;
      this.value = value;
    }
  }
  tick(ctx: TickContext): NodeStatus {
    ctx.blackboard.set(this.key, this.value);
    return NodeStatus.Success;
  }
}

/** 按 chance 概率生成实体（经 api.spawnEntity，需 world:write 权限）。 */
export class SpawnEntity extends Node {
  readonly typeId: string;
  readonly offset: { x: number; y: number; z: number };
  readonly chance: number;
  constructor(config: NodeConfig | string = '', offset?: Vec3, chance?: number) {
    super();
    if (typeof config === 'object' && config !== null) {
      this.typeId = cfg(config, 'typeId', '');
      this.offset = cfg(config, 'offset', { x: 0, y: 0, z: 0 });
      this.chance = cfg(config, 'chance', 1);
    } else {
      this.typeId = config;
      this.offset = offset ?? { x: 0, y: 0, z: 0 };
      this.chance = chance ?? 1;
    }
  }
  tick(ctx: TickContext): NodeStatus {
    if (ctx.rng('spawn') < this.chance) apiOf(ctx).spawnEntity?.(this.typeId, this.offset, this.chance);
    return NodeStatus.Success;
  }
}

/** 经 api.breakBlock 破坏方块（需 world:write 权限）。 */
export class BreakBlock extends Node {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  constructor(config: any = 0, y?: number, z?: number) {
    super();
    if (typeof config === 'object' && config !== null) {
      this.x = cfg(config, 'x', 0);
      this.y = cfg(config, 'y', 0);
      this.z = cfg(config, 'z', 0);
    } else {
      this.x = config;
      this.y = y ?? 0;
      this.z = z ?? 0;
    }
  }
  tick(ctx: TickContext): NodeStatus {
    apiOf(ctx).breakBlock?.(this.x, this.y, this.z);
    return NodeStatus.Success;
  }
}

/** 经 api.placeBlock 放置方块（需 world:write 权限）。 */
export class PlaceBlock extends Node {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly blockId: number;
  constructor(config: any = 0, y?: number, z?: number, blockId?: number) {
    super();
    if (typeof config === 'object' && config !== null) {
      this.x = cfg(config, 'x', 0);
      this.y = cfg(config, 'y', 0);
      this.z = cfg(config, 'z', 0);
      this.blockId = cfg(config, 'blockId', 0);
    } else {
      this.x = config;
      this.y = y ?? 0;
      this.z = z ?? 0;
      this.blockId = blockId ?? 0;
    }
  }
  tick(ctx: TickContext): NodeStatus {
    apiOf(ctx).placeBlock?.(this.x, this.y, this.z, this.blockId);
    return NodeStatus.Success;
  }
}

/** 经 api.playSound 播放音效。 */
export class PlaySound extends Node {
  readonly sound: string;
  readonly volume: number;
  constructor(config: any = '', volume?: number) {
    super();
    if (typeof config === 'object' && config !== null) {
      this.sound = cfg(config, 'sound', '');
      this.volume = cfg(config, 'volume', 1);
    } else {
      this.sound = config;
      this.volume = volume ?? 1;
    }
  }
  tick(ctx: TickContext): NodeStatus {
    apiOf(ctx).playSound?.(this.sound, this.volume);
    return NodeStatus.Success;
  }
}
