/**
 * init() 级安装决策集成回归（Task 5 接线，Fix round 1 补录）。
 *
 * 运行前置：npm run test:snapshot
 *   npm run test:wasm-install-decision   # 自动重建快照后执行
 *
 * 覆盖 wasmParam='0' / 'force' / null（adaptive）与 legacy 默认构造，
 * 断言 init() 后的 status、stats().backend 与 benchJsMs/benchWasmMs 语义，
 * 以及 window 之外的全局噪声后端工厂是否与实际 backend 一致。
 * 与临时脚本 /tmp/opencode/verify-task5.cjs 手工验证项一一对应。
 */
const assert = require('node:assert');
const { WasmRuntime } = require('./logic/wasm/runtime.js');
const noise = require('./logic/world/noise.js');
const noiseMath = require('./logic/world/noiseMath.js');

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

/** 每个 case 结束都销毁实例并确认后端工厂卸载，避免单例状态串味 */
const cleanup = (rt) => {
  rt.dispose();
  assert.strictEqual(noise.getNoiseBackendFactory(), null, 'dispose 后不应残留后端工厂');
};

console.log('WASM init() 安装决策回归（off / force / adaptive / legacy / setEnabled）');

// 1) adaptive：wasmParam=null + enabled=true → 跑对称基准，backend 与安装一致
ok('adaptive(null,true)：ready，两侧 bench>0，backend 与工厂一致，输出逐位等于 JS', () => {
  const rt = new WasmRuntime({ wasmParam: null, enabled: true });
  assert.strictEqual(rt.init(), 'ready');
  const st = rt.stats();
  assert.ok(st.benchJsMs > 0 && st.benchWasmMs > 0, `两侧基准耗时必须 >0：js=${st.benchJsMs} wasm=${st.benchWasmMs}`);
  assert.ok(st.backend === 'js' || st.backend === 'wasm', `非法 backend=${st.backend}`);
  assert.strictEqual(noise.getNoiseBackendFactory() !== null, st.backend === 'wasm');
  const js = noiseMath.makeNoiseFunctions(noiseMath.makePermutation(2026));
  const n = new noise.Noise(2026);
  for (const [x, y, _z] of noiseMath.EQUIVALENCE_SAMPLES) {
    assert.ok(Object.is(js.fbm2(x, y, 3, 2, 0.5), n.fbm2(x, y, 3, 2, 0.5)));
    assert.ok(Object.is(js.noise2(x, y), n.noise2(x, y)));
  }
  cleanup(rt);
});

// 2) force：即使 enabled=false 也直接安装，且不跑基准
ok('force(false)：ready、backend=wasm、bench=0、工厂已安装', () => {
  const rt = new WasmRuntime({ wasmParam: 'force', enabled: false });
  assert.strictEqual(rt.init(), 'ready');
  const st = rt.stats();
  assert.strictEqual(st.backend, 'wasm');
  assert.strictEqual(st.benchJsMs, 0);
  assert.strictEqual(st.benchWasmMs, 0);
  assert.ok(noise.getNoiseBackendFactory());
  cleanup(rt);
});

// 3) ?wasm=0：即使 enabled=true 也强制关闭，setEnabled(true) 不能绕开
ok("'0'(true)：disabled、backend=js、无工厂，setEnabled(true) 仍关闭", () => {
  const rt = new WasmRuntime({ wasmParam: '0', enabled: true });
  assert.strictEqual(rt.init(), 'disabled');
  const st = rt.stats();
  assert.strictEqual(st.backend, 'js');
  assert.strictEqual(st.benchJsMs === 0 && st.benchWasmMs === 0, true, 'off 模式不跑基准');
  assert.strictEqual(noise.getNoiseBackendFactory(), null);
  assert.strictEqual(rt.setEnabled(true), 'disabled');
  cleanup(rt);
});

// 4) legacy 默认构造（不传 wasmParam）：保持 v1.5.0 直接安装语义
ok('legacy 默认构造：ready、backend=wasm（兼容既有调用方）', () => {
  const rt = new WasmRuntime();
  assert.strictEqual(rt.init(), 'ready');
  assert.strictEqual(rt.stats().backend, 'wasm');
  assert.ok(noise.getNoiseBackendFactory());
  cleanup(rt);
});

// 5) adaptive 下 setEnabled(false→true)：关闭卸载、重开重跑基准
ok('adaptive setEnabled(false→true)：disabled/js → ready，重跑后 bench>0', () => {
  const rt = new WasmRuntime({ wasmParam: null, enabled: true });
  rt.init();
  assert.strictEqual(rt.setEnabled(false), 'disabled');
  assert.strictEqual(rt.stats().backend, 'js');
  assert.strictEqual(noise.getNoiseBackendFactory(), null);
  assert.strictEqual(rt.setEnabled(true), 'ready');
  assert.ok(rt.stats().benchJsMs > 0 && rt.stats().benchWasmMs > 0);
  cleanup(rt);
});

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} init() 安装决策：${passed} 项，失败 ${failures} 项`);
process.exit(failures > 0 ? 1 : 0);
