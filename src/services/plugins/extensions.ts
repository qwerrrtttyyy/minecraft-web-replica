/**
 * 扩展点注册表（v1.6.0）。
 *
 * 插件体系 v2 解决了「插件如何加载」，本模块解决「插件扩展哪里」：
 * 用统一的注册表替代散落各处的 subscribe 约定，让 JS 插件与 WASM 插件
 * 通过同一组扩展点参与引擎行为。
 *
 * 设计要点：
 *  - **owner 隔离**：每条注册记录归属插件 id，`unregisterOwner` 一次撤销，
 *    与 EventChannel.dispose 配合，杜绝插件卸载后回调残留。
 *  - **确定性顺序**：emit 按 priority 降序、同优先级按注册序号升序同步执行，
 *    世界生成扩展点因此可复现（相同 seed + 相同插件集合 → 相同地形）。
 *  - **错误隔离**：单个处理器抛错不中断其余处理器，错误汇总在 emit 结果里。
 *  - **通用载体**：point 是字符串（建议 `层:动作`，如 `worldgen:column`），
 *    payload 是不透明对象；JS 传闭包，WASM 由载体层包装成指向导出函数的闭包。
 */
import type { Disposable } from '../ServiceContainer';

/** 处理扩展点事件；返回值被忽略（扩展点是通知语义，不是管道语义） */
export type ExtensionHandler<P = unknown> = (payload: P) => void;

export interface ExtensionRecord<P = unknown> {
  /** 注册表内唯一序号，作为取消句柄 */
  readonly id: number;
  readonly point: string;
  readonly owner: string;
  readonly priority: number;
  readonly handler: ExtensionHandler<P>;
}

export interface ExtensionInfo {
  id: number;
  point: string;
  owner: string;
  priority: number;
}

export interface ExtensionStats {
  points: number;
  handlers: number;
  owners: number;
  emissions: number;
  errors: number;
}

export interface EmitResult {
  point: string;
  called: number;
  errors: { owner: string; message: string }[];
}

const POINT_PATTERN = /^[a-z0-9][a-z0-9._:-]{1,63}$/i;
const OWNER_PATTERN = /^[a-z0-9][a-z0-9._:-]{1,63}$/i;

/** 内置扩展点常量：先落地「事件与游戏逻辑」+「世界生成与地形」两层 */
export const EXTENSION_POINTS = {
  /** 区块地形生成完成后、应用存档编辑与光照初始化之前；payload 见 WorldgenColumnPayload */
  WORLDGEN_COLUMN: 'worldgen:column',
  /** 游戏逻辑节拍（由组装根按固定间隔派发），供插件做周期性计算 */
  GAMEPLAY_TICK: 'gameplay:tick',
} as const;

/** worldgen:column 的载荷：直接暴露区块数据，生成期写入不记存档差分 */
export interface WorldgenColumnPayload {
  readonly cx: number;
  readonly cz: number;
  readonly data: Uint8Array;
  /** 世界坐标读方块（区块内），越界返回 0 */
  get(x: number, y: number, z: number): number;
  /** 世界坐标写方块（生成期写入：不记编辑、不标脏） */
  set(x: number, y: number, z: number, id: number): void;
}

export class ExtensionRegistry implements Disposable {
  private readonly points = new Map<string, ExtensionRecord[]>();
  private seq = 0;
  private emissions = 0;
  private errors = 0;
  private disposed = false;

  register<P>(
    point: string,
    owner: string,
    handler: ExtensionHandler<P>,
    priority = 0,
  ): () => void {
    if (this.disposed) throw new Error('[extensions] 注册表已销毁');
    if (typeof point !== 'string' || !POINT_PATTERN.test(point)) {
      throw new Error(`[extensions] 非法扩展点: ${String(point)}`);
    }
    if (typeof owner !== 'string' || !OWNER_PATTERN.test(owner)) {
      throw new Error(`[extensions] 非法 owner: ${String(owner)}`);
    }
    if (typeof handler !== 'function') throw new Error('[extensions] handler 必须是函数');
    if (!Number.isFinite(priority)) throw new Error('[extensions] priority 必须是有限数值');
    const rec: ExtensionRecord<P> = {
      id: ++this.seq, point, owner, priority,
      handler: handler as ExtensionHandler<unknown>,
    };
    let list = this.points.get(point);
    if (!list) { list = []; this.points.set(point, list); }
    list.push(rec as ExtensionRecord);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.unregisterById(rec.id);
    };
  }

  private unregisterById(id: number): boolean {
    for (const [point, list] of this.points) {
      const i = list.findIndex((r) => r.id === id);
      if (i < 0) continue;
      list.splice(i, 1);
      if (list.length === 0) this.points.delete(point);
      return true;
    }
    return false;
  }

  /** 撤销某 owner 的全部注册；插件停用 / 卸载时由 PluginService 调用 */
  unregisterOwner(owner: string): number {
    let removed = 0;
    for (const [point, list] of this.points) {
      const kept = list.filter((r) => {
        if (r.owner === owner) { removed++; return false; }
        return true;
      });
      if (kept.length === 0) this.points.delete(point);
      else this.points.set(point, kept);
    }
    return removed;
  }

  /** 同步派发：按 priority 降序、注册顺序升序；返回调用数与错误清单 */
  emit<P>(point: string, payload: P): EmitResult {
    if (this.disposed) return { point, called: 0, errors: [] };
    const list = this.points.get(point);
    if (!list || list.length === 0) return { point, called: 0, errors: [] };
    this.emissions++;
    const ordered = [...list].sort((a, b) =>
      b.priority - a.priority || a.id - b.id);
    const result: EmitResult = { point, called: 0, errors: [] };
    for (const rec of ordered) {
      try {
        (rec.handler as ExtensionHandler<P>)(payload);
        result.called++;
      } catch (e) {
        this.errors++;
        result.errors.push({
          owner: rec.owner,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return result;
  }

  list(point?: string): ExtensionInfo[] {
    const out: ExtensionInfo[] = [];
    const push = (p: string, list: ExtensionRecord[]) => {
      for (const r of list) {
        out.push({ id: r.id, point: p, owner: r.owner, priority: r.priority });
      }
    };
    if (point === undefined) {
      for (const [p, list] of this.points) push(p, list);
    } else {
      push(point, this.points.get(point) ?? []);
    }
    return out.sort((a, b) => a.id - b.id);
  }

  has(point: string): boolean {
    return (this.points.get(point)?.length ?? 0) > 0;
  }

  stats(): ExtensionStats {
    let handlers = 0;
    const owners = new Set<string>();
    for (const list of this.points.values()) {
      for (const r of list) { handlers++; owners.add(r.owner); }
    }
    return {
      points: this.points.size,
      handlers,
      owners: owners.size,
      emissions: this.emissions,
      errors: this.errors,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.points.clear();
  }
}
