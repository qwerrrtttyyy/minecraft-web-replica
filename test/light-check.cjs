/**
 * 光照纯逻辑回归（不需要 WebGL / three 运行时）。
 * 运行：npm run test:light
 *
 * 用最小 World/Chunk 替身驱动 LightEngine，验证天空光列、方块光衰减、
 * 跨区块传播以及放置/破坏后的增量回收。
 */
const assert = require('node:assert');
const { LightEngine } = require('./terrain-logic/world/light.js');
const { BlockRegistry, registerBuiltinBlocks } = require('./terrain-logic/world/blocks.js');

const CS = 16;
const H = 80;
const SURFACE = 32;

const reg = new BlockRegistry();
registerBuiltinBlocks(reg);
const stone = reg.byNameGet('stone').id;
const torch = reg.byNameGet('torch').id;
const lantern = reg.byNameGet('jack_o_lantern').id;

const chunks = new Map();
const key = (cx, cz) => `${cx},${cz}`;
function makeChunk(cx, cz) {
  const data = new Uint8Array(CS * CS * H);
  for (let lz = 0; lz < CS; lz++) {
    for (let lx = 0; lx < CS; lx++) {
      for (let y = 0; y <= SURFACE; y++) data[(y * CS + lz) * CS + lx] = stone;
    }
  }
  const chunk = {
    cx, cz, data,
    sky: new Uint8Array(CS * CS * H),
    block: new Uint8Array(CS * CS * H),
    generated: true,
    lit: false,
    idx(x, y, z) { return (y * CS + z) * CS + x; },
  };
  chunks.set(key(cx, cz), chunk);
  return chunk;
}
const world = {
  registry: reg,
  dirty: new Set(),
  getChunk(cx, cz) { return chunks.get(key(cx, cz)); },
};
const light = new LightEngine(world);

let passed = 0;
const ok = (name, cond, extra = '') => {
  assert.ok(cond, `${name} ${extra}`);
  passed++;
  console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
};

