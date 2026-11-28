import { clamp, type BlockId, type GameMode } from '../core/types';
import { WARMTH, COLD } from '../core/tuning';
import type { FrameTarget, GenThreads, MesherThreads, Options, QualityMode, RandomTickSpeed } from '../core/options';
import type { BlockRegistry } from '../world/blocks';
import type { TextureAtlas } from '../gfx/atlas';
import type { HotbarState, MiningState } from '../player/player';
import { ITEMS, MAX_BREATH, MAX_HUNGER, MAX_HEALTH, type Stack } from '../player/survival';
import { CraftingPanel, type CraftingHost } from './crafting';
import { CampfirePanel } from './campfire';
import { ENGINE_NAME, PLUGIN_API_VERSION, RELEASE, VERSION } from '../core/version';
import type { HudAnchor, SlotDecorator } from '../services/ui/PanelHost';

/**
 * HUD 与全部界面：标题屏 / 加载 / 快捷栏 / 生命饥饿 / 方块库 / 暂停菜单 / 设置页 / 死亡界面。
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
  onVolume: (v: number) => void;
  onInvertY: (v: boolean) => void;
  onResetOptions: () => void;
  onOptionsOpen: (from: 'game' | 'menu' | 'title') => void;
  onOptionsClose: () => void;
  getOptions: () => Options;
  onQuality: (v: QualityMode) => void;
  /** 动态分辨率开关（auto 画质下允许 governor 逐帧调分辨率） */
  onDynamicResolution: (v: boolean) => void;
  /** 目标帧率档（governor 的预算来源） */
  onFrameTarget: (v: FrameTarget) => void;
  /** 开发者：地形生成线程（0 = 主线程同步） */
  onGenThreads: (v: GenThreads) => void;
  onParticles: (v: boolean) => void;
  onViewBob: (v: boolean) => void;
  onAutoJump: (v: boolean) => void;
  onTouchSensitivity: (v: number) => void;
  onDebugOverlay: (v: boolean) => void;
  onGreedy: (v: boolean) => void;
  onMesherThreads: (v: MesherThreads) => void;
  onAutosaveInterval: (v: number) => void;
  /** 实验性内容开关（WASM 内核 / 插件载体） */
  onExperimental: (v: boolean) => void;
  /** 实验性内容：横屏模式（锁定设备横屏 + 宽屏 HUD 适配） */
  onLandscapeMode: (v: boolean) => void;
  /** 实验性玩法：随机刻速度档位 */
  onRandomTickSpeed: (v: RandomTickSpeed) => void;
  /** 实验性玩法：推进昼夜循环 */
  onDaylightCycle: (v: boolean) => void;
  /** 实验性玩法：死亡保留背包 */
  onKeepInventory: (v: boolean) => void;
  /** 实验性玩法：自动维持生物种群 */
  onMobSpawning: (v: boolean) => void;
  /** 实验性玩法：渲染体素云层 */
  onShowClouds: (v: boolean) => void;
  /** 实验性玩法：方块重力 */
  onBlockGravity: (v: boolean) => void;
  /** 实验性玩法：火焰蔓延 */
  onFireSpread: (v: boolean) => void;
  /** 实验性玩法：天气与季节 */
  onWeather: (v: boolean) => void;
  /** 实验性玩法：透明通道距离排序 */
  onSortTransparent: (v: boolean) => void;
  /** 原版界面风格开关（默认开启，设置页「视频」分组） */
  onVanillaUI: (v: boolean) => void;
  /** 3D 实验：密度场地形（新建世界生效） */
  onDensityTerrain: (v: boolean) => void;
  /** 3D 实验：导入 ZIP / PNG 材质包 */
  onTexturePackImport: (files: File[]) => void;
  /** 导出当前设置为 JSON 文本（设置页「导出设置」） */
  onExportOptions: () => string;
  onCopyOptions: (json: string) => void;
  onImportOptions: (json: string) => void;
  onPaletteOpen: (from: 'game' | 'menu') => void;
  onPaletteClose: () => void;
  /** 合成面板：背包宿主（由组装根实现，UI 不直接碰 SurvivalState） */
  craftingHost: CraftingHost;
  /** 打开合成界面（from: 'game' = 游戏中，'menu' = 从菜单进入） */
  onCraftOpen: (from: 'game' | 'menu') => void;
  /** 关闭营火界面（恢复输入 / 指针锁） */
  onCampfireClose: (x: number, y: number, z: number) => void;
  onRespawn: () => void;
  onModeToggle: () => void;
  onExportSave: () => void;
  onImportSave: () => void;
  /** 按键设置：读取绑定行（动作 / 名称 / 当前键标签）与写回 */
  getBindings: () => Array<{ action: string; label: string; keyLabel: string }>;
  onRebind: (action: string, code: string) => void;
  onResetBindings: () => void;
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

/** 温暖指示的火焰图标（像素风实心 + 深描边，与状态图标同一套渲染） */
const WARMTH_FLAME_PATH =
  'M12 2C14 5 9 6.5 9 10a3 3 0 0 0 6 0c0-1.5-1-2.5-1-2.5c2.5 1.2 4.5 3.5 4.5 6.5a7 7 0 1 1-14 0C4.5 8 9.5 5.5 12 2z';

/** 设置页循环行的候选值：画质 / 网格化线程 / 自动保存间隔 */
const QUALITY_CHOICES: { value: QualityMode; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'high', label: '高' },
  { value: 'balanced', label: '均衡' },
  { value: 'power', label: '省电' },
];
const THREAD_CHOICES: { value: MesherThreads; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'main', label: '主线程' },
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 4, label: '4' },
];
/** 目标帧率候选（自动 = 跟随屏幕实测刷新率） */
const FRAME_TARGET_CHOICES: { value: FrameTarget; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 30, label: '30' },
  { value: 60, label: '60' },
  { value: 120, label: '120' },
];
/** 地形生成线程候选（与网格化线程同风格；主线程项用 0 表达） */
const GEN_THREAD_CHOICES: { value: GenThreads; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 0, label: '主线程' },
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 4, label: '4' },
];
const AUTOSAVE_CHOICES: { value: number; label: string }[] = [
  { value: 0, label: '关闭' },
  { value: 8, label: '8 秒' },
  { value: 15, label: '15 秒' },
  { value: 30, label: '30 秒' },
];
/** 实验性玩法「随机刻速度」候选档位（对齐原版 /gamerule randomTickSpeed 的语义） */
const TICK_SPEED_CHOICES: { value: RandomTickSpeed; label: string }[] = [
  { value: 0, label: '暂停' },
  { value: 1, label: '慢' },
  { value: 2, label: '标准' },
  { value: 3, label: '快' },
];

