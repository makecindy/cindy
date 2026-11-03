import type { HostedRemoteCollectionItem } from './remoteResources';

/** Give a cold relay a bounded window before falling back to cached remote rows. */
export const REMOTE_RESOURCE_STARTUP_TIMEOUT_MS = 10_000;

/** A host reply is evidence only for the connection in which it arrived. */
export function isRemoteResourceHostOnline(
  relayStatus: string,
  presence: boolean | null,
  replyEpoch: number | undefined,
  connectionEpoch: number,
): boolean {
  return relayStatus === 'online' && presence !== false && replyEpoch === connectionEpoch;
}

let cacheOwner = '';
const collections = new Map<string, HostedRemoteCollectionItem[]>();

/** Keep the last roster across navigation, isolated to the current account generation. */
export function readRemoteCollectionCache(owner: string, collectionId: string): HostedRemoteCollectionItem[] {
  if (owner !== cacheOwner) { cacheOwner = owner; collections.clear(); }
  return collections.get(collectionId) ?? [];
}

export function hasRemoteCollectionCache(owner: string, collectionId: string): boolean {
  return owner === cacheOwner && collections.has(collectionId);
}

export function writeRemoteCollectionCache(owner: string, collectionId: string, items: HostedRemoteCollectionItem[]): void {
  if (owner !== cacheOwner) return;
  collections.set(collectionId, items);
}

/** Connection evidence is independent of whether a resource/API request succeeded. */
export function remoteResourceConnectionState(relayStatus: string, presence: boolean | null): boolean | null {
  // `stopped` / `connecting` are the relay startup window, not evidence that
  // the hosted computer is offline.  Keep that distinction visible to list
  // consumers so a cold launch can stay in its loading state until the first
  // live reply establishes the host status.
  if (relayStatus !== 'online') return null;
  if (presence === false) return false;
  return presence === true ? true : null;
}
