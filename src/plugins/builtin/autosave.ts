import { TOKENS } from '../../services';
import type { PluginDefinition } from '../../services/plugins';
import { AIR } from '../../world/blocks';

/**
 * 内置插件：存档脏标记追踪。
 *
 * 原本这些 `events.on(...)` 散落在 boot() 的 500 多行里；现在它们有身份、
 * 可停用、卸载时订阅自动撤销，且完全不接触 main.ts 的局部状态。
 */
export const autosavePlugin: PluginDefinition = {
  manifest: {
    id: 'core:autosave',
    version: '1.0.0',
    description: '监听世界/背包变化，标记存档待写；死亡时立即落盘',
    permissions: [],
  },
  setup(ctx) {
    const d = ctx.services.require(TOKENS.BuiltinDeps);
    const dirtyEvents = [
      'block:break',
      'block:place',
      'block:ignite',
      'player:move',
      'inventory:change',
      'hotbar:select',
      'explosion',
    ] as const;
    for (const type of dirtyEvents) {
      // 各事件 payload 不同，统一用无参回调即可（TS 允许少参数赋值）
      ctx.events.on(type, () => d.markDirty());
    }
    ctx.events.on('survival:death', () => d.saveNow());
    ctx.events.on('survival:respawn', () => d.markDirty());
    // 演示：插件可通过服务拿到只读 API，无需 import 引擎内部模块
    ctx.log('存档追踪已启动', { air: AIR, apiVersion: ctx.api.version });
  },
};
