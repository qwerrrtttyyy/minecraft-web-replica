import type { BlockId, Vec3Like } from './types';

/**
 * 游戏事件表：扩展方可通过 EventBus.on 监听任意事件，
 * 也可以通过声明合并追加自定义事件类型。
 */
export interface GameEvents {
  'block:break': { x: number; y: number; z: number; block: BlockId };
  'block:place': { x: number; y: number; z: number; block: BlockId };
  'block:ignite': { x: number; y: number; z: number };
  'explosion': { center: Vec3Like; radius: number };
  'player:spawn': { position: Vec3Like };
  'player:move': { position: Vec3Like };
  'player:camera': { mode: number };
  'hotbar:select': { index: number; block: BlockId };
  'time:change': { dayTime: number; daylight: number };
  'chunk:generated': { cx: number; cz: number };
  'chunk:meshed': { cx: number; cz: number };
  'entity:spawn': { type: string; id: number };
  'entity:despawn': { type: string; id: number };
  'entity:dead': { type: string; id: number };
  'entity:hurt': { type: string; id: number; hp: number; maxHp: number };
  /** 生存模式：任何来源的掉血 */
  'survival:damage': { amount: number; health: number; cause: string };
  /** 生存模式：死亡 */
  'survival:death': { cause: string };
  /** 生存模式：重生 */
  'survival:respawn': { position: Vec3Like };
  /** 生存模式：进食 */
  'survival:eat': { item: string; hunger: number };
  /** 生存模式：背包变化（kind: block/item） */
  'inventory:change': { key: string; count: number };
  'game:start': { seed: number };
  'game:pause': { paused: boolean };
  'save:done': { bytes: number };
}

type Handler<T> = (payload: T) => void;

/** 轻量类型安全事件总线（扩展点：所有 gameplay 钩子都经过这里） */
export class EventBus {
  private map = new Map<string, Set<Handler<never>>>();

  on<K extends keyof GameEvents>(type: K, fn: Handler<GameEvents[K]>): () => void {
    let set = this.map.get(type as string);
    if (!set) {
      set = new Set();
      this.map.set(type as string, set);
    }
    set.add(fn as Handler<never>);
    return () => this.off(type, fn);
  }

  off<K extends keyof GameEvents>(type: K, fn: Handler<GameEvents[K]>): void {
    this.map.get(type as string)?.delete(fn as Handler<never>);
  }

  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    const set = this.map.get(type as string);
    if (!set) return;
    for (const fn of [...set]) {
      // 单个监听器异常不应中断整帧更新链路
      try {
        (fn as Handler<GameEvents[K]>)(payload);
      } catch (e) {
        console.error(`[EventBus] ${String(type)} 监听器异常`, e);
      }
    }
  }
}