type Coordinator = <T>(sessionIds: readonly string[], operation: () => Promise<T>) => Promise<T>;

// LocalDB may load before Maker. No automation can race before runtime wiring.
let coordinator: Coordinator = async (_sessionIds, operation) => operation();

export function configureBotModelSelectionCoordinator(next: Coordinator): void {
  coordinator = next;
}

export function coordinateBotModelSelection<T>(sessionIds: readonly string[], operation: () => Promise<T>): Promise<T> {
  return coordinator(sessionIds, operation);
}

/** Serialize the profile transaction with baseline writers in every following lane.
 * Invalidation is synchronous: a queued automation must see the saved choice even
 * when the fire-and-forget runtime refresh has not acquired its lock yet. */
export function createBotModelSelectionCoordinator(deps: {
  acquireSessionLock(sessionId: string): Promise<() => void>;
  invalidate(sessionId: string): void;
}): Coordinator {
  return async (sessionIds, operation) => {
    const ids = [...new Set(sessionIds)].sort();
    const releases: Array<() => void> = [];
    try {
      for (const id of ids) releases.push(await deps.acquireSessionLock(id));
      const result = await operation();
      for (const id of ids) deps.invalidate(id);
      return result;
    } finally {
      for (const release of releases.reverse()) release();
    }
  };
}
