/**
 * 烧炼系统纯逻辑回归（不需要 WebGL / three 运行时）。
 * 运行：npm run test:smelting（需先 npm run test:snapshot）
 *
 * 覆盖：烧炼配方表 / 燃料热值、燃料耗尽停止、自动续料、产出入包、
 * 存档往返、熔炉方块 id 与合成配方。
 */
const assert = require('node:assert');
const {
  SMELTING_RECIPES,
  FUEL_VALUES,
  SmeltingState,
  smeltingRecipeOf,
} = require('./logic/player/smelting.js');
const { BlockRegistry, registerBuiltinBlocks } = require('./logic/world/blocks.js');
const { matchRecipe, CRAFTING_RECIPES } = require('./logic/player/crafting.js');
const { ITEMS } = require('./logic/player/survival.js');

let passed = 0;
function ok(name, cond, extra = '') {
  assert.ok(cond, `${name} ${extra}`);
  passed++;
  console.log(`PASS  ${name}${extra ? ' — ' + extra : ''}`);
}

// ---- 配置表 ----
ok('烧炼配方 4 条', SMELTING_RECIPES.length === 4, String(SMELTING_RECIPES.length));
for (const r of SMELTING_RECIPES) {
  ok(`配方 ${r.id} 字段完整`, !!r.label && !!r.input && r.output.startsWith('item:') && r.time === 8);
  ok(`产物 ${r.output} 在 ITEMS 中`, !!ITEMS[r.output.slice(5)]);
}
ok('煤燃料 80 秒', FUEL_VALUES['item:coal'] === 80);
ok('木棍燃料 5 秒', FUEL_VALUES['item:stick'] === 5);
ok('木板燃料 15 秒', FUEL_VALUES.oak_planks === 15);
ok('原木燃料 15 秒', FUEL_VALUES.oak_log === 15);
ok('铁矿石可烧炼', smeltingRecipeOf('iron_ore')?.output === 'item:iron_ingot');
ok('石头不可烧炼', smeltingRecipeOf('stone') === undefined);

// ---- 状态机 ----
function makeHost(stock = 1) {
  const produced = [];
  const done = [];
  const host = {
    takeInput() { return stock-- > 0; },
    produce(material, count) { produced.push([material, count]); },
    onSmelted(recipe) { done.push(recipe.id); },
  };
  return { host, produced, done, remaining: () => stock };
}

{
  const { host, produced, done } = makeHost(0); // 背包无额外矿石，烧完即停
  const st = new SmeltingState(host);
  ok('投入煤 +80 秒', st.putFuel('item:coal') === 80 && st.fuelTime === 80);
  ok('非燃料返回 0', st.putFuel('stone') === 0);
  ok('无配方材料不能放入', st.putInput('oak_log') === false);
  ok('放入铁矿石', st.putInput('iron_ore') === true);
  ok('已有输入时不能重复放', st.putInput('gold_ore') === false);
  for (let i = 0; i < 85; i++) st.tick(0.1);
  ok('8 秒后产出铁锭', produced.length === 1 && produced[0][0] === 'item:iron_ingot');
  ok('烧炼完成事件', done.length === 1 && done[0] === 'iron_ingot');
  ok('库存耗尽后输入清空', st.input === null);
  ok('燃料按时间扣减', st.fuelTime > 70 && st.fuelTime < 73, String(st.fuelTime));
}

{
  // 自动续料：背包有 3 份矿石，一次投料连续烧 3 个
  const { host, produced } = makeHost(3);
  const st = new SmeltingState(host);
  st.putFuel('item:coal');
  st.putInput('iron_ore');
  for (let i = 0; i < 250; i++) st.tick(0.1);
  ok('自动续料产出 3 份', produced.length === 3, String(produced.length));
}

{
  // 燃料耗尽：10 秒燃料只能烧 1 个，之后停止
  const { host, produced } = makeHost(5);
  const st = new SmeltingState(host);
  st.putFuel('oak_planks'); // 15s
  st.fuelTime = 10;
  st.putInput('gold_ore');
  for (let i = 0; i < 200; i++) st.tick(0.1);
  ok('燃料耗尽只烧 1 个', produced.length === 1, String(produced.length));
  ok('燃料归零', st.fuelTime === 0);
  const before = produced.length;
  for (let i = 0; i < 100; i++) st.tick(0.1);
  ok('无燃料不再产出', produced.length === before);
}

{
  const { host } = makeHost(1);
  const st = new SmeltingState(host);
  st.putFuel('item:coal');
  st.putInput('copper_ore');
  for (let i = 0; i < 30; i++) st.tick(0.1);
  const snap = st.serialize();
  const st2 = new SmeltingState(host);
  st2.restore(snap);
  ok('存档往返：燃料', st2.fuelTime === snap.fuelTime);
  ok('存档往返：输入', st2.input === 'copper_ore');
  ok('存档往返：进度', st2.progress === snap.progress);
  st2.restore(undefined);
  ok('旧档无字段按空熔炉', st2.fuelTime === 0 && st2.input === null && st2.progress === 0);
}

{
  const desync = { takeInput: () => false, produce: () => {}, onSmelted: () => {} };
  const st = new SmeltingState(desync);
  st.putInput('iron_ore');
  ok('取出输入返回材料', st.takeInput() === 'iron_ore' && st.input === null);
}

// ---- 方块与合成配方 ----
const reg = new BlockRegistry();
registerBuiltinBlocks(reg);
const furnace = reg.byNameGet('furnace');
ok('熔炉方块存在且 id=110', !!furnace && furnace.id === 110);
const recipe = CRAFTING_RECIPES.find((r) => r.id === 'furnace');
ok('熔炉合成配方存在', !!recipe);
const grid = ['CCC', 'C C', 'CCC'].join('').split('').map((c) => (c === 'C' ? 'cobblestone' : null));
const match = matchRecipe(grid, 3);
ok('3×3 圆石框架可合成熔炉', match && match.recipe.id === 'furnace');

console.log(`\n烧炼系统回归：${passed} 项通过`);
