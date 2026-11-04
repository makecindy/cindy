// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_APPEARANCE_SETTINGS, type AppearanceSettings } from '../../../../../../shared/appearanceSettings';
import type { TabKindHostContext } from '../../../types';
import type { TerminalState } from '../index';
import type { XtermEntry } from '../lib/xtermPool';

const poolMocks = vi.hoisted(() => ({ getOrCreateXterm: vi.fn() }));
vi.mock('../lib/xtermPool', () => poolMocks);
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { TerminalTabBody } from '../TerminalTabBody';

// Keep the pre-feature defaults literal: deriving these expectations from the
// production constant would fail to catch an accidental change to old terminals.
const ORIGINAL_FAMILY = '"SF Mono", Menlo, Monaco, "Cascadia Code", "Courier New", monospace';
const originalFontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');

type Snapshot = AppearanceSettings & { terminalFamily: string; terminalSize: number };
type Listener = (value: unknown) => void;

function defaultSnapshot(): Snapshot {
  return {
    ...DEFAULT_APPEARANCE_SETTINGS,
    uiFamily: '', codeFamily: '', uiSize: 14, codeSize: 14, windowZoom: 1,
    terminalFamily: '', terminalSize: 13,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let width: number;
let height: number;
let frameId: number;
let frames: Map<number, FrameRequestCallback>;
let resizeCallbacks: Set<ResizeObserverCallback>;
let snapshot: Snapshot;
let appearanceListeners: Set<Listener>;
let dataListeners: Set<Listener>;
let exitListeners: Set<Listener>;
let loadFonts: ReturnType<typeof vi.fn>;
let api: ReturnType<typeof installBridge>;
let entries: Map<string, ReturnType<typeof makeEntry>>;

function installBridge() {
  const terminal = {
    create: vi.fn(async () => ({ shellId: 'zsh', shellDisplayName: 'zsh' })),
    restart: vi.fn(async () => ({ shellId: 'zsh', shellDisplayName: 'zsh' })),
    dispose: vi.fn(async () => undefined),
    resize: vi.fn(async (_id: string, _cols: number, _rows: number) => undefined),
    write: vi.fn(async () => undefined),
    onData: vi.fn((listener: Listener) => {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    }),
    onExit: vi.fn((listener: Listener) => {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    }),
  };
  // A detached renderer exposes only this read surface. No FontSettingsProvider
  // or settings write methods are installed in this harness.
  const appearanceSettings = {
    getSync: vi.fn(() => ({ ...snapshot })),
    onChanged: vi.fn((listener: Listener) => {
      appearanceListeners.add(listener);
      return () => appearanceListeners.delete(listener);
    }),
  };
  const bridge = { terminal, appearanceSettings };
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: bridge });
  return bridge;
}

function makeEntry() {
  const inputListeners = new Set<(value: string) => void>();
  const fitSamples: Array<{ fontFamily: string; fontSize: number }> = [];
  const output: string[] = [];
  const terminal = {
    element: undefined as HTMLElement | undefined,
    options: {
      fontFamily: ORIGINAL_FAMILY,
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      cursorBlink: true,
      cursorStyle: 'block',
      theme: { background: '#1c1c1c', foreground: '#e6e6e6' },
    },
    cols: 80,
    rows: 24,
    open: vi.fn((slot: HTMLElement) => {
      terminal.element = document.createElement('div');
      slot.appendChild(terminal.element);
    }),
    onData: vi.fn((listener: (value: string) => void) => {
      inputListeners.add(listener);
      return { dispose: () => inputListeners.delete(listener) };
    }),
    write: vi.fn((value: string) => output.push(value)),
    focus: vi.fn(),
    dispose: vi.fn(),
    reset: vi.fn(),
    clear: vi.fn(),
    refresh: vi.fn(),
  };
  const fitAddon = {
    fit: vi.fn(() => {
      fitSamples.push({ fontFamily: terminal.options.fontFamily, fontSize: terminal.options.fontSize });
      // Deliberately responsive to the public font option. This checks that the
      // PTY receives the size *after* the new font was applied, not stale cols.
      terminal.cols = Math.max(1, Math.floor(width / (terminal.options.fontSize * 0.6)));
      terminal.rows = Math.max(1, Math.floor(height / (terminal.options.fontSize * 1.2)));
    }),
  };
  return {
    terminal, fitAddon, fitSamples, inputListeners, output,
    lastSize: { cols: 80, rows: 24 },
    ptyAttached: true,
  };
}

