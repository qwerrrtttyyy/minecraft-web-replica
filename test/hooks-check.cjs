/**
 * A2-5 核心通用接口回归（纯逻辑）：
 *  - DamageKind：伤害类型进入 combat:damage-incoming 载荷与 survival:damage 事件
 *  - 玩家行为扩展点 player:use-item / mining / attack / used-tool：无插件时逐项等于旧值，
 *    注册可改写、卸载后复原、异常处理器隔离
 *  - SaveData.plugins? 数据袋：旧档 / 新档校验，save:collect / save:restore 往返
 *  - PanelHost：注册 / 打开 / 关闭 / 注销与暂停状态机的对接
 */
const assert = require('node:assert');
const { ExtensionRegistry, EXTENSION_POINTS: EP } = require('./logic/services/plugins/extensions.js');
const { SurvivalState } = require('./logic/player/survival.js');
const { EventBus } = require('./logic/core/events.js');
const hooks = require('./logic/player/playerHooks.js');
const { PluginSaveBag, isPlainRecord } = require('./logic/services/plugins/saveBag.js');
const { PanelHost } = require('./logic/services/ui/PanelHost.js');
const { validateSave, normalizeSave } = require('./logic/save/save.js');

let passed = 0;
const ok = (name, cond, detail = '') => {
  assert.ok(cond, `${name}${detail ? ' — ' + detail : ''}`);
  passed++;
};
const silence = (fn) => {
  const orig = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = orig;
  }
};

// ---------- 伤害类型 ----------
const registry = { get: (id) => ({ id, name: id === 5 ? 'dirt' : 'air' }) };
function makeSurvival(ext) {
  const events = new EventBus();
  const s = new SurvivalState(events, registry, ext);
  s.mode = 'survival';
  return { s, events };
}
{
  const { s } = makeSurvival(new ExtensionRegistry());
  s.damage(5, '测试', false);
  ok('无插件：伤害按原值落账', s.health === 15, `health=${s.health}`);
  s.damage(2.5, '测试', false, 'fall');
  ok('无插件：带 kind 的伤害同样按原值落账', s.health === 12.5);
}
{
  const ext = new ExtensionRegistry();
  const seen = [];
  ext.register(EP.COMBAT_DAMAGE_INCOMING, 'test:kind', (p) => {
    seen.push(p.kind);
  });
  const { s, events } = makeSurvival(ext);
  const evKinds = [];
  events.on('survival:damage', (e) => evKinds.push(e.kind));
  s.damage(1, 'a', false);
  s.damage(1, 'b', false, 'attack');
  s.damage(1, 'c', false, 'explosion');
  s.damage(1, 'd', false, 'fall');
  ok('kind 缺省为 other，且逐次透传到扩展点载荷', seen.join() === 'other,attack,explosion,fall', seen.join());
  ok('survival:damage 事件带 kind', evKinds.join() === 'other,attack,explosion,fall', evKinds.join());
  ext.register(EP.COMBAT_DAMAGE_INCOMING, 'test:only-attack', (p) => (p.kind === 'attack' ? { amount: 0 } : undefined));
  const before = s.health;
  ok('处理器可按 kind 选择性免伤：attack 被吸收', s.damage(4, 'e', false, 'attack') === false && s.health === before);
  s.damage(4, 'f', false, 'drown');
  ok('处理器可按 kind 选择性免伤：drown 照常', s.health === before - 4);
}
{
  // 溺水 / 饥饿由 SurvivalState 内部发起，kind 必须正确标注
  const ext = new ExtensionRegistry();
  const seen = [];
  ext.register(EP.COMBAT_DAMAGE_INCOMING, 'test:kind', (p) => {
    seen.push(p.kind);
  });
  const { s } = makeSurvival(ext);
  s.breath = 0;
  s.hunger = 0;
  for (let i = 0; i < 400; i++) s.tick(0.05, { moving: false, sprinting: false, mining: false, underwater: true });
  ok('内部溺水伤害标注 drown', seen.includes('drown'), seen.slice(0, 6).join());
  ok('内部饥饿伤害标注 starve', seen.includes('starve'), seen.slice(0, 6).join());
  ok('内部伤害不会误标为 other', !seen.includes('other'), seen.slice(0, 6).join());
}

