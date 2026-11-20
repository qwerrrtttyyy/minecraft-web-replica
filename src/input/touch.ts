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
  private lastJumpTap = 0;

  constructor(private input: Input, uiRoot: HTMLElement, canvas: HTMLCanvasElement) {
    this.root = document.createElement('div');
    this.root.className = 'touch-ui';
    this.root.innerHTML = `
      <div class="joy-zone" data-role="joy">
        <div class="joy-base"><div class="joy-knob"></div></div>
      </div>
      <div class="touch-buttons">
        <button class="tbtn tbtn-fly" data-role="fly" aria-label="切换飞行">
          <svg viewBox="0 0 24 24"><path d="M3 14l7-2 4-7 2 1-2 6 5 2-1 2-6-1-3 4-2-1 1-4-4 1z" fill="currentColor"/></svg>
        </button>
        <button class="tbtn tbtn-down" data-role="sneak" aria-label="下降/潜行">
          <svg viewBox="0 0 24 24"><path d="M12 16l-6-6h12z" fill="currentColor"/></svg>
        </button>
        <button class="tbtn tbtn-break" data-role="break" aria-label="破坏方块">
          <svg viewBox="0 0 24 24"><path d="M14 3l7 7-2 2-1.5-1.5-8 8L4 20l1.5-5.5 8-8L12 5z" fill="currentColor"/></svg>
        </button>
        <button class="tbtn tbtn-place" data-role="place" aria-label="放置方块">
          <svg viewBox="0 0 24 24"><path d="M12 2l9 5v10l-9 5-9-5V7z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 12l9-5M12 12v10M12 12L3 7" stroke="currentColor" stroke-width="2" fill="none"/></svg>
        </button>
        <button class="tbtn tbtn-jump" data-role="jump" aria-label="跳跃">
          <svg viewBox="0 0 24 24"><path d="M12 5l7 8h-4v6h-6v-6H5z" fill="currentColor"/></svg>
        </button>
      </div>`;
    uiRoot.appendChild(this.root);
    this.knob = this.root.querySelector('.joy-knob')!;
    const joyZone = this.root.querySelector('.joy-zone') as HTMLElement;

    // 摇杆
    joyZone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.joyId = e.pointerId;
      try { joyZone.setPointerCapture(e.pointerId); } catch { /* 合成事件无活动指针 */ }
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
        try { el.setPointerCapture(e.pointerId); } catch { /* 合成事件无活动指针 */ }
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
      try { canvas.setPointerCapture(e.pointerId); } catch { /* 合成事件无活动指针 */ }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookId) return;
      const dx = e.clientX - this.lookLast.x;
      const dy = e.clientY - this.lookLast.y;
      this.lookLast = { x: e.clientX, y: e.clientY };
      // 灵敏度统一由 Input.consumeLook() 施加，这里再乘一次会被平方
      this.input.addLook(dx * 2.3, dy * 2.3);
    });
    const lookEnd = (e: PointerEvent) => {
      if (e.pointerId !== this.lookId) return;
      this.lookId = null;
      const dt = performance.now() - this.lookStart.t;
      const dist = Math.hypot(e.clientX - this.lookStart.x, e.clientY - this.lookStart.y);
      if (dt < 230 && dist < 12) this.input.pushEdge({ type: 'tapBreak' });
    };
    canvas.addEventListener('pointerup', lookEnd);
    canvas.addEventListener('pointercancel', lookEnd);
  }

  private updateJoy(e: PointerEvent, zone: HTMLElement) {
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
    this.root.style.display = v ? '' : 'none';
  }

  /** 放置键的语义：手持方块=放置，手持食物=进食，空手=禁用 */
  setUseMode(mode: 'block' | 'item' | 'none') {
    const btn = this.root.querySelector('[data-role="place"]') as HTMLElement;
    const icon = mode === 'item'
      ? '<path d="M12 21c-4 0-7-3.2-7-7 0-4.3 4.6-7.6 7-9.6 2.4 2 7 5.3 7 9.6 0 3.8-3 7-7 7z" fill="currentColor"/><path d="M12 4c.6-1.4 2-2.4 3.6-2.4" stroke="currentColor" stroke-width="2" fill="none"/>'
      : '<path d="M12 2l9 5v10l-9 5-9-5V7z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 12l9-5M12 12v10M12 12L3 7" stroke="currentColor" stroke-width="2" fill="none"/>';
    btn.querySelector('svg')!.innerHTML = icon;
    btn.setAttribute('aria-label', mode === 'item' ? '进食' : '放置方块');
    btn.classList.toggle('disabled', mode === 'none');
    btn.style.opacity = mode === 'none' ? '0.35' : '';
  }

  /** 轻微触感反馈（不支持的设备静默跳过） */
  private buzz() {
    try { navigator.vibrate?.(12); } catch { /* 忽略 */ }
  }
}