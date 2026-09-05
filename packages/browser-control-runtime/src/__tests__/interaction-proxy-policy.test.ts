import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertBrowserNavigationResultAllowed: vi.fn(async () => undefined),
  assertPageNavigationCompletedSafely: vi.fn(async (_opts?: { page?: unknown }) => undefined),
  closeBlockedNavigationTarget: vi.fn(async () => undefined),
  getPageForTargetId: vi.fn(),
  quarantineTargetWithoutClosing: vi.fn(async () => undefined),
  refLocator: vi.fn(),
}));

vi.mock('../_generated/extension/src/browser/navigation-guard.js', () => ({
  assertBrowserNavigationResultAllowed: mocks.assertBrowserNavigationResultAllowed,
  withBrowserNavigationPolicy: (
    ssrfPolicy: unknown,
    options?: { browserProxyMode?: string },
  ) => ({
    ...(ssrfPolicy ? { ssrfPolicy } : {}),
    ...(options?.browserProxyMode ? { browserProxyMode: options.browserProxyMode } : {}),
  }),
}));

vi.mock('../_generated/extension/src/browser/pw-session.js', () => ({
  assertPageNavigationCompletedSafely: mocks.assertPageNavigationCompletedSafely,
  closeBlockedNavigationTarget: mocks.closeBlockedNavigationTarget,
  quarantineTargetWithoutClosing: mocks.quarantineTargetWithoutClosing,
  createObservedDialogAbortSignalForPage: () => ({ signal: undefined, cleanup: vi.fn() }),
  ensurePageState: vi.fn(),
  forceDisconnectPlaywrightForTarget: vi.fn(async () => undefined),
  getPageForTargetId: mocks.getPageForTargetId,
  isBrowserObservedDialogBlockedError: () => false,
  markObservedDialogsHandledRemotelyForPage: vi.fn(),
  refLocator: mocks.refLocator,
  restoreRoleRefsForTarget: vi.fn(),
}));

vi.mock('../_generated/extension/src/browser/paths.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveStrictExistingUploadPaths: async ({ requestedPaths }: { requestedPaths: string[] }) => ({
    ok: true,
    paths: requestedPaths,
  }),
}));

import {
  executeActViaPlaywright,
  setInputFilesViaPlaywright,
} from '../_generated/extension/src/browser/pw-tools-core.interactions.js';

