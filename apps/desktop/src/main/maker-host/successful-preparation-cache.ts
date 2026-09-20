/**
 * Coalesces expensive preparation work and briefly reuses only successful
 * completions. The cache stores no preparation result, so large scan snapshots
 * remain eligible for collection as soon as the preparation settles.
 */
export class SuccessfulPreparationCache {
  private pending: { key: string; promise: Promise<boolean> } | null = null;
  private completed: { key: string; expiresAt: number } | null = null;

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async ensure(key: string, prepare: () => Promise<boolean>): Promise<void> {
    while (true) {
      if (this.completed?.key === key && this.now() < this.completed.expiresAt) {
        return;
      }

      const pending = this.pending;
      if (pending) {
        if (pending.key === key) {
          await pending.promise;
          return;
        }
        // A session boundary can change while an old owner is still preparing.
        // Let that work settle, then prepare the current key independently.
        await pending.promise.catch(() => undefined);
        continue;
      }

      let promise: Promise<boolean>;
      promise = Promise.resolve()
        .then(prepare)
        .then((cacheable) => {
          if (cacheable) {
            this.completed = {
              key,
              expiresAt: this.now() + this.ttlMs,
            };
          }
          return cacheable;
        })
        .finally(() => {
          if (this.pending?.promise === promise) {
            this.pending = null;
          }
        });
      this.pending = { key, promise };
      await promise;
      return;
    }
  }
}
