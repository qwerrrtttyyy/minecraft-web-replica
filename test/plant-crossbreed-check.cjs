/**
 * 植物杂交品系回归（minecraft-web-replica-botany）。
 * 运行：node test/plant-crossbreed-check.cjs（需先 npm run test:snapshot）
 *
 * 覆盖：组合表无序匹配、品系特性覆盖、麦 × 麦自然杂交产出带品系后代、
 * 存档 V2 往返保留品系、V1 旧档迁移（无品系）、破坏植株清除品系、
 * 品系附加产出（金穗小麦的花蜜）。
 */
const assert = require('node:assert');
const { BlockRegistry, registerBuiltinBlocks } = require('./terrain-logic/world/blocks.js');
const { World } = require('./terrain-logic/world/world.js');
const { Botany } = require('./terrain-logic/world/botany.js');
const { EventService } = require('./terrain-logic/services/events/EventService.js');
const {
  STRAINS, STRAIN_ORDER, findCombo, applyStrain,
} = require('./terrain-logic/world/plantStrains.js');
const { PLANT_TRAITS } = require('./terrain-logic/world/plantTraits.js');
const { CHUNK_SIZE: CS } = require('./terrain-logic/core/types.js');

const log = (...a) => console.log(...a);
let passed = 0;
function ok(name, cond, extra = '') {
  assert.ok(cond, `${name} ${extra}`);
  passed++;
  log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
}

function makeWorld(seed = 20261122) {
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

const put = (t, x, y, z, name) => t.world.setBlock(x, y, z, t.id(name));

// ---------- 1. 组合表：无序匹配 ----------

ok('麦 × 麦组合命中', findCombo('wheat', 'wheat')?.offspring === 'luxuriant_wheat');
ok('麦 × 浆果无序匹配', findCombo('sweet_berry_bush', 'wheat')?.offspring === 'berry_wheat');
ok('无关物种不命中', findCombo('poppy', 'wheat') === undefined);

// ---------- 2. 品系覆盖：纯函数 ----------

const luxuriant = applyStrain(PLANT_TRAITS.wheat, STRAINS.luxuriant_wheat);
ok('大穗小麦生长耗能覆盖为 26', luxuriant.growthCost === 26);
ok('大穗小麦收获 4 份种子', luxuriant.harvest?.count === 4);
const golden = applyStrain(PLANT_TRAITS.wheat, STRAINS.golden_wheat);
ok('金穗小麦附加产出花蜜', golden.harvest?.extra?.item === 'item:nectar');
ok('品系顺序固定 5 条', STRAIN_ORDER.length === 5 && STRAIN_ORDER[0] === 'luxuriant_wheat');

// ---------- 3. 自然杂交：麦 × 麦 → 大穗小麦 ----------

const t = makeWorld();
// 两株成熟小麦相邻，第三格空着（下方草地支撑），养分缺省 100 ≥ 80
put(t, 8, 21, 8, 'wheat');
put(t, 9, 21, 8, 'wheat');
t.botany.setEnergy(8, 21, 8, 100);
t.botany.setEnergy(9, 21, 8, 100);

let offspringX = -1;
for (let i = 0; i < 64 && offspringX < 0; i++) {
  t.botany.tickAt(8, 21, 8);
  t.botany.tickAt(9, 21, 8);
  for (const x of [7, 10]) {
    if (t.world.getBlock(x, 21, 8) === t.id('wheat')) offspringX = x;
  }
}
ok('麦 × 麦在邻位长出带品系后代', offspringX >= 0, `x=${offspringX}`);
if (offspringX >= 0) {
  const save = t.botany.serializeEcology();
  ok('存档版本升级为 v2', save.v === 2);
  ok('杂交后代的品系写入存档', save.strains.some(
    ([, , , idx]) => STRAIN_ORDER[idx] === 'luxuriant_wheat',
  ));

  // ---------- 4. 存档往返：V2 保留品系，V1 迁移为无品系 ----------

  const t2 = makeWorld();
  put(t2, 8, 21, 8, 'wheat');
  put(t2, 9, 21, 8, 'wheat');
  put(t2, 10, 21, 8, 'wheat');
  t2.botany.restoreEcology(save);
  ok('restoreEcology 读回 V2 品系', (() => {
    const out = t2.botany.serializeEcology();
    return out.v === 2 && out.strains.some(([, , , idx]) => STRAIN_ORDER[idx] === 'luxuriant_wheat');
  })());

  const t3 = makeWorld();
  put(t3, 8, 21, 8, 'wheat');
  const v1 = { v: 1, plants: [[8, 21, 8, t3.id('wheat'), 50, 0]], soil: [] };
  ok('V1 旧档迁移成功', t3.botany.restoreEcology(v1) === 1);
  const out3 = t3.botany.serializeEcology();
  ok('V1 迁移后无品系记录', out3.v === 2 && out3.strains.length === 0);

  // 品系下标越界的坏条目被静默丢弃
  const t3b = makeWorld();
  put(t3b, 8, 21, 8, 'wheat');
  t3b.botany.restoreEcology({
    v: 2, plants: [[8, 21, 8, t3b.id('wheat'), 50, 0]], soil: [],
    strains: [[8, 21, 8, 99]],
  });
  ok('越界品系下标被丢弃', t3b.botany.serializeEcology().strains.length === 0);

  // ---------- 5. 品系附加产出：金穗小麦收获花蜜 ----------

  const t4 = makeWorld();
  put(t4, 8, 21, 8, 'wheat');
  t4.botany.restoreEcology({
    v: 2,
    plants: [[8, 21, 8, t4.id('wheat'), 100, 0]],
    soil: [],
    strains: [[8, 21, 8, STRAIN_ORDER.indexOf('golden_wheat')]],
  });
  const bonus = t4.botany.harvest(8, 21, 8, 'use');
  ok('金穗小麦收获基础产出种子', bonus?.item === 'item:wheat_seeds');
  ok('金穗小麦附加产出花蜜', bonus?.extra?.item === 'item:nectar' && bonus.extra.count === 1);

  // ---------- 6. 破坏植株清除品系 ----------

  put(t, offspringX, 21, 8, 'air');
  t.events.emit('block:break', { x: offspringX, y: 21, z: 8, block: t.id('wheat') });
  const after = t.botany.serializeEcology();
  ok('破坏后代后品系消失', !after.strains.some(
    ([x]) => x === offspringX,
  ));
}

log(`\n植物杂交品系回归：${passed} 项全部通过`);
process.exit(0);
