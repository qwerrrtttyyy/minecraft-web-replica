#!/usr/bin/env node
/**
 * 权限表一致性机械校验（H14）：
 *
 * 1. WRITE_CAPABILITIES 里列出的每个 namespace.method 必须真实存在于
 *    src/api/CraftAPI.ts 的 interface —— 防止改名/删除后表格悄悄过期；
 * 2. 已知「整段写入口」命名空间（settings / input / save）的每个写形方法
 *    必须全部入表 —— 防止「只拦 4 个」式的系统性漏拦再次发生。
 *
 * 纯静态文本解析，无任何依赖；接入 npm run verify 后缺项即 CI 失败。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const craftSrc = fs.readFileSync(path.join(root, 'src/api/CraftAPI.ts'), 'utf8');
const pluginSrc = fs.readFileSync(path.join(root, 'src/services/plugins/PluginService.ts'), 'utf8');

const fails = [];

// ---- 解析 CraftAPI interface：namespace → 方法名集合（逐行，遇 } 回退到顶层） ----
const apiMembers = new Map(); // ns 字符串或 null（顶层）→ Set(方法名)
const ifaceStart = craftSrc.indexOf('export interface CraftAPI {');
if (ifaceStart < 0) {
  console.error('FAIL：未找到 export interface CraftAPI');
  process.exit(1);
}
let ns = null;
for (const line of craftSrc.slice(ifaceStart).split('\n')) {
  const nsStart = line.match(/^\s{2}([A-Za-z_$][\w$]*)\s*[?:]?\s*:\s*\{/);
  const topMethod = line.match(/^\s{2}([A-Za-z_$][\w$]*)\s*[?:]?\s*[<(]/);
  const nsMethod = line.match(/^\s{4}([A-Za-z_$][\w$]*)\s*[?:]?\s*[<(]/);
  const nsEnd = /^\s{2}\};?,?\s*$/;
  if (nsStart) {
    ns = nsStart[1];
    if (!apiMembers.has(ns)) apiMembers.set(ns, new Set());
    // 单行命名空间（如 `tnt: { ignite(...): void };`）：同行 `{` 后的成员也算
    for (const m of line.slice(line.indexOf('{') + 1).matchAll(/([A-Za-z_$][\w$]*)\s*[?:]?\s*[<(]/g)) {
      apiMembers.get(ns).add(m[1]);
    }
  } else if (nsEnd.test(line)) {
    ns = null;
  } else if (ns !== null && nsMethod) {
    apiMembers.get(ns).add(nsMethod[1]);
  } else if (ns === null && topMethod) {
    if (!apiMembers.has(null)) apiMembers.set(null, new Set());
    apiMembers.get(null).add(topMethod[1]);
  }
  if (line.startsWith('}') && !nsEnd.test(line) && ifaceStart >= 0) break;
}

// ---- 解析 WRITE_CAPABILITIES：permission → [ns, method] 路径 ----
const tableStart = pluginSrc.indexOf('WRITE_CAPABILITIES');
const tableEnd = pluginSrc.indexOf('\n};', tableStart);
if (tableStart < 0 || tableEnd < 0) {
  console.error('FAIL：未找到 WRITE_CAPABILITIES');
  process.exit(1);
}
const listed = new Map(); // permission → paths
let currentPerm = null;
for (const line of pluginSrc.slice(tableStart, tableEnd).split('\n')) {
  const perm = line.match(/^\s*'([\w:]+)'\s*:\s*\[/);
  if (perm) currentPerm = perm[1];
  if (!currentPerm) continue;
  for (const m of line.matchAll(/\[\s*'([A-Za-z_$][\w$]*)'\s*,\s*'([A-Za-z_$][\w$]*)'\s*\]/g)) {
    const arr = listed.get(currentPerm) ?? [];
    arr.push([m[1], m[2]]);
    listed.set(currentPerm, arr);
  }
}

// ---- 校验 1：表里的每个路径必须在 CraftAPI 上真实存在 ----
for (const [perm, paths] of listed) {
  for (const [n, method] of paths) {
    const set = apiMembers.has(n) ? apiMembers.get(n) : apiMembers.get(null);
    if (!set || !set.has(method)) {
      fails.push(`${perm}: ['${n}', '${method}'] 在 CraftAPI interface 中不存在（表格过期）`);
    }
  }
}

// ---- 校验 2：整段写入口命名空间必须全量入表 ----
// 形如 `name(v: T): void` 的写形签名视为写入口；白名单是明确的只读方法。
const FULL_WRITE_NS = {
  settings: { perm: 'settings:write', readonly: new Set(['exportOptions']) },
  input: { perm: 'settings:write', readonly: new Set(['getBinding', 'gamepadConnected']) },
  save: { perm: 'save:write', readonly: new Set() },
};
for (const [n, { perm, readonly }] of Object.entries(FULL_WRITE_NS)) {
  const methods = apiMembers.get(n);
  if (!methods) continue;
  const covered = new Set((listed.get(perm) ?? []).map((p) => p[1]));
  for (const name of methods) {
    if (readonly.has(name) || covered.has(name)) continue;
    fails.push(`${n}.${name} 是写入口但未列入 ${perm}`);
  }
}

// ---- 校验 3：save:write 必须覆盖全部 5 个入口（含数据外带） ----
const saveCovered = new Set((listed.get('save:write') ?? []).map((p) => p[1]));
for (const m of ['export', 'import', 'exportFile', 'importFile', 'setProvider']) {
  if (!saveCovered.has(m)) fails.push(`save.${m} 未受 save:write 约束（数据外带/覆盖缺口）`);
}

if (fails.length) {
  console.error('权限表校验 FAIL：\n' + fails.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log(`权限表校验通过：${[...listed.values()].flat().length} 条路径全部与 CraftAPI 同步`);
