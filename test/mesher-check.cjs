/**
 * 网格生成回归（纯逻辑，无需 WebGL / 浏览器）。
 *
 * 运行：node test/mesher-check.cjs
 *
 * 验证三件事：
 * 1. **快照保真**：Worker 用的 SnapshotMeshSource（1 格 halo 快照）
 *    与主线程直读数据源输出逐字节一致 —— 这是跨线程数据契约的正确性基础。
 * 2. **Greedy 视觉等价**：开关 greedy 后，「每个渲染通道 × 每个可见面格子」
 *    的集合、贴图 tile、平均亮度必须完全一致。合并只允许改变 quad 的
 *    顶点组织方式，不允许改变画面。
 * 3. **收益**：quad 数 / 顶点数显著下降，且 merged 计数与差值吻合。
 */
const assert = require('node:assert');
const { DefaultGenerator } = require('./terrain-logic/world/generator.js');
const { BlockRegistry, registerBuiltinBlocks } = require('./terrain-logic/world/blocks.js');
const { meshChunk } = require('./terrain-logic/world/mesher.js');
const { buildMeshConfig } = require('./terrain-logic/world/meshSource.js');
const { SnapshotMeshSource } = require('./terrain-logic/world/snapshotSource.js');
const { AIR_MESH_DEF } = require('./terrain-logic/world/meshTypes.js');
const { CHUNK_SIZE: CS, WORLD_HEIGHT: H } = require('./terrain-logic/core/types.js');

const W = CS + 2;
const CHANNELS = ['opaque', 'transparent', 'water'];
let passed = 0;
const ok = (name, cond, extra = '') => {
  assert.ok(cond, `${name}${extra ? ' — ' + extra : ''}`);
  passed++;
  console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
};

// ---------- 配置 ----------

function makeConfig(reg, greedy, mergeEmissive = true) {
  // 图集在 Node 侧不可用，用确定性 UV 替身：每个 tile 占 16×16 网格中的一格。
  // 只要同名 tile 映射稳定，就能查出「合并后贴错图」这类错误。
  const order = new Map();
  const slot = (name) => {
    if (!name) return 0;
    if (!order.has(name)) order.set(name, order.size);
    return order.get(name);
  };
  const atlas = {
    uv(name) {
      const i = slot(name);
      const u0 = (i % 16) / 16;
      const v0 = Math.floor(i / 16) / 16;
      return [u0, v0, u0 + 1 / 16, v0 + 1 / 16];
    },
  };
  return buildMeshConfig(reg, atlas, greedy, 1, mergeEmissive);
}

// ---------- 数据源 ----------

/** 世界坐标读取器：按需生成并缓存区块（含 3×3 邻域，保证 halo 真实） */
function makeWorldReader(gen, bedrockId) {
  const cache = new Map();
  const chunkData = (cx, cz) => {
    const k = `${cx},${cz}`;
    let d = cache.get(k);
    if (!d) {
      d = new Uint8Array(CS * CS * H);
      gen.generateChunk(cx, cz, d);
      cache.set(k, d);
    }
    return d;
  };
  return (x, y, z) => {
    if (y < 0) return bedrockId;   // 与 World.getBlock 一致：世界底部之下为基岩
    if (y >= H) return 0;
    const cx = Math.floor(x / CS);
    const cz = Math.floor(z / CS);
    const lx = x - cx * CS;
    const lz = z - cz * CS;
    return chunkData(cx, cz)[(y * CS + lz) * CS + lx];
  };
}

function buildSnapshot(read, cx, cz) {
  const data = new Uint8Array(W * H * W);
  const sky = new Uint8Array(W * H * W);
  const block = new Uint8Array(W * H * W);
  const x0 = cx * CS;
  const z0 = cz * CS;
  for (let lz = -1; lz <= CS; lz++)
    for (let lx = -1; lx <= CS; lx++)
      for (let y = 0; y < H; y++) {
        const i = ((y * W) + (lz + 1)) * W + (lx + 1);
        data[i] = read(x0 + lx, y, z0 + lz);
        // 确定性的假光照：让快照保真与 Greedy 光照一致性都被覆盖
        sky[i] = fakeSky(x0 + lx, y, z0 + lz);
        block[i] = fakeBlock(x0 + lx, y, z0 + lz);
      }
  return { cx, cz, data, sky, block };
}

