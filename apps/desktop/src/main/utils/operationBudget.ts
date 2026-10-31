import { AsyncLocalStorage } from 'node:async_hooks';
import { setImmediate } from 'node:timers/promises';
import path from 'node:path';

// An async-local scope keeps nested Git probes, ownership repair and bootstrap
// on the same budget. It never affects manual Git operations outside the scope.
const current = new AsyncLocalStorage<OperationBudget>();
const uncertainGitDirectories = new Set<string>();
const directoryKey = (dir: string) =>
  process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir);

export function quarantineGitDirectory(dir: string): void {
  uncertainGitDirectories.add(directoryKey(dir));
}

export function assertGitDirectoryReady(dir: string): void {
  if (uncertainGitDirectories.has(directoryKey(dir))) {
    throw new Error('Git process cleanup unconfirmed; repository writes disabled until restart');
  }
}

export class OperationBudget {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  readonly deadlineAtMs: number;
  private readonly children = new Set<Promise<unknown>>();

  constructor(readonly timeoutMs: number) {
    this.deadlineAtMs = performance.now() + timeoutMs;
  }

  cancel(reason: unknown = new Error('Snapshot cancelled')): void {
    this.controller.abort(reason);
  }

  check(): void {
    if (!this.signal.aborted && performance.now() >= this.deadlineAtMs) {
      this.cancel(new Error('Snapshot operation deadline exceeded'));
    }
    this.signal.throwIfAborted();
  }

  track<T>(promise: Promise<T>): Promise<T> {
    this.children.add(promise);
    void promise.finally(() => this.children.delete(promise)).catch(() => {});
    return promise;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.children]);
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const abort = () => this.cancel(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(
      () => this.cancel(new Error('Snapshot operation deadline exceeded')),
      this.timeoutMs,
    );
    try {
      return await current.run(this, async () => {
        this.check();
        try {
          return await operationWait(Promise.resolve().then(task));
        } finally {
          // Git owns termination and its bounded cleanup. Returning from a
          // cancelled scope must not merely abandon still-running children.
          await this.drain();
        }
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}

export function currentOperationBudget(): OperationBudget | undefined {
  return current.getStore();
}

export function operationCheckpoint(): void {
  current.getStore()?.check();
}

/** Only for interruptible waits/reads; writes must retain their cleanup owner. */
export async function operationWait<T>(promise: T | PromiseLike<T>): Promise<T> {
  const scope = current.getStore();
  if (!scope) return promise;
  // Attach handlers even when already aborted: the caller may have started IO.
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(scope.signal.reason);
    scope.signal.addEventListener('abort', abort, { once: true });
    if (scope.signal.aborted) abort();
  });
  try {
    const value = await Promise.race([promise, cancelled]);
    scope.check();
    return value;
  } finally {
    scope.signal.removeEventListener('abort', abort);
  }
}

/** Give Stop/deadline timers a turn during long cached filesystem scans. */
export async function operationYield(index: number): Promise<void> {
  operationCheckpoint();
  if (current.getStore() && index % 256 === 0) {
    await setImmediate();
    operationCheckpoint();
  }
}
