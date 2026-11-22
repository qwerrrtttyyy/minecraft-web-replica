import type { EquipMaterial } from './equipment';

/**
 * 合成系统核心（纯逻辑层，不依赖 DOM / three.js）。
 *
 * 与 survival.ts 同构：只管规则，不管怎么显示。
 * UI 层（src/ui/crafting.ts）负责 3×3 网格、结果槽与背包区的呈现。
 *
 * 术语：
 * - 材料：可放进合成格的东西。方块用方块名（'oak_planks'），
 *   物品用 'item:' 前缀（'item:stick'）。
 * - 材料组：配方里用 '#组名' 引用，组内任一材料都可满足该格。
 * - 配方：有序（pattern）或无序（shapeless）两种。
 *
 * 匹配规则刻意做得严格：网格里多放一个不相干的材料就不该匹配，
 * 否则玩家会拿到「看起来对但其实错了」的产物。
 */

/** 可交互方块名：空手右键它会打开合成界面 */
export const INTERACTIVE_BLOCK = 'crafting_table';

/** 材料组：配方里用 '#组名' 引用，组内任一材料都可满足该格 */
export const CRAFTING_GROUPS: Record<string, string[]> = {
  // 三种木板：合成工作台 / 木棍时任一木板均可
  planks: ['oak_planks', 'birch_planks', 'spruce_planks'],
  // 五种原木：营火等配方任选一种原木
  log: ['oak_log', 'birch_log', 'spruce_log', 'acacia_log', 'cherry_log'],
};

/** 材料标识：方块名，或带 'item:' 前缀的物品名 */
export type MaterialId = string;

/** 配方产物 */
export interface RecipeResult {
  /** 方块名或 'item:xxx' */
  material: MaterialId;
  /** 产出数量 */
  count: number;
}

export interface Recipe {
  /** 稳定 id，用于事件负载与测试断言 */
  id: string;
  /** 中文显示名 */
  label: string;
  /** 有序配方：pattern 每行等长，' ' 表示空位 */
  pattern?: string[];
  /** pattern 字符 → 材料名或材料组（'#planks'） */
  key?: Record<string, string>;
  /** 无序配方：材料列表，顺序无关 */
  shapeless?: string[];
  result: RecipeResult;
}

/** 装备材质 → 合成材料标识（与 EQUIPMENT 的 material 字段一一对应） */
const EQUIP_MATERIAL: Record<EquipMaterial, string> = {
  wood: '#planks',
  stone: 'cobblestone',
  iron: 'item:iron_ingot',
  gold: 'item:gold_ingot',
  diamond: 'item:diamond',
  leather: 'item:leather',
};

interface EquipTier {
  material: EquipMaterial;
  prefix: string;
  label: string;
}

const TOOL_TIERS: EquipTier[] = [
  { material: 'wood', prefix: 'wooden', label: '木' },
  { material: 'stone', prefix: 'stone', label: '石' },
  { material: 'iron', prefix: 'iron', label: '铁' },
  { material: 'gold', prefix: 'golden', label: '金' },
  { material: 'diamond', prefix: 'diamond', label: '钻石' },
];

const ARMOR_TIERS: EquipTier[] = [
  { material: 'leather', prefix: 'leather', label: '皮' },
  { material: 'iron', prefix: 'iron', label: '铁' },
  { material: 'gold', prefix: 'golden', label: '金' },
  { material: 'diamond', prefix: 'diamond', label: '钻石' },
];

/** 由材质档位生成 36 条装备配方（id / 产物与 EQUIPMENT 保持一致） */
function equipmentRecipes(): Recipe[] {
  const out: Recipe[] = [];
  for (const tier of TOOL_TIERS) {
    const m = EQUIP_MATERIAL[tier.material];
    const add = (kind: string, label: string, pattern: string[]) => out.push({
      id: `${tier.prefix}_${kind}`,
      label: `${tier.label}${label}`,
      pattern,
      key: { M: m, S: 'item:stick' },
      result: { material: `item:${tier.prefix}_${kind}`, count: 1 },
    });
    add('sword', '剑', ['M', 'M', 'S']);
    add('pickaxe', '镐', ['MMM', ' S ', ' S ']);
    add('axe', '斧', ['MM ', 'MS ', ' S ']);
    add('shovel', '锹', ['M', 'S', 'S']);
  }
  for (const tier of ARMOR_TIERS) {
    const m = EQUIP_MATERIAL[tier.material];
    const add = (kind: string, label: string, pattern: string[]) => out.push({
      id: `${tier.prefix}_${kind}`,
      label: `${tier.label}${label}`,
      pattern,
      key: { M: m },
      result: { material: `item:${tier.prefix}_${kind}`, count: 1 },
    });
    add('helmet', '头盔', ['MMM', 'M M']);
    add('chestplate', '胸甲', ['M M', 'MMM', 'MMM']);
    add('leggings', '护腿', ['MMM', 'M M', 'M M']);
    add('boots', '靴子', ['M M', 'M M']);
  }
  return out;
}

