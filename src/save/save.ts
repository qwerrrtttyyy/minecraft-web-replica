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

const isVec3 = (v: unknown): boolean => {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return finite(o.x) && finite(o.y) && finite(o.z);
};

const isStack = (v: unknown): boolean => {
  if (v === null) return true;
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  if (s.kind === 'block') return finite(s.id);
  if (s.kind === 'item') return typeof s.id === 'string' && s.id.length > 0;
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
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string' || !finite(e[1])) return false;
  }
  const p = d.player;
  if (!p || !finite(p.x) || !finite(p.y) || !finite(p.z) ||
      !finite(p.yaw) || !finite(p.pitch) || typeof p.fly !== 'boolean') return false;
  const s = d.survival;
  if (!s || !finite(s.health) || !finite(s.hunger) || !finite(s.breath) ||
      !Array.isArray(s.inventory) || !isVec3(s.spawn)) return false;
  for (const e of s.inventory) {
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string' || !finite(e[1])) return false;
  }
  if (!finite(d.dayTime) || !Array.isArray(d.hotbar) ||
      d.hotbar.length !== 9 || !d.hotbar.every(isStack)) return false;
  if (!finite(d.slot) || d.slot < 0 || d.slot > 8) return false;
  const st = d.settings;
  if (!st || typeof st.sound !== 'boolean' || !finite(st.renderDistance) ||
      !finite(st.sensitivity) || !finite(st.fov)) return false;
  return finite(d.savedAt);
}

export interface ISaveProvider {
  load(): Promise<SaveData | null>;
  save(data: SaveData): Promise<void>;
  clear(): Promise<void>;
}

export class LocalStorageProvider implements ISaveProvider {
  constructor(private key = 'minecraft-ts-save-v1') {}

  async load(): Promise<SaveData | null> {
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as SaveData | LegacySave;
      if (!parsed || typeof parsed.seed !== 'number') return null;
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
    } catch {
      return null;
    }
  }

  async save(data: SaveData): Promise<void> {
    localStorage.setItem(this.key, JSON.stringify(data));
  }

  async clear(): Promise<void> {
    localStorage.removeItem(this.key);
  }
}
