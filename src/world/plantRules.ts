/**
 * 生态规则注册扩展点（v1.4.3）。
 *
 * 插件通过 CraftAPI.botany.registerRule() 注入规则；Botany 只有在内置规则
 * 全部未命中时才按方块 id 查表分派，因此扩展不会改变任何既有生态行为。
 *
 * 本模块是纯类型 + 纯数据，不依赖 World / DOM / three.js，可被
 * scripts/build-test-snapshot.mjs 编译成 CommonJS 快照供 Node 回归直接实例化。
 */
import type { BlockId } from '../core/types';

export type GrowKind = 'grow' | 'spread' | 'decay' | 'ripen' | 'harvest';

/**
 * 规则可使用的受限上下文。
 *
 * 只暴露「读世界 / 带能量消耗的写入 / 能量微调」三类能力，插件拿不到
 * World 实例本身，也不会绕过 plant:grow 事件与存档脏标记。
 */
export interface PlantRuleContext {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly id: BlockId;
  /** 0~1，昼夜光照强度 */
  readonly daylight: number;
  rng(): number;
  /** 读取目标植物能量；非植物 / 未跟踪返回 0 */
  energy(x: number, y: number, z: number): number;
  /** 直接增减能量（异花传粉等加成），自动钳制到 0~100 */
  boost(x: number, y: number, z: number, delta: number): void;
  /** 是否满足生长能量门槛 */
  canGrow(x: number, y: number, z: number, id: BlockId): boolean;
  supported(x: number, y: number, z: number, id: BlockId): boolean;
  /** 带能量消耗的写入（消耗源植物能量，成功后发 plant:grow） */
  grow(x: number, y: number, z: number, id: BlockId, kind: GrowKind): boolean;
  /** 不扣能量的写入（环境枯萎 / 退化） */
  write(x: number, y: number, z: number, id: BlockId, kind: GrowKind): boolean;
  get(x: number, y: number, z: number): BlockId;
  isSolid(x: number, y: number, z: number): boolean;
  biome(x: number, z: number): string;
  surface(x: number, z: number): number;
  neighbors(x: number, y: number, z: number): [number, number, number][];
}

export interface PlantRule {
  /** 全局唯一 id，建议 `插件id:规则名` */
  id: string;
  /** 归属插件 id；停用插件时按此批量注销 */
  owner: string;
  /** 适用方块的注册名。按名称动态解析，注册方块与规则的先后顺序无关 */
  plants: readonly string[];
  /** 返回是否改变了世界 */
  tick(ctx: PlantRuleContext): boolean;
}

export interface PlantRuleInfo {
  id: string;
  owner: string;
  plants: string[];
}

/** 规则表：按 owner 批量注销，按方块 id 缓存查表结果 */
export class PlantRuleRegistry {
  private readonly byId = new Map<string, PlantRule>();
  /** 一个方块可同时命中多条规则（如霜花既传粉又受霜线约束） */
  private readonly cache = new Map<BlockId, PlantRule[]>();

  constructor(private readonly resolveId: (name: string) => BlockId) {}

  register(rule: PlantRule): void {
    if (!rule.id || !rule.owner || !rule.plants || rule.plants.length === 0) {
      throw new Error(`[botany] 规则字段不完整: ${rule.id}`);
    }
    if (this.byId.has(rule.id)) throw new Error(`[botany] 规则重复注册: ${rule.id}`);
    this.byId.set(rule.id, rule);
    this.cache.clear();
  }

  /** 按 owner 批量注销，返回注销条数 */
  unregister(owner: string): number {
    let removed = 0;
    for (const [id, rule] of [...this.byId]) {
      if (rule.owner !== owner) continue;
      this.byId.delete(id);
      removed++;
    }
    if (removed) this.cache.clear();
    return removed;
  }

  ruleFor(id: BlockId): PlantRule[] {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const found: PlantRule[] = [];
    for (const rule of this.byId.values()) {
      // 每次查表都按名称重新解析：插件后注册方块也能命中
      if (rule.plants.some((name) => this.resolveId(name) === id)) found.push(rule);
    }
    // 只缓存命中结果：未命中不落缓存，否则「先注册规则、后注册方块」会被空结果永久钉死。
    // ruleFor 只在内置分支全部未命中时才调用，规则数量极少，重复解析的开销可忽略。
    if (found.length) this.cache.set(id, found);
    return found;
  }

  list(): PlantRuleInfo[] {
    return [...this.byId.values()].map((r) => ({
      id: r.id, owner: r.owner, plants: [...r.plants],
    }));
  }

  get size(): number {
    return this.byId.size;
  }
}
