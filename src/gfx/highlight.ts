import * as THREE from 'three';

/** 准星目标方块的黑色描边（原版风格选择框） */
export class BlockHighlight {
  readonly line: THREE.LineSegments;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.006, 1.006, 1.006));
    const mat = new THREE.LineBasicMaterial({ color: 0x0a0a0a, transparent: true, opacity: 0.8 });
    this.line = new THREE.LineSegments(geo, mat);
    this.line.visible = false;
    this.line.renderOrder = 4;
    scene.add(this.line);
  }

  set(hit: { x: number; y: number; z: number } | null) {
    if (!hit) {
      this.line.visible = false;
      return;
    }
    this.line.visible = true;
    this.line.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
  }
}