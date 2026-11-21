/**
 * 装备定义纯逻辑回归（不需要 WebGL / three 运行时）。
 * 运行：npm run test:equipment（需先 npm run test:snapshot）
 *
 * 覆盖：EQUIPMENT 定义表结构（5 材质剑/镐/斧/锹 + 4 材质盔甲）、
 * 数值档位、命名约定（atlas 纹理注册依赖）、ITEMS 与 EQUIPMENT 的一致性、
 * 以及材料物品是否齐备。
 */
const assert = require('node:assert');
const {
  EQUIPMENT,
  EQUIPMENT_IDS,
  equipmentDef,
  isEquipmentId,
  slotOfKind,
  toolKindOf,
} = require('./logic/player/equipment.js');
const { ITEMS } = require('./logic/player/survival.js');

let passed = 0;
function ok(name, cond, extra = '') {
  assert.ok(cond, `${name} ${extra}`);
  passed++;
  console.log(`PASS  ${name}${extra ? ' — ' + extra : ''}`);
}

// ---- 定义表规模 ----
ok('装备总数 36（5×4 武器工具 + 4×4 盔甲）', EQUIPMENT_IDS.length === 36, String(EQUIPMENT_IDS.length));

const swords = EQUIPMENT_IDS.filter((id) => EQUIPMENT[id].kind === 'sword');
const picks = EQUIPMENT_IDS.filter((id) => EQUIPMENT[id].kind === 'pickaxe');
const axes = EQUIPMENT_IDS.filter((id) => EQUIPMENT[id].kind === 'axe');
const shovels = EQUIPMENT_IDS.filter((id) => EQUIPMENT[id].kind === 'shovel');
const armors = EQUIPMENT_IDS.filter((id) => EQUIPMENT[id].slot !== undefined);
ok('剑 / 镐 / 斧 / 锹各 5 件', [swords, picks, axes, shovels].every((a) => a.length === 5));
ok('盔甲 16 件', armors.length === 16, String(armors.length));

// ---- 数值档位 ----
const byMaterial = (ids, mat) => {
  const id = ids.find((x) => EQUIPMENT[x].material === mat);
  return id ? EQUIPMENT[id] : undefined;
};
const attackOf = { wood: 4, stone: 5, iron: 6, gold: 4, diamond: 7 };
for (const [mat, atk] of Object.entries(attackOf)) {
  const def = byMaterial(swords, mat);
  ok(`${mat} 剑攻击 ${atk}`, def && def.attack === atk, def ? String(def.attack) : '缺失');
}
const speedOf = { wood: 2, stone: 4, iron: 6, gold: 12, diamond: 8 };
for (const [mat, sp] of Object.entries(speedOf)) {
  const def = byMaterial(picks, mat);
  ok(`${mat} 镐挖掘倍率 ${sp}`, def && def.miningSpeed === sp, def ? String(def.miningSpeed) : '缺失');
}
for (const ids of [picks, axes, shovels]) {
  for (const id of ids) {
    const def = EQUIPMENT[id];
    ok(`${id} 有正耐久`, def.durability > 0, String(def.durability));
  }
}

// ---- 盔甲槽位 / 护甲 ----
const slotKind = { helmet: 'head', chestplate: 'chest', leggings: 'legs', boots: 'feet' };
for (const id of armors) {
  const def = EQUIPMENT[id];
  const kind = id.slice(id.indexOf('_') + 1);
  ok(`${id} 槽位 = ${slotKind[kind]}`, def.slot === slotKind[kind]);
  ok(`${id} 护甲 > 0`, (def.armor ?? 0) > 0, String(def.armor));
}
const armorTotal = armors.reduce((s, id) => s + (EQUIPMENT[id].armor ?? 0), 0);
ok('全套护甲（4 材质）总护甲 = 53', armorTotal === 53, String(armorTotal));

