import { projectCoordinationOutput } from './coordinationOutput.js';
import type { AgentEvent, Session } from '@cindy/maker-core';
import type {createSessionEventPreparation,PrepareSessionEventDeps} from './sessionEventPreparation.js';
 import type {createSessionStreamPersistence,PersistSessionStreamEventDeps} from './sessionEventStream.js';
 import type {createSessionEventDelivery,DeliverSessionEventDeps} from './sessionEventDelivery.js';
 import type {createSessionEventTerminal,FinishSessionTerminalEventDeps} from './sessionEventTerminal.js';
 import type {createSessionEventSnapshots} from './sessionEventSnapshots.js';
 import type {createSessionClaudeTurnUsage,RecordSessionClaudeTurnUsageDeps} from './sessionClaudeTurnUsage.js';
 import type {createSessionCodexTurnUsage,RecordSessionCodexTurnUsageDeps} from './sessionCodexTurnUsage.js';
 import type {createSessionPiTurnUsage,RecordSessionPiTurnUsageDeps} from './sessionPiTurnUsage.js';
 import type {createBotLearningFeedback} from './botLearningFeedback.js';
 import type {createScheduledOutputProjection} from './silent-output.js';
 export interface SessionEventPipelineHost extends ReturnType<typeof createSessionEventPreparation>,
 ReturnType<typeof createSessionStreamPersistence>,ReturnType<typeof createSessionEventDelivery>,
 ReturnType<typeof createSessionEventTerminal>,ReturnType<typeof createSessionEventSnapshots>,
 ReturnType<typeof createSessionClaudeTurnUsage>,ReturnType<typeof createSessionCodexTurnUsage>,
 ReturnType<typeof createSessionPiTurnUsage>,Pick<ReturnType<typeof createBotLearningFeedback>,'observeBotLearningTurn'>,
 Pick<ReturnType<typeof createScheduledOutputProjection>,'projectQuietScheduledOutput'> {}


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
export function createSessionEventPipeline(host: SessionEventPipelineHost) {
const {observeBotLearningTurn,projectQuietScheduledOutput,prepareSessionEvent,persistSessionStreamEvent,deliverSessionEvent,finishSessionTerminalEvent,recordSessionEventSnapshots,recordSessionClaudeTurnUsage,recordSessionCodexTurnUsage,recordSessionPiTurnUsage} = host;



/** Synchronous delivery boundary. Accepted asynchronous writes retain their original turn. */
function handleSessionEvent(
  deps: SessionEventDependencies,
  session: Session,
  event: AgentEvent,
): void {
  const prepared = prepareSessionEvent(deps, session, event);
  if (!prepared) return;
  const project = (input: AgentEvent) => {
    const scheduled = projectQuietScheduledOutput(input);
    return scheduled && projectCoordinationOutput(scheduled, prepared.taskCoordination);
  };
  const projected = project(prepared.event);
  if (!projected) return;
  if (projected !== prepared.event) {
    prepared.event = projected;
    prepared.attributedEvent = project(prepared.attributedEvent) ?? prepared.attributedEvent;
    // Project the already-redacted event independently; never copy raw fields back into it.
    prepared.broadcastEvent = project(prepared.broadcastEvent) ?? prepared.broadcastEvent;
  }
  if (event.type === 'tool_use' && event.turnScope !== 'background') observeBotLearningTurn(session, event.sessionTurnGeneration);
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
  deps.recordProviderPartyUsage?.(session, event);
}
return {
  handleSessionEvent
};
}
