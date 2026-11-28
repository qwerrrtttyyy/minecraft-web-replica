import { describe, expect, it } from 'vitest';
import { CRAFTING_RECIPES } from '../src/player/crafting';
import { expandMaterial, JEIIndex, jeiKindLabel, searchJEI } from '../src/player/jei';
import { FUEL_UNITS, SMELT_RECIPES, smeltOutputOf } from '../src/player/smelting';

/** 与生产一致的默认索引（纯逻辑，不依赖 DOM / three.js） */
const index = new JEIIndex();
const labelOf = (key: string) => (key.startsWith('item:') ? key.slice(5) : key);

describe('JEI 索引 · 构建倒排表', () => {
  it('内置配方全部进入索引，产物键不重不漏', () => {
    for (const r of CRAFTING_RECIPES) {
      const views = index.recipesFor(r.result.material).filter((v) => v.id === r.id);
      expect(views).toHaveLength(1);
      expect(views[0].output).toBe(r.result.material);
      expect(views[0].count).toBe(r.result.count);
    }
  });

  it('keys 覆盖所有配方产物 / 材料与熔炼产物 / 燃料，且有序去重', () => {
    for (const r of CRAFTING_RECIPES) {
      expect(index.keys).toContain(r.result.material);
      for (const i of r.shapeless ?? []) {
        for (const member of expandMaterial(i)) expect(index.keys).toContain(member);
      }
    }
    for (const material of Object.keys(SMELT_RECIPES)) expect(index.keys).toContain(material);
    for (const fuel of Object.keys(FUEL_UNITS)) expect(index.keys).toContain(fuel);
    const sorted = [...index.keys].sort();
    expect(index.keys).toEqual(sorted);
    expect(new Set(index.keys).size).toBe(index.keys.length);
  });

  it('keys 不含 #planks 等组令牌，只保留展开后的具体材料（避免空图标伪物品）', () => {
    expect(index.keys.some((key) => key.startsWith('#'))).toBe(false);
    expect(index.keys).toContain('oak_planks');
    expect(index.usesFor('oak_planks').some((v) => v.id === 'crafting_table')).toBe(true);
  });

  it('ordered 配方按 pattern 提取输入，空位不产生输入', () => {
    const planks = index.recipesFor('oak_planks')[0];
    expect(planks.inputs).toEqual(['oak_log']);
    const stick = index.recipesFor('item:stick');
    expect(stick.length).toBeGreaterThan(0);
    for (const v of stick) expect(v.inputs.every((i) => i !== ' ')).toBe(true);
  });
});

describe('JEI 索引 · 配方与用途', () => {
  it('熔炼配方以 smelt: 为 id 进入产物索引，与 smelting 表一致', () => {
    for (const [material, output] of Object.entries(SMELT_RECIPES)) {
      const views = index.recipesFor(output).filter((v) => v.kind === 'smelt');
      expect(views.some((v) => v.id === `smelt:${material}`)).toBe(true);
      expect(smeltOutputOf(material)).toBe(output);
    }
  });

  it('燃料条目挂在使用者索引上，kind 为 fuel', () => {
    for (const fuel of Object.keys(FUEL_UNITS)) {
      const views = index.usesFor(fuel).filter((v) => v.kind === 'fuel');
      expect(views.length).toBeGreaterThan(0);
      expect(jeiKindLabel('fuel')).toBe('燃料');
    }
  });

  it('材料组展开：组内任一成员都能查到使用它的配方', () => {
    const members = expandMaterial('#planks');
    expect(members.length).toBeGreaterThan(1);
    for (const m of members) {
      expect(index.usesFor(m).some((v) => v.id === 'crafting_table')).toBe(true);
    }
  });

  it('交叉查询：已知产物的配方同时也是其输入材料的用途', () => {
    const recipe = index.recipesFor('crafting_table')[0];
    expect(recipe).toBeDefined();
    for (const i of recipe.inputs) {
      for (const member of expandMaterial(i)) {
        expect(index.usesFor(member).some((v) => v.id === recipe.id)).toBe(true);
      }
    }
  });
});

describe('JEI 搜索', () => {
  it('空查询返回全量有序列表', () => {
    expect(searchJEI(index.keys, '', labelOf)).toEqual(index.keys);
    expect(searchJEI(index.keys, '  ', labelOf)).toEqual(index.keys);
  });

  it('按键名与显示名做不区分大小写的子串匹配', () => {
    expect(searchJEI(index.keys, 'STICK', labelOf)).toContain('item:stick');
    expect(searchJEI(index.keys, 'stick', labelOf)).toContain('item:stick');
    expect(searchJEI(index.keys, '不存在的东西xyz', labelOf)).toEqual([]);
  });
});
