import * as THREE from 'three';
import type { EventService } from '../services/events';
import type { World } from '../world/world';
import { moveBody, type PhysicsBody } from '../player/physics';
import { buildPig, buildSheep, buildZombie, buildSkeleton, type MobModel } from './models';
import type { DropSpec } from '../world/blocks';
import { rollDrops } from '../world/drops';

/**
 * 实体系统（扩展点：CraftAPI.registerEntity）。
 * 内置猪、羊（随机漫步）与僵尸（夜间敌对）：重力碰撞、腿部动画、受击、掉落。
 */

export interface EntityType {
  id: string;
  label: string;
  width: number;
  height: number;
  speed: number;
  build(): MobModel;
  /** 敌对：发现玩家后追击并攻击 */
  hostile?: boolean;
  /** 生命值，默认 10 */
  health?: number;
  /** 单次攻击伤害，默认 3 */
  damage?: number;
  /** 攻击判定距离，默认 1.8 */
  attackRange?: number;
  /** 白天受到灼烧伤害（僵尸） */
  burnInDay?: boolean;
  /** 死亡掉落 */
  drops?: DropSpec[];
  /** 生成权重，默认 1 */
  weight?: number;
}

export interface EntityContext {
  playerPos: THREE.Vector3;
  /** 对玩家造成伤害，返回是否命中 */
  hurtPlayer(amount: number, cause: string): boolean;
  /** 0~1 日照强度 */
  daylight: number;
  playerDead: boolean;
}

let NEXT_ID = 1;

export class Entity implements PhysicsBody {
  readonly id = NEXT_ID++;
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  width: number;
  height: number;
  onGround = false;
  yaw = Math.random() * Math.PI * 2;
  hp: number;
  readonly maxHp: number;
  hurtCooldown = 0;
  attackCooldown = 0;
  private state: 'idle' | 'walk' = 'idle';
  private timer = 1 + Math.random() * 2;
  private phase = 0;
  readonly model: MobModel;

  constructor(readonly type: EntityType, x: number, y: number, z: number, private events: EventService) {
    this.width = type.width;
    this.height = type.height;
    this.pos.set(x, y, z);
    this.maxHp = type.health ?? 10;
    this.hp = this.maxHp;
    this.model = type.build();
  }

  get dead() {
    return this.hp <= 0;
  }

  get hostile() {
    return !!this.type.hostile;
  }

  /** 受击：扣血 + 轻微击退 */
  hurt(amount: number, fromX?: number, fromZ?: number) {
    if (this.dead) return;
    this.hp = Math.max(0, this.hp - amount);
    this.hurtCooldown = 0.35;
    this.events.emit('entity:hurt', { type: this.type.id, id: this.id, hp: this.hp, maxHp: this.maxHp });
    if (fromX !== undefined && fromZ !== undefined) {
      const dx = this.pos.x - fromX;
      const dz = this.pos.z - fromZ;
      const d = Math.hypot(dx, dz) || 1;
      this.vel.x += (dx / d) * 3.2;
      this.vel.z += (dz / d) * 3.2;
      this.vel.y = Math.max(this.vel.y, 2.6);
    }
    this.model.group.scale.setScalar(1.14);
  }

  update(dt: number, world: World, ctx?: EntityContext) {
    this.hurtCooldown = Math.max(0, this.hurtCooldown - dt);
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    if (this.model.group.scale.x > 1) {
      this.model.group.scale.setScalar(Math.max(1, this.model.group.scale.x - dt * 1.2));
    }

    // 白天灼烧（僵尸）：缓慢掉血
    if (this.type.burnInDay && ctx && ctx.daylight > 0.55) {
      this.hp = Math.max(0, this.hp - dt * 2.2);
    }

    let moving = false;
    let speed = 0;

    if (this.hostile && ctx && !ctx.playerDead) {
      const dx = ctx.playerPos.x - this.pos.x;
      const dz = ctx.playerPos.z - this.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 26) {
        this.yaw = Math.atan2(-dx, -dz);
        moving = true;
        speed = this.type.speed * (dist > 2.2 ? 1.45 : 1.1);
        const dy = Math.abs(ctx.playerPos.y - this.pos.y);
        if (dist < (this.type.attackRange ?? 1.8) && dy < 1.9 && this.attackCooldown <= 0) {
          this.attackCooldown = 1.05;
          ctx.hurtPlayer(this.type.damage ?? 3, `${this.type.label}的攻击`);
          // 攻击前扑
          this.vel.x += (-Math.sin(this.yaw)) * 2.2;
          this.vel.z += (-Math.cos(this.yaw)) * 2.2;
        }
      }
    }

