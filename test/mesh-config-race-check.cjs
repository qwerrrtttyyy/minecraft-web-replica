/**
 * M06：Worker 网格结果与配置版本竞态回归（纯逻辑）。
 *
 * invalidateConfig() 之后到达的旧配置结果必须被判定为过期并重新入队，
 * 否则会留下"用旧方块元数据生成的网格"（方块注册后外观错乱）。
 */
const assert = require('node:assert');
const { isStaleConfigRevision } = require('./logic/world/meshTypes.js');

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  passed++;
  console.log(`  ✓ ${name}`);
};

ok('配置版本不同 → 结果过期', isStaleConfigRevision(3, 4) === true);
ok('配置版本相同 → 结果可用', isStaleConfigRevision(4, 4) === false);
ok('缺失版本（旧 Worker）→ 一律视为过期', isStaleConfigRevision(undefined, 4) === true);
ok('当前版本为 0 时缺失版本仍过期', isStaleConfigRevision(undefined, 0) === true);

console.log(`\nPASS 网格配置竞态回归：${passed} 组断言`);
