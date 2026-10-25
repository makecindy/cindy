
/**
 * chat-data-localization F5：Messages IPC handlers（C7）。
 *
 * - `list(sessionId, opts)` —— 按 createdAt/rowid desc，limit 默认 50/上限 100；before 为 cursor message id
 * - `create(sessionId, body)` —— `(sessionId, clientId)` 唯一索引保证幂等：已存在则返回已有记录
 * - `updateContent(sessionId, clientId, content)` —— 用于 ask_user 的 answered 状态等
 */

import { ipcMain, BrowserWindow } from 'electron';

import { getDbClient, getCurrentDbClientSnapshot } from '../client/current';
import { latestVisiblePreviewRow } from '../latestMessageText';
import {
  messageToCamel,
  messageCreateToRow,
  safeStringify,
  extractMessagePreview,
} from '../mapper';
import * as broadcastTap from '../../device-link/broadcast-tap';
import { createLogger } from '../../logger';
import { collectCindyMediaHashes, commitMessageMediaRefs } from '../../cindy-media/chatAttachments';
import { recoverGeneratedImagesForHistory } from '../../cindy-media/generatedImageRecovery';
import { restoreTaskImageRows } from '../../cindy-media/taskImageDelivery';
import {
  removeRefs as removeMediaRefs,
  removeSessionAttachmentRefIfUnreferencedByLiveMessage,
} from '../../cindy-media/ledger';
import { importExternalCodexMessagesForSession } from '../../maker-host/codex-local-sessions';
import { importExternalClaudeCodeMessagesForSession } from '../../maker-host/claude-local-sessions';
import { getDeviceLinkInvokeContext, isDeviceLinkInvoke } from '../../device-link/invoke-context';
import { onMessageCreated as onChatMessageCreatedForEmbedding } from '../../embedders/chat-history-embedder';
import { recomputePrRefsForSession, recordPrRefsForMessage } from '../../git-context/prRefsStore';
import { resolveStaleCodexSubscriptionValueEstimate } from '../../../shared/codexSubscriptionValue.js';
import { normalizeTurnUsageDetails } from '../../../shared/turnUsageDetails.js';
import {
  addCompatibleRegionalMoney,
  asValueEstimateMoney,
  legacyUsdMoney,
  normalizeRegionalMoney,
  usdMoney,
  type RegionalMoney,
} from '../../../shared/regionalMoney.js';
import { capReferenceMessageRows } from './history.js';
import { scheduleBotRemoteResourceChangedForSession } from '../../maker-ipc/botRemoteResourceInvalidation';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer';
import { setHistoryWorkPageReader } from '../../device-link/historyViewPush';
import { createMessageService } from '@cindy/app-runtime/messageService';
export type { EstimatedSessionValueEntry, PriorUserRoundCost, MessageDeletedPayload, SubagentTurnDeletionWindow, MessageDeletionTarget, MessageAgentMetaPatchResult, VisibleToolUseMessageLink, ParkedEngineSession } from '@cindy/app-runtime/messageService';
export const {
  readMessagesList,
  registerMessageIpc,
  runMessagesListImportSideEffects,
  broadcastMessageRow,
  getMessageDeletionTarget,
  commitMessageDeletion,
  commitContextRebuild,
  findLatestContextRebuildMeta,
  broadcastMessageDeleted,
  rewindPersistedUserMessageAfterClear,
  dismissErrorMessage,
  supersedeRetriedUserTurn,
  discardPersistedAssistantMessage,
  updateMessageContent,
  createMessage,
  updateAgentMeta,
  extractEstimatedSessionValueEntries,
  readPiUserEntry,
  patchMessageAgentMetaWithResult,
  findVisibleToolUseMessageByAliases,
  patchMessageAgentMeta,
  broadcastMessageAgentMetaUpdate,
  readPriorUserRoundCost,
  findPendingAgentHandoff,
  findPendingAgentHandoffSnapshot,
  findPendingForkOrigin,
  findForkParentSessionId,
  listMessagesForAgentHandoff,
  findLatestUserMessageForRebuild,
  findParkedEngineSession,
  updateAgentSwitchBoundaryContent,
  markLatestAgentHandoffConsumed,
  rebroadcastAgentSwitchBoundary
} = createMessageService({
  ipc: ipcMain, broadcastTap, logger: createLogger('localDb/messages'),
  async whenTurnErrorPersisted(...args) {
    const persistence = await import('../../messagePersistBroadcaster.js');
    return persistence.whenTurnErrorPersisted(...args);
  },
  getDbClient: (...args) => getDbClient(...args),
  getCurrentDbClientSnapshot: (...args) => getCurrentDbClientSnapshot(...args),
  latestVisiblePreviewRow: (...args) => latestVisiblePreviewRow(...args),
  extractMessagePreview: (...args) => extractMessagePreview(...args),
  collectCindyMediaHashes: (...args) => collectCindyMediaHashes(...args),
  commitMessageMediaRefs: (...args) => commitMessageMediaRefs(...args),
  recoverGeneratedImagesForHistory: (...args) => recoverGeneratedImagesForHistory(...args),
  restoreTaskImageRows: (...args) => restoreTaskImageRows(...args),
  removeMediaRefs: (...args) => removeMediaRefs(...args),
  removeSessionAttachmentRefIfUnreferencedByLiveMessage: (...args) => removeSessionAttachmentRefIfUnreferencedByLiveMessage(...args),
  importExternalCodexMessagesForSession: (...args) => importExternalCodexMessagesForSession(...args),
  importExternalClaudeCodeMessagesForSession: (...args) => importExternalClaudeCodeMessagesForSession(...args),
  getDeviceLinkInvokeContext: (...args) => getDeviceLinkInvokeContext(...args),
  isDeviceLinkInvoke: (...args) => isDeviceLinkInvoke(...args),
  onChatMessageCreatedForEmbedding: (...args) => onChatMessageCreatedForEmbedding(...args),
  recomputePrRefsForSession: (...args) => recomputePrRefsForSession(...args),
  recordPrRefsForMessage: (...args) => recordPrRefsForMessage(...args),
  resolveStaleCodexSubscriptionValueEstimate: (...args) => resolveStaleCodexSubscriptionValueEstimate(...args),
  normalizeTurnUsageDetails: (...args) => normalizeTurnUsageDetails(...args),
  addCompatibleRegionalMoney: (...args) => addCompatibleRegionalMoney(...args),
  asValueEstimateMoney: (...args) => asValueEstimateMoney(...args),
  legacyUsdMoney: (...args) => legacyUsdMoney(...args),
  normalizeRegionalMoney: (...args) => normalizeRegionalMoney(...args),
  usdMoney: (...args) => usdMoney(...args),
  capReferenceMessageRows: (...args) => capReferenceMessageRows(...args),
  scheduleBotRemoteResourceChangedForSession: (...args) => scheduleBotRemoteResourceChangedForSession(...args),
  assertTrustedAppRendererEvent: (...args) => assertTrustedAppRendererEvent(...args),
  setHistoryWorkPageReader: (...args) => setHistoryWorkPageReader(...args),
  broadcastLocal(channel, payload, ...stamp) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try { win.webContents.send(channel, payload, ...stamp); }
      catch { /* A closing window must not interrupt other recipients. */ }
    }
  },
});