function context(tabId = 'terminal-a'): TabKindHostContext {
  return {
    tabId, sessionId: 'session-a', workdir: '', remoteHostId: null, deviceLinkDeviceId: null,
    patchState: vi.fn(), onVisibilityChange: vi.fn(),
    setCloseInterceptor: () => () => undefined,
  };
}

const runningState: TerminalState = {
  created: true, exited: null, title: '', shellId: 'zsh', shellDisplayName: 'zsh',
};

async function flushWork() {
  await act(async () => {
    // Drain finite promise / animation-frame work without timers or real I/O.
    for (let step = 0; step < 8; step += 1) {
      await Promise.resolve();
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(step * 16);
    }
  });
}

async function broadcast(patch: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...patch };
  await act(async () => {
    for (const listener of appearanceListeners) listener({ ...snapshot });
  });
  await flushWork();
}

async function notifyResize() {
  await act(async () => {
    for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
  });
  await flushWork();
}

beforeEach(() => {
  vi.clearAllMocks();
  width = 800;
  height = 480;
  frameId = 0;
  frames = new Map();
  resizeCallbacks = new Set();
  snapshot = defaultSnapshot();
  appearanceListeners = new Set();
  dataListeners = new Set();
  exitListeners = new Set();
  entries = new Map();
  loadFonts = vi.fn(async () => []);
  Object.defineProperty(document, 'fonts', {
    configurable: true, value: { load: loadFonts },
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++frameId;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe() { resizeCallbacks.add(this.callback); }
    disconnect() { resizeCallbacks.delete(this.callback); }
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, width, height),
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => height);
  poolMocks.getOrCreateXterm.mockImplementation((tabId: string) => {
    let entry = entries.get(tabId);
    if (!entry) {
      entry = makeEntry();
      entries.set(tabId, entry);
    }
    return entry as unknown as XtermEntry;
  });
  api = installBridge();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalFontsDescriptor) Object.defineProperty(document, 'fonts', originalFontsDescriptor);
  else Reflect.deleteProperty(document, 'fonts');
  Reflect.deleteProperty(window, 'electronAPI');
});

