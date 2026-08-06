/**
 * Subscribe to one async provider-model resolve response and bound the listener lifetime.
 *
 * The model fetch itself can succeed while the follow-up resolve is disabled or fails. In that
 * case main never emits a matching payload, so every caller must have a deterministic timeout and
 * an unmount cleanup path instead of retaining the fan-out listener indefinitely.
 */
export function subscribeToProviderModelsResolved<T extends { requestId: string }>(options: {
  requestId: string;
  timeoutMs: number;
  subscribe: (listener: (payload: T) => void) => () => void;
  onResolved: (payload: T) => void;
}): () => void {
  let unsubscribe: (() => void) | undefined;
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timeout !== undefined) {
      globalThis.clearTimeout(timeout);
      timeout = undefined;
    }
    unsubscribe?.();
    unsubscribe = undefined;
  };

  unsubscribe = options.subscribe((payload) => {
    if (payload.requestId !== options.requestId) return;
    stop();
    options.onResolved(payload);
  });

  // Defensive support for a test/future subscribe implementation that emits synchronously.
  if (stopped) {
    unsubscribe();
    unsubscribe = undefined;
  } else {
    timeout = globalThis.setTimeout(stop, options.timeoutMs);
  }

  return stop;
}
