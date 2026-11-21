import type { TextureAtlas } from '../gfx/atlas';
import type { BlockRegistry } from '../world/blocks';
import { ITEMS } from '../player/survival';
import {
  SMELTING_RECIPES,
  FUEL_VALUES,
  smeltingRecipeOf,
  type MaterialId,
} from '../player/smelting';
import type { CraftingMaterial } from './crafting';

/**
 * 熔炉面板：输入槽 + 燃料剩余 + 进度 + 背包 / 配方。
 * 与合成面板同构——只呈现与交互，背包取放和烧炼推进都交给 FurnaceHost。
 * 关闭面板时把未烧完的输入退回背包；已投入的燃料不退（已开始燃烧）。
 */

export interface FurnaceStateView {
  input: MaterialId | null;
  fuelTime: number;
  progress: number;
}

export interface FurnaceHost {
  getMaterials(): CraftingMaterial[];
  /** 从背包取 1 个材料放入输入槽 */
  take(material: MaterialId): boolean;
  /** 取回输入槽材料并退回背包 */
  removeInput(): void;
  /** 投入燃料，返回增加的时间 */
  putFuel(material: MaterialId): number;
  getState(): FurnaceStateView;
  onClose(): void;
}

const h = (tag: string, cls?: string, text?: string): HTMLElement => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};

export class FurnacePanel {
  readonly root: HTMLElement;
  private inputEl!: HTMLElement;
  private resultEl!: HTMLElement;
  private fuelEl!: HTMLElement;
  private progressEl!: HTMLElement;
  private progressFill!: HTMLElement;
  private bagEl!: HTMLElement;
  private fuelBagEl!: HTMLElement;
  private recipeEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private iconCache = new Map<string, string>();

