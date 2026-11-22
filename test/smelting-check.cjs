/**
 * 熔炉烧炼系统纯逻辑回归（不需要 WebGL / three 运行时）。
 * 运行：npm run test:smelting（需先 npm run test:snapshot）
 *
 * 覆盖：配方表结构、燃料表、putFuelFrom 统一校验 / 扣背包 / 加燃料、
 * tick 状态机（点燃 → 进度 → 产出 → 空烧）、serialize/restore 往返。
 */
const assert = require('node:assert');
const { SurvivalState } = require('./logic/player/survival.js');
const { BlockRegistry, registerBuiltinBlocks } = require('./logic/world/blocks.js');
const {
  Smelting,
  SMELT_SECONDS,
  SMELT_RECIPES,
  FUEL_UNITS,
  fuelUnitsOf,
  smeltOutputOf,
} = require('./logic/player/smelting.js');
const { EventService } = require('./logic/services/events/index.js');

const log = (...a) => console.log(...a);
let passed = 0;
function ok(name, cond, extra = '') {
  assert.ok(cond, `${name} ${extra}`);
  passed++;
  log(`PASS  ${name}${extra ? ' — ' + extra : ''}`);
}

log('熔炉烧炼系统回归');

// ---- 1. 配方表与燃料表 ----
ok('原矿→锭配方齐全',
  smeltOutputOf('raw_iron') === 'iron_ingot' &&
  smeltOutputOf('raw_gold') === 'gold_ingot' &&
  smeltOutputOf('raw_copper') === 'copper_ingot');
ok('熟肉配方齐全',
  smeltOutputOf('porkchop') === 'cooked_porkchop' &&
  smeltOutputOf('beef') === 'cooked_beef' &&
  smeltOutputOf('rabbit_meat') === 'cooked_rabbit');
ok('沙子烧玻璃、原木烧木炭',
  smeltOutputOf('sand') === 'glass' && smeltOutputOf('oak_log') === 'charcoal');
ok('燃料表比例与原版一致',
  fuelUnitsOf('coal') === 8 && fuelUnitsOf('charcoal') === 8 &&
  fuelUnitsOf('oak_planks') === 1.5 && fuelUnitsOf('oak_log') === 1.5 &&
  fuelUnitsOf('crafting_table') === 1.5 && fuelUnitsOf('bookshelf') === 1.5 &&
  fuelUnitsOf('stick') === 0.5);
ok('非燃料返回 0', fuelUnitsOf('stone') === 0);
ok('不可烧炼返回 null', smeltOutputOf('stone') === null);
ok('每条配方的输出物品都存在或为方块（b:/i: 前缀或物品名）',
  Object.entries(SMELT_RECIPES).every(([, out]) => typeof out === 'string' && out.length > 0));

// ---- 2. putFuelFrom：统一校验 / 扣背包 / 加燃料 ----
const reg = new BlockRegistry();
registerBuiltinBlocks(reg);
const survival = new SurvivalState(new EventService(), reg);
survival.mode = 'survival';
const smelting = new Smelting();

ok('空背包投燃料失败', smelting.putFuelFrom(survival, 0, 0, 0, 'coal', 1, { kind: 'item', id: 'coal' }) === 0);
survival.addItem('coal', 3);
ok('投 2 个煤成功', smelting.putFuelFrom(survival, 0, 0, 0, 'coal', 2, { kind: 'item', id: 'coal' }) === 2);
ok('背包扣掉 2 个煤', survival.countStack({ kind: 'item', id: 'coal' }) === 1);
const cell0 = smelting.cell(0, 0, 0);
ok('燃料槽记到 2 个煤', cell0.fuel && cell0.fuel.material === 'coal' && cell0.fuel.count === 2);
ok('非燃料投不进去', smelting.putFuelFrom(survival, 0, 0, 0, 'stone', 1, { kind: 'item', id: 'stone' }) === 0);
ok('换一种燃料被拒（槽内已有煤）',
  (survival.addItem('stick', 1), smelting.putFuelFrom(survival, 0, 0, 0, 'stick', 1, { kind: 'item', id: 'stick' }) === 0));

// ---- 3. putInput / tick 状态机 ----
ok('投不进不可烧炼材料', (survival.addItem('apple', 1), smelting.putInput(survival, 1, 0, 0, 'apple', 1, { kind: 'item', id: 'apple' }) === 0));
survival.addItem('raw_iron', 5);
ok('投入 5 个粗铁',
  smelting.putInput(survival, 1, 0, 0, 'raw_iron', 5, { kind: 'item', id: 'raw_iron' }) === 5);

const cell1 = smelting.cell(1, 0, 0);
ok('无燃料时 tick 不推进', (smelting.tick(SMELT_SECONDS), cell1.output === null && cell1.progress === 0));

// 给 1 号炉配燃料：木炭（物品燃料，8 件 = 80s，远够烧 1 件）
survival.addItem('charcoal', 1);
ok('木炭投进 1 号炉', smelting.putFuelFrom(survival, 1, 0, 0, 'charcoal', 1, { kind: 'item', id: 'charcoal' }) === 1);

// 推进一整个烧炼周期：点燃瞬间 + 10s 进度
smelting.tick(0.001);
ok('点燃后进入燃烧态', cell1.burn > 0 && cell1.burnMax > 0);
smelting.tick(SMELT_SECONDS);
ok('10s 后产出铁锭', cell1.output && cell1.output.material === 'iron_ingot' && cell1.output.count === 1);
ok('输入槽剩 4 个粗铁', cell1.input && cell1.input.count === 4);
ok('木炭 8 件燃料烧 80s，10s 后仍有余焰', cell1.burn > 0);

