import { clamp } from '../core/types';

/**
 * 帧预算 governor：跨端动态分辨率的大脑。
 *
 * 输入每帧耗时，输出渲染分辨率倍率。与旧的「移动端 1.2s 阶梯」相比：
 * - 桌面 / 移动同一套逻辑，靠 startScale / minScale / targetFps 区分平台；
 * - 用 p75（近 N 帧）而不是瞬时 FPS，避免单帧抖动引发来回拉锯；
 * - 降档快、升档慢（先保流畅，再谈清晰度）；
 * - 探测屏幕实际刷新率，高刷屏不被按在 60，低刷档不被逼到 30。
 */
export interface QualityGovernorConfig {
  /** 目标帧率；effective = min(targetFps, displayHz) */
  targetFps: number;
  /** 允许降到的最低渲染分辨率倍率 */
  minScale: number;
  /** 起始 / 最高倍率（对应画质档位上限：high=1、balanced=0.85、power=0.7） */
  maxScale: number;
}

export interface QualityGovernorStats {
  scale: number;
  /** 近窗口帧耗时分位数 ms */
  p75: number;
  displayHz: number;
  effectiveTargetFps: number;
}

/** 统计窗口帧数：足够覆盖一次瞬时卡顿，又不至于让调节过钝 */
const WINDOW = 96;
/** 降档冷却：连续超预算这么久才降（快速止损，但不被单帧带节奏） */
const DOWN_COOLDOWN_MS = 450;
/** 升档前的稳定时长：确认真的闲下来才回升清晰度 */
const UP_STABLE_MS = 2500;
/** 单次调节步长 */
const STEP = 0.05;

export class QualityGovernor {
  private cfg: QualityGovernorConfig;
  private samples: number[] = [];
  private startScale: number;
  /** 累计超预算时间 / 稳定低于预算时间 */
  private overMs = 0;
  private underMs = 0;
  /** 实测刷新率（0 = 尚未测出，按 60 处理） */
  private displayHz = 0;
  /** 帧间隔环形缓冲，用于估计刷新率 */
  private intervals: number[] = [];

  constructor(cfg: QualityGovernorConfig) {
    this.cfg = cfg;
    this.startScale = clamp(cfg.maxScale, cfg.minScale, 1);
    this.samples.length = 0;
  }

  /** 重新配置（设置变更 / 画质档位切换时调用） */
  configure(cfg: Partial<QualityGovernorConfig>): void {
    Object.assign(this.cfg, cfg);
    this.startScale = clamp(this.cfg.maxScale, this.cfg.minScale, 1);
  }

  /** 回到上限并清空统计（切回 auto 档时调用，避免沿用上一档的残余倍率） */
  reset(): void {
    this.startScale = clamp(this.cfg.maxScale, this.cfg.minScale, 1);
    this.samples.length = 0;
    this.overMs = 0;
    this.underMs = 0;
  }

  /**
   * 每帧喂入本帧墙钟耗时 ms，返回新的渲染分辨率倍率。
   * dtMs 为引擎帧间隔（含 vsync 等待），即用户真实感知的一帧。
   */
  update(dtMs: number): number {
    const cfg = this.cfg;
    this.pushSample(dtMs);
    this.pushInterval(dtMs);

    const budgetMs = 1000 / this.effectiveTargetFps();
    // 留 8% 余量：贴着预算跑迟早会被 vsync 抖动打穿
    const wantDown = budgetMs * 1.08;
    const wantUp = budgetMs * 0.92;
    const p75 = this.percentile(0.75);

    if (p75 > wantDown) {
      this.overMs += dtMs;
      this.underMs = 0;
      if (this.overMs >= DOWN_COOLDOWN_MS && this.startScale > cfg.minScale + 1e-6) {
        this.startScale = Math.max(cfg.minScale, this.startScale - STEP);
        this.overMs = 0;
        this.samples.length = 0;   // 调完清零窗口，下一段重新评估
      }
    } else if (p75 < wantUp) {
      this.underMs += dtMs;
      this.overMs = 0;
      if (this.underMs >= UP_STABLE_MS && this.startScale < cfg.maxScale - 1e-6) {
        this.startScale = Math.min(cfg.maxScale, this.startScale + STEP);
        this.underMs = 0;
        this.samples.length = 0;
      }
    } else {
      // 死区：既不升也不降，计时保持但不清零（迟到的好状态仍算数）
      this.overMs = Math.min(this.overMs + dtMs, DOWN_COOLDOWN_MS);
      this.underMs = Math.min(this.underMs + dtMs, UP_STABLE_MS);
    }
    return this.startScale;
  }

  get scale(): number { return this.startScale; }

  stats(): QualityGovernorStats {
    return {
      scale: this.startScale,
      p75: this.percentile(0.75),
      displayHz: this.displayHz,
      effectiveTargetFps: this.effectiveTargetFps(),
    };
  }

  /** 目标帧率取设置值与屏幕实测刷新率的较小者 */
  effectiveTargetFps(): number {
    const hz = this.displayHz > 0 ? this.displayHz : 60;
    return Math.min(this.cfg.targetFps, Math.max(30, Math.round(hz)));
  }

  private pushSample(dtMs: number): void {
    const a = this.samples;
    a.push(dtMs);
    if (a.length > WINDOW) a.shift();
  }

  /**
   * 估计屏幕刷新率：取最近 60 帧间隔的 **p10**，而不是中位数。
   * 原因：帧受负载拖慢时中位数会跟着变大（例如 60Hz 屏跑出 25ms 帧会被误判成
   * 40Hz），而 vsync 下单帧不可能快于刷新周期，p10 是「最快的那批帧」的周期，
   * 更接近真实刷新率；无 vsync 场景下也只会偏乐观（目标更严），不会反向放水。
   */
  private pushInterval(dtMs: number): void {
    if (!(dtMs > 1)) return;
    const a = this.intervals;
    a.push(dtMs);
    if (a.length > 60) a.shift();
    if (a.length === 60) {
      const sorted = [...a].sort((x, y) => x - y);
      const p10 = sorted[Math.max(0, Math.floor(sorted.length * 0.1))];
      const hz = Math.round(1000 / p10);
      if (hz >= 24 && hz <= 240) this.displayHz = hz;
    }
  }

  private percentile(q: number): number {
    const n = this.samples.length;
    if (n < 8) return 0;   // 样本不足不参与判定
    const sorted = [...this.samples].sort((a, b) => a - b);
    const i = Math.min(n - 1, Math.floor(n * q));
    return sorted[i];
  }
}