describe('Playwright interaction proxy navigation policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('carries explicit proxy mode into main-frame and subframe checks', async () => {
    let currentUrl = 'https://start.example/';
    let navigationListener: ((frame: { url(): string }) => void) | undefined;
    const mainFrame = { url: () => currentUrl };
    const subframe = { url: () => 'https://static.allowed.example/frame' };
    const page = {
      url: () => currentUrl,
      mainFrame: () => mainFrame,
      on: vi.fn((_event: string, listener: (frame: { url(): string }) => void) => {
        navigationListener = listener;
      }),
      off: vi.fn(),
    };
    const locator = {
      click: vi.fn(async () => {
        navigationListener?.(subframe);
        currentUrl = 'https://allowed.example/next';
        navigationListener?.(mainFrame);
      }),
    };
    mocks.getPageForTargetId.mockResolvedValue(page);
    mocks.refLocator.mockReturnValue(locator);

    await executeActViaPlaywright({
      cdpUrl: 'http://127.0.0.1:18800',
      targetId: 'page-1',
      action: { kind: 'click', ref: 'e1' },
      ssrfPolicy: { hostnameAllowlist: ['*.allowed.example'] },
      browserProxyMode: 'explicit-browser-proxy',
    });

    expect(mocks.assertBrowserNavigationResultAllowed).toHaveBeenCalledWith({
      url: 'https://static.allowed.example/frame',
      ssrfPolicy: { hostnameAllowlist: ['*.allowed.example'] },
      browserProxyMode: 'explicit-browser-proxy',
    });
    expect(mocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
      expect.objectContaining({
        page,
        ssrfPolicy: { hostnameAllowlist: ['*.allowed.example'] },
        browserProxyMode: 'explicit-browser-proxy',
      }),
    );
  });

  it.each([
    ['hover', { kind: 'hover', ref: 'e1' }],
    ['scrollIntoView', { kind: 'scrollIntoView', ref: 'e1' }],
    ['drag', { kind: 'drag', startRef: 'e1', endRef: 'e2' }],
    ['wait', { kind: 'wait', timeMs: 1 }],
    ['resize', { kind: 'resize', width: 800, height: 600 }],
  ] as const)(
    'guards script navigation triggered by %s with the proxy policy',
    async (_label, action) => {
      let currentUrl = 'https://start.example/';
      const mainFrame = { url: () => currentUrl };
      const navigate = async () => {
        currentUrl = 'https://allowed.example/next';
      };
      const page = {
        url: () => currentUrl,
        mainFrame: () => mainFrame,
        on: vi.fn(),
        off: vi.fn(),
        waitForTimeout: vi.fn(navigate),
        setViewportSize: vi.fn(navigate),
      };
      const locator = {
        hover: vi.fn(navigate),
        scrollIntoViewIfNeeded: vi.fn(navigate),
        dragTo: vi.fn(navigate),
      };
      mocks.getPageForTargetId.mockResolvedValue(page);
      mocks.refLocator.mockReturnValue(locator);

      await executeActViaPlaywright({
        cdpUrl: 'http://127.0.0.1:18800',
        targetId: 'page-1',
        action: action as never,
        ssrfPolicy: { hostnameAllowlist: ['*.allowed.example'] },
        browserProxyMode: 'explicit-browser-proxy',
      });

      expect(mocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
        expect.objectContaining({
          page,
          ssrfPolicy: { hostnameAllowlist: ['*.allowed.example'] },
          browserProxyMode: 'explicit-browser-proxy',
        }),
      );
    },
  );

  it('validates popups opened during a guarded interaction against the proxy policy', async () => {
    let currentUrl = 'https://start.example/';
    const mainFrame = { url: () => currentUrl };
    let contextPageListener: ((page: unknown) => void) | undefined;
    const popup = {
      url: () => 'https://evil.example/popup',
      mainFrame: () => ({ url: () => 'https://evil.example/popup' }),
      on: vi.fn(),
      off: vi.fn(),
    };
    const context = {
      on: vi.fn((_event: string, listener: (page: unknown) => void) => {
        contextPageListener = listener;
      }),
      off: vi.fn(),
    };
    const page = {
      url: () => currentUrl,
      mainFrame: () => mainFrame,
      on: vi.fn(),
      off: vi.fn(),
      context: () => context,
    };
    const locator = {
      click: vi.fn(async () => {
        // Deferred like setTimeout(() => window.open(...)): the popup arrives
        // after the action promise resolves, inside the delayed grace window.
        setTimeout(() => contextPageListener?.(popup), 50);
      }),
    };
    mocks.getPageForTargetId.mockResolvedValue(page);
    mocks.refLocator.mockReturnValue(locator);

    await executeActViaPlaywright({
      cdpUrl: 'http://127.0.0.1:18800',
      targetId: 'page-1',
      action: { kind: 'click', ref: 'e1' },
      ssrfPolicy: { hostnameAllowlist: ['*.allowed.example'] },
      browserProxyMode: 'explicit-browser-proxy',
    });

    expect(mocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
      expect.objectContaining({
        page: popup,
        ssrfPolicy: { hostnameAllowlist: ['*.allowed.example'] },
        browserProxyMode: 'explicit-browser-proxy',
      }),
    );
  });

  it('detaches the popup listener even when navigation validation rejects', async () => {
    let currentUrl = 'https://start.example/';
    const mainFrame = { url: () => currentUrl };
    const context = { on: vi.fn(), off: vi.fn() };
    const page = {
      url: () => currentUrl,
      mainFrame: () => mainFrame,
      on: vi.fn(),
      off: vi.fn(),
      context: () => context,
    };
    const locator = {
      click: vi.fn(async () => {
        currentUrl = 'https://blocked.example/next';
      }),
    };
    mocks.getPageForTargetId.mockResolvedValue(page);
    mocks.refLocator.mockReturnValue(locator);
    mocks.assertPageNavigationCompletedSafely.mockRejectedValueOnce(
      new Error('Navigation blocked: proxied browser navigation requires HTTPS'),
    );

    await expect(executeActViaPlaywright({
      cdpUrl: 'http://127.0.0.1:18800',
      targetId: 'page-1',
      action: { kind: 'click', ref: 'e1' },
      ssrfPolicy: { hostnameAllowlist: ['*.allowed.example'] },
      browserProxyMode: 'explicit-browser-proxy',
    })).rejects.toThrow(/Navigation blocked/);

    // A policy deny must not leak the context listener: otherwise every blocked
    // interaction retains all tabs opened afterwards.
    expect(context.on).toHaveBeenCalledTimes(1);
    expect(context.off).toHaveBeenCalledTimes(1);
    expect(context.off).toHaveBeenCalledWith('page', context.on.mock.calls[0]?.[1]);
  });

  it('still validates popups when the main-frame navigation is denied', async () => {
    let currentUrl = 'https://start.example/';
    const mainFrame = { url: () => currentUrl };
    let contextPageListener: ((page: unknown) => void) | undefined;
    const popup = {
      url: () => 'https://evil.example/popup',
      mainFrame: () => ({ url: () => 'https://evil.example/popup' }),
      on: vi.fn(),
      off: vi.fn(),
    };
    const context = {
      on: vi.fn((_event: string, listener: (page: unknown) => void) => {
        contextPageListener = listener;
      }),
      off: vi.fn(),
    };
    const page = {
      url: () => currentUrl,
      mainFrame: () => mainFrame,
      on: vi.fn(),
      off: vi.fn(),
      context: () => context,
    };
    const locator = {
      click: vi.fn(async () => {
        // Both a denied main-frame navigation and a new tab.
        currentUrl = 'https://blocked.example/next';
        contextPageListener?.(popup);
      }),
    };
    mocks.getPageForTargetId.mockResolvedValue(page);
    mocks.refLocator.mockReturnValue(locator);
    mocks.assertPageNavigationCompletedSafely.mockRejectedValueOnce(
      new Error('Navigation blocked: main frame'),
    );

    // The main-frame denial is what the caller asked for, so it wins.
    await expect(executeActViaPlaywright({
      cdpUrl: 'http://127.0.0.1:18800',
      targetId: 'page-1',
      action: { kind: 'click', ref: 'e1' },
      ssrfPolicy: { hostnameAllowlist: ['*.allowed.example'] },
      browserProxyMode: 'explicit-browser-proxy',
    })).rejects.toThrow(/main frame/);

    // ...but the popup must still have been checked, not left live.
    expect(mocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
      expect.objectContaining({ page: popup }),
    );
    expect(context.off).toHaveBeenCalledTimes(1);
  });

  it('validates every popup even when an earlier popup is denied', async () => {
    const currentUrl = 'https://start.example/';
    const mainFrame = { url: () => currentUrl };
    let contextPageListener: ((page: unknown) => void) | undefined;
    const makePopup = (url: string) => ({
      url: () => url,
      mainFrame: () => ({ url: () => url }),
      on: vi.fn(),
      off: vi.fn(),
    });
    const firstPopup = makePopup('https://denied-one.example/a');
    const secondPopup = makePopup('https://denied-two.example/b');
    const context = {
      on: vi.fn((_event: string, listener: (page: unknown) => void) => {
        contextPageListener = listener;
      }),
      off: vi.fn(),
    };
    const page = {
      url: () => currentUrl,
      mainFrame: () => mainFrame,
      on: vi.fn(),
      off: vi.fn(),
      context: () => context,
    };
    const locator = {
      click: vi.fn(async () => {
        contextPageListener?.(firstPopup);
        contextPageListener?.(secondPopup);
      }),
    };
    mocks.getPageForTargetId.mockResolvedValue(page);
    mocks.refLocator.mockReturnValue(locator);
    // First popup is denied; the second must still be checked.
    mocks.assertPageNavigationCompletedSafely.mockRejectedValueOnce(
      new Error('Navigation blocked: popup one'),
    );

    await expect(executeActViaPlaywright({
      cdpUrl: 'http://127.0.0.1:18800',
      targetId: 'page-1',
      action: { kind: 'click', ref: 'e1' },
      ssrfPolicy: { hostnameAllowlist: ['*.allowed.example'] },
      browserProxyMode: 'explicit-browser-proxy',
    })).rejects.toThrow(/popup one/);

    for (const popup of [firstPopup, secondPopup]) {
      expect(mocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
        expect.objectContaining({ page: popup }),
      );
    }
    // The denied popup is torn down fail-closed; the popup that passed
    // validation stays open.
    expect(mocks.closeBlockedNavigationTarget).toHaveBeenCalledTimes(1);
    expect(mocks.closeBlockedNavigationTarget).toHaveBeenCalledWith(
      expect.objectContaining({ page: firstPopup }),
    );
  });

  it('closes a rejected popup fail-closed before rethrowing the denial', async () => {
    // A policy deny on a popup only quarantines inside the assertion helper
    // (it never closes), and interaction popups never reach the navigate-style
    // close path — without an explicit close here the denied page would keep
    // executing after the listener detaches.
    const currentUrl = 'https://start.example/';
    let contextPageListener: ((page: unknown) => void) | undefined;
    const popup = {
      url: () => 'https://evil.example/popup',
      mainFrame: () => ({ url: () => 'https://evil.example/popup' }),
      on: vi.fn(),
      off: vi.fn(),
    };
    const context = {
      on: vi.fn((_event: string, listener: (page: unknown) => void) => {
        contextPageListener = listener;
      }),
      off: vi.fn(),
    };
    const page = {
      url: () => currentUrl,
      mainFrame: () => ({ url: () => currentUrl }),
      on: vi.fn(),
      off: vi.fn(),
      context: () => context,
    };
    const locator = {
      click: vi.fn(async () => {
        contextPageListener?.(popup);
      }),
    };
    mocks.getPageForTargetId.mockResolvedValue(page);
    mocks.refLocator.mockReturnValue(locator);
    mocks.assertPageNavigationCompletedSafely.mockImplementation(async ({ page: checked }) => {
      if (checked === popup) throw new Error('Navigation blocked: popup denied');
    });

    await expect(executeActViaPlaywright({
      cdpUrl: 'http://127.0.0.1:18800',
      targetId: 'page-1',
      action: { kind: 'click', ref: 'e1' },
      ssrfPolicy: { hostnameAllowlist: ['*.allowed.example'] },
      browserProxyMode: 'explicit-browser-proxy',
    })).rejects.toThrow(/popup denied/);

    expect(mocks.closeBlockedNavigationTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: 'http://127.0.0.1:18800',
        page: popup,
      }),
    );
    // A hung close must not leak the context listener either.
    expect(context.off).toHaveBeenCalledTimes(1);
  });

  it('escalates to context teardown when a denied popup will not close', async () => {
    // A close that hangs is NOT containment: the denied page is still live and
    // scriptable once the listener detaches. The per-popup path must climb the
    // same ladder the overflow path uses rather than treating its own timeout
    // as success.
    const currentUrl = 'https://start.example/';
    let contextPageListener: ((page: unknown) => void) | undefined;
    const popup = {
      url: () => 'https://evil.example/popup',
      mainFrame: () => ({ url: () => 'https://evil.example/popup' }),
      on: vi.fn(),
      off: vi.fn(),
    };
    const context = {
      on: vi.fn((_event: string, listener: (page: unknown) => void) => {
        contextPageListener = listener;
      }),
      off: vi.fn(),
      close: vi.fn(async () => undefined),
      browser: vi.fn(() => ({ close: vi.fn(async () => undefined) })),
    };
    const page = {
      url: () => currentUrl,
      mainFrame: () => ({ url: () => currentUrl }),
      on: vi.fn(),
      off: vi.fn(),
      context: () => context,
    };
    mocks.getPageForTargetId.mockResolvedValue(page);
    mocks.refLocator.mockReturnValue({
      click: vi.fn(async () => {
        contextPageListener?.(popup);
      }),
    });
    mocks.assertPageNavigationCompletedSafely.mockImplementation(async ({ page: checked }) => {
      if (checked === popup) throw new Error('Navigation blocked: popup denied');
    });
    // The page refuses to close.
    mocks.closeBlockedNavigationTarget.mockRejectedValue(new Error('close hung'));

    // The context DOES close, so containment succeeded overall — the caller
    // still sees the policy denial, not a teardown failure.
    await expect(executeActViaPlaywright({
      cdpUrl: 'http://127.0.0.1:18800',
      targetId: 'page-1',
      action: { kind: 'click', ref: 'e1' },
      ssrfPolicy: { hostnameAllowlist: ['*.allowed.example'] },
      browserProxyMode: 'explicit-browser-proxy',
    })).rejects.toThrow(/popup denied/);

    expect(context.close).toHaveBeenCalledTimes(1);
    expect(context.off).toHaveBeenCalledTimes(1);
  });

  it('reports an untorn-down browser when no teardown can contain a denied popup', async () => {
    // Page, context and browser all refuse. This is the only signal the host
    // uses to distrust the whole route (mentionsUntornDownBrowser), so it must
    // outrank the ordinary policy denial — otherwise the route stays usable
    // while pages we never contained keep executing.
    const currentUrl = 'https://start.example/';
    let contextPageListener: ((page: unknown) => void) | undefined;
    const popup = {
      url: () => 'https://evil.example/popup',
      mainFrame: () => ({ url: () => 'https://evil.example/popup' }),
      on: vi.fn(),
      off: vi.fn(),
    };
    const browserClose = vi.fn(async () => {
      throw new Error('browser close failed');
    });
    const context = {
      on: vi.fn((_event: string, listener: (page: unknown) => void) => {
        contextPageListener = listener;
      }),
      off: vi.fn(),
      close: vi.fn(async () => {
        throw new Error('context close failed');
      }),
      browser: vi.fn(() => ({ close: browserClose })),
    };
    const page = {
      url: () => currentUrl,
      mainFrame: () => ({ url: () => currentUrl }),
      on: vi.fn(),
      off: vi.fn(),
      context: () => context,
    };
    mocks.getPageForTargetId.mockResolvedValue(page);
    mocks.refLocator.mockReturnValue({
      click: vi.fn(async () => {
        contextPageListener?.(popup);
      }),
    });
    mocks.assertPageNavigationCompletedSafely.mockImplementation(async ({ page: checked }) => {
      if (checked === popup) throw new Error('Navigation blocked: popup denied');
    });
    mocks.closeBlockedNavigationTarget.mockRejectedValue(new Error('close hung'));

    await expect(executeActViaPlaywright({
      cdpUrl: 'http://127.0.0.1:18800',
      targetId: 'page-1',
      action: { kind: 'click', ref: 'e1' },
      ssrfPolicy: { hostnameAllowlist: ['*.allowed.example'] },
      browserProxyMode: 'explicit-browser-proxy',
    })).rejects.toThrow(/could not be torn down/);

    expect(context.close).toHaveBeenCalledTimes(1);
    expect(browserClose).toHaveBeenCalledTimes(1);
    expect(context.off).toHaveBeenCalledTimes(1);
  });

  it('validates a popup opened by another popup during its grace window', async () => {
    // The listener must stay attached across popup validation: a popup can open
    // a further popup inside its own 250ms window, and detaching early would
    // leave that second-generation tab uncollected and unvalidated.
    const currentUrl = 'https://start.example/';
    let contextPageListener: ((page: unknown) => void) | undefined;
    const mkPopup = (url: string, onObserve?: () => void) => {
      let observed = false;
      return {
        // Stays at about:blank on first read so the delayed-navigation observer
        // actually waits, then reports the real URL — the window during which a
        // further popup can appear.
        url: () => {
          if (!observed) { observed = true; onObserve?.(); return 'about:blank'; }
          return url;
        },
        mainFrame: () => ({ url: () => url }),
        on: vi.fn(),
        off: vi.fn(),
      };
    };
    const second = mkPopup('https://second.example/b');
    // The second popup appears ASYNCHRONOUSLY while the first one's grace
    // window is running — i.e. after the old code had already detached the
    // context listener, so `second` would never be collected at all.
    let spawned = false;
    const first = mkPopup('https://first.example/a', () => {
      if (spawned) return;
      spawned = true;
      setTimeout(() => contextPageListener?.(second), 20);
    });
    // off() must actually DETACH, or the test cannot tell the fixed code from
    // the broken code — a mock that keeps the listener callable would let a
    // late popup through either way.
    const context = {
      on: vi.fn((_event: string, listener: (page: unknown) => void) => {
        contextPageListener = listener;
      }),
      off: vi.fn(() => { contextPageListener = undefined; }),
    };
    const page = {
      url: () => currentUrl,
      mainFrame: () => ({ url: () => currentUrl }),
      on: vi.fn(),
      off: vi.fn(),
      context: () => context,
    };
    mocks.getPageForTargetId.mockResolvedValue(page);
    mocks.refLocator.mockReturnValue({
      click: vi.fn(async () => { contextPageListener?.(first); }),
    });

    await executeActViaPlaywright({
      cdpUrl: 'http://127.0.0.1:18800',
      targetId: 'page-1',
      action: { kind: 'click', ref: 'e1' },
      ssrfPolicy: { hostnameAllowlist: ['*.allowed.example'] },
      browserProxyMode: 'explicit-browser-proxy',
    });

    for (const popup of [first, second]) {
      expect(mocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
        expect.objectContaining({ page: popup }),
      );
    }
    // Detach happens once, only after the whole chain has drained.
    expect(context.off).toHaveBeenCalledTimes(1);
  });

  it('terminates and closes the remainder when a popup chain never stops growing', async () => {
    // An allowlisted page can make every popup open another inside its own
    // grace window. Draining that queue unbounded never empties: the action
    // would hang forever, and the backend serializes browser calls, so a later
    // stop — and dispose at quit — would queue behind it indefinitely.
    const currentUrl = 'https://start.example/';
    let contextPageListener: ((page: unknown) => void) | undefined;
    const closed: string[] = [];
    let created = 0;
    const spawnPopup = (): Record<string, unknown> => {
      const id = `popup-${created += 1}`;
      let observed = false;
      return {
        url: () => {
          if (!observed) {
            observed = true;
            // Each popup spawns another while its own grace window runs.
            setTimeout(() => contextPageListener?.(spawnPopup()), 5);
            return 'about:blank';
          }
          return `https://chain.example/${id}`;
        },
        mainFrame: () => ({ url: () => `https://chain.example/${id}` }),
        on: vi.fn(),
        off: vi.fn(),
        close: vi.fn(async () => { closed.push(id); }),
      };
    };
    const context = {
      on: vi.fn((_e: string, listener: (page: unknown) => void) => { contextPageListener = listener; }),
      off: vi.fn(() => { contextPageListener = undefined; }),
    };
    const page = {
      url: () => currentUrl,
      mainFrame: () => ({ url: () => currentUrl }),
      on: vi.fn(),
      off: vi.fn(),
      context: () => context,
    };
    mocks.getPageForTargetId.mockResolvedValue(page);
    mocks.refLocator.mockReturnValue({
      click: vi.fn(async () => { contextPageListener?.(spawnPopup()); }),
    });

    // The assertion that matters is that this RESOLVES at all.
    await expect(executeActViaPlaywright({
      cdpUrl: 'http://127.0.0.1:18800',
      targetId: 'page-1',
      action: { kind: 'click', ref: 'e1' },
      ssrfPolicy: { hostnameAllowlist: ['*.allowed.example'] },
      browserProxyMode: 'explicit-browser-proxy',
    })).rejects.toThrow(/validation budget/);

    // Popups past the budget must be closed, not left live and unvalidated —
    // that would be the very bug the drain exists to prevent.
    expect(closed.length).toBeGreaterThan(0);
    expect(context.off).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('returns even when an overflow popup never finishes closing', async () => {
    // Bounding validation is not enough: quarantining the overflow serially
    // awaited every close(), so one unresponsive popup would keep the action —
    // and the serialized stop/quit cleanup behind it — pending indefinitely.
    const currentUrl = 'https://start.example/';
    let contextPageListener: ((page: unknown) => void) | undefined;
    let created = 0;
    const spawnPopup = (): Record<string, unknown> => {
      const id = `popup-${created += 1}`;
      let observed = false;
      return {
        url: () => {
          if (!observed) {
            observed = true;
            setTimeout(() => contextPageListener?.(spawnPopup()), 5);
            return 'about:blank';
          }
          return `https://chain.example/${id}`;
        },
        mainFrame: () => ({ url: () => `https://chain.example/${id}` }),
        on: vi.fn(),
        off: vi.fn(),
        // Never settles: the close budget, not the page, must end the wait.
        close: vi.fn(() => new Promise<void>(() => {})),
      };
    };
    const context = {
      on: vi.fn((_e: string, listener: (page: unknown) => void) => { contextPageListener = listener; }),
      off: vi.fn(() => { contextPageListener = undefined; }),
    };
    const page = {
      url: () => currentUrl,
      mainFrame: () => ({ url: () => currentUrl }),
      on: vi.fn(),
      off: vi.fn(),
      context: () => context,
    };
    mocks.getPageForTargetId.mockResolvedValue(page);
    mocks.refLocator.mockReturnValue({
      click: vi.fn(async () => { contextPageListener?.(spawnPopup()); }),
    });

    await expect(executeActViaPlaywright({
      cdpUrl: 'http://127.0.0.1:18800',
      targetId: 'page-1',
      action: { kind: 'click', ref: 'e1' },
      ssrfPolicy: { hostnameAllowlist: ['*.allowed.example'] },
      browserProxyMode: 'explicit-browser-proxy',
    })).rejects.toThrow(/validation budget/);

    expect(context.off).toHaveBeenCalledTimes(1);
    // Returning is not enough: a popup whose close() never completes must still
    // have been quarantined, or it stays live and selectable having never been
    // URL-checked — and in direct mode no lifetime CDP gate would catch it.
    expect(mocks.quarantineTargetWithoutClosing).toHaveBeenCalled();
  }, 20_000);

  it('quarantines popups that arrive during the overflow cleanup window', async () => {
    // The inner cleanup loop never awaits, so on its own it drains the queue as
    // it stands and returns before the event loop can deliver another page
    // event. A popup created while the closes are pending would then be left
    // live, unvalidated and unquarantined once the listener detaches.
    const currentUrl = 'https://start.example/';
    let contextPageListener: ((page: unknown) => void) | undefined;
    let created = 0;
    let lateSpawned = false;
    const quarantined: string[] = [];
    mocks.quarantineTargetWithoutClosing.mockImplementation(async ({ page }: { page: { url(): string } }) => {
      quarantined.push(page.url());
      // Once cleanup begins, deliver one more popup asynchronously — it can
      // only be seen if the drain yields and re-reads the queue.
      if (!lateSpawned) {
        lateSpawned = true;
        setTimeout(() => contextPageListener?.(mkLate()), 0);
      }
    });
    const mkLate = () => ({
      url: () => 'https://late.example/arrived-during-cleanup',
      mainFrame: () => ({ url: () => 'https://late.example/arrived-during-cleanup' }),
      on: vi.fn(),
      off: vi.fn(),
      close: vi.fn(async () => {}),
    });
    const spawnPopup = (): Record<string, unknown> => {
      const id = `popup-${created += 1}`;
      let observed = false;
      return {
        url: () => {
          if (!observed) {
            observed = true;
            setTimeout(() => contextPageListener?.(spawnPopup()), 5);
            return 'about:blank';
          }
          return `https://chain.example/${id}`;
        },
        mainFrame: () => ({ url: () => `https://chain.example/${id}` }),
        on: vi.fn(),
        off: vi.fn(),
        close: vi.fn(async () => {}),
      };
    };
    const context = {
      on: vi.fn((_e: string, listener: (page: unknown) => void) => { contextPageListener = listener; }),
      off: vi.fn(() => { contextPageListener = undefined; }),
    };
    const page = {
      url: () => currentUrl,
      mainFrame: () => ({ url: () => currentUrl }),
      on: vi.fn(),
      off: vi.fn(),
      context: () => context,
    };
    mocks.getPageForTargetId.mockResolvedValue(page);
    mocks.refLocator.mockReturnValue({
      click: vi.fn(async () => { contextPageListener?.(spawnPopup()); }),
    });

    await expect(executeActViaPlaywright({
      cdpUrl: 'http://127.0.0.1:18800',
      targetId: 'page-1',
      action: { kind: 'click', ref: 'e1' },
      ssrfPolicy: { hostnameAllowlist: ['*.allowed.example'] },
      browserProxyMode: 'explicit-browser-proxy',
    })).rejects.toThrow(/validation budget/);

    expect(quarantined).toContain('https://late.example/arrived-during-cleanup');
    expect(context.off).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('closes the whole context when cleanup bounds leave popups unaccounted for', async () => {
    // The count/time bounds end cleanup, then the listener detaches. Anything
    // still queued was never validated and never quarantined — in direct mode
    // nothing else will ever check it. Per-page cleanup has already failed to
    // keep up at that point, so the context itself must fail closed.
    const currentUrl = 'https://start.example/';
    let contextPageListener: ((page: unknown) => void) | undefined;
    let created = 0;
    const mk = (): Record<string, unknown> => {
      const id = `popup-${created += 1}`;
      let observed = false;
      return {
        url: () => {
          if (!observed) {
            observed = true;
            // Append several per turn so the queue outruns any bound.
            for (let i = 0; i < 8; i += 1) {
              setTimeout(() => contextPageListener?.(mk()), 0);
            }
            return 'about:blank';
          }
          return `https://chain.example/${id}`;
        },
        mainFrame: () => ({ url: () => `https://chain.example/${id}` }),
        on: vi.fn(),
        off: vi.fn(),
        close: vi.fn(() => new Promise<void>(() => {})),
      };
    };
    const contextClose = vi.fn(async () => {});
    const context = {
      on: vi.fn((_e: string, listener: (page: unknown) => void) => { contextPageListener = listener; }),
      off: vi.fn(() => { contextPageListener = undefined; }),
      close: contextClose,
    };
    const page = {
      url: () => currentUrl,
      mainFrame: () => ({ url: () => currentUrl }),
      on: vi.fn(),
      off: vi.fn(),
      context: () => context,
    };
    mocks.getPageForTargetId.mockResolvedValue(page);
    mocks.refLocator.mockReturnValue({
      click: vi.fn(async () => { contextPageListener?.(mk()); }),
    });

    await expect(executeActViaPlaywright({
      cdpUrl: 'http://127.0.0.1:18800',
      targetId: 'page-1',
      action: { kind: 'click', ref: 'e1' },
      ssrfPolicy: { hostnameAllowlist: ['*.allowed.example'] },
      browserProxyMode: 'explicit-browser-proxy',
    })).rejects.toThrow(/validation budget/);

    expect(contextClose).toHaveBeenCalled();
  }, 30_000);

  it('tears down the browser when the context itself will not close', async () => {
    // Closing the context is the fail-closed remedy for unaccounted popups. If
    // that call rejects or never settles, swallowing it and detaching the
    // listener leaves the same live, never-validated pages — so an unresponsive
    // context must not be able to preserve the bypass.
    const currentUrl = 'https://start.example/';
    let contextPageListener: ((page: unknown) => void) | undefined;
    let created = 0;
    const mk = (): Record<string, unknown> => {
      const id = `popup-${created += 1}`;
      let observed = false;
      return {
        url: () => {
          if (!observed) {
            observed = true;
            for (let i = 0; i < 8; i += 1) {
              setTimeout(() => contextPageListener?.(mk()), 0);
            }
            return 'about:blank';
          }
          return `https://chain.example/${id}`;
        },
        mainFrame: () => ({ url: () => `https://chain.example/${id}` }),
        on: vi.fn(),
        off: vi.fn(),
        close: vi.fn(() => new Promise<void>(() => {})),
      };
    };
    const browserClose = vi.fn(async () => {});
    const context = {
      on: vi.fn((_e: string, listener: (page: unknown) => void) => { contextPageListener = listener; }),
      off: vi.fn(() => { contextPageListener = undefined; }),
      // Never settles — the deadline, not the context, ends the wait.
      close: vi.fn(() => new Promise<void>(() => {})),
      browser: () => ({ close: browserClose }),
    };
    const page = {
      url: () => currentUrl,
      mainFrame: () => ({ url: () => currentUrl }),
      on: vi.fn(),
      off: vi.fn(),
      context: () => context,
    };
    mocks.getPageForTargetId.mockResolvedValue(page);
    mocks.refLocator.mockReturnValue({
      click: vi.fn(async () => { contextPageListener?.(mk()); }),
    });

    await expect(executeActViaPlaywright({
      cdpUrl: 'http://127.0.0.1:18800',
      targetId: 'page-1',
      action: { kind: 'click', ref: 'e1' },
      ssrfPolicy: { hostnameAllowlist: ['*.allowed.example'] },
      browserProxyMode: 'explicit-browser-proxy',
    })).rejects.toThrow(/validation budget/);

    expect(browserClose).toHaveBeenCalled();
  }, 30_000);

  it('reports an untorn-down browser distinctly so the host can block the route', async () => {
    // The runtime can close pages and contexts but cannot verify a process
    // exited — only the host owns teardown. When even browser.close() fails,
    // saying "policy denied" would hide that unvalidated pages may still be
    // live, so the message has to be distinguishable.
    const currentUrl = 'https://start.example/';
    let contextPageListener: ((page: unknown) => void) | undefined;
    let created = 0;
    const mk = (): Record<string, unknown> => {
      const id = `popup-${created += 1}`;
      let observed = false;
      return {
        url: () => {
          if (!observed) {
            observed = true;
            for (let i = 0; i < 8; i += 1) {
              setTimeout(() => contextPageListener?.(mk()), 0);
            }
            return 'about:blank';
          }
          return `https://chain.example/${id}`;
        },
        mainFrame: () => ({ url: () => `https://chain.example/${id}` }),
        on: vi.fn(),
        off: vi.fn(),
        close: vi.fn(() => new Promise<void>(() => {})),
      };
    };
    const context = {
      on: vi.fn((_e: string, listener: (page: unknown) => void) => { contextPageListener = listener; }),
      off: vi.fn(() => { contextPageListener = undefined; }),
      close: vi.fn(() => new Promise<void>(() => {})),
      // Browser teardown also fails — nothing in-process can contain this.
      browser: () => ({ close: vi.fn(async () => { throw new Error('browser gone rogue'); }) }),
    };
    const page = {
      url: () => currentUrl,
      mainFrame: () => ({ url: () => currentUrl }),
      on: vi.fn(),
      off: vi.fn(),
      context: () => context,
    };
    mocks.getPageForTargetId.mockResolvedValue(page);
    mocks.refLocator.mockReturnValue({
      click: vi.fn(async () => { contextPageListener?.(mk()); }),
    });

    await expect(executeActViaPlaywright({
      cdpUrl: 'http://127.0.0.1:18800',
      targetId: 'page-1',
      action: { kind: 'click', ref: 'e1' },
      ssrfPolicy: { hostnameAllowlist: ['*.allowed.example'] },
      browserProxyMode: 'explicit-browser-proxy',
    })).rejects.toThrow(/could not be torn down/);
  }, 30_000);

  it('tears down when the queue drained but every close is still hanging', async () => {
    // popupIndex only records that a close was ISSUED, and quarantine is pure
    // bookkeeping (quarantineTargetWithoutClosing never closes a page). So a
    // fully-drained queue whose closes all hang looked completely handled,
    // teardown was skipped, and every one of those popups stayed live and
    // scriptable after the listener detached.
    const currentUrl = 'https://start.example/';
    let contextPageListener: ((page: unknown) => void) | undefined;
    // A SMALL, finite burst: the queue drains well within the bounds, so the
    // only thing that can trigger teardown is the unsettled closes.
    const mk = (id: string) => ({
      url: () => `https://chain.example/${id}`,
      mainFrame: () => ({ url: () => `https://chain.example/${id}` }),
      on: vi.fn(),
      off: vi.fn(),
      close: vi.fn(() => new Promise<void>(() => {})),
    });
    const contextClose = vi.fn(async () => {});
    const context = {
      on: vi.fn((_e: string, listener: (page: unknown) => void) => { contextPageListener = listener; }),
      off: vi.fn(() => { contextPageListener = undefined; }),
      close: contextClose,
    };
    const page = {
      url: () => currentUrl,
      mainFrame: () => ({ url: () => currentUrl }),
      on: vi.fn(),
      off: vi.fn(),
      context: () => context,
    };
    mocks.getPageForTargetId.mockResolvedValue(page);
    // Overflow the VALIDATION cap (32) with a finite burst so cleanup runs,
    // then let the queue drain fully while the closes never settle.
    mocks.refLocator.mockReturnValue({
      click: vi.fn(async () => {
        for (let i = 0; i < 40; i += 1) contextPageListener?.(mk(`p${i}`));
      }),
    });

    await expect(executeActViaPlaywright({
      cdpUrl: 'http://127.0.0.1:18800',
      targetId: 'page-1',
      action: { kind: 'click', ref: 'e1' },
      ssrfPolicy: { hostnameAllowlist: ['*.allowed.example'] },
      browserProxyMode: 'explicit-browser-proxy',
    })).rejects.toThrow(/validation budget/);

    expect(contextClose).toHaveBeenCalled();
  }, 40_000);

  it('reports a containment failure ahead of a denied main-frame navigation', async () => {
    // An adversarial page can easily arrange both at once. The navigation
    // denial is the safe outcome — a request was refused. The containment
    // failure says pages we never validated are still live, and it is the only
    // signal the host uses to distrust the route, so it must win.
    // The URL must actually CHANGE for a navigation to be observed at all —
    // otherwise the guard never runs and there is no navigationError to outrank.
    let currentUrl = 'https://start.example/';
    const mainFrame = { url: () => currentUrl };
    let contextPageListener: ((page: unknown) => void) | undefined;
    let created = 0;
    const mk = (): Record<string, unknown> => {
      const id = `popup-${created += 1}`;
      let observed = false;
      return {
        url: () => {
          if (!observed) {
            observed = true;
            for (let i = 0; i < 8; i += 1) setTimeout(() => contextPageListener?.(mk()), 0);
            return 'about:blank';
          }
          return `https://chain.example/${id}`;
        },
        mainFrame: () => ({ url: () => `https://chain.example/${id}` }),
        on: vi.fn(),
        off: vi.fn(),
        close: vi.fn(() => new Promise<void>(() => {})),
      };
    };
    const context = {
      on: vi.fn((_e: string, listener: (page: unknown) => void) => { contextPageListener = listener; }),
      off: vi.fn(() => { contextPageListener = undefined; }),
      close: vi.fn(() => new Promise<void>(() => {})),
      browser: () => ({ close: vi.fn(async () => { throw new Error('browser gone rogue'); }) }),
    };
    const page = {
      url: () => currentUrl,
      mainFrame: () => mainFrame,
      on: vi.fn(),
      off: vi.fn(),
      context: () => context,
    };
    mocks.getPageForTargetId.mockResolvedValue(page);
    mocks.refLocator.mockReturnValue({
      click: vi.fn(async () => {
        currentUrl = 'https://blocked.example/next'; // observable navigation
        contextPageListener?.(mk());
      }),
    });
    // The main-frame navigation is ALSO denied.
    mocks.assertPageNavigationCompletedSafely.mockImplementation(async ({ page: p }: { page: unknown }) => {
      if (p === page) throw new Error('Navigation blocked: main frame');
    });

    await expect(executeActViaPlaywright({
      cdpUrl: 'http://127.0.0.1:18800',
      targetId: 'page-1',
      action: { kind: 'click', ref: 'e1' },
      ssrfPolicy: { hostnameAllowlist: ['*.allowed.example'] },
      browserProxyMode: 'explicit-browser-proxy',
    })).rejects.toThrow(/could not be torn down/);
  }, 30_000);

  it('guards script navigation triggered by a direct input file upload', async () => {
    let currentUrl = 'https://start.example/';
    const mainFrame = { url: () => currentUrl };
    const page = {
      url: () => currentUrl,
      mainFrame: () => mainFrame,
      on: vi.fn(),
      off: vi.fn(),
    };
    const locator = {
      setInputFiles: vi.fn(async () => {
        currentUrl = 'https://allowed.example/after-upload';
      }),
      elementHandle: vi.fn(async () => null),
    };
    mocks.getPageForTargetId.mockResolvedValue(page);
    mocks.refLocator.mockReturnValue(locator);

    await setInputFilesViaPlaywright({
      cdpUrl: 'http://127.0.0.1:18800',
      targetId: 'page-1',
      inputRef: 'e1',
      paths: ['/tmp/upload.txt'],
      ssrfPolicy: { hostnameAllowlist: ['*.allowed.example'] },
      browserProxyMode: 'explicit-browser-proxy',
    });

    expect(locator.setInputFiles).toHaveBeenCalledWith(['/tmp/upload.txt']);
    expect(mocks.assertPageNavigationCompletedSafely).toHaveBeenCalledWith(
      expect.objectContaining({
        page,
        ssrfPolicy: { hostnameAllowlist: ['*.allowed.example'] },
        browserProxyMode: 'explicit-browser-proxy',
      }),
    );
  });
});
