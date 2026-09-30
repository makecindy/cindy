import AsyncStorage from '@react-native-async-storage/async-storage';
import { readRemoteResourceSnapshot } from '@/device-link/remoteResourceCache';
import { serializeRemoteResourceTargets } from '@/device-link/remoteResources';

const PREFIX = 'cindy.homeEntry.v1.';
export type HomeEntry = 'bots' | 'tasks';
export type CompanionListHref = {
  pathname: '/resources/[collectionId]';
  params: { collectionId: string; title: string; targets: string };
};

/** Only a top-level choice is persisted, scoped by the realm-qualified account. */
export async function readHomeEntry(accountKey: string, userId: string): Promise<CompanionListHref | null> {
  if (!accountKey) return null;
  const entry = await AsyncStorage.getItem(PREFIX + accountKey).catch(() => null);
  if (entry !== 'bots') return null;
  const snapshot = await readRemoteResourceSnapshot(userId).catch(() => null);
  const collection = snapshot?.home.find((item) => item.id === 'teammates' && item.resourceKind === 'bot');
  // Sign-out/account-switch cleanup removes resource discovery. In that case
  // use the existing home so it can rediscover this account's hosts; never open
  // an unreachable empty list or borrow another account's targets.
  if (!collection || collection.targets.length === 0) return null;
  return {
    pathname: '/resources/[collectionId]',
    params: {
      collectionId: 'teammates',
      title: collection.title,
      targets: serializeRemoteResourceTargets(collection.targets),
    },
  };
}

// Preserve tap order even if native storage completes writes out of order.
let writes: Promise<void> = Promise.resolve();
export function saveHomeEntry(accountKey: string, entry: HomeEntry): Promise<void> {
  if (!accountKey) return Promise.resolve();
  writes = writes.then(() => AsyncStorage.setItem(PREFIX + accountKey, entry)).catch(() => undefined);
  return writes;
}

export function homeEntryForRoute(pathname: string, resourceKind?: string): HomeEntry | null {
  if (pathname === '/resources/teammates' || pathname.startsWith('/resources/teammates/')
    || pathname.startsWith('/companions/')) return 'bots';
  if (pathname.startsWith('/sessions/')) return resourceKind === 'bot' ? 'bots' : 'tasks';
  if (pathname === '/' || pathname === '/devices' || pathname.startsWith('/devices/')) return 'tasks';
  return null;
}
