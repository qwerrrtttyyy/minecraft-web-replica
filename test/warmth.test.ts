/**
 * 温暖系统（PR5）纯逻辑回归（Vitest，直接消费 src TS 源码）。
 * 运行：npx vitest run test/warmth.test.ts
 * 覆盖：warmthTarget / approach 纯函数、WarmthSystem 升降与创造模式不更新、
 *       回血门槛（warmth>=50 → regenHunger，否则 coldHunger）、serialize / restore 兼容。
 */
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { WARMTH } from '../src/core/tuning';
import { MAX_HUNGER, SurvivalState } from '../src/player/survival';
import type { BlockRegistry } from '../src/world/blocks';
import { approach, WarmthSystem, warmthTarget } from '../src/world/warmth';

const registry = {
  get: (id: number) => ({ id, name: id === 5 ? 'dirt' : 'air' }),
  byNameGet: (n: string) => (n === 'dirt' ? { id: 5 } : undefined),
} as unknown as BlockRegistry;

const idle = { moving: false, sprinting: false, mining: false, underwater: false };
const sprint = { moving: true, sprinting: true, mining: false, underwater: false };
const mk = () => new SurvivalState(new EventBus(), registry);

describe('warmthTarget', () => {
  it('无热源 → 0', () => {
    expect(warmthTarget(null)).toBe(0);
  });

  it('相邻热源接近满值，随切比雪夫距离线性衰减', () => {
    expect(warmthTarget(0)).toBe(100);
    expect(warmthTarget(1)).toBeCloseTo(100 * (1 - 1 / (WARMTH.radius + 1)), 6);
    expect(warmthTarget(WARMTH.radius)).toBeCloseTo(100 * (1 - WARMTH.radius / (WARMTH.radius + 1)), 6);
  });

  it('半径外 → 0', () => {
    expect(warmthTarget(WARMTH.radius + 1)).toBe(0);
    expect(warmthTarget(999)).toBe(0);
  });
});

describe('approach', () => {
  it('上升用 rise 系数、下降用 fall 系数（min(1, dt*coef)）', () => {
    const up = approach(0, 100, 0.2, true);
    expect(up).toBeCloseTo(100 * Math.min(1, 0.2 * WARMTH.rise), 6);
    const down = approach(100, 0, 0.2, false);
    expect(down).toBeCloseTo(100 - 100 * Math.min(1, 0.2 * WARMTH.fall), 6);
    // 下降比上升慢
    expect(100 - down).toBeLessThan(up);
  });

  it('大 dt 收敛到目标值', () => {
    expect(approach(0, 100, 10, true)).toBe(100);
    expect(approach(100, 0, 10, false)).toBe(0);
  });
});

describe('WarmthSystem', () => {
  const heatAt = (x: number, y: number, z: number) => x === 0 && y === 0 && z === 0;

  it('附近有热源时 warmth 上升，远离后下降', () => {
    const s = mk();
    const sys = new WarmthSystem({
      survival: s,
      isHeatAt: heatAt,
    });
    // 节拍内不更新
    sys.update(0.1, { x: 0.5, y: 0.5, z: 0.5 });
    expect(s.warmth).toBe(0);
    // 累积满一拍 → 向目标（100）靠近
    sys.update(0.2, { x: 0.5, y: 0.5, z: 0.5 });
    expect(s.warmth).toBeGreaterThan(0);
    const first = s.warmth;
    for (let i = 0; i < 20; i++) sys.update(0.2, { x: 0.5, y: 0.5, z: 0.5 });
    expect(s.warmth).toBeGreaterThan(first);
    expect(s.warmth).toBeLessThanOrEqual(100);

    // 远离热源：目标 0，warmth 按 fall 系数下降（0.25/s，80 拍 ≈16s 后接近 0）
    for (let i = 0; i < 80; i++) sys.update(0.2, { x: 100.5, y: 0.5, z: 100.5 });
    expect(s.warmth).toBeLessThan(5);
  });

  it('创造模式不更新，warmth 保持 0', () => {
    const s = mk();
    s.mode = 'creative';
    const sys = new WarmthSystem({
      survival: s,
      isHeatAt: heatAt,
    });
    for (let i = 0; i < 10; i++) sys.update(0.2, { x: 0.5, y: 0.5, z: 0.5 });
    expect(s.warmth).toBe(0);
  });

  it('生存 tick 的创造模式分支重置 warmth', () => {
    const s = mk();
    s.setWarmth(80);
    s.mode = 'creative';
    s.tick(0.1, idle);
    expect(s.warmth).toBe(0);
  });

  it('setWarmth  clamp 到 0~100', () => {
    const s = mk();
    s.setWarmth(120);
    expect(s.warmth).toBe(100);
    s.setWarmth(-3);
    expect(s.warmth).toBe(0);
  });
});

