/**
 * 16³ section 网格化回归（纯逻辑，不需要 three 运行时）。
 *
 * 运行：node test/section-check.cjs
 *
 * 验证：
 * 1. **脏标记粒度**：改一格只标脏它所在的 section；踩在 16 边界上才连带上下各一段。
 * 2. **分段网格等价**：整列（80 层）与 5 个 section 分别网格化，
 *    总量级一致、每个 section 的顶点 y 落在 0..16（由 mesh.position.y 抬升）。
 * 3. **快照池化**：传入复用 buffer 时返回同一批对象，且每次重建都会清掉旧内容。
 */
const assert = require('node:assert');
const { World } = require('./logic/world/world.js');
const { BlockRegistry, registerBuiltinBlocks } = require('./logic/world/blocks.js');
const { DefaultGenerator } = require('./logic/world/generator.js');
const { meshChunk } = require('./logic/world/mesher.js');
const { buildMeshConfig, buildMeshSnapshot } = require('./logic/world/meshSource.js');
const { SnapshotMeshSource } = require('./logic/world/snapshotSource.js');
const {
  CHUNK_SIZE: CS,
  SECTION_HEIGHT,
  SECTIONS,
  WORLD_HEIGHT: H,
  parseSectionKey,
  sectionKey,
  sectionOfY,
} = require('./logic/core/types.js');

let passed = 0;
const ok = (name, cond, extra = '') => {
  assert.ok(cond, `${name}${extra ? ' — ' + extra : ''}`);
  passed++;
  console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
};

const reg = new BlockRegistry();
registerBuiltinBlocks(reg);
const stone = reg.byNameGet('stone').id;
const dirt = reg.byNameGet('dirt').id;

function makeWorld(seed = 1337) {
  const generator = new DefaultGenerator(seed, reg);
  return new World(reg, generator, { emit() {} });
}

// ---------- 1. 脏标记粒度 ----------
{
  const w = makeWorld();
  w.ensureChunk(0, 0);
  w.dirty.clear();

  // 先用 dirt 占位，再换成 stone：两者同为不透明，光照不变，
  // 这样测到的是纯几何脏标记粒度（否则光照会合法地扩到整列）。
  w.setBlock(8, 20, 8, dirt);
  w.dirty.clear();
  w.setBlock(8, 20, 8, stone);
  const mid = [...w.dirty];
  ok('段落内部改一格 → 只脏 1 个 section', mid.length === 1 && mid[0] === '0,1,0', mid.join('|'));

  w.dirty.clear();
  w.setBlock(8, SECTION_HEIGHT, 8, dirt);
  w.dirty.clear();
  w.setBlock(8, SECTION_HEIGHT, 8, stone); // y=16：section 1 的底面
  const edge = [...w.dirty].sort();
  ok(
    'y=16 边界改一格 → 脏上下两个 section',
    edge.length === 2 && edge.includes('0,1,0') && edge.includes('0,0,0'),
    edge.join('|'),
  );

  w.dirty.clear();
  w.setBlock(0, 40, 8, dirt); // x=0：还影响西侧邻列
  w.dirty.clear();
  w.setBlock(0, 40, 8, stone);
  const nb = [...w.dirty];
  ok(
    '区块边界改一格 → 只脏相邻列对应 section',
    nb.includes('0,2,0') && nb.includes('-1,2,0') && nb.length === 2,
    nb.join('|'),
  );

  ok(
    'sectionOfY / sectionKey / parseSectionKey 自洽',
    sectionOfY(16) === 1 &&
      sectionOfY(79) === SECTIONS - 1 &&
      parseSectionKey(sectionKey(-2, 3, 5)).join(',') === '-2,3,5',
  );
}

