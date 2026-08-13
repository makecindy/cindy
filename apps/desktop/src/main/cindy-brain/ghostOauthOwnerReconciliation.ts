/**
 * Deduplicate OAuth crash reconciliation only within the same durable owner.
 *
 * Different owner scopes must never share an in-flight result: an old owner
 * can fail while its database is being closed, and that stale failure must not
 * suppress the newly committed owner's reconciliation. The completion flag is
 * intentionally supplied by the caller so a task that became stale mid-run
 * cannot mark its scope reconciled.
 */
export function createGhostOauthOwnerReconciliationGate(): {
  run: (
    ownerScope: string,
    reconcile: () => Promise<boolean>,
  ) => Promise<void>;
} {
  let reconciledOwnerScope: string | null = null;
  const inFlightByOwnerScope = new Map<string, Promise<void>>();

  return {
    async run(ownerScope, reconcile): Promise<void> {
      if (reconciledOwnerScope === ownerScope) return;
      const existing = inFlightByOwnerScope.get(ownerScope);
      if (existing) return existing;

      let task!: Promise<void>;
      task = (async () => {
        if (await reconcile()) reconciledOwnerScope = ownerScope;
      })();
      inFlightByOwnerScope.set(ownerScope, task);
      try {
        await task;
      } finally {
        if (inFlightByOwnerScope.get(ownerScope) === task) {
          inFlightByOwnerScope.delete(ownerScope);
        }
      }
    },
  };
}
