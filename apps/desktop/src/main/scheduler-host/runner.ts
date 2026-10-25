import { beginQuietScheduledOutput, hidesScheduledTranscript } from './silent-output.js';

import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
} from '../device-link/broadcast-tap.js';

import { shouldApplyExclusiveProviderRerouteLive } from '../maker-host/model-route-guard-live.js';


import { createMessage, rewindPersistedUserMessageAfterClear } from '../localDb/ipc/messages.js';

import {
  getSessionRowSnapshot,
  getSessionFsSnapshot,
  touchUserSendInDb,
} from '../localDb/ipc/sessions.js';

import {
  getSessionProvider,
  setSessionProvider,
  hydrateSessionProvider,
} from '../maker-host/session-provider-store.js';

import { setSessionEffort, setSessionFastMode } from '../maker-host/session-effort-store.js';

import {
  CredentialModeSwitchBusyError,
  isCodexThreadModelProviderIdentityMismatch,
  prepareLocalCodexCredentialModeSwitch,
  prepareLocalSessionCredentialModeSwitch,
  shouldCloseSessionForCredentialSwitch,
} from '../maker-host/codex-credential-switch.js';

import { crossesCodexAppliedCustomProviderIdentity } from '../maker-host/codex-custom-provider-route.js';

import { ensureDialogueWorkspaceDir } from '../localDb/dialogueWorkspace';

import {
  wireSessionToIpc,
  isSessionInTurn,
  noteSilentStopUserSend,
  onSilentStopSettled,
} from '../maker-ipc/register.js';

import { agentHandoffPending } from '../maker-ipc/agentHandoffPendingSingleton.js';

import { resolveWorkingDir } from './workdir-resolver';



import { beginHeadlessGhostSetupTurn } from '../mcp-integrations/ghostSetupInteractionSurface.js';

import { isManagedScheduledTarget, restoreScheduledTarget } from './restore-target';
import { createMakerScheduleRunner } from '@cindy/app-runtime/schedulePromptRunner';
export type * from '@cindy/app-runtime/schedulePromptRunner';
export { QUEUED_DISPATCH_TRACK_POLL_MS, QUEUED_DISPATCH_MAX_WAIT_MS, QUEUED_DISPATCH_SUSPEND_GAP_MS, buildSilentRunInstruction } from '@cindy/app-runtime/schedulePromptRunner';
export const { MakerScheduleRunner } = createMakerScheduleRunner({
beginQuietScheduledOutput: (...args) => beginQuietScheduledOutput(...args),
hidesScheduledTranscript: (...args) => hidesScheduledTranscript(...args),
captureDataOwnerBroadcastScope: (...args) => captureDataOwnerBroadcastScope(...args),
isDataOwnerBroadcastScopeCurrent: (...args) => isDataOwnerBroadcastScopeCurrent(...args),
shouldApplyExclusiveProviderRerouteLive: (...args) => shouldApplyExclusiveProviderRerouteLive(...args),
createMessage: (...args) => createMessage(...args),
rewindPersistedUserMessageAfterClear: (...args) => rewindPersistedUserMessageAfterClear(...args),
getSessionRowSnapshot: (...args) => getSessionRowSnapshot(...args),
getSessionFsSnapshot: (...args) => getSessionFsSnapshot(...args),
touchUserSendInDb: (...args) => touchUserSendInDb(...args),
getSessionProvider: (...args) => getSessionProvider(...args),
setSessionProvider: (...args) => setSessionProvider(...args),
hydrateSessionProvider: (...args) => hydrateSessionProvider(...args),
setSessionEffort: (...args) => setSessionEffort(...args),
setSessionFastMode: (...args) => setSessionFastMode(...args),
isCodexThreadModelProviderIdentityMismatch: (...args) => isCodexThreadModelProviderIdentityMismatch(...args),
prepareLocalCodexCredentialModeSwitch: (...args) => prepareLocalCodexCredentialModeSwitch(...args),
prepareLocalSessionCredentialModeSwitch: (...args) => prepareLocalSessionCredentialModeSwitch(...args),
shouldCloseSessionForCredentialSwitch: (...args) => shouldCloseSessionForCredentialSwitch(...args),
crossesCodexAppliedCustomProviderIdentity: (...args) => crossesCodexAppliedCustomProviderIdentity(...args),
ensureDialogueWorkspaceDir: (...args) => ensureDialogueWorkspaceDir(...args),
wireSessionToIpc: (...args) => wireSessionToIpc(...args),
isSessionInTurn: (...args) => isSessionInTurn(...args),
noteSilentStopUserSend: (...args) => noteSilentStopUserSend(...args),
onSilentStopSettled: (...args) => onSilentStopSettled(...args),
agentHandoffPending,
resolveWorkingDir: (...args) => resolveWorkingDir(...args),
WorktreePool: { releaseWorktree: async id => (await import('../worktree')).WorktreePool.releaseWorktree(id) },
beginHeadlessGhostSetupTurn: (...args) => beginHeadlessGhostSetupTurn(...args),
restoreScheduledTarget: (...args) => restoreScheduledTarget(...args)
 });
export type MakerScheduleRunner = InstanceType<typeof MakerScheduleRunner>;
