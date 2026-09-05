import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

import { resetBrowserProxyDnsVerdictCache } from '@cindy/browser-control-runtime';

import {
  BrowserProxyAuthCoordinator,
  closeAdoptedManagedBrowser,
  commandLineHasExactArgument,
} from '../proxy-auth.js';

interface CdpCommand {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

const servers: Server[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

async function createFakeCdp(options: {
  failAttachToTarget?: boolean;
  failFetchEnable?: boolean;
  failFetchEnableForSession?: string;
  failBrowserClose?: boolean;
  closeOnBrowserClose?: boolean;
  emitAutoAttach?: boolean;
  emitAutoAttachBeforeReadyBarrier?: boolean;
  reportedUserDataDir?: string;
  startupTargets?: Array<{ targetId: string; type: string }>;
} = {}) {
  const commands: CdpCommand[] = [];
  let browserSocket: WebSocket | undefined;
  let getTargetsCalls = 0;
  const wsServer = new WebSocketServer({ noServer: true });
  wsServer.on('connection', (socket) => {
    sockets.push(socket);
    browserSocket = socket;
    socket.on('message', (raw) => {
      const command = JSON.parse(raw.toString()) as CdpCommand;
      commands.push(command);
      if (command.method === 'Target.setAutoAttach' && options.emitAutoAttach) {
        socket.send(JSON.stringify({
          method: 'Target.attachedToTarget',
          params: {
            sessionId: 'session-1',
            targetInfo: { targetId: 'page-1', type: 'page' },
          },
        }));
        socket.send(JSON.stringify({ id: command.id, result: {} }));
      } else if (command.method === 'Target.getTargets') {
        getTargetsCalls += 1;
        if (options.emitAutoAttachBeforeReadyBarrier && getTargetsCalls === 2) {
          socket.send(JSON.stringify({
            method: 'Target.attachedToTarget',
            params: {
              sessionId: 'session-2',
              targetInfo: { targetId: 'page-2', type: 'page' },
            },
          }));
        }
        socket.send(JSON.stringify({
          id: command.id,
          result: {
            targetInfos: options.startupTargets ?? [{ targetId: 'page-1', type: 'page' }],
          },
        }));
      } else if (command.method === 'Target.attachToTarget') {
        const requestedTargetId = (command.params as { targetId?: string } | undefined)?.targetId;
        socket.send(JSON.stringify(options.failAttachToTarget
          ? { id: command.id, error: { message: 'attach failed' } }
          : {
            id: command.id,
            result: {
              sessionId: options.startupTargets && requestedTargetId
                ? `session-for-${requestedTargetId}`
                : 'session-1',
            },
          }));
      } else if (command.method === 'Fetch.enable' && (
        options.failFetchEnable
        || command.sessionId === options.failFetchEnableForSession
      )) {
        socket.send(JSON.stringify({ id: command.id, error: { message: 'dummy secret must not escape' } }));
      } else if (command.method === 'Browser.close') {
        if (options.failBrowserClose) {
          socket.send(JSON.stringify({ id: command.id, error: { message: 'close failed' } }));
        } else {
          socket.send(JSON.stringify({ id: command.id, result: {} }));
          if (options.closeOnBrowserClose) {
            setTimeout(() => {
              socket.close();
              server.close();
            }, 0);
          }
        }
      } else if (command.method === 'SystemInfo.getInfo') {
        const address = server.address() as AddressInfo;
        socket.send(JSON.stringify({
          id: command.id,
          result: {
            commandLine: options.reportedUserDataDir
              ? `chrome --remote-debugging-port=${address.port} "--user-data-dir=${options.reportedUserDataDir}"`
              : 'chrome',
          },
        }));
      } else {
        socket.send(JSON.stringify({ id: command.id, result: {} }));
      }
    });
  });

  const server = createServer((req, res) => {
    if (req.url !== '/json/version') {
      res.writeHead(404).end();
      return;
    }
    const address = server.address() as AddressInfo;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/browser/test` }));
  });
  server.on('upgrade', (request, socket, head) => {
    wsServer.handleUpgrade(request, socket, head, (ws) => wsServer.emit('connection', ws, request));
  });
  const port = await listen(server);
  return {
    cdpUrl: `http://127.0.0.1:${port}`,
    commands,
    sendEvent(event: Record<string, unknown>) {
      if (!browserSocket) throw new Error('fake CDP browser socket is not connected');
      browserSocket.send(JSON.stringify(event));
    },
    disconnect() {
      if (!browserSocket) throw new Error('fake CDP browser socket is not connected');
      browserSocket.close();
    },
  };
}

// The request gate verifies DNS answers, so tests must supply a resolver:
// the `.example` hosts they use do not resolve. Public answer by default.
const publicLookup = (async () => [{ address: '93.184.216.34', family: 4 }]) as never;

describe('commandLineHasExactArgument', () => {
  const dir = '/Users/me/Library/Application Support/Cindy/browser/Cindy';

  it('rejects a value the expected one is merely a prefix of', () => {
    // The reason this cannot be `includes`: the result feeds a process kill, so
    // matching `<dir>-backup` would terminate an unrelated browser and its tree.
    expect(commandLineHasExactArgument(
      `chrome --user-data-dir=${dir}-backup --remote-debugging-port=18800`,
      `--user-data-dir=${dir}`,
    )).toBe(false);
    expect(commandLineHasExactArgument(
      'chrome --remote-debugging-port=188000',
      '--remote-debugging-port=18800',
    )).toBe(false);
  });

  it('accepts the argument when it stands as its own token', () => {
    for (const line of [
      `chrome --user-data-dir=${dir} --remote-debugging-port=18800`,
      `chrome "--user-data-dir=${dir}" --headless`,
      `--user-data-dir=${dir}`,
    ]) {
      expect(commandLineHasExactArgument(line, `--user-data-dir=${dir}`), line).toBe(true);
    }
  });
});

describe('BrowserProxyAuthCoordinator', () => {
  beforeEach(() => {
    // DNS verdicts are cached per hostname across coordinators, so one test's
    // resolver would otherwise decide the next test's verdict for the same host.
    resetBrowserProxyDnsVerdictCache();
  });

  it('answers only proxy challenges with decoded credentials and continues paused requests', async () => {
    const cdp = await createFakeCdp();
    const logger = { warn: vi.fn() };
    const coordinator = new BrowserProxyAuthCoordinator({
      mode: 'proxied',
      server: 'http://proxy.test:8080',
      username: 'u/ser',
      password: 'p@ss:word',
      allowedHostnames: ['allowed.example'],
    }, logger, () => {}, publicLookup);
    await coordinator.start(cdp.cdpUrl);

    cdp.sendEvent({
      method: 'Fetch.authRequired',
      sessionId: 'session-1',
      params: { requestId: 'proxy-request', authChallenge: { source: 'Proxy' } },
    });
    cdp.sendEvent({
      method: 'Fetch.authRequired',
      sessionId: 'session-1',
      params: { requestId: 'origin-request', authChallenge: { source: 'Server' } },
    });
    cdp.sendEvent({
      method: 'Fetch.requestPaused',
      sessionId: 'session-1',
      params: {
        requestId: 'paused-request',
        request: { url: 'https://allowed.example/page' },
      },
    });

    await vi.waitFor(() => {
      expect(cdp.commands.filter(({ method }) => method === 'Fetch.continueWithAuth')).toHaveLength(2);
      expect(cdp.commands.some(({ method }) => method === 'Fetch.continueRequest')).toBe(true);
    });
    const authCommands = cdp.commands.filter(({ method }) => method === 'Fetch.continueWithAuth');
    expect(authCommands[0]?.params).toMatchObject({
      requestId: 'proxy-request',
      authChallengeResponse: {
        response: 'ProvideCredentials',
        username: 'u/ser',
        password: 'p@ss:word',
      },
    });
    expect(authCommands[1]?.params).toMatchObject({
      requestId: 'origin-request',
      authChallengeResponse: { response: 'Default' },
    });
    expect(logger.warn).not.toHaveBeenCalled();
    await coordinator.dispose();
  });

  it('enforces the HTTPS + hostname allowlist on every paused request, including credential-free proxies', async () => {
    const cdp = await createFakeCdp();
    const coordinator = new BrowserProxyAuthCoordinator({
      mode: 'proxied',
      server: 'http://proxy.test:8080',
      allowedHostnames: ['allowed.example', '*.wild.example'],
    }, { warn: vi.fn() }, () => {}, publicLookup);
    // No credentials: the guard must still attach for the browser lifetime.
    await coordinator.start(cdp.cdpUrl);

    const cases: Array<{ requestId: string; url: string; allowed: boolean }> = [
      { requestId: 'exact-https', url: 'https://allowed.example/page', allowed: true },
      { requestId: 'wildcard-https', url: 'https://sub.wild.example/a', allowed: true },
      { requestId: 'wildcard-apex', url: 'https://wild.example/a', allowed: false },
      { requestId: 'plain-http', url: 'http://allowed.example/page', allowed: false },
      { requestId: 'other-host', url: 'https://evil.example/page', allowed: false },
      { requestId: 'no-url', url: '', allowed: false },
    ];
    for (const { requestId, url } of cases) {
      cdp.sendEvent({
        method: 'Fetch.requestPaused',
        sessionId: 'session-1',
        params: { requestId, ...(url ? { request: { url } } : {}) },
      });
    }

    await vi.waitFor(() => {
      const handled = cdp.commands.filter(
        ({ method }) => method === 'Fetch.continueRequest' || method === 'Fetch.failRequest',
      );
      expect(handled).toHaveLength(cases.length);
    });
    for (const { requestId, allowed } of cases) {
      const command = cdp.commands.find(
        ({ method, params }) =>
          (method === 'Fetch.continueRequest' || method === 'Fetch.failRequest')
          && (params as { requestId?: string } | undefined)?.requestId === requestId,
      );
      expect(command?.method, requestId).toBe(
        allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
      );
      if (!allowed) {
        expect(command?.params).toMatchObject({ errorReason: 'BlockedByClient' });
      }
    }
    await coordinator.dispose();
  });

  it('blocks an allowlisted host whose DNS answer points into the private network', async () => {
    // The allowlist is textual, so `allowed.example` matches — only resolution
    // reveals the inward target (the `127.0.0.1.nip.io` / rebinding class).
    const cdp = await createFakeCdp();
    const coordinator = new BrowserProxyAuthCoordinator({
      mode: 'proxied',
      server: 'http://proxy.test:8080',
      allowedHostnames: ['allowed.example'],
    }, { warn: vi.fn() }, () => {}, (async () => [{ address: '127.0.0.1', family: 4 }]) as never);
    await coordinator.start(cdp.cdpUrl);

    cdp.sendEvent({
      method: 'Fetch.requestPaused',
      sessionId: 'session-1',
      params: { requestId: 'rebound', request: { url: 'https://allowed.example/page' } },
    });

    await vi.waitFor(() => {
      const command = cdp.commands.find(
        ({ params }) => (params as { requestId?: string } | undefined)?.requestId === 'rebound',
      );
      expect(command?.method).toBe('Fetch.failRequest');
      expect(command?.params).toMatchObject({ errorReason: 'BlockedByClient' });
    });
    await coordinator.dispose();
  });

  it('enables auto-attach recursively on each attached target session', async () => {
    // Auto-attach only covers targets related to the session it was set on, so
    // the browser-level call does not reach a page's own dedicated/shared
    // workers. Without recursing per session such a worker never raises
    // attachedToTarget, never gets Fetch, and its requests skip the gate —
    // leaving only the hostname-only PAC. (Playwright recurses the same way.)
    const cdp = await createFakeCdp({
      startupTargets: [
        { targetId: 'page-1', type: 'page' },
        { targetId: 'sw-1', type: 'service_worker' },
      ],
    });
    const coordinator = new BrowserProxyAuthCoordinator({
      mode: 'proxied',
      server: 'http://proxy.test:8080',
      allowedHostnames: ['allowed.example'],
    }, { warn: vi.fn() }, () => {}, publicLookup);
    await coordinator.start(cdp.cdpUrl);

    const autoAttachSessions = cdp.commands
      .filter(({ method }) => method === 'Target.setAutoAttach')
      .map(({ sessionId }) => sessionId);
    // Browser level (no sessionId) plus one per attached network-capable target.
    expect(autoAttachSessions).toContain(undefined);
    for (const targetId of ['page-1', 'sw-1']) {
      expect(autoAttachSessions, targetId).toContain(`session-for-${targetId}`);
    }

    // A target paused at start must not be resumed before its own children
    // will be caught, so the recursion has to precede the resume.
    const order = cdp.commands.filter(({ method, sessionId }) =>
      sessionId === 'session-for-page-1'
      && (method === 'Target.setAutoAttach' || method === 'Runtime.runIfWaitingForDebugger'));
    expect(order.map(({ method }) => method)).toEqual([
      'Target.setAutoAttach',
      'Runtime.runIfWaitingForDebugger',
    ]);
    await coordinator.dispose();
  });

  it('gates workers and subframes, not just pages', async () => {
    const cdp = await createFakeCdp({
      startupTargets: [
        { targetId: 'page-1', type: 'page' },
        { targetId: 'sw-1', type: 'service_worker' },
        { targetId: 'worker-1', type: 'worker' },
        { targetId: 'shared-1', type: 'shared_worker' },
        { targetId: 'frame-1', type: 'iframe' },
        { targetId: 'other-1', type: 'browser' },
      ],
    });
    const coordinator = new BrowserProxyAuthCoordinator({
      mode: 'proxied',
      server: 'http://proxy.test:8080',
      allowedHostnames: ['allowed.example'],
    }, { warn: vi.fn() });
    await coordinator.start(cdp.cdpUrl);

    const gatedSessions = cdp.commands
      .filter(({ method }) => method === 'Fetch.enable')
      .map(({ sessionId }) => sessionId);
    for (const targetId of ['page-1', 'sw-1', 'worker-1', 'shared-1', 'frame-1']) {
      expect(gatedSessions, targetId).toContain(`session-for-${targetId}`);
    }
    // A non-network target is resumed but never gets its own Fetch gate.
    expect(gatedSessions).not.toContain('session-for-other-1');

    // A worker request is enforced on its own session, like a page request.
    cdp.sendEvent({
      method: 'Fetch.requestPaused',
      sessionId: 'session-for-sw-1',
      params: { requestId: 'sw-egress', request: { url: 'https://evil.example/beacon' } },
    });
    await vi.waitFor(() => {
      expect(
        cdp.commands.some(
          ({ method, params }) =>
            method === 'Fetch.failRequest'
            && (params as { requestId?: string } | undefined)?.requestId === 'sw-egress',
        ),
      ).toBe(true);
    });
    await coordinator.dispose();
  });

  it('blocks every request when a proxied launch carries no allowlist', async () => {
    const cdp = await createFakeCdp();
    const coordinator = new BrowserProxyAuthCoordinator({
      mode: 'proxied',
      server: 'http://proxy.test:8080',
    }, { warn: vi.fn() });
    await coordinator.start(cdp.cdpUrl);

    cdp.sendEvent({
      method: 'Fetch.requestPaused',
      sessionId: 'session-1',
      params: { requestId: 'no-allowlist', request: { url: 'https://anything.example/' } },
    });

    await vi.waitFor(() => {
      expect(
        cdp.commands.some(
          ({ method, params }) =>
            method === 'Fetch.failRequest'
            && (params as { requestId?: string } | undefined)?.requestId === 'no-allowlist',
        ),
      ).toBe(true);
    });
    expect(cdp.commands.some(({ method }) => method === 'Fetch.continueRequest')).toBe(false);
    await coordinator.dispose();
  });

  it('fails setup when Fetch authentication handling cannot be enabled', async () => {
    const cdp = await createFakeCdp({ failFetchEnable: true });
    const coordinator = new BrowserProxyAuthCoordinator({
      mode: 'proxied',
      server: 'http://proxy.test:8080',
      username: 'dummy-user',
      password: 'dummy-password',
    }, { warn: vi.fn() });
    await expect(coordinator.start(cdp.cdpUrl)).rejects.toThrow(
      'CDP proxy authentication command failed',
    );
    await coordinator.dispose();
  });

  it('fails setup when an existing live page cannot be attached', async () => {
    const cdp = await createFakeCdp({ failAttachToTarget: true });
    const coordinator = new BrowserProxyAuthCoordinator({
      mode: 'proxied',
      server: 'http://proxy.test:8080',
      username: 'dummy-user',
      password: 'dummy-password',
    }, { warn: vi.fn() });

    await expect(coordinator.start(cdp.cdpUrl)).rejects.toThrow(
      'CDP proxy authentication command failed',
    );
    expect(cdp.commands.filter(({ method }) => method === 'Target.getTargets')).toHaveLength(2);
    expect(cdp.commands.filter(({ method }) => method === 'Fetch.enable')).toHaveLength(0);
    await coordinator.dispose();
  });

  it('awaits auto-attached target setup without attaching the same target twice', async () => {
    const cdp = await createFakeCdp({ emitAutoAttach: true });
    const coordinator = new BrowserProxyAuthCoordinator({
      mode: 'proxied',
      server: 'http://proxy.test:8080',
      username: 'user',
      password: 'password',
    }, { warn: vi.fn() });
    await coordinator.start(cdp.cdpUrl);
    expect(cdp.commands.filter(({ method }) => method === 'Target.attachToTarget')).toHaveLength(0);
    expect(cdp.commands.filter(({ method }) => method === 'Fetch.enable')).toHaveLength(1);
    expect(cdp.commands.filter(({ method }) => method === 'Runtime.runIfWaitingForDebugger')).toHaveLength(1);
    await coordinator.dispose();
  });

  it('fails startup when target auth fails before the CDP readiness barrier', async () => {
    const cdp = await createFakeCdp({
      emitAutoAttachBeforeReadyBarrier: true,
      failFetchEnableForSession: 'session-2',
    });
    const onFailure = vi.fn();
    const coordinator = new BrowserProxyAuthCoordinator({
      mode: 'proxied',
      server: 'http://proxy.test:8080',
      username: 'user',
      password: 'password',
    }, { warn: vi.fn() }, onFailure);

    await expect(coordinator.start(cdp.cdpUrl)).rejects.toThrow('proxy authentication setup failed');
    expect(onFailure).toHaveBeenCalledTimes(1);
    await coordinator.dispose();
  });

  it('blocks the route when later target auth setup fails even if browser close also fails', async () => {
    const cdp = await createFakeCdp({
      failFetchEnableForSession: 'session-2',
      failBrowserClose: true,
    });
    const logger = { warn: vi.fn() };
    const onFailure = vi.fn();
    const coordinator = new BrowserProxyAuthCoordinator({
      mode: 'proxied',
      server: 'http://proxy.test:8080',
      username: 'user',
      password: 'password',
    }, logger, onFailure);
    await coordinator.start(cdp.cdpUrl);

    cdp.sendEvent({
      method: 'Target.attachedToTarget',
      params: {
        sessionId: 'session-2',
        targetInfo: { targetId: 'page-2', type: 'page' },
      },
    });

    await vi.waitFor(() => {
      expect(cdp.commands).toContainEqual(expect.objectContaining({ method: 'Browser.close' }));
    });
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(cdp.commands).not.toContainEqual(expect.objectContaining({
      method: 'Runtime.runIfWaitingForDebugger',
      sessionId: 'session-2',
    }));
    expect(logger.warn).toHaveBeenCalledWith(
      'browser proxy authentication could not prepare a new browser target',
    );
    await coordinator.dispose();
  });

  it('blocks the route when the proxy-auth CDP channel disconnects unexpectedly', async () => {
    const cdp = await createFakeCdp();
    const onFailure = vi.fn();
    const coordinator = new BrowserProxyAuthCoordinator({
      mode: 'proxied',
      server: 'http://proxy.test:8080',
      username: 'user',
      password: 'password',
    }, { warn: vi.fn() }, onFailure);
    await coordinator.start(cdp.cdpUrl);

    cdp.disconnect();

    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    await coordinator.dispose();
  });

  it('terminates the browser over a fresh connection when its own channel is dead', async () => {
    // Blocking the host only stops future host calls. Pages and workers already
    // running keep their network access, and the request gate died with the
    // socket — leaving the hostname-only PAC. Browser.close over the dead
    // channel is a no-op (command() rejects when the socket is not OPEN), so
    // teardown must dial the endpoint again.
    const userDataDir = '/managed/browser/Cindy/user-data';
    const cdp = await createFakeCdp({ reportedUserDataDir: userDataDir });
    const coordinator = new BrowserProxyAuthCoordinator({
      mode: 'proxied',
      server: 'http://proxy.test:8080',
      allowedHostnames: ['allowed.example'],
    }, { warn: vi.fn() }, () => {}, publicLookup, userDataDir);
    await coordinator.start(cdp.cdpUrl);
    const before = cdp.commands.filter(({ method }) => method === 'Browser.close').length;

    cdp.disconnect();

    // The close arrives on a NEW socket, after the coordinator's own is gone.
    await vi.waitFor(() => {
      const after = cdp.commands.filter(({ method }) => method === 'Browser.close').length;
      expect(after).toBeGreaterThan(before);
    }, { timeout: 10_000 });
    await coordinator.dispose();
  }, 20_000);

  it('closes and verifies an adopted managed browser through loopback CDP', async () => {
    const userDataDir = '/managed/browser/Cindy Profile/user-data';
    const cdp = await createFakeCdp({ closeOnBrowserClose: true, reportedUserDataDir: userDataDir });
    await expect(closeAdoptedManagedBrowser(cdp.cdpUrl, userDataDir)).resolves.toBe(true);
    expect(cdp.commands).toContainEqual(expect.objectContaining({ method: 'Browser.close' }));
  });

  it('bounds auth attempt state without depending on CDP event ordering', async () => {
    const cdp = await createFakeCdp();
    const coordinator = new BrowserProxyAuthCoordinator({
      mode: 'proxied',
      server: 'http://proxy.test:8080',
      username: 'u',
      password: 'p',
      allowedHostnames: ['allowed.example'],
    }, { warn: vi.fn() });
    await coordinator.start(cdp.cdpUrl);

    const attempts = (coordinator as unknown as { authAttempts: Map<string, number> }).authAttempts;
    // Far more unique challenges than a page could have in flight at once.
    for (let i = 0; i < 700; i += 1) {
      cdp.sendEvent({
        method: 'Fetch.authRequired',
        sessionId: 'session-1',
        params: { requestId: `req-${i}`, authChallenge: { source: 'Proxy' } },
      });
    }
    await vi.waitFor(() => {
      expect(
        cdp.commands.filter(({ method }) => method === 'Fetch.continueWithAuth'),
      ).toHaveLength(700);
    });

    expect(attempts.size).toBeLessThanOrEqual(512);
    // A challenge still in flight keeps its counter, so a repeat challenge is
    // still recognized as a retry and cancelled rather than re-credentialed.
    cdp.sendEvent({
      method: 'Fetch.authRequired',
      sessionId: 'session-1',
      params: { requestId: 'req-699', authChallenge: { source: 'Proxy' } },
    });
    await vi.waitFor(() => {
      const cancels = cdp.commands.filter(
        ({ method, params }) =>
          method === 'Fetch.continueWithAuth'
          && (params as { authChallengeResponse?: { response?: string } } | undefined)
            ?.authChallengeResponse?.response === 'CancelAuth',
      );
      expect(cancels.length).toBeGreaterThanOrEqual(1);
    });
    await coordinator.dispose();
  }, 20_000);

  it('does not treat a transient CDP outage as a stopped browser', async () => {
    // The HTTP endpoint refuses connections for a while (busy/stalled Chrome)
    // and then recovers — a still-live browser, not an exited one.
    let refuseUntil = Date.now() + 600;
    const server = createServer((req, res) => {
      if (Date.now() < refuseUntil) {
        req.destroy();
        return;
      }
      if (req.url !== '/json/version') {
        res.writeHead(404).end();
        return;
      }
      const address = server.address() as AddressInfo;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/browser/test`,
      }));
    });
    const port = await listen(server);

    // The websocket handshake fails while the endpoint is refusing, so this
    // takes the "cannot connect" path — which must NOT report success once the
    // endpoint proves reachable again.
    await expect(closeAdoptedManagedBrowser(
      `http://127.0.0.1:${port}`,
      '/managed/browser/Cindy/user-data',
    )).resolves.toBe(false);
    expect(refuseUntil).toBeLessThan(Date.now());
    // Runs the full quiescence deadline rather than returning early on the
    // first failed probe — that is the point of the check.
  }, 20_000);

  it('refuses to close an adopted CDP browser with a different profile identity', async () => {
    const cdp = await createFakeCdp({ reportedUserDataDir: '/other/browser/user-data' });

    await expect(closeAdoptedManagedBrowser(
      cdp.cdpUrl,
      '/managed/browser/Cindy/user-data',
    )).resolves.toBe(false);
    expect(cdp.commands).not.toContainEqual(expect.objectContaining({ method: 'Browser.close' }));
  });
});
