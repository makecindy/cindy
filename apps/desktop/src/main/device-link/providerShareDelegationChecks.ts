/** Request scheduling only. No cached result can authorize execution. */
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
  key: string; scope: Scope; deadline: number; background: boolean;
  request(timeoutMs: number, signal: AbortSignal): Promise<unknown>;
  promise: Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  started: boolean; waiters: number;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}
interface Queue {
  key: string; pending: Map<string, Job>; waiting: Job[]; running: boolean;
  nextAt: number; retryAt: number; failures: number;
  lastBackground: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** One account/endpoint gate shared by grants, generation-specific revokes and checks.
 * Only identical in-flight operations join; each caller still checks its own task/generation.
 */
export function createProviderShareDelegationChecks(deps: {
  captureScope(): Scope;
  scopeChanged(): Error;
  request(input: DelegationCheckInput, scope: Scope, timeoutMs: number, signal: AbortSignal): Promise<DelegationCheckResult>;
  random?: () => number;
}) {
  const random = deps.random ?? Math.random;
  let current: Queue | undefined;
  // Retain only live budgets, including when an account is switched away and back.
  // A host rebuild cancels work, never resets the server's cooldown.
  const scopes = new Map<string, Queue>();

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
    // Foreground gets the first turn; alternate when both classes have work so
    // repairs cannot starve normal authorization (or vice versa).
    let index = state.waiting.findIndex(job => job.background !== state.lastBackground);
    if (index < 0) index = 0;
    const [job] = state.waiting.splice(index, 1);
    state.lastBackground = job.background;
    job.started = true;
    state.running = true;
    void (async () => {
      try {
        const result = await job.request(job.deadline - now, job.controller.signal);
        job.controller.signal.throwIfAborted();
        if (current !== state || !job.scope.isCurrent()) throw deps.scopeChanged();
        state.failures = 0;
        job.resolve(result);
      } catch (error) {
        // A late 429 is still evidence about the old account's budget, even
        // though its result cannot be delivered after cancellation/switching.
        if (!(error instanceof DelegationCheckDeferredError) && error && typeof error === 'object'
          && 'statusCode' in error && error.statusCode === 429) {
          state.failures = Math.min(state.failures + 1, 4);
          const supplied = 'retryAt' in error ? error.retryAt : undefined;
          const fallback = Math.min(300_000, 60_000 * 2 ** (state.failures - 1));
          state.retryAt = Math.max(state.retryAt,
            typeof supplied === 'number' && Number.isSafeInteger(supplied) && supplied > Date.now()
              ? supplied : Date.now() + fallback + Math.floor(random() * fallback * 0.2));
          // The exact server bucket is not known here. Conservatively cool all
          // delegation operations for this account/endpoint, not other services.
          for (const queued of state.waiting) {
            state.pending.delete(queued.key);
            clearTimeout(queued.timer);
            queued.reject(new DelegationCheckDeferredError(state.retryAt));
          }
          state.waiting.length = 0;
        }
        if (job.controller.signal.aborted) {
          job.reject(job.controller.signal.reason);
        } else if (current !== state || !job.scope.isCurrent()) {
          job.reject(deps.scopeChanged());
        } else {
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
  function run<T>(key: string,
    request: (scope: Scope, timeoutMs: number, signal: AbortSignal) => Promise<T>,
    options: { background?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    const scope = deps.captureScope();
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    if (!scope.isCurrent()) return Promise.reject(deps.scopeChanged());
    if (current?.key !== scope.key) {
      clear();
      for (const [key, state] of scopes) if (!state.running && !state.pending.size
        && state.nextAt <= Date.now()) scopes.delete(key);
      if (!scopes.has(scope.key)) {
        if (scopes.size >= MAX_PENDING) return Promise.reject(new DelegationCheckDeferredError(Date.now() + 5_000));
        scopes.set(scope.key, { key: scope.key, pending: new Map(), waiting: [], running: false,
          nextAt: 0, retryAt: 0, failures: 0, lastBackground: true });
      }
      current = scopes.get(scope.key)!;
    }
    const state = current!;
    if ([...state.pending.values()].some(job => !job.scope.isCurrent())) clear();
    const joined = state.pending.get(key);
    // Individual cancellation must not cancel another caller's shared write.
    if (joined) {
      if (!options.background) joined.background = false;
      return wait(joined, options.signal) as Promise<T>;
    }
    if (state.retryAt > Date.now()) return Promise.reject(new DelegationCheckDeferredError(state.retryAt));
    if (state.pending.size >= MAX_PENDING && !options.background) {
      const displaced = state.waiting.findLast(job => job.background);
      if (displaced) {
        state.pending.delete(displaced.key);
        state.waiting = state.waiting.filter(job => job !== displaced);
        clearTimeout(displaced.timer);
        displaced.reject(new DelegationCheckDeferredError(Date.now() + 5_000));
      }
    }
    if (state.pending.size >= MAX_PENDING) return Promise.reject(new DelegationCheckDeferredError(Date.now() + 5_000));
    let resolve!: Job['resolve'], reject!: Job['reject'];
    const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
    const job: Job = { key, scope, background: options.background === true,
      request: (timeoutMs, signal) => request(scope, timeoutMs, signal), deadline: Date.now() + QUEUE_DEADLINE_MS,
      promise, resolve, reject, started: false, waiters: 0, controller: new AbortController() };
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
    return wait(job, options.signal) as Promise<T>;
  }
  function wait(job: Job, signal?: AbortSignal): Promise<unknown> {
    job.waiters++;
    if (!signal) return job.promise;
    return new Promise((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener('abort', abort);
        if (--job.waiters === 0) {
          job.controller.abort(signal.reason);
          const state = scopes.get(job.scope.key);
          if (state?.pending.get(job.key) === job) state.pending.delete(job.key);
          if (!job.started) {
            if (state) {
              state.waiting = state.waiting.filter(queued => queued !== job);
              schedule(state);
            }
            clearTimeout(job.timer);
            job.reject(signal.reason);
          }
        }
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      job.promise.then(value => { signal.removeEventListener('abort', abort);
        if (signal.aborted) reject(signal.reason); else resolve(value);
      }, error => { signal.removeEventListener('abort', abort); reject(error); });
      if (signal.aborted) abort();
    });
  }
  return {
    run,
    retryAt: () => scopes.get(deps.captureScope().key)?.retryAt ?? 0,
    check(input: DelegationCheckInput, generation?: string,
      options: { background?: boolean; signal?: AbortSignal } = {}): Promise<DelegationCheckResult> {
      const captured = { ...input };
      return run(JSON.stringify(['check', input.shareId, input.memberId, input.guestDeviceId, input.executorDeviceId, generation]),
        (scope, timeoutMs, signal) => deps.request(captured, scope, timeoutMs, signal), options);
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
