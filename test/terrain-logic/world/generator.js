"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DefaultGenerator = exports.DEFAULT_TERRAIN = void 0;
const types_1 = require("../core/types");
const noise_1 = require("./noise");
exports.DEFAULT_TERRAIN = {
    warp: 26,
    baseHeight: 32,
    continentAmp: 19,
    hillAmp: 8,
    mountainLift: 16,
    mountainRidgeAmp: 27,
    riverDepth: 7,
    spawnUplift: 3,
    spawnRadius: 82,
    treeDensity: { plains: 0.08, forest: 0.42, taiga: 0.34 },
    oreRichness: 1,
};
const CACHE_LIMIT = 8192;
const CS = types_1.CHUNK_SIZE;
const H = types_1.WORLD_HEIGHT;
/** 树冠半径 2，额外留 2 格扫描邻区块的树 */
const PAD = 4;
const GRID = CS + PAD * 2;
const TREE_CELL = 6;
/**
 * 默认地形：大陆/海洋 + 域扭曲丘陵 + 脊线山脉 + 河道 + 温度湿度群系
 * + 渐隐洞穴 + 分层矿脉 + 跨区块树木 + 坡度露石/雪线。
 *
 * 设计要点：
 * - 所有特征都由世界坐标 + seed 决定，区块生成顺序不影响结果；
 * - 树木按「世界坐标候选点」扫描邻域后裁剪写入本区块，树冠可跨区块连续；
 * - 高度与群系带缓存，整区块只算一次 24×24 列信息。
 */
