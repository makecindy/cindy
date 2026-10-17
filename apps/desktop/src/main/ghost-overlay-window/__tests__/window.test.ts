import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindowConstructorOptions } from 'electron';

import { createGhostOverlayWindow } from '../window.js';
import { isGhostOverlayWebContents } from '../registry.js';

/**
 * createGhostOverlayWindow 的窗口参数 / 守卫单测。
 *
 * electron 走 vi.mock 的 FakeWindow（参照 computer-permission-guide 的
 * electron-window.test.ts）。分区由注入的 resolveGhostOverlaySession 提供,
 * 工厂只透传注入值——真实 owner-scoped 命名逻辑(含 namespace 作用域与
 * approval receipt)由 Task 7 接线方与协议注册共用同一实现,不在此固化。
 */

const harness = vi.hoisted(() => {
  const app = { isPackaged: false };
  let nextWebContentsId = 1;
  let nextLoadError: Error | null = null;
  let nextLoadNeverResolves = false;
  const windows: FakeWindow[] = [];
  const ensureProtocolRegistered = vi.fn(async () => undefined);
  const resolveGhostOverlaySession = vi.fn<(ghostId: string) => string | null>(
    (ghostId: string) => `cindy-ghost-owner:local:opaque-local-owner:${ghostId}`,
  );
  const resolveManifestId = vi.fn<(ghostId: string) => string | null>(
    (ghostId: string) => ghostId,
  );

  class FakeWindow {
    readonly loadURL = vi.fn(async () => {
      if (nextLoadNeverResolves) {
        return new Promise<never>(() => {});
      }
      if (nextLoadError) {
        const error = nextLoadError;
        nextLoadError = null;
        throw error;
      }
    });
    readonly setIgnoreMouseEvents = vi.fn();
    readonly setAlwaysOnTop = vi.fn();
    readonly destroy = vi.fn(() => {
      this.destroyed = true;
    });
    destroyed = false;
    /** 销毁后仍可读取的 webContents id(供测试断言 registry 清理)。 */
    readonly overlayWebContentsId: number;
    readonly webContents: {
      id: number;
      on: ReturnType<typeof vi.fn>;
      setWindowOpenHandler: ReturnType<typeof vi.fn>;
      session: { setPermissionRequestHandler: ReturnType<typeof vi.fn> };
    };

    constructor(readonly options: BrowserWindowConstructorOptions) {
      const webContentsId = nextWebContentsId++;
      this.overlayWebContentsId = webContentsId;
      const isWindowDestroyed = () => this.destroyed;
      this.webContents = {
        get id(): number {
          if (isWindowDestroyed()) throw new Error('Object has been destroyed');
          return webContentsId;
        },
        on: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        session: { setPermissionRequestHandler: vi.fn() },
      };
      windows.push(this);
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }
  }

  return {
    app,
    windows,
    ensureProtocolRegistered,
    resolveGhostOverlaySession,
    resolveManifestId,
    FakeWindow,
    setNextLoadError: (error: Error | null) => {
      nextLoadError = error;
    },
    setNextLoadNeverResolves: (v: boolean) => {
      nextLoadNeverResolves = v;
    },
    reset: () => {
      app.isPackaged = false;
      nextWebContentsId = 1;
      nextLoadError = null;
      nextLoadNeverResolves = false;
      windows.length = 0;
      ensureProtocolRegistered.mockReset();
      ensureProtocolRegistered.mockResolvedValue(undefined);
      resolveGhostOverlaySession.mockReset();
      resolveGhostOverlaySession.mockImplementation(
        (ghostId: string) => `cindy-ghost-owner:local:opaque-local-owner:${ghostId}`,
      );
      resolveManifestId.mockReset();
      resolveManifestId.mockImplementation((ghostId: string) => ghostId);
    },
  };
});

vi.mock('electron', () => ({
  BrowserWindow: harness.FakeWindow,
  app: harness.app,
}));

const log = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
};

function deps() {
  return {
    ensureProtocolRegistered: harness.ensureProtocolRegistered,
    resolveGhostOverlaySession: harness.resolveGhostOverlaySession,
    resolveManifestId: harness.resolveManifestId,
    onWindowCreated: vi.fn(),
    log,
  };
}

function webPreferences(win: (typeof harness.windows)[number]): Record<string, unknown> {
  return win.options.webPreferences as Record<string, unknown>;
}

