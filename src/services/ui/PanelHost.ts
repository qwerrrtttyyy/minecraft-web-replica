import type { HookStack } from '../plugins/extensions';

/**
 * 插件 UI 宿主（A2-5）：插件经此注册暂停菜单面板、取 HUD 锚点、装饰快捷栏格，
 * 不直接改 src/ui/** 或 main.ts。面板的暂停 / 恢复与合成面板走同一套状态机。
 */

export type HudAnchor = 'above-hotbar-left' | 'above-hotbar-right';

/** 快捷栏每次重绘后回调；装饰器需自行保证幂等（先清除自己上次加的元素） */
export type SlotDecorator = (slot: HTMLElement, stack: HookStack | null, index: number) => void;

export type PanelOrigin = 'game' | 'menu';

export interface PluginPanel {
  id: string;
  label: string;
  root: HTMLElement;
  /** 创造模式下拒绝打开 */
  survivalOnly?: boolean;
  onShow?(): void;
  onHide?(): void;
}

/** 由组装根 / HUD 实现的底层能力 */
export interface PanelHostAdapter {
  addMenuButton(label: string, onClick: () => void): () => void;
  showPanel(title: string, root: HTMLElement, onClose: () => void): void;
  hidePanel(): void;
  anchor(name: HudAnchor): HTMLElement;
  addSlotDecorator(fn: SlotDecorator): () => void;
  /** 进入暂停态（已暂停则不变） */
  enter(from: PanelOrigin): void;
  /** 关闭面板后回到来源：菜单或继续游戏 */
  leave(from: PanelOrigin): void;
  isSurvival(): boolean;
  toast(message: string): void;
}

interface Entry {
  panel: PluginPanel;
  removeButton: () => void;
}

export class PanelHost {
  private readonly panels = new Map<string, Entry>();
  private current: { id: string; from: PanelOrigin } | null = null;

  constructor(private readonly adapter: PanelHostAdapter) {}

  /** 注册面板并在暂停菜单加入口按钮；返回注销函数（插件放进 ctx.onDispose） */
  register(panel: PluginPanel): () => void {
    if (this.panels.has(panel.id)) throw new Error(`[panels] 面板 id 重复: ${panel.id}`);
    const removeButton = this.adapter.addMenuButton(panel.label, () => this.open(panel.id, 'menu'));
    const entry: Entry = { panel, removeButton };
    this.panels.set(panel.id, entry);
    return () => {
      if (this.panels.get(panel.id) !== entry) return;
      if (this.current?.id === panel.id) this.close();
      removeButton();
      this.panels.delete(panel.id);
    };
  }

  open(id: string, from: PanelOrigin = 'game'): boolean {
    const entry = this.panels.get(id);
    if (!entry) return false;
    const { panel } = entry;
    if (panel.survivalOnly && !this.adapter.isSurvival()) {
      this.adapter.toast(`创造模式不需要${panel.label}`);
      return false;
    }
    if (this.current) this.close();
    this.current = { id, from };
    this.adapter.enter(from);
    this.adapter.showPanel(panel.label, panel.root, () => this.close());
    panel.onShow?.();
    return true;
  }

  close(): void {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    this.adapter.hidePanel();
    this.panels.get(cur.id)?.panel.onHide?.();
    this.adapter.leave(cur.from);
  }

  get openId(): string | null {
    return this.current?.id ?? null;
  }

  has(id: string): boolean {
    return this.panels.has(id);
  }

  anchor(name: HudAnchor): HTMLElement {
    return this.adapter.anchor(name);
  }

  decorateSlot(fn: SlotDecorator): () => void {
    return this.adapter.addSlotDecorator(fn);
  }
}
