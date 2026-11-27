import { Blackboard } from './Blackboard';

/** 行为树节点执行状态。 */
export enum NodeStatus {
  Running = 0,
  Success = 1,
  Failure = 2,
}

/** 行为树节点 tick 时接收的只读上下文。所有随机性必须经 ctx.rng，禁止 Math.random。 */
export interface TickContext {
  entity: Readonly<{
    id: number;
    pos: { x: number; y: number; z: number };
    type: { id: string };
  }>;
  world: Readonly<{
    getBlock(x: number, y: number, z: number): number;
    isSolidAt(x: number, y: number, z: number): boolean;
    surfaceHeight(x: number, z: number): number;
  }>;
  playerPos: { x: number; y: number; z: number };
  /** 0~1 日照强度 */
  daylight: number;
  playerDead: boolean;
  /** 0~1 确定性随机，底层 mulberry32(hash(worldSeed, entityId, label)) */
  rng: (label?: string) => number;
  events: { emit<K extends string>(type: K, payload: unknown): void };
  /** 按权限裁剪的 CraftAPI 视图，副作用节点经此发送 */
  api: unknown;
  blackboard: Blackboard;
  dt: number;
}

/** 行为树节点基类。子类仅实现 tick，不直接 import three / World / DOM。 */
export abstract class Node {
  abstract tick(ctx: TickContext): NodeStatus;
  reset(): void {}
}

/**
 * 节点构造函数签名：首参为 JSON 配置对象（部分内置节点兼容位置参数形态），产出 Node 实例。
 * 首参声明为可选的宽类型，使「必传 config」「带额外位置参数」的构造签名都能自然赋值过来。
 */
export type NodeCtor = new (config?: Record<string, unknown>) => Node;

/**
 * 从节点配置里读取字段：仅当 config 是非数组普通对象且包含该键时生效，否则回退默认值。
 * 条件 / 动作节点的构造统一走这里，避免各处重复 typeof 判断与 any 断言。
 */
export function cfg<T>(config: unknown, key: string, fallback: T): T {
  if (config && typeof config === 'object' && !Array.isArray(config) && key in config) {
    return (config as Record<string, unknown>)[key] as T;
  }
  return fallback;
}
