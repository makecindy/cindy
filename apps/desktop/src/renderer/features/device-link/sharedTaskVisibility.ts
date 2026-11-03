import { sharedTaskHostPeer, type SharedTaskListItem } from '@cindy/device-link';
import { filterCindyMakeSharedTasks } from '@cindy/maker-shared/cindy-make-feature';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';
import { createLogger } from '@/lib/logger';
import * as sessionService from '@/lib/sessionService';
import { sessionsStore } from '@/lib/sessionsStore';
import { resetRemoteDataOwnerPushFence } from '@/lib/remoteDataOwnerPushFence';
import { remoteProjectsStore } from './remoteProjectsStore';

const log = createLogger('SharedTaskVisibility');

export async function leaveHiddenSharedTask(task: SharedTaskListItem, isCurrent: () => boolean) {
  if (!isCurrent()) return;
  await window.electronAPI.sharedTask.account({ action: 'leave', sharedTaskId: task.sharedTaskId });
  if (!isCurrent()) return;
  const peer = sharedTaskHostPeer(task.sharedTaskId, task.hostDeviceId);
  resetRemoteDataOwnerPushFence(peer);
  void window.electronAPI.deviceLink.closeLink(peer).catch(() => undefined);
  remoteProjectsStore.removeDevice(peer);
}

export function filterVisibleSharedTasks<Task extends SharedTaskListItem & { local?: boolean }>(
  tasks: readonly Task[],
  isCurrent: () => boolean,
) {
  const owner = getDataOwnerGeneration();
  const deviceId = (task: Task) => task.ownerAccountId === owner.dataOwnerId
    ? task.hostDeviceId : sharedTaskHostPeer(task.sharedTaskId, task.hostDeviceId);
  return filterCindyMakeSharedTasks(tasks, {
    isCurrent,
    onHiddenTask: task => task.ownerAccountId === owner.dataOwnerId
      ? Promise.resolve() : leaveHiddenSharedTask(task, isCurrent),
    onHiddenTaskError: () => log.warn('Hidden shared task membership cleanup failed; will retry on refresh'),
    knownSession: task => task.local
      ? sessionsStore.findById(task.sessionId)
      : remoteProjectsStore.getDeviceSessions(deviceId(task)).find(session => session.id === task.sessionId),
    readSession: async task => {
      if (task.local) return sessionService.get(task.sessionId);
      const peer = deviceId(task);
      if (task.ownerAccountId !== owner.dataOwnerId) {
        await window.electronAPI.deviceLink.openLink(peer);
        if (!isCurrent()) return null;
      }
      return window.electronAPI.deviceLink.invoke(peer, 'local-db:sessions:get', [task.sessionId]) as Promise<Session>;
    },
  });
}
