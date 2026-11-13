"use strict";
/** 全局共享类型与常量 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.blockKey = exports.chunkKey = exports.smoothstep = exports.lerp = exports.clamp = exports.SEA_LEVEL = exports.WORLD_HEIGHT = exports.CHUNK_SIZE = void 0;
exports.mulberry32 = mulberry32;
/** 体素世界尺寸常量 */
exports.CHUNK_SIZE = 16;
exports.WORLD_HEIGHT = 80;
exports.SEA_LEVEL = 30;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
exports.clamp = clamp;
const lerp = (a, b, t) => a + (b - a) * t;
exports.lerp = lerp;
const smoothstep = (a, b, x) => {
    const t = (0, exports.clamp)((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
};
exports.smoothstep = smoothstep;
/** 确定性伪随机（mulberry32），用于纹理与地形 */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const chunkKey = (cx, cz) => `${cx},${cz}`;
exports.chunkKey = chunkKey;
const blockKey = (x, y, z) => `${x},${y},${z}`;
exports.blockKey = blockKey;
