import type { Disposable } from '../ServiceContainer';
import type { PerfService } from './PerfService';

/**
 * 帧预算调度器（高性能服务体系 · 执行层）。
 *
 * 把主循环从「扁平的 for (const s of systems) s.update()」升级为**分阶段 + 优先级 +
 * 软帧预算**的调度：重要的系统每帧必跑，环境 / 视觉类系统在帧预算超支时可被跳过
 * （带防饿死），从而在弱机上先保交互与物理的流畅，再谈次要表现。
 *
 * 与 `Engine` 的关系：Engine 仍是唯一的 rAF 驱动；组装根用**一个** Engine 系统
 * 驱动本调度器（`scheduler.update(dt, t)`），其余系统全部注册进调度器。
 * 这样依赖方向保持 `main → services → 业务模块`，Engine（core 层）无需认识调度器。
 *
 * 默认预算为 0（不做裁剪）——此时所有系统每帧都跑，行为与原扁平循环**逐帧等价**；
 * 组装根显式 `setBudget(ms)` 后才启用「超预算跳过 background 层」的策略。
 */

export type SystemPhase = 'input' | 'simulate' | 'render' | 'post';
export const SYSTEM_PHASES: readonly SystemPhase[] = ['input', 'simulate', 'render', 'post'];

const PHASE_INDEX: Record<SystemPhase, number> = {
  input: 0, simulate: 1, render: 2, post: 3,
};

/** 系统重要度：critical 每帧必跑；background 在预算超支时可被跳过（有防饿死） */
export type SystemTier = 'critical' | 'background';

export interface SystemSpec {
  name: string;
  update(dt: number, elapsed: number): void;
  /** 调度阶段（默认 simulate） */
  phase?: SystemPhase;
  /** 同阶段内排序键，越小越早；默认 0，同键按注册顺序 */
  priority?: number;
  /** 重要度（默认 critical） */
  tier?: SystemTier;
  /** 每 N 帧执行一次（>=1，默认 1） */
  intervalFrames?: number;
  /** background 被预算连续跳过多少帧后强制执行一次，防饿死（默认 6） */
  maxDeferFrames?: number;
  /** 是否启用（默认 true，可运行时切换） */
  enabled?: boolean;
}

export interface SchedulerSlotStats {
  name: string;
  phase: SystemPhase;
  tier: SystemTier;
  enabled: boolean;
  /** 累计执行次数 */
  runs: number;
  /** 累计因超预算被跳过次数 */
  skipsBudget: number;
  /** 累计因 interval 未到被跳过次数 */
  skipsInterval: number;
  /** 累计抛错次数（被隔离，不打断同帧其它系统） */
  errors: number;
}

export interface SchedulerStats {
  /** 已调度帧数 */
  frame: number;
  /** 软帧预算 ms（0 = 不裁剪） */
  budgetMs: number;
  /** 本帧是否有 background 系统因超预算被跳过 */
  throttled: boolean;
  /** 累计被预算跳过的执行次数 */
  skippedBudget: number;
  slots: SchedulerSlotStats[];
}

interface Slot {
  name: string;
  update: SystemSpec['update'];
  phase: number;
  priority: number;
  tier: SystemTier;
  intervalFrames: number;
  maxDeferFrames: number;
  enabled: boolean;
  /** 注册序号：作为阶段 / 优先级之后的稳定排序键 */
  seq: number;
  lastRunFrame: number;
  /** 连续被预算跳过的帧数 */
  deferred: number;
  runs: number;
  skipsBudget: number;
  skipsInterval: number;
  errors: number;
}

const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

export class FrameScheduler implements Disposable {
  private slots: Slot[] = [];
  private readonly byName = new Map<string, Slot>();
  private sorted = true;
  private frame = 0;
  private seq = 0;
  private budgetMs = 0;
  private lastThrottled = false;
  private skippedBudgetTotal = 0;
  private readonly perf: PerfService | null;
  private readonly onError: (name: string, error: unknown) => void;

  constructor(opts: {
    perf?: PerfService | null;
    /** 软帧预算 ms；<=0 关闭裁剪 */
    budgetMs?: number;
    /** 系统抛错回调；默认打印并隔离，不打断同帧其它系统 */
    onError?: (name: string, error: unknown) => void;
  } = {}) {
    this.perf = opts.perf ?? null;
    this.budgetMs = opts.budgetMs && opts.budgetMs > 0 ? opts.budgetMs : 0;
    this.onError = opts.onError ??
      ((name, error) => console.error(`[scheduler] 系统 "${name}" 抛错`, error));
  }

