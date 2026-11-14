/**
 * 地形体系回归（v1.4.0）：方块扩充 + 统一阶段管线 + 群系配置表。
 * 运行：node test/terrain-system-check.cjs（需先 npm run test:snapshot）
 *
 * 与 terrain-check.cjs 的分工：
 * - terrain-check：确定性、洞穴、水面、跨区块树冠、矿脉分层等基础不变量；
 * - terrain-system：新增 10 种方块是否末位追加、生成阶段顺序、群系配置表
 *   是否真正驱动自然生成，以及黏土 / 灰化土 / 仙人掌 / 甘蔗 / 蕨 / 绿宝石
 *   的生成位置约束。
 */
const assert = require('assert');
const {
  DefaultGenerator, DEFAULT_TERRAIN, BIOME_PROFILES, TERRAIN_STAGES,
} = require('./terrain-logic/world/generator.js');
const { BlockRegistry, registerBuiltinBlocks } = require('./terrain-logic/world/blocks.js');
const { CHUNK_SIZE: CS, WORLD_HEIGHT: H, SEA_LEVEL } = require('./terrain-logic/core/types.js');

const idx = (x, y, z) => (y * CS + z) * CS + x;
const log = (...a) => console.log(...a);
let passed = 0;
function ok(name, cond, extra = '') {
  assert.ok(cond, `${name} ${extra}`);
  passed++;
  log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
}

function make(seed, opts) {
  const reg = new BlockRegistry();
  registerBuiltinBlocks(reg);
  return { reg, gen: new DefaultGenerator(seed, reg, opts) };
}
function chunk(gen, cx, cz) {
  const data = new Uint8Array(CS * CS * H);
  gen.generateChunk(cx, cz, data);
  return data;
}

const NEW_BLOCKS = [
  'copper_ore', 'emerald_ore', 'lapis_ore', 'redstone_ore', 'clay',
  'podzol', 'cactus', 'sugar_cane', 'fern', 'granite',
];

log('地形体系回归（方块扩充 + 生成管线 + 群系配置表）');

// 1) 10 种新方块：末位追加、旧 id 稳定、属性可玩
{
  const { reg } = make(1);
  const all = reg.all();
  ok('内置方块总数 56 种', all.length === 56, `${all.length}`);
  ok('黑色羊毛仍为 id 44（旧存档差分有效）', reg.byNameGet('black_wool').id === 44);
  ok('两种新方块 id 55~56 末位追加',
    reg.byNameGet('pumpkin')?.id === 55 && reg.byNameGet('bookshelf')?.id === 56,
    `pumpkin=${reg.byNameGet('pumpkin')?.id} bookshelf=${reg.byNameGet('bookshelf')?.id}`);
  ok('两种新方块纹理与属性完整', ['pumpkin', 'bookshelf'].every((n) => {
    const d = reg.byNameGet(n);
    return d && d.tiles.top && d.tiles.bottom && d.tiles.side &&
      d.shape === 'cube' && d.solid && d.drops.length > 0;
  }));
  ok('10 种新方块 id 45~54 末位追加',
    NEW_BLOCKS.every((n, i) => reg.byNameGet(n)?.id === 45 + i),
    NEW_BLOCKS.map((n) => reg.byNameGet(n).id).join(','));
  ok('新方块都注册了顶 / 底 / 侧纹理',
    NEW_BLOCKS.every((n) => {
      const d = reg.byNameGet(n);
      return d && d.tiles.top && d.tiles.bottom && d.tiles.side;
    }));

  const podzol = reg.byNameGet('podzol');
  ok('灰化土掉落泥土', podzol.drops.length === 1 && podzol.drops[0].name === 'dirt');
  ok('仙人掌是实心立方体，甘蔗 / 蕨是十字植物',
    reg.byNameGet('cactus').shape === 'cube' && reg.byNameGet('cactus').solid &&
    reg.byNameGet('sugar_cane').shape === 'cross' && !reg.byNameGet('sugar_cane').solid &&
    reg.byNameGet('fern').shape === 'cross');
}

// 2) 统一阶段管线 + 群系配置表
{
  const { reg, gen } = make(1);
  ok('生成阶段固定为 columns → ores → trees → decorate',
    JSON.stringify(gen.stageNames) === JSON.stringify(TERRAIN_STAGES) &&
    TERRAIN_STAGES.join('>') === 'columns>ores>trees>decorate',
    gen.stageNames.join(' → '));

  const biomes = ['ocean', 'beach', 'desert', 'plains', 'forest', 'taiga', 'alpine'];
  ok('群系配置表覆盖全部 7 个群系', biomes.every((b) => BIOME_PROFILES[b]));
  ok('针叶林地表配置为灰化土', BIOME_PROFILES.taiga.surface === 'podzol');
  ok('浅海黏土 / 沙漠仙人掌 / 临水甘蔗都在配置表里',
    BIOME_PROFILES.ocean.clayChance > 0 &&
    BIOME_PROFILES.desert.cactusChance > 0 &&
    BIOME_PROFILES.beach.caneChance > 0);
  ok('蕨进入草甸 / 森林 / 针叶林装饰',
    ['plains', 'forest', 'taiga'].every((b) =>
      BIOME_PROFILES[b].plants.some((p) => p.name === 'fern')));
  ok('配置表所有地表 / 填充 / 装饰方块都在注册表',
    biomes.every((b) => {
      const p = BIOME_PROFILES[b];
      return !!reg.byNameGet(p.surface) && !!reg.byNameGet(p.filler) &&
        p.plants.every((pl) => !!reg.byNameGet(pl.name));
    }));
}

