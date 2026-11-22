import * as THREE from 'three';
import { mulberry32 } from '../core/types';
import type { BlockDefinition } from '../world/blocks';
import { FACES } from '../world/faces';

/**
 * 程序化像素纹理图集：所有方块纹理用 Canvas 逐像素绘制（16×16），
 * 零外部资源，风格贴近原版。扩展点：registerTile() 可注入自定义纹理。
 */

const TILE = 16;
/** 16×16 = 256 槽：内置方块 + 扩展方块 + 运行时 registerTile 仍有富余 */
const GRID = 16;
const SIZE = TILE * GRID;

/**
 * tile 边缘内缩（占 tile 比例）：防止图集渗色。
 * 全部 tile 共用同一个内缩，因此 tile 的 UV 尺寸也是常量。
 */
export const TILE_INSET = 0.02 / TILE;
/** 单个 tile 的 UV 尺寸 [du, dv]，全图集一致 —— 顶点只需存 tile 起点 */
export const TILE_UV_SIZE: readonly [number, number] = [
  1 / GRID - TILE_INSET * 2,
  1 / GRID - TILE_INSET * 2,
];

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

/**
 * 转灰度（BT.601 亮度，jitter 后仍保持 r=g=b）。
 * 草 / 叶 / 藤蔓纹理在图集里画成灰度，区块 shader 按世界坐标噪声乘群系色
 * （chunkManager.injectLight 的 foliageTint）；亮度保留原纹理的明暗对比。
 */
const gray = (hex: number) => {
  const l = Math.round(0.299 * ((hex >> 16) & 255) + 0.587 * ((hex >> 8) & 255) + 0.114 * (hex & 255));
  return (l << 16) | (l << 8) | l;
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

/** 直立茎：从 y0（顶部）画到 y1（底部），可选左右摆动 */
const stem = (p: Px, x: number, y0: number, y1: number, hex: number) => {
  for (let y = y0; y <= y1; y++) p.set(x, y, hex);
};

/** 斜向茎，供藤蔓 / 南瓜藤使用 */
const curlStem = (p: Px, x: number, y0: number, y1: number, hex: number, rng: () => number) => {
  let cx = x;
  for (let y = y0; y <= y1; y++) {
    p.set(cx, y, jitter(hex, rng, 6));
    if (rng() < 0.28) cx += rng() < 0.5 ? -1 : 1;
  }
};

/** 两片对称小叶 */
const leaves = (p: Px, x: number, y: number, hex: number) => {
  p.set(x - 1, y, hex);
  p.set(x + 1, y, hex);
  p.set(x - 2, y + 1, hex);
  p.set(x + 2, y + 1, hex);
};

/** 树叶簇：与橡树叶同构，仅色调随树种变化（灰度画，shader 乘群系色） */
function leavesPainter(tones: number[]): Painter {
  const grays = tones.map(gray);
  return (p, rng) => {
    p.clear();
    for (let cy = 0; cy < 4; cy++) {
      for (let cx = 0; cx < 4; cx++) {
        const base = grays[(rng() * grays.length) | 0];
        for (let y = 0; y < 4; y++) {
          for (let x = 0; x < 4; x++) {
            const edge = x === 0 || y === 0 || x === 3 || y === 3;
            if (edge && rng() < 0.10) continue;
            p.set(cx * 4 + x, cy * 4 + y, jitter(base, rng, 7));
          }
        }
      }
    }
    for (let i = 0; i < 5; i++) p.set((rng() * TILE) | 0, (rng() * TILE) | 0, 0, 0);
  };
}

/** 树干侧面：纵纹 + 少量深浅斑 */
function logSidePainter(base: number, dark: number, light: number, dashes = false): Painter {
  return (p, rng) => {
    fillNoise(p, rng, base, 7);
    for (const x of [0, 4, 8, 12, 15]) {
      for (let y = 0; y < TILE; y++) if (rng() < 0.8) p.set(x, y, jitter(dark, rng, 7));
    }
    blob(p, rng, light, 5, 4);
    if (dashes) {
      for (let i = 0; i < 5; i++) {
        const x = 1 + ((rng() * 12) | 0);
        const y = 1 + ((rng() * 13) | 0);
        p.set(x, y, jitter(dark, rng, 10));
        if (rng() < 0.7) p.set(x + 1, y, dark);
      }
    }
  };
}

/** 树干横截面：年轮 */
function logTopPainter(base: number, ring: number, bark: number): Painter {
  return (p, rng) => {
    fillNoise(p, rng, base, 6);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
        if (d >= 6.5) p.set(x, y, jitter(bark, rng, 6));
        else if (((d | 0) % 3) === 1) p.set(x, y, jitter(ring, rng, 5));
      }
    }
  };
}

/** 花：茎 + 两片叶 + 顶部花冠（kind 决定花冠造型） */
function flowerPainter(
  petal: number, light: number, center: number,
  kind: 'round' | 'cup' | 'bell' | 'daisy' | 'cluster' | 'sphere' | 'bluet' | 'spike',
  stemHex = 0x3e7a22, top = 3,
): Painter {
  return (p, rng) => {
    p.clear();
    stem(p, 7, top + 5, 15, stemHex);
    leaves(p, 7, 11 + ((rng() * 2) | 0), 0x4c8f2b);
    if (kind === 'round' || kind === 'cup' || kind === 'cluster') {
      const y0 = top, y1 = top + 4;
      for (let y = y0; y <= y1; y++) {
        const w = kind === 'cup' ? (y >= y1 - 1 ? 3 : 2) : (y === y0 || y === y1 ? 1 : 2);
        for (let x = 7 - w; x <= 8 + w; x++) {
          const edge = x === 7 - w || x === 8 + w || y === y0 || y === y1;
          p.set(x, y, jitter(edge ? light : petal, rng, 7));
        }
      }
      p.set(7, y1 - 1, center);
      p.set(8, y1 - 1, center);
    } else if (kind === 'bell') {
      for (let y = top; y <= top + 3; y++) {
        const w = y === top ? 1 : 2;
        for (let x = 7 - w; x <= 8 + w; x++) p.set(x, y, jitter(y === top ? light : petal, rng, 7));
      }
      p.set(7, top + 4, 0x8a6a3a);
      p.set(8, top + 4, 0x8a6a3a);
    } else if (kind === 'daisy') {
      for (const [dx, dy] of [[0, 0], [-2, 1], [2, 1], [-1, -1], [1, -1], [-1, 2], [1, 2], [0, 3], [0, -2]]) {
        p.set(8 + dx, top + 2 + dy, jitter(light, rng, 6));
      }
      for (let y = top + 1; y <= top + 2; y++) {
        for (let x = 7; x <= 8; x++) p.set(x, y, jitter(center, rng, 6));
      }
    } else if (kind === 'sphere') {
      for (let y = top; y <= top + 5; y++) {
        for (let x = 5; x <= 10; x++) {
          const dx = x - 7.5, dy = y - (top + 2.5);
          if (dx * dx + dy * dy > 7.5) continue;
          p.set(x, y, jitter(dx * dx + dy * dy > 4 ? petal : light, rng, 8));
        }
      }
    } else if (kind === 'bluet') {
      for (const [dx, dy] of [[0, 0], [-2, 0], [2, 0], [0, -2], [0, 2]]) {
        p.set(8 + dx, top + 2 + dy, jitter(light, rng, 5));
      }
      p.set(8, top + 2, center);
    } else {
      // spike：向日葵 / 麦穗式的长条花冠
      for (let y = top; y <= top + 5; y++) {
        const w = y === top || y === top + 5 ? 1 : 2;
        for (let x = 7 - w; x <= 8 + w; x++) p.set(x, y, jitter(x === 7 - w ? light : petal, rng, 7));
      }
      for (let y = top + 1; y <= top + 4; y += 2) {
        p.set(7, y, center);
        p.set(8, y, center);
      }
    }
    // 右下压暗一层，花瓣与叶片的轮廓更有体积
    shadeEdges(p, 0.84);
  };
}

/** 灌木：底部叶团 + 若干花点 */
function bushPainter(leafHex: number, lightHex: number, flowerHex: number, flowerLight: number): Painter {
  return (p, rng) => {
    p.clear();
    stem(p, 7, 12, 15, 0x4a5a24);
    stem(p, 8, 12, 15, 0x4a5a24);
    for (let y = 5; y <= 12; y++) {
      const w = y <= 6 ? 3 : y <= 9 ? 5 : 4;
      for (let x = 7 - w; x <= 8 + w; x++) {
        if (rng() < 0.12) continue;
        p.set(x, y, jitter(rng() < 0.3 ? lightHex : leafHex, rng, 8));
      }
    }
    for (let i = 0; i < 7; i++) {
      const x = 3 + ((rng() * 10) | 0);
      const y = 4 + ((rng() * 8) | 0);
      const edge = rng() < 0.5 ? flowerLight : flowerHex;
      p.set(x, y, edge);
      if (rng() < 0.6) p.set(x + 1, y, flowerHex);
    }
    shadeEdges(p, 0.86);
  };
}

/** 作物 / 草叶：多根从底部向上的叶片，随成长阶段变高变黄 */
function cropPainter(bladeHex: number, tipHex: number, height: number, heads: boolean): Painter {
  return (p, rng) => {
    p.clear();
    for (let i = 0; i < 5; i++) {
      const x0 = 2 + i * 3;
      const h = height + ((rng() * 3) | 0);
      for (let k = 0; k < h; k++) {
        const y = 15 - k;
        const x = x0 + Math.round(Math.sin(k * 0.35 + i) * 0.8);
        p.set(x, y, jitter(k === h - 1 ? tipHex : bladeHex, rng, 7));
      }
      if (heads && i % 2 === 0) {
        const x = x0 + Math.round(Math.sin((h - 1) * 0.35 + i) * 0.8);
        for (let dy = 0; dy < 3; dy++) {
          p.set(x - 1, 15 - h + 1 - dy, jitter(0xd8b848, rng, 10));
          p.set(x, 15 - h + 1 - dy, jitter(0xf0d878, rng, 8));
          p.set(x + 1, 15 - h + 1 - dy, jitter(0xd8b848, rng, 10));
        }
      }
    }
  };
}

/** 树苗：纤细树干 + 顶部小叶团 */
function saplingPainter(leafHex: number, lightHex: number, trunkHex = 0x6b4a2a): Painter {
  return (p, rng) => {
    p.clear();
    stem(p, 7, 8, 15, trunkHex);
    stem(p, 8, 9, 15, trunkHex);
    for (let y = 3; y <= 9; y++) {
      const w = y >= 8 ? 2 : y >= 5 ? 3 : 2;
      for (let x = 7 - w; x <= 8 + w; x++) {
        if (rng() < 0.14) continue;
        p.set(x, y, jitter(rng() < 0.35 ? lightHex : leafHex, rng, 8));
      }
    }
  };
}


