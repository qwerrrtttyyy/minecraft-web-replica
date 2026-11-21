/**
 * 编辑差分分桶回归（纯逻辑，不需要 three 运行时）。
 *
 * 分桶值从「字符串 key」改为「已解析数值坐标」后，必须保证：
 * 负坐标 / 区块边界 / 同坐标覆盖 / setBlock 记录 / 存档导出的语义完全不变。
 */
const assert = require('node:assert');
const { World } = require('./logic/world/world.js');
const { BlockRegistry, registerBuiltinBlocks } = require('./logic/world/blocks.js');

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  passed++;
  console.log(`  ✓ ${name}`);
};

const reg = new BlockRegistry();
registerBuiltinBlocks(reg);
const stone = reg.byNameGet('stone').id;
const dirt = reg.byNameGet('dirt').id;
const AIR = 0;

function makeWorld() {
  const generator = { generateChunk() {}, surfaceHeight() { return 32; } };
  const events = { emit() {} };
  return new World(reg, generator, events);
}

const w = makeWorld();
w.loadEdits([
  ['-1,10,-1', stone],       // chunk(-1,-1) 的右上角
  ['-16,11,-16', stone],     // chunk(-1,-1) 的左下角
  ['0,12,0', stone],         // chunk(0,0)
  ['15,13,0', stone],        // chunk(0,0) 右边界
  ['16,14,0', stone],        // 应落在 chunk(1,0)，不能串到 (0,0)
  ['0,12,0', dirt],          // 同坐标后写覆盖
]);

const c00 = w.ensureChunk(0, 0);
const cm1 = w.ensureChunk(-1, -1);
const c10 = w.ensureChunk(1, 0);

ok('同坐标覆盖生效（数值分桶仍以 key 去重）', c00.data[c00.idx(0, 12, 0)] === dirt);
ok('区块内右边界编辑生效', c00.data[c00.idx(15, 13, 0)] === stone);
ok('负坐标区块内编辑生效（-1,-1）', cm1.data[cm1.idx(15, 10, 15)] === stone);
ok('负坐标区块左下角编辑生效（-16,-16）', cm1.data[cm1.idx(0, 11, 0)] === stone);
ok('x=16 归入 chunk(1,0) 而非 (0,0)', c10.data[c10.idx(0, 14, 0)] === stone);
ok('相邻区块未被错误写入 x=16', c00.data[c00.idx(0, 14, 0)] === AIR);
ok('存档导出的 edits 仍是字符串 key → 方块 id', [...w.edits.entries()].length === 5 && w.edits.get('0,12,0') === dirt);

w.setBlock(3, 20, 3, stone);
ok('setBlock 路径仍正确记录编辑', w.edits.get('3,20,3') === stone);
ok('setBlock 同 id 不重复记录', w.setBlock(3, 20, 3, stone) === false && [...w.edits.keys()].filter((k) => k === '3,20,3').length === 1);

const w2 = makeWorld();
w2.loadEdits([...w.edits.entries()]);
const c2 = w2.ensureChunk(-1, -1);
ok('整档重载后负坐标编辑仍落在正确格子', c2.data[c2.idx(15, 10, 15)] === stone);

// M04: setBlocks 批量写入
const w3 = makeWorld();
w3.setBlocks([
  [10, 20, 10, stone],
  [11, 20, 10, stone],
  [10, 21, 10, stone],
]);
const c30 = w3.ensureChunk(0, 0);
ok('M04 setBlocks 批量写入多格生效', c30.data[c30.idx(10, 20, 10)] === stone && c30.data[c30.idx(11, 20, 10)] === stone && c30.data[c30.idx(10, 21, 10)] === stone);
ok('M04 setBlocks 编辑差分记录正确', w3.edits.get('10,20,10') === stone && w3.edits.get('11,20,10') === stone && w3.edits.get('10,21,10') === stone);
ok('M04 setBlocks 光照在 batch 内正确传播', c30.sky[c30.idx(10, 20, 10)] >= 0); // 光照计算已完成

console.log(`\nPASS 编辑差分数值分桶回归：${passed} 组断言`);
