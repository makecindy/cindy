/**
 * Bounded guard for Electron WebContents async operations (such as `capturePage()` and
 * `printToPDF()`) that can hang indefinitely when a guest webview or its host window is
 * hidden and stops producing compositor frames.
 *
 * Races the operation against:
 *  - a finite timeout (`timeoutMs`),
 *  - an optional `AbortSignal` (e.g. backend disposal / generation replacement),
 *  - `destroyed` / `render-process-gone` on the target WebContents, and
 *  - `destroyed` on any additional WebContents (e.g. the requesting host renderer).
 *
 * Always cleans up timers and listeners and swallows late rejections from an abandoned
 * operation so `finally` blocks (such as tab-pin release) are guaranteed to run.
 */

import type { WebContents } from 'electron';

export type GuardedWebContentsEvent = 'destroyed' | 'render-process-gone';

export interface GuardedWebContentsLike {
  isDestroyed?(): boolean;
  once?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
}

export type GuardedWebContentsTarget = WebContents | GuardedWebContentsLike;

export interface RunWebContentsOpGuardOptions {
  label: string;
  timeoutMs: number;
  signal?: AbortSignal;
  additionalDestroyedTargets?: readonly GuardedWebContentsTarget[];
}

function attachOnce(
  target: GuardedWebContentsTarget,
  event: GuardedWebContentsEvent,
  listener: () => void,
): () => void {
  const onceFn = target.once as
    | ((ev: GuardedWebContentsEvent, fn: () => void) => unknown)
    | undefined;
  if (typeof onceFn !== 'function') return () => undefined;
  onceFn.call(target, event, listener);
  return () => {
    try {
      const removeFn = (target.removeListener ?? target.off) as
        | ((ev: GuardedWebContentsEvent, fn: () => void) => unknown)
        | undefined;
      if (typeof removeFn === 'function') {
        removeFn.call(target, event, listener);
      }
    } catch {
      // Target may already be torn down.
    }
  };
}

export async function runWebContentsOpWithGuard<T>(
  wc: GuardedWebContentsTarget,
  op: () => Promise<T>,
  opts: RunWebContentsOpGuardOptions,
): Promise<T> {
  if (opts.signal?.aborted) {
    throw new Error('embedded browser control generation was replaced');
  }
  if (wc.isDestroyed?.()) {
    throw new Error(`${opts.label} aborted: webContents is already destroyed`);
  }
  for (const extra of opts.additionalDestroyedTargets ?? []) {
    if (extra.isDestroyed?.()) {
      throw new Error(`${opts.label} aborted: host webContents is already destroyed`);
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanups: Array<() => void> = [];

  const guardPromise = new Promise<never>((_resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    timer = setTimeout(() => {
      fail(
        new Error(
          `${opts.label} timed out after ${opts.timeoutMs}ms (tab or host window may be hidden or unresponsive)`,
        ),
      );
    }, opts.timeoutMs);

    if (opts.signal) {
      const onAbort = () => fail(new Error('embedded browser control generation was replaced'));
      opts.signal.addEventListener('abort', onAbort, { once: true });
      cleanups.push(() => opts.signal?.removeEventListener('abort', onAbort));
    }

    cleanups.push(
      attachOnce(wc, 'destroyed', () =>
        fail(new Error(`${opts.label} aborted: webContents destroyed`)),
      ),
    );
    cleanups.push(
      attachOnce(wc, 'render-process-gone', () =>
        fail(new Error(`${opts.label} aborted: render process gone`)),
      ),
    );
    for (const extra of opts.additionalDestroyedTargets ?? []) {
      cleanups.push(
        attachOnce(extra, 'destroyed', () =>
          fail(new Error(`${opts.label} aborted: host webContents destroyed`)),
        ),
      );
    }
  });

  let opPromise: Promise<T>;
  try {
    opPromise = op();
  } catch (err) {
    if (timer !== undefined) clearTimeout(timer);
    for (const cleanup of cleanups) cleanup();
    guardPromise.catch(() => undefined);
    throw err;
  }

  try {
    return await Promise.race([opPromise, guardPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    for (const cleanup of cleanups) cleanup();
    // Swallow late rejections from an abandoned Electron capture/PDF call after timeout or abort.
    opPromise.catch(() => undefined);
    guardPromise.catch(() => undefined);
  }
}
