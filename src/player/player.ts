import * as THREE from 'three';
import { clamp, lerp, SEA_LEVEL, WORLD_HEIGHT, type BlockId, type System } from '../core/types';
import type { EventService } from '../services/events';
import { AIR, type BlockDefinition, type BlockRegistry } from '../world/blocks';
import type { World, RayHit } from '../world/world';
import type { TextureAtlas } from '../gfx/atlas';
import type { Input } from '../input/input';
import { moveBody, boxIntersectsBlock, type PhysicsBody } from './physics';
import { isStuck, resolvePenetration, type SolidPredicate } from './unstuck';
import { PlayerModel } from '../entity/models';
import type { SoundEngine } from '../audio/sound';
import type { Particles } from '../gfx/particles';
import type { EntityManager, Entity } from '../entity/entity';
import { ITEMS, MAX_HUNGER, type Stack, type SurvivalState } from './survival';
import type { Botany } from '../world/botany';

/** 快捷栏一格：方块或物品（生存模式会带数量） */
export interface HotbarState {
  slots: (Stack | null)[];
  index: number;
}

export interface MiningState {
  progress: number;
  block: BlockDefinition;
}

const EYE = 1.62;
const SNEAK_EYE = 1.5;
const GRAVITY = 27;
const JUMP_VEL = 8.4;
const REACH = 6;
const ENTITY_REACH = 4.2;

/**
 * 玩家控制器：物理、第一/第三人称相机、挖掘/放置/进食/攻击、手持物品动画。
 * 创造模式与生存模式的差异集中在挖掘计时、掉落入包与飞行限制。
 */
export class Player implements System, PhysicsBody {
  readonly name = 'player';
  pos = new THREE.Vector3(0, 40, 0);
  vel = new THREE.Vector3();
  width = 0.6;
  height = 1.8;
  onGround = false;
  yaw = 0;
  pitch = 0;
  fly = false;
  cameraMode = 0; // 0 第一人称 1 第三人称背面 2 第三人称正面
  sneaking = false;
  sprinting = false;
  inWater = false;
  eyeInWater = false;
  autoJump: boolean;
  /** 设置页「视角摇晃」：走路摆动与受击 / 爆炸抖动 */
  viewBob = true;
  target: RayHit | null = null;
  entityTarget: { entity: Entity; dist: number } | null = null;
  readonly model: PlayerModel;
  readonly heldMaterial: THREE.MeshBasicMaterial;

  /** 当前挖掘进度（0~1），null 表示未在挖掘 */
  miningProgress: number | null = null;
  miningBlock: BlockDefinition | null = null;

  private heldGroup = new THREE.Group();
  private heldMesh: THREE.Mesh | null = null;
  private heldStackKey = '';
  private bobPhase = 0;
  private stepAcc = 0;
  private swingT = 1;
  private breakTimer = 0;
  private placeTimer = 0;
  private attackTimer = 0;
  private mineKey = '';
  private mineTime = 0.2;
  private mineSoundAcc = 0;
  private mineIdle = 0;
  private fallVy = 0;
  private wasGround = false;
  private shakeAmp = 0;
  private shakeT = 0;
  private moveEmitAcc = 0;
  private lastEmitX = 0;
  private lastEmitY = 0;
  private lastEmitZ = 0;
  private eatTimer = 0;
  private botany: Botany | null = null;
  private tmpDir = new THREE.Vector3();
  private tmpEye = new THREE.Vector3();
  private tmpV = new THREE.Vector3();

  // ---- AABB 脱困（被方块挤住时平滑推出） ----
  unstuckCount = 0;
  private stuckTarget: {
    fx: number; fy: number; fz: number; tx: number; ty: number; tz: number;
    t: number; dur: number; dist: number;
  } | null = null;
  private readonly solidPredicate: SolidPredicate = (x, y, z) =>
    this.registry.isSolid(this.world.getBlock(x, y, z));

