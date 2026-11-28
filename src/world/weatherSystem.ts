/**
 * 天候系统（四季与天候内容更新）。
 *
 * 与 weather.ts 的分工：weather.ts 只放零依赖纯函数，本文件是运行时 System——
 * 采样历法 → 平滑逼近 → 发事件 → 把 current 暴露给变暗 / 粒子 / 寒冷三处共用。
 */
import { seasonAt } from './ecology';
import {
  approachWeather, isLightning, weatherFactor, weatherTarget,
  type Precipitation, type WeatherKind, type WeatherSnapshot,
} from './weather';
import { WEATHER } from '../core/tuning';
import { type System, type Vec3Like } from '../core/types';
import type { EventService } from '../services/events';

export interface WeatherSystemOptions {
  seed: number;
  /** 当帧时间与昼夜强度（由 sky 提供） */
  getTime: () => { dayCount: number; daylight: number };
  /** 天气观察焦点（玩家位置） */
  getFocus: () => Vec3Like;
  /** 群系逐列温度 0~1 */
  temperatureAt: (x: number, z: number) => number;
  events: EventService;
}

export class WeatherSystem implements System {
  readonly name = 'weather';
  /** 当前平滑后的天气快照：方块光 / 实体光 / 寒冷 / 粒子共用这一份真源 */
  current: WeatherSnapshot = weatherTarget(0, 0, 1, 'spring');
  /** 设置总闸：关闭时平滑回到晴天，停降水 / 变暗 / 雷暴 */
  enabled = true;
  /** 自动化测试强制天气；null 表示按历法推导 */
  forced: WeatherKind | null = null;

  private readonly seed: number;
  private readonly getTime: WeatherSystemOptions['getTime'];
  private readonly getFocus: WeatherSystemOptions['getFocus'];
  private readonly temperatureAt: WeatherSystemOptions['temperatureAt'];
  private readonly events: EventService;
  private lightningTick = -1;

  constructor(opts: WeatherSystemOptions) {
    this.seed = opts.seed;
    this.getTime = opts.getTime;
    this.getFocus = opts.getFocus;
    this.temperatureAt = opts.temperatureAt;
    this.events = opts.events;
  }

  /** 当前唯一的变暗因子（含闪电提亮），两处光照通道都必须用它 */
  darknessFactor(): number {
    return weatherFactor(this.current.kind, this.current.flash);
  }

  update(dt: number, elapsed: number): void {
    if (!(dt > 0)) return;
    const { dayCount } = this.getTime();
    const focus = this.getFocus();
    let target: WeatherSnapshot;
    if (!this.enabled) {
      target = { day: dayCount, kind: 'clear', form: 'none', intensity: 0, darkness: 1, flash: 0 };
    } else if (this.forced) {
      const kind = this.forced;
      const form: Precipitation = kind === 'snow' ? 'snow' : kind === 'clear' ? 'none' : 'rain';
      target = {
        day: dayCount, kind, form,
        intensity: WEATHER.intensity[kind],
        darkness: weatherFactor(kind, 0), flash: 0,
      };
    } else {
      target = weatherTarget(this.seed, dayCount, this.temperatureAt(focus.x, focus.z), seasonAt(dayCount));
    }

    // 闪电：按节拍边沿触发，只在雷暴天；flash 由 approachWeather 自然衰减回 0
    const tick = Math.floor(elapsed / WEATHER.lightningInterval);
    if (tick !== this.lightningTick) {
      this.lightningTick = tick;
      if (this.enabled && target.kind === 'thunder' && isLightning(this.seed, dayCount, tick)) {
        this.current.flash = 1;
        this.events.emit('weather:lightning', { x: focus.x, y: focus.y, z: focus.z });
      }
    }

    const prevKind = this.current.kind;
    this.current = approachWeather(this.current, target, dt);
    if (prevKind !== this.current.kind) {
      this.events.emit('weather:change', { ...this.current });
    }
  }
}
