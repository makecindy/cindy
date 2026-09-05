// External Chrome backend — owns the managed browser process and its launch
// route. The route is launch state, not a mutable per-request option.

import {
  browserProxyRouteKey,
  parseBrowserProxyServer,
  redactBrowserProxyRoute,
  redactBrowserProxyText,
  type BrowserControlRequest,
  type BrowserControlResult,
  type BrowserProxyRoute,
} from '@cindy/browser-control-runtime';

import type {
  BackendRequest,
  BackendResult,
  BackendRuntimeShape,
  BrowserBackend,
} from './types.js';
import {
  BrowserProxyAuthCoordinator,
  closeAdoptedManagedBrowser,
  isManagedBrowserGone,
} from './proxy-auth.js';

interface BackendLogger {
  warn(message: string, ...args: unknown[]): void;
}

type MaybeLazy<T> = T | (() => T);

export interface ExternalChromeBackendOptions {
  /** Creates a runtime after the old browser has been stopped. */
  createRuntime?: (route: BrowserProxyRoute) => BackendRuntimeShape;
  /**
   * Loopback CDP HTTP base used by the request-gate coordinator.
   * May be lazy: Cindy-real can relocate off 18800 after construction.
   */
  cdpHttpUrl?: MaybeLazy<string>;
  /**
   * On-disk managed profile used to verify ownership before adopted-process
   * cleanup. May be lazy so it follows Cindy vs Cindy-real.
   */
  managedUserDataDir?: MaybeLazy<string | undefined>;
  createProxyAuth?: (
    route: BrowserProxyRoute,
    logger: BackendLogger,
    onFailure: () => void,
  ) => Pick<BrowserProxyAuthCoordinator, 'start' | 'dispose'>;
  /** Test seam for closing a process the vendored runtime did not launch. */
  closeAdoptedBrowser?: (cdpHttpUrl: string, expectedUserDataDir: string) => Promise<boolean>;
  /** Non-destructive liveness probe; must not close the browser. */
  isBrowserGone?: (cdpHttpUrl: string, managedUserDataDir?: string) => Promise<boolean>;
}

function invalidRequest(action: BrowserControlRequest['action'], message: string): BrowserControlResult {
  return {
    ok: false,
    action,
    errorCode: 'BROWSER_RUNTIME_INVALID_REQUEST',
    message,
  };
}

function actionWithProxy(result: BrowserControlResult, route: BrowserProxyRoute | undefined): BrowserControlResult {
  const data = result.data && typeof result.data === 'object' && !Array.isArray(result.data)
    ? { ...(result.data as Record<string, unknown>), proxy: redactBrowserProxyRoute(route) }
    : { proxy: redactBrowserProxyRoute(route) };
  return { ...result, data };
}

/**
 * Whether an interaction failed because containment could not be completed —
 * the runtime exhausted per-page, per-context and browser teardown and pages it
 * never validated may still be live. Matched on the message because the
 * vendored runtime reports policy outcomes as errors, not structured codes; the
 * phrase is fixed in LOCAL_PATCHES alongside the code that raises it.
 */
function mentionsUntornDownBrowser(message: unknown): boolean {
  return typeof message === 'string' && message.includes('could not be torn down');
}

function runningState(result: BrowserControlResult): 'running' | 'stopped' | 'unknown' {
  if (!result.ok) return 'unknown';
  const running = (result.data as { running?: unknown } | undefined)?.running;
  if (running === true) return 'running';
  if (running === false) return 'stopped';
  return 'unknown';
}

function isRunning(result: BrowserControlResult): boolean {
  return runningState(result) === 'running';
}

/**
 * Liveness of the managed browser PROCESS, as opposed to `runningState`, which
 * reports the vendored `running` field — and that field is `cdpReady`, i.e.
 * transport readiness. A busy-but-alive Chrome that misses the readiness probe
 * reports `running: false`, so `'stopped'` never means "no process".
 *
 * Every decision that would tear down a route, attribute an implicit launch, or
 * adopt a stranger must branch on this instead:
 *  - `running`  — cheap signal said running; trustworthy, no probe needed.
 *  - `gone`     — independently verified absent (non-destructive probe).
 *  - `unproven` — readiness says stopped but absence is NOT established.
 *                 Always fail closed here; never treat it as `gone`.
 */
