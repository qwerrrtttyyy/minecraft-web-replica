/**
 * WebAssembly 内核加载层（v1.5.0）。
 *
 * 设计要点：
 *  - **同步实例化**：`WebAssembly.Module` / `Instance` 同步构造，不需要 fetch / 网络 /
 *    顶层 await，因此单文件 HTML 在 file:// 下也能用，且能在 boot() 早期装好噪声后端。
 *  - **编译产物与运行实例分离**：Module 只编译一次；每个 Noise 实例 instantiate() 一份，
 *    各自持有独立 linear memory 与 perm 表，避免不同 seed 互相污染。
 *  - **等价性对拍**：WASM 输出必须与 noiseMath.ts 的 JS 参考逐位相等（Object.is），
 *    自检不过就不安装后端；运行期异常则逐调用回退 JS，绝不改变地形确定性。
 *  - **插件模块准入**：无 import、体积/内存/导出数量受限，只暴露数值型调用。
 */
import { KERNEL_BASE64, KERNEL_SHA256, KERNEL_BYTES, KERNEL_ABI as GENERATED_ABI } from './kernelBinary';
import {
  KERNEL_ABI, KERNEL_REQUIRED_EXPORTS, MODULE_LIMITS, PERM_SIZE,
  WasmKernelError, decodeBase64, fnv1a, isWasmAvailable, jsFingerprint,
  validateModuleBytes,
} from './protocol';
import {
  EQUIVALENCE_SAMPLES, makeNoiseFunctions, makePermutation,
  type NoiseBackend,
} from '../world/noiseMath';

export interface KernelExports {
  memory: WebAssembly.Memory;
  mc_abi(): number;
  mc_perm_ptr(): number;
  mc_scratch_ptr(): number;
  mc_scratch_size(): number;
  mc_fingerprint(): number;
  mc_noise2(x: number, y: number): number;
  mc_noise3(x: number, y: number, z: number): number;
  mc_fbm2(x: number, y: number, o: number, l: number, g: number): number;
  mc_fbm3(x: number, y: number, z: number, o: number, l: number, g: number): number;
  mc_ridged2(x: number, y: number, o: number, l: number, g: number): number;
  mc_fbm2_batch(x0: number, y0: number, step: number, n: number, o: number, l: number, g: number): number;
  mc_ao(s1: number, s2: number, cc: number): number;
  mc_crc32(ptr: number, len: number): number;
}

export interface WasmKernelInstance {
  readonly exports: KernelExports;
  readonly memory: WebAssembly.Memory;
  setPerm(perm: Uint8Array): void;
  crc32(data: Uint8Array): number;
  /** 按导出名调用数值函数（供 CraftAPI.wasm.call 与插件使用） */
  call(name: string, args: readonly number[]): number;
}

export interface WasmKernelModule {
  readonly abi: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly checksum: string;
  readonly exports: readonly string[];
  instantiate(): WasmKernelInstance;
}

