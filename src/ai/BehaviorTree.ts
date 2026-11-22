import type { Node, NodeStatus, TickContext } from './Node';
import { Selector, Sequence, Parallel, RandomSelector } from './composites';
import { Inverter, Repeater, UntilFail, UntilSuccess } from './decorators';
import {
  CanSeePlayer,
  DistanceLt,
  HealthPctLt,
  IsDay,
  IsNight,
  IsInWater,
  IsOnGround,
  HasTarget,
  TargetInRange,
  BlackboardEq,
  CanReach,
} from './conditions';
import {
  ChasePlayer,
  FleeFrom,
  AttackPlayer,
  Wander,
  LookAt,
  Wait,
  EmitEvent,
  SetBlackboard,
  SpawnEntity,
  BreakBlock,
  PlaceBlock,
  PlaySound,
} from './actions';
import { NodeRegistry } from './registry';
import type { BehaviorNodeJSON, BehaviorTreeJSON, NodeCtor } from './types';

/** 内置节点工厂：condition:/action: 前缀区分条件与动作同名类型。 */
const defaultRegistry = new NodeRegistry();

/** 条件节点注册表：开放 NodeCtor 类型，插件可用 register 追加自定义节点。 */
const conditionCtors: ReadonlyArray<readonly [string, NodeCtor]> = [
  ['CanSeePlayer', CanSeePlayer],
  ['DistanceLt', DistanceLt],
  ['HealthPctLt', HealthPctLt],
  ['IsDay', IsDay],
  ['IsNight', IsNight],
  ['IsInWater', IsInWater],
  ['IsOnGround', IsOnGround],
  ['HasTarget', HasTarget],
  ['TargetInRange', TargetInRange],
  ['BlackboardEq', BlackboardEq],
  ['CanReach', CanReach],
];
for (const [name, ctor] of conditionCtors) {
  defaultRegistry.register(`condition:${name}`, ctor);
}

/** 动作节点注册表：与条件节点同样使用开放 NodeCtor。 */
const actionCtors: ReadonlyArray<readonly [string, NodeCtor]> = [
  ['ChasePlayer', ChasePlayer],
  ['FleeFrom', FleeFrom],
  ['AttackPlayer', AttackPlayer],
  ['Wander', Wander],
  ['LookAt', LookAt],
  ['Wait', Wait],
  ['EmitEvent', EmitEvent],
  ['SetBlackboard', SetBlackboard],
  ['SpawnEntity', SpawnEntity],
  ['BreakBlock', BreakBlock],
  ['PlaceBlock', PlaceBlock],
  ['PlaySound', PlaySound],
];
for (const [name, ctor] of actionCtors) {
  defaultRegistry.register(`action:${name}`, ctor);
}

/**
 * 递归编译 JSON 节点。
 * config 允许为 undefined（装饰器缺 child 时走与原实现相同的抛错路径）。
 */
function build(config: BehaviorNodeJSON | undefined, registry: NodeRegistry): Node {
  if (!config || typeof config.type !== 'string') throw new Error('Node config missing type');
  const type = config.type;
  switch (type) {
    case 'selector':
      return new Selector(buildChildren(config, registry));
    case 'sequence':
      return new Sequence(buildChildren(config, registry));
    case 'parallel':
      return new Parallel(buildChildren(config, registry));
    case 'randomSelector':
      return new RandomSelector(buildChildren(config, registry));
    case 'inverter':
      return new Inverter(build(config.child, registry));
    case 'repeater':
      return new Repeater(build(config.child, registry));
    case 'until_fail':
      return new UntilFail(build(config.child, registry));
    case 'until_success':
      return new UntilSuccess(build(config.child, registry));
    case 'condition': {
      if (!config.nodeType) throw new Error('Condition node missing nodeType');
      return registry.create(`condition:${config.nodeType}`, config);
    }
    case 'action': {
      if (!config.nodeType) throw new Error('Action node missing nodeType');
      return registry.create(`action:${config.nodeType}`, config);
    }
    default:
      throw new Error(`Unknown node type: ${type}`);
  }
}

/** children 可能是 readonly 元组（as const）或普通数组；统一编译为 Node[]。 */
function buildChildren(config: BehaviorNodeJSON, registry: NodeRegistry): Node[] {
  const raw = config.children;
  if (!Array.isArray(raw)) return [];
  return raw.map((child) => build(child, registry));
}

/** 行为树：从 JSON 配置编译，tick 委托根节点，reset 清空运行时状态。 */
export class BehaviorTree {
  private root: Node;
  constructor(root: Node) {
    this.root = root;
  }

  /** 从 JSON 配置编译行为树。非法 JSON（缺 root / 缺 type / 未知 nodeType）抛错。 */
  static fromJSON(json: BehaviorTreeJSON): BehaviorTree {
    if (!json || typeof json !== 'object' || !json.root || typeof json.root !== 'object') {
      throw new Error('BehaviorTree JSON missing root');
    }
    return new BehaviorTree(build(json.root, defaultRegistry));
  }

  tick(ctx: TickContext): NodeStatus {
    return this.root.tick(ctx);
  }

  reset(): void {
    this.root.reset();
  }
}
