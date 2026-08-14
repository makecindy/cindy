// RsbWindowController 状态机单测(纯 DI,不 mock electron):
//  - prewarm / open / close / setDetached 的落盘 + 广播行为
//  - 双阶段就绪握手(renderer-ready → presentation-ready)
//  - 隐藏复用(close = hide, 不销毁; setDetached(false) = 真正 destroy)
//  - 崩溃恢复有界
//  - getHostWebContents 三态(detached+open → 子窗;否则主窗)
//  - setContext 缓存 + 仅窗口活跃时转发;routeCommand 原子裁决宿主

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, WebContents } from 'electron';

import { RsbWindowController, type RsbWindowControllerDeps } from '../controller.js';
import type { RsbWindowSettings } from '../settings-store.js';

interface FakeWindow {
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  showInactive: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  isMinimized: () => boolean;
  isVisible: () => boolean;
  isDestroyed: () => boolean;
  destroyed: boolean;
  visible: boolean;
  webContents: {
    id: number;
    on: ReturnType<typeof vi.fn>;
    setBackgroundThrottling: ReturnType<typeof vi.fn>;
    isDestroyed: () => boolean;
  };
  emitClosed: () => void;
  emitWindowEvent: (event: string, ...args: unknown[]) => void;
  emitWebContentsEvent: (event: string, ...args: unknown[]) => void;
}

function fakeWindow(id = 1): FakeWindow {
  const winListeners = new Map<string, (...args: unknown[]) => void>();
  const wcListeners = new Map<string, (...args: unknown[]) => void>();
  let destroyed = false;
  let visible = false;
  let minimized = false;
  const webContentsOn = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    wcListeners.set(event, cb);
  });
  const win: FakeWindow = {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      winListeners.set(event, cb);
    }),
    close: vi.fn(() => {
      let prevented = false;
      winListeners.get('close')?.({ preventDefault: () => { prevented = true; } });
      if (prevented) return;
      destroyed = true;
      visible = false;
      winListeners.get('closed')?.();
    }),
    destroy: vi.fn(() => {
      destroyed = true;
      visible = false;
      winListeners.get('closed')?.();
    }),
    hide: vi.fn(() => { visible = false; }),
    show: vi.fn(() => { visible = true; }),
    showInactive: vi.fn(() => { visible = true; }),
    focus: vi.fn(),
    restore: vi.fn(() => {
      minimized = false;
      winListeners.get('restore')?.();
    }),
    isMinimized: () => minimized,
    isVisible: () => visible,
    isDestroyed: () => destroyed,
    destroyed: false,
    visible: false,
    webContents: {
      id,
      on: webContentsOn,
      setBackgroundThrottling: vi.fn(),
      isDestroyed: () => destroyed,
    },
    emitClosed: () => {
      destroyed = true;
      visible = false;
      winListeners.get('closed')?.();
    },
    emitWindowEvent: (event, ...args) => {
      if (event === 'minimize') minimized = true;
      if (event === 'restore') minimized = false;
      if (event === 'hide') visible = false;
      if (event === 'show') visible = true;
      winListeners.get(event)?.(...args);
    },
    emitWebContentsEvent: (event, ...args) => wcListeners.get(event)?.(...args),
  };
  return win;
}

