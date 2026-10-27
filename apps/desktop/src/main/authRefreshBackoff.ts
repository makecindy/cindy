/** Process-local retry deadline, scoped to the current login generation. */
export class AuthRefreshBackoff {
  private epoch = -1;
  private retryAt = 0;
  private networkFailure = false;

  constructor(private readonly now: () => number = () => Date.now()) {}

  remaining(epoch: number): number {
    return this.epoch === epoch ? Math.max(0, this.retryAt - this.now()) : 0;
  }

  defer(epoch: number, serverRetryAt?: number, networkFailure = false): number {
    this.epoch = epoch;
    this.retryAt = Math.max(this.now() + 60_000, Number.isFinite(serverRetryAt) ? serverRetryAt! : 0);
    this.networkFailure = networkFailure && serverRetryAt === undefined;
    return this.remaining(epoch);
  }

  /** A real server response proves reachability; interface hints do not. */
  networkRecovered(epoch: number): boolean {
    if (this.epoch !== epoch || !this.networkFailure) return false;
    this.clear();
    return true;
  }

  clear(): void {
    this.epoch = -1;
    this.retryAt = 0;
    this.networkFailure = false;
  }
}
