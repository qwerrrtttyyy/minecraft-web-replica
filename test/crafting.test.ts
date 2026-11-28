/**
 * 合成系统回归（Vitest，直接消费 src TS 源码）。
 * 运行：npm run test:crafting:vitest
 * 断言语义与 test/crafting-check.cjs 一一对应（迁移，未改动断言行为）。
 */
import { describe, expect, it } from 'vitest';
import {
  CRAFTING_GROUPS,
  CRAFTING_RECIPES,
  INTERACTIVE_BLOCK,
  inventoryKeyToMaterial,
  matchRecipe,
  materialToStack,
} from '../src/player/crafting';
import { EQUIPMENT } from '../src/player/equipment';
import { ITEMS } from '../src/player/survival';
import { BlockRegistry, registerBuiltinBlocks } from '../src/world/blocks';

const reg = new BlockRegistry();
registerBuiltinBlocks(reg);

function id(n: string): number {
  const d = reg.byNameGet(n);
  expect(d).toBeTruthy();
  return d!.id;
}
/** 网格元素用材料标识：方块名或 'item:xxx'（与 UI 层一致） */
const blk = (n: string) => n;

/** 造一个 size×size 的空网格 */
const grid = (size: number) => new Array(size * size).fill(null) as Array<string | null>;
/** 在网格里放一个材料（row/col 从 0 开始） */
const put = (cells: Array<string | null>, size: number, col: number, row: number, stack: string | null) => {
  cells[row * size + col] = stack;
  return cells;
};
const matchOf = (cells: Array<string | null>, size: number) => matchRecipe(cells, size);

// ---- 1. 配方表结构 ----
describe('配方表结构', () => {
  it('配方表非空', () => {
    expect(CRAFTING_RECIPES.length).toBeGreaterThan(0);
  });
  it('配方 id 唯一', () => {
    expect(new Set(CRAFTING_RECIPES.map((r) => r.id)).size).toBe(CRAFTING_RECIPES.length);
  });
  it('每条配方都有产物与数量', () => {
    expect(
      CRAFTING_RECIPES.every(
        (r) =>
          r.result && typeof r.result.material === 'string' && Number.isInteger(r.result.count) && r.result.count > 0,
      ),
    ).toBe(true);
  });
  it('每条配方要么有序要么无序', () => {
    expect(CRAFTING_RECIPES.every((r) => !!r.pattern !== !!r.shapeless)).toBe(true);
  });
  it('有序配方的字符都在 key 里', () => {
    expect(
      CRAFTING_RECIPES.every(
        (r) => !r.pattern || r.pattern.every((row) => [...row].every((ch) => ch === ' ' || (r.key && r.key[ch]))),
      ),
    ).toBe(true);
  });
  it('材料组非空且成员合法', () => {
    expect(
      Object.values(CRAFTING_GROUPS).every((g) => g.length > 0 && g.every((m) => reg.byNameGet(m) !== undefined)),
    ).toBe(true);
  });
});

