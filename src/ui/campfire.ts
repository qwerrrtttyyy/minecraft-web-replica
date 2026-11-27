import type { TextureAtlas } from '../gfx/atlas';
import type { BlockRegistry } from '../world/blocks';
import { ITEMS } from '../player/survival';
import { smeltOutputOf } from '../player/smelting';
import type { CraftingHost } from './crafting';
import type { MaterialId } from '../player/crafting';

/**
 * 营火「直接烤」界面（PR4 营火部分）。
 *
 * 两槽：输入 / 输出；无燃料、无进度，点输出即把 1 个可烧炼材料烤熟。
 * 可烤物判定与熔炉共用 `smeltOutputOf`（远端 smelting 导出），因此营火
 * 也能烧原矿 / 沙子 / 原木，而不仅限于生食。
 *
 * 与合成界面一样不直接碰 SurvivalState：背包取放走 CraftingHost。
 * 营火无持久状态，关闭面板时把输入与输出退回背包，避免物品凭空消失。
 */

const h = (tag: string, cls?: string, text?: string): HTMLElement => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};

/** 材料标识 → 纯物品 / 方块名（smeltOutputOf 的键） */
function materialToPlain(material: MaterialId): string {
  return material.startsWith('item:') ? material.slice(5) : material;
}

/** 纯名 → 材料标识（物品加 item: 前缀，方块保持原名） */
function plainToMaterial(name: string): MaterialId {
  return ITEMS[name] ? `item:${name}` : name;
}

/** 槽位堆叠上限（营火无持久状态，仅作面板容量约束） */
export const CAMPFIRE_STACK_LIMIT = 64;

interface Slot {
  name: string;
  count: number;
}

export class CampfirePanel {
  readonly root: HTMLElement;
  private titleEl!: HTMLElement;
  private slotsEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private bagEl!: HTMLElement;

  private bx = 0;
  private by = 0;
  private bz = 0;
  private input: Slot | null = null;
  private output: Slot | null = null;
  private hint = '';
  private iconCache = new Map<string, string>();

