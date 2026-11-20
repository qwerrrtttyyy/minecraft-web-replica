/**
 * 插件私有存储（v1.5.0）。
 *
 * 每个插件一个命名空间，卸载不会丢数据（下次启用仍可读），但插件之间互相不可见。
 * Provider 可替换：浏览器用 localStorage，Node 测试用内存实现，避免直接依赖 DOM。
 */
export interface PluginStorageProvider {
  read(ns: string): Record<string, unknown>;
  write(ns: string, data: Record<string, unknown>): void;
  clear(ns: string): void;
}

export interface PluginStorage {
  get<T>(key: string, fallback?: T): T | undefined;
  set(key: string, value: unknown): void;
  remove(key: string): void;
  keys(): string[];
}

export class MemoryPluginStorageProvider implements PluginStorageProvider {
  private readonly data = new Map<string, Record<string, unknown>>();

  read(ns: string): Record<string, unknown> {
    return { ...(this.data.get(ns) ?? {}) };
  }

  write(ns: string, data: Record<string, unknown>): void {
    this.data.set(ns, { ...data });
  }

  clear(ns: string): void {
    this.data.delete(ns);
  }
}

const PREFIX = 'mc-ts:plugin:';

export class LocalStoragePluginStorageProvider implements PluginStorageProvider {
  read(ns: string): Record<string, unknown> {
    try {
      const raw = globalThis.localStorage?.getItem(PREFIX + ns);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      // 存档损坏 / 隐私模式禁用 localStorage：降级为空，不拖垮插件启用
      return {};
    }
  }

  write(ns: string, data: Record<string, unknown>): void {
    try {
      globalThis.localStorage?.setItem(PREFIX + ns, JSON.stringify(data));
    } catch {
      // 配额溢出：忽略，插件只读默认值
    }
  }

  clear(ns: string): void {
    try {
      globalThis.localStorage?.removeItem(PREFIX + ns);
    } catch {
      // 同上
    }
  }
}

export function defaultPluginStorageProvider(): PluginStorageProvider {
  try {
    return typeof globalThis.localStorage !== 'undefined'
      ? new LocalStoragePluginStorageProvider()
      : new MemoryPluginStorageProvider();
  } catch {
    return new MemoryPluginStorageProvider();
  }
}

export function createPluginStorage(provider: PluginStorageProvider, ns: string): PluginStorage {
  return {
    get<T>(key: string, fallback?: T): T | undefined {
      const value = provider.read(ns)[key];
      return value === undefined ? fallback : value as T;
    },
    set(key: string, value: unknown): void {
      const data = provider.read(ns);
      data[key] = value;
      provider.write(ns, data);
    },
    remove(key: string): void {
      const data = provider.read(ns);
      delete data[key];
      provider.write(ns, data);
    },
    keys(): string[] {
      return Object.keys(provider.read(ns));
    },
  };
}
