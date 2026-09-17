import { useEffect } from 'react';
import { isMeetingPeer, meetingHostPeer } from '@cindy/device-link';
import { useAuth } from '@/auth/AuthContext';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { RemoteSession } from '@/session/types';
import { useDeviceLink } from './DeviceLinkContext';
import { useSessionMeetingApi } from './useSessionMeetingApi';

/** Shared tasks have their own account authority list, separate from paired devices. */
export function useSharedTasks(): void {
  const { accountGeneration, isAuthenticated } = useAuth();
  const api = useSessionMeetingApi();
  const { openLink, closeLink, invoke, status, sessionMeetingAvailable } = useDeviceLink();
  useEffect(() => {
    if (!isAuthenticated || status !== 'online' || sessionMeetingAvailable !== true) return;
    const owner = getMobileAuthOwner();
    let disposed = false;
    let busy = false;
    const current = () => !disposed && isMobileAuthOwnerCurrent(owner);
    const poll = async () => {
      if (busy || !current()) return;
      busy = true;
      try {
        const tasks = (await api.list()).filter((task) => task.ownerAccountId !== owner.accountId);
        if (!current()) return;
        const peers = new Set(tasks.map((task) => meetingHostPeer(task.meetingId)));
        for (const task of remoteSessionStore.getSessions()) {
          const peer = task.deviceLinkDeviceId;
          if (peer && isMeetingPeer(peer) && !peers.has(peer)) {
            closeLink(peer);
            remoteSessionStore.removeDevice(peer);
          }
        }
        for (const task of tasks) {
          if (!current()) return;
          const peer = meetingHostPeer(task.meetingId);
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
  }, [accountGeneration, api, closeLink, invoke, isAuthenticated, openLink, sessionMeetingAvailable, status]);
}
