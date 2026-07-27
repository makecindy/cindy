// Electron-free core of the browser runtime's quit-time cleanup, split out so it
// is unit-testable without importing electron (browser.ts pulls in `app` via
// browser-runtime-env). browser.ts wires the real singleton runtime + logger into
// `stopRuntimeForQuit`; tests inject fakes. (Same pattern as the electron-free
// `extractBrowserAvailability` split.)
import type { BrowserControlRuntime } from '@cindy/browser-control-runtime';

/** Minimal logger surface used here — matches the unified logger's `warn`. */
interface QuitLogger {
  warn(message: string, ...args: unknown[]): void;
}

/** `stopRuntimeForQuitIfUsed` additionally logs the skip decision at info. */
interface QuitInfoLogger extends QuitLogger {
  info(message: string, ...args: unknown[]): void;
}

/**
 * Usage-tracking wrapper around the vendored runtime: records whether ANY
 * request was dispatched through it this session. The quit path uses this to
 * skip the stop dispatch entirely when the runtime was never touched — the
 * vendored dispatch bridge (`dispatchBrowserControlRequest`) unconditionally
 * boots the browser control service (dynamic playwright import included)
 * before routing ANY action, `stop` included, so an unguarded quit-time stop
 * on a browser-less session would START the very service it is shutting down.
 * That service boot is an exit-hang amplifier we must not run during quit.
 */
export interface UsageTrackedBrowserRuntime extends Pick<BrowserControlRuntime, 'call'> {
  /**
   * True iff a NON-stop `call` produced an HTTP response and no successful
   * `stop` has invalidated it since — i.e. the control service provably
   * booted and answered, and (as far as dispatch ordering can tell) has not
   * been torn down again afterwards.
   */
  everCalled(): boolean;
  /**
   * Resolves once every in-flight call — `stop` included — has settled
   * (results and rejections are swallowed). The quit path awaits this before
   * reading `everCalled()`:
   *  - a still-booting first call must not be misread as "never used"
   *    (review P1): it can finish launching Chrome right after we skipped
   *    the stop, orphaning the process and its locked user-data-dir;
   *  - an in-flight backend-switch `stop` must settle first too (review):
   *    reading usage before its reset lands would make quit dispatch a
   *    second stop against a service that is already going down.
   */
  settleInFlight(): Promise<void>;
  /**
   * Quit gate (review P1): after this, NEW non-stop calls are rejected instead
   * of dispatched. Without it a call admitted between "settleInFlight saw an
   * empty set" and "everCalled read" could boot the service mid-shutdown after
   * the skip decision was already made.
   */
  beginQuiescence(): void;
}

