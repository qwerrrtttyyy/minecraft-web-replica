import type { TextureAtlas } from '../gfx/atlas';
import { type FurnaceCell, type Slot, SMELT_SECONDS } from '../player/smelting';
import { ITEMS } from '../player/survival';
import type { BlockRegistry } from '../world/blocks';

/**
 * 熔炉烧炼界面：输入 / 燃料 / 输出三槽 + 火焰与箭头进度。
 * 与合成面板同风格（mc-panel overlay），逻辑经 FurnaceHost 回调落到 smelting 模块。
 */

const h = (tag: string, cls?: string, text?: string): HTMLElement => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};

export interface FurnaceHost {
  /** 当前熔炉的运行时状态（无则给空槽） */
  cell(): FurnaceCell;
  /** 背包里可用的材料（与合成面板同口径） */
  getMaterials(): { material: string; count: number }[];
  /** 点背包物品：烧炼材料进输入槽 / 燃料进燃料槽（各 1 个）；返回是否成功 */
  put(material: string): boolean;
  /** 点输入 / 燃料槽：把该槽全部退回背包 */
  returnSlot(slot: 'input' | 'fuel'): void;
  /** 点输出槽：产物全部收进背包 */
  collect(): void;
  /** 用户关闭界面 */
  onClose(): void;
}

export class FurnacePanel {
  readonly root: HTMLElement;
  private inputEl!: HTMLElement;
  private fuelEl!: HTMLElement;
  private outputEl!: HTMLElement;
  private flameEl!: HTMLElement;
  private arrowEl!: HTMLElement;
  private bagEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private iconCache = new Map<string, string>();

  constructor(
    private host: FurnaceHost,
    private atlas: TextureAtlas,
    private registry: BlockRegistry,
  ) {
    this.root = h('div', 'overlay crafting-overlay');
    const panel = h('div', 'mc-panel crafting-panel furnace-panel');

    const head = h('div', 'crafting-head');
    this.titleEl = h('div', 'panel-title', '熔炉');
    const close = h('button', 'mc-btn-small crafting-close', '✕') as HTMLButtonElement;
    close.addEventListener('pointerdown', (e) => e.stopPropagation());
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.host.onClose();
    });
    head.append(this.titleEl, close);
    panel.appendChild(head);

    const body = h('div', 'crafting-body furnace-body');
    this.inputEl = this.slot('furnace-input', () => this.host.returnSlot('input'));
    const column = h('div', 'furnace-column');
    this.flameEl = h('div', 'furnace-flame');
    this.arrowEl = h('div', 'furnace-arrow', '?');

    column.append(this.flameEl, this.arrowEl);
    this.fuelEl = this.slot('furnace-fuel', () => this.host.returnSlot('fuel'));
    body.append(this.inputEl, column, this.fuelEl);
    panel.appendChild(body);

    const outRow = h('div', 'furnace-out-row');
    this.outputEl = this.slot('furnace-output', () => this.host.collect());
    outRow.appendChild(this.outputEl);
    panel.appendChild(outRow);

    panel.appendChild(h('div', 'crafting-bag-title', '背包'));
    this.bagEl = h('div', 'crafting-bag');
    panel.appendChild(this.bagEl);

    this.root.appendChild(panel);
    this.root.style.display = 'none';
  }

  private slot(cls: string, onClick: () => void): HTMLElement {
    const el = h('div', `crafting-cell furnace-slot ${cls}`);
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
      // 暂停态主循环不刷新，槽位变动后立即重绘避免显示陈旧数据
      this.refresh();
    });
    return el;
  }

  get isOpen() {
    return this.root.style.display !== 'none';
  }

  show(title = '熔炉') {
    this.titleEl.textContent = title;
    this.root.style.display = '';
    this.refresh();
  }

  hide() {
    this.root.style.display = 'none';
  }

  /** 由主循环在打开期间调用：刷新三槽 / 火焰 / 箭头 / 背包 */
  refresh() {
    if (!this.isOpen) return;
    const cell = this.host.cell();
    this.renderSlot(this.inputEl, cell.input);
    this.renderSlot(this.fuelEl, cell.fuel);
    this.renderSlot(this.outputEl, cell.output);
    this.flameEl.style.setProperty('--burn', cell.burnMax > 0 ? `${cell.burn / cell.burnMax}` : '0');
    this.arrowEl.style.setProperty('--progress', `${Math.min(1, cell.progress / SMELT_SECONDS)}`);
    this.renderBag();
  }

  private renderSlot(el: HTMLElement, slot: Slot | null) {
    el.textContent = '';
    if (!slot) return;
    const icon = h('div', 'crafting-icon');
    const url = this.iconUrl(slot.material);
    if (url) icon.style.backgroundImage = `url(${url})`;
    el.append(icon, h('div', 'crafting-count', String(slot.count)));
  }

  private renderBag() {
    this.bagEl.textContent = '';
    for (const { material, count } of this.host.getMaterials()) {
      const cell = h('div', 'crafting-bag-item');
      const icon = h('div', 'crafting-icon');
      const url = this.iconUrl(material);
      if (url) icon.style.backgroundImage = `url(${url})`;
      cell.append(icon, h('div', 'crafting-count', String(count)));
      cell.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.host.put(material)) this.refresh();
      });
      this.bagEl.appendChild(cell);
    }
  }

  private iconUrl(material: string): string {
    // 简单容量上限：材料种类异常膨胀时整体重建，避免无界缓存
    if (this.iconCache.size > 512) this.iconCache.clear();
    const cached = this.iconCache.get(material);
    if (cached !== undefined) return cached;
    let url = '';
    if (material.startsWith('b:')) {
      const def = this.registry.byNameGet(material.slice(2));
      if (def) url = this.atlas.icon(def, 48).toDataURL();
    } else {
      const name = material.startsWith('i:') ? material.slice(2) : material;
      const item = ITEMS[name];
      if (item) {
        url = this.atlas.itemIcon(item.tile, 48).toDataURL();
      } else {
        // 普通名回退为方块（玻璃等方块形态产物）
        const def = this.registry.byNameGet(name);
        if (def) url = this.atlas.icon(def, 48).toDataURL();
      }
    }
    this.iconCache.set(material, url);
    return url;
  }
}
