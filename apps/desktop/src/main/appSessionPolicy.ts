import type { AppSessionMode } from './appSessionState.js';

interface MigrationAuthState {
  mode: AppSessionMode;
  dataOwnerId: string | null;
  user: { id: string } | null;
}

interface DataOwnerState {
  dataOwnerId: string | null;
}

/**
 * Accept local DB work only for a committed owner outside an account boundary.
 * The previous owner remains visible until the switch commits, so owner-id
 * equality alone is not sufficient while teardown is pending.
 */
export function isLocalDbOwnerCurrent(
  state: DataOwnerState,
  requestedOwnerId: string,
  boundaryPending: boolean,
): boolean {
  return !boundaryPending && state.dataOwnerId === requestedOwnerId;
}

/**
 * Return the verified cloud owner eligible for the legacy XDMaker userData
 * migration. ("XDMaker" here is the pre-rebrand product whose userData we
 * migrate FROM — not the current app; do not rename it to Cindy.)
 * Local and signed-out modes deterministically return null and therefore must
 * never probe the legacy userData directory.
 */
export function legacyMigrationOwner(
  state: MigrationAuthState,
  requestedOwnerId: string,
): string | null {
  if (state.dataOwnerId !== requestedOwnerId) {
    throw new Error('local database owner does not match the active app session');
  }
  if (state.mode !== 'cloud') return null;
  if (!state.user || state.user.id !== requestedOwnerId) {
    throw new Error('cloud database owner does not match the authenticated membership');
  }
  return state.user.id;
}
