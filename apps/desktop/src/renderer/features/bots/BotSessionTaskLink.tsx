import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgentIslandActivity } from '@/state/agentIslandActivity';
import { useRemoteSessionActivity } from '@/features/device-link/remoteSessionActivityStore';
import { makerChatStore } from '@/lib/makerChatStore';
import { sessionsStore } from '@/lib/sessionsStore';
import { projectSidebarSessionActivity } from '@/features/cc-agent/sidebar/sidebarRightStatus';
import { useSessionAttentionKind } from '@/lib/sessionAttentionStore';
import { useSessionDisplayRunningState } from '@/features/cc-agent/hooks/useSessionDisplayRunningState';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { resolveSessionRoute } from '@/lib/orcaSessionIdentity';
import * as sessionService from '@/lib/sessionService';
import type { Session } from '@/lib/ccAgent.types';
import type { BotCollaborationMeta } from '../../../shared/botCollaboration';
import type { BotDelegationView } from '../../../shared/botDelegation';
import { useBotDelegation } from './botDelegationLive';

/** Live identity of the original session behind a task card; never a second task. */
export interface BotTaskSessionRef {
  row: BotDelegationView | null;
  resolved: boolean;
  stale: boolean;
  targetId: string | null;
  session: Session | null;
  /** The parent's device when the bot chat is remote; local controls stay hidden there. */
  sourceDeviceId: string | undefined;
  activity: { compactDetail?: string; workingPhase?: string; startedAtMs?: number | null } | null;
  /** Actual runtime state of the original session, independent of the delegation status. */
  running: boolean;
  originConflict: boolean;
  open: () => void;
}

export function useBotTaskSession(card: BotCollaborationMeta, sessionId?: string): BotTaskSessionRef {
  const navigate = useNavigate();
  const { row, resolved, stale } = useBotDelegation(sessionId ?? card.parentSessionId, card.delegationId);
  const targetId = row?.childSessionId ?? card.childSessionId;
  const [session, setSession] = useState<Session | null>(null);
  const activity = useAgentIslandActivity(targetId ?? '');
  const remoteActivity = useRemoteSessionActivity(targetId ?? '', session?.deviceLinkDeviceId);
  const locallyRunning = useSyncExternalStore(makerChatStore.subscribeAll, () =>
    Boolean(targetId && makerChatStore.getRunningSnapshot().get(targetId)?.isRunning),
  );
  const running = useMemo(
    () => new Set(locallyRunning && targetId ? [targetId] : []),
    [locallyRunning, targetId],
  );
  const rows = useMemo(() => (session ? [session] : []), [session]);
  const { displayRunningSessionIds } = useSessionDisplayRunningState(rows, running);
  const attention = useSessionAttentionKind(targetId ?? '');
  useEffect(() => {
    setSession(null);
    if (!targetId) return;
    let alive = true;
    const owner = getDataOwnerGeneration();
    const sourceDeviceId = remoteProjectsStore.getSessionDeviceId(
      sessionId ?? card.parentSessionId ?? '',
    );
    const existingOrigin = remoteProjectsStore.getSessionDeviceId(targetId);
    if (existingOrigin && existingOrigin !== sourceDeviceId) return;
    if (sourceDeviceId) remoteProjectsStore.pinSessionOrigin(sourceDeviceId, targetId);
    const remoteRead = sourceDeviceId
      ? remoteProjectsStore.captureSessionRead(sourceDeviceId, targetId)
      : null;
    const read = sourceDeviceId
      ? window.electronAPI.deviceLink.invoke(sourceDeviceId, 'local-db:sessions:get', [targetId])
      : sessionService.get(targetId);
    const syncRemote = () => {
      if (alive && sourceDeviceId && isDataOwnerGenerationCurrent(owner))
        setSession(
          remoteProjectsStore
            .getDeviceSessions(sourceDeviceId)
            .find((value) => value.id === targetId) ?? null,
        );
    };
    const offRemote = sourceDeviceId ? remoteProjectsStore.subscribe(syncRemote) : () => {};
    void read
      .then((value) => {
        if (!alive || !isDataOwnerGenerationCurrent(owner)) return;
        if (sourceDeviceId && remoteRead) {
          const remote = value as Session | null;
          if (remoteRead() && remote?.id === targetId) {
            remoteProjectsStore.mergeDeviceSessions(
              sourceDeviceId,
              remoteProjectsStore.getDeviceName(sourceDeviceId) ?? sourceDeviceId,
              [remoteRead.mergeActivity(remote)],
              remote.status === 'archived' ? 'archived' : 'active',
            );
          }
          syncRemote();
        } else {
          setSession(value as Session);
        }
      })
      .catch(() => {});
    const offPatch = sessionsStore.subscribePatches((id, patch) => {
      if (!sourceDeviceId && id === targetId && isDataOwnerGenerationCurrent(owner))
        setSession((current) => (current ? { ...current, ...patch } : current));
    });
    const offReset = sessionsStore.subscribe((change) => {
      if (change === 'reset') {
        alive = false;
        setSession(null);
      }
    });
    return () => {
      alive = false;
      offPatch();
      offRemote();
      offReset();
    };
  }, [targetId, sessionId, card.parentSessionId]);
  const currentActivity = session
    ? projectSidebarSessionActivity({
        interruption: session,
        sessionId: session.id,
        title: session.title,
        recordStatus: session.status,
        liveActivity: session.deviceLinkDeviceId ? remoteActivity : activity,
        attentionKind: attention,
        isUrgentFromContext: false,
        isRunning: session.deviceLinkDeviceId
          ? remoteActivity?.phase === 'running'
          : displayRunningSessionIds.has(session.id),
        hasAttentionNotification: Boolean(attention),
      })
    : null;
  const sourceDevice = remoteProjectsStore.getSessionDeviceId(
    sessionId ?? card.parentSessionId ?? '',
  );
  const targetDevice = targetId ? remoteProjectsStore.getSessionDeviceId(targetId) : undefined;
  const originConflict = Boolean(targetDevice && targetDevice !== sourceDevice);
  const live = session?.deviceLinkDeviceId ? remoteActivity : activity;
  const open = useCallback(() => {
    if (!targetId || originConflict) return;
    void resolveSessionRoute(targetId, session ?? undefined).then((route) => navigate(route));
  }, [navigate, originConflict, session, targetId]);
  return {
    row: row ?? null,
    resolved: resolved === true,
    stale: stale === true,
    targetId: targetId ?? null,
    session,
    sourceDeviceId: sourceDevice,
    activity: live ?? null,
    running: currentActivity?.currentTurnActive === true,
    originConflict,
    open,
  };
}