// ---------- 挖掘 ----------
const blocks = [
  { name: 'dirt', hardness: 0.5, sound: 'gravel' },
  { name: 'stone', hardness: 1.5, sound: 'stone' },
  { name: 'iron_ore', hardness: 3, sound: 'stone' },
  { name: 'tall_grass', hardness: 0, sound: 'grass' },
];
for (const ext of [null, undefined, new ExtensionRegistry()]) {
  for (const b of blocks) {
    const r = hooks.resolveMining(ext, b, 'iron_pickaxe');
    ok(
      `无插件挖掘耗时不变（${b.name} / ${ext === null ? 'null' : ext ? 'empty' : 'undef'}）`,
      r.time === Math.max(0.06, b.hardness * 1.1) && r.harvest === true,
      JSON.stringify(r),
    );
  }
}
{
  const ext = new ExtensionRegistry();
  let last = null;
  ext.register(EP.PLAYER_MINING, 'test:tools', (p) => {
    last = { ...p };
    if (p.toolId === 'iron_pickaxe' && p.sound === 'stone') return { time: p.time / 6 };
    if (p.block === 'iron_ore' && p.toolId === null) return { harvest: false };
    return undefined;
  });
  const fast = hooks.resolveMining(ext, blocks[1], 'iron_pickaxe');
  ok(
    'mining 载荷字段完整',
    last.block === 'stone' &&
      last.hardness === 1.5 &&
      last.toolId === 'iron_pickaxe' &&
      last.harvest === true &&
      last.time === 1.5 * 1.1,
    JSON.stringify(last),
  );
  ok('mining 可改写耗时', Math.abs(fast.time - (1.5 * 1.1) / 6) < 1e-9 && fast.harvest, JSON.stringify(fast));
  ok('mining 可改写 harvest', hooks.resolveMining(ext, blocks[2], null).harvest === false);
  ok('mining 耗时下限 0.06', hooks.resolveMining(ext, blocks[0], 'iron_pickaxe').time >= 0.06);
  ext.register(EP.PLAYER_MINING, 'test:bad', () => ({ time: Number.NaN }), -1);
  ok('mining 非法耗时回退核心值', hooks.resolveMining(ext, blocks[0], null).time === 0.5 * 1.1);
  ext.unregisterOwner('test:bad');
  ext.register(
    EP.PLAYER_MINING,
    'test:throw',
    () => {
      throw new Error('boom');
    },
    10,
  );
  const iso = silence(() => hooks.resolveMining(ext, blocks[1], 'iron_pickaxe'));
  ok('mining 异常处理器被隔离，其余处理器照常', Math.abs(iso.time - (1.5 * 1.1) / 6) < 1e-9);
  ext.unregisterOwner('test:tools');
  ext.unregisterOwner('test:throw');
  const back = hooks.resolveMining(ext, blocks[2], null);
  ok('mining 卸载后复原', back.time === 3 * 1.1 && back.harvest === true && !ext.has(EP.PLAYER_MINING));
}

// ---------- 攻击 ----------
ok(
  '无插件攻击伤害为 3',
  hooks.resolveAttack(null, 'iron_sword', 'zombie') === 3 &&
    hooks.resolveAttack(new ExtensionRegistry(), null, 'zombie') === 3 &&
    hooks.BASE_ATTACK === 3,
);
{
  const ext = new ExtensionRegistry();
  let last = null;
  ext.register(EP.PLAYER_ATTACK, 'test:sword', (p) => {
    last = { ...p };
    return p.toolId === 'iron_sword' ? { amount: p.amount + 3 } : undefined;
  });
  ok('attack 可改写伤害', hooks.resolveAttack(ext, 'iron_sword', 'zombie') === 6);
  ok('attack 载荷字段完整', last.toolId === 'iron_sword' && last.target === 'zombie' && last.amount === 3);
  ok('attack 无工具不加成', hooks.resolveAttack(ext, null, 'zombie') === 3);
  ext.register(EP.PLAYER_ATTACK, 'test:neg', () => ({ amount: -5 }), -1);
  ok('attack 伤害不为负', hooks.resolveAttack(ext, null, 'pig') === 0);
  ext.unregisterOwner('test:neg');
  ext.unregisterOwner('test:sword');
  ok('attack 卸载后复原', hooks.resolveAttack(ext, 'iron_sword', 'zombie') === 3);
}

