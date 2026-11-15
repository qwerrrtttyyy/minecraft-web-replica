/**
 * 可重绑定按键映射（input.ts 头注释预留的扩展点）。
 *
 * 把「游戏动作 → KeyboardEvent.code」的映射从 input.ts 的硬编码里抽出来，
 * 存 localStorage 持久化。Input 的所有 getter / 边缘事件都改为查询这张表，
 * 于是在 HUD 设置面板里改一个动作即可全局生效。
 *
 * 方向键、右 Shift、右 Ctrl、数字键保留为固定别名，不参与重绑定：
 * 前者是移动的方向冗余，后两者是蹲/冲刺的对称备用键。
 */

export const ACTION_LABELS = {
  forward: '前进',
  back: '后退',
  left: '左移',
  right: '右移',
  jump: '跳跃',
  sneak: '潜行 / 下降',
  sprint: '冲刺',
  palette: '方块库',
  fly: '飞行切换',
  camera: '切换视角',
  debug: '调试信息',
  hud: '显示 / 隐藏界面',
  pause: '暂停 / 菜单',
} as const;

export type GameAction = keyof typeof ACTION_LABELS;
export const ACTION_KEYS = Object.keys(ACTION_LABELS) as GameAction[];

export interface KeyBindings {
  forward: string;
  back: string;
  left: string;
  right: string;
  jump: string;
  sneak: string;
  sprint: string;
  palette: string;
  fly: string;
  camera: string;
  debug: string;
  hud: string;
  pause: string;
}

export const DEFAULT_BINDINGS: KeyBindings = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  sneak: 'ShiftLeft',
  sprint: 'ControlLeft',
  palette: 'KeyE',
  fly: 'KeyF',
  camera: 'F5',
  debug: 'F3',
  hud: 'F1',
  pause: 'Escape',
};

const STORAGE_KEY = 'minecraft-ts-keybindings-v1';

/** 把 KeyboardEvent.code 转成玩家可读的短标签（HUD 设置面板显示） */
export function codeLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `小键盘${code.slice(6)}`;
  const named: Record<string, string> = {
    Space: '空格', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    ShiftLeft: '左Shift', ShiftRight: '右Shift', ControlLeft: '左Ctrl', ControlRight: '右Ctrl',
    AltLeft: '左Alt', AltRight: '右Alt', Escape: 'Esc', Enter: '回车',
    Backspace: '退格', Tab: 'Tab', CapsLock: '大写锁定',
  };
  if (named[code]) return named[code];
  if (/^F\d+$/.test(code)) return code;
  return code;
}

/** 读取持久化绑定；缺字段/坏类型用默认值补齐，保证 schema 永远完整 */
export function loadBindings(): KeyBindings {
  const out: KeyBindings = { ...DEFAULT_BINDINGS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw) as Partial<KeyBindings>;
    for (const a of ACTION_KEYS) {
      if (typeof parsed[a] === 'string' && parsed[a]!.length > 0 && parsed[a]!.length < 40) {
        out[a] = parsed[a]!;
      }
    }
  } catch {
    /* 坏档回退默认 */
  }
  return out;
}

export function saveBindings(b: KeyBindings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(b));
  } catch {
    /* 隐私模式 / 配额满：本次会话仍有效，仅无法跨会话持久化 */
  }
}