// 取走产物进背包
ok('取走铁锭进背包', smelting.takeOutput(survival, 1, 0, 0) && survival.countStack({ kind: 'item', id: 'iron_ingot' }) === 1);

// 无输入不点火（原版语义：没有可烧物品时燃料不白白点着）
survival.addItem('coal', 1);
ok('煤投进 2 号炉', smelting.putFuelFrom(survival, 2, 0, 0, 'coal', 1, { kind: 'item', id: 'coal' }) === 1);
const cell2 = smelting.cell(2, 0, 0);
smelting.tick(1);
ok('无输入时不点燃、燃料不消耗', cell2.burn === 0 && cell2.fuel && cell2.fuel.count === 1);

// ---- 4. serialize / restore 往返 ----
const data = smelting.serialize();
ok('序列化出 3 台熔炉（含 1 台未点燃的）', data.length === 3);
const restored = new Smelting();
restored.restore(JSON.parse(JSON.stringify(data)));
ok('恢复后燃料槽内容一致',
  JSON.stringify(restored.cell(0, 0, 0).fuel) === JSON.stringify(cell0.fuel) &&
  JSON.stringify(restored.cell(1, 0, 0).input) === JSON.stringify(cell1.input));
ok('恢复后燃烧 / 进度一致',
  Math.abs(restored.cell(1, 0, 0).burn - cell1.burn) < 0.01 &&
  Math.abs(restored.cell(1, 0, 0).progress - cell1.progress) < 0.01);

// ---- 5. take：挖掉熔炉释放状态 ----
smelting.take(0, 0, 0);
ok('take 后该坐标回到全新状态',
  !smelting.cells.has('0,0,0') && smelting.cell(0, 0, 0).fuel === null);

log(`\n共 ${passed} 项断言通过`);

// ---- 6. 健壮性：方块输入 / 输出上限 / 未知材料 / 负 dt ----
// 方块输入（沙子在背包按数字 id 存）：沙子 → 玻璃（b: 前缀输出）
const smelting3 = new Smelting();
const sandId = reg.byNameGet('sand').id;
survival.addItem('coal', 1);
survival.addBlock(sandId, 2);
smelting3.putFuelFrom(survival, 3, 0, 0, 'coal', 1, { kind: 'item', id: 'coal' });
smelting3.putInput(survival, 3, 0, 0, 'sand', 2, { kind: 'block', id: sandId });
const cell3 = smelting3.cell(3, 0, 0);
smelting3.tick(0.001);
smelting3.tick(SMELT_SECONDS);
ok('沙子（方块输入）烧出玻璃', cell3.output && cell3.output.material === 'glass');
ok('取走玻璃进背包（方块形态）',
  smelting3.takeOutput(survival, 3, 0, 0) &&
  survival.countStack({ kind: 'block', id: reg.byNameGet('glass').id }) === 1);

// 输出槽满 999 时停止烧炼，燃料照烧
const smelting4 = new Smelting();
survival.addItem('coal', 1);
smelting4.putFuelFrom(survival, 4, 0, 0, 'coal', 1, { kind: 'item', id: 'coal' });
survival.addItem('raw_iron', 1200);
smelting4.putInput(survival, 4, 0, 0, 'raw_iron', 1200, { kind: 'item', id: 'raw_iron' });
const cell4 = smelting4.cell(4, 0, 0);
cell4.output = { material: 'iron_ingot', count: 999 };
smelting4.tick(0.001);
smelting4.tick(SMELT_SECONDS);
ok('输出槽满 999 不再产出', cell4.output.count === 999);
// 背包堆叠上限即 999，putInput 只拿到 999 个
ok('输出槽满时输入不消耗', cell4.input && cell4.input.count === 999);
// 与"有可烧输入才点火"语义一致：烧不了就不点燃，燃料也不消耗
ok('输出槽满时不点燃、燃料不消耗', cell4.burn === 0 && cell4.fuel && cell4.fuel.count === 1);

// 未知材料的存档条目：恢复后静默惰性（不烧不崩）
const smelting5 = new Smelting();
smelting5.restore([{ pos: [5, 0, 0], input: ['mystery_item', 1], fuel: null, output: null, burn: 0, burnMax: 0, progress: 0 }]);
const cell5 = smelting5.cell(5, 0, 0);
smelting5.tick(1);
ok('未知材料恢复后不烧不崩', cell5.output === null && cell5.progress === 0);

// 负 dt：燃烧时间不倒增
const smelting6 = new Smelting();
survival.addItem('coal', 1);
smelting6.putFuelFrom(survival, 6, 0, 0, 'coal', 1, { kind: 'item', id: 'coal' });
survival.addItem('raw_iron', 1);
smelting6.putInput(survival, 6, 0, 0, 'raw_iron', 1, { kind: 'item', id: 'raw_iron' });
const cell6 = smelting6.cell(6, 0, 0);
smelting6.tick(0.001);
const burnAtStart = cell6.burn;
smelting6.tick(-5);
ok('负 dt 不使燃烧倒增', cell6.burn === burnAtStart);

log(`含健壮性共 ${passed} 项断言通过`);
console.log('SMELTING OK');
