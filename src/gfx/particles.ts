import * as THREE from 'three';
import type { System } from '../core/types';

/**
 * 轻量粒子池：单个 Points 对象，方块碎屑 / 爆炸火花。
 * 方形粒子贴近原版风格。
 */
export class Particles implements System {
  readonly name = 'particles';
  /** 设置页「粒子效果」开关：关闭时不再产生新粒子，已有粒子立即清空 */
  enabled = true;
  private capacity: number;
  private count = 0;
  private positions: Float32Array;
  private colors: Float32Array;
  private vels: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private geo: THREE.BufferGeometry;
  private points: THREE.Points;

  constructor(scene: THREE.Scene, capacity = 800) {
    this.capacity = capacity;
    this.positions = new Float32Array(this.capacity * 3);
    this.colors = new Float32Array(this.capacity * 3);
    this.vels = new Float32Array(this.capacity * 3);
    this.life = new Float32Array(this.capacity);
    this.maxLife = new Float32Array(this.capacity);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    const mat = new THREE.PointsMaterial({
      size: 0.13, vertexColors: true, sizeAttenuation: true, depthWrite: false,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);
  }

  burst(x: number, y: number, z: number, color: [number, number, number], n: number, spread: number, speed: number) {
    if (!this.enabled) return;
    for (let i = 0; i < n; i++) {
      if (this.count >= this.capacity) return;
      const idx = this.count++;
      const i3 = idx * 3;
      this.positions[i3] = x + (Math.random() - 0.5) * spread * 2;
      this.positions[i3 + 1] = y + (Math.random() - 0.5) * spread * 2;
      this.positions[i3 + 2] = z + (Math.random() - 0.5) * spread * 2;
      this.vels[i3] = (Math.random() - 0.5) * speed;
      this.vels[i3 + 1] = Math.random() * speed * 0.9 + 0.6;
      this.vels[i3 + 2] = (Math.random() - 0.5) * speed;
      const shade = 0.7 + Math.random() * 0.5;
      this.colors[i3] = Math.min(1, color[0] * shade);
      this.colors[i3 + 1] = Math.min(1, color[1] * shade);
      this.colors[i3 + 2] = Math.min(1, color[2] * shade);
      this.maxLife[idx] = this.life[idx] = 0.45 + Math.random() * 0.5;
    }
  }

  update(dt: number) {
    if (!this.enabled) {
      if (this.count > 0) {
        this.count = 0;
        this.geo.setDrawRange(0, 0);
      }
      return;
    }
    let i = 0;
    while (i < this.count) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        // 与末尾交换删除
        const last = --this.count;
        if (i !== last) {
          const i3 = i * 3, l3 = last * 3;
          for (let k = 0; k < 3; k++) {
            this.positions[i3 + k] = this.positions[l3 + k];
            this.colors[i3 + k] = this.colors[l3 + k];
            this.vels[i3 + k] = this.vels[l3 + k];
          }
          this.life[i] = this.life[last];
          this.maxLife[i] = this.maxLife[last];
        }
        continue;
      }
      const i3 = i * 3;
      this.vels[i3 + 1] -= 16 * dt;
      this.positions[i3] += this.vels[i3] * dt;
      this.positions[i3 + 1] += this.vels[i3 + 1] * dt;
      this.positions[i3 + 2] += this.vels[i3 + 2] * dt;
      const fade = this.life[i] / this.maxLife[i];
      if (fade < 0.3) {
        const f = fade / 0.3;
        // 与帧率无关的衰减（等价于 60fps 下每帧乘 0.9~1.0）
        const k = Math.pow(0.9 + f * 0.1, dt * 60);
        this.colors[i3] *= k;
        this.colors[i3 + 1] *= k;
        this.colors[i3 + 2] *= k;
      }
      i++;
    }
    this.geo.setDrawRange(0, this.count);
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }
}