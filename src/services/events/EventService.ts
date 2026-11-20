import type { GameEvents } from './GameEvents';
import { EventChannel } from './EventChannel';
import type { Disposable } from '../ServiceContainer';

type Handler<T> = (payload: T) => void;

interface Entry {
  fn: Handler<never>;
  label: string;
}

export interface EventErrorInfo {
  type: string;
  label: string;
  error: unknown;
}

export interface EventStats {
  emitted: Record<string, number>;
  subscribers: number;
  channels: string[];
}

export type AnyEventHandler = (type: string, payload: unknown) => void;

/** 防止两个插件互相 emit 造成死递归 */
const MAX_EMIT_DEPTH = 16;

/**
 * 事件服务（v1.2.0 从 core/events.ts 的裸 EventBus 独立出来）。
 *
 * 相比旧实现的增量：
 * 1. 订阅者错误隔离 —— 一个插件抛错不再中断同事件的其他订阅者或整帧逻辑；
 * 2. 订阅归属 —— `scope(ns)` 返回 EventChannel，插件卸载时一次性清理；
 * 3. once / waitFor —— 支持异步编排插件启动流程；
 * 4. onAny 全局观测 + stats() 派发计数 —— 调试、回放、审计与断言可直接读取；
 * 5. emit 深度保护 —— 拦截插件事件环；
 * 6. dispose() —— 纳入服务容器统一生命周期。
 *
 * `on/off/emit` 签名与旧 EventBus 完全一致，现有模块零行为改动即可迁移。
 */
export class EventService implements Disposable {
  private map = new Map<string, Set<Entry>>();
  private anyHandlers = new Set<AnyEventHandler>();
  private counts = new Map<string, number>();
  private channels = new Set<EventChannel>();
  private depth = 0;
  private disposed = false;
  private errorHandler: (info: EventErrorInfo) => void = (i) => {
    console.error(`[events] ${i.type} 订阅者 ${i.label} 抛错`, i.error);
  };

  on<K extends keyof GameEvents>(type: K, fn: Handler<GameEvents[K]>, label = 'anonymous'): () => void {
    const key = type as string;
    let set = this.map.get(key);
    if (!set) {
      set = new Set();
      this.map.set(key, set);
    }
    const entry: Entry = { fn: fn as Handler<never>, label };
    set.add(entry);
    return () => {
      set!.delete(entry);
      if (set!.size === 0) this.map.delete(key);
    };
  }

  off<K extends keyof GameEvents>(type: K, fn: Handler<GameEvents[K]>): void {
    const set = this.map.get(type as string);
    if (!set) return;
    for (const e of set) {
      if (e.fn === (fn as Handler<never>)) set.delete(e);
    }
    if (set.size === 0) this.map.delete(type as string);
  }

  once<K extends keyof GameEvents>(type: K, fn: Handler<GameEvents[K]>, label = 'anonymous'): () => void {
    // fired 先于 off 赋值：极端重入（回调在 on 返回前被同步触发）时 off 仍是空函数，
    // 用 fired 保证 fn 只执行一次、移除只做一次，避免订阅泄漏与重复回调。
    let off: () => void = () => {};
    let fired = false;
    off = this.on(type, (p) => {
      if (fired) return;
      fired = true;
      off();
      fn(p);
    }, label);
    // 调用方提前 off 时也要置 fired，防止之后同事件仍触发残留回调
    const wrappedOff = (): void => {
      if (fired) return;
      fired = true;
      off();
    };
    return wrappedOff;
  }

  /** 等待某事件首次到达；超时 reject，便于插件异步启动编排 */
  waitFor<K extends keyof GameEvents>(type: K, timeoutMs = 5000): Promise<GameEvents[K]> {
    return new Promise((resolve, reject) => {
      let off: () => void = () => {};
      const timer = setTimeout(() => {
        off();
        reject(new Error(`[events] 等待 ${String(type)} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      off = this.once(type, (p) => {
        clearTimeout(timer);
        resolve(p);
      });
    });
  }

  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    if (this.disposed) return;
    const key = type as string;
    if (this.depth >= MAX_EMIT_DEPTH) {
      this.errorHandler({
        type: key,
        label: 'emit',
        error: new Error(`事件递归深度超过 ${MAX_EMIT_DEPTH}（疑似插件事件环）`),
      });
      return;
    }
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.depth++;
    try {
      for (const h of [...this.anyHandlers]) {
        try {
          h(key, payload);
        } catch (e) {
          this.errorHandler({ type: key, label: 'onAny', error: e });
        }
      }
      const set = this.map.get(key);
      if (!set) return;
      // 快照迭代：订阅者在回调中增删订阅不会破坏本轮派发
      for (const entry of [...set]) {
        try {
          (entry.fn as Handler<GameEvents[K]>)(payload);
        } catch (e) {
          this.errorHandler({ type: key, label: entry.label, error: e });
        }
      }
    } finally {
      this.depth--;
    }
  }

  /** 全局观测钩子：调试面板、事件回放、插件审计 */
  onAny(fn: AnyEventHandler): () => void {
    this.anyHandlers.add(fn);
    return () => this.anyHandlers.delete(fn);
  }

  /** 创建归属命名空间的订阅通道（插件上下文默认拿到这个） */
  scope(namespace: string): EventChannel {
    return new EventChannel(this, namespace);
  }

  /** @internal 由 EventChannel 构造时调用 */
  track(ch: EventChannel): void {
    this.channels.add(ch);
  }

  /** @internal 由 EventChannel.dispose() 调用 */
  release(ch: EventChannel): void {
    this.channels.delete(ch);
  }

  /** 自定义错误上报（默认 console.error）；返回旧 handler 便于还原 */
  setErrorHandler(fn: (info: EventErrorInfo) => void): (info: EventErrorInfo) => void {
    const old = this.errorHandler;
    this.errorHandler = fn;
    return old;
  }

  stats(): EventStats {
    const emitted: Record<string, number> = {};
    for (const [k, v] of this.counts) emitted[k] = v;
    let subscribers = 0;
    for (const s of this.map.values()) subscribers += s.size;
    return { emitted, subscribers, channels: [...this.channels].map((c) => c.namespace) };
  }

  resetStats(): void {
    this.counts.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const ch of [...this.channels]) ch.dispose();
    this.channels.clear();
    this.map.clear();
    this.anyHandlers.clear();
    this.counts.clear();
  }
}

/** 兼容旧代码的类名：v1.2.0 起实现位于 services/events */
export { EventService as EventBus };
