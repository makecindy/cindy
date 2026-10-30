import { createLogger } from '../logger.js';
import { AsyncLocalStorage } from 'node:async_hooks';

const log = createLogger('maker-ipc:send-to-session-lock');

// 当前异步链已持有的锁记录。ALS 沿 await/回调自动传播，用于识别同链重入：
// 锁临界区内部再触发一次取同把锁的调用（如 orca 派发排水队列时
// drain → sendToAgentAccepted）若照常排队，会等自己释放 = 自锁到 300s bail。
// 记录随临界区生命周期失效：未 await 的后台任务会继承 ALS 上下文，但外层
// 释放（或条目被 bail 结算）后 active=false，它必须重新排队而不是绕过新持有者。
interface HeldLockRecord {
  /** 本次获取实际安装的锁条目；仅用于在条目结算时标记失效，不用于判断归属。 */
  entry: Promise<unknown>;
  active: boolean;
}

const heldLockKeys = new AsyncLocalStorage<ReadonlyMap<string, HeldLockRecord>>();

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
 * Exception: an acquired explicit restart never bails while native close is
 * unresolved; its fence rejects later work until the real operation settles.
 */
export const sendToSessionLocks = new Map<string, Promise<unknown>>();

// A native close cannot be cancelled by a Promise timeout. Until it settles,
// reject new work rather than allowing the ordinary stale-lock watchdog to
// overlap a new runtime with that close. Only this session is fenced.
const restarts = new Map<string, { token: symbol; acquired: boolean }>();
const lockWaiters = new Map<string, Set<(error: Error) => void>>();

export function assertSessionNotRestarting(sessionId: string, token?: symbol): void {
  const restart = restarts.get(sessionId);
  if (restart && restart.token !== token) {
    throw new Error(
      'Session restart is still in progress; retry after the previous runtime closes',
    );
  }
}

export async function waitForSendToSessionLock(
  sessionId: string,
  previous: Promise<unknown> | undefined,
  token?: symbol,
): Promise<void> {
  assertSessionNotRestarting(sessionId, token);
  const waiters = lockWaiters.get(sessionId) ?? new Set<(error: Error) => void>();
  lockWaiters.set(sessionId, waiters);
  let rejectWait!: (error: Error) => void;
  const interrupted = new Promise<never>((_, reject) => {
    rejectWait = reject;
  });
  waiters.add(rejectWait);
  try {
    await Promise.race([Promise.resolve(previous).catch(() => undefined), interrupted]);
    assertSessionNotRestarting(sessionId, token);
  } finally {
    waiters.delete(rejectWait);
    if (waiters.size === 0 && lockWaiters.get(sessionId) === waiters) lockWaiters.delete(sessionId);
  }
}

export async function withSessionRestartLock<T>(
  sessionId: string,
  task: () => Promise<T>,
): Promise<T> {
  assertSessionNotRestarting(sessionId);
  const restart = { token: Symbol(sessionId), acquired: false };
  restarts.set(sessionId, restart);
  for (const reject of lockWaiters.get(sessionId) ?? []) {
    reject(new Error('Session restart is in progress'));
  }
  let release: (() => void) | undefined;
  try {
    release = await acquireSendToSessionLock(sessionId, restart.token);
    restart.acquired = true;
    return await task();
  } finally {
    restarts.delete(sessionId);
    release?.();
  }
}

const SEND_LOCK_WARN_MS = 30_000;
const SEND_LOCK_BAIL_MS = 5 * 60_000;

export function hasSendToSessionLock(sessionId: string): boolean {
  return sendToSessionLocks.has(sessionId);
}

/**
 * Install `run` as the session's current lock entry and return a promise that
 * mirrors `run`'s real settlement for the caller. The stored map entry settles
 * when `run` settles OR when the bail timeout fires, whichever comes first.
 *
 * Returns the **entry** this call installed (not the map tail): a later waiter's
 * `install` overwrites the map immediately, so ownership checks must use the
 * entry captured here instead of re-reading `sendToSessionLocks`.
 */
