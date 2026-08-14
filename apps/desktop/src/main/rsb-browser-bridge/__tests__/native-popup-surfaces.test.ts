import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, input: unknown) => unknown>();
  const windows = new Map<object, object>();
  const views: Array<{
    webContents: object;
    bounds: object | null;
    visible: boolean;
    setBounds: ReturnType<typeof vi.fn>;
    setVisible: ReturnType<typeof vi.fn>;
  }> = [];
  return { handlers, windows, views };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, input: unknown) => unknown) => {
      electronMocks.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: {
    fromWebContents: vi.fn((contents: object) => electronMocks.windows.get(contents) ?? null),
  },
  WebContentsView: class {
    webContents: object;
    bounds: object | null = null;
    visible = true;
    setBounds = vi.fn((bounds: object) => {
      this.bounds = bounds;
    });
    setVisible = vi.fn((visible: boolean) => {
      this.visible = visible;
    });
    constructor(options: { webContents: object }) {
      this.webContents = options.webContents;
      electronMocks.views.push(this);
    }
  },
}));

vi.mock('../../security/trustedAppRenderer', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));

import {
  RSB_NATIVE_POPUP_CLAIM_CHANNEL,
  RSB_NATIVE_POPUP_CLOSE_CHANNEL,
  RSB_NATIVE_POPUP_SET_BOUNDS_CHANNEL,
} from '../../../shared/rsbNativePopup';
import {
  _resetRsbNativePopupSurfacesForTests,
  RSB_NATIVE_POPUP_CLAIM_TIMEOUT_MS,
  attributeRsbNativePopupSurface,
  createRsbNativePopupSurface,
  getRsbNativePopupOwnerWebContents,
  hasActiveRsbNativePopupSurfaces,
  isRsbNativePopupWebContentsId,
  registerRsbNativePopupSurfaceIpc,
} from '../native-popup-surfaces';

function makeContents(id: number) {
  const contents = new EventEmitter() as EventEmitter & {
    id: number;
    destroyed: boolean;
    sent: Array<{ channel: string; payload: unknown }>;
    isDestroyed: () => boolean;
    send: (channel: string, payload: unknown) => void;
    close: () => void;
    getURL: () => string;
    getTitle: () => string;
    isLoading: () => boolean;
    canGoBack: () => boolean;
    canGoForward: () => boolean;
    isCurrentlyAudible: () => boolean;
    getZoomFactor: () => number;
  };
  contents.id = id;
  contents.destroyed = false;
  contents.sent = [];
  contents.isDestroyed = () => contents.destroyed;
  contents.send = (channel, payload) => contents.sent.push({ channel, payload });
  contents.close = vi.fn(() => {
    if (contents.destroyed) return;
    contents.destroyed = true;
    contents.emit('destroyed');
  });
  contents.getURL = () => 'https://accounts.example.test/authorize';
  contents.getTitle = () => 'Authorize';
  contents.isLoading = () => false;
  contents.canGoBack = () => true;
  contents.canGoForward = () => false;
  contents.isCurrentlyAudible = () => false;
  contents.getZoomFactor = () => 1;
  return contents;
}

function makeWindow() {
  const children = new Set<object>();
  return {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
    contentView: {
      addChildView: vi.fn((view: object) => children.add(view)),
      removeChildView: vi.fn((view: object) => children.delete(view)),
    },
    children,
  };
}

