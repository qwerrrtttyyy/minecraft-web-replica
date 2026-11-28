/**
 * 摄影模式运行时（相机接管 + 覆盖层 + 同帧截图）。
 *
 * 世界继续模拟，只冻结玩家与昼夜循环：时间 / 天气是运行时预览，退出一律还原，
 * 不写存档、不标脏、不改区块加载中心。相机归属由 engine.cameraOwner 明确标识。
 */
import './photo.css';
import { Quaternion, Vector3, type EulerOrder } from 'three';
import { CHUNK_SIZE, clamp, type System } from '../core/types';
import type { Engine } from '../core/engine';
import type { Input } from '../input/input';
import type { Player } from '../player/player';
import type { Sky } from '../gfx/sky';
import type { WeatherSystem } from '../world/weatherSystem';
import type { WeatherKind } from '../world/weather';
import { seasonAt } from '../world/ecology';
import type { HUD } from '../ui/hud';
import {
  clampFov,
  clampPhotoPosition,
  nextTimePreset,
  nextWeather,
  photoCaption,
  photoFileName,
  TIME_PRESETS,
  TIME_PRESET_VALUES,
  WEATHER_CYCLE,
  type PhotoMetadata,
  type PhotoWeather,
  type TimePreset,
} from './photoFrames';

export interface PhotoModeOptions {
  engine: Engine;
  input: Input;
  player: Player;
  sky: Sky;
  weather: WeatherSystem;
  hud: HUD;
  /** 覆盖层挂载点（HUD 所在的 #ui） */
  uiRoot: HTMLElement;
  /** 进入条件由组装根裁定（mode / 菜单 / 面板 / 死亡） */
  canEnter(): boolean;
  /** 取景点（相机）的群系名 */
  biomeAt(x: number, z: number): string;
  /** 当前渲染距离，用于相机活动半径 */
  getRenderDistance(): number;
}

const WEATHER_LABELS: Readonly<Record<PhotoWeather, string>> = {
  clear: '晴', rain: '雨', snow: '雪', thunder: '雷暴',
};
const PRESET_LABELS: Readonly<Record<TimePreset, string>> = {
  dawn: '黎明', day: '白昼', dusk: '黄昏', night: '夜晚',
};
const LOOK_SENSITIVITY = 0.0022;
const MOVE_SPEED = 7;
const FAST_SPEED = 14;
const PITCH_LIMIT = Math.PI / 2 - 0.01;

/** 取最接近当前 dayTime 的档位，第一次按 T 会切到下一档 */
function presetFor(dayTime: number): TimePreset {
  let best: TimePreset = 'day';
  let bestDist = Infinity;
  for (const preset of TIME_PRESETS) {
    const raw = Math.abs(dayTime - TIME_PRESET_VALUES[preset]);
    const dist = Math.min(raw, 1 - raw);
    if (dist < bestDist) { best = preset; bestDist = dist; }
  }
  return best;
}

export class PhotoMode implements System {
  readonly name = 'photo';
  active = false;
  /** 进入前的 dayTime；摄影模式期间存档序列化取此值而非预览值 */
  savedDayTime: number | null = null;
  /**
   * 进入前的 dayCount；sky.update 即使 advanceTime=false 也会推进 localTime，
   * 长时间取景可能跨日，存档天数同样必须取快照（0 是合法天数，故显式判 null）。
   */
  savedDayCount: number | null = null;
  /** 最近一次导出的 data URL（供控制台 / 自动化测试读取，不写 localStorage） */
  lastDataUrl = '';

  private readonly opts: PhotoModeOptions;
  private readonly overlay: HTMLElement;
  private readonly infoCoords: HTMLElement;
  private readonly infoPlace: HTMLElement;
  private readonly infoSky: HTMLElement;
  private readonly stampButton: HTMLButtonElement;

  private readonly savedPos = new Vector3();
  private readonly savedQuat = new Quaternion();
  private savedFov = 72;
  private savedOrder: EulerOrder = 'YXZ';
  private savedAdvanceTime = true;
  private savedForced: WeatherKind | null = null;
  private savedHudHidden = false;
  private savedLocked = false;
  private previousAfterRender: (() => void) | null = null;

  /** null = 无待导出请求；boolean = 是否带水印 */
  private pendingCapture: boolean | null = null;
  /** 进入时主动 exitPointerLock 会产生一次 pause 边沿，吞掉这一条以免立刻退出 */
  private swallowLockPause = false;
  private timePreset: TimePreset = 'day';
  private weatherPreset: PhotoWeather = 'clear';
  private stamp = true;
  private yaw = 0;
  private pitch = 0;
  private dragging = false;
  private dragX = 0;
  private dragY = 0;
  private infoAcc = 0;

