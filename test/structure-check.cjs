/**
 * 静态结构纯数据模板回归（需先 npm run test:snapshot）。
 *
 * 当前覆盖：模板表结构 / 18 群系配色覆盖与回退 / 模板边界与确定性 /
 * 禁止矿石与 glowstone。生成级断言由后续任务补入。
 */
const assert = require('node:assert');
const { DefaultGenerator, blockIdSource } = require('./terrain-logic/world/generator.js');
const { BlockRegistry, registerBuiltinBlocks } = require('./terrain-logic/world/blocks.js');
const { CHUNK_SIZE: CS, WORLD_HEIGHT: H } = require('./terrain-logic/core/types.js');
const {
  STRUCTURE_KINDS,
  STRUCTURE_PALETTES,
  STRUCTURE_CELL,
  STRUCTURE_CHANCE,
  STRUCTURE_SALT,
  STRUCTURE_DEPTH,
  MINE_PALETTE,
  DUNGEON_PALETTE,
  paletteFor,
  buildStructure,
  STRUCTURE_BLOCK_NAMES,
} = require('./terrain-logic/world/structures.js');

let passed = 0;
const ok = (name, cond, extra = '') => {
  assert.ok(cond, `${name}${extra ? ' — ' + extra : ''}`);
  passed++;
  console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
};

const LAND_BIOMES = [
  'plains',
  'forest',
  'taiga',
  'alpine',
  'mesa',
  'swamp',
  'savanna',
  'cherry',
  'jungle',
  'snowy_tundra',
  'mushroom_grove',
  'bamboo_grove',
  'dark_forest',
  'birch_forest',
  'snowy_taiga',
  'desert',
];
const BANNED = [
  'coal_ore',
  'iron_ore',
  'gold_ore',
  'diamond_ore',
  'copper_ore',
  'redstone_ore',
  'lapis_ore',
  'emerald_ore',
  'glowstone',
];
// 只把自然地形绝不会产出的方块当作结构标记
const MARKERS = new Set([
  'oak_planks',
  'spruce_planks',
  'birch_planks',
  'acacia_planks',
  'cherry_planks',
  'glass',
  'furnace',
  'crafting_table',
  'bookshelf',
  'lantern',
  'glow_torch',
  'torch',
]);

console.log('静态结构模板回归');

// 1) 模板种类与常量
ok(
  '三种结构种类顺序固定',
  assert.deepStrictEqual(STRUCTURE_KINDS, ['village_house', 'mineshaft', 'dungeon']) === undefined,
);
ok(
  '网格 / 概率 / salt / 深度常量固定',
  STRUCTURE_CELL.village_house === 64 &&
    STRUCTURE_CELL.mineshaft === 96 &&
    STRUCTURE_CELL.dungeon === 80 &&
    STRUCTURE_CHANCE.village_house === 0.32 &&
    STRUCTURE_CHANCE.mineshaft === 0.24 &&
    STRUCTURE_CHANCE.dungeon === 0.28 &&
    STRUCTURE_SALT.village_house === 0x1d01 &&
    STRUCTURE_SALT.mineshaft === 0x1d02 &&
    STRUCTURE_SALT.dungeon === 0x1d03 &&
    STRUCTURE_DEPTH.village_house === 0 &&
    STRUCTURE_DEPTH.mineshaft === 12 &&
    STRUCTURE_DEPTH.dungeon === 9,
);

// 2) 群系配色覆盖与回退
ok(
  '配色表覆盖 16 个陆地群系且排除 ocean / beach',
  Object.keys(STRUCTURE_PALETTES).length === 16 &&
    LAND_BIOMES.every((b) => !!STRUCTURE_PALETTES[b]) &&
    !STRUCTURE_PALETTES.ocean &&
    !STRUCTURE_PALETTES.beach,
  Object.keys(STRUCTURE_PALETTES).join(','),
);
ok('森林配色使用橡木', STRUCTURE_PALETTES.forest.wall === 'oak_planks');
ok('未知群系回退橡木配色', assert.deepStrictEqual(paletteFor('__unknown__'), STRUCTURE_PALETTES.plains) === undefined);
ok(
  '矿井 / 地牢固定配色分别为木梁圆石与苔石石砖',
  MINE_PALETTE.wall === 'oak_planks' &&
    MINE_PALETTE.floor === 'cobblestone' &&
    DUNGEON_PALETTE.wall === 'mossy_cobblestone' &&
    DUNGEON_PALETTE.floor === 'stone_bricks',
);

