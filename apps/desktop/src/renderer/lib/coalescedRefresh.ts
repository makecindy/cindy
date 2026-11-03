/** Share one active read and retain only the latest invalidation for a trailing read.
 * Callers invalidate their own snapshot generation synchronously before scheduling.
 * No results, retries, timers or ownership decisions are retained here.
 */
export function createCoalescedRefresh<T>(): (read: () => Promise<T>) => Promise<T> {
  let active: Promise<T> | undefined;
  let latest: (() => Promise<T>) | undefined;
  return (read) => {
    latest = read;
    if (!active) {
      active = Promise.resolve().then(async () => {
        try {
          let result!: T;
          while (latest) {
            const next = latest;
            latest = undefined;
            try {
              result = await next();
            } catch (error) {
              if (!latest) throw error;
            }
          }
          return result;
        } finally {
          active = undefined;
        }
      });
    }
    return active;
  };
}
