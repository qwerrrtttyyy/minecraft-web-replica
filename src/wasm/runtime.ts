/**
 * WASM 运行时服务（v1.5.0）。
 *
 * 它是服务容器里的一等公民（TOKENS.Wasm），完整生命周期：
 *   能力检测 → 同步加载内联内核 → ABI / 指纹 / 导出校验 → 等价性对拍
 *   → 安装噪声后端 → 运行期异常自动回退 JS → 统计 / 基准 / 插件模块注册。
 *
 * 关键不变量：**未通过自检，绝不接管地形计算**。任何一步失败都回到 v1.4.3 的
 * 纯 JS 路径，游戏行为与固定 seed 地形完全不变；失败原因进入 stats.lastError，
 * 并发出 wasm:fallback 事件供插件 / 诊断观测。
 */

import type { Disposable } from '../services/ServiceContainer';
import { installNoiseBackend } from '../world/noise';
import { EQUIVALENCE_SAMPLES, makeNoiseFunctions, makePermutation, type NoiseFunctions } from '../world/noiseMath';
import {
  compileKernel,
  compilePluginModule,
  createNoiseBackend,
  DEFAULT_CHECK_SEEDS,
  loadBuiltinKernel,
  type PluginModuleRecord,
  verifyKernelEquivalence,
  type WasmKernelInstance,
  type WasmKernelModule,
} from './kernel';
import { fnv1a, isWasmAvailable, type WasmErrorCode, WasmKernelError } from './protocol';

export type WasmStatus = 'disabled' | 'unavailable' | 'ready' | 'fallback';

export interface WasmReadyEvent {
  abi: number;
  bytes: number;
  sha256: string;
  samples: number;
}

export interface WasmFallbackEvent {
  reason: string;
  code?: WasmErrorCode;
}

export interface WasmStats {
  status: WasmStatus;
  enabled: boolean;
  abi: number;
  bytes: number;
  sha256: string;
  loadMs: number;
  selfCheckSamples: number;
  selfCheckMismatches: number;
  selfCheckSeeds: number[];
  /** 实际生效的噪声后端：pending=尚未决策，js=保持 JS 参考，wasm=已安装 WASM 后端 */
  backend: 'js' | 'wasm' | 'pending';
  /** 自适应基准耗时（毫秒）；force / off 模式不跑基准，保持 0 */
  benchJsMs: number;
  benchWasmMs: number;
  calls: number;
  fallbacks: number;
  modules: number;
  lastError: string | null;
}

export interface WasmModuleInfo {
  id: string;
  bytes: number;
  checksum: string;
  exports: readonly string[];
  memory: boolean;
}

export interface WasmBenchmark {
  iterations: number;
  jsMs: number;
  wasmMs: number;
  speedup: number;
  correct: boolean;
  checksum: number;
}

export interface WasmRuntimeOptions {
  /** 实验性内容开关（设置页的值）；与 wasmParam 一起决定 off/force/adaptive */
  enabled?: boolean;
  /**
   * URL 参数 ?wasm 的原值。显式传入（含 null）才启用自适应决策：
   * '0'→off，'force'→force，其余按 enabled 走 adaptive/off。
   * 不传则保留 v1.5.0 行为（enabled=true 直接安装后端），兼容既有调用方与回归。
   */
  wasmParam?: string | null;
  /** 注入自定义二进制：测试用它模拟损坏内核 / 等价性失败 */
  bytes?: Uint8Array;
  checkSeeds?: readonly number[];
  /** 模拟「环境不支持 WebAssembly」 */
  wasmAvailable?: boolean;
  maxModules?: number;
  onReady?: (event: WasmReadyEvent) => void;
  onFallback?: (event: WasmFallbackEvent) => void;
}

/** 基准采样负载：各噪声函数在单次 bench 中的调用次数（C 决策层据此计算总耗时）。 */
export const NOISE_BENCH_SAMPLE = { noise2: 5, fbm2: 4, ridged2: 1, noise3: 2, fbm3: 0 } as const;

