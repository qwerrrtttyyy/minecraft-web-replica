/**
 * 插件体系 v2 回归（v1.5.0，纯逻辑）。
 *
 * 覆盖：semver 约束、manifest 静态校验、依赖版本 / 可选依赖、反向依赖保护、
 * setup 超时、热重载、按优先级启用、统计与能力发现、上下文（config/storage/私有服务）、
 * 源码加载器与权限裁剪。依赖 test:snapshot 快照。
 */
const assert = require('node:assert');

const semver = require('./logic/services/plugins/semver.js');
const { PluginService } = require('./logic/services/plugins/PluginService.js');
const { MemoryPluginStorageProvider } = require('./logic/services/plugins/storage.js');
const { loadPluginDefinition } = require('./logic/services/plugins/loader.js');
const { ServiceContainer } = require('./logic/services/ServiceContainer.js');
const { EventService } = require('./logic/services/events/EventService.js');
const { PLUGIN_API_VERSION, VERSION } = require('./logic/core/version.js');

const fakeApi = () => ({
  version: VERSION,
  world: { setBlock: () => true, getBlock: () => 0, decorate() {} },
  player: { teleport() {}, setFly() {}, break() {}, place() {} },
  save: { import() {}, setProvider() {} },
  blocks: { register() {}, get: (id) => id },
  tnt: { ignite() {} },
  entities: { spawn() {}, list: () => [] },
  survival: { setMode() {}, respawn() {}, give() {}, damage() {}, heal() {} },
  botany: {
    registerPlant() {},
    unregisterPlant() {},
    registerRule() {},
    unregisterRules() {},
    listRules: () => [],
    stats: () => ({}),
  },
  plugins: {
    register() {},
    enable() {},
    disable() {},
    unload() {},
    list: () => [],
    get() {},
    reload() {},
    enableAll() {},
    stats() {},
    install() {},
    findByCapability() {},
  },
  wasm: {
    status: () => 'ready',
    stats: () => ({}),
    benchmark: () => null,
    setEnabled: () => 'ready',
    listModules: () => [],
    call: () => 1,
    callModule: () => 1,
    registerModule: () => ({}),
    unregisterModule: () => true,
  },
  registerBlock() {},
  registerTile() {},
  registerEntity() {},
  setGenerator() {},
  on() {
    return () => {};
  },
  off() {},
  emit() {},
});

const make = (options = {}) => {
  const ev = new EventService();
  const container = new ServiceContainer();
  const base = fakeApi();
  const storage = options.storage ?? new MemoryPluginStorageProvider();
  const ps = new PluginService(ev, container, () => base, { ...options, storage });
  return { ev, container, base, storage, ps };
};

let passed = 0;
let failures = 0;
const ok = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    console.error(`  ✗ ${name} — ${e.message}`);
  }
};
const rejects = (fn, re) => assert.throws(fn, re);

