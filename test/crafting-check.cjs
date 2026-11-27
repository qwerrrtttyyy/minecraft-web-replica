/**
 * 合成系统纯逻辑回归（不需要 WebGL / three 运行时）。
 * 运行：npm run test:crafting（需先 npm run test:snapshot）
 *
 * 覆盖：配方表结构、有序配方（支持 3×3 内的偏移摆放）、无序配方、
 * 材料组（#planks）、2×2 个人合成格与 3×3 工作台的尺寸差异、
 * 以及「多放一个材料就不该匹配」这类严格性约束。
 */
const assert = require('node:assert');
const { BlockRegistry, registerBuiltinBlocks } = require('./logic/world/blocks.js');
const {
  matchRecipe,
  CRAFTING_RECIPES,
  CRAFTING_GROUPS,
  INTERACTIVE_BLOCK,
  materialToStack,
  inventoryKeyToMaterial,
} = require('./logic/player/crafting.js');
const { ITEMS } = require('./logic/player/survival.js');

const log = (...a) => console.log(...a);
let passed = 0;
function ok(name, cond, extra = '') {
  assert.ok(cond, `${name} ${extra}`);
  passed++;
  log(`PASS  ${name}${extra ? ' — ' + extra : ''}`);
}

const reg = new BlockRegistry();
registerBuiltinBlocks(reg);

const id = (n) => {
  const d = reg.byNameGet(n);
  assert.ok(d, `方块 ${n} 必须存在`);
  return d.id;
};
/** 网格元素用材料标识：方块名或 'item:xxx'（与 UI 层一致） */
const blk = (n) => n;

/** 造一个 size×size 的空网格 */
const grid = (size) => new Array(size * size).fill(null);
/** 在网格里放一个材料（row/col 从 0 开始） */
const put = (cells, size, col, row, stack) => {
  cells[row * size + col] = stack;
  return cells;
};
const matchOf = (cells, size) => matchRecipe(cells, size);

log('合成系统回归');

// ---- 1. 配方表结构 ----
ok('配方表非空', CRAFTING_RECIPES.length > 0, `${CRAFTING_RECIPES.length} 条`);
ok('配方 id 唯一', new Set(CRAFTING_RECIPES.map((r) => r.id)).size === CRAFTING_RECIPES.length);
ok('每条配方都有产物与数量',
  CRAFTING_RECIPES.every((r) => r.result && typeof r.result.material === 'string'
    && Number.isInteger(r.result.count) && r.result.count > 0));
ok('每条配方要么有序要么无序',
  CRAFTING_RECIPES.every((r) => (!!r.pattern) !== (!!r.shapeless)));
ok('有序配方的字符都在 key 里',
  CRAFTING_RECIPES.every((r) => !r.pattern
    || r.pattern.every((row) => [...row].every((ch) => ch === ' ' || (r.key && r.key[ch])))));
ok('材料组非空且成员合法',
  Object.values(CRAFTING_GROUPS).every((g) => g.length > 0
    && g.every((m) => reg.byNameGet(m) !== undefined)));

// ---- 2. 单材料无序配方：原木 → 4 木板 ----
{
  const cells = grid(3);
  put(cells, 3, 1, 1, blk('oak_log'));
  const m = matchOf(cells, 3);
  ok('1 原木 → 4 橡木木板', !!m && m.recipe.id === 'oak_planks' && m.recipe.result.count === 4,
    m ? m.recipe.id : '无匹配');
  ok('产物是方块 oak_planks',
    !!m && m.recipe.result.material === 'oak_planks' && m.recipe.result.count === 4);

  const birch = grid(3);
  put(birch, 3, 0, 0, blk('birch_log'));
  const mb = matchOf(birch, 3);
  ok('白桦原木 → 4 白桦木板（不串味）',
    !!mb && mb.recipe.id === 'birch_planks' && mb.recipe.result.material === 'birch_planks',
    mb ? mb.recipe.id : '无匹配');
}

// ---- 3. 无序配方不能多放材料 ----
{
  const cells = grid(3);
  put(cells, 3, 0, 0, blk('oak_log'));
  put(cells, 3, 1, 0, blk('oak_log'));
  ok('两个原木不匹配（原木→木板 只吃 1 个）', matchOf(cells, 3) === null);
}

