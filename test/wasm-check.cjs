/**
 * WASM 层回归（v1.5.0，纯逻辑 / Node 自带 WebAssembly，无需浏览器）。
 *
 * 覆盖：内联二进制完整性、ABI 与导出契约、逐位等价性对拍、噪声后端接管与回退、
 * WasmRuntime 生命周期、自定义模块准入、权限裁剪。
 * 依赖 test:snapshot 生成的 CommonJS 快照，验证前必须先跑 npm run test:snapshot。
 */
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const protocol = require('./logic/wasm/protocol.js');
const binary = require('./logic/wasm/kernelBinary.js');
const kernel = require('./logic/wasm/kernel.js');
const { WasmRuntime } = require('./logic/wasm/runtime.js');
const noiseMath = require('./logic/world/noiseMath.js');
const noise = require('./logic/world/noise.js');
const { scopeAPI } = require('./logic/services/plugins/PluginService.js');
const { satisfies } = require('./logic/services/plugins/semver.js');
const { PLUGIN_API_VERSION, VERSION } = require('./logic/core/version.js');
const { wasmMonitorPlugin } = require('./logic/plugins/builtin/wasmMonitor.js');

const wasmPath = path.join(__dirname, '..', 'native', 'mc_kernel.wasm');
const kernelBytes = readFileSync(wasmPath);

let passed = 0;
let failures = 0;
const ok = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures++;
    console.error(`  ✗ ${name} — ${e.message}`);
  }
};
const hasIssue = (fn, re) => assert.throws(fn, re);

// ---------- 协议与内联产物 ----------
ok('协议常量与 ABI 一致', () => {
  assert.strictEqual(protocol.KERNEL_ABI, 2);
  assert.strictEqual(binary.KERNEL_ABI, 2);
  assert.strictEqual(protocol.PERM_SIZE, 512);
  assert.ok(protocol.MODULE_LIMITS.maxBytes > kernelBytes.length);
  assert.ok(protocol.KERNEL_REQUIRED_EXPORTS.includes('mc_fbm2_batch'));
});

ok('base64 解码与原始二进制逐字节一致', () => {
  const decoded = protocol.decodeBase64(binary.KERNEL_BASE64);
  assert.strictEqual(decoded.length, kernelBytes.length);
  assert.strictEqual(decoded.length, binary.KERNEL_BYTES);
  assert.deepStrictEqual(Buffer.from(decoded), Buffer.from(kernelBytes));
  assert.match(binary.KERNEL_SHA256, /^[0-9a-f]{64}$/);
});

ok('decodeBase64 拒绝非法字符 / magic 校验', () => {
  assert.throws(() => protocol.decodeBase64('####'), /非法 base64/);
  assert.strictEqual(protocol.hasWasmMagic(kernelBytes), true);
  assert.strictEqual(protocol.hasWasmMagic(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0])), false);
  assert.strictEqual(protocol.decodeBase64('AAEC').length, 3);
});

ok('fnv1a 稳定且与 jsFingerprint 有确定值', () => {
  assert.strictEqual(protocol.fnv1a(new Uint8Array([1, 2, 3])), protocol.fnv1a(new Uint8Array([1, 2, 3])));
  assert.notStrictEqual(protocol.fnv1a(new Uint8Array([1, 2, 3])), protocol.fnv1a(new Uint8Array([3, 2, 1])));
  assert.ok(Number.isFinite(protocol.jsFingerprint()));
});

ok('内核二进制：零 import / 14 个导出 / ABI 2', () => {
  const mod = new WebAssembly.Module(kernelBytes);
  const imports = WebAssembly.Module.imports(mod);
  assert.strictEqual(imports.length, 0, `不允许 import，实际 ${imports.length}`);
  const names = WebAssembly.Module.exports(mod).map((e) => e.name);
  assert.strictEqual(names.length, 14);
  for (const name of protocol.KERNEL_REQUIRED_EXPORTS) {
    assert.ok(names.includes(name), `缺少导出 ${name}`);
  }
  const ex = new WebAssembly.Instance(mod, {}).exports;
  assert.strictEqual(ex.mc_abi(), 2);
  assert.ok(Object.is(ex.mc_fingerprint(), protocol.jsFingerprint()));
});

