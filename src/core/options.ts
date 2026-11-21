import { clamp } from './types';

/**
 * 全局游戏设置（设置页）。
 *
 * 与存档内嵌的 `settings` 字段不同，这里是最权威的一份：
 * 独立持久化到 localStorage，跨世界 / 跨存档生效（换世界、删存档都不丢）。
 * main 启动时以本模块为准，改动即写回，并同步进世界存档的 settings 字段。
 */

/** 画质档位：auto = 移动端按帧率自适应；其余为固定渲染分辨率倍率 */
export type QualityMode = 'auto' | 'high' | 'balanced' | 'power';
/** 网格化线程：auto 按核数推断，main 走主线程同步，其余为固定 Worker 数量 */
export type MesherThreads = 'auto' | 'main' | 1 | 2 | 4;

export interface Options {
  /** 音效总开关 */
  sound: boolean;
  /** 音量 0~100 */
  volume: number;
  /** 渲染距离 2~8 区块 */
  renderDistance: number;
  /** 视角灵敏度 0.4~2 */
  sensitivity: number;
  /** 视野 60~95 */
  fov: number;
  /** 反转 Y 轴（鼠标 / 触屏） */
  invertY: boolean;
  /** 画质档位（渲染分辨率倍率） */
  quality: QualityMode;
  /** 粒子效果（破坏碎屑 / 爆炸火花） */
  particles: boolean;
  /** 视角摇晃（走路摆动 + 受击 / 爆炸抖动） */
  viewBob: boolean;
  /** 自动跳跃（移动端默认开，桌面默认关） */
  autoJump: boolean;
  /** 触控视角灵敏度倍率 0.5~2（仅移动端） */
  touchSensitivity: number;
  /** 开发者：常显调试信息（等价于一直按着 F3） */
  debugOverlay: boolean;
  /** 开发者：Greedy 网格合并 */
  greedy: boolean;
  /** 开发者：网格化线程数 */
  mesherThreads: MesherThreads;
  /** 开发者：自动保存间隔（秒），0 = 关闭自动保存 */
  autosaveInterval: number;
  /** 实验性内容：WASM 内核 / 插件三载体（默认关闭，即时生效） */
  experimental: boolean;
  /** 实验性内容：横屏模式（锁定设备横屏并启用宽屏 HUD 布局，即时生效） */
  landscapeMode: boolean;
  /** 实验性玩法：随机刻速度档位 0~3（0=暂停生长，1=慢，2=标准，3=快） */
  randomTickSpeed: RandomTickSpeed;
  /** 实验性玩法：推进昼夜循环（关闭后时间/太阳定格） */
  doDaylightCycle: boolean;
  /** 实验性玩法：死亡保留背包（关闭后死亡清空背包，原版默认行为） */
  keepInventory: boolean;
  /** 实验性玩法：维持生物种群（关闭后不再自动刷新生物） */
  doMobSpawning: boolean;
  /** 实验性玩法：渲染体素云层（关闭后隐藏云并跳过重建，省电） */
  showClouds: boolean;
  /** 实验性玩法：方块重力（沙/砾石下落，关闭后悬空方块保持原位） */
  blockGravity: boolean;
  /** 实验性玩法：透明通道按距离排序（关闭后玻璃/水偶有叠加穿帮） */
  sortTransparent: boolean;
  /** 实验性内容：我的世界 UI 还原（开启后 HUD 切换为原版 Java 版风格） */
  vanillaUI: boolean;
}

/** 随机刻速度档位：0 暂停 / 1 慢 / 2 标准 / 3 快 */
export type RandomTickSpeed = 0 | 1 | 2 | 3;

export const OPTIONS_KEY = 'minecraft-ts-options-v1';

/** 桌面端默认值；移动端默认渲染距离 / 自动跳跃由 main 通过 fallback 覆盖 */
export const DEFAULT_OPTIONS: Options = {
  sound: true,
  volume: 50,
  renderDistance: 5,
  sensitivity: 1,
  fov: 72,
  invertY: false,
  quality: 'auto',
  particles: true,
  viewBob: true,
  autoJump: false,
  touchSensitivity: 1,
  debugOverlay: false,
  greedy: true,
  mesherThreads: 'auto',
  autosaveInterval: 8,
  experimental: false,
  landscapeMode: false,
  randomTickSpeed: 2,
  doDaylightCycle: true,
  keepInventory: true,
  doMobSpawning: true,
  showClouds: true,
  blockGravity: true,
  sortTransparent: true,
  vanillaUI: false,
};

const QUALITY_MODES: readonly QualityMode[] = ['auto', 'high', 'balanced', 'power'];
const MESHER_THREAD_OPTIONS: readonly MesherThreads[] = ['auto', 'main', 1, 2, 4];
const RANDOM_TICK_SPEEDS: readonly RandomTickSpeed[] = [0, 1, 2, 3];

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
const num = (v: unknown, def: number, min: number, max: number) =>
  finite(v) ? clamp(v, min, max) : def;
const pick = <T>(v: unknown, allowed: readonly T[], def: T): T =>
  allowed.includes(v as T) ? (v as T) : def;

/** 画质档位对应的渲染分辨率倍率；auto 返回 null，由引擎按帧率自适应 */
export function qualityScale(mode: QualityMode): number | null {
  if (mode === 'high') return 1;
  if (mode === 'balanced') return 0.85;
  if (mode === 'power') return 0.7;
  return null;
}

/** 网格化线程的合法取值（设置页循环行与导入校验共用） */
export function isMesherThreads(v: unknown): v is MesherThreads {
  return MESHER_THREAD_OPTIONS.includes(v as MesherThreads);
}

