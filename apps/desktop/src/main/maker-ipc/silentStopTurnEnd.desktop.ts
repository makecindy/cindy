import { getActiveAppSession, type ActiveAppSession } from '../appSessionState.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { forgetSilentContinuationProjection, markSessionSilentContinuationStarted } from '../localDb/sessionActiveTurn.js';
import {
  handleSilentStopTurnEndWithPorts,
  type SilentStopTurnEndPorts,
} from './silentStopTurnEnd.js';

type SharedArguments = Parameters<typeof handleSilentStopTurnEndWithPorts>;

type DesktopSilentStopTurnEndPorts = SilentStopTurnEndPorts & {
  owner: Pick<ActiveAppSession, 'mode' | 'dataOwnerId'>;
  getBoundSession(): SharedArguments[0] | undefined;
};

export async function handleDesktopSilentStopTurnEnd(
  session: SharedArguments[0],
  doneAt: SharedArguments[1],
  turnLeaseId: SharedArguments[2],
  turnOrigin: SharedArguments[3],
  { owner, getBoundSession, ...ports }: DesktopSilentStopTurnEndPorts,
): Promise<void> {
  const getOwnerDb = () => {
    const current = getActiveAppSession();
    const snapshot = getCurrentDbClientSnapshot();
    return owner.dataOwnerId && current.mode === owner.mode && current.dataOwnerId === owner.dataOwnerId
      && snapshot?.userId === owner.dataOwnerId ? snapshot.client : null;
  };
  await handleSilentStopTurnEndWithPorts(session, doneAt, turnLeaseId, turnOrigin, {
    ...ports,
    settleSilentStopDone: (...args) => {
      if (getOwnerDb() && getBoundSession() === session) {
        forgetSilentContinuationProjection(session.id, session.instanceId, args[4]);
      }
      return ports.settleSilentStopDone(...args);
    },
  }, (generation, signal) => markSessionSilentContinuationStarted(
    session.id, session.instanceId, generation, getOwnerDb,
    () => !signal?.aborted && getBoundSession() === session && session.getTurnGeneration() === generation,
    error => ports.log.warn('silent-stop continuation start marker write failed', {
      sessionId: session.id, error: error instanceof Error ? error.message : String(error),
    }),
  ));
}
