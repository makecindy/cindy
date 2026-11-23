// Must stay first: removes inherited Anthropic credentials before other modules load.
import './boot-env.js';
// Second: keeps unreadable user settings files instead of deleting them.
import './boot-settings.js';
import {confirmCloudGuestWhenOnline} from '@cindy/auth-client/linux-cloud';
import { resolveAutomaticProjectIcon } from '../../desktop/src/main/projectAutomaticIcon.js';
import { readProjectIconImage, readProjectInfo } from '../../desktop/src/main/projectInfoCore.js';
import { bindHostProfileServices } from './agent/profile-services.js';
import { reconcileDeletedTaskViewState } from '../../desktop/src/main/mcp-apps/viewStateStore.js';
import { clientMigrationContract } from './client-migration-contract.mjs';
import { runLegacyPluginMigrationPreflight } from './plugins/legacy-approvals.js';
import { createRightSidebarTabsService } from '../../desktop/src/main/localDb/ipc/rightSidebarTabs.js';
import { createHostPlatformTools } from './platform/tools.js';
import { createHostCodexRuntime, createHostSubscriptionFastPolicies } from './agent/codex-runtime.js';
import type { EngineKind } from '@cindy/maker-core';
import { createHostClaudeProxyRuntime } from './agent/claude-proxy-runtime.js';
import { createAvailabilityPolicy } from '../../desktop/src/main/device-link/providerShareAvailabilityPolicyCore.js';
import { configureWindowsAtomicRename } from '../../desktop/src/main/windowsAtomicRename.js';
import { isDefinitiveRefreshError } from '../../desktop/src/main/authRefreshError.js';
import type { HostStartFailureReason } from '../../desktop/src/shared/hostStartFailure.js';
import { classifyHostStartFailure, HostAccountMismatchError, HostSignInRequiredError } from './start-failure.js';
import { AuthRefreshBackoff } from '../../desktop/src/main/authRefreshBackoff.js';
import { AUTH_ACCOUNT_VAULT_LOCK_FILE } from '../../desktop/src/main/authRefreshCommit.js';
import { createUserSession } from '../../desktop/src/main/localDb/ipc/createUserSession.js';
import { setSessionOpeningModelAdmission } from '../../desktop/src/main/localDb/sessionOpening.js';
import { resolveSessionExecutionSelection } from '../../desktop/src/main/maker-ipc/sessionExecutionSelection.js';
import { buildLocalProviderRoutingContext } from '../../desktop/src/main/maker-ipc/orcaProviderRoutingContext.js';
import { configureProvisionalSessions, isProvisionalSession, forgetProvisionalSession, sweepLeftoverProvisionalSessions } from '../../desktop/src/main/localDb/provisionalSessions.js';
import { commitProvisionalSession, discardProvisionalSessionRow } from '../../desktop/src/main/localDb/sessionDraftLifecycle.js';
import { activeOwnerScopeKey, beginAppSessionBoundary, commitVolatileAppSession, getActiveAppSession, getActiveDataOwnerPushStamp, isAppSessionBoundaryPending } from '../../desktop/src/main/appSessionState.js';
import { statWorkingDirectory, workdirProbeHostClient } from '../../desktop/src/main/workdir-probe-host/index.js';
import { mapMembershipToAuthUser, type User as AccountUser } from '../../desktop/src/shared/authUser.js';
import { resolveSessionDevice, canRegisterHostDevice } from './auth/device-identity.mjs';
import { AUTH_SESSION_KEY } from '../../desktop/src/main/authCredentialKeys.js';
import { createHostDeviceLink } from './device-link.js';
import { createHostService } from './service.mjs';
import { createHostRuntimeSession, type HostRuntimeSessionCreatePorts } from './agent/create-runtime-session.js';
import {
  createHostProfileCoexistenceMonitor, createDesktopScanner, HOST_PROFILE_IN_USE_BY_DESKTOP, HostProfileInUseError,
  type CoexistenceMonitor, type CoexistenceState,
} from './agent/profile-coexistence.js';
import { createHostProviderExecutionCheck } from './agent/send-preflight.js';
import { explicitPorts } from './agent/explicit-ports.js';
import { createSkillProjectionBoundaryObserver, readSkillProjectionBoundaryStatus } from './agent/skill-projection-boundary.js';
import { refuseSkillProjectionOwnerCommit, sweepOwnerSkillProjectionsAtLogout } from './agent/skill-projection-owner.js';
import { createHostSharedGlobalSkills } from './agent/shared-global-skills.js';
import { createHostAgentSkillList } from './agent/agent-skills.js';
import { resolveRuntimeDeviceId } from '../../desktop/src/main/deviceId.js';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { createHostWebSocketAgent, hostOutbound } from './outbound.mjs';
import { getDefaultVoiceInputSettings } from '../../desktop/src/shared/voiceInputData.ts';
import { DEFAULT_APPEARANCE_SETTINGS } from '../../desktop/src/shared/appearanceSettings.ts';
import { createDefaultLayout } from '../../desktop/src/shared/layoutTree.ts';

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hostRuntimeLayout } from './runtime-layout.mjs';
import { createHostServerApi } from './server-api.js';
import { accessTokenRefreshDelayMs, decodeAccessTokenOrgSlug } from '../../desktop/src/main/authTokenClaims.js';
import { parseGhostSetupInteractionCommand } from '../../desktop/src/main/cindy-brain/ghostSetupInteractionBridge.js';
import { openSystemBrowser, openHostBrowser } from './browser-open.mjs';

import { createDbClientForHandle } from '../../desktop/src/main/localDb/client/createDbClientForHandle.js';
import { OwnerSessionStorage } from '../../desktop/src/main/localDb/sessionStorageAdapter.js';
import { getDbClient, setCurrentDbClient, clearCurrentDbClient, getCurrentDbClientSnapshot } from '../../desktop/src/main/localDb/client/current.ts';
import { waitForRetainedDbClient } from '../../desktop/src/main/localDb/client/pendingOperations.ts';
import { loadAgentInputQueueSnapshot, saveAgentInputQueueSnapshot, getPersistedInputClientIds } from '../../desktop/src/main/localDb/agentInputQueueSnapshots.ts';
import { markSessionTurnStartedDurable, markSessionTurnEnded, drainSessionActiveTurnWrites, ackSessionTurnEndedDurable,
  hasAssistantProgressAfterMessage, getRecoveryContextSnapshot,
} from '../../desktop/src/main/localDb/sessionActiveTurn.ts';
import { readSessionExtraDirsFromDb, readSessionWritableDirsFromDb, readSessionWorkingDirFromDb } from '../../desktop/src/main/maker-host/session-storage.js';
import { applyRemoteDirectoryGrantUpdate } from '../../desktop/src/main/maker-ipc/remoteDirectoryGrantUpdate.js';
import { createTaskWritableDirsUpdater } from '../../desktop/src/main/projectDirectoryRuntime.js';
import { extraDirsForRuntime, libraryRootForRuntime, replaceUserExtraDirs, validateExtraDirs, excludeDirectoryGrantConflictsWithSlots } from '../../desktop/src/main/maker-ipc/extraDirsValidator.js';
import { createProviderGroupStore } from '../../desktop/src/main/provider-group/storeCore.js';
import { createProviderGroupBindings } from '../../desktop/src/main/provider-group/bindings.js';
import { createHostHarnessBinaries, HOST_HARNESS_KINDS } from './agent/harness-binary.js';
import { openOwnerDatabase, OwnerDatabaseError } from '../../desktop/src/main/localDb/startupCore.js';
import { discoverHostOwner, ownerDatabasePath, resolveHostDataDir, resolveHostRegion, resolveHostAppDataDir } from './profile-path.mjs';
import { acquireHostRuntimeLease, acquireHostServiceLease, type HostRuntimeLease } from './runtime-lock.js';
import { publishHostEndpoint, readHostProcessStatus, requestHostStop, requestHostRemote } from './control.mjs';
import { readAdoptedSessionState } from './credentials/session.mjs';
import { hostAccountVaultLock, HostRefreshDeferredError, HostSessionMissingError, refreshHostSession } from './auth/refresh.mjs';
import { configureHostOwner, readClaudeSubscriptionState } from './agent/claude-auth.mjs';
import { attachAgentsToMakerMemory, type createHostMemoryManager } from './agent/memory.mjs';
import { createHostAgentGraph } from './agent/runtime.js';
import { createHostReviewContextResolver } from './agent/review-context.js';
import { createHostGitSnapshot, type HostGitSnapshot } from './agent/git-snapshot.js';
import { removeTurnChangeSetsForSession } from '../../desktop/src/main/turn-change-set/store.js';
import { removeSessionModelInterface } from '../../desktop/src/main/maker-host/session-model-interface.js';
import { cleanupSessionRuntimeForTerminalStatus } from '../../desktop/src/main/localDb/sessionRuntimeCleanup.js';
import { reconcileSavepointRefsForDeletedSessions } from '../../desktop/src/main/git-snapshot/savepointCleanup.js';
import { createHostMcpRuntime } from './agent/mcp-runtime.js';
import { createHostAgentAuth } from './agent/auth-service.js';
import { createLogger, initLogger, setCcDebugTailingEnabled } from '../../desktop/src/main/logger.js';
import { reapCodexToolTreesSync } from '../../desktop/src/main/codex-tool-tree-reaper.js';
import { createHostIpcRoute } from './ipc-route.mjs';
import { createHostIpcBindings } from './ipc-bindings/index.js';
import { projectHostAuthState } from './auth-state.js';
import { createHostModelAccess } from './agent/model-access.js';
import { createHostUsagePricing } from './agent/usage-pricing.ts';
import { createHostUsageRecording } from './agent/usage-recording.ts';
import { MODEL_ACCESS_STATUS_CHANNEL } from '../../desktop/src/shared/modelAccess.js';
import { createProviderCatalog } from './agent/providers.mjs';
import { closeCliProxyBridge } from '../../desktop/src/main/maker-host/cli-proxy-bridge.js';
import { getXdGatewayModels, markXdGatewayModelAccessUnknown, setXdGatewayModels } from '../../desktop/src/main/maker-host/active-catalog.js';
import { buildModelsSyncRequest, parseModelsSyncPayload, withModelsSyncOverallDeadline } from '../../desktop/src/main/model-access/modelsSyncRefresh.js';
import { createHostProviderConfig } from './agent/provider-config.js';
import { createProviderRouteResolver } from './agent/provider-credentials.mjs';
import { createHostHistoryReader, readMessagesList, readMessagesAroundClientId } from './agent/history.js';
import { runLoginCommand } from './login-cli.mjs';
import { readOrCreateApiToken } from './api-token.mjs';
import { CindyAuthClient } from '@cindy/auth-client';
import { hostAuthFetch } from './auth-fetch.mjs';
import type { Effort, PermissionMode } from '@cindy/maker-core';
import { createRequire } from 'node:module';
import { readAuthEndpoints } from './auth/endpoints.mjs';
import { assertHostSessionRegion, HostCrossRegionPersonalAccountError, hostPackageRegion } from './auth/region-policy.js';
import { logoutHostSession } from './auth/logout.mjs';
import { listInstalledPlugins } from './plugins.mjs';
import { createHostGhostManager } from './plugins-installed.ts';
import { initializeHostPluginRemoteAuthorization } from './plugins/remote-authorization.js';
import { ownerScopedPath } from '../../desktop/src/main/dataOwnerPath.js';
import { createHostPluginRuntime } from './plugins/runtime.js';
import { createHostPluginGateway } from './plugins/gateway.js';
import type { createHostToolService } from './agent/host-tools.js';
import { createHostConfirmations } from './host-confirmations.js';
import { createMainI18n } from '../../desktop/src/main/i18n.js';
import { createHostMcpDuplicateChoices } from './agent/mcp-duplicate-choices.js';
import { toolAutoReviewAction } from '@cindy/maker-core';
import { GhostGrantConfirmBridge } from '../../desktop/src/main/cindy-brain/ghostGrantConfirmBridge.js';
import { getGhostCard, listGhostCardsBySession } from '../../desktop/src/main/cindy-brain/cardStoreDb.js';
import { ghostAppContextLocale } from '../../desktop/src/shared/ghost.js';
import { MAKER_PUSH } from '../../desktop/src/main/maker-ipc/channels.js';
import { listActiveSessions, listRunningSessions } from './sessions.mjs';
import {
  readProfileSettings,
  writeAppearanceSettingsPatch,
  writeAppShortcutOverrides,
  writeLayout,
  writeSidebarSettings,
} from './profile-settings.mjs';
import { createCredentialStore } from './credentials/store.mjs';
import { createHostServer } from './server.mjs';
import { createPlatformClientBridge } from './platform/client-bridge.js';
import { createSnapshotProcess } from './snapshot-process.mjs';
import { configureGhostSnapshotProcess } from '../../desktop/src/main/cindy-brain/ghostSnapshotCapability.js';
import { withCrossProcessLock } from '../../desktop/src/main/device-link/crossProcessLock.js';
import { createChatHandler } from './chat.mjs';
import { createOwnerBoundaryStop, runOwnerBoundary } from './agent/owner-boundary.ts';
import { createEventHub } from './events.mjs';
import { createTaskTagService } from '../../desktop/src/main/localDb/ipc/taskTagService.js';
import { executeConversationSearch } from '../../desktop/src/main/localDb/ipc/search.js';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from '../../desktop/src/main/device-link/broadcast-tap.js';
import { createInputQueue } from './agent/input-queue.mjs';
import { createHostSessionActivity } from './agent/session-activity.ts';
import { readClaudeIdleMinutesFrom } from '../../desktop/src/main/maker-host/claudeIdleReleaseSettingsCore.js';
import { createHostAgentHandoffPending } from './agent/handoff-pending.ts';
import { createHostTaskRuntimePlugins } from './agent/task-runtime-plugins.js';
import { setGhostToolApprovalResolver } from '../../desktop/src/main/maker-host/mcp-tool-approval-policy.js';
import { warmRuntimePluginSettings } from '../../desktop/src/main/maker-host/runtime-plugin-settings.js';
import { bindHostSessionRuntimeHooks, createHostRuntimeSelection, hostRuntimeSelectionQueueHooks } from './agent/runtime-selection.ts';
import { throwIpcError } from '../../desktop/src/main/utils/ipcValidate.js';
import type { ContextRecoveryKind } from './agent/context-recovery.ts';
import { createHostContextRecoveryWiring } from './agent/context-recovery-wiring.ts';
import { lockSessionRoute } from './agent/session-route-lock.mjs';
import { listPiRuntimePaletteCommands, mergePiPackageCommands, shouldListPiPackageCommands } from '../../desktop/src/shared/piPackages.js';
import { createHostSessionUpdate } from './agent/session-update.ts';
import { createHostSessionMovePorts, createRecentWorkdirsChangedPush } from './agent/session-move.ts';
import { createHostTouchUserSend } from './agent/touch-user-send.ts';
import { setLiveCcSessionBridge } from '../../desktop/src/main/maker-host/claude-transcript-relocation.ts';
import { bindTaskRestoreRetention, createHostTaskRestore } from './agent/task-restore.ts';
import { bindHostUiText } from './ui-text.ts';
import { createHostGeneratedImages } from './agent/generated-images.ts';
import { reconcileGeneratedImageRecovery, recoverGeneratedImagesForHistory } from '../../desktop/src/main/cindy-media/generatedImageRecovery.js';
import { bindHostProjectIconRuntime } from './project-icon.ts';
import { createUserInputEnqueue } from './agent/user-input.ts';
import { resolveSessionReferencesWithPorts } from '../../desktop/src/main/maker-ipc/sessionReferenceResolverCore.ts';
import { readSwitchOptionsAgentDeviceId, readSwitchOptionsConfirmedContextWindow } from '../../desktop/src/main/maker-ipc/sessionAgentSwitchHandler.ts';
import { setSessionRouteLockImplementation } from '../../desktop/src/main/localDb/sessionRouteLock.ts';
import { withSendToSessionLock } from '../../desktop/src/main/maker-ipc/sendToSessionLock.ts';
import { createHostWorktreeLifecycle } from './agent/worktree-lifecycle.ts';
import { requireBuiltinAgentKind } from '../../desktop/src/main/maker-host/engineKind.ts';
import { createInteractionBroker } from './agent/interactions.mjs';
import { messageToCamel, sessionToCamel } from '../../desktop/src/main/localDb/mapper.ts';
import { readHostSessionList, readHostSession } from './session-reads.js';
import { createHostMessageStore, createHostMessageRecovery } from './message-store.js';
import { createHostAttachments } from './attachments.js';
import { createSubagentReadService } from '../../desktop/src/main/localDb/ipc/subagentReadService.js';
import { configureUserDataDir, configureAppDataDir, getUserDataDir } from '../../desktop/src/main/userDataPath.js';
import { botSessionLinks, messages as messageTable, projectAliases as projectAliasTable, sessions as sessionTable } from '../../desktop/src/main/localDb/schema.js';
import { describeHostOutboundProxy, describeOutboundProxyLine, startHostSystemProxySettings, stopHostSystemProxySettings } from './outbound-proxy.ts';
import { and, eq, isNull } from 'drizzle-orm';
import { projectHistoryView } from '@cindy/maker-shared/message-window';
import { isDefaultDraftSessionTitle, normalizeAutoTitle } from '@cindy/maker-shared/session-title';

const DEFAULT_VOICE_INPUT_SETTINGS = getDefaultVoiceInputSettings();
configureGhostSnapshotProcess(createSnapshotProcess);
const VALID_EFFORTS: Record<string, true> = {
  minimal: true, low: true, medium: true, high: true, xhigh: true, max: true, ultra: true,
};
const VALID_PERMISSION_MODES: Record<string, true> = {
  ask: true, default: true, acceptEdits: true, plan: true, auto: true, bypassPermissions: true,
};
function parseEffort(value: unknown): Effort | undefined {
  if (typeof value !== 'string' || VALID_EFFORTS[value] !== true) return undefined;
  return value as Effort;
}
function parsePermissionMode(value: unknown): PermissionMode | undefined {
  if (typeof value !== 'string' || VALID_PERMISSION_MODES[value] !== true) return undefined;
  return value as PermissionMode;
}

