/**
 * 植物内在能量体系回归（v1.4.1）。
 * 运行：node test/plant-energy-check.cjs（需先 npm run test:snapshot）
 *
 * 覆盖：特性表、日照蓄能、夜间呼吸下限、洞穴 / 干燥 / 火光灼伤枯死、
 * 蓄能开花事件、花蜜与额外作物采集、根系能量共享、能量不足时禁止生长。
 */
const assert = require('node:assert');
const { BlockRegistry, registerBuiltinBlocks } = require('./terrain-logic/world/blocks.js');
const { World } = require('./terrain-logic/world/world.js');
const { Botany } = require('./terrain-logic/world/botany.js');
const { EventService } = require('./terrain-logic/services/events/EventService.js');
const {
  PLANT_TRAITS, MAX_PLANT_ENERGY, NIGHT_ENERGY_FLOOR,
} = require('./terrain-logic/world/plantTraits.js');
const {
  DAYS_PER_SEASON, DEFAULT_PLANT_ENV, seasonAt, weatherAt, modifiers,
} = require('./terrain-logic/world/ecology.js');
const { CHUNK_SIZE: CS } = require('./terrain-logic/core/types.js');

const log = (...a) => console.log(...a);
let passed = 0;
function ok(name, cond, extra = '') {
  assert.ok(cond, `${name} ${extra}`);
  passed++;
  log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
}

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

/** 把花周围 5×5 的地表换成石头，阻止蔓延消耗能量（保留自身脚下） */
function isolate(t, x, z) {
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (dx === 0 && dz === 0) continue;
      t.world.setBlock(x + dx, 20, z + dz, t.id('stone'));
    }
  }
}

log('植物内在能量体系回归（代谢 / 蓄能 / 开花 / 采集 / 根系网络）');

// 1) 特性表：不是所有植物都一个样
{
  const poppy = PLANT_TRAITS.poppy;
  const sunflower = PLANT_TRAITS.sunflower;
  const sapling = PLANT_TRAITS.oak_sapling;
  ok('花卉靠光蓄能、开花后可采花蜜',
    poppy.metabolism === 'solar' && poppy.harvest.item === 'item:nectar' && poppy.bloom > 0);
  ok('向日葵是能量枢纽（共享范围 / 功率 / 双份花蜜）',
    sunflower.hub === true && sunflower.shareRadius > poppy.shareRadius &&
    sunflower.harvest.count === 2);
  ok('树苗需要接近满能量才能长成树',
    sapling.bloom >= 90 && sapling.growthCost >= 90);
  ok('水生 / 真菌代谢分类正确',
    PLANT_TRAITS.kelp.metabolism === 'hydro' &&
    PLANT_TRAITS.seagrass.metabolism === 'hydro' &&
    PLANT_TRAITS.brown_mushroom.metabolism === 'fungal' &&
    PLANT_TRAITS.glow_lichen.metabolism === 'fungal');
  ok('发光地衣是真菌网络枢纽、枯灌木不参与能量体系',
    PLANT_TRAITS.glow_lichen.hub === true && !PLANT_TRAITS.dead_bush);
}

// 2) 白天蓄能 → 开花事件
{
  const t = makeWorld();
  isolate(t, 4, 4);
  put(t, 4, 21, 4, 'poppy');
  t.botany.setEnergy(4, 21, 4, 0);
  let blooms = 0;
  t.events.on('plant:bloom', () => blooms++);
  for (let i = 0; i < 8; i++) t.botany.tickAt(4, 21, 4, 1);
  const energy = t.botany.energyAt(4, 21, 4);
  ok('白天日照持续充能', energy >= 80, `energy=${energy}`);
  ok('达到开花阈值发出 plant:bloom', blooms >= 1, `${blooms} 次`);
  ok('植物本身不会因为蓄能而消失', get(t, 4, 21, 4) === t.id('poppy'));
}

// 3) 夜间呼吸只掉到下限，不会死
{
  const t = makeWorld();
  isolate(t, 6, 6);
  put(t, 6, 21, 6, 'poppy');
  t.botany.setEnergy(6, 21, 6, 30);
  for (let i = 0; i < 30; i++) t.botany.tickAt(6, 21, 6, 0);
  const energy = t.botany.energyAt(6, 21, 6);
  ok('夜间呼吸衰减到下限', energy === NIGHT_ENERGY_FLOOR, `energy=${energy}`);
  ok('夜间植物仍存活', get(t, 6, 21, 6) === t.id('poppy'));

  // 已经耗尽的能量不能在夜间被「下限」凭空补回
  t.botany.setEnergy(6, 21, 6, 5);
  t.botany.tickAt(6, 21, 6, 0);
  const spent = t.botany.energyAt(6, 21, 6);
  ok('夜间不会把低于下限的能量补满', spent < 5, `energy=${spent}`);
}

