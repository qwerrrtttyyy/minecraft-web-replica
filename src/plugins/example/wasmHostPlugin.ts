/**
 * WASM host 插件示例（v1.6.0，不默认启用）。
 *
 * 演示「完整宿主导入插件」：一个真实编译的 wasm 模块通过受控白名单主动调用引擎——
 * 订阅 worldgen:column 在区块生成时放方块、订阅 gameplay:tick 累加计数写入私有存储。
 *
 * 控制台试玩：
 *   CraftAPI.plugins.register(wasmHostPlugin);
 *   await CraftAPI.plugins.enable('example:wasm-host');
 *   CraftAPI.extensions.list();          // 看到 wasm 插件注册的扩展点
 *
 * 二进制由 native/host_plugin_fixture.c 编译，base64 内联在 hostPluginFixtureBinary.ts，
 * 与 test/plugin-carrier-check.cjs 共用同一个 fixture。
 */
import type { PluginDefinition } from '../../services/plugins';
import { HOST_PLUGIN_BASE64 } from './hostPluginFixtureBinary';

export const wasmHostPlugin: PluginDefinition = {
  manifest: {
    id: 'example:wasm-host',
    version: '1.0.0',
    description: '示例：WASM host 插件订阅世界生成与 tick 扩展点（不默认启用）',
    apiVersion: '^2.1.0',
    permissions: ['world:write'],
    capabilities: ['wasm.host-demo'],
    priority: -20,
  },
  carrier: {
    kind: 'wasm:host',
    bytes: HOST_PLUGIN_BASE64,
    abi: 1,
    hostImports: ['mc_log', 'mc_ext_register', 'mc_world_set', 'mc_rand', 'mc_storage_set'],
  },
};
