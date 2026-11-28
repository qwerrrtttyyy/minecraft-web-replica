/**
 * 寒冷纯逻辑（四季与天候内容更新）。
 *
 * WarmthSystem 只负责"靠近热源更暖"，明确排除寒冷伤害（warmth.ts:11）。
 * 本模块负责恶劣天气对温暖的惩罚与冻伤节拍，独立可测。
 */
import { type System } from '../core/types';
import { COLD } from '../core/tuning';
import type { WeatherKind } from './weather';
import type { Season } from './ecology';
import type { SurvivalState } from '../player/survival';

/** 环境对温暖的每秒惩罚（0 表示无惩罚） */
export function environmentPenalty(
  kind: WeatherKind, season: Season, daylight: number, sheltered: boolean, enabled = true,
): number {
  // 「天气与季节」关闭后不产生任何寒冷：冬季 / 夜晚惩罚也必须一起停掉
  if (!enabled) return 0;
  let p = 0;
  if (kind === 'rain') p = COLD.rainPenalty;
  else if (kind === 'snow') p = COLD.snowPenalty;
  else if (kind === 'thunder') p = COLD.stormPenalty;
  if (season === 'winter') p += COLD.winterPenalty;
  if (daylight < COLD.nightDaylight) p += COLD.nightPenalty;
  if (sheltered) p *= COLD.shelterMultiplier;
  return p;
}

/** 是否满足一次冻伤：有惩罚 + 温暖低于阈值 + 距上次伤害达到间隔 */
export function freezeDue(warmth: number, elapsedSinceDamage: number, penalty: number): boolean {
  return penalty > 0 && warmth <= COLD.warmthThreshold && elapsedSinceDamage >= COLD.damageInterval;
}

export interface ColdContext {
  kind: WeatherKind;
  season: Season;
  daylight: number;
  sheltered: boolean;
  /** 「天气与季节」设置；false 时寒冷完全关闭（含冬季 / 夜晚惩罚） */
  enabled?: boolean;
}

export interface ColdSystemOptions {
  survival: SurvivalState;
  observe: () => ColdContext;
  /** 冻伤钩子：组装根接到 survival.damage(amount, cause, false, 'freeze') */
  hurt: (amount: number, cause: string, kind: 'freeze') => void;
}

export class ColdSystem implements System {
  readonly name = 'cold';

  private readonly survival: SurvivalState;
  private readonly observe: () => ColdContext;
  private readonly hurt: ColdSystemOptions['hurt'];
  private timer = 0;

  constructor(opts: ColdSystemOptions) {
    this.survival = opts.survival;
    this.observe = opts.observe;
    this.hurt = opts.hurt;
  }

  update(dt: number): void {
    if (!(dt > 0)) return;
    if (!this.survival.isSurvival) return;
    const ctx = this.observe();
    const penalty = environmentPenalty(ctx.kind, ctx.season, ctx.daylight, ctx.sheltered, ctx.enabled !== false);
    this.timer += dt;
    if (freezeDue(this.survival.warmth, this.timer, penalty)) {
      this.timer = 0;
      this.hurt(COLD.damage, '冻伤', 'freeze');
    }
  }
}
