import { mulberry32 } from '../core/types';
import { AIComponent, type EntityLike } from './AIComponent';
import { hashSeed } from './AIContext';
import { BehaviorTree } from './BehaviorTree';
import { NodeStatus, type TickContext } from './Node';

/** AI 服务：批量更新所有 AIComponent，支持分帧预算、启停与热重载。 */
export class AIService {
  private readonly trees = new Map<string, BehaviorTree>();
  private readonly components = new Map<EntityLike, AIComponent>();
  private enabled = true;
  /** 每帧 AI 更新预算（毫秒），超时下帧继续，不阻塞渲染。 */
  private readonly budgetMs = 2;

  constructor(
    private readonly world: {
      getBlock(x: number, y: number, z: number): number;
      isSolidAt(x: number, y: number, z: number): boolean;
      surfaceHeight(x: number, z: number): number;
    },
    private readonly events: { emit: (...args: any[]) => void },
    private api: unknown,
    private readonly seed: number,
  ) {}

  setApi(api: unknown): void {
    this.api = api;
  }

  /** 注册某种生物的行为树 JSON 配置。 */
  registerType(typeId: string, json: { root: any }): void {
    this.trees.set(typeId, BehaviorTree.fromJSON(json));
  }

  /** 为已存在的实体挂载 AI（spawn 时调用）。 */
  attach(entity: EntityLike, typeId: string): void {
    const tree = this.trees.get(typeId);
    if (!tree) return;
    const comp = new AIComponent(entity, tree, this.seed);
    this.components.set(entity, comp);
    (entity as any).aiComponent = comp;
  }

  /** 从实体上卸载 AI。 */
  detach(entity: EntityLike): void {
    this.components.delete(entity);
    (entity as any).aiComponent = undefined;
  }

  private frameCtx: { playerPos: { x: number; y: number; z: number }; daylight: number; playerDead: boolean } = {
    playerPos: { x: 0, y: 0, z: 0 },
    daylight: 1,
    playerDead: false,
  };

  /** 每帧调用：分帧更新所有启用的 AIComponent。 */
  update(
    dt: number,
    frameCtx?: { playerPos: { x: number; y: number; z: number }; daylight: number; playerDead: boolean },
  ): void {
    if (frameCtx) this.frameCtx = frameCtx;
    if (!this.enabled) return;
    const start = Date.now();
    for (const comp of this.components.values()) {
      if (!comp.enabled) continue;
      const e = comp.entity as any;
      comp.blackboard.set('onGround', e.onGround === true);
      if (typeof e.hp === 'number') comp.blackboard.set('hp', e.hp);
      if (typeof e.maxHp === 'number') comp.blackboard.set('maxHp', e.maxHp);
      const ctx = this.makeCtx(comp.entity, dt);
      comp.tick(dt, ctx);
      if (Date.now() - start >= this.budgetMs) break;
    }
  }

  private makeCtx(entity: EntityLike, dt: number): TickContext {
    const comp = this.components.get(entity)!;
    const rng = (label = 'default'): number => mulberry32(hashSeed(this.seed, entity.id, label))();
    return {
      entity,
      world: this.world,
      playerPos: this.frameCtx.playerPos,
      daylight: this.frameCtx.daylight,
      playerDead: this.frameCtx.playerDead,
      rng,
      events: this.events,
      api: this.api,
      blackboard: comp.blackboard,
      dt,
    } as TickContext;
  }

  enable(): void {
    this.enabled = true;
  }
  disable(): void {
    this.enabled = false;
  }

  /** 热重载某种生物的行为树 JSON（不影响运行中实例的运行时状态，新 tick 应用新配置）。 */
  reloadConfig(typeId: string, json: { root: any }): void {
    this.trees.set(typeId, BehaviorTree.fromJSON(json));
  }

  dispose(): void {
    this.components.clear();
    this.trees.clear();
  }
}
