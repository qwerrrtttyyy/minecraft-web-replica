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
  /** 反转 Y 轴（设置页可调） */
  invertY = false;
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
  /**
   * 锁定刚生效时要丢弃一次 mousemove。
   * Chromium 在 pointerlock 建立的瞬间会补发一个「合成 movement」
   * （实测可达上百像素），导致刚点进游戏视角就猛地一沉 —— 玩家感知为「镜头乱跳」。
   */
  private ignoreNextMove = false;
  private lastClientX = 0;
  private lastClientY = 0;

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
      if (document.pointerLockElement !== canvas && e.button === 0) {
        this.requestLock();
        // 同时准备拖拽降级：iframe / 无用户手势下锁定会被拒，本次拖动仍可转视角
        this.dragging = true;
        this.lastClientX = e.clientX;
        this.lastClientY = e.clientY;
      }
      if (e.button === 0) this.breakHeld = true;
      else if (e.button === 2) this.placeHeld = true;
      else if (e.button === 1) {
        e.preventDefault();
        this.edges.push({ type: 'pick' });
      }
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) {
        this.breakHeld = false;
        this.dragging = false;
      }
      if (e.button === 2) this.placeHeld = false;
    });
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === canvas) {
        if (this.ignoreNextMove) { this.ignoreNextMove = false; return; }
        // 单帧位移上限：合成事件或驱动异常时防止视角瞬移
        this.lookX += Math.max(-400, Math.min(400, e.movementX));
        this.lookY += Math.max(-400, Math.min(400, e.movementY));
      } else if (this.dragging) {
        // Pointer Lock 不可用时的降级路径（v1.1.2 里 lockFailed/dragging 是死代码）
        this.lookX += e.clientX - this.lastClientX;
        this.lookY += e.clientY - this.lastClientY;
        this.lastClientX = e.clientX;
        this.lastClientY = e.clientY;
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
      if (locked) {
        this.lockFailed = false;
        this.dragging = false;
        // 锁定生效的第一帧丢弃浏览器补发的合成位移
        if (!this.wasLocked) this.ignoreNextMove = true;
      }
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
    const gameKeys = [
      'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab',
      'F1', 'F3', 'F5', 'KeyE', 'KeyF', 'Digit1', 'Digit2', 'Digit3', 'Digit4',
      'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9',
    ];
    if (this.enabled && gameKeys.includes(e.code)) e.preventDefault();
    // v1.3.2 修复：keyup 必须无条件处理。
    // 旧实现先判断 enabled —— 暂停 / 死亡期间松开的 W、Shift 等键会永远留在
    // keys 集合里，恢复游戏后角色会自己持续移动，直到重新按一次再松开。
    if (!down) {
      this.keys.delete(e.code);
      if (e.code === 'KeyW') this.sprintLatch = false;
      return;
    }
    if (!this.enabled) return;
    if (e.repeat) return;

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
  }

  /**
   * 暂停 / 死亡 / 切出时清空所有瞬时输入。
   * 与 keyup 兜底配合，保证恢复游戏后不会残留移动、潜行或挖掘状态。
   */
  reset() {
    this.keys.clear();
    this.sprintLatch = false;
    this.breakHeld = false;
    this.placeHeld = false;
    this.dragging = false;
    this.lookX = 0;
    this.lookY = 0;
    this.touchMoveX = 0;
    this.touchMoveZ = 0;
    this.touchSprint = false;
    this.touchJump = false;
    this.touchSneak = false;
    this.touchBreak = false;
    this.touchPlace = false;
  }

  /** 运行时诊断：当前仍处于按下状态的键盘按键 */
  get pressedKeys(): string[] {
    return [...this.keys];
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
    const dy = this.invertY ? -this.lookY : this.lookY;
    const v: [number, number] = [this.lookX * this.sensitivity, dy * this.sensitivity];
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

  /** 供调试面板 / 自动化测试判断当前是否处于拖拽降级 */
  get pointerLockFailed(): boolean {
    return this.lockFailed;
  }

  requestLock() {
    if (this.isMobile || document.pointerLockElement === this.canvas) return;
    try {
      // 现代浏览器返回 Promise；无用户手势 / iframe 下会 reject。
      // v1.1.2 未捕获该 reject，冒出 NotAllowedError 未处理异常。
      const result = this.canvas.requestPointerLock?.() as unknown as Promise<void> | undefined;
      if (result && typeof result.catch === 'function') {
        result.catch(() => { this.lockFailed = true; });
      }
    } catch {
      // 同步抛错（旧实现）也要转入降级，而不是冒泡成页面异常
      this.lockFailed = true;
    }
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock?.();
  }
}