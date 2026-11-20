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
import { installNoiseBackend } from '../world/noise';
import {
  EQUIVALENCE_SAMPLES, makeNoiseFunctions, makePermutation,
} from '../world/noiseMath';
import {
  DEFAULT_CHECK_SEEDS, compileKernel, compilePluginModule, createNoiseBackend,
  loadBuiltinKernel, verifyKernelEquivalence,
  type PluginModuleRecord, type WasmKernelInstance, type WasmKernelModule,
} from './kernel';
import {
  WasmKernelError, fnv1a, isWasmAvailable, type WasmErrorCode,
} from './protocol';
import type { Disposable } from '../services/ServiceContainer';

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
  /** false 表示强制关闭（例如 URL 参数 ?wasm=0） */
  enabled?: boolean;
  /** 注入自定义二进制：测试用它模拟损坏内核 / 等价性失败 */
  bytes?: Uint8Array;
  checkSeeds?: readonly number[];
  /** 模拟「环境不支持 WebAssembly」 */
  wasmAvailable?: boolean;
  maxModules?: number;
  onReady?: (event: WasmReadyEvent) => void;
  onFallback?: (event: WasmFallbackEvent) => void;
}

const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

const errorMessage = (e: unknown): string => e instanceof Error ? e.message : String(e);
const errorCode = (e: unknown): WasmErrorCode | undefined =>
  e instanceof WasmKernelError ? e.code : undefined;

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
  private calls = 0;
  private fallbacks = 0;
  private lastError: string | null = null;

  constructor(private readonly options: WasmRuntimeOptions = {}) {
    this.enabled = options.enabled !== false;
    this.maxModules = options.maxModules ?? 16;
  }

  /** 同步初始化；boot() 在创建 DefaultGenerator 之前调用 */
  init(): WasmStatus {
    if (this.disposed) throw new Error('[wasm] 服务已销毁');
    if (this.status === 'ready') return this.status;
    if (!this.enabled) {
      this.status = 'disabled';
      return this.status;
    }
    if (this.options.wasmAvailable === false || !isWasmAvailable()) {
      return this.fallback(new WasmKernelError('unavailable', '当前环境不支持 WebAssembly'));
    }
    const started = now();
    try {
      const injected = this.options.bytes;
      this.module = injected
        ? compileKernel(injected, { sha256: fnv1a(injected) })
        : loadBuiltinKernel();
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
      installNoiseBackend((perm) => createNoiseBackend(mod, perm, {
        onCall: () => { this.calls++; },
        onFailure: (e) => this.reportRuntimeFailure(e),
      }));
      this.loadMs = now() - started;
      this.lastError = null;
      this.status = 'ready';
      this.options.onReady?.({
        abi: mod.abi, bytes: mod.bytes, sha256: mod.sha256, samples: report.samples,
      });
    } catch (e) {
      return this.fallback(e);
    }
    return this.status;
  }

  private fallback(e: unknown): WasmStatus {
    this.status = 'fallback';
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
    installNoiseBackend(null);
    this.options.onFallback?.({ reason: this.lastError, code: errorCode(e) });
  }

  getState(): WasmStatus { return this.status; }

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
    if (!v) {
      installNoiseBackend(null);
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

      const bx = -3.25, by = 7.5, step = 0.137, n = 64;
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
