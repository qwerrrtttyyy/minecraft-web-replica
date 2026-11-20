/**
 * WASM 宿主导入 ABI（v1.6.0）。
 *
 * 这是「WASM 插件能做什么」的唯一白名单，等价于浏览器沙箱的 capability 清单：
 *  1. 只允许 `env` 模块下的固定函数；任何其它 import 名字在实例化前被拒绝；
 *  2. 每个函数声明所需权限；权限不足时注入「调用即抛错」的桩（不是删除 import，
 *     因为 WebAssembly.Instance 要求 import 对象键齐全），从而既能加载降级插件，
 *     又不会让越权调用静默成功；
 *  3. 字符串一律通过线性内存的 ptr+len 传递，用 UTF-8 编解码；宿主读写入口统一
 *     做边界检查，防止恶意指针越界。
 *
 * 该模块是纯逻辑（只用 TextEncoder / TextDecoder，浏览器与 Node 22 均内置），
 * 可被 test:snapshot 编译成 CommonJS 直接 require。
 */
import type { PluginPermission } from '../PluginContext';

export const HOST_MODULE = 'env';

/** 宿主导入的最低 WASM ABI（由插件导出 mc_plugin_abi 声明） */
export const HOST_PLUGIN_ABI = 1;

/** 导入名 → 所需权限（undefined 表示读能力，默认开放） */
export const HOST_IMPORT_PERMISSIONS: Readonly<Record<string, PluginPermission | undefined>> = {
  mc_log: undefined,            // 写日志（只读副作用，归属命名空间）
  mc_now: undefined,            // 单调时钟
  mc_rand: undefined,           // 确定性 PRNG（由宿主播种，见 wasmHost.ts）
  mc_world_seed: undefined,     // 读世界种子
  mc_world_get: undefined,      // 读方块
  mc_world_height: undefined,   // 读地表高度
  mc_world_set: 'world:write',  // 写方块（生成期或运行时）
  mc_wasm_call: 'wasm:use',     // 调用内置内核数值导出
  mc_ext_register: undefined,   // 注册扩展点（真正写副作用由回调内的受控导入完成）
  mc_storage_get: undefined,    // 读插件私有存储
  mc_storage_set: undefined,    // 写插件私有存储（命名空间隔离）
};

export const HOST_IMPORT_NAMES = Object.freeze(Object.keys(HOST_IMPORT_PERMISSIONS));

/**
 * 扩展点 → 整数 kind（WASM 侧 mc_hook 的第一个参数）。
 * 宿主与 WASM 模块共用这张表，避免让 C 代码解析字符串；新增层面时在此追加即可。
 */
export const POINT_KINDS: Readonly<Record<string, number>> = Object.freeze({
  'worldgen:column': 1,
  'gameplay:tick': 2,
  'event:block:place': 3,
  'event:block:break': 4,
  'event:chunk:generated': 5,
  'event:player:move': 6,
  'event:entity:spawn': 7,
  'event:survival:damage': 8,
});

/** 把 GameEvents 名称映射到扩展点（事件层由扩展注册表统一桥接） */
export const EVENT_TO_POINT: Readonly<Record<string, string>> = Object.freeze({
  'block:place': 'event:block:place',
  'block:break': 'event:block:break',
  'chunk:generated': 'event:chunk:generated',
  'player:move': 'event:player:move',
  'entity:spawn': 'event:entity:spawn',
  'survival:damage': 'event:survival:damage',
});

/** 从扩展点 payload 提取 4 个数值参数给 WASM mc_hook（缺字段补 0） */
export function payloadNumbers(point: string, payload: unknown): [number, number, number, number] {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const num = (k: string): number => typeof p[k] === 'number' && Number.isFinite(p[k]) ? p[k] as number : 0;
  if (point === 'worldgen:column') return [num('cx'), num('cz'), 0, 0];
  if (point === 'gameplay:tick') return [num('now'), 0, 0, 0];
  if (point === 'event:survival:damage') return [num('amount'), num('health'), 0, 0];
  return [num('x'), num('y'), num('z'), num('block')];
}

