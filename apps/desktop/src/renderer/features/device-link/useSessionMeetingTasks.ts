import { useEffect } from 'react';
import { meetingHostPeer, parseMeetingPeer, type SessionMeetingListItem } from '@cindy/device-link';
import { useAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';
import { remoteProjectsStore } from './remoteProjectsStore';
import { bindSharedTaskPushOwner, resetRemoteDataOwnerPushFence } from '@/lib/remoteDataOwnerPushFence';

/** Meeting peers have their own authority list, independent of the user's device directory. */
export function useSessionMeetingTasks(): void {
  const { isAuthenticated, dataOwnerId, dataOwnerRecoveryEpoch } = useAuth();
  const ownerGeneration = getDataOwnerGeneration().generation;
  useEffect(() => {
    if (!isAuthenticated) return;
    let disposed = false;
    const owner = getDataOwnerGeneration();
    const currentOwner = () => !disposed && isDataOwnerGenerationCurrent(owner);
    let busy = false;
    const linked = new Map<string, string>();
    const poll = async () => {
      if (busy || !currentOwner()) return;
      busy = true;
      try {
        const meetings = await window.electronAPI.sessionMeeting.account({ action: 'list' }) as SessionMeetingListItem[];
        if (!currentOwner()) return;
        const current = new Set(meetings.map((meeting) => meetingHostPeer(meeting.meetingId)));
        for (const id of remoteProjectsStore.getAllDeviceIds()) {
          if (!parseMeetingPeer(id) || current.has(id)) continue;
          linked.delete(id);
          resetRemoteDataOwnerPushFence(id);
          remoteProjectsStore.removeDevice(id);
          void window.electronAPI.deviceLink.closeLink(id);
        }
        for (const meeting of meetings) {
          if (!currentOwner()) return;
          const peer = meetingHostPeer(meeting.meetingId);
          bindSharedTaskPushOwner(peer, meeting.ownerAccountId);
          try {
            if (!linked.has(peer)) {
              await window.electronAPI.deviceLink.openLink(peer);
              if (!currentOwner()) return;
              await window.electronAPI.deviceLink.subscribe(peer, ['session:' + meeting.sessionId]);
              if (!currentOwner()) return;
              linked.set(peer, meeting.sessionId);
            }
            const session = await window.electronAPI.deviceLink.invoke(peer, 'local-db:sessions:get', [meeting.sessionId]) as Session;
            if (!currentOwner()) return;
            if (session?.id !== meeting.sessionId) throw new Error('Meeting task mismatch');
            remoteProjectsStore.setDeviceSessions(peer, meeting.title, [session]);
          } catch {
            if (!currentOwner()) return;
            remoteProjectsStore.markDeviceDisconnected(peer);
          }
        }
      } catch { /* No authority response is not evidence of departure. */ }
      finally { busy = false; }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 5_000);
    return () => {
      disposed = true;
      clearInterval(timer);
      for (const [peer, sessionId] of linked) {
        if (!isDataOwnerGenerationCurrent(owner)) break;
        void window.electronAPI.deviceLink.unsubscribe(peer, ['session:' + sessionId]).catch(() => undefined);
        remoteProjectsStore.removeDevice(peer);
        resetRemoteDataOwnerPushFence(peer);
      }
    };
  }, [dataOwnerId, ownerGeneration, dataOwnerRecoveryEpoch, isAuthenticated]);
}
