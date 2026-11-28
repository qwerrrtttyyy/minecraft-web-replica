// v1.6.0：插件载体（js / wasm:module / wasm:host）
export type {
  CarrierActivation,
  CarrierHost,
  CarrierInfo,
  PluginCarrier,
  WasmBytes,
  WasmHostCarrier,
  WasmModuleCarrier,
} from './carriers/types';
export type { EmitResult, ExtensionHandler, ExtensionInfo, ExtensionStats, WorldgenColumnPayload } from './extensions';
// v1.6.0：扩展点注册表
export { EXTENSION_POINTS, ExtensionRegistry } from './extensions';
export type { PluginSourceOptions } from './loader';
export { loadPluginDefinition, PluginLoadError } from './loader';
export type {
  PluginContext,
  PluginDefinition,
  PluginManifest,
  PluginPermission,
  PluginRecord,
  PluginState,
  PluginStats,
} from './PluginContext';
export type { PluginServiceOptions } from './PluginService';
export { PluginService, scopeAPI } from './PluginService';
export type { Comparator, ComparatorOp, DependencySpec, Version, VersionRange } from './semver';
export { compareVersions, parseDependency, parseRange, parseVersion, satisfies } from './semver';
export type { PluginStorage, PluginStorageProvider } from './storage';
export {
  createPluginStorage,
  defaultPluginStorageProvider,
  LocalStoragePluginStorageProvider,
  MemoryPluginStorageProvider,
} from './storage';