    // 非追击状态：随机漫步
    if (!moving) {
      this.timer -= dt;
      if (this.timer <= 0) {
        if (this.state === 'idle') {
          this.state = 'walk';
          this.yaw = Math.random() * Math.PI * 2;
          this.timer = 2 + Math.random() * 4;
        } else {
          this.state = 'idle';
          this.timer = 1.5 + Math.random() * 3.5;
        }
      }
      moving = this.state === 'walk';
      speed = moving ? this.type.speed : 0;
    }

    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);

    // 前方障碍 / 悬崖 / 水域检测（追击时不绕路，直接贴住）
    if (moving && !this.hostile) {
      const ax = Math.floor(this.pos.x + fx * 0.8);
      const az = Math.floor(this.pos.z + fz * 0.8);
      const ay = Math.floor(this.pos.y);
      const headBlocked = world.isSolidAt(ax, ay, az) || world.isSolidAt(ax, ay + 1, az);
      const noGround = !world.isSolidAt(ax, ay - 1, az) && !world.isSolidAt(ax, ay - 2, az);
      const blockId = world.getBlock(ax, ay, az);
      const water = blockId !== 0 && world.registry.get(blockId).liquid;
      if (headBlocked || noGround || water) {
        this.yaw += Math.PI * (0.5 + Math.random() * 0.8);
        this.timer = Math.min(this.timer, 1.5);
        if (!this.hostile) moving = false;
      }
    }

    const k = 1 - Math.exp(-8 * dt);
    this.vel.x += (fx * speed - this.vel.x) * k;
    this.vel.z += (fz * speed - this.vel.z) * k;

    const inWater = world.registry.get(world.getBlock(
      Math.floor(this.pos.x), Math.floor(this.pos.y + 0.2), Math.floor(this.pos.z))).liquid;
    if (inWater) {
      this.vel.y = 2.2;
    } else {
      this.vel.y -= 24 * dt;
      this.vel.y = Math.max(this.vel.y, -40);
    }

    const res = moveBody(world, this, dt);
    if ((res.hitX || res.hitZ) && this.onGround && moving) {
      // 尝试跳上一格
      const ax = Math.floor(this.pos.x + fx * 0.7);
      const az = Math.floor(this.pos.z + fz * 0.7);
      const ay = Math.floor(this.pos.y);
      if (world.isSolidAt(ax, ay, az) && !world.isSolidAt(ax, ay + 1, az) && !world.isSolidAt(ax, ay + 2, az)) {
        this.vel.y = 7.6;
      }
    }

    if (moving) this.phase += dt * 7;
    this.model.group.position.copy(this.pos);
    this.model.group.rotation.y = this.yaw + Math.PI;
    const animating = moving && (Math.abs(this.vel.x) + Math.abs(this.vel.z)) > 0.2;
    this.model.animate(this.phase, animating);
    // 上下浮动必须叠加在实体位置上，不能由 animate() 直接写绝对坐标
    if (animating) this.model.group.position.y += Math.abs(Math.sin(this.phase)) * 0.02;
  }
}

export class EntityManager {
  readonly entities: Entity[] = [];
  private types = new Map<string, EntityType>();
  private popTimer = 0;
  targetPopulation = 7;
  /** 实验性玩法「生物生成」：false 时不再自动补刷生物（已存在的按距离/日照自然清退） */
  allowSpawn = true;
  /** 掉落回调，由主装配接到生存背包 */
  onDrop: ((name: string, count: number) => void) | null = null;
  /** 世界种子：掉落判定必须可复现 */
  private readonly seed: number;
  /** 最近一次 update / maintainPopulation 的日照，供 nightOnly 掉落使用 */
  private daylight = 1;
  /** 死亡序号：同一实体多次触发也能得到不同来源标识 */
  private killSerial = 0;

  constructor(
    private world: World, private scene: THREE.Scene, private events: EventService, seed = 0,
  ) {
    this.seed = seed;
    this.registerType({
      id: 'pig', label: '猪', width: 0.9, height: 0.95, speed: 1.15, build: buildPig,
      health: 8, drops: [
        { name: 'item:porkchop' }, { name: 'item:fertilizer', chance: 0.12 },
        { name: 'item:leather', chance: 0.5 },
      ],
    });
    this.registerType({
      id: 'sheep', label: '羊', width: 0.9, height: 1.15, speed: 1.0, build: buildSheep,
      health: 8, drops: [
        { name: 'white_wool' }, { name: 'item:fertilizer', chance: 0.12 },
        { name: 'item:leather', chance: 0.3 },
      ],
    });
    this.registerType({
      id: 'zombie', label: '僵尸', width: 0.6, height: 1.9, speed: 1.05, build: buildZombie,
      hostile: true, health: 14, damage: 3, attackRange: 1.7, burnInDay: true,
      drops: [
        { name: 'item:apple', chance: 0.35 },
        { name: 'item:iron_ingot', chance: 0.15 },
        { name: 'item:iron_sword', chance: 0.04 },
      ],
    });
    this.registerType({
      id: 'skeleton', label: '骷髅', width: 0.6, height: 1.9, speed: 1.0, build: buildSkeleton,
      hostile: true, health: 12, damage: 2, attackRange: 1.7, burnInDay: true,
      drops: [{ name: 'item:bone_meal', chance: 0.75 }],
    });
  }

  registerType(type: EntityType) {
    this.types.set(type.id, type);
  }

  getType(id: string) {
    return this.types.get(id);
  }

