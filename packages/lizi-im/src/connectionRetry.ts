export interface ConnectionBackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Downward jitter keeps maxMs a true cap. Use 1 for deterministic polling. */
  jitterMinRatio?: number;
  random?: () => number;
}

export function connectionBackoffDelayMs(
  attempt: number,
  {
    baseMs = 1_000,
    maxMs = 30_000,
    jitterMinRatio = 0.8,
    random = Math.random,
  }: ConnectionBackoffOptions = {},
): number {
  const capped = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(capped * (jitterMinRatio + random() * (1 - jitterMinRatio)));
}

/** Shared delay policy for timer-driven connections and abortable poll loops. */
export class ConnectionBackoff {
  private attempt = 0;

  constructor(private readonly options: ConnectionBackoffOptions = {}) {}

  nextDelay(minimumDelayMs = 0): number {
    return Math.max(minimumDelayMs, connectionBackoffDelayMs(this.attempt++, this.options));
  }

  reset(): void {
    this.attempt = 0;
  }
}

/** One cancellable retry per connection; SDK-owned retries stay in their SDK. */
export class ConnectionRetry {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly backoff: ConnectionBackoff;

  constructor(options: ConnectionBackoffOptions = {}) {
    this.backoff = new ConnectionBackoff(options);
  }

  schedule(
    retry: () => void,
    options: { minimumDelayMs?: number; fixedDelayMs?: number } = {},
  ): void {
    if (this.timer) return;
    const backoffDelay = this.backoff.nextDelay(options.minimumDelayMs);
    // Conflict standby uses an exact interval, independent of jitter.
    const delay = options.fixedDelayMs ?? backoffDelay;
    this.timer = setTimeout(() => {
      this.timer = null;
      retry();
    }, delay);
    this.timer.unref?.();
  }

  reset(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.backoff.reset();
  }
}
