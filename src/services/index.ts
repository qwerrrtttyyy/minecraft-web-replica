import type { CraftAPI } from '../api/CraftAPI';
import type { BuiltinDeps } from '../plugins/builtin/deps';
import type { WasmRuntime } from '../wasm/runtime';
import { EventService } from './events';
import { PluginService, type PluginServiceOptions } from './plugins';
import type { WasmBytes } from './plugins/carriers/types';
import { ExtensionRegistry } from './plugins/extensions';
import type { PluginSaveBag } from './plugins/saveBag';
import { ServiceContainer, token } from './ServiceContainer';
import type { PanelHost } from './ui/PanelHost';

/** 全局服务令牌：组装根 provide，插件与门面 require */
export const TOKENS = {
  Events: token<EventService>('events'),
  Plugins: token<PluginService>('plugins'),
  Extensions: token<ExtensionRegistry>('extensions'),
  CraftAPI: token<CraftAPI>('api'),
  BuiltinDeps: token<BuiltinDeps>('builtin-deps'),
  /** v1.5.0：WASM 运行时（由组装根在世界生成前创建并注入） */
  Wasm: token<WasmRuntime>('wasm'),
  /** A2-5：按世界存档的插件数据袋（SaveData.plugins） */
  PluginSaveBag: token<PluginSaveBag>('plugin-save-bag'),
  /** A2-5：插件 UI 宿主（暂停菜单面板 / HUD 锚点 / 快捷栏装饰） */
  PanelHost: token<PanelHost>('panel-host'),
};

export interface Services {
  container: ServiceContainer;
  events: EventService;
  plugins: PluginService;
  extensions: ExtensionRegistry;
}

/**
 * 创建服务层。组装根（main.ts）只负责调用它、注入业务依赖、启动插件；
 * 业务模块不再自行 new EventBus，也不再互相传裸闭包。
 *
 * v1.6.0：扩展注册表在此时创建并与 PluginService 共享；WASM 载体桥接用「延迟代理」，
 * 因为 WasmRuntime 由组装根稍后（世界生成前）才注入容器，而 enable() 更晚才调用。
 */
export function createServices(options?: PluginServiceOptions): Services {
  const container = new ServiceContainer();
  const events = container.provide(TOKENS.Events, new EventService());
  const extensions = container.provide(TOKENS.Extensions, new ExtensionRegistry());
  const wasmHost = {
    registerModule: (id: string, bytes: WasmBytes) => container.require(TOKENS.Wasm).registerModule(id, bytes),
    unregisterModule: (id: string) => container.require(TOKENS.Wasm).unregisterModule(id),
    callKernel: (name: string, args: number[]) => container.require(TOKENS.Wasm).callKernel(name, args),
  };
  // api getter 延迟到 CraftAPI 注入容器之后才被 enable() 调用
  const plugins = container.provide(
    TOKENS.Plugins,
    new PluginService(events, container, () => container.require(TOKENS.CraftAPI), {
      ...options,
      extensions,
      wasmHost,
    }),
  );
  return { container, events, plugins, extensions };
}

export { EventService, EventService as EventBus } from './events';
export type {
  EmitResult,
  ExtensionInfo,
  ExtensionStats,
  PluginCarrier,
  PluginContext,
  PluginDefinition,
  PluginManifest,
  PluginPermission,
  PluginRecord,
  PluginServiceOptions,
  PluginState,
  PluginStats,
  WasmBytes,
  WasmHostCarrier,
  WasmModuleCarrier,
  WorldgenColumnPayload,
} from './plugins';
export { EXTENSION_POINTS, ExtensionRegistry, PluginService, scopeAPI } from './plugins';
export type { Disposable, ServiceToken } from './ServiceContainer';
export { ServiceContainer, token } from './ServiceContainer';