// ---------- 右键使用 ----------
ok(
  '无插件不截断右键',
  hooks.resolveUseItem(null, { kind: 'item', id: 'iron_chestplate' }) === false &&
    hooks.resolveUseItem(new ExtensionRegistry(), { kind: 'block', id: 5 }) === false,
);
{
  const ext = new ExtensionRegistry();
  const keys = [];
  ext.register(EP.PLAYER_USE_ITEM, 'test:armor', (p) => {
    keys.push(p.key);
    return String(p.stack.id).endsWith('_chestplate') ? { handled: true } : undefined;
  });
  ok('use-item 可声明已处理', hooks.resolveUseItem(ext, { kind: 'item', id: 'iron_chestplate' }) === true);
  ok('use-item 未处理时放行', hooks.resolveUseItem(ext, { kind: 'item', id: 'apple' }) === false);
  hooks.resolveUseItem(ext, { kind: 'block', id: 5 });
  ok('use-item 载荷带背包键', keys.join() === 'i:iron_chestplate,i:apple,b:5', keys.join());
  const stack = { kind: 'item', id: 'iron_helmet' };
  ext.register(EP.PLAYER_USE_ITEM, 'test:mutate', (p) => {
    p.stack.id = 'hacked';
  });
  hooks.resolveUseItem(ext, stack);
  ok('use-item 载荷是拷贝，处理器改不到玩家手里的栈', stack.id === 'iron_helmet');
  ext.unregisterOwner('test:armor');
  ext.unregisterOwner('test:mutate');
  ok('use-item 卸载后复原', hooks.resolveUseItem(ext, { kind: 'item', id: 'iron_chestplate' }) === false);
}

// ---------- 手持工具识别 / 使用通知 ----------
ok(
  'heldToolId 识别工具与武器',
  hooks.heldToolId({ kind: 'item', id: 'iron_pickaxe' }) === 'iron_pickaxe' &&
    hooks.heldToolId({ kind: 'item', id: 'iron_sword' }) === 'iron_sword',
);
ok(
  'heldToolId 排除盔甲 / 方块 / 普通物品 / 空手',
  hooks.heldToolId({ kind: 'item', id: 'iron_chestplate' }) === null &&
    hooks.heldToolId({ kind: 'block', id: 1 }) === null &&
    hooks.heldToolId({ kind: 'item', id: 'apple' }) === null &&
    hooks.heldToolId(null) === null,
);
{
  const ext = new ExtensionRegistry();
  const got = [];
  hooks.notifyUsedTool(ext, 'iron_pickaxe', 'mine');
  ext.register(EP.PLAYER_USED_TOOL, 'test:wear', (p) => {
    got.push(`${p.toolId}|${p.key}|${p.action}`);
  });
  hooks.notifyUsedTool(ext, 'iron_pickaxe', 'mine');
  hooks.notifyUsedTool(ext, 'iron_sword', 'attack');
  hooks.notifyUsedTool(ext, null, 'attack');
  ok(
    'used-tool 通知载荷正确，空手不通知',
    got.join() === 'iron_pickaxe|i:iron_pickaxe|mine,iron_sword|i:iron_sword|attack',
    got.join(),
  );
  hooks.notifyUsedTool(null, 'iron_sword', 'attack');
  ok('used-tool 无注册表时无副作用', got.length === 2);
}

// ---------- SaveData.plugins? ----------
const validSave = () => ({
  version: 2,
  seed: 12345,
  mode: 'survival',
  edits: [['1,2,3', 5]],
  player: { x: 1, y: 2, z: 3, yaw: 0, pitch: 0, fly: false },
  survival: {
    health: 20,
    hunger: 20,
    breath: 15,
    inventory: [['i:apple', 2]],
    spawn: { x: 1, y: 2, z: 3 },
  },
  dayTime: 0.32,
  hotbar: Array.from({ length: 9 }, () => null),
  slot: 0,
  settings: { sound: true, renderDistance: 5, sensitivity: 1, fov: 72 },
  savedAt: 1700000000000,
});
ok('旧档（无 plugins）通过校验', validateSave(validSave()) === true);
ok(
  '新档 plugins 为对象通过校验',
  validateSave({ ...validSave(), plugins: { 'core:armor': { v: 1, slots: {} } } }) === true,
);
ok(
  'plugins 为数组 / null / 字符串拒绝',
  !validateSave({ ...validSave(), plugins: [] }) &&
    !validateSave({ ...validSave(), plugins: null }) &&
    !validateSave({ ...validSave(), plugins: 'x' }),
);
{
  const round = normalizeSave(JSON.parse(JSON.stringify({ ...validSave(), plugins: { 'a:b': { n: 1 } } })));
  ok('含 plugins 的档 JSON 往返保留数据', round && round.plugins['a:b'].n === 1);
  const old = normalizeSave(JSON.parse(JSON.stringify(validSave())));
  ok('旧档往返不凭空生成 plugins', old && old.plugins === undefined);
}
ok(
  'isPlainRecord 只认普通对象',
  isPlainRecord({}) &&
    isPlainRecord(Object.create(null)) &&
    !isPlainRecord([]) &&
    !isPlainRecord(null) &&
    !isPlainRecord(new Date()),
);
{
  const ext = new ExtensionRegistry();
  const bag = new PluginSaveBag(ext);
  let restored = null;
  let state = 0;
  ext.register(EP.SAVE_RESTORE, 'test:p', (p) => {
    restored = p.data;
    state = p.data['test:p']?.n ?? 0;
  });
  ext.register(EP.SAVE_COLLECT, 'test:p', (p) => {
    p.data['test:p'] = { n: state };
  });
  bag.load({ 'test:p': { n: 7 }, 'other:q': { keep: true } });
  ok('load 派发 save:restore 并下发数据', state === 7 && restored['other:q'].keep === true);
  ok('get 读到当前世界的插件数据', bag.get('test:p').n === 7);
  state = 9;
  const out = bag.collect();
  ok('collect 派发 save:collect 写回', out['test:p'].n === 9);
  ok('collect 保留未参与插件（已停用）的数据', out['other:q'].keep === true);
  ext.unregisterOwner('test:p');
  ok('插件卸载后 collect 仍保留其最后一次数据', bag.collect()['test:p'].n === 9);
  bag.load(undefined);
  ok('新世界 load(undefined) 清空数据袋', Object.keys(bag.collect()).length === 0);
  bag.load([1, 2]);
  ok('非对象数据当作空袋', Object.keys(bag.collect()).length === 0);
  ext.register(EP.SAVE_COLLECT, 'test:u', (p) => {
    p.data['test:u'] = undefined;
  });
  ok('undefined 值不进存档', !('test:u' in bag.collect()));
  ok(
    '无插件时 collect 为空（存档不新增 plugins 字段）',
    Object.keys(new PluginSaveBag(new ExtensionRegistry()).collect()).length === 0,
  );
}