describe('createGhostOverlayWindow', () => {
  beforeEach(() => {
    harness.reset();
    log.info.mockReset();
  });

  it('creates the overlay window with the frozen avatar and default size', async () => {
    await createGhostOverlayWindow('acme-overlay', { html: 'overlay.html' }, deps());

    expect(harness.windows).toHaveLength(1);
    expect(harness.windows[0].options).toMatchObject({
      width: 128,
      height: 128,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      focusable: false,
      hasShadow: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
    });

    // decl 给 64 时使用显式尺寸。
    harness.reset();
    await createGhostOverlayWindow(
      'acme-overlay',
      { html: 'overlay.html', width: 64, height: 64 },
      deps(),
    );
    expect(harness.windows[0].options).toMatchObject({ width: 64, height: 64 });
  });

  it('returns the window handle with loadCompleted=true after a successful load', async () => {
    const handle = await createGhostOverlayWindow('acme-overlay', { html: 'overlay.html' }, deps());

    // 工厂把“首次加载已完成”作为返回值的一部分交给 controller,供其确定性直推
    // 双阶段就绪(不再探测 webContents.isLoading())。
    expect(handle.win).toBe(harness.windows[0]);
    expect(handle.loadCompleted).toBe(true);
  });

  it('applies full security fields explicitly', async () => {
    await createGhostOverlayWindow('acme-overlay', { html: 'overlay.html' }, deps());

    expect(webPreferences(harness.windows[0])).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      plugins: false,
      navigateOnDragDrop: false,
      spellcheck: false,
    });
  });

  it('enables click-through by default and floating top level', async () => {
    await createGhostOverlayWindow('acme-overlay', { html: 'overlay.html' }, deps());

    expect(harness.windows[0].setIgnoreMouseEvents).toHaveBeenCalledWith(true, {
      forward: true,
    });
    expect(harness.windows[0].setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating', 1);
  });

  it('loads the plugin overlay page from the injected session partition', async () => {
    await createGhostOverlayWindow('acme-overlay', { html: 'overlay.html' }, deps());

    const win = harness.windows[0];
    // 工厂透传注入分区,不自算 owner-scoped 命名。
    expect(harness.resolveGhostOverlaySession).toHaveBeenCalledWith('acme-overlay');
    expect(webPreferences(win).partition).toBe(
      'cindy-ghost-owner:local:opaque-local-owner:acme-overlay',
    );
    expect(harness.ensureProtocolRegistered).toHaveBeenCalledWith('acme-overlay');
    expect(win.loadURL).toHaveBeenCalledWith('cindy-ghost://acme-overlay/overlay.html');

    // ensureProtocolRegistered 必须先于 loadURL（否则直载会落在未挂协议的 session）。
    const registerOrder = harness.ensureProtocolRegistered.mock.invocationCallOrder[0];
    const loadOrder = win.loadURL.mock.invocationCallOrder[0];
    expect(registerOrder).toBeDefined();
    expect(loadOrder).toBeDefined();
    expect(registerOrder!).toBeLessThan(loadOrder!);
  });

  it('loads the overlay entry using the manifest id host when it differs from the storage part', async () => {
    // 真实缺陷场景:storage part(_root__acme)与 manifest id(acme)不一致,
    // 协议 handler 只认 manifest id,URL host 必须用后者。
    harness.resolveManifestId.mockReturnValueOnce('acme');
    await createGhostOverlayWindow('_root__acme', { html: 'overlay.html' }, deps());

    const win = harness.windows[0];
    expect(harness.resolveManifestId).toHaveBeenCalledWith('_root__acme');
    expect(win.loadURL).toHaveBeenCalledWith('cindy-ghost://acme/overlay.html');
    // 窗口其余身份保持 storage part:分区、协议注册、registry 绑定。
    expect(harness.resolveGhostOverlaySession).toHaveBeenCalledWith('_root__acme');
    expect(webPreferences(win).partition).toBe(
      'cindy-ghost-owner:local:opaque-local-owner:_root__acme',
    );
    expect(harness.ensureProtocolRegistered).toHaveBeenCalledWith('_root__acme');
    expect(isGhostOverlayWebContents(win.overlayWebContentsId)).toBe(true);
  });

  it('whitelists navigation by manifest id host even when storage part differs', async () => {
    harness.resolveManifestId.mockReturnValueOnce('acme');
    await createGhostOverlayWindow('_root__acme', { html: 'overlay.html' }, deps());

    const win = harness.windows[0];
    const navCall = win.webContents.on.mock.calls.find(
      ([event]) => event === 'will-navigate',
    );
    expect(navCall).toBeDefined();
    const navHandler = navCall![1] as (
      event: { preventDefault(): void },
      url: string,
    ) => void;

    const preventDefault = vi.fn();
    // 放行 manifest id host。
    navHandler({ preventDefault }, 'cindy-ghost://acme/other.html');
    expect(preventDefault).not.toHaveBeenCalled();

    // storage part host 不再是白名单 host,必须拒绝。
    preventDefault.mockClear();
    navHandler({ preventDefault }, 'cindy-ghost://_root__acme/other.html');
    expect(preventDefault).toHaveBeenCalledTimes(1);

    // 其它 host 依旧拒绝。
    preventDefault.mockClear();
    navHandler({ preventDefault }, 'cindy-ghost://other/x');
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('fails closed before creating a window when no manifest id is resolvable', async () => {
    harness.resolveManifestId.mockReturnValueOnce(null);
    await expect(
      createGhostOverlayWindow('acme-overlay', { html: 'overlay.html' }, deps()),
    ).rejects.toThrow('ghost overlay manifest id unavailable for acme-overlay');
    expect(harness.windows).toHaveLength(0);
  });

  it('uses a distinct injected partition per ghost (no namespace collision)', async () => {
    harness.resolveGhostOverlaySession
      .mockReturnValueOnce('cindy-ghost-owner:local:opaque-a:_ns__a__overlay:ns:a:receipt:r1')
      .mockReturnValueOnce('cindy-ghost-owner:local:opaque-b:_ns__b__overlay:ns:b:receipt:r2');

    await createGhostOverlayWindow('_ns__a__overlay', { html: 'overlay.html' }, deps());
    await createGhostOverlayWindow('_ns__b__overlay', { html: 'overlay.html' }, deps());

    expect(harness.resolveGhostOverlaySession).toHaveBeenNthCalledWith(1, '_ns__a__overlay');
    expect(harness.resolveGhostOverlaySession).toHaveBeenNthCalledWith(2, '_ns__b__overlay');
    expect(webPreferences(harness.windows[0]).partition).toBe(
      'cindy-ghost-owner:local:opaque-a:_ns__a__overlay:ns:a:receipt:r1',
    );
    expect(webPreferences(harness.windows[1]).partition).toBe(
      'cindy-ghost-owner:local:opaque-b:_ns__b__overlay:ns:b:receipt:r2',
    );
    expect(webPreferences(harness.windows[0]).partition).not.toBe(
      webPreferences(harness.windows[1]).partition,
    );
  });

  it('fails closed before creating a window when no session is resolvable', async () => {
    harness.resolveGhostOverlaySession.mockReturnValueOnce(null);
    await expect(
      createGhostOverlayWindow('acme-overlay', { html: 'overlay.html' }, deps()),
    ).rejects.toThrow('ghost overlay session unavailable for acme-overlay');
    expect(harness.windows).toHaveLength(0);
  });

  it('denies window.open and blocks out-of-plugin navigation', async () => {
    await createGhostOverlayWindow('acme-overlay', { html: 'overlay.html' }, deps());

    const win = harness.windows[0];
    const openHandler = win.webContents.setWindowOpenHandler.mock.calls[0]![0] as (details: {
      url: string;
    }) => { action: string };
    expect(openHandler({ url: 'https://x' })).toEqual({ action: 'deny' });
    expect(openHandler({ url: 'cindy-ghost://acme-overlay/other.html' })).toEqual({
      action: 'deny',
    });

    const navCall = win.webContents.on.mock.calls.find(
      ([event]) => event === 'will-navigate',
    );
    expect(navCall).toBeDefined();
    const navHandler = navCall![1] as (
      event: { preventDefault(): void },
      url: string,
    ) => void;

    const preventDefault = vi.fn();
    navHandler({ preventDefault }, 'cindy-ghost://other/x');
    expect(preventDefault).toHaveBeenCalledTimes(1);

    preventDefault.mockClear();
    navHandler({ preventDefault }, 'https://x');
    expect(preventDefault).toHaveBeenCalledTimes(1);

    // 自己 ghost 内的导航放行。
    preventDefault.mockClear();
    navHandler({ preventDefault }, 'cindy-ghost://acme-overlay/other.html');
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('rejects all permission requests', async () => {
    await createGhostOverlayWindow('acme-overlay', { html: 'overlay.html' }, deps());

    const win = harness.windows[0];
    const handler = win.webContents.session.setPermissionRequestHandler.mock
      .calls[0]![0] as (webContents: unknown, permission: string, callback: (allowed: boolean) => void) => void;
    const callback = vi.fn();
    handler(win.webContents, 'notifications', callback);
    expect(callback).toHaveBeenCalledWith(false);
  });

  it('destroys the window and clears the registry when protocol registration fails', async () => {
    let markedBeforeFailure = false;
    harness.ensureProtocolRegistered.mockImplementationOnce(async () => {
      markedBeforeFailure = isGhostOverlayWebContents(harness.windows[0].overlayWebContentsId);
      throw new Error('boom');
    });
    await expect(
      createGhostOverlayWindow('acme-overlay', { html: 'overlay.html' }, deps()),
    ).rejects.toThrow('ghost overlay protocol failed for acme-overlay');
    // 在 catch 包装路径之外断言，避免原始 AssertionError 被包装成预期错误。
    expect(markedBeforeFailure).toBe(true);

    const win = harness.windows[0];
    expect(win.isDestroyed()).toBe(true);
    expect(win.destroy).toHaveBeenCalledTimes(1);
    expect(win.loadURL).not.toHaveBeenCalled();
    expect(isGhostOverlayWebContents(win.overlayWebContentsId)).toBe(false);
  });

  it('destroys the window and clears the registry when loadURL fails', async () => {
    harness.setNextLoadError(new Error('load boom'));
    harness.ensureProtocolRegistered.mockImplementationOnce(async () => {
      // mark 已在 loadURL 之前完成:失败前 registry 应已登记。
      expect(isGhostOverlayWebContents(harness.windows[0].overlayWebContentsId)).toBe(true);
    });
    await expect(
      createGhostOverlayWindow('acme-overlay', { html: 'overlay.html' }, deps()),
    ).rejects.toThrow('ghost overlay load failed for acme-overlay');

    const win = harness.windows[0];
    expect(win.isDestroyed()).toBe(true);
    expect(win.destroy).toHaveBeenCalledTimes(1);
    expect(harness.ensureProtocolRegistered).toHaveBeenCalledWith('acme-overlay');
    expect(isGhostOverlayWebContents(win.overlayWebContentsId)).toBe(false);
  });

  it('disables devTools in packaged builds only', async () => {
    harness.app.isPackaged = true;
    await createGhostOverlayWindow('acme-overlay', { html: 'overlay.html' }, deps());
    expect(webPreferences(harness.windows[0]).devTools).toBe(false);

    harness.reset();
    await createGhostOverlayWindow('acme-overlay', { html: 'overlay.html' }, deps());
    expect(webPreferences(harness.windows[0]).devTools).toBe(true);
  });

  it('notifies onWindowCreated after construction and before protocol/load', async () => {
    const d = deps();
    await createGhostOverlayWindow('acme-overlay', { html: 'overlay.html' }, d);

    const win = harness.windows[0];
    expect(d.onWindowCreated).toHaveBeenCalledWith(win);
    const createdOrder = d.onWindowCreated.mock.invocationCallOrder[0];
    const registerOrder = harness.ensureProtocolRegistered.mock.invocationCallOrder[0];
    const loadOrder = win.loadURL.mock.invocationCallOrder[0];
    expect(createdOrder).toBeDefined();
    expect(registerOrder).toBeDefined();
    expect(loadOrder).toBeDefined();
    expect(createdOrder!).toBeLessThan(registerOrder!);
    expect(registerOrder!).toBeLessThan(loadOrder!);
  });

  it('times out a hung first load after 10s: destroys window and clears registry', async () => {
    vi.useFakeTimers();
    try {
      harness.setNextLoadNeverResolves(true);
      const promise = createGhostOverlayWindow('acme-overlay', { html: 'overlay.html' }, deps());
      // 先挂上拒绝处理器,避免推进定时器期间被计入 unhandled rejection。
      const caught = promise.then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e as Error,
      );
      // 让 ensureProtocolRegistered 的 await 续体推进到 loadURL 并注册超时定时器。
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10_000);

      const error = await caught;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('ghost overlay load failed');
      expect(String((error.cause as Error | undefined)?.message ?? '')).toContain('timed out');

      const win = harness.windows[0];
      expect(win.isDestroyed()).toBe(true);
      expect(win.destroy).toHaveBeenCalledTimes(1);
      expect(isGhostOverlayWebContents(win.overlayWebContentsId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
