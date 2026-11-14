import * as THREE from 'three';
import { mulberry32 } from '../core/types';
import type { BlockDefinition } from '../world/blocks';
import { FACES } from '../world/faces';

/**
 * 程序化像素纹理图集：所有方块纹理用 Canvas 逐像素绘制（16×16），
 * 零外部资源，风格贴近原版。扩展点：registerTile() 可注入自定义纹理。
 */

const TILE = 16;
const GRID = 8;
const SIZE = TILE * GRID;

/** 像素画布 */
class Px {
  readonly data = new Uint8ClampedArray(TILE * TILE * 4);
  set(x: number, y: number, hex: number, a = 255) {
    if (x < 0 || y < 0 || x >= TILE || y >= TILE) return;
    const i = (y * TILE + x) * 4;
    this.data[i] = (hex >> 16) & 255;
    this.data[i + 1] = (hex >> 8) & 255;
    this.data[i + 2] = hex & 255;
    this.data[i + 3] = a;
  }
  clear() {
    this.data.fill(0);
  }
}

type Painter = (p: Px, rng: () => number) => void;

const jitter = (hex: number, rng: () => number, v: number) => {
  const d = ((rng() * 2 - 1) * v) | 0;
  const r = Math.max(0, Math.min(255, ((hex >> 16) & 255) + d));
  const g = Math.max(0, Math.min(255, ((hex >> 8) & 255) + d));
  const b = Math.max(0, Math.min(255, (hex & 255) + d));
  return (r << 16) | (g << 8) | b;
};

const fillNoise = (p: Px, rng: () => number, hex: number, v: number) => {
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) p.set(x, y, jitter(hex, rng, v));
};

const rect = (p: Px, x0: number, y0: number, w: number, h: number, hex: number, a = 255) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) p.set(x, y, hex, a);
};

const blob = (p: Px, rng: () => number, hex: number, count: number, size: number) => {
  for (let i = 0; i < count; i++) {
    let x = (rng() * TILE) | 0;
    let y = (rng() * TILE) | 0;
    for (let j = 0; j < size; j++) {
      p.set(x, y, hex);
      x += ((rng() * 3) | 0) - 1;
      y += ((rng() * 3) | 0) - 1;
    }
  }
};

/** 3×5 像素字体（TNT 字样） */
const FONT: Record<string, string[]> = {
  T: ['111', '010', '010', '010', '010'],
  N: ['101', '111', '111', '101', '101'],
};
const drawText = (p: Px, text: string, x0: number, y0: number, hex: number) => {
  let cx = x0;
  for (const ch of text) {
    const glyph = FONT[ch];
    if (glyph) {
      for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) if (glyph[y][x] === '1') p.set(cx + x, y0 + y, hex);
    }
    cx += 4;
  }
};