  constructor(
    private world: World,
    private camera: THREE.PerspectiveCamera,
    private input: Input,
    private registry: BlockRegistry,
    private atlas: TextureAtlas,
    private events: EventService,
    private sound: SoundEngine,
    private particles: Particles,
    private survival: SurvivalState,
    readonly hotbar: HotbarState,
    private entities: EntityManager,
    scene: THREE.Scene,
    isMobile: boolean,
  ) {
    this.autoJump = isMobile;
    this.model = new PlayerModel();
    this.model.group.visible = false;
    scene.add(this.model.group);

    this.heldMaterial = new THREE.MeshBasicMaterial({ map: atlas.texture, vertexColors: true, alphaTest: 0.5 });
    camera.add(this.heldGroup);
    this.heldGroup.visible = false;
    this.heldGroup.position.set(0.44, -0.42, -0.66);
    this.heldGroup.rotation.set(0.12, -0.4, 0.06);
    this.setHeldStack(this.hotbar.slots[this.hotbar.index]);
  }

  // ---------- 快捷栏 ----------

  selectedStack(): Stack | null {
    return this.hotbar.slots[this.hotbar.index] ?? null;
  }

  selectedBlock(): BlockDefinition {
    const s = this.selectedStack();
    return s && s.kind === 'block' ? this.registry.get(s.id as BlockId) : this.registry.air;
  }

  selectedItem() {
    const s = this.selectedStack();
    return s && s.kind === 'item' ? ITEMS[s.id as string] ?? null : null;
  }

  setHeldStack(stack: Stack | null) {
    const key = stack ? `${stack.kind}:${stack.id}` : '';
    if (key === this.heldStackKey) return;
    this.heldStackKey = key;
    if (this.heldMesh) {
      this.heldGroup.remove(this.heldMesh);
      this.heldMesh.geometry.dispose();
      this.heldMesh = null;
    }
    if (!stack) return;
    if (stack.kind === 'block') {
      const def = this.registry.get(stack.id as BlockId);
      this.heldMesh = new THREE.Mesh(this.atlas.makeBlockGeometry(def), this.heldMaterial);
      this.heldMesh.scale.setScalar(def.shape === 'cross' ? 0.34 : 0.30);
    } else {
      const item = ITEMS[stack.id as string];
      if (!item) return;
      this.heldMesh = new THREE.Mesh(this.atlas.makeItemGeometry(item.tile), this.heldMaterial);
      this.heldMesh.scale.setScalar(0.34);
      this.heldMesh.position.set(0.02, 0.06, 0);
      this.heldMesh.rotation.set(0, 0, -0.18);
    }
    this.heldGroup.add(this.heldMesh);
  }

  // ---------- 出生 / 基础 ----------

  /** 寻找一块陆地出生：优先露天，避免一睁眼就被树冠糊脸 */
  spawn() {
    const place = (x: number, h: number, z: number) => {
      this.pos.set(x + 0.5, h + 1.02, z + 0.5);
      this.vel.set(0, 0, 0);
      this.resetFallDistance();
      this.survival.spawn = { x: x + 0.5, y: h + 1.02, z: z + 0.5 };
      this.events.emit('player:spawn', { position: { x: this.pos.x, y: this.pos.y, z: this.pos.z } });
    };
    for (const preferOpenSky of [true, false]) {
      for (let r = 0; r < 40; r += 4) {
        for (let a = 0; a < 8; a++) {
          const x = Math.round(Math.cos(a * Math.PI / 4) * r);
          const z = Math.round(Math.sin(a * Math.PI / 4) * r);
          // 用生成器地形高度，避免把树冠/草丛误判为地面；花草非实心，可以站进去
          const h = this.world.generator.surfaceHeight(x, z);
          const top = this.world.getBlock(x, h, z);
          const above = this.world.getBlock(x, h + 1, z);
          const above2 = this.world.getBlock(x, h + 2, z);
          const clear = (id: number) => !this.registry.isSolid(id);
          if (h <= SEA_LEVEL || !this.registry.isSolid(top) || !clear(above) || !clear(above2)) continue;
          // 第一轮只接受正上方能看到天空、且不是沙滩/沙漠/海洋的位置
          if (preferOpenSky) {
            if (this.world.getSkyLight(x, h + 1, z) < 15) continue;
            const biome = this.world.generator.biomeAt?.(x, z);
            if (biome === 'beach' || biome === 'desert' || biome === 'ocean') continue;
          }
          place(x, h, z);
          return;
        }
      }
    }
    place(0, this.world.generator.surfaceHeight(0, 0), 0);
  }

