import { createSessionSnapshot, type SessionRowSnapshot } from '@cindy/runtime-db/sessionSnapshot';
import { ensureOpenedProjectGit, openSession } from '../sessionOpening.js';
import { createSessionNotifications } from '@cindy/app-runtime/sessionNotifications';
import { createSessionUserActivity } from '@cindy/app-runtime/sessionUserActivity';
import {
  claimOwnedProvisionalSession,
  configureProvisionalSessions,
  deleteUnsentSessionRow,
  forgetProvisionalSession,
  isProvisionalSession,
  markProvisionalSession,
  provisionalManagedDir,
  removeEmptyDialogueDir,
  sweepLeftoverProvisionalSessions,
} from '../provisionalSessions.js';
import { emitSessionCreated, emitSessionListChangedLocally } from './sessionCreatedBroadcast.js';
/**
 * chat-data-localization F5：Sessions IPC handlers（C6）。
 *
 * 函数签名与原 `/api/sessions` 端点完全一致——上层 sessionService 切层后零改动。
 * 失败时 throw `Error("[CODE] message")`，service 层包装回 `ApiError`。
 */

import { physicalWorktreeKey, withWorktreeResourceLocks } from '../../worktree/resourceLock';
import { managedWorktreeRoot } from '../../worktree/runtimeLeases';
import { queueSessionWorktreeRecycle } from '../../worktree/recycleQueue';
import { notifyWorktreeRecycleOpportunity } from '../../worktree/recycleEvents';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ipcMain, app, BrowserWindow } from 'electron';
import { eq, ne, and, desc, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';

import {
  clearPiSubagentDeletedTombstone,
  piSubagentRunRoot,
  stopAndRemovePiSubagentRuns,
  writePiSubagentDeletedTombstone,
} from '@cindy/maker-core/pi-subagent-runs';
import { DEFAULT_DRAFT_SESSION_TITLE, normalizeAutoTitle } from '@cindy/maker-shared/session-title';

import { getDbClient } from '../client/current';
import * as currentDb from '../client/current';
import type { DbClient } from '../client/DbClient';
import type { SessionsSetTerminalStatusResult } from '../client/tx/types';
import { sessions, messages } from '../schema';
import { clearSessionAttention } from '../../appBadgeService';
import {
  selectSessionListRows,
  selectSessionWithCount,
  selectSessionsByIds,
  flattenSessionReadRow,
  projectSessionReadResult,
  type SessionListRow,
} from '../sessionQueries';
import { commitBotProfileDeletion } from '../botProfileDeletionStore.js';
import {
  persistSessionListProjectionBatch,
  type SessionListProjectionBackfillItem,
} from '../sessionListProjection';
import { buildSessionListFlightKey, runSessionListSingleFlight } from './sessionListSingleFlight';
import { throwIpcError, requireString, requireObject } from '../../utils/ipcValidate';
import { bindDeletedPiSubagentCleanupCancel } from './piSubagentDeletion';
import { resolveBusinessSessionId } from '../../sessionIds';
import { normalizeDbAgentKind } from '../../../shared/agentKindConversion';
import {
  projectSessionContextWindow,
  type ContextWindowSession,
} from '../../../shared/sessionContextWindow';
import {
  sessionToCamel,
  sessionUsageToCamel,
  sessionCreateToRow,
  sessionPatchToRow,
  persistableSessionEffort,
  projectSessionRuntimeFields,
  normalizeRemoteHostId,
  finalizePlainPreview,
} from '../mapper';
import { ensureDialogueWorkspaceDir } from '../dialogueWorkspace';
import { recomputePrRefsForSession } from '../../git-context/prRefsStore';
import * as imageCacheStore from '../../imageCacheStore';
import { removeSessionRefsIfDeleted as removeDeletedSessionMediaRefs } from '../../cindy-media/ledger';
import {
  imAttachmentsRoot,
  removeImSessionAttachmentDirs,
} from '../../im/shared/inboundFileStaging';
import { upsertRecentWorkdir } from './recentWorkdirs';
import { createLogger } from '../../logger';
import {
  DESKTOP_TASK_LIST_SESSION_SOURCES,
  DESKTOP_VISIBLE_SESSION_SOURCES,
  isRetainableProjectSession,
} from '../../../shared/sessionSource.js';
import {
  normalizeWorkingDirForProjectSettings,
  normalizeWorkingDirForStorage,
  workingDirEquals,
} from '../../../shared/workingDir.js';
import {
  WORKTREE_MOVE_BLOCKED_CODE,
  WORKTREE_MOVE_BLOCKED_MESSAGE,
} from '../../../shared/worktreeMoveGuardError.js';
import { assertRendererSessionSourceAllowed } from './sessionSourceGuard.js';
import type { SessionReference } from '../../../shared/sessionReference.js';
import * as broadcastTap from '../../device-link/broadcast-tap.js';
import { notifyAgentIslandSessionPatch } from '../agentIslandSessionPatch';
import { ensureHiddenSessionRegistryLoaded } from '../hiddenSessionRegistry.js';
import { recoverGeneratedImagesForHistory } from '../../cindy-media/generatedImageRecovery';
import { noteSessionClearBoundary } from '../../messagePersistBroadcaster';
import {
  ackSessionTurnEndedDurable,
  ackSessionTurnEndedIfUnchanged,
  listErrorTailPendingRows,
  listErrorTailPendingSessionIds,
  listInterruptedPendingRows,
  listInterruptedPendingSessionIds,
  setOnSessionTurnEndedPersisted,
} from '../sessionActiveTurn';
import { listInterruptedResumeCandidateRows } from '../interruptedResumeCandidates';
import { formatIslandToolDetail } from '../../agent-island/toolDetail';
import { createLocalizedToolRowWording } from '../../agent-island/toolWording';
import { dismissErrorMessage, rebroadcastAgentSwitchBoundary } from './messages';
import { SESSION_READ_BATCH_LIMIT } from '../../../shared/sessionRead';
import { isDeviceLinkInvoke } from '../../device-link/invoke-context.js';
import {
  assertTrustedAppRendererEvent,
  isTrustedAppRendererWindow,
} from '../../security/trustedAppRenderer.js';
import { removeTurnChangeSetsForSession } from '../../turn-change-set/store.js';
import { quiesceSessionBeforeWorktreeRecycle } from './sessionRemovalOperations.js';
import { withSessionRouteLock, withSessionRouteLocks } from '../sessionRouteLock.js';
import { cleanupSessionRuntimeForTerminalStatus } from '../sessionRuntimeCleanup.js';
import { requestSessionArchiveSync } from '../sessionArchiveSync.js';
import { cindyMakeManager } from '../../cindy-make/manager.js';
import { recycleCindyMakeTask } from '../../cindy-make/taskManagement.js';
import { broadcastSubagentRunsInvalidated } from './subagentRuns.js';
import { compactSessionToolResultsBestEffort } from '../toolResultCompaction.js';
import { consumeWritableDirectoryPickerGrants } from '../../maker-ipc/writableDirectoryPickerGrant.js';
import { createSessionService } from '@cindy/app-runtime/sessionService';
import { setSessionRuntimeCleanup } from '../sessionRuntimeCleanup';
export type * from '@cindy/app-runtime/sessionService';

const log = createLogger('sessions');
const snapshot = createSessionSnapshot({ getDbClient: () => getDbClient(), logger: log });
const notifications = createSessionNotifications({
  broadcastTap,
  logger: log,
  isProvisionalSession: (...args) => isProvisionalSession(...args),
  localRecipients: () =>
    BrowserWindow.getAllWindows().map((window) => ({
      isDestroyed: () => window.isDestroyed(),
      isTrusted: () => isTrustedAppRendererWindow(window),
      send: (channel, payload, ...stamp) => window.webContents.send(channel, payload, ...stamp),
    })),
});
const activity = createSessionUserActivity({
  getDbClient: () => getDbClient(),
  upsertRecentWorkdir: (...args) => upsertRecentWorkdir(...args),
  notifications,
});

const service = createSessionService<Electron.IpcMainInvokeEvent>({
  ...snapshot,
  ...notifications,
  ...activity,
  currentDb,
  imageCacheStore,
  logger: log,
  ipc: ipcMain,
  ensureOpenedProjectGit: (...args) => ensureOpenedProjectGit(...args),
  openSession: (...args) => openSession(...args),
  claimOwnedProvisionalSession: (...args) => claimOwnedProvisionalSession(...args),
  configureProvisionalSessions: (...args) => configureProvisionalSessions(...args),
  deleteUnsentSessionRow: (...args) => deleteUnsentSessionRow(...args),
  forgetProvisionalSession: (...args) => forgetProvisionalSession(...args),
  isProvisionalSession: (...args) => isProvisionalSession(...args),
  markProvisionalSession: (...args) => markProvisionalSession(...args),
  provisionalManagedDir: (...args) => provisionalManagedDir(...args),
  removeEmptyDialogueDir: (...args) => removeEmptyDialogueDir(...args),
  sweepLeftoverProvisionalSessions: (...args) => sweepLeftoverProvisionalSessions(...args),
  emitSessionCreated: (...args) => emitSessionCreated(...args),
  emitSessionListChangedLocally: (...args) => emitSessionListChangedLocally(...args),
  physicalWorktreeKey: (...args) => physicalWorktreeKey(...args),
  withWorktreeResourceLocks: (...args) => withWorktreeResourceLocks(...args),
  managedWorktreeRoot: (...args) => managedWorktreeRoot(...args),
  notifyWorktreeRecycleOpportunity: (...args) => notifyWorktreeRecycleOpportunity(...args),
  getDbClient: (...args) => getDbClient(...args),
  clearSessionAttention: (...args) => clearSessionAttention(...args),
  selectSessionListRows: (...args) => selectSessionListRows(...args),
  selectSessionWithCount: (...args) => selectSessionWithCount(...args),
  selectSessionsByIds: (...args) => selectSessionsByIds(...args),
  flattenSessionReadRow: (...args) => flattenSessionReadRow(...args),
  projectSessionReadResult: (...args) => projectSessionReadResult(...args),
  commitBotProfileDeletion: (...args) => commitBotProfileDeletion(...args),
  persistSessionListProjectionBatch: (...args) => persistSessionListProjectionBatch(...args),
  bindDeletedPiSubagentCleanupCancel: (...args) => bindDeletedPiSubagentCleanupCancel(...args),
  sessionToCamel: (...args) => sessionToCamel(...args),
  sessionUsageToCamel: (...args) => sessionUsageToCamel(...args),
  sessionCreateToRow: (...args) => sessionCreateToRow(...args),
  sessionPatchToRow: (...args) => sessionPatchToRow(...args),
  persistableSessionEffort: (...args) => persistableSessionEffort(...args),
  projectSessionRuntimeFields: (...args) => projectSessionRuntimeFields(...args),
  normalizeRemoteHostId: (...args) => normalizeRemoteHostId(...args),
  finalizePlainPreview: (...args) => finalizePlainPreview(...args),
  ensureDialogueWorkspaceDir: (...args) => ensureDialogueWorkspaceDir(...args),
  recomputePrRefsForSession: (...args) => recomputePrRefsForSession(...args),
  removeDeletedSessionMediaRefs: (...args) => removeDeletedSessionMediaRefs(...args),
  imAttachmentsRoot: (...args) => imAttachmentsRoot(...args),
  removeImSessionAttachmentDirs: (...args) => removeImSessionAttachmentDirs(...args),
  upsertRecentWorkdir: (...args) => upsertRecentWorkdir(...args),
  assertRendererSessionSourceAllowed: (...args) => assertRendererSessionSourceAllowed(...args),
  notifyAgentIslandSessionPatch: (...args) => notifyAgentIslandSessionPatch(...args),
  ensureHiddenSessionRegistryLoaded: (...args) => ensureHiddenSessionRegistryLoaded(...args),
  recoverGeneratedImagesForHistory: (...args) => recoverGeneratedImagesForHistory(...args),
  noteSessionClearBoundary: (...args) => noteSessionClearBoundary(...args),
  ackSessionTurnEndedDurable: (...args) => ackSessionTurnEndedDurable(...args),
  ackSessionTurnEndedIfUnchanged: (...args) => ackSessionTurnEndedIfUnchanged(...args),
  listErrorTailPendingRows: (...args) => listErrorTailPendingRows(...args),
  listErrorTailPendingSessionIds: (...args) => listErrorTailPendingSessionIds(...args),
  listInterruptedPendingRows: (...args) => listInterruptedPendingRows(...args),
  listInterruptedPendingSessionIds: (...args) => listInterruptedPendingSessionIds(...args),
  setOnSessionTurnEndedPersisted: (...args) => setOnSessionTurnEndedPersisted(...args),
  listInterruptedResumeCandidateRows: (...args) => listInterruptedResumeCandidateRows(...args),
  dismissErrorMessage: (...args) => dismissErrorMessage(...args),
  rebroadcastAgentSwitchBoundary: (...args) => rebroadcastAgentSwitchBoundary(...args),
  isDeviceLinkInvoke: (...args) => isDeviceLinkInvoke(...args),
  assertTrustedAppRendererEvent: (...args) => assertTrustedAppRendererEvent(...args),
  removeTurnChangeSetsForSession: (...args) => removeTurnChangeSetsForSession(...args),
  withSessionRouteLock: (...args) => withSessionRouteLock(...args),
  withSessionRouteLocks: (...args) => withSessionRouteLocks(...args),
  cleanupSessionRuntimeForTerminalStatus: (...args) =>
    cleanupSessionRuntimeForTerminalStatus(...args),
  requestSessionArchiveSync: (...args) => requestSessionArchiveSync(...args),
  recycleCindyMakeTask: (...args) => recycleCindyMakeTask(...args),
  broadcastSubagentRunsInvalidated: (...args) => broadcastSubagentRunsInvalidated(...args),
  compactSessionToolResultsBestEffort: (...args) => compactSessionToolResultsBestEffort(...args),
  consumeWritableDirectoryPickerGrants: (...args) => consumeWritableDirectoryPickerGrants(...args),
  setSessionRuntimeCleanup: (...args) => setSessionRuntimeCleanup(...args),
  userDataDirectory: () => app.getPath('userData'),
  piAgentHomeForSession: () => path.join(app.getPath('userData'), 'pi-agent-home'),
  piSubagentRunHomes: async () => [path.join(app.getPath('userData'), 'pi-agent-home')],
  senderId: (event) => event.sender.id,
  formatInterruptedToolDetail: (name, input) =>
    formatIslandToolDetail(name, input, { wording: createLocalizedToolRowWording() }),
  settleMakeTasksForSession: (...args) => cindyMakeManager.settleTasksForSession(...args),
  loadSharedTasks: () => import('../../device-link/sharedTaskRuntime.js'),
  loadMaker: () => import('../../maker-host/index.js'),
  loadWorktreeRecycle: () => import('../../worktree/sessionRemovalRecycle.js'),
  loadPluginNotifications: () => import('../../cindy-brain/index.js'),
  loadSummaries: () => import('../../sessionTaskSummary.js'),
  loadTranscriptRelocation: () => import('../../maker-host/claude-transcript-relocation.js'),
});
export const {
  setSessionWorktreeBindingLookup,
  setSessionWorktreeRecycle,
  requestSessionWorktreeRecycle,
  captureSessionRecycleScope,
  recycleSessionWorktreeForStatusChange,
  scheduleWorktreeRecycleForStatusChange,
  applyAgentSwitchToSessionRow,
  applyAgentSwitchResumeFallbackAtomically,
  persistSessionPermissionModeIfAuto,
  persistSessionFields,
  commitProvisionalSession,
  discardProvisionalSessionRow,
  setOnUserSessionTitleWritten,
  getOverwritableAutoTitle,
  isUntitledSessionAwaitingAutoTitle,
  persistSessionTitleIfStillDraft,
  clearSessionContextInDb,
  registerSessionIpc,
  updateSessionInDb,
  restoreArchivedSessionForSend,
  patchSessionMetaInDb,
  renameSessionTitlesInDb,
  setSessionsStatusInDb,
  deleteBotProfileAndDetachSessionsInDb,
  resumeDeletedPiSubagentCleanup,
  setWorktreePathInDb,
  setSessionProviderIdInDb,
  setSessionSourceInDb,
  createSessionRemoteHostIdReader,
  getSessionRowSnapshotStrict,
  getSessionRowSnapshot,
  getSessionFsSnapshot,
  broadcastSessionPatched,
  touchUserSendInDb,
} = service;
export { setSessionRuntimeCleanup };
