import { useMemo } from 'react';
import { getStartingSessionIds } from '@/lib/sessionStartingStore';
import type { Session } from '@/lib/ccAgent.types';
import type { RemoteSessionActivityPhase } from '@/features/device-link/remoteSessionActivityStore';
import { liveTaskPriorityRank } from '@cindy/maker-shared/live-task-priority';
import { sessionRowKey } from '../sidebar/sessionRowKey';
import type { MainListPriorityContext } from './mainListModel';
import { useRemoteFailedScheduleRows } from '@/features/device-link/remoteProjectsStore';
import { useRemoteOrcaQuestionLeadRows } from './orcaLeadWorkerAttention';

export function useRemoteSidebarWaitingRows(): ReadonlySet<string> {
  const failedRuns = useRemoteFailedScheduleRows();
  const pendingQuestions = useRemoteOrcaQuestionLeadRows();
  return useMemo(() => new Set([...failedRuns, ...pendingQuestions]), [failedRuns, pendingQuestions]);
}

export function remoteSidebarPriorityRank(
  session: Session,
  phase: RemoteSessionActivityPhase | undefined,
  ctx: MainListPriorityContext,
  starting: ReadonlySet<string>,
) {
  const rowKey = sessionRowKey(session);
  return liveTaskPriorityRank({
    // Preserve a new send before its first host push; terminal evidence still ends the old turn.
    running: phase === 'running' || (!phase && starting.has(session.id)),
    waiting: phase === 'needs-interaction' || phase === 'error' || ctx.remoteWaitingRows?.has(rowKey) === true,
    unread: phase === 'completed' || ctx.remoteUnreadScheduleRows?.has(rowKey) === true,
  });
}

/** Click capture and list sorting must see the same local and remote activity. */
export function sidebarPriorityContext(
  ctx: MainListPriorityContext,
  sessions: Iterable<Session>,
  remotePhaseOf: (session: Session) => RemoteSessionActivityPhase | undefined,
): MainListPriorityContext {
  const starting = getStartingSessionIds();
  const running = new Set(ctx.runningSessionIds);
  const attention = new Set(ctx.attentionSessionIds);
  const waiting = new Set(ctx.waitingSessionIds);
  const remotePriorityByRow = new Map(ctx.remotePriorityByRow);
  for (const session of sessions) {
    const phase = remotePhaseOf(session);
    if (session.deviceLinkDeviceId) {
      remotePriorityByRow.set(sessionRowKey(session), remoteSidebarPriorityRank(session, phase, ctx, starting));
    }
    if (!phase) continue;
    if (phase === 'running') {
      running.add(session.id);
    } else {
      attention.add(session.id);
      if (phase === 'needs-interaction' || phase === 'error') waiting.add(session.id);
    }
  }
  return {
    ...ctx,
    remotePriorityByRow,
    runningSessionIds: running,
    attentionSessionIds: attention,
    waitingSessionIds: waiting,
  };
}