/**
 * 自适应后端选择：只有 WASM 明显更快（严格小于 jsMs * threshold）才接管。
 * 默认阈值 0.9，给测量噪声留 10% 余量；非法 / NaN 输入一律回到安全的 JS 路径。
 */
export function chooseNoiseBackend(input: { jsMs: number; wasmMs: number; threshold?: number }): 'js' | 'wasm' {
  const { jsMs, wasmMs, threshold = 0.9 } = input;
  if (!Number.isFinite(jsMs) || !Number.isFinite(wasmMs) || !Number.isFinite(threshold)) return 'js';
  // threshold >= 1 等于允许「不比 JS 快」的 WASM 接管，违背只在实测更快时安装的约定
  if (jsMs <= 0 || wasmMs < 0 || threshold <= 0 || threshold >= 1) return 'js';
  return wasmMs < jsMs * threshold ? 'wasm' : 'js';
}

/** 参数优先级：URL 显式值最高，其次实验开关，默认关闭。 */
export function resolveWasmMode(param: string | null, experimental: boolean): 'off' | 'force' | 'adaptive' {
  if (param === '0') return 'off';
  if (param === 'force') return 'force';
  return experimental ? 'adaptive' : 'off';
}

type WasmMode = ReturnType<typeof resolveWasmMode>;
type BenchOp = keyof typeof NOISE_BENCH_SAMPLE;

/**
 * 一次采样的调用序列：严格按生成器的真实逐点组合展开（fbm3 计数为 0，不产生调用）。
 * 坐标固定，两侧共享同一序列，保证 JS / WASM 的负载逐项对齐。
 */
const BENCH_OPS: readonly BenchOp[] = (Object.keys(NOISE_BENCH_SAMPLE) as BenchOp[]).flatMap((op) =>
  Array.from({ length: NOISE_BENCH_SAMPLE[op] }, () => op),
);

/**
 * 对称基准：固定 perm / 坐标序列，JS 参考与 WASM 后端跑完全相同的调用组合与次数。
 *
 * 不能用 WasmRuntime.benchmark()：它要求 status==='ready'（此时还没安装后端），
 * 且只测 mc_fbm2_batch 批量路径，而地形热点是逐点调用。这里必须在安装后端之前完成。
 */
function benchmarkNoiseBackends(mod: WasmKernelModule, perm: Uint8Array): { jsMs: number; wasmMs: number } {
  const js = makeNoiseFunctions(perm);
  const wasm = createNoiseBackend(mod, perm);
  const n = BENCH_OPS.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const zs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = i * 0.137 - 3.25;
    ys[i] = i * 0.219 + 7.5;
    zs[i] = i * 0.071 - 1.5;
  }
  const run = (f: NoiseFunctions, rounds: number): number => {
    let sink = 0;
    for (let r = 0; r < rounds; r++) {
      for (let i = 0; i < n; i++) {
        switch (BENCH_OPS[i]) {
          case 'noise2':
            sink += f.noise2(xs[i], ys[i]);
            break;
          case 'noise3':
            sink += f.noise3(xs[i], ys[i], zs[i]);
            break;
          case 'fbm2':
            sink += f.fbm2(xs[i], ys[i], 3, 2, 0.5);
            break;
          case 'fbm3':
            sink += f.fbm3(xs[i], ys[i], zs[i], 3, 2, 0.5);
            break;
          case 'ridged2':
            sink += f.ridged2(xs[i], ys[i], 3, 2, 0.5);
            break;
        }
      }
    }
    return sink;
  };
  try {
    const warmup = 60,
      trials = 5,
      rounds = 400;
    // 充分预热后再计时：JS 闭包需要数千次调用才会被 V8 优化，预热不足会把
    // JIT 编译开销算进 JS 侧，导致决策翻转。两侧预热与试跑次数完全对称。
    run(js, warmup);
    run(wasm, warmup);
    let jsMs = Infinity,
      wasmMs = Infinity,
      jsSink = 0,
      wasmSink = 0;
    for (let t = 0; t < trials; t++) {
      // 奇数试跑反转测量顺序：两侧调用组合、坐标与累加仍完全对称，
      // 但交替先后可抵消机器负载单调漂移带来的系统性偏差。
      const jsFirst = t % 2 === 0;
      const first = jsFirst ? js : wasm;
      const second = jsFirst ? wasm : js;
      const t0 = now();
      const firstSink = run(first, rounds);
      const firstMs = now() - t0;
      const t1 = now();
      const secondSink = run(second, rounds);
      const secondMs = now() - t1;
      if (jsFirst) {
        jsSink += firstSink;
        wasmSink += secondSink;
        jsMs = Math.min(jsMs, firstMs);
        wasmMs = Math.min(wasmMs, secondMs);
      } else {
        wasmSink += firstSink;
        jsSink += secondSink;
        wasmMs = Math.min(wasmMs, firstMs);
        jsMs = Math.min(jsMs, secondMs);
      }
    }
    // 校验和参与结果判定，防止纯计算循环被 JIT 整体消掉；异常时安全回退 JS
    const checksum = (Math.abs(jsSink) + Math.abs(wasmSink)) | 0;
    return checksum === 0 ? { jsMs: 0, wasmMs: 0 } : { jsMs, wasmMs };
  } finally {
    // 临时后端用毕即释放 WASM 实例引用，避免 memory 累积
    wasm.dispose?.();
  }
}