/** 测试用世界坐标光照：大部分区域一致，稀疏暗格用来验证「光照不同不合并」 */
const fakeSky = (x, y, z) => (y > 32 && x % 5 === 0 && z % 5 === 0 ? 4 : 15);
const fakeBlock = (x, y, z) => (y > 32 && x % 11 === 0 && z % 11 === 0 ? 7 : 0);

/** 主线程直读数据源（等价于 WorldMeshSource，但不依赖 three） */
class DirectSource {
  constructor(config, read, x0, z0) {
    this.config = config;
    this.read = read;
    this.x0 = x0;
    this.z0 = z0;
  }
  getId(lx, y, lz) { return this.read(this.x0 + lx, y, this.z0 + lz); }
  def(id) { return this.config.defs[id] ?? AIR_MESH_DEF; }
  isOpaque(id) {
    const d = this.def(id);
    return !!d && d.opaque;
  }
  uv(tile) { return this.config.uv[tile] ?? [0, 0, 0, 0]; }
  getSkyLight(lx, y, lz) {
    if (y >= H) return 15;
    if (y < 0) return 0;
    return fakeSky(this.x0 + lx, y, this.z0 + lz);
  }
  getBlockLight(lx, y, lz) {
    if (y < 0 || y >= H) return 0;
    return fakeBlock(this.x0 + lx, y, this.z0 + lz);
  }
  get greedy() { return this.config.greedy; }
  get mergeEmissive() { return this.config.mergeEmissive; }
}

// ---------- 面覆盖提取 ----------

/**
 * 把网格拆成「面格子」集合：key = 通道|轴|朝向|平面坐标|格坐标。
 * 合并 quad 会展开成 w×h 个格子，因此可以与逐面输出直接比对。
 */
function coverage(mesh) {
  const cells = new Map();
  let quads = 0;
  let maxSpan = 1;
  let gradientQuads = 0;
  for (const ch of CHANNELS) {
    const g = mesh[ch];
    if (!g || g.positions.length === 0) continue;
    const n = g.positions.length / 12;
    quads += n;
    for (let q = 0; q < n; q++) {
      const p = [];
      for (let i = 0; i < 4; i++) {
        p.push([
          g.positions[q * 12 + i * 3],
          g.positions[q * 12 + i * 3 + 1],
          g.positions[q * 12 + i * 3 + 2],
        ]);
      }
      const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
      const e2 = [p[3][0] - p[0][0], p[3][1] - p[0][1], p[3][2] - p[0][2]];
      const nrm = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      const abs = nrm.map(Math.abs);
      let axis = 0;
      if (abs[1] > abs[axis]) axis = 1;
      if (abs[2] > abs[axis]) axis = 2;
      const sign = nrm[axis] >= 0 ? 1 : -1;
      const plane = Math.round(p[0][axis]);
      const axes = [0, 1, 2].filter((a) => a !== axis);
      const [a1, a2] = axes;
      let lo1 = Infinity, hi1 = -Infinity, lo2 = Infinity, hi2 = -Infinity;
      for (const v of p) {
        lo1 = Math.min(lo1, v[a1]); hi1 = Math.max(hi1, v[a1]);
        lo2 = Math.min(lo2, v[a2]); hi2 = Math.max(hi2, v[a2]);
      }
      maxSpan = Math.max(maxSpan, Math.round(hi1 - lo1) * Math.round(hi2 - lo2));
      const bright = (g.shade[q * 4] + g.shade[q * 4 + 1] + g.shade[q * 4 + 2] + g.shade[q * 4 + 3]) / 4;
      const light = [0, 1, 2, 3].map((i) => `${g.lights[q * 8 + i * 2].toFixed(3)},${g.lights[q * 8 + i * 2 + 1].toFixed(3)}`);
      const lightKey = light.every((v) => v === light[0]) ? light[0] : light.join('|');
      // 角点光照不全等 → 该 quad 内部存在光照梯度（平滑光照生效的证据）
      if (lightKey.includes('|')) gradientQuads++;
      const tile = [g.tile[q * 8].toFixed(5), g.tile[q * 8 + 1].toFixed(5)].join(',');
      for (let c2 = Math.floor(lo2 + 1e-6); c2 <= Math.floor(hi2 - 1e-6); c2++) {
        for (let c1 = Math.floor(lo1 + 1e-6); c1 <= Math.floor(hi1 - 1e-6); c1++) {
          const key = `${ch}|${axis}|${sign}|${plane}|${c1}|${c2}`;
          // 同一面格可被多个 quad 覆盖（如十字面植物与相邻立方体面）；
          // 记成多重集，比较时与发射顺序无关
          const list = cells.get(key);
          if (list) list.push({ bright, tile, lightKey });
          else cells.set(key, [{ bright, tile, lightKey }]);
        }
      }
    }
  }
  return { cells, quads, maxSpan, gradientQuads };
}

