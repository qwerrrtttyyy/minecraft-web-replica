import type { EventChannel } from '../events/EventChannel';
import type { ServiceContainer } from '../ServiceContainer';
import type { CraftAPI } from '../../api/CraftAPI';

/** 插件可申请的写权限；未申请的能力会被 scopeAPI 拦截并抛错 */
export type PluginPermission =
  | 'world:write'
  | 'player:write'
  | 'save:write'
  | 'api:emit'
  | 'blocks:register'
  | 'botany:register';

export interface PluginManifest {
  /** 全局唯一 id，建议 `作者:名称`（如 `core:autosave`） */
  id: string;
  version?: string;
  description?: string;
  /** 依赖的插件 id，enable 时递归先启用，循环依赖会被拦截 */
  dependencies?: string[];
  /** 默认只读；需要写能力必须显式声明 */
  permissions?: PluginPermission[];
}

export interface PluginContext {
  readonly id: string;
  /** 命名空间事件通道：插件卸载时自动撤销全部订阅 */
  readonly events: EventChannel;
  /** 服务容器：可 require 组装根注入的任何服务 */
  readonly services: ServiceContainer;
  /** 按 permissions 裁剪过的公开 API 视图 */
  readonly api: CraftAPI;
  readonly log: (...args: unknown[]) => void;
  /** 注册停用钩子（与 setup 返回 teardown 等价，可多次调用） */
  onDispose(fn: () => void): void;
}

export interface PluginDefinition {
  manifest: PluginManifest;
  /** 返回 teardown，或用 ctx.onDispose 注册；支持异步初始化 */
  setup(ctx: PluginContext): void | (() => void) | Promise<void | (() => void)>;
}

export type PluginState = 'registered' | 'enabled' | 'disabled' | 'failed';

export interface PluginRecord {
  manifest: PluginManifest;
  state: PluginState;
  error?: string;
}
