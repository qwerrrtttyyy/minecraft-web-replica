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

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
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
export const blockKey = (x: number, y: number, z: number) => `${x},${y},${z}`;