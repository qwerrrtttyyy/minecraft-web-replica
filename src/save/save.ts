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
        return {
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
          hotbar: (parsed.hotbar ?? []).map((id) => ({ kind: 'block' as const, id })),
          slot: parsed.slot ?? 0,
          settings: parsed.settings ?? { sound: true, renderDistance: 5, sensitivity: 1, fov: 72 },
          savedAt: parsed.savedAt ?? Date.now(),
        };
      }
      if (parsed.version !== 2) return null;
      // 坏档字段校验：否则 main.ts 遍历 edits / restore 时会直接抛错卡死启动
      if (!Array.isArray(parsed.edits) || !parsed.player || typeof parsed.player.x !== 'number' ||
          !parsed.survival || !Array.isArray(parsed.survival.inventory) ||
          !Array.isArray(parsed.hotbar)) return null;
      return parsed;
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
