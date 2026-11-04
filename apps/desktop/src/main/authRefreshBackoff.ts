/** Process-local, jittered exponential retry deadline for one login generation. */
export class AuthRefreshBackoff {
  private epoch = -1;
  private retryAt = 0;
  private failures = 0;
  private networkFailure = false;
  private quickRetryAt: number | null = null;
  private quickFailures = 0;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly random: () => number = () => Math.random(),
  ) {}

  remaining(epoch: number): number {
    return this.epoch === epoch ? Math.max(0, this.retryAt - this.now()) : 0;
  }

  /** Runtime-only 401 evidence; cold-start/manual retries keep their own contract. */
  serverRejectedToken(epoch: number): boolean {
    if (!this.networkFailure || this.remaining(epoch) <= 0 || this.quickRetryAt !== null) {
      return false;
    }
    // Share one sampled deadline across all callers, never delay the existing retry.
    this.quickRetryAt = Math.min(this.retryAt, this.now() + Math.floor(this.random() * 3_000));
    return true;
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
    if (this.networkFailure && this.quickRetryAt !== null) {
      // Equal jitter with ceilings 3s, 6s, 12s, 24s, 48s, then 60s.
      // Do not advance the long backoff's tier or deadline on these attempts.
      const floor = Math.min(3_000 * 2 ** this.quickFailures, 60_000) / 2;
      this.quickFailures = Math.min(this.quickFailures + 1, 5);
      this.quickRetryAt = this.now() + floor + Math.floor(this.random() * floor);
      return this.runtimeRemaining(epoch);
    }
    this.quickRetryAt = null;
    this.quickFailures = 0;
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
  }
}
