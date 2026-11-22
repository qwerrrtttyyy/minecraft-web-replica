import { WORLD_HEIGHT, type BlockId, type GameMode } from '../core/types';
import {
  MAX_BREATH, MAX_HEALTH, MAX_HUNGER,
  type Stack, type SurvivalSave,
} from '../player/survival';
import { isKnownMaterial } from '../player/smelting';

/**
 * 存档系统（扩展点：CraftAPI.setSaveProvider 可替换为云端/IndexedDB 实现）。
 * 默认使用 localStorage，只保存世界差分、玩家与生存状态，体积极小。
 * v2 增加游戏模式、生命/饥饿/饱和度/背包；读取到 v1 旧档时自动升级并进入创造模式。
 */

export interface SaveData {
  version: 2;
  seed: number;
  mode: GameMode;
  edits: [string, BlockId][];
  player: { x: number; y: number; z: number; yaw: number; pitch: number; fly: boolean };
  survival: SurvivalSave;
  dayTime: number;
  hotbar: (Stack | null)[];
  slot: number;
  settings: {
    sound: boolean;
    renderDistance: number;
    sensitivity: number;
    fov: number;
    /** 设置页：音量 0~100（旧档缺省 50） */
    volume?: number;
    /** 设置页：反转 Y 轴（旧档缺省 false） */
    invertY?: boolean;
  };
  /** v1.6：累计游戏日（旧档缺省 0） */
  dayCount?: number;
  /** v1.6：植物能量 / 土壤养分快照（旧档缺省，植物从初始能量起步） */
  botany?: {
    v: 1;
    plants: [number, number, number, number, number, 0 | 1][];
    soil: [number, number, number, number][];
  };
  /** 熔炉方块实体快照（旧档缺省即无运行中的熔炉） */
  furnaces?: {
    v: 1;
    cells: FurnaceSaveData[];
  };
  savedAt: number;
}

/** 单台熔炉的存档形态：三槽 + 燃烧 / 进度秒数（进度取整到 0.01s） */
export interface FurnaceSaveData {
  pos: [number, number, number];
  input: [string, number] | null;
  fuel: [string, number] | null;
  output: [string, number] | null;
  burn: number;
  burnMax: number;
  progress: number;
}

