/**
 * 生存饱和度（PR2）纯逻辑回归（Vitest，直接消费 src TS 源码）。
 * 运行：npx vitest run test/survival-saturation.test.ts
 * 覆盖：进食叠加、饱和度上限、exhaustion 缓冲顺序、回血门槛、存档往返 / 旧档兼容。
 */
import { describe, expect, it } from 'vitest';

import { SurvivalState, MAX_HUNGER } from '../src/player/survival';
import { EventBus } from '../src/core/events';

const registry = {
  get: (id: number) => ({ id, name: id === 5 ? 'dirt' : 'air' }),
  byNameGet: (n: string) => (n === 'dirt' ? { id: 5 } : undefined),
};

const idle = { moving: false, sprinting: false, mining: false, underwater: false };
const sprint = { moving: true, sprinting: true, mining: false, underwater: false };
const mk = () => new SurvivalState(new EventBus(), registry);

describe('生存饱和度', () => {
  it('吃食物同时恢复 hunger 与 saturation', () => {
    const s = mk();
    s.hunger = 10;
    s.saturation = 0;
    expect(s.eat('apple')).toBe(true); // food 4 / saturation 2.4
    expect(s.hunger).toBe(14);
    expect(s.saturation).toBe(2.4);
  });

  it('saturation 事件载荷包含 saturation', () => {
    const ev = new EventBus();
    const s = new SurvivalState(ev, registry);
    s.hunger = 10;
    s.saturation = 0;
    let payload: { item: string; hunger: number; saturation: number } | undefined;
    ev.on('survival:eat', (p) => { payload = p; });
    s.eat('apple');
    expect(payload).toMatchObject({ item: 'apple', hunger: 14, saturation: 2.4 });
  });

  it('饱和度不超过当前 hunger（含 20 上限）', () => {
    const s = mk();
    s.hunger = 4;
    s.saturation = 8;
    s.eat('porkchop'); // hunger 4→10，saturation min(10, 8+3.6)=10
    expect(s.hunger).toBe(10);
    expect(s.saturation).toBe(10);

    const full = mk();
    full.hunger = 19;
    full.saturation = 19;
    full.eat('rice'); // hunger 19→20，saturation min(20, 19+3)=20
    expect(full.hunger).toBe(MAX_HUNGER);
    expect(full.saturation).toBe(MAX_HUNGER);
  });

  it('exhaustion 先扣 saturation，耗尽后才扣 hunger', () => {
    const buffered = mk();
    buffered.hunger = 20;
    buffered.saturation = 1;
    for (let i = 0; i < 250; i++) buffered.tick(0.1, sprint); // 25s * 0.2 = 5 → 1 点
    expect(buffered.saturation).toBe(0);
    expect(buffered.hunger).toBe(20);

    const dry = mk();
    dry.hunger = 20;
    dry.saturation = 0;
    for (let i = 0; i < 250; i++) dry.tick(0.1, sprint);
    expect(dry.saturation).toBe(0);
    expect(dry.hunger).toBe(19);
  });

  it('饱食回血需 hunger>=18 且 saturation>0', () => {
    const noSat = mk();
    noSat.health = 10;
    noSat.hunger = 19;
    noSat.saturation = 0;
    const heals: number[] = [];
    const origHeal = noSat.heal.bind(noSat);
    noSat.heal = (a: number) => { heals.push(a); origHeal(a); };
    for (let i = 0; i < 400; i++) noSat.tick(0.1, idle);
    expect(heals.length).toBe(0);
    expect(noSat.health).toBe(10);

    const sat = mk();
    sat.health = 10;
    sat.hunger = 19;
    sat.saturation = 10;
    const heals2: number[] = [];
    const origHeal2 = sat.heal.bind(sat);
    sat.heal = (a: number) => { heals2.push(a); origHeal2(a); };
    for (let i = 0; i < 400; i++) sat.tick(0.1, idle);
    expect(heals2.length).toBeGreaterThan(0);
    expect(sat.health).toBe(20);
    expect(sat.hunger).toBe(19); // 饱和度吸收回血消耗，hunger 不掉
  });

  it('serialize / restore 往返 saturation；旧档缺字段恢复满值', () => {
    const s = mk();
    s.hunger = 12;
    s.saturation = 3.2;
    const snap = s.serialize();
    expect(snap.saturation).toBe(3.2);

    const s2 = mk();
    s2.restore(snap);
    expect(s2.saturation).toBe(3.2);

    const legacy = mk();
    legacy.saturation = 5;
    legacy.restore({ health: 10, hunger: 10, breath: 15, inventory: [], spawn: { x: 0, y: 40, z: 0 } });
    expect(legacy.saturation).toBe(MAX_HUNGER);

    const over = mk();
    over.restore({ health: 10, hunger: 10, saturation: 99, breath: 15, inventory: [], spawn: { x: 0, y: 40, z: 0 } });
    expect(over.saturation).toBe(MAX_HUNGER);

    const under = mk();
    under.restore({ health: 10, hunger: 10, saturation: -5, breath: 15, inventory: [], spawn: { x: 0, y: 40, z: 0 } });
    expect(under.saturation).toBe(0);
  });

  it('respawn 重置饱和度', () => {
    const s = mk();
    s.hunger = 3;
    s.saturation = 0;
    s.respawn({ x: 0, y: 40, z: 0 });
    expect(s.saturation).toBe(MAX_HUNGER);
    expect(s.hunger).toBe(MAX_HUNGER);
  });
});