/**
 * 内置配方表。
 *
 * 最小闭环：原木→木板→工作台，外加砂岩 / 石砖 / 木棍三条实用线。
 * 每条配方都刻意做成 2×2 以内的小配方，这样玩家的 2×2 个人合成格
 * 在拿到工作台之前就能先攒出工作台本身（详见 README 的玩法说明）。
 * E04 起追加 36 条装备配方（需要 3×3 工作台，2×2 个人格放不下）。
 */
export const CRAFTING_RECIPES: Recipe[] = [
  {
    id: 'oak_planks',
    label: '橡木木板',
    shapeless: ['oak_log'],
    result: { material: 'oak_planks', count: 4 },
  },
  {
    id: 'birch_planks',
    label: '白桦木板',
    shapeless: ['birch_log'],
    result: { material: 'birch_planks', count: 4 },
  },
  {
    id: 'spruce_planks',
    label: '云杉木板',
    shapeless: ['spruce_log'],
    result: { material: 'spruce_planks', count: 4 },
  },
  {
    id: 'crafting_table',
    label: '工作台',
    pattern: ['PP', 'PP'],
    key: { P: '#planks' },
    result: { material: 'crafting_table', count: 1 },
  },
  {
    id: 'sandstone',
    label: '砂岩',
    pattern: ['SS', 'SS'],
    key: { S: 'sand' },
    result: { material: 'sandstone', count: 1 },
  },
  {
    id: 'stone_bricks',
    label: '石砖',
    pattern: ['CC', 'CC'],
    key: { C: 'cobblestone' },
    result: { material: 'stone_bricks', count: 1 },
  },
  {
    id: 'stick',
    label: '木棍',
    pattern: ['P', 'P'],
    key: { P: '#planks' },
    result: { material: 'item:stick', count: 4 },
  },
  {
    // 堆肥桶：2×2 个人合成格即可制作，保证生存模式能进入堆肥→施肥闭环
    id: 'composter',
    label: '堆肥桶',
    pattern: ['PP', 'PD'],
    key: { P: '#planks', D: 'dirt' },
    result: { material: 'composter', count: 1 },
  },
  // v1.7.0 内容植物闭环：棉花压成建材块；荧光孢子 + 木棍做荧光火把（2×2 个人格可放）
  {
    id: 'cotton_block',
    label: '棉花块',
    pattern: ['CC', 'CC'],
    key: { C: 'item:cotton' },
    result: { material: 'cotton_block', count: 1 },
  },
  {
    id: 'glow_torch',
    label: '荧光火把',
    pattern: ['G', 'S'],
    key: { G: 'item:glow_spore', S: 'item:stick' },
    result: { material: 'glow_torch', count: 2 },
  },
  ...equipmentRecipes(),
  {
    // C01：煤炭 + 木棍 → 4 火把（1×2 竖排，2×2 个人合成格也放得下）
    id: 'torch_fuel',
    label: '火把',
    pattern: ['C', 'S'],
    key: { C: 'item:coal', S: 'item:stick' },
    result: { material: 'torch', count: 4 },
  },
  // v1.7.0：重点株特化闭环——野蒜/玫瑰果的菜式合成（无序，2×2 个人格可做）
  {
    id: 'garlic_rice',
    label: '蒜香米饭',
    shapeless: ['item:garlic', 'item:rice'],
    result: { material: 'item:garlic_rice', count: 1 },
  },
  {
    id: 'rose_tea',
    label: '玫瑰果茶',
    shapeless: ['item:rose_hips', 'item:nectar'],
    result: { material: 'item:rose_tea', count: 2 },
  },
  {
    // PR4 熔炉：8 个圆石围一圈（3×3 工作台）
    id: 'furnace',
    label: '熔炉',
    pattern: ['CCC', 'C C', 'CCC'],
    key: { C: 'cobblestone' },
    result: { material: 'furnace', count: 1 },
  },
  {
    // PR4 营火：3 圆石 + 3 任意原木 + 1 煤（无序，2×2 个人格可放）
    id: 'campfire',
    label: '营火',
    shapeless: ['cobblestone', 'cobblestone', 'cobblestone', '#log', '#log', '#log', 'item:coal'],
    result: { material: 'campfire', count: 1 },
  },
];

/** 合成格里的一个材料：方块名或 'item:xxx' */
export type GridMaterial = MaterialId;

/** 一次匹配的结果 */
export interface RecipeMatch {
  recipe: Recipe;
  /** 参与本次合成的格子下标（有序配方按实际摆放位置给出） */
  cells: number[];
  /** 产物材料与数量 */
  result: RecipeResult;
}

/**
 * 判断某个实际材料是否落在配方槽的可接受集合里。
 * 槽为材料组（'#planks'）时，组内任一材料都接受。
 */
function slotAccepts(slot: string, material: string): boolean {
  if (slot.startsWith('#')) {
    const group = CRAFTING_GROUPS[slot.slice(1)];
    return !!group && group.includes(material);
  }
  return slot === material;
}

/**
 * 无序配方匹配：材料种类齐全即可（每种材料各占一格）。
 * 返回参与匹配的格子下标，无匹配返回 null。
 */
