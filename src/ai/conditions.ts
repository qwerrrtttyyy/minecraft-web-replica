import { Node, NodeStatus, type TickContext } from './Node';
import { Perception } from './Perception';
import { cfgBool, cfgNum, cfgNumArray, cfgStr, cfgUnknown, isRecord, num, str, type NodeConfig } from './types';

/** 玩家在距离内且无固体遮挡 → Success。 */
export interface CanSeePlayerConfig {
  maxDist?: number;
}
export class CanSeePlayer extends Node {
  readonly maxDist: number;
  constructor(config?: CanSeePlayerConfig);
  constructor(config?: number);
  constructor(config: NodeConfig = 16) {
    super();
    this.maxDist = isRecord(config) ? cfgNum(config, 'maxDist', 16) : num(config, 16);
  }
  tick(ctx: TickContext): NodeStatus {
    return new Perception(ctx.world).canSee(ctx.entity, { pos: ctx.playerPos }, this.maxDist)
      ? NodeStatus.Success
      : NodeStatus.Failure;
  }
}

/** 到指定目标（player / 黑板位置）距离 < dist → Success。 */
export interface DistanceLtConfig {
  target?: string;
  dist?: number;
  blackboardKey?: string;
  horizontal?: boolean;
}
export class DistanceLt extends Node {
  readonly target: string;
  readonly dist: number;
  readonly blackboardKey: string;
  readonly horizontal: boolean;
  constructor(config?: DistanceLtConfig);
  constructor(config?: string, dist?: number, blackboardKey?: string);
  constructor(config: NodeConfig = 'player', dist?: number, blackboardKey?: string) {
    super();
    if (isRecord(config)) {
      this.target = cfgStr(config, 'target', 'player');
      this.dist = cfgNum(config, 'dist', 16);
      this.blackboardKey = cfgStr(config, 'blackboardKey', 'target');
      this.horizontal = cfgBool(config, 'horizontal', false);
    } else {
      this.target = str(config, 'player');
      this.dist = dist ?? 16;
      this.blackboardKey = blackboardKey ?? 'target';
      this.horizontal = false;
    }
  }
  tick(ctx: TickContext): NodeStatus {
    let tx = ctx.playerPos.x;
    let ty = ctx.playerPos.y;
    let tz = ctx.playerPos.z;
    if (this.target === 'blackboard') {
      const t = ctx.blackboard.get<{ x: number; y: number; z: number }>(this.blackboardKey);
      if (!t) return NodeStatus.Failure;
      tx = t.x;
      ty = t.y;
      tz = t.z;
    }
    const dx = ctx.entity.pos.x - tx;
    const dy = ctx.entity.pos.y - ty;
    const dz = ctx.entity.pos.z - tz;
    const d = this.horizontal ? Math.hypot(dx, dz) : Math.hypot(dx, dy, dz);
    return d < this.dist ? NodeStatus.Success : NodeStatus.Failure;
  }
}

/** 血量百分比 < pct → Success（血量从黑板 hp/maxHp 读取）。 */
export interface HealthPctLtConfig {
  pct?: number;
}
export class HealthPctLt extends Node {
  readonly pct: number;
  constructor(config?: HealthPctLtConfig);
  constructor(config?: number);
  constructor(config: NodeConfig = 0.5) {
    super();
    this.pct = isRecord(config) ? cfgNum(config, 'pct', 0.5) : num(config, 0.5);
  }
  tick(ctx: TickContext): NodeStatus {
    const hp = ctx.blackboard.get<number>('hp');
    const maxHp = ctx.blackboard.get<number>('maxHp');
    if (hp === undefined || maxHp === undefined || maxHp <= 0) return NodeStatus.Failure;
    return hp / maxHp < this.pct ? NodeStatus.Success : NodeStatus.Failure;
  }
}

export class IsDay extends Node {
  tick(ctx: TickContext): NodeStatus {
    return ctx.daylight > 0.55 ? NodeStatus.Success : NodeStatus.Failure;
  }
}
export class IsNight extends Node {
  tick(ctx: TickContext): NodeStatus {
    return ctx.daylight < 0.35 ? NodeStatus.Success : NodeStatus.Failure;
  }
}

/** 脚底方块在液体 id 列表中 → Success。 */
export interface IsInWaterConfig {
  liquidBlockIds?: number[];
}
export class IsInWater extends Node {
  readonly liquidBlockIds: number[];
  constructor(config?: IsInWaterConfig);
  constructor(config?: readonly number[]);
  constructor(config: NodeConfig = []) {
    super();
    if (Array.isArray(config)) this.liquidBlockIds = config.map((id) => num(id, 0));
    else if (isRecord(config)) this.liquidBlockIds = cfgNumArray(config, 'liquidBlockIds', []);
    else this.liquidBlockIds = [];
  }
  tick(ctx: TickContext): NodeStatus {
    return new Perception(ctx.world).isInWater(ctx.entity, this.liquidBlockIds)
      ? NodeStatus.Success
      : NodeStatus.Failure;
  }
}

export class IsOnGround extends Node {
  tick(ctx: TickContext): NodeStatus {
    return ctx.blackboard.get<boolean>('onGround') === true ? NodeStatus.Success : NodeStatus.Failure;
  }
}
export class HasTarget extends Node {
  tick(ctx: TickContext): NodeStatus {
    return ctx.blackboard.has('target') ? NodeStatus.Success : NodeStatus.Failure;
  }
}

/** 黑板目标到实体距离 ≤ range → Success。 */
export interface TargetInRangeConfig {
  range?: number;
}
export class TargetInRange extends Node {
  readonly range: number;
  constructor(config?: TargetInRangeConfig);
  constructor(config?: number);
  constructor(config: NodeConfig = 1) {
    super();
    this.range = isRecord(config) ? cfgNum(config, 'range', 1) : num(config, 1);
  }
  tick(ctx: TickContext): NodeStatus {
    const t = ctx.blackboard.get<{ x: number; y: number; z: number }>('target');
    if (!t) return NodeStatus.Failure;
    return Math.hypot(ctx.entity.pos.x - t.x, ctx.entity.pos.y - t.y, ctx.entity.pos.z - t.z) <= this.range
      ? NodeStatus.Success
      : NodeStatus.Failure;
  }
}

/** 黑板键值严格相等 → Success。 */
export interface BlackboardEqConfig {
  key?: string;
  value?: unknown;
}
export class BlackboardEq extends Node {
  readonly key: string;
  readonly value: unknown;
  constructor(config?: BlackboardEqConfig);
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
    return ctx.blackboard.get(this.key) === this.value ? NodeStatus.Success : NodeStatus.Failure;
  }
}

/** 贪婪扩展能到达目标格 → Success。 */
export interface CanReachConfig {
  x?: number;
  y?: number;
  z?: number;
}
export class CanReach extends Node {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  constructor(config?: CanReachConfig);
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
    return new Perception(ctx.world).canReach(ctx.entity, this.x, this.y, this.z)
      ? NodeStatus.Success
      : NodeStatus.Failure;
  }
}