ok('loadBuiltinKernel 元数据完整', () => {
  const m = kernel.loadBuiltinKernel();
  assert.strictEqual(m.abi, 2);
  assert.strictEqual(m.bytes, kernelBytes.length);
  assert.strictEqual(m.sha256, binary.KERNEL_SHA256);
  assert.match(m.checksum, /^[0-9a-f]{8}$/);
  assert.strictEqual(m.exports.length, 14);
});

ok('compileKernel 拒绝损坏二进制', () => {
  hasIssue(() => kernel.compileKernel(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0])), /不是合法的 wasm|magic/);
  hasIssue(() => kernel.compileKernel(kernelBytes.subarray(0, 120)), /编译失败|导出/);
});

ok('内核实例 setPerm / crc32 / call', () => {
  const inst = kernel.loadBuiltinKernel().instantiate();
  inst.setPerm(noiseMath.makePermutation(2026));
  const data = new Uint8Array([0, 1, 2, 3, 255, 128, 77, 42, 0]);
  assert.strictEqual(inst.crc32(data), 196924603);
  assert.strictEqual(inst.call('mc_ao', [1, 1, 1]), 0);
  assert.strictEqual(inst.call('mc_ao', [1, 0, 1]), 1);
  assert.strictEqual(inst.call('mc_ao', [0, 0, 0]), 3);
  assert.throws(() => inst.setPerm(new Uint8Array(10)), /长度/);
  assert.throws(() => inst.call('not-there', []), /未提供/);
  assert.throws(() => inst.call('mc_ao', [NaN, 0, 0]), /有限数值/);
});

// ---------- 等价性自检 ----------
const SAMPLE_COUNT = 5 * (noiseMath.EQUIVALENCE_SAMPLES.length * 5 + 1);

ok('等价性自检：多 seed × 5 类函数 + 批量路径全部逐位相等', () => {
  const r = kernel.verifyKernelEquivalence(kernel.loadBuiltinKernel());
  assert.strictEqual(r.ok, true, JSON.stringify(r.mismatches.slice(0, 2)));
  assert.strictEqual(r.samples, SAMPLE_COUNT);
  assert.strictEqual(r.mismatches.length, 0);
});

ok('等价性自检能检出伪造内核', () => {
  const zero = {
    mc_noise2: () => 0, mc_noise3: () => 0, mc_fbm2: () => 0, mc_fbm3: () => 0,
    mc_ridged2: () => 0, mc_fbm2_batch: () => 0,
  };
  const fake = {
    abi: 2, bytes: 1, sha256: '', checksum: '', exports: [],
    instantiate: () => ({ exports: zero, memory: null, setPerm() {}, crc32: () => 0, call: () => 0 }),
  };
  const r = kernel.verifyKernelEquivalence(fake, [2026]);
  assert.strictEqual(r.ok, false);
  assert.ok(r.mismatches.length > 0);
  assert.ok(r.mismatches.every((m) => m.seed === 2026 && typeof m.fn === 'string'));
});

ok('createNoiseBackend 与 JS 参考逐位一致（多 seed）', () => {
  const m = kernel.loadBuiltinKernel();
  for (const seed of [2026, 4242, 777, 20261115, 1]) {
    const perm = noiseMath.makePermutation(seed);
    const js = noiseMath.makeNoiseFunctions(perm);
    const b = kernel.createNoiseBackend(m, perm);
    for (const [x, y, z] of noiseMath.EQUIVALENCE_SAMPLES) {
      assert.ok(Object.is(js.noise2(x, y), b.noise2(x, y)), `noise2 seed=${seed}`);
      assert.ok(Object.is(js.noise3(x, y, z), b.noise3(x, y, z)), `noise3 seed=${seed}`);
      assert.ok(Object.is(js.fbm2(x, y, 4, 2, 0.5), b.fbm2(x, y, 4, 2, 0.5)), `fbm2 seed=${seed}`);
      assert.ok(Object.is(js.fbm3(x, y, z, 3, 2, 0.5), b.fbm3(x, y, z, 3, 2, 0.5)), `fbm3 seed=${seed}`);
      assert.ok(Object.is(js.ridged2(x, y, 4, 2, 0.5), b.ridged2(x, y, 4, 2, 0.5)), `ridged2 seed=${seed}`);
    }
  }
});

