/**
 * 从 native/mc_kernel.c 编译并内联 WebAssembly 内核。
 *
 * 产物：
 *  - native/mc_kernel.wasm       真实二进制（提交进仓库，CI 不需要 clang）
 *  - src/wasm/kernelBinary.ts     base64 内联常量（单文件 HTML 的关键：不依赖网络 / file:// 可运行）
 *
 * 编译后会做 ABI 硬校验：magic、零 import、必需导出齐全、ABI 版本、指纹与 JS 参考一致。
 * 用法：
 *   node scripts/build-wasm.mjs            # 重新编译并生成
 *   node scripts/build-wasm.mjs --check    # 只校验内联产物是否与当前 wasm 一致（不编译）
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cSrc = path.join(root, 'native', 'mc_kernel.c');
const wasmPath = path.join(root, 'native', 'mc_kernel.wasm');
const outPath = path.join(root, 'src', 'wasm', 'kernelBinary.ts');
const ABI = 2;
const REQUIRED_EXPORTS = [
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
];

const fail = (msg) => {
  console.error(`[wasm] ${msg}`);
  process.exit(1);
};

/** 与 C 侧 mc_fingerprint / TS 侧 fingerprint 完全相同的纯 JS 参考 */
const jsFingerprint = () => {
  let s = 0;
  for (let i = 1; i <= 16; i++) {
    const x = i * 0.375;
    s += Math.floor(x) * x + Math.sqrt(x);
  }
  return s;
};

function validate(bytes) {
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    fail('不是合法的 wasm 二进制（magic 错误）');
  }
  let mod;
  try {
    mod = new WebAssembly.Module(bytes);
  } catch (e) {
    fail(`WebAssembly 编译失败：${e.message}`);
  }
  const imports = WebAssembly.Module.imports(mod);
  if (imports.length !== 0) fail(`内核含有 ${imports.length} 个 import，freestanding 约束被破坏`);
  const names = new Set(WebAssembly.Module.exports(mod).map((e) => e.name));
  for (const name of REQUIRED_EXPORTS) if (!names.has(name)) fail(`缺少导出：${name}`);
  const inst = new WebAssembly.Instance(mod, {});
  const ex = inst.exports;
  if (ex.mc_abi() !== ABI) fail(`ABI 版本不符：${ex.mc_abi()}，期望 ${ABI}`);
  if (!Object.is(ex.mc_fingerprint(), jsFingerprint())) fail('内核指纹与 JS 参考不一致（编译产物可能被替换）');
  const mem = ex.memory;
  if (!(mem instanceof WebAssembly.Memory)) fail('memory 导出类型错误');
  const pp = ex.mc_perm_ptr(),
    sp = ex.mc_scratch_ptr(),
    ss = ex.mc_scratch_size();
  if (pp < 0 || sp < 0 || ss < 0 || pp + 512 > mem.buffer.byteLength) fail('perm / scratch 地址越界');
  console.log(`[wasm] ABI 校验通过：${bytes.length} 字节，${names.size} 个导出，0 个 import`);
}

function generate(bytes) {
  const b64 = bytes.toString('base64');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const ts = `/* 由 scripts/build-wasm.mjs 自动生成，请勿手工编辑。
 * 源：native/mc_kernel.c → native/mc_kernel.wasm
 * 内联为 base64 是为了让 vite-plugin-singlefile 产出的单文件 HTML 在 file:// 下
 * 依然能同步实例化 WebAssembly（无需 fetch / 无外部资源）。
 */
export const KERNEL_BASE64 = '${b64}';
export const KERNEL_SHA256 = '${sha}';
export const KERNEL_BYTES = ${bytes.length};
export const KERNEL_ABI = ${ABI};
`;
  writeFileSync(outPath, ts, 'utf8');
  return { b64, sha };
}

const checkOnly = process.argv.includes('--check');
if (checkOnly) {
  if (!existsSync(wasmPath) || !existsSync(outPath)) fail('缺少 wasm 或内联产物，请先运行 npm run build:wasm');
  const bytes = readFileSync(wasmPath);
  validate(bytes);
  const cur = readFileSync(outPath, 'utf8');
  const b64 = bytes.toString('base64');
  if (!cur.includes(`'${b64}'`)) fail('kernelBinary.ts 与 native/mc_kernel.wasm 不一致，请重新运行 build:wasm');
  console.log('[wasm] 内联产物与二进制一致');
  process.exit(0);
}

const clang = process.env.CLANG || 'clang';
const args = [
  '--target=wasm32',
  '-O2',
  '-ffreestanding',
  '-nostdlib',
  '-fno-exceptions',
  '-Wall',
  '-Wextra',
  '-Wl,--no-entry',
  '-Wl,--export-memory',
  '-Wl,--initial-memory=131072',
  '-Wl,--max-memory=1048576',
  '-Wl,--strip-all',
  '-o',
  wasmPath,
  cSrc,
];
try {
  execFileSync(clang, args, { cwd: root, stdio: 'inherit' });
} catch (e) {
  fail(`clang 编译失败（可用 CLANG=/path/to/clang 指定编译器）：${e.message}`);
}
const bytes = readFileSync(wasmPath);
validate(bytes);
const { sha } = generate(bytes);
console.log(`[wasm] 已生成 src/wasm/kernelBinary.ts（sha256 ${sha.slice(0, 16)}…）`);
