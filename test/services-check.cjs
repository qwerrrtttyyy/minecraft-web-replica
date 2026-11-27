/**
 * v1.2.0 服务层纯逻辑回归（Node，无浏览器 / 无 three）。
 * 运行前需先执行 `npm run test:snapshot` 从当前 TS 源码生成快照。
 */
const assert = require('node:assert');

const { ServiceContainer, token } = require('./logic/services/ServiceContainer.js');
const { EventService } = require('./logic/services/events/EventService.js');
const { EventChannel } = require('./logic/services/events/EventChannel.js');
const { PluginService, scopeAPI } = require('./logic/services/plugins/PluginService.js');
const { validateSave, normalizeSave, LocalStorageProvider } = require('./logic/save/save.js');
const shim = require('./logic/core/events.js');

const results = [];
let failures = 0;
const ok = (name, fn) => {
  try {
    fn();
    results.push({ name, pass: true });
    console.log(`PASS  ${name}`);
  } catch (e) {
    failures++;
    results.push({ name, pass: false, error: e.message });
    console.log(`FAIL  ${name} — ${e.message}`);
  }
};
// CommonJS 不支持顶层 await：异步用例先收集，文件末尾统一等待再汇总
const pending = [];
const okAsync = (name, fn) => {
  pending.push(
    Promise.resolve().then(fn).then(
      () => { results.push({ name, pass: true }); console.log(`PASS  ${name}`); },
      (e) => {
        failures++;
        results.push({ name, pass: false, error: e.message });
        console.log(`FAIL  ${name} — ${e.message}`);
      },
    ),
  );
};

// ---------- 服务容器 ----------
ok('容器 provide/require 往返', () => {
  const c = new ServiceContainer();
  const t = token('a');
  const v = { n: 1 };
  assert.strictEqual(c.provide(t, v), v);
  assert.strictEqual(c.require(t), v);
});
ok('容器 optional / has / keys', () => {
  const c = new ServiceContainer();
  const a = token('a'), b = token('b');
  c.provide(a, 1);
  assert.strictEqual(c.optional(b), undefined);
  assert.strictEqual(c.has(a), true);
  assert.deepStrictEqual(c.keys(), ['a']);
});
ok('容器拒绝重复注册', () => {
  const c = new ServiceContainer();
  const t = token('a');
  c.provide(t, 1);
  assert.throws(() => c.provide(t, 2), /重复注册/);
});
ok('容器 require 未注册服务直接抛错', () => {
  const c = new ServiceContainer();
  assert.throws(() => c.require(token('missing')), /未注册/);
});
ok('容器逆序 dispose', () => {
  const c = new ServiceContainer();
  const order = [];
  c.provide(token('first'), { dispose: () => order.push('first') });
  c.provide(token('second'), { dispose: () => order.push('second') });
  c.dispose();
  assert.deepStrictEqual(order, ['second', 'first']);
  assert.throws(() => c.provide(token('x'), 1), /已销毁/);
});

