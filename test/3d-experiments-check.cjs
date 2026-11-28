const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, 'terrain-logic');
const { DefaultGenerator, DEFAULT_TERRAIN } = require(path.join(ROOT, 'world/generator.js'));
const { BlockRegistry, registerBuiltinBlocks } = require(path.join(ROOT, 'world/blocks.js'));
const { CHUNK_SIZE: CS, WORLD_HEIGHT: H, SEA_LEVEL } = require(path.join(ROOT, 'core/types.js'));
const { DEFAULT_OPTIONS } = require(path.join(ROOT, 'core/options.js'));
const {
  packLightVertex, unpackLightVertex, packVertexLights, unpackVertexLights,
} = require(path.join(ROOT, 'world/lightPacking.js'));
const {
  nameToTile, tileForPath, filterKnownTiles, normalizeZipPath,
} = require(path.join(ROOT, 'gfx/texturePack.js'));

let passed = 0;
const ok = (name, cond, extra = '') => {
  assert.ok(cond, `${name} ${extra}`);
  passed++;
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
};

const make = (seed, opts = {}) => {
  const reg = new BlockRegistry();
  registerBuiltinBlocks(reg);
  return { reg, gen: new DefaultGenerator(seed, reg, opts) };
};
const generate = (gen, cx, cz) => {
  const data = new Uint8Array(CS * CS * H);
  gen.generateChunk(cx, cz, data);
  return data;
};
const idx = (x, y, z) => (y * CS + z) * CS + x;

console.log('3D experiments');

ok('默认关闭密度地形', DEFAULT_OPTIONS.densityTerrain === false && DEFAULT_TERRAIN.densityTerrain === false);
ok('光照与材质预设不再占用设置项', !('packedLighting' in DEFAULT_OPTIONS) && !('texturePack' in DEFAULT_OPTIONS));

const classic = make(2026).gen;
const density = make(2026, { densityTerrain: true }).gen;
const densityAgain = make(2026, { densityTerrain: true }).gen;
let surfaceOk = true;
let headClear = true;
let overhang = 0;
for (const [cx, cz] of [[0, 0], [1, 0], [2, 2], [4, 4]]) {
  const c = generate(classic, cx, cz);
  const d = generate(density, cx, cz);
  const d2 = generate(densityAgain, cx, cz);
  if (Buffer.compare(Buffer.from(d), Buffer.from(d2)) !== 0) {
    ok('密度地形确定性', false, `区块 ${cx},${cz} 不稳定`);
  }
  for (let lz = 0; lz < CS; lz++) {
    for (let lx = 0; lx < CS; lx++) {
      const h = density.surfaceHeight(cx * CS + lx, cz * CS + lz);
      if (h < SEA_LEVEL) continue;
      if (d[idx(lx, h, lz)] === 0) surfaceOk = false;
      if ((c[idx(lx, h + 1, lz)] === 0 && d[idx(lx, h + 1, lz)] !== 0) ||
        (c[idx(lx, h + 2, lz)] === 0 && d[idx(lx, h + 2, lz)] !== 0)) headClear = false;
      for (let y = h + 3; y < H; y++) {
        if (c[idx(lx, y, lz)] === 0 && d[idx(lx, y, lz)] !== 0) overhang++;
      }
    }
  }
}
ok('密度地形确定性', true);
ok('每列保留可站立顶面', surfaceOk);
ok('密度地形不占用玩家头部两格', headClear);
ok('密度模式生成原版没有的岩檐 / 悬挑', overhang > 0, `${overhang} 格`);

const values = [0, 0.25, 0.5, 0.75, 1];
for (const v of values) {
  const packed = packLightVertex(v, v);
  const [s, b] = unpackLightVertex(packed);
  assert.ok(Math.abs(s - v) <= 1 / 15, `sky 量化误差 ${v} -> ${s}`);
  assert.ok(Math.abs(b - v) <= 1 / 15, `block 量化误差 ${v} -> ${b}`);
}
ok('8 位光照打包往返误差 <= 1 档', true);
ok('光照高级 / 低级半字节布局', packLightVertex(1, 0) === 240 && packLightVertex(0, 1) === 15);

const packed = packVertexLights(new Float32Array([1, 0, 0, 1, 0.5, 0.5]));
ok('顶点光照批量打包', Array.from(packed).join(',') === '240,15,136');
const unpacked = unpackVertexLights(packed);
ok('顶点光照批量解包', unpacked.length === 6 && unpacked[0] === 1 && unpacked[3] === 1 && Math.abs(unpacked[4] - 8 / 15) < 1e-6);

ok('材质包文件名映射', nameToTile('grass_top.png') === 'grass_top');
ok('Java 1.13+ 资源包路径与别名',
  nameToTile('assets/minecraft/textures/block/grass_block_top.png') === 'grass_top');
ok('原版橡木纹理保持同名匹配',
  nameToTile('assets/minecraft/textures/block/oak_planks.png') === 'oak_planks' &&
  nameToTile('assets/minecraft/textures/block/leaves_oak.png') === 'oak_leaves');
ok('Bedrock 橡木纹理别名',
  nameToTile('textures/blocks/log_oak.png') === 'log_side' &&
  nameToTile('textures/blocks/planks_oak.png') === 'oak_planks');
ok('草丛侧面叠加层不会覆盖最终纹理',
  tileForPath('assets/minecraft/textures/block/grass_block_side_overlay.png',
    new Set(['grass_side'])) === null);
ok('资源包清单相对路径归一化',
  normalizeZipPath('assets/pack/pack.json', './textures/stone.png') === 'assets/pack/textures/stone.png' &&
  normalizeZipPath('pack.json', 'textures/stone.png') === 'textures/stone.png');
const filtered = filterKnownTiles(['stone', 'nope.png', 'grass_block_side_overlay.png'],
  new Set(['stone', 'grass_top', 'grass_side']));
ok('材质包匹配统计', filtered.known.join(',') === 'stone' && filtered.missed.join(',') === 'nope.png');

console.log(`3D experiments PASS (${passed})`);