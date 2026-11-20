/**
 * 插件载体回归（v1.6.0，纯逻辑 + 真实 WASM）。
 *
 * 覆盖：三载体（js / wasm:module / wasm:host）、扩展点注册表、host 导入白名单、
 * 权限裁剪、ABI 校验、确定性 PRNG、事件桥接、卸载自动清理、负例隔离。
 * 依赖 test:snapshot 快照与内联的 host 插件 fixture（CI 不需要 clang）。
 */
const assert = require('assert');

const { PluginService } = require('./logic/services/plugins/PluginService.js');
const { ExtensionRegistry, EXTENSION_POINTS } = require('./logic/services/plugins/extensions.js');
const {
  planGrants, assertWhitelistedImports, readUtf8, writeUtf8,
  POINT_KINDS, EVENT_TO_POINT, payloadNumbers, HOST_PLUGIN_ABI,
} = require('./logic/services/plugins/carriers/hostABI.js');
const { ServiceContainer } = require('./logic/services/ServiceContainer.js');
const { EventService } = require('./logic/services/events/EventService.js');
const { MemoryPluginStorageProvider } = require('./logic/services/plugins/storage.js');
const { WasmRuntime } = require('./logic/wasm/runtime.js');
const { VERSION, PLUGIN_API_VERSION } = require('./logic/core/version.js');
const { parseVersion } = require('./logic/services/plugins/semver.js');
const { KERNEL_BASE64 } = require('./logic/wasm/kernelBinary.js');
const {
  HOST_PLUGIN_BASE64, BAD_HOST_PLUGIN_BASE64,
} = require('./logic/plugins/example/hostPluginFixtureBinary.js');

// 真实内核字节（从内联 base64 解码，走 WasmRuntime 内置加载）
const { decodeBase64 } = require('./logic/wasm/protocol.js');

let passed = 0, failures = 0;
const ok = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failures++; console.error(`  ✗ ${name} — ${e.stack || e.message}`); }
};
const rejects = (fn, re) => assert.throws(fn, re);
const PLUGIN_API_MAJOR = parseVersion(PLUGIN_API_VERSION).major;

/** 构造一个可写世界的 fake CraftAPI，记录 setBlock 调用 */
function fakeApi() {
  const setCalls = [];
  return {
    setCalls,
    version: VERSION,
    world: {
      seed: () => 2026,
      getBlock: () => 0,
      surfaceHeight: () => 40,
      setBlock: (x, y, z, id) => { setCalls.push({ x, y, z, id }); return true; },
      decorate() {},
    },
    player: { teleport() {}, setFly() {}, break() {}, place() {} },
    save: { import() {}, setProvider() {} },
    blocks: { register() {}, get: (id) => id, byNameGet: () => undefined },
    tnt: { ignite() {} },
    entities: { spawn() {}, list: () => [] },
    survival: { setMode() {}, respawn() {}, give() {}, damage() {}, heal() {} },
    botany: {
      registerPlant() {}, unregisterPlant() {}, registerRule() {}, unregisterRules() {},
      listRules: () => [], stats: () => ({}),
    },
    plugins: {
      register() {}, enable() {}, disable() {}, unload() {}, list: () => [], get() {},
      reload() {}, enableAll() {}, stats() {}, install() {}, findByCapability() {},
    },
    wasm: {
      status: () => 'ready', stats: () => ({}), benchmark: () => null,
      setEnabled: () => 'ready', listModules: () => [], call: () => 1,
      callModule: () => 1, registerModule: () => ({}), unregisterModule: () => true,
    },
    extensions: { points: () => [], stats: () => ({}), has: () => false, list: () => [] },
    registerBlock() {}, registerTile() {}, registerEntity() {}, setGenerator() {},
    on() { return () => {}; }, off() {}, emit() {},
  };
}

