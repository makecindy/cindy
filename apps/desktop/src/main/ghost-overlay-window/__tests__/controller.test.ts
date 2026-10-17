// GhostOverlayWindowsController 生命周期状态机单测(DI only,不依赖 electron)。
// 覆盖:双阶段就绪、5s 超时壳、hide 复用、用户禁用拒绝、unmount、reconcile、
// owner 切换、崩溃恢复有界、多插件隔离、move/setInteractive 直通。

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow, WebContents } from 'electron';

import type { GhostOverlayWindowsState } from '../../../shared/ghostOverlayWindow.js';
import { GHOST_OVERLAY_WINDOW_VISIBILITY_CHANGED_CHANNEL } from '../../../shared/ghostOverlayWindow.js';
import type { InstalledGhost, GhostManifest } from '../../../shared/ghost.js';
import {
  clearGhostOverlayWebContents,
  isGhostOverlayWebContents,
  markGhostOverlayWebContentsId,
} from '../registry.js';
import {
  GhostOverlayWindowsController,
  type GhostOverlayWindowsControllerDeps,
} from '../controller.js';

interface FakeWindow {
  on: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  showInactive: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  setPosition: ReturnType<typeof vi.fn>;
  setIgnoreMouseEvents: ReturnType<typeof vi.fn>;
  isMinimized: () => boolean;
  isVisible: () => boolean;
  isDestroyed: () => boolean;
  visible: boolean;
  webContents: {
    id: number;
    send: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    isDestroyed: () => boolean;
  };
  emitClosed: () => void;
  emitWindowEvent: (event: string, ...args: unknown[]) => void;
  emitWebContentsEvent: (event: string, ...args: unknown[]) => void;
  _id: number;
}

let nextId = 1;
function fakeWindow(): FakeWindow {
  const id = nextId++;
  const winListeners = new Map<string, (...args: unknown[]) => void>();
  const wcListeners = new Map<string, (...args: unknown[]) => void>();
  let destroyed = false;
  let visible = false;
  const wcOn = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    wcListeners.set(event, cb);
  });
  const win: FakeWindow = {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      winListeners.set(event, cb);
    }),
    destroy: vi.fn(() => {
      destroyed = true;
      visible = false;
      winListeners.get('closed')?.();
    }),
    hide: vi.fn(() => {
      visible = false;
    }),
    show: vi.fn(() => {
      visible = true;
    }),
    showInactive: vi.fn(() => {
      visible = true;
    }),
    focus: vi.fn(),
    restore: vi.fn(),
    setPosition: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    isMinimized: () => false,
    isVisible: () => visible,
    isDestroyed: () => destroyed,
    visible: false,
    webContents: {
      id,
      send: vi.fn(),
      on: wcOn,
      isDestroyed: () => destroyed,
    },
    emitClosed: () => {
      destroyed = true;
      visible = false;
      winListeners.get('closed')?.();
    },
    emitWindowEvent: (event, ...args) => {
      if (event === 'hide') visible = false;
      if (event === 'show') visible = true;
      winListeners.get(event)?.(...args);
    },
    emitWebContentsEvent: (event, ...args) => wcListeners.get(event)?.(...args),
    _id: id,
  };
  return win;
}

function ghost(id: string, opts: { enabled?: boolean; overlay?: boolean; version?: string } = {}): InstalledGhost {
  const manifest: GhostManifest = {
    schemaVersion: 2,
    id,
    name: id,
    version: opts.version ?? '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    ...(opts.overlay !== false ? { overlay: { html: 'overlay.html' } } : {}),
  };
  return {
    manifest,
    dir: `/fake/${id}`,
    enabled: opts.enabled ?? true,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
  };
}