  spawn(typeId: string, x: number, y: number, z: number): Entity | null {
    const type = this.types.get(typeId);
    if (!type) return null;
    const e = new Entity(type, x, y, z, this.events);
    this.entities.push(e);
    this.scene.add(e.model.group);
    this.events.emit('entity:spawn', { type: typeId, id: e.id });
    return e;
  }

  despawn(e: Entity) {
    const i = this.entities.indexOf(e);
    if (i >= 0) this.entities.splice(i, 1);
    this.scene.remove(e.model.group);
    // 模型材质/几何是每个实例新建的，离场时必须释放，否则反复刷新种群会持续泄漏 GPU 资源
    disposeModel(e.model.group);
    this.events.emit('entity:despawn', { type: e.type.id, id: e.id });
  }

  /** 死亡：发事件 + 掉落 */
  private kill(e: Entity) {
    const dropped = rollDrops(e.type.drops ?? [], {
      seed: this.seed,
      source: `e:${e.id}:${this.killSerial++}`,
      daylight: this.daylight,
    });
    for (const d of dropped) this.onDrop?.(d.name, d.count);
    this.events.emit('entity:dead', { type: e.type.id, id: e.id });
    this.despawn(e);
  }

  /** 在玩家附近的草方块上生成生物 */
  trySpawnNear(playerPos: THREE.Vector3, typeId?: string) {
    if (!this.allowSpawn) return false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = 16 + Math.random() * 22;
      const x = Math.floor(playerPos.x + Math.cos(ang) * dist);
      const z = Math.floor(playerPos.z + Math.sin(ang) * dist);
      const h = this.world.surfaceHeight(x, z);
      const top = this.world.getBlock(x, h, z);
      const above = this.world.getBlock(x, h + 1, z);
      if (this.world.registry.get(top).name === 'grass' && above === 0 && h > 31) {
        const type = typeId ?? (Math.random() < 0.55 ? 'pig' : 'sheep');
        this.spawn(type, x + 0.5, h + 1.05, z + 0.5);
        return true;
      }
    }
    return false;
  }

  update(dt: number, ctx: EntityContext) {
    this.daylight = ctx.daylight;
    for (const e of [...this.entities]) {
      e.update(dt, this.world, ctx);
      if (e.dead) this.kill(e);
    }
  }

  /** 维持种群：夜晚在生存模式额外生成僵尸，白天清退 */
  maintainPopulation(dt: number, playerPos: THREE.Vector3, opts: { survival: boolean; daylight: number }) {
    this.daylight = opts.daylight;
    this.popTimer -= dt;
    if (this.popTimer > 0) return;
    this.popTimer = 2.5;

    const night = opts.daylight < 0.35;
    const zombies = this.entities.filter((e) => e.type.hostile).length;
    for (const e of [...this.entities]) {
      const d = e.pos.distanceTo(playerPos);
      if (d > 88) this.despawn(e);
      else if (e.type.hostile && opts.daylight > 0.7 && d > 24) this.despawn(e);
    }

    const target = opts.survival && night ? 9 : 6;
    if (this.entities.length < target) {
      const wantHostile = opts.survival && night && zombies < 4 && Math.random() < 0.6;
      const hostileType = wantHostile ? (Math.random() < 0.5 ? 'skeleton' : 'zombie') : undefined;
      this.trySpawnNear(playerPos, hostileType);
    }
  }

  /** 视线内最近的生物（玩家攻击判定） */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): { entity: Entity; dist: number } | null {
    let best: { entity: Entity; dist: number } | null = null;
    for (const e of this.entities) {
      const t = rayBox(origin, dir, e.pos, e.width / 2, e.height, maxDist);
      if (t !== null && (!best || t < best.dist)) best = { entity: e, dist: t };
    }
    return best;
  }
}

/** 射线与竖直 AABB 求交（脚底为原点），返回进入距离 */
function rayBox(origin: THREE.Vector3, dir: THREE.Vector3, feet: THREE.Vector3, half: number, height: number, maxDist: number): number | null {
  const minX = feet.x - half, maxX = feet.x + half;
  const minY = feet.y, maxY = feet.y + height;
  const minZ = feet.z - half, maxZ = feet.z + half;
  let tmin = 0;
  let tmax = maxDist;
  const axes: [number, number, number, number][] = [
    [origin.x, dir.x, minX, maxX],
    [origin.y, dir.y, minY, maxY],
    [origin.z, dir.z, minZ, maxZ],
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-8) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}

/**
 * 释放一个实体模型的 GPU 资源。
 * 模型在 build() 时为每个实例新建 BoxGeometry / MeshLambertMaterial（部分带 CanvasTexture），
 * 且 eyeL.clone() 这类复例会共享同一份 geometry / material，因此先去重再 dispose。
 */
function disposeModel(root: THREE.Object3D): void {
  const geos = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!(mesh as unknown as { isMesh?: boolean }).isMesh) return;
    if (mesh.geometry) geos.add(mesh.geometry);
    const m = mesh.material;
    if (Array.isArray(m)) for (const one of m) mats.add(one);
    else if (m) mats.add(m);
  });
  for (const g of geos) g.dispose();
  for (const m of mats) {
    const map = (m as THREE.MeshLambertMaterial).map;
    if (map) map.dispose();
    m.dispose();
  }
}
