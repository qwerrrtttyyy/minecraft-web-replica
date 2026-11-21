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
