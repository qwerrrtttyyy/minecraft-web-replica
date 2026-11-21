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
const assert = require('node:assert');
const {
  DefaultGenerator, DEFAULT_TERRAIN, BIOME_PROFILES, TERRAIN_STAGES,
} = require('./terrain-logic/world/generator.js');
const { BlockRegistry, registerBuiltinBlocks } = require('./terrain-logic/world/blocks.js');
const { CHUNK_SIZE: CS, WORLD_HEIGHT: H, SEA_LEVEL } = require('./terrain-logic/core/types.js');

const idx = (x, y, z) => (y * CS + z) * CS + x;
const { levelOf, nextId: composterNext, harvestOf } = require('./terrain-logic/world/compost.js');
const { EntityManager } = require('./terrain-logic/entity/entity.js');
const THREE = require('three');

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

// v1.4.1 植物大扩充：id 57 起末位追加（35 种）
const PLANT_BLOCKS = [
  'bluebell', 'allium', 'azure_bluet', 'oxeye_daisy', 'cornflower',
  'lily_of_the_valley', 'tulip_red', 'tulip_orange', 'tulip_white', 'tulip_pink',
  'sunflower', 'lilac', 'rose_bush', 'peony', 'tall_fern',
  'vine', 'lily_pad', 'seagrass', 'kelp', 'bamboo', 'glow_lichen', 'moss_carpet',
  'wheat_seedling', 'wheat_growing', 'wheat', 'sweet_berry_bush', 'sweet_berry_bush_ripe',
  'pumpkin_stem', 'oak_sapling', 'birch_sapling', 'spruce_sapling',
  'birch_log', 'birch_leaves', 'spruce_log', 'spruce_leaves',
];
const NATURAL_PLANTS = [
  'birch_log', 'birch_leaves', 'spruce_log', 'spruce_leaves', 'seagrass', 'kelp',
  'lily_pad', 'pumpkin', 'bluebell', 'allium', 'azure_bluet', 'oxeye_daisy',
  'cornflower', 'lily_of_the_valley', 'tulip_red', 'tulip_orange', 'tulip_white',
  'tulip_pink', 'sunflower', 'lilac', 'rose_bush', 'peony', 'tall_fern', 'sweet_berry_bush',
  // 群系扩充（v1.5.1）：新群系的乔木 / 地表方块也属于自然植物
  'acacia_log', 'acacia_leaves', 'cherry_log', 'cherry_leaves',
];

log('地形体系回归（方块扩充 + 生成管线 + 群系配置表）');

// 1) 10 种新方块：末位追加、旧 id 稳定、属性可玩
{
  const { reg } = make(1);
  const all = reg.all();
  ok('内置方块总数 112 种（v1.6 追加 9 个堆肥桶方块）',
    all.length === 112, `${all.length}`);
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

  ok('35 种植物 id 57~91 连续末位追加',
    PLANT_BLOCKS.every((n, i) => reg.byNameGet(n)?.id === 57 + i),
    `${PLANT_BLOCKS[0]}=${reg.byNameGet(PLANT_BLOCKS[0])?.id}..${PLANT_BLOCKS.at(-1)}=${reg.byNameGet(PLANT_BLOCKS.at(-1))?.id}`);
  ok('所有新植物都注册了非空纹理',
    PLANT_BLOCKS.every((n) => {
      const d = reg.byNameGet(n);
      return d && d.tiles.top && d.tiles.bottom && d.tiles.side;
    }));
  ok('树苗 / 作物 / 浆果是十字植物，三种原木是实心立方体',
    ['oak_sapling', 'birch_sapling', 'spruce_sapling', 'wheat_seedling', 'sweet_berry_bush']
      .every((n) => reg.byNameGet(n).shape === 'cross' && !reg.byNameGet(n).solid) &&
    ['birch_log', 'spruce_log'].every((n) => reg.byNameGet(n).shape === 'cube' && reg.byNameGet(n).solid));
  ok('成熟小麦掉种子、成熟浆果掉甜浆果',
    reg.byNameGet('wheat').drops.some((d) => d.name === 'item:wheat_seeds') &&
    reg.byNameGet('sweet_berry_bush_ripe').drops.some((d) => d.name === 'item:sweet_berries'));
  ok('草丛掉小麦种子，三种树叶各掉对应树苗',
    reg.byNameGet('tall_grass').drops.some((d) => d.name === 'item:wheat_seeds') &&
    reg.byNameGet('oak_leaves').drops.some((d) => d.name === 'oak_sapling') &&
    reg.byNameGet('birch_leaves').drops.some((d) => d.name === 'birch_sapling') &&
    reg.byNameGet('spruce_leaves').drops.some((d) => d.name === 'spruce_sapling'));
  ok('发光地衣是唯一会发光的植物（7 级）',
    reg.byNameGet('glow_lichen').lightEmission === 7 &&
    reg.byNameGet('bluebell').lightEmission === 0);
  ok('海草 / 海带标记为水生植物（穿过时仍按入水处理）',
    reg.byNameGet('seagrass').waterPlant === true && reg.byNameGet('kelp').waterPlant === true &&
    reg.byNameGet('vine').waterPlant !== true);

  const { ITEMS } = require('./terrain-logic/player/survival.js');
  ok('种子 / 浆果 / 花蜜物品注册完整',
    ITEMS.wheat_seeds.plant === 'wheat_seedling' &&
    ITEMS.sweet_berries.plant === 'sweet_berry_bush' && ITEMS.sweet_berries.food > 0 &&
    ITEMS.nectar.food > 0 && ITEMS.nectar.tile === 'nectar');
}

