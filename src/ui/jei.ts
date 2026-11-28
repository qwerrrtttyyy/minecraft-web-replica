import type { TextureAtlas } from '../gfx/atlas';
import { expandMaterial, JEIIndex, type JEIRecipeView, jeiKindLabel, type MaterialId, searchJEI } from '../player/jei';
import { ITEMS } from '../player/survival';
import type { BlockRegistry } from '../world/blocks';

/**
 * JEI 物品管理器面板（实验性玩法）。
 *
 * 只读索引 UI：左侧物品格 + 搜索框，右侧选中物品的「配方（怎么做）/ 用途（用在哪）」。
 * 与 CraftingPanel 同款交互约定——点击而非拖拽，移动端友好。
 * 面板样式通过注入一次 <style> 自包含，不侵入全局样式表。
 */

export interface JeiHost {
  /** 用户点击关闭（组装根负责恢复输入 / 指针锁） */
  onClose(): void;
}

const PANEL_CSS = `
.jei-overlay{position:fixed;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55)}
.jei-panel{width:min(720px,92vw);max-height:86vh;display:flex;flex-direction:column;gap:8px;padding:12px}
.jei-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:2px}
.jei-search{width:100%;box-sizing:border-box;padding:6px 10px;background:#1c1c1c;color:#eee;border:2px solid #5a5a5a;font:14px/1.4 inherit}
.jei-body{display:flex;gap:10px;min-height:0;flex:1}
.jei-list{flex:1.1;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(56px,1fr));gap:4px;align-content:start;padding:4px;background:#141414;border:2px solid #3a3a3a;max-height:60vh}
.jei-detail{flex:1.4;overflow-y:auto;padding:6px;background:#141414;border:2px solid #3a3a3a;max-height:60vh}
.jei-item{position:relative;width:56px;height:56px;padding:0;border:2px solid #5a5a5a;background:#2a2a2a;cursor:pointer}
.jei-item.sel{border-color:#fff;background:#3d3d3d}
.jei-item img{width:100%;height:100%;image-rendering:pixelated}
.jei-recipe{margin-bottom:10px;padding:6px;background:#1e1e1e;border:1px solid #333}
.jei-recipe-title{font-size:12px;color:#9ad1ff;margin-bottom:4px}
.jei-flow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.jei-slot{display:inline-flex;align-items:center;gap:2px;padding:2px;background:#2a2a2a;border:2px solid #5a5a5a}
.jei-slot img{width:28px;height:28px;image-rendering:pixelated}
.jei-slot span{font-size:11px;color:#ccc}
.jei-arrow{color:#bbb;font-size:16px}
.jei-empty{color:#888;font-size:13px;padding:4px}
.jei-name{font-weight:bold;color:#fff;margin-bottom:2px}
`;

export class JeiPanel {
  readonly root: HTMLElement;
  private searchEl!: HTMLInputElement;
  private listEl!: HTMLElement;
  private detailEl!: HTMLElement;
  private selected: MaterialId | null = null;
  private iconCache = new Map<string, string>();
  private index = new JEIIndex();

