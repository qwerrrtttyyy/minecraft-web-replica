import type * as THREE from 'three';
import { blockKey, type BlockId, type System } from '../core/types';
import { AIR, type BlockRegistry } from './blocks';
import type { World } from './world';
import type { EventService } from '../services/events';
import type { Particles } from '../gfx/particles';
import { FIRE, FLAMMABLE } from '../core/tuning';

/**
 * 火焰系统（PR3 真实火焰蔓延）。
 *
 * 热源：fire(168) 与 campfire(165)。营火永久不熄，火焰有寿命（默认 18s，±30%）。
 * 跟踪：内部 Map<key, {x,y,z,age,life}>，由玩家周围定期扫描发现 + 自身点燃直接入表。
 * 蔓延：每拍最多处理 maxPerTick 个火源，对 6 邻判定：
 *   1) 邻格本身可燃（实心方块 / 十字面植物）→ 直接引燃该格（烧尽）；
 *   2) 邻格是空气且下方是实心可燃方块 → 引燃该空气格。
 * 伤害：玩家 / 实体脚下方块是火 / 营火时，每 damageInterval 秒造成 damage 点伤害。
 *
 * 火焰是运行时状态：点燃 / 熄灭走 setBlock(..., record=false)，不写玩家编辑差分，
 * 避免污染存档（读档后火焰熄灭）。
 */

/** 扫描垂直半高：玩家脚上下各 8 格（成本受控） */
const SCAN_VERTICAL = 8;
/** 每拍最大 tick 次数，防止异常大 dt 造成单帧卡顿 */
const MAX_TICKS_PER_UPDATE = 8;
/** 6 邻方向（±x / ±y / ±z） */
const DIRS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/** 热源方块名：火焰与营火 */
export function isHeatBlock(name: string): boolean {
  return name === 'fire' || name === 'campfire';
}

/** 火焰系统伤害回调所需的实体最小结构（Entity 结构兼容） */
export interface FireEntityLike {
  id: number;
  pos: { x: number; y: number; z: number };
  hurt(amount: number, fromX?: number, fromZ?: number): void;
}

export interface FireSystemOptions {
  world: World;
  registry: BlockRegistry;
  events: EventService;
  particles: Particles;
  /** 对玩家造成伤害（一般接 SurvivalState.damage） */
  hurtPlayer: (amount: number, cause: string) => boolean;
  /** 可注入随机源（测试用确定性 rng） */
  rng?: () => number;
  /** 实体列表提供者（伤害判定用；主装配传 EntityManager.entities） */
  getEntities?: () => readonly FireEntityLike[];
  /** 可选音效（点燃时的噼啪声） */
  sound?: { crackle(): void };
}

interface TrackedFire {
  x: number;
  y: number;
  z: number;
  age: number;
  life: number;
}

/**
 * 扫描玩家周围的热源（纯函数，只读世界，便于单测）。
 * 命中回调由调用方决定如何入表，函数本身不持有状态。
 */
export function scanHeatSources(
  world: World,
  registry: BlockRegistry,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  vertical: number,
  onFound: (x: number, y: number, z: number) => void,
): void {
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const z0 = Math.floor(cz);
  const r = Math.max(0, Math.floor(radius));
  const v = Math.max(0, Math.floor(vertical));
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -v; dy <= v; dy++) {
      const y = y0 + dy;
      if (y < 0) continue;
      for (let dz = -r; dz <= r; dz++) {
        const id = world.getBlock(x0 + dx, y, z0 + dz);
        if (id === AIR) continue;
        if (isHeatBlock(registry.get(id).name)) onFound(x0 + dx, y, z0 + dz);
      }
    }
  }
}

/** 半径 r（切比雪夫距离）内是否有火 / 营火，供刷怪规避用 */
export function isFireNear(world: World, x: number, y: number, z: number, r: number): boolean {
  const reg = world.registry;
  const rr = Math.max(0, Math.floor(r));
  for (let dx = -rr; dx <= rr; dx++) {
    for (let dy = -rr; dy <= rr; dy++) {
      for (let dz = -rr; dz <= rr; dz++) {
        const id = world.getBlock(x + dx, y + dy, z + dz);
        if (id !== AIR && isHeatBlock(reg.get(id).name)) return true;
      }
    }
  }
  return false;
}

export class FireSystem implements System {
  readonly name = 'fire';
  /** 设置页「火焰蔓延」开关：关闭时不蔓延、不点燃，已有火焰仍按寿命燃尽并造成伤害 */
  enabled = true;

