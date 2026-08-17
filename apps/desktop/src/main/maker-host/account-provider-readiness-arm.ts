export interface AccountProviderReadinessArmBinding {
  publish(ownerId: string, start: () => void, resume?: () => Promise<void>): void;
  clear(): void;
  startIfOwnerMatches(currentOwnerId: string | null): boolean;
  resumeIncompleteIfOwnerMatches(currentOwnerId: string | null): Promise<boolean>;
}

/**
 * Process-local handle for the latest owner-db start() closure.
 * Real account switches must clear() during teardown so a stale closure cannot
 * start discovery for the next owner. Same-owner generation rollover keeps the
 * binding and must not call start() — adopt the settled barrier instead.
 */
export function createAccountProviderReadinessArmBinding(): AccountProviderReadinessArmBinding {
  let bound: { ownerId: string; start: () => void; resume?: () => Promise<void> } | null =
    null;

  return {
    publish(ownerId, start, resume) {
      bound = { ownerId, start, resume };
    },
    clear() {
      bound = null;
    },
    startIfOwnerMatches(currentOwnerId) {
      if (!bound || !currentOwnerId || bound.ownerId !== currentOwnerId) return false;
      bound.start();
      return true;
    },
    async resumeIncompleteIfOwnerMatches(currentOwnerId) {
      if (!bound?.resume || !currentOwnerId || bound.ownerId !== currentOwnerId) return false;
      await bound.resume();
      return true;
    },
  };
}

export function shouldFirePendingReadinessStart(opts: {
  pendingOwnerId: string | null;
  currentOwnerId: string | null;
  boundaryPending: boolean;
}): boolean {
  return Boolean(
    opts.pendingOwnerId &&
      opts.currentOwnerId &&
      opts.pendingOwnerId === opts.currentOwnerId &&
      !opts.boundaryPending,
  );
}

/** Keep the one-shot pending start across a same-owner Ghost repair window. */
export function shouldKeepPendingReadinessStart(opts: {
  pendingOwnerId: string | null;
  currentOwnerId: string | null;
  boundaryPending: boolean;
}): boolean {
  return Boolean(
    opts.boundaryPending &&
      opts.pendingOwnerId &&
      opts.currentOwnerId &&
      opts.pendingOwnerId === opts.currentOwnerId,
  );
}

export const accountProviderReadinessArm = createAccountProviderReadinessArmBinding();
