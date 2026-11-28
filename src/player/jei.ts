import { CRAFTING_GROUPS, CRAFTING_RECIPES, type MaterialId, type Recipe } from './crafting';
import { FUEL_UNITS, SMELT_RECIPES } from './smelting';

export type { MaterialId };

/**
 * JEI 物品管理器（纯逻辑层，不依赖 DOM / three.js）。
 *
 * 仿 JEI（Just Enough Items）的只读索引：把内置合成 / 熔炼 / 燃料三张表
 * 编织成「物品 → 配方（怎么做）」与「物品 → 用途（用在哪）」两张倒排表，
 * 供 UI 面板搜索与查看。只读索引，不提供作弊取出。
 *
 * 与 crafting.ts / smelting.ts 的关系：这里不复制任何配方数据，
 * 只消费两张既有配置表；新增配方自动进入索引。
 */

/** 索引条目的来源类型 */
export type JEIKind = 'craft' | 'smelt' | 'fuel';

/** 一条配方的展示视图（材料组已展开为成员列表供「用途」索引） */
export interface JEIRecipeView {
  /** 源配方 id（熔炼 / 燃料为派生 id） */
  id: string;
  kind: JEIKind;
  /** 显示名（熔炼 / 燃料为派生名） */
  label: string;
  /** 输入材料（材料组保持原样，用 expandMaterial 展开） */
  inputs: MaterialId[];
  output: MaterialId;
  count: number;
}

/** 材料组（'#组名'）展开为具体材料；普通材料原样返回 */
export function expandMaterial(m: MaterialId): MaterialId[] {
  if (!m.startsWith('#')) return [m];
  return CRAFTING_GROUPS[m.slice(1)] ?? [];
}

const KIND_LABEL: Record<JEIKind, string> = {
  craft: '合成',
  smelt: '熔炼',
  fuel: '燃料',
};

function recipeView(r: Recipe): JEIRecipeView {
  const inputs: MaterialId[] = [];
  if (r.pattern && r.key) {
    for (const ch of r.pattern.join('')) {
      if (ch === ' ') continue;
      const m = r.key[ch];
      if (m && !inputs.includes(m)) inputs.push(m);
    }
  } else if (r.shapeless) {
    inputs.push(...r.shapeless);
  }
  return { id: r.id, kind: 'craft', label: r.label, inputs, output: r.result.material, count: r.result.count };
}

export class JEIIndex {
  /** 倒排表：产物 → 配方 */
  private byOutput = new Map<MaterialId, JEIRecipeView[]>();
  /** 倒排表：材料（含组展开）→ 配方 */
  private byInput = new Map<MaterialId, JEIRecipeView[]>();
  /** 全量物品键（产物 + 材料 + 燃料），已去重排序 */
  readonly keys: MaterialId[];

  constructor(
    recipes: readonly Recipe[] = CRAFTING_RECIPES,
    smelt: Readonly<Record<string, string>> = SMELT_RECIPES,
    fuels: Readonly<Record<string, number>> = FUEL_UNITS,
  ) {
    const all = new Set<MaterialId>();
    // 材料组（'#planks'）只登记展开后的成员：组令牌不是可展示物品，
    // 进入 keys 会在面板里渲染成空图标伪物品。
    const push = (m: MaterialId) => {
      for (const e of expandMaterial(m)) all.add(e);
    };
    for (const r of recipes) {
      const view = recipeView(r);
      all.add(view.output);
      push(view.output);
      for (const i of view.inputs) push(i);
      const outs = this.byOutput.get(view.output) ?? [];
      outs.push(view);
      this.byOutput.set(view.output, outs);
      for (const i of view.inputs) {
        for (const member of expandMaterial(i)) {
          const uses = this.byInput.get(member) ?? [];
          uses.push(view);
          this.byInput.set(member, uses);
        }
      }
    }
    // 熔炼线：材料 → 产物（产物同时入索引，可继续链查）
    for (const [material, output] of Object.entries(smelt)) {
      const view: JEIRecipeView = {
        id: `smelt:${material}`,
        kind: 'smelt',
        label: `烧炼 ${output}`,
        inputs: [material],
        output,
        count: 1,
      };
      all.add(material);
      all.add(output);
      const outs = this.byOutput.get(output) ?? [];
      outs.push(view);
      this.byOutput.set(output, outs);
      const uses = this.byInput.get(material) ?? [];
      uses.push(view);
      this.byInput.set(material, uses);
    }
    // 燃料线：燃料 → 用途（可烧炼的材料表，作为「用途」挂在燃料上）
    for (const material of Object.keys(fuels)) {
      const view: JEIRecipeView = {
        id: `fuel:${material}`,
        kind: 'fuel',
        label: '熔炉燃料',
        inputs: [],
        output: material,
        count: 1,
      };
      all.add(material);
      const uses = this.byInput.get(material) ?? [];
      uses.push(view);
      this.byInput.set(material, uses);
    }
    this.keys = [...all].sort();
  }

  /** 这个物品能怎么做出来（空数组 = 不可合成，仅自然生成 / 掉落） */
  recipesFor(key: MaterialId): JEIRecipeView[] {
    return this.byOutput.get(key) ?? [];
  }

  /** 这个物品被用在哪里（空数组 = 终端物品） */
  usesFor(key: MaterialId): JEIRecipeView[] {
    return this.byInput.get(key) ?? [];
  }
}

/** 物品搜索：按材料键或显示名做不区分大小写的子串匹配 */
export function searchJEI(
  keys: readonly MaterialId[],
  query: string,
  labelOf: (key: MaterialId) => string,
): MaterialId[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...keys];
  return keys.filter((k) => k.toLowerCase().includes(q) || labelOf(k).toLowerCase().includes(q));
}

/** 索引条目来源的中文短标签 */
export function jeiKindLabel(kind: JEIKind): string {
  return KIND_LABEL[kind];
}
