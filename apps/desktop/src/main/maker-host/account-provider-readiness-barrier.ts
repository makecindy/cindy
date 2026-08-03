/**
 * Tracks the account-scoped provider/model refresh that may outlive DB read readiness.
 *
 * Existing task lists may render before this barrier settles, while any path that can
 * create or send to an agent waits for the current app-session scope. A new generation
 * also waits for the previous scope before replacing the DB, so detached refresh work
 * cannot write account-scoped catalog state after the ownership boundary has moved on.
 */
export function createAccountProviderReadinessBarrier() {
  let current: { scopeKey: string; promise: Promise<void> } | null = null;

  return {
    start(
      scopeKey: string,
      task: () => Promise<void>,
      onError: (error: unknown) => void,
    ): Promise<void> {
      if (current?.scopeKey === scopeKey) return current.promise;

      const promise = Promise.resolve()
        .then(task)
        .catch((error) => {
          try {
            onError(error);
          } catch {
            // The barrier must always settle: logging failure cannot block future owners.
          }
        });
      current = { scopeKey, promise };
      return promise;
    },

    async waitForScope(scopeKey: string): Promise<boolean> {
      const snapshot = current;
      if (snapshot?.scopeKey !== scopeKey) return false;
      await snapshot.promise;
      return current === snapshot;
    },

    async waitForPreviousScope(nextScopeKey: string): Promise<boolean> {
      let waited = false;
      while (current && current.scopeKey !== nextScopeKey) {
        waited = true;
        const snapshot = current;
        await snapshot.promise;
        if (current === snapshot) return waited;
      }
      return waited;
    },
  };
}

/** Process-lifetime barrier shared by bootstrap and every Desktop Maker instance. */
export const accountProviderReadinessBarrier = createAccountProviderReadinessBarrier();