const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const errorCode = (e: unknown): WasmErrorCode | undefined => (e instanceof WasmKernelError ? e.code : undefined);

export class WasmRuntime implements Disposable {
  private status: WasmStatus = 'disabled';
  private enabled: boolean;
  private module: WasmKernelModule | null = null;
  private kernelInstance: WasmKernelInstance | null = null;
  private modules = new Map<string, PluginModuleRecord>();
  private readonly maxModules: number;
  private disposed = false;

  private loadMs = 0;
  private selfCheckSamples = 0;
  private selfCheckMismatches = 0;
  private selfCheckSeeds: number[] = [];
  private backend: WasmStats['backend'] = 'pending';
  private benchJsMs = 0;
  private benchWasmMs = 0;
  private calls = 0;
  private fallbacks = 0;
  private lastError: string | null = null;

  constructor(private readonly options: WasmRuntimeOptions = {}) {
    this.enabled = options.enabled !== false;
    this.maxModules = options.maxModules ?? 16;
  }

  /** off/force/adaptive 由 URL 参数与实验性开关共同决定；未传 wasmParam 时保留旧版直接安装语义 */
  private mode(): WasmMode {
    if (this.options.wasmParam === undefined) return this.enabled ? 'force' : 'off';
    return resolveWasmMode(this.options.wasmParam, this.enabled);
  }

  /** 同步初始化；boot() 在创建 DefaultGenerator 之前调用 */
  init(): WasmStatus {
    if (this.disposed) throw new Error('[wasm] 服务已销毁');
    if (this.status === 'ready') return this.status;
    const mode = this.mode();
    if (mode === 'off') {
      this.status = 'disabled';
      this.backend = 'js';
      return this.status;
    }
    if (this.options.wasmAvailable === false || !isWasmAvailable()) {
      return this.fallback(new WasmKernelError('unavailable', '当前环境不支持 WebAssembly'));
    }
    const started = now();
    try {
      const injected = this.options.bytes;
      this.module = injected ? compileKernel(injected, { sha256: fnv1a(injected) }) : loadBuiltinKernel();
      const report = verifyKernelEquivalence(this.module, this.options.checkSeeds ?? DEFAULT_CHECK_SEEDS);
      this.selfCheckSamples = report.samples;
      this.selfCheckMismatches = report.mismatches.length;
      this.selfCheckSeeds = [...report.seeds];
      if (!report.ok) {
        const first = report.mismatches[0];
        throw new WasmKernelError(
          'equivalence-failed',
          `等价性自检失败：${report.mismatches.length}/${report.samples} 项不等` +
            (first ? `（seed=${first.seed} ${first.fn} js=${first.js} wasm=${first.wasm}）` : ''),
        );
      }
      const mod = this.module;
      this.kernelInstance = mod.instantiate();
      this.kernelInstance.setPerm(makePermutation(2026));
      // 安装决策在自检通过之后、安装后端之前完成：
      // force 跳过基准直接安装（实验性关闭时也生效）；adaptive 跑对称基准，
      // 只有 WASM 明显更快才接管，否则保持 v1.4.3 的纯 JS 路径。
      let useWasm = mode === 'force';
      if (mode === 'adaptive') {
        const bench = benchmarkNoiseBackends(mod, makePermutation(2026));
        this.benchJsMs = bench.jsMs;
        this.benchWasmMs = bench.wasmMs;
        useWasm = chooseNoiseBackend(bench) === 'wasm';
      }
      if (useWasm) {
        installNoiseBackend((perm) =>
          createNoiseBackend(mod, perm, {
            onCall: () => {
              this.calls++;
            },
            onFailure: (e) => this.reportRuntimeFailure(e),
          }),
        );
        this.backend = 'wasm';
      } else {
        // 自适应判定 JS 更快（或基准失效）：确保不残留任何 WASM 后端工厂
        installNoiseBackend(null);
        this.backend = 'js';
      }
      this.loadMs = now() - started;
      this.lastError = null;
      this.status = 'ready';
      this.options.onReady?.({
        abi: mod.abi,
        bytes: mod.bytes,
        sha256: mod.sha256,
        samples: report.samples,
      });
    } catch (e) {
      return this.fallback(e);
    }
    return this.status;
  }

