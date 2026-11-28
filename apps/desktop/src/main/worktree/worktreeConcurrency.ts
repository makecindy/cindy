import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Worktree concurrency governance (Electron-free, shared by Desktop & Node Host).
 *
 * Lock hierarchy (strictly ordered to prevent deadlocks):
 *   1. Per-session precreated operation queue (WorktreeManager)
 *   2. Per-repo worktree creation queue (`withRepoWorktreeQueue`)
 *   3. Per-worktree physical resource lock (`withWorktreeResourceLock`)
 *   4. Process-wide heavy Multibox clone queue (`withMultiboxHeavyOpQueue`, concurrency = 1)
 *
 * Lightweight non-Multibox `git worktree add --no-checkout` across different repos
 * never enters the Multibox queue and continues to run concurrently without regression.
 */

export const MULTIBOX_MAX_CONCURRENCY = 1;

interface QueueWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface RepoQueueState {
  active: boolean;
  waiters: QueueWaiter[];
}

const repoQueues = new Map<string, RepoQueueState>();

let multiboxLimit = MULTIBOX_MAX_CONCURRENCY;
let multiboxActive = 0;
const multiboxWaiters: QueueWaiter[] = [];

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === 'string' && reason.trim() ? reason : 'Worktree creation aborted');
}

function normalizeRepoKeyString(resolvedPath: string): string {
  const normalized = path.resolve(resolvedPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Canonical repository key using `fs.realpath` (with `path.resolve` fallback) and
 * Windows case-folding so symlinked or differently-cased paths to the same repo
 * serialize properly.
 */
export async function canonicalRepoKey(repoPath: string): Promise<string> {
  try {
    return normalizeRepoKeyString(await fs.realpath(repoPath));
  } catch {
    return normalizeRepoKeyString(repoPath);
  }
}

export interface WorktreeQueueOptions {
  signal?: AbortSignal;
  onQueueWaitStart?: () => void;
  onQueueAcquired?: () => void;
}

/**
 * Serialize worktree creation per canonical base repository with FIFO ordering
 * and abortable queue waiting. Calling `releaseQueue()` early releases the repo
 * slot once metadata creation completes (matching PR #13203).
 */
export async function withRepoWorktreeQueue<T>(
  baseRepo: string,
  fn: (releaseQueue: () => void) => Promise<T>,
  options?: WorktreeQueueOptions,
): Promise<T> {
  const signal = options?.signal;
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }

  const key = await canonicalRepoKey(baseRepo);
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }

  let state = repoQueues.get(key);
  if (!state) {
    state = { active: true, waiters: [] };
    repoQueues.set(key, state);
  } else if (!state.active) {
    state.active = true;
  } else {
    options?.onQueueWaitStart?.();
    await new Promise<void>((resolve, reject) => {
      const waiter: QueueWaiter = { resolve, reject, signal };
      if (signal) {
        const onAbort = () => {
          const idx = state!.waiters.indexOf(waiter);
          if (idx !== -1) state!.waiters.splice(idx, 1);
          reject(createAbortError(signal.reason));
        };
        waiter.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
      state!.waiters.push(waiter);
    });
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const current = repoQueues.get(key);
    if (!current) return;
    const next = current.waiters.shift();
    if (next) {
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener('abort', next.onAbort);
      }
      next.resolve();
    } else {
      current.active = false;
      repoQueues.delete(key);
    }
  };

  if (signal?.aborted) {
    release();
    throw createAbortError(signal.reason);
  }

  options?.onQueueAcquired?.();
  try {
    return await fn(release);
  } finally {
    release();
  }
}

/**
 * Process-wide concurrency cap for heavy Multibox clones (`git multibox add`
 * during both creation and restoration). Acquire strictly as a leaf lock inside
 * per-repo / per-worktree locks.
 */
export async function withMultiboxHeavyOpQueue<T>(
  fn: () => Promise<T>,
  options?: WorktreeQueueOptions,
): Promise<T> {
  const signal = options?.signal;
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }

  if (multiboxActive < multiboxLimit) {
    multiboxActive += 1;
  } else {
    options?.onQueueWaitStart?.();
    await new Promise<void>((resolve, reject) => {
      const waiter: QueueWaiter = { resolve, reject, signal };
      if (signal) {
        const onAbort = () => {
          const idx = multiboxWaiters.indexOf(waiter);
          if (idx !== -1) multiboxWaiters.splice(idx, 1);
          reject(createAbortError(signal.reason));
        };
        waiter.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
      multiboxWaiters.push(waiter);
    });
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    while (multiboxWaiters.length > 0 && multiboxActive <= multiboxLimit) {
      const next = multiboxWaiters.shift()!;
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener('abort', next.onAbort);
      }
      // Slot transfers directly to the woken waiter (multiboxActive unchanged).
      next.resolve();
      return;
    }
    multiboxActive = Math.max(0, multiboxActive - 1);
  };

  if (signal?.aborted) {
    release();
    throw createAbortError(signal.reason);
  }

  options?.onQueueAcquired?.();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Whether the canonical repository already has an active worktree creation holding its queue. */
export async function isRepoWorktreeQueueBusy(baseRepo: string): Promise<boolean> {
  const key = await canonicalRepoKey(baseRepo);
  return repoQueues.get(key)?.active === true;
}

/** Whether the process-wide Multibox heavy-op slot is currently saturated. */
export function isMultiboxHeavyOpQueueBusy(): boolean {
  return multiboxActive >= multiboxLimit;
}

/**
 * Whether a new worktree creation for `baseRepo` would have to wait behind an
 * already-running operation. Callers use this to yield immediately into async
 * provisioning instead of burning a fast-wait budget while queued.
 */
export async function isWorktreeCreationQueueBusy(
  baseRepo: string,
  useMultibox: boolean,
): Promise<boolean> {
  if (useMultibox && isMultiboxHeavyOpQueueBusy()) return true;
  return isRepoWorktreeQueueBusy(baseRepo);
}

/** Test-only reset to ensure clean isolation between unit tests. */
export function resetWorktreeConcurrencyForTest(limit = MULTIBOX_MAX_CONCURRENCY): void {
  repoQueues.clear();
  multiboxWaiters.length = 0;
  multiboxActive = 0;
  multiboxLimit = limit;
}
