import * as THREE from 'three';
import type { System } from './types';
import { clamp } from './types';

/**
 * 引擎主循环：渲染器、场景、相机、系统调度、尺寸自适应。
 * 扩展点：engine.addSystem() 可挂入任意自定义更新逻辑。
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly systems: System[] = [];
  readonly isMobile: boolean;

  paused = false;
  elapsed = 0;
  fps = 60;

  readonly basePixelRatio: number;
  /** 当前渲染分辨率倍率（1 = 基础，越低越省电） */
  qualityScale = 1;
  private container: HTMLElement;
  private clock = new THREE.Clock();
  private raf = 0;
  private disposed = false;
  private fpsAcc = 0;
  private fpsCount = 0;

  constructor(container: HTMLElement) {
    // 粗指针优先；触摸设备再要求「无悬停」，避免触摸屏笔记本被当成手机
    this.isMobile = matchMedia('(pointer: coarse)').matches ||
      (navigator.maxTouchPoints > 0 && matchMedia('(hover: none)').matches);
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
    });
    this.container = container;
    this.basePixelRatio = Math.min(devicePixelRatio || 1, this.isMobile ? 1.5 : 2);
    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.setSize(container.clientWidth || innerWidth, container.clientHeight || innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.08, 900);
    this.scene.add(this.camera);

    addEventListener('resize', () => this.resize(container));
    addEventListener('orientationchange', () => setTimeout(() => this.resize(container), 120));
    // 移动端地址栏收放会改变可视区域，需要同步画布尺寸
    if (this.isMobile && window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => this.resize(container));
    }
  }

  /** 动态分辨率：FPS 不足时降低渲染像素倍率（移动端主要省电/提帧手段） */
  setQualityScale(scale: number) {
    const s = clamp(scale, 0.5, 1);
    if (Math.abs(s - this.qualityScale) < 0.02) return;
    this.qualityScale = s;
    this.renderer.setPixelRatio(this.basePixelRatio * s);
    this.renderer.setSize(this.container.clientWidth || innerWidth, this.container.clientHeight || innerHeight);
  }

  resize(container: HTMLElement = this.container) {
    const w = container.clientWidth || innerWidth;
    const h = container.clientHeight || innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  addSystem<T extends System>(system: T): T {
    this.systems.push(system);
    return system;
  }

  start() {
    this.clock.start();
    const loop = () => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      const rawDt = this.clock.getDelta();
      const dt = clamp(rawDt, 0.0001, 0.05);
      this.fpsAcc += rawDt;
      this.fpsCount++;
      if (this.fpsAcc >= 0.5) {
        this.fps = Math.round(this.fpsCount / this.fpsAcc);
        this.fpsAcc = 0;
        this.fpsCount = 0;
      }
      if (!this.paused) {
        this.elapsed += dt;
        for (const s of this.systems) s.update(dt, this.elapsed);
      }
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.renderer.dispose();
  }
}