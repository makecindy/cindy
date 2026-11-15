import { useEffect } from 'react';
import { sharedTaskHostPeer, parseSharedTaskPeer, startSharedTaskListPoller, type SharedTaskListItem } from '@cindy/device-link';
import { CINDY_MAKE_ENABLED, isCindyMakeSource } from '@cindy/maker-shared/cindy-make-feature';
import { useAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';
import { remoteProjectsStore } from './remoteProjectsStore';
import { bindSharedTaskPushOwner, resetRemoteDataOwnerPushFence } from '@/lib/remoteDataOwnerPushFence';
import { leaveHiddenSharedTask } from './sharedTaskVisibility';

const membershipChangedEvent = 'cindy:shared-task-membership-changed';
// Dispatched by notifySharedTaskEnded when a host revokes this guest.
const accessEndedEvent = 'cindy:shared-task-access-ended';

/** Rereads the guest directory now, e.g. after joining on this device. */
export function notifySharedTaskMembershipChanged(): void {
  window.dispatchEvent(new Event(membershipChangedEvent));
}

/** SharedTask peers have their own authority list, independent of the user's device directory. */
export function useSharedTaskTasks(): void {
  const { isAuthenticated, dataOwnerId, dataOwnerRecoveryEpoch } = useAuth();
  const ownerGeneration = getDataOwnerGeneration().generation;
  useEffect(() => {
    if (!isAuthenticated) return;
    let disposed = false;
    const owner = getDataOwnerGeneration();
    const currentOwner = () => !disposed && isDataOwnerGenerationCurrent(owner);
    const linked = new Map<string, string>();
    const poll = async ({ fresh }: { fresh: boolean }): Promise<number | null> => {
      if (!currentOwner()) return null;
      try {
        // Event-driven reads bypass Main's short list reuse.
        const sharedTasks = await window.electronAPI.sharedTask.account({ action: 'list', ...(fresh ? { fresh: true } : {}) }) as SharedTaskListItem[];
        if (!currentOwner()) return null;
        const current = new Set(sharedTasks.map((sharedTask) => sharedTaskHostPeer(sharedTask.sharedTaskId, sharedTask.hostDeviceId)));
        for (const id of remoteProjectsStore.getAllDeviceIds()) {
          if (!parseSharedTaskPeer(id) || current.has(id)) continue;
          linked.delete(id);
          resetRemoteDataOwnerPushFence(id);
          remoteProjectsStore.removeDevice(id);
          void window.electronAPI.deviceLink.closeLink(id);
        }
        for (const sharedTask of sharedTasks) {
          if (!currentOwner()) return null;
          const peer = sharedTaskHostPeer(sharedTask.sharedTaskId, sharedTask.hostDeviceId);
          try {
            const known = remoteProjectsStore.getDeviceSessions(peer).find(session => session.id === sharedTask.sessionId);
            if (!CINDY_MAKE_ENABLED && isCindyMakeSource(known?.source)) {
              await leaveHiddenSharedTask(sharedTask, currentOwner);
              linked.delete(peer);
              continue;
            }
            bindSharedTaskPushOwner(peer, sharedTask.ownerAccountId);
            if (!linked.has(peer)) {
              await window.electronAPI.deviceLink.openLink(peer);
              if (!currentOwner()) return null;
              await window.electronAPI.deviceLink.subscribe(peer, ['session:' + sharedTask.sessionId]);
              if (!currentOwner()) return null;
              linked.set(peer, sharedTask.sessionId);
            }
            const session = await window.electronAPI.deviceLink.invoke(peer, 'local-db:sessions:get', [sharedTask.sessionId]) as Session;
            if (!currentOwner()) return null;
            if (session?.id !== sharedTask.sessionId) throw new Error('SharedTask task mismatch');
            if (!CINDY_MAKE_ENABLED && isCindyMakeSource(session.source)) {
              await leaveHiddenSharedTask(sharedTask, currentOwner);
              linked.delete(peer);
              continue;
            }
            remoteProjectsStore.setDeviceSessions(peer, sharedTask.title, [session]);
          } catch {
            if (!currentOwner()) return null;
            remoteProjectsStore.markDeviceDisconnected(peer);
          }
        }
        return sharedTasks.length;
      } catch { return null; /* No authority response is not evidence of departure. */ }
    };
    const poller = startSharedTaskListPoller({ poll, isVisible: () => document.visibilityState !== 'hidden' });
    const refresh = () => poller.refresh();
    const visibilityChanged = () => poller.visibilityChanged();
    // Window focus is deliberately ignored: switching windows is too frequent.
    document.addEventListener('visibilitychange', visibilityChanged);
    window.addEventListener(membershipChangedEvent, refresh);
    window.addEventListener(accessEndedEvent, refresh);
    const offStatus = window.electronAPI.deviceLink.onStatusChanged((state) => {
      if (state.status === 'online') refresh();
    });
    return () => {
      disposed = true;
      poller.dispose();
      document.removeEventListener('visibilitychange', visibilityChanged);
      window.removeEventListener(membershipChangedEvent, refresh);
      window.removeEventListener(accessEndedEvent, refresh);
      offStatus();
      for (const [peer, sessionId] of linked) {
        if (!isDataOwnerGenerationCurrent(owner)) break;
        void window.electronAPI.deviceLink.unsubscribe(peer, ['session:' + sessionId]).catch(() => undefined);
        remoteProjectsStore.removeDevice(peer);
        resetRemoteDataOwnerPushFence(peer);
      }
    };
  }, [dataOwnerId, ownerGeneration, dataOwnerRecoveryEpoch, isAuthenticated]);
}
