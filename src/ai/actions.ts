import { Node, NodeStatus, type TickContext } from './Node';
import {
  cfgNum,
  cfgOptNum,
  cfgStr,
  cfgUnknown,
  cfgVec3,
  isRecord,
  num,
  str,
  vec3,
  type NodeConfig,
  type Vec3Like,
} from './types';

/** 面向玩家并向前移动；距离 ≤ stopDist 时返回 Success，否则 Running。 */
export interface ChasePlayerConfig {
  speed?: number;
  stopDist?: number;
  speedFar?: number;
  speedClose?: number;
  closeDist?: number;
}
export class ChasePlayer extends Node {
  readonly speed: number;
  readonly stopDist: number;
  readonly speedFar?: number;
  readonly speedClose?: number;
  readonly closeDist: number;
  constructor(config?: ChasePlayerConfig, stopDist?: number);
  constructor(config?: number, stopDist?: number);
  constructor(config: NodeConfig = {}, stopDist?: number) {
    super();
    if (isRecord(config)) {
      this.speed = cfgNum(config, 'speed', 1);
      this.stopDist = cfgNum(config, 'stopDist', 2);
      this.speedFar = cfgOptNum(config, 'speedFar');
      this.speedClose = cfgOptNum(config, 'speedClose');
      this.closeDist = cfgNum(config, 'closeDist', 2.2);
    } else {
      this.speed = num(config, 1);
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
export interface FleeFromConfig {
  target?: string;
  speed?: number;
  minDist?: number;
}
export class FleeFrom extends Node {
  readonly target: string;
  readonly speed: number;
  readonly minDist: number;
  constructor(config?: FleeFromConfig);
  constructor(config?: string, speed?: number, minDist?: number);
  constructor(config: NodeConfig = {}, speed?: number, minDist?: number) {
    super();
    if (isRecord(config)) {
      this.target = cfgStr(config, 'target', 'player');
      this.speed = cfgNum(config, 'speed', 1);
      this.minDist = cfgNum(config, 'minDist', 8);
    } else {
      this.target = str(config, 'player');
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
export interface AttackPlayerConfig {
  damage?: number;
  cooldown?: number;
  attackRange?: number;
}
export class AttackPlayer extends Node {
  readonly damage: number;
  readonly cooldown: number;
  readonly attackRange: number;
  private attackTimer = 0;
  constructor(config?: AttackPlayerConfig);
  constructor(config?: number, cooldown?: number, attackRange?: number);
  constructor(config: NodeConfig = {}, cooldown?: number, attackRange?: number) {
    super();
    if (isRecord(config)) {
      this.damage = cfgNum(config, 'damage', 3);
      this.cooldown = cfgNum(config, 'cooldown', 1.05);
      this.attackRange = cfgNum(config, 'attackRange', 1.8);
    } else {
      this.damage = num(config, 3);
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
export interface WanderConfig {
  speed?: number;
  idleMin?: number;
  idleMax?: number;
  walkMin?: number;
  walkMax?: number;
}
export class Wander extends Node {
  readonly speed: number;
  readonly idleMin: number;
  readonly idleMax: number;
  readonly walkMin: number;
  readonly walkMax: number;
  private state: 'idle' | 'walk' = 'idle';
  private timer = 0;
  constructor(config?: WanderConfig);
  constructor(config?: number, idleMin?: number, idleMax?: number, walkMin?: number, walkMax?: number);
  constructor(config: NodeConfig = {}, idleMin?: number, idleMax?: number, walkMin?: number, walkMax?: number) {
    super();
    if (isRecord(config)) {
      this.speed = cfgNum(config, 'speed', 1);
      this.idleMin = cfgNum(config, 'idleMin', 1.5);
      this.idleMax = cfgNum(config, 'idleMax', 3.5);
      this.walkMin = cfgNum(config, 'walkMin', 2);
      this.walkMax = cfgNum(config, 'walkMax', 4);
    } else {
      this.speed = num(config, 1);
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
export interface LookAtConfig {
  target?: string;
  duration?: number;
}
export class LookAt extends Node {
  readonly target: string;
  readonly duration: number;
  private timer = 0;
  constructor(config?: LookAtConfig);
  constructor(config?: string, duration?: number);
  constructor(config: NodeConfig = {}, duration?: number) {
    super();
    if (isRecord(config)) {
      this.target = cfgStr(config, 'target', 'player');
      this.duration = cfgNum(config, 'duration', 1);
    } else {
      this.target = str(config, 'player');
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
export interface WaitConfig {
  seconds?: number;
}
export class Wait extends Node {
  readonly seconds: number;
  private timer = 0;
  constructor(config?: WaitConfig);
  constructor(config?: number);
  constructor(config: NodeConfig = 1) {
    super();
    this.seconds = isRecord(config) ? cfgNum(config, 'seconds', 1) : num(config, 1);
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
export interface EmitEventConfig {
  event?: string;
  payload?: unknown;
}
export class EmitEvent extends Node {
  readonly event: string;
  readonly payload: unknown;
  constructor(config?: EmitEventConfig);
  constructor(config?: string, payload?: unknown);
  constructor(config: NodeConfig = '', payload?: unknown) {
    super();
    if (isRecord(config)) {
      this.event = cfgStr(config, 'event', '');
      this.payload = cfgUnknown(config, 'payload', undefined);
    } else {
      this.event = str(config, '');
      this.payload = payload;
    }
  }
  tick(ctx: TickContext): NodeStatus {
    ctx.events.emit(this.event, this.payload);
    return NodeStatus.Success;
  }
}

/** 写黑板后返回 Success。 */
export interface SetBlackboardConfig {
  key?: string;
  value?: unknown;
}
export class SetBlackboard extends Node {
  readonly key: string;
  readonly value: unknown;
  constructor(config?: SetBlackboardConfig);
  constructor(config?: string, value?: unknown);
  constructor(config: NodeConfig = '', value?: unknown) {
    super();
    if (isRecord(config)) {
      this.key = cfgStr(config, 'key', '');
      this.value = cfgUnknown(config, 'value', undefined);
    } else {
      this.key = str(config, '');
      this.value = value;
    }
  }
  tick(ctx: TickContext): NodeStatus {
    ctx.blackboard.set(this.key, this.value);
    return NodeStatus.Success;
  }
}

/** 按 chance 概率生成实体（经 api.spawnEntity，需 world:write 权限）。 */
export interface SpawnEntityConfig {
  typeId?: string;
  offset?: Vec3Like;
  chance?: number;
}
export class SpawnEntity extends Node {
  readonly typeId: string;
  readonly offset: Vec3Like;
  readonly chance: number;
  constructor(config?: SpawnEntityConfig);
  constructor(config?: string, offset?: Vec3Like, chance?: number);
  constructor(config: NodeConfig = '', offset?: Vec3Like, chance?: number) {
    super();
    if (isRecord(config)) {
      this.typeId = cfgStr(config, 'typeId', '');
      this.offset = cfgVec3(config, 'offset', { x: 0, y: 0, z: 0 });
      this.chance = cfgNum(config, 'chance', 1);
    } else {
      this.typeId = str(config, '');
      this.offset = vec3(offset, { x: 0, y: 0, z: 0 });
      this.chance = chance ?? 1;
    }
  }
  tick(ctx: TickContext): NodeStatus {
    if (ctx.rng('spawn') < this.chance) ctx.api.spawnEntity?.(this.typeId, this.offset, this.chance);
    return NodeStatus.Success;
  }
}

/** 经 api.breakBlock 破坏方块（需 world:write 权限）。 */
export interface BreakBlockConfig {
  x?: number;
  y?: number;
  z?: number;
}
export class BreakBlock extends Node {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  constructor(config?: BreakBlockConfig);
  constructor(config?: number, y?: number, z?: number);
  constructor(config: NodeConfig = 0, y?: number, z?: number) {
    super();
    if (isRecord(config)) {
      this.x = cfgNum(config, 'x', 0);
      this.y = cfgNum(config, 'y', 0);
      this.z = cfgNum(config, 'z', 0);
    } else {
      this.x = num(config, 0);
      this.y = y ?? 0;
      this.z = z ?? 0;
    }
  }
  tick(ctx: TickContext): NodeStatus {
    ctx.api.breakBlock?.(this.x, this.y, this.z);
    return NodeStatus.Success;
  }
}

/** 经 api.placeBlock 放置方块（需 world:write 权限）。 */
export interface PlaceBlockConfig {
  x?: number;
  y?: number;
  z?: number;
  blockId?: number;
}
export class PlaceBlock extends Node {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly blockId: number;
  constructor(config?: PlaceBlockConfig);
  constructor(config?: number, y?: number, z?: number, blockId?: number);
  constructor(config: NodeConfig = 0, y?: number, z?: number, blockId?: number) {
    super();
    if (isRecord(config)) {
      this.x = cfgNum(config, 'x', 0);
      this.y = cfgNum(config, 'y', 0);
      this.z = cfgNum(config, 'z', 0);
      this.blockId = cfgNum(config, 'blockId', 0);
    } else {
      this.x = num(config, 0);
      this.y = y ?? 0;
      this.z = z ?? 0;
      this.blockId = blockId ?? 0;
    }
  }
  tick(ctx: TickContext): NodeStatus {
    ctx.api.placeBlock?.(this.x, this.y, this.z, this.blockId);
    return NodeStatus.Success;
  }
}

/** 经 api.playSound 播放音效。 */
export interface PlaySoundConfig {
  sound?: string;
  volume?: number;
}
export class PlaySound extends Node {
  readonly sound: string;
  readonly volume: number;
  constructor(config?: PlaySoundConfig);
  constructor(config?: string, volume?: number);
  constructor(config: NodeConfig = '', volume?: number) {
    super();
    if (isRecord(config)) {
      this.sound = cfgStr(config, 'sound', '');
      this.volume = cfgNum(config, 'volume', 1);
    } else {
      this.sound = str(config, '');
      this.volume = volume ?? 1;
    }
  }
  tick(ctx: TickContext): NodeStatus {
    ctx.api.playSound?.(this.sound, this.volume);
    return NodeStatus.Success;
  }
}
