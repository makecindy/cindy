import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Tip } from '@/components/ui/tooltip';
import { SessionStatusIcon } from '@/features/cc-agent/sidebar/SessionStatusIcon';
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
import { useBotDelegation } from './botDelegationLive';

/** A reference to the original session, never a second task or completion state. */
export function BotSessionTaskLink({
  card,
  sessionId,
}: {
  card: BotCollaborationMeta;
  sessionId?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { row } = useBotDelegation(sessionId ?? card.parentSessionId, card.delegationId);
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
  const [attached, setAttached] = useState(false);
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
    const refreshAttached = () => {
      if (sourceDeviceId) return;
      void window.electronAPI.binding
        .resolveSession(targetId)
        .then((value) => {
          if (alive && isDataOwnerGenerationCurrent(owner)) setAttached(value.attached);
        })
        .catch(() => {});
    };
    setAttached(false);
    refreshAttached();
    const offReset = sessionsStore.subscribe((change) => {
      if (change === 'reset') {
        alive = false;
        setSession(null);
        setAttached(false);
      }
    });
    const offBinding = window.electronAPI.binding.onChanged(refreshAttached);
    return () => {
      alive = false;
      offPatch();
      offRemote();
      offBinding();
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
  const title =
    session?.title ||
    row?.title ||
    card.result?.title ||
    card.objective.split('\n')[0] ||
    t('bots.collab.backgroundTask');
  const preview = card.result?.text || session?.preview || row?.resultSummary || title;
  return (
    <Tip
      text={
        <span className="block max-w-xs whitespace-pre-wrap break-words text-12">
          {preview.slice(0, 500)}
        </span>
      }
    >
      <button
        type="button"
        disabled={!targetId || originConflict}
        className="inline-flex max-w-full items-baseline gap-1 text-left text-14 leading-6 text-[var(--text-primary)] underline decoration-[var(--border-default)] underline-offset-4 disabled:cursor-default"
        onClick={() => {
          if (targetId && !originConflict)
            void resolveSessionRoute(targetId, session ?? undefined).then((route) =>
              navigate(route),
            );
        }}
      >
        {session && (
          <SessionStatusIcon
            session={session}
            isRunning={currentActivity?.currentTurnActive === true}
            isAttached={attached}
            isActive={false}
            hasAttentionNotification={Boolean(attention)}
            size={13}
          />
        )}
        <span className="min-w-0 break-words">{title}</span>
      </button>
    </Tip>
  );
}
