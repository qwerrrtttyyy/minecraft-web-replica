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
  /** 管道语义：伤害落账前依次改写（返回 { amount } 覆写）；核心自身不注册处理器 */
  COMBAT_DAMAGE_INCOMING: 'combat:damage-incoming',
  /** 通知语义：装备耐久变化（slot 为 null 表示背包装备） */
  EQUIPMENT_DURABILITY: 'equipment:durability',
  /** 管道语义：右键使用手持物品前；返回 { handled: true } 截断默认流程 */
  PLAYER_USE_ITEM: 'player:use-item',
  /** 管道语义：生存模式开始挖一个方块时改写耗时 / 是否掉落 */
  PLAYER_MINING: 'player:mining',
  /** 管道语义：生存模式近战命中实体前改写伤害 */
  PLAYER_ATTACK: 'player:attack',
  /** 通知语义：手持工具完成一次挖掘 / 攻击（供耐久结算） */
  PLAYER_USED_TOOL: 'player:used-tool',
  /** 通知语义：写存档前收集插件数据，处理器把自己的数据写进 payload.data[插件 id] */
  SAVE_COLLECT: 'save:collect',
  /** 通知语义：进入世界时下发该世界的插件数据（新世界为空对象） */
  SAVE_RESTORE: 'save:restore',
} as const;

/** 伤害类型：核心按来源分类，插件据此决定是否参与（如护甲只减免攻击 / 爆炸） */
export type DamageKind = 'attack' | 'explosion' | 'fall' | 'drown' | 'starve' | 'freeze' | 'other';

/** combat:damage-incoming 的载荷：处理器返回 { amount } 覆写本次伤害 */
export interface DamageIncomingPayload {
  amount: number;
  source: string;
  kind: DamageKind;
}

/** 扩展点载荷里的物品栈（结构等价于 player/survival 的 Stack，避免反向依赖） */
export interface HookStack {
  kind: 'block' | 'item';
  id: number | string;
}

/** player:use-item 的载荷 */
export interface UseItemPayload {
  stack: HookStack;
  /** 背包键（b:<id> / i:<name>） */
  key: string;
  handled: boolean;
}

/** player:mining 的载荷：time 预填核心的徒手耗时，harvest 预填 true */
export interface MiningPayload {
  block: string;
  hardness: number;
  sound: string;
  toolId: string | null;
  time: number;
  harvest: boolean;
}

/** player:attack 的载荷：amount 预填核心的徒手伤害 */
export interface AttackPayload {
  amount: number;
  toolId: string | null;
  target: string;
}

/** player:used-tool 的载荷 */
export interface UsedToolPayload {
  toolId: string;
  key: string;
  action: 'mine' | 'attack';
}

/** save:collect / save:restore 的载荷 */
export interface PluginSavePayload {
  data: Record<string, unknown>;
}

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

  register<P>(point: string, owner: string, handler: ExtensionHandler<P>, priority = 0): () => void {
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
      id: ++this.seq,
      point,
      owner,
      priority,
      handler: handler as ExtensionHandler<unknown>,
    };
    let list = this.points.get(point);
    if (!list) {
      list = [];
      this.points.set(point, list);
    }
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
        if (r.owner === owner) {
          removed++;
          return false;
        }
        return true;
      });
      if (kept.length === 0) this.points.delete(point);
      else this.points.set(point, kept);
    }
    return removed;
  }

  /**
   * 管道语义派发：按 priority 降序、注册顺序升序依次执行，
   * 处理器可通过返回 { amount } 覆写 payload（写回下一级的入参）。
   * 与 emit 不同：这是「数据流」而非「通知」；错误隔离规则相同，
   * 抛错的处理器被跳过（不参与改写），其余处理器照常生效。
   */
  reduce<P extends object>(point: string, payload: P): { payload: P; errors: { owner: string; message: string }[] } {
    const errors: { owner: string; message: string }[] = [];
    if (this.disposed) return { payload, errors };
    const list = this.points.get(point);
    if (!list || list.length === 0) return { payload, errors };
    const ordered = [...list].sort((a, b) => b.priority - a.priority || a.id - b.id);
    for (const rec of ordered) {
      try {
        const out = (rec.handler as (p: P) => unknown)(payload);
        if (out && typeof out === 'object') Object.assign(payload, out);
      } catch (e) {
        errors.push({ owner: rec.owner, message: e instanceof Error ? e.message : String(e) });
      }
    }
    return { payload, errors };
  }

  /** 同步派发：按 priority 降序、注册顺序升序；返回调用数与错误清单 */
  emit<P>(point: string, payload: P): EmitResult {
    if (this.disposed) return { point, called: 0, errors: [] };
    const list = this.points.get(point);
    if (!list || list.length === 0) return { point, called: 0, errors: [] };
    this.emissions++;
    const ordered = [...list].sort((a, b) => b.priority - a.priority || a.id - b.id);
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
      for (const r of list) {
        handlers++;
        owners.add(r.owner);
      }
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
