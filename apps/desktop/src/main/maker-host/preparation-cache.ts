/** One owner/generation at a time; only successful work gets a short completion TTL. */
export class PreparationCache {
  private pending: { key: string; promise: Promise<boolean> } | null = null;
  private completed: { key: string; until: number } | null = null;

  constructor(private readonly ttlMs: number, private readonly now = Date.now) {}

  /**
   * Resolves with whether the preparation was clean (no warnings). A cached
   * completion is only kept when it was clean, so a hit always reports true.
   */
  async ensure(key: string, prepare: () => Promise<boolean>): Promise<boolean> {
    while (this.pending) {
      const pending = this.pending;
      if (pending.key === key) return pending.promise;
      await pending.promise.catch(() => undefined);
    }
    if (this.completed?.key === key && this.now() < this.completed.until) return true;
    this.completed = null;
    const promise = Promise.resolve().then(prepare).then((success) => {
      this.completed = success && this.ttlMs > 0 ? { key, until: this.now() + this.ttlMs } : null;
      return success;
    }).finally(() => { this.pending = null; });
    this.pending = { key, promise };
    return promise;
  }
}
