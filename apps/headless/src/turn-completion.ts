/**
 * Tracks the gap between a vendor accepting `send()` and the agent emitting
 * its terminal event.  The headless scheduler uses this as the real turn
 * boundary; accepting a request alone is not sufficient for serial delivery.
 */
export class HeadlessTurnCompletionTracker {
  private readonly pending = new Map<string, { promise: Promise<void>; resolve: () => void }>();

  waitFor(sessionId: string): Promise<void> {
    const existing = this.pending.get(sessionId);
    if (existing) return existing.promise;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    this.pending.set(sessionId, { promise, resolve });
    return promise;
  }

  complete(sessionId: string): void {
    const current = this.pending.get(sessionId);
    if (!current) return;
    this.pending.delete(sessionId);
    current.resolve();
  }

  has(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }
}
