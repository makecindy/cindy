import * as persistence from '../messagePersistBroadcaster.desktop.js';
import { broadcastSubagentRunsChanged } from '../localDb/ipc/subagentRuns.js';
import { persistSessionStreamEventCore, type PersistSessionStreamEventDeps } from './sessionEventStreamCore.js';
import type { Session } from '@cindy/maker-core';
import type { PreparedSessionEvent } from './sessionEventPreparation.js';
export type { PersistSessionStreamEventDeps, SessionStreamResult } from './sessionEventStreamCore.js';

export function persistSessionStreamEvent(deps: PersistSessionStreamEventDeps,
  session: Session, prepared: PreparedSessionEvent) {
  // The session entry builds its dependencies with Object.create(...), so log and the Orca
  // service live on the prototype. Spreading deps here copies own properties only and would
  // drop them: the failure callback then throws on an undefined logger and hides the original
  // database error, and worker text is no longer captured.
  return persistSessionStreamEventCore({
    log: deps.log,
    orcaTeamServiceForEvents: deps.orcaTeamServiceForEvents,
    persistence,
    broadcastSubagentRunsChanged,
  }, session, prepared);
}
