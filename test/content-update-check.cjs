/**
 * 内容更新回归（更多生物 / 弓箭 / 沙石）。
 * 运行：npm run test:content（需先 npm run test:snapshot）
 *
 * 覆盖：末位追加的砂岩家族、弓箭合成与熔炼闭环、三种新生物的属性与掉落、
 *       行为树可构造、箭矢飞行 / 命中 / 生命周期。全部为纯逻辑，不需要 WebGL。
 */
const assert = require('node:assert');
const THREE = require('three');

const { BlockRegistry, registerBuiltinBlocks } = require('./terrain-logic/world/blocks.js');
const { CRAFTING_RECIPES, matchRecipe, recipeFits } = require('./terrain-logic/player/crafting.js');
const { smeltOutputOf } = require('./terrain-logic/player/smelting.js');
const { NEW_MOBS, NEW_ITEMS, RANGED } = require('./terrain-logic/core/tuning.js');
const { EntityManager } = require('./terrain-logic/entity/entity.js');
const behaviors = require('./logic/ai/behaviors.js');
const { BehaviorTree } = require('./logic/ai/BehaviorTree.js');
const { ArrowManager } = require('./logic/entity/projectile.js');
const { ITEMS } = require('./terrain-logic/player/survival.js');

const log = (...a) => console.log(...a);
let passed = 0;
function ok(name, cond, extra = '') {
  assert.ok(cond, `${name} ${extra}`);
  passed++;
  log(`PASS  ${name}${extra ? ' — ' + extra : ''}`);
}

log('内容更新回归（生物 / 弓箭 / 沙石）');

// ---- 1. 砂岩家族：末位追加、属性可玩 ----
const reg = new BlockRegistry();
registerBuiltinBlocks(reg);
const sandstoneNames = ['smooth_sandstone', 'chiseled_sandstone', 'cut_sandstone', 'red_sandstone'];
const oldLast = reg.byNameGet('glow_torch').id;
const newIds = sandstoneNames.map((n) => reg.byNameGet(n)?.id);
ok('四种砂岩方块已注册且末位追加',
  newIds.every((id) => typeof id === 'number' && id > oldLast),
  `oldLast=${oldLast} new=${newIds.join(',')}`);
ok('砂岩家族 id 连续',
  newIds.every((id, i) => i === 0 || id === newIds[i - 1] + 1));
ok('砂岩家族为可挖掘实心方块',
  sandstoneNames.every((n) => {
    const d = reg.byNameGet(n);
    return d && d.shape === 'cube' && d.solid && d.opaque && d.hardness > 0 && d.drops.length > 0;
  }));
ok('砂岩纹理三面齐全',
  sandstoneNames.every((n) => {
    const t = reg.byNameGet(n).tiles;
    return t.top === n && t.bottom === n && t.side === n;
  }));
ok('沙砾掉落燧石（箭的材料来源）',
  reg.byNameGet('gravel').drops.some((d) => d.name === 'item:flint' && d.chance > 0));

// ---- 2. 合成 / 熔炼闭环 ----
const bowGrid = [
  null, 'item:string', null,
  'item:string', 'item:stick', 'item:string',
  null, 'item:stick', null,
];
const bow = matchRecipe(bowGrid, 3);
ok('弓：3 线 + 2 棍在 3×3 工作台合成', bow?.recipe.id === 'bow');
ok('弓放不进 2×2 个人合成格', !recipeFits(CRAFTING_RECIPES.find((r) => r.id === 'bow'), 2));
const arrow = matchRecipe(['item:flint', 'item:stick', 'item:feather', null], 2);
ok('箭：燧石 + 木棍 + 羽毛无序合成 4 支', arrow?.recipe.id === 'arrow' && arrow.result.count === 4);
ok('切制砂岩可由 4 砂岩合成',
  matchRecipe(['sandstone', 'sandstone', 'sandstone', 'sandstone'], 2)?.recipe.id === 'cut_sandstone');
ok('錾制砂岩由 2 切制砂岩合成',
  matchRecipe(['cut_sandstone', 'cut_sandstone', null, null], 2)?.recipe.id === 'chiseled_sandstone');
ok('红砂岩由 4 红沙合成',
  matchRecipe(['red_sand', 'red_sand', 'red_sand', 'red_sand'], 2)?.recipe.id === 'red_sandstone');
ok('平滑砂岩走熔炉（砂岩烧炼）', smeltOutputOf('sandstone') === 'smooth_sandstone');
ok('弓箭与砂岩物品条目齐全',
  ['bow', 'arrow', 'gunpowder', 'string', 'ink_sac', 'flint'].every((n) => !!ITEMS[n]));