describe('TerminalTabBody terminal font preferences', () => {
  it('keeps the existing defaults and starts the PTY once without a settings provider', async () => {
    const ctx = context();
    render(<TerminalTabBody state={{ ...runningState, created: false }} ctx={ctx} active />);
    await flushWork();

    const entry = entries.get(ctx.tabId)!;
    expect(entry.terminal.options.fontFamily).toBe(ORIGINAL_FAMILY);
    expect(entry.terminal.options.fontSize).toBe(13);
    expect(api.appearanceSettings.getSync).toHaveBeenCalled();
    expect(appearanceListeners.size).toBe(1);
    expect(api.terminal.create).toHaveBeenCalledOnce();
    expect(ctx.patchState).toHaveBeenCalledWith(expect.objectContaining({ created: true }));
  });

  it('applies saved settings and later broadcasts to the same terminal without changing its session or focus', async () => {
    snapshot = { ...snapshot, terminalFamily: 'Menlo', terminalSize: 16 };
    const ctx = context();
    render(<TerminalTabBody state={runningState} ctx={ctx} active />);
    await flushWork();
    const entry = entries.get(ctx.tabId)!;
    const theme = entry.terminal.options.theme;
    expect(entry.terminal.options.fontFamily).toContain('Menlo');
    expect(entry.terminal.options.fontSize).toBe(16);
    expect(entry.terminal.open).toHaveBeenCalledOnce();

    act(() => {
      for (const listener of dataListeners) listener({ id: ctx.tabId, chunk: 'existing output\r\n' });
    });
    entry.terminal.focus.mockClear();
    api.terminal.resize.mockClear();
    await broadcast({ terminalFamily: 'JetBrains Mono', terminalSize: 20 });

    expect(entry.terminal.options.fontFamily).toContain('JetBrains Mono');
    expect(entry.terminal.options.fontSize).toBe(20);
    expect(entry.fitSamples.at(-1)).toMatchObject({ fontSize: 20 });
    expect(api.terminal.resize).toHaveBeenLastCalledWith(ctx.tabId, 66, 20);
    expect(entry.terminal.focus).not.toHaveBeenCalled();
    expect(entry.terminal.open).toHaveBeenCalledOnce();
    expect(poolMocks.getOrCreateXterm).toHaveBeenCalledOnce();
    expect(api.terminal.create).not.toHaveBeenCalled();
    expect(api.terminal.restart).not.toHaveBeenCalled();
    expect(api.terminal.dispose).not.toHaveBeenCalled();
    expect(entry.terminal.dispose).not.toHaveBeenCalled();
    expect(entry.terminal.reset).not.toHaveBeenCalled();
    expect(entry.terminal.clear).not.toHaveBeenCalled();
    expect(entry.output).toEqual(['existing output\r\n']);
    expect(entry.terminal.options).toMatchObject({ lineHeight: 1.2, scrollback: 5000, cursorBlink: true, cursorStyle: 'block' });
    expect(entry.terminal.options.theme).toBe(theme);
    expect(ctx.patchState).not.toHaveBeenCalled();

    act(() => {
      for (const listener of entry.inputListeners) listener('pwd\r');
      for (const listener of dataListeners) listener({ id: ctx.tabId, chunk: 'next output\r\n' });
    });
    expect(api.terminal.write).toHaveBeenCalledWith(ctx.tabId, 'pwd\r');
    expect(entry.output).toEqual(['existing output\r\n', 'next output\r\n']);
  });

  it('ignores UI and code font changes and restores only the terminal defaults', async () => {
    const ctx = context();
    render(<TerminalTabBody state={runningState} ctx={ctx} active />);
    await flushWork();
    await broadcast({ terminalFamily: 'Menlo', terminalSize: 18 });
    const entry = entries.get(ctx.tabId)!;
    const family = entry.terminal.options.fontFamily;
    loadFonts.mockClear();
    entry.fitAddon.fit.mockClear();
    api.terminal.resize.mockClear();

    await broadcast({ uiFamily: 'Inter', codeFamily: 'Courier New', uiSize: 22, codeSize: 24, windowZoom: 1.2 });
    expect(entry.terminal.options.fontFamily).toBe(family);
    expect(entry.terminal.options.fontSize).toBe(18);
    expect(loadFonts).not.toHaveBeenCalled();
    expect(entry.fitAddon.fit).not.toHaveBeenCalled();
    expect(api.terminal.resize).not.toHaveBeenCalled();

    await broadcast({ terminalFamily: '', terminalSize: 13 });
    expect(entry.terminal.options.fontFamily).toBe(ORIGINAL_FAMILY);
    expect(entry.terminal.options.fontSize).toBe(13);
    expect(snapshot).toMatchObject({ uiFamily: 'Inter', codeFamily: 'Courier New', uiSize: 22, codeSize: 24 });
  });

  it('defers a saved font while the shell is collapsed and applies it on expansion', async () => {
    snapshot = { ...snapshot, terminalFamily: 'Menlo', terminalSize: 20 };
    const ctx = context();
    const view = render(<TerminalTabBody state={runningState} ctx={ctx} active shellVisible={false} />);
    await flushWork();
    const entry = entries.get(ctx.tabId)!;
    const originalSize = { ...entry.lastSize };
    await notifyResize();

    // Collapsed sidebars can keep nonzero layout dimensions during transitions.
    expect(entry.terminal.options.fontSize).toBe(13);
    expect(entry.fitAddon.fit).not.toHaveBeenCalled();
    expect(entry.lastSize).toEqual(originalSize);
    expect(api.terminal.resize).not.toHaveBeenCalled();
    expect(entry.terminal.focus).not.toHaveBeenCalled();

    view.rerender(<TerminalTabBody state={runningState} ctx={ctx} active shellVisible />);
    await flushWork();
    expect(entry.terminal.options.fontFamily).toContain('Menlo');
    expect(entry.terminal.options.fontSize).toBe(20);
    expect(api.terminal.resize).toHaveBeenLastCalledWith(ctx.tabId, 66, 20);
    expect(api.terminal.create).not.toHaveBeenCalled();
  });

  it('holds a font that finishes loading after collapse until the shell becomes visible', async () => {
    const ctx = context();
    const view = render(<TerminalTabBody state={runningState} ctx={ctx} active shellVisible />);
    await flushWork();
    const entry = entries.get(ctx.tabId)!;
    const pending = deferred<FontFace[]>();
    loadFonts.mockReturnValueOnce(pending.promise);
    await broadcast({ terminalFamily: 'Slow Mono', terminalSize: 22 });
    view.rerender(<TerminalTabBody state={runningState} ctx={ctx} active shellVisible={false} />);
    entry.fitAddon.fit.mockClear();
    entry.terminal.focus.mockClear();
    api.terminal.resize.mockClear();
    const originalSize = { ...entry.lastSize };

    pending.resolve([]);
    await flushWork();
    await notifyResize();
    expect(entry.terminal.options.fontSize).toBe(13);
    expect(entry.fitAddon.fit).not.toHaveBeenCalled();
    expect(entry.lastSize).toEqual(originalSize);
    expect(api.terminal.resize).not.toHaveBeenCalled();
    expect(entry.terminal.focus).not.toHaveBeenCalled();

    view.rerender(<TerminalTabBody state={runningState} ctx={ctx} active shellVisible />);
    await flushWork();
    expect(entry.terminal.options.fontFamily).toContain('Slow Mono');
    expect(entry.terminal.options.fontSize).toBe(22);
    expect(api.terminal.resize).toHaveBeenLastCalledWith(ctx.tabId, 60, 18);
    expect(api.terminal.create).not.toHaveBeenCalled();
    expect(api.terminal.restart).not.toHaveBeenCalled();
  });

  it('defers hidden-tab measurements and uses the latest font when activated', async () => {
    const ctx = context();
    const view = render(<TerminalTabBody state={runningState} ctx={ctx} active />);
    await flushWork();
    view.rerender(<TerminalTabBody state={runningState} ctx={ctx} active={false} />);
    await flushWork();
    const entry = entries.get(ctx.tabId)!;
    entry.fitAddon.fit.mockClear();
    entry.terminal.focus.mockClear();
    api.terminal.resize.mockClear();

    await broadcast({ terminalFamily: 'Menlo', terminalSize: 16 });
    await broadcast({ terminalFamily: 'Courier New', terminalSize: 24 });
    await notifyResize();
    expect(entry.fitAddon.fit).not.toHaveBeenCalled();
    expect(api.terminal.resize).not.toHaveBeenCalled();
    expect(entry.terminal.focus).not.toHaveBeenCalled();

    view.rerender(<TerminalTabBody state={runningState} ctx={ctx} active />);
    await flushWork();
    expect(entry.terminal.options.fontFamily).toContain('Courier New');
    expect(entry.terminal.options.fontSize).toBe(24);
    expect(entry.fitSamples.at(-1)).toMatchObject({ fontSize: 24 });
    expect(api.terminal.resize).toHaveBeenLastCalledWith(ctx.tabId, 55, 16);
  });

  it('does not resize a zero-sized panel and applies its pending font once space returns', async () => {
    const ctx = context();
    render(<TerminalTabBody state={runningState} ctx={ctx} active />);
    await flushWork();
    const entry = entries.get(ctx.tabId)!;
    width = 0;
    height = 0;
    entry.fitAddon.fit.mockClear();
    api.terminal.resize.mockClear();
    await broadcast({ terminalFamily: 'Menlo', terminalSize: 20 });
    await notifyResize();
    expect(entry.fitAddon.fit).not.toHaveBeenCalled();
    expect(api.terminal.resize).not.toHaveBeenCalled();

    width = 800;
    height = 480;
    await notifyResize();
    expect(entry.terminal.options.fontSize).toBe(20);
    expect(entry.fitSamples.at(-1)).toMatchObject({ fontSize: 20 });
    expect(api.terminal.resize).toHaveBeenLastCalledWith(ctx.tabId, 66, 20);
  });

  it('reads changes made while unmounted and reuses the pooled terminal and subscriptions', async () => {
    const ctx = context();
    const view = render(<TerminalTabBody state={runningState} ctx={ctx} active />);
    await flushWork();
    const entry = entries.get(ctx.tabId)!;
    view.unmount();
    expect(appearanceListeners.size).toBe(0);
    expect(dataListeners.size).toBe(0);
    expect(exitListeners.size).toBe(0);
    expect(entry.inputListeners.size).toBe(0);
    expect(entry.terminal.dispose).not.toHaveBeenCalled();

    snapshot = { ...snapshot, terminalFamily: 'Courier New', terminalSize: 19 };
    render(<TerminalTabBody state={runningState} ctx={ctx} active />);
    await flushWork();
    expect(entries.get(ctx.tabId)).toBe(entry);
    expect(entry.terminal.open).toHaveBeenCalledOnce();
    expect(entry.terminal.options.fontFamily).toContain('Courier New');
    expect(entry.terminal.options.fontSize).toBe(19);
    expect(appearanceListeners.size).toBe(1);
    expect(dataListeners.size).toBe(1);
    expect(entry.inputListeners.size).toBe(1);
    expect(api.terminal.create).not.toHaveBeenCalled();
    expect(api.terminal.restart).not.toHaveBeenCalled();
  });

  it('does not let an older font load override a newer selection', async () => {
    const ctx = context();
    render(<TerminalTabBody state={runningState} ctx={ctx} active />);
    await flushWork();
    const older = deferred<FontFace[]>();
    const newer = deferred<FontFace[]>();
    loadFonts.mockImplementation((font: string) => font.includes('Older Mono') ? older.promise : newer.promise);

    await broadcast({ terminalFamily: 'Older Mono', terminalSize: 16 });
    await broadcast({ terminalFamily: 'Newer Mono', terminalSize: 21 });
    newer.resolve([]); // [] is valid for locally installed system fonts.
    await flushWork();
    const entry = entries.get(ctx.tabId)!;
    expect(entry.terminal.options.fontFamily).toContain('Newer Mono');
    expect(entry.terminal.options.fontSize).toBe(21);
    const fitCount = entry.fitAddon.fit.mock.calls.length;
    older.resolve([]);
    await flushWork();
    expect(entry.terminal.options.fontFamily).toContain('Newer Mono');
    expect(entry.terminal.options.fontSize).toBe(21);
    expect(entry.fitAddon.fit).toHaveBeenCalledTimes(fitCount);
  });

  it('sends the final font dimensions once a pending PTY creation has completed', async () => {
    const ctx = context();
    const entry = makeEntry();
    entry.ptyAttached = false;
    entries.set(ctx.tabId, entry);
    const create = deferred<{ shellId: string; shellDisplayName: string }>();
    api.terminal.create.mockReturnValueOnce(create.promise);
    snapshot = { ...snapshot, terminalFamily: 'Menlo', terminalSize: 20 };

    render(<TerminalTabBody state={{ ...runningState, created: false }} ctx={ctx} active />);
    await flushWork();
    expect(api.terminal.create).toHaveBeenCalledOnce();
    expect(api.terminal.create).toHaveBeenCalledWith(expect.objectContaining({ cols: 102, rows: 30 }));
    expect(entry.terminal.options.fontSize).toBe(20);
    expect(api.terminal.resize).not.toHaveBeenCalled();

    create.resolve({ shellId: 'zsh', shellDisplayName: 'zsh' });
    await flushWork();
    expect(api.terminal.resize).toHaveBeenCalledOnce();
    expect(api.terminal.resize).toHaveBeenCalledWith(ctx.tabId, 66, 20);
    expect(api.terminal.restart).not.toHaveBeenCalled();
  });

  it.each(['before', 'during', 'after'] as const)(
    'keeps the restarted PTY grid in sync when the font loads %s restart',
    async (fontTiming) => {
      const ctx = context();
      const exitedState = { ...runningState, exited: { code: 0, signal: null } };
      const view = render(<TerminalTabBody state={runningState} ctx={ctx} active />);
      await flushWork();
      const entry = entries.get(ctx.tabId)!;
      let ptySize = { ...entry.lastSize };
      let ptyRunning = false;
      // The main process ignores resize after exit, and restart starts with its
      // last running dimensions rather than the renderer's newly fitted grid.
      api.terminal.resize.mockImplementation(async (_id, cols, rows) => {
        if (ptyRunning) ptySize = { cols, rows };
      });
      act(() => {
        for (const listener of dataListeners) listener({ id: ctx.tabId, chunk: 'before exit\r\n' });
        for (const listener of exitListeners) listener({ id: ctx.tabId, exit: exitedState.exited });
      });
      view.rerender(<TerminalTabBody state={exitedState} ctx={ctx} active />);
      const font = deferred<FontFace[]>();
      const restart = deferred<{ shellId: string; shellDisplayName: string }>();
      loadFonts.mockReturnValueOnce(font.promise);
      api.terminal.restart.mockReturnValueOnce(restart.promise);
      await broadcast({ terminalFamily: 'Menlo', terminalSize: 20 });
      if (fontTiming === 'before') {
        font.resolve([]);
        await flushWork();
      }
      fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.terminal.restart' }));
      if (fontTiming === 'during') {
        font.resolve([]);
        await flushWork();
      }
      api.terminal.resize.mockClear();
      entry.terminal.focus.mockClear();
      ptyRunning = true;
      restart.resolve({ shellId: 'zsh', shellDisplayName: 'zsh' });
      await flushWork();
      expect(api.terminal.resize).toHaveBeenCalledOnce();
      expect(ptySize).toEqual(entry.lastSize);

      if (fontTiming === 'after') {
        font.resolve([]);
        await flushWork();
      }
      expect(entry.terminal.options.fontSize).toBe(20);
      expect(ptySize).toEqual({ cols: 66, rows: 20 });
      expect(ptySize).toEqual(entry.lastSize);
      expect(api.terminal.restart).toHaveBeenCalledOnce();
      expect(api.terminal.create).not.toHaveBeenCalled();
      expect(api.terminal.dispose).not.toHaveBeenCalled();
      expect(entry.terminal.open).toHaveBeenCalledOnce();
      expect(entry.terminal.dispose).not.toHaveBeenCalled();
      expect(entry.terminal.reset).not.toHaveBeenCalled();
      expect(entry.terminal.clear).not.toHaveBeenCalled();
      expect(entry.terminal.focus).not.toHaveBeenCalled();
      expect(entry.output).toEqual(['before exit\r\n']);
    },
  );

  it.each(['collapsed', 'inactive', 'zero-sized'] as const)(
    'reuses the last usable grid when restart completes in a %s terminal',
    async (visibility) => {
      const ctx = context();
      const state = { ...runningState, exited: { code: 0, signal: null } };
      const view = render(<TerminalTabBody state={state} ctx={ctx} active />);
      await flushWork();
      await broadcast({ terminalSize: 20 });
      const entry = entries.get(ctx.tabId)!;
      expect(entry.lastSize).toEqual({ cols: 66, rows: 20 });
      const restart = deferred<{ shellId: string; shellDisplayName: string }>();
      api.terminal.restart.mockReturnValueOnce(restart.promise);
      fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.terminal.restart' }));
      if (visibility === 'zero-sized') { width = 0; height = 0; }
      view.rerender(<TerminalTabBody
        state={state} ctx={ctx}
        active={visibility !== 'inactive'} shellVisible={visibility !== 'collapsed'}
      />);
      await broadcast({ terminalSize: 24 });
      entry.fitAddon.fit.mockClear();
      entry.terminal.focus.mockClear();
      api.terminal.resize.mockClear();

      restart.resolve({ shellId: 'zsh', shellDisplayName: 'zsh' });
      await flushWork();
      expect(api.terminal.resize).toHaveBeenCalledOnce();
      expect(api.terminal.resize).toHaveBeenCalledWith(ctx.tabId, 66, 20);
      expect(entry.fitAddon.fit).not.toHaveBeenCalled();
      expect(entry.terminal.focus).not.toHaveBeenCalled();
      expect(entry.terminal.options.fontSize).toBe(20);

      width = 800; height = 480;
      view.rerender(<TerminalTabBody state={runningState} ctx={ctx} active shellVisible />);
      await notifyResize();
      expect(entry.terminal.options.fontSize).toBe(24);
      expect(api.terminal.resize).toHaveBeenLastCalledWith(ctx.tabId, 55, 16);
      expect(api.terminal.create).not.toHaveBeenCalled();
    },
  );

  it.each(['failed', 'unmounted', 'replaced'] as const)(
    'does not synchronize a %s restart',
    async (outcome) => {
      const ctx = context();
      const state = { ...runningState, exited: { code: 0, signal: null } };
      const view = render(<TerminalTabBody state={state} ctx={ctx} active />);
      await flushWork();
      await broadcast({ terminalSize: 20 });
      const restart = deferred<{ shellId: string; shellDisplayName: string }>();
      api.terminal.restart.mockReturnValueOnce(restart.promise);
      fireEvent.click(screen.getByRole('button', { name: 'rightSidebar.terminal.restart' }));
      if (outcome === 'unmounted') view.unmount();
      if (outcome === 'replaced') {
        view.rerender(<TerminalTabBody state={runningState} ctx={context('terminal-b')} active />);
        await flushWork();
      }
      api.terminal.resize.mockClear();
      if (outcome === 'failed') restart.reject(new Error('TERMINAL_SPAWN_FAILED'));
      else restart.resolve({ shellId: 'zsh', shellDisplayName: 'zsh' });
      await flushWork();
      expect(api.terminal.resize).not.toHaveBeenCalled();
    },
  );

  it('updates both subscribed terminals while deferring measurements for the hidden one', async () => {
    const firstCtx = context('terminal-a');
    const secondCtx = context('terminal-b');
    const view = render(<>
      <TerminalTabBody state={runningState} ctx={firstCtx} active />
      <TerminalTabBody state={runningState} ctx={secondCtx} active={false} />
    </>);
    await flushWork();
    expect(appearanceListeners.size).toBe(2);
    const first = entries.get(firstCtx.tabId)!;
    const second = entries.get(secondCtx.tabId)!;
    second.fitAddon.fit.mockClear();
    api.terminal.resize.mockClear();

    await broadcast({ terminalFamily: 'Courier New', terminalSize: 20 });
    expect(first.terminal.options.fontSize).toBe(20);
    expect(second.fitAddon.fit).not.toHaveBeenCalled();
    expect(api.terminal.resize).toHaveBeenCalledWith(firstCtx.tabId, 66, 20);
    expect(api.terminal.resize).not.toHaveBeenCalledWith(secondCtx.tabId, expect.anything(), expect.anything());

    view.rerender(<>
      <TerminalTabBody state={runningState} ctx={firstCtx} active={false} />
      <TerminalTabBody state={runningState} ctx={secondCtx} active />
    </>);
    await flushWork();
    expect(second.terminal.options.fontFamily).toContain('Courier New');
    expect(second.terminal.options.fontSize).toBe(20);
    expect(api.terminal.resize).toHaveBeenLastCalledWith(secondCtx.tabId, 66, 20);
    expect(first.terminal.open).toHaveBeenCalledOnce();
    expect(second.terminal.open).toHaveBeenCalledOnce();
    expect(api.terminal.create).not.toHaveBeenCalled();
  });

  it('still applies local fonts when the browser does not expose the Font Loading API', async () => {
    Object.defineProperty(document, 'fonts', { configurable: true, value: undefined });
    snapshot = { ...snapshot, terminalFamily: 'Menlo', terminalSize: 17 };
    const ctx = context();
    render(<TerminalTabBody state={runningState} ctx={ctx} active />);
    await flushWork();
    const entry = entries.get(ctx.tabId)!;
    expect(entry.terminal.options.fontFamily).toContain('Menlo');
    expect(entry.terminal.options.fontFamily).toContain(ORIGINAL_FAMILY);
    expect(entry.terminal.options.fontSize).toBe(17);
    expect(loadFonts).not.toHaveBeenCalled();
  });

  it('falls back after font loading fails and can apply a later working font', async () => {
    const ctx = context();
    render(<TerminalTabBody state={runningState} ctx={ctx} active />);
    await flushWork();
    loadFonts.mockRejectedValueOnce(new Error('Font unavailable'));
    await broadcast({ terminalFamily: 'Unavailable Mono', terminalSize: 17 });
    const entry = entries.get(ctx.tabId)!;
    expect(entry.terminal.options.fontFamily).toBe(ORIGINAL_FAMILY);
    expect(entry.terminal.options.fontSize).toBe(17);
    expect(api.terminal.restart).not.toHaveBeenCalled();

    await broadcast({ terminalFamily: 'Menlo', terminalSize: 18 });
    expect(entry.terminal.options.fontFamily).toContain('Menlo');
    expect(entry.terminal.options.fontSize).toBe(18);
  });

  it('does not touch a closed terminal when its outstanding font load resolves', async () => {
    const ctx = context();
    const view = render(<TerminalTabBody state={runningState} ctx={ctx} active />);
    await flushWork();
    const pending = deferred<FontFace[]>();
    loadFonts.mockReturnValueOnce(pending.promise);
    await broadcast({ terminalFamily: 'Slow Mono', terminalSize: 22 });
    const entry = entries.get(ctx.tabId)!;
    view.unmount();
    entry.terminal.dispose(); // The plugin disposes the pooled instance on close.
    const optionsBeforeClose = { ...entry.terminal.options };
    entry.fitAddon.fit.mockClear();
    api.terminal.resize.mockClear();
    entry.terminal.focus.mockClear();
    pending.resolve([]);
    await flushWork();
    expect(entry.terminal.options).toEqual(optionsBeforeClose);
    expect(entry.fitAddon.fit).not.toHaveBeenCalled();
    expect(api.terminal.resize).not.toHaveBeenCalled();
    expect(entry.terminal.focus).not.toHaveBeenCalled();
  });
});
