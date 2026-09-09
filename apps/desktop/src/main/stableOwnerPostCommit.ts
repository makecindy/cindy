export type StableOwnerPostCommitOutcome =
  | 'completed'
  | 'deferred'
  | 'failed'
  | 'not-applicable';

export interface StableOwnerPostCommitContext {
  reason: string;
  scopeKey: string;
  /** Null identifies the stable signed-out scope, not an unstable boundary. */
  dataOwnerId: string | null;
}

export type StableOwnerPostCommitTask = (
  context: StableOwnerPostCommitContext,
) => Promise<Exclude<StableOwnerPostCommitOutcome, 'not-applicable'>>;

interface StableOwnerSnapshot {
  scopeKey: string;
  dataOwnerId: string | null;
  stable: boolean;
}

interface StableOwnerPostCommitCoordinatorOptions {
  snapshot: () => StableOwnerSnapshot;
  warn: (message: string, meta: Record<string, unknown>) => void;
  retryDelaysMs?: readonly number[];
  scheduleRetry?: (callback: () => void, delayMs: number) => unknown;
  cancelRetry?: (handle: unknown) => void;
}

const DEFAULT_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000] as const;

/**
 * Serializes the work that must run after the durable Ghost projection
 * boundary is stable. This includes the signed-out scope: account-free
 * bundled reconciliation still runs there, while the task itself gates work
 * that requires a data owner. A completed scope is memoized, while a deferred
 * or failed pass remains eligible for the next stable opportunity.
 */
export class StableOwnerPostCommitCoordinator {
  private task: StableOwnerPostCommitTask | null = null;
  private chain: Promise<void> = Promise.resolve();
  private inFlight: {
    scopeKey: string;
    promise: Promise<StableOwnerPostCommitOutcome>;
  } | null = null;
  private completedScopeKey: string | null = null;
  private retryHandle: unknown = null;
  private retryScopeKey: string | null = null;
  private retryAttempt = 0;
  private taskGeneration = 0;

  constructor(private readonly options: StableOwnerPostCommitCoordinatorOptions) {}

  setTask(task: StableOwnerPostCommitTask | null): void {
    this.cancelScheduledRetry();
    this.task = task;
    this.completedScopeKey = null;
    this.taskGeneration += 1;
  }

  ensure(reason: string): Promise<StableOwnerPostCommitOutcome> {
    const requested = this.options.snapshot();
    if (this.retryScopeKey && this.retryScopeKey !== requested.scopeKey) {
      this.cancelScheduledRetry();
    }
    const dataOwnerId = requested.dataOwnerId;
    if (!requested.stable || !this.task) return Promise.resolve('deferred');
    if (this.completedScopeKey === requested.scopeKey) return Promise.resolve('completed');
    if (this.inFlight?.scopeKey === requested.scopeKey) return this.inFlight.promise;

    const task = this.task;
    if (!task) return Promise.resolve('deferred');
    const scheduled = this.chain
      .catch(() => undefined)
      .then(async (): Promise<StableOwnerPostCommitOutcome> => {
        const current = this.options.snapshot();
        if (
          !current.stable
          || current.dataOwnerId !== requested.dataOwnerId
          || current.scopeKey !== requested.scopeKey
        ) {
          return 'deferred';
        }
        try {
          const outcome = await task({
            reason,
            scopeKey: requested.scopeKey,
            dataOwnerId,
          });
          const settled = this.options.snapshot();
          if (
            outcome === 'completed'
            && settled.stable
            && settled.scopeKey === requested.scopeKey
            && settled.dataOwnerId === requested.dataOwnerId
          ) {
            this.cancelScheduledRetry();
            this.completedScopeKey = requested.scopeKey;
            return 'completed';
          }
          const effectiveOutcome = outcome === 'completed' ? 'deferred' : outcome;
          this.scheduleAutomaticRetry(requested, reason, effectiveOutcome);
          return effectiveOutcome;
        } catch (error) {
          this.options.warn('stable owner post-commit task failed', {
            reason,
            scopeKey: requested.scopeKey,
            error: error instanceof Error ? error.message : String(error),
          });
          this.scheduleAutomaticRetry(requested, reason, 'failed');
          return 'failed';
        }
      });

    this.chain = scheduled.then(() => undefined);
    this.inFlight = { scopeKey: requested.scopeKey, promise: scheduled };
    void scheduled.then(() => {
      if (this.inFlight?.promise === scheduled) this.inFlight = null;
    });
    return scheduled;
  }

  private scheduleAutomaticRetry(
    requested: StableOwnerSnapshot,
    reason: string,
    outcome: Exclude<StableOwnerPostCommitOutcome, 'completed' | 'not-applicable'>,
  ): void {
    const current = this.options.snapshot();
    if (
      !current.stable
      || current.scopeKey !== requested.scopeKey
      || current.dataOwnerId !== requested.dataOwnerId
      || !this.task
    ) {
      this.cancelScheduledRetry();
      return;
    }
    if (this.retryHandle !== null && this.retryScopeKey === requested.scopeKey) return;

    const delays = this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const delayMs = delays[Math.min(this.retryAttempt, delays.length - 1)] ?? 60_000;
    const generation = this.taskGeneration;
    this.retryScopeKey = requested.scopeKey;
    const schedule = this.options.scheduleRetry ?? ((callback, delay) => {
        const handle = setTimeout(callback, delay);
        handle.unref?.();
        return handle;
      });
    this.retryHandle = schedule(() => {
      this.retryHandle = null;
      if (generation !== this.taskGeneration) return;
      const latest = this.options.snapshot();
      if (
        !latest.stable
        || latest.scopeKey !== requested.scopeKey
        || latest.dataOwnerId !== requested.dataOwnerId
      ) {
        this.retryScopeKey = null;
        this.retryAttempt = 0;
        return;
      }
      this.retryAttempt += 1;
      void this.ensure(`automatic-retry:${reason}:${outcome}`);
    }, delayMs);
  }

  private cancelScheduledRetry(): void {
    if (this.retryHandle !== null) {
      const cancel = this.options.cancelRetry ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
      cancel(this.retryHandle);
    }
    this.retryHandle = null;
    this.retryScopeKey = null;
    this.retryAttempt = 0;
  }
}
