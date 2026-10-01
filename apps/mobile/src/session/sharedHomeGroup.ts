import { isSharedTaskPeer, type SharedTaskListItem } from '@cindy/device-link';
import type { MobileHomePresentation, MobileHomeSessionLike } from './mobileHome';
import type { RemoteSessionListItem } from './sessionList';

export type SharedHomeRow =
  | { key: string; item: RemoteSessionListItem; role: SharedHomeRole; task?: never }
  | { key: string; role: 'owned'; task: SharedTaskListItem; item?: never };

export type SharedHomeRole = 'owned' | 'joined';

/** Group presentation only: routing IDs, store contents and grants stay untouched. */
export function splitSharedHomeGroup(home: MobileHomePresentation, owned: readonly SharedTaskListItem[], options: {
  sessions: readonly MobileHomeSessionLike[];
  searchQuery: string;
  statusFilter: string;
}): { home: MobileHomePresentation; rows: SharedHomeRow[] } {
  const owns = (session: MobileHomeSessionLike, task: SharedTaskListItem) =>
    session.id === task.sessionId && session.deviceLinkDeviceId === task.hostDeviceId;
  const isShared = (item: RemoteSessionListItem) => {
    const session = item.session as MobileHomeSessionLike;
    return isSharedTaskPeer(session.deviceLinkDeviceId) || owned.some(task => owns(session, task));
  };
  const all = [...home.pinned, ...home.chats, ...home.projects.flatMap(project => project.sessions)];
  const rows: SharedHomeRow[] = all.filter(isShared)
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
    .map(item => {
      const session = item.session as MobileHomeSessionLike;
      const role: SharedHomeRole = owned.some(task => owns(session, task)) ? 'owned' : 'joined';
      return { key: `shared:${session.deviceLinkDeviceId}:${session.id}`, item, role };
    });
  // Discovery is account-level even before same-account remote control is allowed.
  // Don't recreate a row that the active search/status filter intentionally hid.
  for (const task of owned) {
    if (options.sessions.some(session => owns(session, task))) continue;
    if (home.selectedDeviceId && home.selectedDeviceId !== task.hostDeviceId) continue;
    if (options.statusFilter !== 'active' && options.statusFilter !== 'all') continue;
    if (!task.title.toLocaleLowerCase().includes(options.searchQuery.trim().toLocaleLowerCase())) continue;
    rows.push({ key: `shared:${task.sharedTaskId}`, role: 'owned', task });
  }
  return {
    rows,
    home: {
      ...home,
      pinned: home.pinned.filter(item => !isShared(item)),
      chats: home.chats.filter(item => !isShared(item)),
      projects: home.projects.map(project => {
        const sessions = project.sessions.filter(item => !isShared(item));
        return { ...project, sessions, sessionCount: sessions.reduce((count, item) => count + (item.automationGroup?.sessionCount ?? 1), 0) };
      }).filter(project => project.sessions.length > 0),
    },
  };
}
