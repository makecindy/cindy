/**
 * Tracks the account-scoped provider/model refresh that may outlive DB read readiness.
 *
 * Existing task lists may render before this barrier settles, while any path that can
 * create or send to an agent waits for the current app-session scope. A new generation
 * also waits for the previous scope before replacing the DB, so detached refresh work
 * cannot write account-scoped catalog state after the ownership boundary has moved on.
 *
 * Same-owner generation rollover is not an account switch: adopt a *completed*
 * discovery task onto the new key. A real teardown invalidates adoption so
 * A → signed-out → A cannot reuse the pre-logout catalog, while the old
 * promise remains joinable for waitForPreviousScope.
 */

/** Matches `activeOwnerScopeKey()`: `${mode}:${dataOwnerId ?? 'none'}:${generation}`. */
export function ownerIdentityFromScopeKey(scopeKey: string): string {
  const lastColon = scopeKey.lastIndexOf(':');
  return lastColon === -1 ? scopeKey : scopeKey.slice(0, lastColon);
}

export function isSameOwnerScopeKey(left: string, right: string): boolean {
  return ownerIdentityFromScopeKey(left) === ownerIdentityFromScopeKey(right);
}

/** Clear the process catalog only after joining a *different owner*, not a generation bump. */
export function shouldClearCatalogAfterJoiningPreviousScope(opts: {
  waited: boolean;
  currentSameOwnerAsNext: boolean;
}): boolean {
  return opts.waited && !opts.currentSameOwnerAsNext;
}

interface ReadinessEntry {
  scopeKey: string;
  promise: Promise<void>;
  adoptable: boolean;
  discoveryComplete: boolean;
  consumersStarted: boolean;
}

export interface AccountProviderReadinessHandle {
  readonly scopeKey: string;
  isLive(): boolean;
  markDiscoveryComplete(): boolean;
}

export type AccountProviderReadinessBarrier = ReturnType<
  typeof createAccountProviderReadinessBarrier
>;

function createHandle(
  readCurrent: () => ReadinessEntry | null,
  entry: ReadinessEntry,
): AccountProviderReadinessHandle {
  return {
    get scopeKey() {
      return entry.scopeKey;
    },
    isLive() {
      return readCurrent() === entry;
    },
    markDiscoveryComplete() {
      if (readCurrent() !== entry) return false;
      entry.discoveryComplete = true;
      return true;
    },
  };
}

export function createAccountProviderReadinessBarrier() {
  let current: ReadinessEntry | null = null;

  return {
    hasScope(scopeKey: string): boolean {
      return current?.scopeKey === scopeKey;
    },

    hasSameOwnerIdentity(scopeKey: string): boolean {
      return current != null && isSameOwnerScopeKey(current.scopeKey, scopeKey);
    },

    hasAdoptableSameOwner(scopeKey: string): boolean {
      return current?.adoptable === true && isSameOwnerScopeKey(current.scopeKey, scopeKey);
    },

    isCurrentAdoptable(): boolean {
      return current?.adoptable === true;
    },

    isDiscoveryComplete(): boolean {
      return current?.discoveryComplete === true;
    },

    needsIncompleteDiscoveryResume(scopeKey: string): boolean {
      return (
        current?.adoptable === true &&
        current.discoveryComplete === false &&
        isSameOwnerScopeKey(current.scopeKey, scopeKey)
      );
    },

    invalidateAdoption(): void {
      if (current) current.adoptable = false;
    },

    currentHandle(): AccountProviderReadinessHandle | null {
      return current ? createHandle(() => current, current) : null;
    },

    markDiscoveryComplete(): void {
      if (current) current.discoveryComplete = true;
    },

    markConsumersStarted(): boolean {
      if (!current || current.consumersStarted) return false;
      current.consumersStarted = true;
      return true;
    },

    start(
      scopeKey: string,
      task: (handle: AccountProviderReadinessHandle) => Promise<void>,
      onError: (error: unknown) => void,
    ): Promise<void> {
      if (current?.scopeKey === scopeKey) return current.promise;
      // Only suppress a second task while this owner incarnation is still live.
      // After a real teardown, adoptable is false so A → signed-out → A starts fresh.
      if (current?.adoptable && isSameOwnerScopeKey(current.scopeKey, scopeKey)) {
        return current.promise;
      }

      const entry: ReadinessEntry = {
        scopeKey,
        promise: Promise.resolve(),
        adoptable: true,
        discoveryComplete: false,
        consumersStarted: false,
      };
      const handle = createHandle(() => current, entry);
      entry.promise = Promise.resolve()
        .then(() => task(handle))
        .catch((error) => {
          try {
            onError(error);
          } catch {
            // The barrier must always settle: logging failure cannot block future owners.
          }
        });
      current = entry;
      return entry.promise;
    },

    async waitForScope(scopeKey: string): Promise<boolean> {
      const snapshot = current;
      if (snapshot?.scopeKey !== scopeKey) return false;
      await snapshot.promise;
      return current === snapshot && snapshot.discoveryComplete;
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

    async adoptSameOwnerAfterPreviousSettles(nextScopeKey: string): Promise<boolean> {
      if (current?.scopeKey === nextScopeKey) {
        const snapshot = current;
        await snapshot.promise;
        return current === snapshot && snapshot.adoptable && snapshot.discoveryComplete;
      }
      if (!current?.adoptable || !isSameOwnerScopeKey(current.scopeKey, nextScopeKey)) {
        return false;
      }
      const snapshot = current;
      await snapshot.promise;
      if (current !== snapshot || !snapshot.adoptable || !snapshot.discoveryComplete) {
        return false;
      }
      current = {
        scopeKey: nextScopeKey,
        promise: snapshot.promise,
        adoptable: snapshot.adoptable,
        discoveryComplete: snapshot.discoveryComplete,
        consumersStarted: snapshot.consumersStarted,
      };
      return true;
    },
  };
}

/** Process-lifetime barrier shared by bootstrap and every Desktop Maker instance. */
export const accountProviderReadinessBarrier = createAccountProviderReadinessBarrier();