  private readonly world: World;
  private readonly registry: BlockRegistry;
  private readonly events: EventService;
  private readonly particles: Particles;
  private readonly hurtPlayer: (amount: number, cause: string) => boolean;
  private readonly rng: () => number;
  private readonly getEntities: () => readonly FireEntityLike[];
  private readonly sound?: { crackle(): void };
  private readonly fireId: BlockId;
  private readonly campfireId: BlockId;

  /** 跟踪中的热源（火 + 营火） */
  private readonly tracked = new Map<string, TrackedFire>();
  /** 各实体下次可受伤时刻（Entity.hurt 无无敌帧，由本系统自管计时） */
  private readonly entityDamageAt = new Map<number, number>();
  private scanTimer = 0;
  private damageTimer = 0;
  private crackleTimer = 0;
  private time = 0;
  private playerPos: THREE.Vector3 | null = null;

  constructor(opts: FireSystemOptions) {
    this.world = opts.world;
    this.registry = opts.registry;
    this.events = opts.events;
    this.particles = opts.particles;
    this.hurtPlayer = opts.hurtPlayer;
    this.rng = opts.rng ?? Math.random;
    this.getEntities = opts.getEntities ?? (() => []);
    this.sound = opts.sound;
    this.fireId = this.registry.byNameGet('fire')?.id ?? 168;
    this.campfireId = this.registry.byNameGet('campfire')?.id ?? 165;
  }

  /** 跟踪中的热源数量（F3 调试用） */
  get trackedCount(): number {
    return this.tracked.size;
  }

  /**
   * 系统入口。第二参数为玩家位置（main 的 gameplay 系统传入）；
   * engine 若直接调度本系统，传来的数字 elapsed 会被忽略。
   */
  update(dt: number, playerPos?: THREE.Vector3 | number): void {
    if (typeof playerPos !== 'object' || !playerPos) return;
    this.playerPos = playerPos;
    this.time += dt;
    this.scanTimer += dt;
    this.damageTimer += dt;
    this.crackleTimer = Math.max(0, this.crackleTimer - dt);

    // 扫描 / 蔓延 / 寿命 / 粒子：按 scanTick 节拍推进
    let guard = 0;
    while (this.scanTimer >= FIRE.scanTick && guard++ < MAX_TICKS_PER_UPDATE) {
      this.scanTimer -= FIRE.scanTick;
      this.tick();
    }
    // 伤害：按 damageInterval 节拍推进
    if (this.damageTimer >= FIRE.damageInterval) {
      this.damageTimer -= FIRE.damageInterval;
      this.applyDamage();
    }
  }

  /** 一个扫描 / 蔓延节拍 */
  private tick(): void {
    // 1) 发现玩家周围的新热源
    if (this.playerPos) {
      scanHeatSources(
        this.world, this.registry,
        this.playerPos.x, this.playerPos.y, this.playerPos.z,
        FIRE.scanRadius, SCAN_VERTICAL,
        (x, y, z) => this.track(x, y, z),
      );
    }

    // 2) 老化 + 支撑检查 + 移除已消失条目
    for (const [key, e] of this.tracked) {
      const id = this.world.getBlock(e.x, e.y, e.z);
      if (!isHeatBlock(this.registry.get(id).name)) {
        this.tracked.delete(key);
        continue;
      }
      if (id === this.campfireId) continue; // 营火永久不熄
      e.age += FIRE.scanTick;
      if (e.age >= e.life) {
        this.extinguish(e.x, e.y, e.z, 'lifetime');
        continue;
      }
      // 火焰失去下方固体支撑则熄灭
      if (!this.registry.isSolid(this.world.getBlock(e.x, e.y - 1, e.z))) {
        this.extinguish(e.x, e.y, e.z, 'unsupported');
        continue;
      }
    }

    // 3) 蔓延（开关关闭时只燃尽、不引燃）
    if (this.enabled) {
      // 先快照再蔓延：点燃会向 tracked 插入新条目，
      // 边遍历边插入会让新火在同一拍内连锁引爆，火势失控。
      const sources: TrackedFire[] = [];
      for (const e of this.tracked.values()) sources.push(e);
      let budget = FIRE.maxPerTick;
      for (const e of sources) {
        // 先确认源仍然有效，再占用预算：被跳过的陈旧源不该消耗蔓延额度
        if (!this.tracked.has(blockKey(e.x, e.y, e.z))) continue;
        if (budget-- <= 0) break;
        this.spreadFrom(e.x, e.y, e.z);
      }
    }

    // 4) 火源粒子氛围（每拍每热源约 0.5 概率）
    if (this.particles.enabled) {
      for (const e of this.tracked.values()) {
        if (this.rng() < 0.5) {
          this.particles.burst(e.x + 0.5, e.y + 0.6, e.z + 0.5, [1, 0.55, 0.15], 1, 0.25, 0.8);
        }
      }
    }
  }