/** 右 / 下与透明相邻的像素压暗，给像素小图一层体块阴影（左上受光） */
const shadeEdges = (p: Px, factor = 0.82) => {
  const src = new Uint8ClampedArray(p.data);
  const alphaAt = (x: number, y: number) =>
    x < 0 || y < 0 || x >= TILE || y >= TILE ? 0 : src[(y * TILE + x) * 4 + 3];
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const i = (y * TILE + x) * 4;
      if (src[i + 3] === 0) continue;
      if (alphaAt(x + 1, y) !== 0 && alphaAt(x, y + 1) !== 0) continue;
      p.data[i] = src[i] * factor;
      p.data[i + 1] = src[i + 1] * factor;
      p.data[i + 2] = src[i + 2] * factor;
    }
  }
};

/** 放射花冠参数：花瓣数、受光 / 背光色、花心与缺刻深度 */
interface BloomSpec {
  petal: number;
  light: number;
  dark: number;
  center: number;
  petals: number;
  radiusX: number;
  radiusY: number;
  top: number;
  leaf?: number;
  stem?: number;
  notch?: number;
}

/**
 * 放射花冠：按角度生成花瓣缺刻，左上受光、右下压暗，花心带高光。
 * 同一套算法换调色板即可画出雏菊 / 郁金香 / 龙胆等不同花型。
 */
const bloomPainter = (spec: BloomSpec): Painter => {
  const { petal, light, dark, center, petals, radiusX, radiusY, top } = spec;
  const leafHex = spec.leaf ?? 0x4c8f2b;
  const stemHex = spec.stem ?? 0x3e7a22;
  const notch = spec.notch ?? 0.7;
  return (p, rng) => {
    p.clear();
    stem(p, 7, top + 4, 15, stemHex);
    stem(p, 8, top + 5, 15, jitter(stemHex, rng, 8));
    leaves(p, 7, 12, jitter(leafHex, rng, 6));
    const cx = 7.5;
    const cy = top + radiusY - 0.5;
    for (let y = Math.floor(top - 1); y <= Math.ceil(top + radiusY * 2); y++) {
      for (let x = 0; x < TILE; x++) {
        const dx = (x - cx) / radiusX;
        const dy = (y - cy) / radiusY;
        const d = dx * dx + dy * dy;
        if (d > 1) continue;
        const ang = Math.atan2(dy, dx);
        const lobe = 0.6 + 0.4 * Math.cos(ang * petals);
        if (d > 0.3 && lobe < notch) continue;
        const lit = -dx * 0.7 - dy;
        let hex = petal;
        if (d > 0.74) hex = dark;
        else if (lit > 0.34) hex = light;
        p.set(x, y, jitter(hex, rng, 7));
      }
    }
    const iy = Math.round(cy);
    for (let y = iy - 1; y <= iy; y++) for (let x = 7; x <= 8; x++) p.set(x, y, jitter(center, rng, 5));
    p.set(7, iy - 1, jitter(light, rng, 10));
    shadeEdges(p, 0.84);
  };
};

/** 发光的放射花冠：在花冠周围撒一圈亮色微粒，用于洞穴 / 夜晚植物 */
const glowingBloomPainter = (spec: BloomSpec, glow: number): Painter => {
  const base = bloomPainter(spec);
  return (p, rng) => {
    base(p, rng);
    for (let i = 0; i < 9; i++) {
      p.set(1 + ((rng() * 14) | 0), 1 + ((rng() * 11) | 0), jitter(glow, rng, 12));
    }
  };
};

/** 穗状花序：薰衣草 / 风信子那种沿茎密生小花，wide 控制花穗宽度 */
const beadSpikePainter = (
  petal: number, light: number, dark: number, top: number, wide: boolean,
  stemHex = 0x3e7a22, leafHex = 0x4c8f2b,
): Painter => (p, rng) => {
  p.clear();
  stem(p, 7, top + 3, 15, stemHex);
  stem(p, 8, top + 5, 15, jitter(stemHex, rng, 8));
  leaves(p, 7, 12, leafHex);
  const rows = wide ? 8 : 7;
  for (let row = 0; row < rows; row++) {
    const y = top + row;
    const t = row / rows;
    const half = wide ? (t < 0.25 ? 1 : t < 0.7 ? 2 : 1) : (t < 0.3 ? 0 : t < 0.72 ? 1 : 0);
    const shift = row % 2 === 0 ? 0 : 1;
    for (let dx = -half; dx <= half; dx++) {
      const edge = Math.abs(dx) === half;
      p.set(7 + dx + shift, y, jitter(edge ? dark : y === top ? light : petal, rng, 7));
    }
    if (row % 2 === 0) p.set(7 + shift, y, jitter(light, rng, 9));
  }
  shadeEdges(p, 0.84);
};

/** 伞形花序：勿忘我 / 野蒜的小碎花，三根花梗各顶一簇 */
const umbelPainter = (
  petal: number, light: number, center: number, stemHex = 0x3e7a22,
): Painter => (p, rng) => {
  p.clear();
  stem(p, 7, 6, 15, stemHex);
  leaves(p, 7, 13, 0x4c8f2b);
  const tips: [number, number][] = [[4, 4], [8, 3], [11, 5]];
  for (const [tx, ty] of tips) {
    const steps = Math.max(Math.abs(tx - 7), Math.abs(ty - 6));
    for (let s = 0; s <= steps; s++) {
      p.set(
        Math.round(7 + ((tx - 7) * s) / steps),
        Math.round(6 + ((ty - 6) * s) / steps),
        jitter(stemHex, rng, 6),
      );
    }
    p.set(tx, ty - 1, light);
    p.set(tx - 1, ty, light);
    p.set(tx + 1, ty, light);
    p.set(tx, ty + 1, petal);
    p.set(tx, ty, center);
    if (rng() < 0.5) p.set(tx - 1, ty - 1, petal);
    if (rng() < 0.4) p.set(tx + 1, ty + 1, petal);
  }
  shadeEdges(p, 0.86);
};

/** 毛地黄：沿茎一侧垂挂一串钟形花 */
const foxglovePainter = (petal: number, light: number, dark: number): Painter => (p, rng) => {
  p.clear();
  stem(p, 7, 2, 15, 0x3e7a22);
  leaves(p, 7, 12, 0x4c8f2b);
  leaves(p, 7, 9, 0x5aa236);
  for (let i = 0; i < 5; i++) {
    const y = 2 + i * 2;
    const left = i % 2 === 0;
    const bx = left ? 3 : 8;
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 4; dx++) {
        const edge = dx === 3 || dy === 1;
        p.set(bx + dx, y + dy, jitter(edge ? dark : dy === 0 ? light : petal, rng, 6));
      }
    }
    p.set(left ? bx + 3 : bx, y + 1, 0xf6d8e8);
  }
  shadeEdges(p, 0.86);
};

/** 蜀葵：高茎 + 沿轴分布的大轮花 */
const hollyhockPainter = (petal: number, light: number, dark: number, center: number): Painter =>
  (p, rng) => {
    p.clear();
    stem(p, 7, 1, 15, 0x3f6a24);
    stem(p, 8, 2, 15, 0x4a7a2a);
    leaves(p, 7, 13, 0x4f8f2c);
    leaves(p, 7, 10, 0x5aa236);
    for (const [bx, by] of [[3, 2], [9, 5], [2, 8]] as const) {
      for (let y = by; y < by + 3; y++) {
        for (let x = bx; x < bx + 4; x++) {
          const edge = x === bx || y === by + 2;
          p.set(x, y, jitter(edge ? dark : y === by ? light : petal, rng, 7));
        }
      }
      p.set(bx + 1, by + 1, center);
      p.set(bx + 2, by + 1, center);
    }
    shadeEdges(p, 0.86);
  };

/** 常春藤：蜿蜒藤茎 + 交替的心形叶，适合垂挂成帘 */
const ivyPainter = (leaf: number, light: number, dark: number): Painter => (p, rng) => {
  p.clear();
  let x = 7;
  for (let y = 0; y < TILE; y++) {
    p.set(x, y, jitter(y % 5 === 0 ? light : dark, rng, 6));
    if (rng() < 0.28) x += rng() < 0.5 ? -1 : 1;
    x = Math.max(2, Math.min(13, x));
    if (y % 4 === 1) {
      const side = y % 8 === 1 ? -1 : 1;
      const lx = x + side * 2;
      for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, 1], [-1, 1], [1, 1]] as const) {
        p.set(lx + dx, y + dy, jitter(dx + dy <= 0 ? light : leaf, rng, 7));
      }
      p.set(lx, y + 2, jitter(leaf, rng, 6));
    }
  }
  shadeEdges(p, 0.84);
};

/** 雪滴花：拱形花茎末端垂一枚白色小铃 */
const snowdropPainter = (petal: number, light: number, sepal: number): Painter => (p, rng) => {
  p.clear();
  let x = 7;
  for (let y = 15; y >= 4; y--) {
    p.set(x, y, 0x4a7a2a);
    if (y < 8) x += 1;
  }
  for (let y = 2; y <= 5; y++) {
    const w = y <= 3 ? 1 : 2;
    for (let dx = -w; dx <= w; dx++) {
      p.set(x + 1 + dx, y + 1, jitter(dx === -w ? light : petal, rng, 6));
    }
  }
  p.set(x + 1, 2, sepal);
  p.set(x, 2, sepal);
  p.set(x + 2, 2, sepal);
  leaves(p, 7, 12, 0x4c8f2b);
  shadeEdges(p, 0.9);
};

/** 番红花：贴地小杯花，紫色花瓣 + 橙色花蕊 */
const crocusPainter = (petal: number, light: number, dark: number): Painter => (p, rng) => {
  p.clear();
  stem(p, 7, 9, 15, 0x4f8f2c);
  for (const x0 of [3, 11]) {
    for (let k = 0; k < 6; k++) p.set(x0 + (x0 < 8 ? k * 0.4 : -k * 0.4) | 0, 14 - k, 0x5a9a3a);
  }
  for (let y = 5; y <= 11; y++) {
    const w = y <= 6 ? 0 : y <= 8 ? 1 : 2;
    for (let x = 7 - w; x <= 8 + w; x++) {
      const edge = x === 7 - w || x === 8 + w;
      p.set(x, y, jitter(edge ? dark : y <= 6 ? light : petal, rng, 7));
    }
  }
  p.set(7, 7, 0xf0a030);
  p.set(8, 7, 0xf0c050);
  shadeEdges(p, 0.86);
};