function makeHarness(initial: Partial<RsbWindowSettings> = {}) {
  let settings: RsbWindowSettings = { detached: false, lastOpen: false, ...initial };
  let quitting = false;
  const windows: FakeWindow[] = [];
  const createWindowCalls: Array<Record<string, never>> = [];
  const mainWin = fakeWindow(100);
  const broadcasts: Array<{ detached: boolean; open: boolean }> = [];
  const sends: Array<{ channel: string; payload: unknown }> = [];
  const sendTargets: number[] = [];

  const deps: RsbWindowControllerDeps = {
    settings: {
      read: () => ({ ...settings }),
      writePatch: (patch) => { settings = { ...settings, ...patch }; },
    },
    createWindow: () => {
      createWindowCalls.push({});
      const w = fakeWindow(200 + windows.length);
      windows.push(w);
      return w as unknown as BrowserWindow;
    },
    getMainWindow: () => mainWin as unknown as BrowserWindow,
    broadcastState: (s) => { broadcasts.push(s); },
    sendToWindow: (win, channel, payload) => {
      sends.push({ channel, payload });
      sendTargets.push((win.webContents as unknown as FakeWindow['webContents']).id);
    },
    contextChannel: 'ctx-channel',
    commandChannel: 'cmd-channel',
    tabHandoffChannel: 'handoff-channel',
    isQuitting: () => quitting,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const controller = new RsbWindowController(deps);
  return {
    controller,
    windows,
    createWindowCalls,
    mainWin,
    broadcasts,
    sends,
    sendTargets,
    getSettings: () => settings,
    setQuitting: (v: boolean) => { quitting = v; },
  };
}

function markReady(controller: RsbWindowController, win: FakeWindow): void {
  expect(controller.markRendererReady(win.webContents as unknown as WebContents)).toBe(true);
  expect(controller.markPresentationReady(win.webContents as unknown as WebContents)).toBe(true);
}

const ctx = { sessionId: 's1', workdir: '/w', remoteHostId: null, available: true };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

// ═══════════════════════════════════════════════════════════════════════
// prewarm: 后台预热
// ═══════════════════════════════════════════════════════════════════════
describe('prewarm', () => {
  it('prewarm creates window without showing or focusing it', () => {
    const h = makeHarness();
    h.controller.prewarm();
    expect(h.windows).toHaveLength(1);
    const win = h.windows[0];
    expect(win.webContents.setBackgroundThrottling).toHaveBeenCalledWith(false);
    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
    expect(h.getSettings().lastOpen).toBe(false);
    expect(h.broadcasts).toHaveLength(0);
  });

  it('restores background throttling after presentation-ready', () => {
    const h = makeHarness();
    h.controller.prewarm();
    const win = h.windows[0];

    markReady(h.controller, win);

    expect(win.webContents.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
  });

  it('restores background throttling when hidden prewarm times out', () => {
    const h = makeHarness();
    h.controller.prewarm();
    const win = h.windows[0];

    vi.advanceTimersByTime(10_000);

    expect(win.webContents.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
    expect(h.controller.getState().open).toBe(false);
  });

  it('prewarm is no-op when disposed', () => {
    const h = makeHarness();
    h.controller.dispose();
    h.controller.prewarm();
    expect(h.windows).toHaveLength(0);
  });

  it('open on a prewarmed completed window shows + focuses immediately', () => {
    const h = makeHarness();
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);

    h.controller.open({ userInitiated: true });
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(h.windows).toHaveLength(1);
  });

  it('open on a prewarmed but not-ready window waits for presentation-ready', () => {
    const h = makeHarness();
    h.controller.prewarm();
    const win = h.windows[0];
    // Only renderer-ready, not presentation-ready
    expect(h.controller.markRendererReady(win.webContents as unknown as WebContents)).toBe(true);

    h.controller.open({ userInitiated: true });
    // Not shown yet — waiting for presentation
    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();

    // presentation-ready → now shown
    expect(h.controller.markPresentationReady(win.webContents as unknown as WebContents)).toBe(true);
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// open / close: 隐藏复用
// ═══════════════════════════════════════════════════════════════════════
describe('open / close (hide-reuse)', () => {
  it('open creates window + sets lastOpen=true + broadcasts open:true', () => {
    const h = makeHarness();
    h.controller.open();
    expect(h.windows).toHaveLength(1);
    expect(h.getSettings().lastOpen).toBe(true);
    expect(h.broadcasts.at(-1)).toEqual({ detached: false, open: true });
  });

  it('repeat open on shown window only focuses', () => {
    const h = makeHarness();
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);
    h.controller.open();
    expect(h.windows).toHaveLength(1);

    win.show.mockClear();
    win.focus.mockClear();
    h.controller.open();
    // Only focus (show would be redundant since already visible)
    expect(h.windows).toHaveLength(1);
  });

  it('close hides window without destroying (hide-reuse)', () => {
    const h = makeHarness();
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);
    h.controller.open();

    h.controller.close();
    expect(win.hide).toHaveBeenCalled();
    expect(win.isDestroyed()).toBe(false);
    expect(h.getSettings().lastOpen).toBe(false);
    expect(h.broadcasts.at(-1)).toEqual({ detached: false, open: false });
  });

  it('re-open after close reuses the same window (hot path)', () => {
    const h = makeHarness();
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);
    h.controller.open();
    h.controller.close();

    win.show.mockClear();
    win.focus.mockClear();
    h.controller.open();
    // Same window, no recreate
    expect(h.windows).toHaveLength(1);
    expect(h.windows[0]).toBe(win);
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
  });

  it('native minimize exposes a recovery entry and open restores the hot window', () => {
    const h = makeHarness({ detached: true });
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);
    h.controller.open();

    win.emitWindowEvent('minimize');
    expect(h.controller.getState()).toEqual({ detached: true, lastOpen: true, open: false });
    expect(h.broadcasts.at(-1)).toEqual({ detached: true, open: false });

    win.show.mockClear();
    win.focus.mockClear();
    h.controller.open();
    expect(h.windows).toHaveLength(1);
    expect(win.restore).toHaveBeenCalledOnce();
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
    expect(h.controller.getState().open).toBe(true);
  });

  it('native taskbar restore updates the main-window state mirror', () => {
    const h = makeHarness({ detached: true });
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);
    h.controller.open();
    win.emitWindowEvent('minimize');

    win.emitWindowEvent('restore');
    expect(h.broadcasts.at(-1)).toEqual({ detached: true, open: true });
    expect(h.controller.getState().open).toBe(true);
  });

  it('native hide updates state and open shows the cached window again', () => {
    const h = makeHarness({ detached: true });
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);
    h.controller.open();

    win.emitWindowEvent('hide');
    expect(h.controller.getState()).toEqual({ detached: true, lastOpen: true, open: false });
    expect(h.broadcasts.at(-1)).toEqual({ detached: true, open: false });

    win.show.mockClear();
    win.focus.mockClear();
    h.controller.open();
    expect(h.windows).toHaveLength(1);
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
    expect(h.controller.getState().open).toBe(true);
  });

  it('open repairs stale controller visibility using the native window state', () => {
    const h = makeHarness({ detached: true });
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);
    h.controller.open();

    // Simulate an external native hide that happened before the controller learned about it.
    win.hide();
    win.show.mockClear();
    win.focus.mockClear();

    h.controller.open();
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
    expect(h.controller.getState().open).toBe(true);
  });
});