function makeHarness(
  declaredIds: Set<string>,
  userEnabledIds: Set<string> = declaredIds,
  hooks: {
    onVisibilityChanged?: (ghostId: string, visible: boolean) => void;
    onAllWindowsDestroyed?: () => void;
  } = {},
  opts: {
    createLoadCompleted?: boolean;
    resolveInstalledVersion?: (ghostId: string) => string | null;
  } = {},
) {
  let quitting = false;
  const created: Array<{ ghostId: string; win: FakeWindow }> = [];
  const broadcasts: GhostOverlayWindowsState[] = [];
  const log = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };

  const deps: GhostOverlayWindowsControllerDeps = {
    createWindow: async (ghostId, onWindowCreated) => {
      // 缺省 loadCompleted=false:就绪由测试手动驱动(IPC 或宿主事件)。
      // createLoadCompleted 模拟真实工厂在返回前 await loadURL 的已加载态。
      const win = fakeWindow();
      // 对齐 Task 3 工厂:窗口创建后登记 webContentsId ↔ ghostId,并经
      // onWindowCreated 回调在 loadURL 之前把"加载中"slot 交给 controller。
      markGhostOverlayWebContentsId(win.webContents.id, ghostId);
      onWindowCreated?.(win as unknown as BrowserWindow);
      created.push({ ghostId, win });
      return {
        win: win as unknown as BrowserWindow,
        loadCompleted: opts.createLoadCompleted ?? false,
      };
    },
    isGhostOverlayDeclared: (id) => declaredIds.has(id),
    isUserEnabled: (id) => userEnabledIds.has(id),
    resolveInstalledVersion: opts.resolveInstalledVersion,
    broadcastState: (s) => {
      broadcasts.push(s);
    },
    isQuitting: () => quitting,
    log,
    onVisibilityChanged: hooks.onVisibilityChanged,
    onAllWindowsDestroyed: hooks.onAllWindowsDestroyed,
  };
  const controller = new GhostOverlayWindowsController(deps);
  return {
    controller,
    created,
    broadcasts,
    log,
    setDeclared: (ghostId: string, declared: boolean) => {
      if (declared) declaredIds.add(ghostId);
      else declaredIds.delete(ghostId);
    },
    setUserEnabled: (ghostId: string, enabled: boolean) => {
      if (enabled) userEnabledIds.add(ghostId);
      else userEnabledIds.delete(ghostId);
    },
    setQuitting: (v: boolean) => {
      quitting = v;
    },
  };
}

function markReady(controller: GhostOverlayWindowsController, win: FakeWindow): void {
  controller.markRendererReady(win.webContents as unknown as WebContents);
  controller.markPresentationReady(win.webContents as unknown as WebContents);
}

/** 慢加载工厂:6s 后才完成 loadURL(>5s 壳超时,<10s 首载超时)。 */
function slowLoadHarness() {
  const created: Array<{ ghostId: string; win: FakeWindow }> = [];
  const log = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
  const deps: GhostOverlayWindowsControllerDeps = {
    createWindow: (ghostId, onWindowCreated) =>
      new Promise<{ win: BrowserWindow; loadCompleted: boolean }>((resolve) => {
        const win = fakeWindow();
        markGhostOverlayWebContentsId(win.webContents.id, ghostId);
        onWindowCreated?.(win as unknown as BrowserWindow);
        created.push({ ghostId, win });
        setTimeout(() => {
          resolve({ win: win as unknown as BrowserWindow, loadCompleted: true });
        }, 6000);
      }),
    isGhostOverlayDeclared: () => true,
    isUserEnabled: () => true,
    broadcastState: () => {},
    isQuitting: () => false,
    log,
  };
  return { controller: new GhostOverlayWindowsController(deps), created, log };
}

describe('prewarm', () => {
  it('prewarm creates hidden window without showing or focusing', async () => {
    const h = makeHarness(new Set(['a']));
    h.controller.prewarm('a');
    await vi.waitFor(() => expect(h.created).toHaveLength(1));
    const win = h.created[0].win;
    expect(win.showInactive).not.toHaveBeenCalled();
    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
    expect(h.controller.getState().a?.mounted).toBe(true);
  });

  it('prewarm is idempotent (single createWindow across concurrent and repeated calls)', async () => {
    const h = makeHarness(new Set(['a']));
    h.controller.prewarm('a');
    h.controller.prewarm('a');
    await h.controller.show('a');
    await h.controller.show('a');
    h.controller.prewarm('a');
    await Promise.resolve();
    expect(h.created).toHaveLength(1);
    expect(Object.keys(h.controller.getState())).toEqual(['a']);
  });
});

describe('two-phase ready', () => {
  it('does not show before both ready phases, shows after presentation-ready', async () => {
    const h = makeHarness(new Set(['a']));
    await h.controller.show('a');
    const win = h.created[0].win;
    expect(win.showInactive).not.toHaveBeenCalled();

    // 只有 renderer-ready 还不够:不得抢跑展示。
    h.controller.markRendererReady(win.webContents as unknown as WebContents);
    expect(win.showInactive).not.toHaveBeenCalled();

    h.controller.markPresentationReady(win.webContents as unknown as WebContents);
    expect(win.showInactive).toHaveBeenCalledTimes(1);
    expect(win.focus).not.toHaveBeenCalled(); // 浮窗永不抢焦点
    expect(h.controller.getState().a).toEqual({
      mounted: true,
      visible: true,
      interactive: false,
    });
  });
});

