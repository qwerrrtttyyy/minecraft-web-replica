import type { SoundEngine } from '../../audio/sound';
import type { HotbarState, Player } from '../../player/player';
import type { Stack, SurvivalState } from '../../player/survival';
import type { HUD } from '../../ui/hud';
import type { BlockRegistry } from '../../world/blocks';

/**
 * 内置插件的运行期依赖集合。
 *
 * 组装根把 boot() 中原本散落的闭包变量一次性打包注册进服务容器
 * （TOKENS.BuiltinDeps），插件只依赖这个稳定接口，不再依赖 main.ts 的作用域。
 */
export interface BuiltinDeps {
  hud: HUD;
  sound: SoundEngine;
  player: Player;
  survival: SurvivalState;
  registry: BlockRegistry;
  hotbar: HotbarState;
  buzz(ms: number): void;
  parseKey(key: string): Stack;
  syncUseMode(): void;
  markDirty(): void;
  saveNow(): void;
  /** 状态机钩子：死亡时由插件回调组装根切换 mode / 释放指针锁 */
  onDeath(cause: string): void;
}
