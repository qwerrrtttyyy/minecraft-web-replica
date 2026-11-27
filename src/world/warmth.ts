import { clamp, type System, type Vec3Like } from '../core/types';
import { WARMTH } from '../core/tuning';
import type { SurvivalState } from '../player/survival';

/**
 * 温暖系统（PR5 轻量温暖）。
 *
 * 靠近热源（营火 / 火焰 / 灯笼 / 蜡烛 / 燃烧中的熔炉）时温暖值上升，远离下降。
 * 热源判定由调用方通过 isHeatAt 注入，本系统不硬编码熔炉逻辑，也不直接读熔炉状态。
 *
 * 只做轻量增益与视觉表现，不含体温 / 冻伤 / 寒冷伤害 / 天气联动。
 * 每 0.2s 重算一次（扫描半径 6，成本受控但没必要每帧）。
 */

/** 温暖值上限（0~100） */
export const MAX_WARMTH = 100;

/** 重算节拍（秒） */
const SCAN_TICK = 0.2;

/**
 * 由最近热源距离求目标温暖值。
 * nearestDist === null（半径内无热源）→ 0；
 * 否则按 clamp(1 - dist / (radius + 1), 0, 1) * 100 线性衰减。
 */
export function warmthTarget(nearestDist: number | null): number {
  if (nearestDist === null) return 0;
  return clamp(1 - nearestDist / (WARMTH.radius + 1), 0, 1) * MAX_WARMTH;
}

/**
 * 按 rise / fall 系数指数逼近目标值。
 * rising=true 用 WARMTH.rise，否则用 WARMTH.fall；步长系数 min(1, dt * coef)。
 */
export function approach(current: number, target: number, dt: number, rising: boolean): number {
  const coef = rising ? WARMTH.rise : WARMTH.fall;
  const t = Math.min(1, Math.max(0, dt * coef));
  return current + (target - current) * t;
}

export interface WarmthSystemOptions {
  survival: SurvivalState;
  /** 热源判定（注入）：火 / 营火 / 灯笼 / 蜡烛或燃烧中的熔炉 */
  isHeatAt: (x: number, y: number, z: number) => boolean;
}

export class WarmthSystem implements System {
  readonly name = 'warmth';

  private readonly survival: SurvivalState;
  private readonly isHeatAt: (x: number, y: number, z: number) => boolean;
  private timer = 0;

  constructor(opts: WarmthSystemOptions) {
    this.survival = opts.survival;
    this.isHeatAt = opts.isHeatAt;
  }

  /**
   * 系统入口。第二参数为玩家位置；engine 直接调度时传入的数字 elapsed 会被忽略。
   * 只在生存模式生效；创造模式不更新（warmth 保持初始 0）。
   */
  update(dt: number, playerPos?: Vec3Like | number | null): void {
    if (!(dt > 0)) return;
    const pos = playerPos && typeof playerPos === 'object' ? playerPos : null;
    if (!pos) return;
    if (!this.survival.isSurvival) return;

    this.timer += dt;
    if (this.timer < SCAN_TICK) return;
    const step = this.timer;
    this.timer = 0;

    const cx = Math.floor(pos.x);
    const cy = Math.floor(pos.y);
    const cz = Math.floor(pos.z);
    const r = WARMTH.radius;
    let nearest: number | null = null;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const y = cy + dy;
        if (y < 0) continue;
        for (let dz = -r; dz <= r; dz++) {
          if (!this.isHeatAt(cx + dx, y, cz + dz)) continue;
          const d = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
          if (nearest === null || d < nearest) nearest = d;
        }
      }
    }

    const target = warmthTarget(nearest);
    const current = this.survival.warmth;
    this.survival.setWarmth(approach(current, target, step, target > current));
  }
}