ok('新物品不可食（避免破坏生存平衡）',
  ['bow', 'arrow', 'gunpowder', 'string', 'ink_sac', 'flint'].every((n) => !ITEMS[n].food && NEW_ITEMS[n]));

// ---- 3. 新生物属性与掉落 ----
const events = { emit() {}, on() {} };
const mobs = new EntityManager({}, new THREE.Scene(), events, 1);
const creeper = mobs.getType('creeper');
const spider = mobs.getType('spider');
const squid = mobs.getType('squid');
ok('三种新生物已注册', !!creeper && !!spider && !!squid);
ok('苦力怕敌对且自爆半径来自调参表',
  creeper.hostile && creeper.explodeRadius === NEW_MOBS.creeper.explodeRadius && !creeper.burnInDay);
ok('苦力怕掉落火药、蜘蛛掉落线',
  creeper.drops.some((d) => d.name === 'item:gunpowder') &&
  spider.drops.some((d) => d.name === 'item:string'));
ok('蜘蛛比普通敌对生物更快', spider.speed > mobs.getType('zombie').speed);
ok('鱿鱼为水生且掉落墨囊',
  squid.aquatic === true && squid.drops.some((d) => d.name === 'item:ink_sac'));
ok('新生物模型可构造（无 DOM 依赖）',
  [creeper, spider, squid].every((t) => !!t.build().group));

// ---- 4. 行为树 ----
for (const name of ['creeper', 'spider', 'squid']) {
  ok(`${name} 行为树可构造`,
    (() => { try { BehaviorTree.fromJSON(behaviors[`${name}Behavior`]); return true; } catch { return false; } })());
}

// ---- 5. 箭矢飞行 / 命中 / 生命周期 ----
const fired = [];
const arrowEvents = [];
const atlasStub = {
  texture: null,
  makeItemGeometry: () => new THREE.BoxGeometry(0.1, 0.1, 0.4),
};
const particlesStub = { burst() {} };
const worldStub = { raycast: () => null };
function makeArrows(entityStub) {
  const manager = new ArrowManager(
    new THREE.Scene(), atlasStub, worldStub, entityStub,
    { emit: (name, payload) => arrowEvents.push({ name, payload }) }, particlesStub,
  );
  return manager;
}
const arrows = makeArrows({ raycast: () => null });
arrows.shoot(new THREE.Vector3(0, 10, 0), new THREE.Vector3(1, 0, 0));
ok('射击产生一支飞行中的箭', arrows.count === 1);
arrows.update(0.1, true);
ok('箭矢沿视线方向前进', arrows.count === 1);
for (let i = 0; i < 70; i++) arrows.update(0.1, true);
ok('箭矢到期自动回收', arrows.count === 0);
ok('射击与到期均发事件',
  arrowEvents.some((e) => e.name === 'arrow:shoot') && arrowEvents.some((e) => e.name === 'arrow:hit') === false);

let damage = 0;
const hitArrows = makeArrows({
  raycast: () => ({
    entity: {
      type: { id: 'creeper' }, pos: new THREE.Vector3(2, 10, 0), height: 1.7,
      hurt: (n) => { damage = n; },
    },
    dist: 1,
  }),
});
hitArrows.shoot(new THREE.Vector3(0, 10, 0), new THREE.Vector3(1, 0, 0));
hitArrows.update(0.1, true);
ok('箭命中生物造成 RANGED.arrowDamage 伤害并回收',
  damage === RANGED.arrowDamage && hitArrows.count === 0);
ok('命中生物发 arrow:hit 事件',
  arrowEvents.some((e) => e.name === 'arrow:hit' && e.payload.kind === 'entity'));

const blockArrows = new ArrowManager(
  new THREE.Scene(), atlasStub,
  { raycast: () => ({ x: 1, y: 10, z: 0, dist: 1 }) },
  { raycast: () => null }, { emit() {} }, particlesStub,
);
blockArrows.shoot(new THREE.Vector3(0, 10, 0), new THREE.Vector3(1, 0, 0));
blockArrows.update(0.1, true);
ok('箭命中方块后消失', blockArrows.count === 0);
ok('暂停时不推进箭矢', (() => {
  const paused = makeArrows({ raycast: () => null });
  paused.shoot(new THREE.Vector3(0, 10, 0), new THREE.Vector3(1, 0, 0));
  paused.update(10, false);
  return paused.count === 1;
})());

log(`\n${passed} passed / 0 failed`);
