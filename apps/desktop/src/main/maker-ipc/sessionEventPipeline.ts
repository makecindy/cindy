
import { observeBotLearningTurn } from './botLearningFeedback.js';
import { projectQuietScheduledOutput } from '../scheduler-host/silent-output.js';
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
import {createSessionEventPipeline} from '@cindy/app-runtime/sessionEventPipeline';
export type * from '@cindy/app-runtime/sessionEventPipeline';
export const {handleSessionEvent}=createSessionEventPipeline({
observeBotLearningTurn: (...args) => observeBotLearningTurn(...args),
projectQuietScheduledOutput: (...args) => projectQuietScheduledOutput(...args),
prepareSessionEvent: (...args) => prepareSessionEvent(...args),
persistSessionStreamEvent: (...args) => persistSessionStreamEvent(...args),
deliverSessionEvent: (...args) => deliverSessionEvent(...args),
finishSessionTerminalEvent: (...args) => finishSessionTerminalEvent(...args),
recordSessionEventSnapshots: (...args) => recordSessionEventSnapshots(...args),
recordSessionClaudeTurnUsage: (...args) => recordSessionClaudeTurnUsage(...args),
recordSessionCodexTurnUsage: (...args) => recordSessionCodexTurnUsage(...args),
recordSessionPiTurnUsage: (...args) => recordSessionPiTurnUsage(...args)
});
