/**
 * WASM 层协议常量与零依赖工具（v1.5.0）。
 *
 * 这里只放「纯逻辑」：常量、base64 解码、能力检测、模块二进制校验，
 * 不引用 DOM / 业务模块，因此可被 test:snapshot 编译成 CommonJS 供 Node 回归直接 require。
 * ABI 契约详见 docs/WASM.md；native/mc_kernel.c 与 scripts/build-wasm.mjs 与此文件保持一致。
 */

/** 内核 ABI：native/mc_kernel.c 的 mc_abi()，变更时两侧必须同步 */
export const KERNEL_ABI = 2;
export const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d] as const;
export const PERM_SIZE = 512;
export const SCRATCH_SIZE = 4096;

/** 内置内核必须提供的导出（build-wasm.mjs 会用同一张表做编译期校验） */
export const KERNEL_REQUIRED_EXPORTS = [
  'memory',
  'mc_abi',
  'mc_perm_ptr',
  'mc_scratch_ptr',
  'mc_scratch_size',
  'mc_fingerprint',
  'mc_noise2',
  'mc_noise3',
  'mc_fbm2',
  'mc_fbm3',
  'mc_ridged2',
  'mc_fbm2_batch',
  'mc_ao',
  'mc_crc32',
] as const;

/** 插件自定义模块的安全边界：无 import、体积 / 内存 / 导出数量均受限 */
export const MODULE_LIMITS = {
  maxBytes: 256 * 1024,
  maxMemoryPages: 16,
  maxExports: 64,
  maxCallArgs: 16,
} as const;

export type WasmErrorCode =
  | 'unavailable'
  | 'invalid-magic'
  | 'invalid-base64'
  | 'compile-failed'
  | 'instantiate-failed'
  | 'missing-export'
  | 'abi-mismatch'
  | 'fingerprint-mismatch'
  | 'has-imports'
  | 'too-large'
  | 'too-many-exports'
  | 'memory-limit'
  | 'module-not-found'
  | 'bad-arguments'
  | 'call-failed'
  | 'equivalence-failed';

export class WasmKernelError extends Error {
  constructor(
    readonly code: WasmErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WasmKernelError';
  }
}

export const isWasmAvailable = (): boolean =>
  typeof WebAssembly !== 'undefined' &&
  typeof WebAssembly.Module === 'function' &&
  typeof WebAssembly.Instance === 'function' &&
  typeof WebAssembly.Module.imports === 'function';

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_TABLE: Int16Array = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) t[B64_ALPHABET.charCodeAt(i)] = i;
  return t;
})();

/** 纯 JS base64 解码：浏览器 / Node 通用，不依赖 atob（单文件产物同样适用） */
export function decodeBase64(input: string): Uint8Array {
  const s = input.replace(/\s+/g, '');
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0x3d) break; // '=' padding
    const v = code < 128 ? B64_TABLE[code] : -1;
    if (v < 0) throw new WasmKernelError('invalid-base64', `非法 base64 字符 @${i}`);
    acc = ((acc << 6) | v) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export function hasWasmMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  return WASM_MAGIC.every((b, i) => bytes[i] === b);
}

/** 插件模块准入校验：只检查静态结构，实例化放到 kernel.ts */
export function validateModuleBytes(bytes: Uint8Array): void {
  if (!hasWasmMagic(bytes)) throw new WasmKernelError('invalid-magic', '不是合法的 wasm 二进制');
  if (bytes.length > MODULE_LIMITS.maxBytes) {
    throw new WasmKernelError('too-large', `模块 ${bytes.length} 字节超过上限 ${MODULE_LIMITS.maxBytes}`);
  }
}

/** FNV-1a 32 位校验和：不依赖 node:crypto，浏览器 / Node 通用，用于插件模块标识 */
export function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 与 C 侧 mc_fingerprint 相同的纯 JS 参考，用于确认加载的是本内核产物 */
export function jsFingerprint(): number {
  let s = 0;
  for (let i = 1; i <= 16; i++) {
    const x = i * 0.375;
    s += Math.floor(x) * x + Math.sqrt(x);
  }
  return s;
}
