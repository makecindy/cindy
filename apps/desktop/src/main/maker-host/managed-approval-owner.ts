import { getDeviceId } from '../authManager.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { getActiveAppSession, activeOwnerScopeKey, isAppSessionBoundaryPending,
  ownerScopedUserDataPath } from '../appSessionState.js';

type Owner = { ownerId: string; executionHostId: string; generation: string; dbClient: object };

/** Main-owned identity shared by the local composer and its managed deny consumer. */
export function captureManagedApprovalOwner(): (Owner & { ownerDataDir: string }) | null {
  const appOwner = getActiveAppSession();
  const dbClient = getCurrentDbClientSnapshot();
  const executionHostId = getDeviceId();
  const generation = activeOwnerScopeKey();
  if (isAppSessionBoundaryPending() || !appOwner.dataOwnerId || !dbClient || !executionHostId
    || dbClient.userId !== appOwner.dataOwnerId
    || generation !== [appOwner.mode, appOwner.dataOwnerId, appOwner.generation].join(':')) return null;
  return { ownerId: appOwner.dataOwnerId, executionHostId, generation, dbClient,
    ownerDataDir: ownerScopedUserDataPath() };
}

export function isManagedApprovalOwnerCurrent(owner: Owner): boolean {
  return !isAppSessionBoundaryPending() && activeOwnerScopeKey() === owner.generation
    && getActiveAppSession().dataOwnerId === owner.ownerId
    && getCurrentDbClientSnapshot() === owner.dbClient
    && getDeviceId() === owner.executionHostId;
}