const command = process.argv[2];
const usage = 'cindy-host [serve|login [--region=cn|global] [--org=<domain-or-id>] [--method=<id>]|open|status [--json]|migration-preflight <profile-directory>|remote [status|enable|disable|revoke <device-id>|agent-net-on|agent-net-off|rejoin]|stop]';

/** The status command's boundary category: the running Host's, else a lock-free read of the profile. */
function readStatusSkillProjectionBoundary(processStatus: { running: boolean | null; runtime?: { skillProjectionBoundary?: string } }) {
  if (processStatus.running) return processStatus.runtime?.skillProjectionBoundary ?? null;
  const owner = process.env.CINDY_HOST_OWNER?.trim() || discoverHostOwner(resolveHostDataDir()).ownerId;
  if (!owner) return null;
  configureUserDataDir(resolveHostDataDir());
  return readSkillProjectionBoundaryStatus(owner);
}

// Every command, before it reads a profile: a release refuses a CINDY_HOST_REGION that names the other
// edition (profile-path.mjs resolveHostRegion) instead of running as the wrong one.
try {
  resolveHostRegion();
} catch (error) {
  console.error(`cindy-host: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
// open, status, stop and remote only contact a local loopback endpoint.
const proxyWarmup = command === undefined || command === 'serve' || command === 'login'
  ? startHostSystemProxySettings().catch((error: unknown) => {
    console.warn('[host] system proxy warmup failed:', error instanceof Error ? error.name : 'UnknownError');
  }) : undefined;
if (command === '--help' || command === '-h') {
  console.log(`Usage: ${usage}`);
} else if (command === 'open') {
  try {
    await openHostBrowser(resolveHostDataDir());
    console.log('Opened Cindy Host in your browser.');
  } catch (error) {
    console.error(`cindy-host open failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} else if (command === 'status') {
  // Sanitized login state for scripts and for the operator: never tokens.
  try {
    const login = await readAdoptedSessionState({
      userDataDir: resolveHostDataDir(),
      keyringApplication: process.env.CINDY_HOST_KEYRING_APPLICATION?.trim() || undefined,
    }).catch(() => ({ authenticated: null, realm: null, credentialStoreUnavailable: true }));
    const processStatus = await readHostProcessStatus(resolveHostDataDir());
    const state = { ...login, ...processStatus,
      skillProjectionBoundary: readStatusSkillProjectionBoundary(processStatus) };
    const json = process.argv.includes('--json');
    if (json) {
      console.log(JSON.stringify(state));
    } else {
      console.log(`authenticated: ${state.authenticated}`);
      console.log(`realm: ${state.realm ?? 'none'}`);
      console.log(`running: ${state.running === null ? 'unreachable' : state.running}`);
      if ('region' in state && state.region) console.log(`region: ${state.region}`);
      if (state.baseUrl) console.log(`address: ${state.baseUrl}`);
      if ('outboundProxy' in state && state.outboundProxy) console.log(`outbound proxy: ${describeOutboundProxyLine(state.outboundProxy)}`);
      if ('legacyPluginApprovals' in state) {
        const report = state.legacyPluginApprovals;
        console.log(`legacy plugins missing approval receipts: ${report ? report.count : 'unchecked'}`);
        for (const id of report?.installIds ?? []) console.log(`  ${id}`);
      }
      if (state.error) console.error(state.error);
      // Row 25 (25b): an install signed in before the login published the projection owner.
      if (state.authenticated && (state.skillProjectionBoundary === 'missing-or-invalid' || state.skillProjectionBoundary === 'other-owner')) {
        console.log('Run cindy-host login again to finish setting up this account\'s Skills.');
      }
      if ('credentialStoreUnavailable' in login) console.error('Credential store is unavailable; unlock it to inspect sign-in status.');
    }
  } catch (error) {
    console.error(`cindy-host status failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} else if (command === 'migration-preflight') {
  try {
    process.exitCode = await runLegacyPluginMigrationPreflight(process.argv.slice(3));
  } catch (error) {
    console.error(`cindy-host migration-preflight failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} else if (command === 'stop') {
  try {
    const result = await requestHostStop(resolveHostDataDir());
    console.log(result.stopping ? 'Cindy Host is stopping.' : 'Cindy Host is not running.');
  } catch (error) {
    console.error(`cindy-host stop failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
 } else if (command === 'remote') {
  try {
    const action = process.argv[3] ?? 'status';
    if (!['status', 'enable', 'disable', 'revoke', 'agent-net-on', 'agent-net-off', 'rejoin'].includes(action))
      throw new Error('Usage: cindy-host remote [status|enable|disable|revoke <device-id>|agent-net-on|agent-net-off|rejoin]');
    const result = await requestHostRemote(resolveHostDataDir(), action, process.argv[4]);
    console.log(JSON.stringify(result, null, 2));
    // 「重新加入」 reports its outcome in the result (device-link.ts `rejoin`): say why it did not work, and fail the command.
    const rejoin = action === 'rejoin' ? (result as { rejoin?: { result?: unknown; hint?: unknown } }).rejoin : undefined;
    if (rejoin && typeof rejoin.hint === 'string') (rejoin.result === 'rejoined' ? console.log : console.error)(rejoin.hint);
    if (rejoin && rejoin.result !== 'rejoined') process.exitCode = 1;
  } catch (error) {
    console.error(`cindy-host remote failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} else if (command === 'login') {
  try {
    await proxyWarmup;
    await runLoginCommand(process.argv.slice(3));
  } catch (error) {
    console.error(`cindy-host login failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} else if (command !== undefined && command !== 'serve') {
  console.error(
    `unknown command: ${command}\nusage: ${usage}`,
  );
  process.exitCode = 2;
} else {
const PORT = Number(process.env.CINDY_HOST_PORT ?? '3456');
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) throw new Error('CINDY_HOST_PORT must be a valid port');
const profileDir = resolveHostDataDir();
configureUserDataDir(profileDir);
configureAppDataDir(resolveHostAppDataDir());
// Release table row 25 (25b, decision (a)): serve never publishes the Skill projection owner; the
// window, or `cindy-host login` on a Host's own profile, does. Before anything can commit.
refuseSkillProjectionOwnerCommit();
// Background copy in the locale before the owner database opens (its startup failure is one), as
// bootstrap-electron.ts configureUiText.
bindHostUiText();
bindHostProjectIconRuntime();
configureWindowsAtomicRename({
  packagedBinary: hostRuntimeLayout().atomicRenameBinary ?? undefined,
  sourceFile: hostRuntimeLayout().atomicRenameSource ?? undefined,
  cacheDir: path.join(profileDir, 'windows-atomic-rename'),
});
mkdirSync(profileDir, { recursive: true, mode: 0o700 });
const serviceLease = acquireHostServiceLease(profileDir);
if (!serviceLease.held) throw new Error(`Cindy Host profile is busy (${serviceLease.reason}). Use status or stop for this profile.`);
initLogger({ userDataDir: profileDir, isPackaged: true, logDir: path.join(profileDir, 'logs') });
// As the desktop at startup (bootstrap-electron.ts): the tailer that merges each session's
// cc-debug raw file into its NDJSON follows XDT_CC_DEBUG_NET.
setCcDebugTailingEnabled(process.env.XDT_CC_DEBUG_NET === '1');
const instanceId = randomUUID();
let removeEndpoint: (() => void) | undefined;
const releaseService = () => {
  try { removeEndpoint?.(); }
  finally { serviceLease.release(); }
};
process.once('exit', releaseService);
const layout = hostRuntimeLayout();

interface RuntimeState {
  state: 'uninitialized' | 'ready' | 'error' | 'blocked';
  owner: string | null;
  storage: 'unopened' | 'ready' | 'error';
  agents?: string[];
  agentLane?: string;
  detail?: string;
  /**
   * Coexistence plan A (agent/profile-coexistence.ts): whether a desktop that opens this profile's
   * database runs beside the Host (PIDs only). `waiting-for-turns`: it is gone, and the Host opens
   * again once its running turns end.
   */
  coexistence?: { state: CoexistenceState['state'] | 'waiting-for-turns'; desktops: number[] };
  /**
   * Why the last start failed or was refused (start-failure.ts), the code the windows are given in the auth
   * state and the 409 of an owner request; never the text of `detail`. Null for an ordinary signed-out start,
   * and cleared once a runtime opens, the account signs out or a sign-in completes; a disposal does not clear it.
   */
  unavailable?: HostStartFailureReason | null;
}

const runtime: RuntimeState = { state: 'uninitialized', owner: null, storage: 'unopened' };
// Row 25 (25a): read-only diagnostic of the Skill projection owner boundary, read per call.
const observeSkillProjectionBoundary = createSkillProjectionBoundaryObserver(createLogger('host-skill-projection'));
// Row 25 (25b): the desktop's shared global Skill preparation, skipped while a desktop holds the profile.
const sharedGlobalSkills = createHostSharedGlobalSkills({
  isProfileHeld: () => inputQueue.isHeldForDesktop(),
  bundledSystemSkillsRoot: () => hostRuntimeLayout().systemSkillsDir,
});

/**
 * The engine binary of each harness, chosen once when an owner runtime starts with the desktop's rules
 * (agent/harness-binary.ts): Pi's explicit selection, then the bundled or dev checkout binary, then the
 * profile install that reports the highest version. The harness status reports the same choice.
 */
const harnessBinaries = createHostHarnessBinaries({
  userDataDir: () => resolveHostDataDir(),
  harnessRoot: () => hostRuntimeLayout().harnessRoot,
  onUnavailable: (kind, error) => hostLog.warn('harness binary unavailable', { kind, error }),
});

/** The refusal a new send gets while a desktop uses this profile, in the system language. */
const profileInUseMessage = () => `${HOST_PROFILE_IN_USE_BY_DESKTOP}: ${
  createMainI18n(() => [Intl.DateTimeFormat().resolvedOptions().locale]).t('logic.errors.hostProfileInUseByDesktop')}`;
/** The same, for a start that was refused: quit the desktop, then restart the Host. */
const profileInUseAtStartMessage = () => createMainI18n(() => [Intl.DateTimeFormat().resolvedOptions().locale])
  .t('logic.errors.hostProfileInUseByDesktopAtStart');
let coexistenceMonitor: CoexistenceMonitor | null = null;
let resumeGeneratedImageRecovery: () => Promise<void>;

/**
 * Rescan the profile while the runtime runs. A desktop that opens the database holds the input
 * queue (new sends refused, nothing queued starts); once it is gone, the queue opens again after the
 * running turns end, rebuilt from the database (input-queue.mjs releaseDesktopHold).
 */
function startProfileCoexistence(dataDir: string, scan: () => Promise<number[]>): void {
  coexistenceMonitor?.stop();
  const monitor = createHostProfileCoexistenceMonitor({
    scan, registryDir: path.join(dataDir, '.dev-instances'), log: hostLog,
    message: profileInUseMessage(), isCurrent: () => coexistenceMonitor === monitor,
    input: {
      isHeldForDesktop: () => inputQueue.isHeldForDesktop(),
      holdForDesktop: message => inputQueue.holdForDesktop(message),
      releaseDesktopHold: () => inputQueue.releaseDesktopHold(),
    },
    getPlugins: () => plugins, refreshPlugins: () => pluginGateway?.refresh(),
    setState: state => { runtime.coexistence = state; },
    onInputReleased() {
      // A Pi receipt retry held while the desktop used the profile runs now (agent/usage-recording.ts).
      usageRecording.onProfileReleased();
      void resumeGeneratedImageRecovery();
      hostLog.info('the desktop left this profile; sends are accepted again');
    },
  });
  coexistenceMonitor = monitor;
  runtime.coexistence = { state: 'clear', desktops: [] };
  monitor.start();
}

/**
 * The Desktop's `AuthState.user` projection, resolved from the same adopted
 * session so the browser identifies the account exactly like the client does.
 */
/**
 * Resolve the signed-in account profile through the adopted Desktop session.
 *
 * The auth-server `me` document is a membership, not a user row, so this maps it
 * exactly like the Desktop's `mapMembershipToAuthUser` does. Only the display
 * projection is kept; the access token never leaves this function, and the
 * refresh token is written back through the shared safeStorage record both
 * clients read (same path, same rotation semantics as the Desktop).
 */
async function resolveAccountUser(expectedOwner: string | null = runtime.owner): Promise<AccountUser | null> {
  const realm = (account.realm ?? resolveHostRegion()) as 'cn' | 'global';
  const endpoints = readAuthEndpoints(realm);
  const store = await createCredentialStore({
    userDataDir: resolveHostDataDir(),
    keyringApplication: process.env.CINDY_HOST_KEYRING_APPLICATION?.trim() || undefined,
  });
  const { machineIdSync } = createRequire(import.meta.url)('node-machine-id');
  const verifiedDeviceId = resolveSessionDevice(store.read(AUTH_SESSION_KEY), () => resolveRuntimeDeviceId(machineIdSync, ''));
  const client = new CindyAuthClient({
    baseUrl: endpoints.authApiBaseUrl,
    region: realm,
    deviceId: verifiedDeviceId,
    clientType: 'desktop',
    fetch: (input, init) => hostAuthFetch(input, init),
  });
  const { sessionToken } = await refreshHostSession({
    store,
    refresh: (token) => client.refresh(token),
    withVaultLock: hostAccountVaultLock(resolveHostDataDir()),
    buildRegion: hostPackageRegion(),
  });
  const me = await client.getMe(sessionToken);
  const membership = me?.membership;
  if (!membership || typeof membership.id !== 'string' || !membership.id) return null;
  // H-2, as the Desktop's cold start and runtime refresh: a rotated token stays in the record of its
  // own region, but a personal session of another region is never adopted (treated as signed out).
  try {
    assertHostSessionRegion({ packageRegion: hostPackageRegion(), sessionRealm: realm, membershipKind: membership.kind });
  } catch (error) {
    // As the Desktop's resetActiveAuthRealmToBuild: the refused realm is not kept as the account's.
    account = { authenticated: false, realm: null };
    throw error;
  }
  if (expectedOwner && expectedOwner !== membership.id) throw new HostAccountMismatchError();
  currentSessionToken = sessionToken;
  if (process.platform==='linux' && endpoints.modelAccessApiBaseUrl) {
    const base=endpoints.modelAccessApiBaseUrl;
    confirmCloudGuestWhenOnline(() => base, () => currentSessionToken, hostAuthFetch);
  }
  currentDeviceId = verifiedDeviceId;
  remoteIdentityReady = canRegisterHostDevice(store.read(AUTH_SESSION_KEY), () => resolveRuntimeDeviceId(machineIdSync, ''));
  return { ...mapMembershipToAuthUser(membership, me.passportId), orgSlug: decodeAccessTokenOrgSlug(sessionToken) };
}

/** Real account profile from the adopted session; null until it resolves. */
let accountUser: AccountUser | null = null;
let currentSessionToken: string | null = null;
let remoteIdentityReady = false;
let currentDeviceId: string | null = null;
let deviceLink: ReturnType<typeof createHostDeviceLink> | null = null;
let activeOwner: string | null = null;
let closeStorage: (() => Promise<void>) | null = null;
let sessionStorage: OwnerSessionStorage | null = null;
let runtimeLease: HostRuntimeLease | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

let authClosed = false;
let authRefreshFlight: Promise<boolean> | null = null;
/** Advanced when the session ends or the runtime is disposed: a later timer or result of the old one does nothing. */
let authRefreshEpoch = 0;
const authRefreshBackoff = new AuthRefreshBackoff();
/**
 * The one renewal of the account session (auth/refresh.mjs). Its callers: the renewal timer
 * (scheduleAuthRefresh), the server API's 401 retry, Device Link's auth failure, the first startup,
 * /api/auth/refresh. As the desktop's refresh(): one at a time, a caller during a retry's wait gets
 * false instead of a request, and the server API's 401 after a network failure may bring the retry
 * forward (`serverRejectedToken`, AuthRefreshBackoff). Not refused while a desktop holds the profile
 * (the exception C); /api/auth/refresh is in the service gate's list of paths allowed then.
 */
async function refreshAuthSession(options?: { serverRejectedToken?: boolean }): Promise<boolean> {
  if (authClosed) return false;
  const epoch = authRefreshEpoch;
  if (options?.serverRejectedToken && authRefreshBackoff.serverRejectedToken(epoch))
    armAuthRefreshTimer(epoch, authRefreshBackoff.runtimeRemaining(epoch));
  if (authRefreshFlight) return authRefreshFlight;
  if (authRefreshBackoff.runtimeRemaining(epoch) > 0) return false;
  clearAuthRefreshTimer();
  authRefreshBackoff.startRuntimeAttempt(epoch);
  authRefreshFlight = performAuthRefresh().finally(() => { authRefreshFlight = null; });
  return authRefreshFlight;
}
function clearAuthRefreshTimer(): void {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
}
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** An access token already due when it arrives (a skewed clock) renews after this, not in a loop. */
const DUE_ACCESS_TOKEN_RENEWAL_DELAY_MS = 60_000;
/**
 * The desktop's scheduleRefresh: renew at the access token's exp minus 300 s (authTokenClaims.ts
 * accessTokenRefreshDelayMs; the token lives about 60 minutes, inferred, not verified on the
 * server). A token that is not a JWT with an exp schedules nothing, as on the desktop.
 */
function scheduleAuthRefresh(epoch = authRefreshEpoch): void {
  if (authClosed || epoch !== authRefreshEpoch) return;
  authRefreshBackoff.clear();
  clearAuthRefreshTimer();
  if (!currentSessionToken) return;
  let delay: number;
  try { delay = accessTokenRefreshDelayMs(currentSessionToken, Date.now()); } catch { return; }
  if (!Number.isFinite(delay)) return;
  armAuthRefreshTimer(epoch, delay > 0 ? delay : DUE_ACCESS_TOKEN_RENEWAL_DELAY_MS);
}
/** The desktop's scheduleRefreshRetryAfterTransientFailure: retry with its jittered backoff. */
function deferAuthRefresh(epoch: number, error: unknown): void {
  if (authClosed || epoch !== authRefreshEpoch) return;
  const deferred = error instanceof HostRefreshDeferredError ? error : null;
  const delay = authRefreshBackoff.defer(epoch, deferred?.retryAt, deferred?.networkFailure ?? false);
  armAuthRefreshTimer(epoch, delay);
}
function armAuthRefreshTimer(epoch: number, delay: number): void {
  clearAuthRefreshTimer();
  const due = Date.now() + delay;
  const fire = () => {
    refreshTimer = null;
    if (authClosed || epoch !== authRefreshEpoch) return;
    // A long wait is armed in chunks the timer can hold, without moving its deadline.
    const remaining = Math.max(due - Date.now(), authRefreshBackoff.runtimeRemaining(epoch));
    if (remaining > 0) { refreshTimer = setTimeout(fire, Math.min(remaining, MAX_TIMER_DELAY_MS)); refreshTimer.unref(); return; }
    void refreshAuthSession();
  };
  refreshTimer = setTimeout(fire, Math.min(delay, MAX_TIMER_DELAY_MS));
  refreshTimer.unref();
}
async function performAuthRefresh(): Promise<boolean> {
  const epoch = authRefreshEpoch;
  try {
    const user = await resolveAccountUser();
    if (user) {
      accountUser = user;
      account = { authenticated: true, realm: account.realm ?? resolveHostRegion() };
      eventHub.publish({ type: 'auth_changed', ...projectAuthState() });
      scheduleAuthRefresh(epoch);
      return true;
    }
    deferAuthRefresh(epoch, null);
    return false;
  } catch (error) {
    // Only a definitive rejection of the token still stored, or a stored session that is gone, ends
    // the session (in this process; no stored credential is deleted). Anything else renews again later.
    if (isDefinitiveRefreshError(error) || error instanceof HostSessionMissingError || error instanceof HostCrossRegionPersonalAccountError) {
      // Refresh may belong to an admitted HTTP request. Raise the boundary now,
      // but let that request unwind before waiting for the HTTP drain.
      void invalidateHostSession('account-unavailable').catch(error => {
        console.warn('[host] expired-account cleanup failed:', error instanceof Error ? error.message : 'cleanup failed');
      });
    } else deferAuthRefresh(epoch, error);
    console.warn('[host] auth refresh failed:', error instanceof Error ? error.message : String(error));
    return false;
  }
}

let invalidation: Promise<void> | null = null;
function invalidateHostSession(_reason: string): Promise<void> {
  if (invalidation) return invalidation;
  let release = () => {};
  // The owner boundary's stop first (agent/owner-boundary.ts), then this path's teardown. Everything before
  // the first await below runs before this returns: the boundary is raised synchronously, as before.
  invalidation = runOwnerBoundary(ownerBoundary, {
    beforeDispose: async () => {
      release = beginAppSessionBoundary();
      account = { authenticated: false, realm: account.realm, error: 'Sign in again with cindy-host login' };
      endAuthRefreshes();
      currentSessionToken = null;
      remoteIdentityReady = false;
      // A refresh that called this belongs to an admitted request: let it unwind before the drain.
      await Promise.resolve();
      const requestsDrained = server.pauseOwnerRequests();
      // Cancel user waits before draining HTTP handlers. A pending confirmation
      // must not keep expired-account requests (and their database) alive forever.
      fileConfirmation.cleanupAll('session_closed');
      plugins?.authorization.bridge.cleanupAll('session_closed');
      stopPluginAuthorization?.(); stopPluginAuthorization = null;
      plugins?.authorization.cancelPending();
      interactionBroker.dispose();
      await pluginGateway?.host.reset();
      await requestsDrained;
    },
    dispose: disposeOwnerRuntime,
  }).then(({ errors }) => { if (errors.length) throw errors[0]; }).finally(() => {
    commitVolatileAppSession('signed-out', null, true);
    release();
    runtime.state = 'uninitialized'; runtime.owner = null; runtime.storage = 'unopened';
    runtime.detail = 'Sign-in expired. Stop the Host, sign in again, then start it.';
    eventHub.clear();
  }).finally(() => { invalidation = null; });
  return invalidation;
}
const serverApi = createHostServerApi({
  token: () => currentSessionToken, refresh: refreshAuthSession,
  invalidate: invalidateHostSession, locale: () => Intl.DateTimeFormat().resolvedOptions().locale,
});

/** No renewal of the ended session or disposed runtime runs or is armed again. */
function endAuthRefreshes(): void {
  authRefreshEpoch += 1;
  clearAuthRefreshTimer();
  authRefreshBackoff.clear();
}
/** Claude subscription state read once per boot; never on the health path. */
let claudeState: Record<string, unknown> | null = null;
/** Real maker-core agents registered in this process. */
let agentGraph: ReturnType<typeof createHostAgentGraph> | null = null;
let taskRuntimePlugins: ReturnType<typeof createHostTaskRuntimePlugins> | null = null;
/** The maker's session-closed subscription of the current agent graph (runtime-selection.ts). */
let offMakerSessionClosed: (() => void) | null = null;
/** The desktop Git snapshot coordinator for this owner's tasks (agent/git-snapshot.ts). */
let gitSnapshot: HostGitSnapshot | null = null;
const hostLog = createLogger('host');
let providerConfig: ReturnType<typeof createHostProviderConfig> | null = null;
let codexRuntime: ReturnType<typeof createHostCodexRuntime> | null = null;
let claudeProxy: ReturnType<typeof createHostClaudeProxyRuntime> | null = null;
let mcpRuntime: ReturnType<typeof createHostMcpRuntime> | null = null;
let agentAuth: ReturnType<typeof createHostAgentAuth> | null = null;
/** The XD gateway prices and reference prices of this process's account (release table row 13, 3a). */
const usagePricing = createHostUsagePricing({
  profileDir,
  modelAccessApiBaseUrl: () => readAuthEndpoints((account.realm ?? resolveHostRegion()) as 'cn' | 'global').modelAccessApiBaseUrl,
});
/**
 * The desktop's turn usage recorders over this process's owner database (release table row 13, 3d;
 * agent/usage-recording.ts). Reads only in-memory credentials: the gateway key and the Codex proxy mode.
 */
const usageRecording = createHostUsageRecording({
  pricing: usagePricing,
  isOpenAiSubscriptionProviderId: id => providerConfig?.codexAccounts.isOpenAiSubscriptionProviderId(id) ?? false,
  readGatewayKey: () => currentGateway()?.credential ?? null,
  codexProxyAuthInjection: () => codexRuntime?.proxy.getCodexProxyAuthInjection() ?? 'env-key',
  isProfileHeld: () => inputQueue.isHeldForDesktop(),
});
const listProviders = createProviderCatalog({
  readProviders: connected => providerConfig?.publicViews(connected) ?? Promise.resolve([]),
  // Keep each engine's model list in step with the account's models (the desktop refreshes on catalog change).
  applyModels: (models: Parameters<typeof setXdGatewayModels>[0], options: Parameters<typeof setXdGatewayModels>[1]) => {
    setXdGatewayModels(models, options);
    agentGraph?.refreshModels();
  },
  markModelsUnknown: () => markXdGatewayModelAccessUnknown(),
  // The XD snapshot in this process's active-catalog module (one module instance for every Host
  // import of maker-host/active-catalog): setXdGatewayModels above writes it, and the subagent
  // model access, the Codex proxy and the one-shot model candidates read it. A failed refresh keeps
  // this current list, as the desktop's runModelsSync does with getXdGatewayModels().
  readModels: () => getXdGatewayModels(),
  fetchModels: async () => {
    const baseUrl = readAuthEndpoints((account.realm ?? resolveHostRegion()) as 'cn' | 'global').modelAccessApiBaseUrl;
    if (!baseUrl) throw new Error('Model access endpoint is unavailable');
    const request = buildModelsSyncRequest(baseUrl);
    const payload = await withModelsSyncOverallDeadline(serverApi(request.path, { ...request.options, redactErrorDetails: true }));
    const parsed = parseModelsSyncPayload(payload);
    if (!parsed.ok) throw new Error('HOST_MODEL_ACCESS_INVALID_RESPONSE');
    return parsed.models;
  },
  readOwner: () => ({ ...getActiveAppSession(), pending: isAppSessionBoundaryPending() }),
  // The desktop's applyGatewayModels replaces the XD prices from the same /models response, and its
  // model sync registers each round so billing waits briefly for it (model-access/index.ts).
  applyPricedModels: (models, ownerId) => { usagePricing.replaceGatewayModelPricing(models, ownerId); },
  trackModelsSync: sync => usagePricing.trackGatewayModelPricingSync(sync),
  // Coexistence plan A: no /models round while a desktop uses this profile (agent/providers.mjs).
  isProfileHeld: () => inputQueue.isHeldForDesktop(),
});
let stopPluginAuthorization: (() => void) | null = null;
let platformClient: ReturnType<typeof createPlatformClientBridge> | null = null;
let platformTools: ReturnType<typeof createHostPlatformTools> | null = null;
let plugins: Awaited<ReturnType<typeof createHostPluginRuntime>> | null = null;
let pluginGateway: ReturnType<typeof createHostPluginGateway> | null = null;
let pluginManager: ReturnType<typeof createHostGhostManager> | null = null;
let hostTools: ReturnType<typeof createHostToolService> | null = null;
let hostConfirmations: ReturnType<typeof createHostConfirmations> | null = null;
let availabilityPolicy: ReturnType<typeof createAvailabilityPolicy> | null = null;
let modelAccess: ReturnType<typeof createHostModelAccess> | null = null;
const currentGateway = () => modelAccess?.gateway.credential && modelAccess.gateway.endpoint ? modelAccess.gateway : null;
/** Owner-scoped Maker Memory; null until the runtime owns an account. */
let makerMemory: ReturnType<typeof createHostMemoryManager> | null = null;
/** Non-secret projection of the adopted Desktop login; never tokens. */
let account: { authenticated: boolean; realm: string | null; error?: string } = { authenticated: false, realm: null };

/**
 * Initialize storage only after verifying the signed-in membership. An explicit
 * owner selects a profile; it is never evidence of a successful login.
 */
async function ensureRuntime(ownerId: string): Promise<void> {
  if (activeOwner !== null) {
    if (activeOwner === ownerId) return;
    throw new Error('owner switch is not supported while the host is running');
  }
  const dataDir = resolveHostDataDir();
  const lease = acquireHostRuntimeLease(dataDir, ownerId);
  if (!lease.held) {
    runtime.state = 'blocked';
    runtime.owner = ownerId;
    runtime.storage = 'unopened';
    runtime.detail = `runtime lease unavailable (${lease.reason}): another cindy-host owns this profile`;
    throw new OwnerDatabaseError('DB_SCHEMA_LOCKED', runtime.detail);
  }
  runtimeLease = lease;

  // Coexistence plan A: the runtime lease only stops a second Host. A desktop that opens this
  // profile's database refuses the start: the lease is released and the Host stays blocked until it
  // is restarted (no automatic retry). A scan that cannot read the registry refuses as well.
  const scanProfile = createDesktopScanner(dataDir);
  let desktops: number[];
  try {
    desktops = await scanProfile((round, elapsedMs, result) => {
      if (round > 1 || result === 'unknown' || result === 'deadline') {
        hostLog.info('startup desktop identity check', { round, elapsedMs, result });
      }
    });
  }
  catch (error) {
    runtimeLease = null; lease.release();
    runtime.state = 'blocked'; runtime.owner = ownerId; runtime.storage = 'unopened';
    runtime.coexistence = { state: 'desktop-running', desktops: [] };
    // The error code only: the message would carry the profile path into the status.
    runtime.detail = `cannot tell whether a Cindy desktop app uses this profile (${(error as NodeJS.ErrnoException)?.code ?? 'unreadable'}); quit it and start cindy-host again`;
    throw new HostProfileInUseError(runtime.detail);
  }
  if (desktops.length) {
    runtimeLease = null; lease.release();
    runtime.state = 'blocked'; runtime.owner = ownerId; runtime.storage = 'unopened';
    runtime.coexistence = { state: 'desktop-running', desktops };
    runtime.detail = `a Cindy desktop app (pid ${desktops.join(', ')}) is running on this profile; quit it and start cindy-host again`;
    throw new HostProfileInUseError(runtime.detail);
  }

  // Verify the credential owner under the profile lease, before opening any
  // database or constructing an agent. Refresh errors here must not be swallowed
  // by the periodic refresh path: an account B login cannot run on A's data.
  if (!currentSessionToken) {
    const state = await readAdoptedSessionState({
      userDataDir: dataDir,
      keyringApplication: process.env.CINDY_HOST_KEYRING_APPLICATION?.trim() || undefined,
    });
    account = { authenticated: false, realm: state.realm };
    if (!state.authenticated) throw new HostSignInRequiredError();
    if (state.authenticated) {
      const user = await resolveAccountUser(ownerId);
      if (!user) throw new Error('Unable to verify the signed-in Host account');
      accountUser = user;
      account = { authenticated: true, realm: state.realm };
    }
  }

  configureHostOwner({ userDataDir: dataDir, ownerId });
  // Option A: the window commits the owner, the Host only reads it (logs when it is not stable).
  observeSkillProjectionBoundary(ownerId);
  const opened = await openOwnerDatabase({
    userDataDir: dataDir,
    ownerId,
    // This remains an experimental writer: keep Desktop's development guard
    // against migrating a formal profile, including in a standalone artifact.
    isPackaged: false,
    drizzleDir: process.env.CINDY_HOST_DRIZZLE_DIR?.trim() || layout.drizzleDir,
    sqliteVecExtPath: process.env.CINDY_HOST_SQLITE_VEC_PATH?.trim()
      || layout.sqliteVecPath,
  });
  const client = createDbClientForHandle({
    db: opened.db,
    drizzle: opened.drizzle,
    dispose: async () => { opened.db.close(); },
  });
  sessionStorage = new OwnerSessionStorage({ db: () => client });
  // Shared readers (history, tags) resolve the owner client from this singleton;
  // installing it here keeps them on the same connection as the host runtime.
  setCurrentDbClient(client, ownerId);
  activeOwner = ownerId;
  await reconcileDeletedTaskViewState(client, () => activeOwner === ownerId);
  closeStorage = async () => {
    clearCurrentDbClient(client);
    await waitForRetainedDbClient(client);
    await client.dispose();
  };
  configureProvisionalSessions(dataDir, { onSwept: sessionId => eventHub.publish({ type: 'session_changed', action: 'delete', sessionId }) });
  await sweepLeftoverProvisionalSessions();
  // As the desktop at startup (bootstrap-electron.ts): Cindy-owned Skill activation and the home-level
  // projections, through the stable-owner boundary. Not awaited: the core logs failures, and every launch
  // and Skill list runs it again before it needs the result, so startup does not wait on its locks.
  void sharedGlobalSkills.ensureSharedGlobalSkills();
  // Desktop runs this repair once the account DB is ready (bootstrap-electron.ts):
  // savepoint refs of tasks this DB marks deleted are removed from their repos.
  void reconcileSavepointRefsForDeletedSessions().catch(error =>
    hostLog.warn('savepoint reconcile postponed', { error: error instanceof Error ? error.message : String(error) }));
  // As the desktop once the account DB is ready (localDb/ipc/registerAll.ts): generated images' cleanup
  // receipts resume (agent/generated-images.ts binds the recovery).
  void reconcileGeneratedImageRecovery().catch(() => hostLog.warn('native image cleanup reconciliation deferred'));
  // As the desktop once the account DB is ready (bootstrap-electron.ts): the account currency and the
  // last price snapshot come back from disk before the first /models round.
  // Usage recording resumes for this owner database; then, as the desktop (bootstrap-electron.ts :10384),
  // pending Pi receipts are priced once the prices are back.
  usageRecording.open();
  void usagePricing.prewarmModelPricing().then(() => usageRecording.retryPending()).catch(error =>
    hostLog.warn('model pricing prewarm failed', { error: error instanceof Error ? error.message : String(error) }));
  runtime.owner = ownerId;
  runtime.storage = 'ready';
  delete runtime.detail;

  const pluginOwner = activeOwnerScopeKey();
  const credentials = await createCredentialStore({ userDataDir: dataDir,
    keyringApplication: process.env.CINDY_HOST_KEYRING_APPLICATION?.trim() || undefined });
  // The engine binaries this owner runtime uses, read once (the model settings use the same ones).
  const harnessBinaryPaths = await harnessBinaries.resolve();
  providerConfig = createHostProviderConfig({ profileDir: dataDir, ownerId, credentials,
    // Coexistence plan A: the xAI login is neither renewed nor signed out while held (agent/xai-held-login.ts).
    isProfileHeld: () => inputQueue.isHeldForDesktop(),
    gatewayConnected: () => Boolean(currentGateway()),
    getCodexBinary: () => harnessBinaryPaths.codex,
    getClaudeBinary: () => harnessBinaryPaths['claude-code'],
    publish: (channel, payload) => eventHub.publish({ type: 'plugin_push', channel, payload }),
    openExternal: async url => { await openSystemBrowser(url); } });
  await providerConfig.loadCatalog({
    baseUrl: readAuthEndpoints((account.realm ?? resolveHostRegion()) as 'cn' | 'global').modelAccessApiBaseUrl,
    url: process.env.XDT_MODELS_URL, localPath: process.env.XDT_MODELS_PATH,
    disableFetch: process.env.XDT_DISABLE_MODELS_FETCH === '1',
  });
  availabilityPolicy = createAvailabilityPolicy(disableShareAvailability);
  const providerSecrets = providerConfig.builtinStore;
  modelAccess = createHostModelAccess({ ownerId, region: (account.realm ?? resolveHostRegion()) as 'cn' | 'global',
    readKey: () => providerSecrets.get('xd'),
    writeKey: value => providerSecrets.set('xd', value),
    request: (route, method) => {
      const baseUrl = readAuthEndpoints((account.realm ?? resolveHostRegion()) as 'cn' | 'global').modelAccessApiBaseUrl;
      if (!baseUrl) throw new Error('Model access endpoint is unavailable');
      return serverApi(route, { baseUrl, method, redactErrorDetails: true });
    },
    publish: status => {
      eventHub.publish({ type: 'plugin_push', channel: MODEL_ACCESS_STATUS_CHANNEL, payload: status });
      // As the desktop's onStatusChange (model-access/index.ts): a failed account's prices go, and
      // come back with the next /models round after ok. Price changes are not pushed yet (row 13, 3f).
      listProviders.noteCredentialStatus(status);
    },
    onKeyChanged: () => agentGraph?.gatewayRestart.schedule(),
  });
  await modelAccess.start();
  pluginManager = createHostGhostManager({ userDataDir: dataDir, ownerId,
    onUninstallSourceState: async fromPart => {
      const current = plugins;
      if (!current || activeOwnerScopeKey() !== pluginOwner) throw new Error('Plugin account cleanup is unavailable');
      await current.cleanupUninstalledSource(fromPart);
    },
    onChanged: ghosts => {
      if (activeOwnerScopeKey() !== pluginOwner || isAppSessionBoundaryPending()) return;
      if (inputQueue.isHeldForDesktop() || plugins?.pluginPauseFailure()) return;
      eventHub.publish({ type: 'plugin_push', channel: 'ghosts:changed', payload: { ghosts } });
      void plugins?.reconcile().then(() => pluginGateway?.refresh())
        .catch(error => console.warn('[host] plugin reconciliation failed:', error.message));
    },
  });
  const toolOwnerCurrent = () => activeOwnerScopeKey() === pluginOwner && !isAppSessionBoundaryPending();
  const i18n = createMainI18n(() => [Intl.DateTimeFormat().resolvedOptions().locale]);
  const confirmations = createHostConfirmations({ current: toolOwnerCurrent });
  hostConfirmations = confirmations;
  hostTools = profileServices.tools({ profileDir: dataDir, ownerId,
    deviceId: () => currentDeviceId ?? 'local',
    onProjectsChanged: catalogChanged => eventHub.publish({ type: 'project_aliases_changed', catalogChanged }),
    owner: () => ({ dataOwnerId: getActiveAppSession().dataOwnerId, ownerGeneration: getActiveAppSession().generation }),
    current: toolOwnerCurrent, getGhost: id => plugins?.getGhost(id) ?? null,
    files: () => { if (!plugins) throw new Error('UNSUPPORTED_CAPABILITY'); return plugins.fsSlot; },
    storage: () => { if (!plugins) throw new Error('UNSUPPORTED_CAPABILITY'); return plugins.storage; },
    getSession: id => agentGraph?.maker.getSession(id), confirmations: hostConfirmations, t: i18n.t,
    taskActions: {
      input: id => inputQueue.taskActionInput(id),
    },
  });
  plugins = await createHostPluginRuntime({ profileDir: dataDir, ownerId, manager: pluginManager, credentials,
    modelRouteSources: () => ({
      localViews: () => providerConfig?.publicViews(Boolean(currentGateway()?.credential)) ?? Promise.resolve([]),
      localAgents: () => agentGraph?.maker.listAvailableAgents() ?? [],
    }),
    // Coexistence plan A: plugin OAuth renews and writes nothing while held (plugins/authorization.ts).
    isProfileHeld: () => inputQueue.isHeldForDesktop(),
    hostToolRequest: hostTools.request, onPluginStopped: hostTools.stopPlugin,
    getLoginEmail: () => accountUser?.email ?? null,
    getUser: () => accountUser,
    account: {
      hasLogin: () => Boolean(currentSessionToken && account.authenticated),
      endpoint: service => {
        const value = readAuthEndpoints((account.realm ?? resolveHostRegion()) as 'cn' | 'global')[service];
        if (!value) throw new Error('Plugin authorization service endpoint is unavailable');
        return value;
      },
      post: (service, route, body) => serverApi(route, {
        method: 'POST', body, timeoutMs: 15_000, redactErrorDetails: true,
        allowedRedactedErrorCodes: ['FEISHU_OAUTH_FAILED', 'JIRA_OAUTH_FAILED'],
        baseUrl: () => {
          const value = readAuthEndpoints((account.realm ?? resolveHostRegion()) as 'cn' | 'global')[service];
          if (!value) throw new Error('Plugin authorization service endpoint is unavailable');
          return value;
        },
      }),
      openExternal: async url => { await openSystemBrowser(url); },
    },
    getSession: id => agentGraph?.maker.getSession(id),
    // A new connection host widens the plugin's network allowlist, so the user
    // must approve it in the host's own dialog (same wording as Desktop).
    confirmConnectionHost: (id, label, host) => {
      const ghost = plugins?.getGhost(id);
      if (!ghost) return Promise.resolve(false);
      const name = ghost.manifest.name;
      return confirmations.confirm({
        ghostId: id, ghostName: name, ...(ghost.iconDataUrl ? { iconDataUrl: ghost.iconDataUrl } : {}),
        body: `${i18n.t('settings.ghosts.connections.confirmMessage').replaceAll('{{name}}', name).replaceAll('{{host}}', host)}\n\n`
          + i18n.t('settings.ghosts.connections.confirmDetail').replaceAll('{{label}}', label),
        confirmText: i18n.t('settings.ghosts.connections.confirmAllow'),
        cancelText: i18n.t('settings.ghosts.connections.confirmCancel'),
        danger: false,
      });
    },
    requestFileConfirmation: (id, payload) => fileConfirmation.request(id, payload),
    appContext: () => ({ ok: true, context: { region: resolveHostRegion(),
      locale: ghostAppContextLocale(Intl.DateTimeFormat().resolvedOptions().locale) } }),
    publish: (channel, payload) => {
      if (channel === MAKER_PUSH.INTERACTION_REQUEST || channel === MAKER_PUSH.INTERACTION_DISMISSED) {
        eventHub.publish({ ...(payload as Record<string, unknown>),
          type: channel === MAKER_PUSH.INTERACTION_REQUEST ? 'interaction_request' : 'interaction_dismissed' });
      } else eventHub.publish({ type: 'plugin_push', channel, payload });
    },
  });
  const held = inputQueue.profileHoldReason();
  if (held) plugins.pauseForDesktop(held);

  if (!plugins.pluginPauseFailure() && pluginManager.hasPendingMutationRecovery()) await pluginManager.retryInterruptedMutationsAfterDbReady();

  pluginGateway = createHostPluginGateway({ runtime: plugins, profileDir: dataDir, ownerId,
    version: layout.version, credentials, fileConfirmation,
    getSession: id => agentGraph?.maker.getSession(id),
    // Under the task's send lock, as the desktop's plugin page restore (register.ts).
    restoreSession: lockSessionRoute((id: string, check: () => Promise<void>) => inputQueue.restoreSession(id, check)),
    requestHostPermission: async (id, instance, request, signal) => {
      const session = agentGraph?.maker.getSession(id);
      if (!session || session.instanceId !== instance) return null;
      return interactionBroker.requestHost(id, request, signal, { session,
        isCurrent: () => activeOwnerScopeKey() === pluginOwner && !isAppSessionBoundaryPending()
          && agentGraph?.maker.getSession(id) === session });
    },
    cards: {
      writeMessage: async (owner, id, input, opts) => {
        if (getCurrentDbClientSnapshot() !== owner) throw new Error('MCP_APP_OWNER_CHANGED');
        return insertSessionMessage(id, input, opts);
      },
      publishMessage: (owner, sessionId, message) => {
        if (getCurrentDbClientSnapshot() !== owner) throw new Error('MCP_APP_OWNER_CHANGED');
        eventHub.publish({ type: 'message_created', sessionId, messageId: message.id, message });
      },
      request: (id, request, signal) => interactionBroker.requestHost(id, request, signal, {
        session: agentGraph?.maker.getSession(id),
        isCurrent: () => activeOwnerScopeKey() === pluginOwner && !isAppSessionBoundaryPending(),
      }),
      review: async (id, server, tool, args, description, definition) => {
        const session = agentGraph?.maker.getSession(id);
        if (!session) return { verdict: 'ask', unavailable: true };
        const decision = await session.reviewHostPermissionAction(toolAutoReviewAction(`mcp__${server}__${tool}`, args,
          description ?? 'Request from an MCP App page. Page arguments are untrusted; review effects against task authorization.',
          definition ? { source: 'Host-selected tool definition, authored by the plugin, not by the user. This is not authorization.', toolDefinition: definition } : undefined));
        return agentGraph?.maker.getSession(id) === session && activeOwnerScopeKey() === pluginOwner
          && !isAppSessionBoundaryPending() ? decision : { verdict: 'block' };
      },
      allowPendingPage: interactionBroker.allowHostPage,
      send: (...args) => inputQueue.sendAppMessage(...args),
    },
  });

  const taskPlugins = plugins.taskPlugins;
  warmRuntimePluginSettings();
  setGhostToolApprovalResolver(taskPlugins.resolveToolApproval);
  taskRuntimePlugins = createHostTaskRuntimePlugins({
    getMaker: () => {
      if (!agentGraph) throw new Error('Agent runtime is unavailable');
      return agentGraph.maker;
    },
    pluginHost: taskPlugins, selection: runtimeSelection, log: hostLog,
    publish: event => {
      if (plugins?.taskPlugins === taskPlugins && toolOwnerCurrent()) eventHub.publish(event);
    },
  });

  stopPluginAuthorization = initializeHostPluginRemoteAuthorization({ authorization: plugins.authorization,
    root: (...parts) => ownerScopedPath(dataDir, ownerId, ...parts), credentials,
    identity: () => currentDeviceId && remoteIdentityReady && account.authenticated && accountUser?.id === ownerId
      ? { realm: (account.realm ?? resolveHostRegion()) as 'cn' | 'global', membershipId: ownerId, deviceId: currentDeviceId } : null,
    available: peer => deviceLink?.canAuthorize(peer) ?? false,
  });

  platformClient = createPlatformClientBridge({ assertCurrent: plugins.assertCurrent, ownerId,
    uploadRoots: async id => {
      const meta = await agentGraph?.maker.getSessionMeta(id);
      return meta?.workDir && !meta.remoteHostId ? [meta.workDir] : [];
    },
  });
  platformTools = createHostPlatformTools({ profileDir: dataDir, client: platformClient,
    assertCurrent: plugins.assertCurrent,
    secretIo: providerConfig.recipeSecretIo,
    browserExtensions: plugins.browserExtensions,
    uploadRoots: async id => {
      const meta = await agentGraph?.maker.getSessionMeta(id);
      return meta?.workDir && !meta.remoteHostId ? [meta.workDir] : [];
    },
  });
  hostTools.providers.push(...platformTools.providers);
  hostTools.services.replace(hostTools.providers);

  const claudeBinary = harnessBinaryPaths['claude-code'];
  const codexBinary = harnessBinaryPaths.codex;
  const piBinary = harnessBinaryPaths.pi;
  if (claudeBinary || codexBinary || piBinary) {
    const gateway = modelAccess!.gateway;
    // Memory uses the same owner-scoped store Desktop reads, so a task started
    // here sees the same memories as a task started there.
    let memoryReview: ReturnType<ReturnType<typeof createHostAgentGraph>['autoReview']['memoryReview']> | undefined;
    const memory = profileServices.memory({ userDataDir: dataDir, ownerId, review: {
      isOneShotRouteDisabled: agent => memoryReview?.isOneShotRouteDisabled(agent) ?? Promise.resolve(true),
      reviewOneShot: (...args) => memoryReview?.reviewOneShot(...args) ?? Promise.resolve(null),
    } });
    makerMemory = memory.manager;
    // Flip the flag before the agents are built: their runtimeConfig snapshots it
    // at construction, and native-agent syncoff needs the agents that do not exist yet.
    if (makerMemory.isEnabled()) await makerMemory.enable({ skipAgentSync: true });
    mcpRuntime = createHostMcpRuntime({ appServerIds: pluginGateway.appServerIds,
      getRemoteMcpBridgeToken: providerConfig.remoteBridgeToken });
    if (codexBinary) codexRuntime = createHostCodexRuntime({ profileDir: dataDir, binaryPath: codexBinary,
      config: providerConfig, modelAccess: modelAccess!, availabilityPolicy: availabilityPolicy!, mcp: mcpRuntime,
      publish: (channel, payload) => eventHub.publish({ type: 'plugin_push', channel, payload }),
      // Coexistence plan A: the subscription bridge neither reconciles nor renews (agent/codex-runtime.ts).
      isProfileHeld: () => inputQueue.isHeldForDesktop(),
    });
    if (claudeBinary || piBinary) {
      claudeProxy = createHostClaudeProxyRuntime({ profileDir: dataDir,
        gateway: () => modelAccess?.gateway ?? null,
        fastRequestPolicy: codexRuntime?.fastRequestPolicy ?? createHostSubscriptionFastPolicies(availabilityPolicy!).requestPolicy,
        isOpenAiSubscriptionProviderId: id => providerConfig?.codexAccounts.isOpenAiSubscriptionProviderId(id) ?? false,
        subscriptions: codexRuntime?.subscriptions ?? null,
        resolveTaskId: sdkSessionId => agentGraph?.maker.listActiveSessions()
          .find(session => session.requestSessionId === sdkSessionId)?.id ?? null,
      });
      // The desktop awaits the proxy before its first task (bootstrap-electron.ts); when it
      // cannot start, the endpoint falls back to the upstream with a log, as there.
      await claudeProxy.ready();
    }
    agentGraph = createHostAgentGraph({
      onSessionClose: (id, close) => {
        if (!close.transient && (close.reason === 'requested' || close.reason === 'unexpected'))
          taskRuntimePlugins?.forgetSession(id);
        return platformTools?.closeSession(id);
      },
      toolLifecycleControl: taskPlugins.ghostToolLifecycleControl,
      codexRuntime,
      claudeProxy,
      providerConfig,
      mcpRuntime,
      isSessionInTurn: (id: string) => inputQueue.isTurnRunning(id),
      wakeSession: (id: string, reason: string) => inputQueue.wakeSession(id, reason),
      // Coexistence plan A: reading a login state writes nothing the desktop shares (agent/runtime.ts).
      isProfileHeld: () => inputQueue.isHeldForDesktop(),
      // A task restored at startup waits for the account's models, as on the desktop.
      ensureProviderCatalog: () => listProviders({ gateway: currentGateway(), ownerId: runtime.owner }),
      getGhostRosterPrompt: pluginGateway.rosterPrompt,
      // The MCP duplicate choices made in the window, read from the same owner file.
      resolveLocalMcpDuplicateChoices: createHostMcpDuplicateChoices(pluginGateway.customMcp).resolveLocalMcpDuplicateChoices,
      // Built-in and approved plugin Skills, as the desktop gives all three engines
      // (listCindyManagedSkills). Codex's Skill projection is release table row 25.
      getManagedSkills: pluginGateway.managedSkills,
      resolveProviderRoute: createProviderRouteResolver({
        catalog: () => listProviders({ gateway, ownerId }),
        store: await createCredentialStore({ userDataDir: dataDir }),
        ownerId,
      }),
      binaryPath: claudeBinary,
      codexBinaryPath: codexBinary ?? undefined,
      piBinaryPath: piBinary ?? undefined,
      storage: sessionStorage,
      gateway,
      makerMemory,
      reportGatewayKeyRejected: key => modelAccess?.reportRejectedKey(key),
      readAuthRealm: () => account.realm,
      sharedGlobalSkills,
      mcpProviders: await pluginGateway.prepareMcpProviders([...hostTools.providers, ...memory.providers({ readsAccountHistory: hostTools.readsAccountHistory, deviceId: () => currentDeviceId ?? '', searchProviders: taskPlugins.searchGhostRuntimeMemories }), pluginGateway.provider]),
      userDataDir: dataDir,
    });
    memoryReview = agentGraph.autoReview.memoryReview(memory.profileHold);
    // The desktop's Auto-review authorization context (review-context.ts).
    agentGraph.autoReview.setContextResolver(createHostReviewContextResolver({
      acceptedInput: (id: string) => inputQueue.acceptedInputProvenance(id),
    }));
    attachAgentsToMakerMemory(makerMemory, agentGraph.instances);
    // Every runtime close of a task, whichever path closed it (idle release, engine switch, rebuild,
    // delete, shutdown): the Maker emits it from the session's own close, as the desktop's per-session
    // status listener finalizes it (sessionBindingLifecycle.ts).
    offMakerSessionClosed = runtimeSelection.attachMaker(agentGraph.maker);
    gitSnapshot = createHostGitSnapshot(agentGraph.maker);
    agentAuth = createHostAgentAuth({ maker: agentGraph.maker, readApiKey: () => gateway?.credential ?? null,
      publish: (channel, payload) => eventHub.publish({ type: 'plugin_push', channel, payload }) });
    // Second step, now that the agents exist: turn their native memory off.
    if (makerMemory.isEnabled()) await makerMemory.enable();
    runtime.agents = [...agentGraph.agents];
    runtime.agentLane = currentGateway() ? 'gateway-key' : 'claude-subscription';
    // Idle ordinary tasks release their runtimes from here on, as on the desktop (idle-release.ts).
    inputQueue.startIdleRelease();

  }
  if (claudeBinary) {
    const ownerSession = activeOwnerScopeKey();
    void readClaudeSubscriptionState({ binary: claudeBinary, env: { PATH: process.env.PATH } })
      .then((state) => { if (activeOwnerScopeKey() === ownerSession) claudeState = state; })
      .catch((error: unknown) => {
        if (activeOwnerScopeKey() === ownerSession) claudeState = { error: error instanceof Error ? error.message : String(error) };
      });
  }
  await plugins.reconcile();
  await pluginGateway.refresh();
  startProfileCoexistence(dataDir, scanProfile);
  runtime.state = 'ready';
  runtime.unavailable = null;
}

const eventHub = createEventHub();
const taskTags = createTaskTagService({
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
  broadcastSessionPatched: (sessionId, patch, scope) => {
    if (scope && !isDataOwnerBroadcastScopeCurrent(scope)) return;
    eventHub.publish({ type: 'session_changed', sessionId, patch });
  },
  tapWindowBroadcast: (_channel, payload, ownerStamp) => {
    eventHub.publish({ type: 'task_tags_changed', payload, ownerStamp });
  },
});
const sessionDraftPorts = {
  emitSessionCreated: (sessionId: string) => eventHub.publish({ type: 'session_changed', action: 'create', sessionId }),
  emitSessionListChangedLocally: (sessionId: string) => eventHub.publish({ type: 'session_changed', action: 'delete', sessionId }),
  notifyPluginSessionCreated: (input: { sessionId: string; workdir?: string }) => eventHub.publish({ type: 'session_created', ...input }),
};
setSessionOpeningModelAdmission(async body => {
  if (body.agentKind === 'acp') throw new Error('插件引擎在无界面 Host 上不可用');
  const kind = body.agentKind === 'cc' ? 'claude-code' : body.agentKind;
  const snapshot = await listProviders({ gateway: currentGateway(), ownerId: runtime.owner });
  const execution = resolveSessionExecutionSelection({
    selection: body,
    availableAgents: agentGraph?.agents ?? [],
    availableModels: snapshot.providers.flatMap(provider => kind ? provider.models[kind] ?? [] : []),
    providerRouting: buildLocalProviderRoutingContext(snapshot.providers),
    hasCindyAiApiKey: currentGateway() !== null,
  });
  return { ...body, ...execution, effort: execution.effort ?? '',
    agentKind: execution.agentKind === 'claude-code' ? 'cc' : execution.agentKind };
});
// Read the same owner-scoped group facts as Desktop. Host does not yet have the
// assignment service, so no mutation port may report a successful group change.
const hostProviderGroups = createProviderGroupStore({
  withAvailabilityPolicyMutation: async () => { throw new Error('[UNSUPPORTED_CAPABILITY] Host cannot change provider groups'); },
});
const hostProviderBindings = createProviderGroupBindings(hostProviderGroups);
// The send path and the Device Link create entry refuse provider group tasks with this one check.
const assertProviderExecutionSupported = createHostProviderExecutionCheck({ hostProviderBindings, hostProviderGroups });
const readSessionForRun = async (sessionId: string) => {
  const db = getDbClient();
  const rows = await db.drizzle.select().from(sessionTable)
    .where(eq(sessionTable.id, sessionId)).limit(1);
  const row = rows[0];
  if (!row || row.status !== 'active') throw new Error('session is not active');
  const [botLink] = await db.drizzle.select({ botId: botSessionLinks.botId })
    .from(botSessionLinks).where(eq(botSessionLinks.sessionId, sessionId)).limit(1);
  const storedKind = requireBuiltinAgentKind(row.agentKind as EngineKind, 'Host task execution');
  const agentKind: 'claude-code' | 'codex' | 'pi' = storedKind === 'codex' ? 'codex' : storedKind === 'pi' ? 'pi' : 'claude-code';
  return {
    id: row.id,
    status: row.status, source: row.source, botId: botLink?.botId ?? null,
    remoteHostId: row.remoteHostId, agentDeviceId: row.agentDeviceId,
    orcaRole: row.orcaRole, orcaRemoteLead: row.orcaRemoteLead,
    agentKind,
    model: row.model,
    workingDir: row.workingDir,
    providerId: row.providerId,
    sdkSessionId: row.sdkSessionId,
    effort: row.effort, permissionMode: row.permissionMode,
    fastMode: row.fastMode, planModeEnabled: row.planModeEnabled,
  };
};
const interactionBroker = createInteractionBroker({ hub: eventHub });
const fileConfirmation = new GhostGrantConfirmBridge({
  broadcast: (channel, payload) => eventHub.publish({
    ...(payload as Record<string, unknown>),
    type: channel === MAKER_PUSH.INTERACTION_REQUEST ? 'interaction_request' : 'interaction_dismissed',
  }),
});
const interactions = {
  ...interactionBroker,
  pending: (sessionId: string) => [...interactionBroker.pending(sessionId),
    ...fileConfirmation.pendingSnapshots(sessionId).map(({ request }) => ({ requestId: request.requestId, request })),
    ...(plugins?.authorization.bridge.pendingSnapshots(sessionId) ?? []).map(({ request }) => ({ requestId: request.requestId, request }))],
  respond: (sessionId: string | null, requestId: string, decision: unknown) => {
    const pending = fileConfirmation.pendingSnapshots().find(item => item.request.requestId === requestId);
    if (pending) return (!sessionId || sessionId === pending.sessionId) && !isAppSessionBoundaryPending()
      && fileConfirmation.resolve(requestId, decision);
    const setup = plugins?.authorization.bridge.pendingSnapshots().find(item => item.request.requestId === requestId);
    if (setup) {
      const command = parseGhostSetupInteractionCommand(decision);
      return Boolean(command && (!sessionId || sessionId === setup.sessionId) && !isAppSessionBoundaryPending()
        && plugins?.authorization.bridge.resolve(requestId, command));
    }
    return interactionBroker.respond(sessionId, requestId, decision);
  },
  detach: (id: string, reason?: string) => {
    fileConfirmation.cleanupForSession(id, 'session_aborted');
    plugins?.authorization.bridge.cleanupForSession(id, 'session_aborted');
    interactionBroker.detach(id, reason);
  },
  cancelHostWaits: (id: string) => {
    fileConfirmation.cleanupForSession(id, 'session_aborted');
    plugins?.authorization.bridge.cleanupForSession(id, 'session_aborted');
  },
};
const insertSessionMessage = createHostMessageStore({ getOwner: getCurrentDbClientSnapshot,
  publish: (event: unknown) => eventHub.publish(event) });
// Codex generated images, stored and delivered as on the desktop (agent/generated-images.ts).
const generatedImages = createHostGeneratedImages({
  createMessage: (sessionId, body, opts) => insertSessionMessage(sessionId, body, opts),
  publish: (event: unknown) => eventHub.publish(event),
  isProfileHeld: () => inputQueue.isHeldForDesktop(),
  registerProfileRelease: resumeRecovery => { resumeGeneratedImageRecovery = resumeRecovery; },
});

const messageRecovery = createHostMessageRecovery({ getOwner: getCurrentDbClientSnapshot,
  publish: (event: unknown) => eventHub.publish(event) });

// Shared database writers that change a task's route (restoring an archived task) take the task's send
// lock through this bridge, as on the desktop (localDb/ipc/registerAll.ts installs the same lock).
setSessionRouteLockImplementation(withSendToSessionLock);
// Making an archived task active: sending to it, and the task list's restore (task-restore.ts); the
// restore is recorded for idle archiving, as the desktop's task management records it.
bindTaskRestoreRetention();
const taskRestore = createHostTaskRestore({ getOwner: getCurrentDbClientSnapshot,
  isHeldForDesktop: () => inputQueue.isHeldForDesktop(),
  publish: event => eventHub.publish(event) });

// The pending handoff summary: one registry for the Host process, as the desktop's singleton.
const pendingHandoff = createHostAgentHandoffPending({ getOwner: getCurrentDbClientSnapshot,
  publish: event => eventHub.publish(event), log: createLogger('agent-handoff-pending') });
// Context recovery of a turn's terminal error (context-recovery-assembly.ts). A kind opens after its
// real-engine test (release table); until then it takes the normal error path, unclaimed.
// - context-overflow: open (codex-runtime and claude-proxy e2e).
// - oversized-history: closed; no engine emits this error now (maker-core Codex).
// - unsupported-request-option: closed; Pi's own cache recovery handles it in the turn (pi-native e2e),
//   so this fallback has no real-engine test.
const OPEN_CONTEXT_RECOVERY_KINDS: ReadonlySet<ContextRecoveryKind> = new Set(['context-overflow']);
const contextRecovery = createHostContextRecoveryWiring({
  openKinds: OPEN_CONTEXT_RECOVERY_KINDS,
  getGraph: () => agentGraph,
  persistMessage: (...args) => insertSessionMessage(...args),
  publish: event => eventHub.publish(event),
  pendingHandoff,
  log: createLogger('context-recovery'),
  rehydrateColdPiRuntimeForWindowVerification: sessionId => runtimeSelection.rehydrateColdPiRuntimeForWindowVerification(sessionId),
});
const inputQueue = createInputQueue({
  getTaskRuntimePlugins: () => taskRuntimePlugins,
  getOwner: getCurrentDbClientSnapshot,
  // The turn usage recorders (agent/usage-recording.ts), fed by the turn executor.
  usage: usageRecording,
  // The task list's activity time when a person's turn is dispatched or steered (register.ts
  // touchSessionActivityInDb, the same write: agent/session-activity.ts).
  touchSessionActivity: createHostSessionActivity({ getOwner: getCurrentDbClientSnapshot, publish: event => eventHub.publish(event) }),
  // The runtime selection's hooks (runtime-selection.ts): a model or engine the user picked lands when
  // the message is sent; as register.ts, the coordinator holds a task's queue while a credential switch
  // waits for its turn to end or a gateway Codex restart is running (deferredRestartQueueWiring.ts), and
  // idle release only looks at the pending switch (claudeIdleReleaseWatcher's isHostBusy); at a turn's
  // end the pending credential switch, then the gateway restart; a runtime's own Plan change is saved.
  ...hostRuntimeSelectionQueueHooks(() => runtimeSelection, {
    isSessionRestarting: (id: string) => agentGraph?.gatewayRestart.isSessionRestarting(id) ?? false,
    afterTurnSettled: () => agentGraph?.gatewayRestart.onSessionSettled(),
  }),
  restoreArchivedSessionForSend: taskRestore.restoreArchivedSessionForSend,
  // Another device's task is read over Device Link, which the Host does not have: it answers as the
  // desktop does when no link is connected (the reference is reported unavailable).
  resolveSessionReferences: (refs: Parameters<typeof resolveSessionReferencesWithPorts>[1], options: Parameters<typeof resolveSessionReferencesWithPorts>[2]) =>
    resolveSessionReferencesWithPorts({
      getSelfDeviceId: () => currentDeviceId ?? '',
      invokeRemote: async () => ({ ok: false, error: { code: 'NOT_CONNECTED', message: 'Host has no Device Link' } }),
    } as Parameters<typeof resolveSessionReferencesWithPorts>[0], refs, options),
  // The profile root's claude-idle-release.json, which the desktop window reads too (read-only here).
  readClaudeIdleMinutes: () => readClaudeIdleMinutesFrom(profileDir),
  pendingHandoff,
  ...contextRecovery,
  createAttachments: ({ assertCurrent }: { assertCurrent(): void }) => createHostAttachments({
    getOwner: getCurrentDbClientSnapshot, assertCurrent,
  }),
  interactions,
  getMaker: () => {
    if (!agentGraph) throw new Error('agent runtime is not ready');
    return agentGraph.maker;
  },
  getGitSnapshot: () => gitSnapshot,
  hub: eventHub,
  reportAgentCindyGatewayKeyRejected: () => modelAccess?.reportCurrentKeyRejected(),
  readSession: readSessionForRun,
  assertProviderExecutionSupported,
  readSessionExtraDirs: readSessionExtraDirsFromDb,
  readSessionWritableDirs: readSessionWritableDirsFromDb,
  readMcpAppModelContext: async (id: string) => (await pluginGateway?.modelContext(id))
    ?? { text: '', async assertCurrent() {}, consume() {} },
  ackInterruptedTurnDispatched: ackSessionTurnEndedDurable,
  ...messageRecovery,
  persistMessage: insertSessionMessage,
  deliverCodexGeneratedImage: generatedImages.deliverCodexGeneratedImage,
  persistQueueSnapshot: saveAgentInputQueueSnapshot,
  loadQueueSnapshot: loadAgentInputQueueSnapshot,
  getPersistedClientIds: getPersistedInputClientIds,
  markStarted: markSessionTurnStartedDurable,
  markEnded: async (sessionId: string, endedAt: number) => {
    markSessionTurnEnded(sessionId, endedAt);
    await drainSessionActiveTurnWrites(sessionId);
  },
  hasAssistantProgressAfter: hasAssistantProgressAfterMessage,
  getRecoveryContextSnapshot,
  loadClearBoundary: async (sessionId: string) => {
    const [row] = await getDbClient().drizzle.select({ clearedAt: sessionTable.clearedAt })
      .from(sessionTable).where(eq(sessionTable.id, sessionId)).limit(1);
    if (!row) throw new Error('session not found');
    return row.clearedAt;
  },
  // The desktop's touchUserSendInDb, with its recent project record (touch-user-send.ts).
  touchUserSend: createHostTouchUserSend({
    getOwner: getCurrentDbClientSnapshot,
    publish: event => eventHub.publish(event),
    broadcastRecentWorkdirsChanged: createRecentWorkdirsChangedPush(event => eventHub.publish(event)),
  }),
  sent: (sessionId: string) => commitProvisionalSession(sessionId, sessionDraftPorts),
});
// The first step of every owner boundary: logout, session invalidation, shutdown (agent/owner-boundary.ts).
const ownerBoundary = createOwnerBoundaryStop({ beginStop: () => inputQueue.beginStop() });
// The history view and work details: the desktop's reader, with the turn state and the in-flight rows
// of this input queue (agent/history.ts).
const hostHistoryReader = createHostHistoryReader({
  running: id => inputQueue.isTurnRunning(id),
  live: id => inputQueue.liveHistory(id),
});

// A client's new input (the input route and /api/chat) waits for the task's permission changes first,
// as the desktop's maker:send and INPUT_ENQUEUE (agent/user-input.ts).
const enqueueUserInput = createUserInputEnqueue({
  getOwner: getCurrentDbClientSnapshot,
  enqueue: (sessionId: string, input: unknown) => inputQueue.enqueue(sessionId, input),
});

// A task's model and engine changes, with the desktop's steps (runtime-selection.ts): the shared
// pending-switch registry (one for the Host process, as the desktop's), the desktop's set-model and
// engine switch, and the send transaction's landing.
const runtimeSelection = createHostRuntimeSelection({
  getMaker: () => {
    if (!agentGraph) throw new Error('agent runtime is not ready');
    return agentGraph.maker;
  },
  getMakerIfReady: () => agentGraph?.maker ?? null,
  publish: event => eventHub.publish(event),
  createDbMessage: (sessionId, body) => insertSessionMessage(sessionId, body),
  pendingHandoff,
  listProviderViews: async () => (await listProviders({ gateway: currentGateway(), ownerId: runtime.owner })).providers,
  userDataDir: profileDir,
  resolveConfiguredContextWindow: (...args) => {
    if (!agentGraph) throw new Error('agent runtime is not ready');
    return agentGraph.modelWindow.resolveConfiguredContextWindow(...args);
  },
  readStoredSessionContextWindowBudget: sessionId => {
    if (!agentGraph) throw new Error('agent runtime is not ready');
    return agentGraph.modelWindow.readStoredSessionContextWindowBudget(sessionId);
  },
  contextWindowBudgetChangesEffectiveWindow: input => {
    if (!agentGraph) throw new Error('agent runtime is not ready');
    return agentGraph.modelWindow.contextWindowBudgetChangesEffectiveWindow(input);
  },
  // No Codex runtime (no binary): no proxy, so no injection, as the desktop's proxy host before start.
  codexProxyAuthInjectionState: () => codexRuntime?.proxy.getCodexProxyAuthInjectionState() ?? null,
  // The input queue's API is the current owner runtime's, forwarded by name (input-queue.mjs).
  inputQueue: inputQueue as unknown as Parameters<typeof createHostRuntimeSelection>[0]['inputQueue'],
  readProviderGroupBinding: sessionId => hostProviderBindings.readProviderGroupBinding(sessionId),
  readProviderGroup: providerId => hostProviderGroups.readProviderGroup(providerId),
  log: createLogger('runtime-selection'),
});
// The desktop's process-wide runtime selection slots (runtime-selection.ts), before any owner commit.
bindHostSessionRuntimeHooks(runtimeSelection);

const subagentReads = createSubagentReadService({
  getUserDataDir,
  isBoundaryPending: () => runtime.state !== 'ready',
  activeOwnerScopeKey: () => {
    const owner = getCurrentDbClientSnapshot();
    if (!owner) throw new Error('DbClient not ready');
    return `${owner.userId}:${owner.clientEpoch}`;
  },
  enqueueSessionWrite: (sessionId, label, write) => inputQueue.enqueueDurableWrite(sessionId, label, write),
  // Reading stored work must not advertise an unwired control operation.
  isParentPiSessionLive: () => false,
});

const apiToken = readOrCreateApiToken(resolveHostDataDir());
const webDir = process.env.CINDY_HOST_WEB_DIR?.trim()
  || layout.webDir;
/** The profile the browser client reads: same account, same files, no copy. */
function hostProfileInput() {
  return { dataDir: resolveHostDataDir(), ownerId: runtime.owner ?? null };
}

function currentProfileSettings() {
  return readProfileSettings(hostProfileInput());
}

function writeProfileAppearance(patch: unknown) {
  const applied = writeAppearanceSettingsPatch(
    hostProfileInput(),
    patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {},
  );
  eventHub.publish({ type: 'appearance_changed', appearance: applied });
  eventHub.publish({ type: 'settings_changed', domain: 'appearance', value: applied });
  return applied;
}

const ipcLog = createLogger('host-ipc');
/** Registered desktop IPC channels; local bearer callers only (see ipc-route.mjs). */
const ipcRoute = createHostIpcRoute({
  instanceId,
  bindings: createHostIpcBindings({ getLiveSession: id => agentGraph?.maker.getSession(id) }),
  readOwnerStamp: getActiveDataOwnerPushStamp,
  isOwnerBoundaryPending: isAppSessionBoundaryPending,
  // Every window call passes here: successes at debug, anything else stays visible.
  log: event => (event.outcome === 'ok' ? ipcLog.debug('ipc call', event) : ipcLog.warn('ipc call', event)),
});

// The working-directory move's ports (session-move.ts): the desktop's worktree registry (worktrees.json
// in the profile root, read only), an idle runtime closed through the executor, the recent project push,
// and the live Claude bridge the shared transcript move reads (register.ts setLiveCcSessionBridge).
const sessionMove = createHostSessionMovePorts({
  profileDir,
  getMakerIfReady: () => agentGraph?.maker ?? null,
  isTurnRunning: (id: string) => inputQueue.isTurnRunning(id),
  closeRuntime: (id: string) => inputQueue.closeRuntime(id),
  publish: event => eventHub.publish(event),
});
setLiveCcSessionBridge(sessionMove.liveCcSessionBridge);

const profileServices = bindHostProfileServices({
  profileHoldReason: inputQueue.profileHoldReason,
  profileHoldGeneration: inputQueue.profileHoldGeneration,
});
const runtimePluginSettings = profileServices.plugins({
  maker: { getSessionMeta: id => {
    if (!agentGraph) throw new Error('Host runtime not ready');
    return agentGraph.maker.getSessionMeta(id);
  } },
  selection: runtimeSelection,
  resolveGhostControlPointPlugin: (point, id) => {
    if (!plugins) throw new Error('Host plugin runtime not ready');
    return plugins.taskPlugins.resolveGhostControlPointPlugin(point, id);
  },
  publish: event => eventHub.publish(event),
});
const serverDeps = {
  runtimePluginSettings,
  legacyPluginApprovals: () => plugins?.legacyPluginApprovals() ?? null,
  ipcRoute,
  // The HTTP logout's first step, before it closes the platform client and drains requests (server.mjs).
  beginOwnerBoundaryStop: () => ownerBoundary.begin(),
  // Coexistence plan A: while a desktop uses this profile, only reads, stops and answers reach the
  // handlers (service.mjs HOST_PATHS_ALLOWED_WHILE_HELD). A failed release reports its write error.
  profileHold: inputQueue.profileHoldReason,
  browserBackend: (handler: keyof NonNullable<typeof platformTools>['browserSettings'], payload: unknown) => {
    if (!platformTools) throw new Error('HOST_RUNTIME_NOT_READY');
    return platformTools.browserSettings[handler](undefined, payload);
  },
  executeTaskTags: taskTags.executeTaskTags,
  searchConversations: executeConversationSearch,
  rightSidebarTabs: createRightSidebarTabsService({
    getDb: () => getDbClient().drizzle,
    changed: sessionId => { eventHub.publish({ type: 'right_sidebar_tabs_changed', sessionId }); },
  }),
  instanceId,
  isOwnerReady: () => runtime.state === 'ready' && account.authenticated && !isAppSessionBoundaryPending(),
  // Why the start failed or was refused (start-failure.ts), the same code as the auth state's
  // `hostUnavailable`. A start refused by a desktop on this profile (coexistence plan A) also says what to do.
  ownerUnavailableReason: () => (!runtime.unavailable ? null
    : runtime.unavailable === HOST_PROFILE_IN_USE_BY_DESKTOP
      ? { reason: runtime.unavailable, message: profileInUseAtStartMessage() }
      : { reason: runtime.unavailable }),
  requestStop: () => stop(),
  subagentRuns: subagentReads,
  token: apiToken,
  shimPath: layout.shimPath,
  shimPrebuilt: layout.packaged,
  // Inline the shared defaults so the synchronous snapshot API can answer.
  // The browser client reads the Desktop's own settings files, so the snapshot
  // it boots with is the same one the Desktop renders — never a host-side copy.
  bootValues: () => {
    const profile = currentProfileSettings();
    return {
      appVersion: layout.version,
      platform: process.platform,
      osRelease: os.release(),
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      voiceInput: profile.voiceInput,
      harness: harnessBinaries.status(),
      auth: account.authenticated && accountUser
        // realm: the web shim lets usage statistics leave only for this region (甲-1).
        ? { user: accountUser, ownerId: runtime.owner, realm: account.realm }
        : {},
      appearance: profile.appearance,
      layout: profile.layout,
      sidebar: profile.sidebar,
      analytics: profile.analytics,
      appShortcuts: profile.appShortcuts,
    };
  },
  profile: async () => currentProfileSettings(),
  settings: {
    setAppearance: async (patch: unknown) => writeProfileAppearance(patch),
    resetAppearance: async () => writeProfileAppearance({ ...DEFAULT_APPEARANCE_SETTINGS }),
    setLayout: async (layout: unknown) => {
      const applied = writeLayout(hostProfileInput(), layout);
      eventHub.publish({ type: 'settings_changed', domain: 'layout', value: applied });
      return applied;
    },
    resetLayout: async () => {
      const applied = writeLayout(hostProfileInput(), createDefaultLayout());
      eventHub.publish({ type: 'settings_changed', domain: 'layout', value: applied });
      return applied;
    },
    setSidebar: async (value: unknown) => {
      const applied = writeSidebarSettings(hostProfileInput(), value);
      eventHub.publish({ type: 'settings_changed', domain: 'sidebar', value: applied });
      return applied;
    },
    setShortcuts: async (overrides: unknown) => {
      const applied = writeAppShortcutOverrides(hostProfileInput(), overrides);
      eventHub.publish({ type: 'settings_changed', domain: 'shortcuts', value: applied });
      return applied;
    },
  },
  // Resolved per request so a bundle built after startup is picked up.
  webDir: () => (existsSync(path.join(webDir, 'index.html')) ? webDir : null),
  probe: async () => ({
    status: 'ok',
    service: 'cindy-host',
    clientProtocol: 1,
    // Platform RPC now survives a client replacement, with live embedded pages
    // deferring it. Full daily-client migration still requires the production
    // adoption acceptance and feature parity (scheduler, companions and IM).
    // The isolated platform acceptance must not open the whole-client gate.
    clientHandoffReady: clientMigrationContract.ready,
    instanceId,
    pid: process.pid,
    region: resolveHostRegion(),
    dataDir: resolveHostDataDir(),
    // How this Host finds its outbound proxy (row 28): never an address or a setting.
    outboundProxy: describeHostOutboundProxy(),
    runtime: activeOwner === null
      ? runtime
      : { ...runtime, skillProjectionBoundary: observeSkillProjectionBoundary(activeOwner) },
    remote: deviceLink?.state() ?? { enabled: false, status: 'offline' },
    account,
    harness: harnessBinaries.status(),
    claude: claudeState,
    maker: agentGraph ? { agents: agentGraph.agents } : null,
    sessions: sessionStorage ? (await listActiveSessions(sessionStorage)).length : null,
  }),
  me: async () => ({
    owner: runtime.owner,
    authenticated: account.authenticated,
    realm: account.realm,
    user: accountUser,
  }),
  getAuthState: async () => { await startup; return projectAuthState(); },
  agentAuthState: async (kind: 'claude-code' | 'codex' | 'pi') => {
    if (!HOST_HARNESS_KINDS.includes(kind)) throw new Error('Invalid agent kind');
    if (!agentGraph?.instances[kind]) return { authenticated: false, errorReason: 'runtime_unavailable' };
    return agentGraph.maker.getAgentAuthState(kind);
  },
  agentStatus: async (kind: 'claude-code' | 'codex' | 'pi') => {
    if (!HOST_HARNESS_KINDS.includes(kind)) throw new Error('Invalid agent kind');
    return agentGraph?.maker.getAgentStatus(kind) ?? { binaryReady: false, binaryPath: null, authReady: false };
  },
  agentAuthInvoke: (channel: string, args: unknown[], caller: string) => {
    if (!agentAuth) throw new Error('Agent runtime is unavailable');
    return agentAuth.invoke(channel, args, caller);
  },
  releaseAuthCaller: (caller: string) => { agentAuth?.releaseCaller(caller); hostConfirmations?.cancelCaller(caller); },
  connectController: (caller: string, send: Parameters<NonNullable<typeof hostConfirmations>['connect']>[1]) =>
    hostConfirmations?.connect(caller, send),
  resolvePluginConfirmation: (caller: string, kind: 'confirm' | 'install', requestId: string, confirmed: boolean) =>
    hostConfirmations?.resolve(caller, kind, requestId, confirmed) ?? false,
  cancelPendingAuth: async () => {
    agentAuth?.close();
    await providerConfig?.cancelLogins();
  },
  listRunningSessions: (options: unknown) => listRunningSessions(agentGraph?.maker, options),
  refreshAuth: async () => {
    const ok = await refreshAuthSession();
    return { ok, ...projectAuthState() };
  },
  logout: async () => {
    await startup;
    authClosed = true;
    const outgoingOwner = activeOwner;
    // Read before the runtime is disposed (disposal releases the hold with the input queue).
    const heldAtLogout = inputQueue.isHeldForDesktop();
    // The signed-in account, read before disposal clears it: signing out names it in the saved accounts.
    const outgoingUser = accountUser;
    let loggedOut = false;
    const releaseBoundary = beginAppSessionBoundary();
    try {
      // As the desktop's logout (authManager.ts): stop and tear down locally first, then sign out the stored
      // session; the server revoke is best effort (auth/logout.mjs), a failed revoke does not fail the logout.
      const { result, errors } = await runOwnerBoundary(ownerBoundary, {
        beforeDispose: () => authRefreshFlight,
        dispose: disposeOwnerRuntime,
        afterDispose: async () => {
          const realm = (account.realm ?? resolveHostRegion()) as 'cn' | 'global';
          const endpoints = readAuthEndpoints(realm);
          const store = await createCredentialStore({
            userDataDir: resolveHostDataDir(),
            keyringApplication: process.env.CINDY_HOST_KEYRING_APPLICATION?.trim() || undefined,
          });
          const { machineIdSync } = createRequire(import.meta.url)('node-machine-id');
          const client = new CindyAuthClient({
            baseUrl: endpoints.authApiBaseUrl,
            region: realm,
            deviceId: resolveSessionDevice(store.read(AUTH_SESSION_KEY), () => resolveRuntimeDeviceId(machineIdSync, '')),
            clientType: 'desktop',
            fetch: (input, init) => hostAuthFetch(input, init),
          });
          const signedOut = await withCrossProcessLock(
            path.join(resolveHostDataDir(), AUTH_ACCOUNT_VAULT_LOCK_FILE),
            { label: 'auth-account-vault', waitMs: 5000 },
            async (lock) => {
              if (!lock.held) throw new Error('Saved account credentials are busy; retry logout');
              return logoutHostSession({
                store, ownerId: outgoingUser?.id, passportId: outgoingUser?.passportId,
                refresh: (token) => client.refresh(token),
                logout: (accessToken) => client.logout(accessToken),
              });
            },
          );
          loggedOut = true;
          return signedOut;
        },
      });
      if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Logout did not complete cleanly');
      return result;
    } finally {
      try {
        // Row 25 (25b, decision (ii)): clear the outgoing owner's Skill projections as the desktop does at
        // sign-out, without a commit; skipped while a desktop holds the profile. Never fails the logout.
        if (loggedOut && outgoingOwner) {
          await sweepOwnerSkillProjectionsAtLogout({ userDataDir: resolveHostDataDir(), ownerId: outgoingOwner,
            isProfileHeld: () => heldAtLogout, warn: (message, fields) => hostLog.warn(message, fields) });
        }
      }
      finally {
        // An explicit sign-out ends what the last failed start reported (disposal keeps it).
        if (loggedOut) runtime.unavailable = null;
        commitVolatileAppSession('signed-out', null, true);
        releaseBoundary();
        eventHub.clear();
        eventHub.publish({ type: 'auth_changed', ...projectAuthState() });
      }
    }
  },
  listSessions: async (body?: Record<string, unknown>) => {
    if (!sessionStorage) return [];
    // A failed read must not replace an archived/pinned view with active-only
    // fallback data. The HTTP boundary reports the error and clients can retry.
    return readHostSessionList(getDbClient().drizzle, body);
  },
  // Project aliases are rows in the same owner database; the sidebar groups by
  // them on both clients, so they come straight from that table.
  readProjectInfo,
  readProjectIconImage,
  resolveAutomaticProjectIcon,
  updateProjectInfo: profileServices.project({
    platform: () => platformClient,
    changed: catalogChanged => eventHub.publish({ type: 'project_aliases_changed', catalogChanged }),
  }),
  listProjectAliases: async () => {
    const rows = await getDbClient().drizzle.select().from(projectAliasTable);
    return rows.map((row: Record<string, unknown>) => ({
      projectKey: String(row.projectKey ?? ''),
      alias: String(row.alias ?? ''),
      updatedAt: new Date(Number(row.updatedAt ?? 0)).toISOString(),
    }));
  },
  setProjectAlias: async (input: { projectKey?: unknown; alias?: unknown }) => {
    const { upsertProjectAlias } = await import('../../desktop/src/main/localDb/ipc/projectAliasesCore.ts');
    const result = await upsertProjectAlias(input.projectKey, input.alias);
    eventHub.publish({ type: 'project_aliases_changed' });
    return result;
  },
  deleteProjectAlias: async (input: { projectKey?: unknown }) => {
    const { deleteProjectAlias } = await import('../../desktop/src/main/localDb/ipc/projectAliasesCore.ts');
    await deleteProjectAlias(input.projectKey);
    eventHub.publish({ type: 'project_aliases_changed' });
    return { ok: true };
  },
  listRecentWorkdirs: async () => {
    const { listRecentWorkdirs } = await import('../../desktop/src/main/localDb/ipc/recentWorkdirsCore.ts');
    return listRecentWorkdirs();
  },
  interruptedPending: async () => {
    const { listInterruptedPendingRows } = await import('../../desktop/src/main/localDb/sessionActiveTurn.ts');
    return (await listInterruptedPendingRows({ includeBotTasks: false })).map((row) => row.sessionId);
  },
  errorTailPending: async () => {
    const { listErrorTailPendingSessionIds } = await import('../../desktop/src/main/localDb/sessionActiveTurn.ts');
    return listErrorTailPendingSessionIds();
  },
  interruptedCandidates: async () => {
    const { listInterruptedResumeCandidateRows } = await import('../../desktop/src/main/localDb/interruptedResumeCandidates.ts');
    const rows = await listInterruptedResumeCandidateRows(() => false);
    return rows.map((row) => ({
      sessionId: row.sessionId,
      interruptedAt: row.interruptedAt,
      activity: row.lastToolUse?.toolName ?? null,
    }));
  },
  updateSession: lockSessionRoute(createHostSessionUpdate({
    restoreTaskToActive: taskRestore.restoreTaskToActive,
    publish: event => eventHub.publish(event),
    setModel: (sessionId, model, providerId, revision, selection) =>
      runtimeSelection.setModel(sessionId, model, providerId, revision, selection),
    persistSessionFields: (sessionId, patch) => runtimeSelection.persistSessionFields(sessionId, patch),
    move: sessionMove.move,
  })),
  /**
   * Register a switch under the route lock for enqueue or the dispatch boundary.
   */
  /**
   * A model change a client asks for: the desktop's set-model (runtime-selection.ts). A user's pick is
   * an intent until the next send; the arguments are the desktop IPC's (the web client passes them
   * through unchanged).
   */
  setSessionModel: (sessionId: string, model: unknown, providerId: unknown, revision: unknown, selection: unknown) =>
    runtimeSelection.setModel(sessionId, model, providerId, revision, selection),
  /**
   * The desktop's set-effort, set-fast-mode and set-thinking-enabled (runtime-selection.ts, the shared
   * handler bodies of sessionRuntimeAxisSettings.ts), with the desktop IPC's arguments.
   */
  setSessionEffort: (sessionId: unknown, effort: unknown) => runtimeSelection.setEffort(sessionId, effort),
  setSessionFastMode: (sessionId: unknown, requestedSpeed: unknown) => runtimeSelection.setFastMode(sessionId, requestedSpeed),
  setSessionThinkingEnabled: (sessionId: unknown, enabled: unknown) => runtimeSelection.setThinkingEnabled(sessionId, enabled),
  /**
   * The desktop's set-permission-mode and set-plan-mode (runtime-selection.ts, the shared bodies of
   * sessionPermissionSettings.ts), with the desktop IPC's arguments. Not under the task's send lock, as
   * on the desktop: a permission change waits in the task's permission queue, which comes before the
   * send lock (a holder of the send lock must never wait for it).
   */
  setSessionPermissionMode: (sessionId: unknown, mode: unknown) => runtimeSelection.setPermissionMode(sessionId, mode),
  setSessionPlanMode: (sessionId: unknown, enabled: unknown) => runtimeSelection.setPlanMode(sessionId, enabled),
  /**
   * An engine change a client asks for: the desktop's switch-session-agent (an intent until the next
   * send), with its arguments: the options (confirmedContextWindow; agentDeviceId) and the thinking
   * choice. Moving the Agent to another computer is refused as the Host refuses remote execution
   * (send-preflight.ts); null keeps it on this computer, as on the desktop.
   */
  switchSessionAgent: async (
    sessionId: string,
    targetAgentKind: string,
    model: string,
    providerId: string | null,
    effort?: unknown,
    fastMode?: unknown,
    options?: unknown,
    thinking?: unknown,
  ) => {
    // The desktop handler's readers of its 7th argument (sessionAgentSwitchHandler.ts).
    const confirmedContextWindow = readSwitchOptionsConfirmedContextWindow(options);
    const agentDeviceId = readSwitchOptionsAgentDeviceId(options);
    if (agentDeviceId !== undefined && agentDeviceId !== null) {
      throwIpcError('UNSUPPORTED_CAPABILITY', 'Host does not yet support remote execution');
    }
    return runtimeSelection.switchAgent({
      sessionId, targetAgentKind, model, providerId, effort, fastMode,
      ...(confirmedContextWindow !== undefined ? { confirmedContextWindow } : {}),
      ...(agentDeviceId !== undefined ? { agentDeviceId } : {}),
      thinking,
    });
  },
  getSessionAgentSwitchIntent: (sessionId: string) => runtimeSelection.projectIntent(sessionId),
  /**
   * Auto-title step 1 (Codex-style immediate placeholder): persist the
   * normalized first user text while the title is still the default sentinel.
   * The desktop's smart-title model pass stays desktop-owned; the web client
   * still gets the visible sidebar update D3 expects.
   */
  autoTitle: async (input: { sessionId?: unknown; text?: unknown; isUserText?: unknown }) => {
    const sessionId = String(input.sessionId ?? '');
    const text = typeof input.text === 'string' ? input.text : '';
    const seed = normalizeAutoTitle(text);
    if (!sessionId || !seed) return { applied: false, done: false };
    if (plugins?.taskPlugins.hasEnabledUserMessageHookGhost()) return { applied: false, done: false };
    const rows = await getDbClient().drizzle.select({ title: sessionTable.title }).from(sessionTable)
      .where(eq(sessionTable.id, sessionId)).limit(1);
    const current = rows[0]?.title ?? null;
    if (current === null || !isDefaultDraftSessionTitle(current)) {
      return { applied: false, done: true };
    }
    await getDbClient().drizzle.update(sessionTable)
      .set({ title: seed, updatedAt: Date.now() })
      .where(and(eq(sessionTable.id, sessionId), eq(sessionTable.title, current)));
    const after = await getDbClient().drizzle.select({ title: sessionTable.title }).from(sessionTable)
      .where(eq(sessionTable.id, sessionId)).limit(1);
    const applied = after[0]?.title === seed;
    if (applied) eventHub.publish({ type: 'session_changed', sessionId, patch: { title: seed } });
    return { applied, done: applied };
  },
  getSession: async (sessionId: string) => {
    return readHostSession(getDbClient().drizzle, sessionId);
  },
  deleteSession: lockSessionRoute(async (sessionId: string) => {
    if (!sessionStorage) throw new Error('agent runtime is not ready');
    const existing = await sessionStorage.get(sessionId);
    if (!existing) return { deleted: false, sessionId };
    await inputQueue.disposeSession(sessionId);
    runtimeSelection.clearIntent(sessionId);
    await sessionStorage.delete(sessionId);
    // As the desktop's status writer for a deleted task (localDb/ipc/sessions.ts removeHookAttachmentDir):
    // its generated images are released.
    void recoverGeneratedImagesForHistory(sessionId).catch(() => undefined);
    // As the desktop's status writers, under the task's route lock: a deleted task's runtime override and
    // axes go (the runtime cleanup bindHostSessionRuntimeHooks installs).
    cleanupSessionRuntimeForTerminalStatus(sessionId, 'deleted');
    // Desktop cleanup for a deleted task (localDb/ipc/sessions.ts cleanupSessionTerminalArtifacts).
    try { removeSessionModelInterface(sessionId); } catch (error) {
      hostLog.warn('session interface snapshot cleanup failed', { sessionId, error: String(error) });
    }
    void removeTurnChangeSetsForSession(sessionId).catch(error =>
      hostLog.warn('turn change-set cleanup failed', { sessionId, err: error instanceof Error ? error.message : String(error) }));
    forgetProvisionalSession(sessionId);
    eventHub.publish({ type: 'session_changed', action: 'delete', sessionId, status: 'deleted' });
    return { deleted: true, sessionId };
  }),
  discardProvisionalSession: lockSessionRoute(async (sessionId: string) => {
    // Only an unsent draft may be closed: a late request for a task another
    // client already sent must leave its queue running.
    if (!isProvisionalSession(sessionId)) {
      return { discarded: false, remaining: Boolean(await sessionStorage?.get(sessionId)) };
    }
    await inputQueue.disposeSession(sessionId);
    runtimeSelection.clearIntent(sessionId);
    const discarded = await discardProvisionalSessionRow(sessionId, sessionDraftPorts);
    return { discarded, remaining: Boolean(await sessionStorage?.get(sessionId)) };
  }),
  commitProvisionalSession: async (sessionId: string) => ({
    committed: await commitProvisionalSession(sessionId, sessionDraftPorts),
  }),
  createSession: async (input: Record<string, unknown>) => {
    if (!agentGraph || !sessionStorage) throw new Error('agent runtime is not ready');
    const allowed: Record<string, true> = {
      id: true, title: true, workingDir: true, model: true, effort: true, permissionMode: true,
      fastMode: true, planModeEnabled: true, agentKind: true, providerId: true, provisional: true,
      workspaceKind: true, projectDir: true, extraDirs: true, writableDirs: true,
    };
    if (Object.keys(input).some((key) => allowed[key] !== true)) throw new Error('unsupported session field');
    if (typeof input.workingDir === 'string' && input.workingDir.trim()) {
      if (!path.isAbsolute(input.workingDir) || !(await statWorkingDirectory(input.workingDir)).isDirectory()) {
        throw new Error('working directory must exist and be absolute');
      }
    } else if (input.workspaceKind !== 'dialogue') {
      throw new Error('choose a project directory or create a dialogue task');
    }
    const row = await createUserSession({ ...input, agentKind: input.agentKind === 'claude-code' ? 'cc' : input.agentKind }, {
      // HTTP has no native folder-picker proof. The shared service rejects new
      // writable roots until a trusted directory-grant flow supplies one.
      senderId: 0, userDataDir: profileDir,
      notifyPluginSessionCreated: sessionDraftPorts.notifyPluginSessionCreated,
    });
    // Connected clients refresh their task list from this event. An unsent
    // draft announces itself when it is sent (commit), not here.
    if (input.provisional !== true) {
      eventHub.publish({ type: 'session_changed', action: 'create', session: row, sessionId: row.id });
    }
    return row;
  },
  chat: createChatHandler({
    readSession: (id: string) => sessionStorage?.get(id),
    profileHold: inputQueue.profileHoldReason,
    createSession: (body: Record<string, unknown>) => serverDeps.createSession(body),
    enqueue: enqueueUserInput,
    inputStatus: (id: string, clientId: string) => inputQueue.inputStatus(id, clientId),
    events: eventHub,
    defaultModel: process.env.CINDY_HOST_MODEL?.trim(),
    // An owner boundary ends the open streams with the interrupted receipt (agent/owner-boundary.ts).
    onBoundaryStop: ownerBoundary.onStop,
  }),
  providers: () => listProviders({ gateway: currentGateway(), ownerId: runtime.owner }),
  // The agent's own capability descriptor; no second catalog is invented here.
  // Gateway credential state, reported from the same facts the runtime uses.
  // The renderer asks this synchronously at boot; the desktop proxies it from
  // here so both clients start from the same visibility-owner facts.
  modelVisibilityClaim: () => ({
    dataOwnerId: runtime.owner,
    ownerGeneration: getActiveAppSession().generation,
    canWriteOwnerScoped: Boolean(runtime.owner),
    // The host holds the profile lease, so it is the owner of the legacy
    // renderer namespace; a fresh client can then finish its first-run
    // migration instead of staying pending forever.
    claimed: Boolean(runtime.owner),
    claimedByOtherOwner: false,
    canInitialize: false,
    profileOrigin: 'existing',
  }),
  modelAccess: () => modelAccess?.sync.getStatus() ?? { state: 'idle', source: null, endpoint: null, accountTier: null },
  retryModelAccess: () => {
    if (!modelAccess) throw new Error('Model access is not initialized');
    return modelAccess.sync.retry();
  },
  codexRuntimeRoute: () => {
    if (!codexRuntime) throw new Error('Codex runtime is not available');
    return codexRuntime.readRoute();
  },
  // `maker:usage:model-pricing-v2`, which the renderer's getModelPricing asks (preload.ts): the native
  // XD quotes. The v1 channel shares this path; only device-link reaches it (device-link.ts).
  modelPricing: () => usagePricing.getGatewayModelPricing(),
  referenceModelPricing: () => usagePricing.readReferenceModelPricing(),
  agents: () => agentGraph?.agents ?? [],
  events: eventHub,
  input: {
    ...inputQueue,
    enqueue: enqueueUserInput,
    projection: (sessionId: string) => inputQueue.getProjection(sessionId),
  },
  interactions,
  agentCommands: async (input: { agentKind?: string; sessionId?: string }) => {
    const rawKind = String(input.agentKind ?? '');
    const kind = rawKind === 'codex' ? 'codex' : rawKind === 'pi' ? 'pi' : 'claude-code';
    const graph = agentGraph;
    const agent = graph?.instances?.[kind];
    if (!graph || !agent) return { success: false, error: `Agent '${kind}' is not registered` };
    const builtins = agent.listAgentCommands();
    if (kind !== 'pi' || !input.sessionId) return { success: true, commands: builtins };
    const owner = getCurrentDbClientSnapshot();
    const meta = await sessionStorage?.get(input.sessionId);
    if (graph !== agentGraph || owner !== getCurrentDbClientSnapshot() || isAppSessionBoundaryPending())
      throw new Error('Host account changed');
    if (!meta) throw new Error('session not found');
    if (!shouldListPiPackageCommands(kind, true, meta)) return { success: true, commands: builtins };
    const manifest = graph.maker.getSessionRuntimeCapabilities(input.sessionId);
    const extra = manifest?.status === 'loaded'
      ? listPiRuntimePaletteCommands(manifest.commands, manifest.authorizedSlashCommandNames ?? manifest.managedPackageCommandNames) : [];
    return { success: true, commands: mergePiPackageCommands(kind, builtins, extra), runtimeStatus: manifest?.status ?? 'pending' };
  },
  agentSkills: createHostAgentSkillList({
    maker: () => agentGraph?.maker ?? null,
    hasAgent: kind => Boolean(agentGraph?.instances?.[kind as 'claude-code' | 'codex' | 'pi']),
    readStoredWorkDir: async (sessionId) => {
      const stored = await sessionStorage?.get(sessionId);
      return { found: Boolean(stored), workDir: stored?.workDir };
    },
    isProfileHeld: () => inputQueue.isHeldForDesktop(),
    ensureSharedGlobalSkills: () => sharedGlobalSkills.ensureSharedGlobalSkills(),
  }),
  capabilities: async (agentKind: string) => {
    const requested = requireBuiltinAgentKind(agentKind as EngineKind, 'Host model capabilities');
    const kind = requested === 'codex' ? 'codex' : requested === 'pi' ? 'pi' : 'claude-code';
    const baseCaps = agentGraph?.capabilitiesByAgent?.[kind];
    if (!baseCaps) throw new Error(`Agent '${kind}' is not registered`);
    const providerSnapshot = await listProviders({ gateway: currentGateway(), ownerId: runtime.owner });
    const allModelsForAgent = providerSnapshot.providers.flatMap((provider) => provider.models?.[kind] ?? []);
    const seen = new Set<string>();
    const availableModels = [];
    for (const model of allModelsForAgent) {
      if (!seen.has(model.id)) {
        seen.add(model.id);
        availableModels.push({
          id: model.id,
          displayName: model.name ?? model.id,
          contextWindow: model.contextWindow ?? 0,
          efforts: model.efforts ?? [],
          defaultEffort: model.defaultEffort ?? null,
          supportsFastMode: model.supportsFastMode,
          supportsImageInput: model.supportsImageInput,
          supportsToolCalls: model.supportsToolCalls,
        });
      }
    }
    return {
      agentKind,
      ...baseCaps,
      availableModels,
      capabilities: { ...baseCaps, availableModels },
      supportsSessionAgentSwitch: true,
      supportsModelWindowSwitchGuard: true,
      supportsSessionAgentSwitchCas: true,
      supportsRemoteModelWindowRebuild: kind === 'claude-code' || kind === 'pi',
      supportsOrcaWorkerPermissionMode: false,
      supportsOrcaWorkerUpdate: false,
    };
  },
  createMessage: insertSessionMessage,
  // Usage totals come from the same session row the task list reads; the
  // per-message breakdown stays with the windowed reader (host TODO).
  estimatedSessionValue: async (sessionId: string) => {
    const rows = await getDbClient().drizzle.select().from(sessionTable)
      .where(eq(sessionTable.id, sessionId)).limit(1);
    const row = rows[0];
    if (!row) throw new Error('session not found');
    return { totalValueUsd: row.totalCostUsd, entries: [] };
  },
  historyView: async (sessionId: string, before?: string | null) => {
    return hostHistoryReader.page(sessionId, before ?? undefined, true);
  },
  workDetails: async (sessionId: string, ref: unknown, after?: string | null) => {
    return hostHistoryReader.details(sessionId, ref as any, after ?? undefined);
  },
  messagesAroundClientId: async (sessionId: string, clientId: string, opts?: { radius?: number }) => {
    return readMessagesAroundClientId(sessionId, clientId, opts);
  },
  messagesList: async (sessionId: string, limit?: number, before?: string | null) => {
    return readMessagesList(sessionId, { limit: limit ?? 200, before: before ?? undefined });
  },
  history: async (sessionId: string, limit: number) => {
    return readMessagesList(sessionId, { limit });
  },
  turnChangeSets: async (sessionId: string) => {
    const { listTurnChangeSets } = await import('../../desktop/src/main/turn-change-set/store.ts');
    return listTurnChangeSets(sessionId);
  },
  ghosts: () => plugins?.list() ?? [],
  pluginRuntimeStates: () => plugins?.runtimeStates() ?? { states: {} },
  getPluginCard: async (callId: string) => ({ card: await getGhostCard(callId) }),
  listPluginCards: async (sessionId: string) => ({ cards: await listGhostCardsBySession(sessionId) }),
  setPluginEnabled: (id: string, enabled: boolean, approval?: string) => {
    if (!plugins) throw new Error('Plugin runtime is not ready');
    return plugins.setEnabled(id, enabled, approval);
  },
  listPlugins: () => (runtime.owner
    ? listInstalledPlugins(resolveHostDataDir(), runtime.owner)
    : { plugins: [], namespace: 'canonical', legacyNamespacePresent: false }),
};

function projectAuthState() {
  return projectHostAuthState({ account, accountUser, owner: runtime.owner,
    generation: getActiveAppSession().generation, deviceId: currentDeviceId, unavailable: runtime.unavailable ?? null });
}

/** Ordered disposal also runs after partial startup or a failed sign-out. */
async function disposeOwnerRuntime(): Promise<void> {
  const remote = deviceLink;
  deviceLink = null;
  remoteIdentityReady = false;
  endAuthRefreshes();
  coexistenceMonitor?.stop(); coexistenceMonitor = null;
  const errors: unknown[] = [];
  const attempt = async (operation: () => unknown) => {
    try { await operation(); } catch (error) { errors.push(error); }
  };
  try {
    // Keep storage alive until all execution and memory writers have settled,
    // but still release every resource when any individual teardown fails.
    fileConfirmation.cleanupAll('session_closed');
    hostConfirmations?.close(); hostTools?.close();
    stopPluginAuthorization?.(); stopPluginAuthorization = null;
    interactionBroker.dispose();
    await attempt(() => agentAuth?.close());
    await attempt(() => modelAccess?.close());
    agentGraph?.gatewayRestart.clear();
    await attempt(() => providerConfig?.close());
    taskRuntimePlugins = null;
    setGhostToolApprovalResolver(null);
    const stopPlugins = plugins?.close();
    const stopApps = pluginGateway?.close();
    // Attach a rejection handler immediately while other services drain.
    const drainedPlugins = stopPlugins?.then(() => {}, error => { errors.push(error); });
    const drainedApps = stopApps?.then(() => {}, error => { errors.push(error); });
    await attempt(() => remote?.stop());
    // Settle disconnected platform calls before Maker awaits task-close hooks.
    // Client-owned OS sessions are released by its authenticated socket teardown.
    platformClient?.close();
    await attempt(() => inputQueue.dispose());
    await attempt(() => (agentGraph?.maker as { shutdown?: () => Promise<void> } | undefined)?.shutdown?.());
    // Stop watching this profile's Pi packages once Maker no longer runs Pi.
    agentGraph?.piPackages.close();
    await attempt(() => codexRuntime?.close());
    await attempt(() => claudeProxy?.close());
    await attempt(() => mcpRuntime?.close());
    platformClient?.close(); platformClient = null;
    await attempt(() => platformTools?.close());
    await attempt(closeCliProxyBridge);
    await attempt(() => makerMemory?.dispose());
    await attempt(() => drainedPlugins);
    await attempt(() => drainedApps);
    pluginManager?.disposeNotificationIndex();
    // The usage writes started for this owner finish in its database, and no new one starts
    // (agent/usage-recording.ts drain; the desktop flushes the Pi writes there, bootstrap-electron.ts :2639).
    await attempt(() => usageRecording.drain());
    await attempt(() => closeStorage?.());
  } finally {
    platformTools = null;
    plugins = null;
    pluginGateway = null;
    pluginManager = null;
    hostTools = null;
    hostConfirmations = null;
    offMakerSessionClosed?.();
    offMakerSessionClosed = null;
    agentGraph = null;
    gitSnapshot = null;
    mcpRuntime = null;
    codexRuntime = null;
    claudeProxy = null;
    providerConfig = null;
    agentAuth = null;
    modelAccess = null;
    availabilityPolicy = null;
    makerMemory = null;
    closeStorage = null;
    sessionStorage = null;
    activeOwner = null;
    accountUser = null;
    currentSessionToken = null;
    currentDeviceId = null;
    claudeState = null;
    account = { authenticated: false, realm: account.realm };
    await attempt(() => runtimeLease?.release());
    runtimeLease = null;
    runtime.state = 'uninitialized';
    runtime.storage = 'unopened';
    runtime.owner = null;
    // runtime.unavailable is not cleared here (甲, 2026-11-18): a refresh that ends a session the failed start
    // never adopted (none saved, or rejected) disposes again, and the window must keep seeing why the start
    // failed instead of a sign-in form. It ends only when the database opens (ensureRuntime), at an explicit
    // sign-out (logout below), or at a completed sign-in; sign-in completes outside serve today (cindy-host
    // login), so the next start reports anew.
  }
  if (errors.length) throw new AggregateError(errors, 'Owner runtime cleanup failed');
}
let startup: Promise<void> = Promise.resolve();

const service = createHostService(serverDeps);
const server = createHostServer({ ...serverDeps, service, platformClient: () => platformClient,
  remoteControl: async (action: string, body: { deviceId?: string }) => {
    if (!deviceLink) throw new Error('Sign in and start the Host runtime first');
    if (action === 'status') return deviceLink.state();
    if (action === 'enable' || action === 'disable') return deviceLink.setEnabled(action === 'enable');
    if (action === 'revoke') return deviceLink.revoke(body.deviceId ?? '');
    // This Host's 「Agent-Net (Beta)」 setting; off by default (docs/agent-net-session-plan.md 阶段 5).
    if (action === 'agent-net-on' || action === 'agent-net-off') return deviceLink.setAgentNetEnabled(action === 'agent-net-on');
    // 「重新加入」 after this Host was removed from the account (device-link.ts `rejoin`).
    if (action === 'rejoin') return deviceLink.rejoin();
    throw new Error('Unknown remote control command');
  },
});

/**
 * Agent-Net for this Host (docs/agent-net-session-plan.md 阶段 5), wired like the Desktop: the account token only enrolls
 * this device on the region's official Agent-Net service; the identity's keys stay in this Host's credential store.
 * Off until the Host's 「Agent-Net (Beta)」 setting is turned on.
 */
function hostAgentNetPorts(): Parameters<typeof createHostDeviceLink>[0]['agentNet'] {
  const realm = account.realm === 'cn' ? 'cn' : 'global';
  const base = readAuthEndpoints(realm).agentNetApiBaseUrl ?? null;
  if (!base) return undefined;
  let store: Promise<Awaited<ReturnType<typeof createCredentialStore>>> | null = null;
  // A store that could not open (keyring still locked) is tried again on the next use, not remembered as failed.
  const credentials = () => (store ??= createCredentialStore({ userDataDir: resolveHostDataDir(),
    keyringApplication: process.env.CINDY_HOST_KEYRING_APPLICATION?.trim() || undefined }).catch((error: unknown) => { store = null; throw error; }));
  let core: Promise<WebAssembly.Module> | null = null;
  return {
    base: () => base,
    subject: () => accountUser?.id ?? null,
    deviceId: () => currentDeviceId,
    deviceName: () => process.env.CINDY_HOST_DEVICE_NAME?.trim() || `${os.hostname()} · Cindy Host`,
    readSecret: async key => (await credentials()).read(key),
    writeSecret: async (key, value) => { (await credentials()).write(key, value); },
    enroll: (url, body) => serverApi('/api/agent-net/enroll', { baseUrl: url, method: 'POST', body, timeoutMs: 10_000, cache: 'no-store',
      logLabel: '/api/agent-net/enroll', redactErrorDetails: true, allowedRedactedErrorCodes: ['DEVICE_REENROLLMENT_REQUIRES_APPROVAL'] }),
    fetch: (input, init) => hostOutbound.outboundFetch(input, init),
    createWebSocket: async (url, options) => new WebSocket(url, { ...options, agent: await createHostWebSocketAgent(url) }),
    workerFile: () => (existsSync(layout.agentNetWorker) ? layout.agentNetWorker : null),
    coreModule: () => (core ??= readFile(layout.agentNetCore).then(bytes => WebAssembly.compile(bytes))
      .catch((error) => { core = null; throw error; })),
    // Devices removed from the account in Device Link are refused on Agent-Net until they sign in again (packages/agent-net/src/membership.ts).
    deviceLinkDeviceIds: async () => {
      const baseUrl = readAuthEndpoints(realm).deviceLinkApiBaseUrl;
      if (!baseUrl || !account.authenticated) return null;
      const listed = await serverApi<{ devices?: Array<{ deviceId?: unknown }> }>('/api/device-link/devices', {
        baseUrl, timeoutMs: 10_000, cache: 'no-store', redactErrorDetails: true });
      return Array.isArray(listed?.devices)
        ? listed.devices.map(device => device?.deviceId).filter((id): id is string => typeof id === 'string') : null;
    },
    // 名册缓存（公开证书）：官方 Agent-Net 服务出故障时重启也能起来，和 Desktop 一样（agentNetDirectoryCache.ts）。按服务与账号各一份。
    directoryCacheFile: () => {
      const subject = accountUser?.id;
      if (!subject) return null;
      const scope = createHash('sha256').update(JSON.stringify([base, subject])).digest('hex').slice(0, 32);
      return path.join(resolveHostDataDir(), 'agent-net', scope, 'directory.json');
    },
    log: createLogger('agent-net'),
  };
}

async function setSessionExtraDirs(sessionId: string, requestedDirs: string[]): Promise<string[] | void> {
  const owner = activeOwnerScopeKey();
  const generation = inputQueue.profileHoldGeneration();
  const assertWriteAllowed = () => {
    if (owner !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) {
      throwIpcError('PRECONDITION_FAILED', 'Host account changed');
    }
    const held = inputQueue.profileHoldReason();
    if (held || generation !== inputQueue.profileHoldGeneration()) {
      throwIpcError('PRECONDITION_FAILED', held ?? 'Host profile ownership changed');
    }
  };
  assertWriteAllowed();
  return withSendToSessionLock(sessionId, async () => {
    assertWriteAllowed();
    const session = agentGraph?.maker.getSession(sessionId);
    if (session && !session.capabilities.extraDirs.supported) return;
    const workDir = session?.workDir || await readSessionWorkingDirFromDb(sessionId);
    const runtime = session
      ? {
          setExtraDirs: (dirs: string[]) => session.setExtraDirs(extraDirsForRuntime(dirs), libraryRootForRuntime(dirs)),
          setWritableDirs: createTaskWritableDirsUpdater(session),
        }
      : { setExtraDirs: async () => {}, setWritableDirs: async () => {} };
    const persisted = await readSessionExtraDirsFromDb(sessionId);
    const dirs = replaceUserExtraDirs(requestedDirs, persisted);
    const result = await applyRemoteDirectoryGrantUpdate('extraDirs', dirs, runtime, {
      assertWriteAllowed,
      validate: dirs => validateExtraDirs(dirs, workDir),
      readExtraDirs: async () => persisted,
      readWritableDirs: () => readSessionWritableDirsFromDb(sessionId),
      excludeConflicts: excludeDirectoryGrantConflictsWithSlots,
      persist: patch => runtimeSelection.persistSessionFields(sessionId, patch),
      terminate: async () => {
        if (session && agentGraph) await agentGraph.maker.closeSessionIfCurrent(session, 'runtime-refresh');
      },
    });
    // Device Link returns the applied subset, not the transaction metadata.
    return result.dirs;
  });
}

function startDeviceLink(): void {
  if (deviceLink) return;
  const endpoint = readAuthEndpoints(account.realm === 'cn' ? 'cn' : 'global').deviceLinkApiBaseUrl;
  if (!endpoint) throw new Error('The endpoint manifest does not contain a Device Link relay');
  const worktree = createHostWorktreeLifecycle(profileDir);
  if (!inputQueue.profileHoldReason()) {
    void worktree.reconcilePendingSafeDirectoryCleanups().catch(error =>
      hostLog.warn('deferred Worktree safe.directory cleanup failed', { error }));
  }
  deviceLink = createHostDeviceLink({
    profileDir, worktree, version: layout.version,
    mcpApps: pluginGateway ?? undefined,
    releaseAuthCaller: caller => agentAuth?.releaseCaller(caller),
    getWsUrl: () => endpoint.replace(/^https:/, 'wss:') + '/api/device-link/ws',
    getToken: async () => currentSessionToken,
    refreshToken: async () => { await refreshAuthSession(); },
    canRegister: () => remoteIdentityReady && account.authenticated && !authClosed,
    agentNet: hostAgentNetPorts(),
    // 「重新加入」 (`cindy-host remote rejoin`): the same official Device Link service and account token as the device list.
    officialDeviceLinkFetch: (route, opts) => serverApi(route, { ...opts, baseUrl: endpoint, cache: 'no-store', redactErrorDetails: true }),
    invoke: service, subscribe: eventHub.subscribe,
    isBusyForProjectArchive: id => !agentGraph || inputQueue.isTurnRunning(id)
      || !!agentGraph.maker.getSession(id)?.isTurnRunning() || isProvisionalSession(id),
    onProjectTaskStatus: (sessionId, status) => {
      eventHub.publish({ type: 'session_changed', sessionId, status, patch: { status } });
    },
    preparePiSkillRuntime: (id, workingDir, route) => {
      const assertPreparationCurrent = inputQueue.capturePiSkillPreparation(id);
      return withSendToSessionLock(id, () => inputQueue.preparePiSkillRuntime(id, workingDir, {
        assertPreparationCurrent,
        ...(route ? { applyPendingOwnerSelection: true, expectedPiModel: route.model, nextInputChars: route.nextInputChars } : {}),
      }));
    },
    // The Device Link create entry, with the runtime start admission (agent/create-runtime-session.ts).
    // Coexistence plan A: a new task's runtime and a plugin page's calls are refused while held (device-link.ts).
    profileHold: inputQueue.profileHoldReason,
    isSessionClaimed: async sessionId => {
      if (agentGraph?.maker.getSession(sessionId)) return true;
      const [row] = await getDbClient().drizzle.select({ id: sessionTable.id })
        .from(sessionTable).where(eq(sessionTable.id, sessionId)).limit(1);
      return !!row;
    },
    createRuntimeSession: input => {
      return createHostRuntimeSession(explicitPorts<HostRuntimeSessionCreatePorts>({
      serverDeps,
      getAgentGraph: () => agentGraph,
      assertProviderExecutionSupported,
      admitLocalRoute: opts => runtimeSelection.admitLocalRoute(opts),
      readStoredSession: async id => {
        const [row] = await getDbClient().drizzle.select({
          status: sessionTable.status, workingDir: sessionTable.workingDir, agentKind: sessionTable.agentKind,
          model: sessionTable.model, effort: sessionTable.effort, permissionMode: sessionTable.permissionMode,
          providerId: sessionTable.providerId, fastMode: sessionTable.fastMode,
          planModeEnabled: sessionTable.planModeEnabled, sdkSessionId: sessionTable.sdkSessionId,
        }).from(sessionTable).where(eq(sessionTable.id, id)).limit(1);
        return row ? { ...row, workingDir: row.workingDir || null } : null;
      },
    }), input);
    },
    send: (sessionId, message, createOpts, sendOpts) => inputQueue.send(sessionId, message, createOpts, sendOpts),
    assertRemoteInputControlBoundary: (sessionId, opts) => inputQueue.assertRemoteInputControlBoundary(sessionId, opts),
    setExtraDirs: setSessionExtraDirs,
    publish: event => eventHub.publish(event),
    availabilityPolicy: availabilityPolicy ?? undefined,
    disableShareAvailability,

  });
}

async function disableShareAvailability(shareId: string) {
  const baseUrl = readAuthEndpoints(account.realm === 'cn' ? 'cn' : 'global').deviceLinkApiBaseUrl;
  if (!baseUrl) throw new Error('Device Link endpoint is unavailable');
  await serverApi(`/api/device-link/provider-shares/availability/${encodeURIComponent(shareId)}/disable`, {
    baseUrl, method: 'POST', body: {}, redactErrorDetails: true,
  });
}

server.on('error', (error) => {
  console.error(`cindy-host failed to listen: ${error.message}`);
  process.exitCode = 1;
  stop();
});

server.listen(PORT, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Host listener address is unavailable');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  // Endpoint discovery for clients on this machine: a pid plus the loopback URL.
  // Explicit clients and host:open use this endpoint; desktop startup stays unchanged.
  try {
    removeEndpoint = publishHostEndpoint(profileDir, baseUrl, instanceId);
  } catch (error) {
    console.error('cindy-host discovery failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    stop();
    return;
  }
  console.log(`cindy-host listening on ${baseUrl}`);
  // Packaged logging captures console.* to disk. Operators and service
  // supervisors still need the non-secret loopback readiness address on stdout.
  process.stdout.write(`cindy-host listening on ${baseUrl}\n`);
  startup = (async () => {
    // The loopback endpoint already answers /health while a cold PAC loads.
    await proxyWarmup;
    if (shuttingDown) return;
    let owner = process.env.CINDY_HOST_OWNER?.trim() || '';
    let initialUser: AccountUser | null = null;
    if (!owner) {
      const discovered = discoverHostOwner(resolveHostDataDir());
      if (discovered.ownerId) {
        owner = discovered.ownerId;
        if (!existsSync(ownerDatabasePath(resolveHostDataDir(), owner))) throw new OwnerDatabaseError('DB_INIT_FAILED', 'owner database is missing');
      } else {
        // A newly signed-in preview has credentials but no database yet. Resolve
        // the authenticated membership before creating its first owner database;
        // never invent an owner or copy the running desktop's account files.
        const state = await readAdoptedSessionState({ userDataDir: resolveHostDataDir() });
        account = { authenticated: false, realm: state.realm };
        if (state.authenticated) initialUser = await resolveAccountUser();
        if (!initialUser) { runtime.detail = discovered.reason ?? 'owner is unknown'; return; }
        owner = initialUser.id;
      }
    }
    if (initialUser) {
      accountUser = initialUser;
      account = { authenticated: true, realm: account.realm };
    }
    await ensureRuntime(owner);
    startDeviceLink();
    if (account.authenticated) { scheduleAuthRefresh(); return; }
    const state = await readAdoptedSessionState({
      userDataDir: resolveHostDataDir(),
      keyringApplication: process.env.CINDY_HOST_KEYRING_APPLICATION?.trim() || undefined,
    });
    account = { authenticated: false, realm: state.realm };
    // A renewal that succeeds schedules the next one; one that fails for now retries with backoff.
    if (state.authenticated) await refreshAuthSession();
  })().catch(async (error: unknown) => {
    const blocked = runtime.state === 'blocked';
    try { await disposeOwnerRuntime(); }
    catch (cleanupError) { console.error('cindy-host startup cleanup failed:', cleanupError); }
    finally { commitVolatileAppSession('signed-out', null, true); }
    runtime.state = blocked ? 'blocked' : 'error';
    runtime.detail = error instanceof Error ? error.message : String(error);
    runtime.unavailable = classifyHostStartFailure(error);
    console.error('cindy-host initialization failed:', runtime.detail);
  });
});

let shuttingDown = false;
const stop = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  authClosed = true;
  endAuthRefreshes();
  let releaseOwnerBoundary = () => {};
  const errors: unknown[] = [];
  // The owner boundary's stop first (agent/owner-boundary.ts): as the desktop's quit freezes the turn markers,
  // a turn still running ends as an interruption. Everything before the first await in beforeDispose runs
  // synchronously here, in the previous order.
  const boundary = runOwnerBoundary(ownerBoundary, {
    beforeDispose: async () => {
      const requestsDrained = server.stopAccepting();
      releaseOwnerBoundary = beginAppSessionBoundary();
      // As the desktop's quit ('reap-codex-tool-trees', a sync step before the Maker shutdown):
      // once the app-servers close, the parent chain proving these trees are the Host's is gone.
      // Only on this exit; an owner change or a window handoff leaves the Host running.
      try { reapCodexToolTreesSync(); }
      catch (error) { console.error('cindy-host codex tool tree reap failed:', error instanceof Error ? error.message : String(error)); }
      // Always drain every in-flight writer before releasing the profile lease,
      // including when another startup/auth operation rejected.
      const settled = await Promise.allSettled([startup, authRefreshFlight, requestsDrained]);
      errors.push(...settled.filter(result => result.status === 'rejected').map(result => result.reason));
    },
    // After the reap above (the guard in hostDesktopSourceContracts.guard.test.ts pins the order).
    dispose: async () => { await disposeOwnerRuntime(); },
  });
  void (async () => {
    try {
      errors.push(...(await boundary).errors);
      // The Chromium proxy helper (row 28c), by its handle; it also quits on its own once this process is gone.
      try { await stopHostSystemProxySettings(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Host shutdown did not complete cleanly');
    } finally {
      server.closeAllConnections();
      try {
        commitVolatileAppSession('signed-out', null, true);
        releaseOwnerBoundary();
        workdirProbeHostClient.dispose();
        runtimeLease?.release();
        releaseService();
      } finally { process.removeListener('exit', releaseService); }
    }
  })().catch((error) => {
    console.error('cindy-host shutdown failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
}