function matchShapeless(recipe: Recipe, grid: (GridMaterial | null)[]): number[] | null {
  const slots = recipe.shapeless ?? [];
  const filled: number[] = [];
  for (let i = 0; i < grid.length; i++) if (grid[i] !== null) filled.push(i);
  if (filled.length !== slots.length) return null;

  // 每个材料槽都要认领一个未被占用的格子
  const used = new Set<number>();
  const assign: number[] = [];

  const tryAssign = (slotIndex: number): boolean => {
    if (slotIndex === slots.length) return true;
    const slot = slots[slotIndex];
    for (const cell of filled) {
      if (used.has(cell)) continue;
      const material = grid[cell]!;
      if (!slotAccepts(slot, material)) continue;
      used.add(cell);
      assign.push(cell);
      if (tryAssign(slotIndex + 1)) return true;
      used.delete(cell);
      assign.pop();
    }
    return false;
  };

  return tryAssign(0) ? assign : null;
}

/**
 * 有序配方匹配：在网格中搜索 pattern 的所有摆放位置。
 *
 * pattern 按自身包围盒逐格比对，网格里 pattern 覆盖范围之外的格子必须为空，
 * 因此 2×2 的配方可以放在 3×3 的任意角落。
 */
function matchShaped(
  recipe: Recipe,
  grid: (GridMaterial | null)[],
  size: number,
): number[] | null {
  const pattern = recipe.pattern!;
  const key = recipe.key ?? {};
  const rows = pattern.length;
  const cols = Math.max(...pattern.map((r) => r.length));

  for (let oy = 0; oy + rows <= size; oy++) {
    for (let ox = 0; ox + cols <= size; ox++) {
      const cells: number[] = [];
      let ok = true;

      for (let r = 0; r < rows && ok; r++) {
        const row = pattern[r];
        for (let c = 0; c < cols && ok; c++) {
          const ch = row[c] ?? ' ';
          const idx = (oy + r) * size + (ox + c);
          const material = grid[idx] ?? null;
          if (ch === ' ') {
            if (material !== null) ok = false;
            continue;
          }
          const slot = key[ch];
          if (!slot || material === null || !slotAccepts(slot, material)) {
            ok = false;
            break;
          }
          cells.push(idx);
        }
      }
      if (!ok) continue;

      // pattern 覆盖范围之外的格子必须全空
      let outsideClean = true;
      for (let i = 0; i < grid.length; i++) {
        const r = Math.floor(i / size);
        const c = i % size;
        const inside = r >= oy && r < oy + rows && c >= ox && c < ox + cols;
        if (inside) continue;
        if (grid[i] !== null) { outsideClean = false; break; }
      }
      if (!outsideClean) continue;

      return cells;
    }
  }
  return null;
}

/**
 * 在网格中寻找匹配的配方。
 *
 * @param grid 长度必须是 size*size，元素为材料标识或 null
 * @param size 网格边长（2 = 个人合成格，3 = 工作台）
 */
export function matchRecipe(
  grid: (GridMaterial | null)[],
  size: number,
  recipes: Recipe[] = CRAFTING_RECIPES,
): RecipeMatch | null {
  for (const recipe of recipes) {
    const cells = recipe.shapeless
      ? matchShapeless(recipe, grid)
      : recipe.pattern
        ? matchShaped(recipe, grid, size)
        : null;
    if (!cells) continue;
    return { recipe, cells, result: recipe.result };
  }
  return null;
}

/**
 * 某条配方在给定网格尺寸下是否放得下（UI 可据此提示"该配方需要工作台"）。
 */
export function recipeFits(recipe: Recipe, size: number): boolean {
  if (recipe.shapeless) return recipe.shapeless.length <= size * size;
  const rows = recipe.pattern!.length;
  const cols = Math.max(...recipe.pattern!.map((r) => r.length));
  return rows <= size && cols <= size;
}

/**
 * 材料标识 → 背包栈（方块按 id、物品按名字）。
 * 未知材料返回 null（调用方据此跳过）。
 */
export function materialToStack(
  material: MaterialId,
  registry: { byNameGet(name: string): { id: number } | undefined },
): { kind: 'block'; id: number } | { kind: 'item'; id: string } | null {
  if (material.startsWith('item:')) {
    const name = material.slice(5);
    return name ? { kind: 'item', id: name } : null;
  }
  const def = registry.byNameGet(material);
  return def ? { kind: 'block', id: def.id } : null;
}

/**
 * 背包键（'b:12' / 'i:apple'）→ 材料标识。
 * 无效方块 id 返回 null。
 */
export function inventoryKeyToMaterial(
  key: string,
  registry: { get(id: number): { id: number; name: string } },
): MaterialId | null {
  if (key.startsWith('i:')) {
    const name = key.slice(2);
    return name ? `item:${name}` : null;
  }
  if (!key.startsWith('b:')) return null;
  const id = Number(key.slice(2));
  const def = registry.get(id);
  if (def.id !== id || id === 0) return null;
  return def.name;
}