describe('host-driven ready (zero-bridge webContents events)', () => {
  it('dom-ready drives renderer-ready; did-finish-load + tick drives presentation-ready', async () => {
    const h = makeHarness(new Set(['a']));
    await h.controller.show('a');
    const win = h.created[0].win;

    // 工厂 loadCompleted=false 时不得直推:创建后未展示,就绪仍由事件驱动。
    expect(win.showInactive).not.toHaveBeenCalled();

    // 零桥浮窗没有 preload 发就绪 IPC:宿主 webContents 事件驱动就绪。
    win.emitWebContentsEvent('dom-ready');
    expect(win.showInactive).not.toHaveBeenCalled(); // 只有 renderer-ready 不够

    win.emitWebContentsEvent('did-finish-load');
    expect(win.showInactive).not.toHaveBeenCalled(); // 延一帧前不展示

    await new Promise((resolve) => setImmediate(resolve));
    expect(win.showInactive).toHaveBeenCalledTimes(1);
    expect(win.focus).not.toHaveBeenCalled();
    expect(h.controller.getState().a).toEqual({
      mounted: true,
      visible: true,
      interactive: false,
    });
  });

  it('marks ready on create when the factory reports loadCompleted', async () => {
    // 真实工厂在返回前 await loadURL:首次 dom-ready/did-finish-load 已发生,
    // 工厂返回 loadCompleted=true,controller 据此确定性直推双阶段就绪并 show。
    const h = makeHarness(new Set(['a']), new Set(['a']), {}, { createLoadCompleted: true });
    await h.controller.show('a');
    const win = h.created[0].win;

    await new Promise((resolve) => setImmediate(resolve));
    expect(win.showInactive).toHaveBeenCalledTimes(1);
    expect(h.controller.getState().a).toEqual({
      mounted: true,
      visible: true,
      interactive: false,
    });
  });
});

