export interface AccountDiscoveryReloadTracker {
  noteAuthState(input: { isAuthenticated: boolean; identityChanged: boolean }): boolean;
  reset(): void;
}

/** Distinguish a real sign-out → sign-in refill from the first authenticated startup snapshot. */
export function createAccountDiscoveryReloadTracker(): AccountDiscoveryReloadTracker {
  let reloadPendingAfterSignOut = false;

  return {
    noteAuthState({ isAuthenticated, identityChanged }): boolean {
      if (!isAuthenticated) {
        reloadPendingAfterSignOut = true;
        return false;
      }
      const shouldReload = identityChanged || reloadPendingAfterSignOut;
      reloadPendingAfterSignOut = false;
      return shouldReload;
    },
    reset(): void {
      reloadPendingAfterSignOut = false;
    },
  };
}
