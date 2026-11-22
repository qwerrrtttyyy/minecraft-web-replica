/**
 * N1 横屏引导兜底。
 *
 * PWA 安装态用 manifest.webmanifest 的 `orientation: landscape` 锁定方向；
 * 普通浏览器标签页无法真正锁屏，因此这里只在「竖屏 + 粗指针 + 非 standalone」
 * 时显示旋转引导，并提供「仍要游玩」入口避免完全不可玩。
 *
 * 约定：不调用 screen.orientation.lock()（多数移动端浏览器会拒绝，且会引入新的失败路径），
 * 不引入任何外部资源，桌面细指针设备永不显示。
 */
export interface OrientationGate {
  readonly el: HTMLElement;
  /** 方向 / 指针 / 显示模式变化时重新判定 */
  refresh(): void;
  /** 「仍要游玩」：本次会话内永久关闭引导 */
  dismiss(): void;
  readonly dismissed: boolean;
}

/** 兼容内嵌片段缺失时的兜底结构（正常由 index.html 提供） */
const FALLBACK_HTML = `
  <div class="rotate-gate-panel">
    <svg class="rotate-gate-icon" viewBox="0 0 64 64" aria-hidden="true">
      <rect x="19" y="7" width="26" height="50" rx="3" fill="none" stroke="currentColor" stroke-width="4" />
      <path d="M9 42a23 23 0 0 0 39 8" fill="none" stroke="#ffd54a" stroke-width="4" stroke-linecap="round" />
      <path d="M48 50V38m0 12H36" fill="none" stroke="#ffd54a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <div class="rotate-gate-title">请旋转设备至横屏</div>
    <div class="rotate-gate-desc">横屏游玩视野更完整，按键与快捷栏会按横屏布局显示。</div>
    <button type="button" class="rotate-gate-play">仍要游玩</button>
  </div>`;

export function createOrientationGate(root: HTMLElement): OrientationGate {
  const existing = document.getElementById('rotate-gate');
  const el = existing ?? document.createElement('div');
  if (!existing) {
    el.id = 'rotate-gate';
    el.innerHTML = FALLBACK_HTML;
    root.appendChild(el);
  }

  let dismissed = false;
  const portrait = window.matchMedia('(orientation: portrait)');
  const coarse = window.matchMedia('(pointer: coarse)');
  const standaloneQuery = window.matchMedia('(display-mode: standalone)');

  const refresh = (): void => {
    // iOS Safari 用 navigator.standalone 表达安装态；其余浏览器看 display-mode
    const standalone = standaloneQuery.matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    el.hidden = dismissed || !portrait.matches || !coarse.matches || standalone;
  };

  const dismiss = (): void => {
    dismissed = true;
    refresh();
  };

  el.querySelector('.rotate-gate-play')?.addEventListener('click', dismiss);
  for (const mql of [portrait, coarse, standaloneQuery]) mql.addEventListener?.('change', refresh);
  window.addEventListener('resize', refresh);
  window.addEventListener('orientationchange', refresh);
  refresh();

  return {
    el,
    refresh,
    dismiss,
    get dismissed() { return dismissed; },
  };
}