describe('renderer navigation lifecycle', () => {
  it('ignores same-document main-frame navigation such as hash routing', () => {
    const h = makeHarness({ detached: true });
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);
    h.controller.open();

    win.hide.mockClear();
    win.emitWebContentsEvent(
      'did-start-navigation',
      {},
      'http://localhost:5173/?sidebarWindow=1#/sidebar-window',
      true,
      true,
    );

    expect(win.hide).not.toHaveBeenCalled();
    expect(h.controller.getState().open).toBe(true);
  });

  it('ignores child-frame navigation such as a newly attached browser webview', () => {
    const h = makeHarness({ detached: true });
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);
    h.controller.open();

    win.hide.mockClear();
    win.emitWebContentsEvent(
      'did-start-navigation',
      {},
      'https://example.com/',
      false,
      false,
    );

    expect(win.hide).not.toHaveBeenCalled();
    expect(h.controller.getState().open).toBe(true);
  });

  it('temporarily hides and restores only for main-frame renderer navigation', () => {
    const h = makeHarness({ detached: true });
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);
    h.controller.open();

    win.emitWebContentsEvent(
      'did-start-navigation',
      {},
      'http://localhost:5173/?sidebarWindow=1#/sidebar-window',
      false,
      true,
    );
    expect(win.hide).toHaveBeenCalledOnce();
    expect(win.webContents.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
    expect(h.controller.getState().open).toBe(true);

    markReady(h.controller, win);
    expect(win.webContents.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
    expect(win.show).toHaveBeenCalledTimes(2);
    expect(h.controller.getState().open).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// setDetached
// ═══════════════════════════════════════════════════════════════════════
describe('setDetached', () => {
  it('true: sets preference + opens window', () => {
    const h = makeHarness();
    const state = h.controller.setDetached(true);
    expect(h.getSettings().detached).toBe(true);
    expect(h.windows).toHaveLength(1);
    expect(h.createWindowCalls).toHaveLength(1);
    expect(state).toEqual({ detached: true, lastOpen: true, open: true });
  });

  it('true: queues a memory-only tab snapshot until the detached renderer is ready', () => {
    const h = makeHarness();
    h.controller.setContext(ctx);
    const handoff = {
      snapshots: [
        {
          sessionId: 's1',
          tabs: [{ id: 't1', kind: 'web-browser', state: { url: 'about:blank' } }],
          activeTabId: 't1',
          persistable: false as const,
        },
      ],
    };

    h.controller.setDetached(true, handoff);
    const win = h.windows[0];
    expect(h.sends.some((entry) => entry.channel === 'handoff-channel')).toBe(false);

    markReady(h.controller, win);

    const handoffIndex = h.sends.findIndex((entry) => entry.channel === 'handoff-channel');
    expect(h.sends[handoffIndex]).toEqual({ channel: 'handoff-channel', payload: handoff });
    expect(h.sendTargets[handoffIndex]).toBe(win.webContents.id);
  });

  it('true: drops a queued snapshot if the main context changes before renderer ready', () => {
    const h = makeHarness();
    h.controller.setContext(ctx);
    h.controller.setDetached(true, {
      snapshots: [
        {
          sessionId: 's1',
          tabs: [{ id: 't1', kind: 'web-browser', state: null }],
          activeTabId: 't1',
          persistable: false,
        },
      ],
    });
    h.controller.setContext({ ...ctx, sessionId: 's2' });

    markReady(h.controller, h.windows[0]);

    expect(h.sends.some((entry) => entry.channel === 'handoff-channel')).toBe(false);
  });

  it('false: destroys window + broadcasts detached:false', () => {
    const h = makeHarness({ detached: true });
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);
    h.controller.open();

    const state = h.controller.setDetached(false);
    expect(h.getSettings().detached).toBe(false);
    expect(win.isDestroyed()).toBe(true);
    expect(state.open).toBe(false);
    expect(h.broadcasts.at(-1)).toEqual({ detached: false, open: false });
  });

  it('false: hands off the current memory-only tab snapshot before destroying the window', () => {
    const h = makeHarness({ detached: true });
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);
    h.controller.setContext(ctx);
    h.controller.open({ userInitiated: false });

    const handoff = {
      snapshots: [
        {
          sessionId: 's1',
          tabs: [{ id: 't1', kind: 'web-browser', state: { url: 'https://example.com' } }],
          activeTabId: 't1',
          persistable: false,
        },
      ],
    };
    h.controller.setDetached(false, handoff);

    const handoffIndex = h.sends.findIndex((entry) => entry.channel === 'handoff-channel');
    expect(handoffIndex).toBeGreaterThanOrEqual(0);
    expect(h.sends[handoffIndex]).toEqual({
      channel: 'handoff-channel',
      payload: handoff,
    });
    expect(h.sendTargets[handoffIndex]).toBe(h.mainWin.webContents.id);
    expect(win.destroy).toHaveBeenCalledOnce();
  });

  it('drops persistable snapshots but preserves a stale-session merge snapshot', () => {
    const h = makeHarness({ detached: true });
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);
    h.controller.setContext(ctx);
    h.controller.open({ userInitiated: false });
    h.controller.setContext({ ...ctx, sessionId: 's2' });

    h.controller.setDetached(false, {
      snapshots: [
        {
          sessionId: 's1',
          tabs: [],
          activeTabId: null,
          persistable: true,
        },
        {
          sessionId: 'other',
          tabs: [],
          activeTabId: null,
          persistable: false,
        },
      ],
    });

    const handoffIndex = h.sends.findIndex((entry) => entry.channel === 'handoff-channel');
    expect(h.sends[handoffIndex]).toEqual({
      channel: 'handoff-channel',
      payload: {
        snapshots: [
          {
            sessionId: 'other',
            tabs: [],
            activeTabId: null,
            persistable: false,
          },
        ],
      },
    });
    expect(h.sendTargets[handoffIndex]).toBe(h.mainWin.webContents.id);
    expect(win.destroy).toHaveBeenCalledOnce();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// closed 事件(用户用 OS 关闭按钮 vs app 退出)
// ═══════════════════════════════════════════════════════════════════════
describe('closed event', () => {
  it('non-quitting: lastOpen=false + broadcast open:false', () => {
    const h = makeHarness();
    h.controller.open();
    h.windows[0].emitClosed();
    expect(h.getSettings().lastOpen).toBe(false);
    expect(h.broadcasts.at(-1)).toEqual({ detached: false, open: false });
    expect(h.controller.getState().open).toBe(false);
  });

  it('quitting: preserves lastOpen=true, no broadcast', () => {
    const h = makeHarness();
    h.controller.open();
    const count = h.broadcasts.length;
    h.setQuitting(true);
    h.windows[0].emitClosed();
    expect(h.getSettings().lastOpen).toBe(true);
    expect(h.broadcasts).toHaveLength(count);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// userInitiated:false 不抢用户前台
// ═══════════════════════════════════════════════════════════════════════
describe('userInitiated:false', () => {
  it('window already visible: automated open is no-op', () => {
    const h = makeHarness();
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);
    h.controller.open({ userInitiated: true });

    win.show.mockClear();
    win.showInactive.mockClear();
    win.focus.mockClear();
    h.controller.open({ userInitiated: false });
    expect(win.show).not.toHaveBeenCalled();
    expect(win.showInactive).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
  });

  it('prewarmed ready window: automated open shows without focusing', () => {
    const h = makeHarness();
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);

    h.controller.open({ userInitiated: false });

    expect(win.showInactive).toHaveBeenCalledTimes(1);
    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
    expect(h.controller.getState().open).toBe(true);
  });

  it('window not yet built: shows without focusing after presentation-ready', () => {
    const h = makeHarness();
    h.controller.open({ userInitiated: false });
    expect(h.windows).toHaveLength(1);
    expect(h.createWindowCalls).toHaveLength(1);
    const win = h.windows[0];

    markReady(h.controller, win);

    expect(win.showInactive).toHaveBeenCalledTimes(1);
    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
  });

  it('not-ready window: automated open fallback shows without focusing', () => {
    const h = makeHarness();
    h.controller.open({ userInitiated: false });
    const win = h.windows[0];

    vi.advanceTimersByTime(5000);

    expect(win.showInactive).toHaveBeenCalledTimes(1);
    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
  });

  it('not-ready window: later user open upgrades pending show to focused', () => {
    const h = makeHarness();
    h.controller.open({ userInitiated: false });
    const win = h.windows[0];

    h.controller.open({ userInitiated: true });
    markReady(h.controller, win);

    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.showInactive).not.toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  it('setDetached(true) opens window', () => {
    const h = makeHarness();
    h.controller.setDetached(true);
    expect(h.windows).toHaveLength(1);
    expect(h.createWindowCalls).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ensureOpenForAutomation
// ═══════════════════════════════════════════════════════════════════════
describe('ensureOpenForAutomation', () => {
  it('non-detached: no-op resolve', async () => {
    const h = makeHarness();
    await expect(h.controller.ensureOpenForAutomation()).resolves.toBeUndefined();
    expect(h.windows).toHaveLength(0);
  });

  it('detached + presentation-ready: direct resolve', async () => {
    const h = makeHarness({ detached: true });
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);
    await expect(h.controller.ensureOpenForAutomation()).resolves.toBeUndefined();
    expect(win.showInactive).toHaveBeenCalledTimes(1);
    expect(win.focus).not.toHaveBeenCalled();
  });

  it('detached + no window: opens and waits for presentation-ready', async () => {
    const h = makeHarness({ detached: true });
    const pending = h.controller.ensureOpenForAutomation();
    expect(h.windows).toHaveLength(1);
    const win = h.windows[0];
    expect(h.controller.markRendererReady(win.webContents as unknown as WebContents)).toBe(true);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    h.controller.markPresentationReady(win.webContents as unknown as WebContents);
    await expect(pending).resolves.toBeUndefined();
  });

  it('ready timeout rejects', async () => {
    const h = makeHarness({ detached: true });
    const pending = h.controller.ensureOpenForAutomation();
    // ensureOpenForAutomation 内部 readyWaiter 超时为 READY_TIMEOUT_MS(8s)。
    // 5s openFallback 会 showInactive 但不影响 readyWaiter。
    const assertion = expect(pending).rejects.toThrow(/ready timeout/);
    vi.advanceTimersByTime(8000);
    await assertion;
  });

  it('window closed before ready rejects', async () => {
    const h = makeHarness({ detached: true });
    const pending = h.controller.ensureOpenForAutomation();
    const assertion = expect(pending).rejects.toThrow(/closed before ready/);
    h.windows[0].emitClosed();
    await assertion;
  });
});

// ═══════════════════════════════════════════════════════════════════════
// getHostWebContents
// ═══════════════════════════════════════════════════════════════════════
describe('getHostWebContents', () => {
  it('non-detached → main window webContents', () => {
    const h = makeHarness();
    expect(h.controller.getHostWebContents()).toBe(h.mainWin.webContents);
  });

  it('detached + no window → main window', () => {
    const h = makeHarness({ detached: true });
    expect(h.controller.getHostWebContents()).toBe(h.mainWin.webContents);
  });

  it('detached + window open → child window webContents', () => {
    const h = makeHarness({ detached: true });
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);
    h.controller.open();
    expect(h.controller.getHostWebContents()).toBe(win.webContents);
  });

  it('detached + cached window hidden → main window webContents', () => {
    const h = makeHarness({ detached: true });
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);
    h.controller.open();
    h.controller.close();

    expect(h.controller.getHostWebContents()).toBe(h.mainWin.webContents);
  });

  it('detached + native-minimized window → main window webContents', () => {
    const h = makeHarness({ detached: true });
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);
    h.controller.open();
    win.emitWindowEvent('minimize');

    expect(h.controller.getHostWebContents()).toBe(h.mainWin.webContents);
  });

  it('after destroy: falls back to main', () => {
    const h = makeHarness({ detached: true });
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);
    h.controller.open();
    h.controller.setDetached(false);
    expect(h.controller.getHostWebContents()).toBe(h.mainWin.webContents);
  });
});

describe('getVisibleSidebarWebContents', () => {
  it('returns null for a cached hidden window while keeping the IPC sender available', () => {
    const h = makeHarness({ detached: true });
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);

    expect(h.controller.getSidebarWebContents()).toBe(win.webContents);
    expect(h.controller.getVisibleSidebarWebContents()).toBeNull();

    h.controller.open({ userInitiated: false });
    expect(h.controller.getVisibleSidebarWebContents()).toBe(win.webContents);

    h.controller.close();
    expect(h.controller.getVisibleSidebarWebContents()).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// setContext / routeCommand
// ═══════════════════════════════════════════════════════════════════════
describe('setContext / routeCommand', () => {
  function terminalRequest(sessionId = 's1', allowOpen = true) {
    return { command: { type: 'open-terminal' as const, sessionId }, allowOpen };
  }

  it('keeps live context out of a hidden prewarm and exposes it after opening', () => {
    const h = makeHarness();
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);
    h.controller.setContext(ctx);
    expect(h.sends.filter((entry) => entry.channel === 'ctx-channel')).toEqual([]);
    expect(h.controller.getContext()).toBeNull();

    h.controller.open();
    expect(h.controller.getContext()).toEqual(ctx);
    h.controller.refreshContext(win.webContents as unknown as WebContents);
    expect(h.sends.at(-1)).toEqual({ channel: 'ctx-channel', payload: ctx });

    h.controller.setContext({ ...ctx, sessionId: 's2' });
    expect(h.sends.at(-1)).toEqual({
      channel: 'ctx-channel',
      payload: { ...ctx, sessionId: 's2' },
    });
  });

  it('ignores refreshContext while the cached sidebar window is hidden', () => {
    const h = makeHarness({ detached: true });
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);
    h.controller.setContext(ctx);

    h.controller.refreshContext(win.webContents as unknown as WebContents);
    expect(h.sends.filter((entry) => entry.channel === 'ctx-channel')).toEqual([]);

    h.controller.open();
    h.controller.refreshContext(win.webContents as unknown as WebContents);
    expect(h.sends.filter((entry) => entry.channel === 'ctx-channel')).toEqual([
      { channel: 'ctx-channel', payload: ctx },
    ]);

    h.controller.close();
    h.controller.refreshContext(win.webContents as unknown as WebContents);
    expect(h.sends.filter((entry) => entry.channel === 'ctx-channel')).toEqual([
      { channel: 'ctx-channel', payload: ctx },
    ]);
  });

  it('detached + allowOpen: opens window, waits ready, routes', async () => {
    const h = makeHarness({ detached: true });
    h.controller.setContext(ctx);
    const pending = h.controller.routeCommand(terminalRequest());
    expect(h.windows).toHaveLength(1);
    expect(h.sends).toHaveLength(0);
    const win = h.windows[0];
    markReady(h.controller, win);
    await expect(pending).resolves.toBe('routed');
    expect(h.sends.at(-1)).toEqual({
      channel: 'cmd-channel',
      payload: { type: 'open-terminal', sessionId: 's1' },
    });
  });

  it('context mismatch returns stale-context', async () => {
    const h = makeHarness({ detached: true });
    h.controller.setContext({ ...ctx, sessionId: 's2' });
    await expect(h.controller.routeCommand(terminalRequest())).resolves.toBe('stale-context');
  });

  it('allowOpen=false + window hidden: stays queued through prewarm and flushes on open', async () => {
    const h = makeHarness({ detached: true });
    h.controller.setContext(ctx);
    const cmd = { type: 'close-orca-workers-tab' as const, sessionId: 's1' };
    await expect(
      h.controller.routeCommand({ command: cmd, allowOpen: false }),
    ).resolves.toBe('queued');
    expect(h.windows).toHaveLength(0);

    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);
    expect(h.sends.filter((entry) => entry.channel === 'cmd-channel')).toEqual([]);

    h.controller.open();
    expect(h.sends.at(-1)).toEqual({ channel: 'cmd-channel', payload: cmd });
  });

  it('queues passive commands while a cached detached window is hidden and flushes on reopen', async () => {
    const h = makeHarness({ detached: true });
    h.controller.setContext(ctx);
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);
    h.controller.open();
    h.controller.close();
    h.sends.length = 0;

    const cmd = { type: 'close-orca-workers-tab' as const, sessionId: 's1' };
    await expect(
      h.controller.routeCommand({ command: cmd, allowOpen: false }),
    ).resolves.toBe('queued');
    expect(h.sends).toEqual([]);

    h.controller.open();
    expect(h.sends).toContainEqual({ channel: 'cmd-channel', payload: cmd });
  });

  it('detach preference change mid-wait: returns attached, no send to destroyed host', async () => {
    const h = makeHarness({ detached: true });
    h.controller.setContext(ctx);
    const pending = h.controller.routeCommand(terminalRequest());
    expect(h.windows).toHaveLength(1);

    h.controller.setDetached(false);
    // setDetached(false) now destroys the window
    await expect(pending).resolves.toBe('attached');
    expect(h.sends.filter(e => e.channel === 'cmd-channel')).toEqual([]);
  });

  it('context switch during ready wait: returns stale-context', async () => {
    const h = makeHarness({ detached: true });
    h.controller.setContext(ctx);
    const pending = h.controller.routeCommand(terminalRequest());
    h.controller.setContext({ ...ctx, sessionId: 's2' });
    const win = h.windows[0];
    markReady(h.controller, win);
    await expect(pending).resolves.toBe('stale-context');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 崩溃恢复
// ═══════════════════════════════════════════════════════════════════════
describe('crash recovery', () => {
  it('did-fail-load invalidates window and rebuilds if pendingOpen', () => {
    const h = makeHarness();
    h.controller.open();
    const win = h.windows[0];
    expect(h.controller.markRendererReady(win.webContents as unknown as WebContents)).toBe(true);

    // Simulate load failure
    win.emitWebContentsEvent('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'url', true);
    vi.advanceTimersByTime(10);

    // Window should have been destroyed and a new one created (auto-recovery)
    expect(win.isDestroyed()).toBe(true);
    expect(h.windows).toHaveLength(2);
  });

  it('render-process-gone invalidates window with bounded recovery', () => {
    const h = makeHarness();
    h.controller.prewarm();
    const win1 = h.windows[0];
    markReady(h.controller, win1);
    h.controller.open();

    // First crash: auto-recover
    win1.emitWebContentsEvent('render-process-gone', {}, { reason: 'crashed' });
    vi.advanceTimersByTime(10);
    expect(win1.isDestroyed()).toBe(true);
    expect(h.windows).toHaveLength(2); // new window created

    // Second crash: recovery exhausted
    const win2 = h.windows[1];
    markReady(h.controller, win2);
    win2.emitWebContentsEvent('render-process-gone', {}, { reason: 'killed' });
    vi.advanceTimersByTime(10);
    expect(h.windows).toHaveLength(2); // no third window
  });

  it('recovery quota resets after stability period', () => {
    const h = makeHarness();
    h.controller.open();
    const win1 = h.windows[0];
    markReady(h.controller, win1);

    win1.emitWebContentsEvent('render-process-gone', {}, { reason: 'crashed' });
    vi.advanceTimersByTime(10);
    expect(h.windows).toHaveLength(2);

    // Wait for stability period
    vi.advanceTimersByTime(30_000);

    // Recovery creates win2; need to open (request visibility) before second crash.
    const win2 = h.windows[1];
    markReady(h.controller, win2);
    h.controller.open();
    win2.emitWebContentsEvent('render-process-gone', {}, { reason: 'crashed' });
    vi.advanceTimersByTime(10);
    expect(h.windows).toHaveLength(3); // recovery quota reset allows third window
  });
});

// ═══════════════════════════════════════════════════════════════════════
// dispose
// ═══════════════════════════════════════════════════════════════════════
describe('dispose', () => {
  it('dispose destroys the window and prevents further prewarm', () => {
    const h = makeHarness();
    h.controller.prewarm();
    const win = h.windows[0];
    h.controller.dispose();
    expect(win.isDestroyed()).toBe(true);

    // prewarm should be no-op after dispose
    h.controller.prewarm();
    expect(h.windows).toHaveLength(1); // no new window
  });

  it('dispose is idempotent', () => {
    const h = makeHarness();
    h.controller.prewarm();
    h.controller.dispose();
    h.controller.dispose();
    // Does not throw
  });
});

// ═══════════════════════════════════════════════════════════════════════
// sender guard: markRendererReady/markPresentationReady reject wrong sender
// ═══════════════════════════════════════════════════════════════════════
describe('sender guard', () => {
  it('markRendererReady rejects non-sidebar sender', () => {
    const h = makeHarness();
    h.controller.prewarm();
    const wrongSender = { id: 999 } as unknown as WebContents;
    expect(h.controller.markRendererReady(wrongSender)).toBe(false);
  });

  it('markPresentationReady rejects non-sidebar sender', () => {
    const h = makeHarness();
    h.controller.prewarm();
    const wrongSender = { id: 999 } as unknown as WebContents;
    expect(h.controller.markPresentationReady(wrongSender)).toBe(false);
  });

  it('refreshContext rejects non-sidebar sender', () => {
    const h = makeHarness();
    h.controller.prewarm();
    const win = h.windows[0];
    markReady(h.controller, win);
    h.controller.setContext({ sessionId: 's1', workdir: '/w', remoteHostId: null, available: true });
    // setContext sends to the window when alive, so there is already traffic.
    const sendCountBefore = h.sends.length;
    const wrongSender = { id: 999 } as unknown as WebContents;
    h.controller.refreshContext(wrongSender);
    // No additional send from refreshContext with wrong sender
    expect(h.sends.length).toBe(sendCountBefore);
  });

  it('同会话多条不同 passive 命令保序全量下发,不再互相覆盖(#2409)', async () => {
    const h = makeHarness({ detached: true });
    h.controller.setContext(ctx);
    const register = {
      type: 'ensure-orca-workers-tab' as const,
      sessionId: 's1',
      focusWorkerSessionId: 'worker-s1',
      focusTab: false,
    };
    const close = { type: 'close-orca-workers-tab' as const, sessionId: 's1' };
    await expect(h.controller.routeCommand({ command: register, allowOpen: false })).resolves.toBe('queued');
    await expect(h.controller.routeCommand({ command: close, allowOpen: false })).resolves.toBe('queued');

    h.controller.open();
    markReady(h.controller, h.windows[0]);
    const delivered = h.sends.filter((entry) => entry.channel === 'cmd-channel').map((entry) => entry.payload);
    expect(delivered).toEqual([register, close]);
  });

  it('切 attached 时同会话多条 deferred 命令按序转交主 renderer(#2409)', async () => {
    const h = makeHarness({ detached: true });
    h.controller.setContext(ctx);
    const register = {
      type: 'ensure-orca-workers-tab' as const,
      sessionId: 's1',
      focusWorkerSessionId: 'worker-s1',
      focusTab: false,
    };
    const close = { type: 'close-orca-workers-tab' as const, sessionId: 's1' };
    await h.controller.routeCommand({ command: register, allowOpen: false });
    await h.controller.routeCommand({ command: close, allowOpen: false });

    h.controller.setDetached(false);
    const delivered = h.sends.filter((entry) => entry.channel === 'cmd-channel').map((entry) => entry.payload);
    expect(delivered).toEqual([register, close]);
    expect(h.sendTargets.slice(-2)).toEqual([
      h.mainWin.webContents.id,
      h.mainWin.webContents.id,
    ]);
  });

  it('完全等价的重复 passive 帧只登记一次(#2409)', async () => {
    const h = makeHarness({ detached: true });
    h.controller.setContext(ctx);
    const register = {
      type: 'ensure-orca-workers-tab' as const,
      sessionId: 's1',
      focusWorkerSessionId: 'worker-s1',
      focusTab: false,
    };
    await h.controller.routeCommand({ command: register, allowOpen: false });
    await h.controller.routeCommand({ command: { ...register }, allowOpen: false });

    h.controller.open();
    markReady(h.controller, h.windows[0]);
    expect(h.sends.filter((entry) => entry.channel === 'cmd-channel')).toHaveLength(1);
  });

  it('generic ensure 被合并后,显式 intent 与其他登记命令仍全量下发(#2409)', async () => {
    const h = makeHarness({ detached: true });
    h.controller.setContext(ctx);
    const explicit = {
      type: 'ensure-orca-workers-tab' as const,
      sessionId: 's1',
      focusWorkerSessionId: 'worker-s1',
      focusTab: false,
    };
    const close = { type: 'close-orca-workers-tab' as const, sessionId: 's1' };
    await h.controller.routeCommand({ command: explicit, allowOpen: false });
    await h.controller.routeCommand({
      command: { type: 'ensure-orca-workers-tab', sessionId: 's1', focusTab: false },
      allowOpen: false,
    });
    await h.controller.routeCommand({ command: close, allowOpen: false });

    h.controller.open();
    markReady(h.controller, h.windows[0]);
    const delivered = h.sends.filter((entry) => entry.channel === 'cmd-channel').map((entry) => entry.payload);
    expect(delivered).toEqual([explicit, close]);
  });

  it('close 之后的 generic ensure 不与屏障前的 ensure 合并,重开意图保留(#2511 review)', async () => {
    const h = makeHarness({ detached: true });
    h.controller.setContext(ctx);
    const explicit = {
      type: 'ensure-orca-workers-tab' as const,
      sessionId: 's1',
      focusWorkerSessionId: 'worker-s1',
      focusTab: false,
    };
    const close = { type: 'close-orca-workers-tab' as const, sessionId: 's1' };
    const reopen = { type: 'ensure-orca-workers-tab' as const, sessionId: 's1', focusTab: false };
    await h.controller.routeCommand({ command: explicit, allowOpen: false });
    await h.controller.routeCommand({ command: close, allowOpen: false });
    await h.controller.routeCommand({ command: reopen, allowOpen: false });

    h.controller.open();
    markReady(h.controller, h.windows[0]);
    const delivered = h.sends.filter((entry) => entry.channel === 'cmd-channel').map((entry) => entry.payload);
    expect(delivered).toEqual([explicit, close, reopen]);
  });

  it('隔着 close 的等价 ensure 帧不做跨屏障合并(#2511 review)', async () => {
    const h = makeHarness({ detached: true });
    h.controller.setContext(ctx);
    const ensure = { type: 'ensure-orca-workers-tab' as const, sessionId: 's1', focusTab: false };
    const close = { type: 'close-orca-workers-tab' as const, sessionId: 's1' };
    await h.controller.routeCommand({ command: ensure, allowOpen: false });
    await h.controller.routeCommand({ command: close, allowOpen: false });
    await h.controller.routeCommand({ command: { ...ensure }, allowOpen: false });

    h.controller.open();
    markReady(h.controller, h.windows[0]);
    const delivered = h.sends.filter((entry) => entry.channel === 'cmd-channel').map((entry) => entry.payload);
    expect(delivered).toEqual([ensure, close, ensure]);
  });

  it('同目标 open-turn-review 后帧取代前帧,不同 session 的并存(#2511 review)', async () => {
    const h = makeHarness({ detached: true });
    h.controller.setContext(ctx);
    const stale = {
      type: 'open-turn-review' as const,
      sessionId: 'worker-a',
      changeSetIds: ['cs-old'],
      requestNonce: 1,
      hostSessionId: 's1',
    };
    const fresh = {
      type: 'open-turn-review' as const,
      sessionId: 'worker-a',
      changeSetIds: ['cs-new'],
      requestNonce: 2,
      hostSessionId: 's1',
    };
    const other = {
      type: 'open-turn-review' as const,
      sessionId: 'worker-b',
      changeSetIds: ['cs-b'],
      requestNonce: 3,
      hostSessionId: 's1',
    };
    await h.controller.routeCommand({ command: stale, allowOpen: false });
    await h.controller.routeCommand({ command: other, allowOpen: false });
    await h.controller.routeCommand({ command: fresh, allowOpen: false });

    h.controller.open();
    markReady(h.controller, h.windows[0]);
    const delivered = h.sends.filter((entry) => entry.channel === 'cmd-channel').map((entry) => entry.payload);
    expect(delivered).toEqual([other, fresh]);
  });

});
