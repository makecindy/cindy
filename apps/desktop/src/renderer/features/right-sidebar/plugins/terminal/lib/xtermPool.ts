/**
 * xtermPool —— per-tab xterm.js Terminal 实例池。
 *
 * 普通 tab 切换保留挂载并隐藏,任务切换等路径仍可能卸载 TabBody,
 * 但 PTY 在 main 进程仍然存活。如果每次重新挂载都重建 xterm Terminal,scrollback
 * (用户看过的输出历史)就丢了。pool 把 Terminal 实例跟 tabId 绑定,跨 mount/unmount
 * 复用。已退出且隐藏的实例转为紧凑快照；关闭 tab 时连快照一起释放。
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
import { SerializeAddon } from '@xterm/addon-serialize';

import { createLogger } from '@/lib/logger';
import { extractIpcError } from '@/utils/ipcError';
import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_TERMINAL_FONT_FAMILY,
} from '@/../shared/appearanceSettings';

import type { TerminalCreateParams, TerminalCreateResult, TerminalExitInfo, TerminalDataEvent, TerminalExitEvent } from '@/../shared/terminal-bridge';
import { xtermEntries as pool, xtermSnapshots as snapshots, type XtermEntry } from './xtermEntries';

export type { XtermEntry } from './xtermEntries';

const log = createLogger('terminal');
const serializers = new WeakMap<Terminal, SerializeAddon>();
const pendingSuspensions = new Map<string, { cancel(): void }>();
const detachedStreams = new Map<string, () => void>();
const exits = new Map<string, TerminalExitInfo>();
const exitListeners = new Map<string, Set<(exit: TerminalExitInfo) => void>>();

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
  detachedStreams.get(tabId)?.();
  pendingSuspensions.get(tabId)?.cancel();
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
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);
  serializers.set(terminal, serializer);
  attachSelectionCopyShortcut(terminal);
  entry = {
    terminal,
    fitAddon,
    lastSize: { cols: 80, rows: 24 },
    ptyAttached: false,
  };
  pool.set(tabId, entry);
  const snapshot = snapshots.get(tabId);
  if (snapshot) {
    snapshots.delete(tabId);
    entry.lastSize = snapshot.lastSize;
    entry.ptyAttached = snapshot.ptyAttached;
    terminal.resize(snapshot.lastSize.cols, snapshot.lastSize.rows);
    const restoredEntry = entry;
    entry.restored = new Promise(resolve => terminal.write(snapshot.data, () => {
      terminal.scrollToLine(snapshot.viewportY);
      restoredEntry.restored = undefined;
      resolve();
    }));
  }
  return entry;
}

/** Exit state belongs to this renderer lifetime, not hydrated/persisted tab state. */
export function getXtermExit(tabId: string): TerminalExitInfo | null {
  return exits.get(tabId) ?? null;
}

export function setXtermExit(tabId: string, exit: TerminalExitInfo | null): void {
  if (exit) {
    exits.set(tabId, exit);
    for (const listener of exitListeners.get(tabId) ?? []) listener(exit);
  } else exits.delete(tabId);
}

/** Observe native exits and failed-transition rollback, including after a remount. */
export function onXtermExit(tabId: string, listener: (exit: TerminalExitInfo) => void): () => void {
  let listeners = exitListeners.get(tabId);
  if (!listeners) exitListeners.set(tabId, listeners = new Set());
  listeners.add(listener);
  const current = getXtermExit(tabId);
  if (current) listener(current);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) exitListeners.delete(tabId);
  };
}

/** A different window may have restarted the PTY since this renderer owned it. */
export function needsXtermAttach(tabId: string): boolean {
  return !(pool.get(tabId)?.ptyAttached ?? snapshots.get(tabId)?.ptyAttached ?? false);
}

/** Clear the old exit before IPC so an unmount keeps receiving the new shell's events. */
export function restartXterm(params: TerminalCreateParams): Promise<TerminalCreateResult> {
  const entry = pool.get(params.id);
  return transitionXterm(params.id, async () => {
    try {
      return await window.electronAPI.terminal.restart(params.id);
    } catch (error) {
      // A failed native restart can already have disposed the old PTY. Do not
      // reuse its attachment marker or recreate a tab closed while IPC waited.
      if (!entry || pool.get(params.id) !== entry) throw error;
      const code = extractIpcError(error)?.code;
      if (code === 'TERMINAL_SPAWN_FAILED' || code === 'TERMINAL_SHELL_NOT_FOUND'
        || code === 'TERMINAL_NOT_FOUND' || code === 'TERMINAL_ALREADY_DISPOSED') {
        entry.ptyAttached = false;
      }
      if (code !== 'TERMINAL_NOT_FOUND' && code !== 'TERMINAL_ALREADY_DISPOSED') throw error;
      // Retry is an explicit user action. Only a confirmed missing session
      // falls back to create; a still-running PTY is never restarted implicitly.
      return window.electronAPI.terminal.create(params);
    }
  });
}