/** 丝兰：放射状硬叶莲座 + 中央高花穗 */
const yuccaPainter = (leaf: number, light: number, sand: number, bloom: number): Painter =>
  (p, rng) => {
    p.clear();
    for (let i = 0; i < 9; i++) {
      const tx = 1 + i * 1.75;
      const steps = 8 + ((rng() * 4) | 0);
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        const x = Math.round(7.5 + (tx - 7.5) * t);
        const y = Math.round(15 - t * 9);
        p.set(x, y, jitter(k >= steps - 1.5 ? light : leaf, rng, 7));
      }
    }
    stem(p, 7, 5, 9, sand);
    for (let y = 0; y <= 5; y += 2) {
      const w = y <= 1 ? 2 : 3;
      for (let x = 7 - w; x <= 8 + w; x++) p.set(x, y, jitter(x === 7 - w ? bloom : 0xf2ead0, rng, 7));
    }
    shadeEdges(p, 0.84);
  };

/** 海石竹：低矮草垫上三团粉色球花 */
const cushionPainter = (petal: number, light: number, leaf: number): Painter => (p, rng) => {
  p.clear();
  for (let x = 1; x <= 14; x++) {
    const h = 3 + ((rng() * 3) | 0);
    for (let k = 0; k < h; k++) p.set(x, 15 - k, jitter(k === h - 1 ? 0x8fbe57 : leaf, rng, 7));
  }
  for (const [cx, cy] of [[4, 8], [8, 6], [11, 9]] as const) {
    for (let y = cy - 1; y <= cy + 1; y++) {
      for (let x = cx - 1; x <= cx + 1; x++) {
        if (rng() < 0.12) continue;
        p.set(x, y, jitter((x + y) % 3 === 0 ? light : petal, rng, 7));
      }
    }
    p.set(cx, cy - 2, petal);
  }
  shadeEdges(p, 0.86);
};

/** 海滩草：偏黄绿的风吹草叶 + 麦穗状种子 */
const beachGrassPainter = (blade: number, tip: number, head: number): Painter => (p, rng) => {
  p.clear();
  for (let i = 0; i < 6; i++) {
    const x0 = 2 + i * 2;
    const h = 7 + ((rng() * 7) | 0);
    for (let k = 0; k < h; k++) {
      const y = 15 - k;
      const x = x0 + Math.round(Math.sin(k * 0.4 + i) * 1.1);
      p.set(x, y, gray(k >= h - 2 ? tip : blade));
    }
    const tx = x0 + Math.round(Math.sin((h - 1) * 0.4 + i) * 1.1);
    if (i % 2 === 0) for (let d = 0; d < 3; d++) p.set(tx, 14 - h - d, gray(head));
  }
};

/** 浮萍：几片小圆叶贴水面漂着，叶心一点深色 */
const padPainter = (leaf: number, light: number, flower: number): Painter => (p, rng) => {
  p.clear();
  for (const [cx, cy] of [[4, 11], [9, 10], [7, 13], [12, 13], [2, 14]] as const) {
    const r = 2 + (rng() < 0.35 ? 1 : 0);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        const dx = (x - cx) / (r + 0.4);
        const dy = (y - cy) / (r + 0.2);
        if (dx * dx + dy * dy > 1) continue;
        p.set(x, y, jitter((x + y) % 3 === 0 ? light : leaf, rng, 6));
      }
    }
    p.set(cx, cy, jitter(leaf, rng, 4));
  }
  p.set(8, 10, flower);
  p.set(9, 11, flower);
  shadeEdges(p, 0.9);
};

/** 海葵：底座 + 向上放射的触手，触手顶端更亮 */
const anemonePainter = (tentacle: number, light: number, base: number): Painter => (p, rng) => {
  p.clear();
  for (let x = 3; x <= 12; x++) p.set(x, 15, jitter(base, rng, 6));
  for (let x = 5; x <= 10; x++) p.set(x, 14, jitter(base, rng, 6));
  for (let i = 0; i < 9; i++) {
    const ang = -Math.PI / 2 + (i - 4) * 0.3;
    let x = 7.5;
    const len = 7 + ((rng() * 4) | 0);
    for (let k = 0; k < len; k++) {
      p.set(Math.round(x), Math.round(13 - k), jitter(k > len - 3 ? light : tentacle, rng, 8));
      x += Math.cos(ang) * 0.9;
    }
  }
  shadeEdges(p, 0.9);
};

/** 红藻：分叉的红色藻体 */
const algaePainter = (main: number, dark: number, light: number): Painter => (p, rng) => {
  p.clear();
  for (const x0 of [4, 8, 11]) {
    let x = x0;
    for (let y = 15; y >= 1; y--) {
      p.set(x, y, jitter(y % 4 === 0 ? light : main, rng, 6));
      if (rng() < 0.3) x += rng() < 0.5 ? -1 : 1;
      if (y % 4 === 2) {
        p.set(x - 1, y, dark);
        p.set(x + 1, y, dark);
      }
    }
  }
  for (let i = 0; i < 6; i++) {
    const x = 2 + ((rng() * 12) | 0);
    const y = 3 + ((rng() * 11) | 0);
    const dir = rng() < 0.5 ? 1 : -1;
    for (let k = 0; k < 3; k++) p.set(x + k * dir, y - k, jitter(main, rng, 6));
  }
  shadeEdges(p, 0.86);
};

/** 荧光苔：贴地苔垫 + 青色发光孢子 */
const glowMossPainter = (base: number, light: number, glow: number): Painter => (p, rng) => {
  p.clear();
  for (let x = 0; x < TILE; x++) {
    const h = 3 + ((rng() * 4) | 0);
    for (let k = 0; k < h; k++) p.set(x, 15 - k, jitter(k === h - 1 ? light : base, rng, 8));
  }
  for (let i = 0; i < 12; i++) p.set(1 + ((rng() * 14) | 0), 9 + ((rng() * 7) | 0), jitter(glow, rng, 10));
  shadeEdges(p, 0.9);
};

