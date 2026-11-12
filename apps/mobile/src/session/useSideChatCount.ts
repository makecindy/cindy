import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { isMobileAuthOwnerCurrent, type MobileAuthOwnerGeneration } from '@/auth/authOwnerGeneration';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { remoteSessionStore } from './remoteSessionStore';

/** Read the host's complete list, including children never opened on this phone. */
export function useSideChatCount({ deviceId, sessionId, maker, owner, enabled, refreshKey }: {
  deviceId: string;
  sessionId: string;
  maker: Pick<MobileMakerTransport, 'listSideChats'>;
  owner: MobileAuthOwnerGeneration;
  enabled: boolean;
  refreshKey: string;
}): number {
  const [snapshot, setSnapshot] = useState<{ deviceId: string; sessionId: string; owner: MobileAuthOwnerGeneration; count: number } | null>(null);
  useFocusEffect(useCallback(() => {
    if (!enabled) return;
    let active = true;
    let request = 0;
    const refresh = () => {
      const epoch = ++request;
      void maker.listSideChats(sessionId).then(rows => {
        if (active && request === epoch && isMobileAuthOwnerCurrent(owner)) {
          setSnapshot({ deviceId, sessionId, owner, count: rows.length });
        }
      }).catch(() => { /* Optional summary: explicit entry retains the retry/error UI. */ });
    };
    let cachedSessions: ReturnType<typeof remoteSessionStore.getSessions> | undefined;
    let cachedMembership = '';
    const membership = () => {
      const sessions = remoteSessionStore.getSessions();
      if (sessions !== cachedSessions) {
        cachedSessions = sessions;
        cachedMembership = JSON.stringify(sessions
          .filter(row => row.deviceLinkDeviceId === deviceId && row.parentSessionId === sessionId
            && row.source === 'side-chat' && (row.status === 'active' || row.status === 'archived'))
          .map(row => row.id).sort());
      }
      return cachedMembership;
    };
    let previous = membership();
    const unsubscribe = remoteSessionStore.subscribe(() => {
      const next = membership();
      if (previous === next) return;
      previous = next;
      refresh();
    });
    // Unknown children never enter the ordinary task list. Its created/reseed
    // signal must also refresh this separate host-owned list.
    const unsubscribeReseed = remoteSessionStore.registerReseedHandler(deviceId, refresh);
    refresh();
    return () => { active = false; unsubscribe(); unsubscribeReseed(); };
  }, [deviceId, sessionId, maker, owner, enabled, refreshKey]));
  return enabled && snapshot?.deviceId === deviceId && snapshot.sessionId === sessionId
    && snapshot.owner === owner ? snapshot.count : 0;
}
