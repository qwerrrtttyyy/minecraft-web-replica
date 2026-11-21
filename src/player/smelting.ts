/**
 * 烧炼系统核心（纯逻辑层，不依赖 DOM / three.js）。
 *
 * 与 crafting.ts 同构：规则表 + 状态机，UI 只负责呈现与交互。
 * 材料标识沿用「方块名 / item:xxx」，与合成 / 背包宿主共用转换函数。
 *
 * 烧炼是后台进行的：即使关闭熔炉面板，主循环仍调用 tick()；
 * 燃料烧完即停，有输入且燃料充足时自动从背包续同一种材料。
 */

export type MaterialId = string;

export interface SmeltingRecipe {
  id: string;
  label: string;
  input: MaterialId;
  output: MaterialId;
  /** 烧炼一个所需秒数 */
  time: number;
}

/** 烧炼配方表：本期只做装备相关的 4 条矿物线 */
export const SMELTING_RECIPES: SmeltingRecipe[] = [
  { id: 'iron_ingot', label: '铁锭', input: 'iron_ore', output: 'item:iron_ingot', time: 8 },
  { id: 'gold_ingot', label: '金锭', input: 'gold_ore', output: 'item:gold_ingot', time: 8 },
  { id: 'copper_ingot', label: '铜锭', input: 'copper_ore', output: 'item:copper_ingot', time: 8 },
  { id: 'diamond', label: '钻石', input: 'diamond_ore', output: 'item:diamond', time: 8 },
];

/** 燃料热值（秒），与烧炼时间同口径 */
export const FUEL_VALUES: Record<MaterialId, number> = {
  'item:coal': 80,
  oak_planks: 15,
  birch_planks: 15,
  spruce_planks: 15,
  'item:stick': 5,
  oak_log: 15,
  birch_log: 15,
  spruce_log: 15,
};

/** 背包宿主：由组装根实现，与合成宿主共用 materialToStack 转换 */
export interface SmeltingHost {
  /** 从背包取 1 个同种材料用于自动续料；不足返回 false */
  takeInput(material: MaterialId): boolean;
  /** 产出进背包 */
  produce(material: MaterialId, count: number): void;
  /** 一次烧炼完成的反馈 */
  onSmelted(recipe: SmeltingRecipe): void;
}

export interface SmeltingSave {
  fuelTime: number;
  input: MaterialId | null;
  progress: number;
}

export function smeltingRecipeOf(input: MaterialId): SmeltingRecipe | undefined {
  return SMELTING_RECIPES.find((r) => r.input === input);
}

export class SmeltingState {
  /** 剩余燃料秒数（不同燃料累加，不区分种类） */
  fuelTime = 0;
  input: MaterialId | null = null;
  /** 0~1 */
  progress = 0;

  constructor(private host: SmeltingHost) {}

  /** 投入燃料，返回增加的时间；非燃料返回 0 */
  putFuel(material: MaterialId): number {
    const value = FUEL_VALUES[material];
    if (!value) return 0;
    this.fuelTime += value;
    return value;
  }

  /**
   * 从背包扣除燃料并投入燃烧（组装根调用）。
   * 校验、扣背包、加时间三步合一，避免调用方只加时间不扣背包。
   * 返回实际增加的燃烧秒数；非燃料或背包不足返回 0。
   */
  putFuelFrom(material: MaterialId, take: (material: MaterialId) => boolean): number {
    if (!FUEL_VALUES[material]) return 0;
    if (!take(material)) return 0;
    return this.putFuel(material);
  }

  /** 放入待烧材料；已有输入或无配方时返回 false */
  putInput(material: MaterialId): boolean {
    if (this.input !== null || !smeltingRecipeOf(material)) return false;
    this.input = material;
    this.progress = 0;
    return true;
  }

  /** 取出输入材料（未烧完时退回背包由宿主负责） */
  takeInput(): MaterialId | null {
    const material = this.input;
    this.input = null;
    this.progress = 0;
    return material;
  }

  tick(dt: number) {
    if (this.input === null) {
      this.progress = 0;
      return;
    }
    const recipe = smeltingRecipeOf(this.input);
    if (!recipe || this.fuelTime <= 0 || dt <= 0) return;
    const burn = Math.min(dt, this.fuelTime);
    this.fuelTime = Math.max(0, this.fuelTime - burn);
    this.progress += burn / recipe.time;
    if (this.progress < 1) return;

    this.host.produce(recipe.output, 1);
    this.host.onSmelted(recipe);
    this.progress = 0;
    const material = this.input;
    // 燃料还有剩余时自动从背包续料，实现一次投料批量烧炼
    if (this.fuelTime > 0 && this.host.takeInput(material)) return;
    this.input = null;
  }

  clear() {
    this.fuelTime = 0;
    this.input = null;
    this.progress = 0;
  }

  serialize(): SmeltingSave {
    return { fuelTime: this.fuelTime, input: this.input, progress: this.progress };
  }

  restore(data: Partial<SmeltingSave> | undefined | null) {
    this.clear();
    if (!data) return;
    if (typeof data.fuelTime === 'number' && data.fuelTime > 0) this.fuelTime = data.fuelTime;
    if (typeof data.input === 'string' && smeltingRecipeOf(data.input)) this.input = data.input;
    if (typeof data.progress === 'number') this.progress = Math.max(0, Math.min(0.999, data.progress));
  }
}