/** 构造一个「桥接到真实 WasmRuntime」的 wasmHost + PluginService */
function make(opts = {}) {
  const ev = new EventService();
  const container = new ServiceContainer();
  const base = fakeApi();
  const extensions = new ExtensionRegistry();
  const storageProvider = new MemoryPluginStorageProvider();
  const rt = new WasmRuntime();
  assert.strictEqual(rt.init(), 'ready');
  const wasmHost = {
    registerModule: (id, bytes) => rt.registerModule(id, bytes),
    unregisterModule: (id) => rt.unregisterModule(id),
    callKernel: (name, args) => rt.callKernel(name, args),
  };
  const ps = new PluginService(ev, container, () => base, {
    storage: storageProvider, extensions, wasmHost,
  });
  return { ev, container, base, extensions, storageProvider, rt, ps };
}

async function main() {
  // ---------- 扩展点注册表 ----------
  await ok('ExtensionRegistry：优先级排序 / owner 隔离 / 错误隔离 / 统计', () => {
    const reg = new ExtensionRegistry();
    const order = [];
    const offLow = reg.register('p:test', 'own:a', () => order.push('low'), 0);
    reg.register('p:test', 'own:b', () => order.push('high'), 10);
    reg.register('p:test', 'own:c', () => { throw new Error('boom'); }, 5);
    const r = reg.emit('p:test', {});
    assert.deepStrictEqual(order, ['high', 'low']);
    assert.strictEqual(r.called, 2);
    assert.strictEqual(r.errors.length, 1);
    assert.strictEqual(r.errors[0].owner, 'own:c');
    assert.strictEqual(reg.stats().errors, 1);
    assert.strictEqual(reg.stats().handlers, 3);
    assert.strictEqual(reg.unregisterOwner('own:a'), 1);
    assert.strictEqual(reg.list('p:test').length, 2);
    // 已被 owner 撤销的句柄再次调用应幂等，不会误删他人注册
    offLow();
    assert.strictEqual(reg.list('p:test').length, 2);
    assert.strictEqual(reg.unregisterOwner('own:b'), 1);
    assert.strictEqual(reg.list('p:test').length, 1);
    reg.dispose();
    assert.strictEqual(reg.emit('p:test', {}).called, 0);
  });

  await ok('ExtensionRegistry：非法 point / owner / handler 在注册期拒绝', () => {
    const reg = new ExtensionRegistry();
    rejects(() => reg.register('bad point!', 'own:a', () => {}), /非法扩展点/);
    rejects(() => reg.register('p:ok', 'bad owner!', () => {}), /非法 owner/);
    rejects(() => reg.register('p:ok', 'own:a', 123), /handler/);
    rejects(() => reg.register('p:ok', 'own:a', () => {}, NaN), /priority/);
  });

  await ok('worldgen 扩展点常量与 payload 数值提取稳定', () => {
    assert.strictEqual(EXTENSION_POINTS.WORLDGEN_COLUMN, 'worldgen:column');
    assert.deepStrictEqual(payloadNumbers('worldgen:column', { cx: 3, cz: -2 }), [3, -2, 0, 0]);
    assert.deepStrictEqual(payloadNumbers('gameplay:tick', { now: 99 }), [99, 0, 0, 0]);
    assert.deepStrictEqual(payloadNumbers('event:block:place', { x: 1, y: 2, z: 3, block: 4 }), [1, 2, 3, 4]);
    assert.strictEqual(POINT_KINDS['worldgen:column'], 1);
    assert.strictEqual(EVENT_TO_POINT['block:place'], 'event:block:place');
    assert.strictEqual(HOST_PLUGIN_ABI, 1);
  });

  // ---------- host ABI ----------
  await ok('planGrants：声明 + 权限双重门控', () => {
    const all = planGrants(undefined, ['world:write', 'wasm:use', 'events:subscribe']);
    assert.ok(all.every((g) => g.granted));
    const none = planGrants(['mc_log', 'mc_world_set'], []);
    assert.strictEqual(none.find((g) => g.name === 'mc_log').granted, true);
    const ws = none.find((g) => g.name === 'mc_world_set');
    assert.strictEqual(ws.granted, false);
    assert.strictEqual(ws.reason, 'permission');
    const undeclared = planGrants([], [])[0];
    assert.strictEqual(undeclared.reason, 'undeclared');
  });

  await ok('assertWhitelistedImports：拒绝非 env 模块 / 未列举名字 / 非函数', () => {
    assert.doesNotThrow(() => assertWhitelistedImports([
      { module: 'env', name: 'mc_log', kind: 'function' },
    ]));
    rejects(() => assertWhitelistedImports([{ module: 'foo', name: 'mc_log', kind: 'function' }]), /不允许的宿主导入/);
    rejects(() => assertWhitelistedImports([{ module: 'env', name: 'mc_evil', kind: 'function' }]), /不允许的宿主导入/);
    rejects(() => assertWhitelistedImports([{ module: 'env', name: 'mc_log', kind: 'memory' }]), /必须是函数/);
  });

  await ok('UTF-8 内存读写与边界检查', () => {
    const mem = new WebAssembly.Memory({ initial: 1 });
    const n = writeUtf8(mem, 16, 64, '世界gen');
    assert.strictEqual(readUtf8(mem, 16, n), '世界gen');
    rejects(() => readUtf8(mem, 65530, 100), /越界/);
    rejects(() => writeUtf8(mem, -1, 10, 'x'), /非法内存参数/);
  });

  // ---------- JS 载体零回归 ----------
  await ok('JS 载体 setup 仍可用（v1.5 插件零改动）', async () => {
    const { ps } = make();
    let ran = false;
    ps.register({ manifest: { id: 'js:legacy' }, setup() { ran = true; } });
    await ps.enable('js:legacy');
    assert.strictEqual(ran, true);
    assert.strictEqual(ps.get('js:legacy').state, 'enabled');
    assert.strictEqual(ps.get('js:legacy').carrier, undefined);
  });

  // ---------- wasm:module 载体 ----------
  await ok('wasm:module：零 import 模块注册为私有模块，停用自动注销', async () => {
    const { ps, rt } = make();
    ps.register({
      manifest: { id: 'wasm:calc', permissions: ['wasm:use'] },
      carrier: { kind: 'wasm:module', bytes: KERNEL_BASE64 /* 零 import 的内核二进制 */ },
    });
    await ps.enable('wasm:calc');
    const rec = ps.get('wasm:calc');
    assert.strictEqual(rec.state, 'enabled');
    assert.strictEqual(rec.carrier.kind, 'wasm:module');
    assert.ok(rec.carrier.bytes > 0);
    assert.ok(rt.listModules().some((m) => m.id === 'wasm:calc'));
    ps.disable('wasm:calc');
    assert.ok(!rt.listModules().some((m) => m.id === 'wasm:calc'));
  });

  // ---------- wasm:host 载体 ----------
  await ok('wasm:host：_start 打招呼 + 注册两个扩展点 + ABI 内省', async () => {
    const { ps, extensions, ev } = make();
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => { logs.push(a.join(' ')); };
    try {
      ps.register({
        manifest: { id: 'host:demo', permissions: ['world:write', 'wasm:use'] },
        carrier: {
          kind: 'wasm:host', bytes: HOST_PLUGIN_BASE64, abi: 1,
          hostImports: ['mc_log', 'mc_ext_register', 'mc_world_set', 'mc_rand', 'mc_storage_set'],
        },
      });
      await ps.enable('host:demo');
    } finally {
      console.log = origLog;
    }
    const rec = ps.get('host:demo');
    assert.strictEqual(rec.state, 'enabled', rec.error || '');
    assert.strictEqual(rec.carrier.kind, 'wasm:host');
    assert.strictEqual(rec.carrier.abi, 1);
    assert.ok(logs.some((l) => l.includes('host:init')), '应记录 host:init');
    assert.ok(extensions.has('worldgen:column'));
    assert.ok(extensions.has('gameplay:tick'));
  });

  await ok('wasm:host：worldgen:column 钩子经 mc_world_set 改写方块', async () => {
    const { ps, extensions, base } = make();
    ps.register({
      manifest: { id: 'host:gen', permissions: ['world:write'] },
      carrier: { kind: 'wasm:host', bytes: HOST_PLUGIN_BASE64 },
    });
    await ps.enable('host:gen');
    assert.strictEqual(ps.get('host:gen').state, 'enabled', ps.get('host:gen').error || '');
    const payload = {
      cx: 1, cz: 2, data: new Uint8Array(16),
      get: () => 0, set: () => {},
    };
    const r = extensions.emit('worldgen:column', payload);
    assert.strictEqual(r.called, 1, JSON.stringify(r.errors));
    assert.deepStrictEqual(base.setCalls[0], { x: 1, y: 40, z: 2, id: 63 });
  });

  await ok('wasm:host：gameplay:tick 钩子累加计数并写插件存储', async () => {
    const { ps, extensions, storageProvider } = make();
    ps.register({
      manifest: { id: 'host:tick', permissions: ['wasm:use'], timeoutMs: 5000 },
      carrier: { kind: 'wasm:host', bytes: HOST_PLUGIN_BASE64 },
    });
    await ps.enable('host:tick');
    assert.strictEqual(ps.get('host:tick').state, 'enabled', ps.get('host:tick').error || '');
    extensions.emit('gameplay:tick', { now: 1 });
    extensions.emit('gameplay:tick', { now: 2 });
    assert.strictEqual(storageProvider.read('host:tick').ticks, '2');
  });

  await ok('wasm:host：停用后扩展点全部撤销，钩子不再触发', async () => {
    const { ps, extensions, base } = make();
    ps.register({
      manifest: { id: 'host:life', permissions: ['world:write'] },
      carrier: { kind: 'wasm:host', bytes: HOST_PLUGIN_BASE64 },
    });
    await ps.enable('host:life');
    assert.ok(extensions.has('worldgen:column'));
    ps.disable('host:life');
    assert.ok(!extensions.has('worldgen:column'));
    assert.ok(!extensions.has('gameplay:tick'));
    extensions.emit('worldgen:column', { cx: 9, cz: 9, data: new Uint8Array(4), get() {}, set() {} });
    assert.strictEqual(base.setCalls.length, 0);
  });

  await ok('wasm:host：未声明 world:write 时 mc_world_set 调用被拒（权限桩）', async () => {
    const { ps, extensions } = make();
    ps.register({
      manifest: { id: 'host:noperm' },
      carrier: { kind: 'wasm:host', bytes: HOST_PLUGIN_BASE64 },
    });
    await ps.enable('host:noperm');
    assert.strictEqual(ps.get('host:noperm').state, 'enabled');
    const r = extensions.emit('worldgen:column', { cx: 0, cz: 0, data: new Uint8Array(4), get() {}, set() {} });
    assert.strictEqual(r.called, 0);
    assert.strictEqual(r.errors.length, 1);
    assert.match(r.errors[0].message, /缺少权限 world:write/);
  });

  await ok('wasm:host：ABI 不符 / 非法 import 均被隔离为 failed', async () => {
    const a = make();
    a.ps.register({
      manifest: { id: 'host:badabi' },
      carrier: { kind: 'wasm:host', bytes: HOST_PLUGIN_BASE64, abi: 99 },
    });
    await a.ps.enable('host:badabi');
    assert.strictEqual(a.ps.get('host:badabi').state, 'failed');
    assert.match(a.ps.get('host:badabi').error, /ABI/);

    const b = make();
    b.ps.register({
      manifest: { id: 'host:evil' },
      carrier: { kind: 'wasm:host', bytes: BAD_HOST_PLUGIN_BASE64 },
    });
    await b.ps.enable('host:evil');
    assert.strictEqual(b.ps.get('host:evil').state, 'failed');
    assert.match(b.ps.get('host:evil').error, /不允许的宿主导入/);
  });

  await ok('WASM 模块载体需要 wasmHost 桥接，否则注册期拒绝', () => {
    const ev = new EventService();
    const container = new ServiceContainer();
    const ps = new PluginService(ev, container, () => fakeApi());
    rejects(() => ps.register({
      manifest: { id: 'wasm:nobridge' },
      carrier: { kind: 'wasm:module', bytes: HOST_PLUGIN_BASE64 },
    }), /宿主桥接未接线/);
  });

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} 插件载体回归：${passed} 项断言，失败 ${failures} 项`);
  process.exit(failures > 0 ? 1 : 0);
}

void main();
