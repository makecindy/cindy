
import { materializeToolProcessMedia } from './cindy-media/toolProcessMedia.js';
import { readTaskResultsForReply } from './botTaskReplyResults.js';

import { BrowserWindow } from 'electron';

import {
  broadcastMessageRow,
  broadcastMessageDeleted,
  discardPersistedAssistantMessage,
  broadcastMessageAgentMetaUpdate,
  createMessage as createDbMessage,
  findVisibleToolUseMessageByAliases,
  patchMessageAgentMetaWithResult,
  updateMessageContent as updateDbMessageContent,
} from './localDb/ipc/messages.js';
import { getDbClient } from './localDb/client/current.js';
import {
  markCodexPlanInterrupted,
  writeCodexPlanTerminal,
  writeCodexPlanUpdate,
} from './localDb/codexPlanState.js';
import { getSubagentRunDetail } from './localDb/subagentRuns.js';
import { createLogger } from './logger.js';
import * as broadcastTap from './device-link/broadcast-tap.js';
import { commitMessageMediaRefs } from './cindy-media/chatAttachments.js';
import { takeMediaToolResult } from './mcp-integrations/mediaToolResultFallback.js';
import { getSessionProvider } from './maker-host/session-provider-store.js';
import { createMessagePersistence } from '@cindy/app-runtime/messagePersistBroadcaster';
export type { DeferredTurnErrorRow } from '@cindy/app-runtime/messagePersistBroadcaster';
export { redactToolInputForUntrustedBoundary } from '@cindy/remote-agent/host/toolInputRedaction';

export const {
  onAssistantAttemptFailure,
  clearSessionThinkingSnapshots,
  getSessionThinkingSnapshots,
  getSessionTextSnapshot,
  noteSessionClearBoundary,
  backgroundTurnPredatesSessionClear,
  noteSessionAgentKind,
  getSessionDbAgentKind,
  noteTurnStarted,
  saveTurnStartedAtForDeferred,
  noteAgentMeta,
  getLastAssistantTranscriptUuid,
  setLastAssistantTranscriptUuid,
  consumeLastAssistantPersistId,
  consumeLastTopLevelAssistantPersistId,
  markAssistantTurnCompleted,
  markAssistantTurnFailed,
  isSuccessfulCodexDoneEventData,
  markAutoResumeOutcome,
  enqueueDurableWrite,
  drainPersistQueue,
  getHistoryToolName,
  onAgentTaskUpdateEvent,
  preserveTurnPersistStateForBackground,
  onToolUseEvent,
  persistCodexPlanOnDone,
  persistCodexPlanOnTerminalError,
  prepareSyntheticToolEventForBroadcast,
  onThinkingEvent,
  onToolResultEvent,
  persistToolProcessMedia,
  onToolResultFullEvent,
  onInteractionMessage,
  onInteractionResolved,
  flushOrphanToolResults,
  resetTurnPersistState,
  onStandaloneTextEvent,
  onAssistantTextEvent,
  flushAssistantBlock,
  sealAssistantBlockForLateFinal,
  reserveTurnErrorPersistId,
  releaseReservedTurnErrorPersistId,
  whenTurnErrorPersisted,
  onTurnErrorEvent,
  captureDeferredTurnError,
  persistDeferredTurnError,
  clearCodexPlanRowsForSession,
  clearSessionPersistState
} = createMessagePersistence({
  logger: createLogger('messagePersistBroadcaster'),
  broadcastTap,
  codexPlan: {
    markCodexPlanInterrupted: (...args) => markCodexPlanInterrupted(...args),
    writeCodexPlanTerminal: (...args) => writeCodexPlanTerminal(...args),
    writeCodexPlanUpdate: (...args) => writeCodexPlanUpdate(...args),
  },
  materializeToolProcessMedia: (...args) => materializeToolProcessMedia(...args),
  readTaskResultsForReply: (...args) => readTaskResultsForReply(...args),
  broadcastMessageRow: (...args) => broadcastMessageRow(...args),
  broadcastMessageDeleted: (...args) => broadcastMessageDeleted(...args),
  discardPersistedAssistantMessage: (...args) => discardPersistedAssistantMessage(...args),
  broadcastMessageAgentMetaUpdate: (...args) => broadcastMessageAgentMetaUpdate(...args),
  createDbMessage: (...args) => createDbMessage(...args),
  findVisibleToolUseMessageByAliases: (...args) => findVisibleToolUseMessageByAliases(...args),
  patchMessageAgentMetaWithResult: (...args) => patchMessageAgentMetaWithResult(...args),
  updateDbMessageContent: (...args) => updateDbMessageContent(...args),
  getDbClient: (...args) => getDbClient(...args),
  getSubagentRunDetail: (...args) => getSubagentRunDetail(...args),
  commitMessageMediaRefs: (...args) => commitMessageMediaRefs(...args),
  takeMediaToolResult: (...args) => takeMediaToolResult(...args),
  getSessionProvider: (...args) => getSessionProvider(...args),
  broadcastLocal(channel, payload, ...stamp) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try { win.webContents.send(channel, payload, ...stamp); }
      catch { /* A closing window must not interrupt durable publication. */ }
    }
  },
});
