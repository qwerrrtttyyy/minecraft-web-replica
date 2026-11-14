/**
 * 版本一致性机械校验（本次强化唯一版本源扫描）。
 *
 * 检查项：
 *  1. package.json.version === src/core/version.ts 的 VERSION；
 *  2. README.md 出现当前版本号；
 *  3. src/**\/*.ts 中不得硬编码 'X.Y.Z' 版本字面量（唯一来源必须是 core/version.ts），
 *     这样才能真正杜绝「包名 / package.json / CraftAPI / F3 四处漂移」。
 *
 * 说明：旧注释声称「README 标题必须一致」，但本仓库 README 标题本身不含版本号，
 * 机械校验标题不可行；改为「README 必须包含当前版本」+「源码唯一版本源」两条可落地规则。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const src = readFileSync(path.join(root, 'src/core/version.ts'), 'utf8');
const m = src.match(/export const VERSION\s*=\s*'([^']+)'/);

if (!m) {
  console.error('[version] src/core/version.ts 未找到 VERSION 常量');
  process.exit(1);
}
if (m[1] !== pkg.version) {
  console.error(`[version] 不一致：package.json=${pkg.version}，version.ts=${m[1]}`);
  process.exit(1);
}
const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
if (!readme.includes(pkg.version)) {
  console.error(`[version] README.md 未出现版本号 ${pkg.version}`);
  process.exit(1);
}

/** 递归收集 src 下的 .ts 文件（排除 core/version.ts 本身） */
function tsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const versionLiteral = /(['"])(\d+\.\d+\.\d+)\1/g;
/** 插件 manifest 的 `version: 'X.Y.Z'` 是组件自身版本，不是项目版本，予以豁免 */
const componentVersion = /\bversion\s*[:=]\s*['"]\d+\.\d+\.\d+['"]/;
const leaks = [];
let skipped = 0;
for (const file of tsFiles(path.join(root, 'src'))) {
  if (path.relative(root, file).replace(/\\/g, '/') === 'src/core/version.ts') continue;
  const text = readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    for (const match of line.matchAll(versionLiteral)) {
      // 与当前版本重复的字面量一律报错；其余仅豁免明确标注为组件 version 的字段
      if (match[2] !== pkg.version && componentVersion.test(line)) { skipped++; continue; }
      leaks.push(`${path.relative(root, file)}: ${match[2]}${match[2] === pkg.version ? '（与当前版本重复，应引用 VERSION）' : ''}`);
    }
  }
}
if (leaks.length > 0) {
  console.error('[version] 源码中出现硬编码版本字面量，应统一引用 core/version.ts：');
  for (const leak of leaks) console.error(`  - ${leak}`);
  process.exit(1);
}
console.log(`[version] 版本一致：${pkg.version}（唯一版本源校验通过，扫描 ${tsFiles(path.join(root, 'src')).length} 个 TS 文件，豁免 ${skipped} 处组件自身版本号）`);