  constructor(opts: PhotoModeOptions) {
    this.opts = opts;
    this.overlay = document.createElement('div');
    this.overlay.id = 'photo-overlay';
    this.overlay.className = 'photo-overlay';
    this.overlay.style.display = 'none';
    this.overlay.innerHTML = `
      <div class="photo-info mc-panel">
        <div class="photo-title">摄影模式</div>
        <div class="photo-line" data-photo="coords"></div>
        <div class="photo-line" data-photo="place"></div>
        <div class="photo-line" data-photo="sky"></div>
      </div>
      <div class="photo-actions mc-panel">
        <button type="button" data-photo-action="capture">拍摄</button>
        <button type="button" data-photo-action="stamp">水印：开</button>
        <button type="button" data-photo-action="time">时刻</button>
        <button type="button" data-photo-action="weather">天气</button>
        <button type="button" data-photo-action="fovMinus" aria-label="缩小视场角">−</button>
        <button type="button" data-photo-action="fovPlus" aria-label="放大视场角">+</button>
        <button type="button" data-photo-action="exit">退出</button>
      </div>
      <div class="photo-hints mc-panel">
        <div>WASD 平移 · 空格 / Shift 升降 · 拖动转向 · 滚轮调整 FOV</div>
        <div>T 时刻 · Y 天气 · S 水印 · 回车拍摄 · P / Esc 退出</div>
        <div>自由相机：已加载区域内</div>
      </div>`;
    opts.uiRoot.appendChild(this.overlay);
    this.infoCoords = this.overlay.querySelector('[data-photo="coords"]')!;
    this.infoPlace = this.overlay.querySelector('[data-photo="place"]')!;
    this.infoSky = this.overlay.querySelector('[data-photo="sky"]')!;
    this.stampButton = this.overlay.querySelector('[data-photo-action="stamp"]')!;

    this.overlay.addEventListener('click', (e) => {
      if (!this.active) return;
      const button = (e.target as HTMLElement).closest<HTMLElement>('[data-photo-action]');
      if (!button) return;
      switch (button.dataset.photoAction) {
        case 'capture': this.requestCapture(this.stamp); break;
        case 'stamp': this.toggleStamp(); break;
        case 'time': this.setTimePreset(); break;
        case 'weather': this.cycleWeather(); break;
        case 'fovMinus': this.changeFov(-5); break;
        case 'fovPlus': this.changeFov(5); break;
        case 'exit': this.exit(); break;
      }
    });

    // T / Y / S / 回车走轻量监听，不占用 gameplay 按键表；仅摄影模式激活时生效。
    addEventListener('keydown', this.onKeyDown);
    const canvas = opts.engine.renderer.domElement;
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    // 拖动转向自己处理：不能让 Input 的 mousedown 重新申请指针锁（摄影模式已主动释放）。
    canvas.addEventListener('mousedown', this.onMouseDown, { capture: true });
    addEventListener('mousemove', this.onMouseMove);
    addEventListener('mouseup', this.onMouseUp);
  }

  /** 进入摄影模式；条件不满足时静默返回 false（不改变任何状态） */
  enter(): boolean {
    if (this.active || !this.opts.canEnter()) return false;
    const { engine, sky, weather, hud, input } = this.opts;
    const { camera } = engine;

    this.savedPos.copy(camera.position);
    this.savedQuat.copy(camera.quaternion);
    this.savedFov = camera.fov;
    this.savedOrder = camera.rotation.order;
    this.savedDayTime = sky.dayTime;
    this.savedDayCount = sky.dayCount;
    this.savedAdvanceTime = sky.advanceTime;
    this.savedForced = weather.forced;
    this.savedHudHidden = hud.hudHidden;
    this.savedLocked = document.pointerLockElement !== null;
    this.previousAfterRender = engine.onAfterRender;

    this.timePreset = presetFor(sky.dayTime);
    const currentWeather = weather.forced ?? weather.current.kind;
    this.weatherPreset = WEATHER_CYCLE.includes(currentWeather as PhotoWeather)
      ? currentWeather as PhotoWeather : 'clear';
    this.stamp = true;
    this.stampButton.textContent = '水印：开';
    this.pendingCapture = null;
    this.lastDataUrl = '';
    this.swallowLockPause = this.savedLocked;
    this.yaw = camera.rotation.y;
    this.pitch = camera.rotation.x;
    this.infoAcc = 0;

    this.active = true;
    engine.cameraOwner = 'photo';
    sky.advanceTime = false;
    sky.setTime(this.savedDayTime, this.savedDayCount);
    if (!hud.hudHidden) hud.toggleHudHidden();
    input.reset();
    input.exitLock();
    engine.onAfterRender = () => this.flushCapture();
    this.overlay.style.display = 'block';
    this.refreshOverlay();
    return true;
  }

