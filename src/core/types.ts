/** 全局共享类型与常量 */

export type BlockId = number;

/** 游戏模式：创造（无限方块、瞬间破坏） / 生存（生命、饥饿、掉落、怪物） */
export type GameMode = 'creative' | 'survival';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** 体素世界尺寸常量 */
export const CHUNK_SIZE = 16;
export const WORLD_HEIGHT = 80;
export const SEA_LEVEL = 30;

/** 引擎系统接口：任何实现 update 的对象都可挂入主循环（扩展点） */
export interface System {
  readonly name?: string;
  update(dt: number, elapsed: number): void;
}

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** 确定性伪随机（mulberry32），用于纹理与地形 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const chunkKey = (cx: number, cz: number) => `${cx},${cz}`;
/** chunkKey 的逆向解析：热路径用 slice 代替 split+map，不产生临时数组 */
export const parseChunkKey = (key: string): [number, number] => {
  const i = key.indexOf(',');
  return [+key.slice(0, i), +key.slice(i + 1)];
};
export const blockKey = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** N3：挖掘裂痕阶段数（0 = 无裂纹，1..9 逐层加深，与原版一致） */
export const CRACK_STAGES = 10;
export type CrackStage = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/**
 * 把浮点挖掘进度量化为裂痕阶段。
 * 纯函数（无 DOM / three 依赖），既给渲染层用，也给低帧率逻辑回归用；
 * progress 天然单调，dt 钳制只会改变推进速度，不会让阶段回退。
 */
export const quantizeCrackStage = (progress: number): CrackStage => {
  const raw = progress >= 1 ? CRACK_STAGES - 1 : Math.floor(progress * CRACK_STAGES);
  return Math.max(0, Math.min(CRACK_STAGES - 1, raw)) as CrackStage;
};