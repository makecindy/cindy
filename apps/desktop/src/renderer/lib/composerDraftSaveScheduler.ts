export interface ComposerDraftSaveScheduler {
  schedule(task: () => void): void;
  flush(): void;
  cancel(): void;
}

export interface ComposerDraftSaveSchedulerOptions {
  delayMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (handle: number) => void;
}

const DEFAULT_DELAY_MS = 120;

/**
 * Coalesces draft writes while the user is typing. The latest task is retained
 * and can be synchronously flushed at lifecycle boundaries (blur, send,
 * session switch, and unmount).
 */
export function createComposerDraftSaveScheduler(
  options: ComposerDraftSaveSchedulerOptions = {},
): ComposerDraftSaveScheduler {
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const setTimer = options.setTimer ?? ((callback, delay) => window.setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((handle) => window.clearTimeout(handle));

  let pendingTask: (() => void) | null = null;
  let timer: number | null = null;

  const flush = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    const task = pendingTask;
    pendingTask = null;
    task?.();
  };

  return {
    schedule(task): void {
      pendingTask = task;
      if (timer !== null) return;
      timer = setTimer(() => {
        timer = null;
        const next = pendingTask;
        pendingTask = null;
        next?.();
      }, delayMs);
    },
    flush,
    cancel(): void {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      pendingTask = null;
    },
  };
}

export const __composerDraftSaveSchedulerDefaultsForTest = {
  delayMs: DEFAULT_DELAY_MS,
};
