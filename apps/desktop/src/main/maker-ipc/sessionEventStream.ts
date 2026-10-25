import {createSessionStreamPersistence} from '@cindy/app-runtime/sessionEventStream';
import * as persistence from '../messagePersistBroadcaster.js';
import * as fence from '../subagentObservationRewindFence.js';
import {persistSubagentTaskUpdate} from '../localDb/subagentRuns.js';
import {broadcastSubagentRunsChanged} from '../localDb/ipc/subagentRuns.js';
export type * from '@cindy/app-runtime/sessionEventStream';
export const {persistSessionStreamEvent}=createSessionStreamPersistence({
 persistence:{enqueueDurableWrite:(...args)=>persistence.enqueueDurableWrite(...args),
flushAssistantBlock:(...args)=>persistence.flushAssistantBlock(...args),
onAssistantTextEvent:(...args)=>persistence.onAssistantTextEvent(...args),
onAssistantAttemptFailure:(...args)=>persistence.onAssistantAttemptFailure(...args),
onAgentTaskUpdateEvent:(...args)=>persistence.onAgentTaskUpdateEvent(...args),
onThinkingEvent:(...args)=>persistence.onThinkingEvent(...args),
onToolResultEvent:(...args)=>persistence.onToolResultEvent(...args),
onToolResultFullEvent:(...args)=>persistence.onToolResultFullEvent(...args),
persistToolProcessMedia:(...args)=>persistence.persistToolProcessMedia(...args),
onToolUseEvent:(...args)=>persistence.onToolUseEvent(...args)},
 fence:{captureSubagentObservationGeneration:(...args)=>fence.captureSubagentObservationGeneration(...args),enqueueSubagentObservationWrite:(...args)=>fence.enqueueSubagentObservationWrite(...args)},
 persistSubagentTaskUpdate:(...args)=>persistSubagentTaskUpdate(...args),
 broadcastSubagentRunsChanged:(...args)=>broadcastSubagentRunsChanged(...args)
});