function compareCoverage(a, b, label) {
  const missing = [];
  for (const k of a.keys()) if (!b.has(k)) missing.push(k);
  const extra = [];
  for (const k of b.keys()) if (!a.has(k)) extra.push(k);
  assert.strictEqual(missing.length, 0, `${label}: 缺少 ${missing.length} 个面格，例如 ${missing.slice(0, 3).join(' / ')}`);
  assert.strictEqual(extra.length, 0, `${label}: 多出 ${extra.length} 个面格，例如 ${extra.slice(0, 3).join(' / ')}`);
  let brightDiff = 0;
  let tileDiff = 0;
  let lightDiff = 0;
  const sortKey = (v) => `${v.tile}|${v.bright}|${v.lightKey}`;
  for (const [k, va] of a) {
    const vb = b.get(k);
    if (va.length !== vb.length) {
      tileDiff += Math.abs(va.length - vb.length);
      continue;
    }
    const sa = [...va].sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
    const sb = [...vb].sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
    for (let i = 0; i < sa.length; i++) {
      brightDiff = Math.max(brightDiff, Math.abs(sa[i].bright - sb[i].bright));
      if (sa[i].tile !== sb[i].tile) tileDiff++;
      if (sa[i].lightKey !== sb[i].lightKey) lightDiff++;
    }
  }
  assert.ok(brightDiff < 1e-6, `${label}: 亮度差异 ${brightDiff}`);
  assert.strictEqual(tileDiff, 0, `${label}: ${tileDiff} 个面格贴图 tile 不一致`);
  assert.strictEqual(lightDiff, 0, `${label}: ${lightDiff} 个面格光照不一致`);
  return { cells: a.size, brightDiff };
}

function sameArrays(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  for (const key of ['positions', 'uvs', 'shade', 'lights', 'tile', 'tints', 'indices']) {
    if (a[key].length !== b[key].length) return false;
    for (let i = 0; i < a[key].length; i++) if (a[key][i] !== b[key][i]) return false;
  }
  return true;
}

// ---------- 主流程 ----------

console.log('网格生成回归（快照保真 + Greedy 等价 + 收益）');

const seeds = [1337, 20260101, 987654321];
const total = { legacy: 0, greedy: 0, msLegacy: 0, msGreedy: 0, merged: 0 };
const grad = { legacy: 0, greedy: 0, quads: 0, greedyQuads: 0 };

