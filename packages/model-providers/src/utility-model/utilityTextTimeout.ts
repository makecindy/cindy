import type { UtilityTextResult } from '../utilityTextResult.js';

const TIMEOUT = Symbol('utility-text-timeout');

/** Include credential discovery in the budget, even when a transport ignores abort. */
export async function requestUtilityTextWithinTimeout(
  request: (signal: AbortSignal) => Promise<UtilityTextResult>,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  timeoutFailure: () => UtilityTextResult,
): Promise<UtilityTextResult> {
  if (parentSignal?.aborted) return timeoutFailure();
  const controller = new AbortController();
  let abort!: () => void;
  const cutoff = new Promise<typeof TIMEOUT>((resolve) => {
    abort = () => {
      controller.abort();
      resolve(TIMEOUT);
    };
  });
  parentSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const result = await Promise.race([request(controller.signal), cutoff]);
    return result === TIMEOUT || controller.signal.aborted
      ? timeoutFailure()
      : result;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abort);
  }
}
