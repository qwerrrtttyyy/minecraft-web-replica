import type { BlockId, GameMode } from '../core/types';
import type { BlockRegistry } from '../world/blocks';
import type { TextureAtlas } from '../gfx/atlas';
import type { HotbarState, MiningState } from '../player/player';
import { ITEMS, MAX_BREATH, MAX_HUNGER, MAX_HEALTH, type Stack } from '../player/survival';

/**
 * HUD 与全部界面：标题屏 / 加载 / 快捷栏 / 生命饥饿 / 方块库 / 暂停菜单 / 死亡界面。
 * 原版风格 UI：泥土面板、立体按钮、像素图标；移动端为加大触控与安全区布局。
 */

export interface HUDOptions {
  uiRoot: HTMLElement;
  atlas: TextureAtlas;
  registry: BlockRegistry;
  hotbar: HotbarState;
  isMobile: boolean;
  onStart: (continueGame: boolean, mode: GameMode) => void;
  onNewWorld: (seed: number | undefined, mode: GameMode) => void;
  onResume: () => void;
  onQuitToTitle: () => void;
  onSlot: (i: number) => void;
  onAssign: (id: BlockId) => void;
  onSoundToggle: () => void;
  onCamera: () => void;
  onFly: () => void;
  onMenu: () => void;
  onRenderDistance: (v: number) => void;
  onSensitivity: (v: number) => void;
  onFov: (v: number) => void;
  onPaletteOpen: (from: 'game' | 'menu') => void;
  onPaletteClose: () => void;
  onRespawn: () => void;
  onModeToggle: () => void;
  isSurvival: () => boolean;
  getCount: (s: Stack) => number;
}

const h = (tag: string, cls?: string, text?: string): HTMLElement => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};

const STAT_PATHS: Record<'heart' | 'hunger' | 'bubble', string> = {
  heart: '<path d="M12 21s-8.3-5.2-10.3-9.7C.5 7.2 2.6 3.5 6.3 3.5c2.2 0 3.8 1.2 5.7 3 1.9-1.8 3.5-3 5.7-3 3.7 0 5.8 3.7 4.6 7.8C20.3 15.8 12 21 12 21z"/>',
  hunger: '<path d="M14.6 3.2a6.2 6.2 0 0 1 6.2 6.2c0 3.1-2.2 5.2-5.6 5.4l-4.4 4.4a2.7 2.7 0 1 1-3.8-3.8l4.4-4.4C13.6 7.6 14.4 5.3 14.6 3.2z"/>',
  bubble: '<circle cx="12" cy="12" r="7.4" fill="none" stroke-width="3.2"/>',
};

export class HUD {
  readonly root: HTMLElement;
  private opts: HUDOptions;
  private iconCache = new Map<string, string>();

  private title!: HTMLElement;
  private titleButtons!: HTMLElement;
  private loading!: HTMLElement;
  private loadingBar!: HTMLElement;
  private loadingText!: HTMLElement;
  private gameHud!: HTMLElement;
  private crosshair!: HTMLElement;
  private hotbarEl!: HTMLElement;
  private slotEls: HTMLElement[] = [];
  private slotCounts: HTMLElement[] = [];
  private itemName!: HTMLElement;
  private debugEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private underwater!: HTMLElement;
  private flashEl!: HTMLElement;
  private hurtEl!: HTMLElement;
  private toastEl!: HTMLElement;
  private saveNote!: HTMLElement;
  private statsWrap!: HTMLElement;
  private heartsRow!: HTMLElement;
  private hungerRow!: HTMLElement;
  private breathRow!: HTMLElement;
  private miningBar!: HTMLElement;
  private miningFill!: HTMLElement;
  private menuOverlay!: HTMLElement;
  private paletteOverlay!: HTMLElement;
  private paletteGrid!: HTMLElement;
  private paletteSearch!: HTMLInputElement;
  private helpOverlay!: HTMLElement;
  private deathOverlay!: HTMLElement;
  private deathCause!: HTMLElement;
  private soundBtn!: HTMLButtonElement;
  private flyBtn!: HTMLButtonElement;
  private rdSlider!: HTMLInputElement;
  private sensSlider!: HTMLInputElement;
  private fovSlider!: HTMLInputElement;
  private rdVal!: HTMLElement;
  private sensVal!: HTMLElement;
  private fovVal!: HTMLElement;
  private modeBtns: HTMLButtonElement[] = [];
  private menuModeBtn!: HTMLButtonElement;

