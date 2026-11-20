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
  private readonly waits = new Set<{
    timer: ReturnType<typeof setTimeout>;
    off: () => void;
    reject: (e: Error) => void;
  }>();
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
    // fired 与 EventService.once 同理：保证回调只触发一次，且对重入安全。
    // 直接复用 bus.once 会绕过本通道的 offs 登记（dispose 无法撤销），故在此独立实现。
    let off: () => void = () => {};
    let fired = false;
    off = this.on(type, (p) => {
      if (fired) return;
      fired = true;
      off();
      fn(p);
    });
    return () => {
      if (fired) return;
      fired = true;
      off();
    };
  }

  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    this.bus.emit(type, payload);
  }

  /**
   * v1.3.2：通道内的 waitFor 必须走本通道订阅，才能在 dispose 时一起撤销。
   * 旧实现直接调用 bus.waitFor()，插件停用后订阅与 Promise 都留在总线上。
   */
  waitFor<K extends keyof GameEvents>(type: K, timeoutMs = 5000): Promise<GameEvents[K]> {
    if (this.disposed) {
      return Promise.reject(new Error(`[events] 通道 ${this.namespace} 已关闭`));
    }
    return new Promise<GameEvents[K]>((resolve, reject) => {
      const entry = {
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
        off: () => {},
        reject,
      };
      entry.timer = setTimeout(() => {
        this.waits.delete(entry);
        entry.off();
        reject(new Error(`[events] 等待 ${String(type)} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      entry.off = this.once(type, (p) => {
        clearTimeout(entry.timer);
        this.waits.delete(entry);
        resolve(p);
      });
      this.waits.add(entry);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const w of this.waits) {
      clearTimeout(w.timer);
      w.off();
      w.reject(new Error(`[events] 通道 ${this.namespace} 已关闭`));
    }
    this.waits.clear();
    for (const off of this.offs.splice(0)) off();
    this.bus.release(this);
  }
}
