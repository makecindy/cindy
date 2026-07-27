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
  /** True iff at least one `call` went through this wrapper. */
  everCalled(): boolean;
}

export function trackBrowserRuntimeUsage(
  inner: Pick<BrowserControlRuntime, 'call'>,
): UsageTrackedBrowserRuntime {
  let everCalled = false;
  return {
    call(request) {
      everCalled = true;
      return inner.call(request);
    },
    everCalled: () => everCalled,
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