// ---- 2~6. 具体配方匹配 ----
describe('具体配方匹配', () => {
  it('1 原木 → 4 橡木木板；产物是方块 oak_planks', () => {
    const m = matchOf(put(grid(3), 3, 1, 1, blk('oak_log')), 3);
    expect(m?.recipe.id).toBe('oak_planks');
    expect(m?.recipe.result.count).toBe(4);
    expect(m?.recipe.result.material).toBe('oak_planks');
  });
  it('白桦原木 → 4 白桦木板（不串味）', () => {
    const mb = matchOf(put(grid(3), 3, 0, 0, blk('birch_log')), 3);
    expect(mb?.recipe.id).toBe('birch_planks');
    expect(mb?.recipe.result.material).toBe('birch_planks');
  });
  it('两个原木不匹配（原木→木板 只吃 1 个）', () => {
    const cells = grid(3);
    put(cells, 3, 0, 0, blk('oak_log'));
    put(cells, 3, 1, 0, blk('oak_log'));
    expect(matchOf(cells, 3)).toBeNull();
  });
  it('4 木板（2×2）→ 工作台；产物指向已注册方块', () => {
    const cells = grid(3);
    put(cells, 3, 0, 0, blk('oak_planks'));
    put(cells, 3, 1, 0, blk('oak_planks'));
    put(cells, 3, 0, 1, blk('oak_planks'));
    put(cells, 3, 1, 1, blk('oak_planks'));
    const m = matchOf(cells, 3);
    expect(m?.recipe.id).toBe('crafting_table');
    expect(m?.recipe.result.count).toBe(1);
    expect(reg.byNameGet(m!.recipe.result.material)?.id).toBe(id('crafting_table'));
  });
  it('2×2 配方在 3×3 内偏移摆放同样匹配', () => {
    const off = grid(3);
    put(off, 3, 1, 1, blk('oak_planks'));
    put(off, 3, 2, 1, blk('oak_planks'));
    put(off, 3, 1, 2, blk('oak_planks'));
    put(off, 3, 2, 2, blk('oak_planks'));
    expect(matchOf(off, 3)?.recipe.id).toBe('crafting_table');
  });
  it('材料组 #planks 允许白桦木板合成工作台', () => {
    const birchPlanks = grid(3);
    put(birchPlanks, 3, 0, 0, blk('birch_planks'));
    put(birchPlanks, 3, 1, 0, blk('birch_planks'));
    put(birchPlanks, 3, 0, 1, blk('birch_planks'));
    put(birchPlanks, 3, 1, 1, blk('birch_planks'));
    expect(matchOf(birchPlanks, 3)?.recipe.id).toBe('crafting_table');
  });
  it('2 木板竖排 → 4 木棍；木棍是物品且已登记在 ITEMS', () => {
    const cells = grid(3);
    put(cells, 3, 0, 0, blk('oak_planks'));
    put(cells, 3, 0, 1, blk('oak_planks'));
    const m = matchOf(cells, 3);
    expect(m?.recipe.id).toBe('stick');
    expect(m?.recipe.result.count).toBe(4);
    expect(m?.recipe.result.material).toBe('item:stick');
    expect(ITEMS.stick && ITEMS.stick.tile === 'stick').toBe(true);
  });
  it('2 木板横排不匹配竖排木棍配方', () => {
    const flat = grid(3);
    put(flat, 3, 0, 0, blk('oak_planks'));
    put(flat, 3, 1, 0, blk('oak_planks'));
    expect(matchOf(flat, 3)).toBeNull();
  });
  it('4 沙 → 砂岩', () => {
    const sand = grid(3);
    put(sand, 3, 0, 0, blk('sand'));
    put(sand, 3, 1, 0, blk('sand'));
    put(sand, 3, 0, 1, blk('sand'));
    put(sand, 3, 1, 1, blk('sand'));
    expect(matchOf(sand, 3)?.recipe.id).toBe('sandstone');
  });
  it('4 圆石 → 石砖', () => {
    const cobble = grid(3);
    put(cobble, 3, 0, 0, blk('cobblestone'));
    put(cobble, 3, 1, 0, blk('cobblestone'));
    put(cobble, 3, 0, 1, blk('cobblestone'));
    put(cobble, 3, 1, 1, blk('cobblestone'));
    expect(matchOf(cobble, 3)?.recipe.id).toBe('stone_bricks');
  });
});

// ---- 7. 2×2 个人合成格 ----
describe('2×2 个人合成格', () => {
  it('2×2 格内 4 木板 → 工作台（个人合成即可起步）', () => {
    const cells = grid(2);
    put(cells, 2, 0, 0, blk('oak_planks'));
    put(cells, 2, 1, 0, blk('oak_planks'));
    put(cells, 2, 0, 1, blk('oak_planks'));
    put(cells, 2, 1, 1, blk('oak_planks'));
    expect(matchOf(cells, 2)?.recipe.id).toBe('crafting_table');
  });
  it('2×2 格内 2 木板竖排 → 木棍', () => {
    const stick = grid(2);
    put(stick, 2, 0, 0, blk('oak_planks'));
    put(stick, 2, 0, 1, blk('oak_planks'));
    expect(matchOf(stick, 2)?.recipe.id).toBe('stick');
  });
});

// ---- 8. 严格性 ----
describe('严格性：材料放错位置 / 放错种类都不该匹配', () => {
  it('4 木板摆成 L 形不匹配工作台', () => {
    const wrong = grid(3);
    put(wrong, 3, 0, 0, blk('oak_planks'));
    put(wrong, 3, 1, 0, blk('oak_planks'));
    put(wrong, 3, 2, 0, blk('oak_planks'));
    put(wrong, 3, 0, 1, blk('oak_planks'));
    expect(matchOf(wrong, 3)).toBeNull();
  });
  it('多余材料会让整个网格不匹配', () => {
    const extra = grid(3);
    put(extra, 3, 0, 0, blk('oak_planks'));
    put(extra, 3, 1, 0, blk('oak_planks'));
    put(extra, 3, 0, 1, blk('oak_planks'));
    put(extra, 3, 1, 1, blk('oak_planks'));
    put(extra, 3, 2, 2, blk('dirt'));
    expect(matchOf(extra, 3)).toBeNull();
  });
  it('空网格不匹配任何配方', () => {
    expect(matchOf(grid(3), 3)).toBeNull();
  });
});