  /**
   * 退出并还原全部接管的状态。
   * @param restoreLock 死亡 / 回标题时不应重新申请指针锁
   */
  exit(restoreLock = true): void {
    if (!this.active) return;
    const { engine, sky, weather, hud, input } = this.opts;
    const { camera } = engine;
    this.active = false;
    engine.cameraOwner = null;
    engine.onAfterRender = this.previousAfterRender;
    this.previousAfterRender = null;

    sky.advanceTime = this.savedAdvanceTime;
    // setTime 同时恢复 localTime，避免摄影期间 sky.update 推进 dayCount 造成跨日漂移
    sky.setTime(this.savedDayTime ?? sky.dayTime, this.savedDayCount ?? sky.dayCount);
    weather.forced = this.savedForced;
    if (hud.hudHidden !== this.savedHudHidden) hud.toggleHudHidden();
    camera.position.copy(this.savedPos);
    camera.quaternion.copy(this.savedQuat);
    camera.rotation.setFromQuaternion(this.savedQuat, this.savedOrder);
    camera.fov = this.savedFov;
    camera.updateProjectionMatrix();

    this.overlay.style.display = 'none';
    this.pendingCapture = null;
    this.swallowLockPause = false;
    this.savedDayTime = null;
    this.savedDayCount = null;
    this.dragging = false;
    input.reset();
    if (restoreLock && this.savedLocked) input.requestLock();
  }

  /** 组装根用于忽略进入时 exitPointerLock 产生的那一条伪 pause 边沿 */
  consumeLockPause(): boolean {
    if (!this.swallowLockPause) return false;
    this.swallowLockPause = false;
    return true;
  }

  /** System 回调：摄影模式激活时驱动自由相机（玩家已被组装根冻结） */
  update(dt: number): void {
    if (!this.active) return;
    const { camera } = this.opts.engine;
    const [lookX, lookY] = this.opts.input.consumeLook();
    if (lookX !== 0 || lookY !== 0) {
      this.yaw -= lookX * LOOK_SENSITIVITY;
      this.pitch = clamp(this.pitch - lookY * LOOK_SENSITIVITY, -PITCH_LIMIT, PITCH_LIMIT);
      camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    }

    const input = this.opts.input;
    // Input.jumpHeld / sneakHeld 是从未赋值的旧字段，实时状态取 jump / sneak getter
    // （它们同时覆盖键盘、触控与手柄），保留旧字段只作兼容或注入测试。
    const rise = (input.jump || input.jumpHeld ? 1 : 0) -
      (input.sneak || input.sneakHeld ? 1 : 0);
    const mx = input.moveX;
    const mz = input.moveZ;
    if (mx !== 0 || mz !== 0 || rise !== 0) {
      const speed = (input.sprint ? FAST_SPEED : MOVE_SPEED) * dt;
      const s = Math.sin(this.yaw);
      const c = Math.cos(this.yaw);
      let dx = (-s * mz + c * mx) * speed;
      let dz = (-c * mz - s * mx) * speed;
      // 斜向不许比直向快：只钳制水平分量，升降速度独立
      const len = Math.hypot(dx, dz);
      if (len > speed) { dx *= speed / len; dz *= speed / len; }
      camera.position.x += dx;
      camera.position.z += dz;
      camera.position.y += rise * speed;
      const radius = Math.max(0, (this.opts.getRenderDistance() - 1) * CHUNK_SIZE);
      const clamped = clampPhotoPosition(camera.position, this.opts.player.pos, radius);
      camera.position.x = clamped.x;
      camera.position.z = clamped.z;
    }

    this.infoAcc += dt;
    if (this.infoAcc >= 0.2) { this.infoAcc = 0; this.refreshOverlay(); }
  }

  /** 只排队，不在帧外读像素（WebGL 未开 preserveDrawingBuffer） */
  requestCapture(withStamp: boolean): void {
    if (!this.active) return;
    this.pendingCapture = withStamp;
  }

