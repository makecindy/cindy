import { sharedTaskHostPeer, type SharedTaskListItem } from '@cindy/device-link';
import { filterCindyMakeSharedTasks } from '@cindy/maker-shared/cindy-make-feature';
import { mobileDebugLog } from '@/debug/mobileDebugLog';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { RemoteSession } from '@/session/types';
import { markDeviceAccessRevoked } from './accessRevoked';
import type { useDeviceLink } from './DeviceLinkContext';

export async function leaveHiddenSharedTask(
  task: SharedTaskListItem,
  closeLink: ReturnType<typeof useDeviceLink>['closeLink'],
  leave: (sharedTaskId: string) => Promise<unknown>,
  isCurrent: () => boolean,
) {
  if (!isCurrent()) return;
  await leave(task.sharedTaskId);
  if (!isCurrent()) return;
  const peer = sharedTaskHostPeer(task.sharedTaskId, task.hostDeviceId);
  markDeviceAccessRevoked(peer);
  closeLink(peer);
  remoteSessionStore.removeDevice(peer);
}

export function filterVisibleSharedTasks(
  tasks: readonly SharedTaskListItem[],
  ownerAccountId: string | null,
  link: Pick<ReturnType<typeof useDeviceLink>, 'openLink' | 'invoke' | 'closeLink'>,
  isCurrent: () => boolean,
  leave: (sharedTaskId: string) => Promise<unknown>,
) {
  const deviceId = (task: SharedTaskListItem) => task.ownerAccountId === ownerAccountId
    ? task.hostDeviceId : sharedTaskHostPeer(task.sharedTaskId, task.hostDeviceId);
  return filterCindyMakeSharedTasks(tasks, {
    isCurrent,
    onHiddenTask: task => task.ownerAccountId === ownerAccountId
      ? Promise.resolve() : leaveHiddenSharedTask(task, link.closeLink, leave, isCurrent),
    onHiddenTaskError: () => mobileDebugLog('warn', 'device-link', 'Hidden shared task membership cleanup failed; will retry on refresh'),
    knownSession: task => remoteSessionStore.getSessions().find(session =>
      session.id === task.sessionId && session.deviceLinkDeviceId === deviceId(task)),
    readSession: async task => {
      const peer = deviceId(task);
      if (task.ownerAccountId !== ownerAccountId) {
        await link.openLink(peer);
        if (!isCurrent()) return null;
      }
      return link.invoke<RemoteSession | null>(peer, 'local-db:sessions:get', [task.sessionId]);
    },
  });
}
