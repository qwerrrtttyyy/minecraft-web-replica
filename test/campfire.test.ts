// @vitest-environment jsdom
/**
 * 营火「直接烤」面板回归（Vitest + jsdom，直接消费 src TS 源码）。
 * 运行：npx vitest run test/campfire.test.ts
 *
 * 覆盖：可烤物判定（与熔炉共用 smeltOutputOf）、点输出即时烤熟 1 个、
 * 不可烤材料被拒、点输入取回、关闭面板把槽内材料退回背包。
 */
import { describe, expect, it, vi } from 'vitest';

import { CampfirePanel } from '../src/ui/campfire';
import { smeltOutputOf } from '../src/player/smelting';
import { ITEMS } from '../src/player/survival';
import type { TextureAtlas } from '../src/gfx/atlas';
import type { BlockRegistry } from '../src/world/blocks';
import type { CraftingHost, CraftingMaterial } from '../src/ui/crafting';
import type { MaterialId } from '../src/player/crafting';

/** 背包宿主：记录取走 / 退回 / 产出，不依赖 SurvivalState。 */
class FakeHost {
  readonly bag = new Map<string, number>();
  readonly produced: CraftingMaterial[] = [];

  add(material: string, count: number) {
    this.bag.set(material, (this.bag.get(material) ?? 0) + count);
  }

  getMaterials(): CraftingMaterial[] {
    return [...this.bag].map(([material, count]) => ({ material: material as MaterialId, count }));
  }

  take(material: MaterialId): boolean {
    const left = this.bag.get(material) ?? 0;
    if (left <= 0) return false;
    if (left === 1) this.bag.delete(material);
    else this.bag.set(material, left - 1);
    return true;
  }

  giveBack(material: MaterialId): void {
    this.bag.set(material, (this.bag.get(material) ?? 0) + 1);
  }

  produce(material: MaterialId, count: number): void {
    this.produced.push({ material, count });
  }
}

const atlas = {
  itemIcon: () => ({ toDataURL: () => 'data:image/png;base64,x' }),
  icon: () => ({ toDataURL: () => 'data:image/png;base64,x' }),
} as unknown as TextureAtlas;

const registry = {
  byNameGet: (name: string) => (name ? { id: 1, name, label: name } : undefined),
} as unknown as BlockRegistry;

function makePanel(host: FakeHost, onClose = vi.fn()) {
  return new CampfirePanel(host as unknown as CraftingHost, atlas, registry, onClose);
}

function clickSlot(panel: CampfirePanel, slot: 'input' | 'output') {
  const btn = panel.root.querySelector<HTMLButtonElement>(`.cooking-slot[data-slot="${slot}"]`);
  expect(btn, `缺少 ${slot} 槽`).not.toBeNull();
  btn!.click();
}

function clickChip(panel: CampfirePanel, label: string) {
  const imgs = [...panel.root.querySelectorAll<HTMLImageElement>('.crafting-chip img')];
  const img = imgs.find((i) => i.alt === label);
  expect(img, `背包里没有 ${label}`).toBeDefined();
  (img!.closest('button') as HTMLButtonElement).click();
}

describe('营火直接烤', () => {
  it('可烤物判定与熔炉共用 smeltOutputOf', () => {
    expect(smeltOutputOf('beef')).toBe('cooked_beef');
    expect(smeltOutputOf('porkchop')).toBe('cooked_porkchop');
    expect(smeltOutputOf('rabbit_meat')).toBe('cooked_rabbit');
    expect(smeltOutputOf('sand')).toBe('glass');
    expect(smeltOutputOf('apple')).toBeNull();
  });

  it('点输出即时烤熟 1 个，再点取出进背包', () => {
    const host = new FakeHost();
    host.add('item:beef', 2);
    const panel = makePanel(host);
    panel.show(0, 0, 0);

    clickChip(panel, ITEMS.beef.label);
    clickSlot(panel, 'output');
    expect(host.bag.get('item:beef')).toBe(1);
    expect(host.produced).toEqual([]);

    clickSlot(panel, 'output');
    expect(host.produced).toEqual([{ material: 'item:cooked_beef', count: 1 }]);
    panel.hide();
  });

  it('不可烤材料被拒绝，不占用输入槽', () => {
    const host = new FakeHost();
    host.add('item:apple', 1);
    const panel = makePanel(host);
    panel.show(0, 0, 0);

    clickChip(panel, ITEMS.apple.label);
    const input = panel.root.querySelector<HTMLButtonElement>('.cooking-slot[data-slot="input"]');
    expect(input?.querySelector('img')).toBeNull();
    expect(host.bag.get('item:apple')).toBe(1);
    panel.hide();
  });

  it('点输入槽把材料退回背包', () => {
    const host = new FakeHost();
    host.add('item:rabbit_meat', 1);
    const panel = makePanel(host);
    panel.show(0, 0, 0);

    clickChip(panel, ITEMS.rabbit_meat.label);
    clickSlot(panel, 'input');
    expect(host.bag.get('item:rabbit_meat')).toBe(1);
    panel.hide();
  });

  it('关闭面板把输入与输出退回背包，不吞物品', () => {
    const host = new FakeHost();
    // 放 2 个生牛肉：烤 1 个后输入槽仍剩 1 个，才能同时验证两槽退回
    host.add('item:beef', 2);
    const panel = makePanel(host);
    panel.show(0, 0, 0);

    clickChip(panel, ITEMS.beef.label);
    clickChip(panel, ITEMS.beef.label);
    clickSlot(panel, 'output');
    panel.hide();
    expect(host.bag.get('item:beef')).toBe(1);
    expect(host.bag.get('item:cooked_beef')).toBe(1);
  });
});
