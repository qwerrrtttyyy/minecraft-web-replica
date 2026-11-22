/**
 * 火焰系统（PR3）纯逻辑回归（Vitest，直接消费 src TS 源码）。
 * 运行：npx vitest run test/fire.test.ts
 * 覆盖：引燃 / 不燃 / 寿命熄灭 / 开关关闭不蔓延 / 玩家与实体伤害间隔 / isFireNear。
 *
 * 用 fake world + 注入 rng，不依赖 three 场景与 DOM。
 */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

import { FireSystem, isFireNear, scanHeatSources } from '../src/world/fire';
import type { World } from '../src/world/world';
import type { BlockRegistry } from '../src/world/blocks';
import type { EventService } from '../src/services/events';
import type { Particles } from '../src/gfx/particles';

const AIR = 0;
const STONE = 1;
const GRASS = 2;
const OAK_LOG = 3;
const TALL_GRASS = 4;
const CAMPFIRE = 165;
const FIRE = 168;

const NAMES: Record<number, string> = {
  [AIR]: 'air', [STONE]: 'stone', [GRASS]: 'grass', [OAK_LOG]: 'oak_log',
  [TALL_GRASS]: 'tall_grass',
  [CAMPFIRE]: 'campfire', [FIRE]: 'fire',
};
const IDS: Record<string, number> = Object.fromEntries(
  Object.entries(NAMES).map(([id, name]) => [name, Number(id)]),
);
const SOLID: Record<number, boolean> = {
  [STONE]: true, [GRASS]: true, [OAK_LOG]: true,
  // 十字面植物：非实心，但可被火直接引燃
  [TALL_GRASS]: false,
};

function makeRegistry(): BlockRegistry {
  return {
    get: (id: number) => ({ id, name: NAMES[id] ?? 'air', solid: SOLID[id] ?? false }),
    byNameGet: (name: string) => (name in IDS ? { id: IDS[name] } : undefined),
    isSolid: (id: number) => SOLID[id] ?? false,
  } as unknown as BlockRegistry;
}

class FakeWorld {
  readonly data = new Map<string, number>();
  readonly registry = makeRegistry();
  /** 打开后 setBlock 对 y<1 返回 false（模拟真实世界边界） */
  rejectLowY = false;

  getBlock(x: number, y: number, z: number): number {
    return this.data.get(`${x},${y},${z}`) ?? AIR;
  }

  setBlock(x: number, y: number, z: number, id: number): boolean {
    if (this.rejectLowY && y < 1) return false;
    this.data.set(`${x},${y},${z}`, id);
    return true;
  }
}

function makeEvents() {
  const calls: { type: string; payload: unknown }[] = [];
  const events = {
    emit: (type: string, payload: unknown) => { calls.push({ type, payload }); },
  };
  return { calls, events: events as unknown as EventService };
}

interface Harness {
  sys: FireSystem;
  events: { calls: { type: string; payload: unknown }[]; events: EventService };
  particles: Particles;
  hurtPlayer: ReturnType<typeof vi.fn>;
}

function makeSystem(
  world: FakeWorld,
  rng: () => number = () => 0,
  getEntities: () => Array<{ id: number; pos: THREE.Vector3; hurt: ReturnType<typeof vi.fn> }> = () => [],
): Harness {
  const { calls, events } = makeEvents();
  const particles = { enabled: true, burst: vi.fn() } as unknown as Particles;
  const hurtPlayer = vi.fn(() => true);
  const sys = new FireSystem({
    world: world as unknown as World,
    registry: world.registry,
    events,
    particles,
    hurtPlayer,
    rng,
    getEntities,
  });
  return { sys, events: { calls, events }, particles, hurtPlayer };
}

const POS = new THREE.Vector3(0.5, 1.0, 0.5);