/** 荧光蕨：蕨叶 + 沿叶脉的青色光点 */
const glowFernPainter = (leaf: number, light: number, glow: number): Painter => (p, rng) => {
  p.clear();
  for (let i = 0; i < 5; i++) {
    const x0 = 2 + i * 3;
    const h = 8 + ((rng() * 7) | 0);
    for (let k = 0; k < h; k++) {
      const y = 15 - k;
      const x = x0 + Math.round(Math.sin(k * 0.5 + i) * 1.2);
      p.set(x, y, jitter(k === h - 1 ? glow : k % 3 === 0 ? light : leaf, rng, 7));
      if (k > 2 && k % 2 === 0) p.set(x + 1, y, jitter(leaf, rng, 6));
    }
  }
  for (let i = 0; i < 5; i++) p.set(2 + ((rng() * 12) | 0), 3 + ((rng() * 8) | 0), 0xbfffe0);
  shadeEdges(p, 0.9);
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
  /** 恶地陶瓦：底色 + 暗斑 + 水平层理细纹 */
  const terracotta = (hex: number, dark: number): Painter => (p, rng) => {
    fillNoise(p, rng, hex, 7);
    blob(p, rng, dark, 8, 4);
    for (let i = 0; i < 4; i++) {
      const y = 2 + ((rng() * 12) | 0);
      for (let x = 0; x < TILE; x++) if (rng() < 0.55) p.set(x, y, jitter(dark, rng, 6));
    }
  };
  return {
    basketball: (p, rng) => {
      // 橙色底 + 深色经纬分格线：与 3D 球模型共用同一套像素语言，零外部资源
      fillNoise(p, rng, 0xd2691e, 8);
      blob(p, rng, 0xb8551a, 6, 3);
      blob(p, rng, 0xe88a3c, 5, 2);
      for (let i = 0; i < TILE; i++) {
        p.set(7, i, 0x2b1408);
        p.set(8, i, 0x2b1408);
        p.set(i, 7, 0x2b1408);
        p.set(i, 8, 0x2b1408);
      }
      // 四角弧缝（像素阶梯）
      for (let i = 0; i < 4; i++) {
        p.set(2 + i, 2 + i, 0x2b1408);
        p.set(13 - i, 2 + i, 0x2b1408);
        p.set(2 + i, 13 - i, 0x2b1408);
        p.set(13 - i, 13 - i, 0x2b1408);
      }
      rect(p, 3, 3, 2, 2, 0xf2a35c); // 左上高光
      shadeEdges(p, 0.86);
    },
    grass_top: (p, rng) => {
      // 灰度画：群系色由 shader 按世界坐标噪声调制（chunkManager.injectLight）
      fillNoise(p, rng, gray(0x7ba848), 10);
      blob(p, rng, gray(0x6b9a3e), 10, 3);
      blob(p, rng, gray(0x8fbe57), 8, 3);
      // 短草叶，让大草地不至于只有噪声
      for (let i = 0; i < 18; i++) {
        const x = (rng() * TILE) | 0;
        const y = (rng() * TILE) | 0;
        p.set(x, y, jitter(gray(0x9ccb63), rng, 8));
        if (rng() < 0.5) p.set(x, y + 1, jitter(gray(0x76a646), rng, 7));
      }
    },
    dirt,
    grass_side: (p, rng) => {
      // 泥土保持彩色，顶部草条带画灰度：shader 的饱和度掩膜只染灰度部分
      dirt(p, rng);
      for (let x = 0; x < TILE; x++) {
        const depth = 2 + ((rng() * 3) | 0);
        for (let y = 0; y < depth; y++) p.set(x, y, jitter(gray(0x7ba848), rng, 10));
        if (rng() < 0.4) p.set(x, depth, jitter(gray(0x6b9a3e), rng, 8));
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
      // 灰度画：群系色由 shader 调制（tint 方块）
      const tones = [0x2f5f1c, 0x3f7a24, 0x4f8f2c, 0x5aa236].map(gray);
      // 4×4 的叶簇：同一簇内色调统一，边缘随机镂空，整体不再是椒盐噪声
      for (let cy = 0; cy < 4; cy++) {
        for (let cx = 0; cx < 4; cx++) {
          const base = tones[(rng() * tones.length) | 0];
          for (let y = 0; y < 4; y++) {
            for (let x = 0; x < 4; x++) {
              const edge = x === 0 || y === 0 || x === 3 || y === 3;
              if (edge && rng() < 0.10) continue;
              p.set(cx * 4 + x, cy * 4 + y, jitter(base, rng, 7));
            }
          }
          if (rng() < 0.55) {
            p.set(cx * 4 + 1 + ((rng() * 2) | 0), cy * 4 + 1 + ((rng() * 2) | 0),
              jitter(gray(0x6fb545), rng, 8));
          }
        }
      }
      // 少量透光孔与底部暗部
      for (let i = 0; i < 6; i++) {
        p.set((rng() * TILE) | 0, (rng() * TILE) | 0, 0, 0);
      }
      for (let x = 0; x < TILE; x++) {
        if (rng() < 0.35) p.set(x, 15, jitter(gray(0x2a5418), rng, 6));
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
          p.set(x, y, gray(k === h - 1 ? 0x93c45e : i % 2 ? 0x6fa03e : 0x82b44e));
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
    // ---- v1.4.0 追加矿石 / 地表 / 植物 ----
    copper_ore: (p, rng) => {
      stoneBase(p, rng);
      blob(p, rng, 0xb87333, 6, 5);
      blob(p, rng, 0xe08a4b, 4, 3);
    },
    emerald_ore: (p, rng) => {
      stoneBase(p, rng);
      blob(p, rng, 0x1fae62, 6, 5);
      blob(p, rng, 0x6ef0a8, 4, 3);
    },
    lapis_ore: (p, rng) => {
      stoneBase(p, rng);
      blob(p, rng, 0x2a52b8, 6, 5);
      blob(p, rng, 0x5c86e8, 4, 3);
    },
    redstone_ore: (p, rng) => {
      stoneBase(p, rng);
      blob(p, rng, 0xb3271f, 7, 5);
      blob(p, rng, 0xe8554a, 5, 3);
    },
    clay: (p, rng) => {
      fillNoise(p, rng, 0xa2a6b4, 7);
      blob(p, rng, 0x8f93a2, 8, 4);
      blob(p, rng, 0xb6bac8, 6, 3);
      for (let y = 0; y < TILE; y += 5) {
        for (let x = 0; x < TILE; x++) if (rng() < 0.5) p.set(x, y, jitter(0x969aa8, rng, 5));
      }
    },
    podzol_top: (p, rng) => {
      fillNoise(p, rng, 0x6b4a2c, 10);
      blob(p, rng, 0x8a5a2e, 9, 4);
      blob(p, rng, 0x9c6a38, 6, 3);
      blob(p, rng, 0x4f3720, 5, 3);
    },
    podzol_side: (p, rng) => {
      dirt(p, rng);
      for (let x = 0; x < TILE; x++) {
        const depth = 3 + ((rng() * 3) | 0);
        for (let y = 0; y < depth; y++) p.set(x, y, jitter(0x6b4a2c, rng, 8));
        if (rng() < 0.4) p.set(x, depth, jitter(0x5a3c22, rng, 6));
      }
    },
    granite: (p, rng) => {
      stoneBase(p, rng);
      blob(p, rng, 0x9a6b62, 10, 3);
      blob(p, rng, 0xb0867c, 6, 2);
      for (let i = 0; i < 10; i++) {
        p.set((rng() * TILE) | 0, (rng() * TILE) | 0, jitter(0x8a5a52, rng, 8));
      }
    },
    cactus: (p, rng) => {
      fillNoise(p, rng, 0x3f7a2f, 8);
      // 纵向棱线与浅色小刺
      for (const x of [0, 1, 7, 8, 14, 15]) {
        for (let y = 0; y < TILE; y++) {
          p.set(x, y, jitter(x % 7 === 0 ? 0x2c5a22 : 0x35682a, rng, 5));
        }
      }
      for (let i = 0; i < 12; i++) {
        const x = 2 + ((rng() * 12) | 0);
        const y = 1 + ((rng() * 14) | 0);
        p.set(x, y, 0xe8e8c8);
        if (rng() < 0.4) p.set(x, y - 1, 0xf5f5d8);
      }
    },
    sugar_cane: (p, rng) => {
      p.clear();
      for (const x0 of [3, 6, 10, 13]) {
        const top = 1 + ((rng() * 3) | 0);
        for (let y = top; y < TILE; y++) {
          const node = y % 5 === 0;
          p.set(x0, y, jitter(node ? 0xd8e8a0 : 0x9fd06a, rng, 7));
          p.set(x0 + 1, y, jitter(node ? 0xb8cc80 : 0x7fb04e, rng, 6));
        }
        // 一两片斜叶
        const ly = 4 + ((rng() * 8) | 0);
        p.set(x0 - 1, ly, 0x8fc45e);
        p.set(x0 + 2, ly + 2, 0x8fc45e);
      }
    },
    fern: (p, rng) => {
      p.clear();
      for (let i = 0; i < 5; i++) {
        const x0 = 3 + i * 2;
        const h = 5 + ((rng() * 8) | 0);
        for (let k = 0; k < h; k++) {
          const y = 15 - k;
          const x = x0 + Math.round(Math.sin(k * 0.6 + i) * 1.2);
          p.set(x, y, gray(k === h - 1 ? 0x8fbe57 : i % 2 ? 0x4f8f2c : 0x5aa236));
          if (k > 2 && k % 2 === 0) {
            p.set(x - 1, y, gray(0x3f7a24));
            p.set(x + 1, y, gray(0x3f7a24));
          }
        }
      }
    },
    // ---- v1.4.1 植物大扩充：花卉 ----
    bluebell: flowerPainter(0x4a5ad0, 0x8a9af0, 0xfff0a0, 'bell', 0x3e7a22, 2),
    allium: flowerPainter(0x9a4ac8, 0xd09af0, 0xfff0c0, 'sphere', 0x3e7a22, 1),
    azure_bluet: flowerPainter(0xeef0e6, 0xffffff, 0xe8c84a, 'bluet', 0x3e7a22, 4),
    oxeye_daisy: flowerPainter(0xf5f5ea, 0xffffff, 0xf0d24a, 'daisy', 0x3e7a22, 3),
    cornflower: flowerPainter(0x3f5fd0, 0x7a9af0, 0x2a3f9a, 'cluster', 0x3e7a22, 4),
    lily_of_the_valley: (p, rng) => {
      p.clear();
      // 拱形花茎，末端垂着几枚白色小铃
      let x = 4;
      for (let y = 15; y >= 5; y--) {
        p.set(x, y, 0x3e7a22);
        if (y < 11 && y % 2 === 0) x += 1;
      }
      for (const [bx, by] of [[5, 12], [7, 10], [9, 8], [11, 7]]) {
        p.set(bx, by, 0xf2f5e8);
        p.set(bx + 1, by, 0xe0e8d0);
        p.set(bx, by + 1, 0xd8e0c8);
      }
      leaves(p, 6, 13, 0x4c8f2b);
      if (rng() < 0.5) p.set(10, 6, 0xffffff);
    },
    tulip_red: flowerPainter(0xd0342c, 0xf06a52, 0x7a1f1a, 'cup'),
    tulip_orange: flowerPainter(0xe8862a, 0xf8b05a, 0x9a4a12, 'cup'),
    tulip_white: flowerPainter(0xe8e6d8, 0xf8f8f0, 0xc8b878, 'cup'),
    tulip_pink: flowerPainter(0xe08ab0, 0xf8bcd4, 0xb0507a, 'cup'),
    sunflower: (p, rng) => {
      p.clear();
      // 高茎 + 两片大叶
      stem(p, 7, 7, 15, 0x4a7a2a);
      stem(p, 8, 8, 15, 0x3f6a24);
      leaves(p, 7, 12, 0x4f8f2c);
      leaves(p, 7, 9, 0x5aa236);
      // 花盘：外圈金黄花瓣 + 中央棕色籽盘
      for (let y = 1; y <= 8; y++) {
        for (let x = 3; x <= 12; x++) {
          const dx = (x - 7.5) / 4.6, dy = (y - 4.5) / 4;
          const d = dx * dx + dy * dy;
          if (d > 1) continue;
          p.set(x, y, jitter(d > 0.52 ? 0xf0c22a : 0x6b4220, rng, 9));
        }
      }
      p.set(7, 4, 0x8a5a2a);
      p.set(8, 5, 0x8a5a2a);
    },
    lilac: bushPainter(0x3f6a2f, 0x4f8a3a, 0xa070d0, 0xc49ae8),
    rose_bush: bushPainter(0x35682a, 0x4f8a3a, 0xc0342c, 0xf06a5a),
    peony: bushPainter(0x3f6a2f, 0x5a8a3a, 0xe08aa8, 0xf8bcd4),
    tall_fern: (p, rng) => {
      p.clear();
      for (let i = 0; i < 6; i++) {
        const x0 = 2 + i * 2;
        const h = 8 + ((rng() * 7) | 0);
        for (let k = 0; k < h; k++) {
          const y = 15 - k;
          const x = x0 + Math.round(Math.sin(k * 0.5 + i) * 1.3);
          p.set(x, y, gray(k === h - 1 ? 0x7aa84a : i % 2 ? 0x356822 : 0x447a2a));
          if (k > 2 && k % 2 === 0) {
            p.set(x - 1, y, gray(0x2a5418));
            p.set(x + 1, y, gray(0x2a5418));
          }
        }
      }
    },
    // ---- 攀爬 / 水生 / 洞穴植物 ----
    vine: (p, rng) => {
      p.clear();
      for (const x0 of [2, 5, 9, 12]) {
        let x = x0;
        const top = (rng() * 4) | 0;
        for (let y = top; y < TILE; y++) {
          p.set(x, y, jitter(gray(y % 4 === 0 ? 0x4f8f2c : 0x35682a), rng, 6));
          if (rng() < 0.22) x += rng() < 0.5 ? -1 : 1;
          if (y % 4 === 1) {
            p.set(x - 1, y, gray(0x3f7a24));
            p.set(x + 1, y, gray(0x4f8f2c));
          }
        }
      }
    },
    lily_pad: (p, rng) => {
      p.clear();
      // 扁圆叶片 + 右侧缺口
      for (let y = 8; y <= 14; y++) {
        for (let x = 1; x <= 14; x++) {
          const dx = (x - 7.5) / 6.2, dy = (y - 11.5) / 2.9;
          if (dx * dx + dy * dy > 1) continue;
          if (x >= 7 && x <= 8 && y >= 10) continue;
          p.set(x, y, jitter((x + y) % 3 === 0 ? 0x4f8f2c : 0x3f7a2f, rng, 6));
        }
      }
      // 一朵粉色睡莲花
      p.set(4, 7, 0xe8a0c0);
      p.set(5, 7, 0xf0c0d8);
      p.set(4, 6, 0xd080a8);
      p.set(6, 6, 0xe8a0c0);
    },
    seagrass: (p, rng) => {
      p.clear();
      for (let i = 0; i < 5; i++) {
        const x0 = 2 + i * 3;
        const h = 7 + ((rng() * 6) | 0);
        for (let k = 0; k < h; k++) {
          const y = 15 - k;
          p.set(x0 + Math.round(Math.sin(k * 0.4 + i) * 0.9), y,
            jitter(k === h - 1 ? 0x6ad0a0 : 0x3f9a6a, rng, 7));
        }
      }
    },
    kelp: (p, rng) => {
      p.clear();
      for (const x0 of [3, 7, 11]) {
        let x = x0;
        for (let y = 15; y >= 0; y--) {
          p.set(x, y, jitter(y % 5 === 0 ? 0x8aa84a : 0x6a8a3a, rng, 7));
          p.set(x + 1, y, jitter(0x5a7a2f, rng, 6));
          if (rng() < 0.24) x += rng() < 0.5 ? -1 : 1;
          if (y % 6 === 3) {
            p.set(x - 1, y, 0x7a9a42);
            p.set(x + 2, y, 0x7a9a42);
          }
        }
      }
    },
    bamboo: (p, rng) => {
      p.clear();
      for (const x0 of [3, 7, 11]) {
        const top = 1 + ((rng() * 4) | 0);
        for (let y = top; y < TILE; y++) {
          const node = y % 5 === 0;
          p.set(x0, y, jitter(node ? 0xb8d878 : 0x7aa84a, rng, 8));
          p.set(x0 + 1, y, jitter(node ? 0x8fb05a : 0x5a8a34, rng, 6));
        }
        const ly = 3 + ((rng() * 5) | 0);
        p.set(x0 - 1, ly, 0x9ac860);
        p.set(x0 - 2, ly + 1, 0x7aa84a);
        p.set(x0 + 2, ly + 2, 0x9ac860);
      }
    },
    glow_lichen: (p, rng) => {
      p.clear();
      for (let i = 0; i < 22; i++) {
        let x = (rng() * TILE) | 0;
        let y = (rng() * TILE) | 0;
        const base = rng() < 0.4 ? 0x9ff0d8 : 0x4fd0b0;
        for (let k = 0; k < 3 + ((rng() * 4) | 0); k++) {
          p.set(x, y, jitter(base, rng, 10));
          x += ((rng() * 3) | 0) - 1;
          y += ((rng() * 3) | 0) - 1;
        }
      }
    },
    moss_carpet: (p, rng) => {
      p.clear();
      for (let i = 0; i < 9; i++) {
        const x0 = (rng() * 14) | 0;
        const w = 2 + ((rng() * 3) | 0);
        const h = 2 + ((rng() * 3) | 0);
        for (let y = 16 - h; y < TILE; y++) {
          for (let x = x0; x < x0 + w; x++) {
            if (rng() < 0.15) continue;
            p.set(x, y, jitter(rng() < 0.4 ? 0x7ab04a : 0x5a8f3a, rng, 8));
          }
        }
      }
    },
    // ---- 小麦与浆果：生长阶段用不同纹理表达 ----
    wheat_seedling: cropPainter(0x6fa03e, 0x93c45e, 4, false),
    wheat_growing: cropPainter(0x7fa84e, 0xb8d878, 8, false),
    wheat: cropPainter(0xc8a840, 0xf0d878, 12, true),
    sweet_berry_bush: bushPainter(0x3f6a2f, 0x4f8a3a, 0x6a9a4a, 0x8aba60),
    sweet_berry_bush_ripe: bushPainter(0x3f6a2f, 0x4f8a3a, 0xd03848, 0xf06a70),
    pumpkin_stem: (p, rng) => {
      p.clear();
      curlStem(p, 7, 3, 15, 0x4a7a2a, rng);
      for (const [x, y] of [[5, 8], [9, 10], [4, 12], [10, 6]]) {
        p.set(x, y, 0x5aa236);
        p.set(x + 1, y, 0x3f7a24);
      }
    },
    // ---- 树苗与树种 ----
    oak_sapling: saplingPainter(0x3f7a24, 0x5aa236),
    birch_sapling: saplingPainter(0x6a8a34, 0x8ab04a, 0xd8d0b8),
    spruce_sapling: saplingPainter(0x2a5a32, 0x3f7a44),
    birch_log_side: logSidePainter(0xd8d0b8, 0x8a8068, 0xf0e8d0, true),
    birch_log_top: logTopPainter(0xd8c9a0, 0xb3a478, 0x8a8068),
    birch_leaves: leavesPainter([0x5a7a2a, 0x6a8a34, 0x7aa040, 0x8ab04a]),
    spruce_log_side: logSidePainter(0x4a3520, 0x2e1f12, 0x6a4a2a),
    spruce_log_top: logTopPainter(0x7a5a34, 0x5a3f24, 0x3a2a18),
    spruce_leaves: leavesPainter([0x1f4a2a, 0x2a5a32, 0x35683a, 0x3f7a44]),
    // ---- 种植物品 ----
    wheat_seeds: (p, rng) => {
      p.clear();
      for (const [x, y] of [[4, 9], [8, 7], [11, 10], [6, 12], [9, 12], [5, 7]]) {
        p.set(x, y, jitter(0xc8a840, rng, 12));
        p.set(x + 1, y, jitter(0xe0c868, rng, 10));
        p.set(x, y + 1, 0xa88830);
      }
    },
    sweet_berries: (p, rng) => {
      p.clear();
      stem(p, 8, 2, 8, 0x4a6a2a);
      p.set(6, 4, 0x5aa236);
      p.set(10, 5, 0x5aa236);
      for (const [x, y] of [[5, 8], [9, 9], [7, 12], [11, 12], [4, 12]]) {
        const c = jitter(0xd03848, rng, 14);
        p.set(x, y, c);
        p.set(x + 1, y, c);
        p.set(x, y + 1, jitter(0xa82838, rng, 10));
        p.set(x + 1, y + 1, jitter(0xa82838, rng, 10));
        p.set(x, y, 0xf06a70);
      }
    },
    // 花蜜：金色蜜滴，用于表现「蓄能开花」的直接收益
    nectar: (p, rng) => {
      p.clear();
      // 蜜滴主体：上窄下宽的水滴形
      for (let y = 4; y <= 15; y++) {
        const half = y < 6 ? 1 : y < 12 ? 3 : 4;
        for (let x = 8 - half; x <= 7 + half; x++) {
          const dx = (x - 7.5) / (half + 0.4);
          const dy = (y - 10.5) / 5.5;
          if (dx * dx + dy * dy > 1) continue;
          const edge = dx * dx + dy * dy > 0.62;
          p.set(x, y, jitter(edge ? 0xd89018 : 0xf6c94a, rng, 9));
        }
      }
      p.set(6, 9, 0xfff3b0);
      p.set(6, 10, 0xffe58a);
      p.set(7, 8, 0xfff8d8);
      // 顶部小高光
      p.set(8, 5, 0xfff8d8);
      p.set(9, 6, 0xffe58a);
    },
    // ---- 群系扩充纹理（追加在末尾，既有 tile 索引不变） ----
    terracotta_red: terracotta(0xb5533c, 0x8a3a28),
    terracotta_orange: terracotta(0xc46a2a, 0x9a4d1c),
    terracotta_yellow: terracotta(0xd8b24a, 0xa8862e),
    terracotta_white: terracotta(0xd8d2c4, 0xb0a898),
    terracotta_blue: terracotta(0x5a6a9e, 0x3f4a78),
    red_sand: (p, rng) => {
      fillNoise(p, rng, 0xc46a42, 9);
      blob(p, rng, 0xa85430, 10, 2);
      blob(p, rng, 0xd88058, 6, 2);
    },
    mud: (p, rng) => {
      fillNoise(p, rng, 0x4a3a2c, 10);
      blob(p, rng, 0x3a2c20, 8, 5);
      blob(p, rng, 0x5a4836, 5, 4);
    },
    dry_grass_top: (p, rng) => {
      // 灰度画：群系色由 shader 调制（tint 方块），干草偏暖黄
      fillNoise(p, rng, gray(0xb0a44e), 10);
      blob(p, rng, gray(0x9c9040), 10, 3);
      blob(p, rng, gray(0xc4b85e), 8, 3);
      for (let i = 0; i < 18; i++) {
        const x = (rng() * TILE) | 0;
        const y = (rng() * TILE) | 0;
        p.set(x, y, jitter(gray(0xd0c470), rng, 8));
      }
    },
    dry_grass_side: (p, rng) => {
      dirt(p, rng);
      for (let x = 0; x < TILE; x++) {
        const depth = 2 + ((rng() * 3) | 0);
        for (let y = 0; y < depth; y++) p.set(x, y, jitter(gray(0xb0a44e), rng, 10));
        if (rng() < 0.4) p.set(x, depth, jitter(gray(0x9c9040), rng, 8));
      }
    },
    acacia_log_side: logSidePainter(0x6e6e6a, 0x4a4a46, 0x8a8a82, true),
    acacia_log_top: logTopPainter(0x9a9a90, 0x7a7a70, 0x5a5a52),
    acacia_leaves: leavesPainter([0x5f7a34, 0x6d8a3c, 0x7a9746, 0x88a552]),
    cherry_log_side: logSidePainter(0x5a3f34, 0x3a271f, 0x7a5a4a, true),
    cherry_log_top: logTopPainter(0x8a6a58, 0x6a4c3e, 0x4a3228),
    cherry_leaves: (p, rng) => {
      p.clear();
      const tones = [0xe8a0b8, 0xf0b4c8, 0xf6c8d8, 0xdd8aa6];
      for (let cy = 0; cy < 4; cy++) {
        for (let cx = 0; cx < 4; cx++) {
          const base = tones[(rng() * tones.length) | 0];
          for (let y = 0; y < 4; y++) {
            for (let x = 0; x < 4; x++) {
              const edge = x === 0 || y === 0 || x === 3 || y === 3;
              if (edge && rng() < 0.2) continue;
              p.set(cx * 4 + x, cy * 4 + y, jitter(base, rng, 7));
            }
          }
        }
      }
      for (let i = 0; i < 5; i++) p.set((rng() * TILE) | 0, (rng() * TILE) | 0, 0, 0);
    },
    // ---- v1.6.0 花海扩充：温带花甸 ----
    lavender: beadSpikePainter(0x9a6ad0, 0xcaa4f0, 0x6a3f9a, 2, false),
    buttercup: bloomPainter({
      petal: 0xf2c92a, light: 0xffe873, dark: 0xc99a18, center: 0xd08a18,
      petals: 5, radiusX: 3.4, radiusY: 3, top: 7,
    }),
    forget_me_not: umbelPainter(0x6a8ae8, 0xa8c4ff, 0xfff0a8),
    marigold: bloomPainter({
      petal: 0xe88a1a, light: 0xf8c05a, dark: 0xb85f10, center: 0x8a4a12,
      petals: 8, radiusX: 4, radiusY: 3.6, top: 5,
    }),
    foxglove: foxglovePainter(0xd06aa8, 0xf0a8d0, 0x8f3f72),
    hollyhock: hollyhockPainter(0xd05a96, 0xf09ac0, 0x9a2f68, 0xffe08a),
    violet: bloomPainter({
      petal: 0x7a4ac8, light: 0xa87ae8, dark: 0x4f2a8a, center: 0xf0e08a,
      petals: 5, radiusX: 3, radiusY: 2.8, top: 7,
    }),
    // ---- 林下阴湿 ----
    wood_anemone: bloomPainter({
      petal: 0xf2f2ea, light: 0xffffff, dark: 0xc8c8bc, center: 0xf0c840,
      petals: 6, radiusX: 3.6, radiusY: 3.2, top: 7,
    }),
    wild_garlic: umbelPainter(0xf2f5e8, 0xffffff, 0xd8e8c0),
    hyacinth: beadSpikePainter(0xd06aa8, 0xf0a8d0, 0x8f3f72, 1, true),
    ivy: ivyPainter(0x35682a, 0x5aa236, 0x244a1c),
    glow_moss: glowMossPainter(0x3f8f6a, 0x6ad0a8, 0x9ff0d8),
    // ---- 针叶林 / 高山 ----
    lingonberry_bush: bushPainter(0x2f5a2a, 0x3f7a34, 0xd03848, 0xf06a70),
    snowdrop: snowdropPainter(0xf2f5e8, 0xffffff, 0x6aa84a),
    edelweiss: bloomPainter({
      petal: 0xe8e8dc, light: 0xf8f8f0, dark: 0xbfbfb0, center: 0xe8c840,
      petals: 8, radiusX: 4.6, radiusY: 4.2, top: 3,
    }),
    snow_lily: bloomPainter({
      petal: 0xe8f0f8, light: 0xffffff, dark: 0xa8c0d8, center: 0xf0e8a0,
      petals: 6, radiusX: 4.4, radiusY: 4.6, top: 2,
    }),
    crocus: crocusPainter(0x8a5ad0, 0xb08ae8, 0x5a3a9a),
    gentian: bloomPainter({
      petal: 0x2a4fc0, light: 0x5a86e8, dark: 0x1a3080, center: 0xc8d8ff,
      petals: 5, radiusX: 4, radiusY: 3.4, top: 5,
    }),
    // ---- 沙漠 / 海岸 ----
    yucca: yuccaPainter(0x5a8a4a, 0x8fbe6a, 0x8a7a4a, 0xf2ead0),
    desert_marigold: bloomPainter({
      petal: 0xe8a020, light: 0xffd260, dark: 0xb06a10, center: 0x8a4a12,
      petals: 9, radiusX: 4.2, radiusY: 3.8, top: 4, leaf: 0x8a9a6a,
    }),
    ghost_flower: glowingBloomPainter({
      petal: 0xd8c8f0, light: 0xf0e8ff, dark: 0xa088c8, center: 0xc8ffe0,
      petals: 6, radiusX: 4, radiusY: 3.6, top: 5,
    }, 0xd6b0ff),
    beach_grass: beachGrassPainter(0x9aae5a, 0xc8d878, 0xe0d8a0),
    sea_thrift: cushionPainter(0xe08ab0, 0xf8bcd4, 0x5a8f3a),
    // ---- 水域 / 洞穴 ----
    duckweed: padPainter(0x5a9a3a, 0x8fc45e, 0xf0e8a0),
    sea_anemone: anemonePainter(0xd06aaa, 0xf0a8d0, 0x8a4a6a),
    red_algae: algaePainter(0xb03a48, 0x7a2534, 0xe06a78),
    moonflower: glowingBloomPainter({
      petal: 0xa8d8f0, light: 0xe8f8ff, dark: 0x6a98c0, center: 0xfff6b0,
      petals: 6, radiusX: 4.2, radiusY: 4, top: 3, leaf: 0x3f7a52, stem: 0x4a6a5a,
    }, 0xfff0a0),
    glow_fern: glowFernPainter(0x356822, 0x7aa84a, 0x8ff0d0),
    // ---- v1.7.0 内容植物扩充 ----
    cotton_bush: bushPainter(0x3f6a2f, 0x4f8a3a, 0xe8e8e0, 0xffffff),
    rice_plant: cropPainter(0x8fae4e, 0xd8c878, 13, true),
    grape_vine: bushPainter(0x35682a, 0x4f8a3a, 0x8a3ac8, 0xb06ae8),
    chili_bush: bushPainter(0x3f6a2f, 0x4f8a3a, 0xd03828, 0xf06a4a),
    lotus: bloomPainter({
      petal: 0xf0a8c0, light: 0xf8d0dc, dark: 0xc87894, center: 0xf0d878,
      petals: 7, radiusX: 4.2, radiusY: 3.6, top: 3, leaf: 0x3f7a52, stem: 0x4a6a5a,
    }),
    orchid: flowerPainter(0xb06ae8, 0xd8a0f8, 0xf0e060, 'cup'),
    sage: flowerPainter(0x6a8ac8, 0xa0b8e8, 0xe8e8f0, 'spike', 0x4a7a3a, 4),
    pitcher_plant: flowerPainter(0x8ac04a, 0xb8e070, 0x8a5a2a, 'bell', 0x4a7a3a, 3),
    glow_cordyceps: glowingBloomPainter({
      petal: 0x8fd0a8, light: 0xc0f0d0, dark: 0x5a9a70, center: 0xd8ffe8,
      petals: 5, radiusX: 3.4, radiusY: 4.4, top: 4, leaf: 0x3f7a52, stem: 0x4a6a5a,
    }, 0x9ff0d8),
    cotton_block: ((p, rng) => {
      fillNoise(p, rng, 0xf0f0e8, 5);
      // 棉絮团块的柔和阴影，让建材面不至于一片白
      for (let i = 0; i < 9; i++) {
        const x = (rng() * 14) | 0;
        const y = (rng() * 14) | 0;
        rect(p, x, y, 3, 3, 0xdcd8cc);
        rect(p, x, y, 2, 2, 0xfafaf4);
      }
    }) as Painter,
    glow_torch: ((p, rng) => {
      fillNoise(p, rng, 0x4a3a2a, 8);
      // 中轴木杆 + 顶部荧光孢子团
      rect(p, 7, 6, 2, 10, 0x6a4a2a);
      for (let y = 1; y <= 5; y++) {
        for (let x = 5; x <= 10; x++) {
          const dx = x - 7.5, dy = y - 3;
          if (dx * dx + dy * dy * 1.4 > 8) continue;
          p.set(x, y, jitter(dx * dx + dy * dy > 3 ? 0x6ad0a8 : 0x9ff0d8, rng, 10));
        }
      }
      p.set(7, 3, 0xd8ffe8);
      p.set(8, 3, 0xd8ffe8);
    }) as Painter,
  };
}

/**
 * 新增的两个方块侧面纹理。
 * 定义在此处、并在构造函数中放到全部既有纹理之后注册，是为了让既有 64 张 tile
 * 的图集索引保持 0..63 完全不变。图集为 16×16=256 格、UV 按 GRID 动态计算，
 * 新增两张不会触发扩容，也不影响任何既有纹理的渲染。
 */

/** 南瓜侧面：橙色底 + 纵向棱纹 + 顶部短梗，呼应 pumpkin_face / pumpkin_top */
const pumpkinSidePainter: Painter = (p, rng) => {
  fillNoise(p, rng, 0xd97318, 10);
  // 暗色沟槽 + 相邻浅色高光，形成一条条纵向棱纹
  for (const x of [2, 6, 10, 14]) {
    for (let y = 0; y < TILE; y++) {
      p.set(x, y, jitter(0xb85c10, rng, 5));
      if (x + 1 < TILE && rng() < 0.75) p.set(x + 1, y, jitter(0xeb8b28, rng, 6));
    }
  }
  // 与 pumpkin_top 同色的顶部短梗
  rect(p, 7, 0, 2, 2, 0x3f7a24);
  p.set(7, 0, 0x2f5c1b);
  p.set(8, 0, 0x2f5c1b);
  p.set(7, 1, 0x4f8f2c);
};

/** 书架侧面：木质边框（横梁 + 立柱）+ 两排彩色书脊 */
const bookshelfSidePainter: Painter = (p, rng) => {
  fillNoise(p, rng, 0x6b4f2e, 6);
  rect(p, 2, 2, 12, 12, 0x3a2a18); // 书架内格阴影
  const spines = [0x9c3b2e, 0x2f4f8a, 0x3f7a34, 0xb08028, 0x6a3f9e, 0xb0552a, 0x2f7a78, 0x8a2f44];
  for (const [yBase, yTop] of [[13, 9], [6, 2]] as const) {
    let x = 2;
    while (x < 14) {
      const w = 2 + ((rng() * 2) | 0);
      const c = spines[(rng() * spines.length) | 0];
      const top = yTop + ((rng() * 2) | 0); // 书高参差
      for (let yy = top; yy <= yBase; yy++)
        for (let xx = x; xx < x + w && xx < 14; xx++) p.set(xx, yy, jitter(c, rng, 8));
      for (let yy = top; yy <= yBase; yy++) p.set(x, yy, 0x241809); // 书脊左缘暗线
      for (let xx = x; xx < x + w && xx < 14; xx++) p.set(xx, top, jitter(c, rng, 18)); // 书页/标题带
      x += w;
    }
  }
  const frame = 0x5f4a2a;
  rect(p, 0, 0, TILE, 2, frame);
  rect(p, 0, 7, TILE, 2, frame);
  rect(p, 0, 14, TILE, 2, frame);
  rect(p, 0, 0, 2, TILE, frame);
  rect(p, 14, 0, 2, TILE, frame);
  for (const y of [0, 7, 14])
    for (let x = 2; x < 14; x++) if (rng() < 0.8) p.set(x, y, jitter(0x8a6a3e, rng, 5));
};

/** 木棍：合成产物，扁平精灵（透明底）。斜置木棒，棕色主体 + 左侧高光 + 两端切口 */
const stickPainter: Painter = (p, rng) => {
  p.clear();
  for (let i = 0; i < 11; i++) {
    const x = 3 + i;
    const y = 12 - i;
    p.set(x, y, jitter(0x9a6b3a, rng, 8));
    p.set(x, y - 1, jitter(0xb5824a, rng, 6));
    p.set(x + 1, y, jitter(0x7a5228, rng, 6));
  }
  p.set(3, 12, 0x6b4520);
  p.set(3, 11, 0xc79a5e);
  p.set(13, 3, 0x6b4520);
  p.set(14, 2, 0xc79a5e);
};

/** 有机肥：棕色土块 + 绿色亮点， signifies 可施肥 */
const fertilizerPainter: Painter = (p, rng) => {
  p.clear();
  for (let y = 5; y < 13; y++) {
    for (let x = 4; x < 12; x++) {
      if ((x === 4 || x === 11) && (y === 5 || y === 12)) continue;
      p.set(x, y, jitter(0x6b4a2a, rng, 10));
    }
  }
  for (const [x, y] of [[6, 7], [9, 8], [7, 10], [10, 6]] as const) {
    p.set(x, y, 0x5fbf52);
    p.set(x + 1, y, 0x82d862);
  }
};

/** 骨粉：白色骨粒，冷色调区分于有机肥 */
const boneMealPainter: Painter = (p, rng) => {
  p.clear();
  p.set(8, 3, 0xf2f2e8); p.set(7, 4, 0xd8d8cc); p.set(9, 4, 0xd8d8cc);
  p.set(6, 6, 0xeaeae0); p.set(8, 6, 0xffffff); p.set(10, 6, 0xeaeae0);
  p.set(7, 8, 0xd8d8cc); p.set(9, 8, 0xf2f2e8);
  for (let i = 0; i < 4; i++) p.set(5 + ((rng() * 6) | 0), 10 + ((rng() * 3) | 0), 0xcfcfc4);
};

/** 煤炭：深色矿块 + 冷灰高光 */
const coalPainter: Painter = (p, rng) => {
  p.clear();
  for (let y = 3; y < 13; y++) {
    for (let x = 3; x < 13; x++) {
      if ((x === 3 || x === 12) && (y === 3 || y === 12)) continue;
      p.set(x, y, jitter(0x24262c, rng, 12));
    }
  }
  for (const [x, y] of [[5, 5], [9, 6], [6, 9], [10, 10]] as const) {
    p.set(x, y, 0x4d5058);
    p.set(x + 1, y, 0x363941);
  }
};

/** 皮革：棕色兽皮 + 深色包边 */
const leatherPainter: Painter = (p, rng) => {
  p.clear();
  for (let y = 2; y < 14; y++) {
    for (let x = 2; x < 14; x++) {
      const edge = x === 2 || x === 13 || y === 2 || y === 13;
      p.set(x, y, jitter(edge ? 0x5d3c21 : 0x9b6839, rng, 9));
    }
  }
  for (let x = 4; x <= 11; x += 3) {
    p.set(x, 5, 0xbd8a56);
    p.set(x + 1, 10, 0x754c2c);
  }
};

/** 生牛肉：红色肉块 + 白色脂肪纹 */
const beefPainter: Painter = (p, rng) => {
  p.clear();
  for (let y = 3; y < 13; y++) {
    for (let x = 3; x < 13; x++) {
      const edge = x === 3 || x === 12 || y === 3 || y === 12;
      p.set(x, y, jitter(edge ? 0x8e2d33 : 0xc34a4d, rng, 10));
    }
  }
  for (const [x, y] of [[5, 5], [6, 5], [7, 6], [9, 8], [10, 9]] as const) {
    p.set(x, y, 0xf0d8cc);
  }
};

/** 羽毛：透明底 + 浅灰羽片与羽轴 */
const featherPainter: Painter = (p, rng) => {
  p.clear();
  for (let y = 2; y < 14; y++) {
    const cx = 8 + Math.round(Math.sin(y * 0.45) * 1.5);
    p.set(cx, y, 0xbfc4c9);
    const w = y < 4 || y > 11 ? 1 : y < 8 ? 2 : 3;
    for (let d = 1; d <= w; d++) {
      p.set(cx - d, y - (d >> 1), jitter(0xe0e5e7, rng, 8));
      p.set(cx + d, y - (d >> 1), jitter(0xe0e5e7, rng, 8));
    }
  }
  p.set(8, 14, 0x9aa0a6);
};

/** 鸡蛋：米白椭圆 + 高光与底部阴影 */
const eggPainter: Painter = (p, rng) => {
  p.clear();
  for (let y = 2; y < 14; y++) {
    for (let x = 4; x < 12; x++) {
      const nx = (x - 8) / 4;
      const ny = (y - 8) / 6;
      if (nx * nx + ny * ny <= 1) p.set(x, y, jitter(0xf2e9d5, rng, 5));
    }
  }
  p.set(6, 5, 0xffffff);
  p.set(7, 4, 0xffffff);
  p.set(9, 11, 0xd8c7aa);
  p.set(10, 10, 0xd8c7aa);
};

/** 兔肉：粉色肉块 + 浅色脂肪纹 */
const rabbitMeatPainter: Painter = (p, rng) => {
  p.clear();
  for (let y = 4; y < 13; y++) {
    for (let x = 3; x < 13; x++) {
      const edge = x === 3 || x === 12 || y === 4 || y === 12;
      p.set(x, y, jitter(edge ? 0xb66771 : 0xe08f92, rng, 9));
    }
  }
  for (const [x, y] of [[5, 6], [6, 6], [8, 8], [9, 9], [10, 7]] as const) {
    p.set(x, y, 0xf6dbd6);
  }
};

/** 堆肥桶侧面：木条 + 横向铁皮箍 */
const composterSidePainter: Painter = (p, rng) => {
  p.clear();
  for (let x = 0; x < 16; x++) {
    for (let y = 0; y < 16; y++) p.set(x, y, jitter(0x8a5f33, rng, 12));
  }
  for (const y of [3, 12]) for (let x = 0; x < 16; x++) p.set(x, y, 0x5b5b62);
  for (let x = 2; x <= 13; x += 4) for (let y = 5; y <= 10; y++) p.set(x, y, 0x6b4526);
};

/** 堆肥桶顶面：木框 + 中间深色土 / 成熟度决定土色 */
function composterTopPainter(ready: boolean): Painter {
  return (p, rng) => {
    p.clear();
    for (let x = 0; x < 16; x++) for (let y = 0; y < 16; y++) p.set(x, y, 0x6b4526);
    for (let x = 2; x < 14; x++) for (let y = 2; y < 14; y++) {
      p.set(x, y, ready ? jitter(0x5fbf52, rng, 12) : jitter(0x4a3420, rng, 14));
    }
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
  /** 设备支持的最大各向异性等级，由 main 注入 renderer.capabilities 后生效 */
  private maxAnisotropy = 1;
  /** 当前请求的等级（1 = 关闭折中档，>1 = 开启 R6 折中档） */
  private anisotropyLevel = 1;

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
    // 新增：放在全部既有纹理之后注册，既有 64 张 tile 的索引保持不变
    this.painters.set('pumpkin_side', pumpkinSidePainter);
    this.painters.set('bookshelf_side', bookshelfSidePainter);
    this.painters.set('stick', stickPainter);
    // v1.6：肥料 / 骨粉物品纹理，追加在末尾以保持既有 tile 索引不变
    this.painters.set('fertilizer', fertilizerPainter);
    this.painters.set('bone_meal', boneMealPainter);
    this.painters.set('composter_side', composterSidePainter);
    this.painters.set('composter_top', composterTopPainter(false));
    this.painters.set('composter_ready_top', composterTopPainter(true));
    this.painters.set('composter_bottom', composterSidePainter);
    // v1.7：内容植物产出物品纹理，追加在末尾以保持既有 tile 索引不变
    this.painters.set('cotton', (p, rng) => {
      p.clear();
      // 三团棉絮 + 两粒深色棉籽
      for (const [cx, cy, r] of [[6, 9, 2.2], [10, 8, 2.4], [8, 12, 2.0]] as const) {
        for (let y = 0; y < 16; y++) {
          for (let x = 0; x < 16; x++) {
            const dx = x - cx, dy = y - cy;
            if (dx * dx + dy * dy > r * r) continue;
            p.set(x, y, jitter(dx * dx + dy * dy > 1 ? 0xf0f0e8 : 0xffffff, rng, 4));
          }
        }
      }
      p.set(7, 9, 0x8a6a3a);
      p.set(10, 11, 0x8a6a3a);
    });
    this.painters.set('rice', (p, rng) => {
      p.clear();
      // 一小把稻米粒：米白色椭圆粒叠放
      for (const [x, y] of [[6, 7], [9, 6], [7, 10], [10, 9], [5, 11], [8, 12], [11, 11]]) {
        p.set(x, y, jitter(0xf4f0e0, rng, 4));
        p.set(x + 1, y, jitter(0xe0d8c0, rng, 4));
      }
      p.set(7, 8, 0xc0b898);
      p.set(10, 10, 0xc0b898);
    });
    this.painters.set('grapes', (p, rng) => {
      p.clear();
      // 紫葡萄串：上宽下窄的三角簇 + 顶部短梗与叶
      stem(p, 8, 1, 3, 0x4a6a2a);
      p.set(10, 2, 0x5aa236);
      for (const [x, y] of [[6, 5], [9, 5], [5, 8], [8, 8], [11, 8], [6, 11], [9, 11], [8, 13]]) {
        const c = jitter(0x8a3ac8, rng, 12);
        p.set(x, y, c); p.set(x + 1, y, c);
        p.set(x, y + 1, jitter(0x6a2a9a, rng, 10));
      }
      p.set(6, 5, 0xb06ae8); p.set(9, 5, 0xb06ae8);
    });
    this.painters.set('chili', (p, rng) => {
      p.clear();
      // 一枚弯月形红辣椒 + 绿蒂
      for (let y = 4; y <= 13; y++) {
        const x0 = y < 8 ? 8 : 7 - ((y - 8) >> 1);
        p.set(x0, y, jitter(0xd03828, rng, 10));
        p.set(x0 + 1, y, jitter(0xf06a4a, rng, 10));
        p.set(x0 + 2, y, jitter(0xa82818, rng, 8));
      }
      p.set(9, 4, 0x4a7a2a);
      p.set(10, 3, 0x5a8a3a);
      p.set(8, 13, 0xf8a080);
    });
    this.painters.set('glow_spore', (p, rng) => {
      p.clear();
      // 发光孢子团：青绿光斑 + 中心亮点，呼应荧光植物配色
      for (let y = 3; y <= 13; y++) {
        for (let x = 3; x <= 12; x++) {
          const dx = x - 7.5, dy = y - 8;
          if (dx * dx + dy * dy > 14) continue;
          const d = dx * dx + dy * dy;
          p.set(x, y, jitter(d > 7 ? 0x3f8f6a : d > 2.5 ? 0x6ad0a8 : 0x9ff0d8, rng, 10));
        }
      }
      p.set(7, 8, 0xd8ffe8);
      p.set(8, 8, 0xd8ffe8);
    });
    // C01：新物品纹理，全部追加在既有 painter 之后，既有 tile 索引保持不变
    this.painters.set('coal', coalPainter);
    this.painters.set('leather', leatherPainter);
    this.painters.set('beef', beefPainter);
    this.painters.set('feather', featherPainter);
    this.painters.set('egg', eggPainter);
    this.painters.set('rabbit_meat', rabbitMeatPainter);
    // ---- 矿物→材料→熔炼闭环物品纹理：追加在末尾，既有 tile 索引不变 ----
    // 原矿：不规则的粗矿团块
    const rawOrePainter = (base: number, dark: number, light: number) =>
      (p: { clear(): void; set(x: number, y: number, c: number): void }, rng: () => number) => {
        p.clear();
        for (let y = 4; y < 13; y++) {
          for (let x = 3; x < 13; x++) {
            const dx = x - 8, dy = y - 8;
            if (dx * dx + dy * dy * 1.6 > 22) continue;
            p.set(x, y, jitter(base, rng, 14));
          }
        }
        for (const [x, y] of [[5, 6], [9, 5], [7, 9], [10, 10]] as const) {
          p.set(x, y, light);
          p.set(x, y + 1, dark);
        }
      };
    this.painters.set('raw_iron', rawOrePainter(0xc79c7c, 0x8a6a52, 0xe8cdb8));
    this.painters.set('raw_gold', rawOrePainter(0xd9b53c, 0x93722a, 0xf5e37a));
    this.painters.set('raw_copper', rawOrePainter(0xa85b3d, 0x6e3a26, 0xd88a64));
    // 锭：平行四边形金属条
    const ingotPainter = (base: number, dark: number, light: number) =>
      (p: { clear(): void; set(x: number, y: number, c: number): void }, rng: () => number) => {
        p.clear();
        for (let y = 6; y < 11; y++) {
          const in0 = y - 6, off = 2 - in0;
          for (let x = 3 + off; x < 13 + off; x++) {
            p.set(x, y, jitter(x === 3 + off || y === 10 ? dark : base, rng, 8));
          }
        }
        for (let x = 5; x < 11; x++) p.set(x, 7, light);
        p.set(3, 10, dark); p.set(4, 10, dark);
      };
    this.painters.set('iron_ingot', ingotPainter(0xd8bfa8, 0x9c8472, 0xf2e2d4));
    this.painters.set('gold_ingot', ingotPainter(0xe8c23c, 0xa8871e, 0xf8e88a));
    this.painters.set('copper_ingot', ingotPainter(0xc46a45, 0x8a4426, 0xe8a37e));
    // 钻石：青色菱形宝石
    this.painters.set('diamond', (p, rng) => {
      p.clear();
      for (let y = 3; y < 13; y++) {
        const w = y < 8 ? y - 3 : 12 - y;
        for (let x = 8 - w; x <= 8 + w; x++) {
          p.set(x, y, jitter(x <= 8 - w + 1 || y > 10 ? 0x2fb8a8 : 0x4aedd9, rng, 10));
        }
      }
      p.set(7, 5, 0xbdf8f0); p.set(8, 5, 0xbdf8f0);
    });
    // 青金石：深蓝石块 + 亮蓝斑点
    this.painters.set('lapis', (p, rng) => {
      p.clear();
      for (let y = 3; y < 13; y++) {
        for (let x = 3; x < 13; x++) {
          if ((x === 3 || x === 12) && (y === 3 || y === 12)) continue;
          p.set(x, y, jitter(0x1e4bd8, rng, 16));
        }
      }
      for (const [x, y] of [[5, 5], [9, 6], [6, 9], [10, 10], [8, 4]] as const) {
        p.set(x, y, 0x6a9af0);
      }
    });
    // 红石粉：散落的红色粉末堆
    this.painters.set('redstone', (p, rng) => {
      p.clear();
      for (let i = 0; i < 40; i++) {
        const x = 3 + ((rng() * 10) | 0);
        const y = 6 + ((rng() * 7) | 0);
        p.set(x, y, jitter(0xd41c1c, rng, 18));
      }
      for (let x = 5; x < 11; x++) p.set(x, 11, 0x8e1010);
    });
    // 绿宝石：绿色长六边形宝石
    this.painters.set('emerald', (p, rng) => {
      p.clear();
      for (let y = 3; y < 13; y++) {
        const w = y < 5 || y > 10 ? 2 : 4;
        for (let x = 8 - w; x <= 8 + w; x++) {
          p.set(x, y, jitter(x <= 8 - w + 1 ? 0x0fa84a : 0x17dd62, rng, 10));
        }
      }
      p.set(7, 4, 0xa8f8c8); p.set(7, 5, 0xa8f8c8);
    });
    // 木炭：与煤炭同形但带木纹焦痕
    this.painters.set('charcoal', (p, rng) => {
      p.clear();
      for (let y = 3; y < 13; y++) {
        for (let x = 3; x < 13; x++) {
          if ((x === 3 || x === 12) && (y === 3 || y === 12)) continue;
          p.set(x, y, jitter(0x1c1a16, rng, 10));
        }
      }
      for (const [x, y] of [[5, 6], [9, 8], [6, 10]] as const) {
        p.set(x, y, 0x4a3c2c);
        p.set(x + 1, y, 0x6a563c);
      }
    });
    // 熟肉：棕色肉块 + 深色烤纹
    const cookedMeatPainter = (p: { clear(): void; set(x: number, y: number, c: number): void }, rng: () => number) => {
      p.clear();
      for (let y = 3; y < 13; y++) {
        for (let x = 3; x < 13; x++) {
          const edge = x === 3 || x === 12 || y === 3 || y === 12;
          p.set(x, y, jitter(edge ? 0x5c3818 : 0x9c6430, rng, 10));
        }
      }
      for (const [x, y] of [[5, 5], [6, 5], [9, 8], [10, 9], [7, 10]] as const) {
        p.set(x, y, 0x6a4420);
      }
    };
    this.painters.set('cooked_porkchop', cookedMeatPainter);
    this.painters.set('cooked_beef', cookedMeatPainter);
    // v1.7：重点株特化产物纹理，追加在末尾以保持既有 tile 索引不变
    this.painters.set('garlic', (p, rng) => {
      p.clear();
      // 一整头蒜：球形蒜瓣 + 顶部短茎
      for (let y = 5; y <= 13; y++) {
        for (let x = 4; x <= 11; x++) {
          const dx = x - 7.5, dy = y - 9.5;
          if (dx * dx + dy * dy * 1.3 > 12) continue;
          p.set(x, y, jitter(dx * dx + dy * dy > 6 ? 0xe8e0c8 : 0xfaf6e8, rng, 5));
        }
      }
      for (const [x, y] of [[6, 3], [7, 2], [8, 3], [7, 4]]) p.set(x, y, jitter(0xb8c48a, rng, 8));
      // 蒜瓣分界线
      p.set(7, 8, 0xd8cfb4); p.set(8, 9, 0xd8cfb4); p.set(7, 11, 0xd8cfb4);
    });
    this.painters.set('rose_hips', (p, rng) => {
      p.clear();
      // 三枚橙红色玫瑰果，各带残留花萼
      for (const [cx, cy, r] of [[5, 9, 1.8], [10, 7, 2.0], [8, 12, 1.6]] as const) {
        for (let y = 0; y < 16; y++) {
          for (let x = 0; x < 16; x++) {
            const dx = x - cx, dy = y - cy;
            if (dx * dx + dy * dy > r * r) continue;
            p.set(x, y, jitter(dx * dx + dy * dy > 1 ? 0xd06828 : 0xf08838, rng, 10));
          }
        }
        p.set(cx, cy - r - 1, 0x4a7a2a);
      }
    });
    this.painters.set('garlic_rice', (p, rng) => {
      p.clear();
      // 碗装蒜香米饭：白米饭堆 + 金色蒜粒点缀
      for (let y = 6; y <= 13; y++) {
        for (let x = 3; x <= 12; x++) {
          const dy = y - 10;
          if ((x - 7.5) * (x - 7.5) / 36 + dy * dy / 16 > 1) continue;
          p.set(x, y, jitter(0xf4f0e0, rng, 5));
        }
      }
      for (const [x, y] of [[5, 9], [8, 8], [10, 10], [6, 11], [9, 12]]) {
        p.set(x, y, jitter(0xd8b860, rng, 12));
      }
    });
    this.painters.set('rose_tea', (p, rng) => {
      p.clear();
      // 茶杯：杯体 + 玫瑰红色茶水与杯柄
      for (let y = 6; y <= 13; y++) {
        for (let x = 4; x <= 10; x++) {
          p.set(x, y, jitter(y > 6 ? 0xe8e8f0 : 0xd0d0dc, rng, 4));
        }
      }
      for (let x = 5; x <= 9; x++) p.set(x, 7, jitter(0xc04858, rng, 10));
      p.set(11, 8, 0xe8e8f0); p.set(11, 9, 0xe8e8f0); p.set(10, 9, 0xd0d0dc);
      // 杯口飘出的热气与一朵小花瓣
      p.set(7, 3, 0xf0d8dc);
      p.set(6, 2, 0xc04858);
      p.set(8, 4, 0xf0f0f8);
    });
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

  /** tile 索引（测试用于核对既有索引与裂纹末位追加契约；不存在返回 -1） */
  tileIndex(name: string): number {
    return this.indices.get(name) ?? -1;
  }

  /** 注入设备能力上限（main 初始化时调用一次），避免图集层依赖 renderer。 */
  setMaxAnisotropy(max: number): void {
    const safe = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : 1;
    if (this.maxAnisotropy === safe) return;
    this.maxAnisotropy = safe;
    this.applyAnisotropy();
  }

  /**
   * R6 折中档开关：level<=1 回到像素风原状（Nearest / 无 mipmap）；
   * level>1 时 magFilter 仍为 Nearest（放大锐利不变），仅缩小路径切到
   * NearestMipmapNearestFilter + generateMipmaps，让各向异性在远景生效。
   * 实际上限 = min(8, 设备上限)，不因请求 16 而超设备能力。
   */
  setAnisotropy(level: number): void {
    const requested = Number.isFinite(level) ? Math.floor(level) : 1;
    const target = Math.max(1, Math.min(8, this.maxAnisotropy, requested));
    if (this.anisotropyLevel === target) return;
    this.anisotropyLevel = target;
    this.applyAnisotropy();
  }

  private applyAnisotropy(): void {
    const enabled = this.anisotropyLevel > 1;
    this.texture.anisotropy = this.anisotropyLevel;
    this.texture.minFilter = enabled ? THREE.NearestMipmapNearestFilter : THREE.NearestFilter;
    this.texture.generateMipmaps = enabled;
    this.texture.needsUpdate = true;
  }

  /** 当前各向异性等级（E13 读数） */
  get anisotropyValue(): number {
    return this.texture.anisotropy;
  }

  /** 当前是否处于 R6 折中档（E13 读数） */
  get mipmapEnabled(): boolean {
    return this.texture.generateMipmaps;
  }

  /** 带半像素内缩的 UV，防止图集渗色 */
  uv(name: string): [number, number, number, number] {
    const idx = this.indices.get(name) ?? 0;
    const u0 = (idx % GRID) / GRID + TILE_INSET;
    const v0 = 1 - (((idx / GRID) | 0) + 1) / GRID + TILE_INSET;
    return [u0, v0, u0 + TILE_UV_SIZE[0], v0 + TILE_UV_SIZE[1]];
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
      // 与放置后的十字面几何保持一致：手持矮花不会突然变成整格高
      const ch = Math.max(0.1, Math.min(1, def.crossHeight ?? 1));
      const quads = [
        [[0.15, 0, 0.15], [0.85, 0, 0.85], [0.85, ch, 0.85], [0.15, ch, 0.15]],
        [[0.85, 0, 0.15], [0.15, 0, 0.85], [0.15, ch, 0.85], [0.85, ch, 0.15]],
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