async function main() {
  // ---------- semver ----------
  await ok('parseVersion 支持简写 / v 前缀 / prerelease', () => {
    assert.deepStrictEqual(semver.parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: '' });
    assert.deepStrictEqual(semver.parseVersion('v2'), { major: 2, minor: 0, patch: 0, prerelease: '' });
    assert.strictEqual(semver.parseVersion('1.2.3-beta').prerelease, 'beta');
    assert.strictEqual(semver.parseVersion('not-a-version'), null);
    assert.strictEqual(semver.compareVersions(semver.parseVersion('1.2.3'), semver.parseVersion('1.2.4')), -1);
    assert.strictEqual(semver.compareVersions(semver.parseVersion('2.0.0'), semver.parseVersion('2.0.0-beta')), 1);
  });

  await ok('satisfies：精确 / ^ / ~ / 比较符 / x 通配 / AND / OR', () => {
    const s = semver.satisfies;
    assert.strictEqual(s('1.2.3', '1.2.3'), true);
    assert.strictEqual(s('1.2.3', '^1.2.0'), true);
    assert.strictEqual(s('2.0.0', '^1.2.0'), false);
    assert.strictEqual(s('1.2.9', '~1.2.3'), true);
    assert.strictEqual(s('1.3.0', '~1.2.3'), false);
    assert.strictEqual(s('1.5.0', '>=1.0.0 <2.0.0'), true);
    assert.strictEqual(s('2.0.0', '>=1.0.0 <2.0.0'), false);
    assert.strictEqual(s('1.9.9', '1.x'), true);
    assert.strictEqual(s('2.0.0', '1.x'), false);
    assert.strictEqual(s('0.0.1', '*'), true);
    assert.strictEqual(s('3.0.0', '^1.0.0 || ^3.0.0'), true);
    assert.strictEqual(s('beta', '*'), true);
    assert.strictEqual(s('beta', '^1.0.0'), false);
    assert.strictEqual(s('1.0.0', 'not a range !!'), false);
  });

  await ok('parseDependency 支持 id@range 与非法声明', () => {
    assert.deepStrictEqual(semver.parseDependency('core:foo'), { id: 'core:foo', range: '*' });
    assert.deepStrictEqual(semver.parseDependency('core:foo@^1.2.0'), { id: 'core:foo', range: '^1.2.0' });
    assert.strictEqual(semver.parseDependency('core:foo@??'), null);
    assert.strictEqual(semver.parseDependency('bad id'), null);
  });

  // ---------- manifest 静态校验 ----------
  await ok('apiVersion 不满足引擎契约时拒绝注册', () => {
    const { ps } = make();
    rejects(
      () =>
        ps.register({
          manifest: { id: 'demo:old', apiVersion: '^1.0.0' },
          setup() {},
        }),
      /要求插件 API/,
    );
    assert.strictEqual(semver.satisfies(PLUGIN_API_VERSION, '^2.0.0'), true);
    assert.doesNotThrow(() =>
      ps.register({
        manifest: { id: 'demo:new', apiVersion: '^2.0.0' },
        setup() {},
      }),
    );
  });

  await ok('manifest 字段非法在注册期就被拦截', () => {
    const { ps } = make();
    const bad = (manifest) => () => ps.register({ manifest: { id: 'demo:bad', ...manifest }, setup() {} });
    rejects(bad({ capabilities: ['bad capability!'] }), /capabilities/);
    rejects(bad({ priority: NaN }), /priority/);
    rejects(bad({ timeoutMs: 1 }), /timeoutMs/);
    rejects(bad({ config: [1, 2] }), /config/);
    rejects(bad({ dependencies: ['core:x@??'] }), /非法依赖/);
    rejects(bad({ optionalDependencies: 'core:x' }), /必须是数组/);
    rejects(() => ps.register({ manifest: { id: 'demo:nosetup' } }), /缺少 setup/);
  });

  // ---------- 依赖 ----------
  await ok('必需依赖版本约束生效', async () => {
    const a = make();
    a.ps.register({ manifest: { id: 'p:base', version: '1.0.0' }, setup() {} });
    a.ps.register({
      manifest: { id: 'p:child', dependencies: ['p:base@^1.0.0'] },
      setup() {},
    });
    await a.ps.enable('p:child');
    assert.strictEqual(a.ps.get('p:base').state, 'enabled');
    assert.strictEqual(a.ps.get('p:child').state, 'enabled');

    const b = make();
    b.ps.register({ manifest: { id: 'p:base', version: '1.0.0' }, setup() {} });
    b.ps.register({
      manifest: { id: 'p:child', dependencies: ['p:base@^2.0.0'] },
      setup() {},
    });
    await b.ps.enable('p:child');
    assert.strictEqual(b.ps.get('p:child').state, 'failed');
    assert.match(b.ps.get('p:child').error, /不满足约束/);
  });

  await ok('可选依赖缺失 / 失败只记 warning，不阻断启用', async () => {
    const { ps } = make();
    ps.register({
      manifest: { id: 'p:optfail' },
      setup() {
        throw new Error('boom');
      },
    });
    ps.register({
      manifest: {
        id: 'p:main',
        optionalDependencies: ['p:missing', 'p:optfail'],
      },
      setup() {},
    });
    await ps.enable('p:main');
    const rec = ps.get('p:main');
    assert.strictEqual(rec.state, 'enabled');
    assert.strictEqual(rec.warnings.length, 2);
    assert.ok(rec.warnings.some((w) => /未注册/.test(w)));
    assert.ok(rec.warnings.some((w) => /未成功启用/.test(w)));
    assert.ok(ps.stats().warnings >= 2);
  });

  await ok('循环依赖仍被隔离为 failed', async () => {
    const { ps } = make();
    ps.register({ manifest: { id: 'p:a', dependencies: ['p:b'] }, setup() {} });
    ps.register({ manifest: { id: 'p:b', dependencies: ['p:a'] }, setup() {} });
    await ps.enable('p:a');
    assert.ok(['failed', 'disabled'].includes(ps.get('p:a').state));
  });

  // ---------- 生命周期保护 ----------
  await ok('反向依赖保护：被依赖插件不可直接停用，force 可强制停用', async () => {
    const { ps } = make();
    ps.register({ manifest: { id: 'p:base' }, setup() {} });
    ps.register({ manifest: { id: 'p:child', dependencies: ['p:base'] }, setup() {} });
    await ps.enable('p:child');
    rejects(() => ps.disable('p:base'), /仍依赖/);
    ps.disable('p:base', true);
    assert.strictEqual(ps.get('p:base').state, 'disabled');
    // v1.5.0 集成：force=true 级联停用依赖方，避免出现悬浮依赖
    assert.strictEqual(ps.get('p:child').state, 'disabled');
    ps.dispose();
    assert.ok(ps.list().every((p) => p.state === 'disabled'));
  });

  await ok('setup 超时被隔离为 failed 并发出 plugin:error', async () => {
    const { ev, ps } = make();
    const errors = [];
    ev.on('plugin:error', (p) => errors.push(p));
    ps.register({
      manifest: { id: 'p:slow', timeoutMs: 60 },
      setup: () => new Promise(() => {}),
    });
    await ps.enable('p:slow');
    assert.strictEqual(ps.get('p:slow').state, 'failed');
    assert.match(ps.get('p:slow').error, /超时/);
    assert.strictEqual(errors.length, 1);
  });

  await ok('reload 热重载：重新 setup 并发出 plugin:reloaded', async () => {
    const { ev, ps } = make();
    let setups = 0;
    const reloaded = [];
    ev.on('plugin:reloaded', (p) => reloaded.push(p.id));
    ps.register({
      manifest: { id: 'p:reload' },
      setup() {
        setups++;
      },
    });
    await ps.enable('p:reload');
    await ps.reload('p:reload');
    assert.strictEqual(setups, 2);
    assert.strictEqual(ps.get('p:reload').state, 'enabled');
    assert.deepStrictEqual(reloaded, ['p:reload']);
    await assert.rejects(() => ps.reload('p:missing'), /未注册/);
  });

  await ok('enableAll 按 priority 降序启用', async () => {
    const { ps } = make();
    const order = [];
    ps.register({
      manifest: { id: 'p:low', priority: -10 },
      setup() {
        order.push('low');
      },
    });
    ps.register({
      manifest: { id: 'p:high', priority: 10 },
      setup() {
        order.push('high');
      },
    });
    ps.register({
      manifest: { id: 'p:mid' },
      setup() {
        order.push('mid');
      },
    });
    await ps.enableAll();
    assert.deepStrictEqual(order, ['high', 'mid', 'low']);
  });

  await ok('stats / findByCapability / durationMs / warnings', async () => {
    const { ps } = make();
    ps.register({
      manifest: { id: 'p:cap', capabilities: ['demo.cap', 'wasm.monitor'] },
      setup() {},
    });
    await ps.enable('p:cap');
    const st = ps.stats();
    assert.strictEqual(st.total, 1);
    assert.strictEqual(st.enabled, 1);
    assert.ok(st.capabilities.includes('demo.cap'));
    assert.ok(st.totalEnableMs >= 0);
    assert.deepStrictEqual(ps.findByCapability('wasm.monitor'), ['p:cap']);
    assert.strictEqual(typeof ps.get('p:cap').durationMs, 'number');
  });

  // ---------- 上下文 ----------
  await ok('ctx.manifest 冻结快照 / apiVersion 注入', async () => {
    const { ps } = make();
    let seen;
    ps.register({
      manifest: { id: 'p:ctx', capabilities: ['demo.ctx'] },
      setup(ctx) {
        seen = ctx;
      },
    });
    await ps.enable('p:ctx');
    assert.strictEqual(seen.id, 'p:ctx');
    assert.strictEqual(seen.apiVersion, PLUGIN_API_VERSION);
    assert.ok(Object.isFrozen(seen.manifest));
    assert.ok(Object.isFrozen(seen.config));
  });

  await ok('ctx.config 合并 manifest 默认值与已保存配置', async () => {
    const storage = new MemoryPluginStorageProvider();
    storage.write('p:cfg', { config: { b: 9, c: 10 } });
    const { ps } = make({ storage });
    let cfg;
    ps.register({
      manifest: { id: 'p:cfg', config: { a: 1, b: 2 } },
      setup(ctx) {
        cfg = ctx.config;
      },
    });
    await ps.enable('p:cfg');
    assert.deepStrictEqual(cfg, { a: 1, b: 9, c: 10 });
  });

  await ok('ctx.storage 命名空间隔离且持久化', async () => {
    const { ps } = make();
    ps.register({
      manifest: { id: 'ns:a' },
      setup(ctx) {
        assert.strictEqual(ctx.storage.get('shared', undefined), undefined);
        ctx.storage.set('shared', 'A');
        assert.deepStrictEqual(ctx.storage.keys(), ['shared']);
      },
    });
    ps.register({
      manifest: { id: 'ns:b' },
      setup(ctx) {
        assert.strictEqual(ctx.storage.get('shared', undefined), undefined);
        ctx.storage.set('shared', 'B');
      },
    });
    await ps.enableAll();
    ps.unload('ns:a', true);
    ps.register({
      manifest: { id: 'ns:a' },
      setup(ctx) {
        assert.strictEqual(ctx.storage.get('shared'), 'A', '卸载后数据应保留');
        ctx.storage.remove('shared');
        assert.strictEqual(ctx.storage.get('shared', 'gone'), 'gone');
      },
    });
    await ps.enable('ns:a');
  });

  await ok('ctx.provide / require / tryRequire 与卸载清理', async () => {
    const { ps } = make();
    ps.register({
      manifest: { id: 'p:svc' },
      setup(ctx) {
        ctx.provide('answer', 42);
        assert.strictEqual(ctx.require('answer'), 42);
        assert.strictEqual(ctx.tryRequire('missing'), undefined);
        rejects(() => ctx.require('missing'), /插件私有服务未注册/);
      },
    });
    await ps.enable('p:svc');
    ps.disable('p:svc');
    assert.strictEqual(ps.get('p:svc').state, 'disabled');
  });

  // ---------- 源码加载器 ----------
  const SOURCE = `module.exports = {
    manifest: { id: 'demo:from-source', version: '1.0.0', permissions: ['api:emit'] },
    setup(ctx) { ctx.log('loaded'); }
  };`;

  await ok('loadPluginDefinition 支持 module.exports 与 .default', () => {
    const def = loadPluginDefinition(SOURCE);
    assert.strictEqual(def.manifest.id, 'demo:from-source');
    assert.strictEqual(typeof def.setup, 'function');
    assert.ok(Object.isFrozen(def.manifest));
    const def2 = loadPluginDefinition(SOURCE.replace('module.exports =', 'module.exports.default ='));
    assert.strictEqual(def2.manifest.id, 'demo:from-source');
  });

  await ok('loadPluginDefinition 拒绝非法定义', () => {
    rejects(() => loadPluginDefinition(''), /为空/);
    rejects(() => loadPluginDefinition('x'.repeat(70 * 1024)), /超过上限/);
    rejects(() => loadPluginDefinition('module.exports = {}'), /缺少 manifest/);
    rejects(() => loadPluginDefinition('module.exports = { manifest: { id: "bad id" }, setup() {} }'), /非法插件 id/);
    rejects(() => loadPluginDefinition('module.exports = { manifest: { id: "demo:x" } }'), /缺少 setup/);
    rejects(
      () => loadPluginDefinition('module.exports = { manifest: { id: "demo:x", permissions: ["nope"] }, setup() {} }'),
      /未知权限/,
    );
    rejects(() => loadPluginDefinition('throw new Error("syntax'), /执行失败/);
  });

  await ok('PluginService.install 端到端加载并启用', async () => {
    const { ps } = make();
    const rec = ps.install(SOURCE);
    assert.strictEqual(rec.state, 'registered');
    await ps.enable('demo:from-source');
    assert.strictEqual(ps.get('demo:from-source').state, 'enabled');
  });

  await ok('插件 ctx.api 按 permissions 裁剪（默认不可管理其它插件）', async () => {
    const { ps } = make();
    ps.register({
      manifest: { id: 'p:scoped' },
      setup(ctx) {
        ctx.api.plugins.enable('p:other');
      },
    });
    await ps.enable('p:scoped');
    assert.strictEqual(ps.get('p:scoped').state, 'failed');
    assert.match(ps.get('p:scoped').error, /缺少权限 plugins:manage/);
  });

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} 插件体系 v2 回归：${passed} 项断言，失败 ${failures} 项`);
  process.exit(failures > 0 ? 1 : 0);
}

void main();