export function trackBrowserRuntimeUsage(
  inner: Pick<BrowserControlRuntime, 'call'>,
): UsageTrackedBrowserRuntime {
  let everCalled = false;
  let quiescing = false;
  // Dispatch-order barrier (review ×3, two rounds): every call gets a
  // monotonically increasing dispatch sequence; a SUCCESSFUL stop raises the
  // barrier to its own sequence. A non-stop response only marks usage when
  // its dispatch sequence is ABOVE the barrier:
  //  - calls dispatched BEFORE the stop settle late against a torn-down
  //    service → blocked (late settle must not re-enable the quit stop);
  //  - calls admitted AFTER the stop was dispatched (e.g. a start racing
  //    ExternalChromeBackend.dispose during a backend switch) are newer than
  //    the barrier → their response re-marks usage, so quit still cleans up
  //    the freshly launched Chrome (an epoch-per-stop scheme wrongly
  //    invalidated these).
  let dispatchSeq = 0;
  let stopInvalidationBarrier = -1;
  const inFlight = new Set<Promise<unknown>>();
  return {
    call(request) {
      if (quiescing && request.action !== 'stop') {
        // Resolve (not reject): the underlying runtime's contract is that
        // `call` always resolves a BrowserControlResult — callers only check
        // `res.ok` and a rejection here would surface as an unhandled
        // rejection (review). No `status` field, so this never counts as
        // usage either.
        return Promise.resolve({
          ok: false,
          action: request.action,
          errorCode: 'BROWSER_RUNTIME_UNAVAILABLE',
          message: 'browser runtime is shutting down — new calls are not dispatched',
        });
      }
      const result = inner.call(request);
      // Mark "used" only when the response carries an HTTP `status`, and only
      // for non-stop actions (review feedback, three P1s across two rounds):
      //  - `status` present means the dispatcher really answered over the
      //    control service — it booted. This includes ok:false HTTP >=400
      //    responses (service is up, the action failed) which MUST count,
      //    otherwise quit skips the stop and leaks the running service.
      //  - `status` absent covers planDispatch rejections and thrown boots
      //    (`BROWSER_RUNTIME_UNAVAILABLE` / catch-path failures): service
      //    liveness unproven — counting those would make the quit-time stop
      //    re-run the very boot we're avoiding.
      //  - `stop` itself is teardown, not usage — ExternalChromeBackend.dispose
      //    dispatches one during backend switching, and counting it would make
      //    the quit path dispatch a second stop that re-boots the service.
      // A wrongly-skipped quit-stop is recovered by the vendored stale-lock
      // path on next launch (see stopRuntimeForQuit docs).
      const mySeq = dispatchSeq;
      dispatchSeq += 1;
      let settled: Promise<unknown>;
      if (request.action !== 'stop') {
        settled = result.then(
          (response) => {
            const status = (response as { status?: unknown } | null | undefined)?.status;
            // Barrier check: only calls dispatched after the latest
            // successful stop may (re-)mark usage — see barrier comment.
            if (typeof status === 'number' && mySeq > stopInvalidationBarrier) {
              everCalled = true;
            }
          },
          () => {
            // Rejected dispatch proves nothing about service liveness — ignore.
          },
        );
      } else {
        // A settled SUCCESSFUL stop proves the service is down again (review
        // P1: ExternalChromeBackend.dispose stops it mid-session on backend
        // switch). Keeping usage true past that point would make the
        // quit-time stop boot the already-stopped service — the exact
        // startup this wrapper exists to prevent. The barrier only
        // invalidates calls dispatched BEFORE this stop; anything admitted
        // after it can re-mark usage. ok:false / rejected stops leave state
        // unchanged: the service may still be up, and a possibly-redundant
        // quit stop is the safe direction there.
        settled = result.then(
          (response) => {
            const r = response as
              | { ok?: unknown; data?: { stopped?: unknown } | null }
              | null
              | undefined;
            // Only a stop that actually tore something down invalidates usage
            // (review P1): the vendored /stop reports `data.stopped`, and a
            // no-op stop (`stopped:false` — nothing running at that instant,
            // e.g. it raced a cold `start` whose launch it did NOT cover)
            // must leave usage and the barrier untouched, so the racing
            // start's later response re-marks usage and quit still cleans up
            // the Chrome it launched. Vendored state machine guarantees
            // `stopped:true` only after the launch finished (`running` is
            // assigned post-launch), so a mid-launch race always lands here
            // as `stopped:false`.
            if (r?.ok === true && r.data?.stopped === true) {
              everCalled = false;
              stopInvalidationBarrier = Math.max(stopInvalidationBarrier, mySeq);
            }
          },
          () => {},
        );
      }
      // Stops are tracked in inFlight too (review): settleInFlight must let a
      // racing backend-switch stop land its usage reset before the quit path
      // reads everCalled, or quit dispatches a second stop.
      inFlight.add(settled);
      void settled.finally(() => inFlight.delete(settled));
      return result;
    },
    everCalled: () => everCalled,
    settleInFlight: async () => {
      // Snapshot-loop until quiescent: an in-flight call may itself trigger
      // follow-up calls (e.g. login flow chaining start → focus).
      while (inFlight.size > 0) {
        await Promise.all([...inFlight]);
      }
    },
    beginQuiescence: () => {
      quiescing = true;
    },
  };
}

/**
 * Quit-path stop, short-circuited when the runtime saw zero traffic this
 * session (see `trackBrowserRuntimeUsage`). If any request DID go through,
 * the control service already exists, so dispatching `stop` cannot newly
 * boot anything — it only tears down whatever the session created.
 */
export async function stopRuntimeForQuitIfUsed(
  runtime: UsageTrackedBrowserRuntime,
  logger: QuitInfoLogger,
): Promise<void> {
  // Quit can race the very first call (e.g. openBrowserForLogin still awaiting
  // `start`): close the gate to NEW calls first, then wait for in-flight ones
  // to settle before deciding — otherwise a still-booting Chrome would be
  // misread as "never used" and outlive the app, or a call admitted right
  // after the settle-check could boot the service mid-shutdown (review P1).
  // Bounded externally: this runs inside the async disposer phase (timeoutMs
  // race) with the hard-kill watchdog behind it.
  runtime.beginQuiescence();
  await runtime.settleInFlight();
  if (!runtime.everCalled()) {
    logger.info('browser runtime never used this session — skipping quit-time stop');
    return;
  }
  await stopRuntimeForQuit(runtime, logger);
}

/**
 * Stop the managed browser on the app-quit path.
 *
 * Swallows/logs all failures: this runs inside the lifecycle disposer chain
 * where throwing would only stall shutdown, and a failed stop is recovered by
 * the vendored stale-lock path on next launch. `stop` won't kill anything that
 * isn't running — but note the dispatch itself boots the browser control
 * service if it isn't up yet, so quit-time callers should prefer
 * `stopRuntimeForQuitIfUsed` to avoid starting services during shutdown.
 *
 * An unprofiled `stop` resolves the DEFAULT profile, which is sufficient because
 * the runtime is configured with exactly one managed profile (the sync.mjs patch
 * skips upstream's auto openclaw/user profiles, and an unknown profile name can't
 * launch). If multiple managed profiles are ever introduced, switch this to an
 * enumerate-and-stop so no launched Chrome leaks on quit.
 */
export async function stopRuntimeForQuit(
  runtime: Pick<BrowserControlRuntime, 'call'>,
  logger: QuitLogger,
): Promise<void> {
  try {
    const res = await runtime.call({ action: 'stop' });
    if (!res.ok) {
      logger.warn('browser runtime stop returned not-ok', {
        errorCode: res.errorCode,
        message: res.message,
      });
    }
  } catch (err) {
    logger.warn('browser runtime stop threw (ignored on quit path)', err);
  }
}
