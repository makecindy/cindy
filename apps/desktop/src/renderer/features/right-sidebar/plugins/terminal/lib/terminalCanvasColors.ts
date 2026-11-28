import type { ITheme } from '@xterm/xterm';

/**
 * 右侧栏终端画布的固定深色（DESIGN.md §2「Terminal canvas」）。
 *
 * 终端面板是一块固定深色画布，Light / Dark 同值、不跟随主题：这里没有定义 ANSI
 * 16 色，xterm 沿用它按深底调校的默认色板，换成浅底会让黄、青等输出看不清。面板
 * 底色与 xterm 主题共用这一份值，避免两处各写一遍、改了一边留下色差。
 *
 * 只给终端画布使用；终端外的界面 chrome 仍走主题 token。
 */
export const TERMINAL_CANVAS = {
  background: '#1c1c1c',
  foreground: '#e6e6e6',
  cursor: '#e6e6e6',
  cursorAccent: '#1c1c1c',
  selectionBackground: '#3a4a5a',
} as const satisfies ITheme;
