import type { GameEvents } from './GameEvents';
import type { EventService } from './EventService';

type Handler<T> = (payload: T) => void;

/**
 * 归属某个命名空间（通常是一个插件 id）的订阅作用域。
 *
 * 插件停用 / 卸载时只需 `channel.dispose()`，即可一次性撤销本插件注册的全部
 * on / once / waitFor，从根上消除「插件卸载后回调还在跑」的内存泄漏。
 * 旧架构的 `EventBus.on()` 返回裸 off 函数，没有任何归属管理。
 */
export class EventChannel {
  private readonly offs: (() => void)[] = [];
  private disposed = false;

  constructor(private readonly bus: EventService, readonly namespace: string) {
    // 无论通过 scope() 还是直接构造，都登记到服务，保证 stats/dispose 可观测
    bus.track(this);
  }

  on<K extends keyof GameEvents>(type: K, fn: Handler<GameEvents[K]>): () => void {
    if (this.disposed) throw new Error(`[events] 通道 ${this.namespace} 已关闭`);
    const off = this.bus.on(type, fn, this.namespace);
    this.offs.push(off);
    return () => {
      off();
      const i = this.offs.indexOf(off);
      if (i >= 0) this.offs.splice(i, 1);
    };
  }

  once<K extends keyof GameEvents>(type: K, fn: Handler<GameEvents[K]>): () => void {
    let off: () => void = () => {};
    off = this.on(type, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    this.bus.emit(type, payload);
  }

  waitFor<K extends keyof GameEvents>(type: K, timeoutMs = 5000): Promise<GameEvents[K]> {
    return this.bus.waitFor(type, timeoutMs);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.offs.splice(0)) off();
    this.bus.release(this);
  }
}
