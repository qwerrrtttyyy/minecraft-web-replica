/**
 * WASM 地形生成基准（测量工具，不进 verify）。
 *
 * 三种模式生成同一批新区块，测的是「新区块、缓存全冷」的稳态耗时：
 *   js-point  模拟 Phase 3 之前的 JS 路径：批量接口内部逐点调用 JS 参考实现
 *   js-batch  当前 JS 回退路径：noiseMath 的批量循环（switch 提到循环外）
 *   wasm      当前 WASM 路径：固定 I/O 区 + 单次跨界批量求值
 *
 * 为什么要单独测 js-point：Phase 3 之后生成器一律走 batch 接口，
 * 直接拿「JS + batch 壳」当基线会把批处理的 JS 开销算到 WASM 头上，低估收益。
 *
 * 用法：node test/wasm-bench.cjs [--rounds=3] [--chunks=64]
 * 前置：npm run test:snapshot（读取 test/logic 快照，确保测的是当前源码）
 */
const { DefaultGenerator } = require('./logic/world/generator.js');
const { BlockRegistry, registerBuiltinBlocks } = require('./logic/world/blocks.js');
const { WasmRuntime } = require('./logic/wasm/runtime.js');
const { installNoiseBackend } = require('./logic/world/noise.js');
const { makeNoiseFunctions } = require('./logic/world/noiseMath.js');
const { CHUNK_SIZE: CS, WORLD_HEIGHT: H } = require('./logic/core/types.js');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
const ROUNDS = arg('rounds', 3);
const CHUNKS = arg('chunks', 64);

function makeGen(seed) {
  const reg = new BlockRegistry();
  registerBuiltinBlocks(reg);
  return new DefaultGenerator(seed, reg);
}

/** Phase 3 之前的等价负载：批量接口里逐点调用 JS 参考，没有跨调用状态 */
function pointwiseFactory(perm) {
  const f = makeNoiseFunctions(perm);
  return {
    noise2: f.noise2,
    noise3: f.noise3,
    fbm2: f.fbm2,
    fbm3: f.fbm3,
    ridged2: f.ridged2,
    batch(kind, coords, count, out, opts) {
      const oct = opts?.octaves ?? 1;
      const lac = opts?.lacunarity ?? 2;
      const gain = opts?.gain ?? 0.5;
      for (let i = 0; i < count; i++) {
        const x = coords[i * 3];
        const y = coords[i * 3 + 1];
        const z = coords[i * 3 + 2];
        switch (kind) {
          case 'noise2': out[i] = f.noise2(x, y); break;
          case 'noise3': out[i] = f.noise3(x, y, z); break;
          case 'fbm2': out[i] = f.fbm2(x, y, oct, lac, gain); break;
          case 'fbm3': out[i] = f.fbm3(x, y, z, oct, lac, gain); break;
          case 'ridged2': out[i] = f.ridged2(x, y, oct, lac, gain); break;
          default: throw new Error(`未知批量类型：${kind}`);
        }
      }
      return count;
    },
  };
}

/** 生成一批互不重叠的区块；返回平均每区块毫秒。 */
function run(gen, originX, originZ, count) {
  const data = new Uint8Array(CS * CS * H);
  const side = Math.ceil(Math.sqrt(count));
  const t0 = performance.now();
  let n = 0;
  for (let cx = 0; cx < side && n < count; cx++) {
    for (let cz = 0; cz < side && n < count; cz++) {
      gen.generateChunk(originX + cx, originZ + cz, data);
      n++;
    }
  }
  return (performance.now() - t0) / n;
}

/**
 * 只跑 buildContext（24×24 列噪声 + 坡度差分），排除矿石 / 树木 / 装饰。
 * buildContext 是 private，但运行时就是普通方法；测量工具直接调用，避免复制一份采样逻辑。
 */
function runContext(gen, originX, originZ, count) {
  const t0 = performance.now();
  for (let i = 0; i < count; i++) gen.buildContext(originX + i, originZ);
  return (performance.now() - t0) / count;
}

const stats = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { avg, min: sorted[0], median: sorted[sorted.length >> 1] };
};

let rt = null;
let wasmReady = false;

