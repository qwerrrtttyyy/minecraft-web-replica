import * as THREE from 'three';
import { clamp, lerp, SEA_LEVEL, type BlockId, type System } from '../core/types';
import type { EventBus } from '../core/events';
import { AIR, type BlockDefinition, type BlockRegistry } from '../world/blocks';
import type { World, RayHit } from '../world/world';
import type { TextureAtlas } from '../gfx/atlas';
import type { Input } from '../input/input';
import { moveBody, boxIntersectsBlock, type PhysicsBody } from './physics';
import { PlayerModel } from '../entity/models';
import type { SoundEngine } from '../audio/sound';
import type { Particles } from '../gfx/particles';
import type { EntityManager, Entity } from '../entity/entity';
import { ITEMS, MAX_HUNGER, type Stack, type SurvivalState } from './survival';

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
  private tmpDir = new THREE.Vector3();
  private tmpEye = new THREE.Vector3();
  private tmpV = new THREE.Vector3();

  constructor(
    private world: World,
    private camera: THREE.PerspectiveCamera,
    private input: Input,
    private registry: BlockRegistry,
    private atlas: TextureAtlas,
    private events: EventBus,
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

  /** 寻找一块陆地出生 */
  spawn() {
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
        if (h > SEA_LEVEL && this.registry.isSolid(top) && clear(above) && clear(above2)) {
          this.pos.set(x + 0.5, h + 1.02, z + 0.5);
          this.vel.set(0, 0, 0);
          this.survival.spawn = { x: x + 0.5, y: h + 1.02, z: z + 0.5 };
          this.events.emit('player:spawn', { position: { x: this.pos.x, y: this.pos.y, z: this.pos.z } });
          return;
        }
      }
    }
    this.pos.set(0.5, this.world.generator.surfaceHeight(0, 0) + 2.02, 0.5);
    this.survival.spawn = { x: 0.5, y: this.pos.y, z: 0.5 };
    this.events.emit('player:spawn', { position: { x: this.pos.x, y: this.pos.y, z: this.pos.z } });
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
    this.shakeAmp = Math.max(this.shakeAmp, amp);
    this.shakeT = 0.4;
  }

  toggleFly(): boolean {
    if (this.survival.isSurvival) return false;
    this.fly = !this.fly;
    if (this.fly) this.vel.y = 0;
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
  }

  // ---------- 主循环 ----------

  update(dt: number) {
    if (this.survival.dead) return;
    const input = this.input;
    const [dx, dy] = input.consumeLook();
    this.yaw -= dx * 0.0022;
    this.pitch = clamp(this.pitch - dy * 0.0022, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);

    this.sneaking = input.sneak && !this.fly;
    this.sprinting = input.sprint && input.moveZ > 0.1 && !this.sneaking &&
      (!this.survival.isSurvival || this.survival.hunger > 6);

    const feetBlock = this.registry.get(this.world.getBlock(
      Math.floor(this.pos.x), Math.floor(this.pos.y + 0.3), Math.floor(this.pos.z)));
    const eyeBlock = this.registry.get(this.world.getBlock(
      Math.floor(this.pos.x), Math.floor(this.pos.y + EYE), Math.floor(this.pos.z)));
    this.inWater = feetBlock.liquid;
    this.eyeInWater = eyeBlock.liquid;

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

  /** 破坏准星方块（含掉落与上方植物连带） */
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
    this.world.setBlock(hit.x, hit.y, hit.z, AIR);
    this.events.emit('block:break', { x: hit.x, y: hit.y, z: hit.z, block: hit.block });
    const color = this.atlas.avgColor(def.tiles.side);
    this.particles.burst(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, color, 22, 0.4, 3.4);
    this.sound.dig(def.sound, def.hardness);
    this.collectDrops(def);
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

  /** 右键 / 放置键：手持方块则放置，手持食物则进食 */
  useSelected() {
    const stack = this.selectedStack();
    if (!stack) return;
    if (stack.kind === 'item') {
      this.eat();
      return;
    }
    this.doPlace();
  }

  doPlace() {
    const stack = this.selectedStack();
    if (!stack || stack.kind !== 'block') return;
    const hit = this.target;
    if (!hit) return;
    const x = hit.x + hit.nx;
    const y = hit.y + hit.ny;
    const z = hit.z + hit.nz;
    const existing = this.registry.get(this.world.getBlock(x, y, z));
    if (existing.solid) return;
    if (boxIntersectsBlock(this.pos, this.width, this.height, x, y, z)) return;
    const def = this.registry.get(stack.id as BlockId);
    if (def.id === AIR) return;
    if (def.shape === 'cross' && !this.world.isSolidAt(x, y - 1, z)) return;
    if (this.survival.isSurvival && !this.survival.consume(stack, 1)) return;
    this.world.setBlock(x, y, z, def.id);
    this.events.emit('block:place', { x, y, z, block: def.id });
    this.sound.place(def.sound);
    this.swing();
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
    const shakeX = this.shakeAmp * (Math.random() - 0.5) * this.shakeT;
    const shakeY = this.shakeAmp * (Math.random() - 0.5) * this.shakeT;

    this.eyePosition(this.tmpEye);
    this.viewDirection(this.tmpDir);

    const moving = this.onGround && hSpeed > 0.6 && !this.fly;
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
    // 竖屏时等比缩小手持物并往里收，避免被画面裁掉
    const handScale = Math.min(1, Math.max(0.55, aspect / 1.5));
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