  /** 注册一个系统；名字必须唯一 */
  add(spec: SystemSpec): void {
    if (this.byName.has(spec.name)) {
      throw new Error(`[scheduler] 系统名重复: ${spec.name}`);
    }
    const slot: Slot = {
      name: spec.name,
      update: spec.update,
      phase: PHASE_INDEX[spec.phase ?? 'simulate'],
      priority: spec.priority ?? 0,
      tier: spec.tier ?? 'critical',
      intervalFrames: Math.max(1, Math.floor(spec.intervalFrames ?? 1)),
      maxDeferFrames: Math.max(1, Math.floor(spec.maxDeferFrames ?? 6)),
      enabled: spec.enabled ?? true,
      seq: this.seq++,
      lastRunFrame: -1,
      deferred: 0,
      runs: 0,
      skipsBudget: 0,
      skipsInterval: 0,
      errors: 0,
    };
    this.slots.push(slot);
    this.byName.set(slot.name, slot);
    this.sorted = false;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  setEnabled(name: string, enabled: boolean): void {
    const slot = this.byName.get(name);
    if (slot) slot.enabled = enabled;
  }

  /** 运行时改软帧预算；<=0 关闭裁剪（回到逐帧等价） */
  setBudget(ms: number): void {
    this.budgetMs = ms > 0 ? ms : 0;
  }

  get budget(): number {
    return this.budgetMs;
  }

  remove(name: string): boolean {
    const slot = this.byName.get(name);
    if (!slot) return false;
    this.byName.delete(name);
    this.slots = this.slots.filter((s) => s !== slot);
    return true;
  }

  /**
   * 调度一帧。顺序：阶段 → 优先级 → 注册序号（稳定）。
   * critical 层永不因预算被跳过；background 层在已耗时 >= 预算且未达防饿死上限时让位。
   */
  update(dt: number, elapsed: number): void {
    if (!this.sorted) {
      this.slots.sort((a, b) => a.phase - b.phase || a.priority - b.priority || a.seq - b.seq);
      this.sorted = true;
    }
    this.frame++;
    const budget = this.budgetMs;
    const enforce = budget > 0;
    const measure = enforce || this.perf !== null;
    let spent = 0;
    let throttled = false;

    for (const slot of this.slots) {
      if (!slot.enabled) continue;
      // interval 门控：首帧必跑，之后每 intervalFrames 帧跑一次
      if (slot.intervalFrames > 1 && slot.lastRunFrame >= 0 &&
        this.frame - slot.lastRunFrame < slot.intervalFrames) {
        slot.skipsInterval++;
        continue;
      }
      // 预算门控：只裁 background 层，且连续跳过不超过 maxDeferFrames（防饿死）
      if (enforce && slot.tier === 'background' && spent >= budget && slot.deferred < slot.maxDeferFrames) {
        slot.deferred++;
        slot.skipsBudget++;
        this.skippedBudgetTotal++;
        throttled = true;
        continue;
      }

      const t0 = measure ? now() : 0;
      try {
        slot.update(dt, elapsed);
      } catch (error) {
        slot.errors++;
        this.onError(slot.name, error);
      }
      if (measure) {
        const cost = now() - t0;
        if (this.perf) this.perf.record(slot.name, cost);
        spent += cost;
      }
      slot.lastRunFrame = this.frame;
      slot.deferred = 0;
      slot.runs++;
    }
    this.lastThrottled = throttled;
  }

  stats(): SchedulerStats {
    return {
      frame: this.frame,
      budgetMs: this.budgetMs,
      throttled: this.lastThrottled,
      skippedBudget: this.skippedBudgetTotal,
      slots: this.slots.map((s) => ({
        name: s.name,
        phase: SYSTEM_PHASES[s.phase],
        tier: s.tier,
        enabled: s.enabled,
        runs: s.runs,
        skipsBudget: s.skipsBudget,
        skipsInterval: s.skipsInterval,
        errors: s.errors,
      })),
    };
  }

  dispose(): void {
    this.slots = [];
    this.byName.clear();
  }
}
