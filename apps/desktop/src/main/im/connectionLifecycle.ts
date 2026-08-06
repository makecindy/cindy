/**
 * Serializes one process-wide IM connection across login, logout, account
 * replacement, and app quit. Keeping start/stop on one queue prevents a late
 * async start from bringing transports back online after logout has begun.
 */
export interface SerializedConnectionLifecycle {
  start(): void;
  stop(reason?: string): Promise<void>;
  runWhileStarted<T>(operation: () => Promise<T>): Promise<T>;
  isStarted(): boolean;
}

/** Dependencies are injected so lifecycle ordering stays unit-testable. */
export interface SerializedConnectionLifecycleDeps {
  startConnection(): Promise<void>;
  stopConnection(reason?: string): Promise<void>;
  onStartError(error: unknown): void;
}

/** Create an idempotent, restartable connection lifecycle. */
export function createSerializedConnectionLifecycle(
  deps: SerializedConnectionLifecycleDeps,
): SerializedConnectionLifecycle {
  let started = false;
  let needsStop = false;
  let generation = 0;
  let tail = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const current = tail.catch(() => undefined).then(operation);
    // A failed operation must not poison later logout/relogin operations.
    tail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      // Keep this set even if start fails: a partially initialized transport
      // still needs an explicit stop before its account resources are closed.
      needsStop = true;
      const requestedGeneration = ++generation;
      const operation = enqueue(async () => {
        // A stop requested before this queued start ran invalidates it.
        if (!started || generation !== requestedGeneration) return;
        await deps.startConnection();
      });
      void operation.catch((error) => {
        if (generation === requestedGeneration) started = false;
        deps.onStartError(error);
      });
    },

    async stop(reason?: string): Promise<void> {
      const shouldStopConnection = needsStop;
      started = false;
      needsStop = false;
      generation += 1;
      await enqueue(async () => {
        if (!shouldStopConnection) return;
        await deps.stopConnection(reason);
      });
    },

    runWhileStarted<T>(operation: () => Promise<T>): Promise<T> {
      if (!started) {
        return Promise.reject(new Error('[IM_NOT_READY] IM connection is not active'));
      }
      const requestedGeneration = generation;
      return enqueue(async () => {
        // Logout invalidates queued account-scoped work synchronously, before
        // transport shutdown or DbClient disposal begins.
        if (!started || generation !== requestedGeneration) {
          throw new Error('[IM_NOT_READY] IM connection stopped before operation ran');
        }
        return operation();
      });
    },

    isStarted(): boolean {
      return started;
    },
  };
}
