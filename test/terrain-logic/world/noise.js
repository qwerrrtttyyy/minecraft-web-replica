"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Noise = void 0;
const types_1 = require("../core/types");
/**
 * 可播种的 2D / 3D 值噪声 + 分形叠加（fBm）。
 * 无第三方依赖，地形、洞穴、云、纹理共用。
 */
class Noise {
    constructor(seed) {
        const rng = (0, types_1.mulberry32)(seed);
        const p = new Uint8Array(256);
        for (let i = 0; i < 256; i++)
            p[i] = i;
        for (let i = 255; i > 0; i--) {
            const j = (rng() * (i + 1)) | 0;
            const t = p[i];
            p[i] = p[j];
            p[j] = t;
        }
        this.perm = new Uint8Array(512);
        for (let i = 0; i < 512; i++)
            this.perm[i] = p[i & 255];
    }
    hash2(x, y) {
        return this.perm[(this.perm[x & 255] + y) & 255] / 255;
    }
    hash3(x, y, z) {
        return this.perm[(this.perm[(this.perm[x & 255] + y) & 255] + z) & 255] / 255;
    }
    /** 2D 值噪声，返回 [-1, 1] */
    noise2(x, y) {
        const xi = Math.floor(x);
        const yi = Math.floor(y);
        const xf = x - xi;
        const yf = y - yi;
        const u = xf * xf * (3 - 2 * xf);
        const v = yf * yf * (3 - 2 * yf);
        const a = this.hash2(xi, yi);
        const b = this.hash2(xi + 1, yi);
        const c = this.hash2(xi, yi + 1);
        const d = this.hash2(xi + 1, yi + 1);
        const val = a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
        return val * 2 - 1;
    }
    /** 3D 值噪声，返回 [-1, 1] */
    noise3(x, y, z) {
        const xi = Math.floor(x);
        const yi = Math.floor(y);
        const zi = Math.floor(z);
        const xf = x - xi;
        const yf = y - yi;
        const zf = z - zi;
        const u = xf * xf * (3 - 2 * xf);
        const v = yf * yf * (3 - 2 * yf);
        const w = zf * zf * (3 - 2 * zf);
        const lerp = (a, b, t) => a + (b - a) * t;
        const c00 = lerp(this.hash3(xi, yi, zi), this.hash3(xi + 1, yi, zi), u);
        const c10 = lerp(this.hash3(xi, yi + 1, zi), this.hash3(xi + 1, yi + 1, zi), u);
        const c01 = lerp(this.hash3(xi, yi, zi + 1), this.hash3(xi + 1, yi, zi + 1), u);
        const c11 = lerp(this.hash3(xi, yi + 1, zi + 1), this.hash3(xi + 1, yi + 1, zi + 1), u);
        return lerp(lerp(c00, c10, v), lerp(c01, c11, v), w) * 2 - 1;
    }
    /** 分形叠加 */
    fbm2(x, y, octaves, lacunarity = 2, gain = 0.5) {
        let sum = 0;
        let amp = 1;
        let freq = 1;
        let norm = 0;
        for (let i = 0; i < octaves; i++) {
            sum += this.noise2(x * freq, y * freq) * amp;
            norm += amp;
            amp *= gain;
            freq *= lacunarity;
        }
        return sum / norm;
    }
    /**
     * 脊线噪声：把 1-|n| 平方后叠加，输出 0~1。
     * 高值形成连续的山脊 / 河道轮廓，比普通 fBm 更像真实地貌。
     */
    ridged2(x, y, octaves, lacunarity = 2, gain = 0.5) {
        let sum = 0;
        let amp = 1;
        let freq = 1;
        let norm = 0;
        for (let i = 0; i < octaves; i++) {
            const r = 1 - Math.abs(this.noise2(x * freq, y * freq));
            sum += r * r * amp;
            norm += amp;
            amp *= gain;
            freq *= lacunarity;
        }
        return sum / norm;
    }
    /** 3D 分形叠加（洞穴 / 矿脉等体积特征） */
    fbm3(x, y, z, octaves, lacunarity = 2, gain = 0.5) {
        let sum = 0;
        let amp = 1;
        let freq = 1;
        let norm = 0;
        for (let i = 0; i < octaves; i++) {
            sum += this.noise3(x * freq, y * freq, z * freq) * amp;
            norm += amp;
            amp *= gain;
            freq *= lacunarity;
        }
        return sum / norm;
    }
}
exports.Noise = Noise;
