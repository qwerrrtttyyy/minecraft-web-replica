import * as THREE from 'three';
import { clamp, type System } from './types';

/**
 * 相机默认远平面。与 main.ts 的 farplane 系统共用同一常量，
 * 避免构造初值（旧为 900）与首帧收敛值不一致导致的深度精度浪费。
 */
export const CAMERA_DEFAULT_FAR = 520;

/**
 * 抗锯齿档位（实验设置，URL ?aa= 选择）：
 * - off：原生分辨率，不做抗锯齿（默认，与 v1.5.1 行为一致）
 * - msaa：创建上下文时打开硬件 MSAA，成本主要在显存与带宽
 * - ssaa：按 SSAA_SCALE 超采样后降回原生分辨率，质量最好、片段成本最高
 */
export type AAMode = 'off' | 'msaa' | 'ssaa';

export const AA_MODES: readonly AAMode[] = ['off', 'msaa', 'ssaa'];
/** ssaa 的分辨率倍率 */
export const SSAA_SCALE = 1.5;
/** 像素比硬上限：避免 ssaa 在高 DPI 屏上把填充率放大到不可玩 */
export const MAX_PIXEL_RATIO = 2.5;
/** 动态分辨率下限： governor 最低降到 25%（移动端保命档），更低会糊到无法辨认 */
export const MIN_QUALITY_SCALE = 0.25;
/** 动态分辨率上限：固定档最高 100%，ssaa 的额外像素由 aaMode 自己乘 */
export const MAX_QUALITY_SCALE = 1.5;

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
  /** 抗锯齿档位（msaa 在创建上下文时生效；ssaa 走像素比） */
  readonly aaMode: AAMode;
  private container: HTMLElement;
  private clock = new THREE.Clock();
  private raf = 0;
  private disposed = false;
  private fpsAcc = 0;
  private fpsCount = 0;
  /** 每帧原始（未钳制）帧耗时回调：供动态分辨率等观察者使用，不受 50ms 上限影响 */
  onRawFrame: ((dtSeconds: number) => void) | null = null;
  /** 保存监听器引用，dispose 时解绑，避免组件化复用时累积泄漏 */
  private readonly onWindowResize: () => void;
  private readonly onOrientation: () => void;
  private readonly onVisualResize: () => void;
  private readonly onContextLost: (e: Event) => void;
  private readonly onContextRestored: () => void;
  /** H06：WebGL 上下文丢失期间暂停渲染，恢复后自动继续（否则画面永久冻结、rAF 空转） */
  private contextLost = false;
  private orientationTimer = 0;

  constructor(container: HTMLElement, options: { aa?: AAMode } = {}) {
    // 粗指针优先；触摸设备再要求「无悬停」，避免触摸屏笔记本被当成手机
    this.isMobile =
      matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && matchMedia('(hover: none)').matches);
    // MSAA 只能在创建上下文时决定，运行期改不了 —— 因此档位由启动参数选定
    this.aaMode = AA_MODES.includes(options.aa as AAMode) ? (options.aa as AAMode) : 'off';
    this.renderer = new THREE.WebGLRenderer({
      antialias: this.aaMode === 'msaa',
      powerPreference: 'high-performance',
    });
    this.container = container;
    this.basePixelRatio = Math.min(devicePixelRatio || 1, this.isMobile ? 1.5 : 2);
    this.applyPixelRatio();
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
    this.onContextLost = (e) => {
      // 移动端切后台 / 显存压力会触发上下文丢失：preventDefault 阻止浏览器放弃恢复
      e.preventDefault();
      this.contextLost = true;
    };
    this.onContextRestored = () => {
      this.contextLost = false;
      this.clock.getDelta(); // 丢弃停顿期间积累的 dt，避免恢复瞬间跳帧
    };
    addEventListener('resize', this.onWindowResize);
    addEventListener('orientationchange', this.onOrientation);
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost);
    this.renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored);
    // 移动端地址栏收放会改变可视区域，需要同步画布尺寸
    if (this.isMobile && window.visualViewport) {
      window.visualViewport.addEventListener('resize', this.onVisualResize);
    }
  }

  /** 动态分辨率：FPS 不足时降低渲染像素倍率（桌面 / 移动端共用同一 governor 驱动） */
  setQualityScale(scale: number) {
    const s = clamp(scale, MIN_QUALITY_SCALE, MAX_QUALITY_SCALE);
    if (Math.abs(s - this.qualityScale) < 0.02) return;
    this.qualityScale = s;
    this.applyPixelRatio();
    this.renderer.setSize(this.container.clientWidth || innerWidth, this.container.clientHeight || innerHeight);
  }

  /** 像素比 = 设备基础 × 省电档位 × 超采样档位，钳到硬上限 */
  private applyPixelRatio() {
    const ssaa = this.aaMode === 'ssaa' ? SSAA_SCALE : 1;
    this.renderer.setPixelRatio(clamp(this.basePixelRatio * this.qualityScale * ssaa, 0.5, MAX_PIXEL_RATIO));
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
      this.onRawFrame?.(rawDt);
      const dt = clamp(rawDt, 0.0001, 0.05);
      this.fpsAcc += rawDt;
      this.fpsCount++;
      if (this.fpsAcc >= 0.5) {
        this.fps = Math.round(this.fpsCount / this.fpsAcc);
        this.fpsAcc = 0;
        this.fpsCount = 0;
      }
      if (!this.paused && !this.contextLost) {
        this.elapsed += dt;
        for (const s of this.systems) s.update(dt, this.elapsed);
      }
      if (this.contextLost) return; // 上下文丢失：不渲染，恢复后自动继续
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
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);
    if (this.isMobile && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this.onVisualResize);
    }
    this.renderer.dispose();
  }
}