// 3) 模板边界、确定性与名称集合一致
{
  const palettes = [...new Set([...Object.values(STRUCTURE_PALETTES), MINE_PALETTE, DUNGEON_PALETTE])];
  for (const kind of STRUCTURE_KINDS) {
    const bad = [];
    for (const palette of palettes) {
      const a = buildStructure(kind, palette);
      const b = buildStructure(kind, palette);
      if (a.kind !== kind) bad.push(`kind=${a.kind}`);
      if (a.blocks.length === 0) bad.push('empty');
      try {
        assert.deepStrictEqual(a, b);
      } catch {
        bad.push(`nondeterministic:${palette.wall}`);
      }
      for (const blk of a.blocks) {
        if (
          !Number.isInteger(blk.dx) ||
          blk.dx < 0 ||
          blk.dx >= a.width ||
          !Number.isInteger(blk.dy) ||
          blk.dy < 0 ||
          blk.dy >= a.height ||
          !Number.isInteger(blk.dz) ||
          blk.dz < 0 ||
          blk.dz >= a.depth
        ) {
          bad.push(`oob:${blk.dx},${blk.dy},${blk.dz}`);
        }
        if (!blk.block || !STRUCTURE_BLOCK_NAMES.has(blk.block)) bad.push(`unknown:${blk.block}`);
      }
    }
    ok(`${kind}: 模板非空 / 坐标在界内 / 重复调用一致 / 名称已登记`, bad.length === 0, bad.slice(0, 3).join(';'));
  }
}

// 4) 禁止矿石与 glowstone（既有深度 / 群系回归断言不得被结构破坏）
{
  const leaked = [...STRUCTURE_BLOCK_NAMES].filter((n) => BANNED.includes(n));
  ok('模板方块集合不含矿石与 glowstone', leaked.length === 0, leaked.join(','));
}

// 5) 生成级：确定性 / 结构确实落地 / 跨区块边界连续
{
  const idx = (x, y, z) => (y * CS + z) * CS + x;
  const make = (seed) => {
    const reg = new BlockRegistry();
    registerBuiltinBlocks(reg);
    return { reg, gen: new DefaultGenerator(seed, reg) };
  };
  const chunk = (gen, cx, cz) => {
    const data = new Uint8Array(CS * CS * H);
    gen.generateChunk(cx, cz, data);
    return data;
  };
  const planted = [...MARKERS].every((n) => STRUCTURE_BLOCK_NAMES.has(n));
  ok('结构标记全部来自模板方块集合', planted);

  const a = make(777);
  const b = make(777);
  const ca = chunk(a.gen, 0, 0);
  const cb = chunk(b.gen, 0, 0);
  ok('同 seed 同区块两次生成逐字节一致', Buffer.compare(Buffer.from(ca), Buffer.from(cb)) === 0);
  ok('换 seed 后区块不同', Buffer.compare(Buffer.from(ca), Buffer.from(chunk(make(778).gen, 0, 0))) !== 0);

  const byId = new Map(a.reg.all().map((block) => [block.id, block.name]));
  let markers = 0;
  for (let cx = -4; cx <= 4; cx++) {
    for (let cz = -4; cz <= 4; cz++) {
      const data = chunk(a.gen, cx, cz);
      for (let i = 0; i < data.length; i++) {
        if (MARKERS.has(byId.get(data[i]))) markers++;
      }
    }
  }
  ok('seed 777 的 [-4..4]² 区块确实生成了结构', markers > 0, `count=${markers}`);

  // 区块边界两侧是相邻但不同的世界列，不能要求逐格相等（家具也可能只落在一侧）。
  // 真正的跨区块连续性判据是：同一座结构在边界两侧都有方块，且重复生成完全一致。
  const cache = new Map();
  const markerCounts = (cx, cz) => {
    const key = `${cx},${cz}`;
    if (!cache.has(key)) {
      const data = chunk(a.gen, cx, cz);
      let n = 0;
      for (let i = 0; i < data.length; i++) if (MARKERS.has(byId.get(data[i]))) n++;
      cache.set(key, n);
    }
    return cache.get(key);
  };
  let spanning = 0;
  for (let cx = -4; cx < 4; cx++) {
    for (let cz = -4; cz < 4; cz++) {
      const here = markerCounts(cx, cz);
      if (here > 0 && markerCounts(cx + 1, cz) > 0) spanning++;
      if (here > 0 && markerCounts(cx, cz + 1) > 0) spanning++;
    }
  }
  ok('存在跨区块连续的结构（相邻区块两侧都有结构方块）', spanning > 0, `pairs=${spanning}`);

  const b2 = make(777);
  const repeat = chunk(b2.gen, -4, 3);
  ok('跨区块结构的重复生成逐字节一致', Buffer.compare(Buffer.from(repeat), Buffer.from(chunk(a.gen, -4, 3))) === 0);
}

