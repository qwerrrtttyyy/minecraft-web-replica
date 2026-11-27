import { EXTENSION_POINTS, type ExtensionRegistry, type PluginSavePayload } from './extensions';

export function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * 按世界存档的插件数据袋（SaveData.plugins）。
 *
 * 核心只知道「有一袋插件数据」，不认识其中任何字段：进入世界时 load() 派发
 * save:restore，写存档前 collect() 派发 save:collect 让插件写回自己的键。
 * 停用插件的旧数据原样留在袋里，重新启用后仍可恢复。
 */
export class PluginSaveBag {
  private data: Record<string, unknown> = {};

  constructor(private readonly extensions: ExtensionRegistry) {}

  load(data: unknown): void {
    this.data = isPlainRecord(data) ? { ...data } : {};
    this.extensions.emit<PluginSavePayload>(EXTENSION_POINTS.SAVE_RESTORE, { data: { ...this.data } });
  }

  get(id: string): unknown {
    return this.data[id];
  }

  collect(): Record<string, unknown> {
    const payload: PluginSavePayload = { data: { ...this.data } };
    this.extensions.emit(EXTENSION_POINTS.SAVE_COLLECT, payload);
    const next: Record<string, unknown> = {};
    if (isPlainRecord(payload.data)) {
      for (const [k, v] of Object.entries(payload.data)) if (v !== undefined) next[k] = v;
    }
    this.data = next;
    return { ...next };
  }
}