describe('show timeout (5s shell)', () => {
  it('renderer ready but content pending at timeout: shows the mounted shell', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness(new Set(['a']));
      await h.controller.show('a');
      const win = h.created[0].win;
      h.controller.markRendererReady(win.webContents as unknown as WebContents);

      await vi.advanceTimersByTimeAsync(5000);

      expect(win.showInactive).toHaveBeenCalledTimes(1);
      expect(win.focus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renderer never ready at timeout: never shows blank, rebuilds bounded', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness(new Set(['a']));
      await h.controller.show('a');
      const win1 = h.created[0].win;

      await vi.advanceTimersByTimeAsync(5000);

      // 壳未就绪:不得展示空白窗口,作废缓存并重建重开(有界恢复)。
      expect(win1.isDestroyed()).toBe(true);
      expect(h.created).toHaveLength(2);
      expect(h.created[1].win.showInactive).not.toHaveBeenCalled();

      // 恢复额度耗尽:重建窗口再次超时后不再重建,也不展示。
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.created).toHaveLength(2);
      expect(h.created[1].win.showInactive).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('hide / reuse', () => {
  it('hide keeps the renderer alive; show reuses the same window', async () => {
    const h = makeHarness(new Set(['a']));
    await h.controller.show('a');
    const win = h.created[0].win;
    markReady(h.controller, win);
    expect(win.showInactive).toHaveBeenCalledTimes(1);

    h.controller.hide('a');
    expect(win.hide).toHaveBeenCalled();
    expect(win.isDestroyed()).toBe(false);
    expect(win.webContents.send).toHaveBeenCalledWith(
      GHOST_OVERLAY_WINDOW_VISIBILITY_CHANGED_CHANNEL,
      { visible: false },
    );

    await h.controller.show('a');
    expect(h.created).toHaveLength(1); // 不重建
    expect(win.showInactive).toHaveBeenCalledTimes(2); // 复用同一 Renderer
  });

  it('hide resets interactive mouse capture so the next show does not block clicks', async () => {
    const h = makeHarness(new Set(['a']));
    await h.controller.show('a');
    const win = h.created[0].win;
    markReady(h.controller, win);

    h.controller.setInteractive('a', true);
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
    expect(h.controller.getState().a?.interactive).toBe(true);

    h.controller.hide('a');
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    expect(h.controller.getState().a?.interactive).toBe(false);

    // 再显示:插件页面重新判定命中前,窗口保持默认穿透,不拦截点击。
    await h.controller.show('a');
    expect(h.controller.getState().a?.interactive).toBe(false);
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
  });

  it('native hide also resets interactive mouse capture', async () => {
    const h = makeHarness(new Set(['a']));
    await h.controller.show('a');
    const win = h.created[0].win;
    markReady(h.controller, win);

    h.controller.setInteractive('a', true);
    expect(h.controller.getState().a?.interactive).toBe(true);

    win.emitWindowEvent('hide');
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    expect(h.controller.getState().a?.interactive).toBe(false);
  });
});

describe('user disabled guard (fail closed)', () => {
  it('refuses prewarm/show when user disabled', async () => {
    const h = makeHarness(new Set(['a']), new Set());
    h.controller.prewarm('a');
    await h.controller.show('a');
    expect(h.created).toHaveLength(0);
    expect(h.controller.getState()).toEqual({});
  });

  it('disabled while renderer-ready pendingShow: 5s fallback does not show', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness(new Set(['a']));
      await h.controller.show('a');
      const win = h.created[0].win;
      h.controller.markRendererReady(win.webContents as unknown as WebContents);

      h.setUserEnabled('a', false);

      await vi.advanceTimersByTimeAsync(5000);

      expect(win.showInactive).not.toHaveBeenCalled();
      expect(win.isDestroyed()).toBe(false); // 已 ready 的壳不应被 5s 超时销毁
      expect(h.controller.getState().a?.visible).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disabled while a visible overlay reloads: reload complete does not re-show', async () => {
    const h = makeHarness(new Set(['a']));
    await h.controller.show('a');
    const win = h.created[0].win;
    markReady(h.controller, win);
    expect(win.showInactive).toHaveBeenCalledTimes(1);

    win.emitWebContentsEvent('did-start-navigation', {}, 'about:blank', false, true);
    expect(win.isVisible()).toBe(false); // reload 开始时已 hide

    h.setUserEnabled('a', false);

    win.emitWebContentsEvent('did-finish-load');
    await new Promise((resolve) => setImmediate(resolve));

    expect(win.showInactive).toHaveBeenCalledTimes(1); // 没有再次展示
    expect(win.isVisible()).toBe(false);
    expect(h.controller.getState().a?.visible).toBe(false);
  });
});

describe('unmount', () => {
  it('unmount destroys and clears registry', async () => {
    const h = makeHarness(new Set(['a']));
    await h.controller.show('a');
    const win = h.created[0].win;
    markReady(h.controller, win);
    expect(isGhostOverlayWebContents(win.webContents.id)).toBe(true);

    h.controller.unmount('a');

    expect(win.isDestroyed()).toBe(true);
    expect(h.controller.getState()).toEqual({});
    expect(isGhostOverlayWebContents(win.webContents.id)).toBe(false);
  });
});

describe('reconcile', () => {
  it('reconcile disposes windows of uninstalled or disabled ghosts', async () => {
    const h = makeHarness(new Set(['gone', 'disabled', 'stays']));
    await h.controller.show('gone');
    await h.controller.show('disabled');
    await h.controller.show('stays');
    markReady(h.controller, h.created[0].win);
    markReady(h.controller, h.created[1].win);
    markReady(h.controller, h.created[2].win);

    h.controller.reconcile([ghost('stays'), ghost('disabled', { enabled: false })]);

    expect(h.created[0].win.isDestroyed()).toBe(true); // gone:已卸载
    expect(h.created[1].win.isDestroyed()).toBe(true); // disabled:已停用
    expect(h.created[2].win.isDestroyed()).toBe(false); // stays:保留
    expect(h.controller.getState()).toEqual({
      stays: { mounted: true, visible: true, interactive: false },
    });
  });

  it('reconcile disposes windows whose overlay declaration is gone', async () => {
    const h = makeHarness(new Set(['nolonger']));
    await h.controller.show('nolonger');
    markReady(h.controller, h.created[0].win);

    h.controller.reconcile([ghost('nolonger', { overlay: false })]);

    expect(h.created[0].win.isDestroyed()).toBe(true);
    expect(h.controller.getState()).toEqual({});
  });

  it('reconcile disposes the slot when the installed version changed; next mount rebuilds', async () => {
    const versions = new Map<string, string>([['upgraded', '1.0.0']]);
    const h = makeHarness(new Set(['upgraded']), new Set(['upgraded']), {}, {
      resolveInstalledVersion: (id) => versions.get(id) ?? null,
    });
    await h.controller.show('upgraded');
    markReady(h.controller, h.created[0].win);
    expect(h.created).toHaveLength(1);

    // 插件更新:仍声明 overlay,但安装版本变了 → dispose,重建留给下次 mount。
    versions.set('upgraded', '2.0.0');
    h.controller.reconcile([ghost('upgraded', { version: '2.0.0' })]);

    expect(h.created[0].win.isDestroyed()).toBe(true);
    expect(h.controller.getState()).toEqual({});

    // 下次 mount 用新版本重建出新窗口。
    await h.controller.show('upgraded');
    expect(h.created).toHaveLength(2);
    expect(h.controller.getState().upgraded?.mounted).toBe(true);
  });

  it('reconcile keeps the slot when the installed version is unchanged', async () => {
    const h = makeHarness(new Set(['same']), new Set(['same']), {}, {
      resolveInstalledVersion: () => '1.0.0',
    });
    await h.controller.show('same');
    markReady(h.controller, h.created[0].win);

    h.controller.reconcile([ghost('same', { version: '1.0.0' })]);

    expect(h.created[0].win.isDestroyed()).toBe(false);
    expect(h.controller.getState()).toEqual({
      same: { mounted: true, visible: true, interactive: false },
    });
  });
});

describe('owner change', () => {
  it('owner change disposes every window', async () => {
    const h = makeHarness(new Set(['a', 'b']));
    await h.controller.show('a');
    await h.controller.show('b');
    markReady(h.controller, h.created[0].win);
    markReady(h.controller, h.created[1].win);

    h.controller.disposeAllForOwnerChange();

    expect(h.created[0].win.isDestroyed()).toBe(true);
    expect(h.created[1].win.isDestroyed()).toBe(true);
    expect(h.controller.getState()).toEqual({});
  });
});

describe('crash recovery', () => {
  it('recovers a crashed renderer at most once per stability window', async () => {
    const h = makeHarness(new Set(['a']));
    await h.controller.show('a');
    const win1 = h.created[0].win;

    win1.emitWebContentsEvent('render-process-gone', {}, { reason: 'crashed' });
    await vi.waitFor(() => expect(h.created).toHaveLength(2));
    expect(win1.isDestroyed()).toBe(true);

    const win2 = h.created[1].win;
    win2.emitWebContentsEvent('render-process-gone', {}, { reason: 'killed' });
    await Promise.resolve();
    expect(h.created).toHaveLength(2); // 额度耗尽,不再重建
  });

  it('resets the recovery quota after 30s of stability', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness(new Set(['a']));
      await h.controller.show('a');
      h.created[0].win.emitWebContentsEvent('render-process-gone', {}, { reason: 'crashed' });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.created).toHaveLength(2);

      const replacement = h.created[1].win;
      markReady(h.controller, replacement); // presentationReady 后进入稳定窗口

      await vi.advanceTimersByTimeAsync(30_000);

      replacement.emitWebContentsEvent('render-process-gone', {}, { reason: 'crashed-again' });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.created).toHaveLength(3); // 额度已恢复,再次重建
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('per-ghost isolation', () => {
  it('keeps two ghosts in independent slots', async () => {
    const h = makeHarness(new Set(['a', 'b']));
    await h.controller.show('a');
    await h.controller.show('b');
    expect(h.created).toHaveLength(2);
    const [winA, winB] = [h.created[0].win, h.created[1].win];

    markReady(h.controller, winA);
    expect(winA.showInactive).toHaveBeenCalledTimes(1);
    expect(winB.showInactive).not.toHaveBeenCalled(); // b 尚未双阶段就绪

    h.controller.hide('a');
    expect(winA.hide).toHaveBeenCalled();
    expect(winB.hide).not.toHaveBeenCalled();

    h.controller.unmount('b');
    expect(winB.isDestroyed()).toBe(true);
    expect(winA.isDestroyed()).toBe(false);
  });
});

describe('move / setInteractive', () => {
  it('move forwards to setPosition', async () => {
    const h = makeHarness(new Set(['a']));
    await h.controller.show('a');
    h.controller.move('a', 12, 34);
    expect(h.created[0].win.setPosition).toHaveBeenCalledWith(12, 34);
  });

  it('setInteractive(true) captures mouse; false restores forward pass-through', async () => {
    const h = makeHarness(new Set(['a']));
    await h.controller.show('a');
    const win = h.created[0].win;
    markReady(h.controller, win); // 可见期才受理"变交互"

    h.controller.setInteractive('a', true);
    expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(false);
    expect(h.controller.getState().a?.interactive).toBe(true);

    h.controller.setInteractive('a', false);
    expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
    expect(h.controller.getState().a?.interactive).toBe(false);
  });

  it('setInteractive(true) while hidden is a no-op; next show stays pass-through', async () => {
    const h = makeHarness(new Set(['a']));
    await h.controller.show('a');
    const win = h.created[0].win;

    // 隐藏期(尚未双阶段就绪)受理"变交互"时直接拒绝:不落 setIgnoreMouseEvents(false),
    // 不改 interactive 状态,避免下次 show 以整矩形捕鼠状态出现。
    h.controller.setInteractive('a', true);
    expect(win.setIgnoreMouseEvents).not.toHaveBeenCalledWith(false);
    expect(h.controller.getState().a?.interactive).toBe(false);

    // 双阶段就绪后 show:窗口仍保持默认穿透(不拦截点击)。
    markReady(h.controller, win);
    expect(win.showInactive).toHaveBeenCalledTimes(1);
    expect(win.setIgnoreMouseEvents).not.toHaveBeenCalledWith(false);
    expect(h.controller.getState().a?.interactive).toBe(false);
  });
});

describe('sender guard', () => {
  it('markPresentationReady from a foreign sender is a no-op', async () => {
    const h = makeHarness(new Set(['a']));
    await h.controller.show('a');
    const win = h.created[0].win;
    h.controller.markPresentationReady({ id: 99999 } as unknown as WebContents);
    expect(win.showInactive).not.toHaveBeenCalled();
  });
});

describe('dispose', () => {
  it('dispose destroys every window and clears the registry', async () => {
    const h = makeHarness(new Set(['a', 'b']));
    await h.controller.show('a');
    await h.controller.show('b');
    const winA = h.created[0].win;

    h.controller.dispose();

    expect(winA.isDestroyed()).toBe(true);
    expect(h.created[1].win.isDestroyed()).toBe(true);
    expect(isGhostOverlayWebContents(winA.webContents.id)).toBe(false);
    expect(h.controller.getState()).toEqual({});
  });
});

describe('in-flight creation registry cleanup', () => {
  it('owner change during in-flight creation destroys the window and clears its registry binding', async () => {
    let resolveCreate!: (created: { win: BrowserWindow; loadCompleted: boolean }) => void;
    const gate = new Promise<{ win: BrowserWindow; loadCompleted: boolean }>((resolve) => {
      resolveCreate = resolve;
    });
    const created: FakeWindow[] = [];
    const log = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
    };
    const deps: GhostOverlayWindowsControllerDeps = {
      createWindow: (): Promise<{ win: BrowserWindow; loadCompleted: boolean }> => {
        const win = fakeWindow();
        markGhostOverlayWebContentsId(win.webContents.id, 'a');
        created.push(win);
        return gate;
      },
      isGhostOverlayDeclared: () => true,
      isUserEnabled: () => true,
      broadcastState: () => {},
      isQuitting: () => false,
      log,
    };
    const controller = new GhostOverlayWindowsController(deps);

    const showPromise = controller.show('a');
    await vi.waitFor(() => expect(created).toHaveLength(1));
    const win = created[0];
    expect(isGhostOverlayWebContents(win.webContents.id)).toBe(true);

    controller.disposeAllForOwnerChange();

    resolveCreate({ win: win as unknown as BrowserWindow, loadCompleted: false });
    await showPromise;

    expect(win.isDestroyed()).toBe(true);
    expect(isGhostOverlayWebContents(win.webContents.id)).toBe(false);
  });

  it('dedup branch: duplicate creation destroys the extra window and clears its registry binding', async () => {
    const h = makeHarness(new Set(['a']));
    // 直接驱动私有 createSlot 两次(绕过 ensureSlot 的在途去重),覆盖去重分支的防御清理。
    const internals = h.controller as unknown as {
      generation: number;
      createSlot: (ghostId: string, generation: number) => Promise<{ win: FakeWindow } | null>;
    };
    const generation = internals.generation;
    const [slot1, slot2] = await Promise.all([
      internals.createSlot('a', generation),
      internals.createSlot('a', generation),
    ]);

    expect(h.created).toHaveLength(2);
    const [win1, win2] = h.created.map(({ win }) => win);
    expect(slot1?.win).toBe(win1);
    expect(slot2?.win).toBe(win1); // 去重:返回既有 slot
    expect(win1.isDestroyed()).toBe(false);
    expect(win2.isDestroyed()).toBe(true);
    expect(isGhostOverlayWebContents(win1.webContents.id)).toBe(true);
    expect(isGhostOverlayWebContents(win2.webContents.id)).toBe(false);
    expect(Object.keys(h.controller.getState())).toEqual(['a']);
  });
});

describe('in-flight creation rejection cleanup', () => {
  function brokenWindow(): BrowserWindow {
    // 模拟 createSlot 成功路径中未包裹的抛点:窗口已销毁时读 webContents.id 会抛。
    return {
      webContents: {
        get id(): number {
          throw new Error('webContents gone');
        },
        on: vi.fn(),
        send: vi.fn(),
      },
      on: vi.fn(),
      isDestroyed: () => false,
      destroy: vi.fn(),
    } as unknown as BrowserWindow;
  }

  function rejectionHarness() {
    let calls = 0;
    const log = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
    };
    const deps: GhostOverlayWindowsControllerDeps = {
      createWindow: async () => {
        calls += 1;
        return { win: brokenWindow(), loadCompleted: false };
      },
      isGhostOverlayDeclared: () => true,
      isUserEnabled: () => true,
      broadcastState: () => {},
      isQuitting: () => false,
      log,
    };
    return { controller: new GhostOverlayWindowsController(deps), calls: () => calls };
  }

  it('rejected in-flight creation clears the pending entry and retries on the next call', async () => {
    const h = rejectionHarness();

    await expect(h.controller.show('a')).rejects.toThrow('webContents gone');
    expect(h.calls()).toBe(1);

    // 清理后再次调用会重新 createWindow,而不是永远命中同一个已拒绝 promise。
    await expect(h.controller.show('a')).rejects.toThrow('webContents gone');
    expect(h.calls()).toBe(2);
  });

  it('two concurrent rejected creations share the in-flight promise and both reject', async () => {
    const h = rejectionHarness();

    const p1 = h.controller.show('a');
    const p2 = h.controller.show('a');
    await expect(p1).rejects.toThrow('webContents gone');
    await expect(p2).rejects.toThrow('webContents gone');
    expect(h.calls()).toBe(1); // 在途去重仍生效,只 createWindow 一次
  });

  it('registers a loading slot before load completes and cleans it up on rejection; retryable', async () => {
    let calls = 0;
    let rejectFirst!: (error: Error) => void;
    const createdWindows: FakeWindow[] = [];
    const log = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
    };
    const deps: GhostOverlayWindowsControllerDeps = {
      createWindow: (ghostId, onWindowCreated) => {
        calls += 1;
        if (calls === 1) {
          return new Promise((_resolve, reject) => {
            rejectFirst = reject;
            // 模拟工厂在 loadURL 之前登记"加载中"窗口。
            const win = fakeWindow();
            markGhostOverlayWebContentsId(win.webContents.id, ghostId);
            createdWindows.push(win);
            onWindowCreated?.(win as unknown as BrowserWindow);
          });
        }
        const win = fakeWindow();
        markGhostOverlayWebContentsId(win.webContents.id, ghostId);
        createdWindows.push(win);
        onWindowCreated?.(win as unknown as BrowserWindow);
        return Promise.resolve({ win: win as unknown as BrowserWindow, loadCompleted: true });
      },
      isGhostOverlayDeclared: () => true,
      isUserEnabled: () => true,
      broadcastState: () => {},
      isQuitting: () => false,
      log,
    };
    const controller = new GhostOverlayWindowsController(deps);

    const showPromise = controller.show('a');
    await vi.waitFor(() => expect(createdWindows).toHaveLength(1));
    // 加载期间 slot 已登记(窗口不在 slots 中无法回收的旧缺陷已消除)。
    expect(controller.getState().a?.mounted).toBe(true);
    expect(isGhostOverlayWebContents(createdWindows[0].webContents.id)).toBe(true);

    // 首次加载失败(工厂侧超时) reject:show 不悬挂,事务清理 loading slot。
    rejectFirst(new Error('first load timed out'));
    await showPromise;

    expect(createdWindows[0].isDestroyed()).toBe(true);
    expect(isGhostOverlayWebContents(createdWindows[0].webContents.id)).toBe(false);
    expect(controller.getState()).toEqual({});

    // 后续 mount 可重试,重建出新窗口。
    await controller.show('a');
    expect(createdWindows).toHaveLength(2);
    expect(controller.getState().a?.mounted).toBe(true);
  });
});

