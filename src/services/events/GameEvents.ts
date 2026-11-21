import type { BlockId, Vec3Like } from '../../core/types';

/**
 * 游戏事件表：事件服务的唯一契约。
 *
 * 扩展方可在任意 .d.ts / .ts 里用「声明合并」追加自定义事件：
 *
 * ```ts
 * declare module './services/events/GameEvents' {
 *   interface GameEvents { 'my:thing': { value: number } }
 * }
 * ```
 *
 * 所有 gameplay 钩子都经过事件服务派发，插件不得直接调用彼此的内部方法。
 */
export interface GameEvents {
  'block:break': { x: number; y: number; z: number; block: BlockId };
  'block:place': { x: number; y: number; z: number; block: BlockId };
  'block:ignite': { x: number; y: number; z: number };
  /** 生态随机刻改变了方块（生长 / 蔓延 / 枯萎 / 成熟 / 采集），供存档与插件观测 */
  'plant:grow': {
    x: number; y: number; z: number; block: BlockId;
    kind: 'grow' | 'spread' | 'decay' | 'ripen' | 'harvest';
  };
  /** 植物蓄能到开花阈值 / 被采集：用于粒子、音效与生态反馈 */
  'plant:bloom': { x: number; y: number; z: number; block: BlockId; energy: number };
  'explosion': { center: Vec3Like; radius: number };
  'player:spawn': { position: Vec3Like };
  'player:move': { position: Vec3Like };
  'player:camera': { mode: number };
  /** 玩家被实体方块包围后完成脱困（AABB 推出） */
  'player:unstuck': { position: Vec3Like; distance: number };
  'hotbar:select': { index: number; block: BlockId };
  'time:change': { dayTime: number; daylight: number };
  'chunk:generated': { cx: number; cz: number };
  'chunk:meshed': { cx: number; cz: number };
  /** v1.2.0 新增：区块卸载（内存回收可观测） */
  'chunk:unloaded': { cx: number; cz: number };
  /** v1.2.0 新增：生成队列触发背压 */
  'stream:backpressure': { dirty: number };
  'entity:spawn': { type: string; id: number };
  'entity:despawn': { type: string; id: number };
  'entity:dead': { type: string; id: number };
  'entity:hurt': { type: string; id: number; hp: number; maxHp: number };
  /** 生存模式：任何来源的掉血 */
  'survival:damage': { amount: number; health: number; cause: string };
  /** 生存模式：死亡 */
  'survival:death': { cause: string; itemsLost?: number; keepInventory?: boolean };
  /** 生存模式：重生 */
  'survival:respawn': { position: Vec3Like };
  /** 生存模式：进食 */
  'survival:eat': { item: string; hunger: number };
  /** 生存模式：背包变化（kind: block/item） */
  'inventory:change': { key: string; count: number };
  /** 装备穿戴 / 耐久变化（slot 为 null 表示背包装备） */
  'equipment:change': { slot: string | null; id: string | null; durability: number };
  /** 装备耐久耗尽损坏 */
  'equipment:broken': { id: string; source: 'held' | 'armor' };
  /** 生存模式：空手右键工作台，请求打开合成界面 */
  'crafting:open': { x: number; y: number; z: number };
  /** 合成完成（配方 id / 产物材料 / 数量） */
  'crafting:crafted': { recipe: string; result: string; count: number };
  /** 生存模式：空手右键熔炉，请求打开烧炼界面 */
  'furnace:open': { x: number; y: number; z: number };
  /** 一次烧炼完成 */
  'smelting:done': { recipe: string; result: string };
  'game:start': { seed: number };
  'game:pause': { paused: boolean };
  'save:done': { bytes: number };
  /** v1.2.0 新增：服务与插件生命周期 */
  'service:ready': { services: string[] };
  'plugin:registered': { id: string };
  'plugin:enabled': { id: string };
  'plugin:disabled': { id: string };
  'plugin:error': { id: string; error: string };
  /** v1.5.0：插件热重载完成 */
  'plugin:reloaded': { id: string };
  /** v1.5.0：WASM 内核通过自检并接管噪声计算 */
  'wasm:ready': { abi: number; bytes: number; sha256: string; samples: number };
  /** v1.5.0：WASM 失败已回退纯 JS */
  'wasm:fallback': { reason: string; code?: string };
}
