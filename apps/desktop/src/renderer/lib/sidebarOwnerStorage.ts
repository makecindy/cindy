const OWNER_CLAIM_KEY = 'cc-agent.sidebar.identityOwnerClaim.v1';

function safeStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

export function sidebarOwnerStorageKey(baseKey: string, ownerId: string): string {
  return `${baseKey}.owner.${encodeURIComponent(ownerId)}`;
}

function readClaimedOwner(storage: Storage): string | null | undefined {
  const raw = storage.getItem(OWNER_CLAIM_KEY);
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; ownerId?: unknown };
    return parsed.version === 1 && typeof parsed.ownerId === 'string' && parsed.ownerId.length > 0
      ? parsed.ownerId
      : null;
  } catch {
    return null;
  }
}

/**
 * The first signed-in/local data owner claims unscoped renderer sidebar data.
 * A malformed marker fails closed so a later account can never reinterpret it.
 */
export function claimLegacySidebarOwner(ownerId: string | null): boolean {
  if (!ownerId) return false;
  const storage = safeStorage();
  if (!storage) return false;
  try {
    const claimed = readClaimedOwner(storage);
    if (claimed !== undefined) return claimed === ownerId;
    storage.setItem(OWNER_CLAIM_KEY, JSON.stringify({ version: 1, ownerId }));
    return readClaimedOwner(storage) === ownerId;
  } catch {
    return false;
  }
}

/** Read an owner-scoped value, copying the legacy value only for its claimed owner. */
export function readSidebarOwnerStorage(baseKey: string, ownerId: string | null): string | null {
  if (!ownerId) return null;
  const storage = safeStorage();
  if (!storage) return null;
  const scopedKey = sidebarOwnerStorageKey(baseKey, ownerId);
  try {
    const scoped = storage.getItem(scopedKey);
    if (scoped !== null) return scoped;
    if (!claimLegacySidebarOwner(ownerId)) return null;
    const legacy = storage.getItem(baseKey);
    if (legacy === null) return null;
    storage.setItem(scopedKey, legacy);
    storage.removeItem(baseKey);
    return legacy;
  } catch {
    return null;
  }
}

export function writeSidebarOwnerStorage(
  baseKey: string,
  ownerId: string | null,
  value: string,
): boolean {
  if (!ownerId) return false;
  const storage = safeStorage();
  if (!storage) return false;
  try {
    storage.setItem(sidebarOwnerStorageKey(baseKey, ownerId), value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pinned order migrates to main-process storage, not another localStorage key.
 * Keep the legacy value until main confirms that the write reached disk.
 */
export function readClaimedLegacySidebarStorage(
  baseKey: string,
  ownerId: string | null,
): string | null {
  if (!ownerId || !claimLegacySidebarOwner(ownerId)) return null;
  try {
    return safeStorage()?.getItem(baseKey) ?? null;
  } catch {
    return null;
  }
}

export function clearClaimedLegacySidebarStorage(baseKey: string, ownerId: string | null): void {
  if (!ownerId || !claimLegacySidebarOwner(ownerId)) return;
  try {
    safeStorage()?.removeItem(baseKey);
  } catch {
    // A retained legacy copy only causes a same-owner retry on the next launch.
  }
}

export const __testing = { OWNER_CLAIM_KEY };