ok('WASM 调用抛错时后端自动回退 JS 且只上报一次', () => {
  const perm = noiseMath.makePermutation(2026);
  const js = noiseMath.makeNoiseFunctions(perm);
  let failures = 0;
  let wasmCalls = 0;
  const ex = {
    mc_noise2: () => { wasmCalls++; throw new Error('simulated trap'); },
    mc_noise3: () => 0, mc_fbm2: () => 0, mc_fbm3: () => 0, mc_ridged2: () => 0,
  };
  const fake = {
    abi: 2, bytes: 1, sha256: '', checksum: '', exports: [],
    instantiate: () => ({ exports: ex, memory: null, setPerm() {}, crc32: () => 0, call: () => 0 }),
  };
  const backend = kernel.createNoiseBackend(fake, perm, { onFailure: () => { failures++; } });
  assert.ok(Object.is(backend.noise2(1.25, -3.5), js.noise2(1.25, -3.5)));
  assert.ok(Object.is(backend.noise2(2.5, 4.5), js.noise2(2.5, 4.5)));
  assert.strictEqual(failures, 1);
  assert.strictEqual(wasmCalls, 1, '回退后不应再次尝试 WASM');
});

// ---------- 运行时 ----------
ok('WasmRuntime 自检通过后进入 ready 并发事件', () => {
  const ready = [];
  const rt = new WasmRuntime({ onReady: (e) => ready.push(e) });
  assert.strictEqual(rt.init(), 'ready');
  const st = rt.stats();
  assert.strictEqual(st.status, 'ready');
  assert.strictEqual(st.abi, 2);
  assert.strictEqual(st.bytes, kernelBytes.length);
  assert.strictEqual(st.selfCheckSamples, SAMPLE_COUNT);
  assert.strictEqual(st.selfCheckMismatches, 0);
  assert.strictEqual(ready.length, 1);
  assert.ok(noise.getNoiseBackendFactory(), '噪声后端应已安装');
  rt.dispose();
  assert.strictEqual(noise.getNoiseBackendFactory(), null);
});

ok('后端接管后 Noise 输出与纯 JS 完全一致（地形确定性不破）', () => {
  const rt = new WasmRuntime();
  rt.init();
  const js = noiseMath.makeNoiseFunctions(noiseMath.makePermutation(2026));
  const n = new noise.Noise(2026);
  for (const [x, y, z] of noiseMath.EQUIVALENCE_SAMPLES) {
    assert.ok(Object.is(js.noise2(x, y), n.noise2(x, y)));
    assert.ok(Object.is(js.fbm2(x, y, 4, 2, 0.5), n.fbm2(x, y, 4, 2, 0.5)));
    assert.ok(Object.is(js.ridged2(x, y, 4, 2, 0.5), n.ridged2(x, y, 4, 2, 0.5)));
    assert.ok(Object.is(js.fbm3(x, y, z, 3, 2, 0.5), n.fbm3(x, y, z, 3, 2, 0.5)));
  }
  rt.dispose();
  const n2 = new noise.Noise(2026);
  assert.ok(Object.is(js.noise2(1.25, -3.5), n2.noise2(1.25, -3.5)), '卸载后回到 JS 路径');
});

