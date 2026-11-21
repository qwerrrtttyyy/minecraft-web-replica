import * as THREE from 'three';
import { AIR, type BlockDefinition, type BlockRegistry } from '../world/blocks';
import type { BlockId } from '../core/types';
import type { World } from '../world/world';
import type { TextureAtlas } from '../gfx/atlas';
import type { EventService } from '../services/events';
import { WORLD_HEIGHT } from '../core/types';

/**
 * 沙 / 沙砾重力（借鉴原版 FallingBlock）。
 *
 * 失去支撑的沙类方块转为下落实体（复用 PrimedTnt 的轻量抛物线模式，垂直下落），
 * 落地后回写方块并从落点继续向上级联——堆叠的沙柱会逐块依次坍塌（每次只转
 * 最低的失支撑块，其余等它落地后级联），上方植物与 breakBlock 的连带语义一致。
 * 落点被植物占位时先连带掉落再回写，保证不吞掉落物。
 */

export class FallingBlock {
  private mesh: THREE.Mesh;
  private mat: THREE.MeshBasicMaterial;
  private vel = -1.5;
  private onPlantDrop: ((def: BlockDefinition) => void) | null;
  /** H09：落点被玩家/生物 AABB 占据时返回 true（落地悬停，不实体化进实体） */
  isBlocked: ((x: number, y: number, z: number) => boolean) | null = null;
  done = false;

  constructor(
    private world: World,
    private registry: BlockRegistry,
    atlas: TextureAtlas,
    private scene: THREE.Scene,
    private events: EventService,
    private x: number,
    private y: number,
    private z: number,
    private id: BlockId,
    private onLand: (x: number, y: number, z: number) => void,
    onPlantDrop: ((def: BlockDefinition) => void) | null,
  ) {
    this.onPlantDrop = onPlantDrop;
    const def = registry.get(id);
    this.mat = new THREE.MeshBasicMaterial({ map: atlas.texture, vertexColors: true, alphaTest: 0.5 });
    this.mesh = new THREE.Mesh(atlas.makeBlockGeometry(def), this.mat);
    this.mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
    scene.add(this.mesh);
  }

  update(dt: number) {
    if (this.done) return;
    this.vel = Math.max(this.vel - 32 * dt, -42);
    const ny = this.mesh.position.y + this.vel * dt;
    // 落出世界：直接消失（与掉出虚空的方块一致，不再回写）
    if (ny < -2) {
      this.finish();
      return;
    }
    // H09：逐格步进检测——每步最多下落 1 格，高速（终端速度 2.1 格/帧）
    // 不再只查终点底格穿透薄地板
    let py = this.mesh.position.y;
    while (py - ny > 1) {
      py -= 1;
      const feetCell = Math.floor(py - 0.5);
      if (feetCell >= 0 && this.world.isSolidAt(this.x, feetCell, this.z)) {
        if (this.tryLand(feetCell)) return;
      }
    }
    const feetCell = Math.floor(ny - 0.5);
    if (feetCell >= 0 && this.world.isSolidAt(this.x, feetCell, this.z)) {
      if (this.tryLand(feetCell)) return;
    }
    this.mesh.position.y = ny;
  }

  /** 命中实心柱后的落地流程：从命中格向上找第一个空位；被实体挡住则悬停等待。返回是否已结束 */
  private tryLand(feetCell: number): boolean {
    let landY = feetCell + 1;
    while (landY < WORLD_HEIGHT && this.world.isSolidAt(this.x, landY, this.z)) landY++;
    // H09：落点在玩家/生物体内时先悬停，等让开后落地——不实体化进实体
    if (this.isBlocked?.(this.x, landY, this.z)) {
      this.mesh.position.y = landY + 0.5;
      this.vel = 0;
      return false;
    }
    this.land(landY);
    return true;
  }

  private land(landY: number) {
    this.finish();
    if (landY >= WORLD_HEIGHT) return;
    // 落点被草丛 / 花等非实心方块占位：先连带掉落（与 breakBlock 同语义），再回写
    const existing = this.world.getBlock(this.x, landY, this.z);
    if (existing !== AIR && !this.world.isSolidAt(this.x, landY, this.z)) {
      this.events.emit('block:break', { x: this.x, y: landY, z: this.z, block: existing });
      this.onPlantDrop?.(this.registry.get(existing));
    }
    this.world.setBlock(this.x, landY, this.z, this.id);
    this.events.emit('block:place', { x: this.x, y: landY, z: this.z, block: this.id });
    // 落地级联：落点上方的沙类 / 植物接着处理，堆叠沙柱逐块坍塌
    this.onLand(this.x, landY + 1, this.z);
  }

  private finish() {
    if (this.done) return;
    this.done = true;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

/**
 * 下落调度：方块更新（破坏 / 放置 / 爆炸 / 落地）后调用 triggerColumn。
 */
export class FallingSystem {
  readonly list: FallingBlock[] = [];
  /** 实验性玩法「方块重力」：false 时 triggerColumn 不触发，悬空方块保持原位 */
  enabled = true;
  /** 植物失去支撑的掉落回调（组装根接到生存背包，创造模式忽略） */
  onPlantDrop: ((def: BlockDefinition) => void) | null = null;
  /** H09：落点阻挡检查（玩家/实体 AABB），由组装根注入 */
  isBlocked: ((x: number, y: number, z: number) => boolean) | null = null;

  constructor(
    private world: World,
    private registry: BlockRegistry,
    private atlas: TextureAtlas,
    private scene: THREE.Scene,
    private events: EventService,
  ) {}

  /**
   * 从 (x,y,z) 向上处理失支撑的沙类与植物（受更新下落）。
   *
   * 只把最低的失支撑沙类转为下落实体，其余等它落地后由 onLand 级联——
   * 保证堆叠沙柱像原版一样逐块坍塌，而不是同时下落穿模；
   * 悬空植物在扫描中连带掉落，语义与 breakBlock 的「上方植物随之掉落」一致。
   */
  triggerColumn(x: number, y: number, z: number): void {
    if (!this.enabled) return;
    let started = false;
    for (let yy = Math.max(0, y); yy < WORLD_HEIGHT; yy++) {
      const id = this.world.getBlock(x, yy, z);
      if (id === AIR) continue;
      const def = this.registry.get(id);
      const supported = yy > 0 && this.world.isSolidAt(x, yy - 1, z);
      if (def.falling && !supported) {
        if (started) return; // 上面的沙块等先落地的级联
        started = true;
        this.world.setBlock(x, yy, z, AIR);
        this.events.emit('block:break', { x, y: yy, z, block: id });
        const fb = new FallingBlock(
          this.world, this.registry, this.atlas, this.scene, this.events,
          x, yy, z, id,
          (lx, ly, lz) => this.triggerColumn(lx, ly, lz),
          this.onPlantDrop,
        );
        fb.isBlocked = this.isBlocked;
        this.list.push(fb);
        continue;
      }
      if (def.shape === 'cross' && !supported) {
        this.world.setBlock(x, yy, z, AIR);
        this.events.emit('block:break', { x, y: yy, z, block: id });
        this.onPlantDrop?.(def);
        continue;
      }
      return; // 支撑成立：柱子稳定
    }
  }

  update(dt: number): void {
    for (const f of [...this.list]) {
      f.update(dt);
      if (f.done) {
        const i = this.list.indexOf(f);
        if (i >= 0) this.list.splice(i, 1);
      }
    }
  }

  /** 运行时诊断：在途下落实体数 */
  get count(): number {
    return this.list.length;
  }
}