function installSendToSessionLockEntry(
  sessionId: string,
  run: Promise<unknown>,
  getStage?: () => string | undefined,
): Promise<unknown> {
  const previous = sendToSessionLocks.get(sessionId);
  let bail!: () => void;
  const bailGate = new Promise<void>((resolve) => {
    bail = resolve;
  });
  let settled = false;
  let warnTimer: ReturnType<typeof setTimeout> | undefined;
  let bailTimer: ReturnType<typeof setTimeout> | undefined;
  // Queued senders have not acquired the lock yet. Starting their watchdogs
  // while they wait would release the entire queue together after one hung
  // holder, allowing several route mutations to run concurrently.
  void Promise.resolve(previous)
    .catch(() => undefined)
    .then(() => {
      if (settled) return;
      warnTimer = setTimeout(() => {
        log.warn('sendToSession lock still held after expected budget', {
          sessionId,
          heldMs: SEND_LOCK_WARN_MS,
          stage: getStage?.() ?? 'unknown',
        });
      }, SEND_LOCK_WARN_MS);
      warnTimer.unref?.();
      bailTimer = setTimeout(() => {
        if (restarts.get(sessionId)?.acquired) return;
        log.warn(
          'sendToSession lock bailed out; later senders proceed while the stuck holder finishes',
          {
            sessionId,
            heldMs: SEND_LOCK_BAIL_MS,
            stage: getStage?.() ?? 'unknown',
          },
        );
        bail();
      }, SEND_LOCK_BAIL_MS);
      bailTimer.unref?.();
    });
  // The map entry must never reject: waiters chain on it with `.catch(() => undefined)`
  // only as a legacy guard, and a rejecting entry would surface as an unhandled
  // rejection once the bail gate races it.
  const entry = Promise.race([
    Promise.all([Promise.resolve(previous).catch(() => undefined), run.catch(() => undefined)]),
    bailGate,
  ]);
  void entry.finally(() => {
    settled = true;
    clearTimeout(warnTimer);
    clearTimeout(bailTimer);
    if (sendToSessionLocks.get(sessionId) === entry) {
      sendToSessionLocks.delete(sessionId);
    }
  });
  sendToSessionLocks.set(sessionId, entry);
  return entry;
}

/**
 * Acquire the per-session send/route lock until the returned release callback runs.
 *
 * Direct-send callers need this lease form because applying a deferred agent switch,
 * refreshing the resulting live Session, and calling Session.send happen in different
 * modules but must remain one atomic route decision. `getStage` is sampled when
 * a watchdog fires, so callers can identify the current await without logging
 * task content. Keep the getter alive until release, including lease handoffs.
 */
/** Lease form plus the entry this acquisition actually installed. */
async function acquireSendToSessionLockEntry(
  sessionId: string,
  restartToken?: symbol,
  getStage?: () => string | undefined,
): Promise<{ release: () => void; entry: Promise<unknown> }> {
  assertSessionNotRestarting(sessionId, restartToken);
  const previous = sendToSessionLocks.get(sessionId);
  const waitPrevious = previous ? previous.catch(() => undefined) : Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const run = waitPrevious.then(() => gate);
  const entry = installSendToSessionLockEntry(sessionId, run, getStage);
  try {
    await waitForSendToSessionLock(sessionId, previous, restartToken);
  } catch (error) {
    // Cancel this waiter, but its queue entry still waits for its predecessor.
    releaseGate();
    throw error;
  }
  let released = false;
  return {
    entry,
    release: () => {
      if (released) return;
      released = true;
      releaseGate();
    },
  };
}

export async function acquireSendToSessionLock(
  sessionId: string,
  restartToken?: symbol,
  getStage?: () => string | undefined,
): Promise<() => void> {
  const { release } = await acquireSendToSessionLockEntry(sessionId, restartToken, getStage);
  return release;
}

/** Serialize every local send / runtime release / route mutation for one session. */
export async function withSendToSessionLock<T>(
  sessionId: string,
  task: () => Promise<T>,
  getStage?: () => string | undefined,
): Promise<T> {
  // 同异步链重入直接放行：同一条链是天然串行的，与自身不存在竞争；
  // 不放行则嵌套获取会等自己持有的条目结算，自锁到 bail。跨链互斥不变。
  // 归属只看「本链临界区是否仍在进行」：外层 finally / 条目结算（含 300s
  // bail 强制结算）都把记录置为失效，继承上下文的后台任务因此落回正常排队。
  // 不能用 `sendToSessionLocks.get(sessionId)` 判断归属——那是队尾，后来的
  // 等待者一排队就会换掉它（会让持锁者的嵌套调用排到等待者后面，又成自锁）。
  const held = heldLockKeys.getStore()?.get(sessionId);
  if (held?.active) {
    // 重入放行仍要过重启栅栏：withSessionRestartLock 会先登记重启标记再排队，
    // 所以“重启已在等待”是一个与持锁无关的状态；跳过它会让嵌套发送在重启
    // 开始后继续执行，违反“重启开始后拒绝新工作”。
    assertSessionNotRestarting(sessionId);
    return task();
  }
  const { release, entry } = await acquireSendToSessionLockEntry(sessionId, undefined, getStage);
  const record: HeldLockRecord = { entry, active: true };
  // 条目结算（含 bail 强制结算）即视为不再持有：此时嵌套调用必须重新排队。
  void entry.then(() => {
    record.active = false;
  }, () => {
    record.active = false;
  });
  const nextHeld = new Map(heldLockKeys.getStore() ?? []);
  nextHeld.set(sessionId, record);
  try {
    return await heldLockKeys.run(nextHeld, task);
  } finally {
    record.active = false;
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

// A request may start before rewind and acquire the write lock only afterwards.
// Capture this generation before async preparation and validate inside the lock.
const rewindGenerations = new Map<string, number>();
export function getSessionRewindGeneration(sessionId: string): number {
  return rewindGenerations.get(sessionId) ?? 0;
}
export function advanceSessionRewindGeneration(sessionId: string): void {
  rewindGenerations.set(sessionId, getSessionRewindGeneration(sessionId) + 1);
}
