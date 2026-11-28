/**
 * 可见悬浮掉落物：渲染与生命周期（DropManager）。
 *
 * 纯判定在 world/dropLogic.ts；本模块只负责建 mesh、复用 moveBody 做碰撞、
 * 浮动自转、入水水花与拾取反馈。几何按材料键缓存、材质全局共享一份，
 * 拾取 / 消失只从 scene 移除，绝不 dispose 共享资源。
 */
import * as THREE from 'three';
import type { SoundEngine } from '../audio/sound';
import { DROPS } from '../core/tuning';
import type { TextureAtlas } from '../gfx/atlas';
import type { Particles } from '../gfx/particles';
import { moveBody, type PhysicsBody } from '../player/physics';
import { ITEMS } from '../player/survival';
import { advanceWater, canPickup, dropsMerge, scatterOffset, shouldDespawn } from '../world/dropLogic';
import type { World } from '../world/world';

/** 掉落物碰撞盒：小方块，脚底中心为 pos */
const BODY_SIZE = 0.25;

export interface DropManagerOptions {
  scene: THREE.Scene;
  atlas: TextureAtlas;
  seed: number;
  world: World;
  onPickup(name: string, count: number): void;
  /** 可选反馈通道：由组装根注入，纯逻辑测试可省略 */
  particles?: Particles;
  sound?: SoundEngine;
}

export class DroppedItem implements PhysicsBody {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  width = BODY_SIZE;
  height = BODY_SIZE;
  onGround = false;
  age = 0;
  wasInWater = false;
  readonly mesh: THREE.Mesh;
  /** 浮动相位错开，避免同批掉落物整齐划一地上下跳动 */
  private readonly bobPhase: number;

  constructor(
    readonly name: string,
    public count: number,
    x: number,
    y: number,
    z: number,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    bobPhase: number,
  ) {
    this.pos.set(x, y, z);
    this.bobPhase = bobPhase;
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.scale.setScalar(DROPS.scale);
  }

  /** 浮动叠在物理位置之上，不写回 pos（否则会污染 moveBody 的碰撞坐标） */
  applyVisual(dt: number) {
    const bob = Math.sin(this.age * DROPS.bobSpeed + this.bobPhase) * DROPS.bobAmp;
    this.mesh.position.set(this.pos.x, this.pos.y + this.height / 2 + bob, this.pos.z);
    this.mesh.rotation.y += DROPS.spin * dt;
  }
}

export class DropManager {
  readonly items: DroppedItem[] = [];
  private spawnSerial = 0;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly geometryCache = new Map<string, THREE.BufferGeometry>();

  constructor(private readonly opts: DropManagerOptions) {
    this.material = new THREE.MeshBasicMaterial({
      map: opts.atlas.texture,
      vertexColors: true,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
    });
  }

  /** 生成一个掉落物；0.8 格内同类先合并（上限 999），剩余另起一个实体 */
  spawn(name: string, count: number, x: number, y: number, z: number, source?: string) {
    if (!(count > 0)) return;
    const src = source || `d:${x},${y},${z}`;
    const index = this.spawnSerial++;
    const scatter = scatterOffset(this.opts.seed, src, index);
    const px = x + scatter.dx * DROPS.scatter;
    const py = y;
    const pz = z + scatter.dz * DROPS.scatter;

    let remaining = count;
    const incoming = { name, count: remaining, x: px, y: py, z: pz };
    for (const item of this.items) {
      if (remaining <= 0) break;
      const existing = { name: item.name, count: item.count, x: item.pos.x, y: item.pos.y, z: item.pos.z };
      if (!dropsMerge(existing, incoming)) continue;
      const room = DROPS.stackLimit - item.count;
      if (room <= 0) continue;
      const add = Math.min(room, remaining);
      item.count += add;
      remaining -= add;
      incoming.count = remaining;
    }
    if (remaining <= 0) return;

    const item = new DroppedItem(name, remaining, px, py, pz, this.geometryFor(name), this.material, index * 0.7);
    item.vel.set(scatter.vx * DROPS.popSpeed, scatter.vy * DROPS.popSpeed, scatter.vz * DROPS.popSpeed);
    this.opts.scene.add(item.mesh);
    this.items.push(item);
  }