/** WASM 模式：确保运行时已自检并重新安装后端工厂（前面的 JS 模式会把它顶掉） */
function ensureWasm() {
  if (!rt) rt = new WasmRuntime();
  if (rt.getState() === 'ready') {
    rt.setEnabled(false);
    return rt.setEnabled(true) === 'ready';
  }
  return rt.init() === 'ready';
}

const MODES = [
  { label: 'js-point', offset: 0, install: () => { installNoiseBackend(pointwiseFactory); return true; } },
  { label: 'js-batch', offset: 100, install: () => { installNoiseBackend(null); return true; } },
  { label: 'wasm', offset: 200, install: ensureWasm },
];

/** 按模式安装后端工厂 → 建生成器（Noise 实例在此时捕获后端）→ 恢复全局工厂 */
function makeModeGen(mode) {
  let ok = false;
  try { ok = mode.install(); } catch (e) { console.log(`  ${mode.label} 初始化失败：${e.message}`); }
  if (!ok) return null;
  const gen = makeGen(2026);
  installNoiseBackend(null);
  return gen;
}

console.log(`WASM 地形基准（chunks=${CHUNKS} rounds=${ROUNDS}，Node ${process.version}）`);

// 先建好各模式的生成器，再交替测量，减少机器漂移的系统性偏差
for (const mode of MODES) {
  mode.gen = makeModeGen(mode);
  mode.ok = mode.gen !== null;
  if (mode.ok) {
    run(mode.gen, 1000 + mode.offset, 1000 + mode.offset, 16); // 预热 JIT
    mode.samples = [];
  }
}
wasmReady = MODES.find((m) => m.label === 'wasm')?.ok ?? false;

for (let r = 0; r < ROUNDS; r++) {
  for (const mode of MODES) {
    if (!mode.ok) continue;
    const o = 3000 + r * 300 + mode.offset;
    mode.samples.push(run(mode.gen, o, o, CHUNKS));
  }
}

const result = {};
for (const mode of MODES) {
  if (!mode.ok) {
    console.log(`  ${mode.label.padEnd(9)} 跳过（WASM 状态 ${rt?.stats().lastError ?? rt?.getState() ?? 'unavailable'}）`);
    continue;
  }
  const s = stats(mode.samples);
  result[mode.label] = s;
  console.log(
    `  ${mode.label.padEnd(9)} avg ${s.avg.toFixed(2)} ms/chunk   median ${s.median.toFixed(2)}   min ${s.min.toFixed(2)}` +
    `   samples [${mode.samples.map((v) => v.toFixed(2)).join(', ')}]`,
  );
}

if (result.wasm && result['js-point']) {
  console.log(`\n  整个区块生成：WASM 批量 / 旧 JS 逐点 = ${(result['js-point'].avg / result.wasm.avg).toFixed(2)}×`);
}
if (result.wasm && result['js-batch']) {
  console.log(`  整个区块生成：WASM 批量 / 当前 JS 回退 = ${(result['js-batch'].avg / result.wasm.avg).toFixed(2)}×`);
}

// 列上下文微基准：只含 24×24 列噪声 + 坡度，WASM 信号不会再被其他阶段稀释
if (wasmReady) {
  console.log('\n列上下文微基准（只含 24×24 列噪声 + 坡度）');
  const ctx = {};
  for (const mode of MODES) {
    const gen = makeModeGen(mode);
    if (!gen) continue;
    runContext(gen, 500, 500, 16);
    const samples = [];
    for (let r = 0; r < ROUNDS; r++) samples.push(runContext(gen, 900 + r * 200, 700 + mode.offset, CHUNKS));
    const s = stats(samples);
    ctx[mode.label] = s;
    console.log(
      `  ${mode.label.padEnd(9)} avg ${s.avg.toFixed(3)} ms/context   median ${s.median.toFixed(3)}   min ${s.min.toFixed(3)}`,
    );
  }
  if (ctx.wasm && ctx['js-point']) {
    console.log(`\n  列上下文：WASM 批量 / 旧 JS 逐点 = ${(ctx['js-point'].median / ctx.wasm.median).toFixed(2)}×（按 median）`);
  }
}

if (rt) rt.dispose();
installNoiseBackend(null);
