import type { Node } from './Node';
import type { NodeConfig, NodeCtor } from './types';

/** 节点工厂注册表：name → 构造函数。第三方插件可注册自定义节点类型。 */
export class NodeRegistry {
  private readonly nodes = new Map<string, NodeCtor>();

  register(name: string, ctor: NodeCtor): void {
    this.nodes.set(name, ctor);
  }

  create(name: string, config: NodeConfig): Node {
    const ctor = this.nodes.get(name);
    if (!ctor) throw new Error(`Unknown node type: ${name}`);
    // NodeCtor 首参以 never 声明以兼容任意插件构造签名；config 的真实形态由节点自身守卫收窄
    return new ctor(config as never);
  }
}