// ---------- 事件服务 ----------
ok('on/emit 派发', () => {
  const ev = new EventService();
  let got = null;
  ev.on('game:start', (p) => { got = p; });
  ev.emit('game:start', { seed: 42 });
  assert.strictEqual(got.seed, 42);
});
ok('off 取消订阅', () => {
  const ev = new EventService();
  let n = 0;
  const fn = () => n++;
  ev.on('game:pause', fn);
  ev.off('game:pause', fn);
  ev.emit('game:pause', { paused: true });
  assert.strictEqual(n, 0);
});
ok('M11 过期 off() 不抹掉后续同类型订阅', () => {
  const ev = new EventService();
  let a = 0, b = 0;
  const fnA = () => a++;
  const fnB = () => b++;
  const offA = ev.on('game:start', fnA);
  ev.off('game:start', fnA);          // 先把 fnA 直接移除，offA 变为 stale
  ev.on('game:start', fnB);          // 新订阅复用同 key
  offA();                             // 旧 unsubscribe 应该不误删 fnB
  ev.emit('game:start', { seed: 1 });
  assert.strictEqual(a, 0);
  assert.strictEqual(b, 1);
});
ok('同一事件多个订阅者均收到', () => {
  const ev = new EventService();
  let a = 0, b = 0;
  ev.on('game:start', () => a++);
  ev.on('game:start', () => b++);
  ev.emit('game:start', { seed: 1 });
  assert.strictEqual(a + b, 2);
});
ok('订阅者抛错被隔离，不阻断其他订阅者', () => {
  const ev = new EventService();
  const errors = [];
  ev.setErrorHandler((i) => errors.push(i));
  let survived = 0;
  ev.on('block:break', () => { throw new Error('插件炸了'); }, 'bad-plugin');
  ev.on('block:break', () => { survived++; }, 'good-plugin');
  ev.emit('block:break', { x: 0, y: 1, z: 0, block: 1 });
  assert.strictEqual(survived, 1);
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].label, 'bad-plugin');
});
ok('stats 记录派发次数与订阅数', () => {
  const ev = new EventService();
  const off = ev.on('game:start', () => {});
  ev.emit('game:start', { seed: 1 });
  ev.emit('game:start', { seed: 2 });
  const s = ev.stats();
  assert.strictEqual(s.emitted['game:start'], 2);
  assert.strictEqual(s.subscribers, 1);
  off();
  assert.strictEqual(ev.stats().subscribers, 0);
});
ok('onAny 全局观测', () => {
  const ev = new EventService();
  const seen = [];
  const off = ev.onAny((t) => seen.push(t));
  ev.emit('save:done', { bytes: 10 });
  off();
  ev.emit('save:done', { bytes: 11 });
  assert.deepStrictEqual(seen, ['save:done']);
});
ok('once 只触发一次', () => {
  const ev = new EventService();
  let n = 0;
  ev.once('game:start', () => n++);
  ev.emit('game:start', { seed: 1 });
  ev.emit('game:start', { seed: 2 });
  assert.strictEqual(n, 1);
});
ok('EventChannel 作用域订阅可一次性清理', () => {
  const ev = new EventService();
  const ch = new EventChannel(ev, 'demo:plugin');
  ch.on('block:place', () => {});
  ch.on('block:break', () => {});
  assert.strictEqual(ev.stats().subscribers, 2);
  assert.ok(ev.stats().channels.includes('demo:plugin'));
  ch.dispose();
  assert.strictEqual(ev.stats().subscribers, 0);
  assert.ok(!ev.stats().channels.includes('demo:plugin'));
  assert.throws(() => ch.on('block:place', () => {}), /已关闭/);
});
ok('事件环深度保护', () => {
  const ev = new EventService();
  const errors = [];
  ev.setErrorHandler((i) => errors.push(i));
  let n = 0;
  ev.on('game:pause', () => { n++; ev.emit('game:pause', { paused: true }); });
  ev.emit('game:pause', { paused: true });
  assert.ok(n <= 17, `递归次数 ${n}`);
  assert.ok(errors.some((e) => String(e.error).includes('深度')));
});
ok('dispose 后不再派发', () => {
  const ev = new EventService();
  let n = 0;
  ev.on('game:start', () => n++);
  ev.dispose();
  ev.emit('game:start', { seed: 1 });
  assert.strictEqual(n, 0);
});
ok('兼容垫片仍导出 EventBus 别名', () => {
  assert.strictEqual(shim.EventBus, shim.EventService);
  assert.strictEqual(typeof shim.EventChannel, 'function');
});
okAsync('waitFor 收到事件后 resolve', async () => {
  const ev = new EventService();
  const p = ev.waitFor('game:start', 1000);
  ev.emit('game:start', { seed: 7 });
  assert.strictEqual((await p).seed, 7);
});
okAsync('waitFor 超时 reject', async () => {
  const ev = new EventService();
  await assert.rejects(() => ev.waitFor('game:start', 25), /超时/);
});

// ---------- 插件服务 ----------
const makeFakeApi = () => {
  const registeredById = new Map();
  const registeredByName = new Map();
  // 预注册内置方块 id 1~91，模拟 registerBuiltinBlocks 的效果
  for (let i = 1; i <= 91; i++) {
    registeredById.set(i, { id: i, name: `builtin:${i}` });
    registeredByName.set(`builtin:${i}`, { id: i });
  }
  return {
    version: '1.2.0',
    world: { setBlock: () => true, getBlock: () => 0 },
    player: { teleport() {}, setFly() {}, break() {}, place() {}, setCamera() {} },
    save: { import() {}, setProvider() {} },
    blocks: { 
      register() {}, 
      get: (id) => id 
    },
    tnt: { ignite() {} },
    entities: { spawn() {}, list: () => [] },
    survival: { setMode() {}, respawn() {}, give() {}, damage() {}, heal() {} },
    time: { set() {}, setDayLength() {} },
    settings: { renderDistance() {}, sensitivity() {}, fov() {}, sound() {} },
    plugins: { register() {}, enable() {}, disable() {}, unload() {}, list: () => [] },
    registerBlock(input) {
      if (registeredByName.has(input.name)) throw new Error(`方块名重复: ${input.name}`);
      const id = input.id ?? 200;
      if (id < 1 || id > 255) throw new Error(`方块 id 超出 1~255: ${id}`);
      if (registeredById.has(id)) throw new Error(`方块 id 重复: ${id}`);
      const def = { ...input, id, drops: input.drops ?? [{ name: 'self' }] };
      registeredById.set(id, def);
      registeredByName.set(def.name, def);
      return def;
    },
    registerTile() {}, registerEntity() {}, setGenerator() {},
    on() { return () => {}; }, off() {}, emit() {},
    events: {
      scope(ns, options) { return { ns, options }; },
      stats: () => ({ emitted: {}, subscribers: 0, channels: [] }),
      onAny() { return () => {}; },
      waitFor() { return Promise.resolve(); },
    },
  };
};
const fakeApi = makeFakeApi;
const makePluginService = () => {
  const ev = new EventService();
  const c = new ServiceContainer();
  const base = fakeApi();
  const ps = new PluginService(ev, c, () => base);
  return { ev, c, ps, base };
};