/** 循环行当前值对应的展示文案（找不到候选时退回原始值） */
const choiceLabel = <T extends string | number>(
  choices: readonly { value: T; label: string }[], v: T,
): string => choices.find((c) => c.value === v)?.label ?? String(v);

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
  // 插件 UI 宿主（PanelHost）的底层挂点：菜单按钮行 / HUD 锚点 / 快捷栏装饰器 / 通用面板
  private menuBtnRow!: HTMLElement;
  private anchors = new Map<HudAnchor, HTMLElement>();
  private slotDecorators = new Set<SlotDecorator>();
  private pluginOverlay!: HTMLElement;
  private pluginTitle!: HTMLElement;
  private pluginBody!: HTMLElement;
  private pluginOnClose: (() => void) | null = null;
  private itemName!: HTMLElement;
  private debugEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private underwater!: HTMLElement;
  private flashEl!: HTMLElement;
  private hurtEl!: HTMLElement;
  private toastEl!: HTMLElement;
  private saveNote!: HTMLElement;
  private statsWrap!: HTMLElement;
  private xpWrap!: HTMLElement;
  private xpBar!: HTMLElement;
  private xpFill!: HTMLElement;
  private xpLevel!: HTMLElement;
  private heartsRow!: HTMLElement;
  private hungerRow!: HTMLElement;
  private breathRow!: HTMLElement;
  private warmthMeter!: HTMLElement;
  private warmthFill!: HTMLElement;
  private warmthGlow!: HTMLElement;
  private miningBar!: HTMLElement;
  private miningFill!: HTMLElement;
  private menuOverlay!: HTMLElement;
  private optionsOverlay!: HTMLElement;
  private paletteOverlay!: HTMLElement;
  private paletteGrid!: HTMLElement;
  private paletteSearch!: HTMLInputElement;
  private helpOverlay!: HTMLElement;
  private keybindOverlay!: HTMLElement;
  private keybindList!: HTMLElement;
  private keybindCapture: string | null = null;
  private deathOverlay!: HTMLElement;
  private deathCause!: HTMLElement;
  private deathNote!: HTMLElement;
  private soundBtn!: HTMLButtonElement;
  private flyBtn!: HTMLButtonElement;
  private rdSlider!: HTMLInputElement;
  private sensSlider!: HTMLInputElement;
  private fovSlider!: HTMLInputElement;
  private volumeSlider!: HTMLInputElement;
  private rdVal!: HTMLElement;
  private sensVal!: HTMLElement;
  private fovVal!: HTMLElement;
  private volumeVal!: HTMLElement;
  private soundRow!: HTMLButtonElement;
  private invertRow!: HTMLButtonElement;
  private touchSensSlider!: HTMLInputElement;
  private touchSensVal!: HTMLElement;
  private qualityRow!: HTMLButtonElement;
  /** 动态分辨率开关行（auto 画质下生效） */
  private dynamicResRow!: HTMLButtonElement;
  /** 目标帧率循环行 */
  private frameTargetRow!: HTMLButtonElement;
  /** 开发者：地形生成线程循环行 */
  private genThreadsRow!: HTMLButtonElement;
  private particlesRow!: HTMLButtonElement;
  private viewBobRow!: HTMLButtonElement;
  private autoJumpRow!: HTMLButtonElement;
  private debugRow!: HTMLButtonElement;
  private greedyRow!: HTMLButtonElement;
  private threadsRow!: HTMLButtonElement;
  private autosaveRow!: HTMLButtonElement;
  private experimentalRow?: HTMLButtonElement;
  private densityTerrainRow?: HTMLButtonElement;
  private texturePackStatus?: HTMLElement;
  private landscapeRow?: HTMLButtonElement;
  private tickSpeedRow?: HTMLButtonElement;
  private daylightRow?: HTMLButtonElement;
  private keepInvRow?: HTMLButtonElement;
  private mobSpawnRow?: HTMLButtonElement;
  private cloudsRow?: HTMLButtonElement;
  private gravityRow?: HTMLButtonElement;
  private fireSpreadRow?: HTMLButtonElement;
  private weatherRow?: HTMLButtonElement;
  private sortRow?: HTMLButtonElement;
  private vanillaUIRow?: HTMLButtonElement;
  private ioOverlay!: HTMLElement;
  private ioTitle!: HTMLElement;
  private ioTextArea!: HTMLTextAreaElement;
  private ioCopyBtn!: HTMLButtonElement;
  private ioApplyBtn!: HTMLButtonElement;
  private aboutOverlay!: HTMLElement;
  private rotateHint!: HTMLElement;
  private modeBtns: HTMLButtonElement[] = [];
  private menuModeBtn!: HTMLButtonElement;
  private crafting!: CraftingPanel;
  private campfire!: CampfirePanel;

  hudHidden = false;
  private itemNameTimer = 0;
  private toastTimer = 0;
  /** N5：自动保存提示单一定时器，连续触发不堆叠 */
  private savedNoteTimer = 0;
  private pips: HTMLElement[] = [];
  private lastStats = { health: -1, hunger: -1, saturation: -1, breath: -1, warmth: -1, mode: '' as string, weather: '' as string };
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
    this.buildOptions();
    this.buildAbout();
    this.buildPalette();
    this.buildHelp();
    this.buildKeybinds();
    this.buildDeath();
    this.buildRotateHint();
    // 合成面板独立于 HUD 其余部分，但同样挂在 hud-root 下以复用遮罩与层级
    this.crafting = new CraftingPanel(opts.craftingHost, opts.atlas, opts.registry);
    this.root.appendChild(this.crafting.root);
    this.buildPluginPanel();
    // 营火面板与合成面板同级挂载，复用遮罩与层级
    this.campfire = new CampfirePanel(
      opts.craftingHost, opts.atlas, opts.registry, opts.onCampfireClose,
    );
    this.root.appendChild(this.campfire.root);
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

    const linkRow = h('div', 'title-links');
    const helpLink = h('button', 'link-btn', '操作说明');
    helpLink.addEventListener('click', () => this.showHelp(true));
    const optionsLink = h('button', 'link-btn', '设置');
    optionsLink.addEventListener('click', () => this.opts.onOptionsOpen('title'));
    const aboutLink = h('button', 'link-btn', '关于本项目');
    aboutLink.addEventListener('click', () => this.showAbout(true));
    linkRow.append(helpLink, optionsLink, aboutLink);
    inner.appendChild(linkRow);

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
    // 温暖暖光：fixed 定位的暖色径向光晕，强度随 warmth（不拦截输入）
    this.warmthGlow = h('div');
    this.warmthGlow.id = 'warmth-glow';
    this.gameHud.appendChild(this.warmthGlow);

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
    // 轻量温暖指示：火焰小图标 + 细条，悬在生命行上方，不新增 10 格行
    this.warmthMeter = h('div', 'warmth-meter');
    const flame = h('span', 'warmth-flame');
    flame.innerHTML = `<svg viewBox="0 0 24 24"><path d="${WARMTH_FLAME_PATH}"/></svg>`;
    const bar = h('span', 'warmth-bar');
    this.warmthFill = h('span', 'warmth-fill');
    bar.appendChild(this.warmthFill);
    this.warmthMeter.append(flame, bar);
    this.statsWrap.appendChild(this.warmthMeter);
    this.statsWrap.style.display = 'none';
    this.gameHud.appendChild(this.statsWrap);

    // 经验条（Java 版 1.20 标志性 HUD：绿色弧形进度 + 等级数字，位于快捷栏正上方）
    this.xpWrap = h('div', 'xp-wrap');
    this.xpLevel = h('div', 'xp-level', '0');
    this.xpBar = h('div', 'xp-bar');
    this.xpFill = h('div', 'xp-fill');
    this.xpBar.appendChild(this.xpFill);
    this.xpWrap.append(this.xpLevel, this.xpBar);
    this.gameHud.appendChild(this.xpWrap);

    // 快捷栏
    const hotbarWrap = h('div', 'hotbar-wrap');
    this.itemName = h('div', 'item-name');
    hotbarWrap.appendChild(this.itemName);
    const anchorRow = h('div', 'hud-anchor-row');
    for (const name of ['above-hotbar-left', 'above-hotbar-right'] as const) {
      const el = h('div', `hud-anchor hud-anchor-${name}`);
      this.anchors.set(name, el);
      anchorRow.appendChild(el);
    }
    hotbarWrap.appendChild(anchorRow);
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
      this.opts.isMobile ? '' : '左键按住破坏/拍球 · 右键放置/进食/投掷 · 滚轮/1-9切换 · 中键取样 · E方块库 · F5视角 · F3调试');
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
      for (const fn of this.slotDecorators) {
        try {
          fn(this.slotEls[i], stack, i);
        } catch (err) {
          console.error('[hud] 快捷栏装饰器异常', err);
        }
      }
    }
  }

  // ---------- 插件 UI 挂点（经 PanelHost 暴露给插件） ----------

  anchor(name: HudAnchor): HTMLElement {
    const el = this.anchors.get(name);
    if (!el) throw new Error(`[hud] 未知锚点: ${name}`);
    return el;
  }

  addSlotDecorator(fn: SlotDecorator): () => void {
    this.slotDecorators.add(fn);
    this.updateHotbar();
    return () => {
      if (this.slotDecorators.delete(fn)) this.updateHotbar();
    };
  }

  addMenuButton(label: string, onClick: () => void): () => void {
    const b = this.mcButton(label, onClick);
    this.menuBtnRow.appendChild(b);
    return () => b.remove();
  }

  private buildPluginPanel() {
    this.pluginOverlay = h('div', 'overlay plugin-panel-overlay');
    const panel = h('div', 'mc-panel plugin-panel');
    const head = h('div', 'crafting-head');
    this.pluginTitle = h('div', 'panel-title');
    head.append(this.pluginTitle, this.mcButton('关闭', () => this.pluginOnClose?.(), 'mc-btn-small'));
    this.pluginBody = h('div', 'plugin-panel-body');
    panel.append(head, this.pluginBody);
    this.pluginOverlay.appendChild(panel);
    this.pluginOverlay.style.display = 'none';
    this.root.appendChild(this.pluginOverlay);
  }

  showPluginPanel(title: string, root: HTMLElement, onClose: () => void) {
    this.pluginTitle.textContent = title;
    this.pluginBody.replaceChildren(root);
    this.pluginOnClose = onClose;
    this.pluginOverlay.style.display = '';
  }

  hidePluginPanel() {
    this.pluginOverlay.style.display = 'none';
    this.pluginBody.replaceChildren();
    this.pluginOnClose = null;
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
    window.clearTimeout(this.savedNoteTimer);
    this.savedNoteTimer = window.setTimeout(() => this.saveNote.classList.remove('show'), 2500);
  }

  toggleHudHidden() {
    this.hudHidden = !this.hudHidden;
    this.gameHud.classList.toggle('hud-hidden', this.hudHidden);
  }

  // ---------- 生存状态 ----------

  /** 每帧调用；内部做变化检测，避免频繁重排 DOM */
  setSurvival(s: {
    health: number; hunger: number; saturation: number; breath: number; warmth: number;
    mode: GameMode; dead: boolean;
    /** 当前天气形态，用于低温暖时叠加冷色调（可选，旧调用方零改动） */
    weather?: 'clear' | 'rain' | 'snow' | 'thunder';
  } | null) {
    const survival = !!s && s.mode === 'survival';
    this.statsWrap.style.display = survival && !this.hudHidden ? '' : 'none';
    if (!s || !survival) {
      // 创造 / 无状态：暖光熄灭，温暖指示隐藏
      this.warmthGlow.style.opacity = '0';
      this.warmthMeter.classList.remove('show');
      return;
    }
    if (s.health === this.lastStats.health && s.hunger === this.lastStats.hunger &&
      s.saturation === this.lastStats.saturation &&
      s.breath === this.lastStats.breath && s.warmth === this.lastStats.warmth &&
      s.mode === this.lastStats.mode && (s.weather ?? '') === this.lastStats.weather) return;
    this.lastStats = {
      health: s.health, hunger: s.hunger, saturation: s.saturation,
      breath: s.breath, warmth: s.warmth, mode: s.mode, weather: s.weather ?? '',
    };

    // 温暖表现：屏幕暖光强度 + 火焰细条 + 达标高亮（阈值来自 tuning）
    const warmth = clamp(s.warmth ?? 0, 0, 100);
    // 恶劣天气 + 低温暖：屏幕叠一层冷色，提示该靠近热源了
    const cold = warmth < COLD.warmthThreshold && !!s.weather && s.weather !== 'clear';
    // 冷色提示必须可见： warmth 越低原暖光透明度越接近 0，直接复用会恰好在最该提示时看不见
    const glowOpacity = warmth / 100 * 0.35;
    this.warmthGlow.style.opacity = (cold ? Math.max(glowOpacity, 0.3) : glowOpacity).toFixed(3);
    this.warmthMeter.classList.toggle('show', warmth > 0.5);
    this.warmthFill.style.width = `${warmth}%`;
    this.warmthMeter.classList.toggle('warm', warmth >= WARMTH.regenThreshold);
    this.warmthGlow.classList.toggle('cold', cold);

    // 饱和度视觉：有缓冲时暖色微光，耗尽时鸡腿变暗（互斥）
    this.hungerRow.classList.toggle('satiated', s.saturation > 0);
    this.hungerRow.classList.toggle('drained', s.saturation <= 0 && s.hunger > 0);

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

  /**
   * 经验条（Java 版 HUD 元素）。本项目暂无经验系统，默认显示 0 级空条作为视觉还原；
   * 未来接入经验时由组装根每帧调用本方法即可，无需改布局。
   */
  setExperience(level: number, progress: number) {
    this.xpLevel.textContent = String(Math.max(0, Math.floor(level)));
    this.xpFill.style.width = `${Math.max(0, Math.min(1, progress)) * 100}%`;
  }

  setMining(state: MiningState | null) {
    // N3：裂痕阶段与目标键由 main 帧循环交给 CrackOverlay，HUD 只维护弱化后的辅助绿条
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

    const btnRow = h('div', 'menu-row');
    btnRow.appendChild(this.mcButton('操作说明', () => this.showHelp(true)));
    // 必须交给组装根打开面板：paletteReturn 需要记住 'menu'，
    // 否则关闭面板会直接恢复游戏而不是回到菜单（v1.3.2 修复）。
    btnRow.appendChild(this.mcButton('方块库', () => this.opts.onPaletteOpen('menu')));
    btnRow.appendChild(this.mcButton('设置', () => this.opts.onOptionsOpen('menu')));
    // 工作台：生存模式下随时可开（材料来自背包），与右键工作台方块等价
    btnRow.appendChild(this.mcButton('工作台', () => this.opts.onCraftOpen('menu')));
    btnRow.appendChild(this.mcButton('按键设置', () => this.showKeybinds(true)));
    panel.appendChild(btnRow);
    this.menuBtnRow = btnRow;

    const saveRow = h('div', 'menu-row');
    saveRow.appendChild(this.mcButton('导出存档', () => this.opts.onExportSave(), 'mc-btn-small'));
    saveRow.appendChild(this.mcButton('导入存档', () => this.opts.onImportSave(), 'mc-btn-small'));
    panel.appendChild(saveRow);

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
    panel.appendChild(this.mcButton('关于本项目', () => this.showAbout(true)));
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

  // ---------- 设置页 ----------
  /** 原版风滑杆行：菜单与设置页共用，避免两处各写一份 */
  private sliderRow(
    label: string, min: number, max: number, step: number, val: number,
    fmt: (v: number) => string, cb: (v: number) => void,
  ): { row: HTMLElement; input: HTMLInputElement; val: HTMLElement } {
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
    return { row, input, val: valEl };
  }

  /** 原版选项行：整行可点，右侧显示当前值（开 / 关） */
  private optionRow(label: string, onToggle: () => void): HTMLButtonElement {
    const b = h('button', 'mc-btn opt-row') as HTMLButtonElement;
    b.append(h('span', 'opt-label', label), h('span', 'opt-val', ''));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onToggle();
    });
    return b;
  }

  /** 循环选项行：整行可点，点击在候选值间轮转（画质 / 线程数 / 保存间隔） */
  private cycleRow<T extends string | number>(
    label: string, choices: readonly { value: T; label: string }[], get: () => T,
    cb: (v: T) => void,
  ): HTMLButtonElement {
    const b = h('button', 'mc-btn opt-row') as HTMLButtonElement;
    const valEl = h('span', 'opt-val', '');
    b.append(h('span', 'opt-label', label), valEl);
    const sync = () => {
      const cur = get();
      const hit = choices.find((c) => c.value === cur);
      valEl.textContent = hit ? hit.label : String(cur);
      b.title = `${label}：${choices.map((c) => c.label).join(' / ')}`;
    };
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const cur = get();
      const i = choices.findIndex((c) => c.value === cur);
      const next = choices[(i + 1 + choices.length) % choices.length].value;
      cb(next);
      sync();
    });
    sync();
    return b;
  }

  /** 刷新某个选项行右侧的值显示 */
  private setRowVal(row: HTMLButtonElement, text: string, off = false) {
    const el = row.querySelector('.opt-val') as HTMLElement | null;
    if (el) el.textContent = text;
    row.classList.toggle('off', off);
  }

  private buildOptions() {
    const o = this.opts.getOptions();
    this.optionsOverlay = h('div', 'overlay options-overlay');
    const panel = h('div', 'mc-panel options-panel');
    panel.appendChild(h('div', 'panel-title', '设置'));

    const group = (title: string): HTMLElement => {
      const g = h('div', 'opt-group');
      g.appendChild(h('h3', '', title));
      panel.appendChild(g);
      return g;
    };

    // ---- 音效 ----
    const audio = group('音效');
    this.soundRow = this.optionRow('音效', () => {
      this.opts.onSoundToggle();
      this.syncOptions(this.opts.getOptions());
    });
    audio.appendChild(this.soundRow);
    const vol = this.sliderRow('音量', 0, 100, 5, o.volume, (v) => `${v}%`, (v) => this.opts.onVolume(v));
    audio.appendChild(vol.row);
    this.volumeSlider = vol.input;
    this.volumeVal = vol.val;

    // ---- 视频 ----
    const video = group('视频');
    const rd = this.sliderRow('渲染距离', 2, 8, 1, o.renderDistance, (v) => `${v} 区块`, (v) => this.opts.onRenderDistance(v));
    video.appendChild(rd.row);
    this.rdSlider = rd.input;
    this.rdVal = rd.val;
    const fov = this.sliderRow('视野 FOV', 60, 95, 1, o.fov, (v) => `${v}°`, (v) => this.opts.onFov(v));
    video.appendChild(fov.row);
    this.fovSlider = fov.input;
    this.fovVal = fov.val;
    this.qualityRow = this.cycleRow('画质', QUALITY_CHOICES,
      () => this.opts.getOptions().quality, (v) => this.opts.onQuality(v));
    video.appendChild(this.qualityRow);
    this.dynamicResRow = this.optionRow('动态分辨率', () => {
      this.opts.onDynamicResolution(!this.opts.getOptions().dynamicResolution);
      this.syncOptions(this.opts.getOptions());
    });
    video.appendChild(this.dynamicResRow);
    video.appendChild(h('div', 'menu-note', '自动档按帧耗时实时升降渲染分辨率，桌面与移动端均可。'));
    this.frameTargetRow = this.cycleRow('目标帧率', FRAME_TARGET_CHOICES,
      () => this.opts.getOptions().frameTarget, (v) => this.opts.onFrameTarget(v));
    video.appendChild(this.frameTargetRow);
    this.particlesRow = this.optionRow('粒子效果', () => {
      this.opts.onParticles(!this.opts.getOptions().particles);
      this.syncOptions(this.opts.getOptions());
    });
    video.appendChild(this.particlesRow);
    this.viewBobRow = this.optionRow('视角摇晃', () => {
      this.opts.onViewBob(!this.opts.getOptions().viewBob);
      this.syncOptions(this.opts.getOptions());
    });
    video.appendChild(this.viewBobRow);
    this.vanillaUIRow = this.optionRow('原版界面风格', () => {
      this.opts.onVanillaUI(!this.opts.getOptions().vanillaUI);
      this.syncOptions(this.opts.getOptions());
    });
    video.appendChild(this.vanillaUIRow);
    video.appendChild(h('div', 'menu-note', '默认开启：原版 Java 版按钮、字体与快捷栏风格，即时生效。'));

    // ---- 控制 ----
    const ctrl = group('控制');
    const sens = this.sliderRow('视角灵敏度', 40, 200, 5, Math.round(o.sensitivity * 100),
      (v) => `${v}%`, (v) => this.opts.onSensitivity(v / 100));
    ctrl.appendChild(sens.row);
    this.sensSlider = sens.input;
    this.sensVal = sens.val;
    this.invertRow = this.optionRow('反转 Y 轴', () => {
      this.opts.onInvertY(!this.opts.getOptions().invertY);
      this.syncOptions(this.opts.getOptions());
    });
    ctrl.appendChild(this.invertRow);
    this.autoJumpRow = this.optionRow('自动跳跃', () => {
      this.opts.onAutoJump(!this.opts.getOptions().autoJump);
      this.syncOptions(this.opts.getOptions());
    });
    ctrl.appendChild(this.autoJumpRow);
    if (this.opts.isMobile) {
      const ts = this.sliderRow('触控灵敏度', 50, 200, 10, Math.round(o.touchSensitivity * 100),
        (v) => `${v}%`, (v) => this.opts.onTouchSensitivity(v / 100));
      ctrl.appendChild(ts.row);
      this.touchSensSlider = ts.input;
      this.touchSensVal = ts.val;
    }

    // ---- 实验性内容（引擎 / 内核）----
    const exp = group('实验性内容');
    this.experimentalRow = this.optionRow('WASM 内核 / 插件载体', () => {
      this.opts.onExperimental(!this.opts.getOptions().experimental);
      this.syncOptions(this.opts.getOptions());
    });
    exp.appendChild(this.experimentalRow);
    // 横屏模式（远端 v1.5.3 既有功能）：锁定设备横向并启用宽屏 HUD
    this.landscapeRow = this.optionRow('横屏模式', () => {
      this.opts.onLandscapeMode(!this.opts.getOptions().landscapeMode);
      this.syncOptions(this.opts.getOptions());
    });
    exp.appendChild(this.landscapeRow);
    exp.appendChild(h('div', 'menu-note', 'WASM 内核与插件载体默认关闭；「我的世界 UI 还原」开关已移至「视频」分组（默认开启，开启后把 HUD 切换为原版 Java 版风格）；「横屏模式」在移动端默认开启、桌面端默认关闭，锁定设备横向并启用宽屏 HUD，竖屏时会提示手动旋转。均即时生效。'));

    // ---- 3D 实验 ----
    const exp3d = group('3D 实验');
    this.densityTerrainRow = this.optionRow('3D 密度场地形（新区块）', () => {
      this.opts.onDensityTerrain(!this.opts.getOptions().densityTerrain);
      this.syncOptions(this.opts.getOptions());
    });
    exp3d.appendChild(this.densityTerrainRow);
    const importRow = h('div', 'menu-row');
    const packInput = h('input') as HTMLInputElement;
    packInput.type = 'file';
    packInput.accept = '.zip,.mcpack,.png,.jpg,.jpeg,.webp,application/zip,image/png';
    packInput.multiple = true;
    packInput.style.display = 'none';
    packInput.addEventListener('change', () => {
      const files = Array.from(packInput.files ?? []);
      if (files.length > 0) this.opts.onTexturePackImport(files);
      packInput.value = '';
    });
    const importBtn = this.mcButton('导入材质包', () => packInput.click());
    importRow.append(importBtn, packInput);
    exp3d.appendChild(importRow);
    this.texturePackStatus = h('div', 'menu-note', '当前材质包：经典（程序化）');
    exp3d.appendChild(this.texturePackStatus);
    exp3d.appendChild(h('div', 'menu-note', '密度地形影响之后生成的区块；8 位顶点光照默认开启，可用 ?lighting=float2 对照。材质包支持 Java / Bedrock 资源包 ZIP、pack.json 或同名 PNG。'));

    // ---- 实验性玩法（对齐原版 gamerule，可随时开关，即时生效）----
    const gamerules = group('实验性玩法');
    this.tickSpeedRow = this.cycleRow('随机刻速度', TICK_SPEED_CHOICES,
      () => this.opts.getOptions().randomTickSpeed, (v) => this.opts.onRandomTickSpeed(v));
    gamerules.appendChild(this.tickSpeedRow);
    this.daylightRow = this.optionRow('昼夜循环', () => {
      this.opts.onDaylightCycle(!this.opts.getOptions().doDaylightCycle);
      this.syncOptions(this.opts.getOptions());
    });
    gamerules.appendChild(this.daylightRow);
    this.keepInvRow = this.optionRow('死亡保留物品', () => {
      this.opts.onKeepInventory(!this.opts.getOptions().keepInventory);
      this.syncOptions(this.opts.getOptions());
    });
    gamerules.appendChild(this.keepInvRow);
    this.mobSpawnRow = this.optionRow('生物生成', () => {
      this.opts.onMobSpawning(!this.opts.getOptions().doMobSpawning);
      this.syncOptions(this.opts.getOptions());
    });
    gamerules.appendChild(this.mobSpawnRow);
    this.cloudsRow = this.optionRow('体素云层', () => {
      this.opts.onShowClouds(!this.opts.getOptions().showClouds);
      this.syncOptions(this.opts.getOptions());
    });
    gamerules.appendChild(this.cloudsRow);
    this.gravityRow = this.optionRow('方块重力', () => {
      this.opts.onBlockGravity(!this.opts.getOptions().blockGravity);
      this.syncOptions(this.opts.getOptions());
    });
    gamerules.appendChild(this.gravityRow);
    this.fireSpreadRow = this.optionRow('火焰蔓延', () => {
      this.opts.onFireSpread(!this.opts.getOptions().fireSpread);
      this.syncOptions(this.opts.getOptions());
    });
    gamerules.appendChild(this.fireSpreadRow);
    this.weatherRow = this.optionRow('天气与季节', () => {
      this.opts.onWeather(!this.opts.getOptions().weather);
      this.syncOptions(this.opts.getOptions());
    });
    gamerules.appendChild(this.weatherRow);
    this.sortRow = this.optionRow('透明排序', () => {
      this.opts.onSortTransparent(!this.opts.getOptions().sortTransparent);
      this.syncOptions(this.opts.getOptions());
    });
    gamerules.appendChild(this.sortRow);
    gamerules.appendChild(h('div', 'menu-note', '前四项对应原版 /gamerule；后四项为渲染/玩法特性对照，全部立即生效并自动保存。'));

    // ---- 开发者 ----
    const dev = group('开发者');
    this.debugRow = this.optionRow('显示调试信息', () => {
      this.opts.onDebugOverlay(!this.opts.getOptions().debugOverlay);
      this.syncOptions(this.opts.getOptions());
    });
    dev.appendChild(this.debugRow);
    this.greedyRow = this.optionRow('Greedy 网格合并', () => {
      this.opts.onGreedy(!this.opts.getOptions().greedy);
      this.syncOptions(this.opts.getOptions());
    });
    dev.appendChild(this.greedyRow);
    this.threadsRow = this.cycleRow('网格化线程', THREAD_CHOICES,
      () => this.opts.getOptions().mesherThreads, (v) => this.opts.onMesherThreads(v));
    dev.appendChild(this.threadsRow);
    this.genThreadsRow = this.cycleRow('生成线程', GEN_THREAD_CHOICES,
      () => this.opts.getOptions().genThreads, (v) => this.opts.onGenThreads(v));
    dev.appendChild(this.genThreadsRow);
    this.autosaveRow = this.cycleRow('自动保存间隔', AUTOSAVE_CHOICES,
      () => this.opts.getOptions().autosaveInterval, (v) => this.opts.onAutosaveInterval(v));
    dev.appendChild(this.autosaveRow);
    const ioRow = h('div', 'menu-row');
    ioRow.appendChild(this.mcButton('导出设置', () => this.showOptionsIO('export')));
    ioRow.appendChild(this.mcButton('导入设置', () => this.showOptionsIO('import')));
    dev.appendChild(ioRow);
    dev.appendChild(h('div', 'menu-note', '开发者项用于调试与基准，改动立即生效'));

    const footer = h('div', 'menu-row options-footer');
    footer.appendChild(this.mcButton('关于本项目', () => this.showAbout(true)));
    footer.appendChild(this.mcButton('重置全部设置', () => {
      this.opts.onResetOptions();
      this.syncOptions(this.opts.getOptions());
    }));
    panel.appendChild(footer);
    panel.appendChild(this.mcButton('完成', () => this.opts.onOptionsClose(), 'mc-btn-big'));
    panel.appendChild(h('div', 'menu-note', '设置自动保存，换世界也保留'));
    this.optionsOverlay.appendChild(panel);
    this.optionsOverlay.style.display = 'none';
    this.root.appendChild(this.optionsOverlay);

    // 设置导入 / 导出面板（复用 overlay + mc-panel）
    this.ioOverlay = h('div', 'overlay options-io-overlay');
    const ioPanel = h('div', 'mc-panel options-io-panel');
    this.ioTitle = h('div', 'panel-title', '导出设置');
    ioPanel.appendChild(this.ioTitle);
    const ta = h('textarea', 'mc-input mc-textarea') as HTMLTextAreaElement;
    ta.spellcheck = false;
    ta.placeholder = '粘贴设置 JSON，然后点「应用」';
    this.ioTextArea = ta;
    ioPanel.appendChild(ta);
    const ioBtns = h('div', 'menu-row');
    this.ioCopyBtn = this.mcButton('复制', () => this.opts.onCopyOptions(ta.value));
    this.ioApplyBtn = this.mcButton('应用', () => this.opts.onImportOptions(ta.value));
    ioBtns.append(this.ioCopyBtn, this.ioApplyBtn, this.mcButton('关闭', () => this.showOptionsIO(false)));
    ioPanel.appendChild(ioBtns);
    this.ioOverlay.appendChild(ioPanel);
    this.ioOverlay.style.display = 'none';
    this.root.appendChild(this.ioOverlay);

    this.syncOptions(o);
  }

  /** 打开 / 关闭设置导入导出面板；mode=false 关闭 */
  showOptionsIO(mode: 'export' | 'import' | false) {
    if (mode === false) {
      this.ioOverlay.style.display = 'none';
      return;
    }
    const exportMode = mode === 'export';
    this.ioTitle.textContent = exportMode ? '导出设置' : '导入设置';
    this.ioTextArea.readOnly = exportMode;
    this.ioTextArea.value = exportMode ? this.opts.onExportOptions() : '';
    this.ioCopyBtn.style.display = exportMode ? '' : 'none';
    this.ioApplyBtn.style.display = exportMode ? 'none' : '';
    this.ioOverlay.style.display = '';
    if (!exportMode) this.ioTextArea.focus();
  }

  get optionsIOOpen() {
    return this.ioOverlay.style.display !== 'none';
  }

  setTexturePackStatus(text: string) {
    if (this.texturePackStatus) this.texturePackStatus.textContent = text;
  }

  /** 用当前设置刷新控件（打开页面、切换开关、重置后调用） */
  syncOptions(o: Options) {
    this.rdSlider.value = String(o.renderDistance);
    this.rdVal.textContent = `${o.renderDistance} 区块`;
    this.sensSlider.value = String(Math.round(o.sensitivity * 100));
    this.sensVal.textContent = `${Math.round(o.sensitivity * 100)}%`;
    this.fovSlider.value = String(o.fov);
    this.fovVal.textContent = `${o.fov}°`;
    this.volumeSlider.value = String(o.volume);
    this.volumeVal.textContent = `${o.volume}%`;
    if (this.touchSensSlider) {
      this.touchSensSlider.value = String(Math.round(o.touchSensitivity * 100));
      this.touchSensVal.textContent = `${Math.round(o.touchSensitivity * 100)}%`;
    }
    this.setRowVal(this.soundRow, o.sound ? '开' : '关', !o.sound);
    this.setRowVal(this.invertRow, o.invertY ? '开' : '关', !o.invertY);
    this.setRowVal(this.particlesRow, o.particles ? '开' : '关', !o.particles);
    this.setRowVal(this.viewBobRow, o.viewBob ? '开' : '关', !o.viewBob);
    this.setRowVal(this.autoJumpRow, o.autoJump ? '开' : '关', !o.autoJump);
    this.setRowVal(this.debugRow, o.debugOverlay ? '开' : '关', !o.debugOverlay);
    this.setRowVal(this.greedyRow, o.greedy ? '开' : '关', !o.greedy);
    this.setRowVal(this.qualityRow, choiceLabel(QUALITY_CHOICES, o.quality));
    this.setRowVal(this.dynamicResRow, o.dynamicResolution ? '开' : '关', !o.dynamicResolution);
    this.setRowVal(this.frameTargetRow, choiceLabel(FRAME_TARGET_CHOICES, o.frameTarget));
    this.setRowVal(this.threadsRow, choiceLabel(THREAD_CHOICES, o.mesherThreads));
    this.setRowVal(this.genThreadsRow, choiceLabel(GEN_THREAD_CHOICES, o.genThreads));
    this.setRowVal(this.autosaveRow, choiceLabel(AUTOSAVE_CHOICES, o.autosaveInterval));
    if (this.experimentalRow) this.setRowVal(this.experimentalRow, o.experimental ? '开' : '关', !o.experimental);
    if (this.densityTerrainRow) this.setRowVal(this.densityTerrainRow, o.densityTerrain ? '开（新区块）' : '关', !o.densityTerrain);
    if (this.landscapeRow) this.setRowVal(this.landscapeRow, o.landscapeMode ? '开' : '关', !o.landscapeMode);
    if (this.tickSpeedRow) this.setRowVal(this.tickSpeedRow, choiceLabel(TICK_SPEED_CHOICES, o.randomTickSpeed), o.randomTickSpeed === 0);
    if (this.daylightRow) this.setRowVal(this.daylightRow, o.doDaylightCycle ? '开' : '关', !o.doDaylightCycle);
    if (this.keepInvRow) this.setRowVal(this.keepInvRow, o.keepInventory ? '开' : '关', !o.keepInventory);
    if (this.mobSpawnRow) this.setRowVal(this.mobSpawnRow, o.doMobSpawning ? '开' : '关', !o.doMobSpawning);
    if (this.cloudsRow) this.setRowVal(this.cloudsRow, o.showClouds ? '开' : '关', !o.showClouds);
    if (this.gravityRow) this.setRowVal(this.gravityRow, o.blockGravity ? '开' : '关', !o.blockGravity);
    if (this.fireSpreadRow) this.setRowVal(this.fireSpreadRow, o.fireSpread ? '开' : '关', !o.fireSpread);
    if (this.weatherRow) this.setRowVal(this.weatherRow, o.weather ? '开' : '关', !o.weather);
    if (this.sortRow) this.setRowVal(this.sortRow, o.sortTransparent ? '开' : '关', !o.sortTransparent);
    if (this.vanillaUIRow) this.setRowVal(this.vanillaUIRow, o.vanillaUI ? '开' : '关', !o.vanillaUI);
  }

  showOptions(v: boolean) {
    this.optionsOverlay.style.display = v ? '' : 'none';
    if (!v) this.ioOverlay.style.display = 'none';
    if (v) {
      this.syncOptions(this.opts.getOptions());
      const panel = this.optionsOverlay.querySelector('.options-panel');
      if (panel) panel.scrollTop = 0;
    }
  }

  get optionsOpen() {
    return this.optionsOverlay.style.display !== 'none';
  }

  // ---------- 关于本项目 ----------
  /** 游戏内「关于」页：版本信息全部来自 version.ts 唯一来源，不在此硬编码 */
  private buildAbout() {
    this.aboutOverlay = h('div', 'overlay about-overlay');
    const panel = h('div', 'mc-panel about-panel');
    panel.appendChild(h('div', 'panel-title', '关于本项目'));

    const meta = h('div', 'about-meta');
    const metaRow = (label: string, value: string) => {
      const r = h('div', 'about-meta-row');
      r.append(h('span', 'about-meta-label', label), h('span', 'about-meta-val', value));
      meta.appendChild(r);
    };
    metaRow('项目', ENGINE_NAME);
    metaRow('正式里程碑', RELEASE);
    metaRow('迭代版本', VERSION);
    metaRow('插件 API 契约', PLUGIN_API_VERSION);
    panel.appendChild(meta);

    const body = h('div', 'about-text');
    const para = (text: string) => body.appendChild(h('p', '', text));
    para('一个架构清晰、依赖极轻的体素 Minecraft 复刻：运行时唯一依赖 three.js，'
      + '体素世界、网格生成、程序化纹理、昼夜天空、物理与 AI 全部手写。');
    para('构建产物是单个自包含 HTML：离线、无外部资源，file:// 双击即可游玩；'
      + '所有纹理均为代码逐像素绘制，不含任何原版资源。');
    para('本项目完全由 AI 生成——全部源码、测试与文档均出自 AI 编程代理，人类仅提出方向。'
      + '生成方式与质量边界见仓库 README 的「关于本项目（诚实说明）」。');
    para('双轨版本号：vN 是正式里程碑（只在发布时推进），X.Y.Z 是日常迭代版；'
      + '实验性内容（WASM 内核 / 插件载体）默认关闭，可在设置页开启。');
    panel.appendChild(body);

    panel.appendChild(h('div', 'menu-note',
      '非官方学习项目，与 Mojang / Microsoft 无关 · 进度自动保存在本机浏览器'));
    panel.appendChild(this.mcButton('返回', () => this.showAbout(false), 'mc-btn-big'));
    this.aboutOverlay.appendChild(panel);
    this.aboutOverlay.style.display = 'none';
    this.root.appendChild(this.aboutOverlay);
  }

  showAbout(v: boolean) {
    this.aboutOverlay.style.display = v ? '' : 'none';
  }

  get aboutOpen() {
    return this.aboutOverlay.style.display !== 'none';
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
        const empty = this.opts.hotbar.slots.indexOf(null);
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

  // ---------- 合成 ----------

  /** 打开合成界面（工作台 3×3） */
  showCrafting(title: string) {
    this.crafting.show(3, title);
  }

  /** 关闭合成界面（材料退回背包由 CraftingPanel 负责） */
  hideCrafting() {
    this.crafting.hide();
  }

  get craftingOpen() {
    return this.crafting.isOpen;
  }

  // ---------- 营火（直接烤） ----------

  /** 打开营火界面 */
  showCampfire(x: number, y: number, z: number) {
    this.campfire.show(x, y, z);
  }

  /** 关闭营火界面（输入 / 输出退回背包） */
  hideCampfire() {
    this.campfire.hide();
  }

  get campfireOpen() {
    return this.campfire.isOpen;
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
    // 文案随「死亡保留物品」开关变化，避免关闭后仍提示保留而误导玩家（v1.5.2 修复）
    this.deathNote = h('div', 'menu-note', '');
    panel.appendChild(this.deathNote);
    this.deathOverlay.appendChild(panel);
    this.deathOverlay.style.display = 'none';
    this.root.appendChild(this.deathOverlay);
  }

  showDeath(cause: string) {
    this.deathCause.textContent = cause ? `死因：${cause}` : '';
    const keep = this.opts.getOptions().keepInventory;
    this.deathNote.textContent = keep ? '物品会保留在背包里' : '物品已从背包掉落（原版规则）';
    this.deathOverlay.style.display = '';
  }

  hideDeath() {
    this.deathOverlay.style.display = 'none';
  }

  get deathOpen() {
    return this.deathOverlay.style.display !== 'none';
  }

  // ---------- 横屏模式：旋转设备提示 ----------
  private buildRotateHint() {
    this.rotateHint = h('div', 'rotate-hint');
    const card = h('div', 'rotate-hint-card');
    const icon = h('div', 'rotate-icon');
    icon.innerHTML = '<svg viewBox="0 0 64 64"><rect x="21" y="6" width="22" height="38" rx="3" fill="none" stroke="currentColor" stroke-width="3"/><path d="M21 47l7 5-7 5" fill="none" stroke="currentColor" stroke-width="3"/><path d="M43 17a15 15 0 1 1-13-8" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M30 4l3 6-7 1" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';
    card.appendChild(icon);
    card.appendChild(h('div', 'rotate-title', '请旋转设备'));
    card.appendChild(h('div', 'rotate-sub', '横屏模式下请将手机/平板横向放置，以获得完整的宽屏游戏体验'));
    // 遮罩会盖住设置页，必须给用户一个主动退出的出口（审查修复）
    card.appendChild(this.mcButton('关闭横屏模式', () => this.opts.onLandscapeMode(false), 'mc-btn-big'));
    this.rotateHint.appendChild(card);
    this.rotateHint.style.display = 'none';
    this.root.appendChild(this.rotateHint);
  }

  /** 应用横屏模式：给根加 class 驱动 CSS 宽屏重排；显隐统一交给 refreshRotateHint。 */
  setLandscape(active: boolean, showRotate: boolean) {
    this.root.classList.toggle('landscape-mode', active);
    this.refreshRotateHint(active, showRotate);
  }

  /** 方向变化时由组装根调用，唯一的旋转提示显隐更新路径。 */
  refreshRotateHint(active: boolean, showRotate: boolean) {
    const portrait = typeof matchMedia === 'function' && matchMedia('(orientation: portrait)').matches;
    this.rotateHint.style.display = active && showRotate && portrait ? '' : 'none';
  }

  // ---------- 帮助 ----------
  private buildHelp() {
    this.helpOverlay = h('div', 'overlay help-overlay');
    const panel = h('div', 'mc-panel help-panel');
    panel.appendChild(h('div', 'panel-title', '操作说明'));
    const cols = h('div', 'help-cols');

    const desk = h('div', 'help-col');
    desk.appendChild(h('h3', '', '键盘 / 鼠标（可在菜单中重绑定）'));
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

    const pad = h('div', 'help-col');
    pad.appendChild(h('h3', '', '手柄（Gamepad）'));
    const prows: [string, string][] = [
      ['左摇杆', '移动'],
      ['右摇杆', '转动视角'],
      ['A', '跳跃 / 上浮'],
      ['B', '潜行 / 下降'],
      ['RB / 按下左摇杆', '疾跑'],
      ['RT / X', '破坏方块'],
      ['LT', '放置方块'],
      ['LB / RB', '上一格 / 下一格'],
      ['Y', '方块库'],
      ['Start', '菜单 / 暂停'],
      ['十字键上/下', '视角 / 飞行'],
      ['十字键左/右', '选第1格 / 隐藏界面'],
    ];
    for (const [k, v] of prows) {
      const row = h('div', 'help-row');
      row.appendChild(h('kbd', '', k));
      row.appendChild(h('span', '', v));
      pad.appendChild(row);
    }
    pad.appendChild(h('div', 'help-tip', '插入手柄或通过蓝牙配对后按任意键即可启用；热插拔无需刷新页面。'));
    cols.appendChild(pad);
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

  // ---------- 按键设置 ----------
  private buildKeybinds() {
    this.keybindOverlay = h('div', 'overlay keybind-overlay');
    const panel = h('div', 'mc-panel keybind-panel');
    panel.appendChild(h('div', 'panel-title', '按键设置'));
    panel.appendChild(h('div', 'menu-note', '点击键位后按下新按键；Esc 取消，冲突键会自动交换。'));
    this.keybindList = h('div', 'keybind-list');
    panel.appendChild(this.keybindList);
    const row = h('div', 'menu-row');
    row.appendChild(this.mcButton('恢复默认', () => {
      this.opts.onResetBindings();
      this.refreshKeybinds();
      this.toast('已恢复默认按键');
    }, 'mc-btn-small'));
    row.appendChild(this.mcButton('完成', () => this.showKeybinds(false), 'mc-btn-big'));
    panel.appendChild(row);
    this.keybindOverlay.appendChild(panel);
    this.keybindOverlay.style.display = 'none';
    this.root.appendChild(this.keybindOverlay);
  }

  /** 重建键位行；捕获中的行显示「按下按键…」 */
  refreshKeybinds() {
    this.keybindList.innerHTML = '';
    for (const b of this.opts.getBindings()) {
      const line = h('div', 'keybind-row');
      line.appendChild(h('span', 'keybind-label', b.label));
      const btn = h('button', 'mc-btn mc-btn-small keybind-key') as HTMLButtonElement;
      const capturing = this.keybindCapture === b.action;
      btn.textContent = capturing ? '按下按键…' : b.keyLabel;
      if (capturing) btn.classList.add('capturing');
      btn.addEventListener('click', () => {
        this.keybindCapture = b.action;
        this.refreshKeybinds();
      });
      line.appendChild(btn);
      this.keybindList.appendChild(line);
    }
  }

  /** 捕获一个按键：若正在等待绑定则消费它，返回是否已消费 */
  captureKey(code: string): boolean {
    if (!this.keybindCapture) return false;
    const action = this.keybindCapture;
    this.keybindCapture = null;
    if (code !== 'Escape') {
      this.opts.onRebind(action, code);
      this.toast('按键已更新');
    }
    this.refreshKeybinds();
    return true;
  }

  showKeybinds(v: boolean) {
    if (v) {
      this.keybindCapture = null;
      this.refreshKeybinds();
    }
    this.keybindOverlay.style.display = v ? '' : 'none';
  }

  get keybindOpen() {
    return this.keybindOverlay.style.display !== 'none';
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
