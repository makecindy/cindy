/** One owner/generation at a time; only successful work gets a short completion TTL. */
export class PreparationCache {
  private pending: { key: string; promise: Promise<boolean> } | null = null;
  private completed: { key: string; until: number } | null = null;

  constructor(private readonly ttlMs: number, private readonly now = Date.now) {}

  async ensure(key: string, prepare: () => Promise<boolean>): Promise<void> {
    while (this.pending) {
      const pending = this.pending;
      if (pending.key === key) { await pending.promise; return; }
      await pending.promise.catch(() => undefined);
    }
    if (this.completed?.key === key && this.now() < this.completed.until) return;
    this.completed = null;
    const promise = Promise.resolve().then(prepare).then((success) => {
      this.completed = success && this.ttlMs > 0 ? { key, until: this.now() + this.ttlMs } : null;
      return success;
    }).finally(() => { this.pending = null; });
    this.pending = { key, promise };
    await promise;
  }
}