// ---- 9. 匹配结果里的格子下标可用于消耗 ----
describe('匹配结果给出参与格子下标', () => {
  it('单个原木 → cells=[4]', () => {
    const cells = grid(3);
    put(cells, 3, 1, 1, blk('oak_log'));
    const m = matchOf(cells, 3);
    expect(m?.cells.length).toBe(1);
    expect(m?.cells[0]).toBe(4);
  });
});

// ---- 10. 背包取放闭环 ----
describe('背包取放闭环：取料 → 合成 → 产出', () => {
  // 模拟 CraftingHost：背包用 'b:<id>' / 'i:<name>' 键，合成用材料标识
  const bag = new Map<string, number>();
  const keyOf = (material: string) => {
    if (material.startsWith('item:')) return `i:${material.slice(5)}`;
    return `b:${id(material)}`;
  };
  const materialOf = (key: string): string | null => {
    if (key.startsWith('i:')) return `item:${key.slice(2)}`;
    const num = Number(key.slice(2));
    return reg.get(num).id === num ? reg.get(num).name : null;
  };
  const host = {
    take: (material: string) => {
      const key = keyOf(material);
      if ((bag.get(key) ?? 0) <= 0) return false;
      bag.set(key, bag.get(key)! - 1);
      if (bag.get(key) === 0) bag.delete(key);
      return true;
    },
    giveBack: (material: string) => {
      const key = keyOf(material);
      bag.set(key, (bag.get(key) ?? 0) + 1);
    },
    produce: (material: string, count: number) => {
      const key = keyOf(material);
      bag.set(key, (bag.get(key) ?? 0) + count);
    },
  };

  const takeInto = (cells: Array<string | null>, size: number, col: number, row: number, material: string) => {
    expect(host.take(material)).toBe(true);
    put(cells, size, col, row, material);
  };

  it('原木 → 木板：材料被扣除、产物进背包', () => {
    bag.clear();
    bag.set(`b:${id('oak_log')}`, 1);
    const c1 = grid(3);
    takeInto(c1, 3, 0, 0, 'oak_log');
    const m1 = matchOf(c1, 3)!;
    expect(m1.recipe.id).toBe('oak_planks');
    host.produce(m1.result.material, m1.result.count);
    expect(bag.get(`b:${id('oak_planks')}`)).toBe(4);
    expect(bag.get(`b:${id('oak_log')}`) ?? 0).toBe(0);
  });
  it('木板 → 工作台（2×2）：4 块木板全部被扣除', () => {
    const c2 = grid(3);
    takeInto(c2, 3, 0, 0, 'oak_planks');
    takeInto(c2, 3, 1, 0, 'oak_planks');
    takeInto(c2, 3, 0, 1, 'oak_planks');
    takeInto(c2, 3, 1, 1, 'oak_planks');
    const m2 = matchOf(c2, 3)!;
    expect(m2.recipe.id).toBe('crafting_table');
    host.produce(m2.result.material, m2.result.count);
    expect(bag.get(`b:${id('crafting_table')}`)).toBe(1);
    expect(bag.get(`b:${id('oak_planks')}`) ?? 0).toBe(0);
  });
  it('背包空时取料失败，不会凭空产出', () => {
    bag.clear();
    expect(host.take('oak_log')).toBe(false);
    expect(bag.get(`b:${id('oak_planks')}`) ?? 0).toBe(0);
  });
  void host.giveBack;
});

