import type { Input } from './input';

/**
 * 移动端触控：左下虚拟摇杆 + 右侧视角拖动 + 动作按钮。
 * 所有输入汇入统一 Input 层。
 */
export class TouchControls {
  readonly root: HTMLElement;
  private knob: HTMLElement;
  private joyId: number | null = null;
  private lookId: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private lookStart = { x: 0, y: 0, t: 0 };
  private lookDX = 0;
  private lookDY = 0;
  private lookRaf = 0;
  private lastJumpTap = 0;
  /** 视角拖动倍率（设置页「触控灵敏度」，1 = 默认） */
  lookScale = 1;

  constructor(
    private input: Input,
    uiRoot: HTMLElement,
    canvas: HTMLCanvasElement,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'touch-ui';
    this.root.innerHTML = `
      <div class="joy-zone joy-zone--pe" data-role="joy">
        <div class="joy-base joy-base--pe"><div class="joy-knob joy-knob--pe"></div></div>
      </div>
      <div class="touch-buttons">
        <button class="tbtn tbtn--pe tbtn-fly" data-role="fly" data-icon="fly" aria-label="切换飞行">
          <svg viewBox="0 0 24 24" shape-rendering="crispEdges"><path d="M3 13h4v-2h4V8h3v3h4v2h3v2h-6v3h-3v-3H9v3H6v-3H3z" fill="currentColor"/></svg>
        </button>
        <button class="tbtn tbtn--pe tbtn-down" data-role="sneak" data-icon="down" aria-label="下降/潜行">
          <svg viewBox="0 0 24 24" shape-rendering="crispEdges"><path d="M11 3h2v10h4l-5 7-5-7h4z" fill="currentColor"/></svg>
        </button>
        <button class="tbtn tbtn--pe tbtn-break" data-role="break" data-icon="break" aria-label="破坏方块">
          <svg viewBox="0 0 24 24" shape-rendering="crispEdges"><path d="M4 4h4v2h4v2h4V6h4V4h4v7h-3v2h-2v2h-2v2h-2v-2h-2v-2H8v-2H5v-2H4z" fill="currentColor"/></svg>
        </button>
        <button class="tbtn tbtn--pe tbtn-place" data-role="place" data-icon="place" aria-label="放置方块">
          <svg viewBox="0 0 24 24" shape-rendering="crispEdges"><path d="M9 3h6v2h3v14h-3v2H9v-2H6V5h3z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6 5l6 4 6-4M12 9v12" stroke="currentColor" stroke-width="2" fill="none"/></svg>
        </button>
        <button class="tbtn tbtn--pe tbtn-jump" data-role="jump" data-icon="jump" aria-label="跳跃">
          <svg viewBox="0 0 24 24" shape-rendering="crispEdges"><path d="M11 3h2v6h3l-4 5-4-5h3zM6 12h3v7h6v-7h3v10H6z" fill="currentColor"/></svg>
        </button>
      </div>`;
    uiRoot.appendChild(this.root);
    this.knob = this.root.querySelector('.joy-knob')!;
    const joyZone = this.root.querySelector('.joy-zone') as HTMLElement;

    // 摇杆
    joyZone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.joyId = e.pointerId;
      try {
        joyZone.setPointerCapture(e.pointerId);
      } catch {
        /* 合成事件无活动指针 */
      }
      this.updateJoy(e, joyZone);
    });
    joyZone.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.joyId) this.updateJoy(e, joyZone);
    });
    const joyEnd = (e: PointerEvent) => {
      if (e.pointerId !== this.joyId) return;
      this.joyId = null;
      this.input.touchMoveX = 0;
      this.input.touchMoveZ = 0;
      this.input.touchSprint = false;
      this.knob.style.transform = 'translate(-50%, -50%)';
    };
    joyZone.addEventListener('pointerup', joyEnd);
    joyZone.addEventListener('pointercancel', joyEnd);

    // 动作按钮
    const bindHold = (role: string, key: 'jump' | 'sneak' | 'break' | 'place') => {
      const el = this.root.querySelector(`[data-role="${role}"]`) as HTMLElement;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* 合成事件无活动指针 */
        }
        el.classList.add('active');
        this.buzz();
        if (key === 'jump') {
          const now = performance.now();
          if (now - this.lastJumpTap < 280) this.input.pushEdge({ type: 'fly' });
          this.lastJumpTap = now;
        }
        this.input.setTouchButtons({ [key]: true });
      });
      const up = (e: PointerEvent) => {
        e.stopPropagation();
        el.classList.remove('active');
        this.input.setTouchButtons({ [key]: false });
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    };
    bindHold('jump', 'jump');
    bindHold('sneak', 'sneak');
    bindHold('break', 'break');
    bindHold('place', 'place');
    (this.root.querySelector('[data-role="fly"]') as HTMLElement).addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.input.pushEdge({ type: 'fly' });
    });

    // 视角拖动（画布右半区），轻点 = 破坏准星方块
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || !this.input.enabled) return;
      if (e.clientX < innerWidth * 0.32) return;
      if (this.lookId !== null) return;
      this.lookId = e.pointerId;
      this.lookLast = { x: e.clientX, y: e.clientY };
      this.lookStart = { x: e.clientX, y: e.clientY, t: performance.now() };
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* 合成事件无活动指针 */
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookId) return;
      // 暂停 / 死亡期间 input 被禁用：丢弃这次拖动，避免恢复后把累积增量一次性应用。
      if (!this.input.enabled) {
        this.dropLook();
        this.lookId = null;
        return;
      }
      const dx = e.clientX - this.lookLast.x;
      const dy = e.clientY - this.lookLast.y;
      this.lookLast = { x: e.clientX, y: e.clientY };
      // 基础系数 2.3 是触屏拖动相对鼠标的补偿；设置页「触控灵敏度」再乘在它之上。
      // 120Hz 触控采样会高频写输入：先累积，每帧最多提交一次。
      this.lookDX += dx * 2.3 * this.lookScale;
      this.lookDY += dy * 2.3 * this.lookScale;
      this.scheduleLook();
    });
    const lookEnd = (e: PointerEvent) => {
      if (e.pointerId !== this.lookId) return;
      this.lookId = null;
      this.flushLook();
      if (!this.input.enabled) return; // 暂停 / 死亡期间不触发轻点破坏
      const dt = performance.now() - this.lookStart.t;
      const dist = Math.hypot(e.clientX - this.lookStart.x, e.clientY - this.lookStart.y);
      if (dt < 230 && dist < 12) this.input.pushEdge({ type: 'tapBreak' });
    };
    canvas.addEventListener('pointerup', lookEnd);
    canvas.addEventListener('pointercancel', lookEnd);
  }

  private scheduleLook() {
    if (this.lookRaf !== 0) return;
    this.lookRaf = requestAnimationFrame(() => {
      this.lookRaf = 0;
      this.flushLook();
    });
  }

  private flushLook() {
    if (this.lookRaf !== 0) {
      cancelAnimationFrame(this.lookRaf);
      this.lookRaf = 0;
    }
    const dx = this.lookDX;
    const dy = this.lookDY;
    this.lookDX = 0;
    this.lookDY = 0;
    if (this.input.enabled && (dx !== 0 || dy !== 0)) this.input.addLook(dx, dy);
  }

  private dropLook() {
    if (this.lookRaf !== 0) {
      cancelAnimationFrame(this.lookRaf);
      this.lookRaf = 0;
    }
    this.lookDX = 0;
    this.lookDY = 0;
  }

  private updateJoy(e: PointerEvent, zone: HTMLElement) {
    if (!this.input.enabled) return;
    const rect = zone.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = (e.clientX - cx) / (rect.width / 2);
    let dy = (e.clientY - cy) / (rect.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    const dead = 0.14;
    const mag = Math.min(1, len);
    const scale = mag < dead ? 0 : (mag - dead) / (1 - dead);
    this.input.touchMoveX = dx * scale;
    this.input.touchMoveZ = -dy * scale;
    this.input.touchSprint = mag > 0.92;
    this.knob.style.transform = `translate(calc(-50% + ${dx * 34}px), calc(-50% + ${dy * 34}px))`;
  }

  setVisible(v: boolean) {
    if (!v) {
      // 隐藏时清掉进行中的指针，避免暂停期间残留的拖动/摇杆继续喂输入
      this.dropLook();
      this.lookId = null;
      this.joyId = null;
      this.input.touchMoveX = 0;
      this.input.touchMoveZ = 0;
      this.input.touchSprint = false;
      this.knob.style.transform = 'translate(-50%, -50%)';
    }
    this.root.style.display = v ? '' : 'none';
  }

  /** 放置键的语义：手持方块=放置，手持食物=进食，手持篮球=投掷，空手=禁用 */
  setUseMode(mode: 'block' | 'item' | 'throw' | 'none') {
    const btn = this.root.querySelector('[data-role="place"]') as HTMLElement;
    const throwIcon =
      '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 12h16M12 4c3.2 3.3 3.2 12.7 0 16M12 4c-3.2 3.3-3.2 12.7 0 16" fill="none" stroke="currentColor" stroke-width="1.5"/>';
    const itemIcon =
      '<path d="M12 21c-4 0-7-3.2-7-7 0-4.3 4.6-7.6 7-9.6 2.4 2 7 5.3 7 9.6 0 3.8-3 7-7 7z" fill="currentColor"/><path d="M12 4c.6-1.4 2-2.4 3.6-2.4" stroke="currentColor" stroke-width="2" fill="none"/>';
    const blockIcon =
      '<path d="M12 2l9 5v10l-9 5-9-5V7z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 12l9-5M12 12v10M12 12L3 7" stroke="currentColor" stroke-width="2" fill="none"/>';
    const icon = mode === 'throw' ? throwIcon : mode === 'item' ? itemIcon : blockIcon;
    btn.querySelector('svg')!.innerHTML = icon;
    btn.setAttribute('aria-label', mode === 'throw' ? '投掷篮球' : mode === 'item' ? '进食' : '放置方块');
    btn.classList.toggle('disabled', mode === 'none');
    btn.style.opacity = mode === 'none' ? '0.35' : '';
  }

  /** 轻微触感反馈（不支持的设备静默跳过） */
  private buzz() {
    try {
      navigator.vibrate?.(12);
    } catch {
      /* 忽略 */
    }
  }
}