describe('visibility change hooks', () => {
  it('stale closed does not stop a rebuilt, visible slot', async () => {
    const visibility: Array<{ ghostId: string; visible: boolean }> = [];
    const h = makeHarness(new Set(['a']), new Set(['a']), {
      onVisibilityChanged: (ghostId, visible) => visibility.push({ ghostId, visible }),
    });
    await h.controller.show('a');
    const win1 = h.created[0].win;
    markReady(h.controller, win1);
    expect(visibility).toEqual([{ ghostId: 'a', visible: true }]);

    // 旧窗口销毁时暂缓 closed:模拟事件迟到。
    win1.destroy.mockImplementation(() => {});
    h.controller.unmount('a');
    expect(visibility).toEqual([
      { ghostId: 'a', visible: true },
      { ghostId: 'a', visible: false },
    ]);

    // 重建并展示新 slot。
    await h.controller.show('a');
    const win2 = h.created[1].win;
    markReady(h.controller, win2);
    expect(visibility).toEqual([
      { ghostId: 'a', visible: true },
      { ghostId: 'a', visible: false },
      { ghostId: 'a', visible: true },
    ]);

    // 迟到的旧窗口 closed 不得把新 slot 停掉。
    win1.emitClosed();
    expect(visibility).toEqual([
      { ghostId: 'a', visible: true },
      { ghostId: 'a', visible: false },
      { ghostId: 'a', visible: true },
    ]);
  });

  it('unmount stops pushing synchronously (not via closed event)', async () => {
    const visibility: Array<{ ghostId: string; visible: boolean }> = [];
    const h = makeHarness(new Set(['a']), new Set(['a']), {
      onVisibilityChanged: (ghostId, visible) => visibility.push({ ghostId, visible }),
    });
    await h.controller.show('a');
    const win = h.created[0].win;
    markReady(h.controller, win);
    expect(visibility).toEqual([{ ghostId: 'a', visible: true }]);

    // 让 destroy 不触发 closed:验证停推由 disposeSlot 同步完成。
    win.destroy.mockImplementation(() => {});
    h.controller.unmount('a');

    expect(visibility).toEqual([
      { ghostId: 'a', visible: true },
      { ghostId: 'a', visible: false },
    ]);
  });

  it('owner change fires onAllWindowsDestroyed for stream dispose', async () => {
    let allDestroyedCalls = 0;
    const h = makeHarness(new Set(['a', 'b']), new Set(['a', 'b']), {
      onAllWindowsDestroyed: () => {
        allDestroyedCalls += 1;
      },
    });
    await h.controller.show('a');
    await h.controller.show('b');

    h.controller.disposeAllForOwnerChange();

    expect(allDestroyedCalls).toBe(1);
  });
});

