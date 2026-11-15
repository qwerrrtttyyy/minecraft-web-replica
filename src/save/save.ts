import type { BlockId, GameMode } from '../core/types';
import type { Stack, SurvivalSave } from '../player/survival';

/**
 * 存档系统（扩展点：CraftAPI.setSaveProvider 可替换为云端/IndexedDB 实现）。
 * 默认使用 localStorage，只保存世界差分、玩家与生存状态，体积极小。
 * v2 增加游戏模式、生命/饥饿/背包；读取到 v1 旧档时自动升级并进入创造模式。
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
  settings: { sound: boolean; renderDistance: number; sensitivity: number; fov: number };
  savedAt: number;
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

/** 编辑差分 key 必须是整数坐标；方块 id 0~255（0 表示挖掉） */
const EDIT_KEY_RE = /^-?\d+,-?\d+,-?\d+$/;
/** 背包 key：i:物品名 / b:方块 id */
const ITEM_KEY_RE = /^i:[A-Za-z0-9_.:-]+$/;
const BLOCK_KEY_RE = /^b:\d+$/;

const isVec3 = (v: unknown): boolean => {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return finite(o.x) && finite(o.y) && finite(o.z);
};

const isStack = (v: unknown): boolean => {
  if (v === null) return true;
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  if (s.kind === 'block') return intIn(s.id, 0, 255);
  if (s.kind === 'item') return typeof s.id === 'string' && ITEM_KEY_RE.test(`i:${s.id}`);
  return false;
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
  if (!p || !finite(p.x) || !finite(p.y) || !finite(p.z) ||
      !finite(p.yaw) || !finite(p.pitch) || typeof p.fly !== 'boolean') return false;
  const s = d.survival;
  if (!s || !finite(s.health) || !finite(s.hunger) || !finite(s.breath) ||
      !Array.isArray(s.inventory) || !isVec3(s.spawn)) return false;
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
  return finite(d.savedAt);
}

export interface ISaveProvider {
  load(): Promise<SaveData | null>;
  /** 返回写入的字节数（可选），用于 save:done 事件 */
  save(data: SaveData): Promise<number | void>;
  clear(): Promise<void>;
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
        health: 20, hunger: 20, breath: 15, inventory: [],
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
  return validateSave(parsed) ? parsed : null;
}

export class LocalStorageProvider implements ISaveProvider {
  constructor(private key = 'minecraft-ts-save-v1') {}

  async load(): Promise<SaveData | null> {
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) return null;
      return normalizeSave(JSON.parse(raw));
    } catch {
      return null;
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
        const req = fn(t.objectStore(IDB_STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB 事务失败'));
      });
    } finally {
      db.close();
    }
  }

  async load(): Promise<SaveData | null> {
    try {
      const raw = await this.tx<unknown>('readonly', (s) => s.get(this.key) as IDBRequest<unknown>);
      return normalizeSave(raw ?? null);
    } catch {
      return null;
    }
  }

  async save(data: SaveData): Promise<number> {
    const json = JSON.stringify(data);
    await this.tx('readwrite', (s) => s.put(JSON.parse(json), this.key) as IDBRequest<IDBValidKey>);
    return json.length;
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
