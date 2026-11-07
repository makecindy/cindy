/**
 * xtermPool —— per-tab xterm.js Terminal 实例池。
 *
 * 普通 tab 切换保留挂载并隐藏,任务切换等路径仍可能卸载 TabBody,
 * 但 PTY 在 main 进程仍然存活。如果每次重新挂载都重建 xterm Terminal,scrollback
 * (用户看过的输出历史)就丢了。pool 把 Terminal 实例跟 tabId 绑定,跨 mount/unmount
 * 复用,只在 plugin.onBeforeClose 真正关 tab 时才 dispose。
 *
 * 跟 web-browser plugin 的 BrowserWebviewPool 同款思路,但简单很多——xterm
 * Terminal 只是个 JS 对象,没有像 webview 那样必须保活的 DOM,挂到哪个 div
 * 都能 open()。所以 pool 只存"实例本体 + addons + 上次 fit 的尺寸",不存 DOM。
 *
 * Terminal 实例首次创建时,主题色用 RSB 内嵌色块预设(后续可改 token);如果将来
 * 接 token system,把这里的 theme 改成读 CSS variable 即可。
 */

// xterm.js 自带的样式表 —— 必须 import,否则 xterm 内部用来接键盘/IME 输入的
// `.xterm-helper-textarea` 不会被隐藏,会以浏览器默认 textarea 样式(白底带边框)
// 浮在终端顶部,把粘贴/输入字符可见地"漏"出来。Vite 会把这条 CSS 自动注入到
// document.head,不需要额外配置。
import '@xterm/xterm/css/xterm.css';

import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

import { createLogger } from '@/lib/logger';
import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_TERMINAL_FONT_FAMILY,
} from '@/../shared/appearanceSettings';

import { xtermEntries as pool, type XtermEntry } from './xtermEntries';

export type { XtermEntry } from './xtermEntries';

const log = createLogger('terminal');

const DEFAULT_OPTIONS: ITerminalOptions = {
  // Codex 同款字号 / 字体;cursorBlink 跟 iTerm 默认行为对齐。
  fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
  fontSize: DEFAULT_APPEARANCE_SETTINGS.terminalSize,
  lineHeight: 1.2,
  cursorBlink: true,
  cursorStyle: 'block',
  // scrollback 默认 1000,放大到 5000 给 long-running 任务多一点回溯空间。
  scrollback: 5000,
  // 允许 OSC 8 超链接(WebLinksAddon 也会处理裸 URL)
  allowProposedApi: false,
  // 反色风格的暗黑主题。RSB 视觉是黑底白字。
  theme: {
    background: '#1c1c1c',
    foreground: '#e6e6e6',
    cursor: '#e6e6e6',
    cursorAccent: '#1c1c1c',
    selectionBackground: '#3a4a5a',
  },
};

/** 获取或创建某个 tabId 的 xterm 实例。重复调用同 id 返回同一个。 */
export function getOrCreateXterm(tabId: string): XtermEntry {
  let entry = pool.get(tabId);
  if (entry) return entry;
  const terminal = new Terminal(DEFAULT_OPTIONS);
  const fitAddon = new FitAddon();
  // xterm's default link handler uses `window.open()`. In an Electron
  // renderer that creates a popup window, which is intentionally blocked by
  // the app's window policy and leaves terminal links inert. Route the click
  // through the existing main-process URL allowlist instead.
  const webLinks = new WebLinksAddon(openTerminalExternalLink);
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(webLinks);
  attachSelectionCopyShortcut(terminal);
  entry = {
    terminal,
    fitAddon,
    lastSize: { cols: 80, rows: 24 },
    ptyAttached: false,
  };
  pool.set(tabId, entry);
  return entry;
}

/**
 * Open a link detected in the terminal through the privileged host bridge.
 *
 * The main-process `shell:open-external` handler validates the URL protocol
 * before delegating to the operating system, so the renderer never opens
 * arbitrary terminal output directly.
 */
export function openTerminalExternalLink(_event: MouseEvent, uri: string): void {
  void window.electronAPI
    .openExternal(uri)
    .then((result) => {
      if (!result.success) {
        // Do not log the URL: terminal output may contain sensitive query parameters.
        log.warn('terminal link open rejected or failed');
      }
    })
    .catch(() => {
      log.warn('terminal link open IPC failed');
    });
}

/** 仅供 plugin.onBeforeClose 调用：真正销毁实例 + 释放 GPU/DOM 资源。 */
export function disposeXterm(tabId: string): void {
  const entry = pool.get(tabId);
  if (!entry) return;
  pool.delete(tabId);
  try {
    entry.terminal.dispose();
  } catch {
    /* swallow */
  }
}

/** 测试用 */
export function __resetPoolForTesting(): void {
  for (const [id] of pool) disposeXterm(id);
}

function attachSelectionCopyShortcut(terminal: Terminal): void {
  terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    if (!isCopyShortcut(event)) return true;
    if (!terminal.hasSelection()) return true;

    event.preventDefault();
    void navigator.clipboard.writeText(terminal.getSelection());
    return false;
  });
}

function isCopyShortcut(event: KeyboardEvent): boolean {
  if (event.type !== 'keydown') return false;
  if (event.key.toLowerCase() !== 'c') return false;
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
}
