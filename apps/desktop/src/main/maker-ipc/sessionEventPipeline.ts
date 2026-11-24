import { turnUsageAdmission } from '../usage/turnUsageAdmission.js';
import { observeBotLearningEvent } from './botLearningFeedback.js';
import { projectQuietScheduledOutput } from '../scheduler-host/silent-output.js';
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
import { recordSessionAcpTurnUsage } from './sessionAcpTurnUsage.js';
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
  RecordSessionPiTurnUsageDeps & {
    /** 按供应商记「本机」用量(远程与分享页的按使用方用量)。不提供 = 不记。 */
    readonly recordProviderPartyUsage?: (session: Session, event: AgentEvent) => void;
  };

/** Synchronous delivery boundary. Accepted asynchronous writes retain their original turn. */
export function handleSessionEvent(
  deps: SessionEventDependencies,
  session: Session,
  event: AgentEvent,
  admitUsage?: () => boolean,
  observeUnbilledUsage?: () => void,
): void {
  const prepared = prepareSessionEvent(deps, session, event, admitUsage);
  if (!prepared) return;
  const project = projectQuietScheduledOutput;
  const projected = project(prepared.event);
  if (!projected) return;
  if (projected !== prepared.event) {
    prepared.event = projected;
    prepared.attributedEvent = project(prepared.attributedEvent) ?? prepared.attributedEvent;
    // Project the already-redacted event independently; never copy raw fields back into it.
    prepared.broadcastEvent = project(prepared.broadcastEvent) ?? prepared.broadcastEvent;
  }
  observeBotLearningEvent(session, prepared.attributedEvent);
  const stream = persistSessionStreamEvent(deps, session, prepared);
  // The existing durable row push carries ACP input patches to all clients. Broadcasting a
  // second tool_use on the live stream would add a second card on older controllers.
  if (stream.persistedOnly) return;
  const delivery = deliverSessionEvent(deps, session, prepared, stream);
  const terminal = finishSessionTerminalEvent(deps, session, prepared, delivery);
  recordSessionEventSnapshots(session, prepared);
  const record = () => {
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
    recordSessionAcpTurnUsage(session, event, terminal.turnAssistantPersistId);
    deps.recordProviderPartyUsage?.(session, event);
  };
  if (admitUsage === undefined) record();
  else if (admitUsage()) turnUsageAdmission.run(admitUsage, record);
  else observeUnbilledUsage?.();
}