  eyePosition(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.pos.x, this.pos.y + (this.sneaking ? SNEAK_EYE : EYE), this.pos.z);
  }

  viewDirection(out: THREE.Vector3): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  swing() {
    this.swingT = 0;
  }

  shake(amp: number) {
    if (!this.viewBob) return;
    this.shakeAmp = Math.max(this.shakeAmp, amp);
    this.shakeT = 0.4;
  }

  toggleFly(): boolean {
    if (this.survival.isSurvival) return false;
    this.fly = !this.fly;
    if (this.fly) this.vel.y = 0;
    // 飞行状态下落的竖直速度不计入摔落伤害
    this.fallVy = 0;
    this.sound.click(this.fly ? 880 : 520);
    return true;
  }

  cycleCamera() {
    this.cameraMode = (this.cameraMode + 1) % 3;
    this.events.emit('player:camera', { mode: this.cameraMode });
  }

  teleport(x: number, y: number, z: number) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.resetFallDistance();
    this.stuckTarget = null;
  }

  /** 当前 AABB 是否与真实实心方块相交（未生成区块视为空气） */
  get isStuck(): boolean {
    return isStuck(this.pos, this.width, this.height, this.solidPredicate);
  }
  /** 是否正在执行脱困缓动 */
  get isUnstucking(): boolean { return this.stuckTarget !== null; }

  /** 传送 / 入水 / 切模式后必须清零，否则旧下落速度会在下一次落地时结算伤害 */
  resetFallDistance() {
    this.fallVy = 0;
  }

  get fallDistance(): number {
    return this.fallVy;
  }

  // ---------- 主循环 ----------

  /**
   * AABB 脱困：被实体方块包围时平滑推出。moveBody 只能阻止穿入、无法把已嵌入的身体推出，
   * 这里检测到相交后用最小贯穿量搜索出最近脱离点，并以 ≤0.4s 缓动把玩家推过去，
   * 完成后清速度、置空中、计数并派发 player:unstuck。
   */
  private stepUnstuck(dt: number): boolean {
    if (this.stuckTarget) {
      const s = this.stuckTarget;
      s.t += dt;
      const k = Math.min(1, s.t / s.dur);
      const ease = k * k * (3 - 2 * k);
      this.pos.set(lerp(s.fx, s.tx, ease), lerp(s.fy, s.ty, ease), lerp(s.fz, s.tz, ease));
      if (k >= 1) {
        this.stuckTarget = null;
        this.vel.set(0, 0, 0);
        this.onGround = false;
        this.unstuckCount++;
        this.events.emit('player:unstuck', {
          position: { x: this.pos.x, y: this.pos.y, z: this.pos.z }, distance: s.dist,
        });
      }
      return true;
    }
    if (!this.isStuck) return false;
    const r = resolvePenetration(this.pos, this.width, this.height, this.solidPredicate);
    if (!r.moved || !r.resolved) return false;
    const dist = Math.hypot(r.dx, r.dy, r.dz);
    this.stuckTarget = {
      fx: this.pos.x, fy: this.pos.y, fz: this.pos.z, tx: r.x, ty: r.y, tz: r.z,
      t: 0, dur: Math.min(0.4, 0.12 + dist * 0.02), dist,
    };
    this.vel.set(0, 0, 0);
    return true;
  }

  update(dt: number) {
    if (this.survival.dead) return;
    // AABB 脱困优先于常规物理：被方块挤住时先平滑推出，避免 moveBody 反复钳制卡死
    if (this.stepUnstuck(dt)) {
      this.updateCamera(dt, 0);
      return;
    }
    const input = this.input;
    const [dx, dy] = input.consumeLook();
    this.yaw -= dx * 0.0022;
    this.pitch = clamp(this.pitch - dy * 0.0022, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);

    this.sneaking = input.sneak && !this.fly;
    this.sprinting = input.sprint && input.moveZ > 0.1 && !this.sneaking &&
      (!this.survival.isSurvival || this.survival.hunger > 6);

    const feetDef = this.registry.get(this.world.getBlock(
      Math.floor(this.pos.x), Math.floor(this.pos.y + 0.3), Math.floor(this.pos.z)));
    const eyeDef = this.registry.get(this.world.getBlock(
      Math.floor(this.pos.x), Math.floor(this.pos.y + EYE), Math.floor(this.pos.z)));
    // 海草 / 海带占据水格，玩家穿过时仍要按入水处理（浮力、氧气、水下雾）
    this.inWater = feetDef.liquid || feetDef.waterPlant === true;
    this.eyeInWater = eyeDef.liquid || eyeDef.waterPlant === true;
    // 入水即视为安全落地：否则高台跳水后游上岸，旧 fallVy 会在岸边结算伤害
    if (this.inWater) this.fallVy = 0;

    // 期望方向
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    let wx = -s * input.moveZ + c * input.moveX;
    let wz = -c * input.moveZ - s * input.moveX;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) { wx /= wl; wz /= wl; }

    let speed = this.fly ? (this.sprinting ? 22 : 11)
      : this.sneaking ? 1.4
        : this.sprinting ? 5.8 : 4.3;
    if (this.inWater && !this.fly) speed *= 0.55;

    const accel = this.fly ? 10 : this.onGround ? 14 : 3.2;
    const k = 1 - Math.exp(-accel * dt);
    this.vel.x = lerp(this.vel.x, wx * speed, k);
    this.vel.z = lerp(this.vel.z, wz * speed, k);

    if (this.fly) {
      const vy = ((input.jump ? 1 : 0) - (input.sneak ? 1 : 0)) * speed * 0.75;
      this.vel.y = lerp(this.vel.y, vy, k);
    } else if (this.inWater) {
      this.vel.y -= 6 * dt;
      this.vel.y *= Math.exp(-2.2 * dt);
      if (input.jump) this.vel.y = Math.min(this.vel.y + 26 * dt, 3.4);
      this.vel.y = Math.max(this.vel.y, -4);
    } else {
      this.vel.y -= GRAVITY * dt;
      this.vel.y = Math.max(this.vel.y, -46);
      if (input.jump && this.onGround) {
        this.vel.y = JUMP_VEL;
        this.onGround = false;
        this.survival.exhaust(0.12);
      }
    }

    this.wasGround = this.onGround;
    const res = moveBody(this.world, this, dt);

    // 摔落伤害
    if (this.onGround && !this.wasGround) {
      // 约 3 格起算：v = sqrt(2 * 27 * 3) ≈ 12.7，避免 2 格小跳也掉血
      if (!this.inWater && this.fallVy > 12.7) {
        this.survival.damage((this.fallVy - 12) * 0.75, '摔落');
      }
      this.fallVy = 0;
    } else if (!this.onGround && this.vel.y < 0) {
      this.fallVy = Math.max(this.fallVy, -this.vel.y);
    }

    // 移动端自动跳台阶
    if (this.autoJump && this.onGround && (res.hitX || res.hitZ) && wl > 0.1) {
      const px = Math.floor(this.pos.x + wx * 0.7);
      const pz = Math.floor(this.pos.z + wz * 0.7);
      const py = Math.floor(this.pos.y);
      if (this.world.isSolidAt(px, py, pz) &&
        !this.world.isSolidAt(px, py + 1, pz) &&
        !this.world.isSolidAt(px, py + 2, pz)) {
        this.vel.y = JUMP_VEL;
      }
    }

    // 脚步声与视角摆动
    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (this.onGround && hSpeed > 0.6 && !this.fly) {
      this.bobPhase += hSpeed * dt * 1.55;
      this.stepAcc += hSpeed * dt;
      if (this.stepAcc > 2.3) {
        this.stepAcc = 0;
        const under = this.registry.get(this.world.getBlock(
          Math.floor(this.pos.x), Math.floor(this.pos.y - 0.05), Math.floor(this.pos.z)));
        this.sound.step(under.sound);
      }
    }
    if (res.landed) this.sound.step('dirt', 0.5);

    // 准星目标
    this.eyePosition(this.tmpEye);
    this.viewDirection(this.tmpDir);
    this.target = this.world.raycast(this.tmpEye, this.tmpDir, REACH);
    const eHit = this.entities.raycast(this.tmpEye, this.tmpDir, ENTITY_REACH);
    const blockDist = this.target ? this.target.dist : 999;
    this.entityTarget = eHit && eHit.dist < Math.min(blockDist, ENTITY_REACH) ? eHit : null;

    // 交互
    this.breakTimer -= dt;
    this.placeTimer -= dt;
    this.attackTimer -= dt;
    this.eatTimer -= dt;

    if (this.entityTarget && input.breaking) {
      this.attack(this.entityTarget);
    } else if (input.breaking) {
      if (this.survival.isSurvival) this.mineTick(dt);
      else if (this.breakTimer <= 0) {
        this.breakTimer = 0.24;
        this.breakBlock();
      }
    } else if (this.survival.isSurvival) {
      // 松手后短暂保留进度（移动端轻点可累积），1 秒后归零
      this.mineIdle += dt;
      if (this.mineIdle > 1) this.resetMining();
      this.breakTimer = Math.min(this.breakTimer, 0);
    } else {
      this.resetMining();
      this.breakTimer = Math.min(this.breakTimer, 0);
    }

    if (input.placing && this.placeTimer <= 0) {
      this.placeTimer = 0.24;
      this.useSelected();
    }
    if (!input.placing) this.placeTimer = Math.min(this.placeTimer, 0);

    // 生存状态（饥饿/氧气/回血）
    this.survival.tick(dt, {
      moving: hSpeed > 0.6 || this.fly,
      sprinting: this.sprinting,
      mining: this.miningProgress !== null,
      underwater: this.eyeInWater,
    });

    this.updateCamera(dt, hSpeed);

    this.moveEmitAcc += dt;
    if (this.moveEmitAcc > 0.25) {
      this.moveEmitAcc = 0;
      // 只有真的移动过才通知存档，站着不动不应反复触发自动保存
      const moved = Math.abs(this.pos.x - this.lastEmitX) +
        Math.abs(this.pos.y - this.lastEmitY) + Math.abs(this.pos.z - this.lastEmitZ);
      if (moved > 0.02) {
        this.lastEmitX = this.pos.x;
        this.lastEmitY = this.pos.y;
        this.lastEmitZ = this.pos.z;
        this.events.emit('player:move', { position: { x: this.pos.x, y: this.pos.y, z: this.pos.z } });
      }
    }
  }

  // ---------- 挖掘 ----------

  private resetMining() {
    this.mineIdle = 0;
    this.mineKey = '';
    this.mineTime = 0.2;
    this.miningProgress = null;
    this.miningBlock = null;
  }

  /** 生存模式：按住左键按硬度计时挖掘 */
  private mineTick(dt: number) {
    const hit = this.target;
    if (!hit) {
      this.resetMining();
      return;
    }
    const def = this.registry.get(hit.block);
    if (!isFinite(def.hardness)) {
      this.resetMining();
      return;
    }
    const key = `${hit.x},${hit.y},${hit.z}`;
    this.mineIdle = 0;
    if (key !== this.mineKey) {
      this.mineKey = key;
      this.mineTime = Math.max(0.06, def.hardness * 1.1);
      this.miningProgress = 0;
      this.miningBlock = def;
      this.mineSoundAcc = 0;
      if (def.name === 'tnt') {
        this.igniteTnt(hit.x, hit.y, hit.z);
        this.resetMining();
        return;
      }
    }
    this.miningProgress = Math.min(1, (this.miningProgress ?? 0) + dt / this.mineTime);
    this.mineSoundAcc += dt;
    if (this.mineSoundAcc > 0.26) {
      this.mineSoundAcc = 0;
      this.sound.dig(def.sound, def.hardness);
      const color = this.atlas.avgColor(def.tiles.side);
      this.particles.burst(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, color, 2, 0.35, 1.4);
      this.swing();
    }
    if (this.miningProgress >= 1) {
      this.breakBlock();
      this.resetMining();
    }
  }

  /** 轻点破坏（移动端）：生存模式给一小段挖掘进度 */
  tapBreak() {
    if (!this.survival.isSurvival) {
      this.breakBlock();
      return;
    }
    const hit = this.target;
    if (!hit || !isFinite(this.registry.get(hit.block).hardness)) return;
    const def = this.registry.get(hit.block);
    const key = `${hit.x},${hit.y},${hit.z}`;
    if (key !== this.mineKey) {
      this.mineKey = key;
      this.mineTime = Math.max(0.06, def.hardness * 1.1);
      this.miningProgress = 0;
    }
    this.mineIdle = 0;
    this.miningProgress = Math.min(1, (this.miningProgress ?? 0) + 0.3 / this.mineTime);
    this.miningBlock = def;
    this.sound.dig(this.miningBlock.sound, this.miningBlock.hardness);
    this.swing();
    if (this.miningProgress >= 1) {
      this.breakBlock();
      this.resetMining();
    }
  }

  private igniteTnt(x: number, y: number, z: number) {
    this.world.setBlock(x, y, z, AIR);
    this.events.emit('block:ignite', { x, y, z });
    this.sound.fuse();
  }

  /** 生态能量系统在组装根创建后注入（避免 Player 反向依赖 Botany 的构造顺序） */
  setBotany(botany: Botany) {
    this.botany = botany;
  }

  /** 破坏准星方块（含掉落、上方植物连带与蓄能采集结算） */
  breakBlock() {
    const hit = this.target;
    if (!hit) return;
    const def = this.registry.get(hit.block);
    if (!isFinite(def.hardness)) {
      this.sound.click(180);
      return;
    }
    this.swing();
    if (def.name === 'tnt') {
      this.igniteTnt(hit.x, hit.y, hit.z);
      return;
    }
    // 破坏前结算蓄能产物（花蜜 / 额外种子 / 浆果）
    const bonus = this.botany?.harvest(hit.x, hit.y, hit.z, 'break') ?? null;
    this.world.setBlock(hit.x, hit.y, hit.z, AIR);
    this.events.emit('block:break', { x: hit.x, y: hit.y, z: hit.z, block: hit.block });
    const color = this.atlas.avgColor(def.tiles.side);
    this.particles.burst(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, color, 22, 0.4, 3.4);
    this.sound.dig(def.sound, def.hardness);
    this.collectDrops(def);
    if (bonus) this.survival.addDrop(bonus.item, bonus.count);
    // 上方植物随之掉落
    const aboveId = this.world.getBlock(hit.x, hit.y + 1, hit.z);
    const above = this.registry.get(aboveId);
    if (above.shape === 'cross') {
      this.world.setBlock(hit.x, hit.y + 1, hit.z, AIR);
      this.events.emit('block:break', { x: hit.x, y: hit.y + 1, z: hit.z, block: aboveId });
      this.collectDrops(above);
    }
  }

  /** 生存模式把掉落物放进背包，创造模式忽略 */
  private collectDrops(def: BlockDefinition) {
    if (!this.survival.isSurvival) return;
    for (const d of def.drops) {
      if (d.chance !== undefined && Math.random() > d.chance) continue;
      const name = d.name === 'self' ? def.name : d.name;
      this.survival.addDrop(name, d.count ?? 1);
    }
  }

  // ---------- 放置 / 使用 / 进食 ----------

  /** 右键 / 放置键：手持方块则放置，种子 / 浆果则种植，空手则采集蓄能植物 */
  useSelected() {
    const stack = this.selectedStack();
    if (!stack) {
      this.harvestPlant();
      return;
    }
    if (stack.kind === 'item') {
      const item = this.selectedItem();
      if (item?.plant) {
        const def = this.registry.byNameGet(item.plant);
        // 甜浆果既能种植也能进食：对准可种位置时优先种植，否则吃掉
        if (!def || !this.placeBlockDef(def, stack)) {
          if (item.food) this.eat();
        }
        return;
      }
      this.eat();
      return;
    }
    this.doPlace();
  }

  /** 空手右键蓄能植物：采集花蜜 / 额外作物，植物保留并消耗能量 */
  private harvestPlant(): boolean {
    const hit = this.target;
    if (!hit || !this.botany) return false;
    const bonus = this.botany.harvest(hit.x, hit.y, hit.z, 'use');
    if (!bonus) return false;
    this.survival.addDrop(bonus.item, bonus.count);
    const def = this.registry.get(hit.block);
    const color = this.atlas.avgColor(def.tiles.side);
    this.particles.burst(hit.x + 0.5, hit.y + 0.7, hit.z + 0.5, color, 12, 0.28, 1.6);
    this.sound.click(1080);
    this.swing();
    return true;
  }

  doPlace() {
    const stack = this.selectedStack();
    if (!stack || stack.kind !== 'block') return;
    this.placeBlockDef(this.registry.get(stack.id as BlockId), stack);
  }

  /** 放置 / 种植共用路径；返回是否真的落下方块 */
  private placeBlockDef(def: BlockDefinition, stack: Stack): boolean {
    const hit = this.target;
    if (!hit) return false;
    const x = hit.x + hit.nx;
    const y = hit.y + hit.ny;
    const z = hit.z + hit.nz;
    // 先校验放置边界，避免 setBlock 返回 false 时背包已经被扣掉
    if (y < 1 || y >= WORLD_HEIGHT) return false;
    const existing = this.registry.get(this.world.getBlock(x, y, z));
    if (existing.solid) return false;
    if (boxIntersectsBlock(this.pos, this.width, this.height, x, y, z)) return false;
    if (def.id === AIR) return false;
    if (def.shape === 'cross' && !this.world.isSolidAt(x, y - 1, z)) return false;
    // 目标格已是同一方块时 setBlock 会返回 false：先拦住，否则扣了背包却没放下方块。
    // 火把 / 草丛这类非实心方块不会被上面的 existing.solid 挡住，所以这条必须存在。
    if (existing.id === def.id) return false;
    if (this.survival.isSurvival && !this.survival.consume(stack, 1)) return false;
    this.world.setBlock(x, y, z, def.id);
    this.events.emit('block:place', { x, y, z, block: def.id });
    this.sound.place(def.sound);
    this.swing();
    return true;
  }

  eat() {
    if (this.eatTimer > 0) return;
    const item = this.selectedItem();
    if (!item?.food) return;
    const stack = this.selectedStack()!;
    if (this.survival.hunger >= MAX_HUNGER) {
      this.sound.click(240);
      return;
    }
    // 先扣物品再生效：consume 失败时不能白吃一份回血/饥饿
    if (!this.survival.consume(stack, 1)) return;
    this.survival.eat(item.name);
    this.eatTimer = 0.7;
    this.swing();
    this.sound.eat();
  }

  // ---------- 攻击 ----------

  attack(target: { entity: Entity; dist: number }) {
    if (this.attackTimer > 0) return;
    this.attackTimer = 0.55;
    this.swing();
    const dmg = this.survival.isSurvival ? 3 : 999;
    target.entity.hurt(dmg, this.pos.x, this.pos.z);
    this.survival.exhaust(0.1);
    this.sound.hit();
  }

  pickBlock() {
    if (!this.target) return;
    const id = this.target.block;
    if (this.survival.isSurvival && this.survival.countKey(`b:${id}`) <= 0) return;
    const idx = this.hotbar.slots.findIndex((s) => s && s.kind === 'block' && s.id === id);
    if (idx >= 0) this.hotbar.index = idx;
    else {
      // 覆盖当前格前先把原有物品挪到空格，避免背包里留下取不回来的"孤儿"
      const i = this.hotbar.index;
      const old = this.hotbar.slots[i];
      if (old) {
        const empty = this.hotbar.slots.findIndex((s) => s === null);
        if (empty >= 0) this.hotbar.slots[empty] = old;
      }
      this.hotbar.slots[i] = { kind: 'block', id };
    }
    this.setHeldStack(this.hotbar.slots[this.hotbar.index]);
    this.events.emit('hotbar:select', { index: this.hotbar.index, block: id });
  }

  // ---------- 相机 ----------

  private updateCamera(dt: number, hSpeed: number) {
    this.swingT = Math.min(1, this.swingT + dt / 0.26);
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      if (this.shakeT <= 0) this.shakeAmp = 0;
    }
    const shakeX = this.viewBob ? this.shakeAmp * (Math.random() - 0.5) * this.shakeT : 0;
    const shakeY = this.viewBob ? this.shakeAmp * (Math.random() - 0.5) * this.shakeT : 0;

    this.eyePosition(this.tmpEye);
    this.viewDirection(this.tmpDir);

    const moving = this.viewBob && this.onGround && hSpeed > 0.6 && !this.fly;
    const bobY = moving ? Math.sin(this.bobPhase * 2) * 0.045 : 0;
    const bobX = moving ? Math.cos(this.bobPhase) * 0.03 : 0;

    if (this.cameraMode === 0) {
      this.camera.position.set(
        this.tmpEye.x + Math.cos(this.yaw) * bobX + shakeX,
        this.tmpEye.y + bobY + shakeY,
        this.tmpEye.z - Math.sin(this.yaw) * bobX,
      );
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.set(this.pitch, this.yaw, 0);
    } else {
      const sign = this.cameraMode === 1 ? -1 : 1;
      let dist = 4.6;
      this.tmpV.copy(this.tmpDir).multiplyScalar(sign);
      const hit = this.world.raycast(this.tmpEye, this.tmpV, dist);
      if (hit) dist = Math.max(0.8, hit.dist - 0.25);
      this.camera.position.copy(this.tmpEye).addScaledVector(this.tmpV, dist);
      this.camera.position.x += shakeX;
      this.camera.position.y += shakeY;
      if (this.cameraMode === 1) {
        this.camera.lookAt(this.tmpEye.x + this.tmpDir.x * 6, this.tmpEye.y + this.tmpDir.y * 6, this.tmpEye.z + this.tmpDir.z * 6);
      } else {
        this.camera.lookAt(this.tmpEye);
      }
    }

    // 角色模型
    this.model.group.visible = this.cameraMode !== 0;
    if (this.cameraMode !== 0) {
      const swing = this.swingT < 1 ? this.swingT : 0;
      this.model.update(this.pos, this.yaw + Math.PI, this.bobPhase, moving, swing, this.pitch);
    }

    // 手持物品
    this.heldGroup.visible = this.cameraMode === 0;
    const sp = this.swingT < 1 ? Math.sin(this.swingT * Math.PI) : 0;
    const aspect = this.camera.aspect || 1.6;
    const halfW = Math.tan((this.camera.fov * Math.PI) / 360) * aspect;
    // 竖屏时明显缩小手持物，避免遮住跳跃/放置按钮；桌面也略收一点
    const handScale = Math.min(0.72, Math.max(0.3, aspect / 2.15));
    this.heldGroup.scale.setScalar(handScale);
    const handX = Math.min(0.44, halfW * 0.42);
    this.heldGroup.position.set(
      handX + bobX * 0.6,
      -0.40 + bobY * 0.6 - sp * 0.22,
      -0.72 - sp * 0.12,
    );
    this.heldGroup.rotation.set(0.12 - sp * 0.95, -0.4 - sp * 0.2, 0.06);
  }
}