for (const seed of seeds) {
  const reg = new BlockRegistry();
  registerBuiltinBlocks(reg);
  const gen = new DefaultGenerator(seed, reg);
  const read = makeWorldReader(gen, reg.byNameGet('bedrock').id);
  const cfgLegacy = makeConfig(reg, false);
  const cfgGreedy = makeConfig(reg, true);
  assert.ok(cfgLegacy.defs.length > 1, '配置应包含方块定义');

  for (const [cx, cz] of [[0, 0], [3, -2]]) {
    const snap = buildSnapshot(read, cx, cz);
    const tag = `seed=${seed} chunk=${cx},${cz}`;

    // 1) 快照保真：Worker 路径 == 主线程直读路径（两种 greedy 设置都测）
    for (const [cfg, name] of [[cfgLegacy, '逐面'], [cfgGreedy, 'Greedy']]) {
      const viaSnap = meshChunk(new SnapshotMeshSource(cfg, snap));
      const viaDirect = meshChunk(new DirectSource(cfg, read, cx * CS, cz * CS));
      const same = CHANNELS.every((ch) => sameArrays(viaSnap[ch], viaDirect[ch]));
      ok(`快照保真·${name}（${tag}）`, same);
    }

    // 2) Greedy 视觉等价
    const legacy = meshChunk(new SnapshotMeshSource(cfgLegacy, snap));
    const greedy = meshChunk(new SnapshotMeshSource(cfgGreedy, snap));
    const covL = coverage(legacy);
    const covG = coverage(greedy);
    const cmp = compareCoverage(covL.cells, covG.cells, tag);
    ok(`面覆盖完全一致（${tag}）`, true, `${cmp.cells} 个面格，亮度差 ${cmp.brightDiff.toExponential(1)}`);

    // 3) 收益
    // 平滑光照让四角亮度不一致的面退回逐面输出，叠加新群系（恶地层状陶瓦、泥、
    // 干草原等高差区块）与 v1.6.0 花海（十字面占比上升）后，最差 seed 的合并
    // 收益收敛到 12.5%。阈值从 15% 放宽到 10%，仍能证明 Greedy 有效；
    // 「确有合并发生」与 diagnostics 的 mergeBudget 继续兜底。
    ok(`quad 数下降（${tag}）`, covG.quads <= covL.quads * 0.90,
      `${covL.quads} → ${covG.quads}（${((1 - covG.quads / covL.quads) * 100).toFixed(1)}%）`);
    ok(`顶点数 = quad × 4（${tag}）`, greedy.stats.vertices === covG.quads * 4,
      `${greedy.stats.vertices}`);
    const expectMerged = covL.quads - covG.quads;
    ok(`merged 计数自洽（${tag}）`, Math.abs(greedy.stats.merged - expectMerged) <= 0,
      `merged=${greedy.stats.merged} 差值=${expectMerged}`);
    ok(`确有合并发生（${tag}）`, covG.maxSpan > 1, `最大合并面 ${covG.maxSpan} 格`);

    total.legacy += covL.quads;
    total.greedy += covG.quads;
    total.msLegacy += legacy.stats.ms;
    total.msGreedy += greedy.stats.ms;
    total.merged += greedy.stats.merged;
    grad.legacy += covL.gradientQuads;
    grad.greedy += covG.gradientQuads;
    grad.quads += covL.quads;
    grad.greedyQuads += covG.quads;
  }
}

// 4) 平滑光照生效性：必须有相当比例的面存在角点光照梯度。
//    如果逐面输出退化成「整面一个光值」，上面所有等价断言仍然会全绿，
//    所以这里单独盯住「梯度确实存在」和「梯度没有吃掉整个网格」两端。
{
  const ratio = grad.legacy / grad.quads;
  ok('平滑光照生效（逐面输出存在角点光照梯度）', grad.legacy > 0,
    `${grad.legacy} / ${grad.quads} 个 quad 有梯度（${(ratio * 100).toFixed(1)}%）`);
  ok('角点光照梯度占比在合理区间（不是全平也不是全梯度）',
    ratio > 0.05 && ratio < 0.95,
    `${(ratio * 100).toFixed(1)}%`);
  const gradRatio = grad.greedy / grad.greedyQuads;
  ok('Greedy 与逐面的梯度面占比一致（合并不改变光照结构）',
    Math.abs(gradRatio - ratio) < 0.2,
    `greedy ${(gradRatio * 100).toFixed(1)}% vs legacy ${(ratio * 100).toFixed(1)}%`);
}

