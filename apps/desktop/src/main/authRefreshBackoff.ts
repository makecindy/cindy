/** Process-local, jittered exponential retry deadline for one login generation. */
export class AuthRefreshBackoff {
  private epoch = -1;
  private retryAt = 0;
  private failures = 0;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly random: () => number = () => Math.random(),
  ) {}

  remaining(epoch: number): number {
    return this.epoch === epoch ? Math.max(0, this.retryAt - this.now()) : 0;
  }

  defer(epoch: number, serverRetryAt?: number): number {
    if (this.epoch !== epoch) this.failures = 0;
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
  }
}
