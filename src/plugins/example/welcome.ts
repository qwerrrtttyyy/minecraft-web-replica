import type { PluginDefinition } from '../../services/plugins';

/**
 * 示例插件（默认不启用）：展示 v1.2.0 插件契约的完整用法。
 *
 * 控制台里可以这样启用：
 * ```js
 * CraftAPI.plugins.register(myPlugin);   // 也可 await import 后传入
 * await CraftAPI.plugins.enable('demo:welcome');
 * CraftAPI.plugins.disable('demo:welcome'); // 订阅与定时器自动清理
 * ```
 */
export const welcomePlugin: PluginDefinition = {
  manifest: {
    id: 'demo:welcome',
    version: '1.0.0',
    description: '注册一块发光石并在每次破坏方块时计数',
    permissions: ['blocks:register', 'api:emit'],
  },
  setup(ctx) {
    let broken = 0;
    // 1) 注册纹理与方块（需要 blocks:register 权限）
    ctx.api.registerTile('demo_glow', (setPixel, rng) => {
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const n = rng();
          setPixel(x, y, n > 0.5 ? 0xffe08a : 0xffb347);
        }
      }
    });
    const def = ctx.api.registerBlock({
      name: 'demo_glow',
      label: '示例发光石',
      shape: 'cube',
      solid: true,
      opaque: true,
      liquid: false,
      transparentPass: false,
      lightEmission: 14, // 0~15，0.8 会被 Uint8Array 截断成 0（不发光）
      hardness: 1.2,
      sound: 'stone',
      tiles: { top: 'demo_glow', bottom: 'demo_glow', side: 'demo_glow' },
    });

    // 2) 订阅事件（ctx.events 是命名空间通道，卸载时自动撤销）
    ctx.events.on('block:break', () => {
      broken++;
      ctx.log('已破坏方块数', broken);
    });

    // 3) 释放资源
    ctx.onDispose(() => ctx.log('示例插件已停用', { blockId: def.id, broken }));
    return () => ctx.log('teardown 也可以由 setup 返回');
  },
};
