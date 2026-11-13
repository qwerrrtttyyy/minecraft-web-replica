/**
 * 统一输入层：键盘 / 鼠标 / 触摸都映射到同一组动作状态，
 * gameplay 只读取这里，不关心设备差异（扩展点：可重绑定按键）。
 */

export interface InputEdge {
  type: 'slot' | 'camera' | 'debug' | 'palette' | 'pause' | 'fly' | 'pick' | 'tapBreak' | 'hud';
  value?: number;
  absolute?: boolean;
}

export class Input {
  enabled = false;
  sensitivity = 1;
  touchMoveX = 0;
  touchMoveZ = 0;
  touchSprint = false;
  jumpHeld = false;
  sneakHeld = false;
  breakHeld = false;
  placeHeld = false;

  private keys = new Set<string>();
  private lookX = 0;
  private lookY = 0;
  private edges: InputEdge[] = [];
  private wasLocked = false;
  private lastSpace = 0;
  private lastW = 0;
  private sprintLatch = false;
  private touchJump = false;
  private touchSneak = false;
  private touchBreak = false;
  private touchPlace = false;
  /** 指针锁定不可用时（iframe / 无头环境）退化为拖拽视角 */
  private lockFailed = false;
  private dragging = false;

  constructor(private canvas: HTMLCanvasElement, readonly isMobile: boolean) {
    addEventListener('keydown', (e) => this.onKey(e, true));
    addEventListener('keyup', (e) => this.onKey(e, false));
    addEventListener('blur', () => {
      this.keys.clear();
      this.breakHeld = false;
      this.placeHeld = false;
    });

    canvas.addEventListener('mousedown', (e) => {
      if (!this.enabled || this.isMobile) return;
      // 首次点击同时完成锁定与操作，避免"点一下只锁定"的空响应
      if (document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
      if (e.button === 0) this.breakHeld = true;
      else if (e.button === 2) this.placeHeld = true;
      else if (e.button === 1) {
        e.preventDefault();
        this.edges.push({ type: 'pick' });
      }
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.breakHeld = false;
      if (e.button === 2) this.placeHeld = false;
    });
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === canvas) {
        this.lookX += e.movementX;
        this.lookY += e.movementY;
      }
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.edges.push({ type: 'slot', value: e.deltaY > 0 ? 1 : -1 });
    }, { passive: false });

    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === canvas;
      // 仅当"曾经锁定过"再丢失时才暂停，避免锁定请求被拒时误暂停
      if (!this.isMobile && this.enabled && !locked && this.wasLocked) {
        this.breakHeld = false;
        this.placeHeld = false;
        this.edges.push({ type: 'pause' });
      }
      this.wasLocked = locked;
    });
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    if (e.code === 'Escape') {
      if (down) this.edges.push({ type: 'pause' });
      return;
    }
    if (!this.enabled) return;
    const gameKeys = [
      'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab',
      'F1', 'F3', 'F5', 'KeyE', 'KeyF', 'Digit1', 'Digit2', 'Digit3', 'Digit4',
      'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9',
    ];
    if (gameKeys.includes(e.code)) e.preventDefault();
    if (down && e.repeat) return;

    if (down) {
      this.keys.add(e.code);
      const now = performance.now();
      if (e.code === 'Space') {
        if (now - this.lastSpace < 280) this.edges.push({ type: 'fly' });
        this.lastSpace = now;
      }
      if (e.code === 'KeyW') {
        if (now - this.lastW < 280) this.sprintLatch = true;
        this.lastW = now;
      }
      if (e.code.startsWith('Digit')) {
        const n = Number(e.code.slice(5));
        if (n >= 1 && n <= 9) this.edges.push({ type: 'slot', value: n - 1, absolute: true } as InputEdge);
      }
      if (e.code === 'F5') this.edges.push({ type: 'camera' });
      if (e.code === 'F3') this.edges.push({ type: 'debug' });
      if (e.code === 'KeyE') this.edges.push({ type: 'palette' });
      if (e.code === 'KeyF') this.edges.push({ type: 'fly' });
      if (e.code === 'F1') this.edges.push({ type: 'hud' });
    } else {
      this.keys.delete(e.code);
      if (e.code === 'KeyW') this.sprintLatch = false;
    }
  }

  /** 触摸视角增量 */
  addLook(dx: number, dy: number) {
    this.lookX += dx;
    this.lookY += dy;
  }

  setTouchButtons(opts: { jump?: boolean; sneak?: boolean; break?: boolean; place?: boolean }) {
    if (opts.jump !== undefined) this.touchJump = opts.jump;
    if (opts.sneak !== undefined) this.touchSneak = opts.sneak;
    if (opts.break !== undefined) this.touchBreak = opts.break;
    if (opts.place !== undefined) this.touchPlace = opts.place;
  }

  pushEdge(e: InputEdge) {
    this.edges.push(e);
  }

  consumeLook(): [number, number] {
    const v: [number, number] = [this.lookX * this.sensitivity, this.lookY * this.sensitivity];
    this.lookX = 0;
    this.lookY = 0;
    return v;
  }

  consumeEdges(): InputEdge[] {
    const out = this.edges;
    this.edges = [];
    return out;
  }

  get moveX(): number {
    const kb = (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) -
      (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0);
    return Math.max(-1, Math.min(1, kb + this.touchMoveX));
  }

  get moveZ(): number {
    const kb = (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) -
      (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0);
    return Math.max(-1, Math.min(1, kb + this.touchMoveZ));
  }

  get jump(): boolean {
    return this.keys.has('Space') || this.touchJump;
  }

  get sneak(): boolean {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.touchSneak;
  }

  get sprint(): boolean {
    return this.keys.has('ControlLeft') || this.keys.has('ControlRight') || this.sprintLatch || this.touchSprint;
  }

  get breaking(): boolean {
    return this.breakHeld || this.touchBreak;
  }

  get placing(): boolean {
    return this.placeHeld || this.touchPlace;
  }

  requestLock() {
    if (!this.isMobile) this.canvas.requestPointerLock?.();
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock?.();
  }
}