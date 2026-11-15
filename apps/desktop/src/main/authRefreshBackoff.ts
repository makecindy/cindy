/** Process-local, jittered exponential retry deadline for one login generation. */
export class AuthRefreshBackoff {
  private epoch = -1;
  private retryAt = 0;
  private failures = 0;
  private networkFailure = false;
  private quickRetryAt: number | null = null;
  private quickFailures = 0;
  private quickNotBefore = 0;
  private quickAttemptInFlight = false;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly random: () => number = () => Math.random(),
  ) {}

  remaining(epoch: number): number {
    return this.epoch === epoch ? Math.max(0, this.retryAt - this.now()) : 0;
  }

  /** Runtime-only 401 evidence; cold-start/manual retries keep their own contract. */
  serverRejectedToken(epoch: number): boolean {
    if (this.epoch !== epoch || !this.networkFailure || this.quickRetryAt !== null) return false;
    // Evidence is consumed at launch. Evidence arriving during that request may
    // authorize its successor, but must not start a second timer/request yet.
    const candidate = Math.max(this.quickNotBefore, this.now() + Math.floor(this.random() * 3_000));
    if (this.quickAttemptInFlight) {
      this.quickRetryAt = candidate;
      return false;
    }
    // The ordinary retry wins if its deadline is earlier; do not misclassify it
    // as a quick attempt and then immediately repeat it after a network failure.
    if (candidate >= this.retryAt) return false;
    this.quickRetryAt = candidate;
    return true;
  }

  startRuntimeAttempt(epoch: number): void {
    if (this.epoch !== epoch) return;
    this.quickAttemptInFlight = this.quickRetryAt !== null;
    this.quickRetryAt = null;
  }

  runtimeRemaining(epoch: number): number {
    if (this.epoch !== epoch) return 0;
    return this.quickRetryAt === null
      ? this.remaining(epoch)
      : Math.max(0, this.quickRetryAt - this.now());
  }

  defer(epoch: number, serverRetryAt?: number, networkFailure = false): number {
    if (this.epoch !== epoch) this.clear();
    this.networkFailure = networkFailure && serverRetryAt === undefined;
    const wasQuickAttempt = this.quickAttemptInFlight;
    this.quickAttemptInFlight = false;
    if (this.networkFailure && wasQuickAttempt) {
      // Equal jitter with ceilings 3s, 6s, 12s, 24s, 48s, then 60s.
      // Retain the tier, but only fresh evidence may schedule another quick try.
      const floor = Math.min(3_000 * 2 ** this.quickFailures, 60_000) / 2;
      this.quickFailures = Math.min(this.quickFailures + 1, 5);
      this.quickNotBefore = this.now() + floor + Math.floor(this.random() * floor);
      if (this.quickRetryAt !== null) {
        const candidate = Math.max(this.quickNotBefore, this.quickRetryAt);
        this.quickRetryAt = candidate < this.retryAt ? candidate : null;
      }
      // No evidence: resume the original long deadline without advancing it.
      return this.runtimeRemaining(epoch);
    }
    this.quickRetryAt = null;
    if (!this.networkFailure) {
      this.quickFailures = 0;
      this.quickNotBefore = 0;
    }
    this.epoch = epoch;
    // Equal jitter: 1–2m, 2–4m, 4–8m, then 5–10m indefinitely. Add the
    // random spread AFTER a shared server deadline, not before a max() that
    // would collapse every client's retry back onto the same Retry-After time.
    const floor = Math.min(60_000 * 2 ** this.failures, 300_000);
    this.failures = Math.min(this.failures + 1, 3);
    this.retryAt =
      Math.max(this.now() + floor, Number.isFinite(serverRetryAt) ? serverRetryAt! : 0) +
      Math.floor(this.random() * floor);
    return this.remaining(epoch);
  }

  /** Explicit transport retry releases the wait without resetting the failure count. */
  release(epoch: number): void {
    if (this.epoch === epoch) this.retryAt = 0;
  }

  clear(): void {
    this.epoch = -1;
    this.retryAt = 0;
    this.failures = 0;
    this.networkFailure = false;
    this.quickRetryAt = null;
    this.quickFailures = 0;
    this.quickNotBefore = 0;
    this.quickAttemptInFlight = false;
  }
}
