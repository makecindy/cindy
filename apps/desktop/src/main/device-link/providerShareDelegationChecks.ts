/** Local query scheduling only. Results never renew or cache an execution permission. */
export interface DelegationCheckInput {
  shareId: string; memberId: string; guestDeviceId: string; executorDeviceId: string;
}
export interface DelegationCheckResult {
  active: boolean; ownerDeviceId?: string; expiresAt?: number; generation?: string;
}
interface Scope { key: string; isCurrent(): boolean }

export class DelegationCheckDeferredError extends Error {
  readonly code = 'RATE_LIMITED';
  readonly statusCode = 429;
  constructor(readonly retryAt: number) {
    super('Provider share verification is temporarily deferred');
  }
}

const QUEUE_DEADLINE_MS = 15_000;
const MAX_PENDING = 128;
interface Job {
  key: string; input: DelegationCheckInput; scope: Scope; deadline: number;
  promise: Promise<DelegationCheckResult>;
  resolve(value: DelegationCheckResult): void;
  reject(error: unknown): void;
  started: boolean;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}
interface Queue {
  key: string; pending: Map<string, Job>; waiting: Job[]; running: boolean;
  nextAt: number; retryAt: number; failures: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** One account/endpoint gate shared by initial grants and background rechecks.
 * Only in-flight identical queries join; each caller still checks its own task/generation.
 */
export function createProviderShareDelegationChecks(deps: {
  captureScope(): Scope;
  scopeChanged(): Error;
  request(input: DelegationCheckInput, scope: Scope, timeoutMs: number, signal: AbortSignal): Promise<DelegationCheckResult>;
  random?: () => number;
}) {
  const random = deps.random ?? Math.random;
  let current: Queue | undefined;

  function clear(): void {
    const old = current;
    if (!old) return;
    // Disposing a host cancels its callers, not this account's server budget.
    // Keep a running physical tail serialized and retain Retry-After/spacing
    // when the next host captures the same account/endpoint scope.
    clearTimeout(old.timer);
    for (const job of old.pending.values()) {
      clearTimeout(job.timer);
      const error = deps.scopeChanged();
      job.controller.abort(error);
      job.reject(error);
    }
    old.pending.clear();
    old.waiting.length = 0;
  }
  function schedule(state: Queue): void {
    if (current !== state || state.running || !state.waiting.length) return;
    clearTimeout(state.timer);
    const deadline = Math.min(...state.waiting.map(job => job.deadline));
    state.timer = setTimeout(() => pump(state), Math.max(0, Math.min(state.nextAt, deadline) - Date.now()));
    state.timer.unref?.();
  }
  function pump(state: Queue): void {
    if (current !== state || state.running) return;
    const now = Date.now();
    state.waiting = state.waiting.filter(job => {
      const valid = job.scope.isCurrent();
      if (valid && job.deadline > now) return true;
      state.pending.delete(job.key);
      clearTimeout(job.timer);
      job.reject(valid ? new DelegationCheckDeferredError(now + 5_000) : deps.scopeChanged());
      return false;
    });
    if (!state.waiting.length) return;
    if (state.nextAt > now) { schedule(state); return; }
    const job = state.waiting.shift()!;
    job.started = true;
    state.running = true;
    void (async () => {
      try {
        const result = await deps.request(job.input, job.scope, job.deadline - now, job.controller.signal);
        job.controller.signal.throwIfAborted();
        if (current !== state || !job.scope.isCurrent()) throw deps.scopeChanged();
        state.failures = 0;
        job.resolve(result);
      } catch (error) {
        if (job.controller.signal.aborted) {
          job.reject(job.controller.signal.reason);
        } else if (current !== state || !job.scope.isCurrent()) {
          job.reject(deps.scopeChanged());
        } else {
          if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 429) {
            state.failures = Math.min(state.failures + 1, 4);
            const supplied = 'retryAt' in error ? error.retryAt : undefined;
            const fallback = Math.min(300_000, 60_000 * 2 ** (state.failures - 1));
            state.retryAt = typeof supplied === 'number' && Number.isSafeInteger(supplied) && supplied >= 0
              ? Math.max(Date.now(), supplied) : Date.now() + fallback;
            // The old server shares this account budget with management writes.
            // Stop this batch immediately; do not spend more quota on its other peers.
            for (const queued of state.waiting) {
              state.pending.delete(queued.key);
              clearTimeout(queued.timer);
              queued.reject(new DelegationCheckDeferredError(state.retryAt));
            }
            state.waiting.length = 0;
          }
          job.reject(error);
        }
      } finally {
        clearTimeout(job.timer);
        if (state.pending.get(job.key) === job) state.pending.delete(job.key);
        state.running = false;
        state.nextAt = Math.max(state.retryAt, Date.now() + 750 + Math.floor(random() * 500));
        schedule(state);
      }
    })();
  }
  return {
    check(input: DelegationCheckInput, generation?: string): Promise<DelegationCheckResult> {
      const scope = deps.captureScope();
      if (!scope.isCurrent()) return Promise.reject(deps.scopeChanged());
      if (current?.key !== scope.key) {
        clear();
        current = { key: scope.key, pending: new Map(), waiting: [], running: false,
          nextAt: 0, retryAt: 0, failures: 0 };
      }
      const state = current!;
      const key = JSON.stringify([input.shareId, input.memberId, input.guestDeviceId, input.executorDeviceId, generation]);
      const joined = state.pending.get(key);
      if (joined) return joined.promise;
      if (state.retryAt > Date.now()) return Promise.reject(new DelegationCheckDeferredError(state.retryAt));
      if (state.pending.size >= MAX_PENDING) return Promise.reject(new DelegationCheckDeferredError(Date.now() + 5_000));
      let resolve!: Job['resolve'], reject!: Job['reject'];
      const promise = new Promise<DelegationCheckResult>((yes, no) => { resolve = yes; reject = no; });
      const job: Job = { key, input: { ...input }, scope, deadline: Date.now() + QUEUE_DEADLINE_MS,
        promise, resolve, reject, started: false, controller: new AbortController() };
      job.timer = setTimeout(() => {
        if (!job.started) {
          state.pending.delete(key);
          state.waiting = state.waiting.filter(queued => queued !== job);
        }
        const error = new DelegationCheckDeferredError(Date.now() + 5_000);
        job.controller.abort(error);
        job.reject(error);
      }, QUEUE_DEADLINE_MS);
      job.timer.unref?.();
      state.pending.set(key, job);
      state.waiting.push(job);
      schedule(state);
      return promise;
    },
    clear,
  };
}