// ---- 4. 2×2 有序配方：4 木板 → 工作台 ----
{
  const cells = grid(3);
  put(cells, 3, 0, 0, blk('oak_planks'));
  put(cells, 3, 1, 0, blk('oak_planks'));
  put(cells, 3, 0, 1, blk('oak_planks'));
  put(cells, 3, 1, 1, blk('oak_planks'));
  const m = matchOf(cells, 3);
  ok('4 木板（2×2）→ 工作台', !!m && m.recipe.id === 'crafting_table' && m.recipe.result.count === 1,
    m ? m.recipe.id : '无匹配');
  ok('工作台产物指向已注册方块',
    !!m && reg.byNameGet(m.recipe.result.material)?.id === id('crafting_table'));

  // 偏移摆放：2×2 放在 3×3 的右下角也应匹配
  const off = grid(3);
  put(off, 3, 1, 1, blk('oak_planks'));
  put(off, 3, 2, 1, blk('oak_planks'));
  put(off, 3, 1, 2, blk('oak_planks'));
  put(off, 3, 2, 2, blk('oak_planks'));
  const mo = matchOf(off, 3);
  ok('2×2 配方在 3×3 内偏移摆放同样匹配', !!mo && mo.recipe.id === 'crafting_table',
    mo ? mo.recipe.id : '无匹配');

  // 材料组：白桦木板也应能合成工作台
  const birchPlanks = grid(3);
  put(birchPlanks, 3, 0, 0, blk('birch_planks'));
  put(birchPlanks, 3, 1, 0, blk('birch_planks'));
  put(birchPlanks, 3, 0, 1, blk('birch_planks'));
  put(birchPlanks, 3, 1, 1, blk('birch_planks'));
  const mb = matchOf(birchPlanks, 3);
  ok('材料组 #planks 允许白桦木板合成工作台', !!mb && mb.recipe.id === 'crafting_table',
    mb ? mb.recipe.id : '无匹配');
}

// ---- 5. 竖排 2 木板 → 4 木棍（新材料） ----
{
  const cells = grid(3);
  put(cells, 3, 0, 0, blk('oak_planks'));
  put(cells, 3, 0, 1, blk('oak_planks'));
  const m = matchOf(cells, 3);
  ok('2 木板竖排 → 4 木棍', !!m && m.recipe.id === 'stick' && m.recipe.result.count === 4,
    m ? m.recipe.id : '无匹配');
  ok('木棍是物品', !!m && m.recipe.result.material === 'item:stick');
  ok('木棍物品已登记在 ITEMS', !!ITEMS.stick && ITEMS.stick.tile === 'stick');

  // 横排不匹配（配方是竖排）
  const flat = grid(3);
  put(flat, 3, 0, 0, blk('oak_planks'));
  put(flat, 3, 1, 0, blk('oak_planks'));
  ok('2 木板横排不匹配竖排木棍配方', matchOf(flat, 3) === null);
}

// ---- 6. 4 沙 → 砂岩；4 圆石 → 石砖 ----
{
  const sand = grid(3);
  put(sand, 3, 0, 0, blk('sand'));
  put(sand, 3, 1, 0, blk('sand'));
  put(sand, 3, 0, 1, blk('sand'));
  put(sand, 3, 1, 1, blk('sand'));
  const ms = matchOf(sand, 3);
  ok('4 沙 → 砂岩', !!ms && ms.recipe.id === 'sandstone',
    ms ? ms.recipe.id : '无匹配');

  const cobble = grid(3);
  put(cobble, 3, 0, 0, blk('cobblestone'));
  put(cobble, 3, 1, 0, blk('cobblestone'));
  put(cobble, 3, 0, 1, blk('cobblestone'));
  put(cobble, 3, 1, 1, blk('cobblestone'));
  const mc = matchOf(cobble, 3);
  ok('4 圆石 → 石砖', !!mc && mc.recipe.id === 'stone_bricks',
    mc ? mc.recipe.id : '无匹配');
}

// ---- 7. 2×2 个人合成格：只放得下 2×2 配方 ----
{
  const cells = grid(2);
  put(cells, 2, 0, 0, blk('oak_planks'));
  put(cells, 2, 1, 0, blk('oak_planks'));
  put(cells, 2, 0, 1, blk('oak_planks'));
  put(cells, 2, 1, 1, blk('oak_planks'));
  const m = matchOf(cells, 2);
  ok('2×2 格内 4 木板 → 工作台（个人合成即可起步）', !!m && m.recipe.id === 'crafting_table',
    m ? m.recipe.id : '无匹配');

  // 竖排木棍配方在 2×2 内同样放得下
  const stick = grid(2);
  put(stick, 2, 0, 0, blk('oak_planks'));
  put(stick, 2, 0, 1, blk('oak_planks'));
  const mst = matchOf(stick, 2);
  ok('2×2 格内 2 木板竖排 → 木棍', !!mst && mst.recipe.id === 'stick',
    mst ? mst.recipe.id : '无匹配');
}