type Liveness = 'running' | 'gone' | 'unproven';

/**
 * The queue covers every external-browser call, not only start/stop. Runtime
 * configuration is process-global in the vendored adapter, so serializing all
 * calls prevents a route snapshot from changing underneath an unrelated call.
 */
export class ExternalChromeBackend implements BrowserBackend {
  readonly kind = 'external' as const;
  private runtime: BackendRuntimeShape;
  private route: BrowserProxyRoute | undefined;
  private auth: Pick<BrowserProxyAuthCoordinator, 'start' | 'dispose'> | undefined;
  private transition: Promise<void> = Promise.resolve();
  private used = false;
  private routeBlocked = false;
  /**
   * Set when a failed start leaves a runtime whose configured route no longer
   * matches `route` (which never committed). A later verified stop must then
   * replace the runtime with direct config instead of trusting `route`.
   */
  private forceDirectOnReset = false;
  /**
   * Route the current runtime is *configured* for, as opposed to `route` (the
   * route of a browser confirmed to be running). Used to attribute an implicit
   * launch — `open`/`tabs` can start the browser without going through
   * `start`, which would otherwise leave `route` unknown and make the next
   * same-route `start` destroy the user's tabs as if adopting a stranger.
   */
  private runtimeRoute: BrowserProxyRoute = { mode: 'direct' };
  /**
   * Whether the browser was verifiably stopped while this runtime was current.
   * Only then can a later implicit launch be attributed to us; a process that
   * predates our ownership keeps an unknown route and the adopt-or-refuse path.
   */
  private runtimeOwnsNextLaunch = false;
  /**
   * True only when `routeBlocked` was set by an UNPROVEN liveness reading (a
   * readiness probe that missed while the process may still be alive). Such a
   * block is transient and must clear once the browser answers again.
   *
   * Blocks from any other cause — proxy-auth failure, an unverifiable stop, a
   * failed restart — are NOT transient: they mean the route can no longer be
   * trusted, and only a verified stop may lift them. Never clear those here.
   */
  private routeBlockedByUnprovenLiveness = false;
  private quiescing = false;

  constructor(
    runtime: BackendRuntimeShape,
    private readonly logger: BackendLogger,
    private readonly options: ExternalChromeBackendOptions = {},
  ) {
    this.runtime = runtime;
  }

  private resolveCdpHttpUrl(): string {
    const value = this.options.cdpHttpUrl;
    if (typeof value === 'function') return value();
    return value ?? 'http://127.0.0.1:18800';
  }

  private resolveManagedUserDataDir(): string | undefined {
    const value = this.options.managedUserDataDir;
    if (typeof value === 'function') return value();
    return value;
  }

  call(request: BackendRequest): Promise<BackendResult> {
    if (this.quiescing && request.action !== 'stop') {
      return Promise.resolve({
        ok: false,
        action: request.action,
        errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
        message: 'managed browser is shutting down; new calls are not accepted',
      });
    }
    return this.enqueue(() => this.handleCall(request));
  }

  /** Close the quit-time admission gate before enqueueing the final stop. */
  beginQuiescence(): void {
    this.quiescing = true;
  }