  constructor(
    private host: CraftingHost,
    private atlas: TextureAtlas,
    private registry: BlockRegistry,
    private onClose: (x: number, y: number, z: number) => void,
  ) {
    this.root = h('div', 'overlay cooking-overlay');
    const panel = h('div', 'mc-panel cooking-panel');

    const head = h('div', 'crafting-head');
    this.titleEl = h('div', 'panel-title', '营火');
    const close = h('button', 'mc-btn-small crafting-close', '✕') as HTMLButtonElement;
    close.addEventListener('pointerdown', (e) => e.stopPropagation());
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.close();
    });
    head.append(this.titleEl, close);
    panel.appendChild(head);

    this.slotsEl = h('div', 'cooking-slots');
    panel.appendChild(this.slotsEl);

    this.hintEl = h('div', 'cooking-hint', '');
    panel.appendChild(this.hintEl);

    panel.appendChild(h('div', 'crafting-bag-title', '背包'));
    this.bagEl = h('div', 'crafting-bag');
    panel.appendChild(this.bagEl);

    // 常驻提示：面板打开时玩家无法移动
    panel.appendChild(h('div', 'cooking-note', '营火烤制中无法移动，Esc 关闭'));

    this.root.appendChild(panel);
    this.root.style.display = 'none';
  }

  get isOpen() {
    return this.root.style.display !== 'none';
  }

  show(x: number, y: number, z: number) {
    this.bx = x;
    this.by = y;
    this.bz = z;
    this.input = null;
    this.output = null;
    this.hint = '';
    this.buildSlots();
    this.root.style.display = '';
    this.refresh();
  }

  /** 关闭界面：把输入 / 输出退回背包 */
  hide() {
    this.returnSlot(this.input);
    this.returnSlot(this.output);
    this.input = null;
    this.output = null;
    this.root.style.display = 'none';
  }

  /** 点击 ✕：先退回槽位，再回调宿主恢复输入 */
  private close() {
    this.onClose(this.bx, this.by, this.bz);
  }

  private buildSlots() {
    this.slotsEl.innerHTML = '';
    const slots: Array<{ name: 'input' | 'output'; label: string }> = [
      { name: 'input', label: '输入' },
      { name: 'output', label: '输出' },
    ];
    for (const s of slots) {
      const wrap = h('div', 'cooking-slot-wrap');
      const btn = h('button', 'cooking-slot') as HTMLButtonElement;
      btn.dataset.slot = s.name;
      btn.title = s.label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onSlotClick(s.name);
      });
      const caption = h('span', 'cooking-slot-label', s.label);
      wrap.append(btn, caption);
      this.slotsEl.appendChild(wrap);
    }
  }

  private onSlotClick(slot: 'input' | 'output') {
    if (slot === 'input') {
      if (!this.input) {
        this.setHint('输入槽是空的');
      } else {
        const s = this.input;
        this.returnSlot(s);
        this.input = null;
        this.setHint(`取回 ${this.labelOf(`item:${s.name}`)} ×${s.count}`);
      }
    } else if (this.output) {
      const out = this.output;
      this.host.produce(`item:${out.name}`, out.count);
      this.output = null;
      this.setHint(`取出 ${this.labelOf(`item:${out.name}`)} ×${out.count}`);
    } else if (this.input) {
      const cooked = smeltOutputOf(this.input.name);
      if (!cooked) {
        this.setHint('该材料不能烤制');
      } else {
        this.input.count -= 1;
        if (this.input.count <= 0) this.input = null;
        this.output = { name: cooked, count: 1 };
        this.setHint(`烤熟了一份 ${this.labelOf(`item:${cooked}`)}`);
      }
    } else {
      this.setHint('输入槽没有材料');
    }
    this.refresh();
  }

  /** 点背包条目：可烧炼材料进输入槽（每次 1 个，与合成面板一致） */
  private onBagClick(material: MaterialId) {
    const name = materialToPlain(material);
    if (smeltOutputOf(name) === null) {
      this.setHint('营火只能烤制可烧炼的材料');
      this.refresh();
      return;
    }
    if (this.input && this.input.name !== name) {
      this.setHint('输入槽已有其他材料');
      this.refresh();
      return;
    }
    if ((this.input?.count ?? 0) >= CAMPFIRE_STACK_LIMIT) {
      this.setHint('输入槽已满');
      this.refresh();
      return;
    }
    if (!this.host.take(material)) {
      this.setHint('材料不足');
      this.refresh();
      return;
    }
    if (!this.input) this.input = { name, count: 0 };
    this.input.count += 1;
    this.setHint(`放入 ${this.labelOf(material)} ×1`);
    this.refresh();
  }

  private returnSlot(slot: Slot | null) {
    if (!slot) return;
    this.host.giveBack(plainToMaterial(slot.name));
    for (let i = 1; i < slot.count; i++) this.host.giveBack(plainToMaterial(slot.name));
  }

  private setHint(text: string) {
    this.hint = text;
  }

  private refresh() {
    this.hintEl.textContent = this.hint;
    this.renderSlots();
    this.renderBag();
  }

  private renderSlots() {
    for (const btn of Array.from(this.slotsEl.querySelectorAll<HTMLButtonElement>('.cooking-slot'))) {
      const slot = btn.dataset.slot;
      const data = slot === 'input' ? this.input : slot === 'output' ? this.output : null;
      this.fillSlot(btn, data ? plainToMaterial(data.name) : null, data?.count ?? 0);
    }
  }

  private fillSlot(btn: HTMLButtonElement, material: MaterialId | null, count: number) {
    btn.innerHTML = '';
    if (material) {
      const img = h('img') as HTMLImageElement;
      img.src = this.iconOf(material);
      img.alt = this.labelOf(material);
      img.draggable = false;
      btn.appendChild(img);
    }
    if (count > 1) btn.appendChild(h('span', 'crafting-count', String(count)));
  }

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
