import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { promisify } from 'node:util';

import WebSocket from 'ws';

import { findPortOwnerPids, killPortOwner } from '../../cindy-brain/portReclaim.js';

import {
  isBrowserProxyRequestUrlAllowedAsync,
  managedProfilePidOwnsCdpPort,
  pidIsManagedChromeForProfile,
  readManagedProfileOwnerPid,
  type BrowserProxyRoute,
  type LookupFn,
} from '@cindy/browser-control-runtime';

type CdpResponse = {
  id?: number;
  result?: unknown;
  error?: { message?: string };
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const execFileAsync = promisify(execFile);

const COMMAND_TIMEOUT_MS = 10_000;

/**
 * Target types that can originate network requests and therefore need their own
 * Fetch gate: interception is per target/session, so a worker without it would
 * reach the proxy unfiltered. Non-network targets are merely resumed.
 */
const NETWORK_CAPABLE_TARGET_TYPES = new Set([
  'page',
  'iframe',
  'service_worker',
  'shared_worker',
  'worker',
  'shared_storage_worklet',
  'worklet',
]);

function isNetworkCapableTargetType(type: unknown): boolean {
  return typeof type === 'string' && NETWORK_CAPABLE_TARGET_TYPES.has(type);
}

async function fetchBrowserWebSocketUrl(cdpHttpUrl: string): Promise<string> {
  const base = new URL(cdpHttpUrl);
  if (
    base.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(base.hostname)
  ) {
    throw new Error('managed browser CDP endpoint must be loopback HTTP');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS);
  try {
    const response = await fetch(`${base.toString().replace(/\/$/, '')}/json/version`, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('CDP endpoint unavailable');
    const body = (await response.json()) as { webSocketDebuggerUrl?: unknown };
    if (typeof body.webSocketDebuggerUrl !== 'string' || !body.webSocketDebuggerUrl) {
      throw new Error('CDP websocket endpoint unavailable');
    }
    const ws = new URL(body.webSocketDebuggerUrl);
    if (
      ws.protocol !== 'ws:'
      || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(ws.hostname)
      || ws.port !== base.port
      || !ws.pathname.startsWith('/devtools/browser/')
      || ws.username
      || ws.password
      || ws.search
      || ws.hash
    ) {
      throw new Error('CDP websocket endpoint is not the managed loopback browser');
    }
    return ws.toString();
  } finally {
    clearTimeout(timer);
  }
}

async function isCdpReachable(cdpHttpUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 250);
  try {
    const response = await fetch(`${cdpHttpUrl.replace(/\/$/, '')}/json/version`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How long the CDP endpoint must stay continuously unreachable before the
 * browser counts as gone.
 *
 * A single failed probe only proves the endpoint did not answer within its
 * timeout, which a busy-but-alive Chrome also produces; a short burst of
 * failures proves little more. Requiring an uninterrupted unreachable window
 * distinguishes a real exit from a stall, at the cost of a bounded delay on
 * the (already slow) teardown path. Any successful probe resets the window.
 */
/**
 * Upper bound on tracked proxy-auth challenges. Sized well above any realistic
 * number of simultaneously-challenging requests so eviction only ever reclaims
 * entries whose requests are long finished.
 */
const MAX_TRACKED_AUTH_ATTEMPTS = 512;

const CDP_GONE_CONFIRM_WINDOW_MS = 1_500;
const CDP_GONE_PROBE_INTERVAL_MS = 100;

/**
 * Whether no live Chrome owns the managed profile.
 *
 * The CDP port is the floor, on every platform. A bare TCP connect (not an HTTP
 * request) is what separates "process gone" from "process busy": accepting a
 * connection happens in the socket layer, so a Chrome stalled on its main
 * thread still completes it while failing to answer `/json/version`.
 *
 * The profile's SingletonLock is deliberately NOT consulted here. It cannot
 * substitute for the port in either direction:
 *  - null does not mean absent — `readCurrentHostSingletonPid` also returns
 *    null when the lock is missing, unreadable, malformed, or records another
 *    hostname, all reachable with a live browser. Windows never writes one at
 *    all. Trusting null would report `gone` and let the request guard be
 *    disposed while Chrome still serves the old route.
 *  - a live PID does not mean present — the lock survives a crash and the OS
 *    recycles PIDs, so it can name an unrelated process and block the route
 *    until that process exits or the user clears the lock by hand.
 *
 * The lock is still used for TERMINATION, where it supplies a candidate PID —
 * but there it is paired with a command-line identity check before anything is
 * signalled.
 */
async function confirmNoManagedChromeProcess(cdpHttpUrl: string): Promise<boolean> {
  return !(await isCdpPortListening(cdpHttpUrl));
}

/**
 * Whether a command line carries this exact argument, respecting token
 * boundaries.
 *
 * A substring test is not sufficient: `--user-data-dir=/p/Cindy` is a prefix of
 * `--user-data-dir=/p/Cindy-backup`, so `includes` would accept an unrelated
 * browser and hand it to a process kill. The argument must be delimited by
 * whitespace or quotes on both sides (or sit at a string edge).
 */
export function commandLineHasExactArgument(commandLine: string, argument: string): boolean {
  let offset = commandLine.indexOf(argument);
  while (offset >= 0) {
    const before = offset === 0 ? '' : commandLine[offset - 1];
    const after = commandLine[offset + argument.length] ?? '';
    if ((!before || /[\s"']/.test(before)) && (!after || /[\s"']/.test(after))) return true;
    offset = commandLine.indexOf(argument, offset + 1);
  }
  return false;
}

/**
 * Windows command-line identity for a PID.
 *
 * The vendored `readManagedProcessCommandLine` only implements Linux (/proc)
 * and macOS (ps), returning null on win32 — so the shared identity verifier
 * always answers "not ours" there, which would silently disable the very
 * teardown this platform needs. Query Win32_Process for the command line so
 * the same profile/port proof can be applied.
 *
 * Returns null on any failure, so callers treat an unknown identity as "do not
 * signal" rather than assuming ownership.
 */
async function readWindowsProcessCommandLine(pid: number): Promise<string | null> {
  try {
    const powershell = `${process.env.SystemRoot ?? 'C:\\Windows'}`
      + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const { stdout } = await execFileAsync(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop; `
          + 'if ($p) { [string]$p.CommandLine }',
      ],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true, maxBuffer: 64 * 1024 },
    );
    const text = stdout.trim();
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

/** Whether a PID is a Chrome launched for exactly this profile and CDP port. */
async function isManagedChromeProcess(params: {
  pid: number;
  cdpPort: number;
  userDataDir: string;
}): Promise<boolean> {
  if (process.platform !== 'win32') {
    return pidIsManagedChromeForProfile(params);
  }
  const commandLine = await readWindowsProcessCommandLine(params.pid);
  if (!commandLine) return false;
  // Same two proofs the POSIX path requires: our profile AND our debug port.
  // Exact-argument matching, not substring: `--user-data-dir=<dir>` is a prefix
  // of `--user-data-dir=<dir>-backup`, and this result feeds `taskkill /T /F`.
  return commandLineHasExactArgument(commandLine, `--user-data-dir=${params.userDataDir}`)
    && commandLineHasExactArgument(commandLine, `--remote-debugging-port=${params.cdpPort}`);
}

/**
 * Whether anything still holds the CDP port.
 *
 * Deliberately a bare TCP connect, not an HTTP request: accepting a connection
 * is handled by the OS/socket layer, so a Chrome stalled on its main thread
 * still completes it while failing to answer `/json/version`. That difference
 * is the whole point — it separates "process gone" from "process busy".
 */
async function isCdpPortListening(cdpHttpUrl: string): Promise<boolean> {
  let target: URL;
  try {
    target = new URL(cdpHttpUrl);
  } catch {
    return false;
  }
  const port = Number(target.port || 80);
  const host = target.hostname.replace(/^\[|\]$/g, '');
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (listening: boolean) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* best effort */ }
      resolve(listening);
    };
    const socket = createConnection({ port, host });
    socket.setTimeout(1_000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(true)); // reachable but unresponsive
    socket.once('error', () => finish(false));
  });
}

/**
 * Whether the CDP endpoint is verifiably gone, not merely slow to answer.
 * Fails closed: if the window cannot be established before the deadline, the
 * caller must treat the browser as still running.
 */
async function confirmCdpGone(cdpHttpUrl: string): Promise<boolean> {
  const deadline = Date.now() + COMMAND_TIMEOUT_MS;
  let unreachableSince: number | undefined;
  while (Date.now() < deadline) {
    if (await isCdpReachable(cdpHttpUrl)) {
      unreachableSince = undefined;
    } else {
      unreachableSince ??= Date.now();
      if (Date.now() - unreachableSince >= CDP_GONE_CONFIRM_WINDOW_MS) {
        // Endpoint silence is not process death: a Chrome stalled on its main
        // thread stops answering while still alive, and calling that "gone"
        // releases the request gate and lets the survivor be re-attributed to a
        // new route. Require the OS to agree before declaring an exit.
        return await confirmNoManagedChromeProcess(cdpHttpUrl);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, CDP_GONE_PROBE_INTERVAL_MS));
  }
  return false;
}

/**
 * Close an adopted browser through its browser-level CDP endpoint.
 *
 * Vendored `stop` cannot terminate a process that predates its in-memory
 * ownership state. A route transition must not re-adopt such a process and
 * claim the new route, so the host explicitly closes it and verifies the CDP
 * listener is gone before relaunching.
 */
/**
 * Non-destructive liveness probe: whether the managed browser's CDP endpoint
 * is verifiably gone. Issues no commands, so it is safe on passive paths such
 * as a status poll — unlike {@link closeAdoptedManagedBrowser}, which proves
 * ownership by actually closing the browser.
 */
export async function isManagedBrowserGone(cdpHttpUrl: string): Promise<boolean> {
  return await confirmCdpGone(cdpHttpUrl);
}

export async function closeAdoptedManagedBrowser(
  cdpHttpUrl: string,
  expectedUserDataDir: string,
): Promise<boolean> {
  let wsUrl: string;
  try {
    wsUrl = await fetchBrowserWebSocketUrl(cdpHttpUrl);
  } catch {
    // A failed handshake does not prove the browser exited — the endpoint may
    // be briefly unavailable while Chrome is busy. Treating that as "stopped"
    // would unblock the route and mis-report a surviving process (possibly on
    // an unknown proxy route) as direct. Require the endpoint to stay
    // unreachable across the full quiescence window before claiming success.
    return await confirmCdpGone(cdpHttpUrl);
  }

  const socket = new WebSocket(wsUrl, { handshakeTimeout: COMMAND_TIMEOUT_MS });
  let commandSent = false;
  const expectedCdpPort = new URL(cdpHttpUrl).port || '80';
  const closeRequested = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      try { socket.terminate(); } catch { /* best effort */ }
      resolve(false);
    }, COMMAND_TIMEOUT_MS);
    const finish = (value: boolean) => {
      clearTimeout(timer);
      resolve(value);
    };
    socket.once('open', () => {
      // SystemInfo.getInfo exposes the browser command line over CDP. Verify
      // both Cindy's stable profile path and this listener's port before
      // closing an adopted process; a loopback DevTools endpoint alone does
      // not establish ownership.
      // https://chromedevtools.github.io/devtools-protocol/tot/SystemInfo/#method-getInfo
      socket.send(JSON.stringify({ id: 1, method: 'SystemInfo.getInfo' }), (error) => {
        if (error) finish(false);
      });
    });
    socket.on('message', (data) => {
      try {
        const message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) as CdpResponse;
        if (message.id === 1) {
          const commandLine = (message.result as { commandLine?: unknown } | undefined)?.commandLine;
          const owned = typeof commandLine === 'string'
            && commandLineHasExactArgument(commandLine, `--remote-debugging-port=${expectedCdpPort}`)
            && commandLineHasExactArgument(commandLine, `--user-data-dir=${expectedUserDataDir}`);
          if (!owned) {
            finish(false);
            return;
          }
          commandSent = true;
          socket.send(JSON.stringify({ id: 2, method: 'Browser.close' }), (error) => {
            if (error) finish(false);
          });
        } else if (message.id === 2) {
          finish(!message.error);
        }
      } catch {
        // Ignore unrelated/malformed events while Chrome is exiting.
      }
    });
    socket.once('close', () => finish(commandSent));
    socket.once('error', () => finish(false));
  });
  const requested = await closeRequested;
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    try { socket.close(); } catch { /* best effort */ }
  }
  if (!requested) return false;

  return await confirmCdpGone(cdpHttpUrl);
}

/**
 * Lifetime CDP guard for a proxied browser launch.
 *
 * CDP Fetch is enabled on every network-capable target (startup tabs, popups,
 * subframes, and workers — interception is per session, so a worker without
 * its own gate would reach the proxy unfiltered) for the whole browser
 * lifetime, and every paused request is checked against the fail-closed launch
 * policy: HTTPS only, to a hostname on the per-start allowlist. HTTP proxy authentication rides the
 * same channel — challenges are answered in memory with Fetch.continueWithAuth
 * so credentials never reach Chrome's command line.
 *
 * Known limitation: CDP Fetch does not intercept WebSocket handshakes, so WS
 * egress is not blocked at this layer (navigation-level guards still gate the
 * pages that could open one).
 */
export class BrowserProxyAuthCoordinator {
  private socket: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly authAttempts = new Map<string, number>();
  private readonly sessions = new Set<string>();
  private readonly targetSetups = new Map<string, Promise<void>>();
  private readonly sessionTargets = new Map<string, string>();
  private readonly eventTasks = new Set<Promise<void>>();
  private closing = false;
  private failed = false;
  private cdpHttpUrl: string | undefined;
  /**
   * In-flight failClosed() work. It runs detached from the backend's serial
   * queue, so dispose() must await it: otherwise a `stop` + `start` can land a
   * new Chrome on the same profile/port while the old cleanup is still running,
   * and that cleanup would then terminate the replacement.
   */
  private teardown: Promise<void> | undefined;

  constructor(
    private readonly route: BrowserProxyRoute,
    private readonly logger: { warn(message: string, ...args: unknown[]): void },
    private readonly onFailure: () => void = () => {},
    /** Test seam only; production uses the platform resolver. */
    private readonly lookupFn?: LookupFn,
    /** Managed profile path; required to close the browser if our socket dies. */
    private readonly managedUserDataDir?: string,
  ) {}

  private get hasCredentials(): boolean {
    return this.route.username !== undefined || this.route.password !== undefined;
  }

  async start(cdpHttpUrl: string): Promise<void> {
    if (this.route.mode !== 'proxied') return;
    // Retained for teardown: if this coordinator's own socket dies, closing the
    // browser needs an endpoint it can reach over a fresh connection.
    this.cdpHttpUrl = cdpHttpUrl;
    let wsUrl: string;
    try {
      wsUrl = await fetchBrowserWebSocketUrl(cdpHttpUrl);
    } catch {
      throw new Error('proxy authentication setup could not reach the managed browser');
    }

    const socket = new WebSocket(wsUrl, { handshakeTimeout: COMMAND_TIMEOUT_MS });
    this.socket = socket;
    socket.on('message', (data) => this.handleMessage(data));
    socket.on('error', (error) => {
      if (!this.closing) {
        this.logger.warn('browser proxy authentication channel failed', { error: String(error) });
        this.rejectPending(new Error('proxy authentication channel failed'));
        void this.beginTeardown();
      }
    });
    socket.on('close', () => {
      if (!this.closing) {
        this.rejectPending(new Error('proxy authentication channel closed'));
        void this.beginTeardown();
      }
    });
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('proxy authentication channel could not open'));
      };
      const onClose = () => {
        cleanup();
        reject(new Error('proxy authentication channel closed before setup'));
      };
      const cleanup = () => {
        socket.off('open', onOpen);
        socket.off('error', onError);
        socket.off('close', onClose);
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
      socket.once('close', onClose);
    });

    await this.command('Target.setDiscoverTargets', { discover: true });
    await this.command('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    const targets = await this.command('Target.getTargets') as {
      targetInfos?: Array<{ targetId?: string; type?: string }>;
    };
    for (const target of targets.targetInfos ?? []) {
      if (target.targetId && isNetworkCapableTargetType(target.type)) {
        await this.attach(target.targetId);
      }
    }
    // CDP messages are ordered on the browser WebSocket. A final command acts
    // as a barrier: every auto-attach event received before its response has
    // registered an event task, which must settle before startup is committed.
    await this.command('Target.getTargets');
    await this.drainEventTasks();
    if (this.failed) throw new Error('proxy authentication setup failed');
  }

  async dispose(): Promise<void> {
    // Settle any detached teardown BEFORE marking this coordinator closed, so
    // the caller cannot start a replacement browser while old cleanup is still
    // able to kill it. Awaited first because failClosed() itself bails once
    // `closing` is set — flipping the flag first would abandon work midway.
    const teardown = this.teardown;
    this.teardown = undefined;
    if (teardown) await teardown.catch(() => undefined);
    this.closing = true;
    this.rejectPending(new Error('proxy authentication channel closed'));
    const socket = this.socket;
    this.socket = undefined;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      try {
        socket.close();
      } catch {
        // Socket teardown is best effort.
      }
    }
    this.sessions.clear();
    this.authAttempts.clear();
    this.targetSetups.clear();
    this.sessionTargets.clear();
    this.eventTasks.clear();
  }

  private async attach(targetId: string): Promise<void> {
    const existing = this.targetSetups.get(targetId);
    if (existing) return existing;
    let result: { sessionId?: string };
    try {
      result = await this.command('Target.attachToTarget', { targetId, flatten: true }) as {
        sessionId?: string;
      };
    } catch (error) {
      // A target can disappear between discovery and attachment, while an
      // auto-attach event can also win the race and prepare it first. Recheck
      // both states; a still-live network-capable target without the Fetch gate
      // must fail startup rather than being silently skipped.
      const targets = await this.command('Target.getTargets') as {
        targetInfos?: Array<{ targetId?: string; type?: string }>;
      };
      await this.drainEventTasks();
      const autoAttached = this.targetSetups.get(targetId);
      if (autoAttached) {
        await autoAttached;
        return;
      }
      const stillLive = (targets.targetInfos ?? []).some(
        (target) => target.targetId === targetId && isNetworkCapableTargetType(target.type),
      );
      if (stillLive) throw error;
      return;
    }
    // Once attachment succeeds, Fetch.enable is part of the authentication
    // readiness handshake. Propagate failure so start fails closed rather than
    // reporting an authenticated route with no challenge handler installed.
    if (result.sessionId) await this.setupTarget(targetId, result.sessionId);
  }

  private setupTarget(targetId: string, sessionId: string): Promise<void> {
    const existing = this.targetSetups.get(targetId);
    if (existing) return existing;
    const setup = (async () => {
      this.sessionTargets.set(sessionId, targetId);
      await this.enableFetch(sessionId);
      // Auto-attach only covers targets related to the session it was set on,
      // so the browser-level call does NOT reach a page's own dedicated/shared
      // workers. Without this recursion such a worker never raises
      // attachedToTarget, never gets Fetch enabled, and its HTTPS requests skip
      // the DNS/private-address gate entirely — leaving only the hostname-only
      // PAC. Playwright does the same thing (setAutoAttach per page session and
      // per worker session, crPage.js), which is what makes nested targets
      // reachable at all.
      //
      // Before runIfWaitingForDebugger: a target paused at start must not be
      // resumed until its own children will be caught too.
      await this.command('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      }, sessionId);
      // This is harmless for an already-running target and is required for
      // auto-attached targets paused before their first network request. Do
      // not resume when Fetch setup fails: the page must never run without
      // the authenticated-proxy challenge handler installed.
      await this.command('Runtime.runIfWaitingForDebugger', {}, sessionId);
    })();
    this.targetSetups.set(targetId, setup);
    setup.catch(() => {
      if (this.targetSetups.get(targetId) === setup) this.targetSetups.delete(targetId);
      this.sessionTargets.delete(sessionId);
    });
    return setup;
  }

  private async enableFetch(sessionId: string): Promise<void> {
    if (this.sessions.has(sessionId)) return;
    this.sessions.add(sessionId);
    try {
      await this.command('Fetch.enable', { handleAuthRequests: this.hasCredentials }, sessionId);
    } catch (error) {
      this.sessions.delete(sessionId);
      throw error;
    }
  }

  private handleMessage(data: WebSocket.RawData): void {
    let message: CdpResponse;
    try {
      message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) as CdpResponse;
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error?.message) pending.reject(new Error('CDP proxy authentication command failed'));
      else pending.resolve(message.result);
      return;
    }
    const task = this.handleEvent(message);
    this.eventTasks.add(task);
    void task.finally(() => this.eventTasks.delete(task)).catch(() => {});
  }

  private async handleEvent(message: CdpResponse): Promise<void> {
    const params = message.params ?? {};
    if (message.method === 'Target.attachedToTarget') {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
      const targetInfo = params.targetInfo as { targetId?: string; type?: string } | undefined;
      if (sessionId) {
        try {
          if (isNetworkCapableTargetType(targetInfo?.type) && targetInfo?.targetId) {
            await this.setupTarget(targetInfo.targetId, sessionId);
          } else {
            await this.command('Runtime.runIfWaitingForDebugger', {}, sessionId);
          }
        } catch {
          this.logger.warn('browser proxy authentication could not prepare a new browser target');
          // Through the shared task, not failClosed() directly. During startup
          // this is awaited by start(); afterwards it runs as a loose event
          // task, so a teardown begun here must be visible to dispose() —
          // otherwise a stop+start can land a replacement browser that this
          // cleanup then kills.
          await this.beginTeardown();
        }
      }
      return;
    }
    if (message.method === 'Target.detachedFromTarget') {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
      if (sessionId) {
        this.sessions.delete(sessionId);
        const targetId = this.sessionTargets.get(sessionId);
        this.sessionTargets.delete(sessionId);
        if (targetId) this.targetSetups.delete(targetId);
        for (const key of this.authAttempts.keys()) {
          if (key.startsWith(`${sessionId}:`)) this.authAttempts.delete(key);
        }
      }
      return;
    }
    if (message.method === 'Fetch.requestPaused') {
      const requestId = typeof params.requestId === 'string' ? params.requestId : undefined;
      if (requestId && message.sessionId) {
        // Lifetime request-level enforcement of the fail-closed launch policy:
        // HTTPS to an allowlisted hostname continues; everything else fails
        // before egress, regardless of how the navigation was initiated
        // (startup tab, manual address bar, timer, meta refresh, popup).
        const request = params.request as { url?: unknown } | undefined;
        const requestUrl = typeof request?.url === 'string' ? request.url : '';
        const allowed = await isBrowserProxyRequestUrlAllowedAsync(requestUrl, this.route, {
          ...(this.lookupFn ? { lookupFn: this.lookupFn } : {}),
        });
        try {
          if (allowed) {
            await this.command('Fetch.continueRequest', { requestId }, message.sessionId);
          } else {
            await this.command(
              'Fetch.failRequest',
              { requestId, errorReason: 'BlockedByClient' },
              message.sessionId,
            );
          }
        } catch {
          // The request may have been cancelled while the browser restarted.
        }
      }
      return;
    }
    if (message.method === 'Fetch.authRequired') {
      const requestId = typeof params.requestId === 'string' ? params.requestId : undefined;
      const challenge = params.authChallenge as { source?: string } | undefined;
      if (!requestId || !message.sessionId) return;
      const attemptKey = `${message.sessionId}:${requestId}`;
      const attempts = (this.authAttempts.get(attemptKey) ?? 0) + 1;
      this.authAttempts.set(attemptKey, attempts);
      this.evictOldestAuthAttempts();
      const response = challenge?.source !== 'Proxy'
        ? 'Default'
        : this.hasCredentials && attempts === 1
          ? 'ProvideCredentials'
          : 'CancelAuth';
      try {
        await this.command(
          'Fetch.continueWithAuth',
          {
            requestId,
            authChallengeResponse: {
              response,
              ...(response === 'ProvideCredentials'
                ? { username: this.route.username ?? '', password: this.route.password ?? '' }
                : {}),
            },
          },
          message.sessionId,
        );
      } catch {
        // The request failure is surfaced by the browser navigation itself.
      }
      if (response !== 'ProvideCredentials') this.authAttempts.delete(attemptKey);
    }
  }

  /**
   * Bound the challenge-attempt map without depending on CDP event ordering.
   *
   * There is no documented guarantee that `Fetch.requestPaused` follows the
   * `Fetch.authRequired` for a given request, nor that it fires exactly once,
   * so it cannot serve as a completion signal: deleting on it could drop a
   * live counter and let a repeat challenge re-send credentials. Instead cap
   * the map and evict oldest-first — Map preserves insertion order, and only
   * the newest entries can belong to challenges still in flight. The cap is
   * far above any plausible concurrent-challenge count, so a real retry is
   * never evicted before its second challenge arrives.
   */
  private evictOldestAuthAttempts(): void {
    while (this.authAttempts.size > MAX_TRACKED_AUTH_ATTEMPTS) {
      const oldest = this.authAttempts.keys().next();
      if (oldest.done) return;
      this.authAttempts.delete(oldest.value);
    }
  }

  /**
   * Start teardown once, and keep the promise that is actually doing the work.
   *
   * A dropped socket fires `error` and then `close`, so this runs twice. The
   * second `failClosed()` returns immediately — `failed` is set synchronously
   * before its first await — and assigning that already-resolved promise over
   * `this.teardown` would make `dispose()` await nothing, reopening the window
   * where a replacement browser gets killed by the old cleanup. Only the first
   * call's promise is retained.
   */
  private beginTeardown(): Promise<void> {
    this.teardown ??= this.failClosed();
    // Returned so callers that CAN wait (the startup path) do, while
    // fire-and-forget callers still register the same task for dispose().
    return this.teardown;
  }

  private async failClosed(): Promise<void> {
    if (this.failed || this.closing) return;
    this.failed = true;
    // Block the host route before attempting browser teardown. Browser.close
    // can itself fail if the CDP channel is already unhealthy; the host must
    // still refuse ordinary traffic until a later stop is verified.
    this.onFailure();
    await this.command('Browser.close').catch(() => {});
    // The common failure IS a dead socket — command() rejects outright when the
    // channel is not OPEN, so the call above is a no-op precisely when teardown
    // matters most. Blocking the host only stops future host calls; pages and
    // workers already running keep their network access, and with this guard
    // gone the DNS/private-address check is gone with it, leaving the
    // hostname-only PAC. Close over a fresh connection instead.
    await this.closeBrowserWithoutOwnSocket();
  }

  /**
   * Terminate the browser without relying on this coordinator's socket.
   *
   * `closeAdoptedManagedBrowser` dials the CDP endpoint anew and verifies exit,
   * so it still works when our own channel has dropped. Ownership is checked
   * against the managed profile there, so this cannot close a stranger.
   */
  private async closeBrowserWithoutOwnSocket(): Promise<void> {
    const cdpHttpUrl = this.cdpHttpUrl;
    const expectedUserDataDir = this.managedUserDataDir;
    if (!cdpHttpUrl || !expectedUserDataDir) return;
    let closed = false;
    try {
      closed = await closeAdoptedManagedBrowser(cdpHttpUrl, expectedUserDataDir);
    } catch {
      closed = false;
    }
    if (closed) return;
    // A `false` return is not an edge case here — it is the expected outcome
    // when CDP itself is the thing that broke. Leaving it there keeps a browser
    // running whose Fetch gate died with the connection: blocking new host
    // calls does nothing about pages that are already loaded and still
    // reaching the network. Every CDP-based remedy has now failed, so fall
    // through to the OS.
    await this.terminateManagedChromeProcess(expectedUserDataDir);
  }

  /**
   * Terminate the managed browser without CDP, then verify it is gone.
   *
   * Only reachable once both the coordinator's socket and a fresh CDP
   * connection have failed.
   *
   * The lock records a PID; it does not prove that PID is still Chrome. A crash
   * can leave the lock behind and the OS recycles PIDs, so signalling on the
   * lock alone can SIGKILL an unrelated process — the one failure here that is
   * worse than doing nothing. Require positive identity first: the PID must
   * actually hold the CDP port. No probe, no signal (Windows has neither lock
   * nor probe), leaving the host's verified-stop requirement as the backstop.
   */
  private async terminateManagedChromeProcess(managedUserDataDir: string): Promise<void> {
    // Belt-and-braces against killing a replacement browser. dispose() awaits
    // this work before it flips `closing`, so the ordinary path cannot race;
    // this covers a dispose that lands while the await chain is already
    // unwinding. Every identity check below would PASS for a legitimately
    // restarted Chrome — same profile, same port — so "is it ours" cannot
    // distinguish the two and only sequencing can.
    if (this.closing) return;
    const cdpPort = Number(new URL(this.cdpHttpUrl ?? 'http://127.0.0.1:18800').port || 80);
    const pid = readManagedProfileOwnerPid(managedUserDataDir);
    if (pid === null) {
      // No usable lock. Windows never writes one, but this is also reached on
      // macOS/Linux when the lock is missing, unreadable, or names a dead PID —
      // so this path is not Windows-only and cannot assume anything about the
      // platform.
      //
      // Resolve the owner from the loopback CDP port, then VERIFY it. Holding
      // the port is not identity: Chrome may have exited and any other program
      // can take a fixed port, and there is a reuse window between the lookup
      // and the kill. So each candidate must present a command line carrying
      // both our --user-data-dir and our --remote-debugging-port, re-checked
      // immediately before signalling.
      //
      // killPortOwner refuses protected/self PIDs and uses `taskkill /T`, which
      // matters because Chrome's renderer children would otherwise be orphaned.
      const reclaimLogger = {
        info: (message: string, meta?: Record<string, unknown>) => this.logger.warn(message, meta),
        warn: (message: string, meta?: Record<string, unknown>) => this.logger.warn(message, meta),
      };
      for (const owner of await findPortOwnerPids(cdpPort)) {
        if (!(await isManagedChromeProcess({
          pid: owner,
          cdpPort,
          userDataDir: managedUserDataDir,
        }))) {
          this.logger.warn('skipping CDP port owner: not the managed browser', { pid: owner });
          continue;
        }
        await killPortOwner(owner, reclaimLogger);
      }
      // Issuing the kill is not exit. taskkill can fail on permissions, lose a
      // race, or return an error, and killPortOwner reports that as false —
      // which the loop above deliberately does not act on per-PID, since a
      // partial failure still leaves the port to check. Verify centrally
      // instead: if the port is still held, nothing was actually torn down and
      // the caller must keep treating this route as untrusted.
      if (await isCdpPortListening(this.cdpHttpUrl ?? 'http://127.0.0.1:18800')) {
        this.logger.warn(
          'managed browser survived proxy-guard teardown; route stays blocked until a verified stop',
        );
      }
      return;
    }
    // Port ownership alone is not identity — verify the process is a Chrome
    // launched for THIS profile and port before signalling it.
    const lockedPidIsOurs = async (): Promise<boolean> => managedProfilePidOwnsCdpPort(pid, cdpPort)
      && await isManagedChromeProcess({ pid, cdpPort, userDataDir: managedUserDataDir });
    if (!(await lockedPidIsOurs())) {
      this.logger.warn(
        'skipping managed browser termination: locked PID is not the managed browser',
      );
      return;
    }
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      // Revalidate at the TOP of each iteration, immediately before signalling.
      // Checking after the kill and before the sleep is not equivalent: the
      // window that matters is the delay itself, during which SIGTERM can take
      // effect and the OS can hand the PID to something else. A verdict taken
      // before that wait is stale by the time SIGKILL is sent.
      if (!(await lockedPidIsOurs())) return;
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone, or not ours to signal; the next check is the arbiter.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (readManagedProfileOwnerPid(managedUserDataDir) !== null) {
      this.logger.warn(
        'managed browser survived proxy-guard teardown; route stays blocked until a verified stop',
      );
    }
  }

  private async drainEventTasks(): Promise<void> {
    await Promise.allSettled([...this.eventTasks]);
  }

  private command(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('proxy authentication channel is not open'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('proxy authentication command timed out'));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('proxy authentication command failed'));
      }
    });
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