// ---- 命名约定（atlas 注册依赖）----
const WEAPON_PREFIX = ['wooden', 'stone', 'iron', 'golden', 'diamond'];
const WEAPON_KIND = ['sword', 'pickaxe', 'axe', 'shovel'];
const ARMOR_PREFIX = ['leather', 'iron', 'golden', 'diamond'];
const ARMOR_KIND = ['helmet', 'chestplate', 'leggings', 'boots'];
const expected = new Set();
for (const p of WEAPON_PREFIX) for (const k of WEAPON_KIND) expected.add(`${p}_${k}`);
for (const p of ARMOR_PREFIX) for (const k of ARMOR_KIND) expected.add(`${p}_${k}`);
for (const id of EQUIPMENT_IDS) {
  ok(`${id} 命名符合注册约定`, expected.has(id));
  const def = EQUIPMENT[id];
  ok(`${id} id = tile 且 label 非空`, def.tile === id && def.label.length > 0);
}

// ---- ITEMS 一致性 ----
for (const id of EQUIPMENT_IDS) {
  const item = ITEMS[id];
  ok(`ITEMS 含装备 ${id}`, !!item);
  if (!item) continue;
  ok(`ITEMS ${id} tile/equip 一致`, item.tile === id && item.equip === id);
}
const MATERIALS = ['coal', 'leather', 'iron_ingot', 'gold_ingot', 'copper_ingot', 'diamond'];
for (const name of MATERIALS) {
  const item = ITEMS[name];
  ok(`ITEMS 含材料 ${name}`, !!item && item.tile === name && !item.equip);
}

// ---- 辅助函数 ----
ok('slotOfKind(helmet) = head', slotOfKind('helmet') === 'head');
ok('slotOfKind(chestplate) = chest', slotOfKind('chestplate') === 'chest');
ok('slotOfKind(leggings) = legs', slotOfKind('leggings') === 'legs');
ok('slotOfKind(boots) = feet', slotOfKind('boots') === 'feet');
ok('slotOfKind(sword) = null', slotOfKind('sword') === null);
ok('toolKindOf(pickaxe) = pickaxe', toolKindOf('pickaxe') === 'pickaxe');
ok('toolKindOf(sword) = null', toolKindOf('sword') === null);
ok('isEquipmentId(iron_sword) = true', isEquipmentId('iron_sword') === true);
ok('isEquipmentId(apple) = false', isEquipmentId('apple') === false);
ok('equipmentDef 未知 id 返回 undefined', equipmentDef('nope') === undefined);

// ---- 纯函数：减伤 / 工具倍率 ----
const { armorReduction, miningSpeedFor } = require('./logic/player/equipment.js');
const { EquipmentState } = require('./logic/player/equipmentState.js');
const { EventBus } = require('./logic/core/events.js');
const { SurvivalState } = require('./logic/player/survival.js');
const { BlockRegistry, registerBuiltinBlocks } = require('./logic/world/blocks.js');

ok('armorReduction(0) = 0', armorReduction(0) === 0);
ok('armorReduction(10) = 0.4', Math.abs(armorReduction(10) - 0.4) < 1e-9);
ok('armorReduction(100) 上限 0.8', armorReduction(100) === 0.8);
ok('iron_pickaxe 挖 pickaxe 方块倍率 6', miningSpeedFor('iron_pickaxe', 'pickaxe') === 6);
ok('iron_pickaxe 挖 axe 方块倍率 1', miningSpeedFor('iron_pickaxe', 'axe') === 1);
ok('剑不加速挖掘', miningSpeedFor('iron_sword', 'pickaxe') === 1);
ok('徒手倍率 1', miningSpeedFor(null, 'pickaxe') === 1);

