import { describe, expect, it, vi } from 'vitest';

import type {
  BrowserControlRequest,
  BrowserControlResult,
  BrowserProxyRoute,
} from '@cindy/browser-control-runtime';

import { ExternalChromeBackend } from '../external-chrome-backend.js';

function fakeLogger() {
  return { warn: vi.fn() };
}

function fakeRuntime(initialRunning = false) {
  let running = initialRunning;
  const call = vi.fn(async (req: BrowserControlRequest): Promise<BrowserControlResult> => {
    if (req.action === 'status') {
      return { ok: true, action: req.action, status: 200, data: { running } };
    }
    if (req.action === 'start') {
      running = true;
      return { ok: true, action: req.action, status: 200, data: { ok: true } };
    }
    if (req.action === 'stop') {
      const stopped = running;
      running = false;
      return { ok: true, action: req.action, status: 200, data: { stopped } };
    }
    return { ok: true, action: req.action, status: 200, data: { request: req } };
  });
  return { call };
}

function createHarness(initialRunning = false) {
  const initial = fakeRuntime(initialRunning);
  const created: Array<{ route: BrowserProxyRoute; runtime: ReturnType<typeof fakeRuntime> }> = [];
  const auth = { start: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
  let failProxyAuth = () => {};
  const closeAdoptedBrowser = vi.fn(async () => true);
  // Default: the browser is gone when the runtime says it stopped. Tests that
  // exercise the busy-but-alive case override this.
  const isBrowserGone = vi.fn(async () => true);
  const backend = new ExternalChromeBackend(initial, fakeLogger(), {
    createRuntime: (route) => {
      const runtime = fakeRuntime();
      created.push({ route, runtime });
      return runtime;
    },
    createProxyAuth: (_route, _logger, onFailure) => {
      failProxyAuth = onFailure;
      return auth;
    },
    closeAdoptedBrowser,
    isBrowserGone,
    managedUserDataDir: '/managed/browser/Cindy/user-data',
  });
  return {
    backend,
    initial,
    created,
    auth,
    closeAdoptedBrowser,
    isBrowserGone,
    failProxyAuth: () => failProxyAuth(),
  };
}

describe('ExternalChromeBackend proxy lifecycle', () => {
  it('reports kind = external', () => {
    expect(createHarness().backend.kind).toBe('external');
  });

  it('passes ordinary requests through and rejects misplaced proxyServer', async () => {
    const { backend, initial } = createHarness();
    const req: BrowserControlRequest = {
      action: 'act',
      targetId: 'tab-1',
      request: { kind: 'click', ref: 'ref-7' },
    };
    await backend.call(req);
    expect(initial.call).toHaveBeenCalledWith(req);

    // Keep credentials in THIS fixture: the point is that a rejected request
    // never echoes the caller's secret back, whatever the rejection reason.
    const invalid = await backend.call({
      action: 'status',
      proxyServer: 'http://user:secret@proxy.test:8080',
    });
    expect(invalid).toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_INVALID_REQUEST',
    });
    expect(JSON.stringify(invalid)).not.toContain('secret');
  });

  it('starts direct explicitly and safely restarts an unknown inherited process', async () => {
    const { backend, initial, created, closeAdoptedBrowser } = createHarness(true);
    const status = await backend.call({ action: 'status' });
    expect(status.data).toMatchObject({ proxy: { mode: 'unknown' } });

    const started = await backend.call({ action: 'start' });
    expect(initial.call.mock.calls.map(([req]) => req.action)).toEqual(['status', 'status']);
    expect(closeAdoptedBrowser).toHaveBeenCalledWith(
      'http://127.0.0.1:18800',
      '/managed/browser/Cindy/user-data',
    );
    expect(created).toHaveLength(1);
    expect(created[0].route).toEqual({ mode: 'direct' });
    expect(started.data).toMatchObject({ proxy: { mode: 'direct' } });
  });

  it('closes an inherited process when status cannot establish whether it is running', async () => {
    const initial = {
      call: vi.fn(async (req: BrowserControlRequest): Promise<BrowserControlResult> => ({
        ok: false,
        action: req.action,
        errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
      })),
    };
    const closeAdoptedBrowser = vi.fn(async () => true);
    const backend = new ExternalChromeBackend(initial, fakeLogger(), {
      createRuntime: () => fakeRuntime(),
      closeAdoptedBrowser,
      isBrowserGone: vi.fn(async () => true),
      managedUserDataDir: '/managed/browser/Cindy/user-data',
    });

    const started = await backend.call({ action: 'start' });

    expect(started.ok).toBe(true);
    expect(closeAdoptedBrowser).toHaveBeenCalled();
  });

  it('keeps repeated same-proxy starts idempotent', async () => {
    const { backend, created } = createHarness();
    await backend.call({ action: 'start', proxyServer: 'http://proxy-a.test:8080' });
    await backend.call({ action: 'start', proxyServer: 'http://proxy-a.test:8080' });
    expect(created).toHaveLength(1);
    expect(created[0].runtime.call.mock.calls.map(([req]) => req.action)).toEqual(['start', 'status']);
  });

  it('keeps an active proxy route while status and focus raise the existing browser', async () => {
    const { backend, created } = createHarness();
    await backend.call({ action: 'start', proxyServer: 'http://proxy-a.test:8080' });

    await backend.call({ action: 'status' });
    await backend.call({ action: 'tabs' });
    await backend.call({ action: 'focus', targetId: 'page-1' });

    expect(created).toHaveLength(1);
    expect(backend.getEffectiveProxy()).toEqual({
      mode: 'proxied',
      server: 'http://proxy-a.test:8080',
    });
    expect(created[0].runtime.call.mock.calls.map(([req]) => req.action)).toEqual([
      'start',
      'status',
      'tabs',
      'focus',
    ]);
  });

  it('restarts on direct → proxy A → proxy B → direct transitions', async () => {
    const { backend, created } = createHarness();
    await backend.call({ action: 'start' });
    await backend.call({ action: 'start', proxyServer: 'http://proxy-a.test:8080' });
    await backend.call({ action: 'start', proxyServer: 'https://proxy-b.test:8443' });
    const direct = await backend.call({ action: 'start' });

    expect(created.map(({ route }) => route)).toEqual([
      { mode: 'direct' },
      { mode: 'proxied', server: 'http://proxy-a.test:8080' },
      { mode: 'proxied', server: 'https://proxy-b.test:8443' },
      { mode: 'direct' },
    ]);
    expect(created.slice(0, -1).every(({ runtime }) =>
      runtime.call.mock.calls.some(([req]) => req.action === 'stop'))).toBe(true);
    expect(direct.data).toMatchObject({ proxy: { mode: 'direct' } });
  });

  it('replaces a stopped proxy runtime with direct config before an implicit launch', async () => {
    const { backend, created } = createHarness();
    await backend.call({ action: 'start', proxyServer: 'http://proxy-a.test:8080' });

    await backend.call({ action: 'stop' });
    await backend.call({ action: 'tabs' });

    expect(created.map(({ route }) => route)).toEqual([
      { mode: 'proxied', server: 'http://proxy-a.test:8080' },
      { mode: 'direct' },
    ]);
    expect(created[0].runtime.call.mock.calls.map(([request]) => request.action)).toEqual(['start', 'stop', 'status']);
    expect(created[1].runtime.call).toHaveBeenCalledWith({ action: 'tabs' });
  });

  it('rejects an authenticated proxy URL without launching anything', async () => {
    // Authenticated proxies are unsupported: the only credential channel that
    // works over connectOverCDP also leaks to untrusted origins. The rejection
    // must happen before any browser is created.
    const { backend, created, auth } = createHarness();
    const result = await backend.call({
      action: 'start',
      proxyServer: 'http://u%2Fser:p%40ss%3Aword@proxy.test:8080',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_INVALID_REQUEST',
    });
    expect(result.message).toMatch(/authenticated proxies are not supported/);
    expect(created).toHaveLength(0);
    expect(auth.start).not.toHaveBeenCalled();
    // The rejection text must not echo the caller's credentials back.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('u%2Fser');
    expect(serialized).not.toContain('p%40ss');
  });

  it('reports unknown status without forgetting a known proxy route or its auth channel', async () => {
    const { backend, created, auth } = createHarness();
    await backend.call({
      action: 'start',
      proxyServer: 'http://proxy.test:8080',
    });
    created[0].runtime.call.mockImplementationOnce(async () => ({
      ok: false,
      action: 'status',
      errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
    }));

    const status = await backend.call({ action: 'status' });

    // An unreadable status does not prove the process exited, so the known
    // route is retained AND reported — reporting `unknown` here would invite a
    // caller to treat a live proxied browser as route-less.
    expect(status.data).toEqual({
      proxy: { mode: 'proxied', server: 'http://proxy.test:8080' },
    });
    expect(backend.getEffectiveProxy()).toEqual({
      mode: 'proxied',
      server: 'http://proxy.test:8080',
    });
    expect(auth.dispose).not.toHaveBeenCalled();
  });

  it('blocks a route after a later proxy-auth target failure', async () => {
    const { backend, failProxyAuth } = createHarness();
    await backend.call({
      action: 'start',
      proxyServer: 'http://proxy.test:8080',
    });

    failProxyAuth();
    const status = await backend.call({ action: 'status' });
    const tabs = await backend.call({ action: 'tabs' });
    const restart = await backend.call({ action: 'start' });

    expect(status.data).toEqual({ running: true, proxy: { mode: 'unknown' } });
    expect(tabs).toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
    });
    expect(restart).toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
    });
  });

  it('fails closed and stops the new browser when auth setup fails', async () => {
    const initial = fakeRuntime();
    const runtime = fakeRuntime();
    const backend = new ExternalChromeBackend(initial, fakeLogger(), {
      createRuntime: () => runtime,
      createProxyAuth: () => ({
        start: async () => { throw new Error('auth setup failed'); },
        dispose: async () => {},
      }),
      isBrowserGone: vi.fn(async () => true),
    });
    const result = await backend.call({
      action: 'start',
      proxyServer: 'http://proxy.test:8080',
    });
    expect(result.ok).toBe(false);
    expect(runtime.call.mock.calls.map(([req]) => req.action)).toEqual(['start', 'stop', 'status']);
    expect(backend.getEffectiveProxy()).toEqual({ mode: 'unknown' });
  });

  it('fails start when proxy auth reports a target failure during setup', async () => {
    const runtime = fakeRuntime();
    const auth = { dispose: vi.fn(async () => {}) };
    const backend = new ExternalChromeBackend(fakeRuntime(), fakeLogger(), {
      createRuntime: () => runtime,
      createProxyAuth: (_route, _logger, onFailure) => ({
        start: async () => { onFailure(); },
        dispose: auth.dispose,
      }),
      isBrowserGone: vi.fn(async () => true),
    });

    const result = await backend.call({
      action: 'start',
      proxyServer: 'http://proxy.test:8080',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_ACTION_FAILED',
    });
    expect(runtime.call.mock.calls.map(([request]) => request.action)).toEqual(['start', 'stop', 'status']);
    expect(auth.dispose).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('keeps a direct start idempotent after an implicit launch by open/tabs', async () => {
    // `open` launches the browser implicitly, as the real runtime does.
    let running = false;
    const initial = {
      call: vi.fn(async (req: BrowserControlRequest): Promise<BrowserControlResult> => {
        if (req.action === 'status') {
          return { ok: true, action: req.action, status: 200, data: { running } };
        }
        if (req.action === 'start') {
          running = true;
          return { ok: true, action: req.action, status: 200, data: { ok: true } };
        }
        if (req.action === 'stop') {
          const stopped = running;
          running = false;
          return { ok: true, action: req.action, status: 200, data: { stopped } };
        }
        // Like the real /tabs/open route: launches implicitly and returns a
        // tab object with NO `running` field, so the backend cannot infer
        // liveness from this response and must query `status`.
        running = true;
        return {
          ok: true,
          action: req.action,
          status: 200,
          data: { targetId: 'tab-1', url: 'about:blank' },
        };
      }),
    };
    const created: BrowserProxyRoute[] = [];
    const closeAdoptedBrowser = vi.fn(async () => true);
    const backend = new ExternalChromeBackend(initial, fakeLogger(), {
      createRuntime: (route) => {
        created.push(route);
        return fakeRuntime();
      },
      closeAdoptedBrowser,
      isBrowserGone: vi.fn(async () => true),
      managedUserDataDir: '/managed/browser/Cindy/user-data',
    });

    // Cold start: no explicit `start` and no prior verified stop — `open`
    // launches implicitly and must still be attributed to this runtime.
    const implicit = await backend.call({ action: 'open' });
    expect(implicit.ok).toBe(true);

    // A same-route direct start must be idempotent: it must NOT adopt-and-close
    // our own browser, which would destroy the user's tabs.
    const restart = await backend.call({ action: 'start' });

    expect(restart.ok).toBe(true);
    expect(closeAdoptedBrowser).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
    expect(initial.call.mock.calls.map(([req]) => req.action)).not.toContain('start');
  });

  it('keeps a direct start idempotent after a verified stop then implicit launch', async () => {
    let running = false;
    const initial = {
      call: vi.fn(async (req: BrowserControlRequest): Promise<BrowserControlResult> => {
        if (req.action === 'status') {
          return { ok: true, action: req.action, status: 200, data: { running } };
        }
        if (req.action === 'stop') {
          const stopped = running;
          running = false;
          return { ok: true, action: req.action, status: 200, data: { stopped } };
        }
        running = true;
        return {
          ok: true,
          action: req.action,
          status: 200,
          data: { targetId: 'tab-1', url: 'about:blank' },
        };
      }),
    };
    const closeAdoptedBrowser = vi.fn(async () => true);
    const backend = new ExternalChromeBackend(initial, fakeLogger(), {
      createRuntime: () => fakeRuntime(),
      closeAdoptedBrowser,
      isBrowserGone: vi.fn(async () => true),
      managedUserDataDir: '/managed/browser/Cindy/user-data',
    });

    await backend.call({ action: 'start' });
    await backend.call({ action: 'stop' });
    await backend.call({ action: 'open' });

    await expect(backend.call({ action: 'start' })).resolves.toMatchObject({ ok: true });
    expect(closeAdoptedBrowser).not.toHaveBeenCalled();
  });

  it('attributes an implicit launch even when the action itself fails', async () => {
    // Like snapshot: resolves (and thereby launches) a tab, then rejects an
    // invalid argument combination.
    let running = false;
    const initial = {
      call: vi.fn(async (req: BrowserControlRequest): Promise<BrowserControlResult> => {
        if (req.action === 'status') {
          return { ok: true, action: req.action, status: 200, data: { running } };
        }
        if (req.action === 'stop') {
          running = false;
          return { ok: true, action: req.action, status: 200, data: { stopped: true } };
        }
        running = true;
        return {
          ok: false,
          action: req.action,
          status: 400,
          errorCode: 'BROWSER_RUNTIME_INVALID_REQUEST',
          message: 'labels/mode=efficient require format=ai',
        };
      }),
    };
    const created: BrowserProxyRoute[] = [];
    const closeAdoptedBrowser = vi.fn(async () => true);
    const backend = new ExternalChromeBackend(initial, fakeLogger(), {
      createRuntime: (route) => {
        created.push(route);
        return fakeRuntime();
      },
      closeAdoptedBrowser,
      isBrowserGone: vi.fn(async () => true),
      managedUserDataDir: '/managed/browser/Cindy/user-data',
    });

    await expect(backend.call({ action: 'snapshot' })).resolves.toMatchObject({ ok: false });

    // The failed action still launched our browser, so a same-route start must
    // stay idempotent rather than closing and relaunching it.
    await expect(backend.call({ action: 'start' })).resolves.toMatchObject({ ok: true });
    expect(closeAdoptedBrowser).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it('does not drop a proxied route when status reports a merely-unreachable browser', async () => {
    // The vendored status sets running:cdpReady, so a busy-but-alive Chrome
    // reports running:false. Treating that as stopped would dispose the proxy
    // coordinator and swap in a direct runtime under a live proxied browser.
    let reachable = true;
    const proxied = {
      call: vi.fn(async (req: BrowserControlRequest): Promise<BrowserControlResult> => {
        if (req.action === 'status') {
          return { ok: true, action: req.action, status: 200, data: { running: reachable } };
        }
        return { ok: true, action: req.action, status: 200, data: { ok: true } };
      }),
    };
    const auth = { start: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    const created: BrowserProxyRoute[] = [];
    // Tracks the real process, unlike the runtime's readiness-based `running`.
    // Before the launch there is nothing; afterwards the process stays alive
    // even while it is too busy to answer the readiness probe.
    let processAlive = false;
    const isBrowserGone = vi.fn(async () => !processAlive);
    // A passive poll must never reach the destructive ownership check.
    const closeAdoptedBrowser = vi.fn(async () => false);
    const backend = new ExternalChromeBackend(fakeRuntime(), fakeLogger(), {
      createRuntime: (route) => {
        created.push(route);
        return proxied;
      },
      createProxyAuth: () => auth,
      isBrowserGone,
      closeAdoptedBrowser,
      managedUserDataDir: '/managed/browser/Cindy/user-data',
    });

    await backend.call({
      action: 'start',
      proxyServer: 'http://proxy.test:8080',
      proxyAllowedHostnames: ['allowed.example'],
    });
    expect(created.map((route) => route.mode)).toEqual(['proxied']);
    processAlive = true;

    // The proxied Chrome is alive but too busy to answer the readiness probe,
    // so the vendored status reports running:false.
    reachable = false;
    const status = await backend.call({ action: 'status' });

    // The proxied route is retained and the coordinator kept; traffic is
    // refused rather than silently switched to direct egress.
    expect(status.data).toMatchObject({ proxy: { mode: 'proxied' } });
    expect(auth.dispose).not.toHaveBeenCalled();
    expect(created.map((route) => route.mode)).toEqual(['proxied']);
    // The decisive property: a status poll checks liveness without ever
    // issuing the Browser.close that ownership verification uses, so polling
    // can never terminate the user's browser and discard their tabs.
    expect(isBrowserGone).toHaveBeenCalled();
    expect(closeAdoptedBrowser).not.toHaveBeenCalled();
    await expect(backend.call({ action: 'tabs' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
    });
  });

  it('clears a transient readiness block once the browser answers again', async () => {
    // A busy Chrome misses the readiness probe, then recovers. The block that
    // guarded the route while liveness was unproven must lift — otherwise every
    // action but status/stop stays unavailable forever.
    let reachable = true;
    let launched = false;
    const runtime = {
      call: vi.fn(async (req: BrowserControlRequest): Promise<BrowserControlResult> => {
        if (req.action === 'status') {
          return { ok: true, action: req.action, status: 200, data: { running: reachable } };
        }
        if (req.action === 'start') launched = true;
        return { ok: true, action: req.action, status: 200, data: { ok: true } };
      }),
    };
    const backend = new ExternalChromeBackend(fakeRuntime(), fakeLogger(), {
      createRuntime: () => runtime,
      createProxyAuth: () => ({ start: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }),
      // The initial (pre-start) browser is genuinely absent, so `start` can
      // proceed; only AFTER the proxied launch does the probe report the
      // process as alive-but-unreadable.
      isBrowserGone: vi.fn(async () => !launched),
      closeAdoptedBrowser: vi.fn(async () => false),
      managedUserDataDir: '/managed/browser/Cindy/user-data',
    });
    await backend.call({
      action: 'start',
      proxyServer: 'http://proxy.test:8080',
      proxyAllowedHostnames: ['allowed.example'],
    });

    reachable = false;
    await backend.call({ action: 'status' });
    await expect(backend.call({ action: 'tabs' })).resolves.toMatchObject({ ok: false });

    reachable = true;
    await backend.call({ action: 'status' });

    await expect(backend.call({ action: 'tabs' })).resolves.toMatchObject({ ok: true });
    expect(backend.getEffectiveProxy()).toEqual({
      mode: 'proxied',
      server: 'http://proxy.test:8080',
    });
  });

  it('keeps an auth-failure block even after the browser answers again', async () => {
    // Distinct from the transient case: an auth failure means the route itself
    // is untrusted, so recovery of the readiness probe must NOT lift it.
    const { backend, failProxyAuth } = createHarness();
    await backend.call({ action: 'start', proxyServer: 'http://proxy.test:8080' });

    failProxyAuth();
    await backend.call({ action: 'status' }); // browser answers: running
    await expect(backend.call({ action: 'tabs' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
    });
  });

  it('keeps an auth-failure block across an unproven status poll', async () => {
    // The dangerous ordering, which "answers again" alone does not cover: a
    // hard block, then a poll that finds the process alive but unreadable,
    // then a poll that finds it running. If the middle poll marked the block
    // transient, the last one would clear it and re-admit ordinary traffic on
    // a browser whose CDP request gate died with the auth coordinator. The
    // availability card polls status on its own, so this needs no user action.
    let reachable = true;
    const { backend, created, failProxyAuth, isBrowserGone } = createHarness();
    await backend.call({ action: 'start', proxyServer: 'http://proxy.test:8080' });
    // After the launch the process is alive, so a missed readiness probe reads
    // as `unproven` rather than `gone`.
    isBrowserGone.mockImplementation(async () => false);
    const runtimeCall = created[created.length - 1]?.runtime.call;
    if (!runtimeCall) throw new Error('proxied runtime was not created');
    runtimeCall.mockImplementation(async (req: BrowserControlRequest) => ({
      ok: true,
      action: req.action,
      status: 200,
      data: req.action === 'status' ? { running: reachable } : { ok: true },
    }));

    failProxyAuth();
    reachable = false;
    await backend.call({ action: 'status' }); // unproven
    reachable = true;
    await backend.call({ action: 'status' }); // running again

    await expect(backend.call({ action: 'tabs' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
    });
  });

  it('recovers an adopted managed browser on stop instead of blocking forever', async () => {
    // An adopted process: vendored stop reports ok but never actually stops it,
    // because its ownership state is in-memory and empty after a Cindy restart.
    const runtime = {
      call: vi.fn(async (req: BrowserControlRequest): Promise<BrowserControlResult> => {
        if (req.action === 'stop') {
          return { ok: true, action: req.action, status: 200, data: { stopped: false } };
        }
        return { ok: true, action: req.action, status: 200, data: { running: true } };
      }),
    };
    const closeAdoptedBrowser = vi.fn(async () => true);
    const backend = new ExternalChromeBackend(runtime, fakeLogger(), {
      createRuntime: () => fakeRuntime(),
      closeAdoptedBrowser,
      isBrowserGone: vi.fn(async () => true),
      managedUserDataDir: '/managed/browser/Cindy/user-data',
    });

    const stopped = await backend.call({ action: 'stop' });

    expect(stopped.ok).toBe(true);
    // The vendored result said stopped:false; the adopted cleanup is what
    // proved the exit, so the caller must be told what was actually verified
    // rather than being left to retry a completed stop.
    expect(stopped.data).toMatchObject({ stopped: true });
    expect(closeAdoptedBrowser).toHaveBeenCalledTimes(1);
    // The backend must be usable again, not stuck blocked until the user
    // closes Chrome by hand.
    await expect(backend.call({ action: 'tabs' })).resolves.toMatchObject({ ok: true });
  });

  it('stays blocked when an adopted browser cannot be verified closed', async () => {
    const runtime = {
      call: vi.fn(async (req: BrowserControlRequest): Promise<BrowserControlResult> => {
        if (req.action === 'stop') {
          return { ok: true, action: req.action, status: 200, data: { stopped: false } };
        }
        return { ok: true, action: req.action, status: 200, data: { running: true } };
      }),
    };
    const backend = new ExternalChromeBackend(runtime, fakeLogger(), {
      createRuntime: () => fakeRuntime(),
      closeAdoptedBrowser: vi.fn(async () => false),
      managedUserDataDir: '/managed/browser/Cindy/user-data',
      isBrowserGone: vi.fn(async () => true),
    });

    await expect(backend.call({ action: 'stop' })).resolves.toMatchObject({ ok: false });
    await expect(backend.call({ action: 'tabs' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
    });
  });

  it('installs the lifetime guard for credential-free proxied launches too', async () => {
    const auth = { start: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    const routes: BrowserProxyRoute[] = [];
    const backend = new ExternalChromeBackend(fakeRuntime(), fakeLogger(), {
      createRuntime: () => fakeRuntime(),
      createProxyAuth: (route) => {
        routes.push(route);
        return auth;
      },
      isBrowserGone: vi.fn(async () => true),
    });

    await backend.call({
      action: 'start',
      proxyServer: 'http://proxy.test:8080',
      proxyAllowedHostnames: ['allowed.example'],
    });

    expect(auth.start).toHaveBeenCalledTimes(1);
    expect(routes[0]).toMatchObject({
      mode: 'proxied',
      allowedHostnames: ['allowed.example'],
    });
    expect(routes[0]?.username).toBeUndefined();

    // Direct launches must not install the guard.
    await backend.call({ action: 'start' });
    expect(auth.start).toHaveBeenCalledTimes(1);
  });

  it('does not report a stop as done when readiness lies about an inherited process', async () => {
    // The reviewer's exact scenario: vendored stop returns stopped:false for an
    // inherited process, and the readiness probe then says running:false only
    // because the browser is busy. Treating that as a clean stop would release
    // the proxy guard and reset to direct while the old process keeps serving
    // the old route.
    const runtime = {
      call: vi.fn(async (req: BrowserControlRequest): Promise<BrowserControlResult> => {
        if (req.action === 'stop') {
          return { ok: true, action: req.action, status: 200, data: { stopped: false } };
        }
        // Busy browser: readiness reports NOT running though it is alive.
        return { ok: true, action: req.action, status: 200, data: { running: false } };
      }),
    };
    const auth = { start: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    const created: BrowserProxyRoute[] = [];
    let launched = false;
    const backend = new ExternalChromeBackend(fakeRuntime(), fakeLogger(), {
      createRuntime: (route) => { created.push(route); launched = true; return runtime; },
      createProxyAuth: () => auth,
      isBrowserGone: vi.fn(async () => !launched), // alive after launch
      closeAdoptedBrowser: vi.fn(async () => false),
      managedUserDataDir: '/managed/browser/Cindy/user-data',
    });
    await backend.call({
      action: 'start',
      proxyServer: 'http://proxy.test:8080',
      proxyAllowedHostnames: ['allowed.example'],
    });

    const stopped = await backend.call({ action: 'stop' });

    expect(stopped).toMatchObject({ ok: false, errorCode: 'BROWSER_RUNTIME_ACTION_FAILED' });
    expect(stopped.data).not.toMatchObject({ stopped: true });
    // The proxy guard must NOT be released and no direct runtime substituted
    // while the proxied process may still be alive.
    expect(auth.dispose).not.toHaveBeenCalled();
    expect(created.map((r) => r.mode)).toEqual(['proxied']);
  });

  it('does not restart a same-route browser that is merely busy', async () => {
    // `running` is READINESS. A busy-but-alive browser reports false, and
    // treating that as "not running" takes an unchanged route through
    // stopCurrentRuntime() and a relaunch — destroying the user's open tabs to
    // apply a route that is already in effect.
    let busy = false;
    const runtime = {
      call: vi.fn(async (req: BrowserControlRequest): Promise<BrowserControlResult> => {
        if (req.action === 'status') {
          return { ok: true, action: req.action, status: 200, data: { running: !busy } };
        }
        return { ok: true, action: req.action, status: 200, data: { ok: true } };
      }),
    };
    const created: BrowserProxyRoute[] = [];
    const backend = new ExternalChromeBackend(fakeRuntime(), fakeLogger(), {
      createRuntime: (route) => { created.push(route); return runtime; },
      createProxyAuth: () => ({ start: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }),
      // Gone before the first start (so it launches), alive after.
      isBrowserGone: vi.fn(async () => created.length === 0),
      closeAdoptedBrowser: vi.fn(async () => true),
      managedUserDataDir: '/managed/browser/Cindy/user-data',
    });
    const start = {
      action: 'start' as const,
      proxyServer: 'http://proxy.test:8080',
      proxyAllowedHostnames: ['allowed.example'],
    };
    await backend.call(start);
    expect(created).toHaveLength(1);

    // Now the browser is alive but too busy to answer the readiness probe.
    busy = true;
    const again = await backend.call(start);

    expect(again.ok).toBe(true);
    // No relaunch: the user's tabs survive.
    expect(created).toHaveLength(1);
    expect(runtime.call.mock.calls.some(([req]) => req.action === 'stop')).toBe(false);
  });

  it('signals an inherited browser as proxy.mode unknown so callers can recover it', async () => {
    // Contract openBrowserForLogin depends on: after a Cindy restart that
    // inherited a running Chrome, `status` reports mode 'unknown' AND ordinary
    // actions are refused. A caller that skips `start` on `running: true` would
    // therefore return success while the window never comes forward, so the
    // 'unknown' mode is what tells it an explicit start is still required.
    const runtime = {
      call: vi.fn(async (req: BrowserControlRequest): Promise<BrowserControlResult> => ({
        ok: true,
        action: req.action,
        status: 200,
        data: req.action === 'status' ? { running: true } : { ok: true },
      })),
    };
    const backend = new ExternalChromeBackend(runtime, fakeLogger(), {
      createRuntime: () => runtime,
      isBrowserGone: vi.fn(async () => false), // alive, route unknown
      closeAdoptedBrowser: vi.fn(async () => true),
      managedUserDataDir: '/managed/browser/Cindy/user-data',
    });

    const status = await backend.call({ action: 'status' });

    expect((status.data as { proxy?: { mode?: string } }).proxy?.mode).toBe('unknown');
    expect(await backend.call({ action: 'tabs' })).toMatchObject({ ok: false });
  });

  it('refuses ordinary actions while a live browser has an unknown route', async () => {
    // Cindy restarted and inherited a Chrome from a previous proxied start:
    // route is unknown, the process is alive. Running the action anyway would
    // attach to it, egress through the OLD proxy while this backend reports
    // direct, and the previous instance's request gate is gone. Only
    // status/start/stop may proceed.
    const initial = {
      call: vi.fn(async (req: BrowserControlRequest): Promise<BrowserControlResult> => ({
        ok: true,
        action: req.action,
        status: 200,
        data: req.action === 'status' ? { running: true } : { ok: true },
      })),
    };
    const backend = new ExternalChromeBackend(initial, fakeLogger(), {
      createRuntime: () => fakeRuntime(),
      isBrowserGone: vi.fn(async () => false), // alive
      closeAdoptedBrowser: vi.fn(async () => true),
      managedUserDataDir: '/managed/browser/Cindy/user-data',
    });

    const navigated = await backend.call({ action: 'open', url: 'https://example.test/' } as BrowserControlRequest);

    expect(navigated).toMatchObject({ ok: false, errorCode: 'BROWSER_RUNTIME_UNAVAILABLE' });
    // The action must never have been forwarded to the inherited process.
    expect(initial.call.mock.calls.map(([req]) => req.action)).not.toContain('open');
    // status stays available so the caller can see the state and recover.
    expect((await backend.call({ action: 'status' })).ok).toBe(true);
  });

  it('disposes a browser launched by an action that then failed', async () => {
    // An action can start Chrome and then fail without a numeric status, which
    // is what `used` is normally set from. If the follow-up probe establishes a
    // running browser, that IS proof we own one — otherwise dispose() takes its
    // `if (!this.used) return` path and leaves a headed Chrome after quit.
    let running = false;
    const runtime = {
      call: vi.fn(async (req: BrowserControlRequest): Promise<BrowserControlResult> => {
        if (req.action === 'status') {
          return { ok: true, action: req.action, status: 200, data: { running } };
        }
        if (req.action === 'stop') {
          running = false;
          return { ok: true, action: req.action, status: 200, data: { stopped: true } };
        }
        // Launches Chrome, then fails — and returns NO numeric status.
        running = true;
        return { ok: false, action: req.action, errorCode: 'BROWSER_RUNTIME_ACTION_FAILED' };
      }),
    };
    const backend = new ExternalChromeBackend(runtime, fakeLogger(), {
      createRuntime: () => runtime,
      isBrowserGone: vi.fn(async () => !running),
      closeAdoptedBrowser: vi.fn(async () => true),
      managedUserDataDir: '/managed/browser/Cindy/user-data',
    });

    await backend.call({ action: 'open', url: 'https://example.test/' } as BrowserControlRequest);
    await backend.dispose();

    expect(runtime.call.mock.calls.some(([req]) => req.action === 'stop')).toBe(true);
  });

  it('refuses a same-route start while the route is blocked, and recovers via stop', async () => {
    // A block from a failed auth channel is not cleared by the browser
    // answering again: the request gate is gone. `start` is refused outright
    // (its message tells the user to stop first), so the shortcut below never
    // hands back success for a route whose gate no longer exists.
    const { backend, failProxyAuth, created } = createHarness();
    await backend.call({
      action: 'start',
      proxyServer: 'http://proxy.test:8080',
      proxyAllowedHostnames: ['allowed.example'],
    });
    failProxyAuth();

    const blocked = await backend.call({
      action: 'start',
      proxyServer: 'http://proxy.test:8080',
      proxyAllowedHostnames: ['allowed.example'],
    });
    expect(blocked).toMatchObject({ ok: false, errorCode: 'BROWSER_RUNTIME_UNAVAILABLE' });
    expect(created).toHaveLength(1); // no silent reuse of the blocked route

    // The documented recovery works and restores ordinary traffic.
    expect((await backend.call({ action: 'stop' })).ok).toBe(true);
    const restarted = await backend.call({
      action: 'start',
      proxyServer: 'http://proxy.test:8080',
      proxyAllowedHostnames: ['allowed.example'],
    });
    expect(restarted.ok).toBe(true);
    expect((await backend.call({ action: 'tabs' })).ok).toBe(true);
  });

  it('tears the browser down when the runtime reports containment failed', async () => {
    // The runtime validates and quarantines pages but cannot end a process.
    // When it reports that containment failed and unvalidated pages may still
    // be live, blocking future calls is not enough — those pages are already
    // loaded and keep reaching the network. The host owns teardown, so it must
    // actually stop the browser.
    const { backend, created, auth } = createHarness();
    await backend.call({
      action: 'start',
      proxyServer: 'http://proxy.test:8080',
      proxyAllowedHostnames: ['allowed.example'],
    });
    const runtime = created[0].runtime;
    runtime.call.mockResolvedValueOnce({
      ok: false,
      action: 'act',
      errorCode: 'BROWSER_RUNTIME_ACTION_FAILED',
      message: 'Navigation blocked: popup chain exceeded the validation budget and the browser '
        + 'could not be torn down; unvalidated pages may still be live',
    });

    await backend.call({
      action: 'act',
      targetId: 't',
      request: { kind: 'click', ref: 'e1' },
    } as BrowserControlRequest);

    // The surviving pages are gone because the process is.
    expect(runtime.call.mock.calls.some(([req]) => req.action === 'stop')).toBe(true);
    // The proxy guard is released only because the browser it guarded is gone.
    expect(auth.dispose).toHaveBeenCalled();
    expect(backend.getEffectiveProxy()).toEqual({ mode: 'unknown' });
  });

  it('keeps the route blocked when that teardown cannot be verified', async () => {
    // If the stop cannot be verified, the pages may still be live — so the
    // route must stay unusable rather than quietly recovering.
    const { backend, created, isBrowserGone } = createHarness();
    await backend.call({
      action: 'start',
      proxyServer: 'http://proxy.test:8080',
      proxyAllowedHostnames: ['allowed.example'],
    });
    const runtime = created[0].runtime;
    isBrowserGone.mockResolvedValue(false); // never verifiably gone
    runtime.call.mockResolvedValueOnce({
      ok: false,
      action: 'act',
      errorCode: 'BROWSER_RUNTIME_ACTION_FAILED',
      message: 'Navigation blocked: popup chain exceeded the validation budget and the browser '
        + 'could not be torn down; unvalidated pages may still be live',
    });
    runtime.call.mockResolvedValueOnce({
      ok: true, action: 'stop', status: 200, data: { stopped: false },
    });

    await backend.call({
      action: 'act',
      targetId: 't',
      request: { kind: 'click', ref: 'e1' },
    } as BrowserControlRequest);

    expect(await backend.call({ action: 'tabs' })).toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
    });
    // A status poll finding it alive must not clear this: containment failed
    // regardless of whether the process is healthy.
    await backend.call({ action: 'status' });
    expect(await backend.call({ action: 'tabs' })).toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
    });
  });

  it('does not trust a successful vendored stop as proof the process exited', async () => {
    // stopOpenClawChrome breaks its wait as soon as proc.killed is set (SIGTERM
    // does that synchronously), SIGKILLs, and returns without awaiting exit;
    // stopRunningBrowser then reports stopped:true regardless. So stopped:true
    // means "signals sent", not "process gone" — releasing the proxy guard on
    // it would let a survivor keep serving the old route under a new launch.
    const runtime = {
      call: vi.fn(async (req: BrowserControlRequest): Promise<BrowserControlResult> => {
        if (req.action === 'stop') {
          return { ok: true, action: req.action, status: 200, data: { stopped: true } };
        }
        return { ok: true, action: req.action, status: 200, data: { running: false } };
      }),
    };
    const auth = { start: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    const created: BrowserProxyRoute[] = [];
    let launched = false;
    const backend = new ExternalChromeBackend(fakeRuntime(), fakeLogger(), {
      createRuntime: (route) => { created.push(route); launched = true; return runtime; },
      createProxyAuth: () => auth,
      isBrowserGone: vi.fn(async () => !launched), // still alive after launch
      closeAdoptedBrowser: vi.fn(async () => false),
      managedUserDataDir: '/managed/browser/Cindy/user-data',
    });
    await backend.call({
      action: 'start',
      proxyServer: 'http://proxy.test:8080',
      proxyAllowedHostnames: ['allowed.example'],
    });

    const stopped = await backend.call({ action: 'stop' });

    expect(stopped).toMatchObject({ ok: false, errorCode: 'BROWSER_RUNTIME_ACTION_FAILED' });
    expect(stopped.data).not.toMatchObject({ stopped: true });
    expect(auth.dispose).not.toHaveBeenCalled();
    expect(created.map((r) => r.mode)).toEqual(['proxied']);
  });

  it('blocks traffic when a stop cannot be verified', async () => {
    const runtime = {
      call: vi.fn(async (req: BrowserControlRequest): Promise<BrowserControlResult> => {
        if (req.action === 'start') return { ok: true, action: req.action, status: 200 };
        if (req.action === 'stop') {
          return { ok: true, action: req.action, status: 200, data: { stopped: false } };
        }
        if (req.action === 'status') {
          return { ok: false, action: req.action, errorCode: 'BROWSER_RUNTIME_UNAVAILABLE' };
        }
        return { ok: true, action: req.action, status: 200 };
      }),
    };
    const backend = new ExternalChromeBackend(fakeRuntime(), fakeLogger(), {
      createRuntime: () => runtime,
      createProxyAuth: () => ({ start: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }),
      // The point of this test: the stop cannot be VERIFIED. The process is
      // still reachable, so absence is never established and the route must
      // stay blocked rather than being reported as cleanly stopped.
      isBrowserGone: vi.fn(async () => false),
    });
    await backend.call({ action: 'start', proxyServer: 'http://proxy.test:8080' });

    const stopped = await backend.call({ action: 'stop' });
    const tabs = await backend.call({ action: 'tabs' });

    expect(stopped).toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_ACTION_FAILED',
      // This runtime fails `status`, so the start never committed a route and
      // the reported mode is `unknown`. What matters here is that the stop is
      // refused and traffic stays blocked — asserted below.
      data: { proxy: { mode: 'unknown' } },
    });
    expect(tabs).toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
    });
  });

  it('replaces the proxied runtime with direct config after a failed start whose cleanup stop was unverified', async () => {
    let stopVerifiable = false;
    const proxiedRuntime = {
      call: vi.fn(async (req: BrowserControlRequest): Promise<BrowserControlResult> => {
        if (req.action === 'start') return { ok: true, action: req.action, status: 200 };
        if (req.action === 'stop') {
          return { ok: true, action: req.action, status: 200, data: { stopped: stopVerifiable } };
        }
        if (req.action === 'status') {
          return { ok: true, action: req.action, status: 200, data: { running: !stopVerifiable } };
        }
        return { ok: true, action: req.action, status: 200 };
      }),
    };
    const created: Array<{ route: BrowserProxyRoute; runtime: ReturnType<typeof fakeRuntime> | typeof proxiedRuntime }> = [];
    const backend = new ExternalChromeBackend(fakeRuntime(), fakeLogger(), {
      createRuntime: (route) => {
        const runtime = route.mode === 'proxied' ? proxiedRuntime : fakeRuntime();
        created.push({ route, runtime });
        return runtime;
      },
      createProxyAuth: () => ({
        start: async () => { throw new Error('auth setup failed'); },
        dispose: async () => {},
      }),
      isBrowserGone: vi.fn(async () => true),
    });

    const failedStart = await backend.call({
      action: 'start',
      proxyServer: 'http://proxy.test:8080',
    });
    expect(failedStart.ok).toBe(false);
    await expect(backend.call({ action: 'tabs' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
    });

    stopVerifiable = true;
    const stopped = await backend.call({ action: 'stop' });
    expect(stopped.ok).toBe(true);

    // The verified stop must retire the still-proxied runtime; implicit
    // launches afterwards must run through a fresh direct runtime.
    expect(created.map(({ route }) => route.mode)).toEqual(['proxied', 'direct']);
    const directRuntime = created[1].runtime;
    const tabs = await backend.call({ action: 'tabs' });
    expect(tabs.ok).toBe(true);
    expect(directRuntime.call.mock.calls.map(([req]) => req.action)).toContain('tabs');
    expect(proxiedRuntime.call.mock.calls.map(([req]) => req.action)).not.toContain('tabs');
  });

  it('serializes concurrent lifecycle calls', async () => {
    const events: string[] = [];
    let releaseStart: (() => void) | undefined;
    const initial = fakeRuntime();
    const runtime = {
      call: vi.fn(async (req: BrowserControlRequest): Promise<BrowserControlResult> => {
        events.push(`${req.action}:begin`);
        if (req.action === 'start') {
          await new Promise<void>((resolve) => { releaseStart = resolve; });
        }
        events.push(`${req.action}:end`);
        return {
          ok: true,
          action: req.action,
          status: 200,
          data: req.action === 'status' ? { running: true } : { stopped: true },
        };
      }),
    };
    const backend = new ExternalChromeBackend(initial, fakeLogger(), {
      createRuntime: () => runtime,
      createProxyAuth: () => ({ start: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }),
      isBrowserGone: vi.fn(async () => true),
    });
    const start = backend.call({ action: 'start', proxyServer: 'http://proxy.test:8080' });
    const stop = backend.call({ action: 'stop' });
    await vi.waitFor(() => expect(releaseStart).toBeTypeOf('function'));
    expect(events).toEqual(['start:begin']);
    releaseStart?.();
    await Promise.all([start, stop]);
    // The trailing status is the stop's independent exit verification: the
    // vendored stopped:true only reports that signals were sent. What this test
    // pins is the ordering — stop never interleaves with the in-flight start.
    expect(events).toEqual([
      'start:begin', 'start:end', 'stop:begin', 'stop:end', 'status:begin', 'status:end',
    ]);
  });

  it('rejects a late start after quit quiescence instead of relaunching', async () => {
    const { backend, created } = createHarness();
    await backend.call({ action: 'start' });

    backend.beginQuiescence();
    const dispose = backend.dispose();
    const lateStart = backend.call({
      action: 'start',
      proxyServer: 'http://proxy-after-quit.test:8080',
    });

    await expect(lateStart).resolves.toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
    });
    await dispose;
    expect(created).toHaveLength(1);
    expect(created[0].runtime.call.mock.calls.map(([req]) => req.action)).toEqual(['start', 'stop', 'status']);
  });

  it('swallows dispose errors and skips a runtime that was never used', async () => {
    const unused = fakeRuntime();
    const unusedBackend = new ExternalChromeBackend(unused, fakeLogger());
    await expect(unusedBackend.dispose()).resolves.toBeUndefined();
    expect(unused.call).not.toHaveBeenCalled();

    const call = vi.fn(async (req: BrowserControlRequest): Promise<BrowserControlResult> => {
      if (req.action === 'status') return { ok: true, action: req.action, status: 200, data: { running: true } };
      throw new Error('boom');
    });
    const logger = fakeLogger();
    const usedBackend = new ExternalChromeBackend({ call }, logger);
    await usedBackend.call({ action: 'status' });
    await expect(usedBackend.dispose()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('retains and blocks a known route when dispose cannot stop the browser', async () => {
    const { backend, created, auth } = createHarness();
    await backend.call({
      action: 'start',
      proxyServer: 'http://proxy.test:8080',
    });
    const runtime = created[0].runtime;
    runtime.call.mockImplementationOnce(async () => {
      throw new Error('stop failed');
    });

    await expect(backend.dispose()).resolves.toBeUndefined();

    expect(backend.getEffectiveProxy()).toEqual({
      mode: 'proxied',
      server: 'http://proxy.test:8080',
    });
    await expect(backend.call({ action: 'tabs' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
    });
    expect(auth.dispose).not.toHaveBeenCalled();
  });

  it('attaches the proxy guard to the live Cindy-real identity, not the isolated default', async () => {
    let cdpHttpUrl = 'http://127.0.0.1:18800';
    let managedUserDataDir = '/managed/browser/Cindy/user-data';
    const auth = { start: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    const closeAdoptedBrowser = vi.fn(async () => true);
    const backend = new ExternalChromeBackend(fakeRuntime(), fakeLogger(), {
      createRuntime: () => fakeRuntime(),
      createProxyAuth: () => auth,
      closeAdoptedBrowser,
      isBrowserGone: vi.fn(async () => true),
      cdpHttpUrl: () => cdpHttpUrl,
      managedUserDataDir: () => managedUserDataDir,
    });

    // wrapRuntimeWithRealProfile relocates off 18800 after construction.
    cdpHttpUrl = 'http://127.0.0.1:18801';
    managedUserDataDir = '/managed/browser/Cindy-real/user-data';
    await backend.call({
      action: 'start',
      proxyServer: 'http://proxy-a.test:8080',
    });

    expect(auth.start).toHaveBeenCalledWith('http://127.0.0.1:18801');
    expect(closeAdoptedBrowser).not.toHaveBeenCalled();
  });

  it('closes an inherited process using the live Cindy-real identity', async () => {
    const closeAdoptedBrowser = vi.fn(async () => true);
    const backend = new ExternalChromeBackend(fakeRuntime(true), fakeLogger(), {
      createRuntime: () => fakeRuntime(),
      createProxyAuth: () => ({ start: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }),
      closeAdoptedBrowser,
      isBrowserGone: vi.fn(async () => false),
      cdpHttpUrl: () => 'http://127.0.0.1:18801',
      managedUserDataDir: () => '/managed/browser/Cindy-real/user-data',
    });

    await backend.call({
      action: 'start',
      proxyServer: 'http://proxy-a.test:8080',
    });

    expect(closeAdoptedBrowser).toHaveBeenCalledWith(
      'http://127.0.0.1:18801',
      '/managed/browser/Cindy-real/user-data',
    );
  });
});
