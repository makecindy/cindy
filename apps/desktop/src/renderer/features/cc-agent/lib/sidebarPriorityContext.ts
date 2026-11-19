import type { Session } from '@/lib/ccAgent.types';
import type { RemoteSessionActivityPhase } from '@/features/device-link/remoteSessionActivityStore';
import { sessionRowKey } from '../sidebar/sessionRowKey';
import type { MainListPriorityContext } from './mainListModel';

/** Click capture and list sorting must see the same local and remote activity. */
export function sidebarPriorityContext(
  ctx: MainListPriorityContext,
  sessions: Iterable<Session>,
  remotePhaseOf: (session: Session) => RemoteSessionActivityPhase | undefined,
): MainListPriorityContext {
  const running = new Set(ctx.runningSessionIds);
  const attention = new Set(ctx.attentionSessionIds);
  const waiting = new Set(ctx.waitingSessionIds);
  const remoteRunningByRow = new Map(ctx.remoteRunningByRow);
  for (const session of sessions) {
    const phase = remotePhaseOf(session);
    if (session.deviceLinkDeviceId) {
      // Match the remote row indicator, including after a read receipt removes the completion.
      remoteRunningByRow.set(sessionRowKey(session), phase === 'running');
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
    remoteRunningByRow,
    runningSessionIds: running,
    attentionSessionIds: attention,
    waitingSessionIds: waiting,
  };
}
