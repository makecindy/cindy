import * as persistence from '../messagePersistBroadcaster.desktop.js';
import { broadcastSubagentRunsChanged } from '../localDb/ipc/subagentRuns.js';
import { persistSessionStreamEventCore, type PersistSessionStreamEventDeps } from './sessionEventStreamCore.js';
import type { Session } from '@cindy/maker-core';
import type { PreparedSessionEvent } from './sessionEventPreparation.js';
export type { PersistSessionStreamEventDeps, SessionStreamResult } from './sessionEventStreamCore.js';

export function persistSessionStreamEvent(deps: PersistSessionStreamEventDeps,
  session: Session, prepared: PreparedSessionEvent) {
  return persistSessionStreamEventCore({ ...deps, persistence, broadcastSubagentRunsChanged }, session, prepared);
}
