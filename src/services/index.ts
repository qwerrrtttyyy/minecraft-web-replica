import { ServiceContainer, token } from './ServiceContainer';
import { EventService } from './events';
import { PluginService } from './plugins';
import type { CraftAPI } from '../api/CraftAPI';
import type { BuiltinDeps } from '../plugins/builtin/deps';

/** 全局服务令牌：组装根 provide，插件与门面 require */
export const TOKENS = {
  Events: token<EventService>('events'),
  Plugins: token<PluginService>('plugins'),
  CraftAPI: token<CraftAPI>('api'),
  BuiltinDeps: token<BuiltinDeps>('builtin-deps'),
};

export interface Services {
  container: ServiceContainer;
  events: EventService;
  plugins: PluginService;
}

/**
 * 创建服务层。组装根（main.ts）只负责调用它、注入业务依赖、启动插件；
 * 业务模块不再自行 new EventBus，也不再互相传裸闭包。
 */
export function createServices(): Services {
  const container = new ServiceContainer();
  const events = container.provide(TOKENS.Events, new EventService());
  // api getter 延迟到 CraftAPI 注入容器之后才被 enable() 调用
  const plugins = container.provide(
    TOKENS.Plugins,
    new PluginService(events, container, () => container.require(TOKENS.CraftAPI)),
  );
  return { container, events, plugins };
}

export { ServiceContainer, token } from './ServiceContainer';
export type { ServiceToken, Disposable } from './ServiceContainer';
export { EventService, EventService as EventBus } from './events';
export { PluginService, scopeAPI } from './plugins';
export type { PluginDefinition, PluginManifest, PluginContext, PluginRecord, PluginState } from './plugins';
