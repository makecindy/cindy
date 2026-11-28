/**
 * The active owner's physical name for a provider-secret key. Moved verbatim from
 * providerSecretStore.ts (which loads Electron and re-exports this), so the Node Host derives the
 * same names for the same safe-storage files.
 */
import { getActiveAppSession, dataOwnerStorageKey } from '../appSessionState.js';

export function ownerStoragePrefix(ownerId: string): string {
  return `owner_${dataOwnerStorageKey(ownerId)}_`;
}

/** Resolve a renderer/main logical provider-secret key into the active owner's key. */
export function resolveOwnerScopedSecretStorageKey(storageKey: string): string | null {
  const ownerId = getActiveAppSession().dataOwnerId;
  if (!ownerId) return null;
  return `${ownerStoragePrefix(ownerId)}${storageKey}`;
}
