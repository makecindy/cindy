import { readSidebarOwnerStorage, writeSidebarOwnerStorage } from './sidebarOwnerStorage';

const KEY = 'cindy.mainEntry.v1';

/** Device-local navigation memory; never retain a partner or task identifier. */
export function readMainEntryRoute(ownerId: string | null): '/bots/list' | '/cc-agent' {
  return readSidebarOwnerStorage(KEY, ownerId) === 'bots' ? '/bots/list' : '/cc-agent';
}

export function rememberMainEntry(ownerId: string | null, pathname: string): void {
  const entry = pathname === '/bots' || pathname.startsWith('/bots/')
    ? 'bots'
    : pathname === '/cc-agent' || pathname.startsWith('/cc-agent/')
      ? 'tasks'
      : null;
  if (entry) writeSidebarOwnerStorage(KEY, ownerId, entry);
}