// ---------- PanelHost ----------
function makeHost(survival = true) {
  const log = [];
  const buttons = new Map();
  const host = new PanelHost({
    addMenuButton: (label, onClick) => {
      buttons.set(label, onClick);
      log.push(`btn+${label}`);
      return () => {
        buttons.delete(label);
        log.push(`btn-${label}`);
      };
    },
    showPanel: (title, _root, onClose) => {
      log.push(`show:${title}`);
      host._close = onClose;
    },
    hidePanel: () => log.push('hide'),
    anchor: (name) => ({ name }),
    addSlotDecorator: () => {
      log.push('deco+');
      return () => log.push('deco-');
    },
    enter: (from) => log.push(`enter:${from}`),
    leave: (from) => log.push(`leave:${from}`),
    isSurvival: () => survival,
    toast: (m) => log.push(`toast:${m}`),
  });
  return { host, log, buttons };
}
{
  const { host, log, buttons } = makeHost();
  const hooksLog = [];
  const off = host.register({
    id: 'test:armor',
    label: '装备',
    root: {},
    survivalOnly: true,
    onShow: () => hooksLog.push('show'),
    onHide: () => hooksLog.push('hide'),
  });
  ok('register 在菜单加入口按钮', buttons.has('装备') && host.has('test:armor'));
  let threw = false;
  try {
    host.register({ id: 'test:armor', label: 'x', root: {} });
  } catch {
    threw = true;
  }
  ok('重复面板 id 拒绝', threw);
  buttons.get('装备')();
  ok(
    '菜单按钮打开面板：来源为 menu',
    host.openId === 'test:armor' && log.includes('enter:menu') && log.includes('show:装备'),
  );
  host._close();
  ok(
    '关闭回到来源（菜单）并触发 onHide',
    host.openId === null && log.at(-1) === 'leave:menu' && hooksLog.join() === 'show,hide',
  );
  ok('open 默认来源 game', host.open('test:armor') && log.includes('enter:game'));
  host.close();
  ok('从游戏打开的面板关闭后恢复游戏', log.at(-1) === 'leave:game');
  host.close();
  ok('重复 close 无副作用', log.filter((l) => l.startsWith('leave')).length === 2);
  host.open('test:armor');
  off();
  ok('注销时自动关闭已打开的面板并移除按钮', host.openId === null && !buttons.has('装备') && log.at(-1) === 'btn-装备');
  ok('注销后无法再打开', host.open('test:armor') === false);
  off();
  ok('重复注销无副作用', log.filter((l) => l === 'btn-装备').length === 1);
  ok(
    'anchor / decorateSlot 透传宿主',
    host.anchor('above-hotbar-left').name === 'above-hotbar-left' &&
      typeof host.decorateSlot(() => {}) === 'function' &&
      log.includes('deco+'),
  );
}
{
  const { host, log } = makeHost(false);
  host.register({ id: 'test:armor', label: '装备', root: {}, survivalOnly: true });
  ok(
    'survivalOnly 面板在创造模式拒绝打开并提示',
    host.open('test:armor') === false &&
      host.openId === null &&
      log.some((l) => l.startsWith('toast:')) &&
      !log.some((l) => l.startsWith('enter')),
  );
}

console.log(`[hooks] A2-5 核心通用接口 ${passed} 项断言通过`);
