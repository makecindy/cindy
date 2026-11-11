/** Desktop presentation around the shared durable message pipeline. */
import { BrowserWindow } from 'electron';
import { materializeToolProcessMedia } from './cindy-media/toolProcessMedia.js';
import * as broadcastTap from './device-link/broadcast-tap.js';
import { createMessagePersistence } from './messagePersistBroadcaster.js';
import { assistantSamplingSettlements } from './assistantSamplingSettlement.js';
import { commitMessageMediaRefs } from './cindy-media/chatAttachments.js';
export type { DeferredTurnErrorRow } from './messagePersistBroadcaster.js';
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

const persistence = createMessagePersistence({
  assistantSamplingSettlements,
  broadcastTap,
  commitMessageMediaRefs: (...args) => commitMessageMediaRefs(...args),
  broadcastMessageRow: (...args) => broadcastMessageRow(...args),
  broadcastMessageDeleted: (...args) => broadcastMessageDeleted(...args),
  discardPersistedAssistantMessage: (...args) => discardPersistedAssistantMessage(...args),
  broadcastMessageAgentMetaUpdate: (...args) => broadcastMessageAgentMetaUpdate(...args),
  createDbMessage: (...args) => createDbMessage(...args),
  findVisibleToolUseMessageByAliases: (...args) => findVisibleToolUseMessageByAliases(...args),
  patchMessageAgentMetaWithResult: (...args) => patchMessageAgentMetaWithResult(...args),
  updateDbMessageContent: (...args) => updateDbMessageContent(...args),
  materializeToolProcessMedia: (...args) => materializeToolProcessMedia(...args),
  onErrorPersisted(sessionId, persistId, ownerScope) {
    const ownerStamp = ownerScope ? ownerScope.ownerStamp : broadcastTap.getSafeDataOwnerPushStamp?.();
    const payload = { sessionId, persistId };
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        if (ownerScope === null) win.webContents.send('local-db:session:error-persisted', payload);
        else win.webContents.send('local-db:session:error-persisted', payload, ownerStamp);
      } catch { /* one closed window cannot block other clients */ }
    }
    if (ownerScope === null) broadcastTap.tapWindowBroadcast('local-db:session:error-persisted', payload);
    else broadcastTap.tapWindowBroadcast('local-db:session:error-persisted', payload, ownerStamp);
  },
});

export const {
  retryFailedWrites,
  hasFailedWrites,
  redactToolInputForUntrustedBoundary,
  getAssistantSamplingRuntimeId,
  flushAssistantSamplingMetadata,
  onAssistantSamplingAccepted,
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
  clearSessionPersistState,
} = persistence;
