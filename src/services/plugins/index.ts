export { PluginService, scopeAPI } from './PluginService';
export type { PluginServiceOptions } from './PluginService';
export type {
  PluginManifest,
  PluginDefinition,
  PluginContext,
  PluginPermission,
  PluginRecord,
  PluginState,
  PluginStats,
} from './PluginContext';
export {
  parseVersion, compareVersions, parseRange, satisfies, parseDependency,
} from './semver';
export type {
  Version, Comparator, ComparatorOp, VersionRange, DependencySpec,
} from './semver';
export { loadPluginDefinition, PluginLoadError } from './loader';
export type { PluginSourceOptions } from './loader';
export {
  MemoryPluginStorageProvider, LocalStoragePluginStorageProvider,
  createPluginStorage, defaultPluginStorageProvider,
} from './storage';
export type { PluginStorage, PluginStorageProvider } from './storage';
// v1.6.0：扩展点注册表
export {
  ExtensionRegistry, EXTENSION_POINTS,
} from './extensions';
export type {
  ExtensionInfo, ExtensionStats, EmitResult,
  ExtensionHandler, WorldgenColumnPayload,
} from './extensions';
// v1.6.0：插件载体（js / wasm:module / wasm:host）
export type {
  PluginCarrier, WasmModuleCarrier, WasmHostCarrier, WasmBytes,
  CarrierInfo, CarrierHost, CarrierActivation,
} from './carriers/types';