okAsync('插件注册与启用发出生命周期事件', async () => {
  const { ev, ps } = makePluginService();
  const seen = [];
  ev.on('plugin:registered', () => seen.push('registered'));
  ev.on('plugin:enabled', () => seen.push('enabled'));
  let setup = 0;
  ps.register({ manifest: { id: 'demo:a', version: '1.0.0' }, setup() { setup++; } });
  await ps.enable('demo:a');
  assert.strictEqual(setup, 1);
  assert.deepStrictEqual(seen, ['registered', 'enabled']);
  assert.strictEqual(ps.get('demo:a').state, 'enabled');
});
ok('插件拒绝非法 id 与重复注册', () => {
  const { ps } = makePluginService();
  assert.throws(() => ps.register({ manifest: { id: '' }, setup() {} }), /非法/);
  ps.register({ manifest: { id: 'demo:a' }, setup() {} });
  assert.throws(() => ps.register({ manifest: { id: 'demo:a' }, setup() {} }), /重复注册/);
});
okAsync('插件依赖递归启用', async () => {
  const { ps } = makePluginService();
  const order = [];
  ps.register({ manifest: { id: 'demo:base' }, setup() { order.push('base'); } });
  ps.register({ manifest: { id: 'demo:child', dependencies: ['demo:base'] }, setup() { order.push('child'); } });
  await ps.enable('demo:child');
  assert.deepStrictEqual(order, ['base', 'child']);
});
okAsync('循环依赖被拦截且不冒泡', async () => {
  const { ps } = makePluginService();
  ps.register({ manifest: { id: 'demo:a', dependencies: ['demo:b'] }, setup() {} });
  ps.register({ manifest: { id: 'demo:b', dependencies: ['demo:a'] }, setup() {} });
  await ps.enable('demo:a');
  assert.ok(['failed', 'disabled'].includes(ps.get('demo:a').state));
});
okAsync('setup 抛错被隔离为 failed 并发出 plugin:error', async () => {
  const { ev, ps } = makePluginService();
  const errs = [];
  ev.on('plugin:error', (p) => errs.push(p));
  ps.register({ manifest: { id: 'demo:boom' }, setup() { throw new Error('init failed'); } });
  await ps.enable('demo:boom');
  assert.strictEqual(ps.get('demo:boom').state, 'failed');
  assert.strictEqual(errs.length, 1);
  assert.ok(errs[0].error.includes('init failed'));
});
okAsync('插件停用后订阅与 teardown 自动清理', async () => {
  const { ev, ps } = makePluginService();
  let teardown = 0;
  ps.register({
    manifest: { id: 'demo:scope' },
    setup(ctx) {
      ctx.events.on('block:break', () => {});
      ctx.onDispose(() => teardown++);
      return () => teardown++;
    },
  });
  const before = ev.stats().subscribers;
  await ps.enable('demo:scope');
  assert.strictEqual(ev.stats().subscribers, before + 1);
  ps.disable('demo:scope');
  assert.strictEqual(ev.stats().subscribers, before);
  assert.strictEqual(teardown, 2);
  assert.strictEqual(ps.get('demo:scope').state, 'disabled');
});
okAsync('插件 unload 后从注册表移除', async () => {
  const { ps } = makePluginService();
  ps.register({ manifest: { id: 'demo:temp' }, setup() {} });
  await ps.enable('demo:temp');
  ps.unload('demo:temp');
  assert.strictEqual(ps.get('demo:temp'), undefined);
});