class DefaultGenerator {
    constructor(seed, registry, options = {}) {
        this.seed = seed;
        this.heightCache = new Map();
        this.baseCache = new Map();
        this.opt = {
            ...exports.DEFAULT_TERRAIN,
            ...options,
            treeDensity: { ...exports.DEFAULT_TERRAIN.treeDensity, ...options.treeDensity },
        };
        const n = (salt) => new noise_1.Noise(seed ^ salt);
        this.warpNoise = n(0x1a2b3c4d);
        this.continent = n(0x9e3779b9);
        this.hills = n(0x7f4a7c15);
        this.mountain = n(0x3c6ef372);
        this.river = n(0xd1b54a32);
        this.temperature = n(0x27d4eb2f);
        this.humidity = n(0x165667b1);
        this.biomeJitter = n(0x85ebca6b);
        this.cave = n(0xc2b2ae35);
        this.cave2 = n(0x5bf03675);
        const id = (name) => registry.byNameGet(name)?.id ?? 0;
        this.ids = {
            grass: id('grass'), dirt: id('dirt'), stone: id('stone'), sand: id('sand'),
            water: id('water'), bedrock: id('bedrock'), snow: id('snow'),
            log: id('oak_log'), leaves: id('oak_leaves'),
            tallgrass: id('tall_grass'), poppy: id('poppy'), dandelion: id('dandelion'),
            coal: id('coal_ore'), iron: id('iron_ore'), gold: id('gold_ore'),
            diamond: id('diamond_ore'), glowstone: id('glowstone'),
        };
    }
    // ---------- 确定性哈希 ----------
    hash2i(x, z, salt) {
        let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(this.seed ^ salt, 144665)) | 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        h ^= h >>> 16;
        return (h >>> 0) / 4294967296;
    }
    hashInt(a, b, c, d) {
        let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^
            Math.imul(c, 83492791) ^ Math.imul(d, 2654435761) ^ this.seed) | 0;
        h = Math.imul(h ^ (h >>> 15), 2246822519);
        h ^= h >>> 13;
        return h >>> 0;
    }
    // ---------- 高度场 ----------
    warped(x, z) {
        const a = this.opt.warp;
        return [
            x + a * this.warpNoise.noise2(x / 140 + 11, z / 140 - 7),
            z + a * this.warpNoise.noise2(x / 140 - 53, z / 140 + 29),
        ];
    }
    rawHeight(x, z, wx, wz) {
        const o = this.opt;
        const cont = this.continent.fbm2(wx / 220, wz / 220, 3);
        const detail = this.hills.fbm2(wx / 52 + 37, wz / 52 - 11, 3);
        const ridge = this.mountain.ridged2(wx / 190 - 90, wz / 190 + 40, 3);
        const mountMask = (0, types_1.smoothstep)(0.4, 0.72, ridge) * (0, types_1.smoothstep)(-0.16, 0.2, cont);
        let h = o.baseHeight + cont * o.continentAmp + detail * o.hillAmp;
        h += mountMask * (o.mountainLift + ridge * o.mountainRidgeAmp);
        // 河道：|n|≈0 的等值线形成蜿蜒低谷。
        // 按「距海平面的高度」平滑淡出，让河谷在海岸自然收口，
        // 而不是用硬阈值在海床上切出一条笔直深沟。
        const river = 1 - Math.abs(this.river.noise2(wx / 110, wz / 110));
        if (river > 0.93) {
            const landFade = (0, types_1.smoothstep)(types_1.SEA_LEVEL - 1, types_1.SEA_LEVEL + 4, h);
            h -= ((river - 0.93) / 0.07) * o.riverDepth * landFade;
        }
        // 出生点保底陆地：把低洼处平滑抬到「海平面 + spawnUplift」。
        // max(0, …) 保证只抬不压、任意 seed 都落在陆地；半径用噪声扰动，岛岸不是正圆。
        const wobble = 1 + 0.35 * this.biomeJitter.noise2(x / 45 + 9, z / 45 - 4);
        const radius = o.spawnRadius * wobble;
        const r2 = (x * x + z * z) / (radius * radius);
        const target = types_1.SEA_LEVEL + o.spawnUplift;
        h += Math.max(0, (target - h) * Math.exp(-1.5 * r2));
        return (0, types_1.clamp)(Math.floor(h), 4, H - 14);
    }
    height(x, z) {
        const key = `${x},${z}`;
        const cached = this.heightCache.get(key);
        if (cached !== undefined)
            return cached;
        const [wx, wz] = this.warped(x, z);
        const h = this.rawHeight(x, z, wx, wz);
        if (this.heightCache.size > CACHE_LIMIT)
            this.heightCache.clear();
        this.heightCache.set(key, h);
        return h;
    }
    /** 公开的地形高度（供水面/出生点/实体生成使用，不受树冠影响） */
    surfaceHeight(x, z) {
        return this.height(x, z);
    }
    base(x, z) {
        const key = `${x},${z}`;
        const cached = this.baseCache.get(key);
        if (cached)
            return cached;
        const height = this.height(x, z);
        const temperature = (0, types_1.clamp)(0.5 + this.temperature.fbm2(x / 300 + 17, z / 300 - 29, 3) * 1.15, 0, 1);
        const humidity = (0, types_1.clamp)(0.5 + this.humidity.fbm2(x / 240 - 71, z / 240 + 13, 3) * 1.15, 0, 1);
        // 抖动边界，避免群系分界出现笔直线
        const jitter = this.biomeJitter.noise2(x / 22, z / 22) * 0.06;
        const t = (0, types_1.clamp)(temperature + jitter, 0, 1);
        const m = (0, types_1.clamp)(humidity + jitter, 0, 1);
        const alt = (0, types_1.smoothstep)(46, 60, height);
        let biome;
        if (height < types_1.SEA_LEVEL)
            biome = 'ocean';
        else if (height <= types_1.SEA_LEVEL + 1)
            biome = 'beach';
        else if (alt > 0.55 || (t < 0.2 && height > 50))
            biome = 'alpine';
        else if (t < 0.3)
            biome = 'taiga';
        else if (t > 0.68 && m < 0.45)
            biome = 'desert';
        else if (m > 0.56)
            biome = 'forest';
        else
            biome = 'plains';
        const info = { height, biome, temperature, humidity };
        if (this.baseCache.size > CACHE_LIMIT)
            this.baseCache.clear();
        this.baseCache.set(key, info);
        return info;
    }
    biomeAt(x, z) {
        return this.base(x, z).biome;
    }
    slopeAt(x, z) {
        const d = 2;
        const hx = this.height(x + d, z) - this.height(x - d, z);
        const hz = this.height(x, z + d) - this.height(x, z - d);
        return (0, types_1.clamp)(Math.hypot(hx, hz) / (2 * d * 1.4), 0, 1);
    }
    /** 供 CraftAPI / 调试使用的完整列信息 */
    columnInfo(x, z) {
        const b = this.base(x, z);
        return { x, z, ...b, slope: this.slopeAt(x, z) };
    }
    // ---------- 区块生成 ----------
    generateChunk(cx, cz, data) {
        const I = this.ids;
        const idx = (x, y, z) => (y * CS + z) * CS + x;
        const x0 = cx * CS;
        const z0 = cz * CS;
        // 一次算出 (16+2*PAD)² 列的地形信息，列内复用
        const cols = new Array(GRID * GRID);
        const heights = new Int16Array(GRID * GRID);
        for (let gz = 0; gz < GRID; gz++) {
            for (let gx = 0; gx < GRID; gx++) {
                const wx = x0 + gx - PAD;
                const wz = z0 + gz - PAD;
                const b = this.base(wx, wz);
                const k = gz * GRID + gx;
                heights[k] = b.height;
                cols[k] = { x: wx, z: wz, ...b, slope: 0 };
            }
        }
        // 坡度直接由高度网格做差分，避免每列再算 4 次高度
        for (let gz = 0; gz < GRID; gz++) {
            for (let gx = 0; gx < GRID; gx++) {
                const k = gz * GRID + gx;
                const hx = heights[gz * GRID + Math.min(GRID - 1, gx + 1)] -
                    heights[gz * GRID + Math.max(0, gx - 1)];
                const hz = heights[Math.min(GRID - 1, gz + 1) * GRID + gx] -
                    heights[Math.max(0, gz - 1) * GRID + gx];
                cols[k].slope = (0, types_1.clamp)(Math.hypot(hx, hz) / (2 * 1.4), 0, 1);
            }
        }
        const at = (lx, lz) => cols[(lz + PAD) * GRID + lx + PAD];
        const groundAt = (wx, wz) => {
            const gx = wx - x0 + PAD;
            const gz = wz - z0 + PAD;
            if (gx >= 0 && gx < GRID && gz >= 0 && gz < GRID)
                return heights[gz * GRID + gx];
            return this.height(wx, wz);
        };
        // 1) 地形柱 + 洞穴
        for (let lz = 0; lz < CS; lz++) {
            for (let lx = 0; lx < CS; lx++) {
                const c = at(lx, lz);
                const h = c.height;
                const wx = x0 + lx;
                const wz = z0 + lz;
                const sandy = c.biome === 'ocean' || c.biome === 'beach' || c.biome === 'desert';
                const snowy = c.biome === 'alpine';
                const steep = c.slope > 0.58;
                for (let y = 0; y <= h; y++) {
                    let id;
                    if (y === 0) {
                        id = I.bedrock;
                    }
                    else if (y < h - 3) {
                        id = I.stone;
                        const cover = h - y;
                        const minCover = 5;
                        // 洞穴随「距地表深度」渐隐；水下地层完全不挖，
                        // 否则会形成被海水压住的空气袋（玩家游过突然能呼吸、渲染出现水下空洞）
                        const fade = h >= types_1.SEA_LEVEL ? (0, types_1.smoothstep)(minCover, minCover + 5, cover) : 0;
                        if (fade > 0 && y > 3) {
                            const n1 = this.cave.noise3(wx / 26, y / 11, wz / 26);
                            const n2 = this.cave2.noise3(wx / 16 + 50, y / 13, wz / 16 - 30);
                            const tunnel = 1 - Math.abs(n1);
                            if (tunnel > (0, types_1.lerp)(1.1, 0.905, fade) || n2 > (0, types_1.lerp)(1.1, 0.6, fade))
                                id = 0;
                        }
                    }
                    else if (y < h) {
                        id = sandy ? I.sand : steep ? I.stone : I.dirt;
                    }
                    else {
                        id = sandy ? I.sand : snowy ? I.snow : steep ? I.stone : I.grass;
                    }
                    data[idx(lx, y, lz)] = id;
                }
                if (h < types_1.SEA_LEVEL) {
                    for (let y = h + 1; y <= types_1.SEA_LEVEL; y++)
                        data[idx(lx, y, lz)] = I.water;
                }
            }
        }
        // 2) 矿脉：只替换仍是石头的体素，洞穴不会被矿石填回
        this.placeOres(cx, cz, data, idx);
        // 3) 树木先于花草，避免植物占住树冠格
        this.placeTrees(cx, cz, data, idx, groundAt);
        // 4) 地表装饰（只在草地、缓坡、无遮挡的格子上）
        for (let lz = 0; lz < CS; lz++) {
            for (let lx = 0; lx < CS; lx++) {
                const c = at(lx, lz);
                if (c.biome === 'ocean' || c.biome === 'beach' || c.biome === 'desert')
                    continue;
                if (c.slope > 0.5 || c.height <= types_1.SEA_LEVEL)
                    continue;
                const h = c.height;
                if (h + 1 >= H || data[idx(lx, h, lz)] !== I.grass)
                    continue;
                const p = idx(lx, h + 1, lz);
                if (data[p] !== 0)
                    continue;
                const wx = x0 + lx;
                const wz = z0 + lz;
                const r = this.hash2i(wx, wz, 0x51ed);
                const density = c.biome === 'forest' ? 0.16 : c.biome === 'taiga' ? 0.08 : 0.11;
                if (r < density * 0.62)
                    data[p] = I.tallgrass;
                else if (r < density * 0.82)
                    data[p] = I.poppy;
                else if (r < density)
                    data[p] = I.dandelion;
            }
        }
    }
    // ---------- 矿脉 ----------
    placeOres(cx, cz, data, idx) {
        const I = this.ids;
        const veins = [
            { id: I.coal, min: 6, max: 52, count: 16, size: 7, salt: 0x11a },
            { id: I.iron, min: 6, max: 40, count: 10, size: 6, salt: 0x22b },
            { id: I.gold, min: 5, max: 26, count: 5, size: 5, salt: 0x33c },
            { id: I.diamond, min: 4, max: 16, count: 2, size: 4, salt: 0x44d },
            // 深层偶发萤石晶洞，给地下一点自发光
            { id: I.glowstone, min: 8, max: 24, count: 2, size: 3, salt: 0x55e },
        ];
        for (const v of veins) {
            if (v.id === 0)
                continue; // 自定义注册表缺少该方块时静默跳过
            const count = Math.round(v.count * this.opt.oreRichness);
            for (let i = 0; i < count; i++) {
                const rng = (0, types_1.mulberry32)(this.hashInt(cx, cz, v.salt, i));
                const lx = 1 + ((rng() * (CS - 2)) | 0);
                const lz = 1 + ((rng() * (CS - 2)) | 0);
                // 用本区块中心的地形高度限制矿脉深度，避免穿出海床
                const h = this.height(cx * CS + lx, cz * CS + lz);
                const maxY = Math.min(v.max, h - 5);
                if (maxY < v.min)
                    continue;
                let px = lx;
                let py = v.min + ((rng() * (maxY - v.min + 1)) | 0);
                let pz = lz;
                for (let k = 0; k < v.size; k++) {
                    if (px < 0 || px >= CS || pz < 0 || pz >= CS || py < 1 || py >= H)
                        break;
                    const j = idx(px, py, pz);
                    if (data[j] === I.stone)
                        data[j] = v.id;
                    px += ((rng() * 3) | 0) - 1;
                    py += ((rng() * 3) | 0) - 1;
                    pz += ((rng() * 3) | 0) - 1;
                }
            }
        }
    }
    // ---------- 跨区块树木 ----------
    placeTrees(cx, cz, data, idx, groundAt) {
        const I = this.ids;
        const x0 = cx * CS;
        const z0 = cz * CS;
        // 多扫一个格子：邻区块中心的树冠可能伸进本区块
        const gx0 = Math.floor((x0 - PAD - TREE_CELL) / TREE_CELL);
        const gx1 = Math.floor((x0 + CS + PAD) / TREE_CELL);
        const gz0 = Math.floor((z0 - PAD - TREE_CELL) / TREE_CELL);
        const gz1 = Math.floor((z0 + CS + PAD) / TREE_CELL);
        for (let gz = gz0; gz <= gz1; gz++) {
            for (let gx = gx0; gx <= gx1; gx++) {
                const rDen = this.hash2i(gx, gz, 0x7a1c);
                const rJx = this.hash2i(gx, gz, 0x1b33);
                const rJz = this.hash2i(gx, gz, 0x2c47);
                const wx = gx * TREE_CELL + 1 + ((rJx * (TREE_CELL - 2)) | 0);
                const wz = gz * TREE_CELL + 1 + ((rJz * (TREE_CELL - 2)) | 0);
                const b = this.base(wx, wz);
                const density = this.opt.treeDensity[b.biome] ?? 0;
                if (density <= 0 || rDen > density)
                    continue;
                if (b.height <= types_1.SEA_LEVEL || b.height + 10 >= H)
                    continue;
                if (this.slopeAt(wx, wz) > 0.45)
                    continue;
                // 同一棵树在任何区块里都用同一随机序列，保证跨区块裁剪结果一致
                const rng = (0, types_1.mulberry32)((Math.imul(wx, 73856093) ^ Math.imul(wz, 19349663) ^ this.seed) | 0);
                const trunk = 4 + ((rng() * 3) | 0);
                const baseY = b.height + 1;
                if (baseY + trunk + 2 >= H)
                    continue;
                const crown = b.biome === 'taiga' ? 1 : 2;
                // 树干：只写本区块内的那一列
                if (wx >= x0 && wx < x0 + CS && wz >= z0 && wz < z0 + CS) {
                    const lx = wx - x0;
                    const lz = wz - z0;
                    for (let dy = 0; dy < trunk; dy++) {
                        const yy = baseY + dy;
                        if (yy < H)
                            data[idx(lx, yy, lz)] = I.log;
                    }
                }
                // 树冠：按世界坐标计算，按本区块范围裁剪
                const topRad = Math.max(1, crown - 1);
                for (let dy = trunk - 2; dy <= trunk + 1; dy++) {
                    const rad = dy >= trunk ? topRad : crown;
                    for (let dx = -rad; dx <= rad; dx++) {
                        for (let dz = -rad; dz <= rad; dz++) {
                            if (Math.abs(dx) === rad && Math.abs(dz) === rad && (dy >= trunk || rng() < 0.5))
                                continue;
                            const lx = wx + dx - x0;
                            const lz = wz + dz - z0;
                            const yy = baseY + dy;
                            if (lx < 0 || lx >= CS || lz < 0 || lz >= CS || yy >= H)
                                continue;
                            if (yy <= groundAt(wx + dx, wz + dz))
                                continue;
                            const j = idx(lx, yy, lz);
                            if (data[j] === 0)
                                data[j] = I.leaves;
                        }
                    }
                }
            }
        }
    }
}
exports.DefaultGenerator = DefaultGenerator;
