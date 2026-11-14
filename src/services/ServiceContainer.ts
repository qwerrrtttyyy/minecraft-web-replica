/**
 * 类型安全的服务定位器（v1.2.0 架构革新引入）。
 *
 * 旧架构里所有运行期对象都是 `boot()` 的闭包局部变量，插件无法访问、也无法替换。
 * 现在由组装根把长期存活的横切能力注册进容器，插件通过 `ctx.services.require(TOKEN)` 取用，
 * 依赖方向单一、可测试、可替换；容器销毁时逆序调用所有服务的 dispose()。
 */

/** 服务令牌：key + 仅供类型推导的幽灵字段（运行时不存在） */
export interface ServiceToken<T> {
  readonly key: string;
  readonly __phantom?: T;
}

export const token = <T>(key: string): ServiceToken<T> => ({ key });

export interface Disposable {
  dispose(): void;
}

const isDisposable = (v: unknown): v is Disposable =>
  !!v && typeof (v as Disposable).dispose === 'function';

export class ServiceContainer implements Disposable {
  private readonly services = new Map<string, unknown>();
  private readonly order: string[] = [];
  private disposed = false;

  /** 注册服务（禁止重复注册，避免静默覆盖） */
  provide<T>(t: ServiceToken<T>, value: T): T {
    if (this.disposed) throw new Error('[services] 容器已销毁，无法注册服务');
    if (this.services.has(t.key)) throw new Error(`[services] 服务重复注册: ${t.key}`);
    this.services.set(t.key, value);
    this.order.push(t.key);
    return value;
  }

  /** 取服务；未注册直接抛错，便于在组装阶段暴露接线错误 */
  require<T>(t: ServiceToken<T>): T {
    const v = this.services.get(t.key);
    if (v === undefined) throw new Error(`[services] 服务未注册: ${t.key}`);
    return v as T;
  }

  optional<T>(t: ServiceToken<T>): T | undefined {
    return this.services.get(t.key) as T | undefined;
  }

  has<T>(t: ServiceToken<T>): boolean {
    return this.services.has(t.key);
  }

  keys(): string[] {
    return [...this.order];
  }

  /** 逆序销毁，依赖方先于被依赖方释放 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const key of [...this.order].reverse()) {
      const v = this.services.get(key);
      if (!isDisposable(v)) continue;
      try {
        v.dispose();
      } catch (e) {
        console.error(`[services] 销毁 ${key} 失败`, e);
      }
    }
    this.services.clear();
    this.order.length = 0;
  }
}