// 4) 完全黑暗：太阳能植物饿死；蘑菇反而蓄能
{
  const t = makeWorld();
  // 封闭石室：屋顶 + 四壁
  for (let x = 6; x <= 12; x++) {
    for (let z = 6; z <= 12; z++) {
      t.world.setBlock(x, 24, z, t.id('stone'));
      const edge = x === 6 || x === 12 || z === 6 || z === 12;
      for (let y = 21; y <= 23; y++) {
        t.world.setBlock(x, y, z, edge ? t.id('stone') : 0);
      }
    }
  }
  put(t, 9, 21, 9, 'poppy');
  t.botany.setEnergy(9, 21, 9, 32);
  for (let i = 0; i < 8; i++) t.botany.tickAt(9, 21, 9, 1);
  ok('完全黑暗中的太阳能植物会枯死', get(t, 9, 21, 9) === 0);

  put(t, 10, 21, 10, 'brown_mushroom');
  t.botany.setEnergy(10, 21, 10, 0);
  for (let i = 0; i < 6; i++) t.botany.tickAt(10, 21, 10, 1);
  ok('洞穴里的蘑菇能蓄能', t.botany.energyAt(10, 21, 10) > 0,
    `energy=${t.botany.energyAt(10, 21, 10)}`);
}

// 5) 真菌：白天强光被压制，火光旁会被灼伤
{
  const t = makeWorld();
  put(t, 3, 21, 10, 'brown_mushroom');
  t.botany.setEnergy(3, 21, 10, 32);
  for (let i = 0; i < 6; i++) t.botany.tickAt(3, 21, 10, 1);
  ok('白天强光下蘑菇存活但能量被压到下限',
    get(t, 3, 21, 10) === t.id('brown_mushroom') &&
    t.botany.energyAt(3, 21, 10) === NIGHT_ENERGY_FLOOR,
    `energy=${t.botany.energyAt(3, 21, 10)}`);

  // 相邻火把的方块光会灼伤菌类
  put(t, 4, 21, 10, 'torch');
  t.botany.setEnergy(3, 21, 10, 32);
  for (let i = 0; i < 8; i++) t.botany.tickAt(3, 21, 10, 1);
  ok('火光旁的真菌会枯死', get(t, 3, 21, 10) === 0,
    `light=${t.world.getBlockLight(3, 21, 10)}`);
}

// 6) 柱状植物长高后，底格不会因为自己的植株遮光而误判饿死
{
  const t = makeWorld();
  put(t, 7, 21, 7, 'cactus');
  put(t, 7, 22, 7, 'cactus');
  put(t, 7, 23, 7, 'cactus');
  t.botany.setEnergy(7, 21, 7, 50);
  for (let i = 0; i < 20; i++) t.botany.tickAt(7, 21, 7, 1);
  ok('三格高仙人掌仍能靠顶部光照蓄能',
    get(t, 7, 23, 7) === t.id('cactus') && t.botany.energyAt(7, 21, 7) > 0,
    `energy=${t.botany.energyAt(7, 21, 7)}`);
}

// 7) 水生植物：离水枯死、水中夜间也能蓄能
{
  const t = makeWorld();
  put(t, 2, 21, 2, 'seagrass');
  t.botany.setEnergy(2, 21, 2, 32);
  for (let i = 0; i < 8; i++) t.botany.tickAt(2, 21, 2, 1);
  ok('离水的水草会枯死', get(t, 2, 21, 2) === 0);

  put(t, 12, 20, 4, 'sand');
  put(t, 12, 21, 4, 'water');
  put(t, 12, 22, 4, 'water');
  t.world.setBlock(12, 21, 4, t.id('seagrass'));
  t.botany.setEnergy(12, 21, 4, 0);
  for (let i = 0; i < 5; i++) t.botany.tickAt(12, 21, 4, 0);
  ok('水中海草夜间也能蓄能', t.botany.energyAt(12, 21, 4) > 0,
    `energy=${t.botany.energyAt(12, 21, 4)}`);
}

// 7) 蓄能采集：花蜜 / 额外种子 / 浆果回退
{
  const t = makeWorld();
  isolate(t, 4, 12);
  put(t, 4, 21, 12, 'poppy');
  t.botany.setEnergy(4, 21, 12, 100);
  const nectar = t.botany.harvest(4, 21, 12, 'use');
  ok('蓄能虞美人可采花蜜', nectar && nectar.item === 'item:nectar' && nectar.count === 1,
    JSON.stringify(nectar));
  ok('采集后能量大幅下降', t.botany.energyAt(4, 21, 12) < 80,
    `energy=${t.botany.energyAt(4, 21, 12)}`);
  ok('未重新蓄能时不能重复采集', t.botany.harvest(4, 21, 12, 'use') === null);
  ok('采集花蜜不会破坏花', get(t, 4, 21, 12) === t.id('poppy'));

  put(t, 8, 21, 12, 'wheat');
  t.botany.setEnergy(8, 21, 12, 100);
  const seeds = t.botany.harvest(8, 21, 12, 'use');
  ok('蓄能成熟小麦额外掉种子', seeds && seeds.item === 'item:wheat_seeds' && seeds.count === 2,
    JSON.stringify(seeds));

  put(t, 11, 21, 12, 'sweet_berry_bush_ripe');
  t.botany.setEnergy(11, 21, 12, 100);
  const berries = t.botany.harvest(11, 21, 12, 'use');
  ok('蓄能成熟浆果丛采集甜浆果',
    berries && berries.item === 'item:sweet_berries' && berries.count === 2,
    JSON.stringify(berries));
  ok('采集后浆果丛回到未成熟状态', get(t, 11, 21, 12) === t.id('sweet_berry_bush'));
}