/**
 * 拆出每个 quad 的 11 个顶点分量（与打包后的顶点布局一一对应）。
 * 用于「自发光并入不透明通道」与「独立 emissive 通道」的逐顶点等价对比。
 */
function quadsOf(g) {
  if (!g || g.positions.length === 0) return [];
  const n = g.positions.length / 12;
  const out = [];
  for (let q = 0; q < n; q++) {
    const vals = [];
    for (let i = 0; i < 4; i++) {
      const b = q * 4 + i;
      vals.push(
        g.positions[b * 3], g.positions[b * 3 + 1], g.positions[b * 3 + 2],
        g.uvs[b * 2], g.uvs[b * 2 + 1],
        g.shade[b],
        g.lights[b * 2], g.lights[b * 2 + 1],
        g.tile[b * 2], g.tile[b * 2 + 1],
        g.tints[b],
      );
    }
    out.push({ key: vals.join(','), tint: g.tints[q * 4] });
  }
  return out;
}

// 5) 自发光通道对照（E3）：默认「并入不透明 + aTint=2」与 v1.5.1 的「独立 emissive 通道」
//    必须逐顶点等价 —— 这是「去掉一条渲染通道」不需要改画面的证据。
{
  const reg = new BlockRegistry();
  registerBuiltinBlocks(reg);
  const glowId = reg.byNameGet('glowstone').id;
  const stoneId = reg.byNameGet('stone').id;
  const rockId = reg.byNameGet('bedrock').id;
  // 手工世界：石头地面上摆一排萤石，其余为空气
  const readGlow = (x, y, z) => {
    if (y < 0) return rockId;
    if (y >= H) return 0;
    if (y < 3) return stoneId;
    if (y === 3 && x >= 2 && x <= 6 && z === 4) return glowId;
    return 0;
  };
  const snap = buildSnapshot(readGlow, 0, 0);
  const merged = meshChunk(new SnapshotMeshSource(makeConfig(reg, true, true), snap));
  const split = meshChunk(new SnapshotMeshSource(makeConfig(reg, true, false), snap));

  ok('默认路径不自开 emissive 通道',
    !merged.emissive || merged.emissive.indices.length === 0);
  ok('对照路径保留 emissive 通道',
    !!split.emissive && split.emissive.indices.length > 0,
    `${quadsOf(split.emissive).length} 个 quad`);
  ok('默认路径的自发光面带 aTint=2 标记',
    quadsOf(merged.opaque).some((q) => q.tint === 2));
  ok('对照路径的 opaque 不含自发光顶点',
    quadsOf(split.opaque).every((q) => q.tint !== 2));
  const viaMerge = quadsOf(merged.opaque).filter((q) => q.tint === 2).map((q) => q.key);
  const viaSplit = quadsOf(split.emissive).map((q) => q.key);
  ok('自发光几何逐顶点一致（并入 vs 独立通道）',
    viaMerge.length === viaSplit.length && viaMerge.every((k, i) => k === viaSplit[i]),
    `${viaMerge.length} 个 quad`);
}

// 6) 汇总基准
const drop = (1 - total.greedy / total.legacy) * 100;
// 平滑光照 + 新群系后总体收益从约 33% 收敛到 29%，仍显著；阈值下调到 27% 留出波动余量。
ok('总体 quad 减少 ≥ 27%', drop >= 27, `${total.legacy} → ${total.greedy}（-${drop.toFixed(1)}%）`);
console.log('\n基准（快照数据源，含 6 个区块）：');
console.log(`  逐面    quad ${total.legacy}  ${total.msLegacy.toFixed(1)} ms`);
console.log(`  Greedy  quad ${total.greedy}  ${total.msGreedy.toFixed(1)} ms  merged ${total.merged}`);

console.log(`\n合计 ${passed} 项全部通过`);