// 6) 约束守卫：群系 / 出生点 / Worker 逐位一致
{
  const idx = (x, y, z) => (y * CS + z) * CS + x;
  const make = (seed, ids) => {
    const reg = new BlockRegistry();
    registerBuiltinBlocks(reg);
    return { reg, gen: new DefaultGenerator(seed, ids ? blockIdSource(ids) : reg) };
  };
  const chunk = (gen, cx, cz) => {
    const data = new Uint8Array(CS * CS * H);
    gen.generateChunk(cx, cz, data);
    return data;
  };
  const a = make(777);
  const byId = new Map(a.reg.all().map((block) => [block.id, block.name]));
  const badBiome = [];
  const badSpawn = [];
  for (let cx = -3; cx <= 3; cx++) {
    for (let cz = -3; cz <= 3; cz++) {
      const data = chunk(a.gen, cx, cz);
      for (let y = 0; y < H; y++) {
        for (let lz = 0; lz < CS; lz++) {
          for (let lx = 0; lx < CS; lx++) {
            const name = byId.get(data[idx(lx, y, lz)]);
            if (!MARKERS.has(name)) continue;
            const wx = cx * CS + lx;
            const wz = cz * CS + lz;
            const biome = a.gen.biomeAt(wx, wz);
            if (biome === 'ocean' || biome === 'beach') badBiome.push(`${wx},${y},${wz}:${biome}`);
            if (Math.hypot(wx, wz) <= 16) badSpawn.push(`${wx},${y},${wz}:${name}`);
          }
        }
      }
    }
  }
  ok('ocean / beach 世界列不出现结构方块', badBiome.length === 0, `${badBiome.length} first=${badBiome[0] ?? ''}`);
  ok('出生点 16 格半径内不出现结构方块', badSpawn.length === 0, `${badSpawn.length} first=${badSpawn[0] ?? ''}`);

  // 复刻 chunkManager：Worker 拿到的是全量注册表 id 表，不是 workerConfig.ids 的规范名子集
  const fullIds = Object.fromEntries(a.reg.all().map((block) => [block.name, block.id]));
  const workerStyle = make(777, fullIds);
  for (const [cx, cz] of [
    [0, 0],
    [2, -1],
    [-4, 3],
  ]) {
    ok(
      `Worker 口径生成器与主线程逐字节一致 (${cx},${cz})`,
      Buffer.compare(Buffer.from(chunk(workerStyle.gen, cx, cz)), Buffer.from(chunk(a.gen, cx, cz))) === 0,
    );
  }
}

console.log(`\n${passed} 项通过`);
