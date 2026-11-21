/**
 * 护甲插件回归（纯逻辑）：
 *  - EquipmentState：4 甲槽 / 耐久 / 序列化对称 / 旧档清空
 *  - combat:damage-incoming 管道扩展点：减伤曲线 0/10/20 点、上限截断
 *  - 卸载（unregisterOwner）后伤害路径零行为变化
 */
const assert = require('node:assert');
const {
  ExtensionRegistry,
  EXTENSION_POINTS: { COMBAT_DAMAGE_INCOMING },
} = require('./logic/services/plugins/extensions.js');
const { EquipmentState } = require('./logic/player/equipmentState.js');
const { equipmentDef } = require('./logic/player/equipment.js');
const { SurvivalState } = require('./logic/player/survival.js');
const { EventBus } = require('./logic/core/events.js');

let passed = 0;
const ok = (name, cond, detail = '') => {
  assert.ok(cond, `${name}${detail ? ' — ' + detail : ''}`);
  passed++;
};

// ---------- 定义表 ----------
ok('装备定义表非空且可查询', equipmentDef('iron_chestplate')?.slot === 'chest');
ok('盔甲定义带护甲点数与耐久', equipmentDef('iron_chestplate').armor > 0 && equipmentDef('iron_chestplate').durability > 0);

// ---------- EquipmentState ----------
const ev = new EventBus();
const eq = new EquipmentState(ev);
let changes = 0;
ev.on('equipment:change', () => changes++);
const def = equipmentDef('iron_chestplate');
ok('穿戴成功且派发 change', eq.equip('chest', 'iron_chestplate', def.durability) && changes === 1);
ok('护甲点数汇总', eq.armorPoints === def.armor);
const broken = eq.damageArmor(1);
ok('受击扣甲耐久且未损坏', broken.length === 0 && eq.slots.chest.durability === def.durability - 1);
const saved = eq.serialize();
const eq2 = new EquipmentState(new EventBus());
eq2.restore(saved);
ok('序列化往返对称', eq2.slots.chest?.id === 'iron_chestplate' && eq2.slots.chest?.durability === def.durability - 1);
eq2.restore(undefined);
ok('旧档（无字段）恢复后清空不残留', eq2.slots.chest === null && eq2.armorPoints === 0);

// ---------- 减伤管道 ----------
const registry = { get: (id) => ({ id, name: id === 5 ? 'dirt' : 'air' }) };
const events = new EventBus();

/** 构造一个 SurvivalState + 仿 armor 插件注册的减伤处理器 */
function makeSurvivalWithArmor() {
  const ext = new ExtensionRegistry();
  const s = new SurvivalState(events, registry, ext);
  s.mode = 'survival';
  const armor = { points: 0 };
  ext.register(COMBAT_DAMAGE_INCOMING, 'core:armor', (payload) => {
    const p = Math.min(20, armor.points);
    if (p <= 0) return undefined;
    return { amount: payload.amount * (1 - 0.04 * p) };
  });
  return { s, armor, ext };
}

// 0 点：零行为变化
{
  const { s, ext } = makeSurvivalWithArmor();
  s.damage(10, '测试');
  ok('0 护甲点：伤害不变', s.health === 10);
  ext.dispose();
}
// 10 点 → 60% 伤害；20 点 → 80% 减伤
{
  const { s, armor, ext } = makeSurvivalWithArmor();
  armor.points = 10;
  s.damage(10, '测试');
  ok('10 护甲点：伤害打 6 折', s.health === 20 - 6, `health=${s.health}`);
  armor.points = 20;
  s.damage(10, '测试', false);
  ok('20 护甲点：减伤 80%（截断生效）', s.health === 20 - 6 - 2, `health=${s.health}`);
  ext.dispose();
}
// 卸载后零残留
{
  const { s, armor, ext } = makeSurvivalWithArmor();
  armor.points = 20;
  ext.unregisterOwner('core:armor');
  s.damage(10, '测试');
  ok('插件卸载后伤害路径与未安装完全一致', s.health === 10);
  ext.dispose();
}
// reduce 错误隔离：抛错处理器被跳过，其余照常
{
  const ext = new ExtensionRegistry();
  ext.register(COMBAT_DAMAGE_INCOMING, 'bad:plugin', () => {
    throw new Error('boom');
  });
  ext.register(COMBAT_DAMAGE_INCOMING, 'good:plugin', (p) => ({ amount: p.amount / 2 }));
  const s = new SurvivalState(events, registry, ext);
  s.mode = 'survival';
  s.damage(10, '测试');
  ok('抛错处理器被隔离，其余处理器照常改写', s.health === 15, `health=${s.health}`);
  ext.dispose();
}

console.log(`PASS 护甲插件回归：${passed} 组断言全部通过`);
