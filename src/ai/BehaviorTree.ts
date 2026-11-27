import type { Node, NodeCtor, TickContext } from './Node';
import { NodeStatus } from './Node';
import { Selector, Sequence, Parallel, RandomSelector } from './composites';
import { Inverter, Repeater, UntilFail, UntilSuccess } from './decorators';
import {
  CanSeePlayer, DistanceLt, HealthPctLt, IsDay, IsNight, IsInWater, IsOnGround,
  HasTarget, TargetInRange, BlackboardEq, CanReach,
} from './conditions';
import {
  ChasePlayer, FleeFrom, AttackPlayer, Wander, LookAt, Wait, EmitEvent, SetBlackboard,
  SpawnEntity, BreakBlock, PlaceBlock, PlaySound,
} from './actions';
import { NodeRegistry } from './registry';

/** JSON 行为树配置里的节点描述（组合节点带 children / child，叶子节点带 nodeType + 参数字段）。 */
export interface NodeConfig {
  type?: string;
  name?: string;
  nodeType?: string;
  children?: NodeConfig[];
  child?: NodeConfig;
  [key: string]: unknown;
}

/** 内置节点工厂：condition:/action: 前缀区分条件与动作同名类型。 */
const defaultRegistry = new NodeRegistry();
for (const [name, ctor] of [
  ['CanSeePlayer', CanSeePlayer], ['DistanceLt', DistanceLt], ['HealthPctLt', HealthPctLt],
  ['IsDay', IsDay], ['IsNight', IsNight], ['IsInWater', IsInWater], ['IsOnGround', IsOnGround],
  ['HasTarget', HasTarget], ['TargetInRange', TargetInRange], ['BlackboardEq', BlackboardEq],
  ['CanReach', CanReach],
] as [string, NodeCtor][]) {
  defaultRegistry.register(`condition:${name}`, ctor);
}
for (const [name, ctor] of [
  ['ChasePlayer', ChasePlayer], ['FleeFrom', FleeFrom], ['AttackPlayer', AttackPlayer],
  ['Wander', Wander], ['LookAt', LookAt], ['Wait', Wait], ['EmitEvent', EmitEvent],
  ['SetBlackboard', SetBlackboard], ['SpawnEntity', SpawnEntity], ['BreakBlock', BreakBlock],
  ['PlaceBlock', PlaceBlock], ['PlaySound', PlaySound],
] as [string, NodeCtor][]) {
  defaultRegistry.register(`action:${name}`, ctor);
}

function build(config: NodeConfig | undefined, registry: NodeRegistry): Node {
  const type = config?.type;
  if (!type || typeof type !== 'string') throw new Error('Node config missing type');
  const children = (config.children ?? []) as NodeConfig[];
  switch (type) {
    case 'selector':
      return new Selector(children.map((c) => build(c, registry)));
    case 'sequence':
      return new Sequence(children.map((c) => build(c, registry)));
    case 'parallel':
      return new Parallel(children.map((c) => build(c, registry)));
    case 'randomSelector':
      return new RandomSelector(children.map((c) => build(c, registry)));
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

/** 行为树：从 JSON 配置编译，tick 委托根节点，reset 清空运行时状态。 */
export class BehaviorTree {
  private root: Node;
  constructor(root: Node) { this.root = root; }

  /** 从 JSON 配置编译行为树。非法 JSON（缺 root / 缺 type / 未知 nodeType）抛错。 */
  static fromJSON(json: { root?: NodeConfig }): BehaviorTree {
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
