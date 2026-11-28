import { ITEMS } from '../../player/survival';
import { TOKENS } from '../../services';
import type { PluginDefinition } from '../../services/plugins';
import { AIR } from '../../world/blocks';

/**
 * 内置插件：事件 → HUD / 音效 / 触感反馈。
 *
 * 这是 v1.2.0 架构革新最直观的收益：8 个事件订阅从 800 行的 boot() 里剥离出来，
 * 变成可独立启用/停用、可单测、卸载即清理的插件。
 */
export const hudFeedbackPlugin: PluginDefinition = {
  manifest: {
    id: 'core:hud-feedback',
    version: '1.0.0',
    description: '把游戏事件映射为 HUD 更新、音效与移动端触感',
    permissions: [],
  },
  setup(ctx) {
    const d = ctx.services.require(TOKENS.BuiltinDeps);

    ctx.events.on('hotbar:select', ({ index, block }) => {
      d.hud.updateHotbar();
      d.player.setHeldStack(d.hotbar.slots[index]);
      d.syncUseMode();
      if (block !== AIR) {
        d.hud.showItemName(d.registry.get(block).label);
      } else {
        const s = d.hotbar.slots[index];
        if (s && s.kind === 'item') d.hud.showItemName(ITEMS[s.id as string]?.label ?? '');
      }
    });

    ctx.events.on('block:break', () => d.buzz(10));
    ctx.events.on('block:place', () => d.buzz(10));

    ctx.events.on('inventory:change', ({ key, count }) => {
      if (count <= 0) {
        const stack = d.parseKey(key);
        let clearedCurrent = false;
        d.hotbar.slots = d.hotbar.slots.map((s, i) => {
          if (s && s.kind === stack.kind && s.id === stack.id) {
            if (i === d.hotbar.index) clearedCurrent = true;
            return null;
          }
          return s;
        });
        if (clearedCurrent) {
          d.player.setHeldStack(null);
          d.syncUseMode();
        }
      }
      if (count > 0 && d.survival.isSurvival) {
        const stack = d.parseKey(key);
        const exists = d.hotbar.slots.some((s) => s && s.kind === stack.kind && s.id === stack.id);
        if (!exists) {
          const empty = d.hotbar.slots.indexOf(null);
          if (empty >= 0) d.hotbar.slots[empty] = stack;
        }
      }
      d.hud.updateHotbar();
    });

    ctx.events.on('save:done', () => {
      d.hud.noteSaved(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
    });

    ctx.events.on('survival:damage', () => {
      d.hud.flashHurt();
      d.sound.hurt();
      d.player.shake(0.22);
      d.buzz(45);
    });

    ctx.events.on('survival:death', ({ cause }) => {
      d.hud.showDeath(cause);
      d.buzz(90);
      d.onDeath(cause);
    });

    ctx.events.on('entity:hurt', () => d.buzz(12));
  },
};