// ---- 11. 材料标识 ↔ 背包键 / 背包栈 的转换 ----
describe('材料标识转换', () => {
  it('可交互方块是工作台且已注册', () => {
    expect(INTERACTIVE_BLOCK).toBe('crafting_table');
    expect(reg.byNameGet(INTERACTIVE_BLOCK)).toBeTruthy();
  });
  it('方块材料 → 背包栈', () => {
    const stack = materialToStack('oak_planks', reg);
    expect(stack?.kind).toBe('block');
    expect(stack?.id).toBe(id('oak_planks'));
  });
  it('物品材料 → 背包栈', () => {
    const itemStack = materialToStack('item:stick', reg);
    expect(itemStack?.kind).toBe('item');
    expect(itemStack?.id).toBe('stick');
  });
  it('未知材料 → null', () => {
    expect(materialToStack('no_such_thing', reg)).toBeNull();
  });
  it('背包键 → 方块材料', () => {
    expect(inventoryKeyToMaterial(`b:${id('crafting_table')}`, reg)).toBe('crafting_table');
  });
  it('背包键 → 物品材料', () => {
    expect(inventoryKeyToMaterial('i:stick', reg)).toBe('item:stick');
  });
  it('越界方块 id → null', () => {
    expect(inventoryKeyToMaterial('b:9999', reg)).toBeNull();
  });
  it('非法背包键 → null', () => {
    expect(inventoryKeyToMaterial('x:1', reg)).toBeNull();
  });
});

// ---- 12. E04：装备配方 ----
describe('装备配方', () => {
  const gridOf = (rows: string[], symbols: Record<string, string>) =>
    rows
      .join('')
      .split('')
      .map((c) => symbols[c] ?? null);

  it('41 件装备各有配方，产物与 EQUIPMENT 一致（新增铜工具 4 + 铜锄 1）', () => {
    const equipRecipes = CRAFTING_RECIPES.filter((r) => !!EQUIPMENT[r.id]);
    expect(equipRecipes.length).toBe(41);
    for (const r of equipRecipes) {
      expect(r.result.material).toBe(`item:${r.id}`);
      expect(ITEMS[r.id]).toBeTruthy();
      expect(r.result.count).toBe(1);
    }
  });
  it('铁剑/铁镐/铁斧/铁锹配方可匹配', () => {
    const iron = { I: 'item:iron_ingot', S: 'item:stick' };
    expect(matchRecipe(gridOf(['I  ', 'I  ', 'S  '], iron), 3)?.recipe.id).toBe('iron_sword');
    expect(matchRecipe(gridOf(['III', ' S ', ' S '], iron), 3)?.recipe.id).toBe('iron_pickaxe');
    expect(matchRecipe(gridOf(['II ', 'IS ', ' S '], iron), 3)?.recipe.id).toBe('iron_axe');
    expect(matchRecipe(gridOf(['I  ', 'S  ', 'S  '], iron), 3)?.recipe.id).toBe('iron_shovel');
  });
  it('多放材料不误匹配', () => {
    const iron = { I: 'item:iron_ingot', S: 'item:stick' };
    expect(matchRecipe(gridOf(['III', 'ISI', 'SSS'], iron), 3)).toBeNull();
  });
  it('皮革盔甲四件套配方可匹配', () => {
    const leather = { L: 'item:leather' };
    expect(matchRecipe(gridOf(['LLL', 'L L'], leather), 3)?.recipe.id).toBe('leather_helmet');
    expect(matchRecipe(gridOf(['L L', 'LLL', 'LLL'], leather), 3)?.recipe.id).toBe('leather_chestplate');
    expect(matchRecipe(gridOf(['LLL', 'L L', 'L L'], leather), 3)?.recipe.id).toBe('leather_leggings');
    expect(matchRecipe(gridOf(['L L', 'L L'], leather), 3)?.recipe.id).toBe('leather_boots');
  });
  it('木工具使用材料组 #planks，任一木板均可', () => {
    const wood = { P: 'birch_planks', S: 'item:stick' };
    expect(matchRecipe(gridOf(['P  ', 'P  ', 'S  '], wood), 3)?.recipe.id).toBe('wooden_sword');
  });
});

// ---- 13. 内容植物闭环与火把 ----
describe('内容配方', () => {
  const patternGrid = (rows: string[], symbols: Record<string, string>) =>
    rows
      .join('')
      .split('')
      .map((c) => symbols[c] ?? null);

  it('棉花×4 可合成棉花块', () => {
    expect(matchRecipe(patternGrid(['CC', 'CC'], { C: 'item:cotton' }), 2)?.recipe.id).toBe('cotton_block');
  });
  it('荧光孢子+木棍可合成 2 荧光火炬', () => {
    const m = matchRecipe(['item:glow_spore', null, 'item:stick', null], 2);
    expect(m?.recipe.id).toBe('glow_torch');
    expect(m?.recipe.result.count).toBe(2);
  });
  it('棉花块混入多余材料不匹配（合成必须严格）', () => {
    expect(matchRecipe(['item:cotton', 'item:cotton', 'item:cotton', 'dirt'], 2)?.recipe.id).not.toBe('cotton_block');
  });
  it('煤炭+木棍可合成 4 火把', () => {
    const r = CRAFTING_RECIPES.find((x) => x.id === 'torch_fuel');
    expect(r?.result.material).toBe('torch');
    expect(r?.result.count).toBe(4);
    expect(r?.pattern.join('')).toBe('CS');
    expect(r?.key.C).toBe('item:coal');
    expect(r?.key.S).toBe('item:stick');
  });
});

