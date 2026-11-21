import { Node, NodeStatus, TickContext } from './Node';

/** 反转子节点的 Success / Failure，Running 保持不变。 */
export class Inverter extends Node {
  constructor(public readonly child: Node) { super(); }
  tick(ctx: TickContext): NodeStatus {
    const s = this.child.tick(ctx);
    if (s === NodeStatus.Success) return NodeStatus.Failure;
    if (s === NodeStatus.Failure) return NodeStatus.Success;
    return NodeStatus.Running;
  }
  reset(): void { this.child.reset(); }
}

/** 子节点完成（Success/Failure）后重置并重新 tick，持续返回 Running；可限定最大次数。 */
export class Repeater extends Node {
  constructor(public readonly child: Node, public readonly maxTimes?: number) { super(); }
  private times = 0;
  tick(ctx: TickContext): NodeStatus {
    if (this.maxTimes !== undefined && this.times >= this.maxTimes) return NodeStatus.Success;
    const s = this.child.tick(ctx);
    if (s === NodeStatus.Success || s === NodeStatus.Failure) {
      this.times++;
      this.child.reset();
    }
    return NodeStatus.Running;
  }
  reset(): void {
    this.times = 0;
    this.child.reset();
  }
}

/** 子节点返回 Success 时继续 Running，返回 Failure 时返回 Success（“直到失败”）。 */
export class UntilFail extends Node {
  constructor(public readonly child: Node) { super(); }
  tick(ctx: TickContext): NodeStatus {
    const s = this.child.tick(ctx);
    return s === NodeStatus.Failure ? NodeStatus.Success : NodeStatus.Running;
  }
  reset(): void { this.child.reset(); }
}

/** 子节点返回 Failure 时继续 Running，返回 Success 时返回 Failure（“直到成功”）。 */
export class UntilSuccess extends Node {
  constructor(public readonly child: Node) { super(); }
  tick(ctx: TickContext): NodeStatus {
    const s = this.child.tick(ctx);
    return s === NodeStatus.Success ? NodeStatus.Failure : NodeStatus.Running;
  }
  reset(): void { this.child.reset(); }
}
