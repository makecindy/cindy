import { useEffect, useState } from 'react';
import { isSharedTaskPeer, sharedTaskHostPeer, type SharedTaskListItem } from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { RemoteSession } from '@/session/types';
import { useDeviceLink } from './DeviceLinkContext';
import { useSharedTaskApi } from './useSharedTaskApi';

/** Shared tasks have their own account authority list, separate from paired devices. */
export function useSharedTasks(): readonly SharedTaskListItem[] {
  const { accountGeneration, isAuthenticated } = useAuth();
  const api = useSharedTaskApi();
  const { openLink, closeLink, invoke, status, sharedTaskAvailable } = useDeviceLink();
  const [owned, setOwned] = useState<{ owner: ReturnType<typeof getMobileAuthOwner>; tasks: SharedTaskListItem[] } | null>(null);
  useEffect(() => {
    if (!isAuthenticated || status !== 'online' || sharedTaskAvailable !== true) return;
    const owner = getMobileAuthOwner();
    let disposed = false;
    let busy = false;
    const current = () => !disposed && isMobileAuthOwnerCurrent(owner);
    const poll = async () => {
      if (busy || !current()) return;
      busy = true;
      try {
        const all = await api.list();
        if (!current()) return;
        // Owner discovery must not depend on full-device remote-control permission.
        // Only guests are auto-connected through task-scoped peers.
        setOwned({ owner, tasks: all.filter(task => task.ownerAccountId === owner.accountId) });
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
          if (!current()) return;
          const peer = sharedTaskHostPeer(task.sharedTaskId, task.hostDeviceId);
          try {
            await openLink(peer);
            if (!current()) return;
            const session = await invoke<RemoteSession>(peer, 'local-db:sessions:get', [task.sessionId]);
            if (!current()) return;
            if (session.id === task.sessionId) remoteSessionStore.setDeviceSessions(peer, task.title, [session]);
          } catch { /* Keep offline history; only the authority list removes membership. */ }
        }
      } catch { /* A transient authority failure is not evidence of departure. */ }
      finally { busy = false; }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 5_000);
    return () => { disposed = true; clearInterval(timer); };
  }, [accountGeneration, api, closeLink, invoke, isAuthenticated, openLink, sharedTaskAvailable, status]);
  return isAuthenticated && owned && isMobileAuthOwnerCurrent(owned.owner) ? owned.tasks : [];
}