export function attachXterm(params: TerminalCreateParams): Promise<TerminalCreateResult> {
  return transitionXterm(params.id, () => window.electronAPI.terminal.create(params));
}

async function transitionXterm(tabId: string, invoke: () => Promise<TerminalCreateResult>): Promise<TerminalCreateResult> {
  const entry = pool.get(tabId);
  const previousExit = getXtermExit(tabId);
  pendingSuspensions.get(tabId)?.cancel();
  setXtermExit(tabId, null);
  try {
    const result = await invoke();
    if (entry && pool.get(tabId) === entry) entry.ptyAttached = true;
    return result;
  } catch (error) {
    // Closing the tab or a newer native exit must win over this stale request.
    if (entry && pool.get(tabId) === entry && !getXtermExit(tabId)) {
      setXtermExit(tabId, previousExit);
      if (previousExit && /terminal session already exists \(exited\)/.test(String(error))) entry.ptyAttached = true;
      if (previousExit && detachedStreams.has(tabId)) detachXterm(tabId);
    }
    throw error;
  }
}

/** Keep receiving output while a running tab's body is unmounted. */
export function detachXterm(tabId: string): void {
  detachedStreams.get(tabId)?.();
  if (!pool.has(tabId)) return;
  if (getXtermExit(tabId)) {
    void suspendExitedXterm(tabId);
    return;
  }
  const offData = window.electronAPI.terminal.onData((event: TerminalDataEvent) => {
    if (event.id === tabId) pool.get(tabId)?.terminal.write(event.chunk);
  });
  const offExit = window.electronAPI.terminal.onExit((event: TerminalExitEvent) => {
    if (event.id !== tabId) return;
    setXtermExit(tabId, event.exit);
    stop();
    void suspendExitedXterm(tabId);
  });
  const stop = () => {
    offData();
    offExit();
    detachedStreams.delete(tabId);
  };
  detachedStreams.set(tabId, stop);
}

/** Only call for an exited, hidden terminal. Keep ANSI history, release its renderer. */
export function suspendExitedXterm(tabId: string): Promise<boolean> {
  const entry = pool.get(tabId);
  if (!entry) return Promise.resolve(false);
  pendingSuspensions.get(tabId)?.cancel();
  return new Promise((resolve) => {
    const request = { cancel() { pendingSuspensions.delete(tabId); resolve(false); } };
    pendingSuspensions.set(tabId, request);
    // PTY exit can arrive before xterm finishes parsing its last output batch.
    entry.terminal.write('', () => {
      if (pendingSuspensions.get(tabId) !== request || pool.get(tabId) !== entry) {
        resolve(false);
        return;
      }
      pendingSuspensions.delete(tabId);
      try {
        snapshots.set(tabId, {
          // Store compact UTF-8 bytes, not the serializer's per-cell string ropes.
          data: new TextEncoder().encode(serializers.get(entry.terminal)!.serialize()),
          lastSize: { cols: entry.terminal.cols, rows: entry.terminal.rows },
          ptyAttached: entry.ptyAttached,
          viewportY: entry.terminal.buffer.active.viewportY,
        });
      } catch {
        // Retain the live view if serialization fails; never discard history.
        snapshots.delete(tabId);
        resolve(false);
        return;
      }
      pool.delete(tabId);
      try { entry.terminal.dispose(); } catch { /* Snapshot remains recoverable. */ }
      resolve(true);
    });
  });
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
  detachedStreams.get(tabId)?.();
  exits.delete(tabId);
  snapshots.delete(tabId);
  pendingSuspensions.get(tabId)?.cancel();
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
  for (const id of new Set([...pool.keys(), ...snapshots.keys(), ...exits.keys()])) disposeXterm(id);
  snapshots.clear();
  pendingSuspensions.clear();
  exitListeners.clear();
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
