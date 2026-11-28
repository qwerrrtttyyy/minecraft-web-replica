/**
 * 把测试用 WASM 插件编译并 base64 内联（v1.6.0）。
 *
 * 这些 fixture 是「WASM 插件载体」回归的真实二进制来源：
 *   - host_plugin_fixture.c：合规 host 插件（5 个白名单 import + 统一 mc_hook）
 *   - bad_host_fixture.c  ：import 白名单外的 mc_evil，用于负例校验
 *
 * 产物 src/plugins/example/hostPluginFixtureBinary.ts 提交进仓库，
 * 因此 CI / `npm run verify` 不需要 clang（就像 mc_kernel.wasm 一样）。
 * 用法：npm run build:plugin-fixtures（需要 clang --target=wasm32）
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clang = process.env.CLANG || 'clang';
const common = [
  '--target=wasm32',
  '-O2',
  '-ffreestanding',
  '-nostdlib',
  '-fno-exceptions',
  '-Wl,--no-entry',
  '-Wl,--export-memory',
  '-Wl,--initial-memory=131072',
  '-Wl,--strip-all',
];

for (const name of ['host_plugin_fixture', 'bad_host_fixture']) {
  const src = path.join(root, 'native', `${name}.c`);
  const out = path.join(root, 'native', `${name}.wasm`);
  try {
    execFileSync(clang, [...common, '-o', out, src], { cwd: root, stdio: 'inherit' });
  } catch (e) {
    console.error(`[fixtures] 编译 ${name} 失败：${e.message}`);
    process.exit(1);
  }
  const mod = new WebAssembly.Module(readFileSync(out));
  const imports = WebAssembly.Module.imports(mod);
  console.log(`[fixtures] ${name}: ${imports.length} imports, ${WebAssembly.Module.exports(mod).length} exports`);
}

const b64 = (f) => readFileSync(path.join(root, 'native', f)).toString('base64');
const ts = `/**
 * 自动生成：host 插件 fixture 的 base64 内联（CI 不需要 clang）。
 * 源：native/host_plugin_fixture.c / native/bad_host_fixture.c
 * 由 scripts/build-plugin-fixtures.mjs 生成，请勿手工编辑。
 */
export const HOST_PLUGIN_BASE64 = '${b64('host_plugin_fixture.wasm')}';
export const BAD_HOST_PLUGIN_BASE64 = '${b64('bad_host_fixture.wasm')}';
`;
writeFileSync(path.join(root, 'src', 'plugins', 'example', 'hostPluginFixtureBinary.ts'), ts, 'utf8');
console.log('[fixtures] 已生成 src/plugins/example/hostPluginFixtureBinary.ts');