// ---- 8. 严格性：材料放错位置 / 放错种类都不该匹配 ----
{
  const wrong = grid(3);
  put(wrong, 3, 0, 0, blk('oak_planks'));
  put(wrong, 3, 1, 0, blk('oak_planks'));
  put(wrong, 3, 2, 0, blk('oak_planks'));
  put(wrong, 3, 0, 1, blk('oak_planks'));
  ok('4 木板摆成 L 形不匹配工作台', matchOf(wrong, 3) === null);

  const extra = grid(3);
  put(extra, 3, 0, 0, blk('oak_planks'));
  put(extra, 3, 1, 0, blk('oak_planks'));
  put(extra, 3, 0, 1, blk('oak_planks'));
  put(extra, 3, 1, 1, blk('oak_planks'));
  put(extra, 3, 2, 2, blk('dirt'));
  ok('多余材料会让整个网格不匹配', matchOf(extra, 3) === null);

  const empty = grid(3);
  ok('空网格不匹配任何配方', matchOf(empty, 3) === null);
}

// ---- 9. 匹配结果里的格子下标可用于消耗 ----
{
  const cells = grid(3);
  put(cells, 3, 1, 1, blk('oak_log'));
  const m = matchOf(cells, 3);
  ok('匹配结果给出参与格子下标', !!m && m.cells.length === 1 && m.cells[0] === 4,
    m ? `cells=[${m.cells}]` : '无匹配');
}

// ---- 10. 背包取放闭环：取料 → 合成 → 产出，材料被扣除 ----
{
  // 模拟 CraftingHost：背包用 'b:<id>' / 'i:<name>' 键，合成用材料标识
  const bag = new Map();
  const keyOf = (material) => {
    if (material.startsWith('item:')) return `i:${material.slice(5)}`;
    return `b:${id(material)}`;
  };
  const materialOf = (key) => {
    if (key.startsWith('i:')) return `item:${key.slice(2)}`;
    const num = Number(key.slice(2));
    return reg.get(num).id === num ? reg.get(num).name : null;
  };
  const host = {
    getMaterials: () => [...bag].map(([k, n]) => ({ material: materialOf(k), count: n })).filter((m) => m.material),
    take: (material) => {
      const key = keyOf(material);
      if ((bag.get(key) ?? 0) <= 0) return false;
      bag.set(key, bag.get(key) - 1);
      if (bag.get(key) === 0) bag.delete(key);
      return true;
    },
    giveBack: (material) => {
      const key = keyOf(material);
      bag.set(key, (bag.get(key) ?? 0) + 1);
    },
    produce: (material, count) => {
      const key = keyOf(material);
      bag.set(key, (bag.get(key) ?? 0) + count);
    },
  };

  const takeInto = (cells, size, col, row, material) => {
    assert.ok(host.take(material), `背包里应有 ${material}`);
    put(cells, size, col, row, material);
  };

  // 原木 → 木板
  bag.set(`b:${id('oak_log')}`, 1);
  const c1 = grid(3);
  takeInto(c1, 3, 0, 0, 'oak_log');
  const m1 = matchOf(c1, 3);
  ok('取料后可匹配原木→木板', !!m1 && m1.recipe.id === 'oak_planks');
  host.produce(m1.result.material, m1.result.count);
  ok('产出 4 橡木木板进背包', bag.get(`b:${id('oak_planks')}`) === 4,
    `count=${bag.get(`b:${id('oak_planks')}`)}`);
  ok('原木已被消耗', (bag.get(`b:${id('oak_log')}`) ?? 0) === 0);

  // 木板 → 工作台（2×2）
  const c2 = grid(3);
  takeInto(c2, 3, 0, 0, 'oak_planks');
  takeInto(c2, 3, 1, 0, 'oak_planks');
  takeInto(c2, 3, 0, 1, 'oak_planks');
  takeInto(c2, 3, 1, 1, 'oak_planks');
  const m2 = matchOf(c2, 3);
  ok('4 木板可合成工作台', !!m2 && m2.recipe.id === 'crafting_table');
  host.produce(m2.result.material, m2.result.count);
  ok('工作台进背包', bag.get(`b:${id('crafting_table')}`) === 1);
  ok('4 块木板全部被扣除', (bag.get(`b:${id('oak_planks')}`) ?? 0) === 0);

  // 材料不足时取料必须失败，避免凭空造物
  bag.clear();
  ok('背包空时取料失败', host.take('oak_log') === false);
  ok('取料失败不会产出', (bag.get(`b:${id('oak_planks')}`) ?? 0) === 0);
}

