import type { AnyEventHandler, EventService } from './EventService';
import type { GameEvents } from './GameEvents';

type Handler<T> = (payload: T) => void;

export interface EventChannelOptions {
  /**
   * 是否允许本通道 `emit`。插件通道按 `api:emit` 权限创建（默认拒绝），
   * 避免插件绕过权限裁剪直接派发事件。直接构造 / `EventService.scope()` 默认放行。
   */
  canEmit?: boolean;
}

/**
 * 归属某个命名空间（通常是一个插件 id）的订阅作用域。
 *
 * 插件停用 / 卸载时只需 `channel.dispose()`，即可一次性撤销本插件注册的全部
 * on / once / waitFor / onAny 以及 fork 出去的子通道，从根上消除
 * 「插件卸载后回调还在跑」的内存泄漏。
 * 旧架构的 `EventBus.on()` 返回裸 off 函数，没有任何归属管理。
 */
export class EventChannel {
  private readonly offs: (() => void)[] = [];
  private readonly anyOffs: (() => void)[] = [];
  private readonly children = new Set<EventChannel>();
  private readonly waits = new Set<{
    timer: ReturnType<typeof setTimeout>;
    off: () => void;
    reject: (e: Error) => void;
  }>();
  private readonly canEmit: boolean;
  /** 父通道（fork 出来时登记），子通道自行 dispose 后要把自己摘掉 */
  private parent?: EventChannel;
  private disposed = false;

  constructor(
    private readonly bus: EventService,
    readonly namespace: string,
    options: EventChannelOptions = {},
  ) {
    this.canEmit = options.canEmit !== false;
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

  /**
   * 派发事件。插件通道默认关闭此能力：`api:emit` 权限必须同时盖住
   * `ctx.events.emit` 与 `api.events.scope(...).emit`，否则权限形同虚设。
   */
  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    if (!this.canEmit) {
      throw new Error(`[events] 通道 ${this.namespace} 未授权发送事件（manifest.permissions 需声明 api:emit）`);
    }
    this.bus.emit(type, payload);
  }

  /**
   * 派生一个子通道：订阅与 emit 权限继承父通道，并随父通道一起 dispose。
   * 插件通过 `api.events.scope(ns)` 拿到的就是子通道，避免产生脱离插件生命周期的孤儿订阅。
   */
  fork(namespace: string): EventChannel {
    if (this.disposed) throw new Error(`[events] 通道 ${this.namespace} 已关闭`);
    const child = new EventChannel(this.bus, namespace, { canEmit: this.canEmit });
    child.parent = this;
    this.children.add(child);
    return child;
  }

  /** 全局观测钩子，登记在本通道下，dispose 时一并撤销 */
  onAny(fn: AnyEventHandler): () => void {
    if (this.disposed) throw new Error(`[events] 通道 ${this.namespace} 已关闭`);
    const off = this.bus.onAny(fn);
    this.anyOffs.push(off);
    return () => {
      off();
      const i = this.anyOffs.indexOf(off);
      if (i >= 0) this.anyOffs.splice(i, 1);
    };
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
    this.parent?.children.delete(this);
    this.parent = undefined;
    // 先收子通道，再收自己：子通道的订阅与等待全部随父插件一起消失
    for (const child of [...this.children]) {
      child.dispose();
      this.children.delete(child);
    }
    for (const w of this.waits) {
      clearTimeout(w.timer);
      w.off();
      w.reject(new Error(`[events] 通道 ${this.namespace} 已关闭`));
    }
    this.waits.clear();
    for (const off of this.offs.splice(0)) off();
    for (const off of this.anyOffs.splice(0)) off();
    this.bus.release(this);
  }
}