/** 白名单外 import → 拒绝实例化，错误信息含具体名字便于插件作者排查 */
export function assertWhitelistedImports(
  imports: readonly { module: string; name: string; kind: string }[],
): void {
  for (const imp of imports) {
    if (imp.module !== HOST_MODULE || !(imp.name in HOST_IMPORT_PERMISSIONS)) {
      throw new Error(`[wasm-host] 不允许的宿主导入 ${imp.module}.${imp.name}`);
    }
    if (imp.kind !== 'function') {
      throw new Error(`[wasm-host] 宿主导入 ${imp.name} 必须是函数（实际 ${imp.kind}）`);
    }
  }
}

/** 根据插件声明的 hostImports 与权限，给出每个导入的实际状态 */
export interface ImportGrant {
  name: string;
  granted: boolean;
  reason?: 'undeclared' | 'permission';
  permission?: PluginPermission;
}

export function planGrants(
  declared: readonly string[] | undefined,
  permissions: readonly PluginPermission[],
): ImportGrant[] {
  const perms = new Set(permissions);
  return HOST_IMPORT_NAMES.map((name) => {
    const permission = HOST_IMPORT_PERMISSIONS[name];
    if (declared && !declared.includes(name)) {
      return { name, granted: false, reason: 'undeclared' as const, permission };
    }
    if (permission && !perms.has(permission)) {
      return { name, granted: false, reason: 'permission' as const, permission };
    }
    return { name, granted: true, permission };
  });
}

/** 抛错桩：保留 import 键但调用即失败，避免插件借「未声明能力」静默做事 */
export function denyImport(name: string, grant: ImportGrant): (...args: unknown[]) => never {
  const why = grant.reason === 'permission'
    ? `缺少权限 ${grant.permission}（在 manifest.permissions 中声明）`
    : '未在 carrier.hostImports 中声明';
  return () => { throw new Error(`[wasm-host] ${name} 不可用：${why}`); };
}

// ---- 线性内存 UTF-8 编解码（带边界检查）----

const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { fatal: false }) : null;

const view = (memory: WebAssembly.Memory, ptr: number, len: number): Uint8Array => {
  if (!Number.isInteger(ptr) || !Number.isInteger(len) || ptr < 0 || len < 0) {
    throw new Error('[wasm-host] 非法内存参数');
  }
  const end = ptr + len;
  if (!Number.isSafeInteger(end) || end > memory.buffer.byteLength) {
    throw new Error(`[wasm-host] 内存越界：ptr=${ptr} len=${len} 容量=${memory.buffer.byteLength}`);
  }
  return new Uint8Array(memory.buffer, ptr, len);
};

export function readUtf8(memory: WebAssembly.Memory, ptr: number, len: number): string {
  const bytes = view(memory, ptr, len);
  if (!decoder) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
  }
  return decoder.decode(bytes);
}

export function writeUtf8(memory: WebAssembly.Memory, ptr: number, cap: number, text: string): number {
  if (!encoder) {
    const bytes = new Uint8Array(cap);
    for (let i = 0; i < cap && i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    view(memory, ptr, cap).set(bytes);
    return Math.min(cap, text.length);
  }
  const bytes = encoder.encode(text);
  const n = Math.min(cap, bytes.length);
  view(memory, ptr, n).set(bytes.subarray(0, n));
  return n;
}

/** 把任意 payload 安全转成插件可读的短文本（扩展点回调用，防止超大对象撑爆内存） */
export function payloadToText(payload: unknown, maxChars = 512): string {
  let text: string;
  try {
    text = typeof payload === 'string' ? payload : JSON.stringify(payload) ?? String(payload);
  } catch {
    text = String(payload);
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
