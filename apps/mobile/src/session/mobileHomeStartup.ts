export const HOME_STARTUP_LOCAL_READ_TIMEOUT_MS = 2_000;

/**
 * Bounds best-effort local reads that must not block the first remote Home sync.
 * The native operation is left alone after timeout and remains available through
 * completion so callers can safely reconcile a late value.
 */
export function startBoundedStartupRead<T>(
  operation: PromiseLike<T>,
  fallback: T,
  timeoutMs: number = HOME_STARTUP_LOCAL_READ_TIMEOUT_MS,
) {
  const completion = Promise.resolve(operation)
    .then((value) => ({ ok: true as const, value }))
    .catch(() => ({ ok: false as const, value: fallback }));
  const initial = new Promise<{ timedOut: boolean; value: T }>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { timedOut: boolean; value: T }) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => finish({ timedOut: true, value: fallback }), timeoutMs);
    void completion.then((result) => finish({ timedOut: false, value: result.value }));
  });
  return { completion, initial };
}