// ---- v1.3.2 生命周期回归 ----
okAsync('并发启用依赖插件不再误报循环依赖（child 先）', async () => {
  const { ps } = makePluginService();
  ps.register({
    manifest: { id: 'demo:base' },
    setup: async () => { await new Promise((r) => setTimeout(r, 20)); },
  });
  ps.register({ manifest: { id: 'demo:child', dependencies: ['demo:base'] }, setup() {} });
  await Promise.all([ps.enable('demo:child'), ps.enable('demo:base')]);
  assert.strictEqual(ps.get('demo:base').state, 'enabled');
  assert.strictEqual(ps.get('demo:child').state, 'enabled');
});
okAsync('并发启用依赖插件不再误报循环依赖（base 先）', async () => {
  const { ps } = makePluginService();
  ps.register({
    manifest: { id: 'demo:base' },
    setup: async () => { await new Promise((r) => setTimeout(r, 20)); },
  });
  ps.register({ manifest: { id: 'demo:child', dependencies: ['demo:base'] }, setup() {} });
  await Promise.all([ps.enable('demo:base'), ps.enable('demo:child')]);
  assert.strictEqual(ps.get('demo:base').state, 'enabled');
  assert.strictEqual(ps.get('demo:child').state, 'enabled');
});
okAsync('同一插件并发 enable 只初始化一次', async () => {
  const { ps } = makePluginService();
  let setups = 0;
  ps.register({
    manifest: { id: 'demo:once' },
    setup: async () => { setups++; await new Promise((r) => setTimeout(r, 10)); },
  });
  await Promise.all([ps.enable('demo:once'), ps.enable('demo:once'), ps.enable('demo:once')]);
  assert.strictEqual(setups, 1);
  assert.strictEqual(ps.get('demo:once').state, 'enabled');
});
okAsync('初始化中 disable 不会回写 enabled 且会清理 teardown', async () => {
  const { ps } = makePluginService();
  let teardown = 0;
  ps.register({
    manifest: { id: 'demo:slow' },
    setup: async (ctx) => {
      await new Promise((r) => setTimeout(r, 20));
      ctx.onDispose(() => teardown++);
      return () => teardown++;
    },
  });
  const p = ps.enable('demo:slow');
  ps.disable('demo:slow');
  await p;
  assert.strictEqual(ps.get('demo:slow').state, 'disabled');
  assert.strictEqual(teardown, 2);
});
okAsync('EventChannel.waitFor 在 dispose 时撤销订阅并 reject', async () => {
  const ev = new EventService();
  const ch = ev.scope('demo:wait');
  const before = ev.stats().subscribers;
  const p = ch.waitFor('game:start', 5000);
  assert.strictEqual(ev.stats().subscribers, before + 1);
  ch.dispose();
  assert.strictEqual(ev.stats().subscribers, before);
  await assert.rejects(p, /已关闭/);
});
okAsync('EventChannel.waitFor 收到事件后自动退订', async () => {
  const ev = new EventService();
  const ch = ev.scope('demo:wait-ok');
  const before = ev.stats().subscribers;
  const p = ch.waitFor('game:start', 5000);
  ev.emit('game:start', { seed: 9 });
  assert.strictEqual((await p).seed, 9);
  assert.strictEqual(ev.stats().subscribers, before);
  ch.dispose();
});
ok('EventChannel.fork 子通道随父通道销毁且继承 emit 门禁', () => {
  const ev = new EventService();
  const parent = ev.scope('demo:parent', { canEmit: false });
  const child = parent.fork('demo:child');
  child.on('game:start', () => {});
  assert.strictEqual(ev.stats().subscribers, 1);
  assert.ok(ev.stats().channels.includes('demo:child'));
  assert.throws(() => child.emit('game:start', { seed: 1 }), /未授权发送事件/);
  parent.dispose();
  assert.strictEqual(ev.stats().subscribers, 0);
  assert.ok(!ev.stats().channels.includes('demo:child'));
});
ok('EventChannel.onAny 归属通道，dispose 时撤销', () => {
  const ev = new EventService();
  const ch = ev.scope('demo:any');
  let seen = 0;
  ch.onAny(() => seen++);
  ev.emit('game:start', { seed: 1 });
  assert.strictEqual(seen, 1);
  ch.dispose();
  ev.emit('game:start', { seed: 2 });
  assert.strictEqual(seen, 1);
});
ok('权限裁剪：scoped API 不冻结且只暴露命名空间白名单成员', () => {
  const base = fakeApi();
  base.__privateTop = () => 'secret';
  base.world.__privateMember = () => 'secret';
  const scoped = scopeAPI(base, []);
  assert.strictEqual(Object.isFrozen(scoped), false, '顶层不应被 freeze');
  assert.strictEqual(Object.isFrozen(scoped.world), false, '命名空间不应被 freeze');
  assert.strictEqual(Object.isFrozen(scoped.blocks), false, 'blocks 不应被 freeze');
  assert.strictEqual('__privateTop' in scoped, false, '非白名单顶层成员不应暴露');
  assert.strictEqual('__privateMember' in scoped.world, false, '非白名单命名空间成员不应暴露');
  assert.strictEqual(Object.getPrototypeOf(scoped.world), Object.prototype, '不应爬到原对象原型');
});
ok('权限裁剪：未声明 world:write 时 setBlock 抛错', () => {
  const base = fakeApi();
  const scoped = scopeAPI(base, []);
  assert.throws(() => scoped.world.setBlock(1, 2, 3, 4), /缺少权限 world:write/);
  assert.throws(() => scoped.registerBlock({}), /缺少权限 blocks:register/);
  assert.throws(() => scoped.save.import({}), /缺少权限 save:write/);
  assert.strictEqual(scoped.world.getBlock(1, 2, 3), 0); // 读能力保留
});
ok('权限裁剪：声明后写能力放行', () => {
  const base = fakeApi();
  const scoped = scopeAPI(base, ['world:write', 'blocks:register', 'api:emit']);
  assert.strictEqual(scoped.world.setBlock(1, 2, 3, 4), true);
  assert.doesNotThrow(() => scoped.registerBlock({}));
  assert.doesNotThrow(() => scoped.emit('game:start', { seed: 1 }));
});
ok('权限裁剪：blocks 只读代理与 tnt / entities / survival 写入口', () => {
  const base = fakeApi();
  const scoped = scopeAPI(base, []);
  // 旧 22 项直接暴露 BlockRegistry；register 必须被拦截，读能力保留
  assert.throws(() => scoped.blocks.register({}), /缺少权限 blocks:register/);
  assert.strictEqual(scoped.blocks.get(7), 7);
  assert.throws(() => scoped.tnt.ignite(0, 0, 0), /缺少权限 world:write/);
  assert.throws(() => scoped.entities.spawn('pig', 0, 0, 0), /缺少权限 world:write/);
  assert.throws(() => scoped.survival.give('apple'), /缺少权限 player:write/);
  assert.throws(() => scoped.survival.setMode('creative'), /缺少权限 player:write/);
  // 声明权限后，blocks.register 仍必须走门面（真实环境会触发配置刷新）
  const allowed = scopeAPI(fakeApi(), ['blocks:register']);
  assert.doesNotThrow(() => allowed.blocks.register({}));
});
ok('M09 块 ID/名称冲突治理：重复 id 抛错', () => {
  const base = fakeApi();
  const scoped = scopeAPI(base, ['blocks:register']);
  // 注册一个带指定 id 的方块
  const def1 = scoped.registerBlock({ name: 'test:block_a', id: 200, tiles: { top: 'test', bottom: 'test', side: 'test' } });
  assert.strictEqual(def1.id, 200);
  // 同 id 再次注册 → 抛错
  assert.throws(() => scoped.registerBlock({ name: 'test:block_b', id: 200, tiles: { top: 'test', bottom: 'test', side: 'test' } }), /方块 id 重复: 200/);
  // 同 name 再次注册 → 抛错（即使 id 不同）
  assert.throws(() => scoped.registerBlock({ name: 'test:block_a', id: 201, tiles: { top: 'test', bottom: 'test', side: 'test' } }), /方块名重复: test:block_a/);
  // 内置方块 id（如 1=stone）不可覆盖
  assert.throws(() => scoped.registerBlock({ name: 'test:override_stone', id: 1, tiles: { top: 'test', bottom: 'test', side: 'test' } }), /方块 id 重复: 1/);
  // id 超出 1~255 → 抛错
  assert.throws(() => scoped.registerBlock({ name: 'test:outrange', id: 300, tiles: { top: 'test', bottom: 'test', side: 'test' } }), /方块 id 超出 1~255/);
  assert.throws(() => scoped.registerBlock({ name: 'test:neg', id: 0, tiles: { top: 'test', bottom: 'test', side: 'test' } }), /方块 id 超出 1~255/);
});
ok('权限裁剪：time / settings / plugins 写入口默认拒绝', () => {
  const scoped = scopeAPI(fakeApi(), []);
  assert.throws(() => scoped.time.set(0.5), /缺少权限 time:write/);
  assert.throws(() => scoped.time.setDayLength(100), /缺少权限 time:write/);
  assert.throws(() => scoped.settings.sound(false), /缺少权限 settings:write/);
  assert.throws(() => scoped.settings.fov(80), /缺少权限 settings:write/);
  assert.throws(() => scoped.plugins.register({}), /缺少权限 plugins:manage/);
  assert.throws(() => scoped.plugins.enable('demo:x'), /缺少权限 plugins:manage/);
  assert.throws(() => scoped.plugins.disable('demo:x'), /缺少权限 plugins:manage/);
  assert.throws(() => scoped.plugins.unload('demo:x'), /缺少权限 plugins:manage/);
  assert.doesNotThrow(() => scoped.plugins.list()); // 读能力保留
});
ok('权限裁剪：声明 time / settings / plugins:manage 后放行', () => {
  const scoped = scopeAPI(fakeApi(), ['time:write', 'settings:write', 'plugins:manage']);
  assert.doesNotThrow(() => scoped.time.set(0.5));
  assert.doesNotThrow(() => scoped.settings.fov(80));
  assert.doesNotThrow(() => scoped.plugins.disable('demo:x'));
});
ok('权限裁剪：player.setCamera 归 player:write 管', () => {
  const scoped = scopeAPI(fakeApi(), []);
  assert.throws(() => scoped.player.setCamera(1), /缺少权限 player:write/);
  assert.doesNotThrow(() => scopeAPI(fakeApi(), ['player:write']).player.setCamera(1));
});
okAsync('api:emit 同时约束 ctx.events.emit 与 api.events.scope 子通道', async () => {
  const { ev, ps } = makePluginService();
  let denied = null;
  let scopedDenied = null;
  ps.register({
    manifest: { id: 'demo:emit' },
    setup(ctx) {
      try { ctx.events.emit('game:start', { seed: 1 }); } catch (e) { denied = e.message; }
      try { ctx.api.events.scope('demo:child').emit('game:start', { seed: 1 }); } catch (e) { scopedDenied = e.message; }
    },
  });
  await ps.enable('demo:emit');
  assert.match(denied, /api:emit/);
  assert.match(scopedDenied, /api:emit/);
  assert.ok(ev.stats().channels.includes('demo:child'));

  let emitted = 0;
  ev.on('game:start', () => emitted++);
  ps.register({
    manifest: { id: 'demo:emit-ok', permissions: ['api:emit'] },
    setup(ctx) {
      ctx.events.emit('game:start', { seed: 2 });
      ctx.api.events.scope('demo:child-ok').emit('game:start', { seed: 3 });
    },
  });
  await ps.enable('demo:emit-ok');
  assert.strictEqual(emitted, 2);
  assert.ok(ev.stats().channels.includes('demo:child-ok'));
  ps.disable('demo:emit-ok');
  assert.ok(!ev.stats().channels.includes('demo:child-ok'), '子通道应随插件停用销毁');
});
okAsync('api.on / api.events.waitFor 归属插件通道，disable 后清理', async () => {
  const { ev, ps } = makePluginService();
  ps.register({
    manifest: { id: 'demo:scoped-subs' },
    setup(ctx) {
      ctx.api.on('block:break', () => {});
      ctx.api.events.waitFor('game:start', 5000).catch(() => {});
    },
  });
  const before = ev.stats().subscribers;
  await ps.enable('demo:scoped-subs');
  assert.strictEqual(ev.stats().subscribers, before + 2);
  ps.disable('demo:scoped-subs');
  assert.strictEqual(ev.stats().subscribers, before);
});
okAsync('list()/get() 的 manifest 是副本，改写无法自我提权', async () => {
  const { ps } = makePluginService();
  let denied = false;
  ps.register({
    manifest: { id: 'demo:tamper', permissions: [] },
    setup(ctx) {
      try { ctx.api.world.setBlock(0, 0, 0, 1); } catch (e) { denied = /world:write/.test(e.message); }
    },
  });
  ps.list()[0].manifest.permissions.push('world:write');
  ps.get('demo:tamper').manifest.permissions.push('world:write');
  await ps.enable('demo:tamper');
  assert.strictEqual(denied, true);
  assert.deepStrictEqual(ps.get('demo:tamper').manifest.permissions, []);
});
ok('register 校验 setup / 未知权限 / 自依赖', () => {
  const { ps } = makePluginService();
  assert.throws(() => ps.register({ manifest: { id: 'demo:a' } }), /setup/);
  assert.throws(
    () => ps.register({ manifest: { id: 'demo:b', permissions: ['world:writ'] }, setup() {} }),
    /未知权限/,
  );
  assert.throws(
    () => ps.register({ manifest: { id: 'demo:c', dependencies: ['demo:c'] }, setup() {} }),
    /自己/,
  );
});
okAsync('停用依赖插件会级联停用下游（依赖方先 teardown）', async () => {
  const { ps } = makePluginService();
  const order = [];
  ps.register({
    manifest: { id: 'demo:base' },
    setup() { order.push('base-setup'); return () => order.push('base-teardown'); },
  });
  ps.register({
    manifest: { id: 'demo:mid', dependencies: ['demo:base'] },
    setup() { order.push('mid-setup'); return () => order.push('mid-teardown'); },
  });
  ps.register({
    manifest: { id: 'demo:leaf', dependencies: ['demo:mid'] },
    setup() { order.push('leaf-setup'); return () => order.push('leaf-teardown'); },
  });
  await ps.enable('demo:leaf');
  assert.deepStrictEqual(order, ['base-setup', 'mid-setup', 'leaf-setup']);
  // v2：默认启用反向依赖保护，级联停用需显式 force=true
  ps.disable('demo:base', true);
  assert.strictEqual(ps.get('demo:leaf').state, 'disabled');
  assert.strictEqual(ps.get('demo:mid').state, 'disabled');
  assert.strictEqual(ps.get('demo:base').state, 'disabled');
  assert.deepStrictEqual(order, [
    'base-setup', 'mid-setup', 'leaf-setup',
    'leaf-teardown', 'mid-teardown', 'base-teardown',
  ]);
});
ok('插件 dispose 停用全部插件', () => {
  const { ps } = makePluginService();
  ps.register({ manifest: { id: 'demo:x' }, setup() {} });
  ps.register({ manifest: { id: 'demo:y' }, setup() {} });
  ps.dispose();
  assert.strictEqual(ps.list().length, 2);
  assert.ok(ps.list().every((p) => p.state === 'disabled'));
});

