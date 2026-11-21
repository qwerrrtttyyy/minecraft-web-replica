import { Node } from './Node';

/** 节点工厂注册表：name → 构造函数。第三方插件可注册自定义节点类型。 */
export class NodeRegistry {
  private readonly nodes = new Map<string, new (config: any) => Node>();

  register(name: string, ctor: new (config: any) => Node): void {
    this.nodes.set(name, ctor);
  }

  create(name: string, config: any): Node {
    const ctor = this.nodes.get(name);
    if (!ctor) throw new Error(`Unknown node type: ${name}`);
    return new ctor(config);
  }
}
