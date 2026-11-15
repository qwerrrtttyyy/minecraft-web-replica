/**
 * 植物生长 / 蔓延 / 枯萎回归（v1.4.1）。
 * 运行：node test/botany-check.cjs（需先 npm run test:snapshot）
 *
 * 用 4×4 区块的平坦测试世界替代地形生成，逐条验证随机刻规则：
 * 甘蔗 / 仙人掌 / 竹子 / 海带长高、小麦分阶段成熟、浆果成熟、树苗长成树，
 * 草方块与花草蔓延、蘑菇在暗处扩散、藤蔓垂挂、睡莲铺水、南瓜藤结瓜，
 * 以及支撑方块被拆后整列枯萎。
 */
const assert = require('node:assert');
const { BlockRegistry, registerBuiltinBlocks } = require('./terrain-logic/world/blocks.js');
const { World } = require('./terrain-logic/world/world.js');
const { Botany } = require('./terrain-logic/world/botany.js');
const { EventService } = require('./terrain-logic/services/events/EventService.js');
const { CHUNK_SIZE: CS } = require('./terrain-logic/core/types.js');

const log = (...a) => console.log(...a);
let passed = 0;
function ok(name, cond, extra = '') {
  assert.ok(cond, `${name} ${extra}`);
  passed++;
  log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
}

/** 平坦世界：y=20 草方块，下面泥土 / 石头，y=0 基岩 */
function makeWorld(seed = 20261115) {
  const reg = new BlockRegistry();
  registerBuiltinBlocks(reg);
  const ids = {
    bedrock: reg.byNameGet('bedrock').id,
    stone: reg.byNameGet('stone').id,
    dirt: reg.byNameGet('dirt').id,
    grass: reg.byNameGet('grass').id,
  };
  const generator = {
    seed,
    surfaceHeight: () => 20,
    biomeAt: () => 'plains',
    generateChunk(_cx, _cz, data) {
      const idx = (x, y, z) => (y * CS + z) * CS + x;
      for (let z = 0; z < CS; z++) {
        for (let x = 0; x < CS; x++) {
          data[idx(x, 0, z)] = ids.bedrock;
          for (let y = 1; y <= 18; y++) data[idx(x, y, z)] = ids.stone;
          data[idx(x, 19, z)] = ids.dirt;
          data[idx(x, 20, z)] = ids.grass;
        }
      }
    },
  };
  const events = new EventService();
  const world = new World(reg, generator, events);
  world.ensureChunk(0, 0);
  const id = (n) => {
    const def = reg.byNameGet(n);
    assert.ok(def, `缺少方块 ${n}`);
    return def.id;
  };
  const botany = new Botany(world, reg, seed, events, { interval: 0.35, attempts: 1, radius: 8 });
  return { reg, events, world, botany, id };
}

const get = (t, x, y, z) => t.world.getBlock(x, y, z);
const put = (t, x, y, z, name) => t.world.setBlock(x, y, z, t.id(name));
const count = (t, name) => {
  const want = t.id(name);
  const data = t.world.getChunk(0, 0).data;
  let n = 0;
  for (const v of data) if (v === want) n++;
  return n;
};
/** 反复在固定坐标执行随机刻，直到条件成立（概率性规则用足够尝试次数收敛） */
function until(t, x, y, z, pred, tries = 4000) {
  for (let i = 0; i < tries; i++) {
    t.botany.tickAt(x, y, z, 1);
    if (pred()) return true;
  }
  return false;
}

log('植物生态随机刻回归（生长 / 蔓延 / 枯萎）');

