/**
 * 后端选择与参数优先级纯函数回归（C 的决策层，Task 4）。
 *
 * 覆盖 chooseNoiseBackend / resolveWasmMode / NOISE_BENCH_SAMPLE 三个纯导出。
 * 依赖 test:snapshot 生成的 CommonJS 快照，验证前必须先跑 npm run test:snapshot。
 */
const assert = require('node:assert');

const { NOISE_BENCH_SAMPLE, chooseNoiseBackend, resolveWasmMode } = require('./logic/wasm/runtime.js');

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

// ---------- chooseNoiseBackend ----------
ok('默认 threshold 0.9：wasmMs=70 < 90 → wasm', () => {
  assert.strictEqual(chooseNoiseBackend({ jsMs: 100, wasmMs: 70 }), 'wasm');
});

ok('默认 threshold 0.9 边界：wasmMs=90 == 90 → js（严格小于才选 wasm）', () => {
  assert.strictEqual(chooseNoiseBackend({ jsMs: 100, wasmMs: 90 }), 'js');
});

ok('自定义 threshold 0.75：wasmMs=80 > 75 → js', () => {
  assert.strictEqual(chooseNoiseBackend({ jsMs: 100, wasmMs: 80, threshold: 0.75 }), 'js');
});

ok('自定义 threshold 0.75：wasmMs=70 < 75 → wasm', () => {
  assert.strictEqual(chooseNoiseBackend({ jsMs: 100, wasmMs: 70, threshold: 0.75 }), 'wasm');
});

ok('threshold >= 1 视为无效：wasmMs=150 < jsMs×2 也不接管', () => {
  assert.strictEqual(chooseNoiseBackend({ jsMs: 100, wasmMs: 150, threshold: 2 }), 'js');
  assert.strictEqual(chooseNoiseBackend({ jsMs: 100, wasmMs: 70, threshold: 1 }), 'js');
});

ok('非法 / NaN 输入一律回退 js', () => {
  assert.strictEqual(chooseNoiseBackend({ jsMs: NaN, wasmMs: 70 }), 'js');
  assert.strictEqual(chooseNoiseBackend({ jsMs: 100, wasmMs: NaN }), 'js');
  assert.strictEqual(chooseNoiseBackend({ jsMs: 100, wasmMs: 70, threshold: NaN }), 'js');
  assert.strictEqual(chooseNoiseBackend({ jsMs: 0, wasmMs: 0 }), 'js');
  assert.strictEqual(chooseNoiseBackend({ jsMs: Infinity, wasmMs: 70 }), 'js');
});

// ---------- resolveWasmMode ----------
ok('参数优先级：0 / force 显式覆盖 experimental', () => {
  assert.strictEqual(resolveWasmMode('0', true), 'off');
  assert.strictEqual(resolveWasmMode('force', false), 'force');
});

ok('无参数时由 experimental 决定：true → adaptive，false → off', () => {
  assert.strictEqual(resolveWasmMode(null, true), 'adaptive');
  assert.strictEqual(resolveWasmMode(null, false), 'off');
});

ok('未知参数回落到 experimental 默认', () => {
  assert.strictEqual(resolveWasmMode('bogus', true), 'adaptive');
  assert.strictEqual(resolveWasmMode('bogus', false), 'off');
});

// ---------- NOISE_BENCH_SAMPLE ----------
ok('NOISE_BENCH_SAMPLE 逐值等于约定采样数', () => {
  assert.deepStrictEqual({ ...NOISE_BENCH_SAMPLE }, { noise2: 5, fbm2: 4, ridged2: 1, noise3: 2, fbm3: 0 });
});

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} 后端选择纯函数：${passed} 项，失败 ${failures} 项`);
process.exit(failures > 0 ? 1 : 0);