// 2) 统一阶段管线 + 群系配置表
{
  const { reg, gen } = make(1);
  ok('生成阶段固定为 columns → ores → trees → decorate',
    JSON.stringify(gen.stageNames) === JSON.stringify(TERRAIN_STAGES) &&
    TERRAIN_STAGES.join('>') === 'columns>ores>trees>decorate',
    gen.stageNames.join(' → '));

  const biomes = ['ocean', 'beach', 'desert', 'plains', 'forest', 'taiga', 'alpine',
    'mesa', 'swamp', 'savanna', 'cherry'];
  ok('群系配置表覆盖全部 11 个群系', biomes.every((b) => BIOME_PROFILES[b]));
  ok('针叶林地表配置为灰化土', BIOME_PROFILES.taiga.surface === 'podzol');
  ok('浅海黏土 / 沙漠仙人掌 / 临水甘蔗都在配置表里',
    BIOME_PROFILES.ocean.clayChance > 0 &&
    BIOME_PROFILES.desert.cactusChance > 0 &&
    BIOME_PROFILES.beach.caneChance > 0);
  ok('蕨进入草甸 / 森林 / 针叶林装饰',
    ['plains', 'forest', 'taiga'].every((b) =>
      BIOME_PROFILES[b].plants.some((p) => p.name === 'fern')));
  ok('草甸新增 9 种花卉且全部由配置表驱动',
    ['azure_bluet', 'oxeye_daisy', 'cornflower', 'tulip_red', 'tulip_orange',
      'tulip_white', 'tulip_pink', 'bluebell', 'allium', 'sunflower']
      .every((n) => BIOME_PROFILES.plains.plants.some((p) => p.name === n)));
  ok('森林按权重混交橡树 / 白桦，针叶林与高山为云杉',
    BIOME_PROFILES.forest.trees.some((t) => t.species === 'birch') &&
    BIOME_PROFILES.forest.trees.some((t) => t.species === 'oak') &&
    BIOME_PROFILES.taiga.trees.every((t) => t.species === 'spruce') &&
    BIOME_PROFILES.alpine.trees.every((t) => t.species === 'spruce'));
  ok('海洋配置海草 / 海带与睡莲',
    BIOME_PROFILES.ocean.waterPlants.length === 2 &&
    BIOME_PROFILES.ocean.waterPlantChance > 0 && BIOME_PROFILES.ocean.lilyChance > 0);
  ok('草甸 / 森林配置野生南瓜', BIOME_PROFILES.plains.pumpkinChance > 0 && BIOME_PROFILES.forest.pumpkinChance > 0);
  ok('配置表所有地表 / 填充 / 装饰 / 树种 / 水生方块都在注册表',
    biomes.every((b) => {
      const p = BIOME_PROFILES[b];
      return !!reg.byNameGet(p.surface) && !!reg.byNameGet(p.filler) &&
        p.plants.every((pl) => !!reg.byNameGet(pl.name)) &&
        (p.trees ?? []).every((t) => !!reg.byNameGet(
          t.species === 'birch' ? 'birch_log' : t.species === 'spruce' ? 'spruce_log'
            : t.species === 'acacia' ? 'acacia_log' : t.species === 'cherry' ? 'cherry_log' : 'oak_log',
        )) &&
        (p.waterPlants ?? []).every((pl) => !!reg.byNameGet(pl.name));
    }));
  ok('恶地 / 沼泥 / 干草原 / 樱花林 4 个新群系地貌规则',
    BIOME_PROFILES.mesa.surface === 'red_sand' &&
    BIOME_PROFILES.mesa.strata?.[0] === 'terracotta_red' &&
    BIOME_PROFILES.mesa.strata?.length >= 2 &&
    BIOME_PROFILES.swamp.surface === 'mud' &&
    BIOME_PROFILES.savanna.surface === 'dry_grass' &&
    BIOME_PROFILES.cherry.trees?.[0].species === 'cherry');
  ok('新群系可达：seed 777 的 ±7 区块内 4 个群系都有地表实例',
    (() => {
      const gen = new DefaultGenerator(777, reg);
      const seen = new Set();
      for (let x = -112; x < 112; x += 4) {
        for (let z = -112; z < 112; z += 4) seen.add(gen.biomeAt(x, z));
      }
      return ['mesa', 'swamp', 'savanna', 'cherry'].every((b) => seen.has(b));
    })());
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
              if (!['desert', 'mesa'].includes(biome) || y <= h || y > h + 3) {
                fail(`仙人掌不在沙质地貌 ${wx},${y},${wz} h=${h} ${biome}`);
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

// 3b) v1.4.1 自然植物：固定种子 ±7 区块内全部出现，且位置符合规则
{
  const { reg, gen } = make(777);
  const ids = Object.fromEntries(NATURAL_PLANTS.map((n) => [n, reg.byNameGet(n).id]));
  const byName = Object.fromEntries(NATURAL_PLANTS.map((n) => [ids[n], n]));
  const counts = Object.fromEntries(NATURAL_PLANTS.map((n) => [n, 0]));
  const bad = [];
  const fail = (msg) => { if (bad.length < 12) bad.push(msg); };
  const R = 7;

  for (let cx = -R; cx <= R; cx++) {
    for (let cz = -R; cz <= R; cz++) {
      const data = chunk(gen, cx, cz);
      for (let y = 0; y < H; y++) {
        for (let lz = 0; lz < CS; lz++) {
          for (let lx = 0; lx < CS; lx++) {
            const name = byName[data[idx(lx, y, lz)]];
            if (!name) continue;
            counts[name]++;
            const wx = cx * CS + lx;
            const wz = cz * CS + lz;
            const h = gen.surfaceHeight(wx, wz);
            const biome = gen.biomeAt(wx, wz);
            if (name === 'birch_log' || name === 'spruce_log') {
              const okBiome = name === 'birch_log' ? biome === 'forest' : (biome === 'taiga' || biome === 'alpine');
              if (!okBiome || y <= h) fail(`${name} 不在正确群系 ${wx},${y},${wz} ${biome}`);
            } else if (name === 'acacia_log' || name === 'acacia_leaves' ||
              name === 'cherry_log' || name === 'cherry_leaves') {
              // 树冠可跨区块伸进邻区块（既有设计），断言只限高度，不限生成区块群系
              if (y <= h) fail(`${name} 出现在树冠高度以下 ${wx},${y},${wz} h=${h}`);
            } else if (name === 'birch_leaves' || name === 'spruce_leaves') {
              if (y <= h) fail(`${name} 出现在树冠高度以下 ${wx},${y},${wz} h=${h}`);
            } else if (name === 'seagrass' || name === 'kelp') {
              if (biome !== 'ocean' || y <= h || y > SEA_LEVEL) {
                fail(`${name} 不在浅海床 ${wx},${y},${wz} h=${h} ${biome}`);
              }
            } else if (name === 'lily_pad') {
              if (biome !== 'ocean' || y !== SEA_LEVEL + 1) {
                fail(`睡莲不在海面 ${wx},${y},${wz} ${biome}`);
              }
            } else if (name === 'pumpkin') {
              if (!['plains', 'forest'].includes(biome) || y !== h + 1) {
                fail(`南瓜不在草甸/森林地表 ${wx},${y},${wz} h=${h} ${biome}`);
              }
            } else if (name === 'sweet_berry_bush') {
              if (biome !== 'taiga' || y !== h + 1) fail(`甜浆果丛不在针叶林 ${wx},${y},${wz} ${biome}`);
            } else if (y !== h + 1 || !['plains', 'forest', 'taiga'].includes(biome)) {
              fail(`${name} 不在草甸/森林/针叶林地表 ${wx},${y},${wz} ${biome}`);
            }
          }
        }
      }
    }
  }

  ok('28 种自然植物 / 树种全部生成',
    NATURAL_PLANTS.every((n) => counts[n] > 0),
    NATURAL_PLANTS.map((n) => `${n}×${counts[n]}`).join(' '));
  ok('自然植物位置全部符合群系 / 高度 / 水位规则', bad.length === 0,
    bad.length ? `${bad.length} 处，例如 ${bad[0]}` : '');
}

// 3c) 新群系地貌方块（terracotta / red_sand / mud / dry_grass）生成在对应群系表面
{
  const { reg, gen } = make(777);
  const counts = Object.fromEntries([
    'terracotta_red', 'terracotta_orange', 'terracotta_yellow',
    'terracotta_white', 'terracotta_blue', 'red_sand', 'mud', 'dry_grass',
  ].map((n) => [n, 0]));
  const bad = [];
  const fail = (msg) => { if (bad.length < 16) bad.push(msg); };
  const R = 7;
  for (let cx = -R; cx <= R; cx++) {
    for (let cz = -R; cz <= R; cz++) {
      const data = chunk(gen, cx, cz);
      for (let lz = 0; lz < CS; lz++) {
        for (let lx = 0; lx < CS; lx++) {
          const wx = cx * CS + lx;
          const wz = cz * CS + lz;
          const h = gen.surfaceHeight(wx, wz);
          const biome = gen.biomeAt(wx, wz);
          const top = data[idx(lx, h, lz)];
          const topName = reg.get(top).name;
          // terracotta 在 mesa 地表(red_sand)下层的 strata 层里，这里扫 y=h 之下一深度段
          const strataNames = [];
          for (let y = h - 1; y >= Math.max(1, h - 6); y--) {
            const nm = reg.get(data[idx(lx, y, lz)]).name;
            if (nm.startsWith('terracotta_')) strataNames.push(nm);
          }
          if (topName === 'red_sand') {
            if (biome !== 'mesa') fail(`red_sand 在非恶地 ${wx},${h},${wz}:${biome}`);
            else counts.red_sand++;
          } else if (topName === 'mud') {
            if (biome !== 'swamp' || top === 0) fail(`mud 不在沼泥表面 ${wx},${h},${wz} ${biome}`);
            else counts.mud++;
          } else if (topName === 'dry_grass') {
            if (biome !== 'savanna') fail(`dry_grass 不在干草原表面 ${wx},${h},${wz} ${biome}`);
            else counts.dry_grass++;
          }
          if (strataNames.length > 0) {
            if (biome === 'mesa') {
              for (const nm of strataNames) {
                if (counts[nm] !== undefined) counts[nm]++;
              }
            } else {
              fail(`非恶地出现 terracotta 层 ${wx},${h},${wz}:${biome} ${strataNames.join('/')}`);
            }
          }
        }
      }
    }
  }
  ok('群系地貌方块生成在对应群系表面',
    ['terracotta_red', 'terracotta_orange', 'terracotta_yellow', 'terracotta_white',
      'terracotta_blue'].every((n) => counts[n] > 0) &&
    counts.red_sand > 0 && counts.mud > 0 && counts.dry_grass > 0,
    JSON.stringify(counts));
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

// 堆肥桶与肥料来源（P04）
{
  const { reg } = make(1);
  const all = reg.all();
  ok('方块总数增至 112（新增 9 个堆肥桶方块）', all.length === 112, `${all.length}`);
  ok('堆肥桶方块 id 110~118 连续且末位追加',
    reg.byNameGet('composter')?.id === 110 &&
    reg.byNameGet('composter_7')?.id === 117 &&
    reg.byNameGet('composter_ready')?.id === 118);
  ok('堆肥等级编码：空=0 / 满=8',
    levelOf(reg.byNameGet('composter').id) === 0 &&
    levelOf(reg.byNameGet('composter_ready').id) === 8);
  ok('满级拒绝继续填、取肥回到空桶',
    composterNext(reg.byNameGet('composter_ready').id, 'item:apple') === null &&
    composterNext(reg.byNameGet('composter').id, 'item:wheat_seeds') === reg.byNameGet('composter_1').id);
  ok('满级可收取肥料', harvestOf(reg.byNameGet('composter_ready').id) === 'item:fertilizer');
  ok('堆肥桶掉落自身', reg.byNameGet('composter').drops.some((d) => d.name === 'self'));

  const mobs = new EntityManager({} , new THREE.Scene(), { on() {} }, 1);
  ok('猪 / 羊掉落肥料、骷髅掉落骨粉',
    mobs.getType('pig').drops.some((d) => d.name === 'item:fertilizer') &&
    mobs.getType('sheep').drops.some((d) => d.name === 'item:fertilizer') &&
    mobs.getType('skeleton').drops.some((d) => d.name === 'item:bone_meal'));
}

log(`\nPASS 地形体系回归：${passed} 组断言全部通过`);
