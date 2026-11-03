import { readSidebarOwnerStorage, writeSidebarOwnerStorage } from './sidebarOwnerStorage';

const KEY = 'cindy.mainEntry.v1';

/**
 * Device-local navigation memory; never retain a partner or task identifier.
 * Teammates share the task sidebar, so a remembered bots entry reopens a chat
 * (`/bots` resolves the last-viewed teammate, else Cindy) instead of an empty list pane.
 */
export function readMainEntryRoute(ownerId: string | null): '/bots' | '/cc-agent' {
  return readSidebarOwnerStorage(KEY, ownerId) === 'bots' ? '/bots' : '/cc-agent';
}

export function mainEntryRouteForPath(pathname: string): '/bots' | '/cc-agent' | null {
  return pathname === '/bots' || pathname.startsWith('/bots/')
    ? '/bots'
    : pathname === '/cc-agent' || pathname.startsWith('/cc-agent/')
      ? '/cc-agent'
      : null;
}

export function rememberMainEntry(ownerId: string | null, pathname: string): void {
  const route = mainEntryRouteForPath(pathname);
  if (route) writeSidebarOwnerStorage(KEY, ownerId, route === '/bots' ? 'bots' : 'tasks');
}
