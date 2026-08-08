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
  disposeUnclaimedRsbNativePopupSurface,
  getRsbNativePopupOwnerWebContents,
  hasActiveRsbNativePopupSurfaces,
  hasActiveRsbNativePopupSurfacesForOwner,
  isRsbNativePopupWebContentsId,
  prepareQueuedRsbNativePopupSurfaceTransfer,
  registerRsbNativePopupSurfaceIpc,
  transferRsbNativePopupSurface,
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

  it('atomically transfers an unclaimed surface and rebinds ownership cleanup', async () => {
    const oldHost = makeContents(1);
    const nextHost = makeContents(2);
    const popup = makeContents(42);
    const oldWindow = makeWindow();
    const nextWindow = makeWindow();
    electronMocks.windows.set(oldHost, oldWindow);
    electronMocks.windows.set(nextHost, nextWindow);
    const surfaceId = createRsbNativePopupSurface(oldHost as never, popup as never)!;
    const view = electronMocks.views[0]!;
    const staleDestroyed = oldHost.listeners('destroyed')[0] as () => void;
    const staleNavigation = oldHost.listeners('did-start-navigation')[0] as (
      event: unknown,
      url: string,
      isSameDocument: boolean,
      isMainFrame: boolean,
    ) => void;

    expect(hasActiveRsbNativePopupSurfacesForOwner(oldHost.id)).toBe(true);
    expect(hasActiveRsbNativePopupSurfacesForOwner(nextHost.id)).toBe(false);

    expect(transferRsbNativePopupSurface(surfaceId, nextHost as never)).toBe('transferred');
    expect(oldWindow.contentView.removeChildView).toHaveBeenCalledWith(view);
    expect(nextWindow.contentView.addChildView).toHaveBeenCalledWith(view);
    expect(oldWindow.children.has(view)).toBe(false);
    expect(nextWindow.children.has(view)).toBe(true);
    expect(getRsbNativePopupOwnerWebContents(42)).toBe(nextHost);
    expect(hasActiveRsbNativePopupSurfacesForOwner(oldHost.id)).toBe(false);
    expect(hasActiveRsbNativePopupSurfacesForOwner(nextHost.id)).toBe(true);

    // removeListener cannot revoke a callback Electron already queued. Both
    // stale lifecycle callbacks must observe that oldHost is no longer owner.
    staleDestroyed();
    staleNavigation({}, 'https://stale-owner.test/', false, true);
    expect(popup.close).not.toHaveBeenCalled();
    expect(hasActiveRsbNativePopupSurfaces()).toBe(true);

    oldHost.close();
    expect(popup.close).not.toHaveBeenCalled();

    const claim = electronMocks.handlers.get(RSB_NATIVE_POPUP_CLAIM_CHANNEL)!;
    expect(() =>
      claim({ sender: oldHost }, { surfaceId, sessionId: 'session-a', tabId: 'tab-popup' }),
    ).toThrow(/PERMISSION_DENIED/);
    await claim({ sender: nextHost }, { surfaceId, sessionId: 'session-a', tabId: 'tab-popup' });

    nextHost.close();
    expect(popup.close).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith('tab-popup', 42);
    expect(hasActiveRsbNativePopupSurfaces()).toBe(false);
  });

  it('prepares every queued unclaimed surface before a host transition', () => {
    const oldHost = makeContents(1);
    const nextHost = makeContents(2);
    const firstPopup = makeContents(42);
    const secondPopup = makeContents(43);
    electronMocks.windows.set(oldHost, makeWindow());
    electronMocks.windows.set(nextHost, makeWindow());
    const firstId = createRsbNativePopupSurface(oldHost as never, firstPopup as never)!;
    const secondId = createRsbNativePopupSurface(oldHost as never, secondPopup as never)!;

    expect(
      prepareQueuedRsbNativePopupSurfaceTransfer([firstId, secondId], nextHost as never),
    ).toEqual({ ready: true, droppedSurfaceIds: [] });
    expect(getRsbNativePopupOwnerWebContents(firstPopup.id)).toBe(nextHost);
    expect(getRsbNativePopupOwnerWebContents(secondPopup.id)).toBe(nextHost);
  });

  it('blocks a host transition for unclaimed surfaces whose payload already left the queue', () => {
    const oldHost = makeContents(1);
    const nextHost = makeContents(2);
    const popup = makeContents(42);
    electronMocks.windows.set(oldHost, makeWindow());
    electronMocks.windows.set(nextHost, makeWindow());
    createRsbNativePopupSurface(oldHost as never, popup as never);

    expect(prepareQueuedRsbNativePopupSurfaceTransfer([], nextHost as never)).toEqual({
      ready: false,
      droppedSurfaceIds: [],
    });
    expect(getRsbNativePopupOwnerWebContents(popup.id)).toBe(oldHost);
  });

  it('blocks a host transition once a queued surface has been claimed', async () => {
    const oldHost = makeContents(1);
    const nextHost = makeContents(2);
    const popup = makeContents(42);
    electronMocks.windows.set(oldHost, makeWindow());
    electronMocks.windows.set(nextHost, makeWindow());
    const surfaceId = createRsbNativePopupSurface(oldHost as never, popup as never)!;
    const claim = electronMocks.handlers.get(RSB_NATIVE_POPUP_CLAIM_CHANNEL)!;
    await claim({ sender: oldHost }, { surfaceId, sessionId: 'session-a', tabId: 'tab-popup' });

    expect(prepareQueuedRsbNativePopupSurfaceTransfer([surfaceId], nextHost as never)).toEqual({
      ready: false,
      droppedSurfaceIds: [],
    });
    expect(getRsbNativePopupOwnerWebContents(popup.id)).toBe(oldHost);
  });

  it('rolls back earlier queued transfers when a later native view is retryable', () => {
    const oldHost = makeContents(1);
    const nextHost = makeContents(2);
    const firstPopup = makeContents(42);
    const secondPopup = makeContents(43);
    const oldWindow = makeWindow();
    const nextWindow = makeWindow();
    electronMocks.windows.set(oldHost, oldWindow);
    electronMocks.windows.set(nextHost, nextWindow);
    const firstId = createRsbNativePopupSurface(oldHost as never, firstPopup as never)!;
    const secondId = createRsbNativePopupSurface(oldHost as never, secondPopup as never)!;
    let attachCount = 0;
    nextWindow.contentView.addChildView.mockImplementation((view: object) => {
      attachCount += 1;
      if (attachCount === 2) throw new Error('second native view rejected');
      return nextWindow.children.add(view);
    });

    expect(
      prepareQueuedRsbNativePopupSurfaceTransfer([firstId, secondId], nextHost as never),
    ).toEqual({ ready: false, droppedSurfaceIds: [] });
    expect(getRsbNativePopupOwnerWebContents(firstPopup.id)).toBe(oldHost);
    expect(getRsbNativePopupOwnerWebContents(secondPopup.id)).toBe(oldHost);
    expect(nextWindow.children.size).toBe(0);
  });

  it('disposes a prepared surface when its rollback is also retryable', () => {
    const oldHost = makeContents(1);
    const nextHost = makeContents(2);
    const firstPopup = makeContents(42);
    const secondPopup = makeContents(43);
    const oldWindow = makeWindow();
    const nextWindow = makeWindow();
    electronMocks.windows.set(oldHost, oldWindow);
    electronMocks.windows.set(nextHost, nextWindow);
    const firstId = createRsbNativePopupSurface(oldHost as never, firstPopup as never)!;
    const secondId = createRsbNativePopupSurface(oldHost as never, secondPopup as never)!;
    let targetAttachCount = 0;
    nextWindow.contentView.addChildView.mockImplementation((view: object) => {
      targetAttachCount += 1;
      if (targetAttachCount === 2) throw new Error('second native view rejected');
      return nextWindow.children.add(view);
    });
    let oldAttachCount = 0;
    oldWindow.contentView.addChildView.mockImplementation((view: object) => {
      oldAttachCount += 1;
      if (oldAttachCount === 2) throw new Error('first native view rollback rejected');
      return oldWindow.children.add(view);
    });

    expect(
      prepareQueuedRsbNativePopupSurfaceTransfer([firstId, secondId], nextHost as never),
    ).toEqual({ ready: false, droppedSurfaceIds: [firstId] });
    expect(firstPopup.close).toHaveBeenCalledOnce();
    expect(getRsbNativePopupOwnerWebContents(firstPopup.id)).toBeNull();
    expect(getRsbNativePopupOwnerWebContents(secondPopup.id)).toBe(oldHost);
    expect(hasActiveRsbNativePopupSurfacesForOwner(nextHost.id)).toBe(false);
  });

  it('allows stale queued ids when no native surface remains', () => {
    const nextHost = makeContents(2);
    electronMocks.windows.set(nextHost, makeWindow());

    expect(
      prepareQueuedRsbNativePopupSurfaceTransfer(['surface-already-gone'], nextHost as never),
    ).toEqual({ ready: true, droppedSurfaceIds: [] });
  });

  it('rolls an unclaimed surface back when the new window rejects its view', async () => {
    const oldHost = makeContents(1);
    const nextHost = makeContents(2);
    const popup = makeContents(42);
    const oldWindow = makeWindow();
    const nextWindow = makeWindow();
    electronMocks.windows.set(oldHost, oldWindow);
    electronMocks.windows.set(nextHost, nextWindow);
    const surfaceId = createRsbNativePopupSurface(oldHost as never, popup as never)!;
    const staleDestroyed = oldHost.listeners('destroyed')[0] as () => void;
    const staleNavigation = oldHost.listeners('did-start-navigation')[0] as (
      event: unknown,
      url: string,
      isSameDocument: boolean,
      isMainFrame: boolean,
    ) => void;
    nextWindow.contentView.addChildView.mockImplementationOnce(() => {
      throw new Error('native view rejected');
    });

    expect(transferRsbNativePopupSurface(surfaceId, nextHost as never)).toBe('retryable');
    expect(getRsbNativePopupOwnerWebContents(42)).toBe(oldHost);
    expect(oldWindow.children.has(electronMocks.views[0]!)).toBe(true);
    expect(popup.close).not.toHaveBeenCalled();

    // Rollback installs a new ownership generation. Callbacks captured before
    // the attempted transfer must not tear down the restored surface.
    staleDestroyed();
    staleNavigation({}, 'https://stale-owner.test/', false, true);
    expect(popup.close).not.toHaveBeenCalled();
    expect(hasActiveRsbNativePopupSurfacesForOwner(oldHost.id)).toBe(true);

    const claim = electronMocks.handlers.get(RSB_NATIVE_POPUP_CLAIM_CHANNEL)!;
    expect(
      await claim({ sender: oldHost }, { surfaceId, sessionId: 'session-a', tabId: 'tab-popup' }),
    ).toMatchObject({ alive: true });
  });

  it('fails closed when detaching leaves native view ownership ambiguous', () => {
    const oldHost = makeContents(1);
    const nextHost = makeContents(2);
    const popup = makeContents(42);
    const oldWindow = makeWindow();
    electronMocks.windows.set(oldHost, oldWindow);
    electronMocks.windows.set(nextHost, makeWindow());
    const surfaceId = createRsbNativePopupSurface(oldHost as never, popup as never)!;
    oldWindow.contentView.removeChildView.mockImplementationOnce(() => {
      throw new Error('native detach failed');
    });

    expect(transferRsbNativePopupSurface(surfaceId, nextHost as never)).toBe('gone');
    expect(popup.close).toHaveBeenCalledOnce();
    expect(hasActiveRsbNativePopupSurfaces()).toBe(false);
  });

  it('fails closed when both transfer and rollback reject the native view', () => {
    const oldHost = makeContents(1);
    const nextHost = makeContents(2);
    const popup = makeContents(42);
    const oldWindow = makeWindow();
    const nextWindow = makeWindow();
    electronMocks.windows.set(oldHost, oldWindow);
    electronMocks.windows.set(nextHost, nextWindow);
    const surfaceId = createRsbNativePopupSurface(oldHost as never, popup as never)!;
    nextWindow.contentView.addChildView.mockImplementationOnce(() => {
      throw new Error('native attach failed');
    });
    oldWindow.contentView.addChildView.mockImplementationOnce(() => {
      throw new Error('native rollback failed');
    });

    expect(transferRsbNativePopupSurface(surfaceId, nextHost as never)).toBe('gone');
    expect(popup.close).toHaveBeenCalledOnce();
    expect(hasActiveRsbNativePopupSurfaces()).toBe(false);
  });

  it('disposes only unclaimed surfaces dropped by the main popup backlog', async () => {
    const host = makeContents(1);
    const unclaimedPopup = makeContents(42);
    electronMocks.windows.set(host, makeWindow());
    const unclaimedId = createRsbNativePopupSurface(host as never, unclaimedPopup as never)!;

    expect(disposeUnclaimedRsbNativePopupSurface(unclaimedId)).toBe(true);
    expect(unclaimedPopup.close).toHaveBeenCalledOnce();
    expect(hasActiveRsbNativePopupSurfaces()).toBe(false);

    const claimedPopup = makeContents(43);
    const claimedId = createRsbNativePopupSurface(host as never, claimedPopup as never)!;
    const claim = electronMocks.handlers.get(RSB_NATIVE_POPUP_CLAIM_CHANNEL)!;
    await claim(
      { sender: host },
      { surfaceId: claimedId, sessionId: 'session-a', tabId: 'tab-popup' },
    );
    expect(disposeUnclaimedRsbNativePopupSurface(claimedId)).toBe(false);
    expect(claimedPopup.close).not.toHaveBeenCalled();
  });

  it('publishes null when a favicon update has no usable URL', async () => {
    const host = makeContents(1);
    const popup = makeContents(42);
    electronMocks.windows.set(host, makeWindow());
    const surfaceId = createRsbNativePopupSurface(host as never, popup as never)!;
    const claim = electronMocks.handlers.get(RSB_NATIVE_POPUP_CLAIM_CHANNEL)!;
    await claim({ sender: host }, { surfaceId, sessionId: 'session-a', tabId: 'tab-popup' });

    popup.emit('page-favicon-updated', {}, ['', '   ']);

    expect(host.sent.at(-1)).toEqual({
      channel: 'rsb-native-popup:event',
      payload: {
        surfaceId,
        type: 'state',
        snapshot: expect.objectContaining({ favicon: null }),
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
    await claim({ sender: host }, { surfaceId, sessionId: 'session-a', tabId: 'tab-popup' });

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
