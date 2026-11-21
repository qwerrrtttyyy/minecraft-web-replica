import type { PluginDefinition } from '../../services/plugins';
import { EXTENSION_POINTS } from '../../services/plugins/extensions';
import { EquipmentState } from '../../player/equipmentState';

/**
 * 内置插件：护甲（armor）。
 *
 * v2.0 路线图「护甲以插件形式实现，不新增 main.ts 事件接线」的落地：
 *  - 经管道扩展点 combat:damage-incoming 做减伤（每护甲点 4%，20 点封顶 80%）；
 *  - 订阅 survival:damage 在受击后扣甲耐久（沿用 WIP 快照 8281895 的 EquipmentState）；
 *  - 装备状态经 ctx.storage 持久化（插件私有，卸载即撤销，核心存档不含装备字段）。
 * 卸载本插件后伤害路径与未安装时完全一致（核心不注册任何 combat 处理器）。
 */
export const armorPlugin: PluginDefinition = {
  manifest: {
    id: 'core:armor',
    version: '1.0.0',
    description: '护甲系统：4 甲槽穿戴、按护甲点减伤、受击扣甲耐久',
    permissions: [],
  },
  setup(ctx) {
    const equipment = new EquipmentState(ctx.events);

    // 持久化：恢复在 setup 期完成，保存走 storage 的同步写
    const saved = ctx.storage.get('equipment') as Parameters<EquipmentState['restore']>[0] | undefined;
    equipment.restore(saved);
    ctx.onDispose(() => {
      ctx.storage.set('equipment', equipment.serialize());
    });
    ctx.events.on('save:done', () => ctx.storage.set('equipment', equipment.serialize()));

    // 减伤：管道语义，读当前护甲点数改写 amount
    ctx.extensions.register(EXTENSION_POINTS.COMBAT_DAMAGE_INCOMING, 'core:armor', (payload: { amount: number }) => {
      const points = Math.min(20, equipment.armorPoints);
      if (points <= 0) return undefined;
      return { amount: payload.amount * (1 - 0.04 * points) };
    });

    // 受击后每个甲槽扣 1 点耐久
    ctx.events.on('survival:damage', () => {
      equipment.damageArmor(1);
    });
  },
};