  private fallback(e: unknown): WasmStatus {
    this.status = 'fallback';
    this.backend = 'js';
    this.lastError = errorMessage(e);
    this.fallbacks++;
    installNoiseBackend(null);
    this.options.onFallback?.({ reason: this.lastError, code: errorCode(e) });
    return this.status;
  }

  /** 运行期 WASM 调用异常：计数 + 卸载后端，已构造的 Noise 实例由自身 guard 回退 */
  private reportRuntimeFailure(e: unknown): void {
    this.fallbacks++;
    this.lastError = errorMessage(e);
    // 运行期失败同样落到 fallback 终态，避免诊断看到「ready 但已卸载后端」的矛盾状态
    this.status = 'fallback';
    this.backend = 'js';
    installNoiseBackend(null);
    this.options.onFallback?.({ reason: this.lastError, code: errorCode(e) });
  }

  getState(): WasmStatus {
    return this.status;
  }

  stats(): WasmStats {
    return {
      status: this.status,
      enabled: this.enabled,
      abi: this.module?.abi ?? 0,
      bytes: this.module?.bytes ?? 0,
      sha256: this.module?.sha256 ?? '',
      loadMs: this.loadMs,
      selfCheckSamples: this.selfCheckSamples,
      selfCheckMismatches: this.selfCheckMismatches,
      selfCheckSeeds: [...this.selfCheckSeeds],
      backend: this.backend,
      benchJsMs: this.benchJsMs,
      benchWasmMs: this.benchWasmMs,
      calls: this.calls,
      fallbacks: this.fallbacks,
      modules: this.modules.size,
      lastError: this.lastError,
    };
  }

  /** 运行时开关：关闭会立刻卸载噪声后端；重新打开会重新自检 */
  setEnabled(v: boolean): WasmStatus {
    if (this.disposed) throw new Error('[wasm] 服务已销毁');
    if (v === this.enabled) return this.status;
    this.enabled = v;
    if (this.mode() === 'off') {
      installNoiseBackend(null);
      this.backend = 'js';
      this.status = 'disabled';
      this.options.onFallback?.({ reason: 'WASM 已被手动关闭' });
      return this.status;
    }
    this.status = 'disabled';
    return this.init();
  }

