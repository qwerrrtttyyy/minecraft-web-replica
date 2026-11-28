import * as THREE from 'three';
import { RANGED } from '../core/tuning';
import type { TextureAtlas } from '../gfx/atlas';
import type { Particles } from '../gfx/particles';
import type { EventService } from '../services/events';
import type { World } from '../world/world';
import type { EntityManager } from './entity';

/**
 * 箭矢投射物（内容更新：弓箭）。
 *
 * 纯数据 + three 表现分离：飞行 / 命中判定只依赖 World 与 EntityManager.raycast，
 * 不触碰 DOM；网格几何与材质由管理器共享，命中即回收，避免逐支创建 GPU 资源。
 */

const UP = new THREE.Vector3(0, 1, 0);

export class ArrowManager {
  private readonly arrows: Arrow[] = [];
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.MeshBasicMaterial;
  private readonly dir = new THREE.Vector3();

  constructor(
    private readonly scene: THREE.Scene,
    atlas: TextureAtlas,
    private readonly world: World,
    private readonly entities: EntityManager,
    private readonly events: EventService,
    private readonly particles: Particles,
  ) {
    this.geo = atlas.makeItemGeometry('arrow');
    this.mat = new THREE.MeshBasicMaterial({
      map: atlas.texture,
      vertexColors: true,
      alphaTest: 0.5,
    });
  }

  get count(): number {
    return this.arrows.length;
  }

  /** 从眼睛位置沿视线射出一支箭；damage 为命中生物造成的伤害 */
  shoot(origin: THREE.Vector3, direction: THREE.Vector3, damage = RANGED.arrowDamage): void {
    const dir = this.dir.copy(direction).normalize();
    const arrow = new Arrow(
      origin.clone().addScaledVector(dir, 0.6),
      dir.clone().multiplyScalar(RANGED.arrowSpeed),
      damage,
      new THREE.Mesh(this.geo, this.mat),
    );
    arrow.mesh.scale.setScalar(0.16);
    arrow.orient();
    this.scene.add(arrow.mesh);
    this.arrows.push(arrow);
    this.events.emit('arrow:shoot', { x: arrow.pos.x, y: arrow.pos.y, z: arrow.pos.z });
  }

  /** 推进所有箭矢；暂停 / 标题时传 playing=false 直接跳过 */
  update(dt: number, playing: boolean): void {
    if (!playing) return;
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const arrow = this.arrows[i];
      arrow.update(dt, this.world, this.entities, this.particles, this.events);
      if (arrow.done) {
        this.scene.remove(arrow.mesh);
        this.arrows.splice(i, 1);
      }
    }
  }

  /** 退出到标题 / 读档：清场，不触发命中 */
  clear(): void {
    for (const arrow of this.arrows) this.scene.remove(arrow.mesh);
    this.arrows.length = 0;
  }

  dispose(): void {
    this.clear();
    this.geo.dispose();
    this.mat.dispose();
  }
}

class Arrow {
  readonly mesh: THREE.Mesh;
  done = false;
  private life = RANGED.arrowLifetime;
  private readonly step = new THREE.Vector3();
  private readonly next = new THREE.Vector3();

  constructor(
    readonly pos: THREE.Vector3,
    readonly vel: THREE.Vector3,
    readonly damage: number,
    mesh: THREE.Mesh,
  ) {
    this.mesh = mesh;
    this.mesh.position.copy(pos);
  }

  orient(): void {
    const dir = this.step.copy(this.vel).normalize();
    this.mesh.quaternion.setFromUnitVectors(UP, dir);
  }

  update(dt: number, world: World, entities: EntityManager, particles: Particles, events: EventService): void {
    this.vel.y -= RANGED.arrowGravity * dt;
    this.step.copy(this.vel).multiplyScalar(dt);
    const dist = this.step.length();
    if (dist > 1e-6) {
      this.step.divideScalar(dist);
      const blockHit = world.raycast(this.pos, this.step, dist);
      const entityHit = entities.raycast(this.pos, this.step, dist);
      const useEntity = entityHit && (!blockHit || entityHit.dist < blockHit.dist);
      if (useEntity) {
        entityHit!.entity.hurt(this.damage, this.pos.x, this.pos.z);
        particles.burst(
          entityHit!.entity.pos.x,
          entityHit!.entity.pos.y + entityHit!.entity.height * 0.6,
          entityHit!.entity.pos.z,
          [0.9, 0.25, 0.2],
          8,
          0.14,
          2.2,
        );
        events.emit('arrow:hit', { kind: 'entity', type: entityHit!.entity.type.id });
        this.done = true;
        return;
      }
      if (blockHit) {
        this.next.copy(this.pos).addScaledVector(this.step, blockHit.dist);
        particles.burst(this.next.x, this.next.y, this.next.z, [0.8, 0.78, 0.7], 5, 0.1, 1.4);
        events.emit('arrow:hit', { kind: 'block', x: blockHit.x, y: blockHit.y, z: blockHit.z });
        this.done = true;
        return;
      }
    }
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.position.copy(this.pos);
    this.orient();
    this.life -= dt;
    if (this.life <= 0 || this.pos.y < 0) this.done = true;
  }
}