// 清理跨用例的 registry 绑定,避免影响其它断言。
beforeEach(() => {
  for (let i = 1; i < nextId; i += 1) clearGhostOverlayWebContents(i);
});

describe('slow first load (prewarm + show race)', () => {
  it('show waits for the in-flight create; 5s fallback does not destroy; shows after slow load', async () => {
    vi.useFakeTimers();
    try {
      const h = slowLoadHarness();
      h.controller.prewarm('a');
      expect(h.created).toHaveLength(1);
      const win = h.created[0].win;
      expect(h.controller.getState().a?.mounted).toBe(true);

      const showPromise = h.controller.show('a');
      await vi.advanceTimersByTimeAsync(5000);

      // 5s 壳超时不得在仍加载时误销毁;show 也还没到 fallback 阶段。
      expect(win.isDestroyed()).toBe(false);
      expect(win.showInactive).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      await showPromise;
      // setImmediate 在 tick 中被调度为 +1ms(见 sinon fake-timers),补 1ms 让
      // presentation-ready 的 setImmediate 落地。
      await vi.advanceTimersByTimeAsync(1);

      expect(win.isDestroyed()).toBe(false);
      expect(win.showInactive).toHaveBeenCalledTimes(1);
      expect(h.created).toHaveLength(1); // 无重建
    } finally {
      vi.useRealTimers();
    }
  });

  it('5s fallback suppresses invalidate while the window is still in its first load', async () => {
    vi.useFakeTimers();
    try {
      const h = slowLoadHarness();
      h.controller.prewarm('a');
      const win = h.created[0].win;

      // 防御路径:即便某个调用方在首次加载期间就给"尚无壳"slot 挂了 pendingShow
      // 并调度 5s 壳超时,也不得作废它(没有壳可展示,清理由 10s 加载超时负责)。
      const internals = h.controller as unknown as {
        scheduleShowFallback: (ghostId: string, slot: unknown) => void;
        slots: Map<string, { pendingShow: boolean }>;
      };
      const slot = internals.slots.get('a')!;
      slot.pendingShow = true;
      internals.scheduleShowFallback('a', slot);

      await vi.advanceTimersByTimeAsync(5000);
      expect(win.isDestroyed()).toBe(false);

      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1);

      expect(win.isDestroyed()).toBe(false);
      expect(win.showInactive).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('load failure surfaces and is retryable', () => {
  it('load rejection logs the failure, cleans the slot transaction, and retries on the next show', async () => {
    let calls = 0;
    const createdWindows: FakeWindow[] = [];
    const log = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
    };
    const deps: GhostOverlayWindowsControllerDeps = {
      createWindow: (ghostId, onWindowCreated) => {
        calls += 1;
        if (calls === 1) {
          const win = fakeWindow();
          markGhostOverlayWebContentsId(win.webContents.id, ghostId);
          createdWindows.push(win);
          onWindowCreated?.(win as unknown as BrowserWindow);
          return Promise.reject(new Error('ghost overlay first load timed out'));
        }
        const win = fakeWindow();
        markGhostOverlayWebContentsId(win.webContents.id, ghostId);
        createdWindows.push(win);
        onWindowCreated?.(win as unknown as BrowserWindow);
        return Promise.resolve({ win: win as unknown as BrowserWindow, loadCompleted: true });
      },
      isGhostOverlayDeclared: () => true,
      isUserEnabled: () => true,
      broadcastState: () => {},
      isQuitting: () => false,
      log,
    };
    const controller = new GhostOverlayWindowsController(deps);

    await controller.show('a');

    // 明确失败:记录告警(不静默),slot 事务清理,窗口销毁并清 registry。
    expect(log.warn).toHaveBeenCalledWith(
      'ghost overlay window creation failed',
      expect.objectContaining({ ghostId: 'a' }),
    );
    expect(createdWindows[0].isDestroyed()).toBe(true);
    expect(isGhostOverlayWebContents(createdWindows[0].webContents.id)).toBe(false);
    expect(controller.getState()).toEqual({});

    // 后续 show 可重试:重建出可用窗口。
    await controller.show('a');
    expect(calls).toBe(2);
    expect(controller.getState().a?.mounted).toBe(true);
  });
});

describe('reconcile install identity', () => {
  it('disposes the slot when the version is unchanged but the install revision changed', async () => {
    const identities = new Map<string, string>([['samever', '1.0.0:approved:rev-1']]);
    const h = makeHarness(new Set(['samever']), new Set(['samever']), {}, {
      resolveInstalledVersion: (id) => identities.get(id) ?? null,
    });
    await h.controller.show('samever');
    markReady(h.controller, h.created[0].win);
    expect(h.created).toHaveLength(1);

    // 本地 .cindy 覆盖重装:manifest.version 不变,但批准 revision 变了 → 身份变化。
    identities.set('samever', '1.0.0:approved:rev-2');
    h.controller.reconcile([ghost('samever', { version: '1.0.0' })]);

    expect(h.created[0].win.isDestroyed()).toBe(true);
    expect(h.controller.getState()).toEqual({});

    await h.controller.show('samever');
    expect(h.created).toHaveLength(2);
    expect(h.controller.getState().samever?.mounted).toBe(true);
  });
});