  /** 把发现的热源加入跟踪（已存在则跳过） */
  private track(x: number, y: number, z: number): void {
    const key = blockKey(x, y, z);
    if (this.tracked.has(key)) return;
    const id = this.world.getBlock(x, y, z);
    const life = id === this.campfireId ? Number.POSITIVE_INFINITY : this.rollLife();
    this.tracked.set(key, { x, y, z, age: 0, life });
  }

  /** 火焰寿命：默认 18s，按 rng ±30% 波动 */
  private rollLife(): number {
    return FIRE.lifetime * (0.7 + this.rng() * 0.6);
  }

  /** 单个火源向 6 邻蔓延 */
  private spreadFrom(x: number, y: number, z: number): void {
    for (const [dx, dy, dz] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      const nid = this.world.getBlock(nx, ny, nz);
      if (nid === this.fireId || nid === this.campfireId) continue;

      // 1) 邻格本身可燃（原木 / 树叶 / 花草等，含十字面植物）→ 直接引燃该格。
      //    正下方除外：那是火焰的支撑，烧掉它会让火焰立刻失去立足点而自熄。
      if (dy !== -1) {
        const selfChance = FLAMMABLE[this.registry.get(nid).name];
        if (selfChance !== undefined) {
          if (this.rng() < selfChance * FIRE.spreadScale) this.igniteCell(nx, ny, nz);
          continue;
        }
      }

      // 2) 邻格是空气，且下方是实心可燃方块 → 引燃该空气格（地面火横向铺开）。
      //    dy === -1 时该分支不可达：火焰能留在 tracked 里说明正下方是实心支撑，
      //    正下方空气的火焰已在上面支撑判定中熄灭，因此这里不会再遇到 nid === AIR。
      if (nid !== AIR) continue;
      const below = this.world.getBlock(nx, ny - 1, nz);
      if (!this.registry.isSolid(below)) continue;
      const chance = FLAMMABLE[this.registry.get(below).name];
      if (chance === undefined) continue;
      if (this.rng() < chance * FIRE.spreadScale) this.igniteCell(nx, ny, nz);
    }
  }

  /** 把一个已判定为可燃（或空气）的格子变成火焰（不写编辑差分） */
  private igniteCell(x: number, y: number, z: number): void {
    const cur = this.world.getBlock(x, y, z);
    if (cur === this.fireId || cur === this.campfireId) return;
    // setBlock 在 y<1 等非法格返回 false：此时不能入表，也不能发点燃事件
    if (!this.world.setBlock(x, y, z, this.fireId, false)) return;
    this.tracked.set(blockKey(x, y, z), { x, y, z, age: 0, life: this.rollLife() });
    this.events.emit('fire:ignite', { x, y, z });
    if (this.sound && this.crackleTimer <= 0) {
      this.crackleTimer = 0.15;
      this.sound.crackle();
    }
  }

  /** 熄灭火焰（寿命到期 / 失去支撑），营火不会走到这里 */
  private extinguish(x: number, y: number, z: number, cause: 'lifetime' | 'unsupported'): void {
    const key = blockKey(x, y, z);
    if (this.world.getBlock(x, y, z) === this.fireId) {
      this.world.setBlock(x, y, z, AIR, false);
      this.events.emit('fire:extinguish', { x, y, z, cause });
    }
    this.tracked.delete(key);
  }

  /** 玩家 / 实体灼烧伤害节拍 */
  private applyDamage(): void {
    const p = this.playerPos;
    if (p && this.isHeatAt(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))) {
      this.hurtPlayer(FIRE.damage, '火焰');
    }

    const entities = this.getEntities();
    // 清理过期条目，避免生物死亡 / 离场后 Map 无限增长（实体为空时也要做）
    if (this.entityDamageAt.size > 64) {
      for (const [id, at] of this.entityDamageAt) {
        if (at < this.time - 5) this.entityDamageAt.delete(id);
      }
    }
    if (entities.length === 0) return;
    for (const e of entities) {
      const bx = Math.floor(e.pos.x);
      const by = Math.floor(e.pos.y);
      const bz = Math.floor(e.pos.z);
      if (!this.isHeatAt(bx, by, bz)) continue;
      const next = this.entityDamageAt.get(e.id) ?? 0;
      if (this.time < next) continue;
      e.hurt(FIRE.damage, bx, bz);
      this.entityDamageAt.set(e.id, this.time + FIRE.damageInterval);
    }
  }

  private isHeatAt(x: number, y: number, z: number): boolean {
    const id = this.world.getBlock(x, y, z);
    return id !== AIR && isHeatBlock(this.registry.get(id).name);
  }
}
