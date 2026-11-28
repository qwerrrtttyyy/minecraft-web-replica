/**
 * 版本机械校验（双轨版本 + 唯一版本源扫描）。
 *
 * 检查项：
 *  1. VERSION（非正式版）必须为 X.Y.Z，RELEASE（正式版）必须为 vN；
 *  2. package.json.version === VERSION；
 *  3. README 含两行版本标记（当前正式版 / 当前非正式版）；
 *  4. src/**\/*.ts 不得硬编码 'X.Y.Z' 版本字面量（唯一来源必须是 core/version.ts），
 *     杜绝「包名 / package.json / CraftAPI / F3 四处漂移」；组件自身 version 字段豁免。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const src = readFileSync(path.join(root, 'src/core/version.ts'), 'utf8');
const readme = readFileSync(path.join(root, 'README.md'), 'utf8');

const fail = (msg) => {
  console.error(`[version] ${msg}`);
  process.exit(1);
};

const m = src.match(/export const VERSION\s*=\s*'([^']+)'/);
const r = src.match(/export const RELEASE\s*=\s*'([^']+)'/);
if (!m) fail('src/core/version.ts 未找到 VERSION 常量');
if (!r) fail('src/core/version.ts 未找到 RELEASE 常量');
const version = m[1],
  release = r[1];

// 预发布版使用 SemVer 后缀（1.5.2-alpha.1 → beta → rc → 1.5.2），见 README「版本规范」
if (!/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(version))
  fail(`非正式版格式错误：${version}（应为 X.Y.Z[-alpha.N]，不带 v 前缀）`);
if (!/^v\d+$/.test(release)) fail(`正式版格式错误：${release}（应为 vN，N 为整数）`);
if (version !== pkg.version) fail(`不一致：package.json=${pkg.version}，version.ts=${version}`);
if (!readme.includes(`当前非正式版：${version}`)) fail(`README.md 缺少版本标记行「当前非正式版：${version}」`);
if (!readme.includes(`当前正式版：${release}`)) fail(`README.md 缺少版本标记行「当前正式版：${release}」`);

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

const files = tsFiles(path.join(root, 'src'));
const versionLiteral = /(['"])(\d+\.\d+\.\d+)\1/g;
/** 插件 manifest 的 `version: 'X.Y.Z'` 是组件自身版本，不是项目版本，予以豁免 */
const componentVersion = /\bversion\s*[:=]\s*['"]\d+\.\d+\.\d+['"]/;
const leaks = [];
let skipped = 0;
for (const file of files) {
  if (path.relative(root, file).replace(/\\/g, '/') === 'src/core/version.ts') continue;
  const text = readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    for (const match of line.matchAll(versionLiteral)) {
      if (match[2] !== pkg.version && componentVersion.test(line)) {
        skipped++;
        continue;
      }
      leaks.push(
        `${path.relative(root, file)}: ${match[2]}${match[2] === pkg.version ? '（与当前版本重复，应引用 VERSION）' : ''}`,
      );
    }
  }
}
if (leaks.length > 0) {
  console.error('[version] 源码中出现硬编码版本字面量，应统一引用 core/version.ts：');
  for (const leak of leaks) console.error(`  - ${leak}`);
  process.exit(1);
}
console.log(
  `[version] 双轨版本一致：正式版 ${release} / 非正式版 ${version}（唯一版本源扫描 ${files.length} 个 TS 文件，豁免 ${skipped} 处组件版本号）`,
);