  /**
   * 每帧推进：仅 playing 时推进 age / 物理 / 拾取 / 消失；暂停 / 标题 / 死亡直接返回。
   * dt 由主循环钳制到 0.05，不能靠暂停期间的帧累积绕过 age。
   */
  update(dt: number, playerPos: { x: number; y: number; z: number }, playing: boolean) {
    if (!playing) return;
    const world = this.opts.world;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      item.age += dt;

      // 入水判定：取身体中部所在格，液体（本作只有水）才触发
      const inWater = world.registry.get(
        world.getBlock(Math.floor(item.pos.x), Math.floor(item.pos.y + item.height / 2), Math.floor(item.pos.z)),
      ).liquid;
      if (inWater && !item.wasInWater) {
        const color = this.colorOf(item.name);
        this.opts.particles?.burst(item.pos.x, item.pos.y + 0.5, item.pos.z, color, 8, 0.3, 1.2);
        this.opts.sound?.click(520);
      }
      item.wasInWater = inWater;

      // 水中终端下沉 + 水平指数衰减；出水把重力交回 moveBody 处理落地
      const vel = advanceWater({ vx: item.vel.x, vy: item.vel.y, vz: item.vel.z }, dt, inWater);
      item.vel.set(vel.vx, vel.vy, vel.vz);
      moveBody(world, item, dt);
      if (item.onGround) {
        item.vel.x *= 0.8;
        item.vel.z *= 0.8;
      }
      item.applyVisual(dt);

      if (canPickup({ x: item.pos.x, y: item.pos.y, z: item.pos.z, age: item.age }, playerPos)) {
        this.opts.onPickup(item.name, item.count);
        this.opts.particles?.burst(item.pos.x, item.pos.y + 0.3, item.pos.z, this.colorOf(item.name), 6, 0.25, 1);
        this.opts.sound?.click(880);
        this.opts.scene.remove(item.mesh);
        this.items.splice(i, 1);
        continue;
      }
      if (shouldDespawn({ age: item.age, y: item.pos.y })) {
        this.opts.scene.remove(item.mesh);
        this.items.splice(i, 1);
      }
    }
  }

  /** 清空全部掉落物（newWorld / 返回标题 / 重生）；不 dispose 共享几何与材质 */
  clear() {
    for (const item of this.items) this.opts.scene.remove(item.mesh);
    this.items.length = 0;
  }

  private geometryFor(name: string): THREE.BufferGeometry {
    const cached = this.geometryCache.get(name);
    if (cached) return cached;
    let geo: THREE.BufferGeometry;
    if (name.startsWith('item:')) {
      const def = ITEMS[name.slice(5)];
      geo = this.opts.atlas.makeItemGeometry(def ? def.tile : name);
    } else {
      const def = this.opts.world.registry.byNameGet(name);
      geo = def ? this.opts.atlas.makeBlockGeometry(def) : this.opts.atlas.makeItemGeometry(name);
      // 方块几何原点在底部（0..1），下移半格让 mesh 以身体中心对齐
      geo.translate(0, -0.5, 0);
    }
    this.geometryCache.set(name, geo);
    return geo;
  }

  private colorOf(name: string): [number, number, number] {
    const fallback: [number, number, number] = [1, 1, 1];
    const tile = name.startsWith('item:')
      ? ITEMS[name.slice(5)]?.tile
      : this.opts.world.registry.byNameGet(name)?.tiles.side;
    return tile ? (this.opts.atlas.avgColor?.(tile) ?? fallback) : fallback;
  }
}