const asBytes = (data: Uint8Array | ArrayBuffer | string): Uint8Array => {
  if (typeof data === 'string') return decodeBase64(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
};

const exportTable = (ex: WebAssembly.Exports): Record<string, unknown> =>
  ex as unknown as Record<string, unknown>;

function callNumeric(
  ex: WebAssembly.Exports,
  name: string,
  args: readonly number[],
  label: string,
): number {
  const fn = exportTable(ex)[name];
  if (typeof fn !== 'function') {
    throw new WasmKernelError('missing-export', `${label} 未提供函数导出 ${name}`);
  }
  if (args.length > MODULE_LIMITS.maxCallArgs || args.some((a) => typeof a !== 'number' || !Number.isFinite(a))) {
    throw new WasmKernelError('bad-arguments', `${label}.${name} 参数必须是有限数值（最多 ${MODULE_LIMITS.maxCallArgs} 个）`);
  }
  let out: unknown;
  try {
    out = (fn as (...a: number[]) => unknown)(...args);
  } catch (e) {
    throw new WasmKernelError('call-failed', `${label}.${name} 调用抛错：${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof out !== 'number') {
    throw new WasmKernelError('bad-arguments', `${label}.${name} 返回值不是数值（WASM 导出只开放数值函数）`);
  }
  return out;
}

function compileRaw(bytes: Uint8Array, strict: boolean): WebAssembly.Module {
  if (!isWasmAvailable()) throw new WasmKernelError('unavailable', '当前环境不支持 WebAssembly');
  validateModuleBytes(bytes);
  let mod: WebAssembly.Module;
  try {
    mod = new WebAssembly.Module(bytes);
  } catch (e) {
    throw new WasmKernelError('compile-failed', `WebAssembly 编译失败：${e instanceof Error ? e.message : String(e)}`);
  }
  const imports = WebAssembly.Module.imports(mod);
  if (imports.length > 0) {
    throw new WasmKernelError('has-imports', `模块含 ${imports.length} 个 import，只允许自包含模块`);
  }
  const exports = WebAssembly.Module.exports(mod);
  if (exports.length > MODULE_LIMITS.maxExports) {
    throw new WasmKernelError('too-many-exports', `导出数量 ${exports.length} 超过上限 ${MODULE_LIMITS.maxExports}`);
  }
  for (const e of exports) {
    if (e.kind !== 'function' && e.kind !== 'memory') {
      throw new WasmKernelError('bad-arguments', `不允许导出 ${e.kind} 类型：${e.name}`);
    }
  }
  if (strict) {
    const names = new Set(exports.map((e) => e.name));
    for (const name of KERNEL_REQUIRED_EXPORTS) {
      if (!names.has(name)) throw new WasmKernelError('missing-export', `内核缺少导出：${name}`);
    }
  }
  return mod;
}

function makeKernelInstance(mod: WebAssembly.Module, label: string): WasmKernelInstance {
  let instance: WebAssembly.Instance;
  try {
    instance = new WebAssembly.Instance(mod, {});
  } catch (e) {
    throw new WasmKernelError('instantiate-failed', `${label} 实例化失败：${e instanceof Error ? e.message : String(e)}`);
  }
  const ex = instance.exports as unknown as KernelExports;
  const memory = ex.memory;
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new WasmKernelError('missing-export', `${label} 缺少 memory 导出`);
  }
  if (memory.buffer.byteLength / 65536 > MODULE_LIMITS.maxMemoryPages) {
    throw new WasmKernelError('memory-limit', `${label} 内存超过 ${MODULE_LIMITS.maxMemoryPages} 页`);
  }
  return {
    exports: ex,
    memory,
    setPerm(perm: Uint8Array) {
      if (perm.length !== PERM_SIZE) {
        throw new WasmKernelError('bad-arguments', `perm 长度必须是 ${PERM_SIZE}`);
      }
      new Uint8Array(memory.buffer, ex.mc_perm_ptr(), PERM_SIZE).set(perm);
    },
    crc32(data: Uint8Array) {
      const size = ex.mc_scratch_size();
      if (data.length > size) {
        throw new WasmKernelError('bad-arguments', `CRC32 输入超过 scratch 容量 ${size}`);
      }
      new Uint8Array(memory.buffer, ex.mc_scratch_ptr(), data.length).set(data);
      return ex.mc_crc32(0, data.length) >>> 0;
    },
    call: (name, args) => callNumeric(instance.exports, name, args, label),
  };
}

/** 编译内置内核（strict：ABI / 指纹 / 必需导出全部校验） */
export function compileKernel(
  bytes: Uint8Array,
  meta: { sha256?: string } = {},
): WasmKernelModule {
  const mod = compileRaw(bytes, true);
  const probe = makeKernelInstance(mod, 'kernel');
  const ex = probe.exports;
  if (ex.mc_abi() !== KERNEL_ABI) {
    throw new WasmKernelError('abi-mismatch', `内核 ABI ${ex.mc_abi()}，期望 ${KERNEL_ABI}`);
  }
  if (!Object.is(ex.mc_fingerprint(), jsFingerprint())) {
    throw new WasmKernelError('fingerprint-mismatch', '内核指纹与 JS 参考不一致');
  }
  const exports = WebAssembly.Module.exports(mod).map((e) => e.name);
  return {
    abi: ex.mc_abi(),
    bytes: bytes.length,
    sha256: meta.sha256 ?? '',
    checksum: fnv1a(bytes),
    exports,
    instantiate: () => makeKernelInstance(mod, 'kernel'),
  };
}

/** 加载随仓库内联的内核二进制（base64 → Uint8Array → 编译） */
export function loadBuiltinKernel(): WasmKernelModule {
  const bytes = decodeBase64(KERNEL_BASE64);
  if (bytes.length !== KERNEL_BYTES) {
    throw new WasmKernelError('invalid-base64', `内联内核长度 ${bytes.length}，期望 ${KERNEL_BYTES}`);
  }
  if (GENERATED_ABI !== KERNEL_ABI) {
    throw new WasmKernelError('abi-mismatch', `生成物 ABI ${GENERATED_ABI} 与协议 ABI ${KERNEL_ABI} 不一致，请重新 build:wasm`);
  }
  return compileKernel(bytes, { sha256: KERNEL_SHA256 });
}

export interface NoiseBackendHooks {
  /** 每次成功的 WASM 调用（用于运行时统计） */
  onCall?(): void;
  /** WASM 调用抛错：后端永久降级到 JS 参考，并上报 runtime */
  onFailure?(error: unknown): void;
}

/**
 * 为单个 perm 表创建 WASM 噪声后端。
 * 每次调用包一层 guard：一旦 wasm 抛错，该实例后续调用全部走 JS 参考，
 * 且不会再次尝试 WASM（避免每帧重复抛异常）。
 */
export function createNoiseBackend(
  module: WasmKernelModule,
  perm: Uint8Array,
  hooks: NoiseBackendHooks = {},
): NoiseBackend {
  const instance = module.instantiate();
  instance.setPerm(perm);
  // ex 用可空变量持有：dispose() 时断开对 WASM 实例 / linear memory 的强引用，
  // 让一次性后端（benchmark）的 wasm memory 可被 GC 回收，而不是等整个闭包消亡。
  let ex: KernelExports | null = instance.exports;
  const js = makeNoiseFunctions(perm);
  let alive = true;
  const guard = (label: string, wasm: (exports: KernelExports) => number, fallback: () => number): number => {
    if (!alive || !ex) return fallback();
    try {
      const v = wasm(ex);
      hooks.onCall?.();
      return v;
    } catch (e) {
      alive = false;
      hooks.onFailure?.(new Error(`[wasm] ${label} 调用异常，已回退 JS：${e instanceof Error ? e.message : String(e)}`));
      return fallback();
    }
  };
  return {
    noise2: (x, y) => guard('noise2', (e) => e.mc_noise2(x, y), () => js.noise2(x, y)),
    noise3: (x, y, z) => guard('noise3', (e) => e.mc_noise3(x, y, z), () => js.noise3(x, y, z)),
    fbm2: (x, y, o, l, g) => guard('fbm2', (e) => e.mc_fbm2(x, y, o, l, g), () => js.fbm2(x, y, o, l, g)),
    fbm3: (x, y, z, o, l, g) => guard('fbm3', (e) => e.mc_fbm3(x, y, z, o, l, g), () => js.fbm3(x, y, z, o, l, g)),
    ridged2: (x, y, o, l, g) => guard('ridged2', (e) => e.mc_ridged2(x, y, o, l, g), () => js.ridged2(x, y, o, l, g)),
    dispose: () => {
      if (!alive) return;
      alive = false;
      ex = null;
    },
  };
}

export interface EquivalenceMismatch {
  seed: number;
  fn: string;
  sample: readonly number[];
  js: number;
  wasm: number;
}

export interface EquivalenceReport {
  ok: boolean;
  seeds: readonly number[];
  samples: number;
  mismatches: EquivalenceMismatch[];
}

export const DEFAULT_CHECK_SEEDS = [2026, 4242, 777, 20261115, 1] as const;

/**
 * 逐位等价性自检：多 seed × 多采样 × 5 类函数，用 Object.is 比较（含 -0）。
 * 任何一项不等即返回 ok=false，WasmRuntime 据此拒绝安装后端并进入 fallback。
 */
export function verifyKernelEquivalence(
  module: WasmKernelModule,
  seeds: readonly number[] = DEFAULT_CHECK_SEEDS,
): EquivalenceReport {
  const mismatches: EquivalenceMismatch[] = [];
  let samples = 0;
  for (const seed of seeds) {
    const perm = makePermutation(seed);
    const js = makeNoiseFunctions(perm);
    const instance = module.instantiate();
    instance.setPerm(perm);
    const ex = instance.exports;
    const check = (fn: string, sample: readonly number[], a: number, b: number) => {
      samples++;
      if (!Object.is(a, b)) mismatches.push({ seed, fn, sample, js: a, wasm: b });
    };
    for (const [x, y, z] of EQUIVALENCE_SAMPLES) {
      const s = [x, y, z] as const;
      check('noise2', s, js.noise2(x, y), ex.mc_noise2(x, y));
      check('noise3', s, js.noise3(x, y, z), ex.mc_noise3(x, y, z));
      check('fbm2', s, js.fbm2(x, y, 4, 2, 0.5), ex.mc_fbm2(x, y, 4, 2, 0.5));
      check('fbm3', s, js.fbm3(x, y, z, 3, 2, 0.5), ex.mc_fbm3(x, y, z, 3, 2, 0.5));
      check('ridged2', s, js.ridged2(x, y, 4, 2, 0.5), ex.mc_ridged2(x, y, 4, 2, 0.5));
    }
    // 批量内核：累加顺序与 JS 参考一致，逐位对拍
    const bx = -3.25, by = 7.5, step = 0.137, n = 64;
    let jsBatch = 0;
    for (let i = 0; i < n; i++) jsBatch += js.fbm2(bx + i * step, by, 4, 2, 0.5);
    check('fbm2_batch', [bx, by, step], jsBatch, ex.mc_fbm2_batch(bx, by, step, n, 4, 2, 0.5));
  }
  return { ok: mismatches.length === 0, seeds: [...seeds], samples, mismatches };
}

/** 插件自定义模块：受控编译 + 数值调用，id 由 PluginService 风格的命名规则约束 */
export interface PluginModuleRecord {
  readonly id: string;
  readonly bytes: number;
  readonly checksum: string;
  readonly exports: readonly string[];
  readonly memory: boolean;
  call(fn: string, args: readonly number[]): number;
}

const MODULE_ID = /^[a-z0-9][a-z0-9._:-]{1,63}$/i;

export function compilePluginModule(
  id: string,
  data: Uint8Array | ArrayBuffer | string,
): PluginModuleRecord {
  if (!MODULE_ID.test(id)) throw new WasmKernelError('bad-arguments', `非法 WASM 模块 id: ${id}`);
  const bytes = asBytes(data);
  const mod = compileRaw(bytes, false);
  const descriptors = WebAssembly.Module.exports(mod);
  const instance = makePluginInstance(mod, id);
  return {
    id,
    bytes: bytes.length,
    checksum: fnv1a(bytes),
    exports: descriptors.map((e) => e.name),
    memory: descriptors.some((e) => e.kind === 'memory'),
    call: (fn, args) => callNumeric(instance.exports, fn, args, `module:${id}`),
  };
}

function makePluginInstance(mod: WebAssembly.Module, id: string): WebAssembly.Instance {
  try {
    return new WebAssembly.Instance(mod, {});
  } catch (e) {
    throw new WasmKernelError('instantiate-failed', `模块 ${id} 实例化失败：${e instanceof Error ? e.message : String(e)}`);
  }
}