// ---------- 2. 整列 vs 分段网格 ----------
{
  const w = makeWorld();
  w.ensureChunk(0, 0);
  // 图集在 Node 侧不可用：给一个确定性 UV 替身，只关心几何量级
  const atlas = { uv: (name) => [(name.length % 16) / 16, 0, ((name.length % 16) + 1) / 16, 1 / 16] };
  const config = buildMeshConfig(reg, atlas, true, 1, true);
  const srcFull = new SnapshotMeshSource(config, fullSnapshot(w, 0, 0));
  const full = meshChunk(srcFull);

  let sectionQuads = 0;
  let sectionVerts = 0;
  const perSection = [];
  for (let sy = 0; sy < SECTIONS; sy++) {
    const snap = buildMeshSnapshot(w, 0, 0, sy);
    const src = new SnapshotMeshSource(config, snap);
    const out = meshChunk(src, sy * SECTION_HEIGHT, SECTION_HEIGHT);
    perSection.push(out);
    let verts = 0;
    let badY = 0;
    for (const ch of ['opaque', 'transparent', 'water']) {
      const g = out[ch];
      if (!g) continue;
      verts += g.positions.length / 3;
      for (let i = 1; i < g.positions.length; i += 3) {
        const y = g.positions[i];
        if (y < -0.2 || y > SECTION_HEIGHT + 0.2) badY++;
      }
    }
    sectionVerts += verts;
    sectionQuads += out.stats.quads;
    ok(`section ${sy} 顶点 y 归一到 0..16`, badY === 0, `verts=${verts} bad=${badY}`);
  }
  const fullQuads = full.stats.quads;
  ok(
    '分段网格 quad 总量与整列同量级（贪心跨段不合并带来的小幅增加）',
    sectionQuads >= fullQuads * 0.95 && sectionQuads <= fullQuads * 1.25,
    `full=${fullQuads} sections=${sectionQuads}`,
  );
  ok(
    '每个 quad 仍为 4 个顶点（分段不改变顶点打包方式）',
    sectionVerts === sectionQuads * 4 && full.stats.vertices === fullQuads * 4,
    `sections=${sectionVerts}/${sectionQuads * 4} full=${full.stats.vertices}/${fullQuads * 4}`,
  );
  ok('地形之上（section 4）不产生几何', perSection[4].stats.quads === 0, `quads=${perSection[4].stats.quads}`);
}

// ---------- 3. 快照池化 ----------
{
  const w = makeWorld();
  w.ensureChunk(0, 0);
  const size = 18 * 18 * 18;
  const buffers = {
    data: new Uint8Array(size).fill(9),
    sky: new Uint8Array(size).fill(9),
    block: new Uint8Array(size).fill(9),
  };
  const snap = buildMeshSnapshot(w, 0, 0, 1, buffers);
  ok(
    '复用快照返回同一批 buffer',
    snap.data === buffers.data && snap.sky === buffers.sky && snap.block === buffers.block,
  );
  ok('复用时 data 不残留上一轮内容', !snap.data.includes(9), '');
  ok('复用时 sky 不残留上一轮内容', snap.sky.includes(15) && !snap.sky.includes(9), '');
  ok('快照 y0 = sy*16 - 1', snap.y0 === SECTION_HEIGHT - 1, `${snap.y0}`);
}

/** 构造整列（80 层）快照，用于与分段结果对照 */
function fullSnapshot(world, cx, cz) {
  const W = CS + 2;
  const SH = H + 2;
  const data = new Uint8Array(W * SH * W);
  const sky = new Uint8Array(W * SH * W).fill(15);
  const block = new Uint8Array(W * SH * W);
  const chunk = world.getChunk(cx, cz);
  for (let y = 0; y < H; y++) {
    for (let lz = 0; lz < CS; lz++) {
      const s = (y * CS + lz) * CS;
      const d = ((y + 1) * W + lz + 1) * W + 1;
      data.set(chunk.data.subarray(s, s + CS), d);
      sky.set(chunk.sky.subarray(s, s + CS), d);
      block.set(chunk.block.subarray(s, s + CS), d);
    }
  }
  return { cx, cz, y0: -1, data, sky, block, known: null };
}

console.log(`\nPASS 16³ section 网格化回归：${passed} 组断言`);
