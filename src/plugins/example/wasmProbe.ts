import type { PluginDefinition } from '../../services/plugins';

/**
 * 插件开发示例（不默认启用）：演示 WASM 扩展点与插件体系 v2。
 *
 * 把本模块导出的定义注册进插件服务后启用即可：
 *   CraftAPI.plugins.register(wasmProbePlugin);
 *   await CraftAPI.plugins.enable('example:wasm-probe');
 *
 * 演示点：依赖版本约束（core:wasm-monitor@^1.0.0）、可选依赖不阻断、
 * wasm:use 权限、capabilities、config、插件私有存储与 onDispose 清理。
 */
export const wasmProbePlugin: PluginDefinition = {
  manifest: {
    id: 'example:wasm-probe',
    version: '0.1.0',
    description: '演示 WASM 扩展点与插件体系 v2（不默认启用）',
    apiVersion: '^2.0.0',
    dependencies: ['core:wasm-monitor@^1.0.0'],
    optionalDependencies: ['example:not-installed'],
    permissions: ['wasm:use'],
    capabilities: ['wasm.probe'],
    priority: -10,
    timeoutMs: 2000,
    config: { probe: true },
  },
  setup(ctx) {
    const { api, storage, log, onDispose, config } = ctx;
    log('WASM 状态', api.wasm.status(), '插件 API', ctx.apiVersion);

    if (config.probe && api.wasm.status() === 'ready') {
      // 内置内核的整数原语：AO 四角亮度档位
      const ao = api.wasm.call('mc_ao', 1, 0, 1);
      storage.set('lastAO', ao);
      // 自定义 WASM 模块示例（bytes 为 Uint8Array / ArrayBuffer / base64）：
      //   api.wasm.registerModule('example:math', bytes);
      //   const v = api.wasm.callModule('example:math', 'add', 2, 3);
      log('WASM 自检样本', api.wasm.stats().selfCheckSamples);
    }
    onDispose(() => {
      api.wasm.unregisterModule('example:math');
    });
  },
};
