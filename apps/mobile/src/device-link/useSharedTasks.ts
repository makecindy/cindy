import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { isSharedTaskPeer, sharedTaskHostPeer, startSharedTaskListPoller, type SharedTaskListItem } from '@cindy/device-link';
import { CINDY_MAKE_ENABLED, isCindyMakeSource } from '@cindy/maker-shared/cindy-make-feature';
import { useAuth } from '@/auth/AuthContext';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { RemoteSession } from '@/session/types';
import { useDeviceLink } from './DeviceLinkContext';
import { useSharedTaskApi } from './useSharedTaskApi';
import { filterVisibleSharedTasks, leaveHiddenSharedTask } from './sharedTaskVisibility';
import { onSharedTaskMembershipChanged } from './sharedTaskMembershipSignal';

/** Shared tasks have their own account authority list, separate from paired devices. */
export function useSharedTasks(): readonly SharedTaskListItem[] {
  const { accountGeneration, isAuthenticated } = useAuth();
  const api = useSharedTaskApi();
  const { openLink, closeLink, invoke, status: primaryStatus, sharedTaskAvailable, sharedTaskConnection } = useDeviceLink();
  const status = sharedTaskConnection?.status ?? primaryStatus;
  const [owned, setOwned] = useState<{ owner: ReturnType<typeof getMobileAuthOwner>; tasks: SharedTaskListItem[] } | null>(null);
  useEffect(() => {
    // Reconnecting reruns this effect, which reads immediately.
    if (!isAuthenticated || status !== 'online' || sharedTaskAvailable !== true) return;
    const owner = getMobileAuthOwner();
    let disposed = false;
    const current = () => !disposed && isMobileAuthOwnerCurrent(owner);
    const poll = async (): Promise<number | null> => {
      if (!current()) return null;
      try {
        const all = await api.list();
        if (!current()) return null;
        const visibleOwned = await filterVisibleSharedTasks(
          all.filter(task => task.ownerAccountId === owner.accountId), owner.accountId, { openLink, closeLink, invoke }, current, api.leave,
        );
        if (!current()) return null;
        setOwned({ owner, tasks: visibleOwned });
        const tasks = all.filter(task => task.ownerAccountId !== owner.accountId);
        const peers = new Set(tasks.map((task) => sharedTaskHostPeer(task.sharedTaskId, task.hostDeviceId)));
        for (const task of remoteSessionStore.getSessions()) {
          const peer = task.deviceLinkDeviceId;
          if (peer && isSharedTaskPeer(peer) && !peers.has(peer)) {
            closeLink(peer);
            remoteSessionStore.removeDevice(peer);
          }
        }
        for (const task of tasks) {
          if (!current()) return null;
          const peer = sharedTaskHostPeer(task.sharedTaskId, task.hostDeviceId);
          try {
            const known = remoteSessionStore.getSessions().find(session => session.id === task.sessionId && session.deviceLinkDeviceId === peer);
            if (!CINDY_MAKE_ENABLED && isCindyMakeSource(known?.source)) {
              await leaveHiddenSharedTask(task, closeLink, api.leave, current);
              continue;
            }
            await openLink(peer);
            if (!current()) return null;
            const session = await invoke<RemoteSession>(peer, 'local-db:sessions:get', [task.sessionId]);
            if (!current()) return null;
            if (session.id !== task.sessionId) continue;
            if (!CINDY_MAKE_ENABLED && isCindyMakeSource(session.source)) {
              await leaveHiddenSharedTask(task, closeLink, api.leave, current);
              continue;
            }
            remoteSessionStore.setDeviceSessions(peer, task.title, [session]);
          } catch { /* Keep offline history; only the authority list removes membership. */ }
        }
        return all.length;
      } catch { return null; /* A transient authority failure is not evidence of departure. */ }
    };
    const poller = startSharedTaskListPoller({ poll, isVisible: () => AppState.currentState === 'active' });
    const offMembership = onSharedTaskMembershipChanged(() => poller.refresh());
    const subscription = AppState.addEventListener('change', () => poller.visibilityChanged());
    return () => {
      disposed = true;
      poller.dispose();
      offMembership();
      subscription.remove();
    };
  }, [accountGeneration, api, closeLink, invoke, isAuthenticated, openLink, sharedTaskAvailable, status]);
  return isAuthenticated && owned && isMobileAuthOwnerCurrent(owned.owner) ? owned.tasks : [];
}