// 8) 能量不足时禁止生长；蓄满后允许
{
  const t = makeWorld();
  // 清空树苗上空，避免树冠净空检查失败
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      for (let y = 21; y < 40; y++) t.world.setBlock(13 + dx, y, 13 + dz, 0);
    }
  }
  put(t, 13, 21, 13, 'oak_sapling');
  t.botany.setEnergy(13, 21, 13, 0);
  t.botany.tickAt(13, 21, 13, 1);
  ok('能量不足的树苗不会长树', get(t, 13, 21, 13) === t.id('oak_sapling'),
    `energy=${t.botany.energyAt(13, 21, 13)}`);

  t.botany.setEnergy(13, 21, 13, 100);
  let grew = false;
  for (let i = 0; i < 2000 && !grew; i++) {
    t.botany.tickAt(13, 21, 13, 1);
    grew = get(t, 13, 21, 13) === t.id('oak_log');
  }
  ok('蓄满能量的树苗长成橡树', grew);
}

// 9) 根系网络：蓄满的向日葵把能量送给邻近植物
{
  const t = makeWorld();
  // 只保留两株花脚下的草地，其余地表铺石，阻止蔓延抢能量
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if ((dx === 0 && dz === 0) || (dx === 1 && dz === 0)) continue;
      t.world.setBlock(5 + dx, 20, 12 + dz, t.id('stone'));
    }
  }
  put(t, 5, 21, 12, 'sunflower');
  put(t, 6, 21, 12, 'poppy');
  t.botany.setEnergy(5, 21, 12, MAX_PLANT_ENERGY);
  t.botany.setEnergy(6, 21, 12, 0);
  for (let i = 0; i < 600; i++) t.botany.tickAt(5, 21, 12, 1);
  ok('向日葵把富余能量共享给邻近花朵',
    t.botany.energyAt(6, 21, 12) > 0, `receiver=${t.botany.energyAt(6, 21, 12)}`);
}

// 10) 生态统计：F3 可观测
{
  const t = makeWorld();
  isolate(t, 3, 3);
  put(t, 3, 21, 3, 'poppy');
  t.botany.setEnergy(3, 21, 3, 100);
  put(t, 5, 21, 3, 'brown_mushroom');
  t.botany.setEnergy(5, 21, 3, 10);
  const s = t.botany.stats(4, 3, 8);
  ok('stats 统计株数 / 开花 / 代谢分类',
    s.tracked >= 2 && s.charged >= 1 && s.solar >= 1 && s.fungal >= 1,
    JSON.stringify(s));
}

// 11) 季节 / 天气：纯函数历法、天气确定性与中性 env 等价
{
  ok('一季为 6 游戏日，四季循环',
    DAYS_PER_SEASON === 6 && seasonAt(0) === 'spring' && seasonAt(5) === 'spring' &&
    seasonAt(6) === 'summer' && seasonAt(12) === 'autumn' &&
    seasonAt(23) === 'winter' && seasonAt(24) === 'spring');
  ok('天气由 seed+day 确定性推导',
    weatherAt(20261115, 3) === weatherAt(20261115, 3));
  const neutral = modifiers(DEFAULT_PLANT_ENV);
  ok('默认环境倍率全为 1',
    neutral.growth === 1 && neutral.solar === 1 && neutral.hydro === 1 && neutral.fungal === 1);
  ok('冬季抑制光合 / 雨天增强水生',
    modifiers({ ...DEFAULT_PLANT_ENV, season: 'winter' }).solar < 1 &&
    modifiers({ ...DEFAULT_PLANT_ENV, weather: 'rain' }).hydro > 1);

  const a = makeWorld();
  const b = makeWorld();
  for (const t of [a, b]) {
    isolate(t, 7, 7);
    put(t, 7, 21, 7, 'poppy');
    t.botany.setEnergy(7, 21, 7, 50);
  }
  for (let i = 0; i < 40; i++) {
    a.botany.tickAt(7, 21, 7, 1);
    b.botany.tickAt(7, 21, 7, 1, DEFAULT_PLANT_ENV);
  }
  ok('不传 env 与传默认 env 的生态演化逐值一致',
    get(a, 7, 21, 7) === get(b, 7, 21, 7) &&
    a.botany.energyAt(7, 21, 7) === b.botany.energyAt(7, 21, 7));
}

log(`\nPASS 植物能量体系回归：${passed} 组断言全部通过`);
