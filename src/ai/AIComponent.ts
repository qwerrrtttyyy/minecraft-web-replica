import { Blackboard } from './Blackboard';
import type { BehaviorTree } from './BehaviorTree';
import type { NodeStatus, TickContext } from './Node';
import type { Vec3Like } from './types';

/**
 * 运行时实体标识（仅 AI 系统使用，不依赖 three / Entity 类）。
 * 可选字段由 AIService 在 attach / update 时读写，实体类无需实现任何接口声明即可满足结构约束。
 */
export interface EntityLike {
  id: number;
  pos: Vec3Like;
  type: { id: string };
  aiComponent?: AIComponent;
  hp?: number;
  maxHp?: number;
  onGround?: boolean;
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

  tick(_dt: number, ctx: TickContext): NodeStatus {
    return this.tree.tick(ctx);
  }
}
