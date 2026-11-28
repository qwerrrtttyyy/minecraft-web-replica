import { CHUNK_SIZE } from '../../core/types';
import type { PluginDefinition } from '../../services/plugins';
import {
  EXPANSION_PLANT_COUNT,
  EXPANSION_PLANTS,
  EXPANSION_PLUGIN_ID,
  EXPANSION_RULES,
  expansionBlockInput,
  planSpawn,
  SPAWN_ROLL_CEILING,
  spawnHash,
} from './botanyContent';

/**
 * 内置插件：植物生态扩展包（v1.4.3）。
 *
 * 这是「插件驱动扩展」的示范：6 种植物、3 条生态规则、自然生成钩子
 * 全部通过公开 API 注册，核心代码只提供一个兜底分派点，没有为任何
 * 新植物加一条 if 分支。
 *
 * 权限按最小原则声明：
 * - blocks:register  注册纹理与方块
 * - botany:register  注册植物特性与生态规则
 * - world:write      在 chunk:generated 时经 decorate 补种（生成期写入）
 *
 * 停用 / 卸载时：EventChannel 自动撤销订阅，onDispose 注销规则与特性，
 * 方块与纹理保留（BlockRegistry / TextureAtlas 不支持反注册），植物退回
 * 静态装饰，不会留下仍在运行的生态逻辑。
 *
 * 控制台可试玩：
 * ```js
 * CraftAPI.plugins.disable('core:botany-expansion'); // 规则立即失效
 * CraftAPI.plugins.enable('core:botany-expansion');  // 幂等重新启用
 * CraftAPI.botany.listRules();                       // 查看已注册规则
 * ```
 */
export const botanyExpansionPlugin: PluginDefinition = {
  manifest: {
    id: EXPANSION_PLUGIN_ID,
    version: '1.0.0',
    description: '6 种植物 + 3 条生态规则 + 按群系自然生成，全部经 botany 扩展点注册',
    permissions: ['blocks:register', 'botany:register', 'world:write'],
  },
  setup(ctx) {
    const api = ctx.api;

    // 1) 纹理与方块：registerTile 同名覆盖、方块按名字判重，保证 disable→enable 幂等
    for (const p of EXPANSION_PLANTS) {
      api.registerTile(p.name, p.paint);
      if (!api.blocks.byNameGet(p.name)) api.registerBlock(expansionBlockInput(p));
    }

    // 2) 特性与规则：先按 owner 清一遍，重复启用不会触发「规则重复注册」
    api.botany.unregisterRules(EXPANSION_PLUGIN_ID);
    for (const p of EXPANSION_PLANTS) api.botany.registerPlant(p.name, p.trait);
    for (const rule of EXPANSION_RULES) api.botany.registerRule(rule);

    // 3) 自然生成：DefaultGenerator 在构造时就把 BIOME_PROFILES 编译成了 id 表，
    //    运行时新方块进不去那张表，因此改由插件订阅 chunk:generated 按群系补种。
    //    坐标哈希只依赖 seed + 世界坐标，区块生成顺序不影响结果。
    const waterId = api.blocks.byNameGet('water')?.id ?? 0;
    ctx.events.on('chunk:generated', ({ cx, cz }) => {
      const seed = api.world.seed();
      const x0 = cx * CHUNK_SIZE;
      const z0 = cz * CHUNK_SIZE;
      for (let dz = 0; dz < CHUNK_SIZE; dz++) {
        for (let dx = 0; dx < CHUNK_SIZE; dx++) {
          const x = x0 + dx;
          const z = z0 + dz;
          // 先做一次廉价哈希过滤：绝大多数列只花一次整数运算，
          // 避免 256 列 × 多次世界查询拖慢区块生成、让 dirty 队列无法收敛。
          const roll = spawnHash(x, z, seed);
          if (roll >= SPAWN_ROLL_CEILING) continue;

          const biome = api.world.biomeAt(x, z);
          const y = api.world.surfaceHeight(x, z) + 1;
          const current = api.world.getBlock(x, y, z);
          // 水生植物可以占据水格（与内置海草 / 海带一致），其余只落空气格
          if (current !== 0 && !api.blocks.get(current).liquid) continue;

          const nearWater =
            waterId !== 0 &&
            (api.world.getBlock(x - 1, y, z) === waterId ||
              api.world.getBlock(x + 1, y, z) === waterId ||
              api.world.getBlock(x, y, z - 1) === waterId ||
              api.world.getBlock(x, y, z + 1) === waterId);
          const name = planSpawn(biome, roll, nearWater);
          if (!name) continue;

          const def = api.blocks.byNameGet(name);
          if (!def) continue;
          const below = api.blocks.get(api.world.getBlock(x, y - 1, z));
          if (!below.solid && !below.liquid) continue;
          // 生成期写入：不记录存档差分、不标脏、不触发光照增量，
          // 网格由 ChunkManager 在本次生成后统一派发。
          api.world.decorate(x, y, z, def.id);
        }
      }
    });

    ctx.onDispose(() => {
      api.botany.unregisterRules(EXPANSION_PLUGIN_ID);
      for (const p of EXPANSION_PLANTS) api.botany.unregisterPlant(p.name);
      ctx.log('植物扩展包已停用：规则与特性已注销，方块保留为静态装饰');
    });

    ctx.log('植物扩展包已启用', {
      plants: EXPANSION_PLANT_COUNT,
      rules: api.botany.listRules().length,
    });
  },
};