/**
 * 读取设置：本地无记录时用 fallback（用于区分桌面 / 移动端的默认值）。
 * 单字段损坏只丢该字段，不会整份退回默认。
 */
export function loadOptions(fallback: Partial<Options> = {}): Options {
  const base: Options = { ...DEFAULT_OPTIONS, ...fallback };
  try {
    const raw = localStorage.getItem(OPTIONS_KEY);
    if (!raw) return base;
    const o = JSON.parse(raw) as Partial<Options>;
    if (!o || typeof o !== 'object') return base;
    return {
      sound: bool(o.sound, base.sound),
      volume: num(o.volume, base.volume, 0, 100),
      renderDistance: Math.round(num(o.renderDistance, base.renderDistance, 2, 8)),
      sensitivity: num(o.sensitivity, base.sensitivity, 0.4, 2),
      fov: Math.round(num(o.fov, base.fov, 60, 95)),
      invertY: bool(o.invertY, base.invertY),
      quality: pick(o.quality, QUALITY_MODES, base.quality),
      particles: bool(o.particles, base.particles),
      viewBob: bool(o.viewBob, base.viewBob),
      autoJump: bool(o.autoJump, base.autoJump),
      touchSensitivity: num(o.touchSensitivity, base.touchSensitivity, 0.5, 2),
      debugOverlay: bool(o.debugOverlay, base.debugOverlay),
      greedy: bool(o.greedy, base.greedy),
      mesherThreads: pick(o.mesherThreads, MESHER_THREAD_OPTIONS, base.mesherThreads),
      autosaveInterval: Math.round(num(o.autosaveInterval, base.autosaveInterval, 0, 120)),
      experimental: bool(o.experimental, base.experimental),
      landscapeMode: bool(o.landscapeMode, base.landscapeMode),
      randomTickSpeed: pick(o.randomTickSpeed, RANDOM_TICK_SPEEDS, base.randomTickSpeed),
      doDaylightCycle: bool(o.doDaylightCycle, base.doDaylightCycle),
      keepInventory: bool(o.keepInventory, base.keepInventory),
      doMobSpawning: bool(o.doMobSpawning, base.doMobSpawning),
      showClouds: bool(o.showClouds, base.showClouds),
      blockGravity: bool(o.blockGravity, base.blockGravity),
      sortTransparent: bool(o.sortTransparent, base.sortTransparent),
      vanillaUI: bool(o.vanillaUI, base.vanillaUI),
    };
  } catch {
    return base;
  }
}

/** 写回本地；存储失败（隐私模式 / 配额）静默忽略，不影响游戏 */
export function persistOptions(o: Options): void {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(o));
  } catch {
    /* 忽略 */
  }
}

/** 把设置钳制回合法区间（导入旧档 / API 传入越界值时用） */
export function normalizeOptions(o: Partial<Options>, fallback: Partial<Options> = {}): Options {
  const base: Options = { ...DEFAULT_OPTIONS, ...fallback, ...o };
  return {
    sound: bool(base.sound, DEFAULT_OPTIONS.sound),
    volume: Math.round(num(base.volume, DEFAULT_OPTIONS.volume, 0, 100)),
    renderDistance: Math.round(num(base.renderDistance, DEFAULT_OPTIONS.renderDistance, 2, 8)),
    sensitivity: num(base.sensitivity, DEFAULT_OPTIONS.sensitivity, 0.4, 2),
    fov: Math.round(num(base.fov, DEFAULT_OPTIONS.fov, 60, 95)),
    invertY: bool(base.invertY, DEFAULT_OPTIONS.invertY),
    quality: pick(base.quality, QUALITY_MODES, DEFAULT_OPTIONS.quality),
    particles: bool(base.particles, DEFAULT_OPTIONS.particles),
    viewBob: bool(base.viewBob, DEFAULT_OPTIONS.viewBob),
    autoJump: bool(base.autoJump, DEFAULT_OPTIONS.autoJump),
    touchSensitivity: num(base.touchSensitivity, DEFAULT_OPTIONS.touchSensitivity, 0.5, 2),
    debugOverlay: bool(base.debugOverlay, DEFAULT_OPTIONS.debugOverlay),
    greedy: bool(base.greedy, DEFAULT_OPTIONS.greedy),
    mesherThreads: pick(base.mesherThreads, MESHER_THREAD_OPTIONS, DEFAULT_OPTIONS.mesherThreads),
    autosaveInterval: Math.round(num(base.autosaveInterval, DEFAULT_OPTIONS.autosaveInterval, 0, 120)),
    experimental: bool(base.experimental, DEFAULT_OPTIONS.experimental),
    landscapeMode: bool(base.landscapeMode, DEFAULT_OPTIONS.landscapeMode),
    randomTickSpeed: pick(base.randomTickSpeed, RANDOM_TICK_SPEEDS, DEFAULT_OPTIONS.randomTickSpeed),
    doDaylightCycle: bool(base.doDaylightCycle, DEFAULT_OPTIONS.doDaylightCycle),
    keepInventory: bool(base.keepInventory, DEFAULT_OPTIONS.keepInventory),
    doMobSpawning: bool(base.doMobSpawning, DEFAULT_OPTIONS.doMobSpawning),
    showClouds: bool(base.showClouds, DEFAULT_OPTIONS.showClouds),
    blockGravity: bool(base.blockGravity, DEFAULT_OPTIONS.blockGravity),
    sortTransparent: bool(base.sortTransparent, DEFAULT_OPTIONS.sortTransparent),
    vanillaUI: bool(base.vanillaUI, DEFAULT_OPTIONS.vanillaUI),
  };
}