  async dispose(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.used) return;
      try {
        const stopped = await this.stopBrowser({ action: 'stop' });
        if (!stopped.ok) {
          this.logger.warn('managed browser stop during dispose failed', {
            errorCode: stopped.errorCode,
            message: redactBrowserProxyText(stopped.message ?? ''),
          });
        }
      } catch (err) {
        this.routeBlocked = true;
        this.logger.warn('managed browser stop during dispose threw', redactBrowserProxyText(err));
      }
    });
  }

  getEffectiveProxy(): ReturnType<typeof redactBrowserProxyRoute> {
    return redactBrowserProxyRoute(this.route);
  }

  private async handleCall(request: BackendRequest): Promise<BackendResult> {
    if (
      (request.proxyServer !== undefined || request.proxyAllowedHostnames !== undefined)
      && request.action !== 'start'
    ) {
      return invalidRequest(
        request.action,
        'proxyServer and proxyAllowedHostnames are only valid for action=start',
      );
    }

    if (this.routeBlocked && request.action !== 'status' && request.action !== 'stop') {
      return {
        ok: false,
        action: request.action,
        errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
        message: 'managed browser route is unknown after a failed restart; stop it before retrying',
      };
    }

    if (request.action === 'start') {
      let requested: BrowserProxyRoute;
      try {
        requested = parseBrowserProxyServer(
          request.proxyServer,
          request.proxyAllowedHostnames,
        );
      } catch (err) {
        return invalidRequest(request.action, redactBrowserProxyText(err));
      }
      return this.startInRoute(requested);
    }
    if (request.action === 'stop') {
      return this.stopBrowser(request);
    }

    // Many actions launch the browser implicitly — anything that resolves a tab
    // goes through the vendored ensureTabAvailable/ensureBrowserAvailable path,
    // not just open/tabs. Attributing such a launch requires knowing the
    // browser was NOT already running before the call: then the process is ours
    // and its route is this runtime's config. Without this, the next same-route
    // `start` treats our own browser as a stranger and closes the user's tabs
    // to "apply" a route already in effect.
    //
    // Infer from before/after status rather than an action allowlist: the list
    // of launching actions is a vendored implementation detail that drifts.
    // `runtimeOwnsNextLaunch` short-circuits the probe after a verified stop;
    // the probe itself only runs while the route is unknown, so it costs at
    // most one extra call per action until the first launch is attributed.
    // `status` is excluded because it cannot launch anything and its own
    // result already reports the state — probing before it would just double
    // every status call.
    //
    // Absence must be VERIFIED, not inferred from readiness: a surviving Chrome
    // whose probe timed out reads as stopped, and attributing its next action to
    // this runtime would label a stranger's process with our route.
    let mayOwnImplicitLaunch = false;
    if (this.route === undefined && request.action !== 'status') {
      if (this.runtimeOwnsNextLaunch) {
        mayOwnImplicitLaunch = true;
      } else if ((await this.resolveLiveness()) === 'gone') {
        mayOwnImplicitLaunch = true;
      } else {
        // A process is alive but its route is unknown — e.g. Cindy restarted
        // and inherited a Chrome launched by a previous proxied start. Skipping
        // attribution is not enough: running the action anyway attaches to that
        // process, so traffic egresses through the OLD proxy while this backend
        // reports direct, and the previous instance's lifetime CDP request gate
        // is gone with no way to reinstate it. Fail closed and require an
        // explicit start (which adopts or replaces it) or a stop.
        return {
          ok: false,
          action: request.action,
          errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
          message: 'managed browser route is unknown for a running browser; start or stop it before other actions',
        };
      }
    }

    const result = await this.runtime.call(this.withoutProxy(request));
    if (typeof result.status === 'number') this.used = true;
    // Not gated on result.ok: an action can launch Chrome and *then* fail
    // (e.g. snapshot resolves a tab before rejecting an invalid label/format
    // combination). The browser is ours either way, so attribute from the
    // post-call status rather than from whether the action succeeded.
    if (this.route === undefined && mayOwnImplicitLaunch) {
      // Most actions (`open` returns a tab object, `tabs` a list) carry no
      // `running` field, so their state reads as 'unknown'. Ask `status`
      // explicitly rather than inferring launch from a response shape.
      const state = runningState(result) === 'running'
        ? 'running'
        : runningState(await this.runtime.call({ action: 'status' }));
      if (state === 'running') {
        this.route = this.runtimeRoute;
        this.runtimeOwnsNextLaunch = false;
        // An action can launch Chrome and then fail without a numeric status,
        // which is what `used` is normally set from. Establishing a running
        // browser here IS the proof that we own one, so record it or dispose()
        // takes its `if (!this.used) return` path and leaves a headed Chrome
        // alive after Cindy quits.
        this.used = true;
      }
    }
    if (request.action === 'status') {
      // `status` is a PASSIVE poll (availability card, Settings login-browser
      // check), so every branch here must be non-destructive — never the
      // `Browser.close` that ownership verification uses.
      const liveness = await this.resolveLiveness(result);
      if (liveness === 'running') {
        // Clear ONLY a block this path set from an unproven reading: the
        // process is demonstrably alive on the route we still hold, so leaving
        // it blocked would strand every action but status/stop forever. A block
        // from auth failure or an unverifiable stop means the route itself is
        // untrusted and must survive until a verified stop.
        if (this.routeBlockedByUnprovenLiveness && this.route) {
          this.routeBlocked = false;
          this.routeBlockedByUnprovenLiveness = false;
        }
        return actionWithProxy(result, this.routeBlocked ? undefined : this.route);
      }
      if (liveness === 'gone') {
        await this.disposeAuth();
        this.resetStoppedRuntime();
        return actionWithProxy(result, undefined);
      }
      // `unproven`: readiness says stopped but the process is not verifiably
      // gone. Applies to DIRECT routes too — clearing a live direct route makes
      // the next start treat our own browser as a stranger and close the user's
      // tabs. Keep the route and refuse ordinary traffic until a verified stop.
      if (this.route) {
        // Only claim the transient flag when THIS branch is what blocks the
        // route. A block already in place came from a cause only a verified
        // stop may lift (auth failure, an unverifiable stop, an untorn-down
        // browser); marking it transient here would let the next `running`
        // status clear it above, re-admitting `tabs`/`navigate` on a process
        // whose CDP request gate is already dead. Passive status polling from
        // the availability card is enough to hit that sequence.
        if (!this.routeBlocked) {
          this.routeBlockedByUnprovenLiveness = true;
        }
        this.routeBlocked = true;
        return actionWithProxy(result, this.route);
      }
      return actionWithProxy(result, undefined);
    }
    // The runtime can validate and quarantine pages, but it cannot verify that
    // a browser process exited — only the host owns teardown. When it reports
    // that every containment step failed and unvalidated pages may still be
    // live, the route can no longer be trusted: block it until a verified stop.
    // Not an `unproven liveness` block, so a later status must NOT clear it.
    if (!result.ok && mentionsUntornDownBrowser(result.message)) {
      this.routeBlocked = true;
      this.routeBlockedByUnprovenLiveness = false;
      // Blocking only stops FUTURE backend calls. The pages that survived
      // containment are already loaded and keep executing and reaching the
      // network — and in direct mode there is no lifetime request gate to catch
      // them. The runtime cannot end a process; the host can, so do it here
      // rather than leaving them live until someone happens to call stop.
      try {
        const stopped = await this.stopBrowser({ action: 'stop' });
        if (!stopped.ok) {
          this.logger.warn('browser teardown after popup containment failure could not be verified');
        }
      } catch (err) {
        this.logger.warn(
          'browser teardown after popup containment failure threw',
          redactBrowserProxyText(err),
        );
      }
      // Deliberately NOT re-asserting the block afterwards. A verified stop
      // means the surviving pages are gone, which is the whole objective here —
      // there is nothing left to distrust, and resetStoppedRuntime has already
      // cleared the route. If the stop could NOT be verified it leaves the
      // block in place itself, which is the case that must stay blocked.
    }
    return result;
  }

  private async startInRoute(requested: BrowserProxyRoute): Promise<BackendResult> {
    const requestedKey = browserProxyRouteKey(requested);
    const currentStatus = await this.runtime.call({ action: 'status' });
    if (typeof currentStatus.status === 'number') this.used = true;
    const state = runningState(currentStatus);
    // Defence in depth: `handleCall` already refuses `start` while the route is
    // blocked, so this branch is not reachable in that state today. Keep the
    // guard anyway — the idempotent shortcut must never hand back success for a
    // route whose request gate is gone, and that invariant should not depend on
    // an admission check several frames up staying exactly as it is.
    // `running` is READINESS, not liveness: a busy browser reports false while
    // very much alive. Falling through on that would take an owned, unchanged
    // route into stopCurrentRuntime() and relaunch — destroying the user's open
    // tabs to "apply" a route already in effect. So when the route matches,
    // confirm the process is actually gone before treating this as a restart.
    const sameRoute = this.route && browserProxyRouteKey(this.route) === requestedKey;
    const sameRouteAlive = sameRoute
      && !this.routeBlocked
      && (state === 'running' || (await this.resolveLiveness(currentStatus)) !== 'gone');
    if (sameRouteAlive) {
      return actionWithProxy({
        ok: true,
        action: 'start',
        status: currentStatus?.status ?? 200,
        data: currentStatus?.data,
      }, this.route);
    }

    // An unowned/pre-existing process has an unknown route. Vendored `stop`
    // cannot terminate it because process ownership is in-memory, so close it
    // through the dedicated loopback browser CDP endpoint and verify it exited.
    // `state === 'stopped'` only means the CDP readiness probe failed (the
    // vendored status sets running:cdpReady), not that no process exists. An
    // adopted Chrome whose handshake merely timed out would otherwise skip
    // ownership cleanup here, and the new runtime's longer ensureBrowserAvailable
    // retry could attach to that same process and report success — committing a
    // route whose proxy/PAC launch arguments were never applied. Require
    // verified absence before trusting 'stopped' on an unknown route.
    const processMayExist = state !== 'stopped'
      || (!this.route && (await this.resolveLiveness(currentStatus)) !== 'gone');

    if (processMayExist && !this.route) {
      const cdpHttpUrl = this.resolveCdpHttpUrl();
      const expectedUserDataDir = this.resolveManagedUserDataDir();
      if (!expectedUserDataDir) {
        return {
          ok: false,
          action: 'start',
          errorCode: 'BROWSER_RUNTIME_ACTION_FAILED',
          message: 'cannot apply browser proxy route because the pre-existing browser identity cannot be verified',
        };
      }
      const closed = await (this.options.closeAdoptedBrowser ?? closeAdoptedManagedBrowser)(
        cdpHttpUrl,
        expectedUserDataDir,
      );
      if (!closed) {
        return {
          ok: false,
          action: 'start',
          errorCode: 'BROWSER_RUNTIME_ACTION_FAILED',
          message: 'cannot apply browser proxy route because the pre-existing managed browser could not be stopped',
        };
      }
      await this.disposeAuth();
      this.route = undefined;
    } else if (processMayExist || this.route) {
      const stopped = await this.stopCurrentRuntime();
      if (!stopped.ok) return { ...stopped, action: 'start' };
    }

    const createRuntime = this.options.createRuntime;
    if (!createRuntime) {
      if (requested.mode === 'proxied') {
        return invalidRequest('start', 'the active browser backend cannot apply proxyServer');
      }
      return invalidRequest('start', 'managed browser runtime factory is unavailable');
    }

    let nextRuntime: BackendRuntimeShape;
    try {
      nextRuntime = createRuntime(requested);
    } catch (err) {
      this.resetStoppedRuntime();
      return {
        ok: false,
        action: 'start',
        errorCode: 'BROWSER_RUNTIME_INVALID_REQUEST',
        message: redactBrowserProxyText(err),
      };
    }
    this.runtime = nextRuntime;
    this.runtimeRoute = requested;
    this.runtimeOwnsNextLaunch = false;
    this.route = undefined;
    this.used = true;
    let started: BrowserControlResult;
    try {
      started = await nextRuntime.call({ action: 'start' });
    } catch (err) {
      await this.stopAndForget(nextRuntime);
      return {
        ok: false,
        action: 'start',
        errorCode: 'BROWSER_RUNTIME_ACTION_FAILED',
        message: redactBrowserProxyText(err),
      };
    }
    if (!started.ok) {
      await this.stopAndForget(nextRuntime);
      return {
        ...started,
        action: 'start',
        message: redactBrowserProxyText(started.message ?? 'browser start failed'),
      };
    }
    this.routeBlocked = false;

    // Every proxied launch gets the lifetime CDP guard: it enforces the
    // fail-closed HTTPS + hostname allowlist at the request level for all
    // targets (startup tabs, popups, timer/meta-refresh navigations) and
    // additionally answers proxy auth challenges when credentials exist.
    if (requested.mode === 'proxied') {
      const onFailure = () => {
        this.routeBlocked = true;
        // Not a readiness blip: the route is untrusted until a verified stop.
        this.routeBlockedByUnprovenLiveness = false;
      };
      const coordinator = this.options.createProxyAuth?.(requested, this.logger, onFailure)
        ?? new BrowserProxyAuthCoordinator(
          requested,
          this.logger,
          onFailure,
          undefined,
          this.resolveManagedUserDataDir(),
        );
      try {
        await coordinator.start(this.resolveCdpHttpUrl());
      } catch (err) {
        await coordinator.dispose();
        await this.stopAndForget(nextRuntime);
        return {
          ok: false,
          action: 'start',
          errorCode: 'BROWSER_RUNTIME_ACTION_FAILED',
          message: redactBrowserProxyText(err),
        };
      }
      if (this.routeBlocked) {
        await coordinator.dispose();
        await this.stopAndForget(nextRuntime);
        return {
          ok: false,
          action: 'start',
          errorCode: 'BROWSER_RUNTIME_ACTION_FAILED',
          message: 'proxy authentication failed while the managed browser was starting',
        };
      }
      this.auth = coordinator;
    }

    this.route = requested;
    return actionWithProxy(started, requested);
  }

  private async stopBrowser(request: BackendRequest): Promise<BackendResult> {
    const result = await this.runtime.call(this.withoutProxy(request));
    if (!result.ok) {
      this.routeBlocked = true;
      return actionWithProxy(result, this.route);
    }

    // `stopped: true` means "termination signals were sent", NOT "the process
    // exited": stopOpenClawChrome breaks its wait as soon as proc.killed is set
    // (which SIGTERM does synchronously), then SIGKILLs and returns without
    // awaiting exit, and stopRunningBrowser reports stopped:true regardless.
    // Readiness is not exit either — a busy Chrome reports running:false while
    // still alive. Confirm absence independently before releasing the proxy
    // guard, or a survivor keeps serving the old route while we reset to direct.
    let stoppedSafely = (await this.resolveLiveness()) === 'gone';
    // An adopted process (Cindy restarted while its managed Chrome stayed
    // alive) cannot be terminated by the vendored stop: its ownership state is
    // in-memory and empty, so `stop` reports ok with stopped:false forever.
    // Fall back to the same verified CDP close `start` uses, otherwise the
    // backend is stuck until the user closes Chrome by hand.
    if (!stoppedSafely && !this.route) {
      stoppedSafely = await this.closeAdoptedBrowserIfManaged();
    }
    if (stoppedSafely) {
      await this.disposeAuth();
      this.resetStoppedRuntime();
      // The vendored result can still say stopped:false when the status probe
      // or adopted-process cleanup is what proved the exit. Report what was
      // actually verified, so callers do not retry a completed stop.
      return actionWithProxy({
        ...result,
        data: { ...(result.data as Record<string, unknown> | undefined), stopped: true },
      }, undefined);
    }
    this.routeBlocked = true;
    return actionWithProxy({
      ok: false,
      action: 'stop',
      errorCode: 'BROWSER_RUNTIME_ACTION_FAILED',
      message: 'managed browser stop could not be verified',
    }, this.route);
  }

  /**
   * Close a pre-existing managed browser through the loopback CDP endpoint,
   * verifying profile identity first. Returns false when identity cannot be
   * established or the process would not exit, so callers stay fail-closed.
   */
  /**
   * Whether the managed browser is verifiably gone, without touching it.
   * Fails closed: an endpoint that answers, or an inconclusive probe, means
   * "still running".
   */
  /**
   * Resolve process liveness once, so no caller has to decide for itself
   * whether a `'stopped'` readiness signal can be trusted. Pass the result of a
   * call that already carries state to avoid a redundant `status` round trip.
   */
  private async resolveLiveness(known?: BrowserControlResult): Promise<Liveness> {
    const cheap = known ? runningState(known) : 'unknown';
    if (cheap === 'running') return 'running';
    const state = cheap === 'unknown'
      ? runningState(await this.runtime.call({ action: 'status' }))
      : cheap;
    if (state === 'running') return 'running';
    // Readiness says stopped/unknown — that is not proof of absence, so ask the
    // non-destructive probe. Anything short of verified absence is `unproven`.
    return (await this.confirmBrowserGone()) ? 'gone' : 'unproven';
  }

  private async confirmBrowserGone(): Promise<boolean> {
    try {
      return await (this.options.isBrowserGone ?? isManagedBrowserGone)(
        this.resolveCdpHttpUrl(),
      );
    } catch (err) {
      this.logger.warn('managed browser liveness probe failed', redactBrowserProxyText(err));
      return false;
    }
  }

  private async closeAdoptedBrowserIfManaged(): Promise<boolean> {
    const expectedUserDataDir = this.resolveManagedUserDataDir();
    if (!expectedUserDataDir) return false;
    try {
      return await (this.options.closeAdoptedBrowser ?? closeAdoptedManagedBrowser)(
        this.resolveCdpHttpUrl(),
        expectedUserDataDir,
      );
    } catch (err) {
      this.logger.warn('managed browser adopted close failed', redactBrowserProxyText(err));
      return false;
    }
  }

  private async stopCurrentRuntime(): Promise<BackendResult> {
    const stopped = await this.runtime.call({ action: 'stop' });
    if (!stopped.ok) {
      this.routeBlocked = true;
      this.logger.warn('managed browser route transition stop failed', {
        errorCode: stopped.errorCode,
        message: redactBrowserProxyText(stopped.message ?? ''),
      });
      return {
        ok: false,
        action: 'start',
        errorCode: 'BROWSER_RUNTIME_ACTION_FAILED',
        message: 'cannot change browser proxy route because the current browser could not be stopped',
      };
    }
    // Require verified absence before handing the route to a new launch. The
    // vendored `stopped: true` only means signals were sent, so it cannot skip
    // this check: a survivor would keep serving the old route under a new one.
    if ((await this.resolveLiveness()) !== 'gone') {
      this.routeBlocked = true;
      return {
        ok: false,
        action: 'start',
        errorCode: 'BROWSER_RUNTIME_ACTION_FAILED',
        message: 'cannot change browser proxy route because a pre-existing browser process could not be stopped',
      };
    }
    await this.disposeAuth();
    return stopped;
  }

  private async stopAndForget(runtime: BackendRuntimeShape): Promise<void> {
    let stoppedSafely = true;
    try {
      const stopped = await runtime.call({ action: 'stop' });
      if (!stopped.ok) {
        stoppedSafely = false;
      } else {
        // resolveLiveness() probes the shared managed endpoint, which is what
        // this runtime launched — readiness alone would again mistake a busy
        // browser for an exited one, and the vendored `stopped: true` only
        // reports that signals were sent, not that the process exited.
        stoppedSafely = (await this.resolveLiveness()) === 'gone';
      }
    } catch (err) {
      stoppedSafely = false;
      this.logger.warn('managed browser cleanup after failed start threw', redactBrowserProxyText(err));
    }
    if (this.runtime === runtime) {
      if (stoppedSafely) {
        this.resetStoppedRuntime(true);
      } else {
        // The runtime may still be configured for the requested route even
        // though the route never committed; remember that the next verified
        // stop must rebuild a direct runtime instead of trusting `route`.
        this.route = undefined;
        this.used = true;
        this.routeBlocked = true;
        this.forceDirectOnReset = true;
      }
    }
  }

  private resetStoppedRuntime(forceDirect = false): void {
    const replaceWithDirect =
      forceDirect || this.forceDirectOnReset || this.route?.mode === 'proxied';
    this.route = undefined;
    this.used = false;
    this.routeBlockedByUnprovenLiveness = false;
    // The browser was verifiably stopped while we held this runtime, so the
    // next launch through it is ours and its route is known.
    this.runtimeOwnsNextLaunch = true;
    if (!replaceWithDirect) {
      this.routeBlocked = false;
      return;
    }
    const createRuntime = this.options.createRuntime;
    if (!createRuntime) {
      this.routeBlocked = true;
      return;
    }
    try {
      this.runtime = createRuntime({ mode: 'direct' });
      this.runtimeRoute = { mode: 'direct' };
      this.routeBlocked = false;
      this.forceDirectOnReset = false;
    } catch (err) {
      this.routeBlocked = true;
      this.logger.warn('managed browser direct runtime reset failed', redactBrowserProxyText(err));
    }
  }

  private async disposeAuth(): Promise<void> {
    const auth = this.auth;
    this.auth = undefined;
    await auth?.dispose();
  }

  private withoutProxy(request: BackendRequest): BrowserControlRequest {
    const {
      proxyServer: _proxyServer,
      proxyAllowedHostnames: _proxyAllowedHostnames,
      ...rest
    } = request;
    return rest;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transition.then(operation, operation);
    this.transition = result.then(() => undefined, () => undefined);
    return result;
  }
}