  constructor(
    private host: JeiHost,
    private atlas: TextureAtlas,
    private registry: BlockRegistry,
  ) {
    // 样式只注入一次（多实例也安全）
    if (!document.getElementById('jei-panel-css')) {
      const style = document.createElement('style');
      style.id = 'jei-panel-css';
      style.textContent = PANEL_CSS;
      document.head.appendChild(style);
    }

    const mk = (tag: string, cls?: string, text?: string): HTMLElement => {
      const el = document.createElement(tag);
      if (cls) el.className = cls;
      if (text !== undefined) el.textContent = text;
      return el;
    };

    this.root = mk('div', 'overlay jei-overlay');
    const panel = mk('div', 'mc-panel jei-panel');

    const head = mk('div', 'jei-head');
    head.appendChild(mk('div', 'panel-title', 'JEI 物品管理器'));
    const close = mk('button', 'mc-btn-small crafting-close', '✕') as HTMLButtonElement;
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.host.onClose();
    });
    head.appendChild(close);
    panel.appendChild(head);

    this.searchEl = document.createElement('input');
    this.searchEl.className = 'jei-search';
    this.searchEl.placeholder = '搜索物品 / 配方（按显示名或英文 id）';
    this.searchEl.addEventListener('input', () => this.refresh());
    panel.appendChild(this.searchEl);

    const body = mk('div', 'jei-body');
    this.listEl = mk('div', 'jei-list');
    this.detailEl = mk('div', 'jei-detail');
    this.detailEl.appendChild(mk('div', 'jei-empty', '左侧选择一个物品查看配方与用途'));
    body.append(this.listEl, this.detailEl);
    panel.appendChild(body);

    this.root.appendChild(panel);
    this.root.style.display = 'none';
  }

  get isOpen() {
    return this.root.style.display !== 'none';
  }

  show() {
    this.selected = null;
    this.searchEl.value = '';
    this.refresh();
    this.root.style.display = '';
  }

  hide() {
    this.root.style.display = 'none';
  }

  /** 重建物品列表（按搜索词过滤） */
  private refresh() {
    this.listEl.replaceChildren();
    const keys = searchJEI(this.index.keys, this.searchEl.value, (k) => this.labelOf(k));
    for (const key of keys.slice(0, 200)) {
      const btn = document.createElement('button');
      btn.className = 'jei-item' + (key === this.selected ? ' sel' : '');
      btn.title = `${this.labelOf(key)}（${key}）`;
      const img = document.createElement('img');
      img.src = this.iconOf(key);
      img.alt = '';
      btn.appendChild(img);
      btn.addEventListener('click', () => {
        this.selected = key;
        this.refresh();
        this.showDetail(key);
      });
      this.listEl.appendChild(btn);
    }
    if (keys.length === 0) this.listEl.appendChild(mkEmpty('没有匹配的物品'));
  }

  /** 渲染选中物品的配方 / 用途明细 */
  private showDetail(key: MaterialId) {
    this.detailEl.replaceChildren();
    const name = mkEl('div', 'jei-name', `${this.labelOf(key)}（${key}）`);
    this.detailEl.appendChild(name);

    const recipes = this.index.recipesFor(key);
    this.detailEl.appendChild(
      mkEl('div', 'jei-recipe-title', recipes.length ? '配方（怎么做）' : '配方：暂无（自然生成 / 掉落获得）'),
    );
    for (const view of recipes) this.detailEl.appendChild(this.recipeEl(view));

    const uses = this.index.usesFor(key);
    this.detailEl.appendChild(mkEl('div', 'jei-recipe-title', uses.length ? '用途（用在哪）' : '用途：暂无'));
    for (const view of uses) this.detailEl.appendChild(this.recipeEl(view));
  }

  /** 一条配方的「材料 → 产物」流式展示 */
  private recipeEl(view: JEIRecipeView): HTMLElement {
    const box = document.createElement('div');
    box.className = 'jei-recipe';
    box.appendChild(mkEl('div', 'jei-recipe-title', `${jeiKindLabel(view.kind)} · ${view.label}`));
    const flow = document.createElement('div');
    flow.className = 'jei-flow';
    if (view.kind === 'fuel') {
      flow.appendChild(this.slotEl(view.output, 1));
      flow.appendChild(mkEl('span', 'jei-arrow', '→ 可作为熔炉 / 营火的燃料'));
    } else {
      const inputs = new Set<string>();
      for (const i of view.inputs) for (const m of expandMaterial(i)) inputs.add(m);
      let n = 0;
      for (const m of inputs) {
        if (n++ > 0) flow.appendChild(mkEl('span', 'jei-arrow', '+'));
        flow.appendChild(this.slotEl(m, 1));
      }
      flow.appendChild(mkEl('span', 'jei-arrow', '➜'));
      flow.appendChild(this.slotEl(view.output, view.count));
    }
    box.appendChild(flow);
    return box;
  }

  /** 单个材料槽：图标 + 数量 */
  private slotEl(material: MaterialId, count: number): HTMLElement {
    const slot = document.createElement('span');
    slot.className = 'jei-slot';
    const img = document.createElement('img');
    img.src = this.iconOf(material);
    img.alt = '';
    slot.appendChild(img);
    if (count > 1) slot.appendChild(document.createElement('span')!).textContent = String(count);
    slot.title = this.labelOf(material);
    return slot;
  }

  /** 材料 → 图标 URL（方块用等距图，物品用扁平精灵），与合成界面同一套取图 */
  private iconOf(material: MaterialId): string {
    const cached = this.iconCache.get(material);
    if (cached !== undefined) return cached;
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

const mkEl = (tag: string, cls?: string, text?: string): HTMLElement => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};
const mkEmpty = (text: string): HTMLElement => mkEl('div', 'jei-empty', text);