  /**
   * JS 参考 vs WASM 的同负载基准（批量路径）。
   *
   * 逐点跨界调用会被 JS↔WASM 边界开销吃掉收益（实测 V8 上 WASM 反而略慢），
   * 因此用 mc_fbm2_batch 一次调用算 64 个点，这才是该内核的正确用法。
   * 两侧累加顺序一致，correct 用 Object.is 逐位判定；未就绪时返回 null。
   */
  benchmark(iterations = 2000): WasmBenchmark | null {
    if (this.status !== 'ready' || !this.module || !this.kernelInstance) return null;
    const perm = makePermutation(2026);
    const js = makeNoiseFunctions(perm);
    const ex = this.kernelInstance.exports;
    const backend = createNoiseBackend(this.module, perm);
    try {
      // 1) 逐点等价（与 init 的自检同源，作为基准自身的可信度校验）
      const expected = EQUIVALENCE_SAMPLES.map(([x, y]) => js.fbm2(x, y, 4, 2, 0.5));
      const got = EQUIVALENCE_SAMPLES.map(([x, y]) => backend.fbm2(x, y, 4, 2, 0.5));
      const pointCorrect = expected.every((v, i) => Object.is(v, got[i]));

      const bx = -3.25,
        by = 7.5,
        step = 0.137,
        n = 64;
      let jsBatch = 0;
      for (let i = 0; i < n; i++) jsBatch += js.fbm2(bx + i * step, by, 4, 2, 0.5);
      const batchCorrect = Object.is(jsBatch, ex.mc_fbm2_batch(bx, by, step, n, 4, 2, 0.5));

      // 2) 计时：JS 逐点 vs WASM 单次批量，负载完全相同
      let jsSink = 0;
      const t0 = now();
      for (let i = 0; i < iterations; i++) {
        const x0 = bx + i * 0.0001;
        let s = 0;
        for (let j = 0; j < n; j++) s += js.fbm2(x0 + j * step, by, 4, 2, 0.5);
        jsSink += s;
      }
      const jsMs = now() - t0;

      let wasmSink = 0;
      const t1 = now();
      for (let i = 0; i < iterations; i++) {
        wasmSink += ex.mc_fbm2_batch(bx + i * 0.0001, by, step, n, 4, 2, 0.5);
      }
      const wasmMs = now() - t1;

      return {
        iterations,
        jsMs,
        wasmMs,
        speedup: wasmMs > 0 ? jsMs / wasmMs : 0,
        correct: pointCorrect && batchCorrect,
        // 防止 JIT 把纯计算循环整体消掉
        checksum: (Math.abs(jsSink) + Math.abs(wasmSink)) | 0,
      };
    } finally {
      // benchmark 是低频诊断调用，临时后端用毕即释放 WASM 实例引用，避免 memory 累积。
      backend.dispose?.();
    }
  }

  /** 调用内置内核的数值导出（mc_ao / mc_crc32 / mc_noise2 ...） */
  callKernel(name: string, args: readonly number[] = []): number {
    if (this.status !== 'ready' || !this.kernelInstance) {
      throw new WasmKernelError('unavailable', `WASM 未就绪（${this.status}），无法调用 ${name}`);
    }
    this.calls++;
    return this.kernelInstance.call(name, args);
  }

  registerModule(id: string, data: Uint8Array | ArrayBuffer | string): WasmModuleInfo {
    if (this.disposed) throw new Error('[wasm] 服务已销毁');
    if (this.modules.has(id)) throw new WasmKernelError('bad-arguments', `WASM 模块重复注册: ${id}`);
    if (this.modules.size >= this.maxModules) {
      throw new WasmKernelError('too-large', `WASM 模块数量超过上限 ${this.maxModules}`);
    }
    const rec = compilePluginModule(id, data);
    this.modules.set(id, rec);
    return moduleInfo(rec);
  }

  unregisterModule(id: string): boolean {
    return this.modules.delete(id);
  }

  listModules(): WasmModuleInfo[] {
    return [...this.modules.values()].map(moduleInfo);
  }

  callModule(id: string, fn: string, args: readonly number[] = []): number {
    const rec = this.modules.get(id);
    if (!rec) throw new WasmKernelError('module-not-found', `WASM 模块未注册: ${id}`);
    this.calls++;
    return rec.call(fn, args);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    installNoiseBackend(null);
    this.modules.clear();
    this.kernelInstance = null;
    this.module = null;
  }
}

const moduleInfo = (rec: PluginModuleRecord): WasmModuleInfo => ({
  id: rec.id,
  bytes: rec.bytes,
  checksum: rec.checksum,
  exports: rec.exports,
  memory: rec.memory,
});

export { WasmKernelError } from './protocol';
