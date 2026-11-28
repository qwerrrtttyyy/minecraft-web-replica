/**
 * 噪声数学的唯一 JS 参考实现（v1.5.0 从 noise.ts 抽出）。
 *
 * 为什么必须独立成纯函数：
 *  - WASM 内核（native/mc_kernel.c）必须与 JS 逐位等价，运行时据此做等价性对拍；
 *  - 等价性失败或运行期异常时，WASM 后端要能立刻退回同一份 JS 实现；
 *  - 测试可以直接 require 它，不需要构造 Noise 实例 / 不需要浏览器。
 *
 * 运算顺序与 v1.4.3 的 Noise 类逐字一致，禁止「顺手优化」表达式：
 * 任何重排都可能造成 1 ULP 差异，进而改变固定 seed 的地形并击穿全部回归。
 */
import { mulberry32 } from '../core/types';

export interface NoiseFunctions {
  noise2(x: number, y: number): number;
  noise3(x: number, y: number, z: number): number;
  fbm2(x: number, y: number, octaves: number, lacunarity: number, gain: number): number;
  fbm3(x: number, y: number, z: number, octaves: number, lacunarity: number, gain: number): number;
  ridged2(x: number, y: number, octaves: number, lacunarity: number, gain: number): number;
}

/**
 * 可插拔计算后端契约：WASM 后端实现同一组方法，签名中不含可选参数。
 * dispose 可选：一次性 / 临时后端（如 benchmark）用它主动断开 WASM 实例引用，
 * 常驻后端（Noise 实例持有）无需调用，随宿主一起回收。
 */
export type NoiseBackend = NoiseFunctions & { dispose?(): void };

/** 由 seed 生成 512 字节置换表；WASM 自检与 Noise 类共用，避免两份实现漂移 */
export function makePermutation(seed: number): Uint8Array {
  const rng = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const out = new Uint8Array(512);
  for (let i = 0; i < 512; i++) out[i] = p[i & 255];
  return out;
}

export function makeNoiseFunctions(perm: Uint8Array): NoiseFunctions {
  const hash2 = (x: number, y: number): number => perm[(perm[x & 255] + y) & 255] / 255;
  const hash3 = (x: number, y: number, z: number): number => perm[(perm[(perm[x & 255] + y) & 255] + z) & 255] / 255;
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

  const noise2 = (x: number, y: number): number => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = hash2(xi, yi);
    const b = hash2(xi + 1, yi);
    const c = hash2(xi, yi + 1);
    const d = hash2(xi + 1, yi + 1);
    const val = a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    return val * 2 - 1;
  };

  const noise3 = (x: number, y: number, z: number): number => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const xf = x - xi;
    const yf = y - yi;
    const zf = z - zi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const w = zf * zf * (3 - 2 * zf);
    const c00 = lerp(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), u);
    const c10 = lerp(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), u);
    const c01 = lerp(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), u);
    const c11 = lerp(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), u);
    return lerp(lerp(c00, c10, v), lerp(c01, c11, v), w) * 2 - 1;
  };

  const fbm2 = (x: number, y: number, octaves: number, lacunarity: number, gain: number): number => {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += noise2(x * freq, y * freq) * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  };

  const ridged2 = (x: number, y: number, octaves: number, lacunarity: number, gain: number): number => {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      const r = 1 - Math.abs(noise2(x * freq, y * freq));
      sum += r * r * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  };

  const fbm3 = (x: number, y: number, z: number, octaves: number, lacunarity: number, gain: number): number => {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += noise3(x * freq, y * freq, z * freq) * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  };

  return { noise2, noise3, fbm2, fbm3, ridged2 };
}

/** 等价性自检的固定采样点：覆盖小数 / 负数 / 大坐标 / 零点，坐标域保持在 i32 之内 */
export const EQUIVALENCE_SAMPLES: readonly (readonly [number, number, number])[] = (() => {
  const out: [number, number, number][] = [];
  for (let i = 0; i < 64; i++) {
    const x = (i * 0.137 - 27.31) * (i % 3 === 0 ? -1 : 1) + i * 0.0011;
    const y = (i * 0.271 + 9.77) * (i % 5 === 0 ? -1 : 1);
    const z = (i * 0.053 - 4.19) * (i % 7 === 0 ? -1 : 1);
    out.push([x, y, z]);
  }
  out.push([0, 0, 0], [-0.5, -0.5, -0.5], [-12345.678, 98765.432, -555.25], [1e6 + 0.5, -1e6 - 0.5, 0.25]);
  return out;
})();