// ---- EquipmentState ----
const es = new EquipmentState(new EventBus());
ok('初始护甲 0', es.armorPoints === 0);
ok('首次获得铁剑耐久 250', es.initDurability('i:iron_sword', 'iron_sword') === 250);
ok('重复初始化不覆盖耐久', es.initDurability('i:iron_sword', 'iron_sword') === 250);
ok('刷新耐久不覆盖', es.initDurability('i:iron_helmet', 'iron_helmet') === 165);
ok('穿戴铁头盔成功', es.equip('head', 'iron_helmet', 165) === true);
ok('穿戴错误槽位失败', es.equip('feet', 'iron_helmet', 165) === false);
ok('铁头盔护甲 2', es.armorPoints === 2);
ok('背包装备扣耐久 1', es.damageHeld('i:iron_sword') === false && es.durabilityOf('i:iron_sword') === 249);
es.durability.set('i:wooden_sword', 1);
ok('耐久耗尽返回损坏', es.damageHeld('i:wooden_sword') === true && es.durabilityOf('i:wooden_sword') === null);
const taken = es.unequip('head');
ok('卸下返回装备与耐久', taken && taken.id === 'iron_helmet' && taken.durability === 165);
ok('卸下后护甲归零', es.armorPoints === 0);
const broken = es.damageArmor();
ok('无甲不受击扣耐久', broken.length === 0);
es.equip('chest', 'iron_chestplate', 1);
const broken2 = es.damageArmor();
ok('甲耐久耗尽返回损坏 id', broken2.length === 1 && broken2[0] === 'iron_chestplate');
es.equip('legs', 'diamond_leggings', 400);
const snapEq = es.serialize();
const es2 = new EquipmentState(new EventBus());
es2.restore(snapEq);
ok('装备存档往返：槽位', es2.slots.legs && es2.slots.legs.id === 'diamond_leggings');
ok('装备存档往返：背包耐久', es2.durabilityOf('i:iron_sword') === 249);
es2.restore(undefined);
ok('旧档无装备字段按空装备', es2.armorPoints === 0 && es2.durability.size === 0);

// ---- SurvivalState 集成 ----
const reg = new BlockRegistry();
registerBuiltinBlocks(reg);
const sv = new SurvivalState(new EventBus(), reg);
sv.addItem('iron_sword', 5);
ok('装备不可堆叠（addItem 5 件仍为 1）', sv.countKey('i:iron_sword') === 1);
ok('重复拾取装备返回 false（防静默丢弃）', sv.addItem('iron_sword') === false && sv.countKey('i:iron_sword') === 1);
ok('普通物品加入返回 true', sv.addItem('apple') === true);
ok('获得装备即初始化耐久', sv.equipment.durabilityOf('i:iron_sword') === 250);
ok('剑不能穿到甲槽', sv.equipFromInventory('iron_sword') === false);
sv.addItem('iron_helmet');
ok('从背包穿戴头盔', sv.equipFromInventory('iron_helmet') === true);
ok('穿戴后背包扣除', sv.countKey('i:iron_helmet') === 0);
ok('穿戴后护甲 2', sv.equipment.armorPoints === 2);
sv.health = 20;
sv.damage(10, 'test');
ok('护甲减伤：10 点伤害实扣 9', sv.health === 11, String(sv.health));
ok('受击扣甲耐久', sv.equipment.slots.head.durability === 164);
ok('卸下头盔', sv.unequipToInventory('head') === true);
ok('卸下后背包恢复', sv.countKey('i:iron_helmet') === 1);
ok('卸下保留剩余耐久', sv.equipment.durabilityOf('i:iron_helmet') === 164);
sv.health = 20;
sv.damage(10, 'test', false);
ok('无甲受击实扣 10', sv.health === 10, String(sv.health));
const sv2 = new SurvivalState(new EventBus(), reg);
sv2.restore(sv.serialize());
ok('生存存档往返：装备耐久', sv2.equipment.durabilityOf('i:iron_helmet') === 164);

// ---- 方块工具类别 ----
ok('石头需镐', reg.byNameGet('stone').tool === 'pickaxe');
ok('煤矿需镐', reg.byNameGet('coal_ore').tool === 'pickaxe');
ok('橡木原木需斧', reg.byNameGet('oak_log').tool === 'axe');
ok('泥土需锹', reg.byNameGet('dirt').tool === 'shovel');
ok('玻璃不享受工具加速', reg.byNameGet('glass').tool === undefined);

console.log(`\n装备系统回归：${passed} 项通过`);