/** 旧版（v1）存档：快捷栏是纯方块 id 数组，没有生存状态 */
interface LegacySave {
  version: 1;
  seed: number;
  edits: [string, BlockId][];
  player: SaveData['player'];
  dayTime: number;
  hotbar: BlockId[];
  slot: number;
  settings: SaveData['settings'];
  savedAt: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const intIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
/** 有限数值 + 范围：挡住 1e308 这类能通过 finite 但会撑爆区块生成的值 */
const inRange = (v: unknown, min: number, max: number): v is number =>
  finite(v) && v >= min && v <= max;
/** 玩家坐标允许的横向范围（远超正常探索距离，但远小于浮点极端值） */
const MAX_COORD = 1e7;
/** 纵向留一点余量，避免边界存档被误判 */
const inWorldY = (v: unknown): v is number => inRange(v, -64, WORLD_HEIGHT + 64);

/** 编辑差分 key 必须是整数坐标；方块 id 0~255（0 表示挖掉） */
const EDIT_KEY_RE = /^-?\d+,-?\d+,-?\d+$/;
/** 背包 key：i:物品名 / b:方块 id */
const ITEM_KEY_RE = /^i:[A-Za-z0-9_.:-]+$/;
const BLOCK_KEY_RE = /^b:\d+$/;

const isVec3 = (v: unknown): boolean => {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return inRange(o.x, -MAX_COORD, MAX_COORD) && inWorldY(o.y) && inRange(o.z, -MAX_COORD, MAX_COORD);
};

const isStack = (v: unknown): boolean => {
  if (v === null) return true;
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  if (s.kind === 'block') return intIn(s.id, 0, 255);
  if (s.kind === 'item') return typeof s.id === 'string' && ITEM_KEY_RE.test(`i:${s.id}`);
  return false;
};

/** v1.6 生态存档校验：结构严格但字段可选，旧档缺省即跳过 */
const isBotanySave = (v: unknown): boolean => {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  if (b.v !== 1 || !Array.isArray(b.plants) || !Array.isArray(b.soil)) return false;
  for (const p of b.plants) {
    if (!Array.isArray(p) || p.length !== 6) return false;
    // x / z 支持负数（世界允许负坐标），y 限定在有效高度内，id 1..255
    if (!p.slice(0, 4).every((n) => Number.isInteger(n))) return false;
    if ((p[1] as number) < 1 || (p[1] as number) > 79) return false;
    if ((p[3] as number) <= 0 || (p[3] as number) > 255) return false;
    if (!finite(p[4]) || (p[4] as number) < 0 || (p[4] as number) > 100) return false;
    if (p[5] !== 0 && p[5] !== 1) return false;
  }
  for (const s of b.soil) {
    if (!Array.isArray(s) || s.length !== 4) return false;
    if (!s.slice(0, 3).every((n) => Number.isInteger(n))) return false;
    if ((s[1] as number) < 0 || (s[1] as number) > 79) return false;
    if (!finite(s[3]) || (s[3] as number) < 0 || (s[3] as number) > 100) return false;
  }
  return true;
};

/** 熔炉存档校验：结构严格但字段可选，旧档缺省即跳过 */
const isFurnaceSave = (v: unknown): boolean => {
  if (!v || typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  if (f.v !== 1 || !Array.isArray(f.cells)) return false;
  const slotOk = (s: unknown): boolean => {
    if (s === null) return true;
    if (!Array.isArray(s) || s.length !== 2) return false;
    return (typeof s[0] === 'string' && s[0].length > 0 && s[0].length <= 64) &&
      intIn(s[1], 1, 999) && isKnownMaterial(s[0]);
  };
  for (const c of f.cells) {
    if (!c || typeof c !== 'object') return false;
    const cell = c as Record<string, unknown>;
    if (!Array.isArray(cell.pos) || cell.pos.length !== 3 ||
        !cell.pos.every((n) => Number.isInteger(n))) return false;
    const y = (cell.pos as number[])[1];
    if (y < 0 || y > WORLD_HEIGHT) return false;
    if (!slotOk(cell.input) || !slotOk(cell.fuel) || !slotOk(cell.output)) return false;
    const burn = cell.burn, burnMax = cell.burnMax, progress = cell.progress;
    if (!finite(burn) || (burn as number) < 0) return false;
    if (!finite(burnMax) || (burnMax as number) < 0) return false;
    if (!finite(progress) || (progress as number) < 0 || (progress as number) > 60) return false;
  }
  return true;
};

/**
 * 全量存档 schema 校验（v1.2.0）。
 *
 * v1.1.2 只检查了 edits / player.x / survival.inventory / hotbar 四个字段，
 * 其余字段一旦损坏会在 restore、settings 展开、hotbar.map 处二次抛错。
 * 这里一次校验到底，同时供 LocalStorageProvider.load 与 CraftAPI.save.import 使用。
 */
export function validateSave(data: unknown): data is SaveData {
  if (!data || typeof data !== 'object') return false;
  const d = data as Partial<SaveData>;
  if (d.version !== 2 || !finite(d.seed)) return false;
  if (d.mode !== 'survival' && d.mode !== 'creative') return false;
  if (!Array.isArray(d.edits)) return false;
  for (const e of d.edits) {
    if (!Array.isArray(e) || e.length !== 2) return false;
    if (typeof e[0] !== 'string' || !EDIT_KEY_RE.test(e[0])) return false;
    if (!intIn(e[1], 0, 255)) return false;
  }
  const p = d.player;
  if (!p || !inRange(p.x, -MAX_COORD, MAX_COORD) || !inWorldY(p.y) ||
      !inRange(p.z, -MAX_COORD, MAX_COORD) ||
      !finite(p.yaw) || !finite(p.pitch) || typeof p.fly !== 'boolean') return false;
  const s = d.survival;
  if (!s || !inRange(s.health, 0, MAX_HEALTH) || !inRange(s.hunger, 0, MAX_HUNGER) ||
      !inRange(s.breath, 0, MAX_BREATH) ||
      !Array.isArray(s.inventory) || !isVec3(s.spawn)) return false;
  // v1.5.3 饱和度为可选字段：旧档缺省放行，存在时必须落在 0~20
  if (s.saturation !== undefined && !inRange(s.saturation, 0, MAX_HUNGER)) return false;
  // PR5 温暖值为可选字段：旧档缺省放行，存在时必须落在 0~100
  if (s.warmth !== undefined && !inRange(s.warmth, 0, 100)) return false;
  for (const e of s.inventory) {
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string') return false;
    if (!ITEM_KEY_RE.test(e[0]) && !BLOCK_KEY_RE.test(e[0])) return false;
    if (!intIn(e[1], 1, 999)) return false;
    if (BLOCK_KEY_RE.test(e[0]) && !intIn(Number(e[0].slice(2)), 1, 255)) return false;
  }
  if (!finite(d.dayTime) || d.dayTime < 0 || d.dayTime > 1 || !Array.isArray(d.hotbar) ||
      d.hotbar.length !== 9 || !d.hotbar.every(isStack)) return false;
  if (!finite(d.slot) || d.slot < 0 || d.slot > 8) return false;
  const st = d.settings;
  if (!st || typeof st.sound !== 'boolean' || !finite(st.renderDistance) ||
      !finite(st.sensitivity) || !finite(st.fov)) return false;
  // 设置页新增字段为可选：旧档没有时按默认值处理，不影响校验通过
  if (st.volume !== undefined && !finite(st.volume)) return false;
  if (st.invertY !== undefined && typeof st.invertY !== 'boolean') return false;
  // v1.6 生态字段为可选，旧档缺省仍通过
  if (d.dayCount !== undefined && (!intIn(d.dayCount, 0, Number.MAX_SAFE_INTEGER))) return false;
  if (d.botany !== undefined && !isBotanySave(d.botany)) return false;
  // 熔炉字段为可选，旧档缺省仍通过
  if (d.furnaces !== undefined && !isFurnaceSave(d.furnaces)) return false;
  return finite(d.savedAt);
}

export type SaveLoadResult =
  | { status: 'ok'; data: SaveData }
  | { status: 'no-save' }
  | { status: 'corrupt'; reason: string }
  | { status: 'transient-error'; reason: string };

export interface ISaveProvider {
  load(): Promise<SaveData | null>;
  /** 三态加载（H01）：区分「无档 / 坏档 / 瞬时故障」，调用方据此决定是否允许覆盖写 */
  loadResult?(): Promise<SaveLoadResult>;
  /** 坏档隔离（H01）：把原始存档复制到备份 key 而非丢弃，返回是否隔离成功 */
  quarantine?(): Promise<boolean>;
  /** 返回写入的字节数（可选），用于 save:done 事件 */
  save(data: SaveData): Promise<number | void>;
  clear(): Promise<void>;
}

/**
 * 三态加载的统一入口：老式 provider（load 可能 throw）也包装成结果对象，
 * 任何加载路径都不会再出现「读不出来 → 当作无档 → 覆盖清档」的静默丢失。
 */
export async function loadSaveResult(provider: ISaveProvider): Promise<SaveLoadResult> {
  try {
    if (provider.loadResult) return await provider.loadResult();
    const data = await provider.load();
    return data ? { status: 'ok', data } : { status: 'no-save' };
  } catch (e) {
    return { status: 'transient-error', reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 旧档升级 + 全量 schema 校验（LocalStorageProvider / IndexedDBProvider / 文件导入共用）。
 * v1 旧档自动升级为 v2 并进入创造模式；坏档一律返回 null（当作无存档）。
 */
export function normalizeSave(raw: unknown): SaveData | null {
  if (!raw || typeof raw !== 'object') return null;
  const parsed = raw as SaveData | LegacySave;
  if (typeof parsed.seed !== 'number') return null;
  if (parsed.version === 1) {
    const upgraded: SaveData = {
      version: 2,
      seed: parsed.seed,
      mode: 'creative',
      edits: parsed.edits ?? [],
      player: parsed.player,
      survival: {
        health: 20, hunger: 20, saturation: MAX_HUNGER, warmth: 0, breath: 15, inventory: [],
        spawn: { x: parsed.player.x, y: parsed.player.y, z: parsed.player.z },
      },
      dayTime: parsed.dayTime ?? 0.32,
      // 旧档快捷栏长度不定，补齐到 9 格以通过 v2 schema 校验
      hotbar: Array.from({ length: 9 }, (_, i) => {
        const id = (parsed.hotbar ?? [])[i];
        return typeof id === 'number' ? { kind: 'block' as const, id } : null;
      }),
      slot: parsed.slot ?? 0,
      settings: parsed.settings ?? { sound: true, renderDistance: 5, sensitivity: 1, fov: 72 },
      savedAt: parsed.savedAt ?? Date.now(),
    };
    return validateSave(upgraded) ? upgraded : null;
  }
  if (parsed.version !== 2) return null;
  // 全量 schema 校验：坏档一律当作无存档，避免启动中途抛错卡死
  if (!validateSave(parsed)) return null;
  // v1.6：旧档缺生态字段时补默认值，不影响既有存档
  if (parsed.dayCount === undefined) parsed.dayCount = 0;
  return parsed;
}

export class LocalStorageProvider implements ISaveProvider {
  constructor(private key = 'minecraft-ts-save-v1') {}

  async load(): Promise<SaveData | null> {
    const res = await this.loadResult();
    return res.status === 'ok' ? res.data : null;
  }

  async loadResult(): Promise<SaveLoadResult> {
    let raw: string | null;
    try {
      raw = localStorage.getItem(this.key);
    } catch {
      return { status: 'transient-error', reason: 'localStorage 不可用' };
    }
    if (!raw) return { status: 'no-save' };
    try {
      const data = normalizeSave(JSON.parse(raw));
      if (data) return { status: 'ok', data };
      return { status: 'corrupt', reason: '存档字段校验失败' };
    } catch {
      return { status: 'corrupt', reason: '存档不是有效的 JSON' };
    }
  }

  async quarantine(): Promise<boolean> {
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) return false;
      localStorage.setItem(`${this.key}-corrupt-${Date.now()}`, raw);
      return true;
    } catch {
      return false;
    }
  }

  async save(data: SaveData): Promise<number> {
    const json = JSON.stringify(data);
    localStorage.setItem(this.key, json);
    return json.length;
  }

  async clear(): Promise<void> {
    localStorage.removeItem(this.key);
  }
}

const IDB_NAME = 'minecraft-ts';
const IDB_STORE = 'saves';

/**
 * IndexedDB 存档后端（CraftAPI.setSaveProvider 可替换，默认首选）。
 *
 * localStorage 5MB 上限是「存档丢失」类差评的隐患：世界差分随游玩增长，
 * 超限后 setItem 抛 QuotaExceededError 只能丢档。IndexedDB 配额大一个数量级、
 * 异步读写不阻塞主线程，是浏览器端存档的正确默认；localStorage 降级兜底。
 */
export class IndexedDBProvider implements ISaveProvider {
  constructor(private key = 'minecraft-ts-save-v1') {}

  /** 浏览器不支持 / 隐私模式禁用时返回 null，调用方降级 localStorage */
  static isSupported(): boolean {
    try {
      return typeof indexedDB !== 'undefined' && indexedDB !== null;
    } catch {
      return false;
    }
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (!IndexedDBProvider.isSupported()) {
        reject(new Error('IndexedDB 不可用'));
        return;
      }
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
      req.onblocked = () => reject(new Error('IndexedDB 被其他标签页占用'));
    });
  }

  private async tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const t = db.transaction(IDB_STORE, mode);
        let result: T;
        const req = fn(t.objectStore(IDB_STORE));
        // H02：等 transaction.oncomplete（事务真正持久化）而不是 req.onsuccess，
        // 否则页面卸载阶段发起的写入可能未提交就被浏览器丢弃
        req.onsuccess = () => { result = req.result; };
        req.onerror = () => reject(req.error ?? new Error('IndexedDB 事务失败'));
        t.oncomplete = () => resolve(result);
        t.onabort = () => reject(t.error ?? new Error('IndexedDB 事务中止'));
      });
    } finally {
      db.close();
    }
  }

  async load(): Promise<SaveData | null> {
    const res = await this.loadResult();
    return res.status === 'ok' ? res.data : null;
  }

  async loadResult(): Promise<SaveLoadResult> {
    let raw: unknown;
    try {
      raw = await this.tx<unknown>('readonly', (s) => s.get(this.key) as IDBRequest<unknown>);
    } catch (e) {
      return { status: 'transient-error', reason: e instanceof Error ? e.message : 'IndexedDB 读取失败' };
    }
    if (raw === null || raw === undefined) return { status: 'no-save' };
    const data = normalizeSave(raw);
    if (data) return { status: 'ok', data };
    return { status: 'corrupt', reason: '存档字段校验失败' };
  }

  async quarantine(): Promise<boolean> {
    try {
      const raw = await this.tx<unknown>('readonly', (s) => s.get(this.key) as IDBRequest<unknown>);
      if (raw === null || raw === undefined) return false;
      await this.tx('readwrite', (s) => s.put(raw, `${this.key}-corrupt-${Date.now()}`) as IDBRequest<IDBValidKey>);
      return true;
    } catch {
      return false;
    }
  }

  async save(data: SaveData): Promise<number> {
    // H04：直接结构化克隆写入——JSON.stringify/parse 往返纯属多余，
    // 且与 edits 数量成正比、全跑在主线程（每 8 秒一次 autosave）
    await this.tx('readwrite', (s) => s.put(data, this.key) as IDBRequest<IDBValidKey>);
    return data.edits.length;
  }

  async clear(): Promise<void> {
    try {
      await this.tx('readwrite', (s) => s.delete(this.key) as unknown as IDBRequest<undefined>);
    } catch {
      /* 无档可清 */
    }
  }
}