function builtinPainters(): Record<string, Painter> {
  const dirt: Painter = (p, rng) => {
    fillNoise(p, rng, 0x866043, 13);
    blob(p, rng, 0x79553a, 8, 5);
    blob(p, rng, 0x966c4e, 6, 4);
  };
  const stoneBase: Painter = (p, rng) => {
    fillNoise(p, rng, 0x7c7f82, 9);
    blob(p, rng, 0x6a6d70, 7, 9);
    blob(p, rng, 0x8c8f92, 4, 5);
    // 几道短裂纹，避免大面积石墙过于均匀
    for (let i = 0; i < 3; i++) {
      let x = 2 + ((rng() * 12) | 0);
      let y = 2 + ((rng() * 10) | 0);
      for (let k = 0; k < 4; k++) {
        p.set(x, y, jitter(0x626568, rng, 5));
        x += ((rng() * 3) | 0) - 1;
        y += 1;
      }
    }
  };
  const redTnt = (p: Px, rng: () => number) => {
    fillNoise(p, rng, 0xd5451b, 8);
    blob(p, rng, 0xb83a14, 4, 4);
  };
  return {
    grass_top: (p, rng) => {
      fillNoise(p, rng, 0x7ba848, 10);
      blob(p, rng, 0x6b9a3e, 10, 3);
      blob(p, rng, 0x8fbe57, 8, 3);
      // 短草叶，让大草地不至于只有噪声
      for (let i = 0; i < 18; i++) {
        const x = (rng() * TILE) | 0;
        const y = (rng() * TILE) | 0;
        p.set(x, y, jitter(0x9ccb63, rng, 8));
        if (rng() < 0.5) p.set(x, y + 1, jitter(0x76a646, rng, 7));
      }
    },
    dirt,
    grass_side: (p, rng) => {
      dirt(p, rng);
      for (let x = 0; x < TILE; x++) {
        const depth = 2 + ((rng() * 3) | 0);
        for (let y = 0; y < depth; y++) p.set(x, y, jitter(0x7ba848, rng, 10));
        if (rng() < 0.4) p.set(x, depth, jitter(0x6b9a3e, rng, 8));
      }
    },
    stone: stoneBase,
    cobblestone: (p, rng) => {
      fillNoise(p, rng, 0x565656, 6);
      for (let cy = 0; cy < 3; cy++) {
        for (let cx = 0; cx < 3; cx++) {
          const x0 = cx * 5 + ((rng() * 2) | 0);
          const y0 = cy * 5 + ((rng() * 2) | 0);
          const w = 4 + ((rng() * 2) | 0);
          const h = 4 + ((rng() * 2) | 0);
          const base = jitter(0x7e7e7e, rng, 10);
          for (let y = y0; y < y0 + h; y++) {
            for (let x = x0; x < x0 + w; x++) {
              const corner = (x === x0 || x === x0 + w - 1) && (y === y0 || y === y0 + h - 1);
              if (!corner) p.set(x, y, jitter(base, rng, 6));
            }
          }
          for (let x = x0 + 1; x < x0 + w - 1; x++) p.set(x, y0, 0x909090);
        }
      }
    },
    sand: (p, rng) => {
      fillNoise(p, rng, 0xdbd3a0, 9);
      blob(p, rng, 0xc7be8b, 10, 2);
      blob(p, rng, 0xe8e2b4, 6, 2);
    },
    log_side: (p, rng) => {
      fillNoise(p, rng, 0x6b5330, 8);
      for (const x of [0, 3, 7, 10, 14]) {
        for (let y = 0; y < TILE; y++) if (rng() < 0.85) p.set(x, y, jitter(0x543f24, rng, 6));
      }
      blob(p, rng, 0x7c623c, 6, 4);
    },
    log_top: (p, rng) => {
      fillNoise(p, rng, 0xb8945f, 6);
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
          if (d >= 6.5) p.set(x, y, jitter(0x554126, rng, 6));
          else if (((d | 0) % 3) === 1) p.set(x, y, jitter(0x9c7f4e, rng, 5));
        }
      }
      p.set(7, 7, 0x8a6c3e);
      p.set(8, 8, 0x8a6c3e);
    },
    oak_planks: (p, rng) => {
      fillNoise(p, rng, 0x9c7f4e, 7);
      for (const y of [3, 7, 11, 15]) for (let x = 0; x < TILE; x++) p.set(x, y, jitter(0x66502e, rng, 4));
      const joints = [4, 11, 2, 9];
      for (let r = 0; r < 4; r++) {
        for (let y = r * 4; y < r * 4 + 3; y++) p.set(joints[r], y, 0x6b5533);
      }
      for (let i = 0; i < 10; i++) {
        const y = (rng() * TILE) | 0;
        const x = (rng() * 12) | 0;
        const len = 3 + ((rng() * 4) | 0);
        for (let k = 0; k < len; k++) if (y % 4 !== 3) p.set(x + k, y, 0xab8d5a);
      }
    },
    oak_leaves: (p, rng) => {
      p.clear();
      const tones = [0x2f5f1c, 0x3f7a24, 0x4f8f2c, 0x5aa236];
      // 4×4 的叶簇：同一簇内色调统一，边缘随机镂空，整体不再是椒盐噪声
      for (let cy = 0; cy < 4; cy++) {
        for (let cx = 0; cx < 4; cx++) {
          const base = tones[(rng() * tones.length) | 0];
          for (let y = 0; y < 4; y++) {
            for (let x = 0; x < 4; x++) {
              const edge = x === 0 || y === 0 || x === 3 || y === 3;
              if (edge && rng() < 0.18) continue;
              p.set(cx * 4 + x, cy * 4 + y, jitter(base, rng, 7));
            }
          }
          if (rng() < 0.55) {
            p.set(cx * 4 + 1 + ((rng() * 2) | 0), cy * 4 + 1 + ((rng() * 2) | 0),
              jitter(0x6fb545, rng, 8));
          }
        }
      }
      // 少量透光孔与底部暗部
      for (let i = 0; i < 6; i++) {
        p.set((rng() * TILE) | 0, (rng() * TILE) | 0, 0, 0);
      }
      for (let x = 0; x < TILE; x++) {
        if (rng() < 0.35) p.set(x, 15, jitter(0x2a5418, rng, 6));
      }
    },
    glass: (p) => {
      p.clear();
      for (let i = 0; i < TILE; i++) {
        p.set(i, 0, 0xdceff2, 235);
        p.set(i, 15, 0xdceff2, 235);
        p.set(0, i, 0xdceff2, 235);
        p.set(15, i, 0xdceff2, 235);
      }
      p.set(11, 3, 0xffffff, 150);
      p.set(12, 4, 0xffffff, 130);
      p.set(13, 5, 0xffffff, 110);
      p.set(3, 10, 0xffffff, 120);
      p.set(4, 11, 0xffffff, 100);
    },
    bricks: (p, rng) => {
      fillNoise(p, rng, 0xbfb7ae, 4);
      for (let r = 0; r < 4; r++) {
        const y0 = r * 4;
        const off = (r % 2) * 4;
        for (let bx = -off; bx < TILE; bx += 8) {
          const base = jitter(0x9c5638, rng, 9);
          for (let y = y0; y < y0 + 3; y++) {
            for (let x = bx; x < bx + 7; x++) {
              if (x >= 0 && x < TILE) p.set(x, y, jitter(base, rng, 5));
            }
          }
        }
      }
    },
    water: (p, rng) => {
      fillNoise(p, rng, 0x3569d1, 7);
      for (let i = 0; i < 8; i++) {
        const y = (rng() * TILE) | 0;
        const x = (rng() * 10) | 0;
        const len = 4 + ((rng() * 5) | 0);
        for (let k = 0; k < len; k++) p.set(x + k, y, jitter(0x4b86e8, rng, 5));
      }
      for (let i = 0; i < 3; i++) {
        const y = 2 + ((rng() * 12) | 0);
        const x = 2 + ((rng() * 10) | 0);
        p.set(x, y, jitter(0x274f9f, rng, 4));
      }
    },
    bedrock: (p, rng) => {
      fillNoise(p, rng, 0x575757, 18);
      blob(p, rng, 0x333333, 10, 7);
      blob(p, rng, 0x777777, 8, 6);
    },
    glowstone: (p, rng) => {
      fillNoise(p, rng, 0x9c7440, 10);
      blob(p, rng, 0x6e5230, 5, 4);
      for (let i = 0; i < 11; i++) {
        const x = 1 + ((rng() * 13) | 0);
        const y = 1 + ((rng() * 13) | 0);
        p.set(x, y, 0xffc868);
        p.set(x + 1, y, 0xffc868);
        p.set(x, y + 1, 0xffc868);
        p.set(x + 1, y + 1, 0xffe9a8);
      }
    },
    snow: (p, rng) => {
      fillNoise(p, rng, 0xf2fafa, 3);
      blob(p, rng, 0xe4efef, 6, 2);
    },
    tnt_side: (p, rng) => {
      redTnt(p, rng);
      rect(p, 0, 3, TILE, 7, 0xe5dcc8);
      for (let x = 0; x < TILE; x++) {
        p.set(x, 3, jitter(0xcfc4ac, rng, 4));
        p.set(x, 9, jitter(0xcfc4ac, rng, 4));
      }
      drawText(p, 'TNT', 2, 4, 0x2b2b2b);
      for (let x = 0; x < TILE; x++) {
        p.set(x, 2, 0xa83512);
        p.set(x, 10, 0xa83512);
      }
    },
    tnt_top: (p, rng) => {
      redTnt(p, rng);
      rect(p, 3, 3, 10, 10, 0xc9c2b4);
      for (let y = 3; y < 13; y++) for (let x = 3; x < 13; x++) p.set(x, y, jitter(0xc9c2b4, rng, 5));
      rect(p, 6, 6, 4, 4, 0x4a4a4a);
      p.set(7, 7, 0x2b2b2b);
      p.set(8, 8, 0x2b2b2b);
    },
    tnt_bottom: (p, rng) => {
      redTnt(p, rng);
      rect(p, 3, 3, 10, 10, 0x8a8478);
      for (let y = 3; y < 13; y++) for (let x = 3; x < 13; x++) p.set(x, y, jitter(0x8a8478, rng, 5));
    },
    tall_grass: (p, rng) => {
      p.clear();
      for (let i = 0; i < 6; i++) {
        const x0 = 2 + i * 2 + (((rng() * 2) | 0) - 1);
        const h = 6 + ((rng() * 7) | 0);
        for (let k = 0; k < h; k++) {
          const y = 15 - k;
          const x = x0 + Math.round(Math.sin(k * 0.45 + i) * 0.9);
          p.set(x, y, k === h - 1 ? 0x93c45e : i % 2 ? 0x6fa03e : 0x82b44e);
        }
      }
    },
    poppy: (p, rng) => {
      p.clear();
      for (let y = 8; y < 16; y++) p.set(7, y, 0x3e7a22);
      p.set(5, 12, 0x4c8f2b);
      p.set(6, 12, 0x4c8f2b);
      p.set(9, 11, 0x4c8f2b);
      for (let y = 3; y < 8; y++) for (let x = 5; x < 11; x++) p.set(x, y, jitter(0xd0342c, rng, 7));
      p.set(5, 3, 0); p.set(10, 3, 0); p.set(5, 7, 0); p.set(10, 7, 0);
      p.set(7, 4, 0x7a1f1a);
      p.set(8, 4, 0x7a1f1a);
      p.set(7, 5, 0x2b1a12);
      p.set(6, 3, 0xe8503f);
      p.set(9, 3, 0xe8503f);
    },
    dandelion: (p, rng) => {
      p.clear();
      for (let y = 9; y < 16; y++) p.set(7, y, 0x3e7a22);
      p.set(9, 12, 0x4c8f2b);
      p.set(5, 13, 0x4c8f2b);
      for (let y = 4; y < 8; y++) for (let x = 5; x < 10; x++) p.set(x, y, jitter(0xf7d442, rng, 6));
      p.set(5, 4, 0); p.set(9, 4, 0); p.set(5, 7, 0); p.set(9, 7, 0);
      p.set(7, 5, 0xe0a828);
      p.set(6, 4, 0xffe873);
    },
    // ---- 生存模式物品（透明底扁平精灵） ----
    apple: (p, rng) => {
      p.clear();
      for (let y = 4; y < 16; y++) {
        for (let x = 3; x < 14; x++) {
          const dx = x - 8, dy = (y - 10) * 0.92;
          const d = dx * dx + dy * dy;
          if (d > 22) continue;
          let hex = jitter(0xb5352c, rng, 10);
          if (dx * 0.6 + dy < -7) hex = jitter(0xd8524a, rng, 8);
          if (d > 16) hex = jitter(0x7e1d18, rng, 8);
          p.set(x, y, hex);
        }
      }
      p.set(6, 8, 0xf5b3a2);
      p.set(6, 9, 0xd98a76);
      p.set(8, 2, 0x5a3b1c);
      p.set(8, 3, 0x6b4823);
      p.set(9, 3, 0x5a3b1c);
      p.set(10, 2, 0x3f7a24);
      p.set(11, 2, 0x4d8f2c);
      p.set(11, 3, 0x3f7a24);
    },
    porkchop: (p, rng) => {
      p.clear();
      for (let y = 3; y < 16; y++) {
        for (let x = 3; x < 14; x++) {
          if (Math.abs((y - 9) - (x - 8) * 0.22) > 5.2) continue;
          p.set(x, y, jitter(0xe79aa0, rng, 9));
        }
      }
      for (let x = 4; x < 13; x++) {
        p.set(x, 4, 0xfbe3de);
        p.set(x, 5, 0xf3cdc8);
      }
      for (let i = 0; i < 5; i++) {
        const y = 6 + i * 2;
        for (let x = 4; x < 13; x++) if (rng() < 0.55) p.set(x, y, jitter(0xc96b73, rng, 6));
      }
      p.set(11, 12, 0xb05360);
      p.set(12, 12, 0xb05360);
      p.set(12, 13, 0x9a4652);
    },
    // 矿石：石头底纹 + 彩色矿斑。追加在末尾，不影响已有纹理的图集索引
    coal_ore: (p, rng) => {
      stoneBase(p, rng);
      blob(p, rng, 0x2a2a2a, 7, 5);
      blob(p, rng, 0x111111, 4, 3);
    },
    iron_ore: (p, rng) => {
      stoneBase(p, rng);
      blob(p, rng, 0xc4865a, 6, 5);
      blob(p, rng, 0xe0b183, 4, 3);
    },
    gold_ore: (p, rng) => {
      stoneBase(p, rng);
      blob(p, rng, 0xe8b93f, 6, 5);
      blob(p, rng, 0xffdc76, 4, 3);
    },
    diamond_ore: (p, rng) => {
      stoneBase(p, rng);
      blob(p, rng, 0x35b9c4, 6, 5);
      blob(p, rng, 0x8ff0ef, 4, 3);
    },
    // 光源方块：火把 / 南瓜灯
    torch: (p, rng) => {
      p.clear();
      // 4px 宽的木棍，远处和 48px 图标都能看清
      for (let y = 7; y < 16; y++) {
        p.set(6, y, 0x4a3018);
        p.set(7, y, 0x6b4a2a);
        p.set(8, y, 0x7d5a34);
        p.set(9, y, 0x4a3018);
      }
      // 火焰：下宽上窄
      for (let y = 4; y <= 7; y++) {
        const w = y <= 5 ? 1 : 2;
        for (let x = 7 - w; x <= 8 + w; x++) {
          p.set(x, y, jitter(y <= 5 ? 0xffd95e : 0xff9a2a, rng, 12));
        }
      }
      p.set(7, 4, 0xfff6d0);
      p.set(8, 4, 0xffe58a);
      p.set(7, 3, 0xffe58a);
      p.set(8, 3, 0xffb83a);
      p.set(6, 7, 0x8a4a12);
      p.set(9, 7, 0x8a4a12);
    },
    pumpkin_top: (p, rng) => {
      fillNoise(p, rng, 0xd97318, 10);
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
          if (d > 6.5) p.set(x, y, jitter(0xa9530d, rng, 6));
          else if (((d | 0) % 3) === 1) p.set(x, y, jitter(0xeb8b28, rng, 6));
        }
      }
      rect(p, 7, 6, 2, 3, 0x3f7a24);
      p.set(7, 5, 0x2f5c1b);
      p.set(8, 5, 0x2f5c1b);
    },
    pumpkin_bottom: (p, rng) => {
      fillNoise(p, rng, 0xc46714, 9);
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
          if (d > 6.5) p.set(x, y, jitter(0x9c4a0c, rng, 6));
          else if (((d | 0) % 4) === 2) p.set(x, y, jitter(0xd97a1e, rng, 6));
        }
      }
    },
    pumpkin_face: (p, rng) => {
      fillNoise(p, rng, 0xd97318, 10);
      for (const x of [2, 6, 10, 14]) {
        for (let y = 0; y < TILE; y++) p.set(x, y, jitter(0xb85c10, rng, 5));
      }
      // 雕刻的眼睛与锯齿嘴（内部暖色表示灯光）
      rect(p, 3, 5, 3, 2, 0x2a1608);
      rect(p, 10, 5, 3, 2, 0x2a1608);
      p.set(4, 5, 0xffcc55);
      p.set(11, 5, 0xffcc55);
      for (let x = 3; x <= 12; x++) p.set(x, 10, 0x2a1608);
      p.set(4, 9, 0x2a1608);
      p.set(7, 9, 0x2a1608);
      p.set(10, 9, 0x2a1608);
      p.set(5, 11, 0x2a1608);
      p.set(8, 11, 0x2a1608);
      p.set(11, 11, 0x2a1608);
      p.set(4, 6, 0xffd166);
      p.set(11, 6, 0xffd166);
    },
    // ---- 追加建材 ----
    stone_bricks: (p, rng) => {
      fillNoise(p, rng, 0x5e5e61, 5); // 砖缝底色
      const brickRect = (x0: number, y0: number, w: number, h: number) => {
        for (let y = y0; y < y0 + h; y++) {
          for (let x = x0; x < x0 + w; x++) {
            if (x >= TILE || y >= TILE) continue;
            p.set(x, y, jitter(0x7a7a7e, rng, 7));
          }
        }
        // 顶边受光
        for (let x = x0; x < x0 + w && x < TILE; x++) p.set(x, y0, jitter(0x8d8d91, rng, 5));
      };
      // 上下两行砖，竖缝错开
      brickRect(0, 1, 7, 6); brickRect(9, 1, 7, 6);
      brickRect(0, 9, 3, 6); brickRect(5, 9, 6, 6); brickRect(13, 9, 3, 6);
    },
    mossy_cobblestone: (p, rng) => {
      // 先铺圆石，再盖苔藓
      fillNoise(p, rng, 0x565656, 6);
      for (let cy = 0; cy < 3; cy++) {
        for (let cx = 0; cx < 3; cx++) {
          const x0 = cx * 5 + ((rng() * 2) | 0);
          const y0 = cy * 5 + ((rng() * 2) | 0);
          const w = 4 + ((rng() * 2) | 0);
          const h = 4 + ((rng() * 2) | 0);
          const base = jitter(0x7e7e7e, rng, 10);
          for (let y = y0; y < y0 + h; y++) {
            for (let x = x0; x < x0 + w; x++) {
              if (x >= TILE || y >= TILE) continue;
              const corner = (x === x0 || x === x0 + w - 1) && (y === y0 || y === y0 + h - 1);
              if (!corner) p.set(x, y, jitter(base, rng, 6));
            }
          }
        }
      }
      blob(p, rng, 0x4e7a30, 10, 5);
      blob(p, rng, 0x6a9440, 7, 4);
      for (let i = 0; i < 14; i++) {
        p.set((rng() * TILE) | 0, (rng() * TILE) | 0, jitter(0x3f6a26, rng, 8));
      }
    },
    obsidian: (p, rng) => {
      fillNoise(p, rng, 0x17121f, 7);
      blob(p, rng, 0x0d0a14, 6, 7);
      // 紫色晶纹与亮点
      for (let i = 0; i < 5; i++) {
        let x = 2 + ((rng() * 11) | 0);
        let y = 1 + ((rng() * 12) | 0);
        for (let k = 0; k < 5; k++) {
          p.set(x, y, jitter(0x3b2b5e, rng, 8));
          p.set(x + 1, y, jitter(0x2a1f45, rng, 6));
          x += ((rng() * 3) | 0) - 1;
          y += ((rng() * 3) | 0) - 1;
        }
      }
      for (let i = 0; i < 6; i++) {
        p.set(1 + ((rng() * 14) | 0), 1 + ((rng() * 14) | 0), 0x6a5aa0);
      }
    },
    gravel: (p, rng) => {
      fillNoise(p, rng, 0x8b857c, 11);
      blob(p, rng, 0x6d675e, 9, 5);
      blob(p, rng, 0xa59e93, 7, 4);
      // 几颗分明的碎石子
      for (let i = 0; i < 6; i++) {
        const x = 1 + ((rng() * 13) | 0);
        const y = 1 + ((rng() * 13) | 0);
        const c = jitter(0x76705f, rng, 9);
        p.set(x, y, c); p.set(x + 1, y, c); p.set(x, y + 1, c); p.set(x + 1, y + 1, c);
      }
    },
    sandstone: (p, rng) => {
      fillNoise(p, rng, 0xdcd3a1, 6);
      blob(p, rng, 0xcfc48e, 6, 4);
      // 层理：横向浅色带 + 细缝
      for (const y of [0, 1, 5, 6, 12, 13]) {
        for (let x = 0; x < TILE; x++) if (rng() < 0.8) p.set(x, y, jitter(0xe6dfb5, rng, 5));
      }
      for (const y of [4, 11]) {
        for (let x = 0; x < TILE; x++) p.set(x, y, jitter(0xbcb183, rng, 5));
      }
      for (let i = 0; i < 10; i++) p.set((rng() * TILE) | 0, (rng() * TILE) | 0, jitter(0xc9be86, rng, 6));
    },
    ice: (p, rng) => {
      p.clear();
      // 半透明冰体
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) p.set(x, y, jitter(0x9ecdf0, rng, 10), 205);
      }
      // 白色裂纹
      for (let i = 0; i < 4; i++) {
        let x = (rng() * 14) | 0;
        let y = (rng() * 14) | 0;
        for (let k = 0; k < 7; k++) {
          p.set(x, y, 0xeaf6ff, 245);
          x += ((rng() * 3) | 0) - 1;
          y += ((rng() * 3) | 0) - 1;
        }
      }
      for (let i = 0; i < 4; i++) {
        p.set(1 + ((rng() * 13) | 0), 1 + ((rng() * 13) | 0), 0xffffff, 235);
      }
    },
    spruce_planks: (p, rng) => {
      fillNoise(p, rng, 0x6b4f2e, 6);
      for (const y of [3, 7, 11, 15]) {
        for (let x = 0; x < TILE; x++) p.set(x, y, jitter(0x4a361f, rng, 4));
      }
      const joints = [5, 12, 3, 9];
      for (let r = 0; r < 4; r++) {
        for (let y = r * 4; y < r * 4 + 3; y++) p.set(joints[r], y, 0x553f24);
      }
      for (let i = 0; i < 9; i++) {
        const y = (rng() * TILE) | 0;
        const x = (rng() * 13) | 0;
        const len = 2 + ((rng() * 4) | 0);
        for (let k = 0; k < len; k++) if (y % 4 !== 3) p.set(x + k, y, 0x7d5c37);
      }
    },
    birch_planks: (p, rng) => {
      fillNoise(p, rng, 0xd6c9a0, 6);
      for (const y of [3, 7, 11, 15]) {
        for (let x = 0; x < TILE; x++) p.set(x, y, jitter(0xb3a478, rng, 4));
      }
      const joints = [9, 4, 13, 6];
      for (let r = 0; r < 4; r++) {
        for (let y = r * 4; y < r * 4 + 3; y++) p.set(joints[r], y, 0xa89a70);
      }
      // 白桦特有的深色小斑
      for (let i = 0; i < 5; i++) {
        const x = (rng() * 14) | 0;
        const y = (rng() * 14) | 0;
        p.set(x, y, 0x6e6350); p.set(x + 1, y, 0x6e6350);
      }
      for (let i = 0; i < 8; i++) p.set((rng() * TILE) | 0, (rng() * TILE) | 0, 0xefe6c6);
    },
    crafting_top: (p, rng) => {
      fillNoise(p, rng, 0x9c7f4e, 7);
      // 3×3 网格缝
      for (const g of [5, 10]) {
        for (let i = 0; i < TILE; i++) {
          p.set(g, i, 0x5f4a2a);
          p.set(i, g, 0x5f4a2a);
        }
      }
      for (const g of [6, 11]) {
        for (let i = 0; i < TILE; i++) {
          if (rng() < 0.7) { p.set(g, i, 0x74592f); p.set(i, g, 0x74592f); }
        }
      }
      // 每格内一点木纹
      for (let cy = 0; cy < 3; cy++) {
        for (let cx = 0; cx < 3; cx++) {
          const x = cx * 5 + 2;
          const y = cy * 5 + 2;
          p.set(x, y, 0xab8d5a);
          if (rng() < 0.6) p.set(x + 1, y + 1, 0x8a6f42);
        }
      }
    },
    crafting_side: (p, rng) => {
      fillNoise(p, rng, 0x9c7f4e, 7);
      for (const y of [3, 7]) {
        for (let x = 0; x < TILE; x++) p.set(x, y, jitter(0x66502e, rng, 4));
      }
      // 下半是工具挂板
      rect(p, 0, 8, TILE, 8, 0x7d5f36);
      for (let x = 0; x < TILE; x++) p.set(x, 8, 0x5f4a2a);
      // 锤子（左）
      rect(p, 3, 10, 2, 4, 0xb7a98d);
      rect(p, 2, 10, 4, 1, 0x8f8471);
      // 锯（右）
      for (let i = 0; i < 5; i++) {
        p.set(9 + i, 10 + i, 0xc9c1b4);
        p.set(9 + i, 11 + i, 0x8f8471);
      }
      rect(p, 13, 9, 2, 2, 0x6e5a3a);
    },
    // ---- 追加植物 ----
    red_mushroom: (p, rng) => {
      p.clear();
      for (let y = 9; y < 16; y++) {
        p.set(7, y, 0xe8e2d2); p.set(8, y, 0xd8d2c0);
      }
      // 菌盖
      for (let y = 4; y <= 9; y++) {
        const w = y >= 8 ? 5 : y >= 6 ? 4 : 3;
        for (let x = 8 - w; x <= 7 + w; x++) {
          if (x < 0 || x >= TILE) continue;
          p.set(x, y, jitter(y <= 5 ? 0xd8483a : 0xc93a2e, rng, 8));
        }
      }
      for (let x = 3; x <= 12; x++) p.set(x, 9, 0xe8d8c8);
      // 白色斑点
      for (const [x, y] of [[5, 6], [9, 5], [11, 7], [4, 8]]) {
        p.set(x, y, 0xf2f0e8); p.set(x + 1, y, 0xf2f0e8);
      }
    },
    brown_mushroom: (p, rng) => {
      p.clear();
      for (let y = 10; y < 16; y++) {
        p.set(7, y, 0xe8e2d2); p.set(8, y, 0xd8d2c0);
      }
      for (let y = 5; y <= 10; y++) {
        const w = y >= 9 ? 5 : y >= 7 ? 4 : 3;
        for (let x = 8 - w; x <= 7 + w; x++) {
          if (x < 0 || x >= TILE) continue;
          const edge = y >= 9 || x <= 8 - w || x >= 7 + w;
          p.set(x, y, jitter(edge ? 0xa87848 : 0x9c6b3f, rng, 7));
        }
      }
      for (let x = 4; x <= 11; x++) p.set(x, 10, 0xd8c8b0);
      for (const [x, y] of [[6, 7], [10, 6], [8, 8]]) p.set(x, y, 0xb98a55);
    },
    dead_bush: (p, rng) => {
      p.clear();
      // 主干
      for (let y = 8; y < 16; y++) p.set(7, y, 0x6b4a2a);
      p.set(8, 14, 0x6b4a2a);
      // 分叉细枝
      for (let i = 0; i < 7; i++) {
        let x = 7 + (((rng() * 3) | 0) - 1);
        let y = 8 + ((rng() * 5) | 0);
        const dx = rng() < 0.5 ? -1 : 1;
        for (let k = 0; k < 4 + ((rng() * 3) | 0); k++) {
          p.set(x, y, rng() < 0.7 ? 0x7d5732 : 0x5f411f);
          x += rng() < 0.65 ? dx : ((rng() * 3) | 0) - 1;
          y -= 1;
          if (x < 1 || x > 14 || y < 1) break;
        }
      }
      for (let i = 0; i < 3; i++) p.set(6 + ((rng() * 3) | 0), 7, 0x5f411f);
    },
  };
}