  hudHidden = false;
  private itemNameTimer = 0;
  private toastTimer = 0;
  private pips: HTMLElement[] = [];
  private lastStats = { health: -1, hunger: -1, breath: -1, mode: '' as string };
  private selectedMode: GameMode = 'survival';

  constructor(opts: HUDOptions) {
    this.opts = opts;
    this.root = h('div', 'hud-root');
    opts.uiRoot.appendChild(this.root);
    this.root.style.setProperty('--dirt-url', `url(${opts.atlas.dataURL('dirt', 4)})`);
    this.buildTitle();
    this.buildLoading();
    this.buildGameHud();
    this.buildMenu();
    this.buildPalette();
    this.buildHelp();
    this.buildDeath();
  }

  private icon(stack: Stack): string {
    const key = `${stack.kind}:${stack.id}`;
    let url = this.iconCache.get(key);
    if (!url) {
      if (stack.kind === 'block') {
        url = this.opts.atlas.icon(this.opts.registry.get(stack.id as BlockId), 48).toDataURL();
      } else {
        const item = ITEMS[stack.id as string];
        url = item ? this.opts.atlas.itemIcon(item.tile, 48).toDataURL() : '';
      }
      this.iconCache.set(key, url);
    }
    return url;
  }

  private mcButton(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
    const b = h('button', `mc-btn ${cls}`, label) as HTMLButtonElement;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  // ---------- 标题屏 ----------
  private buildTitle() {
    this.title = h('div', 'title-screen');
    const inner = h('div', 'title-inner');
    const logoWrap = h('div', 'logo-wrap');
    logoWrap.appendChild(h('div', 'mc-logo', 'MINECRAFT'));
    logoWrap.appendChild(h('div', 'mc-splash', 'TypeScript 复刻!'));
    inner.appendChild(logoWrap);
    inner.appendChild(h('div', 'title-sub', '网页版 · 生存 / 创造双模式'));

    this.titleButtons = h('div', 'title-buttons');
    inner.appendChild(this.titleButtons);

    // 模式选择：生存 / 创造
    const modeRow = h('div', 'mode-row');
    const modes: [GameMode, string, string][] = [
      ['survival', '生存模式', '生命 · 饥饿 · 怪物 · 采集'],
      ['creative', '创造模式', '无限方块 · 自由飞行 · 瞬间破坏'],
    ];
    this.modeBtns = [];
    for (const [m, label, desc] of modes) {
      const b = this.mcButton(label, () => this.setSelectedMode(m), 'mode-btn');
      b.appendChild(h('span', 'mode-desc', desc));
      b.dataset.mode = m;
      this.modeBtns.push(b);
      modeRow.appendChild(b);
    }
    inner.appendChild(modeRow);
    this.setSelectedMode('survival');

    const seedRow = h('div', 'seed-row');
    const seedInput = h('input', 'mc-input seed-input') as HTMLInputElement;
    seedInput.placeholder = '世界种子（留空随机）';
    seedInput.maxLength = 20;
    seedInput.addEventListener('pointerdown', (e) => e.stopPropagation());
    const seedBtn = this.mcButton('生成新世界', () => {
      const v = seedInput.value.trim();
      const seed = v === '' ? undefined : (/^\d+$/.test(v) ? Number(v) : hashSeed(v));
      this.opts.onNewWorld(seed, this.selectedMode);
    }, 'mc-btn-small');
    seedRow.append(seedInput, seedBtn);
    inner.appendChild(seedRow);

    const helpLink = h('button', 'link-btn', '操作说明');
    helpLink.addEventListener('click', () => this.showHelp(true));
    inner.appendChild(helpLink);

    inner.appendChild(h('div', 'title-footer',
      '非官方学习项目，与 Mojang / Microsoft 无关 · 进度自动保存在本机浏览器'));
    this.title.appendChild(inner);
    this.root.appendChild(this.title);
  }

  private setSelectedMode(mode: GameMode) {
    this.selectedMode = mode;
    for (const b of this.modeBtns) b.classList.toggle('active', b.dataset.mode === mode);
  }

  private continueMode: GameMode | null = null;

  /**
   * 根据是否存在存档刷新标题按钮。
   * v1.2.0：有存档时把模式高亮同步为存档的真实模式，
   * 修复 v1.1.2「标题高亮生存、点继续却进入创造」的误导。
   */
  refreshTitleButtons(hasSave: boolean, savedMode?: GameMode) {
    this.titleButtons.innerHTML = '';
    this.continueMode = hasSave ? (savedMode ?? 'survival') : null;
    if (savedMode) this.setSelectedMode(savedMode);
    if (hasSave) {
      const label = this.continueMode === 'creative' ? '继续游戏（创造）' : '继续游戏（生存）';
      // 继续游戏传存档模式；「新的世界」用当前选择（用户可另行切换）
      this.titleButtons.appendChild(this.mcButton(label, () => this.opts.onStart(true, this.continueMode ?? this.selectedMode), 'mc-btn-big'));
      this.titleButtons.appendChild(this.mcButton('新的世界', () => this.opts.onNewWorld(undefined, this.selectedMode)));
    } else {
      this.titleButtons.appendChild(this.mcButton('进入世界', () => this.opts.onStart(false, this.selectedMode), 'mc-btn-big'));
    }
  }

  showTitle(v: boolean) {
    this.title.style.display = v ? '' : 'none';
  }

  // ---------- 加载 ----------
  private buildLoading() {
    this.loading = h('div', 'loading-screen');
    this.loading.appendChild(h('div', 'loading-title', '生成世界中'));
    const bar = h('div', 'loading-bar');
    this.loadingBar = h('div', 'loading-fill');
    bar.appendChild(this.loadingBar);
    this.loading.appendChild(bar);
    this.loadingText = h('div', 'loading-text', '准备地形…');
    this.loading.appendChild(this.loadingText);
    this.loading.style.display = 'none';
    this.root.appendChild(this.loading);
  }

  setLoading(progress: number | null, text?: string) {
    if (progress === null) {
      this.loading.style.display = 'none';
      return;
    }
    this.loading.style.display = '';
    this.loadingBar.style.width = `${Math.round(progress * 100)}%`;
    if (text) this.loadingText.textContent = text;
  }

  // ---------- 游戏 HUD ----------
  private buildGameHud() {
    this.gameHud = h('div', 'game-hud');

    this.crosshair = h('div', 'crosshair');
    // 原版准星：白色十字、中心留 2px 空隙，四臂独立以便逐臂加黑色描边
    for (const dir of ['up', 'right', 'down', 'left']) {
      this.crosshair.appendChild(h('i', `ch-arm ch-${dir}`));
    }
    this.gameHud.appendChild(this.crosshair);

    // 挖掘进度条（准星下方）
    this.miningBar = h('div', 'mining-bar');
    this.miningFill = h('div', 'mining-fill');
    this.miningBar.appendChild(this.miningFill);
    this.miningBar.style.display = 'none';
    this.gameHud.appendChild(this.miningBar);

    this.underwater = h('div', 'underwater');
    this.gameHud.appendChild(this.underwater);
    this.flashEl = h('div', 'flash');
    this.gameHud.appendChild(this.flashEl);
    this.hurtEl = h('div', 'hurt-flash');
    this.gameHud.appendChild(this.hurtEl);

    // 顶部按钮
    const topBar = h('div', 'top-buttons');
    this.soundBtn = this.iconButton('sound', '音效开关', () => this.opts.onSoundToggle());
    this.flyBtn = this.iconButton('fly', '切换飞行', () => this.opts.onFly());
    const camBtn = this.iconButton('camera', '切换视角', () => this.opts.onCamera());
    const menuBtn = this.iconButton('menu', '菜单', () => this.opts.onMenu());
    topBar.append(this.soundBtn, this.flyBtn, camBtn, menuBtn);
    this.gameHud.appendChild(topBar);

    // 调试面板
    this.debugEl = h('pre', 'debug-panel');
    this.debugEl.style.display = 'none';
    this.gameHud.appendChild(this.debugEl);

    // 状态条（生命 / 饥饿 / 氧气）
    this.statsWrap = h('div', 'stats-wrap');
    const mkRow = (kind: 'heart' | 'hunger' | 'bubble') => {
      const row = h('div', `stat-row stat-${kind}`);
      for (let i = 0; i < 10; i++) {
        const pip = h('span', 'stat-pip');
        pip.dataset.kind = kind;
        pip.innerHTML = `<svg class="pip-empty" viewBox="0 0 24 24">${STAT_PATHS[kind]}</svg>` +
          `<span class="pip-fill"><svg viewBox="0 0 24 24">${STAT_PATHS[kind]}</svg></span>`;
        this.pips.push(pip);
        row.appendChild(pip);
      }
      return row;
    };
    this.heartsRow = mkRow('heart');
    this.hungerRow = mkRow('hunger');
    this.breathRow = mkRow('bubble');
    this.statsWrap.append(this.heartsRow, this.hungerRow, this.breathRow);
    this.breathRow.style.display = 'none';
    this.statsWrap.style.display = 'none';
    this.gameHud.appendChild(this.statsWrap);

    // 快捷栏
    const hotbarWrap = h('div', 'hotbar-wrap');
    this.itemName = h('div', 'item-name');
    hotbarWrap.appendChild(this.itemName);
    this.hotbarEl = h('div', 'hotbar');
    for (let i = 0; i < 9; i++) {
      const slot = h('div', 'hotbar-slot');
      const img = h('img', 'slot-icon') as HTMLImageElement;
      img.draggable = false;
      const count = h('span', 'slot-count');
      const num = h('span', 'slot-num', String(i + 1));
      slot.append(img, count, num);
      slot.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.opts.onSlot(i);
      });
      this.slotEls.push(slot);
      this.slotCounts.push(count);
      this.hotbarEl.appendChild(slot);
    }
    hotbarWrap.appendChild(this.hotbarEl);
    this.gameHud.appendChild(hotbarWrap);

