import { isAppSessionBoundaryPending } from '../appSessionState.js';
import { getCurrentDbClientSnapshot, type CurrentDbClientSnapshot } from '../localDb/client/current.js';
import { isEndedWriteSuppressed, markSessionSilentContinuationStarted } from '../localDb/sessionActiveTurn.js';
import {
  handleSilentStopTurnEndWithPorts,
  type SilentStopTurnEndPorts,
} from './silentStopTurnEnd.js';

type SharedArguments = Parameters<typeof handleSilentStopTurnEndWithPorts>;

type DesktopSilentStopTurnEndPorts = SilentStopTurnEndPorts & {
  ownerDb: CurrentDbClientSnapshot | null;
  getBoundSession(): SharedArguments[0] | undefined;
};

export async function handleDesktopSilentStopTurnEnd(
  session: SharedArguments[0],
  doneAt: SharedArguments[1],
  turnLeaseId: SharedArguments[2],
  turnOrigin: SharedArguments[3],
  { ownerDb, getBoundSession, ...ports }: DesktopSilentStopTurnEndPorts,
): Promise<void> {
  if (!ownerDb) return;
  const isCurrent = (allowClosedSession = false) => {
    const bound = getBoundSession();
    return getCurrentDbClientSnapshot() === ownerDb &&
      !isAppSessionBoundaryPending() && !isEndedWriteSuppressed() &&
      (bound === session || (allowClosedSession && !bound && session.getStatus() === 'closed'));
  };
  await handleSilentStopTurnEndWithPorts(session, doneAt, turnLeaseId, turnOrigin, {
    ...ports,
    continuationMarkers: {
      isCurrent,
      start: canDispatch => markSessionSilentContinuationStarted(
        session.id, ownerDb, () => isCurrent() && canDispatch(),
      ),
    },
  });
}
