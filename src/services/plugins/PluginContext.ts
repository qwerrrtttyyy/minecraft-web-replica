import type { EventChannel } from '../events/EventChannel';
import type { ServiceContainer } from '../ServiceContainer';
import type { CraftAPI } from '../../api/CraftAPI';
import type { PluginStorage } from './storage';
import type { ExtensionRegistry } from './extensions';
import type { CarrierInfo } from './carriers/types';

/** 插件可申请的写权限；未申请的能力会被 scopeAPI 拦截并抛错 */
export type PluginPermission =
  | 'world:write'
  | 'player:write'
  | 'save:write'
  | 'api:emit'
  | 'blocks:register'
  | 'botany:register'
  /** v1.4.3：调整时间 / 设置（旧权限，保留兼容） */
  | 'time:write'
  | 'settings:write'
  /** v1.5.0：调用 WASM 内核 / 注册自定义 WASM 模块 / 切换 WASM 开关 */
  | 'wasm:use'
  /** v1.5.0：注册、启用、停用、卸载、重载其他插件（默认禁止，防止插件互相劫持） */
  | 'plugins:manage'
  /** v1.6.0：WASM host 插件经 mc_ext_register 桥接游戏事件订阅 */
  | 'events:subscribe';

/** 全部合法权限名（register 期校验） */
export const PLUGIN_PERMISSIONS: readonly PluginPermission[] = [
  'world:write', 'player:write', 'save:write', 'api:emit', 'blocks:register', 'botany:register',
  'time:write', 'settings:write', 'wasm:use', 'plugins:manage', 'events:subscribe',
];

export interface PluginManifest {
  /** 全局唯一 id，建议 `作者:名称`（如 `core:autosave`） */
  id: string;
  version?: string;
  description?: string;
  /** 依赖的插件 id，支持 `id@^1.2.0` 版本约束；enable 时递归先启用，循环依赖会被拦截 */
  dependencies?: string[];
  /** v1.5.0：可选依赖，缺失 / 启用失败只记录 warning，不阻断当前插件 */
  optionalDependencies?: string[];
  /** 默认只读；需要写能力必须显式声明 */
  permissions?: PluginPermission[];
  /** v1.5.0：声明兼容的引擎插件 API 版本范围（semver），不满足则拒绝注册 */
  apiVersion?: string;
  /** v1.5.0：声明式扩展点，供宿主 / 其它插件做能力发现 */
  capabilities?: string[];
  /** v1.5.0：启用优先级，数值大的先启用（enableAll 使用），默认 0 */
  priority?: number;
  /** v1.5.0：异步 setup 超时（毫秒），默认 5000，范围 50~120000 */
  timeoutMs?: number;
  /** v1.5.0：默认配置，与插件存储中的 config 合并后注入 ctx.config（只读） */
  config?: Readonly<Record<string, unknown>>;
}

export interface PluginContext {
  readonly id: string;
  /** 命名空间事件通道：插件卸载时自动撤销全部订阅 */
  readonly events: EventChannel;
  /** 服务容器：可 require 组装根注入的任何服务 */
  readonly services: ServiceContainer;
  /** 按 permissions 裁剪过的公开 API 视图 */
  readonly api: CraftAPI;
  /** v1.5.0：本插件的 manifest 快照（只读，避免插件运行时篡改权限） */
  readonly manifest: Readonly<PluginManifest>;
  /** v1.5.0：引擎插件 API 版本（用于插件自检兼容性） */
  readonly apiVersion: string;
  /** v1.5.0：manifest.config 与已保存配置合并后的只读视图 */
  readonly config: Readonly<Record<string, unknown>>;
  /** v1.5.0：命名空间持久化 KV；卸载后数据保留，其它插件不可见 */
  readonly storage: PluginStorage;
  readonly log: (...args: unknown[]) => void;
  /** 注册停用钩子（与 setup 返回 teardown 等价，可多次调用） */
  onDispose(fn: () => void): void;
  /** v1.5.0：插件私有服务注册表，卸载时自动清空；名字仅在本插件内可见 */
  provide<T>(name: string, value: T): T;
  require<T>(name: string): T;
  tryRequire<T>(name: string): T | undefined;
  /** v1.6.0：扩展点注册表（卸载时自动撤销本插件的全部注册） */
  readonly extensions: ExtensionRegistry;
}

/**
 * 插件定义（v1.6.0）：`setup`（JS）与 `carrier`（WASM）二选一。
 * 为保持 v1.2~v1.5 插件零改动，两者都做成可选，由 PluginService.register 校验至少其一。
 */
export interface PluginDefinition {
  manifest: PluginManifest;
  /** JS 载体：返回 teardown，或用 ctx.onDispose 注册；支持异步初始化 */
  setup?(ctx: PluginContext): void | (() => void) | Promise<void | (() => void)>;
  /** WASM 载体（wasm:module / wasm:host），v1.6.0 引入 */
  carrier?: import('./carriers/types').PluginCarrier;
}

export type PluginState = 'registered' | 'enabled' | 'disabled' | 'failed';

export interface PluginRecord {
  manifest: PluginManifest;
  state: PluginState;
  error?: string;
  /** v1.5.0：可选依赖缺失 / 失败等非致命问题 */
  warnings?: string[];
  /** v1.5.0：本次成功启用耗时（毫秒） */
  durationMs?: number;
  /** v1.6.0：实际激活的载体信息（js / wasm:module / wasm:host） */
  carrier?: CarrierInfo;
}

/** v1.5.0：插件服务统计 */
export interface PluginStats {
  total: number;
  registered: number;
  enabled: number;
  disabled: number;
  failed: number;
  capabilities: string[];
  totalEnableMs: number;
  warnings: number;
}
