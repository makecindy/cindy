import { getStartingSessionIds } from '@/lib/sessionStartingStore';
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
  const starting = getStartingSessionIds();
  const running = new Set(ctx.runningSessionIds);
  const attention = new Set(ctx.attentionSessionIds);
  const waiting = new Set(ctx.waitingSessionIds);
  const remoteRunningByRow = new Map(ctx.remoteRunningByRow);
  for (const session of sessions) {
    const phase = remotePhaseOf(session);
    if (session.deviceLinkDeviceId) {
      // Preserve a new send before its first host push; terminal evidence still ends the old turn.
      remoteRunningByRow.set(sessionRowKey(session), phase === 'running' || (!phase && starting.has(session.id)));
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
