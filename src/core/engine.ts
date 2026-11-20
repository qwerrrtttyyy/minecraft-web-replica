import * as THREE from 'three';
import { clamp, type System } from './types';

/**
 * 相机默认远平面。与 main.ts 的 farplane 系统共用同一常量，
 * 避免构造初值（旧为 900）与首帧收敛值不一致导致的深度精度浪费。
 */
export const CAMERA_DEFAULT_FAR = 520;

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
  /** 保存监听器引用，dispose 时解绑，避免组件化复用时累积泄漏 */
  private readonly onWindowResize: () => void;
  private readonly onOrientation: () => void;
  private readonly onVisualResize: () => void;
  private orientationTimer = 0;

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

    this.camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.08, CAMERA_DEFAULT_FAR);
    this.scene.add(this.camera);

    this.onWindowResize = () => this.resize(container);
    this.onOrientation = () => {
      clearTimeout(this.orientationTimer);
      this.orientationTimer = window.setTimeout(() => this.resize(container), 120);
    };
    this.onVisualResize = () => this.resize(container);
    addEventListener('resize', this.onWindowResize);
    addEventListener('orientationchange', this.onOrientation);
    // 移动端地址栏收放会改变可视区域，需要同步画布尺寸
    if (this.isMobile && window.visualViewport) {
      window.visualViewport.addEventListener('resize', this.onVisualResize);
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
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.orientationTimer);
    removeEventListener('resize', this.onWindowResize);
    removeEventListener('orientationchange', this.onOrientation);
    if (this.isMobile && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this.onVisualResize);
    }
    this.renderer.dispose();
  }
}