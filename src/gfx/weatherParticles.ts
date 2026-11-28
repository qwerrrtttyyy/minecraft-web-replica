import * as THREE from 'three';
import { WEATHER } from '../core/tuning';
import type { System } from '../core/types';
import type { WeatherSnapshot } from '../world/weather';

/**
 * 天气降水粒子：相机跟随的盒体循环复用。
 *
 * 刻意独立于 gfx/particles.ts —— 后者是"方块碎屑 / 火星"语义：
 * 重力固定 -16、单一材质尺寸、满池直接丢弃，不适合长时间持续的雨雪。
 */
const BOX = 16;

interface LayerOptions {
  capacity: number;
  size: number;
  color: number;
  opacity: number;
  fallMin: number;
  fallMax: number;
  drift: number;
}

class PrecipLayer {
  readonly points: THREE.Points;
  private readonly geo: THREE.BufferGeometry;
  private readonly positions: Float32Array;
  private readonly speeds: Float32Array;
  private readonly capacity: number;
  private readonly fallMin: number;
  private readonly fallMax: number;
  private readonly drift: number;
  private count = 0;

  constructor(scene: THREE.Scene, opts: LayerOptions) {
    this.capacity = opts.capacity;
    this.fallMin = opts.fallMin;
    this.fallMax = opts.fallMax;
    this.drift = opts.drift;
    this.positions = new Float32Array(this.capacity * 3);
    this.speeds = new Float32Array(this.capacity);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    const mat = new THREE.PointsMaterial({
      size: opts.size,
      color: opts.color,
      sizeAttenuation: true,
      transparent: true,
      opacity: opts.opacity,
      depthWrite: false,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.points.visible = false;
    scene.add(this.points);
  }

  private reset(i: number, cx: number, cy: number, cz: number, top: boolean): void {
    const i3 = i * 3;
    this.positions[i3] = cx + (Math.random() - 0.5) * BOX * 2;
    this.positions[i3 + 1] = top ? cy + BOX : cy + (Math.random() - 0.5) * BOX * 2;
    this.positions[i3 + 2] = cz + (Math.random() - 0.5) * BOX * 2;
    this.speeds[i] = this.fallMin + Math.random() * (this.fallMax - this.fallMin);
  }

  update(dt: number, cam: THREE.Vector3, active: boolean, intensity: number): void {
    const target = active ? Math.floor(this.capacity * Math.min(1, Math.max(0, intensity))) : 0;
    if (target === 0) {
      this.count = 0;
      this.points.visible = false;
      this.geo.setDrawRange(0, 0);
      return;
    }
    this.points.visible = true;
    // 新激活的粒子散布在盒体内；数量随强度平滑增减，无每帧分配
    for (let i = this.count; i < target; i++) this.reset(i, cam.x, cam.y, cam.z, false);
    this.count = target;
    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      this.positions[i3 + 1] -= this.speeds[i] * dt;
      this.positions[i3] += this.drift * dt;
      if (
        this.positions[i3 + 1] < cam.y - BOX ||
        Math.abs(this.positions[i3] - cam.x) > BOX ||
        Math.abs(this.positions[i3 + 2] - cam.z) > BOX
      ) {
        this.reset(i, cam.x, cam.y, cam.z, true);
      }
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.geo.setDrawRange(0, this.count);
  }
}

export class WeatherParticles implements System {
  readonly name = 'weatherParticles';
  private readonly rain: PrecipLayer;
  private readonly snow: PrecipLayer;
  private readonly camera: THREE.Camera;
  private current: WeatherSnapshot | null = null;

  constructor(scene: THREE.Scene, camera: THREE.Camera, isMobile = false) {
    this.camera = camera;
    this.rain = new PrecipLayer(scene, {
      capacity: isMobile ? 90 : WEATHER.rainBudget,
      size: 0.045,
      color: 0xbcd8ff,
      opacity: 0.75,
      fallMin: 14,
      fallMax: 22,
      drift: 0.6,
    });
    this.snow = new PrecipLayer(scene, {
      capacity: isMobile ? 60 : WEATHER.snowBudget,
      size: 0.09,
      color: 0xffffff,
      opacity: 0.9,
      fallMin: 1.2,
      fallMax: 2.6,
      drift: 0.9,
    });
  }

  /** 由天气系统每帧写入同一份快照 */
  setWeather(w: WeatherSnapshot): void {
    this.current = w;
  }

  update(dt: number): void {
    const w = this.current;
    const cam = this.camera.position;
    const isRain = !!w && w.form === 'rain';
    const isSnow = !!w && w.form === 'snow';
    const intensity = w?.intensity ?? 0;
    this.rain.update(dt, cam, isRain, intensity);
    this.snow.update(dt, cam, isSnow, intensity);
  }
}