// 1) 柱状植物：甘蔗 / 仙人掌 / 竹子 / 海带
{
  const t = makeWorld();
  put(t, 5, 21, 5, 'sugar_cane');
  ok('甘蔗长高', until(t, 5, 21, 5, () => get(t, 5, 22, 5) === t.id('sugar_cane')));
  until(t, 5, 21, 5, () => get(t, 5, 23, 5) === t.id('sugar_cane'));
  const caneTop = get(t, 5, 24, 5) === t.id('sugar_cane');
  ok('甘蔗最高 3 格', !caneTop && get(t, 5, 23, 5) === t.id('sugar_cane'));

  put(t, 7, 21, 7, 'cactus');
  ok('仙人掌长高', until(t, 7, 21, 7, () => get(t, 7, 22, 7) === t.id('cactus')));
  until(t, 7, 21, 7, () => get(t, 7, 23, 7) === t.id('cactus'));
  ok('仙人掌最高 3 格', get(t, 7, 24, 7) !== t.id('cactus'));

  put(t, 9, 21, 9, 'bamboo');
  ok('竹子长高', until(t, 9, 21, 9, () => get(t, 9, 22, 9) === t.id('bamboo')));

  // 海带需要上方是水
  put(t, 14, 20, 8, 'sand');
  put(t, 14, 21, 8, 'water');
  put(t, 14, 22, 8, 'water');
  put(t, 14, 23, 8, 'water');
  t.world.setBlock(14, 21, 8, t.id('kelp'));
  ok('海带向上生长', until(t, 14, 21, 8, () => get(t, 14, 22, 8) === t.id('kelp')));
}

// 2) 作物与浆果：阶段推进 / 成熟
{
  const t = makeWorld();
  put(t, 3, 21, 3, 'wheat_seedling');
  ok('麦苗 → 抽穗', until(t, 3, 21, 3, () => get(t, 3, 21, 3) === t.id('wheat_growing')));
  ok('抽穗 → 成熟', until(t, 3, 21, 3, () => get(t, 3, 21, 3) === t.id('wheat')));
  t.botany.tickAt(3, 21, 3, 1);
  ok('成熟小麦不再变化', get(t, 3, 21, 3) === t.id('wheat'));

  put(t, 5, 21, 3, 'sweet_berry_bush');
  ok('甜浆果丛成熟', until(t, 5, 21, 3, () => get(t, 5, 21, 3) === t.id('sweet_berry_bush_ripe')));
}
// 3) 树苗长成对应树种
for (const [sapling, logName, leafName] of [
  ['oak_sapling', 'oak_log', 'oak_leaves'],
  ['birch_sapling', 'birch_log', 'birch_leaves'],
  ['spruce_sapling', 'spruce_log', 'spruce_leaves'],
]) {
  const t = makeWorld();
  put(t, 8, 21, 8, sapling);
  // 清空 5×5 树冠空间，避免被地表其他测试残留阻挡
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      for (let y = 21; y < 40; y++) t.world.setBlock(8 + dx, y, 8 + dz, 0);
    }
  }
  put(t, 8, 21, 8, sapling);
  const grew = until(t, 8, 21, 8, () => get(t, 8, 21, 8) === t.id(logName), 12000);
  ok(`${sapling} 长成${logName}`, grew);
  ok(`${sapling} 生成${leafName}树冠`, count(t, leafName) > 8, `${count(t, leafName)} 片`);
}

// 4) 草方块 / 花草蔓延与支撑枯萎
{
  const t = makeWorld();
  // 泥土被邻接草方块同化
  put(t, 6, 20, 10, 'dirt');
  ok('泥土被草方块同化', until(t, 6, 20, 10, () => get(t, 6, 20, 10) === t.id('grass')));

  // 草方块自然长出草花
  t.world.setBlock(11, 21, 11, 0);
  const grewPlant = until(t, 11, 20, 11, () => {
    const above = get(t, 11, 21, 11);
    return above !== 0 && t.reg.get(above).shape === 'cross';
  });
  ok('草方块上自然长出植物', grewPlant,
    grewPlant ? `${t.reg.get(get(t, 11, 21, 11)).name}` : '');

  // 花向邻近草地蔓延
  put(t, 4, 21, 12, 'poppy');
  const before = count(t, 'poppy');
  ok('虞美人向邻近草地蔓延', until(t, 4, 21, 12, () => count(t, 'poppy') > before, 6000),
    `${before} → ${count(t, 'poppy')}`);

  // 拆掉支撑后随机刻会枯萎
  put(t, 3, 21, 14, 'bluebell');
  t.world.setBlock(3, 20, 14, 0);
  ok('失去支撑的花自动枯萎', t.botany.tickAt(3, 21, 14, 1) && get(t, 3, 21, 14) === 0);
}

