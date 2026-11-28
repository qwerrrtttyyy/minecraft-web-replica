import { Node, NodeStatus, type TickContext } from './Node';

/** 遇到第一个成功的子节点即返回 Success；全部失败返回 Failure。 */
export class Selector extends Node {
  constructor(public readonly children: Node[]) {
    super();
  }
  private runningIndex = 0;
  tick(ctx: TickContext): NodeStatus {
    for (let i = this.runningIndex; i < this.children.length; i++) {
      const s = this.children[i].tick(ctx);
      if (s === NodeStatus.Success) {
        this.runningIndex = 0;
        return NodeStatus.Success;
      }
      if (s === NodeStatus.Running) {
        this.runningIndex = i;
        return NodeStatus.Running;
      }
    }
    this.runningIndex = 0;
    return NodeStatus.Failure;
  }
  reset(): void {
    this.runningIndex = 0;
    for (const c of this.children) c.reset();
  }
}

/** 所有子节点成功才返回 Success；任一失败即 Failure。 */
export class Sequence extends Node {
  constructor(public readonly children: Node[]) {
    super();
  }
  private runningIndex = 0;
  tick(ctx: TickContext): NodeStatus {
    for (let i = this.runningIndex; i < this.children.length; i++) {
      const s = this.children[i].tick(ctx);
      if (s === NodeStatus.Failure) {
        this.runningIndex = 0;
        return NodeStatus.Failure;
      }
      if (s === NodeStatus.Running) {
        this.runningIndex = i;
        return NodeStatus.Running;
      }
    }
    this.runningIndex = 0;
    return NodeStatus.Success;
  }
  reset(): void {
    this.runningIndex = 0;
    for (const c of this.children) c.reset();
  }
}

/** 并发 tick 全部子节点：成功数 ≥ successCount → Success；失败数 ≥ failureCount → Failure；否则 Running。 */
export class Parallel extends Node {
  constructor(
    public readonly children: Node[],
    public readonly successCount?: number,
    public readonly failureCount?: number,
  ) {
    super();
  }
  tick(ctx: TickContext): NodeStatus {
    let success = 0;
    let failure = 0;
    for (const c of this.children) {
      const s = c.tick(ctx);
      if (s === NodeStatus.Success) success++;
      else if (s === NodeStatus.Failure) failure++;
    }
    if (success >= (this.successCount ?? this.children.length)) return NodeStatus.Success;
    if (failure >= (this.failureCount ?? 1)) return NodeStatus.Failure;
    return NodeStatus.Running;
  }
  reset(): void {
    for (const c of this.children) c.reset();
  }
}

/** 按 rng 随机打乱子节点顺序后按 Selector 逻辑执行。 */
export class RandomSelector extends Node {
  constructor(public readonly children: Node[]) {
    super();
  }
  private runningIndex = 0;
  private order: number[] = [];
  tick(ctx: TickContext): NodeStatus {
    // 重新随机排序（首版每帧重排，简单且可测；Running 子节点会在下帧重新参与排序）
    this.order = this.children.map((_, i) => i);
    for (let i = this.order.length - 1; i > 0; i--) {
      const j = Math.floor(ctx.rng('randomSelector') * (i + 1));
      [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
    }
    for (const idx of this.order) {
      const s = this.children[idx].tick(ctx);
      if (s === NodeStatus.Success) return NodeStatus.Success;
      if (s === NodeStatus.Running) return NodeStatus.Running;
    }
    return NodeStatus.Failure;
  }
  reset(): void {
    this.runningIndex = 0;
    this.order = [];
    for (const c of this.children) c.reset();
  }
}
