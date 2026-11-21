import type { TextureAtlas } from '../gfx/atlas';
import type { BlockRegistry } from '../world/blocks';
import { ITEMS } from '../player/survival';
import {
  CRAFTING_GROUPS,
  CRAFTING_RECIPES,
  matchRecipe,
  recipeFits,
  type MaterialId,
  type Recipe,
  type RecipeResult,
} from '../player/crafting';

/**
 * 合成界面（工作台 3×3 与个人合成格 2×2 共用同一套代码）。
 *
 * 只管呈现与交互，**不直接碰 SurvivalState**：
 * 背包的取放与产出都通过 CraftingHost 回调交给组装根，
 * 这样 UI 层不需要知道背包是 Map 还是槽位数组。
 *
 * 交互刻意做成「点击」而非拖拽（移动端友好）：
 * - 点空格 → 选中它（高亮）
 * - 点背包条目 → 放进选中的格子
 * - 点已填的格子 → 退回背包
 * - 点结果槽 → 合成
 * - 点配方条目 → 按配方图案自动摆放（材料不足会提示）
 */

export interface CraftingMaterial {
  material: MaterialId;
  count: number;
}

/** 背包宿主：由组装根实现 */
export interface CraftingHost {
  /** 背包里可用的材料（合成界面底部的背包区） */
  getMaterials(): CraftingMaterial[];
  /** 从背包取出 1 个材料；不足返回 false */
  take(material: MaterialId): boolean;
  /** 把 1 个材料退回背包 */
  giveBack(material: MaterialId): void;
  /** 产出进背包 */
  produce(material: MaterialId, count: number): void;
  /** 产物能否被背包接受（装备不可堆叠时防止材料被白白消耗）；缺省视为可接受 */
  canProduce?(material: MaterialId): boolean;
  /** 合成成功的反馈（音效 / 提示） */
  onCrafted(recipe: Recipe, result: RecipeResult): void;
  /** 用户关闭合成界面（回到菜单或继续游戏） */
  onClose(): void;
}

const h = (tag: string, cls?: string, text?: string): HTMLElement => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};

/** 材料组（'#planks'）展开成具体材料列表 */
function groupMembers(slot: string): string[] {
  if (!slot.startsWith('#')) return [slot];
  return CRAFTING_GROUPS[slot.slice(1)] ?? [];
}
export class CraftingPanel {
  readonly root: HTMLElement;
  private titleEl!: HTMLElement;
  private gridEl!: HTMLElement;
  private resultEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private bagEl!: HTMLElement;
  private recipeEl!: HTMLElement;

  /** 网格内容：每格 1 个材料（数量在背包侧，这里只记"放了什么"） */
  private cells: (MaterialId | null)[] = [];
  private size = 3;
  private selected = -1;
  private iconCache = new Map<string, string>();

