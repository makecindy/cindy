import type { AgentEvent, Session } from '@cindy/maker-core';
import { prepareSessionEvent, type PrepareSessionEventDeps } from './sessionEventPreparation.js';
import {
  persistSessionStreamEvent,
  type PersistSessionStreamEventDeps,
} from './sessionEventStream.js';
import { deliverSessionEvent, type DeliverSessionEventDeps } from './sessionEventDelivery.js';
import {
  finishSessionTerminalEvent,
  type FinishSessionTerminalEventDeps,
} from './sessionEventTerminal.js';
import { recordSessionEventSnapshots } from './sessionEventSnapshots.js';
import {
  recordSessionClaudeTurnUsage,
  type RecordSessionClaudeTurnUsageDeps,
} from './sessionClaudeTurnUsage.js';
import {
  recordSessionCodexTurnUsage,
  type RecordSessionCodexTurnUsageDeps,
} from './sessionCodexTurnUsage.js';
import {
  recordSessionPiTurnUsage,
  type RecordSessionPiTurnUsageDeps,
} from './sessionPiTurnUsage.js';

export type SessionEventDependencies = PrepareSessionEventDeps &
  PersistSessionStreamEventDeps &
  DeliverSessionEventDeps &
  FinishSessionTerminalEventDeps &
  RecordSessionClaudeTurnUsageDeps &
  RecordSessionCodexTurnUsageDeps &
  RecordSessionPiTurnUsageDeps;

/** Synchronous delivery boundary. Accepted asynchronous writes retain their original turn. */
export function handleSessionEvent(
  deps: SessionEventDependencies,
  session: Session,
  event: AgentEvent,
): void {
  const prepared = prepareSessionEvent(deps, session, event);
  if (!prepared) return;
  const stream = persistSessionStreamEvent(deps, session, prepared);
  const delivery = deliverSessionEvent(deps, session, prepared, stream);
  const terminal = finishSessionTerminalEvent(deps, session, prepared, delivery);
  recordSessionEventSnapshots(session, prepared);
  recordSessionClaudeTurnUsage(
    deps,
    session,
    event,
    terminal.turnAssistantPersistId,
    prepared.completedTurnWallClockMs,
    prepared.isContinuationBoundary,
  );
  recordSessionCodexTurnUsage(deps, session, event, terminal.turnAssistantPersistId);
  recordSessionPiTurnUsage(deps, session, event, terminal.turnAssistantPersistId);
}