describe('温暖回血门槛', () => {
  const run = (s: SurvivalState, ticks: number) => {
    const heals: number[] = [];
    const orig = s.heal.bind(s);
    s.heal = (a: number) => {
      heals.push(a);
      orig(a);
    };
    for (let i = 0; i < ticks; i++) s.tick(0.1, idle);
    return heals;
  };

  it('warmth>=50 时门槛为 14，否则为 18', () => {
    const warm = mk();
    warm.health = 10;
    warm.hunger = 14;
    warm.saturation = 10;
    warm.setWarmth(50);
    expect(run(warm, 50).length).toBeGreaterThan(0);

    const cold = mk();
    cold.health = 10;
    cold.hunger = 14;
    cold.saturation = 10;
    cold.setWarmth(49);
    expect(run(cold, 50).length).toBe(0);

    // 常温 18 的基线仍有效
    const base = mk();
    base.health = 10;
    base.hunger = 18;
    base.saturation = 10;
    expect(run(base, 50).length).toBeGreaterThan(0);
  });
});

describe('温暖消耗增益', () => {
  /** 同样疾跑动作下，饥饿首次掉点所需的 tick 数（exhaustion 累积更慢 → 更晚掉点） */
  const firstHungerDropTick = (warmth: number) => {
    const s = mk();
    s.hunger = MAX_HUNGER;
    s.saturation = 0; // 不让饱和度当缓冲，直接观察 hunger 掉落
    s.setWarmth(warmth);
    for (let i = 1; i <= 600; i++) {
      s.tick(0.1, sprint);
      if (s.hunger < MAX_HUNGER) return i;
    }
    return -1;
  };

  it('warmth 达标时同样动作的 exhaustion 积累更少（掉饥饿更晚）', () => {
    const warm = firstHungerDropTick(WARMTH.regenThreshold); // 50 → scale 0.8
    const cold = firstHungerDropTick(WARMTH.regenThreshold - 1); // 49 → scale 1
    expect(warm).toBeGreaterThan(0);
    expect(cold).toBeGreaterThan(0);
    expect(warm).toBeGreaterThan(cold);
  });
});

describe('温暖存档', () => {
  it('serialize / restore 往返 warmth', () => {
    const s = mk();
    s.setWarmth(42.5);
    const snap = s.serialize();
    expect(snap.warmth).toBe(42.5);

    const s2 = mk();
    s2.restore(snap);
    expect(s2.warmth).toBe(42.5);
  });

  it('旧档缺 warmth → 0；越界 clamp', () => {
    const legacy = mk();
    legacy.setWarmth(80);
    legacy.restore({ health: 10, hunger: 10, saturation: 5, breath: 15, inventory: [], spawn: { x: 0, y: 40, z: 0 } });
    expect(legacy.warmth).toBe(0);

    const over = mk();
    over.restore({
      health: 10,
      hunger: 10,
      saturation: 5,
      warmth: 150,
      breath: 15,
      inventory: [],
      spawn: { x: 0, y: 40, z: 0 },
    });
    expect(over.warmth).toBe(100);

    const under = mk();
    under.restore({
      health: 10,
      hunger: 10,
      saturation: 5,
      warmth: -5,
      breath: 15,
      inventory: [],
      spawn: { x: 0, y: 40, z: 0 },
    });
    expect(under.warmth).toBe(0);
  });

  it('respawn 重置 warmth', () => {
    const s = mk();
    s.setWarmth(77);
    s.respawn({ x: 0, y: 40, z: 0 });
    expect(s.warmth).toBe(0);
    expect(s.hunger).toBe(MAX_HUNGER);
  });
});