ok('?wasm=0 等价的 enabled:false → disabled 且不安装后端', () => {
  const rt = new WasmRuntime({ enabled: false });
  assert.strictEqual(rt.init(), 'disabled');
  assert.strictEqual(noise.getNoiseBackendFactory(), null);
  rt.dispose();
});

ok('环境不支持 / 二进制损坏 → fallback 且记录原因', () => {
  const a = new WasmRuntime({ wasmAvailable: false });
  assert.strictEqual(a.init(), 'fallback');
  assert.match(a.stats().lastError, /不支持/);
  assert.strictEqual(a.stats().fallbacks, 1);
  a.dispose();

  const b = new WasmRuntime({ bytes: new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 2, 3]) });
  assert.strictEqual(b.init(), 'fallback');
  assert.ok(b.stats().lastError);
  assert.strictEqual(noise.getNoiseBackendFactory(), null);
  b.dispose();
});

ok('setEnabled 运行时开关可关闭 / 重新自检开启', () => {
  const rt = new WasmRuntime();
  rt.init();
  assert.strictEqual(rt.setEnabled(false), 'disabled');
  assert.strictEqual(noise.getNoiseBackendFactory(), null);
  assert.strictEqual(rt.setEnabled(true), 'ready');
  assert.ok(noise.getNoiseBackendFactory());
  rt.dispose();
});

ok('benchmark 结果自洽（批量路径 + 逐位正确）', () => {
  const rt = new WasmRuntime();
  rt.init();
  const bm = rt.benchmark(300);
  assert.ok(bm);
  assert.strictEqual(bm.correct, true);
  assert.strictEqual(bm.iterations, 300);
  assert.ok(bm.jsMs > 0 && bm.wasmMs > 0 && bm.speedup > 0);
  assert.ok(Number.isFinite(bm.checksum));
  rt.dispose();
  const off = new WasmRuntime({ enabled: false });
  off.init();
  assert.strictEqual(off.benchmark(), null);
  off.dispose();
});

ok('callKernel 暴露整数原语与 ABI', () => {
  const rt = new WasmRuntime();
  rt.init();
  assert.strictEqual(rt.callKernel('mc_abi', []), 2);
  assert.strictEqual(rt.callKernel('mc_ao', [1, 1, 1]), 0);
  assert.strictEqual(rt.callKernel('mc_ao', [0, 1, 0]), 2);
  assert.ok(Number.isFinite(rt.callKernel('mc_noise2', [1.25, -3.5])));
  assert.ok(rt.stats().calls >= 4);
  hasIssue(() => rt.callKernel('missing', []), /未提供/);
  rt.dispose();
});

// ---------- 插件自定义模块 ----------
ok('自定义 WASM 模块注册 / 调用 / 列表 / 注销', () => {
  const rt = new WasmRuntime();
  rt.init();
  const info = rt.registerModule('demo:kernel', kernelBytes);
  assert.strictEqual(info.id, 'demo:kernel');
  assert.strictEqual(info.bytes, kernelBytes.length);
  assert.strictEqual(info.memory, true);
  assert.ok(info.exports.includes('mc_ao'));
  assert.strictEqual(rt.callModule('demo:kernel', 'mc_ao', [0, 0, 0]), 3);
  assert.strictEqual(rt.listModules().length, 1);
  assert.strictEqual(rt.stats().modules, 1);
  assert.strictEqual(rt.unregisterModule('demo:kernel'), true);
  hasIssue(() => rt.callModule('demo:kernel', 'mc_ao', []), /未注册/);
  rt.dispose();
});

ok('自定义模块准入：非法 id / magic / 体积 / 重复 / 数量', () => {
  const rt = new WasmRuntime();
  rt.init();
  hasIssue(() => rt.registerModule('bad id', kernelBytes), /非法|bad-arguments/);
  hasIssue(() => rt.registerModule('demo:bad', new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0])), /不是合法的 wasm|magic/);
  const huge = new Uint8Array(protocol.MODULE_LIMITS.maxBytes + 1);
  huge.set([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
  hasIssue(() => rt.registerModule('demo:huge', huge), /超过上限/);
  const b64 = Buffer.from(kernelBytes).toString('base64');
  rt.registerModule('demo:dup', b64);
  hasIssue(() => rt.registerModule('demo:dup', b64), /重复注册/);
  hasIssue(() => rt.registerModule('demo:bad64', '####'), /非法 base64/);
  rt.dispose();
});

