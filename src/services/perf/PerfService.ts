import type { Disposable } from '../ServiceContainer';

/**
 * 性能监控服务（高性能服务体系 · 观测层）。
 *
 * 逐系统采样每帧耗时，维护定长环形窗口，按需计算 p50 / p95 / max。
 * 设计目标：**热路径零分配**——`record()` 命中后只写 `Float32Array` 环形缓冲；
 * 只有 `report()` / `stats()` 这类低频调用（F3 面板、诊断采样）才做排序与字符串拼接。
 *
 * 与 `QualityGovernor`（消费者：按帧耗时分档渲染分辨率）互补：
 * 本服务负责「谁在吃帧预算」的可观测性，governor 负责「据此调整分辨率」。
 */

/** 统计窗口帧数：约 2 秒 @60fps，足够覆盖一次瞬时卡顿又不至于过钝 */
const WINDOW = 120;

/** 单系统耗时统计（窗口内 + 自 reset 起累计） */
export interface SystemPerf {
  name: string;
  /** 最近一帧耗时 ms */
  last: number;
  /** 窗口内平均 ms */
  avg: number;
  /** 窗口内分位数与峰值 ms */
  p50: number;
  p95: number;
  max: number;
  /** 窗口内样本数（<= WINDOW） */
  samples: number;
  /** 自 reset 起累计调用次数 */
  calls: number;
  /** 自 reset 起累计耗时 ms */
  totalMs: number;
}

export interface PerfStats {
  /** 已采集帧数 */
  frames: number;
  /** 整帧墙钟耗时超过 budgetMs 的帧数 */
  overBudgetFrames: number;
  /** 当前帧预算 ms（0 = 不统计超预算） */
  budgetMs: number;
  /** 整帧墙钟耗时：最近 / 窗口均值 / 窗口 p95 */
  frameLast: number;
  frameAvg: number;
  frameP95: number;
  /** 已跟踪的系统数 */
  systems: number;
}

export interface PerfReport extends PerfStats {
  /** 按 p95 降序排列的系统耗时（热点优先） */
  offenders: SystemPerf[];
}

interface Stat {
  ring: Float32Array;
  /** 下一个写入位置 */
  head: number;
  /** 已填充样本数（0..WINDOW） */
  filled: number;
  /** 窗口内耗时之和 */
  sum: number;
  last: number;
  /** 自 reset 起累计调用次数 / 耗时 */
  calls: number;
  total: number;
}

export class PerfService implements Disposable {
  private readonly byName = new Map<string, Stat>();
  private readonly frames = new Float32Array(WINDOW);
  private frameHead = 0;
  private frameFilled = 0;
  private frameSum = 0;
  private frameLast = 0;
  private frameCount = 0;
  private overBudget = 0;
  private budgetMs = 0;
  /** 复用排序缓冲，避免每次 report 重新分配 */
  private readonly scratch = new Float32Array(WINDOW);
  /** 关闭后 record/endFrame 立即空转（发布版可整体关闭观测开销） */
  enabled = true;

  /** 设置整帧预算 ms；<=0 表示不统计超预算帧 */
  setBudget(ms: number): void {
    this.budgetMs = ms > 0 ? ms : 0;
  }

  get budget(): number {
    return this.budgetMs;
  }

  /** 记录某系统本帧耗时（ms）。热路径：Map 命中后无分配。 */
  record(name: string, ms: number): void {
    if (!this.enabled) return;
    let st = this.byName.get(name);
    if (st === undefined) {
      st = {
        ring: new Float32Array(WINDOW),
        head: 0,
        filled: 0,
        sum: 0,
        last: 0,
        calls: 0,
        total: 0,
      };
      this.byName.set(name, st);
    }
    const r = st.ring;
    if (st.filled === WINDOW) st.sum -= r[st.head];
    else st.filled++;
    r[st.head] = ms;
    st.head = (st.head + 1) % WINDOW;
    st.sum += ms;
    st.last = ms;
    st.calls++;
    st.total += ms;
  }

  /** 每帧末记录整帧墙钟耗时（引擎 onRawFrame 提供，含 vsync 等待） */
  endFrame(frameMs: number): void {
    if (!this.enabled) return;
    const r = this.frames;
    if (this.frameFilled === WINDOW) this.frameSum -= r[this.frameHead];
    else this.frameFilled++;
    r[this.frameHead] = frameMs;
    this.frameHead = (this.frameHead + 1) % WINDOW;
    this.frameSum += frameMs;
    this.frameLast = frameMs;
    this.frameCount++;
    if (this.budgetMs > 0 && frameMs > this.budgetMs) this.overBudget++;
  }

  /** 整帧耗时统计（不含逐系统明细） */
  stats(): PerfStats {
    const q = this.summarize(this.frames, this.frameFilled);
    return {
      frames: this.frameCount,
      overBudgetFrames: this.overBudget,
      budgetMs: this.budgetMs,
      frameLast: this.frameLast,
      frameAvg: this.frameFilled > 0 ? this.frameSum / this.frameFilled : 0,
      frameP95: q.p95,
      systems: this.byName.size,
    };
  }

  /** 完整报告：帧统计 + 按 p95 降序的系统热点 */
  report(): PerfReport {
    const offenders: SystemPerf[] = [];
    for (const [name, st] of this.byName) {
      const q = this.summarize(st.ring, st.filled);
      offenders.push({
        name,
        last: st.last,
        avg: st.filled > 0 ? st.sum / st.filled : 0,
        p50: q.p50,
        p95: q.p95,
        max: q.max,
        samples: st.filled,
        calls: st.calls,
        totalMs: st.total,
      });
    }
    // p95 降序；同值按名字字典序，保证跨环境确定性
    offenders.sort((a, b) => b.p95 - a.p95 || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { ...this.stats(), offenders };
  }

  /** p95 最高的前 n 个系统（F3 面板用） */
  top(n = 4): SystemPerf[] {
    return this.report().offenders.slice(0, n);
  }

  /** 单行摘要：`帧 16.6ms (avg 14.0 / p95 22.1) · 热点 chunks 3.2 · ...` */
  format(topN = 3): string {
    const rep = this.report();
    const head = `帧 ${rep.frameLast.toFixed(1)}ms (avg ${rep.frameAvg.toFixed(1)} / p95 ${rep.frameP95.toFixed(1)})`;
    const worst = rep.offenders
      .slice(0, topN)
      .map((s) => `${s.name} ${s.p95.toFixed(1)}`)
      .join(' · ');
    return worst ? `${head} · 热点 ${worst}` : head;
  }

  /** 清空全部统计（切世界 / 重新基准时调用） */
  reset(): void {
    this.byName.clear();
    this.frames.fill(0);
    this.frameHead = 0;
    this.frameFilled = 0;
    this.frameSum = 0;
    this.frameLast = 0;
    this.frameCount = 0;
    this.overBudget = 0;
  }

  dispose(): void {
    this.reset();
    this.enabled = false;
  }

  /** 拷贝环形窗口的有效前缀到 scratch 后排序，一次得到 p50 / p95 / max */
  private summarize(ring: Float32Array, filled: number): { p50: number; p95: number; max: number } {
    if (filled === 0) return { p50: 0, p95: 0, max: 0 };
    const s = this.scratch;
    for (let i = 0; i < filled; i++) s[i] = ring[i];
    const view = s.subarray(0, filled);
    view.sort();
    return {
      p50: view[Math.min(filled - 1, Math.floor(filled * 0.5))],
      p95: view[Math.min(filled - 1, Math.floor(filled * 0.95))],
      max: view[filled - 1],
    };
  }
}