// ---- 14. PR4 熔炉 / 营火配方 ----
describe('熔炉与营火配方', () => {
  it('8 个圆石围一圈 → 熔炉', () => {
    const cells = grid(3);
    const ring: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 1],
      [2, 1],
      [0, 2],
      [1, 2],
      [2, 2],
    ];
    for (const [col, row] of ring) put(cells, 3, col, row, blk('cobblestone'));
    const m = matchOf(cells, 3);
    expect(m?.recipe.id).toBe('furnace');
    expect(m?.recipe.result.material).toBe('furnace');
    expect(m?.recipe.result.count).toBe(1);
    expect(reg.byNameGet('furnace')?.id).toBe(id('furnace'));
  });

  it('9 个圆石（中间也放）不匹配熔炉', () => {
    const cells = grid(3);
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) put(cells, 3, col, row, blk('cobblestone'));
    expect(matchOf(cells, 3)).toBeNull();
  });

  it('3 圆石 + 3 橡木原木 + 1 煤 → 营火', () => {
    const cells = grid(3);
    put(cells, 3, 0, 0, blk('cobblestone'));
    put(cells, 3, 1, 0, blk('cobblestone'));
    put(cells, 3, 2, 0, blk('cobblestone'));
    put(cells, 3, 0, 1, blk('oak_log'));
    put(cells, 3, 1, 1, blk('oak_log'));
    put(cells, 3, 2, 1, blk('oak_log'));
    put(cells, 3, 0, 2, 'item:coal');
    const m = matchOf(cells, 3);
    expect(m?.recipe.id).toBe('campfire');
    expect(m?.recipe.result.material).toBe('campfire');
    expect(reg.byNameGet('campfire')?.id).toBe(id('campfire'));
  });

  it('材料组 #log：白桦 / 云杉原木也能合成营火', () => {
    for (const log of ['birch_log', 'spruce_log']) {
      const cells = grid(3);
      put(cells, 3, 0, 0, blk('cobblestone'));
      put(cells, 3, 1, 0, blk('cobblestone'));
      put(cells, 3, 2, 0, blk('cobblestone'));
      put(cells, 3, 0, 1, blk(log));
      put(cells, 3, 1, 1, blk(log));
      put(cells, 3, 2, 1, blk(log));
      put(cells, 3, 0, 2, 'item:coal');
      expect(matchOf(cells, 3)?.recipe.id).toBe('campfire');
    }
  });

  it('营火缺煤 / 缺圆石都不匹配', () => {
    const noCoal = grid(3);
    put(noCoal, 3, 0, 0, blk('cobblestone'));
    put(noCoal, 3, 1, 0, blk('cobblestone'));
    put(noCoal, 3, 2, 0, blk('cobblestone'));
    put(noCoal, 3, 0, 1, blk('oak_log'));
    put(noCoal, 3, 1, 1, blk('oak_log'));
    put(noCoal, 3, 2, 1, blk('oak_log'));
    expect(matchOf(noCoal, 3)).toBeNull();

    const noStone = grid(3);
    put(noStone, 3, 0, 0, blk('oak_log'));
    put(noStone, 3, 1, 0, blk('oak_log'));
    put(noStone, 3, 2, 0, blk('oak_log'));
    put(noStone, 3, 0, 1, blk('oak_log'));
    put(noStone, 3, 1, 1, blk('oak_log'));
    put(noStone, 3, 2, 1, blk('oak_log'));
    put(noStone, 3, 0, 2, 'item:coal');
    expect(matchOf(noStone, 3)).toBeNull();
  });

  it('营火配方的材料标识可被 materialToStack 解析', () => {
    const coal = materialToStack('item:coal', reg);
    expect(coal?.kind).toBe('item');
    expect(coal?.id).toBe('coal');
    expect(ITEMS.coal).toBeTruthy();
  });
});
