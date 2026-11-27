import * as THREE from 'three';
import type { EventService } from '../services/events';
import type { World } from '../world/world';
import { moveBody, type PhysicsBody } from '../player/physics';
import {
  buildPig, buildSheep, buildCow, buildChicken, buildRabbit,
  buildZombie, buildSkeleton, buildCreeper, buildSpider, buildSquid, type MobModel,
} from './models';
import type { DropSpec } from '../world/blocks';
import type { Particles } from '../gfx/particles';
import { dropHash, rollDrops } from '../world/drops';
import { ANIMALS, BREED, NEW_MOBS, POPULATION } from '../core/tuning';
import { canBreed, isBreedFood, pickMate } from './breeding';
import type { AIService } from '../ai/AIService';
import { BALL, bounceVy, rollFriction } from './basketball';

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
  /** 物理分流：省略为现有漫步行为；'bounce' 为篮球弹跳体（无 AI） */
  physics?: 'bounce';
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
  /** 水中悬浮生物（鱿鱼）：入水时悬停而非上浮，且不被“水域阻挡”逻辑调头 */
  aquatic?: boolean;
  /** 攻击时自爆（苦力怕）：数值为破坏 / 伤害半径 */
  explodeRadius?: number;
}

export interface EntityContext {
  playerPos: THREE.Vector3;
  /** 对玩家造成伤害，返回是否命中 */
  hurtPlayer(amount: number, cause: string, kind?: 'attack'): boolean;
  /** 0~1 日照强度 */
  daylight: number;
  playerDead: boolean;
  /** 自爆生物触发的爆炸回调（由主装配注入；缺省时退化为普通近战） */
  explode?: (x: number, y: number, z: number, radius: number) => void;
  /** 是否处于游玩态：默认 true；暂停 / 标题时繁殖计时不推进 */
  playing?: boolean;
}

let NEXT_ID = 1;