// 3) 固定种子下 10 种新方块都能自然生成，且位置符合各自规则
{
  const { reg, gen } = make(777);
  const ids = Object.fromEntries(NEW_BLOCKS.map((n) => [n, reg.byNameGet(n).id]));
  const byName = Object.fromEntries(NEW_BLOCKS.map((n) => [ids[n], n]));
  const counts = Object.fromEntries(NEW_BLOCKS.map((n) => [n, 0]));
  // 矿脉会长到 8 格、且可能顺带漂移 1 格，深度上限按「声明最大 + 矿脉尺寸」留余量
  const depthCap = {
    copper_ore: 50 + 7, lapis_ore: 32 + 5, redstone_ore: 22 + 5,
    emerald_ore: 42 + 4, granite: 44 + 8,
  };
  const bad = [];
  const R = 7;
  const fail = (msg) => { if (bad.length < 20) bad.push(msg); };

  const t0 = Date.now();
  for (let cx = -R; cx <= R; cx++) {
    for (let cz = -R; cz <= R; cz++) {
      const data = chunk(gen, cx, cz);
      for (let y = 0; y < H; y++) {
        for (let lz = 0; lz < CS; lz++) {
          for (let lx = 0; lx < CS; lx++) {
            const v = data[idx(lx, y, lz)];
            const name = byName[v];
            if (!name) continue;
            counts[name]++;
            const wx = cx * CS + lx;
            const wz = cz * CS + lz;
            const h = gen.surfaceHeight(wx, wz);
            const biome = gen.biomeAt(wx, wz);

            if (name === 'emerald_ore' && biome !== 'alpine') {
              fail(`绿宝石不在高山 ${wx},${y},${wz}:${biome}`);
            } else if (depthCap[name]) {
              if (y < 1 || y > depthCap[name]) {
                fail(`${name} 超出深度上限 ${wx},${y},${wz} cap=${depthCap[name]}`);
              }
            } else if (name === 'clay') {
              if (biome !== 'ocean' || y !== h || SEA_LEVEL - h > 3) {
                fail(`黏土不在浅海床 ${wx},${y},${wz} h=${h} ${biome}`);
              }
            } else if (name === 'podzol') {
              if (biome !== 'taiga' || y !== h) {
                fail(`灰化土不在针叶林地表 ${wx},${y},${wz} ${biome}`);
              }
            } else if (name === 'cactus') {
              if (biome !== 'desert' || y <= h || y > h + 3) {
                fail(`仙人掌不在沙漠沙面 ${wx},${y},${wz} h=${h} ${biome}`);
              }
            } else if (name === 'sugar_cane') {
              const near = gen.surfaceHeight(wx + 1, wz) < h ||
                gen.surfaceHeight(wx - 1, wz) < h ||
                gen.surfaceHeight(wx, wz + 1) < h ||
                gen.surfaceHeight(wx, wz - 1) < h;
              if (y <= h || !near) fail(`甘蔗不在临水浅岸 ${wx},${y},${wz} h=${h}`);
            } else if (name === 'fern') {
              if (y !== h + 1 || !['plains', 'forest', 'taiga'].includes(biome)) {
                fail(`蕨不在草甸/森林/针叶林地表 ${wx},${y},${wz} ${biome}`);
              }
            }
          }
        }
      }
    }
  }
  const ms = Date.now() - t0;

  ok('10 种新方块都自然生成', NEW_BLOCKS.every((n) => counts[n] > 0),
    NEW_BLOCKS.map((n) => `${n}×${counts[n]}`).join(' '));
  ok('新方块位置全部符合群系 / 深度规则', bad.length === 0,
    bad.length ? `${bad.length} 处，例如 ${bad[0]}` : '');
  ok('大范围生成无明显性能退化', ms < 15000, `${ms} ms / ${(2 * R + 1) ** 2} 区块`);
}

// 4) 新矿脉同样受 oreRichness 统一控制
{
  const { reg, gen } = make(777, { oreRichness: 0 });
  const oreIds = new Set(['copper_ore', 'emerald_ore', 'lapis_ore', 'redstone_ore', 'granite']
    .map((n) => reg.byNameGet(n).id));
  const data = chunk(gen, 0, 0);
  let n = 0;
  for (const v of data) if (oreIds.has(v)) n++;
  ok('oreRichness=0 同时关闭 5 种新矿脉', n === 0, `${n}`);
  ok('默认参数未被破坏', DEFAULT_TERRAIN.oreRichness === 1 && DEFAULT_TERRAIN.warp > 0);
}

// 5) 新装饰 / 矿脉不破坏「生成顺序无关」
{
  const a = make(777);
  const b = make(777);
  const left = chunk(a.gen, 0, 0);
  chunk(b.gen, 1, 0);
  chunk(b.gen, 0, 1);
  chunk(b.gen, 1, 1);
  const left2 = chunk(b.gen, 0, 0);
  ok('同 seed 且先生成邻区块时结果仍完全一致',
    Buffer.from(left).equals(Buffer.from(left2)));
}

log(`\nPASS 地形体系回归：${passed} 组断言全部通过`);
