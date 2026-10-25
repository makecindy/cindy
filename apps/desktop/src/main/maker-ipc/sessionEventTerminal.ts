import { botLearningTracker } from './botLearningTracker.js';
import { learningTurnIdentity } from './botLearningFeedback.js';

// sidebar-card-mode: turn-done 后刷新列表预览,并按需生成置顶卡片摘要
import {
  maybeGenerateSessionTaskSummary,
  refreshSessionListPreview,
} from '../sessionTaskSummary.js';

import {
  consumeLastAssistantPersistId,
  consumeLastTopLevelAssistantPersistId,
  drainPersistQueue,
  flushAssistantBlock,
  flushOrphanToolResults,
  isSuccessfulCodexDoneEventData,
  markAssistantTurnCompleted,
  markAssistantTurnFailed,
  clearCodexPlanRowsForSession,
  persistCodexPlanOnDone,
  persistCodexPlanOnTerminalError,
  preserveTurnPersistStateForBackground,
  onTurnErrorEvent,
  releaseReservedTurnErrorPersistId,
  reserveTurnErrorPersistId,
  resetTurnPersistState,
  saveTurnStartedAtForDeferred,
} from '../messagePersistBroadcaster.js';
import { MAKER_PUSH } from './channels.js';
import { hasEnabledGhostAssistantHook, runGhostAssistantReplyHook } from '../cindy-brain/index.js';
import { withGhostAssistantHookModel } from '../cindy-brain/subscriptionGateway.js';
import {createSessionEventTerminal} from '@cindy/app-runtime/sessionEventTerminal';
export type * from '@cindy/app-runtime/sessionEventTerminal';
export const {finishSessionTerminalEvent}=createSessionEventTerminal({
get botLearningTracker() { return botLearningTracker; },
learningTurnIdentity: (...args) => learningTurnIdentity(...args),
maybeGenerateSessionTaskSummary: (...args) => maybeGenerateSessionTaskSummary(...args),
refreshSessionListPreview: (...args) => refreshSessionListPreview(...args),
consumeLastAssistantPersistId: (...args) => consumeLastAssistantPersistId(...args),
consumeLastTopLevelAssistantPersistId: (...args) => consumeLastTopLevelAssistantPersistId(...args),
drainPersistQueue: (...args) => drainPersistQueue(...args),
flushAssistantBlock: (...args) => flushAssistantBlock(...args),
flushOrphanToolResults: (...args) => flushOrphanToolResults(...args),
isSuccessfulCodexDoneEventData: (...args) => isSuccessfulCodexDoneEventData(...args),
markAssistantTurnCompleted: (...args) => markAssistantTurnCompleted(...args),
markAssistantTurnFailed: (...args) => markAssistantTurnFailed(...args),
clearCodexPlanRowsForSession: (...args) => clearCodexPlanRowsForSession(...args),
persistCodexPlanOnDone: (...args) => persistCodexPlanOnDone(...args),
persistCodexPlanOnTerminalError: (...args) => persistCodexPlanOnTerminalError(...args),
preserveTurnPersistStateForBackground: (...args) => preserveTurnPersistStateForBackground(...args),
onTurnErrorEvent: (...args) => onTurnErrorEvent(...args),
releaseReservedTurnErrorPersistId: (...args) => releaseReservedTurnErrorPersistId(...args),
reserveTurnErrorPersistId: (...args) => reserveTurnErrorPersistId(...args),
resetTurnPersistState: (...args) => resetTurnPersistState(...args),
saveTurnStartedAtForDeferred: (...args) => saveTurnStartedAtForDeferred(...args),
get MAKER_PUSH() { return MAKER_PUSH; },
hasEnabledGhostAssistantHook: (...args) => hasEnabledGhostAssistantHook(...args),
runGhostAssistantReplyHook: (...args) => runGhostAssistantReplyHook(...args),
withGhostAssistantHookModel: (...args) => withGhostAssistantHookModel(...args)
});