describe('火焰系统', () => {
  it('火源旁的可燃空气格被点燃（概率 1 时必燃）', () => {
    const w = new FakeWorld();
    w.setBlock(0, 0, 0, GRASS);
    w.setBlock(1, 0, 0, GRASS);
    w.setBlock(0, 1, 0, CAMPFIRE);
    const { sys, events } = makeSystem(w, () => 0);

    sys.update(0.25, POS);

    expect(w.getBlock(1, 1, 0)).toBe(FIRE);
    expect(events.calls.some((c) => c.type === 'fire:ignite')).toBe(true);
  });

  it('不可燃方块不燃', () => {
    const w = new FakeWorld();
    w.setBlock(0, 0, 0, STONE);
    w.setBlock(1, 0, 0, STONE);
    w.setBlock(0, 1, 0, CAMPFIRE);
    const { sys } = makeSystem(w, () => 0);

    sys.update(0.25, POS);

    expect(w.getBlock(1, 1, 0)).toBe(AIR);
  });

  it('直接引燃相邻的实心可燃方块（原木）', () => {
    const w = new FakeWorld();
    w.setBlock(0, 0, 0, STONE);
    w.setBlock(1, 1, 0, OAK_LOG);
    w.setBlock(0, 1, 0, CAMPFIRE);
    const { sys, events } = makeSystem(w, () => 0);

    sys.update(0.25, POS);

    expect(w.getBlock(1, 1, 0)).toBe(FIRE);
    expect(events.calls.some((c) => c.type === 'fire:ignite')).toBe(true);
  });

  it('直接引燃相邻的十字面植物（草）', () => {
    const w = new FakeWorld();
    w.setBlock(0, 0, 0, STONE);
    w.setBlock(1, 0, 0, GRASS);
    w.setBlock(1, 1, 0, TALL_GRASS);
    w.setBlock(0, 1, 0, CAMPFIRE);
    const { sys } = makeSystem(w, () => 0);

    sys.update(0.25, POS);

    expect(w.getBlock(1, 1, 0)).toBe(FIRE);
  });

  it('不烧掉正下方的支撑方块（避免火焰自熄）', () => {
    const w = new FakeWorld();
    w.setBlock(0, 0, 0, GRASS);
    w.setBlock(0, 1, 0, FIRE);
    const { sys } = makeSystem(w, () => 0);

    sys.update(0.25, POS);

    expect(w.getBlock(0, 0, 0)).toBe(GRASS);
    expect(w.getBlock(0, 1, 0)).toBe(FIRE);
  });

  it('相邻的非可燃实心方块保持原样', () => {
    const w = new FakeWorld();
    w.setBlock(0, 0, 0, STONE);
    w.setBlock(1, 1, 0, STONE);
    w.setBlock(0, 1, 0, CAMPFIRE);
    const { sys } = makeSystem(w, () => 0);

    sys.update(0.25, POS);

    expect(w.getBlock(1, 1, 0)).toBe(STONE);
  });

  it('寿命到熄灭为空气', () => {
    const w = new FakeWorld();
    w.setBlock(0, 0, 0, GRASS);
    w.setBlock(0, 1, 0, FIRE);
    const { sys, events } = makeSystem(w, () => 0); // 寿命 = 18 × 0.7 = 12.6s

    for (let i = 0; i < 60; i++) sys.update(0.25, POS); // 15s

    expect(w.getBlock(0, 1, 0)).toBe(AIR);
    expect(events.calls.some((c) => c.type === 'fire:extinguish')).toBe(true);
  });

  it('失去下方固体支撑时熄灭', () => {
    const w = new FakeWorld();
    w.setBlock(0, 1, 0, FIRE); // 悬空火焰，下方是空气
    const { sys } = makeSystem(w, () => 0);

    sys.update(0.25, POS);

    expect(w.getBlock(0, 1, 0)).toBe(AIR);
  });

  it('enabled=false 不蔓延，已有火焰仍按寿命熄灭', () => {
    const w = new FakeWorld();
    w.setBlock(0, 0, 0, GRASS);
    w.setBlock(1, 0, 0, GRASS);
    w.setBlock(0, 1, 0, CAMPFIRE);
    const { sys } = makeSystem(w, () => 0);
    sys.enabled = false;

    sys.update(0.25, POS);
    expect(w.getBlock(1, 1, 0)).toBe(AIR);

    // 已存在的火焰仍然燃尽
    w.setBlock(5, 1, 5, FIRE);
    w.setBlock(5, 0, 5, GRASS);
    for (let i = 0; i < 60; i++) sys.update(0.25, POS);
    expect(w.getBlock(5, 1, 5)).toBe(AIR);
  });

  it('玩家在火上的伤害间隔为 0.5s', () => {
    const w = new FakeWorld();
    w.setBlock(0, 0, 0, GRASS);
    w.setBlock(0, 1, 0, FIRE);
    const { sys, hurtPlayer } = makeSystem(w);
    const pos = new THREE.Vector3(0.5, 1.0, 0.5); // 脚下方块 (0,1,0) 是火

    sys.update(0.25, pos);
    expect(hurtPlayer).not.toHaveBeenCalled();
    sys.update(0.25, pos);
    expect(hurtPlayer).toHaveBeenCalledTimes(1);
    expect(hurtPlayer).toHaveBeenLastCalledWith(1, '火焰');
    sys.update(0.25, pos);
    expect(hurtPlayer).toHaveBeenCalledTimes(1);
    sys.update(0.25, pos);
    expect(hurtPlayer).toHaveBeenCalledTimes(2);
  });

  it('实体在火上的伤害间隔为 0.5s（系统自管计时）', () => {
    const w = new FakeWorld();
    w.setBlock(0, 0, 0, GRASS);
    w.setBlock(0, 1, 0, FIRE);
    const entity = { id: 7, pos: new THREE.Vector3(0.5, 1.0, 0.5), hurt: vi.fn() };
    const { sys } = makeSystem(w, () => 0, () => [entity]);
    const pos = new THREE.Vector3(0.5, 1.0, 0.5);

    sys.update(0.25, pos);
    expect(entity.hurt).not.toHaveBeenCalled();
    sys.update(0.25, pos);
    expect(entity.hurt).toHaveBeenCalledTimes(1);
    expect(entity.hurt).toHaveBeenLastCalledWith(1, 0, 0);
    sys.update(0.25, pos);
    expect(entity.hurt).toHaveBeenCalledTimes(1);
    sys.update(0.25, pos);
    expect(entity.hurt).toHaveBeenCalledTimes(2);
  });

  it('igniteCell 尊重 setBlock 返回值：y<1 不入表、不发事件', () => {
    const w = new FakeWorld();
    w.setBlock(0, 0, 0, CAMPFIRE);
    w.setBlock(1, 0, 0, OAK_LOG);
    w.rejectLowY = true;
    const { sys, events } = makeSystem(w, () => 0);

    sys.update(0.25, POS);

    expect(w.getBlock(1, 0, 0)).toBe(OAK_LOG);
    expect(events.calls.some((c) => c.type === 'fire:ignite')).toBe(false);
    expect(sys.trackedCount).toBe(1); // 只有营火本身，失败的引燃不入表
  });

  it('实体全部离场后仍清理过期伤害计时', () => {
    const w = new FakeWorld();
    w.setBlock(0, 0, 0, GRASS);
    w.setBlock(0, 1, 0, FIRE);
    const entities = Array.from({ length: 70 }, (_, i) => ({
      id: i,
      pos: new THREE.Vector3(0.5, 1.0, 0.5),
      hurt: vi.fn(),
    }));
    let alive = true;
    const { sys } = makeSystem(w, () => 0, () => (alive ? entities : []));

    sys.update(0.5, new THREE.Vector3(0.5, 1.0, 0.5));
    const map = (sys as unknown as { entityDamageAt: Map<number, number> }).entityDamageAt;
    expect(map.size).toBe(70);

    alive = false;
    for (let i = 0; i < 24; i++) sys.update(0.25, new THREE.Vector3(0.5, 1.0, 0.5)); // 6s
    expect(map.size).toBe(0);
  });

  it('isFireNear 判定火源半径', () => {
    const w = new FakeWorld();
    w.setBlock(5, 10, 5, FIRE);
    const world = w as unknown as World;

    expect(isFireNear(world, 5, 10, 5, 3)).toBe(true);
    expect(isFireNear(world, 8, 10, 5, 3)).toBe(true); // dx=3
    expect(isFireNear(world, 9, 10, 5, 3)).toBe(false); // dx=4
    expect(isFireNear(world, 5, 13, 5, 3)).toBe(true); // dy=3
    expect(isFireNear(world, 5, 14, 5, 3)).toBe(false); // dy=4

    w.setBlock(5, 10, 5, AIR);
    w.setBlock(-5, 10, -5, CAMPFIRE);
    expect(isFireNear(world, -5, 10, -5, 3)).toBe(true);
    expect(isFireNear(world, 0, 10, 0, 3)).toBe(false);
  });

  it('scanHeatSources 是纯函数：只读扫描并回调热源', () => {
    const w = new FakeWorld();
    w.setBlock(0, 0, 0, FIRE);
    w.setBlock(2, 1, 2, CAMPFIRE);
    w.setBlock(-1, 0, -1, GRASS);
    const found: Array<[number, number, number]> = [];

    scanHeatSources(w as unknown as World, w.registry, 0, 0, 0, 4, 4, (x, y, z) => {
      found.push([x, y, z]);
    });

    expect(found).toContainEqual([0, 0, 0]);
    expect(found).toContainEqual([2, 1, 2]);
    expect(found).toHaveLength(2);
  });
});