/** 球面滚动轴：模块级复用 Vector3，避免每帧分配 */
const ROLL_AXIS = new THREE.Vector3();

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
  /** 出生后秒数；成体初始化为 growTime，幼崽出生时为 0 */
  age: number = BREED.growTime;
  /** 求爱窗口剩余秒数（喂食后为 loveDuration） */
  loveTimer = 0;
  /** 繁殖冷却剩余秒数 */
  cooldown = 0;
  /** 受击闪光剩余秒数：目标缩放 = 体型基准 × 1.14 */
  private hurtFlash = 0;
  /** 拾取冷却：spawn 后延迟，防「刚投出即被捡回」 */
  pickupCooldown = 0;
  private state: 'idle' | 'walk' = 'idle';
  private timer = 1 + Math.random() * 2;
  private phase = 0;
  /** AI 运行时组件（行为树 + 黑板），由 AIService.attach 设置 */
  aiComponent?: import('../ai/AIComponent').AIComponent;
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

  /** 幼崽：age 未达 growTime，不能繁殖，整体缩小显示 */
  get baby() {
    return this.age < BREED.growTime;
  }

  /** 当前体型基准：幼崽是 babyScale，成体是 1 */
  private get scaleBase() {
    return this.baby ? BREED.babyScale : 1;
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
    // 闪光目标按体型基准缩放：写死 1 会让幼崽挨一下就长成成体尺寸
    this.hurtFlash = this.hurtCooldown;
    this.model.group.scale.setScalar(this.scaleBase * 1.14);
  }

  /**
   * 一次近战 / 自爆结算（AI 与硬编码追击两条路径共用）。
   * 苦力怕自爆后立即死亡进入掉落流程；其余生物走普通伤害 + 前扑。
   */
  private strike(ctx: EntityContext): void {
    if (this.attackCooldown > 0) return;
    this.attackCooldown = 1.05;
    if (this.type.explodeRadius && ctx.explode) {
      ctx.explode(this.pos.x, this.pos.y + this.height * 0.5, this.pos.z, this.type.explodeRadius);
      this.hp = 0;
      return;
    }
    ctx.hurtPlayer(this.type.damage ?? 3, `${this.type.label}的攻击`);
    this.vel.x += (-Math.sin(this.yaw)) * 2.2;
    this.vel.z += (-Math.cos(this.yaw)) * 2.2;
  }

  update(dt: number, world: World, ctx?: EntityContext) {
    this.hurtCooldown = Math.max(0, this.hurtCooldown - dt);
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    // 繁殖计时只在游玩态推进（标题 / 暂停时 ctx.playing === false）
    if (ctx?.playing !== false) {
      this.age += dt;
      this.loveTimer = Math.max(0, this.loveTimer - dt);
      this.cooldown = Math.max(0, this.cooldown - dt);
    }
    // 受击闪光的目标必须按体型基准缩放：写死 1 会让幼崽挨一下就变大。
    // 先推进 age 再算目标，成长跨过 growTime 的这一帧缩放就会跟上去。
    const scaleTarget = this.scaleBase * (this.hurtFlash > 0 ? 1.14 : 1);
    const scaleNow = this.model.group.scale.x;
    if (Math.abs(scaleNow - scaleTarget) > 1e-4) {
      const diff = scaleTarget - scaleNow;
      const step = Math.sign(diff) * Math.min(Math.abs(diff), dt * 1.2);
      this.model.group.scale.setScalar(scaleNow + step);
    }

    // 篮球：绕过漫步 AI / 攻击 / 灼烧，直接走弹跳物理分支（既有 walk 实体零改动）
    if (this.type.physics === 'bounce') {
      this.updateBounce(dt, world);
      return;
    }

    // 白天灼烧（僵尸）：缓慢掉血
    if (this.type.burnInDay && ctx && ctx.daylight > 0.55) {
      this.hp = Math.max(0, this.hp - dt * 2.2);
    }

    let moving = false;
    let speed = 0;

    const ai = this.aiComponent;
    if (ai && ai.enabled) {
      // AI 行为树已在 AIService.update 中 tick，黑板已写入决策
      moving = ai.blackboard.get<boolean>('moving') === true;
      speed = ai.blackboard.get<number>('moveSpeed') ?? 0;
      const yaw = ai.blackboard.get<number>('moveYaw');
      if (typeof yaw === 'number') this.yaw = yaw;
      if (ai.blackboard.get<boolean>('wantAttack') === true && ctx && !ctx.playerDead) {
        const dy = Math.abs(ctx.playerPos.y - this.pos.y);
        const dist = Math.hypot(ctx.playerPos.x - this.pos.x, ctx.playerPos.z - this.pos.z);
        if (dist < (this.type.attackRange ?? 1.8) && dy < 1.9 && this.attackCooldown <= 0) {
          this.attackCooldown = 1.05;
          ctx.hurtPlayer(this.type.damage ?? 3, `${this.type.label}的攻击`, 'attack');
          this.vel.x += (-Math.sin(this.yaw)) * 2.2;
          this.vel.z += (-Math.cos(this.yaw)) * 2.2;
        }
        ai.blackboard.set('wantAttack', false);
      }
    } else {
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
            ctx.hurtPlayer(this.type.damage ?? 3, `${this.type.label}的攻击`, 'attack');
            // 攻击前扑
            this.vel.x += (-Math.sin(this.yaw)) * 2.2;
            this.vel.z += (-Math.cos(this.yaw)) * 2.2;
          }
        }
      }
    }

    // 非追击状态：随机漫步（仅在无 AI 组件时使用硬编码逻辑）
    if (!this.aiComponent && !moving) {
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
    if (moving && !this.hostile && !this.type.aquatic) {
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
      // 水生生物悬浮在水中，而不是像误入水的陆生生物一样上浮
      this.vel.y = this.type.aquatic ? 0 : 2.2;
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

  /**
   * 篮球专用物理分支：无漫步 AI，只有重力 / 弹跳 / 滚动 / 冷却。
   * 核心时序：反弹必须用 moveBody 之前的入射速度（moveBody 会把撞地轴 vel.y 归零）。
   */
  private updateBounce(dt: number, world: World): void {
    const prevX = this.pos.x;
    const prevZ = this.pos.z;
    this.pickupCooldown = Math.max(0, this.pickupCooldown - dt);

    // (1) 记录撞地前入射竖直速度 —— 全方法最关键的一行
    const impactVy = this.vel.y;
    const wasGround = this.onGround;

    // (2) 重力 / 水中阻尼上浮 + 水平滚动摩擦（均在 moveBody 之前）
    const inWater = world.registry.get(world.getBlock(
      Math.floor(this.pos.x), Math.floor(this.pos.y + 0.2), Math.floor(this.pos.z))).liquid;
    if (inWater) {
      this.vel.y = Math.min(this.vel.y + 8 * dt, 2.2);
      this.vel.x *= 0.6;
      this.vel.z *= 0.6;
    } else {
      this.vel.y = Math.max(this.vel.y - BALL.GRAVITY * dt, -BALL.TERMINAL);
    }
    this.vel.x = rollFriction(this.vel.x, dt);
    this.vel.z = rollFriction(this.vel.z, dt);

    // (3) moveBody 逐轴碰撞：会把撞地 / 撞墙 / 撞头轴的 vel 归零
    const hitXIn = this.vel.x;
    const hitZIn = this.vel.z;
    const res = moveBody(world, this, dt);

    // (4) 反弹：用 (1) 的 impactVy，不能用已被归零的 this.vel.y。
    // landed 仅在 vel.y < -8 时置位，衰减后的小弹跳靠 (!wasGround && onGround) 兜底。
    const justLanded = (!wasGround && this.onGround) || res.landed;
    if (justLanded && impactVy < 0) {
      const vy = bounceVy(impactVy);
      this.vel.y = vy; // 0 = 静止；>0 = 弹起
      this.vel.x *= 0.92;
      this.vel.z *= 0.92;
      if (vy > 0) {
        this.events.emit('basketball:bounce', {
          id: this.id, x: this.pos.x, y: this.pos.y, z: this.pos.z, strength: Math.abs(impactVy),
        });
      }
    }
    // 撞墙轻微反弹：moveBody 已归零该轴，这里用入射值补回一点
    if (res.hitX) this.vel.x = -hitXIn * BALL.WALL_RESTITUTION;
    if (res.hitZ) this.vel.z = -hitZIn * BALL.WALL_RESTITUTION;

    // (5) 球面按本帧实际位移滚动：轴 (dz,0,-dx) 保证向前滚而非反向滑
    const dx = this.pos.x - prevX;
    const dz = this.pos.z - prevZ;
    const dist = Math.hypot(dx, dz);
    if (dist > 1e-5) {
      ROLL_AXIS.set(dz, 0, -dx).normalize();
      this.model.group.rotateOnWorldAxis(ROLL_AXIS, dist / BALL.RADIUS);
    }

    // (6) 同步模型：pos 是脚底，球心需上移一个半径
    this.model.group.position.copy(this.pos);
    this.model.group.position.y += BALL.RADIUS;
  }
}

export class EntityManager {
  readonly entities: Entity[] = [];
  private types = new Map<string, EntityType>();
  private popTimer = 0;
  targetPopulation = 7;
  /** 实验性玩法「生物生成」：false 时不再自动补刷生物（已存在的按距离/日照自然清退） */
  allowSpawn = true;
  /** 掉落回调，由主装配接到可见掉落物管理器（带死亡坐标与来源串） */
  onDrop: ((name: string, count: number, x: number, y: number, z: number, source: string) => void) | null = null;
  /** 世界种子：掉落判定必须可复现 */
  private readonly seed: number;
  /** 最近一次 update / maintainPopulation 的日照，供 nightOnly 掉落使用 */
  private daylight = 1;
  /** 死亡序号：同一实体多次触发也能得到不同来源标识 */
  private killSerial = 0;
  /** 自然生成序号：加权类型抽取的确定性来源标识（typeId 覆盖时不递增） */
  private spawnSerial = 0;
  /** 求爱心形粒子的节流计时，避免每帧刷屏 */
  private heartTimer = 0;
  /** AI 服务：spawn/attach，despawn/detach */
  private aiService: AIService | null = null;

  constructor(
    private world: World, private scene: THREE.Scene, private events: EventService, seed = 0,
    private particles?: Particles,
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
    // 三种新被动动物：数值与掉落取自 tuning.ts 的 ANIMALS，掉落名一律 item: 前缀
    const cow = ANIMALS.cow;
    this.registerType({
      id: 'cow', label: '牛', width: cow.width, height: cow.height, speed: cow.speed,
      build: buildCow, health: cow.health, weight: cow.weight, drops: cow.drops,
    });
    const chicken = ANIMALS.chicken;
    this.registerType({
      id: 'chicken', label: '鸡', width: chicken.width, height: chicken.height, speed: chicken.speed,
      build: buildChicken, health: chicken.health, weight: chicken.weight, drops: chicken.drops,
    });
    const rabbit = ANIMALS.rabbit;
    this.registerType({
      id: 'rabbit', label: '兔', width: rabbit.width, height: rabbit.height, speed: rabbit.speed,
      build: buildRabbit, health: rabbit.health, weight: rabbit.weight, drops: rabbit.drops,
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
    // ---- 内容更新：三种新生物（数值来自 tuning.ts 的 NEW_MOBS） ----
    const creeper = NEW_MOBS.creeper;
    this.registerType({
      id: 'creeper', label: '苦力怕', width: creeper.width, height: creeper.height,
      speed: creeper.speed, build: buildCreeper,
      hostile: true, health: creeper.health, damage: creeper.damage, attackRange: creeper.attackRange,
      burnInDay: creeper.burnInDay, explodeRadius: creeper.explodeRadius,
      drops: creeper.drops.map((d) => ({ ...d })),
    });
    const spider = NEW_MOBS.spider;
    this.registerType({
      id: 'spider', label: '蜘蛛', width: spider.width, height: spider.height,
      speed: spider.speed, build: buildSpider,
      hostile: true, health: spider.health, damage: spider.damage, attackRange: spider.attackRange,
      burnInDay: spider.burnInDay,
      drops: spider.drops.map((d) => ({ ...d })),
    });
    const squid = NEW_MOBS.squid;
    this.registerType({
      id: 'squid', label: '鱿鱼', width: squid.width, height: squid.height,
      speed: squid.speed, build: buildSquid,
      health: squid.health, aquatic: squid.aquatic,
      drops: squid.drops.map((d) => ({ ...d })),
    });
  }

  registerType(type: EntityType) {
    this.types.set(type.id, type);
  }

  getType(id: string) {
    return this.types.get(id);
  }

  setAIService(ai: AIService | null): void {
    this.aiService = ai;
  }

  spawn(typeId: string, x: number, y: number, z: number): Entity | null {
    const type = this.types.get(typeId);
    if (!type) return null;
    const e = new Entity(type, x, y, z, this.events);
    this.entities.push(e);
    this.scene.add(e.model.group);
    this.aiService?.attach(e, typeId);
    this.events.emit('entity:spawn', { type: typeId, id: e.id });
    return e;
  }

  despawn(e: Entity) {
    const i = this.entities.indexOf(e);
    if (i >= 0) this.entities.splice(i, 1);
    this.aiService?.detach?.(e as any);
    this.scene.remove(e.model.group);
    // 模型材质/几何是每个实例新建的，离场时必须释放，否则反复刷新种群会持续泄漏 GPU 资源
    disposeModel(e.model.group);
    this.events.emit('entity:despawn', { type: e.type.id, id: e.id });
  }

  /** 死亡：发事件 + 掉落 */
  private kill(e: Entity) {
    // 同一个来源串同时驱动掉落判定与散开，保证同种子同序列可复现
    const source = `e:${e.id}:${this.killSerial++}`;
    const dropped = rollDrops(e.type.drops ?? [], {
      seed: this.seed,
      source,
      daylight: this.daylight,
    });
    for (const d of dropped) {
      this.onDrop?.(d.name, d.count, e.pos.x, e.pos.y, e.pos.z, source);
    }
    this.events.emit('entity:dead', { type: e.type.id, id: e.id });
    this.despawn(e);
  }

  /**
   * 被动动物加权抽取：来源标识来自 spawnSerial，与坐标 / 游荡的 Math.random() 解耦，
   * 同 seed + 同调用序列必然抽到同一类型。typeId 覆盖时本方法不会被调用，序号也不递增。
   */
  private pickPassiveType(): string {
    const table = Object.entries(ANIMALS) as [string, { weight?: number }][];
    const total = table.reduce((sum, [, a]) => sum + (a.weight ?? 1), 0);
    let r = (dropHash(this.seed, 'spawn:' + this.spawnSerial++, 0) / 4294967296) * total;
    for (const [id, a] of table) {
      r -= a.weight ?? 1;
      if (r < 0) return id;
    }
    return table[table.length - 1][0];
  }

  /** 在玩家附近的草方块上生成生物 */
  trySpawnNear(playerPos: THREE.Vector3, typeId?: string) {
    if (!this.allowSpawn) return false;
    if (this.entities.length >= POPULATION.cap) return false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = 16 + Math.random() * 22;
      const x = Math.floor(playerPos.x + Math.cos(ang) * dist);
      const z = Math.floor(playerPos.z + Math.sin(ang) * dist);
      const h = this.world.surfaceHeight(x, z);
      const top = this.world.getBlock(x, h, z);
      const above = this.world.getBlock(x, h + 1, z);
      if (this.world.registry.get(top).name === 'grass' && above === 0 && h > 31) {
        const type = typeId ?? this.pickPassiveType();
        this.spawn(type, x + 0.5, h + 1.05, z + 0.5);
        return true;
      }
    }
    return false;
  }

  /** 右键喂食：命中繁殖食物、成体且冷却结束时进入求爱窗口；其余情况静默失败 */
  feed(e: Entity, material: string): boolean {
    if (e.hostile || e.baby || e.cooldown > 0 || !isBreedFood(e.type.id, material)) return false;
    e.loveTimer = BREED.loveDuration;
    return true;
  }

  /** 幼崽落点：优先双亲中点，非法则退回父方附近一格（复用 trySpawnNear 的草地判定） */
  private spawnBaby(a: Entity, b: Entity): boolean {
    const spots: [number, number][] = [
      [Math.floor((a.pos.x + b.pos.x) / 2), Math.floor((a.pos.z + b.pos.z) / 2)],
      [Math.floor(a.pos.x) + 1, Math.floor(a.pos.z)],
      [Math.floor(a.pos.x) - 1, Math.floor(a.pos.z)],
      [Math.floor(a.pos.x), Math.floor(a.pos.z) + 1],
      [Math.floor(a.pos.x), Math.floor(a.pos.z) - 1],
    ];
    for (const [x, z] of spots) {
      const h = this.world.surfaceHeight(x, z);
      const top = this.world.getBlock(x, h, z);
      const above = this.world.getBlock(x, h + 1, z);
      if (this.world.registry.get(top).name !== 'grass' || above !== 0 || h <= 31) continue;
      const baby = this.spawn(a.type.id, x + 0.5, h + 1.05, z + 0.5);
      if (!baby) return false;
      baby.age = 0;
      baby.model.group.scale.setScalar(BREED.babyScale);
      return true;
    }
    return false;
  }

  /** 繁殖 tick：求爱双方靠近即生成幼崽并进入冷却；满员与非法落点静默跳过 */
  private updateBreeding(dt: number, playing: boolean) {
    if (!playing) return;
    this.heartTimer -= dt;
    const courting = this.entities.filter((e) => e.loveTimer > 0 && !e.baby && !e.hostile);
    if (courting.length && this.heartTimer <= 0) {
      this.heartTimer = 0.9;
      for (const e of courting) {
        this.particles?.burst(e.pos.x, e.pos.y + e.height + 0.45, e.pos.z, [1, 0.45, 0.72], 3, 0.22, 0.9);
      }
    }
    for (const a of courting) {
      if (a.loveTimer <= 0 || a.cooldown > 0) continue;
      const mate = pickMate(a, this.entities, BREED.mateRadius);
      if (!mate || !canBreed(a, mate)) continue;
      if (this.entities.length >= POPULATION.cap) return; // 全局上限：静默拒绝
      if (!this.spawnBaby(a, mate)) continue;
      a.cooldown = mate.cooldown = BREED.cooldown;
      a.loveTimer = mate.loveTimer = 0;
    }
  }

  update(dt: number, ctx: EntityContext) {
    this.daylight = ctx.daylight;
    for (const e of [...this.entities]) {
      e.update(dt, this.world, ctx);
      if (e.dead) this.kill(e);
    }
    this.updateBreeding(dt, ctx.playing !== false);
  }

  /**
   * 在近岸水体生成鱿鱼（内容更新）。脚底落在水面下的水格中，
   * 数量上限 2，避免把水生生物刷满整片海。
   */
  private trySpawnSquid(playerPos: THREE.Vector3): boolean {
    if (!this.allowSpawn || this.entities.length >= POPULATION.cap) return false;
    if (this.entities.filter((e) => e.type.id === 'squid').length >= 2) return false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = 10 + Math.random() * 18;
      const x = Math.floor(playerPos.x + Math.cos(ang) * dist);
      const z = Math.floor(playerPos.z + Math.sin(ang) * dist);
      const h = this.world.surfaceHeight(x, z);
      const isWater = (id: number) => id !== 0 && this.world.registry.get(id).liquid;
      if (isWater(this.world.getBlock(x, h + 1, z)) && isWater(this.world.getBlock(x, h + 2, z))) {
        this.spawn('squid', x + 0.5, h + 1.5, z + 0.5);
        return true;
      }
    }
    return false;
  }

  /** 维持种群：夜晚在生存模式额外生成敌对生物，白天清退 */
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
      // 敌对池扩充为四种：僵尸 / 骷髅 / 苦力怕 / 蜘蛛
      const hostilePool = ['zombie', 'skeleton', 'creeper', 'spider'];
      const hostileType = wantHostile ? hostilePool[(Math.random() * hostilePool.length) | 0] : undefined;
      this.trySpawnNear(playerPos, hostileType);
      if (!hostileType && Math.random() < 0.3) this.trySpawnSquid(playerPos);
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