// 5) 阴暗处蘑菇扩散
{
  const t = makeWorld();
  // 5×5×3 石室：屋顶 + 四壁封死天光，只留内部空气与草地
  for (let x = 5; x <= 11; x++) {
    for (let z = 5; z <= 11; z++) {
      t.world.setBlock(x, 24, z, t.id('stone'));
      const edge = x === 5 || x === 11 || z === 5 || z === 11;
      for (let y = 21; y <= 23; y++) {
        t.world.setBlock(x, y, z, edge ? t.id('stone') : 0);
      }
    }
  }
  put(t, 8, 21, 8, 'brown_mushroom');
  ok('暗处蘑菇扩散', until(t, 8, 21, 8, () => count(t, 'brown_mushroom') > 1, 8000),
    `${count(t, 'brown_mushroom')} 株，天光 ${t.world.getSkyLight(8, 21, 8)}`);
}

// 6) 藤蔓垂挂 / 睡莲铺水 / 南瓜藤结瓜 / 发光地衣扩散
{
  const t = makeWorld();
  t.world.setBlock(14, 23, 14, t.id('stone'));
  put(t, 14, 22, 14, 'vine');
  ok('藤蔓向下垂挂', until(t, 14, 22, 14, () => get(t, 14, 21, 14) === t.id('vine')));
  for (let i = 0; i < 80; i++) t.botany.tickAt(14, 21, 14, 1);
  ok('垂下的藤蔓由上方藤蔓支撑、不会枯萎', get(t, 14, 21, 14) === t.id('vine'));

  // 5×5 水池，睡莲向邻近水面铺开
  for (let dx = 2; dx <= 6; dx++) {
    for (let dz = 2; dz <= 6; dz++) t.world.setBlock(dx, 20, dz, t.id('water'));
  }
  put(t, 4, 21, 4, 'lily_pad');
  ok('睡莲铺满邻近水面', until(t, 4, 21, 4, () => count(t, 'lily_pad') > 1, 6000),
    `${count(t, 'lily_pad')} 片`);

  put(t, 11, 21, 3, 'pumpkin_stem');
  ok('南瓜藤结出南瓜', until(t, 11, 21, 3, () => {
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) =>
      get(t, 11 + dx, 21, 3 + dz) === t.id('pumpkin'));
  }, 6000));

  // 洞穴壁：封闭石室内部放发光地衣，暗处沿石壁扩散
  for (let x = 1; x <= 7; x++) {
    for (let z = 7; z <= 13; z++) {
      t.world.setBlock(x, 24, z, t.id('stone'));
      const edge = x === 1 || x === 7 || z === 7 || z === 13;
      for (let y = 21; y <= 23; y++) {
        t.world.setBlock(x, y, z, edge ? t.id('stone') : 0);
      }
    }
  }
  put(t, 4, 21, 10, 'glow_lichen');
  ok('发光地衣在暗处扩散', until(t, 4, 21, 10, () => count(t, 'glow_lichen') > 1, 8000),
    `${count(t, 'glow_lichen')} 处，天光 ${t.world.getSkyLight(4, 21, 10)}`);
}

// 7) 生态事件可观测
{
  const t = makeWorld();
  const kinds = new Set();
  t.events.on('plant:grow', (e) => kinds.add(e.kind));
  put(t, 3, 21, 3, 'sugar_cane');
  until(t, 3, 21, 3, () => get(t, 3, 22, 3) === t.id('sugar_cane'));
  put(t, 5, 20, 10, 'dirt');
  until(t, 5, 20, 10, () => get(t, 5, 20, 10) === t.id('grass'));
  ok('plant:grow 事件带 grow / spread 类型',
    kinds.has('grow') && kinds.has('spread'), [...kinds].join(','));
}

// 8) 未加载区块不会被采样（update 不越界）
{
  const t = makeWorld();
  const data = t.world.getChunk(0, 0).data.slice();
  for (let i = 0; i < 20; i++) t.botany.update(0.4, 4000, 4000, 1);
  const after = t.world.getChunk(0, 0).data;
  ok('远处未加载区块不产生随机刻', Buffer.from(data).equals(Buffer.from(after)));
}

log(`\nPASS 植物生态回归：${passed} 组断言全部通过`);
