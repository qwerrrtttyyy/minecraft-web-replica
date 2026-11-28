import * as THREE from 'three';
import type { TextureAtlas } from '../gfx/atlas';
import type { BlockRegistry } from '../world/blocks';
import type { World } from '../world/world';

/**
 * 点燃的 TNT：闪烁倒数 → 爆炸破坏球形区域内方块。
 * 通过事件系统触发，展示实体 + 事件 + 粒子 + 音效的协作。
 */
export class PrimedTnt {
  private mesh: THREE.Mesh;
  private mat: THREE.MeshBasicMaterial;
  private fuse = 1.6;
  private vel = new THREE.Vector3((Math.random() - 0.5) * 0.6, 2.2, (Math.random() - 0.5) * 0.6);
  done = false;

  constructor(
    private world: World,
    atlas: TextureAtlas,
    registry: BlockRegistry,
    private scene: THREE.Scene,
    private x: number,
    private y: number,
    private z: number,
    private onExplode: (x: number, y: number, z: number, radius: number) => void,
  ) {
    const def = registry.byNameGet('tnt')!;
    this.mat = new THREE.MeshBasicMaterial({ map: atlas.texture, vertexColors: true, alphaTest: 0.5 });
    this.mesh = new THREE.Mesh(atlas.makeBlockGeometry(def), this.mat);
    this.mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
    scene.add(this.mesh);
  }

  update(dt: number) {
    this.fuse -= dt;
    // 轻微抛起后落下
    this.vel.y -= 18 * dt;
    const ny = this.mesh.position.y + this.vel.y * dt;
    if (
      this.world.isSolidAt(Math.floor(this.mesh.position.x), Math.floor(ny - 0.5), Math.floor(this.mesh.position.z))
    ) {
      this.vel.y = 0;
      this.vel.x *= 0.6;
      this.vel.z *= 0.6;
    } else {
      this.mesh.position.y = ny;
    }
    this.mesh.position.x += this.vel.x * dt;
    this.mesh.position.z += this.vel.z * dt;
    // 闪烁加速
    const blink = Math.sin(this.fuse * (6 + (1.6 - this.fuse) * 14)) > 0;
    this.mat.color.setRGB(blink ? 2.2 : 1, blink ? 2.2 : 1, blink ? 2.2 : 1);
    const s = 1 + Math.max(0, 0.3 - this.fuse) * 0.8;
    this.mesh.scale.setScalar(s);
    if (this.fuse <= 0 && !this.done) {
      this.done = true;
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mat.dispose();
      this.onExplode(this.mesh.position.x, this.mesh.position.y, this.mesh.position.z, 3.4);
    }
  }

  /** 退出到标题等清场：移除网格（不爆炸、不回落） */
  remove(): void {
    if (this.done) return;
    this.done = true;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