// ---- 11. 材料标识 ↔ 背包键 / 背包栈 的转换 ----
{
  ok('可交互方块是工作台', INTERACTIVE_BLOCK === 'crafting_table');
  ok('工作台方块确实已注册', !!reg.byNameGet(INTERACTIVE_BLOCK));

  const stack = materialToStack('oak_planks', reg);
  ok('方块材料 → 背包栈', !!stack && stack.kind === 'block' && stack.id === id('oak_planks'));
  const itemStack = materialToStack('item:stick', reg);
  ok('物品材料 → 背包栈', !!itemStack && itemStack.kind === 'item' && itemStack.id === 'stick');
  ok('未知材料 → null', materialToStack('no_such_thing', reg) === null);

  ok('背包键 → 方块材料',
    inventoryKeyToMaterial(`b:${id('crafting_table')}`, reg) === 'crafting_table');
  ok('背包键 → 物品材料',
    inventoryKeyToMaterial('i:stick', reg) === 'item:stick');
  ok('越界方块 id → null', inventoryKeyToMaterial('b:9999', reg) === null);
  ok('非法背包键 → null', inventoryKeyToMaterial('x:1', reg) === null);
}

// ---- 12. E04：装备配方 ----
{
  const { EQUIPMENT } = require('./logic/player/equipment.js');
  const equipRecipes = CRAFTING_RECIPES.filter((r) => !!EQUIPMENT[r.id]);
  ok('41 件装备各有配方（新增铜工具 4 + 铜锄 1）', equipRecipes.length === 41, String(equipRecipes.length));
  for (const r of equipRecipes) {
    ok(`配方 ${r.id} 产物与 EQUIPMENT 一致`,
      r.result.material === `item:${r.id}` && !!ITEMS[r.id] && r.result.count === 1);
  }

  // 铁剑/铁镐：材料 + 木棍
  const grid = (rows, symbols) => rows.join('').split('').map((c) => symbols[c] ?? null);
  const iron = { I: 'item:iron_ingot', S: 'item:stick' };
  ok('铁剑配方可匹配', matchRecipe(grid(['I  ', 'I  ', 'S  '], iron), 3)?.recipe.id === 'iron_sword');
  ok('铁镐配方可匹配', matchRecipe(grid(['III', ' S ', ' S '], iron), 3)?.recipe.id === 'iron_pickaxe');
  ok('铁斧配方可匹配', matchRecipe(grid(['II ', 'IS ', ' S '], iron), 3)?.recipe.id === 'iron_axe');
  ok('铁锹配方可匹配', matchRecipe(grid(['I  ', 'S  ', 'S  '], iron), 3)?.recipe.id === 'iron_shovel');
  ok('多放材料不误匹配', matchRecipe(grid(['III', 'ISI', 'SSS'], iron), 3) === null);

  // 皮革盔甲
  const leather = { L: 'item:leather' };
  ok('皮头盔配方可匹配', matchRecipe(grid(['LLL', 'L L'], leather), 3)?.recipe.id === 'leather_helmet');
  ok('皮胸甲配方可匹配', matchRecipe(grid(['L L', 'LLL', 'LLL'], leather), 3)?.recipe.id === 'leather_chestplate');
  ok('皮护腿配方可匹配', matchRecipe(grid(['LLL', 'L L', 'L L'], leather), 3)?.recipe.id === 'leather_leggings');
  ok('皮靴配方可匹配', matchRecipe(grid(['L L', 'L L'], leather), 3)?.recipe.id === 'leather_boots');

  // 木工具使用材料组 #planks，任一木板均可
  const wood = { P: 'birch_planks', S: 'item:stick' };
  ok('木剑可用白桦木板', matchRecipe(grid(['P  ', 'P  ', 'S  '], wood), 3)?.recipe.id === 'wooden_sword');
}

// v1.7.0 内容植物闭环：棉花块与荧光火把
const patternGrid = (rows, symbols) => rows.join('').split('').map((c) => symbols[c] ?? null);
ok('棉花×4 可合成棉花块',
  matchRecipe(patternGrid(['CC', 'CC'], { C: 'item:cotton' }), 2)?.recipe.id === 'cotton_block');
ok('荧光孢子+木棍可合成 2 荧光火炬',
  (() => {
    const m = matchRecipe(['item:glow_spore', null, 'item:stick', null], 2);
    return m?.recipe.id === 'glow_torch' && m.recipe.result.count === 2;
  })());
// 多一个不相干材料就不该匹配（合成必须严格）
ok('棉花块混入多余材料不匹配',
  matchRecipe(['item:cotton', 'item:cotton', 'item:cotton', 'dirt'], 2)?.recipe.id !== 'cotton_block');

// C01：煤炭 + 木棍 → 4 火把
ok('煤炭+木棍可合成 4 火把', (() => {
  const r = CRAFTING_RECIPES.find((x) => x.id === 'torch_fuel');
  return !!r && r.result.material === 'torch' && r.result.count === 4 &&
    r.pattern.join('') === 'CS' && r.key.C === 'item:coal' && r.key.S === 'item:stick';
})());

log(`\n合成回归全部通过（${passed} 项）`);