ok('自定义模块调用参数与导出约束', () => {
  const rt = new WasmRuntime({ maxModules: 4 });
  rt.init();
  rt.registerModule('demo:k', kernelBytes);
  hasIssue(() => rt.callModule('demo:k', 'memory', []), /未提供函数导出/);
  hasIssue(() => rt.callModule('demo:k', 'mc_ao', [1, 2, NaN]), /有限数值/);
  hasIssue(() => rt.callModule('demo:k', 'mc_ao', Array(20).fill(1)), /最多/);
  hasIssue(() => rt.callModule('nope', 'mc_ao', []), /未注册/);
  rt.dispose();
});

// ---------- 权限与插件 ----------
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
    registerPlant() {}, unregisterPlant() {}, registerRule() {}, unregisterRules() {},
    listRules: () => [], stats: () => ({}),
  },
  plugins: {
    register() {}, enable() {}, disable() {}, unload() {}, list: () => [],
    get() {}, reload() {}, enableAll() {}, stats() {}, install() {}, findByCapability() {},
  },
  wasm: {
    status: () => 'ready', stats: () => ({}), benchmark: () => null,
    setEnabled: () => 'ready', listModules: () => [], call: () => 1,
    callModule: () => 1, registerModule: () => ({}), unregisterModule: () => true,
  },
  registerBlock() {}, registerTile() {}, registerEntity() {}, setGenerator() {},
  on() { return () => {}; }, off() {}, emit() {},
});

ok('scopeAPI 裁剪 wasm:use / plugins:manage，只读能力保留', () => {
  const scoped = scopeAPI(fakeApi(), []);
  assert.strictEqual(scoped.wasm.status(), 'ready');
  assert.deepStrictEqual(scoped.wasm.listModules(), []);
  hasIssue(() => scoped.wasm.call('mc_ao'), /缺少权限 wasm:use/);
  hasIssue(() => scoped.wasm.callModule('x', 'f'), /缺少权限 wasm:use/);
  hasIssue(() => scoped.wasm.registerModule('x', new Uint8Array()), /缺少权限 wasm:use/);
  hasIssue(() => scoped.wasm.setEnabled(false), /缺少权限 wasm:use/);
  assert.deepStrictEqual(scoped.plugins.list(), []);
  hasIssue(() => scoped.plugins.register({}), /缺少权限 plugins:manage/);
  hasIssue(() => scoped.plugins.enable('x'), /缺少权限 plugins:manage/);
  hasIssue(() => scoped.plugins.reload('x'), /缺少权限 plugins:manage/);
  hasIssue(() => scoped.plugins.install(''), /缺少权限 plugins:manage/);
  const allowed = scopeAPI(fakeApi(), ['wasm:use', 'plugins:manage']);
  assert.strictEqual(allowed.wasm.call('mc_ao'), 1);
  assert.doesNotThrow(() => allowed.plugins.enable('x'));
});

ok('内置 wasm-monitor 插件 manifest 兼容当前插件 API', () => {
  const m = wasmMonitorPlugin.manifest;
  assert.strictEqual(m.id, 'core:wasm-monitor');
  assert.strictEqual(satisfies(PLUGIN_API_VERSION, m.apiVersion), true);
  assert.ok(m.capabilities.includes('wasm.monitor'));
  assert.strictEqual(typeof m.priority, 'number');
  assert.deepStrictEqual(m.permissions, []);
});

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} WASM 层回归：${passed} 项断言，失败 ${failures} 项`);
process.exit(failures > 0 ? 1 : 0);
