import type { HostedRemoteCollectionItem } from './remoteResources';

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

export function writeRemoteCollectionCache(owner: string, collectionId: string, items: HostedRemoteCollectionItem[]): void {
  if (owner !== cacheOwner) return;
  collections.set(collectionId, items);
}

/** Connection evidence is independent of whether a resource/API request succeeded. */
export function remoteResourceConnectionState(relayStatus: string, presence: boolean | null): boolean | null {
  if (presence === false || relayStatus === 'stopped') return false;
  return relayStatus === 'online' && presence === true ? true : null;
}