    this.hintEl = h('div', 'hint-bar',
      this.opts.isMobile ? '' : '左键按住破坏 · 右键放置/进食 · 滚轮/1-9切换 · 中键取样 · E方块库 · F5视角 · F3调试');
    this.gameHud.appendChild(this.hintEl);

    this.toastEl = h('div', 'toast');
    this.gameHud.appendChild(this.toastEl);
    this.saveNote = h('div', 'save-note');
    this.gameHud.appendChild(this.saveNote);

    this.gameHud.style.display = 'none';
    this.root.appendChild(this.gameHud);
    this.updateHotbar();
  }

  private iconButton(kind: string, label: string, onClick: () => void): HTMLButtonElement {
    const b = h('button', `icon-btn icon-${kind}`) as HTMLButtonElement;
    b.setAttribute('aria-label', label);
    b.title = label;
    const svgs: Record<string, string> = {
      sound: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path class="snd-wave" d="M16 8c1.5 1 1.5 7 0 8M18.5 6c3 2.5 3 9.5 0 12" stroke="currentColor" stroke-width="1.8" fill="none"/><path class="snd-mute" d="M16 9l6 6M22 9l-6 6" stroke="currentColor" stroke-width="2" style="display:none"/></svg>',
      fly: '<svg viewBox="0 0 24 24"><path d="M3 14l7-2 4-7 2 1-2 6 5 2-1 2-6-1-3 4-2-1 1-4-4 1z" fill="currentColor"/></svg>',
      camera: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 11l5-3v9l-5-3" fill="currentColor"/><circle cx="7.5" cy="12.5" r="2.2" fill="currentColor"/></svg>',
      menu: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
    };
    b.innerHTML = svgs[kind] ?? '';
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  setPlaying(v: boolean) {
    this.gameHud.style.display = v ? '' : 'none';
  }

  fadeHint() {
    this.hintEl.style.opacity = '0';
  }

  updateHotbar() {
    const { slots, index } = this.opts.hotbar;
    const survival = this.opts.isSurvival();
    for (let i = 0; i < 9; i++) {
      const img = this.slotEls[i].querySelector('img') as HTMLImageElement;
      const stack = slots[i];
      if (stack) {
        img.src = this.icon(stack);
        img.alt = stack.kind === 'block' ? this.opts.registry.get(stack.id as BlockId).label : (ITEMS[stack.id as string]?.label ?? '');
        img.style.visibility = '';
      } else {
        img.removeAttribute('src');
        img.alt = '';
        img.style.visibility = 'hidden';
      }
      const cnt = survival && stack ? this.opts.getCount(stack) : 0;
      this.slotCounts[i].textContent = cnt > 1 ? String(cnt) : '';
      this.slotEls[i].classList.toggle('selected', i === index);
      this.slotEls[i].classList.toggle('empty', !stack || (survival && cnt <= 0));
    }
  }

  showItemName(label: string) {
    this.itemName.textContent = label;
    this.itemName.classList.add('show');
    clearTimeout(this.itemNameTimer);
    this.itemNameTimer = window.setTimeout(() => this.itemName.classList.remove('show'), 1400);
  }

  setDebug(text: string | null) {
    if (text === null) {
      this.debugEl.style.display = 'none';
    } else {
      this.debugEl.style.display = '';
      this.debugEl.textContent = text;
    }
  }

  setSound(on: boolean) {
    this.soundBtn.classList.toggle('muted', !on);
    const wave = this.soundBtn.querySelector('.snd-wave') as SVGElement | null;
    const mute = this.soundBtn.querySelector('.snd-mute') as SVGElement | null;
    if (wave) wave.style.display = on ? '' : 'none';
    if (mute) mute.style.display = on ? 'none' : '';
  }

  setFlyActive(on: boolean) {
    this.flyBtn.classList.toggle('active', on);
    this.flyBtn.classList.toggle('disabled', this.opts.isSurvival());
  }

  setUnderwater(v: boolean) {
    this.underwater.classList.toggle('show', v);
  }

  flash() {
    this.flashEl.classList.remove('go');
    void this.flashEl.offsetWidth;
    this.flashEl.classList.add('go');
  }

  /** 受伤红屏 */
  flashHurt() {
    this.hurtEl.classList.remove('go');
    void this.hurtEl.offsetWidth;
    this.hurtEl.classList.add('go');
  }

  toast(msg: string) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 2200);
  }

  noteSaved(time: string) {
    this.saveNote.textContent = `已自动保存 ${time}`;
    this.saveNote.classList.add('show');
    window.setTimeout(() => this.saveNote.classList.remove('show'), 2500);
  }

  toggleHudHidden() {
    this.hudHidden = !this.hudHidden;
    this.gameHud.classList.toggle('hud-hidden', this.hudHidden);
  }

  // ---------- 生存状态 ----------

  /** 每帧调用；内部做变化检测，避免频繁重排 DOM */
  setSurvival(s: { health: number; hunger: number; breath: number; mode: GameMode; dead: boolean } | null) {
    const survival = !!s && s.mode === 'survival';
    this.statsWrap.style.display = survival && !this.hudHidden ? '' : 'none';
    if (!s || !survival) return;
    if (s.health === this.lastStats.health && s.hunger === this.lastStats.hunger &&
      s.breath === this.lastStats.breath && s.mode === this.lastStats.mode) return;
    this.lastStats = { health: s.health, hunger: s.hunger, breath: s.breath, mode: s.mode };

    const fill = (row: HTMLElement, value: number, max: number) => {
      const pips = [...row.children] as HTMLElement[];
      for (let i = 0; i < pips.length; i++) {
        const perPip = max / pips.length;
        const v = value - perPip * i;
        const ratio = Math.max(0, Math.min(1, v / perPip));
        const inner = pips[i].querySelector('.pip-fill') as HTMLElement;
        inner.style.width = `${ratio * 100}%`;
        pips[i].classList.toggle('low', ratio > 0 && ratio <= 0.5);
      }
    };
    fill(this.heartsRow, s.health, MAX_HEALTH);
    fill(this.hungerRow, s.hunger, MAX_HUNGER);

    const showBreath = s.breath < MAX_BREATH - 0.2;
    this.breathRow.style.display = showBreath ? '' : 'none';
    if (showBreath) fill(this.breathRow, s.breath, MAX_BREATH);
    this.heartsRow.classList.toggle('dead', s.dead);
  }

  setMining(state: MiningState | null) {
    if (!state) {
      this.miningBar.style.display = 'none';
      return;
    }
    this.miningBar.style.display = '';
    this.miningFill.style.width = `${Math.round(state.progress * 100)}%`;
    this.miningFill.style.background = state.block.hardness >= 1.5 ? '#d8b45a' : '#8bd45a';
  }

  // ---------- 暂停菜单 ----------
  private buildMenu() {
    this.menuOverlay = h('div', 'overlay menu-overlay');
    const panel = h('div', 'mc-panel menu-panel');
    panel.appendChild(h('div', 'panel-title', '游戏菜单'));

    this.menuModeBtn = this.mcButton('切换为创造模式', () => this.opts.onModeToggle());
    panel.appendChild(this.menuModeBtn);
    panel.appendChild(this.mcButton('继续游戏', () => this.opts.onResume(), 'mc-btn-big'));

    const sliders = h('div', 'sliders');
    const mkSlider = (label: string, min: number, max: number, step: number, val: number,
      fmt: (v: number) => string, cb: (v: number) => void): [HTMLInputElement, HTMLElement] => {
      const row = h('div', 'slider-row');
      const head = h('div', 'slider-head');
      head.appendChild(h('span', '', label));
      const valEl = h('span', 'slider-val', fmt(val));
      head.appendChild(valEl);
      const input = h('input', 'mc-slider') as HTMLInputElement;
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(val);
      input.addEventListener('input', () => {
        const v = Number(input.value);
        valEl.textContent = fmt(v);
        cb(v);
      });
      row.append(head, input);
      sliders.appendChild(row);
      return [input, valEl];
    };
    [this.rdSlider, this.rdVal] = mkSlider('渲染距离', 2, 8, 1, 5, (v) => `${v} 区块`, (v) => this.opts.onRenderDistance(v));
    [this.sensSlider, this.sensVal] = mkSlider('视角灵敏度', 40, 200, 5, 100, (v) => `${v}%`, (v) => this.opts.onSensitivity(v / 100));
    [this.fovSlider, this.fovVal] = mkSlider('视野 FOV', 60, 95, 1, 72, (v) => `${v}°`, (v) => this.opts.onFov(v));
    panel.appendChild(sliders);

    const btnRow = h('div', 'menu-row');
    btnRow.appendChild(this.mcButton('操作说明', () => this.showHelp(true)));
    // 必须交给组装根打开面板：paletteReturn 需要记住 'menu'，
    // 否则关闭面板会直接恢复游戏而不是回到菜单（v1.3.2 修复）。
    btnRow.appendChild(this.mcButton('方块库', () => this.opts.onPaletteOpen('menu')));
    panel.appendChild(btnRow);

    const newWorldRow = h('div', 'menu-new-world');
    const seedInput = h('input', 'mc-input') as HTMLInputElement;
    seedInput.placeholder = '新世界种子（留空随机）';
    seedInput.maxLength = 20;
    const genBtn = this.mcButton('新世界', () => {
      const v = seedInput.value.trim();
      const seed = v === '' ? undefined : (/^\d+$/.test(v) ? Number(v) : hashSeed(v));
      this.opts.onNewWorld(seed, this.opts.isSurvival() ? 'survival' : 'creative');
    }, 'mc-btn-small');
    newWorldRow.append(seedInput, genBtn);
    panel.appendChild(newWorldRow);

    panel.appendChild(this.mcButton('保存并返回标题', () => this.opts.onQuitToTitle()));
    panel.appendChild(h('div', 'menu-note', '进度已自动保存到本机浏览器'));
    this.menuOverlay.appendChild(panel);
    this.menuOverlay.style.display = 'none';
    this.root.appendChild(this.menuOverlay);
  }

  setMenuMode(mode: GameMode, health: number, hunger: number) {
    this.menuModeBtn.textContent = mode === 'survival' ? '切换为创造模式' : '切换为生存模式';
    this.menuModeBtn.title = mode === 'survival'
      ? `当前：生存模式（生命 ${Math.ceil(health)}/20，饥饿 ${Math.ceil(hunger)}/20）`
      : '当前：创造模式';
  }

  showMenu(v: boolean) {
    this.menuOverlay.style.display = v ? '' : 'none';
  }

  syncSettings(rd: number, sens: number, fov: number) {
    this.rdSlider.value = String(rd);
    this.rdVal.textContent = `${rd} 区块`;
    this.sensSlider.value = String(Math.round(sens * 100));
    this.sensVal.textContent = `${Math.round(sens * 100)}%`;
    this.fovSlider.value = String(fov);
    this.fovVal.textContent = `${fov}°`;
  }

  // ---------- 方块库 ----------
  private buildPalette() {
    this.paletteOverlay = h('div', 'overlay palette-overlay');
    const panel = h('div', 'mc-panel palette-panel');
    const head = h('div', 'palette-head');
    head.appendChild(h('div', 'panel-title', '方块库'));
    const close = this.mcButton('✕', () => this.opts.onPaletteClose(), 'mc-btn-small palette-close');
    head.appendChild(close);
    panel.appendChild(head);

    this.paletteSearch = h('input', 'mc-input palette-search') as HTMLInputElement;
    this.paletteSearch.placeholder = '搜索方块…';
    this.paletteSearch.addEventListener('input', () => this.fillPalette(this.paletteSearch.value.trim()));
    panel.appendChild(this.paletteSearch);

    this.paletteGrid = h('div', 'palette-grid');
    panel.appendChild(this.paletteGrid);
    panel.appendChild(h('div', 'menu-note', '点击方块放入当前快捷栏格子'));
    this.paletteOverlay.appendChild(panel);
    this.paletteOverlay.style.display = 'none';
    this.root.appendChild(this.paletteOverlay);
    this.fillPalette('');
  }

  fillPalette(filter: string) {
    this.paletteGrid.innerHTML = '';
    const f = filter.toLowerCase();
    const survival = this.opts.isSurvival();

    /** 先写入 slot 再通知（否则手持模型读到旧物品），并把被覆盖的旧物品挪到空格 */
    const assign = (stack: Stack, label: string) => {
      const i = this.opts.hotbar.index;
      const old = this.opts.hotbar.slots[i];
      if (old && (old.kind !== stack.kind || old.id !== stack.id)) {
        const empty = this.opts.hotbar.slots.findIndex((s) => s === null);
        if (empty >= 0) this.opts.hotbar.slots[empty] = old;
      }
      this.opts.hotbar.slots[i] = stack;
      this.opts.onAssign(stack.kind === 'block' ? (stack.id as BlockId) : 0);
      this.updateHotbar();
      this.toast(`已放入快捷栏 第 ${i + 1} 格：${label}`);
    };

    const addCell = (stack: Stack, label: string, count: number, icon: string) => {
      const cell = h('button', 'palette-cell');
      const img = h('img') as HTMLImageElement;
      img.src = icon;
      img.alt = label;
      img.draggable = false;
      cell.append(img, h('span', '', label));
      if (survival) cell.appendChild(h('span', 'palette-count', `x${count}`));
      cell.addEventListener('click', () => assign(stack, label));
      this.paletteGrid.appendChild(cell);
    };

    for (const def of this.opts.registry.all()) {
      if (f && !def.label.toLowerCase().includes(f) && !def.name.includes(f)) continue;
      const stack: Stack = { kind: 'block', id: def.id };
      const count = this.opts.getCount(stack);
      if (survival && count <= 0) continue;
      addCell(stack, def.label, count, this.icon(stack));
    }
    // 物品也要能重新指派，否则苹果等被取样覆盖后就再也拿不回快捷栏
    for (const [name, item] of Object.entries(ITEMS)) {
      if (f && !item.label.toLowerCase().includes(f) && !name.includes(f)) continue;
      const stack: Stack = { kind: 'item', id: name };
      const count = this.opts.getCount(stack);
      if (survival && count <= 0) continue;
      addCell(stack, item.label, count, this.icon(stack));
    }
    if (this.paletteGrid.children.length === 0) {
      this.paletteGrid.appendChild(h('div', 'palette-empty',
        survival ? '背包里还没有方块，先去挖一些吧' : '没有匹配的方块'));
    }
  }

  rebuildPalette() {
    this.iconCache.clear();
    this.fillPalette(this.paletteSearch.value.trim());
    this.updateHotbar();
  }

  showPalette(v: boolean) {
    this.paletteOverlay.style.display = v ? '' : 'none';
    if (v) {
      this.paletteSearch.value = '';
      this.fillPalette('');
    }
  }

  get paletteOpen() {
    return this.paletteOverlay.style.display !== 'none';
  }

  get menuOpen() {
    return this.menuOverlay.style.display !== 'none';
  }

  // ---------- 死亡 ----------
  private buildDeath() {
    this.deathOverlay = h('div', 'overlay death-overlay');
    const panel = h('div', 'death-panel');
    panel.appendChild(h('div', 'death-title', '你死了！'));
    this.deathCause = h('div', 'death-cause', '');
    panel.appendChild(this.deathCause);
    const row = h('div', 'death-actions');
    row.appendChild(this.mcButton('重生', () => this.opts.onRespawn(), 'mc-btn-big'));
    row.appendChild(this.mcButton('返回标题', () => this.opts.onQuitToTitle()));
    panel.appendChild(row);
    panel.appendChild(h('div', 'menu-note', '物品会保留在背包里'));
    this.deathOverlay.appendChild(panel);
    this.deathOverlay.style.display = 'none';
    this.root.appendChild(this.deathOverlay);
  }

  showDeath(cause: string) {
    this.deathCause.textContent = cause ? `死因：${cause}` : '';
    this.deathOverlay.style.display = '';
  }

  hideDeath() {
    this.deathOverlay.style.display = 'none';
  }

  get deathOpen() {
    return this.deathOverlay.style.display !== 'none';
  }

  // ---------- 帮助 ----------
  private buildHelp() {
    this.helpOverlay = h('div', 'overlay help-overlay');
    const panel = h('div', 'mc-panel help-panel');
    panel.appendChild(h('div', 'panel-title', '操作说明'));
    const cols = h('div', 'help-cols');

    const desk = h('div', 'help-col');
    desk.appendChild(h('h3', '', '键盘 / 鼠标'));
    const rows: [string, string][] = [
      ['W A S D', '移动'],
      ['空格', '跳跃 / 水中上浮'],
      ['双击空格 或 F', '切换飞行（仅创造模式）'],
      ['Shift', '潜行（慢速）'],
      ['Ctrl 或 双击W', '疾跑（消耗饥饿）'],
      ['鼠标左键', '破坏方块：生存模式需按住直到进度条满'],
      ['鼠标右键', '放置方块；手持食物时进食'],
      ['鼠标中键', '取样准星方块'],
      ['滚轮 / 1-9', '切换快捷栏'],
      ['E', '方块库（生存模式只显示已有方块）'],
      ['F5', '第一 / 第三人称视角'],
      ['F3', '调试信息'],
      ['F1', '隐藏界面'],
      ['Esc', '菜单'],
    ];
    for (const [k, v] of rows) {
      const row = h('div', 'help-row');
      row.appendChild(h('kbd', '', k));
      row.appendChild(h('span', '', v));
      desk.appendChild(row);
    }
    cols.appendChild(desk);

    const mob = h('div', 'help-col');
    mob.appendChild(h('h3', '', '触屏'));
    const mrows: [string, string][] = [
      ['左下摇杆', '移动（推满疾跑）'],
      ['右侧拖动', '转动视角'],
      ['右侧轻点', '敲击方块（生存模式累积进度）'],
      ['⛏ 按钮', '按住连续挖掘'],
      ['⬡ 按钮', '放置方块 / 手持食物时进食'],
      ['▲ 按钮', '跳跃（双击切换飞行）'],
      ['▼ 按钮', '飞行下降 / 潜行'],
      ['点击快捷栏', '选择物品'],
    ];
    for (const [k, v] of mrows) {
      const row = h('div', 'help-row');
      row.appendChild(h('kbd', '', k));
      row.appendChild(h('span', '', v));
      mob.appendChild(row);
    }
    mob.appendChild(h('div', 'help-tip', '生存提示：树叶可能掉苹果，猪掉猪排，夜晚僵尸会出现。摔落、溺水、饥饿都会掉血。'));
    cols.appendChild(mob);
    panel.appendChild(cols);
    panel.appendChild(this.mcButton('关闭', () => this.showHelp(false), 'mc-btn-big'));
    this.helpOverlay.appendChild(panel);
    this.helpOverlay.style.display = 'none';
    this.root.appendChild(this.helpOverlay);
  }

  showHelp(v: boolean) {
    this.helpOverlay.style.display = v ? '' : 'none';
  }

  get helpOpen() {
    return this.helpOverlay.style.display !== 'none';
  }
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
