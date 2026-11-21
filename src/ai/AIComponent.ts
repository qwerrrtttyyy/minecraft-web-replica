import { Blackboard } from './Blackboard';
import { BehaviorTree } from './BehaviorTree';
import { NodeStatus, TickContext } from './Node';

/** 运行时实体标识（仅 AI 系统使用，不依赖 three / Entity 类）。 */
export interface EntityLike {
  id: number;
  pos: { x: number; y: number; z: number };
  type: { id: string };
}

/** 挂在实体上的 AI 运行时：行为树 + 黑板 + 启停开关。 */
export class AIComponent {
  readonly entity: EntityLike;
  readonly tree: BehaviorTree;
  readonly seed: number;
  readonly blackboard = new Blackboard();
  enabled = true;

  constructor(entity: EntityLike, tree: BehaviorTree, seed: number) {
    this.entity = entity;
    this.tree = tree;
    this.seed = seed;
  }

  tick(dt: number, ctx: TickContext): NodeStatus {
    return this.tree.tick(ctx);
  }
}