  constructor(
    private host: CraftingHost,
    private atlas: TextureAtlas,
    private registry: BlockRegistry,
  ) {
    this.root = h('div', 'overlay crafting-overlay');
    const panel = h('div', 'mc-panel crafting-panel');

    const head = h('div', 'crafting-head');
    this.titleEl = h('div', 'panel-title', '工作台');
    const close = h('button', 'mc-btn-small crafting-close', '✕') as HTMLButtonElement;
    close.addEventListener('pointerdown', (e) => e.stopPropagation());
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.host.onClose();
    });
    head.append(this.titleEl, close);
    panel.appendChild(head);

    const body = h('div', 'crafting-body');
    this.gridEl = h('div', 'crafting-grid');
    body.appendChild(this.gridEl);
    body.appendChild(h('div', 'crafting-arrow', '➜'));
    this.resultEl = h('button', 'crafting-result');
    this.resultEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.craft();
    });
    body.appendChild(this.resultEl);
    panel.appendChild(body);

    this.hintEl = h('div', 'crafting-hint', '');
    panel.appendChild(this.hintEl);

    panel.appendChild(h('div', 'crafting-bag-title', '背包'));
    this.bagEl = h('div', 'crafting-bag');
    panel.appendChild(this.bagEl);

    panel.appendChild(h('div', 'crafting-bag-title', '配方'));
    this.recipeEl = h('div', 'crafting-recipes');
    panel.appendChild(this.recipeEl);

    this.root.appendChild(panel);
    this.root.style.display = 'none';
  }

  get isOpen() {
    return this.root.style.display !== 'none';
  }

  /** 打开合成界面。size: 2 = 个人合成格，3 = 工作台 */
  show(size: 2 | 3, title: string) {
    this.size = size;
    this.titleEl.textContent = title;
    this.cells = new Array(size * size).fill(null);
    this.selected = -1;
    this.buildGrid();
    this.root.style.display = '';
    this.refresh();
  }

  /** 关闭界面：把网格里剩下的材料全部退回背包，避免玩家丢东西 */
  hide() {
    for (const cell of this.cells) {
      if (cell !== null) this.host.giveBack(cell);
    }
    this.cells = new Array(this.size * this.size).fill(null);
    this.selected = -1;
    this.root.style.display = 'none';
  }

  private buildGrid() {
    this.gridEl.innerHTML = '';
    this.gridEl.dataset.size = String(this.size);
    for (let i = 0; i < this.size * this.size; i++) {
      const slot = h('div', 'crafting-cell');
      slot.dataset.index = String(i);
      slot.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onCellClick(i);
      });
      this.gridEl.appendChild(slot);
    }
  }

  /** 点格子：空的→选中；已填的→退回背包并选中该格 */
  private onCellClick(index: number) {
    const cell = this.cells[index];
    if (cell !== null) {
      this.host.giveBack(cell);
      this.cells[index] = null;
    }
    this.selected = index;
    this.refresh();
  }

  /** 点背包条目：放进选中的格子 */
  private onBagClick(material: MaterialId) {
    const target = this.selected >= 0 ? this.selected : this.cells.indexOf(null);
    if (target < 0) {
      this.hintEl.textContent = '合成格已满';
      return;
    }
    if (this.cells[target] !== null) {
      this.hintEl.textContent = '该格已有材料，先点它退回背包';
      return;
    }
    if (!this.host.take(material)) {
      this.hintEl.textContent = '材料不足';
      return;
    }
    this.cells[target] = material;
    this.refresh();
  }

  /** 按配方自动摆放；材料不足返回 false */
  private autoFill(recipe: Recipe): boolean {
    // 每个格子需要的材料（材料组已展开成候选列表）；空位为 null
    const need: (string[] | null)[] = new Array(this.size * this.size).fill(null);
    if (recipe.pattern && recipe.key) {
      const rows = recipe.pattern;
      const cols = Math.max(...rows.map((r) => r.length));
      if (rows.length > this.size || cols > this.size) return false;
      // 图案左上角对齐到网格左上角，其余格子留空
      for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < cols; c++) {
          const ch = rows[r][c] ?? ' ';
          if (ch === ' ') continue;
          const slot = recipe.key[ch];
          if (!slot) return false;
          need[r * this.size + c] = groupMembers(slot);
        }
      }
    } else if (recipe.shapeless) {
      // 无序配方：从左上角依次摆放
      const slots = recipe.shapeless;
      if (slots.length > this.cells.length) return false;
      for (let i = 0; i < slots.length; i++) need[i] = groupMembers(slots[i]);
    } else {
      return false;
    }

    // 为每个需求格挑一个背包里真实存在的材料
    const bag = this.host.getMaterials();
    const plan: (MaterialId | null)[] = new Array(this.size * this.size).fill(null);
    const used = new Map<MaterialId, number>();
    for (let i = 0; i < need.length; i++) {
      const options = need[i];
      if (!options || options.length === 0) continue; // 空位
      const pick = options.find((o) => {
        const entry = bag.find((b) => b.material === o);
        if (!entry) return false;
        return (used.get(o) ?? 0) < entry.count;
      });
      if (!pick) return false;
      plan[i] = pick;
      used.set(pick, (used.get(pick) ?? 0) + 1);
    }

    // 先把旧材料退回背包，再摆新的
    for (const cell of this.cells) if (cell !== null) this.host.giveBack(cell);
    this.cells = new Array(this.size * this.size).fill(null);
    for (let i = 0; i < plan.length; i++) {
      const material = plan[i];
      if (!material) continue;
      if (!this.host.take(material)) {
        // 理论上不会发生（前面已核对数量），真发生就整体回退
        for (const c of this.cells) if (c !== null) this.host.giveBack(c);
        this.cells = new Array(this.size * this.size).fill(null);
        return false;
      }
      this.cells[i] = material;
    }
    return true;
  }

  private refresh() {
    // 格子
    for (let i = 0; i < this.cells.length; i++) {
      const el = this.gridEl.children[i] as HTMLElement;
      el.innerHTML = '';
      el.classList.toggle('selected', i === this.selected);
      const cell = this.cells[i];
      if (cell === null) continue;
      const img = h('img') as HTMLImageElement;
      img.src = this.iconOf(cell);
      img.alt = this.labelOf(cell);
      img.draggable = false;
      el.appendChild(img);
    }

    // 结果槽
    const match = matchRecipe(this.cells, this.size);
    this.resultEl.innerHTML = '';
    this.resultEl.classList.toggle('ready', !!match);
    if (match) {
      const img = h('img') as HTMLImageElement;
      img.src = this.iconOf(match.result.material);
      img.alt = this.labelOf(match.result.material);
      img.draggable = false;
      this.resultEl.append(img, h('span', 'crafting-count', `x${match.result.count}`));
      this.hintEl.textContent = `点击右侧合成：${match.recipe.label}`;
    } else {
      this.hintEl.textContent = this.cells.some((c) => c !== null)
        ? '摆放不符合任何配方（可点下方配方自动摆放）'
        : '点格子选中，再点背包材料放入';
    }

    this.renderBag();
    this.renderRecipes();
  }

  /** 背包区 */
  private renderBag() {
    this.bagEl.innerHTML = '';
    const materials = this.host.getMaterials();
    if (materials.length === 0) {
      this.bagEl.appendChild(h('div', 'crafting-bag-empty', '背包里没有可用材料'));
    }
    for (const m of materials) {
      const chip = h('button', 'crafting-chip');
      const img = h('img') as HTMLImageElement;
      img.src = this.iconOf(m.material);
      img.alt = this.labelOf(m.material);
      img.draggable = false;
      chip.append(img, h('span', 'crafting-count', `x${m.count}`));
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onBagClick(m.material);
      });
      this.bagEl.appendChild(chip);
    }
  }

  /** 配方区：图案 + 产物，点击可自动摆放 */
  private renderRecipes() {
    this.recipeEl.innerHTML = '';
    for (const recipe of CRAFTING_RECIPES) {
      if (!recipeFits(recipe, this.size)) continue;
      const row = h('button', 'crafting-recipe');
      row.appendChild(this.patternView(recipe));
      row.appendChild(h('span', 'crafting-recipe-label', recipe.label));
      const res = h('span', 'crafting-recipe-result');
      const img = h('img') as HTMLImageElement;
      img.src = this.iconOf(recipe.result.material);
      img.alt = this.labelOf(recipe.result.material);
      img.draggable = false;
      res.append(img, h('span', 'crafting-count', `x${recipe.result.count}`));
      row.appendChild(res);
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!this.autoFill(recipe)) {
          this.hintEl.textContent = `材料不足，无法摆放「${recipe.label}」`;
        }
        this.refresh();
      });
      this.recipeEl.appendChild(row);
    }
  }

  /** 配方的迷你图案视图 */
  private patternView(recipe: Recipe): HTMLElement {
    const box = h('span', 'crafting-pattern');
    if (recipe.pattern && recipe.key) {
      const rows = recipe.pattern;
      const cols = Math.max(...rows.map((r) => r.length));
      for (let r = 0; r < rows.length; r++) {
        for (let c = 0; c < cols; c++) {
          const ch = rows[r][c] ?? ' ';
          const cell = h('i', 'crafting-pattern-cell');
          if (ch !== ' ') {
            const slot = recipe.key![ch];
            const first = groupMembers(slot)[0];
            if (first) {
              const img = h('img') as HTMLImageElement;
              img.src = this.iconOf(first);
              img.alt = '';
              img.draggable = false;
              cell.appendChild(img);
            }
          }
          box.appendChild(cell);
        }
      }
    } else {
      for (const slot of recipe.shapeless ?? []) {
        const cell = h('i', 'crafting-pattern-cell');
        const first = groupMembers(slot)[0];
        if (first) {
          const img = h('img') as HTMLImageElement;
          img.src = this.iconOf(first);
          img.alt = '';
          img.draggable = false;
          cell.appendChild(img);
        }
        box.appendChild(cell);
      }
    }
    return box;
  }

  /** 点击结果槽 → 合成 */
  private craft() {
    const match = matchRecipe(this.cells, this.size);
    if (!match) return;
    // 装备不可堆叠：背包已有同类时先拦住，避免材料扣了却拿不到产物
    if (this.host.canProduce && !this.host.canProduce(match.result.material)) {
      this.hintEl.textContent = '背包已有该装备，无法合成更多';
      return;
    }
    // 网格里的材料在放入时已从背包取出，这里直接消耗并产出
    for (const idx of match.cells) this.cells[idx] = null;
    this.selected = -1;
    this.host.produce(match.result.material, match.result.count);
    this.host.onCrafted(match.recipe, match.result);
    this.refresh();
  }

  /** 材料 → 图标 URL（方块用等距图，物品用扁平精灵） */
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

  /** 材料 → 显示名 */
  private labelOf(material: MaterialId): string {
    if (material.startsWith('item:')) {
      const item = ITEMS[material.slice(5)];
      return item ? item.label : material;
    }
    return this.registry.byNameGet(material)?.label ?? material;
  }
}