describe('main-owned RSB native popup surfaces', () => {
  const report = vi.fn();
  const release = vi.fn();
  const pinReleases: Array<ReturnType<typeof vi.fn>> = [];
  const registry = {
    report,
    release,
    acquirePinLease: vi.fn(() => {
      const fn = vi.fn();
      pinReleases.push(fn);
      return fn;
    }),
  };

  beforeEach(() => {
    electronMocks.handlers.clear();
    electronMocks.windows.clear();
    electronMocks.views.length = 0;
    report.mockReset();
    release.mockReset();
    registry.acquirePinLease.mockClear();
    pinReleases.length = 0;
    registerRsbNativePopupSurfaceIpc(registry as never);
  });

  afterEach(() => {
    _resetRsbNativePopupSurfacesForTests();
    vi.useRealTimers();
  });

  it('adopts the exact popup WebContents, claims it, and applies renderer bounds', async () => {
    const host = makeContents(1);
    const popup = makeContents(42);
    const hostWindow = makeWindow();
    electronMocks.windows.set(host, hostWindow);

    const surfaceId = createRsbNativePopupSurface(host as never, popup as never);
    expect(surfaceId).toBeTypeOf('string');
    expect(electronMocks.views[0]?.webContents).toBe(popup);
    expect(hasActiveRsbNativePopupSurfaces()).toBe(true);
    expect(isRsbNativePopupWebContentsId(42)).toBe(true);

    const claim = electronMocks.handlers.get(RSB_NATIVE_POPUP_CLAIM_CHANNEL)!;
    const claimed = await claim(
      { sender: host },
      { surfaceId, sessionId: 'session-a', tabId: 'tab-popup' },
    );
    expect(claimed).toMatchObject({
      alive: true,
      snapshot: { url: 'https://accounts.example.test/authorize', title: 'Authorize' },
    });
    expect(report).toHaveBeenCalledWith({
      sessionId: 'session-a',
      tabId: 'tab-popup',
      webContentsId: 42,
    });
    expect(getRsbNativePopupOwnerWebContents(42)).toBe(host);

    const setBounds = electronMocks.handlers.get(RSB_NATIVE_POPUP_SET_BOUNDS_CHANNEL)!;
    await setBounds(
      { sender: host },
      {
        surfaceId,
        bounds: { x: 10, y: 50, width: 600, height: 400 },
        visible: true,
      },
    );
    expect(electronMocks.views[0]?.bounds).toEqual({ x: 10, y: 50, width: 600, height: 400 });
    expect(electronMocks.views[0]?.visible).toBe(true);
  });

  it('publishes an empty string when Chromium explicitly reports no favicon', async () => {
    const host = makeContents(1);
    const popup = makeContents(42);
    electronMocks.windows.set(host, makeWindow());
    const surfaceId = createRsbNativePopupSurface(host as never, popup as never)!;
    const claim = electronMocks.handlers.get(RSB_NATIVE_POPUP_CLAIM_CHANNEL)!;
    const claimed = await claim(
      { sender: host },
      { surfaceId, sessionId: 'session-a', tabId: 'tab-popup' },
    );
    expect(claimed).toMatchObject({ alive: true, snapshot: { favicon: null } });

    popup.emit('page-favicon-updated', {}, ['', '   ']);

    expect(host.sent.at(-1)).toEqual({
      channel: 'rsb-native-popup:event',
      payload: {
        surfaceId,
        type: 'state',
        snapshot: expect.objectContaining({ favicon: '' }),
      },
    });
  });

  it('skips non-persistable popup favicon candidates and publishes a safe fallback', async () => {
    const host = makeContents(1);
    const popup = makeContents(42);
    electronMocks.windows.set(host, makeWindow());
    const surfaceId = createRsbNativePopupSurface(host as never, popup as never)!;
    const claim = electronMocks.handlers.get(RSB_NATIVE_POPUP_CLAIM_CHANNEL)!;
    await claim({ sender: host }, { surfaceId, sessionId: 'session-a', tabId: 'tab-popup' });

    popup.emit('page-favicon-updated', {}, [
      'blob:https://accounts.example.test/favicon',
      `data:image/png;base64,${'x'.repeat(3 * 1024)}`,
      'https://accounts.example.test/favicon.ico',
    ]);

    expect(host.sent.at(-1)).toEqual({
      channel: 'rsb-native-popup:event',
      payload: {
        surfaceId,
        type: 'state',
        snapshot: expect.objectContaining({
          favicon: 'https://accounts.example.test/favicon.ico',
        }),
      },
    });
  });

  it('pins opener and popup, rejects a foreign owner, and closes idempotently', async () => {
    const host = makeContents(1);
    const foreign = makeContents(3);
    const popup = makeContents(42);
    const hostWindow = makeWindow();
    electronMocks.windows.set(host, hostWindow);
    electronMocks.windows.set(foreign, makeWindow());

    const surfaceId = createRsbNativePopupSurface(host as never, popup as never)!;
    attributeRsbNativePopupSurface(surfaceId, { tabId: 'tab-opener' });
    const claim = electronMocks.handlers.get(RSB_NATIVE_POPUP_CLAIM_CHANNEL)!;
    expect(() =>
      claim({ sender: foreign }, { surfaceId, sessionId: 'session-a', tabId: 'tab-popup' }),
    ).toThrow(/PERMISSION_DENIED/);
    await claim({ sender: host }, { surfaceId, sessionId: 'session-a', tabId: 'tab-popup' });
    expect(registry.acquirePinLease).toHaveBeenCalledTimes(2);

    const setBounds = electronMocks.handlers.get(RSB_NATIVE_POPUP_SET_BOUNDS_CHANNEL)!;
    expect(() =>
      setBounds(
        { sender: foreign },
        { surfaceId, bounds: { x: 0, y: 0, width: 10, height: 10 }, visible: true },
      ),
    ).toThrow(/PERMISSION_DENIED/);

    const close = electronMocks.handlers.get(RSB_NATIVE_POPUP_CLOSE_CHANNEL)!;
    await close({ sender: host }, { surfaceId });
    expect(popup.close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith('tab-popup', 42);
    expect(pinReleases.every((fn) => fn.mock.calls.length === 1)).toBe(true);
    expect(hasActiveRsbNativePopupSurfaces()).toBe(false);
    expect(isRsbNativePopupWebContentsId(42)).toBe(false);

    expect(close({ sender: host }, { surfaceId })).toEqual({ ok: true });
    expect(popup.close).toHaveBeenCalledOnce();
  });

  it('scales renderer CSS bounds into owner-window DIPs at non-default zoom', async () => {
    const host = makeContents(1);
    host.getZoomFactor = () => 1.25;
    const popup = makeContents(42);
    electronMocks.windows.set(host, makeWindow());
    const surfaceId = createRsbNativePopupSurface(host as never, popup as never)!;
    const claim = electronMocks.handlers.get(RSB_NATIVE_POPUP_CLAIM_CHANNEL)!;
    await claim({ sender: host }, { surfaceId, sessionId: 'session-a', tabId: 'tab-popup' });

    const setBounds = electronMocks.handlers.get(RSB_NATIVE_POPUP_SET_BOUNDS_CHANNEL)!;
    await setBounds(
      { sender: host },
      {
        surfaceId,
        bounds: { x: 8, y: 40, width: 600, height: 400 },
        visible: true,
      },
    );

    expect(electronMocks.views[0]?.bounds).toEqual({ x: 10, y: 50, width: 750, height: 500 });
  });

  it('closes a claimed surface when its creating renderer is destroyed', async () => {
    const host = makeContents(1);
    const popup = makeContents(42);
    electronMocks.windows.set(host, makeWindow());
    const surfaceId = createRsbNativePopupSurface(host as never, popup as never)!;
    const claim = electronMocks.handlers.get(RSB_NATIVE_POPUP_CLAIM_CHANNEL)!;
    await claim({ sender: host }, { surfaceId, sessionId: 'session-a', tabId: 'tab-popup' });

    host.close();

    expect(popup.close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith('tab-popup', 42);
    expect(hasActiveRsbNativePopupSurfaces()).toBe(false);
  });

  it('closes a claimed surface when the owner renderer begins a full reload', async () => {
    const host = makeContents(1);
    const popup = makeContents(42);
    electronMocks.windows.set(host, makeWindow());
    const surfaceId = createRsbNativePopupSurface(host as never, popup as never)!;
    const claim = electronMocks.handlers.get(RSB_NATIVE_POPUP_CLAIM_CHANNEL)!;
    await claim(
      { sender: host },
      { surfaceId, sessionId: 'session-a', tabId: 'tab-popup' },
    );

    host.emit('did-start-navigation', {}, 'file:///app/index.html', false, true);

    expect(popup.close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith('tab-popup', 42);
    expect(hasActiveRsbNativePopupSurfaces()).toBe(false);
  });

  it('disposes a popup that is never claimed by a renderer tab', () => {
    vi.useFakeTimers();
    const host = makeContents(1);
    const popup = makeContents(42);
    electronMocks.windows.set(host, makeWindow());

    createRsbNativePopupSurface(host as never, popup as never);
    vi.advanceTimersByTime(RSB_NATIVE_POPUP_CLAIM_TIMEOUT_MS);

    expect(popup.close).toHaveBeenCalledOnce();
    expect(hasActiveRsbNativePopupSurfaces()).toBe(false);
  });

  it('lets the creating renderer dispose a surface before it is claimed', async () => {
    const host = makeContents(1);
    const popup = makeContents(42);
    electronMocks.windows.set(host, makeWindow());
    const surfaceId = createRsbNativePopupSurface(host as never, popup as never)!;

    const close = electronMocks.handlers.get(RSB_NATIVE_POPUP_CLOSE_CHANNEL)!;
    await close({ sender: host }, { surfaceId });

    expect(popup.close).toHaveBeenCalledOnce();
    expect(hasActiveRsbNativePopupSurfaces()).toBe(false);
  });

  it('reports guest window.close to the claimed renderer and drops registry ownership', async () => {
    const host = makeContents(1);
    const popup = makeContents(42);
    const hostWindow = makeWindow();
    electronMocks.windows.set(host, hostWindow);
    const surfaceId = createRsbNativePopupSurface(host as never, popup as never)!;
    const claim = electronMocks.handlers.get(RSB_NATIVE_POPUP_CLAIM_CHANNEL)!;
    await claim({ sender: host }, { surfaceId, sessionId: 'session-a', tabId: 'tab-popup' });

    popup.close();

    expect(host.sent).toContainEqual({
      channel: 'rsb-native-popup:event',
      payload: { surfaceId, type: 'closed' },
    });
    expect(release).toHaveBeenCalledWith('tab-popup', 42);
    expect(getRsbNativePopupOwnerWebContents(42)).toBeNull();

    const setBounds = electronMocks.handlers.get(RSB_NATIVE_POPUP_SET_BOUNDS_CHANNEL)!;
    expect(
      setBounds(
        { sender: host },
        { surfaceId, bounds: { x: 0, y: 0, width: 10, height: 10 }, visible: false },
      ),
    ).toEqual({ ok: true });
    const close = electronMocks.handlers.get(RSB_NATIVE_POPUP_CLOSE_CHANNEL)!;
    expect(close({ sender: host }, { surfaceId })).toEqual({ ok: true });
  });
});