const center = makeChunk(0, 0);
for (const [cx, cz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) makeChunk(cx, cz);
for (const chunk of chunks.values()) light.initChunk(chunk);

ok('露天列天空光为 15', center.sky[center.idx(8, SURFACE + 1, 8)] === 15);
ok('地下天空光为 0', center.sky[center.idx(8, 2, 8)] === 0);
ok('不透明方块自身无天空光', center.sky[center.idx(8, SURFACE, 8)] === 0);

// 火把：自身 14，向外每格 -1
const ty = SURFACE + 2;
center.data[center.idx(8, ty, 8)] = torch;
light.updateBlock(8, ty, 8, 0, torch);
ok('火把自身方块光 14', center.block[center.idx(8, ty, 8)] === 14);
ok('距离 1 衰减为 13', center.block[center.idx(9, ty, 8)] === 13);
ok('距离 5 衰减为 9', center.block[center.idx(13, ty, 8)] === 9);

center.data[center.idx(8, ty, 8)] = 0;
light.updateBlock(8, ty, 8, torch, 0);
ok('移除火把后光照归零', center.block[center.idx(8, ty, 8)] === 0 &&
  center.block[center.idx(13, ty, 8)] === 0);

// 跨区块传播
center.data[center.idx(15, ty, 8)] = torch;
light.updateBlock(15, ty, 8, 0, torch);
ok('火光跨区块传播', chunks.get(key(1, 0)).block[chunks.get(key(1, 0)).idx(0, ty, 8)] === 13,
  `x16=${chunks.get(key(1, 0)).block[chunks.get(key(1, 0)).idx(0, ty, 8)]}`);
center.data[center.idx(15, ty, 8)] = 0;
light.updateBlock(15, ty, 8, torch, 0);
ok('跨区块移除后归零', chunks.get(key(1, 0)).block[chunks.get(key(1, 0)).idx(0, ty, 8)] === 0);

// 南瓜灯（不透明光源）：自身 15，邻居 14
center.data[center.idx(4, ty, 4)] = lantern;
light.updateBlock(4, ty, 4, 0, lantern);
ok('南瓜灯自身方块光 15', center.block[center.idx(4, ty, 4)] === 15);
ok('南瓜灯向邻居发光', center.block[center.idx(5, ty, 4)] === 14);

// 遮挡：在露天列放一块石头会清掉该格天空光，移除后恢复
const roofY = SURFACE + 4;
const before = center.sky[center.idx(2, roofY, 2)];
center.data[center.idx(2, roofY, 2)] = stone;
light.updateBlock(2, roofY, 2, 0, stone);
const covered = center.sky[center.idx(2, roofY, 2)];
center.data[center.idx(2, roofY, 2)] = 0;
light.updateBlock(2, roofY, 2, stone, 0);
const restored = center.sky[center.idx(2, roofY, 2)];
ok('放石头清掉自身天空光', before === 15 && covered === 0, `${before}→${covered}`);
ok('移除石头后天空光恢复', restored === 15, `restored=${restored}`);
ok('光照变化会标记区块脏', world.dirty.size > 0);

// ---- 遮挡回收：封住天窗后，房间内的天空光必须整体退掉（含跨区块） ----
// 回归 v1.3.1：旧实现只清「本列」，水平扩散出去的格子保留旧亮度，
// 表现为封死天窗后房间依旧亮堂；同时列内等亮度梯度（都是 15）也收不掉。
const roofY2 = SURFACE + 5;
for (const [cx, cz] of [[2, 2], [3, 2]]) makeChunk(cx, cz);
const at = (gx, gz) => chunks.get(key(gx >> 4, gz >> 4));
const gsky = (gx, y, gz) => { const c = at(gx, gz); return c.sky[c.idx(gx & 15, y, gz & 15)]; };
/** 模拟 world.setBlock：先落 data，再走增量光照 */
function gedit(gx, y, gz, v) {
  const c = at(gx, gz);
  const old = c.data[c.idx(gx & 15, y, gz & 15)];
  c.data[c.idx(gx & 15, y, gz & 15)] = v;
  light.updateBlock(gx, y, gz, old, v);
}
// 房间：x 44~52（跨 48 处的区块边界）、z 36~38、y SURFACE+1~+4，外壳石，天窗开在 (52,·,37)
for (let gx = 43; gx <= 53; gx++) {
  for (let gz = 35; gz <= 39; gz++) {
    for (let y = SURFACE; y <= roofY2; y++) {
      const inner = gx >= 44 && gx <= 52 && gz >= 36 && gz <= 38 && y > SURFACE && y < roofY2;
      at(gx, gz).data[at(gx, gz).idx(gx & 15, y, gz & 15)] = inner ? 0 : stone;
    }
  }
}
for (let y = roofY2; y < H; y++) at(52, 37).data[at(52, 37).idx(52 & 15, y, 37 & 15)] = 0;
light.initChunk(chunks.get(key(2, 2)));
light.initChunk(chunks.get(key(3, 2)));

const shaftFloor = gsky(52, SURFACE + 1, 37);
const roomNear = gsky(48, SURFACE + 1, 37);
const roomFar = gsky(44, SURFACE + 1, 37);
ok('天窗井底为露天亮度', shaftFloor === 15, `got=${shaftFloor}`);
ok('密封房间由天窗点亮（跨区块）', roomNear > 0 && roomFar < roomNear,
  `near=${roomNear} far=${roomFar}`);

gedit(52, roofY2, 37, stone);
let residual = 0;
for (let gx = 44; gx <= 52; gx++) {
  for (let gz = 36; gz <= 38; gz++) {
    for (let y = SURFACE + 1; y < roofY2; y++) if (gsky(gx, y, gz) > 0) residual++;
  }
}
ok('封住天窗后房间内无残留天空光', residual === 0, `残留 ${residual} 格`);
ok('封住天窗后井底天空光归零', gsky(52, SURFACE + 1, 37) === 0);

gedit(52, roofY2, 37, 0);
ok('重新挖开后天窗亮度可恢复（幂等）',
  gsky(52, SURFACE + 1, 37) === shaftFloor && gsky(48, SURFACE + 1, 37) === roomNear &&
  gsky(44, SURFACE + 1, 37) === roomFar,
  `${gsky(52, SURFACE + 1, 37)}/${gsky(48, SURFACE + 1, 37)}/${gsky(44, SURFACE + 1, 37)}`);

// 半透明介质落进光井：衰减判据要用「列衰减」，空气→树叶 opacity 相同但列衰减 +1
gedit(52, roofY2 + 1, 37, reg.byNameGet('oak_leaves').id);
ok('树叶落进光井使井底变暗', gsky(52, SURFACE + 1, 37) === 14, `got=${gsky(52, SURFACE + 1, 37)}`);
gedit(52, roofY2 + 1, 37, 0);
ok('取走树叶后井底回到 15', gsky(52, SURFACE + 1, 37) === 15);

console.log(`PASS 光照回归：${passed} 组断言全部通过`);