/**
 * 默认存档后端：优先 IndexedDB，不可用时降级 localStorage。
 * localStorage 里的历史存档会一次性迁移到 IndexedDB（原 key 保留作手工兜底）。
 */
export async function createDefaultSaveProvider(): Promise<ISaveProvider> {
  const legacy = new LocalStorageProvider();
  if (!IndexedDBProvider.isSupported()) return legacy;
  const idb = new IndexedDBProvider();
  try {
    const existing = await idb.load();
    if (existing) return idb;
    const old = await legacy.load();
    if (old) {
      await idb.save(old);
      console.info('[save] 已把 localStorage 存档迁移到 IndexedDB');
      return idb;
    }
    return idb;
  } catch {
    return legacy;
  }
}

// ---- 存档文件导出 / 导入（.json）----

/** 导出为 .json 文件下载（备份 / 跨浏览器迁移） */
export function downloadSave(data: SaveData): void {
  const stamp = new Date(data.savedAt || Date.now());
  const pad = (n: number) => String(n).padStart(2, '0');
  const name = `minecraft-ts-save-${data.seed}-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.json`;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 解析导入的存档文本；格式非法或 schema 校验失败返回 null */
export function parseSaveFile(text: string): SaveData | null {
  try {
    return normalizeSave(JSON.parse(text));
  } catch {
    return null;
  }
}

/** 弹出文件选择器导入存档；用户取消返回 null，内容非法抛错（调用方提示） */
export function pickSaveFile(): Promise<SaveData | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      input.remove();
      fn();
    };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) { settle(() => resolve(null)); return; }
      void file.text().then((text) => {
        const data = parseSaveFile(text);
        if (!data) {
          settle(() => reject(new Error('存档文件格式校验失败')));
          return;
        }
        settle(() => resolve(data));
      }, (e) => settle(() => reject(e)));
    });
    // 部分浏览器取消选择不触发 change：窗口重新获得焦点时按取消处理
    const onFocus = () => {
      window.setTimeout(() => {
        if (!input.files?.length) settle(() => resolve(null));
        window.removeEventListener('focus', onFocus);
      }, 500);
    };
    window.addEventListener('focus', onFocus);
    document.body.appendChild(input);
    input.click();
  });
}