function woolPainter(hex: number): Painter {
  return (p, rng) => {
    fillNoise(p, rng, hex, 5);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        if (x % 4 === 0 || y % 4 === 0) {
          const i = (y * TILE + x) * 4;
          p.data[i] = Math.max(0, p.data[i] - 8);
          p.data[i + 1] = Math.max(0, p.data[i + 1] - 8);
          p.data[i + 2] = Math.max(0, p.data[i + 2] - 8);
        }
      }
    }
  };
}

export class TextureAtlas {
  readonly texture: THREE.CanvasTexture;
  private painters = new Map<string, Painter>();
  private indices = new Map<string, number>();
  private canvas: HTMLCanvasElement;
  private tileCache = new Map<string, HTMLCanvasElement>();
  private avgCache = new Map<string, [number, number, number]>();

  constructor() {
    const builtins = builtinPainters();
    for (const [name, fn] of Object.entries(builtins)) this.painters.set(name, fn);
    this.painters.set('white_wool', woolPainter(0xe9ecec));
    this.painters.set('red_wool', woolPainter(0xa12722));
    this.painters.set('blue_wool', woolPainter(0x35399d));
    this.painters.set('yellow_wool', woolPainter(0xf0af15));
    this.painters.set('orange_wool', woolPainter(0xd97b1f));
    this.painters.set('green_wool', woolPainter(0x3f7a2f));
    this.painters.set('purple_wool', woolPainter(0x7a3f9e));
    this.painters.set('black_wool', woolPainter(0x24242a));
    let i = 0;
    for (const name of this.painters.keys()) this.indices.set(name, i++);

    this.canvas = document.createElement('canvas');
    this.canvas.width = SIZE;
    this.canvas.height = SIZE;
    this.paintAll();
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.colorSpace = THREE.SRGBColorSpace;
  }

