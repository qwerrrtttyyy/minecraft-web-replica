/**
 * 统一输入层：键盘 / 鼠标 / 触摸 / 手柄都映射到同一组动作状态，
 * gameplay 只读取这里，不关心设备差异。
 *
 * 按键可重绑定（见 keybindings.ts）；手柄用 Gamepad API 在 rAF 里轮询，
 * 摇杆映射移动/视角、按钮映射跳跃/蹲/破坏/放置/切槽/菜单。
 */

import {
  type GameAction, type KeyBindings, ACTION_KEYS,
  DEFAULT_BINDINGS, loadBindings, saveBindings,
} from './keybindings';

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

  /** 动作 → KeyboardEvent.code 映射，可运行时重绑定并持久化 */
  private bindings: KeyBindings;
  private keys = new Set<string>();
  private lookX = 0;
  private lookY = 0;
  private edges: InputEdge[] = [];
  // ---- 手柄状态（Gamepad API 标准映射）----
  private gamepadIndex = -1;
  /** 上一帧各按钮的按下状态，用于边沿触发（切槽/菜单/调试只触发一次） */
  private padPrevButtons: boolean[] = [];
  private padLookX = 0;
  private padLookY = 0;
  private padMoveX = 0;
  private padMoveZ = 0;
  private padJump = false;
  private padSneak = false;
  private padSprint = false;
  private padBreak = false;
  private padPlace = false;
  /** 手柄是否连接过（用于一次性 toast 提示） */
  private gamepadNotified = false;
  onGamepadConnected: ((label: string) => void) | null = null;
  private wasLocked = false;
  /** 跳跃输入缓冲：按下瞬间记时，落地前 120ms 内的提前按键仍然生效 */
  private jumpPressedAt = -Infinity;
  private jumpPrev = false;
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
    this.bindings = loadBindings();
    addEventListener('keydown', (e) => this.onKey(e, true));
    addEventListener('keyup', (e) => this.onKey(e, false));
    addEventListener('blur', () => {
      this.keys.clear();
      this.breakHeld = false;
      this.placeHeld = false;
    });
    // 手柄热插拔：记录索引以便 rAF 轮询；首次连接给出提示
    addEventListener('gamepadconnected', (e) => {
      this.gamepadIndex = (e as GamepadEvent).gamepad.index;
      if (!this.gamepadNotified) {
        this.gamepadNotified = true;
        this.onGamepadConnected?.((e as GamepadEvent).gamepad.id.slice(0, 32));
      }
    });
    addEventListener('gamepaddisconnected', () => {
      this.gamepadIndex = -1;
      this.padPrevButtons = [];
      this.clearPadState();
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

  /** 反查某个 code 当前绑定到哪个动作（边缘事件用） */
  private actionOf(code: string): GameAction | null {
    for (const a of ACTION_KEYS) if (this.bindings[a] === code) return a;
    return null;
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    const action = this.actionOf(e.code);
    if (action === 'pause') {
      if (down) this.edges.push({ type: 'pause' });
      return;
    }
    const gameKeys = [
      // 可绑定动作 + 固定方向键 / 数字键
      ...ACTION_KEYS.map((a) => this.bindings[a]),
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab',
      'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
      'Digit6', 'Digit7', 'Digit8', 'Digit9',
    ];
    if (this.enabled && gameKeys.includes(e.code)) e.preventDefault();
    // v1.3.2 修复：keyup 必须无条件处理。
    // 旧实现先判断 enabled —— 暂停 / 死亡期间松开的 W、Shift 等键会永远留在
    // keys 集合里，恢复游戏后角色会自己持续移动，直到重新按一次再松开。
    if (!down) {
      this.keys.delete(e.code);
      if (e.code === this.bindings.forward) this.sprintLatch = false;
      return;
    }
    if (!this.enabled) return;
    if (e.repeat) return;

    this.keys.add(e.code);
    const now = performance.now();
    if (e.code === this.bindings.jump) {
      if (now - this.lastSpace < 280) this.edges.push({ type: 'fly' });
      this.lastSpace = now;
    }
    if (e.code === this.bindings.forward) {
      if (now - this.lastW < 280) this.sprintLatch = true;
      this.lastW = now;
    }
    if (e.code.startsWith('Digit')) {
      const n = Number(e.code.slice(5));
      if (n >= 1 && n <= 9) this.edges.push({ type: 'slot', value: n - 1, absolute: true } as InputEdge);
    }
    // 边缘动作走绑定表：重绑定后 F5→任意键都生效
    switch (action) {
      case 'camera': this.edges.push({ type: 'camera' }); break;
      case 'debug': this.edges.push({ type: 'debug' }); break;
      case 'palette': this.edges.push({ type: 'palette' }); break;
      case 'fly': this.edges.push({ type: 'fly' }); break;
      case 'hud': this.edges.push({ type: 'hud' }); break;
    }
  }

  /**
   * 暂停 / 死亡 / 切出时清空所有瞬时输入。
   * 与 keyup 兜底配合，保证恢复游戏后不会残留移动、潜行或挖掘状态。
   */
  reset() {
    this.keys.clear();
    this.sprintLatch = false;
    this.jumpPressedAt = -Infinity;
    this.jumpPrev = false;
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
    this.clearPadState();
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
    const dy = this.invertY ? -(this.lookY + this.padLookY) : (this.lookY + this.padLookY);
    const v: [number, number] = [
      (this.lookX + this.padLookX) * this.sensitivity,
      dy * this.sensitivity,
    ];
    this.lookX = 0;
    this.lookY = 0;
    this.padLookX = 0;
    this.padLookY = 0;
    return v;
  }

  consumeEdges(): InputEdge[] {
    const out = this.edges;
    this.edges = [];
    return out;
  }

  get moveX(): number {
    const kb = (this.keys.has(this.bindings.right) || this.keys.has('ArrowRight') ? 1 : 0) -
      (this.keys.has(this.bindings.left) || this.keys.has('ArrowLeft') ? 1 : 0);
    return Math.max(-1, Math.min(1, kb + this.touchMoveX + this.padMoveX));
  }

  get moveZ(): number {
    const kb = (this.keys.has(this.bindings.forward) || this.keys.has('ArrowUp') ? 1 : 0) -
      (this.keys.has(this.bindings.back) || this.keys.has('ArrowDown') ? 1 : 0);
    return Math.max(-1, Math.min(1, kb + this.touchMoveZ + this.padMoveZ));
  }

  get jump(): boolean {
    return this.keys.has(this.bindings.jump) || this.touchJump || this.padJump;
  }

  /**
   * 每帧帧首采样一次跳跃：按下沿记录时间戳，落地前 ≤120ms 的提前输入仍算数。
   * 持续按住依旧返回 true（保留原版「按住连跳」行为），缓冲只补提前量。
   */
  sampleJump(now = performance.now()): boolean {
    const down = this.jump;
    if (down && !this.jumpPrev) this.jumpPressedAt = now;
    this.jumpPrev = down;
    return down || now - this.jumpPressedAt <= 120;
  }

  /** 起跳成功后清掉缓冲，避免一次提前按键在落地瞬间连跳多次 */
  consumeJumpBuffer() {
    this.jumpPressedAt = -Infinity;
  }

  get sneak(): boolean {
    // 右 Shift 恒为蹲/下降备用键（与是否重绑定左 Shift 无关）
    return this.keys.has(this.bindings.sneak) || this.keys.has('ShiftRight') ||
      this.touchSneak || this.padSneak;
  }

  get sprint(): boolean {
    // 右 Ctrl 恒为冲刺备用键
    return this.keys.has(this.bindings.sprint) || this.keys.has('ControlRight') ||
      this.sprintLatch || this.touchSprint || this.padSprint;
  }

  get breaking(): boolean {
    return this.breakHeld || this.touchBreak || this.padBreak;
  }

  get placing(): boolean {
    return this.placeHeld || this.touchPlace || this.padPlace;
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

  // ---- 手柄（Gamepad API）----

  /** 清空所有手柄derived状态（断开连接 / reset 时） */
  private clearPadState() {
    this.padLookX = this.padLookY = 0;
    this.padMoveX = this.padMoveZ = 0;
    this.padJump = this.padSneak = this.padSprint = false;
    this.padBreak = this.padPlace = false;
  }

  /**
   * 每帧轮询手柄（由主循环调用，与渲染 dt 同步）。
   *
   * 标准映射：
   *   左摇杆 → 移动；右摇杆 → 视角
   *   A(0) 跳 / B(1) 蹲 / RB(5) 冲刺 / RT(7) 破坏 / LT(6) 放置
   *   X(2) 放置备用 / LB(4) 切上一槽 / RB+方向键切槽
   *   Y(3) 方块库 / Start(9) 菜单 / Back(8) 调试 / 十字键上(12) 切换视角
   * 按钮边沿用 padPrevButtons 检测，切槽/菜单/调试只在按下瞬间触发一次。
   */
  pollGamepad(dt: number) {
    if (this.gamepadIndex < 0 || typeof navigator === 'undefined' || !navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    const pad = pads[this.gamepadIndex];
    if (!pad) return;

    const dead = (v: number, t = 0.18) => Math.abs(v) < t ? 0 : v;
    // 摇杆 → 移动 / 视角（视角按 dt 归一化，与鼠标增量单位对齐）
    this.padMoveX = dead(pad.axes[0] ?? 0);
    this.padMoveZ = -dead(pad.axes[1] ?? 0); // 摇杆上前推为负 → 前进为正
    const lookScale = 900 * dt;               // 满摇杆每秒约转 900 像素当量
    this.padLookX = dead(pad.axes[2] ?? 0) * lookScale;
    this.padLookY = dead(pad.axes[3] ?? 0) * lookScale;

    const b = (i: number) => !!pad.buttons[i]?.pressed;
    const analog = (i: number) => pad.buttons[i]?.value ?? 0;
    this.padJump = b(0);
    this.padSneak = b(1) || b(11);            // B 或右摇杆按下
    this.padSprint = b(5) || analog(10) > 0.5; // RB 或左摇杆按下
    this.padBreak = b(7) || analog(7) > 0.5;   // RT
    this.padPlace = b(6) || analog(6) > 0.5 || b(2); // LT 或 X

    // 边沿事件无条件 push（与键盘 Escape 一致）：暂停时 Start 也要能恢复，
    // 具体是否响应由 processEdges 按 mode 判断；否则 enabled=false 会卡死在菜单。
    const prev = this.padPrevButtons;
    const pressed = (i: number) => b(i) && !prev[i];
    if (pressed(4)) this.edges.push({ type: 'slot', value: -1 });       // LB 上一槽
    if (pressed(5)) this.edges.push({ type: 'slot', value: 1 });        // RB 下一槽
    if (pressed(9)) this.edges.push({ type: 'pause' });                 // Start 菜单
    if (pressed(8)) this.edges.push({ type: 'debug' });                 // Back 调试
    if (pressed(3)) this.edges.push({ type: 'palette' });               // Y 方块库
    if (pressed(12)) this.edges.push({ type: 'camera' });               // 十字键上 视角
    if (pressed(13)) this.edges.push({ type: 'fly' });                  // 十字键下 飞行
    if (pressed(14)) this.edges.push({ type: 'slot', value: 0, absolute: true }); // 十字键左 → 槽0
    if (pressed(15)) this.edges.push({ type: 'hud' });                  // 十字键右 HUD
    if (pressed(2)) this.edges.push({ type: 'pick' });                  // X 取方块
    // 记录当前按钮状态供下一帧边沿检测
    this.padPrevButtons = pad.buttons.map((x) => x.pressed);
  }

  // ---- 可重绑定 API（HUD 设置面板 / CraftAPI 调用）----

  /** 当前绑定表副本 */
  getBindings(): KeyBindings {
    return { ...this.bindings };
  }

  getBinding(action: GameAction): string {
    return this.bindings[action];
  }

  /**
   * 重绑定某动作。若新键已被其他动作占用，则与之交换（避免重复绑定导致的歧义）。
   * 写回 localStorage 持久化，并清除当前按键状态防止卡键。
   */
  setBinding(action: GameAction, code: string): void {
    if (!code || code.length > 40) return;
    const conflict = ACTION_KEYS.find((a) => a !== action && this.bindings[a] === code);
    if (conflict) this.bindings[conflict] = this.bindings[action];
    this.bindings[action] = code;
    saveBindings(this.bindings);
    this.keys.clear();
    this.sprintLatch = false;
  }

  /** 恢复默认绑定 */
  resetBindings(): void {
    this.bindings = { ...DEFAULT_BINDINGS };
    saveBindings(this.bindings);
    this.keys.clear();
    this.sprintLatch = false;
  }

  /** 手柄是否已连接 */
  get gamepadConnected(): boolean {
    return this.gamepadIndex >= 0;
  }
}