  constructor(
    private host: FurnaceHost,
    private atlas: TextureAtlas,
    private registry: BlockRegistry,
  ) {
    this.root = h('div', 'overlay furnace-overlay');
    const panel = h('div', 'mc-panel furnace-panel');

    const head = h('div', 'crafting-head');
    head.appendChild(h('div', 'panel-title', '熔炉'));
    const close = h('button', 'mc-btn-small crafting-close', '✕') as HTMLButtonElement;
    close.addEventListener('pointerdown', (e) => e.stopPropagation());
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.host.onClose();
    });
    head.append(close);
    panel.appendChild(head);

    const body = h('div', 'crafting-body');
    this.inputEl = h('button', 'crafting-cell furnace-input');
    this.inputEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.host.getState().input !== null) this.host.removeInput();
      this.refresh();
    });
    body.appendChild(this.inputEl);
    body.appendChild(h('div', 'crafting-arrow', '➜'));
    this.resultEl = h('div', 'crafting-result');
    body.appendChild(this.resultEl);
    panel.appendChild(body);

    this.fuelEl = h('div', 'furnace-fuel', '燃料：0 秒');
    panel.appendChild(this.fuelEl);
    this.progressEl = h('div', 'furnace-progress');
    this.progressFill = h('div', 'furnace-progress-fill');
    this.progressEl.appendChild(this.progressFill);
    panel.appendChild(this.progressEl);

    this.hintEl = h('div', 'crafting-hint', '点下方材料放入输入槽，点燃料投入燃烧');
    panel.appendChild(this.hintEl);

    panel.appendChild(h('div', 'crafting-bag-title', '可烧炼材料'));
    this.bagEl = h('div', 'crafting-bag');
    panel.appendChild(this.bagEl);

    panel.appendChild(h('div', 'crafting-bag-title', '燃料'));
    this.fuelBagEl = h('div', 'crafting-bag');
    panel.appendChild(this.fuelBagEl);

    panel.appendChild(h('div', 'crafting-bag-title', '配方'));
    this.recipeEl = h('div', 'crafting-recipes');
    panel.appendChild(this.recipeEl);

    this.root.appendChild(panel);
    this.root.style.display = 'none';
  }

  get isOpen() {
    return this.root.style.display !== 'none';
  }

  show() {
    this.root.style.display = '';
    this.refresh();
  }

  /** 关闭：未烧完的输入退回背包 */
  hide() {
    if (this.host.getState().input !== null) this.host.removeInput();
    this.root.style.display = 'none';
  }

  /** 每帧刷新进度（面板打开时由 HUD 调用） */
  updateProgress() {
    if (!this.isOpen) return;
    const state = this.host.getState();
    this.fuelEl.textContent = `燃料：${Math.ceil(state.fuelTime)} 秒`;
    this.progressFill.style.width = `${Math.round(state.progress * 100)}%`;
  }

  private refresh() {
    const state = this.host.getState();
    this.inputEl.innerHTML = '';
    this.inputEl.classList.toggle('ready', state.input !== null);
    if (state.input) {
      const img = h('img') as HTMLImageElement;
      img.src = this.iconOf(state.input);
      img.alt = this.labelOf(state.input);
      img.draggable = false;
      this.inputEl.appendChild(img);
    }

    this.resultEl.innerHTML = '';
    const recipe = state.input ? smeltingRecipeOf(state.input) : undefined;
    this.resultEl.classList.toggle('ready', !!recipe);
    if (recipe) {
      const img = h('img') as HTMLImageElement;
      img.src = this.iconOf(recipe.output);
      img.alt = this.labelOf(recipe.output);
      img.draggable = false;
      this.resultEl.appendChild(img);
    }
    this.updateProgress();

    this.renderBag();
    this.renderRecipes();
  }

  private renderBag() {
    const materials = this.host.getMaterials();
    this.bagEl.innerHTML = '';
    this.fuelBagEl.innerHTML = '';
    let hasSmeltable = false;
    let hasFuel = false;
    for (const m of materials) {
      if (smeltingRecipeOf(m.material)) {
        hasSmeltable = true;
        this.bagEl.appendChild(this.chip(m, () => {
          if (!this.host.take(m.material)) this.hintEl.textContent = '背包材料不足';
          this.refresh();
        }));
      }
      if (FUEL_VALUES[m.material]) {
        hasFuel = true;
        this.fuelBagEl.appendChild(this.chip(m, () => {
          const add = this.host.putFuel(m.material);
          this.hintEl.textContent = add > 0 ? `燃料 +${add} 秒` : '投入失败';
          this.refresh();
        }));
      }
    }
    if (!hasSmeltable) this.bagEl.appendChild(h('div', 'crafting-bag-empty', '没有可烧炼的矿物'));
    if (!hasFuel) this.fuelBagEl.appendChild(h('div', 'crafting-bag-empty', '没有可用燃料（煤 / 木板 / 木棍 / 原木）'));
  }

  private chip(m: CraftingMaterial, onClick: () => void): HTMLElement {
    const chip = h('button', 'crafting-chip');
    const img = h('img') as HTMLImageElement;
    img.src = this.iconOf(m.material);
    img.alt = this.labelOf(m.material);
    img.draggable = false;
    chip.append(img, h('span', 'crafting-count', `x${m.count}`));
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return chip;
  }

  private renderRecipes() {
    this.recipeEl.innerHTML = '';
    for (const recipe of SMELTING_RECIPES) {
      const row = h('button', 'crafting-recipe');
      const img = h('img') as HTMLImageElement;
      img.src = this.iconOf(recipe.input);
      img.alt = this.labelOf(recipe.input);
      img.draggable = false;
      row.appendChild(img);
      row.appendChild(h('span', 'crafting-recipe-label', recipe.label));
      const res = h('span', 'crafting-recipe-result');
      const out = h('img') as HTMLImageElement;
      out.src = this.iconOf(recipe.output);
      out.alt = this.labelOf(recipe.output);
      out.draggable = false;
      res.append(out, h('span', 'crafting-count', `x1 · ${recipe.time}s`));
      row.appendChild(res);
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.host.getState().input !== null) this.host.removeInput();
        if (!this.host.take(recipe.input)) {
          this.hintEl.textContent = `材料不足，无法烧炼「${recipe.label}」`;
        }
        this.refresh();
      });
      this.recipeEl.appendChild(row);
    }
  }

  private iconOf(material: MaterialId): string {
    const cached = this.iconCache.get(material);
    if (cached) return cached;
    let url = '';
    if (material.startsWith('item:')) {
      const item = ITEMS[material.slice(5)];
      if (item) url = this.atlas.itemIcon(item.tile, 48).toDataURL();
    } else {
      const def = this.registry.byNameGet(material);
      if (def) url = this.atlas.icon(def, 48).toDataURL();
    }
    this.iconCache.set(material, url);
    return url;
  }

  private labelOf(material: MaterialId): string {
    if (material.startsWith('item:')) {
      const item = ITEMS[material.slice(5)];
      return item ? item.label : material;
    }
    return this.registry.byNameGet(material)?.label ?? material;
  }
}