  setTimePreset(): void {
    if (!this.active) return;
    this.timePreset = nextTimePreset(this.timePreset);
    this.opts.sky.setTime(TIME_PRESET_VALUES[this.timePreset], this.opts.sky.dayCount);
    this.refreshOverlay();
  }

  cycleWeather(): void {
    if (!this.active) return;
    this.weatherPreset = nextWeather(this.weatherPreset);
    this.opts.weather.forced = this.weatherPreset;
    this.refreshOverlay();
  }

  toggleStamp(): void {
    if (!this.active) return;
    this.stamp = !this.stamp;
    this.stampButton.textContent = `水印：${this.stamp ? '开' : '关'}`;
  }

  /** 滚轮 / 移动端按钮共用：FOV 走 photoFrames 的同一钳制函数 */
  changeFov(delta: number): void {
    if (!this.active) return;
    const { camera } = this.opts.engine;
    camera.fov = clampFov(camera.fov + delta);
    camera.updateProjectionMatrix();
    this.refreshOverlay();
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.active || e.repeat) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    switch (e.code) {
      case 'KeyT': e.preventDefault(); this.setTimePreset(); break;
      case 'KeyY': e.preventDefault(); this.cycleWeather(); break;
      case 'KeyS': this.toggleStamp(); break;
      case 'Enter':
      case 'NumpadEnter': e.preventDefault(); this.requestCapture(this.stamp); break;
    }
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.active) return;
    e.preventDefault();
    this.changeFov(e.deltaY > 0 ? -2 : 2);
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (!this.active || e.button !== 0) return;
    // 阻止 Input 的 mousedown 再次申请指针锁：摄影模式用拖拽转向
    e.stopImmediatePropagation();
    e.preventDefault();
    this.dragging = true;
    this.dragX = e.clientX;
    this.dragY = e.clientY;
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.active || !this.dragging) return;
    this.opts.input.addLook(e.clientX - this.dragX, e.clientY - this.dragY);
    this.dragX = e.clientX;
    this.dragY = e.clientY;
  };

  private readonly onMouseUp = (): void => { this.dragging = false; };

  private weatherLabel(): string {
    const kind = this.opts.weather.forced ?? this.opts.weather.current.kind;
    return WEATHER_LABELS[kind as PhotoWeather] ?? '晴';
  }

  private metadata(): PhotoMetadata {
    const p = this.opts.engine.camera.position;
    return {
      biome: this.opts.biomeAt(p.x, p.z),
      season: seasonAt(this.opts.sky.dayCount),
      weather: this.weatherLabel(),
      time: this.opts.sky.timeString(),
      x: p.x, y: p.y, z: p.z,
      date: new Date(),
    };
  }

  private refreshOverlay(): void {
    if (!this.active) return;
    const meta = this.metadata();
    const n = (v: number) => v.toFixed(1);
    this.infoCoords.textContent =
      `坐标 (${n(meta.x)}, ${n(meta.y)}, ${n(meta.z)}) · FOV ${Math.round(this.opts.engine.camera.fov)}`;
    this.infoPlace.textContent = `群系 ${meta.biome} · 季节 ${meta.season}`;
    this.infoSky.textContent =
      `天气 ${meta.weather} · 时刻 ${meta.time} · 档位 ${PRESET_LABELS[this.timePreset]}`;
  }

  /** engine.onAfterRender：紧跟 renderer.render 的同一帧取像素并导出 */
  private flushCapture(): void {
    if (!this.active || this.pendingCapture === null) return;
    const withStamp = this.pendingCapture;
    this.pendingCapture = null;
    try {
      const source = this.opts.engine.renderer.domElement;
      const canvas = document.createElement('canvas');
      canvas.width = source.width;
      canvas.height = source.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas 不可用');
      ctx.drawImage(source, 0, 0);

      const meta = this.metadata();
      if (withStamp) {
        const text = photoCaption(meta);
        const fontSize = Math.max(13, Math.round(canvas.width / 70));
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textBaseline = 'bottom';
        const pad = Math.round(fontSize * 0.6);
        const width = Math.min(canvas.width, ctx.measureText(text).width + pad * 2);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(0, canvas.height - fontSize - pad * 2, width, fontSize + pad * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(text, pad, canvas.height - pad);
      }

      const url = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.download = photoFileName(meta);
      link.href = url;
      document.body.appendChild(link);
      link.click();
      link.remove();
      this.lastDataUrl = url;
    } catch (e) {
      // 导出失败不能打断主循环，也不能抛到 rAF 里
      console.warn('截图失败', e);
      this.opts.hud.toast('截图失败');
    }
  }
}