  private paintAll() {
    const ctx = this.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, SIZE, SIZE);
    for (const [name, painter] of this.painters) {
      const idx = this.indices.get(name)!;
      const p = new Px();
      painter(p, mulberry32(hashStr(name)));
      const img = new ImageData(p.data, TILE, TILE);
      ctx.putImageData(img, (idx % GRID) * TILE, ((idx / GRID) | 0) * TILE);
    }
    this.tileCache.clear();
    this.avgCache.clear();
  }

  /** 扩展点：注册自定义纹理并重绘图集 */
  registerTile(name: string, painter: (setPixel: (x: number, y: number, hexColor: number, alpha?: number) => void, rng: () => number) => void) {
    if (!this.painters.has(name)) {
      if (this.indices.size >= GRID * GRID) {
        throw new Error(`纹理图集已满（${GRID * GRID} 格），无法注册 ${name}`);
      }
      this.indices.set(name, this.indices.size);
    }
    this.painters.set(name, (p, rng) => painter((x, y, hex, a) => p.set(x, y, hex, a), rng));
    this.paintAll();
    this.texture.needsUpdate = true;
  }

  hasTile(name: string) {
    return this.painters.has(name);
  }

  /** 带半像素内缩的 UV，防止图集渗色 */
  uv(name: string): [number, number, number, number] {
    const idx = this.indices.get(name) ?? 0;
    const inset = 0.02 / TILE;
    const u0 = (idx % GRID) / GRID + inset;
    const v0 = 1 - (((idx / GRID) | 0) + 1) / GRID + inset;
    return [u0, v0, u0 + 1 / GRID - inset * 2, v0 + 1 / GRID - inset * 2];
  }

  tileCanvas(name: string): HTMLCanvasElement {
    let c = this.tileCache.get(name);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = TILE;
    c.height = TILE;
    const ctx = c.getContext('2d')!;
    const idx = this.indices.get(name) ?? 0;
    ctx.drawImage(this.canvas, (idx % GRID) * TILE, ((idx / GRID) | 0) * TILE, TILE, TILE, 0, 0, TILE, TILE);
    this.tileCache.set(name, c);
    return c;
  }

  dataURL(name: string, scale = 4): string {
    const c = document.createElement('canvas');
    c.width = TILE * scale;
    c.height = TILE * scale;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.tileCanvas(name), 0, 0, c.width, c.height);
    return c.toDataURL();
  }

  avgColor(name: string): [number, number, number] {
    let v = this.avgCache.get(name);
    if (v) return v;
    const ctx = this.tileCanvas(name).getContext('2d')!;
    const d = ctx.getImageData(0, 0, TILE, TILE).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
    }
    n = Math.max(1, n);
    v = [r / n / 255, g / n / 255, b / n / 255];
    this.avgCache.set(name, v);
    return v;
  }

  /** 等距方块图标（物品栏 / 方块库） */
  icon(def: BlockDefinition, size = 48): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    if (def.shape === 'cross') {
      ctx.drawImage(this.tileCanvas(def.tiles.side), size * 0.1, size * 0.1, size * 0.8, size * 0.8);
      return c;
    }
    const top = this.tileCanvas(def.tiles.top);
    const side = this.tileCanvas(def.tiles.side);
    const u = size / 4.6;
    const cx = size / 2;
    const y0 = size * 0.06;
    // 顶面
    ctx.setTransform(2 * u, u, -2 * u, u, cx, y0);
    ctx.drawImage(top, 0, 0, TILE, TILE, 0, 0, 1, 1);
    // 左面
    ctx.setTransform(2 * u, u, 0, 2 * u, cx - 2 * u, y0 + u);
    ctx.drawImage(side, 0, 0, TILE, TILE, 0, 0, 1, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(0, 0, 1, 1);
    // 右面
    ctx.setTransform(2 * u, -u, 0, 2 * u, cx, y0 + 2 * u);
    ctx.drawImage(side, 0, 0, TILE, TILE, 0, 0, 1, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, 1, 1);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return c;
  }

  /** 扁平物品图标（物品栏 / 快捷栏） */
  itemIcon(tile: string, size = 48): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.tileCanvas(tile), size * 0.06, size * 0.06, size * 0.88, size * 0.88);
    return c;
  }

  /** 手持物品的扁平几何体（前后双面片，避免背面不可见） */
  makeItemGeometry(tile: string): THREE.BufferGeometry {
    const [u0, v0, u1, v1] = this.uv(tile);
    const pos: number[] = [];
    const nor: number[] = [];
    const uv: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const hw = 0.33;
    const zz = 0.02;
    for (const [z, dir] of [[zz, 1], [-zz, -1]] as const) {
      const base = pos.length / 3;
      const quad = [[-hw, -hw, u0, v0], [hw, -hw, u1, v0], [hw, hw, u1, v1], [-hw, hw, u0, v1]];
      for (const [x, y, u, v] of quad) {
        pos.push(x, y, z);
        nor.push(0, 0, dir);
        uv.push(u, v);
        col.push(1, 1, 1);
      }
      if (dir === 1) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    return g;
  }

  /** 单个方块的小几何体（手持物品 / TNT 实体用） */
  makeBlockGeometry(def: BlockDefinition): THREE.BufferGeometry {
    const pos: number[] = [];
    const nor: number[] = [];
    const uv: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    if (def.shape === 'cross') {
      const [u0, v0, u1, v1] = this.uv(def.tiles.side);
      const quads = [
        [[0.15, 0, 0.15], [0.85, 0, 0.85], [0.85, 1, 0.85], [0.15, 1, 0.15]],
        [[0.85, 0, 0.15], [0.15, 0, 0.85], [0.15, 1, 0.85], [0.85, 1, 0.15]],
      ];
      for (const q of quads) {
        for (const dir of [1, -1]) {
          const base = pos.length / 3;
          const order = dir === 1 ? [0, 1, 2, 3] : [3, 2, 1, 0];
          const uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
          order.forEach((k, i) => {
            pos.push(...q[k]);
            nor.push(0, 1, 0);
            uv.push(...uvs[i]);
            col.push(1, 1, 1);
          });
          idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
      }
    } else {
      for (const face of FACES) {
        const tileName = face.axis === 1 ? (face.sign > 0 ? def.tiles.top : def.tiles.bottom) : def.tiles.side;
        const [u0, v0, u1, v1] = this.uv(tileName);
        const base = pos.length / 3;
        for (const [x, y, z, u, v] of face.corners) {
          pos.push(x - 0.5, y - 0.5, z - 0.5);
          nor.push(...face.normal);
          uv.push(u0 + (u1 - u0) * u, v0 + (v1 - v0) * v);
          col.push(face.shade, face.shade, face.shade);
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    return g;
  }
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}