// ---------- 存档校验 ----------
const validSave = () => ({
  version: 2,
  seed: 12345,
  mode: 'survival',
  edits: [['1,2,3', 5]],
  player: { x: 1, y: 2, z: 3, yaw: 0, pitch: 0, fly: false },
  survival: {
    health: 20, hunger: 20, saturation: 20, breath: 15,
    inventory: [['i:apple', 2]], spawn: { x: 1, y: 2, z: 3 },
  },
  dayTime: 0.32,
  hotbar: Array.from({ length: 9 }, () => null),
  slot: 0,
  settings: { sound: true, renderDistance: 5, sensitivity: 1, fov: 72 },
  savedAt: 1700000000000,
});
ok('validateSave 接受合法档', () => assert.strictEqual(validateSave(validSave()), true));
ok('validateSave 接受含可选生态字段的新档', () => {
  const d = validSave();
  d.dayCount = 5;
  d.botany = { v: 1, plants: [[3, 21, 4, 60, 88, 1]], soil: [[3, 20, 4, 64]] };
  assert.strictEqual(validateSave(d), true);
  assert.strictEqual(normalizeSave(d).botany.plants.length, 1);
  // 世界支持负坐标，生态存档必须接受
  d.botany.plants.push([-17, 21, -9, 60, 40, 0]);
  d.botany.soil.push([-17, 20, -9, 30]);
  assert.strictEqual(validateSave(d), true);
});
ok('validateSave 拒绝损坏的生态字段', () => {
  const bad = [
    (d) => { d.dayCount = -1; },
    (d) => { d.dayCount = NaN; },
    (d) => { d.botany = { v: 2, plants: [], soil: [] }; },
    (d) => { d.botany = { v: 1, plants: 'x', soil: [] }; },
    (d) => { d.botany = { v: 1, plants: [[1.5, 2, 3, 4, 5, 0]], soil: [] }; },
    (d) => { d.botany = { v: 1, plants: [], soil: [[1, 2, 3, 500]] }; },
  ];
  for (const mutate of bad) {
    const d = validSave();
    mutate(d);
    assert.strictEqual(validateSave(d), false, `应拒绝生态坏档：${mutate.toString().slice(0, 50)}`);
  }
});
ok('饱和度为可选字段：缺失放行、越界拒绝', () => {
  const noSat = validSave();
  delete noSat.survival.saturation;
  assert.strictEqual(validateSave(noSat), true, '旧档缺 saturation 应放行');
  const bad = validSave();
  bad.survival.saturation = 1e6;
  assert.strictEqual(validateSave(bad), false, 'saturation 越界应拒绝');
  const neg = validSave();
  neg.survival.saturation = -1;
  assert.strictEqual(validateSave(neg), false, 'saturation 负值应拒绝');
});
ok('旧档缺生态字段仍通过校验并补默认值', () => {
  const d = validSave();
  const normalized = normalizeSave(d);
  assert.strictEqual(normalized.dayCount, 0);
  assert.strictEqual(normalized.botany, undefined);
});
ok('validateSave 接受含熔炉字段的存档并保留', () => {
  const d = validSave();
  d.furnaces = {
    v: 1,
    cells: [
      { pos: [1, 2, 3], input: ['beef', 3], fuel: ['coal', 2], output: ['cooked_beef', 1], burn: 12.5, burnMax: 80, progress: 4.2 },
      { pos: [-17, 21, -9], input: null, fuel: null, output: null, burn: 0, burnMax: 0, progress: 0 },
    ],
  };
  assert.strictEqual(validateSave(d), true);
  const normalized = normalizeSave(d);
  assert.strictEqual(normalized.furnaces.cells.length, 2);
});
ok('validateSave 拒绝结构损坏的熔炉字段', () => {
  const bad = [
    (d) => { d.furnaces = { v: 2, cells: [] }; },
    (d) => { d.furnaces = { v: 1, cells: 'x' }; },
    (d) => { d.furnaces = { v: 1, cells: [{ input: null, fuel: null, output: null, burn: 0, burnMax: 0, progress: 0 }] }; },
    (d) => { d.furnaces = { v: 1, cells: [{ pos: [1, 2], input: null, fuel: null, output: null, burn: 0, burnMax: 0, progress: 0 }] }; },
    (d) => { d.furnaces = { v: 1, cells: [{ pos: [1.5, 2, 3], input: null, fuel: null, output: null, burn: 0, burnMax: 0, progress: 0 }] }; },
    (d) => { d.furnaces = { v: 1, cells: [{ pos: [1, -1, 3], input: null, fuel: null, output: null, burn: 0, burnMax: 0, progress: 0 }] }; },
    (d) => { d.furnaces = { v: 1, cells: [{ pos: [1, 81, 3], input: null, fuel: null, output: null, burn: 0, burnMax: 0, progress: 0 }] }; },
    (d) => { d.furnaces = { v: 1, cells: [{ pos: [1, 2, 3], input: ['beef', 0], fuel: null, output: null, burn: 0, burnMax: 0, progress: 0 }] }; },
    (d) => { d.furnaces = { v: 1, cells: [{ pos: [1, 2, 3], input: ['beef', 1000], fuel: null, output: null, burn: 0, burnMax: 0, progress: 0 }] }; },
    (d) => { d.furnaces = { v: 1, cells: [{ pos: [1, 2, 3], input: ['rock', 1], fuel: null, output: null, burn: 0, burnMax: 0, progress: 0 }] }; },
    (d) => { d.furnaces = { v: 1, cells: [{ pos: [1, 2, 3], input: null, fuel: null, output: null, burn: -1, burnMax: 0, progress: 0 }] }; },
    (d) => { d.furnaces = { v: 1, cells: [{ pos: [1, 2, 3], input: null, fuel: null, output: null, burn: 0, burnMax: -1, progress: 0 }] }; },
    (d) => { d.furnaces = { v: 1, cells: [{ pos: [1, 2, 3], input: null, fuel: null, output: null, burn: 0, burnMax: 0, progress: -0.5 }] }; },
    (d) => { d.furnaces = { v: 1, cells: [{ pos: [1, 2, 3], input: null, fuel: null, output: null, burn: 0, burnMax: 0, progress: 61 }] }; },
  ];
  for (const mutate of bad) {
    const d = validSave();
    mutate(d);
    assert.strictEqual(validateSave(d), false, `应拒绝熔炉坏档：${mutate.toString().slice(0, 50)}`);
  }
});
ok('旧档缺熔炉字段仍通过校验', () => {
  const d = validSave();
  assert.strictEqual(d.furnaces, undefined);
  assert.strictEqual(validateSave(d), true);
  assert.strictEqual(normalizeSave(d).furnaces, undefined);
});
ok('validateSave 拒绝各类坏档', () => {
  const bad = [
    (d) => { d.version = 1; },
    (d) => { d.seed = 'abc'; },
    (d) => { d.mode = 'hardcore'; },
    (d) => { d.edits = 'oops'; },
    (d) => { d.edits = [['1,2,3', 'x']]; },
    (d) => { d.edits = [['1,2', 3]]; },
    (d) => { d.edits = [['1,2,3', 256]]; },
    (d) => { d.edits = [['1.5,2,3', 3]]; },
    (d) => { d.dayTime = 1.5; },
    (d) => { d.survival.inventory = [['b:999', 1]]; },
    (d) => { d.survival.inventory = [['i:apple', 0]]; },
    (d) => { d.survival.inventory = [['x:apple', 1]]; },
    (d) => { delete d.player.pitch; },
    (d) => { d.player.fly = 'yes'; },
    (d) => { d.survival.inventory = [['i:apple']]; },
    (d) => { d.survival.spawn = null; },
    (d) => { d.hotbar = Array.from({ length: 8 }, () => null); },
    (d) => { d.hotbar[0] = { kind: 'block', id: 'x' }; },
    (d) => { d.slot = 12; },
    (d) => { d.settings.fov = 'wide'; },
    (d) => { delete d.savedAt; },
    (d) => { d.dayTime = NaN; },
    // 坐标 / 生存数值必须有范围：1e308 这类值会撑爆区块生成或 UI
    (d) => { d.player.x = 1e308; },
    (d) => { d.player.z = -1e308; },
    (d) => { d.survival.spawn.y = 1e308; },
    (d) => { d.survival.health = 1e6; },
    (d) => { d.survival.saturation = 1e6; },
    (d) => { d.survival.saturation = -1; },
    (d) => { d.survival.breath = -1; },
  ];
  for (const mutate of bad) {
    const d = validSave();
    mutate(d);
    assert.strictEqual(validateSave(d), false, `应拒绝：${mutate.toString().slice(0, 60)}`);
  }
  assert.strictEqual(validateSave(null), false);
  assert.strictEqual(validateSave('{}'), false);
});
okAsync('v1 旧存档自动升级并补齐 9 格快捷栏', async () => {
  const store = {};
  global.localStorage = {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  };
  const legacy = {
    version: 1, seed: 7, edits: [],
    player: { x: 1, y: 2, z: 3, yaw: 0, pitch: 0, fly: false },
    dayTime: 0.3, hotbar: [1, 2, 3], slot: 0,
    settings: { sound: true, renderDistance: 5, sensitivity: 1, fov: 72 },
    savedAt: 1,
  };
  store['minecraft-ts-save-v1'] = JSON.stringify(legacy);
  const loaded = await new LocalStorageProvider().load();
  assert.ok(loaded, '旧档应能加载');
  assert.strictEqual(loaded.version, 2);
  assert.strictEqual(loaded.mode, 'creative');
  assert.strictEqual(loaded.hotbar.length, 9);
  assert.strictEqual(validateSave(loaded), true);
});
ok('M10 v2 存档缺失 mode 字段应拒绝（防静默模式切换）', () => {
  const v2NoMode = {
    version: 2, seed: 7, mode: undefined,
    edits: [], player: { x: 1, y: 2, z: 3, yaw: 0, pitch: 0, fly: false },
    survival: { health: 20, hunger: 20, saturation: 20, breath: 15, inventory: [], spawn: { x: 1, y: 2, z: 3 } },
    dayTime: 0.3, hotbar: Array(9).fill(null), slot: 0,
    settings: { sound: true, renderDistance: 5, sensitivity: 1, fov: 72 },
    savedAt: 1,
  };
  assert.strictEqual(validateSave(v2NoMode), false);
  assert.strictEqual(normalizeSave(v2NoMode), null);
});

Promise.all(pending).then(() => {
  console.log(`\n合计 ${results.length} 项，失败 ${failures} 项`);
  process.exit(failures > 0 ? 1 : 0);
});
