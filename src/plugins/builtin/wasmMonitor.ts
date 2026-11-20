import type { PluginDefinition } from '../../services/plugins';

/**
 * 内置插件：WASM 生命周期观测器。
 *
 * 同时演示插件体系 v2 的新能力：apiVersion 兼容范围、capabilities 能力声明、
 * priority 启用顺序、timeoutMs、config 默认配置、命名空间 storage、
 * 插件私有 provide/require 服务（卸载自动回收）。
 * 全程只读，不申请任何写权限。
 */
export const wasmMonitorPlugin: PluginDefinition = {
  manifest: {
    id: 'core:wasm-monitor',
    version: '1.0.0',
    description: '观测 WASM 内核生命周期，把状态与回退原因写入插件私有存储',
    apiVersion: '^2.0.0',
    capabilities: ['wasm.monitor', 'plugin.v2-demo'],
    priority: 20,
    timeoutMs: 3000,
    config: { verbose: false },
    permissions: [],
  },
  setup(ctx) {
    const { events, api, storage, config, log } = ctx;
    const record = (status: string, detail: string): void => {
      storage.set('lastStatus', status);
      storage.set('lastDetail', detail);
      storage.set('lastAt', Date.now());
      storage.set('observations', (storage.get<number>('observations', 0) ?? 0) + 1);
      if (config.verbose) log('WASM', status, detail);
    };

    record(api.wasm.status(), 'setup');
    events.on('wasm:ready', (p) => {
      record('ready', `abi=${p.abi} bytes=${p.bytes} samples=${p.samples}`);
    });
    events.on('wasm:fallback', (p) => {
      record('fallback', `${p.code ?? 'runtime'}: ${p.reason}`);
    });

    // 插件私有服务：其它插件可通过 ctx.services.require(TOKENS...) 之外的方式
    // 在本插件作用域内取用；停用 / 卸载时注册表自动清空。
    ctx.provide('lastStatus', () => storage.get<string>('lastStatus', 'unknown'));
    ctx.onDispose(() => {
      storage.set('lastStatus', api.wasm.status());
    });
  },
};
