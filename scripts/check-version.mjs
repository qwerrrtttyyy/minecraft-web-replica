/**
 * 版本一致性机械校验：package.json / src/core/version.ts / README 标题必须一致。
 * v1.1.2 曾出现包名 1.1.2、package.json 1.1.0、CraftAPI 1.1.0、F3 1.1.0 四处漂移。
 */
import { readFileSync } from 'node:fs';
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
console.log(`[version] 版本一致：${pkg.version}`);