interface LeaseEntry {
  peer: string; sessionId: string;
  lease: { ownerDeviceId: string; nonce: string; generation: string; availability?: boolean };
}

/** Spread peers over the minute, and inspect only one at a time. There is no
 * renewal here: a failed read leaves the original deadline untouched.
 */
export function startProviderShareDelegationRechecks(deps: {
  leases(): LeaseEntry[];
  check(item: LeaseEntry): Promise<DelegationCheckResult>;
  invalidate(item: LeaseEntry): void;
  random?: () => number;
}): () => void {
  const due = new Map<string, number>();
  const random = deps.random ?? Math.random;
  let stopped = false, running = false;
  const tick = () => {
    if (stopped) return;
    const groups = new Map<string, LeaseEntry[]>();
    for (const item of deps.leases()) {
      const key = JSON.stringify([item.peer, item.lease.availability === true]);
      const items = groups.get(key) ?? [];
      items.push(item);
      groups.set(key, items);
      if (!due.has(key)) due.set(key, Date.now() + 30_000 + Math.floor(random() * 30_000));
    }
    for (const peer of due.keys()) if (!groups.has(peer)) due.delete(peer);
    if (running) return;
    const next = [...due].filter(([, at]) => at <= Date.now()).sort((a, b) => a[1] - b[1])[0];
    if (!next) return;
    const [peer] = next;
    const items = groups.get(peer)!;
    due.set(peer, Date.now() + 60_000);
    running = true;
    void deps.check(items[0]).then(confirmed => {
      if (stopped) return;
      for (const item of items) if (!confirmed.active || confirmed.ownerDeviceId !== item.lease.ownerDeviceId) {
        deps.invalidate(item);
      }
    }).catch(error => {
      if (!stopped && error && typeof error === 'object' && 'retryAt' in error
        && typeof error.retryAt === 'number' && Number.isSafeInteger(error.retryAt) && due.has(peer)) {
        due.set(peer, Math.max(due.get(peer)!, error.retryAt));
      }
    }).finally(() => { running = false; });
  };
  const timer = setInterval(tick, 1_000);
  timer.unref?.();
  tick();
  return () => { stopped = true; clearInterval(timer); due.clear(); };
}
