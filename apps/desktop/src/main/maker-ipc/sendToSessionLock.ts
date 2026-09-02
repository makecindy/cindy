import { createLogger } from '../logger.js';

const log = createLogger('maker-ipc:send-to-session-lock');

/**
 * Per-session send/route serialization. Every local send path (maker:send,
 * programmatic bot/guardian delivery, runtime control mutations, card actions)
 * funnels through this map so one session's route decision stays atomic.
 *
 * NOTE: isSessionInTurn is turn-level (single SDK call) semantics, unlike
 * Session.getStatus() lifecycle (active/closed) and unlike the short-lived
 * background-throttling keepalive after terminal.
 *
 * Leak watchdog (PR #2829 QA): an entry whose holder never settles used to pin
 * the map forever — one hung critical section bricked every later programmatic
 * send to that session (outbox retries queued behind `waitPrev`, guardian
 * inbox dispatch wedged mid-`drainBot`, worker idle-close blocked), while UI
 * direct sends kept working and masked the deadlock. Entries are therefore
 * stored behind a bail gate: after `BAIL_MS` the map entry settles on its own
 * so queued waiters proceed. The stuck holder keeps running as a zombie; that
 * is the lesser evil — the critical section's writes are DB-backed with
 * clientId dedup and turn-start guards, the same protections that already
 * tolerate lock-external UI sends. Every bail escalates via `log.warn` with
 * the holder's stage so the original hang point (getSessionMeta /
 * getSessionRowSnapshot / ensureQueueRestored / …) is identifiable from logs.
 */
export const sendToSessionLocks = new Map<string, Promise<unknown>>();

const SEND_LOCK_WARN_MS = 30_000;
const SEND_LOCK_BAIL_MS = 5 * 60_000;

export function hasSendToSessionLock(sessionId: string): boolean {
  return sendToSessionLocks.has(sessionId);
}

/**
 * Install `run` as the session's current lock entry and return a promise that
 * mirrors `run`'s real settlement for the caller. The stored map entry settles
 * when `run` settles OR when the bail timeout fires, whichever comes first.
 */
function installSendToSessionLockEntry(
  sessionId: string,
  run: Promise<unknown>,
  getStage?: () => string | undefined,
): Promise<unknown> {
  let bail!: () => void;
  const bailGate = new Promise<void>((resolve) => {
    bail = resolve;
  });
  const warnTimer = setTimeout(() => {
    log.warn('sendToSession lock still held after expected budget', {
      sessionId,
      heldMs: SEND_LOCK_WARN_MS,
      stage: getStage?.() ?? 'unknown',
    });
  }, SEND_LOCK_WARN_MS);
  warnTimer.unref?.();
  const bailTimer = setTimeout(() => {
    log.warn('sendToSession lock bailed out; later senders proceed while the stuck holder finishes', {
      sessionId,
      heldMs: SEND_LOCK_BAIL_MS,
      stage: getStage?.() ?? 'unknown',
    });
    bail();
  }, SEND_LOCK_BAIL_MS);
  bailTimer.unref?.();
  // The map entry must never reject: waiters chain on it with `.catch(() => undefined)`
  // only as a legacy guard, and a rejecting entry would surface as an unhandled
  // rejection once the bail gate races it.
  const entry = Promise.race([run.then(() => undefined, () => undefined), bailGate]);
  void entry.finally(() => {
    clearTimeout(warnTimer);
    clearTimeout(bailTimer);
    if (sendToSessionLocks.get(sessionId) === entry) {
      sendToSessionLocks.delete(sessionId);
    }
  });
  sendToSessionLocks.set(sessionId, entry);
  return run;
}

/**
 * Acquire the per-session send/route lock until the returned release callback runs.
 *
 * Direct-send callers need this lease form because applying a deferred agent switch,
 * refreshing the resulting live Session, and calling Session.send happen in different
 * modules but must remain one atomic route decision.
 */
export async function acquireSendToSessionLock(sessionId: string): Promise<() => void> {
  const previous = sendToSessionLocks.get(sessionId);
  const waitPrevious = previous ? previous.catch(() => undefined) : Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const run = waitPrevious.then(() => gate);
  installSendToSessionLockEntry(sessionId, run);
  await waitPrevious;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGate();
  };
}

/** Serialize every local send / runtime release / route mutation for one session. */
export async function withSendToSessionLock<T>(
  sessionId: string,
  task: () => Promise<T>,
): Promise<T> {
  const release = await acquireSendToSessionLock(sessionId);
  try {
    return await task();
  } finally {
    release();
  }
}

/**
 * Chain-form lock entry for `sendToSessionInternal`: `run` both performs the
 * critical section and IS the lock occupancy. Returns the caller-observable
 * promise (identical settlement to `run`); the map entry additionally bails
 * out after `SEND_LOCK_BAIL_MS`. `getStage` exposes the critical section's
 * current await for watchdog logs.
 */
export function trackSendToSessionLockRun<T>(
  sessionId: string,
  run: Promise<T>,
  getStage?: () => string | undefined,
): Promise<T> {
  installSendToSessionLockEntry(sessionId, run as Promise<unknown>, getStage);
  return run;
}
