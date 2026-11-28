/**
 * 静态结构纯数据模板回归（需先 npm run test:snapshot）。
 *
 * 当前覆盖：模板表结构 / 18 群系配色覆盖与回退 / 模板边界与确定性 /
 * 禁止矿石与 glowstone。生成级断言由后续任务补入。
 */
const assert = require('node:assert');
const {
  STRUCTURE_KINDS, STRUCTURE_PALETTES, STRUCTURE_CELL, STRUCTURE_CHANCE,
  STRUCTURE_SALT, STRUCTURE_DEPTH, MINE_PALETTE, DUNGEON_PALETTE,
  paletteFor, buildStructure, STRUCTURE_BLOCK_NAMES,
} = require('./terrain-logic/world/structures.js');

let passed = 0;
const ok = (name, cond, extra = '') => {
  assert.ok(cond, `${name}${extra ? ' — ' + extra : ''}`);
  passed++;
  console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
};

const LAND_BIOMES = [
  'plains', 'forest', 'taiga', 'alpine', 'mesa', 'swamp', 'savanna', 'cherry',
  'jungle', 'snowy_tundra', 'mushroom_grove', 'bamboo_grove',
  'dark_forest', 'birch_forest', 'snowy_taiga', 'desert',
];
const BANNED = [
  'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'copper_ore',
  'redstone_ore', 'lapis_ore', 'emerald_ore', 'glowstone',
];

console.log('静态结构模板回归');

// 1) 模板种类与常量
ok('三种结构种类顺序固定',
  assert.deepStrictEqual(STRUCTURE_KINDS, ['village_house', 'mineshaft', 'dungeon']) === undefined);
ok('网格 / 概率 / salt / 深度常量固定',
  STRUCTURE_CELL.village_house === 64 && STRUCTURE_CELL.mineshaft === 96 &&
  STRUCTURE_CELL.dungeon === 80 &&
  STRUCTURE_CHANCE.village_house === 0.32 && STRUCTURE_CHANCE.mineshaft === 0.24 &&
  STRUCTURE_CHANCE.dungeon === 0.28 &&
  STRUCTURE_SALT.village_house === 0x1d01 && STRUCTURE_SALT.mineshaft === 0x1d02 &&
  STRUCTURE_SALT.dungeon === 0x1d03 &&
  STRUCTURE_DEPTH.village_house === 0 && STRUCTURE_DEPTH.mineshaft === 12 &&
  STRUCTURE_DEPTH.dungeon === 9);

// 2) 群系配色覆盖与回退
ok('配色表覆盖 16 个陆地群系且排除 ocean / beach',
  Object.keys(STRUCTURE_PALETTES).length === 16 &&
  LAND_BIOMES.every((b) => !!STRUCTURE_PALETTES[b]) &&
  !STRUCTURE_PALETTES.ocean && !STRUCTURE_PALETTES.beach,
  Object.keys(STRUCTURE_PALETTES).join(','));
ok('森林配色使用橡木', STRUCTURE_PALETTES.forest.wall === 'oak_planks');
ok('未知群系回退橡木配色',
  assert.deepStrictEqual(paletteFor('__unknown__'), STRUCTURE_PALETTES.plains) === undefined);
ok('矿井 / 地牢固定配色分别为木梁圆石与苔石石砖',
  MINE_PALETTE.wall === 'oak_planks' && MINE_PALETTE.floor === 'cobblestone' &&
  DUNGEON_PALETTE.wall === 'mossy_cobblestone' && DUNGEON_PALETTE.floor === 'stone_bricks');

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
      try { assert.deepStrictEqual(a, b); } catch { bad.push(`nondeterministic:${palette.wall}`); }
      for (const blk of a.blocks) {
        if (!Number.isInteger(blk.dx) || blk.dx < 0 || blk.dx >= a.width ||
            !Number.isInteger(blk.dy) || blk.dy < 0 || blk.dy >= a.height ||
            !Number.isInteger(blk.dz) || blk.dz < 0 || blk.dz >= a.depth) {
          bad.push(`oob:${blk.dx},${blk.dy},${blk.dz}`);
        }
        if (!blk.block || !STRUCTURE_BLOCK_NAMES.has(blk.block)) bad.push(`unknown:${blk.block}`);
      }
    }
    ok(`${kind}: 模板非空 / 坐标在界内 / 重复调用一致 / 名称已登记`,
      bad.length === 0, bad.slice(0, 3).join(';'));
  }
}

// 4) 禁止矿石与 glowstone（既有深度 / 群系回归断言不得被结构破坏）
{
  const leaked = [...STRUCTURE_BLOCK_NAMES].filter((n) => BANNED.includes(n));
  ok('模板方块集合不含矿石与 glowstone', leaked.length === 0, leaked.join(','));
}

console.log(`\n${passed} 项通过`);
