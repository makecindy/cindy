import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  shell,
  type WebContents,
} from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { supportsCindyVersion } from '@cindy/plugin-protocol';

import { createLogger } from '../logger.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  type GhostAppRegion,
  CINDY_ACCOUNT_GHOST_IDS,
  GHOST_CARD_HEIGHT_DEFAULT,
  GHOST_CARD_HEIGHT_MAX,
  GHOST_CARD_HEIGHT_MIN,
  GHOST_INSTALL_MANIFEST_MAX_BYTES,
  GHOST_MEDIA_CAPABILITIES,
  GHOST_NETWORK_MAX_CONNECTIONS_PER_DECL,
  GHOST_NOTIFY_MIN_INTERVAL_MS,
  ghostInstallApprovalToken,
  ghostNetworkAuthorizationWithinCap,
  ghostNodeSecretAuthorizationWithinCap,
  ghostSetupAuthorizationWithinCap,
  ghostSettingsUiWithinCap,
  ghostSubscribeAuthorizationWithinCap,
  ghostToolParametersWithinCap,
  ghostUnknownV3FieldsWithinCap,
  isGhostInstallApprovalToken,
  ghostAppContextLocale,
  unreviewedGhostPermissionItems,
  ghostWebviewEntryPaths,
  isCindyAccountGhostId,
  isBrokerEligibleGhostId,
  isOfficialGhostId,
  isUserInstallReservedGhostId,
  isValidGhostId,
  layoutWithGhostPanel,
  type GhostHostNoticeKey,
  type GhostImageAspectRatio,
  type GhostManifest,
  type GhostCindyPreferenceResult,
  type GhostMediaCapability,
  type GhostMediaModelsResult,
  type GhostMediaModelType,
  type GhostSetupAllowedAction,
  type GhostSetupAssessment,
  type GhostSetupReauthSuggest,
  type GhostVideoRefMode,
  type GhostVideoResultParams,
  type InstalledGhost,
  type GhostLibraryOverview,
} from '../../shared/ghost.js';
import { getAppCapabilities } from '../appCapabilities.js';
import { withGhostSkillProjectionReconcile } from '../authBoundaryQuarantine.js';
import {
  activeOwnerScopeKey,
  getActiveDataOwnerPushStamp,
  getActiveAppSession,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
  type ActiveAppSession,
  type AppSessionMode,
} from '../appSessionState.js';
import { getLayoutStore } from '../layout/index.js';
import {
  GhostManager,
  type GhostExclusiveMutation,
  isCindyOfficialTrustInfo,
  type GhostHostTrustOverride,
  type InstallRejection,
  type UninstallRejection,
} from './GhostManager.js';
import { exportGhostPackage } from './exportGhostPackage.js';
import { GhostMutationCoordinator } from './ghostMutationCoordinator.js';
import { shouldRejectReservedGhostIds } from './reservedGhostIdGate.js';
import {
  bindForgePackStagingTempDir,
  invalidateForgePackTicketsForOwner,
} from './forgePackStaging.js';
import { withGhostInstallLock } from './ghostInstallLock.js';
import {
  clearBuiltinTombstone,
  listEligibleBuiltinCommands,
  listBuiltinSeedIds,
  listEnterpriseSeedIds,
  listRestorableBuiltinGhosts,
  isTrustedBuiltinSeedSource,
  provisionBuiltinGhosts,
  readBuiltinTombstones,
  recordBuiltinTombstone,
  renameBuiltinTombstone,
  type ProvisionIdentity,
} from './builtinGhostProvisioner.js';
import {
  getAccessToken,
  getAuthState,
  onAuthStateChange,
} from '../authManager.js';
import { serverApiFetch } from '../serverApiClient.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { createGhostOauthBrokerClient } from './ghostOauthBroker.js';
import { readRefImagesWithinBudget } from './refImageBudget.js';
import {
  resolveCachedGhostRepoRoot,
  type GhostRepoRootCacheEntry,
} from './repoRoot.js';
import { takePendingCindyInstall } from './openFileInstall.js';
import { GhostRuntime } from './runtime/GhostRuntime.js';
import {
  electronSandboxAdapter,
  ensureGhostProtocolRegistered,
  ghostIdForLogicWebContents,
  sendToGhostLogic,
  setGhostAppContextProvider,
  setGhostConnectionsHandler,
  setGhostKvStore,
  setGhostMediaModelsProvider,
  setGhostOauthHandler,
  setGhostSandboxDevToolsDisabled,
  setGhostSecretsHandler,
  setGhostWakeHandler,
} from './runtime/electronSandboxAdapter.js';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { createGhostKvStore, removeGhostKvBestEffort, type GhostKvStore } from './ghostKvStore.js';
import {
  evaluateGhostSetupAssessment,
  handleGhostSetupStatusRequest,
  parseOauthConnectSecretKey,
} from './ghostSetupStatus.js';
import { getGhostSetupChangeBus } from './ghostSetupChangeBus.js';
import { GhostSetupManifestTracker } from './ghostSetupManifestTracker.js';
import {
  getGhostSetupCoordinator,
  type GhostSetupActionResult,
} from './ghostSetupCoordinator.js';
import {
  getGhostSetupInteractionBridge,
  type GhostSetupInteractionResponseTarget,
} from './ghostSetupInteractionBridge.js';
import { executeGhostSetupInlineSubmission } from './ghostSetupInlineExecutor.js';
import { handleGhostSecretsRequest } from './runtime/ghostSecretsEndpoint.js';
import { handleGhostOauthRequest } from './runtime/ghostOauthEndpoint.js';
import { handleGhostConnectionsRequest } from './runtime/ghostConnectionsEndpoint.js';
import { GhostOauthAccountManager, type GhostOauthDecl } from './ghostOauthAccounts.js';
import { withGhostOauthMutationLock } from './ghostOauthMutationLock.js';
import { createGhostOauthOwnerReconciliationGate } from './ghostOauthOwnerReconciliation.js';
import { cancelActiveGhostOauthFlow } from './ghostOauthFlow.js';
import {
  appendReadyGhostOauthReauthSuggest,
  findGhostOauthReauthSuggest,
} from './ghostOauthScopeStaleness.js';
import { mapGhostOauthConnectError } from './ghostOauthSetupError.js';
import { reclaimLoopbackPort } from './portReclaim.js';
import { GhostConnectionManager } from './ghostConnections.js';
import { getResolvedMainLocale, t } from '../i18n.js';
import { getDeepLinkMainWindow } from '../deepLink.js';
import { reconcileGhostSkillLinks, removeGhostSkillLinksForRoots } from './skillSlot.js';
import { assertGhostSkillProjectionStableOwner } from '../authBoundaryQuarantine.js';
import { type GhostOwnerScope } from './ghostOwnerScope.js';
import {
  assertTrustedAppRendererEvent,
  isTrustedAppRendererEvent,
  isTrustedAppRendererWindow,
} from '../security/trustedAppRenderer.js';
import {
  FILO_GOOGLE_GHOST_ID,
  FILO_GOOGLE_SECRET_KEY,
  migrateFiloGoogleAccountsWithResult,
  type LegacyGoogleAccountRow,
} from './googleAccountsMigration.js';
import { withFiloGoogleBuildClientConfig } from './filoGoogleClientConfig.js';
import {
  LEGACY_JIRA_CONNECTION_FILE,
  LEGACY_JIRA_RT_FILE,
  XD_ATLASSIAN_GHOST_ID,
  XD_ATLASSIAN_SECRET_KEY,
  migrateAtlassianAccountsWithResult,
} from './atlassianAccountsMigration.js';
import {
  LEGACY_GITHUB_CONNECTION_FILE,
  LEGACY_GITHUB_TOKEN_FILE,
  CINDY_GITHUB_GHOST_ID,
  CINDY_GITHUB_SECRET_KEY,
  migrateGithubAccountsWithResult,
} from './githubAccountsMigration.js';
import {
  LEGACY_GITLAB_CONNECTION_FILE,
  LEGACY_GITLAB_TOKEN_FILE,
  CINDY_GITLAB_GHOST_ID,
  CINDY_GITLAB_CONNECTION_KEY,
  migrateGitlabAccountsWithResult,
} from './gitlabAccountsMigration.js';
import {
  LEGACY_MIGRATION_MISSING,
  LEGACY_MIGRATION_RETRYABLE_FAILURE,
  legacyMigrationAvailable,
  readLegacyEncryptedValue,
  type LegacyMigrationRead,
} from './legacyMigrationRead.js';
import { GHOST_SCHEME, ghostExternalLinkUrls } from '../../shared/ghost.js';
import { GhostPipeDispatcher } from './pipeDispatcher.js';
import { GhostCardService, parseCardHeightReport } from './cardService.js';
import { GhostCardActionDispatcher } from './cardActionDispatch.js';
import { GhostSessionActivityTracker } from './ghostSessionActivity.js';
import { sanitizeGhostCardHtml } from './cardSanitizer.js';
import {
  getGhostCard,
  listGhostCardsBySession,
  reassignGhostCards,
  updateGhostCardHeight,
  upsertGhostCard,
} from './cardStoreDb.js';
import { updateMessageContent } from '../localDb/ipc/messages.js';
import { runAssistantReplyHook } from './assistantReplyHook.js';
import { submitAndAwaitVideo } from '../cindy-proxy-media/video/run.js';

import {
  deriveCindyMediaConfig,
  filterLegacyCindyMediaConfig,
  selectExecutableCoreMediaModels,
  type CindyCapabilityKind,
  type CindyMediaCatalogConfig,
} from './cindyMediaCatalog.js';
import { isXdGatewayProviderReady } from './cindyGatewayReadiness.js';
import {
  GhostCindySlot,
  type CindyImageCapabilities,
  type CindyVideoCapabilities,
  type CindyVideoParams,
} from './cindySlot.js';
import { GhostAgentSlot, type GhostAgentTurnRunner } from './agentSlot.js';
import { GhostErrandSlot, type GhostErrandRunner } from './errandSlot.js';
import { readGhostErrandConfig, writeGhostErrandConfig } from './errandPrefsStore.js';
import {
  GhostNodeRuntimeBroker,
  type NodeRuntimeStartAttemptContext,
} from './nodeRuntimeBroker.js';
import { GhostPickSlot } from './pickSlot.js';
import { recordGhostPickedDir } from './pickGrantsStore.js';
import { GhostPreviewSlot } from './previewSlot.js';
import { GhostScheduleSlot, isMainShellWindowUrl } from './scheduleSlot.js';
import { GhostWorkspaceSlot, type WorkspaceSessionService } from './workspaceSlot.js';
import { GhostIOSSimulatorSlot, type IOSSimulatorSlotFocusContext } from './iosSimulatorSlot.js';
import { resolveIOSSimulatorPluginAccess } from './iosSimulatorPluginGate.js';
import {
  clearIOSSimulatorRendererAccess,
  focusIOSSimulatorRendererSession,
  getIOSSimulatorRendererSessionAccess,
  requestIOSSimulatorRendererSessionAccess,
  syncIOSSimulatorRendererAccessForSessionChange,
} from '../mcp-integrations/ios-simulator-renderer-access.js';
import { getIOSSimulatorPluginStatus } from '../mcp-integrations/ios-simulator.js';
import type { GhostTrustRegistry } from './ghostSignature.js';
import { GhostNotifySlot, sanitizeGhostNoticeText } from './notifySlot.js';
import { GhostBadgeSlot } from './badgeSlot.js';
import {
  clearGhostUnread,
  loadGhostUnread,
  markGhostUnread,
  readGhostUnread,
  type GhostUnreadEntry,
} from './ghostUnreadStore.js';
import { isGhostUnreadProjectable, selectRevokedGhostUnreadIds } from './ghostUnreadProjection.js';
import { GhostConfirmSlot } from './confirmSlot.js';
import {
  getGhostConfirmDialogBridge,
  initGhostConfirmDialogBridge,
} from './ghostConfirmDialogBridge.js';
import {
  createForgeOidcInstallMainWindowSender,
  forgeOidcInstallConfirmFacts,
  forgeInstallOriginForMembership,
  getForgeOidcInstallConfirmBridge,
  initForgeOidcInstallConfirmBridge,
} from './forgeOidcInstallConfirmBridge.js';
import { GhostNetworkSlot } from './networkSlot.js';
import {
  type ConnectionAudienceResolution,
  isConnectionSecretReady,
  isReservedConnectionPluginSlug,
  loadConnectionAudienceResolver,
  type ConnectionAudienceResolver,
} from './connectionAudienceResolver.js';
import {
  bindPendingMarketRecordToInspectedPackage,
  loadGhostFirstPartyFactsLoader,
  type GhostFirstPartyFactsLoader,
  type GhostFirstPartyFactsLoad,
  type GhostFirstPartyFactsOverrides,
  type GhostFirstPartyPendingMarketRecord,
  type GhostFirstPartyFactsPurpose,
} from './ghostFirstPartyFacts.js';
import { authorizeGhostTokenBroker } from './ghostFirstPartyPrivilege.js';
import { ghostTokenBrokerInstallError } from './ghostTokenBrokerInstallError.js';
import { ghostBrokerRedirectPortInstallError } from './ghostBrokerRedirectPort.js';
import { ConnectionTokenProvider, type IssuedConnectionToken } from './connectionTokenProvider.js';
import { GhostFsSlot } from './fsSlot.js';
import { GhostLibrarySlot } from './librarySlot.js';
import { LibraryBindingStore, validateLibraryCandidateLocation } from './libraryBinding.js';
import { LibraryVault, statfsFreeBytes, DEFAULT_LIBRARY_LIMITS } from './libraryVault.js';
import { LibrarySqlService, defaultLibraryDbWorkerPath } from './librarySqlService.js';
import { trashGhostLibrary } from './libraryTrash.js';
import { migrateGhostLibrary } from './libraryMigrate.js';
import { setGhostLibraryFileResolver } from './runtime/electronSandboxAdapter.js';
import { createBetterSqliteDatabase, resolveBetterSqliteModuleEntry } from '../localDb/betterSqliteFactory.js';
import { getGhostGrantConfirmBridge } from './ghostGrantConfirmBridge.js';
import { getSessionFsSnapshot, getSessionRowSnapshot } from '../localDb/ipc/sessions.js';
import { getTeamByWorkerSession } from '../localDb/orcaTeamStore.js';
import { getDirDepositVault, getSaveDepositVault, isPathInsideDir } from './dirDeposit.js';
import { readInstalledGhostManifestSnapshot } from '../installedGhostManifest.js';
import {
  ghostManifestDigest,
  PluginMarketLedger,
  type PluginMarketInstallationRecord,
} from '../plugin-market/ledger.js';
import {
  installedMarketManifestIdentity,
  type InstalledMarketManifestIdentity,
} from '../plugin-market/installedManifestIdentity.js';
import { createOrganizationPrefixStore } from '../plugin-market/organizationPrefixStore.js';
import {
  GhostSubscriptionGateway,
  GhostActivityTracker,
  GhostTurnTranslator,
  createGhostPrimarySessionFocusTracker,
  createGhostSessionFocusTracker,
  GhostTapPendingQueue,
  GhostTurnOriginTracker,
  isGhostEligibleSessionRow,
  isGhostSessionSwitchEligibleRow,
  resolveGhostPrimarySessionId,
  type GhostInteractionActivityKind,
  type GhostScreenResult,
  type MinimalAgentEvent,
} from './subscriptionGateway.js';
import { GhostExternalLinkGate, GhostPreviewGate, resolveGhostPanelMedia } from './previewGate.js';
import { runGhostExternalLinkNavigation } from './ghostExternalLinkNavigation.js';
import { runGhostPreviewNavigation } from './ghostPreviewNavigation.js';
import { resolveGhostWebviewPartitionClaim } from './ghostWebviewPartition.js';
import {
  ghostSecretSaved,
  readGhostSecret,
  readGhostSecretStrict,
  getProviderSecretStore,
  readCustomProviderKey,
  readGhostSecretTail,
  removeGhostSecret,
  removeGhostSecrets,
  storeGhostSecret,
} from '../secrets/providerSecretStore.js';
import { getActiveCatalog, getXdGatewayModels } from '../maker-host/active-catalog.js';
import {
  getGrokAccessToken,
  getGrokOAuthCredentialGeneration,
  hasGrokOAuthLogin,
} from '../maker-host/grok-oauth-login.js';
import { invalidateXaiBridgeAuth } from '../maker-host/xai-auth-invalidation-host.js';
import {
  isModelDisabled,
  isModelDisabledWithUniqueLegacyBasename,
  isProviderDisabled,
  type MediaCapability,
  xaiApiOfficialRuntimeAgents,
  XAI_API_CUSTOM_PROVIDER_ID,
} from '@cindy/model-providers';
import { readModelDisableOverrides } from '../maker-host/model-disable-store.js';
import { readProviderOrder } from '../maker-host/provider-order-store.js';
import { guardedOutboundFetch, outboundFetch } from '../maker-host/outbound-fetch.js';
import { getSharedGhCliTokenSource } from '../git-context/ghCliTokenSource.js';
import { hasCodexOAuthLoginReadOnly } from '../maker-host/codex-oauth-readiness.js';
import {
  formatAuxiliaryModelRefLabel,
  getEffectiveAuxiliaryModelChain,
} from '../utility-model/resolveAuxiliaryModelChain.js';
import { utilityModelPinOptions } from '../../shared/utilityModelProfiles.js';
import { isKnownEmbeddingModel } from '@cindy/embedding-client';
import {
  buildTextOneshotPinOptions,
  encodeCatalogPin,
  resolveOneshotCatalogModel,
} from '../utility-model/textOneshotPinOptions.js';
import { hasOneshotProviderCredential } from '../utility-model/oneshotProviderUsability.js';
import {
  CINDY_CAPABILITY_KEYS,
  readGhostCindyOverrides,
  readGhostCindyInflightLimit,
  writeGhostCindyOverride,
  type CindyCapabilityKey,
} from './cindyPrefsStore.js';
import { isCindyOverrideModelAllowed } from './cindyOverrideWhitelist.js';
import {
  isGhostDisabledForWorkdir,
  listDisabledGhostIdsForWorkdir,
  setGhostDisabledForWorkdir,
} from './ghostWorkdirPrefs.js';
import {
  forgetGhostRecentUsage,
  loadGhostRecentIds,
  markGhostRecentlyUsed,
} from './ghostRecentUsageStore.js';
import { createXaiImageChannel } from './xaiImageClient.js';
import { getCindyProxyMediaService } from '../mcp-integrations/cindyProxyMedia.js';
import { getCindyProxySearchService } from '../mcp-integrations/cindyProxySearch.js';
import { ImageChannelRegistry, decodeImageResponse } from './imageChannelRegistry.js';
import { createGeminiImageChannel } from './geminiImageClient.js';
import { createCodexImageChannel } from './codexImageClient.js';
import { getCodexImageAuthBinding } from './codexImageAuthBinding.js';
import { createGatewayImageClient } from '../cindy-proxy-media/api/gatewayImageClient.js';
import { createXaiVideoProvider } from '../cindy-proxy-media/video/providers/xai.js';
import * as blobStore from '../cindy-media/blobStore.js';
import {
  configureProviderMediaRuntime,
  listProviderMediaModels,
} from '../cindy-media/providerMediaRuntime.js';
import { loadPluginMediaAvailability } from './pluginMediaCatalogFallback.js';
import * as ledger from '../cindy-media/ledger.js';
import { ingestMedia, supportedMime } from '../cindy-media/ingest.js';
import { captureMediaRefCompensationScope } from '../cindy-media/refCompensationJournal.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';
import { recordGhostCallMedia } from './ghostMediaLedger.js';
import { MAKER_PUSH } from '../maker-ipc/channels.js';
import { ghostSetupNavigationForAction } from './ghostSetupNavigation.js';
import { assessGhostHostSetupRequirements } from './ghostHostSetupRequirements.js';
import { isModelAccessReady } from '../model-access/readiness.js';
import {
  filterEnabledGatewayMediaModels,
  isMediaModelExecutable,
  isMediaModelExecutableForGuide,
  listExecutableMediaModels,
  supportsMediaCapability,
} from '../model-access/mediaModels.js';
// ⚠️ 下面三个依赖必须保持模块顶层静态 import,禁止改回函数内 await import():
// 运行时 import() 会被 Rollup 编译成跨 chunk 的 require(尤其 drizzle-orm 会拆独立
// chunk),而 bootstrap chunk 因 conf(electron-store 依赖)的模块副作用
// delete require.cache[__filename] 不在 CJS 缓存里——跨 chunk require 会把整个
// 主进程 bundle 重新求值,启动副作用全量重跑直至 IPC 二次注册抛错,反复触发即
// 主进程 OOM(2026-07-12 实事故,详见 bootstrap-electron.ts 末尾的缓存自愈注释)。
import { getDbClient } from '../localDb/client/current.js';
import * as localDbSchema from '../localDb/schema.js';
import { eq } from 'drizzle-orm';
import { requireAppCapability } from '../appCapabilities.js';
import {
  acknowledgeRecoveredLegacyGhosts,
  getLegacyGhostRecoveryStatus,
  hasLegacyOwnerNamespaceClaim,
  listLegacyOwnerProjectionRoots,
  listLegacyGhostPluginSources,
  listLegacyGhostTombstoneRoots,
  recoverLegacyGhostPlugins,
} from '../ownerNamespaceMigration.js';
import {
  LEGACY_GHOST_RECOVERY_RETRY_CHANNEL,
  LEGACY_GHOST_RECOVERY_STATUS_CHANNEL,
  createLegacyGhostRecoveryIpcHandlers,
} from './legacyGhostRecoveryIpc.js';
import type { LegacyGhostRecoveryStatus } from '../../shared/legacyGhostRecovery.js';
import { isDataOwnerPushStamp, type DataOwnerPushStamp } from '../../shared/dataOwnerPush.js';

/**
 * 意识仓库的进程级单例 + IPC 注册。
 *
 * channel 约定(前缀 ghosts:):
 * - list (sendSync):renderer 首帧同步拉已装意识清单 —— 意识面板要和内置
 *   面板同帧注册进布局引擎,禁止「先渲染缺面板的布局再补」(设计规范规则 7),
 *   与 layout:get 同模式。目录扫描极小,同步读不卡启动。
 * - install (invoke):装入本地 .cindy 文件;失败按分类 throwIpcError。
 * - uninstall (invoke):按 id 卸下。
 * - setup-status (invoke):按 id 判定配置就绪度(插件页「使用」前置门,
 *   判定真身 ghostSetupStatus.ts;未装 NOT_FOUND)。
 * - changed (main → renderer 广播):全量已装清单,多窗口热更新。
 */

const log = createLogger('brain');

/** Attach the main-owned data-owner boundary to ghost UI pushes. */
function getGhostOwnerPushStamp(): DataOwnerPushStamp | undefined {
  try {
    return getActiveDataOwnerPushStamp();
  } catch {
    // Tests and very early bootstrap may not have an app-session store yet.
    return undefined;
  }
}

function isSameGhostOwnerStamp(a: DataOwnerPushStamp, b: DataOwnerPushStamp): boolean {
  return a.dataOwnerId === b.dataOwnerId && a.ownerGeneration === b.ownerGeneration;
}

function isGhostOwnerStampCurrent(ownerStamp: DataOwnerPushStamp | undefined): boolean {
  if (ownerStamp === undefined) return true;
  const current = getGhostOwnerPushStamp();
  return current !== undefined && isSameGhostOwnerStamp(ownerStamp, current);
}

function sendGhostWindowPush(
  window: BrowserWindow,
  channel: string,
  payload: unknown,
  ownerStamp?: DataOwnerPushStamp,
): void {
  sendGhostContentsPush(window.webContents, channel, payload, ownerStamp);
}

function sendGhostContentsPush(
  contents: WebContents,
  channel: string,
  payload: unknown,
  ownerStamp?: DataOwnerPushStamp,
): void {
  if (ownerStamp !== undefined && !isGhostOwnerStampCurrent(ownerStamp)) return;
  const stamp = ownerStamp ?? getGhostOwnerPushStamp();
  // The initial pre-auth bootstrap has no meaningful boundary yet. Keep the
  // old Electron call shape there; every committed owner carries a stamp.
  if (stamp === undefined || (stamp.dataOwnerId === null && stamp.ownerGeneration === 0)) {
    contents.send(channel, payload);
  } else {
    contents.send(channel, payload, stamp);
  }
}

function broadcastGhostWindowPush(
  channel: string,
  payload: unknown,
  ownerStamp?: DataOwnerPushStamp,
): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) sendGhostWindowPush(window, channel, payload, ownerStamp);
  }
}

function sendGhostTrustedWindowPush(
  channel: string,
  payload: unknown,
  ownerStamp?: DataOwnerPushStamp,
): number {
  let sent = 0;
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || !isTrustedAppRendererWindow(window)) continue;
    sendGhostWindowPush(window, channel, payload, ownerStamp);
    sent += 1;
  }
  return sent;
}

/**
 * 电子脑管子与 settingsHtml `/app-context` 共用,避免 region / locale 两条口径漂移。
 * dev 区域(第三系统身份,2026-07-20)对意识映射为 'cn':意识契约
 * GhostAppRegion 维持 cn|global 两值(FORGE_GUIDE §4.1 不变),dev 的行为
 * 语义本就归 cn 系,意识按区域选公开配置时应与 cn 同待遇。
 */
function currentGhostAppContext() {
  const region: GhostAppRegion = CURRENT_CINDY_REGION === 'global' ? 'global' : 'cn';
  return {
    ok: true as const,
    context: { region, locale: ghostAppContextLocale(getResolvedMainLocale()) },
  };
}

let managerSingleton: GhostManager | null = null;
let ghostSetupManifestTrackerSingleton: GhostSetupManifestTracker | null = null;

function getGhostSetupManifestTracker(): GhostSetupManifestTracker {
  if (!ghostSetupManifestTrackerSingleton) {
    ghostSetupManifestTrackerSingleton = new GhostSetupManifestTracker(
      getGhostSetupChangeBus(),
      isGhostAvailableForActiveSession,
    );
  }
  return ghostSetupManifestTrackerSingleton;
}

const ghostMutationCoordinator = new GhostMutationCoordinator();

/**
 * Capture the stable owner before a mutation performs any asynchronous
 * preparation that cannot safely hold a lease (for example, user approval).
 */
function captureGhostMutationOwner(): ActiveAppSession {
  if (isAppSessionBoundaryPending()) {
    throw new Error('账号切换中，已取消本次 Plugin 操作');
  }
  return getActiveAppSession();
}

/**
 * Acquire a lease for a market/local Ghost filesystem mutation. When an owner
 * was captured before asynchronous preparation, generation equality prevents
 * a completed account switch from turning a stale approval into a mutation for
 * the new owner. New leases also fail closed while a boundary is still active.
 */
function beginGhostMutation(expectedOwner?: ActiveAppSession): () => void {
  if (isAppSessionBoundaryPending()) {
    throw new Error('账号切换中，已取消本次 Plugin 操作');
  }
  const currentOwner = getActiveAppSession();
  if (expectedOwner) {
    if (
      currentOwner.mode !== expectedOwner.mode ||
      currentOwner.dataOwnerId !== expectedOwner.dataOwnerId ||
      currentOwner.generation !== expectedOwner.generation
    ) {
      throw new Error('账号已切换，已取消本次 Plugin 操作');
    }
  }
  return ghostMutationCoordinator.acquire();
}

/** MCP calls hold the same owner lease across setup, grant confirmation, and dispatch. */
export function captureGhostMutationOwnerForMcp(): ActiveAppSession {
  return captureGhostMutationOwner();
}

export function acquireGhostMutationLeaseForMcp(expectedOwner: ActiveAppSession): () => void {
  return beginGhostMutation(expectedOwner);
}

function isSameAppSession(a: ActiveAppSession, b: ActiveAppSession): boolean {
  return a.mode === b.mode && a.dataOwnerId === b.dataOwnerId && a.generation === b.generation;
}

const ghostOwnerScope: GhostOwnerScope = {
  capture: () => captureGhostMutationOwner(),
  isCurrent: (scope) =>
    !!scope && isSameAppSession(scope as ActiveAppSession, getActiveAppSession()),
  isStable: (scope) =>
    !!scope
    && !isAppSessionBoundaryPending()
    && isSameAppSession(scope as ActiveAppSession, getActiveAppSession()),
  onInvalidated: (ghostId) => {
    try {
      getGhostRuntime().stop(ghostId);
    } catch (error) {
      log.warn('stale Ghost owner runtime stop failed', {
        ghostId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
};

function currentLegacyGhostMigrationSession(): {
  mode: ActiveAppSession['mode'];
  dataOwnerId: string | null;
  user: { id: string } | null;
} {
  const session = getActiveAppSession();
  return {
    mode: session.mode,
    dataOwnerId: session.dataOwnerId,
    user: session.mode === 'cloud' && session.dataOwnerId ? { id: session.dataOwnerId } : null,
  };
}

function getLegacyGhostRecoveryStatusForActiveSession(): LegacyGhostRecoveryStatus {
  const ownerId = getActiveAppSession().dataOwnerId;
  const excludedBuiltinIds =
    ownerId === null
      ? new Set<string>()
      : new Set(
          listLegacyGhostTombstoneRoots(ownerId, app.getPath('userData')).flatMap((root) => {
            try {
              return readBuiltinTombstones(root);
            } catch (err) {
              // 一份损坏的 legacy .builtin-provisioning.json 不能打死整个恢复入口(状态查询
              // 与重试都经此)。降级为"该根无墓碑"并记录;漏掉的 builtin 排除仍由 backfill 的
              // isTrustedBundledId 闸兜底,不会因此把随包 id 误迁 —— 对齐 ghosts:builtin-status
              // 的降级语义,而不是让 recovery UI 整体不可用(§5 恢复入口必须可用)。
              log.warn('legacy builtin tombstone root unreadable during recovery status; treated as empty', {
                root,
                error: err instanceof Error ? err.message : String(err),
              });
              return [] as string[];
            }
          }),
        );
  const reservedBuiltinCommands = new Set(
    listEligibleBuiltinCommands(
      builtinSeedRootDirs(),
      currentProvisionIdentity(),
      excludedBuiltinIds,
      log,
    ),
  );
  return getLegacyGhostRecoveryStatus(
    currentLegacyGhostMigrationSession(),
    undefined,
    isAppSessionBoundaryPending(),
    {
      reservedCommands: reservedBuiltinCommands,
      rejectReservedIds: shouldRejectReservedGhostIds(app.isPackaged),
    },
  );
}

async function retryLegacyGhostRecoveryForActiveSession(): Promise<LegacyGhostRecoveryStatus> {
  const expectedOwner = captureGhostMutationOwner();
  if (expectedOwner.mode !== 'cloud' || !expectedOwner.dataOwnerId) {
    return getLegacyGhostRecoveryStatusForActiveSession();
  }
  const initialStatus = getLegacyGhostRecoveryStatusForActiveSession();
  if (!initialStatus.canRetry) return initialStatus;
  if (initialStatus.deferredReason === 'legacy-discovery-incomplete') return initialStatus;

  const releaseMutation = beginGhostMutation(expectedOwner);
  try {
    const shouldAbort = (): boolean =>
      isAppSessionBoundaryPending() || !isSameAppSession(expectedOwner, getActiveAppSession());
    if (shouldAbort()) return getLegacyGhostRecoveryStatusForActiveSession();
    const authorizedStatus = getLegacyGhostRecoveryStatusForActiveSession();
    if (!authorizedStatus.canRetry) return authorizedStatus;
    if (authorizedStatus.deferredReason === 'legacy-discovery-incomplete') return authorizedStatus;

    const existingGhosts = getGhostManager().list();
    const existingGhostById = new Map(existingGhosts.map((ghost) => [ghost.manifest.id, ghost]));
    const existingGhostDirs = new Map(
      existingGhosts.map((ghost) => [ghost.manifest.id, ghost.dir]),
    );
    type StoppedActiveGhost = {
      ghost: InstalledGhost;
      browserRuntimeRunning: boolean;
      nodeRuntimeRunning: boolean;
    };
    const stoppedActiveGhosts = new Map<string, StoppedActiveGhost>();
    const legacySources = listLegacyGhostPluginSources(
      expectedOwner.dataOwnerId,
      app.getPath('userData'),
    );
    const excludedBuiltinIds = new Set(
      listLegacyGhostTombstoneRoots(expectedOwner.dataOwnerId, app.getPath('userData')).flatMap(
        (root) => readBuiltinTombstones(root),
      ),
    );
    const reservedBuiltinCommands = new Set(
      listEligibleBuiltinCommands(
        builtinSeedRootDirs(),
        currentProvisionIdentity(),
        excludedBuiltinIds,
        log,
      ),
    );
    for (const source of legacySources) {
      const activeDir = existingGhostDirs.get(source.id);
      if (activeDir !== undefined && path.resolve(activeDir) !== path.resolve(source.dir)) continue;
      const browserRuntimeRunning = getGhostRuntime().stateOf(source.id) === 'running';
      const nodeRuntimeRunning = getGhostNodeRuntimeBroker().stateOf(source.id) === 'running';
      getGhostRuntime().stop(source.id);
      getGhostNodeRuntimeBroker().stop(source.id);
      const activeGhost = existingGhostById.get(source.id);
      if (activeGhost) {
        stoppedActiveGhosts.set(source.id, {
          ghost: activeGhost,
          browserRuntimeRunning,
          nodeRuntimeRunning,
        });
      }
    }
    const restoreGhostRuntimes = (ghost: InstalledGhost, stopped: StoppedActiveGhost): void => {
      spawnIfResident(ghost);
      if (
        stopped.browserRuntimeRunning &&
        ghost.manifest.launch !== 'resident' &&
        isGhostAvailableForActiveSession(ghost.manifest.id) &&
        ghost.enabled
      ) {
        void getGhostRuntime()
          .spawn(ghost)
          .catch((error) =>
            log.warn('recovery on-demand ghost spawn error', {
              id: ghost.manifest.id,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
      }
      if (
        stopped.nodeRuntimeRunning &&
        ghost.manifest.node?.lifecycle !== 'resident' &&
        isGhostAvailableForActiveSession(ghost.manifest.id) &&
        ghost.enabled
      ) {
        void getGhostNodeRuntimeBroker()
          .startForRecovery(ghost)
          .catch((error) =>
            log.warn('recovery on-demand ghost node spawn error', {
              id: ghost.manifest.id,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
      }
    };
    const restartStoppedActiveGhosts = (): void => {
      for (const stopped of stoppedActiveGhosts.values()) {
        restoreGhostRuntimes(stopped.ghost, stopped);
      }
    };
    let result;
    try {
      result = await recoverLegacyGhostPlugins(
        {
          mode: 'cloud',
          dataOwnerId: expectedOwner.dataOwnerId,
          user: { id: expectedOwner.dataOwnerId },
        },
        undefined,
        {
          shouldAbort,
          reservedCommands: reservedBuiltinCommands,
          rejectReservedIds: shouldRejectReservedGhostIds(app.isPackaged),
        },
      );
    } catch (error) {
      if (!shouldAbort()) restartStoppedActiveGhosts();
      throw error;
    }
    if (shouldAbort()) return getLegacyGhostRecoveryStatusForActiveSession();
    if (
      result.moved === 0 &&
      !result.provisioningStateMoved &&
      !result.recoveredIds?.length
    ) {
      restartStoppedActiveGhosts();
      return getLegacyGhostRecoveryStatusForActiveSession();
    }
    if (result.moved > 0 || result.provisioningStateMoved || result.recoveredIds?.length) {
      brainRootCache = null;
      const restoredBeforeReconcile = getGhostManager().list();
      const movedGhostIds = new Set<string>();
      for (const ghost of restoredBeforeReconcile) {
        const previousDir = existingGhostDirs.get(ghost.manifest.id);
        if (previousDir !== undefined && path.resolve(previousDir) !== path.resolve(ghost.dir)) {
          movedGhostIds.add(ghost.manifest.id);
          getGhostRuntime().stop(ghost.manifest.id);
          getGhostNodeRuntimeBroker().stop(ghost.manifest.id);
        }
      }
      // 只有 owner recovery 在 rename 前写入并在本轮确认的 durable marker 才能进入
      // receipt backfill。不能从安装根扫描结果推断“刚搬入”，否则同一时间窗内由其他
      // 写者放入的无 receipt 目录会被当成 legacy 事实自动铸造批准。
      const recoveredLegacyIds = [...(result.recoveredIds ?? [])];
      if (recoveredLegacyIds.length > 0) {
        try {
          const expectedApprovalProjectionSha256ById =
            result.recoveredApprovalProjectionSha256ById ?? {};
          const backfill = await getGhostManager().backfillRecoveredLegacyGhosts(
            recoveredLegacyIds,
            {
              includePending: true,
              expectedApprovalProjectionSha256ById,
            },
          );
          const pending = new Set(backfill.pending ?? []);
          const failed = new Set(backfill.failed);
          await acknowledgeRecoveredLegacyGhosts(
            expectedOwner.dataOwnerId,
            recoveredLegacyIds.filter((id) => !pending.has(id) && !failed.has(id)),
          );
        } catch (err) {
          log.warn('recovered legacy ghost backfill pass failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const builtinReconcileSucceeded =
        result.deferredReason !== 'concurrent-live-instances' &&
        (await scheduleBuiltinReconcile('legacy-recovery')) === 'completed';
      if (shouldAbort()) return getLegacyGhostRecoveryStatusForActiveSession();
      const ghosts = getGhostManager().list();
      for (const ghost of ghosts) {
        const previousDir = existingGhostDirs.get(ghost.manifest.id);
        const relocatedExistingGhost =
          movedGhostIds.has(ghost.manifest.id) ||
          (previousDir !== undefined && path.resolve(previousDir) !== path.resolve(ghost.dir));
        if (relocatedExistingGhost) ensureGhostProtocolRegistered(ghost);
        const stopped = stoppedActiveGhosts.get(ghost.manifest.id);
        if (relocatedExistingGhost && stopped) {
          restoreGhostRuntimes(ghost, stopped);
        } else if (builtinReconcileSucceeded && previousDir === undefined) {
          spawnIfResident(ghost);
        }
      }
      broadcastGhostsChanged(ghosts);
    }
    return getLegacyGhostRecoveryStatusForActiveSession();
  } finally {
    releaseMutation();
  }
}

/** Wait until all owner-bound Ghost filesystem mutations have finished. */
export function waitForGhostMutations(): Promise<void> {
  return ghostMutationCoordinator.waitForIdle();
}

/** Account-managed built-ins are unavailable outside a verified cloud session. */
export function isGhostAvailableForActiveSession(id: string): boolean {
  if (isAppSessionBoundaryPending()) return false;
  return !isCindyAccountGhostId(id) || getAppCapabilities().canUseCindyAccountServices;
}

/** Live Host capability gate shared by Agent transports and Renderer IPC. */
export function getIOSSimulatorPluginAccessDecision(
  workingDir: string | null = null,
) {
  return resolveIOSSimulatorPluginAccess(getGhostManager().list(), workingDir, {
    isAvailableForActiveSession: isGhostAvailableForActiveSession,
    isDisabledForWorkdir: isGhostDisabledForWorkdir,
  });
}

function availableGhosts(): InstalledGhost[] {
  if (isAppSessionBoundaryPending()) return [];
  return getGhostManager().list().filter((ghost) =>
    isGhostAvailableForActiveSession(ghost.manifest.id),
  );
}

function projectGhostForRenderer(ghost: InstalledGhost): InstalledGhost {
  try {
    const runtimeManifest = withRuntimeFiloGoogleClient(ghost.manifest);
    const oauthManager = getGhostOauthAccountManager();
    const expiredAccountCount = (runtimeManifest.network?.secrets ?? []).reduce(
      (count, secret) =>
        secret.source === 'oauth' && secret.oauth
          ? count +
            oauthManager.clientMigrationExpiredAccountCount(runtimeManifest.id, secret.key)
          : count,
      0,
    );
    const suggest = getGhostOauthReauthSuggest(runtimeManifest);
    return {
      ...ghost,
      ...(expiredAccountCount > 0
        ? { oauthAuthorizationExpired: { expiredAccountCount } }
        : {}),
      ...(suggest
        ? {
            oauthScopeStale: {
              secretKey: suggest.secretKey,
              missingScopeCount: suggest.missingScopeCount,
            },
          }
        : {}),
    };
  } catch (error) {
    // OAuth 展示投影是提示面，保险库异常不能让插件清单整体消失。
    log.warn('ghost oauth renderer projection omitted', {
      ghostId: ghost.manifest.id,
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return ghost;
  }
}

function findAvailableGhost(id: string): InstalledGhost | null {
  return availableGhosts().find((ghost) => ghost.manifest.id === id) ?? null;
}

/** Runtime-authorized lookup for integrations outside this module. */
export function findAvailableGhostForAuthorization(id: string): InstalledGhost | null {
  return findAvailableGhost(id);
}

export function listAvailableGhostsForAuthorization(): InstalledGhost[] {
  return availableGhosts();
}

function requireGhostAvailableForActiveSession(id: string): void {
  if (!isGhostAvailableForActiveSession(id)) {
    if (isAppSessionBoundaryPending()) {
      throwIpcError(
        'PRECONDITION_FAILED',
        'Plugin owner is switching; retry after the boundary settles.',
      );
    }
    throwIpcError('PERMISSION_DENIED', 'This Plugin requires a Cindy account.');
  }
}

/** Stop any account-managed sandbox before an auth/data-owner boundary switch. */
export function suspendCindyAccountGhosts(): void {
  if (!runtimeSingleton) return;
  for (const id of CINDY_ACCOUNT_GHOST_IDS) runtimeSingleton.stop(id);
}

/**
 * Cancel owner-bound calls before waiting for their mutation leases.
 *
 * The lease itself stays held until each call unwinds, so attachment grants,
 * setup writes, and post-dispatch cleanup cannot cross into the next owner.
 */
export async function interruptGhostCallsForAccountBoundary(): Promise<void> {
  cancelActiveGhostOauthFlow();
  getGhostSetupInteractionBridge()?.cleanupAll('session_aborted');
  getGhostGrantConfirmBridge()?.cleanupAll('session_aborted');
  getGhostConfirmDialogBridge()?.cancelAll();
  getForgeOidcInstallConfirmBridge()?.cancelAll();
  runtimeSingleton?.destroyAll();
  resetNodeRuntimeBrokerForAccountBoundary();
  // Library 会话一并作废:关 db worker + 作废 handle——在途写入已在串行链上
  // 归属原 owner 完成或随 vault.invalidate 作废,新 owner 解析到全新根。
  await getGhostLibrarySlot().disposeAll();
  if (libraryExtraDirSync) {
    await libraryExtraDirSync(null).catch((error) => {
      log.warn('library extraDirs owner-boundary sync failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  await getGhostSetupCoordinator()?.waitForActionsIdle();
}

function listGhostOwnerProjectionRoots(): string[] {
  const activeOwnerRoot = ownerScopedUserDataPath();
  return [...new Set([
    path.join(activeOwnerRoot, 'brain'),
    path.join(activeOwnerRoot, 'cindy-brain'),
    path.join(activeOwnerRoot, 'ghost-install-state'),
    ...listLegacyOwnerProjectionRoots(app.getPath('userData')),
  ])];
}

/** Stop every sandbox and revoke global skill projections before changing the active data owner. */
export async function suspendAllGhosts(): Promise<void> {
  runtimeSingleton?.destroyAll();
  resetNodeRuntimeBrokerForAccountBoundary();
  brainRootCache = null;
  const skillCleanup = await removeGhostSkillLinksForRoots(listGhostOwnerProjectionRoots());
  for (const warning of skillCleanup.warnings) {
    log.warn('ghost owner skill cleanup warning', { warning });
  }
  if (skillCleanup.blockers.length > 0) {
    for (const blocker of skillCleanup.blockers) {
      log.error('ghost owner skill cleanup blocked account boundary', { blocker });
    }
    throw new Error(`ghost owner skill cleanup incomplete (${skillCleanup.blockers.length})`);
  }
}
let ipcRegistered = false;

/** 意识仓库根(userData/cindy-brain;旧 brain 目录首次解析时原地迁移)。 */
let brainRootCache: GhostRepoRootCacheEntry | null = null;
function brainRootDir(): string {
  brainRootCache = resolveCachedGhostRepoRoot(
    brainRootCache,
    activeOwnerScopeKey(),
    {
      userDataDir: ownerScopedUserDataPath(),
      exists: (p) => fs.existsSync(p),
      rename: (from, to) => fs.renameSync(from, to),
      log,
    },
  );
  return brainRootCache.rootDir;
}

/**
 * 内置意识种子根目录列表(第一方可信通道,随包分发的源码目录形态):
 * - dev:仓库 apps/desktop/resources/builtin-ghosts(appPath = apps/desktop);
 * - packaged:process.resourcesPath/builtin-ghosts(forge extraResource 原样拷入)。
 * 2026-07-22 起种子源拆为两个 submodule 仓,分别挂载在 builtin-ghosts 下:
 * official(cindy-official-plugin)与 xd(cindy-xd-plugin),各自带一份
 * provisioning.json。submodule 未初始化 = 对应根为空,播种层按半初始化保护
 * 处理(见 builtinGhostProvisioner 头注释)。双平台无差异(纯 path.join)。
 */
function builtinSeedRootDirs(): string[] {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'builtin-ghosts')
    : path.join(app.getAppPath(), 'resources', 'builtin-ghosts');
  return [path.join(base, 'official'), path.join(base, 'xd')];
}

function isTrustedBundledSource(id: string, sourceDir: string): boolean {
  return isTrustedBuiltinSeedSource(builtinSeedRootDirs(), id, sourceDir);
}

/**
 * Forge scaffold/pack 绝不允许写入的 Host 受管根:安装内容根 + 批准状态根(来自
 * `managedRootDirs()`)+ **随包 seed 根**。seed 根漏在外面时,把 `.cindy` 产物写进
 * seed 目录会翻转播种指纹,下次启动触发整目录重播种(B-4);seed 根与内容/状态根
 * 物理不相交,不在 `managedRootDirs()` 内,必须在此显式并入。
 */
export function ghostForgeForbiddenRootDirs(): string[] {
  return [...getGhostManager().managedRootDirs(), ...builtinSeedRootDirs()];
}

function hasDisabledMarker(dir: string): boolean {
  try {
    fs.lstatSync(path.join(dir, '.disabled'));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true;
  }
}

/** 当前登录身份 → 播种受众判定的输入(登出 = null)。 */
function currentProvisionIdentity(): ProvisionIdentity | null {
  const state = getAuthState();
  if (!state.isAuthenticated || !state.user) return null;
  return {
    userId: state.user.id,
    email: state.user.email,
  };
}

/**
 * 内置意识对账的串行链：统一由 stable-owner post-commit/ensure 入口调度，
 * 所有触发共用一条 promise 链，
 * 保证任意时刻只有一个 reconcile 在跑(登录抖动 / 快速切号不并发写盘)。
 * 单次失败吞掉并 warn(下次触发重试),链永不断。
 */
let builtinReconcileChain: Promise<void> = Promise.resolve();

type BuiltinReconcileOutcome = 'completed' | 'deferred' | 'failed' | 'retry-pending';
interface BuiltinReconcileScope {
  scopeKey: string;
  dataOwnerId: string | null;
}

let stableOwnerPostCommitTask:
  ((reason: string, scope: BuiltinReconcileScope) => Promise<BuiltinReconcileOutcome>) | null =
  null;

/** Run the Plugin post-commit pipeline registered during Ghost IPC bootstrap. */
export function runStableOwnerPostCommitTask(
  reason: string,
  scope: BuiltinReconcileScope,
): Promise<BuiltinReconcileOutcome> {
  return stableOwnerPostCommitTask?.(reason, scope) ?? Promise.resolve('deferred');
}

/**
 * 本会话内因「撤销陈旧批准」被熄灯的常驻随包插件 id。
 *
 * 撤销路径的四连熄灯会把正在跑的常驻实例停掉;后一轮对账把批准补回来时,原判
 * (#1080)是不自动重启 —— 那时缺少"用户此刻想让它跑"的信号。但对**本会话内被
 * 我们自己熄掉**的常驻声明插件,重启只是恢复熄灯前的既有状态,不是新决策;常驻
 * 声明本身就是"启用即应运行"的意思(启动扫描无条件点火)。范围刻意收窄:只记
 * 本会话、只记常驻声明、点火仍走 spawnIfResident(它自查启用态与会话可用性,
 * 停用的插件不会被点亮)。
 */
const quenchedResidentBuiltinIds = new Set<string>();

function scheduleBuiltinReconcile(
  reason: string,
  expectedScope: BuiltinReconcileScope = {
    scopeKey: activeOwnerScopeKey(),
    dataOwnerId: getActiveAppSession().dataOwnerId,
  },
): Promise<BuiltinReconcileOutcome> {
  const scheduled = builtinReconcileChain
    .catch((err) => {
      log.warn('builtin ghost activation error; reconcile chain resumed', {
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .then(async () => {
      const activeSession = getActiveAppSession();
      if (
        activeOwnerScopeKey() !== expectedScope.scopeKey ||
        activeSession.dataOwnerId !== expectedScope.dataOwnerId
      ) {
        log.info('builtin ghost reconcile skipped: stale owner scope', { reason });
        return 'deferred' as const;
      }
      try {
        return await reconcileBuiltinGhosts(reason, expectedScope.dataOwnerId);
      } catch (err) {
        log.warn('builtin ghost reconcile error', {
          reason,
          error: err instanceof Error ? err.message : String(err),
        });
        return 'failed' as const;
      }
    });
  builtinReconcileChain = scheduled.then(() => undefined);
  return scheduled;
}

/**
 * 内置意识改名台账([旧 id, 新 id]):播种器的孤儿回收负责"旧包收走、新包
 * 装上",这里驱动存量数据迁移(历史卡片归属 / KV 偏好)。改完名的条目长期
 * 保留——老设备可能隔很多版本才升级,迁移必须一直在场。
 */
const RENAMED_BUILTIN_GHOSTS: ReadonlyArray<readonly [string, string]> = [
  ['cindy-mivo', 'xd-mivo'], // 2026-07-13 更名 XD Mivo
  ['cindy-feishu', 'xd-feishu'], // 2026-07-16 更名 XD Feishu(企业档)
];

/**
 * 内置意识退役台账(整包下线、无接替 id)。种子目录删除后播种器的孤儿回收
 * 只负责"包收走",不清用户数据 —— 这里补上 uninstall 同款的三连清理:
 * safeStorage 凭证(OAuth 账号/refresh token)、ghost-kv 偏好、fs 槽私有
 * 目录。每轮对账幂等执行,长期保留(老设备可能隔很多版本才升级)。
 */
const RETIRED_BUILTIN_GHOSTS: readonly string[] = [
  'cindy-slack', // 2026-07-19 退役:Slack 能力并轨 hook 通道(cindy_slack 网关工具)
];

/** 退役意识的存量用户数据清理(uninstall 三连的对账版;全程 best-effort)。 */
function cleanupRetiredGhostData(id: string): void {
  try {
    removeGhostSecrets(id);
  } catch (err) {
    log.warn('retired ghost secret cleanup failed', {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  for (const target of [
    ownerScopedUserDataPath('ghost-kv', `${id}.json`),
    ownerScopedUserDataPath('ghost-fs', id),
  ]) {
    try {
      if (!fs.existsSync(target)) continue;
      fs.rmSync(target, { recursive: true, force: true });
      log.info('retired ghost data removed', { id, target });
    } catch (err) {
      log.warn('retired ghost data cleanup failed', {
        id,
        target,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * 改名 KV 搬家:userData/ghost-kv/<旧id>.json → <新id>.json(新 id 名下已有
 * 内容则不覆盖;旧文件保留作回滚余地)。文件级操作,best-effort。
 */
function migrateGhostKvOnRename(fromId: string, toId: string): void {
  try {
    const dir = ownerScopedUserDataPath('ghost-kv');
    const fromFile = path.join(dir, `${fromId}.json`);
    const toFile = path.join(dir, `${toId}.json`);
    if (!fs.existsSync(fromFile) || fs.existsSync(toFile)) return;
    fs.copyFileSync(fromFile, toFile);
    log.info('ghost kv migrated after builtin rename', { fromId, toId });
  } catch (err) {
    log.warn('ghost kv migrate failed', {
      fromId,
      toId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 单轮对账:一次性 legacy 迁移 → 播种 → (有变化时)广播 + 首装停靠 + 常驻点火。 */
async function reconcileBuiltinGhosts(
  reason: string,
  dataOwnerId: string | null,
): Promise<BuiltinReconcileOutcome> {
  // 整轮对账(迁移 backfill + 播种换目录 + 批准 receipt 写入)都是 owner 绑定的
  // 文件系统写路径,但 GhostManager/ReceiptStore 的根目录是**每次调用现解析**的:
  // 异步 hash/copy 中途账号切换落定,后半段写入就会漏进新 owner 的状态根(拿 A 的
  // 安装目录字节给 B 的同 id 插件铸批准)。与市场装入同一套约束:开工前捕获 owner、
  // 全程持 mutation 租约(账号 teardown 会等租约),边界期一律整轮跳过 —— 对账是
  // 幂等的；下一次 stable-owner post-commit/ensure 会补上。
  let releaseMutation: () => void;
  try {
    releaseMutation = beginGhostMutation(captureGhostMutationOwner());
  } catch {
    log.info('builtin ghost reconcile skipped: app session boundary', { reason });
    return 'deferred';
  }
  let migrationNeedsRetry = false;
  try {
    const manager = getGhostManager();
    if (dataOwnerId !== null) {
      // 存量插件迁移必须先于播种与授权消费:#1080 之前装的插件没有 receipt,这里从旧安装
      // 布局 backfill 出等价批准,让它们升级后无感可用(docs §5 红线)。signed-out 的
      // no-session 根只承载本进程的 account-free bundled 投影,绝不扫描或确认 legacy
      // 安装事实。迁移自己取事务锁,因此必须在下面 runExclusiveMutation **之外**调用。
      try {
        const migration = await manager.migrateLegacyApprovalsOnce();
        migrationNeedsRetry =
          migration.retryPending.length > 0 || manager.hasPendingLegacyApprovalMigration();
      } catch (err) {
        migrationNeedsRetry = true;
        // 迁移整体失败(如状态根不可写)不能挡住播种与后续对账:随包插件仍要能装/更新,
        // 存量插件保持 fail-closed(列停用、走恢复 UI),下一轮启动再尝试迁移。
        log.warn('legacy ghost approval migration pass failed', {
          reason,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const approvalNeedsRetry = await manager.runExclusiveMutation((mutation) =>
      reconcileBuiltinGhostsLocked(reason, dataOwnerId, manager, mutation),
    );
    migrationNeedsRetry ||= approvalNeedsRetry;
  } finally {
    releaseMutation();
  }
  return migrationNeedsRetry ? 'retry-pending' : 'completed';
}

async function reconcileBuiltinGhostsLocked(
  reason: string,
  dataOwnerId: string | null,
  manager: GhostManager,
  mutation: GhostExclusiveMutation,
): Promise<boolean> {
  // 改名前置:用户自主状态(墓碑=卸载过 / .disabled=停用)随改名带到新 id,
  // 不能让"明确卸载/停用过"的用户在升级后被以新 id 重新装上并点亮(播种器
  // "用户自主权豁免"支柱)。墓碑:旧 id 有 → 给新 id 记墓碑并清掉旧墓碑
  // (旧种子已不随包,旧墓碑是死数据;清掉也避免用户日后手动恢复新 id 时被
  // 本处反复重新盖墓)。停用态:抓在播种前(孤儿回收会删旧目录),装上后补。
  const renameDisabledCarry = new Map<string, boolean>();
  if (dataOwnerId !== null) {
    for (const [fromId, toId] of RENAMED_BUILTIN_GHOSTS) {
      if (renameBuiltinTombstone(brainRootDir(), fromId, toId, log)) {
        log.info('builtin ghost tombstone carried over rename', { fromId, toId });
      }
      renameDisabledCarry.set(
        toId,
        hasDisabledMarker(path.join(brainRootDir(), fromId)),
      );
    }
  }
  // "播种进行中"胶囊提示:只在真的动手(装/覆盖/回收)时亮起,no-op 对账
  // 不闪(onApplyStart 整轮至多一次);结束广播放 finally,异常也不留悬挂提示。
  let tipShown = false;
  let outcome: Awaited<ReturnType<typeof provisionBuiltinGhosts>>;
  try {
    outcome = await provisionBuiltinGhosts({
      seedRootDirs: builtinSeedRootDirs(),
      repoRootDir: brainRootDir(),
      identity: currentProvisionIdentity(),
      // 回收先熄灯沙箱再删目录(Windows 文件锁:运行中的电子脑可能占着句柄)。
      beforeRemove: async (id) => {
        getGhostRuntime().stop(id);
        getGhostNodeRuntimeBroker().stop(id);
        getGhostAgentSlot().clearGhost(id);
        getGhostErrandSlot().clearGhost(id);
        // 内置回收也必须走 Host 的 uninstall journal；只撤 receipt 再由
        // provisioner 直接 rm 会在 receipt 删除失败+崩溃时留下孤立批准。
        const removal = await mutation.uninstall(id, {
          notify: false,
          // Audience/orphan reconciliation is Host lifecycle cleanup, not a
          // durable user choice to keep this builtin uninstalled.
          recordBuiltinTombstone: false,
        });
        if ('rejection' in removal) {
          throw new Error(`builtin ghost uninstall failed: ${removal.rejection.reason}`);
        }
      },
      beforeReplace: async (id) => {
        // Revoke the old receipt before swapping mutable installed bytes. If a
        // crash occurs during provisioning, the new bytes cannot run under the
        // previous approval; the next reconcile mints a receipt from the
        // immutable seed after the swap is complete.
        if (!(await mutation.removeInstallApproval(id))) {
          throw new Error(`builtin ghost approval revoke failed: ${id}`);
        }
      },
      publishSeed: (id, seedDir, options) =>
        mutation.publishTrustedBundledSeed(id, seedDir, options),
      onApplyStart: () => {
        tipShown = true;
        broadcastGhostProvisioning(true);
      },
      log,
    });
  } finally {
    if (tipShown) broadcastGhostProvisioning(false);
  }
  // 内置意识改名的存量迁移(每轮无条件跑,两个操作都幂等:UPDATE 查无旧行
  // no-op、KV 有"目标已存在即跳过"守卫——不吃"改名落地那一轮"的一次性触发
  // 窗口,首轮失败/中途退出下轮自愈):历史卡片归属改挂新 id(老卡 chip 与
  // 交互按钮按 ghostId 找主,不迁全废)+ KV 偏好搬家。密钥零迁移(官方别名
  // 映射到底层同一存储键);媒体账本旧引用保留(历史聊天图继续可读,新任务
  // 在新 id 名下重新记账)。
  if (dataOwnerId !== null) {
    for (const [fromId, toId] of RENAMED_BUILTIN_GHOSTS) {
      void reassignGhostCards(fromId, toId).catch((err) =>
        log.warn('ghost card reassign failed', {
          fromId,
          toId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      migrateGhostKvOnRename(fromId, toId);
    }
    // 退役插件的凭证、KV 与 fs 槽都是 owner 私有数据；signed-out 不得借
    // no-session 临时命名空间替任何真实 owner 做清理。
    for (const retiredId of RETIRED_BUILTIN_GHOSTS) {
      cleanupRetiredGhostData(retiredId);
    }
    // 改名停用态补挂:新 id 本轮首装且旧 id 此前处于停用 → 新目录补 .disabled
    // (播种首装默认启用,这里还原用户选择;放在广播/停靠之前,清单首帧即正确)。
    for (const manifest of outcome.installed) {
      if (!renameDisabledCarry.get(manifest.id)) continue;
      try {
        mutation.writeDisabledMarker(manifest.id);
        log.info('builtin ghost disabled state carried over rename', { id: manifest.id });
      } catch (err) {
        log.warn('builtin ghost disabled carry failed', {
          id: manifest.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  let approvalChanged = false;
  let approvalNeedsRetry = outcome.retryPending === true;
  const healedResidentIds: string[] = [];
  for (const manifest of outcome.approved) {
    try {
      approvalChanged =
        (await mutation.approveTrustedBundledInstall(
          manifest,
          // `.disabled` 镜像的读数只作停用方向的输入:receipt 已钉停用时,镜像被
          // 外部移除不会把插件翻回启用(合并规则见 approveTrustedBundledInstall
          // 头注释;重新启用只有用户显式 setEnabled 一条路)。
          !hasDisabledMarker(path.join(brainRootDir(), manifest.id)),
          { sourceDir: outcome.approvedSourceDirs[manifest.id] },
        )) || approvalChanged;
      // 本会话内被撤销熄灯的常驻实例,批准补回即恢复点火(隔离态下批准必然重写,
      // approvalChanged 已为 true,不会被下面的 no-op 早退拦住)。
      if (quenchedResidentBuiltinIds.delete(manifest.id)) {
        healedResidentIds.push(manifest.id);
      }
    } catch (err) {
      approvalNeedsRetry = true;
      // 走到这里内容目录可能已经换成新种子字节，旧 receipt 却还是授权事实 ——
      // 留着它就是拿旧批准跑新代码(新版删掉的 slot 仍被授予、版本与技能快照
      // 也停在旧 revision)。
      //
      // removeInstallApproval 的契约是"返回后该插件一定不再被授权运行":删得掉就
      // 删 receipt，删不掉(状态根不可写 —— 与这里写批准失败同一个成因)就转进程内
      // 隔离。所以这里不需要、也不应该再自己判断撤销成不成功:那正是上一版在
      // cleanup 失败时留下 fail-open 的地方。随包插件下一轮启动对账会重新补批准，
      // 自愈，不需要用户介入。
      await mutation.removeInstallApproval(manifest.id);
      // 撤销只让后续的 Host 能力调用与技能落链失效,不会自己结束已经跑起来的沙箱
      // 进程 —— 登录触发对账时插件可能正在运行。与 beforeRemove 同款四连熄灯
      // (含 errand slot:漏掉它会让节流状态与在途任务记录留到同会话的自愈之后,
      // 变成不必要的 rate-limit／"已有在途任务"阻塞),让"撤销后不再被授权运行"
      // 这句话对运行中的实例也成立。
      getGhostRuntime().stop(manifest.id);
      getGhostNodeRuntimeBroker().stop(manifest.id);
      getGhostAgentSlot().clearGhost(manifest.id);
      getGhostErrandSlot().clearGhost(manifest.id);
      // 常驻声明的实例被本次撤销熄掉:记下 id,批准自愈那一轮补点火(见 set 头注释)。
      if (manifest.launch === 'resident' || manifest.node?.lifecycle === 'resident') {
        quenchedResidentBuiltinIds.add(manifest.id);
      }
      approvalChanged = true;
      log.warn('builtin ghost approval receipt failed; approval revoked', {
        id: manifest.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (
    outcome.installed.length === 0 &&
    outcome.updated.length === 0 &&
    outcome.removed.length === 0 &&
    !approvalChanged
  ) {
    return approvalNeedsRetry;
  }
  log.info('builtin ghost reconcile applied changes', {
    reason,
    installed: outcome.installed.map((m) => m.id),
    updated: outcome.updated.map((m) => m.id),
    removed: outcome.removed,
    approvalChanged,
  });
  // 播种绕过 manager 写盘,广播由这里补上(renderer 首帧 sendSync 早于对账
  // 完成时,靠 ghosts:changed 热更新兜底,多窗口同一套通道)。
  // 对账跑完 = 一次完整扫描,清单权威(见 broadcastGhostsChanged 的说明)。
  broadcastGhostsChanged(manager.list(), true);
  // 首装的意识停进布局树(与 installAndDock 同一套停靠逻辑;覆盖更新 id 未变,
  // 布局位置天然保留,不动树;回收不动树 —— 与 uninstall 口径一致,位置记录
  // 由布局引擎保留)。
  const store = getLayoutStore();
  for (const manifest of outcome.installed) {
    const docked = layoutWithGhostPanel(store.getLayout(), manifest);
    if (docked) {
      const applied = store.setLayout(docked);
      if ('rejection' in applied) {
        log.warn('builtin ghost panel dock rejected', {
          id: manifest.id,
          reason: applied.rejection,
        });
      }
    }
    // 登录触发的对账装上常驻意识时,这里就是它的点火时机(启动那趟扫描早过了)。
    const ghost = manager.list().find((g) => g.manifest.id === manifest.id);
    if (ghost) spawnIfResident(ghost);
  }
  // 本会话内被撤销熄灯、本轮批准自愈的常驻插件:恢复熄灯前的运行状态。
  // spawnIfResident 自查启用态与会话可用性,停用/不可用的不会被点亮。
  for (const id of healedResidentIds) {
    const ghost = manager.list().find((g) => g.manifest.id === id);
    if (ghost) spawnIfResident(ghost);
  }
  return approvalNeedsRetry;
}

export function getGhostManager(): GhostManager {
  if (!managerSingleton) {
    managerSingleton = new GhostManager({
      getRootDir: brainRootDir,
      getStateDir: () => ownerScopedUserDataPath('ghost-install-state'),
      getOwnerContextKey: activeOwnerScopeKey,
      onChanged: broadcastGhostsChanged,
      getLocale: getResolvedMainLocale,
      trustRegistry: loadGhostTrustRegistry(),
      // 随包批准入口的 builtin-only 边界:id 必须对应一颗随包种子。该入口不经用户
      // 确认就铸出批准,不能只靠"唯一调用者是随包对账"这条纪律。
      isTrustedBundledId: (id) => listBuiltinSeedIds(builtinSeedRootDirs()).includes(id),
      isTokenBrokerAuthorized: (manifest) =>
        isGhostTokenBrokerAuthorized(manifest.id, 'install'),
      isTrustedBundledSource,
      recordBuiltinTombstone: (id) => recordBuiltinTombstone(brainRootDir(), id, log),
      clearBuiltinTombstone: (id) => clearBuiltinTombstone(brainRootDir(), id, log),
      log,
    });
    getGhostSetupManifestTracker().seed(managerSingleton.list());
  }
  return managerSingleton;
}

/**
 * 发布者/审核公钥信任表随 Cindy 版本发布，只有公钥没有私钥。坏文件降级为空表：
 * 发布者签名仍会验包完整性，但不会显示“已验证/已审核”。
 */
function loadGhostTrustRegistry(): GhostTrustRegistry {
  const trustPath = app.isPackaged
    ? path.join(process.resourcesPath, 'ghost-trust.json')
    : path.join(app.getAppPath(), 'resources', 'ghost-trust.json');
  try {
    const raw = JSON.parse(fs.readFileSync(trustPath, 'utf8')) as Record<string, unknown>;
    const readKeys = (value: unknown): NonNullable<GhostTrustRegistry['publishers']> => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
      const out: NonNullable<GhostTrustRegistry['publishers']> = {};
      for (const [keyId, entry] of Object.entries(value as Record<string, unknown>)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const item = entry as Record<string, unknown>;
        if (typeof item.name !== 'string' || typeof item.publicKey !== 'string') continue;
        out[keyId] = { name: item.name, publicKey: item.publicKey };
      }
      return out;
    };
    return {
      publishers: readKeys(raw.publishers),
      reviewers: readKeys(raw.reviewers),
    };
  } catch (err) {
    log.warn('ghost trust registry unavailable; signed publishers stay unverified', {
      trustPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

/** 仅供 main 出网/OAuth 链使用；不要把补过 client 的 manifest 广播给 renderer。 */
function withRuntimeFiloGoogleClient(manifest: GhostManifest): GhostManifest {
  return withFiloGoogleBuildClientConfig(manifest, {
    clientId: process.env.XDT_FILO_GOOGLE_CLIENT_ID,
    clientSecret: process.env.XDT_FILO_GOOGLE_CLIENT_SECRET,
  });
}

let runtimeSingleton: GhostRuntime | null = null;

/**
 * 意识运行时单例:芯片型意识的沙箱进程生命周期。
 * 熔断(60s 内 3 崩)→ 自动转沉睡(setEnabled false),用户在设置页看到
 * 唤醒开关被关掉,重新打开即 resetFuse 重获新生。
 */
export function getGhostRuntime(): GhostRuntime {
  if (!runtimeSingleton) {
    runtimeSingleton = new GhostRuntime({
      adapter: electronSandboxAdapter,
      log,
      // 熔断不再自动转沉睡(Lizi 2026-07-09 定案):面板原地显示错误状态,
      // 关闭(沉睡)/ 重载都由用户在面板上决定,主机只记日志。
      onFused: (id) => log.warn('ghost fused after repeated crashes', { id }),
      onStateChanged: (id, state) => {
        log.info('ghost runtime state', { id, state });
        // 崩溃/熄灯时把该意识名下的在途工具调用收掉(结构化失败给 agent)。
        getGhostPipeDispatcher().onRuntimeState(id, state);
        broadcastGhostRuntimeStates();
      },
    });
  }
  return runtimeSingleton;
}

let dispatcherSingleton: GhostPipeDispatcher | null = null;

/**
 * 管子工具派发器单例:ghost 总机(cindy-tools)的 callGhostTool 真身。
 * deps 全部懒取现查——装/卸/唤醒/沉睡即时反映(网关模式的"现查现报"承诺
 * 从总机一路贯穿到派发器)。
 */
export function getGhostPipeDispatcher(): GhostPipeDispatcher {
  if (!dispatcherSingleton) {
    dispatcherSingleton = new GhostPipeDispatcher({
      getGhost: findAvailableGhost,
      ownerScope: ghostOwnerScope,
      runtimeStateOf: (id) => getGhostRuntime().stateOf(id),
      spawn: async (ghost) => {
        const r = await getGhostRuntime().spawn(ghost);
        return r.ok ? { ok: true } : { ok: false, reason: r.reason };
      },
      sendToGhost: (ghostId, payload) => sendToGhostLogic(ghostId, payload),
      log,
    });
  }
  return dispatcherSingleton;
}

export function hasPendingGhostCalls(ghostId: string): boolean {
  return getGhostPipeDispatcher().hasPendingCallsFor(ghostId);
}

let agentSlotSingleton: GhostAgentSlot | null = null;

/** Agent 新回合槽单例：一次性点击票、后台权限与模板替换的统一守门点。 */
export function getGhostAgentSlot(): GhostAgentSlot {
  if (!agentSlotSingleton) {
    agentSlotSingleton = new GhostAgentSlot({
      getGhost: findAvailableGhost,
      log,
    });
  }
  return agentSlotSingleton;
}

/** maker-ipc 完成初始化后注入真实会话 runner；保持 cindy-brain 不反向依赖它。 */
export function setGhostAgentTurnRunner(runner: GhostAgentTurnRunner | null): void {
  getGhostAgentSlot().setRunner(runner);
}

/** maker-ipc 完成初始化后注入「切到这条可见任务」；保持 cindy-brain 不反向依赖 deepLink。 */
export function setGhostSessionRevealer(reveal: ((sessionId: string) => void) | null): void {
  getGhostAgentSlot().setRevealSession(reveal);
  getGhostErrandSlot().setRevealSession(reveal);
}

let errandSlotSingleton: GhostErrandSlot | null = null;

/** 派活取件槽单例(agent 槽 errand 加档):资格审/频控/任务表的统一守门点。 */
export function getGhostErrandSlot(): GhostErrandSlot {
  if (!errandSlotSingleton) {
    errandSlotSingleton = new GhostErrandSlot({
      getGhost: findAvailableGhost,
      // wait 模式的署名单在途期间替管子那头的 tool-call 续命(同 cindy 槽契约)。
      holdPipeCall: (ghostId, callId, budgetMs) =>
        getGhostPipeDispatcher().holdCall(ghostId, callId, budgetMs),
      releasePipeCall: (ghostId, callId) => getGhostPipeDispatcher().releaseCall(ghostId, callId),
      consumeUserActionToken: (token, ghostId) =>
        getGhostAgentSlot().consumeUserActionToken(token, ghostId),
      log,
    });
  }
  return errandSlotSingleton;
}

export function hasRunningGhostErrand(ghostId: string): boolean {
  return getGhostErrandSlot().hasActiveErrandFor(ghostId);
}

export function hasRunningGhostCindyWork(ghostId: string): boolean {
  return getGhostCindySlot().hasInflightWorkFor(ghostId);
}

/** maker-ipc 完成初始化后注入真实派活 runner;传 null 用于退出清理。 */
export function setGhostErrandRunner(runner: GhostErrandRunner | null): void {
  getGhostErrandSlot().setRunner(runner);
}

/** 宿主确认的面板/卡片点击。派活只在这之后才切任务。 */
export function noteGhostUserGesture(ghostId: string): void {
  getGhostErrandSlot().noteUserGesture(ghostId);
}

/** 插件展示名(errand 会话默认标题等宿主侧使用;未装返回 null)。 */
export function getInstalledGhostName(id: string): string | null {
  return findAvailableGhost(id)?.manifest.name ?? null;
}

let nodeRuntimeBrokerSingleton: GhostNodeRuntimeBroker | null = null;
let nodeRuntimeStartAttemptContextReader: (() => NodeRuntimeStartAttemptContext) | null = null;
const nodeRuntimeAppRunId = (() => {
  try {
    return randomUUID().replaceAll('-', '');
  } catch {
    return 'unknown';
  }
})();

/** Desktop bootstrap 注入主窗/系统的粗粒度只读快照；不注册额外全局监听。 */
export function setGhostNodeRuntimeStartAttemptContextReader(
  reader: (() => NodeRuntimeStartAttemptContext) | null,
): void {
  nodeRuntimeStartAttemptContextReader = reader;
}

/**
 * `GhostNodeRuntimeBroker.destroyAll()` is a terminal host-exit operation. An
 * account boundary still needs the old broker terminally stopped so delayed
 * retries cannot cross owners, but the singleton slot must then be cleared so
 * the next owner gets a fresh, startable broker.
 */
function resetNodeRuntimeBrokerForAccountBoundary(): void {
  const broker = nodeRuntimeBrokerSingleton;
  if (!broker) return;
  broker.destroyAll();
  if (nodeRuntimeBrokerSingleton === broker) nodeRuntimeBrokerSingleton = null;
}

/** 随包 Node 工作进程单例：每个活跃插件一个进程，main.js 经主机中继调用。 */
export function getGhostNodeRuntimeBroker(): GhostNodeRuntimeBroker {
  if (!nodeRuntimeBrokerSingleton) {
    nodeRuntimeBrokerSingleton = new GhostNodeRuntimeBroker({
      getGhost: findAvailableGhost,
      ownerScope: ghostOwnerScope,
      readSecret: (ghostId, secretKey) => readGhostSecret(ghostId, secretKey),
      sendToGhost: (ghostId, payload) => {
        sendToGhostLogic(ghostId, payload);
      },
      getStartAttemptContext: () =>
        nodeRuntimeStartAttemptContextReader?.() ?? {
          observedMainWindowState: 'unknown',
          observedScreenState: 'unknown',
        },
      appRunId: nodeRuntimeAppRunId,
      log,
    });
  }
  return nodeRuntimeBrokerSingleton;
}

/** 意识聊天卡片更新推送通道(main → 全窗口 renderer;ghostCardStore 消费)。 */
export const GHOST_CARD_UPDATED_CHANNEL = 'ghosts:card-updated';

/** 意识后台活动(会话呼吸)推送通道(main → 全窗口 renderer;
 *  ghostSessionActivityStore 消费,载荷 { sessionId, busy })。 */
export const GHOST_SESSION_ACTIVITY_CHANNEL = 'ghosts:session-activity';

let sessionActivityTrackerSingleton: GhostSessionActivityTracker | null = null;

/**
 * 意识后台活动跟踪器单例:card-action 派发即亮呼吸,card-update 的 state
 * 声明 / TTL 静默超时熄呼吸(0↔1 转变才广播)。
 */
export function getGhostSessionActivityTracker(): GhostSessionActivityTracker {
  if (!sessionActivityTrackerSingleton) {
    sessionActivityTrackerSingleton = new GhostSessionActivityTracker({
      broadcast: (sessionId, busy) => {
        broadcastGhostWindowPush(GHOST_SESSION_ACTIVITY_CHANNEL, { sessionId, busy });
      },
      log,
    });
  }
  return sessionActivityTrackerSingleton;
}

let cardServiceSingleton: GhostCardService | null = null;

/**
 * 卡片供片服务单例(卡槽③):校验链 + 净化 + 落库 + 推送的装配点。
 * deps 全部懒取现查(与派发器同纪律):卸载/沉睡后的供片即时被拒。
 */
export function getGhostCardService(): GhostCardService {
  if (!cardServiceSingleton) {
    cardServiceSingleton = new GhostCardService({
      hasCardSlot: (ghostId) => {
        const g = findAvailableGhost(ghostId);
        return !!g && g.enabled && g.manifest.card !== undefined;
      },
      sanitize: sanitizeGhostCardHtml,
      persist: (row) => upsertGhostCard(row),
      broadcast: (payload) => {
        broadcastGhostWindowPush(GHOST_CARD_UPDATED_CHANNEL, payload);
      },
      // 重开态(card-action 后台干活)的供片驱动会话呼吸:working/未声明续期,
      // done 熄灭(TTL 兜底在跟踪器内)。
      onActivity: ({ callId, sessionId, state }) =>
        getGhostSessionActivityTracker().noteCardUpdate(callId, sessionId, state),
      log,
    });
  }
  return cardServiceSingleton;
}

let cardActionDispatcherSingleton: GhostCardActionDispatcher | null = null;

/** 交互卡(v2)按钮点击派发器单例:归属查证(内存卡服务→持久卡库兜底)+
 *  唤醒 + 管子下发 card-action。wake/sendToGhost/isRunning 与订阅网关同源。 */
export function getGhostCardActionDispatcher(): GhostCardActionDispatcher {
  if (!cardActionDispatcherSingleton) {
    cardActionDispatcherSingleton = new GhostCardActionDispatcher({
      resolveLiveInfo: (callId) => getGhostCardService().callInfoOf(callId),
      resolvePersistedCard: async (callId) => {
        const c = await getGhostCard(callId);
        return c ? { ghostId: c.ghostId, sessionId: c.sessionId ?? null } : null;
      },
      reopenForAction: (callId, info) => getGhostCardService().reopenForAction(callId, info),
      getGhost: findAvailableGhost,
      isRunning: (id) => getGhostRuntime().stateOf(id) === 'running',
      wake: async (ghost) => {
        const r = await getGhostRuntime().spawn(ghost);
        if (!r.ok) throw new Error(r.reason);
      },
      sendToGhost: (ghostId, payload) => {
        if (!sendToGhostLogic(ghostId, payload)) {
          throw new Error('ghost pipe send failed');
        }
      },
      issueUserActionToken: (ghostId, sessionId) =>
        getGhostAgentSlot().issueUserActionToken(ghostId, sessionId),
      // 呼吸起点:点击成功投递即把该会话标为"意识活动中"(结束由 card-update
      // state / TTL 收口)。
      onActivityStart: (key, sessionId) => getGhostSessionActivityTracker().begin(key, sessionId),
      now: () => Date.now(),
      ownerScope: ghostOwnerScope,
      log,
    });
  }
  return cardActionDispatcherSingleton;
}

/* ── 订阅槽①(旁听 + 拦截)装配点 ──────────────────────────────────── */

/** 钩子熔断通知通道(main → 全窗口 renderer;toast 提示用)。 */
export const GHOST_HOOK_FUSED_CHANNEL = 'ghosts:hook-fused';
/** 用户消息被拦通知通道(main → 全窗口 renderer;气泡原地降级用)。 */
export const GHOST_MESSAGE_BLOCKED_CHANNEL = 'ghosts:user-message-blocked';
/** 用户消息被意识钩子改写通知通道(main → 全窗口 renderer;气泡静默换文本,v1 无留痕标记)。 */
export const GHOST_MESSAGE_REWRITTEN_CHANNEL = 'ghosts:user-message-rewritten';
/** AI 回复被 will-assistant-message 出口钩子改写通知(main → renderer;气泡静默换文本)。 */
export const GHOST_ASSISTANT_REWRITTEN_CHANNEL = 'ghosts:assistant-message-rewritten';
/** 出口钩子后台处理中/完成的轻指示(main → renderer;回复已显示、意识还在跑那段)。
 *  render(自绘卡)不另设通道:卡片经 GHOST_CARD_UPDATED_CHANNEL(callId = 该
 *  assistant 消息 clientId)推达,renderer 见 byCallId 出现该键即判定气泡被自绘替换。 */
export const GHOST_ASSISTANT_PENDING_CHANNEL = 'ghosts:assistant-message-pending';

let subscriptionGatewaySingleton: GhostSubscriptionGateway | null = null;

/**
 * 订阅网关单例(卡槽①):did- 旁听扇出与 will- 拦截裁决的装配点。
 * deps 全部懒取现查(与派发器同纪律):装卸/启停即时反映。
 */
export function getGhostSubscriptionGateway(): GhostSubscriptionGateway {
  if (!subscriptionGatewaySingleton) {
    subscriptionGatewaySingleton = new GhostSubscriptionGateway({
      listGhosts: availableGhosts,
      isRunning: (id) => getGhostRuntime().stateOf(id) === 'running',
      wake: async (ghost) => {
        const r = await getGhostRuntime().spawn(ghost);
        if (!r.ok) throw new Error(r.reason);
      },
      sendToGhost: (ghostId, payload) => {
        // 适配:底层返回 false 表示投递失败(网关契约是抛错 → 走缓冲/熔断)。
        if (!sendToGhostLogic(ghostId, payload)) {
          throw new Error('ghost pipe send failed');
        }
      },
      now: () => Date.now(),
      onHookFused: (ghost, ownerStamp) => {
        broadcastGhostWindowPush(
          GHOST_HOOK_FUSED_CHANNEL,
          {
            ghostId: ghost.manifest.id,
            name: ghost.manifest.name,
          },
          isDataOwnerPushStamp(ownerStamp) ? ownerStamp : undefined,
        );
      },
      ownerScope: ghostOwnerScope,
      log,
    });
  }
  return subscriptionGatewaySingleton;
}

/**
 * 会话是否在订阅事件的投递范围。默认只允许非 Orca 用户主任务；session-switch
 * 额外允许已归一后的 Orca Lead，行级判定见 subscriptionGateway。
 * outcome 三值:eligible / ineligible(查到行且明确不合格,可终身缓存)/
 * retry(DB 未就绪、查询抛错、行还没落库——都是暂时态,调用方稍后重试;
 * 2026-07-12 实测:启动期会话接线早于 DbClient 就绪,一次性判定会把
 * 所有重连会话终身误杀)。
 */
async function isGhostEligibleSession(
  sessionId: string,
  scope: 'default' | 'session-switch' = 'default',
): Promise<
  | { outcome: 'eligible'; agentKind?: string; workdir?: string }
  | { outcome: 'ineligible' }
  | { outcome: 'retry' }
> {
  try {
    // 查询必须 await(DB 走 worker-thread 异步代理,全仓惯用法),不能用
    // 同步 .all()——代理下拿不到真实行(2026-07-12 实测踩坑)。
    const rows = await getDbClient()
      .drizzle.select({
        source: localDbSchema.sessions.source,
        orcaRole: localDbSchema.sessions.orcaRole,
        agentKind: localDbSchema.sessions.agentKind,
        workingDir: localDbSchema.sessions.workingDir,
      })
      .from(localDbSchema.sessions)
      .where(eq(localDbSchema.sessions.id, sessionId))
      .limit(1);
    const row = rows[0];
    if (!row) return { outcome: 'retry' }; // 行未落库(极早期)→ 暂时态
    const isEligible =
      scope === 'session-switch'
        ? isGhostSessionSwitchEligibleRow(row)
        : isGhostEligibleSessionRow(row);
    if (isEligible) {
      return {
        outcome: 'eligible',
        agentKind: row.agentKind ?? undefined,
        workdir: row.workingDir ?? undefined,
      };
    }
    log.debug('ghost eligibility: rejected', {
      sessionId,
      source: String(row.source),
      orcaRole: String(row.orcaRole),
    });
    return { outcome: 'ineligible' };
  } catch (err) {
    // DB 未就绪等基建失败:暂时态,绝不终身定性(也绝不影响会话)。
    log.debug('ghost eligibility: transient failure, will retry', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { outcome: 'retry' };
  }
}

type PendingActivityRequest = {
  kind: GhostInteractionActivityKind;
  requestId: string;
};

/**
 * 会话事件 tap 工厂(register.ts wireSessionToIpc 对每个新会话叠加一个
 * onEvent 监听):把 AgentEvent 折叠成 did-turn-* 发进网关。
 * - 只投用户主会话(desktop、非 orca;资格 DB 现查,判定期事件小缓冲回放);
 * - 自动化轮次(turnOrigin 非 user)不投——hook-control 后台会话由此天然滤除;
 * - interaction 侧同样只投用户 Desktop 面(见 GhostTurnOriginTracker):非 desktop
 *   route 直接挡掉,route 缺省时按事件流上记下的轮次来源挡掉 goal / scheduler。
 *
 * 拆线必须调 `dispose()`:register.ts 的 disposer 一跑,事件源就没了,turn 在场时
 * 只有这里能给插件补上缺失的 did-turn-end(见 GhostTurnTranslator.dispose)。
 */
export function createGhostSessionTap(sessionId: string): {
  handleEvent(ev: MinimalAgentEvent & { turnOrigin?: { kind?: string } }): void;
  interactionObserver: {
    onStart(request: PendingActivityRequest, route?: { origin?: { kind?: string } }): void;
    onEnd(request: PendingActivityRequest, route?: { origin?: { kind?: string } }): void;
  };
  dispose(): void;
} {
  let translator: GhostTurnTranslator | null = null;
  let activity: GhostActivityTracker | null = null;
  /** 拆线不可逆:资格判定是异步的,回调必须知道自己已经没有归属会话了。 */
  let disposed = false;
  // 资格判定**惰性化 + 可重试**:接线发生在启动重连期,DbClient 可能还没
  // 就绪——判定挪到第一个事件到达时(用户已在交互,DB 必然可用);暂时性
  // 失败(retry)不定性,下个事件再试,封顶后放弃(防怪会话反复打 DB)。
  let state: 'unknown' | 'resolving' | 'eligible' | 'ineligible' = 'unknown';
  // 轮次来源:interaction 侧只靠 route 判断不住 goal / scheduler(它们没 route),
  // 得从事件流上记。语义与理由见 GhostTurnOriginTracker。资格无关,恒记。
  const origin = new GhostTurnOriginTracker();
  let attempts = 0;
  const MAX_ATTEMPTS = 5;
  const MAX_PENDING = 32;
  // 有界缓冲,溢出丢最旧(留下的是到达序后缀,不留孤儿 start),语义见 GhostTapPendingQueue。
  const pending = new GhostTapPendingQueue(MAX_PENDING, () => {
    log.warn('ghost session tap pending overflow while resolving eligibility', {
      sessionId,
      cap: MAX_PENDING,
    });
  });

  const applyActivity = (phase: 'start' | 'end', request: PendingActivityRequest): void => {
    if (!activity) {
      pending.push({ type: 'activity', phase, request });
      return;
    }
    if (phase === 'start') activity.startInteraction(request.kind, request.requestId);
    else activity.endInteraction(request.kind, request.requestId);
  };

  const kickResolve = (): void => {
    if (state !== 'unknown') return;
    if (attempts >= MAX_ATTEMPTS) {
      state = 'ineligible';
      pending.clear();
      return;
    }
    state = 'resolving';
    attempts += 1;
    void isGhostEligibleSession(sessionId).then((info) => {
      // 判定期间会话已拆线:不建 translator、不回放,否则会向已经没人配对的
      // topic 发出一条永远等不到 end 的 did-turn-start。
      if (disposed) return;
      if (info.outcome === 'retry') {
        state = 'unknown'; // 暂时态:留着 pending,下个事件再试
        return;
      }
      if (info.outcome === 'ineligible') {
        state = 'ineligible';
        pending.clear();
        return;
      }
      const gw = getGhostSubscriptionGateway();
      activity = new GhostActivityTracker({
        sessionId,
        sink: { activity: (name, data) => gw.publish('activity', name, data) },
      });
      translator = new GhostTurnTranslator({
        sessionId,
        agent: info.agentKind ?? 'unknown',
        now: () => Date.now(),
        sink: {
          turnStart: (d) => {
            gw.publish('turn', 'did-turn-start', d);
            activity?.beginTurn();
          },
          turnEnd: (d) => {
            activity?.finishTurn();
            gw.publish('turn', 'did-turn-end', d);
          },
        },
      });
      state = 'eligible';
      // 先取快照再回放:applyActivity 在 activity 已就绪后直投,不会再回队。
      const replay = pending.drain();
      log.debug('ghost session tap eligible', {
        sessionId,
        replay: replay.length,
        ...(pending.dropped > 0 ? { droppedPending: pending.dropped } : {}),
      });
      for (const item of replay) {
        if (item.type === 'event') {
          activity.handleEvent(item.event);
          translator.handleEvent(item.event);
        } else {
          applyActivity(item.phase, item.request);
        }
      }
    });
  };

  return {
    handleEvent(ev) {
      if (disposed) return;
      // 记来源要在过滤**之前**:自动化轮次的事件正是"当前轮次不是用户发起"的唯一线索。
      origin.noteEvent(ev);
      if (ev.turnOrigin?.kind && ev.turnOrigin.kind !== 'user') return;
      if (state === 'eligible') {
        activity?.handleEvent(ev);
        translator?.handleEvent(ev);
        return;
      }
      if (state === 'ineligible') return;
      pending.push({
        type: 'event',
        event: {
          type: ev.type,
          data: ev.data,
          source: ev.source,
          ...(ev.turnContinuationId !== undefined
            ? { turnContinuationId: ev.turnContinuationId }
            : {}),
        },
      });
      kickResolve();
    },
    interactionObserver: {
      onStart(request, route) {
        if (state === 'ineligible') return;
        if (!origin.acceptsInteraction(route)) return;
        applyActivity('start', request);
        if (state !== 'eligible') kickResolve();
      },
      onEnd(request, route) {
        if (state === 'ineligible') return;
        void route; // 见 acceptsInteraction 注释:end 只按 requestId 配对,不过滤来源
        applyActivity('end', request);
        if (state !== 'eligible') kickResolve();
      },
    },
    dispose() {
      if (disposed) return; // 两条 disposer 路径都可能跑到,补发只做一次
      disposed = true;
      // 补发都会走插件分发链路,它们的异常不能打断 register.ts 的 disposer 队列
      // (实例替换路径是裸调用,后面还排着 onEvent 退订),也不能让 activity 侧的
      // 失败吃掉 turn 侧的补发,所以两段各自兜住。
      const guard = (stage: string, fn: () => void): void => {
        try {
          fn();
        } catch (err) {
          log.warn('ghost session tap dispose failed', {
            sessionId,
            stage,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };
      // 先收口 activity 再收口 turn:会话关闭 / Session 实例替换时,router 里可能还有
      // interaction 等在 finally 前,而 observer 马上就会被摘掉——不补发 end 插件就会
      // 永久停在"等待审批 / 等待用户输入"。顺序也是契约:未收口的 thinking end 必须
      // 排在 did-turn-end 之前(回合边界只收口 thinking——审批可以跨回合终态,
      // 见 GhostActivityTracker)。
      guard('activity', () => activity?.finishAll());
      guard('turn', () => translator?.dispose());
      activity?.reset();
      translator = null;
      activity = null;
      pending.clear();
      state = 'ineligible';
    },
  };
}

/**
 * 用户消息拦截筛查(input coordinator 的 screenUserMessage 依赖真身)。
 * 快路径:没有任何启用意识声明钩子 → 零开销放行(不查 DB 不进网关),
 * 绝大多数用户走这条。任何异常收敛为放行(fail-open),绝不卡发送热路径。
 */
/**
 * 是否装有**启用中**的 will-user-message 拦截意识(纯本地判定,不触发钩子)。
 *
 * 调用方(自动起名)据此决定要不要把用户原话送去标题模型:那是一次独立的 AI 发送,
 * 而拦截钩的全部意义就是不让某些内容到达 AI。这里只问"有没有人在管",不重复询问
 * 钩子本身 —— 重复询问会让 Ghost 对同一条消息被问两次,产生它没预期的副作用。
 */
export function hasEnabledUserMessageHookGhost(): boolean {
  try {
    return availableGhosts().some(
      (g) => g.enabled && g.manifest.subscribe?.hooks?.includes('will-user-message'),
    );
  } catch {
    // 判定不了就按"有人在管"处理:宁可少一个智能标题,也不把内容送出去。
    return true;
  }
}

export async function screenGhostUserMessage(
  sessionId: string,
  text: string,
): Promise<GhostScreenResult> {
  const ownerStamp = getGhostOwnerPushStamp();
  try {
    const hasHookGhost = availableGhosts().some(
      (g) => g.enabled && g.manifest.subscribe?.hooks?.includes('will-user-message'),
    );
    if (!hasHookGhost) return { action: 'allow' };
    // retry(DB 未就绪)也放行:拦截是尽力而为的旁路,fail-open 不挡发送。
    if ((await isGhostEligibleSession(sessionId)).outcome !== 'eligible')
      return { action: 'allow' };
    const result = await getGhostSubscriptionGateway().screenUserMessage(
      { sessionId, text },
      ownerStamp,
    );
    return isGhostOwnerStampCurrent(ownerStamp) ? result : { action: 'allow' };
  } catch (err) {
    log.warn('ghost screen failed (fail-open)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { action: 'allow' };
  }
}

/** 被拦通知广播(register.ts 的 onUserMessageBlocked 依赖真身)。
 *  text = 被拦原文:会话忙时消息只以队列灰字存在、没有乐观气泡,renderer
 *  找不到既有 clientId 就得靠它补渲一条被拦气泡——否则排队消息被拦就是
 *  "凭空蒸发"。 */
export function broadcastGhostMessageBlocked(payload: {
  sessionId: string;
  clientId: string;
  ghostId: string;
  ghostName: string;
  reason: string;
  text: string;
}): void {
  broadcastGhostWindowPush(GHOST_MESSAGE_BLOCKED_CHANNEL, payload);
}

/** 改写通知广播(register.ts 的 onUserMessageRewritten 依赖真身)。
 *  renderer 据此把气泡正文静默换成改写版(v1 无留痕标记,所见即送给 AI 的);
 *  text = 改写后正文,originalText = 用户原文(v1 renderer 不消费,留给
 *  后续留痕迭代,广播协议先带上避免届时改协议)。 */
export function broadcastGhostMessageRewritten(payload: {
  sessionId: string;
  clientId: string;
  ghostId: string;
  ghostName: string;
  text: string;
  originalText: string;
}): void {
  broadcastGhostWindowPush(GHOST_MESSAGE_REWRITTEN_CHANNEL, payload);
}

/** 是否有启用的意识声明了 will-assistant-message(出口钩子快路径同步守卫)。 */
export function hasEnabledGhostAssistantHook(): boolean {
  return availableGhosts().some(
    (g) => g.enabled && g.manifest.subscribe?.hooks?.includes('will-assistant-message'),
  );
}

/** 广播:AI 回复被出口钩子改写(renderer 气泡静默换文本)。 */
function broadcastGhostAssistantRewritten(
  payload: {
    sessionId: string;
    clientId: string;
    ghostId: string;
    ghostName: string;
    text: string;
  },
  ownerStamp?: DataOwnerPushStamp,
): void {
  broadcastGhostWindowPush(GHOST_ASSISTANT_REWRITTEN_CHANNEL, payload, ownerStamp);
}

/** 广播:出口钩子后台处理中/完成的轻指示。 */
function broadcastGhostAssistantPending(
  sessionId: string,
  clientId: string,
  pending: boolean,
  ownerStamp?: DataOwnerPushStamp,
): void {
  broadcastGhostWindowPush(
    GHOST_ASSISTANT_PENDING_CHANNEL,
    { sessionId, clientId, pending },
    ownerStamp,
  );
}

/**
 * render 裁决落地:净化(同 card 槽海报规则)+ height clamp + 持久化(按 assistant
 * 消息 clientId 当 callId 存,复用 ghost_cards 与 renderer 的 byCallId 寻址)+ 广播
 * 卡片推送。原文已在库里,不动;renderer 据 GHOST_ASSISTANT_RENDERED_CHANNEL 切卡。
 */
async function applyGhostAssistantRenderCard(
  sessionId: string,
  clientId: string,
  card: { ghostId: string; ghostName: string; html: string; height?: number },
  ownerStamp?: DataOwnerPushStamp,
): Promise<void> {
  if (ownerStamp !== undefined && !isGhostOwnerStampCurrent(ownerStamp)) return;
  const sanitized = sanitizeGhostCardHtml(card.html);
  if (!sanitized.ok) {
    log.warn('ghost assistant render card rejected by sanitizer', {
      sessionId,
      reason: sanitized.reason,
    });
    return;
  }
  const heightRaw =
    typeof card.height === 'number' && Number.isFinite(card.height)
      ? Math.round(card.height)
      : GHOST_CARD_HEIGHT_DEFAULT;
  const height = Math.min(GHOST_CARD_HEIGHT_MAX, Math.max(GHOST_CARD_HEIGHT_MIN, heightRaw));
  const now = Date.now();
  // 落库失败不阻断广播(活卡先见;历史回放缺卡 renderer missing 降级)。
  await upsertGhostCard({
    callId: clientId,
    ghostId: card.ghostId,
    sessionId,
    html: sanitized.html,
    height,
    v: 1,
    updatedAt: now,
  }).catch((err) => {
    log.warn('ghost assistant render card persist failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  if (ownerStamp !== undefined && !isGhostOwnerStampCurrent(ownerStamp)) return;
  broadcastGhostWindowPush(
    GHOST_CARD_UPDATED_CHANNEL,
    {
      callId: clientId,
      ghostId: card.ghostId,
      toolUseId: null,
      html: sanitized.html,
      // 出口钩子自绘卡不含 running 动画版语义(turn 已结束),静态版即最终。
      animatedHtml: null,
      height,
      // turn 级自绘卡标记:renderer 只入卡库(byCallId,AssistantMessage 按消息
      // clientId 直取),**不进 liveCards 锚定池**——否则 toolUseId:null 的条目会
      // 被同意识进行中 ghost_call 的启发式锚定抢走(review P1,2026-07-13)。
      turnCard: true,
    },
    ownerStamp,
  );
}

/**
 * will-assistant-message 出口钩子入口(register.ts done 边界 fire-and-forget 调)。
 * 快路径 + eligibility + 网关裁决 + 落地(rewrite/render)全在独立续跑里,绝不
 * 阻塞 turn 结束记账;真实 deps 装配在此,核心编排在 assistantReplyHook.ts。
 * clientId = 本轮 assistant 消息持久化 id(consumeLastAssistantPersistId 取得)。
 */
export function runGhostAssistantReplyHook(
  sessionId: string,
  clientId: string,
  text: string,
): void {
  const ownerStamp = getGhostOwnerPushStamp();
  const isCurrent = () => isGhostOwnerStampCurrent(ownerStamp);
  void runAssistantReplyHook(
    {
      isCurrent,
      hasHook: hasEnabledGhostAssistantHook,
      isEligible: async (sid) =>
        isCurrent() && (await isGhostEligibleSession(sid)).outcome === 'eligible',
      screen: async (sid, t) => {
        if (!isCurrent()) return { action: 'allow' as const };
        const result = await getGhostSubscriptionGateway().screenAssistantMessage(
          { sessionId: sid, text: t },
          ownerStamp,
        );
        return isCurrent() ? result : { action: 'allow' as const };
      },
      persistRewrite: async (sid, cid, t) => {
        if (!isCurrent()) return;
        await updateMessageContent(sid, cid, t);
      },
      applyRenderCard: (sid, cid, cardArg) =>
        applyGhostAssistantRenderCard(sid, cid, cardArg, ownerStamp),
      broadcastRewritten: (payload) => broadcastGhostAssistantRewritten(payload, ownerStamp),
      setPending: (sid, cid, pending) =>
        broadcastGhostAssistantPending(sid, cid, pending, ownerStamp),
      log,
    },
    sessionId,
    clientId,
    text,
  );
}

/**
 * 会话生命周期事件入口(created/archived 由 localDb sessions handler 处
 * fire-and-forget 调;switched 由下方 noteGhostSessionFocused 去重后调):
 * → did-session-*。任何异常吞掉,绝不影响会话主流程。
 */
export function notifyGhostSessionEvent(
  kind: 'created' | 'archived' | 'switched',
  data: { sessionId: string; workdir?: string },
  shouldPublish: () => boolean | Promise<boolean> = () => true,
  onRetry: () => void = () => {},
): void {
  void (async () => {
    try {
      // 快路径:没人订 session topic 就不查 DB(纯内存判断,调用方零负担)。
      const hasSubscriber = availableGhosts().some(
        (g) => g.enabled && g.manifest.subscribe?.topics?.includes('session'),
      );
      if (!hasSubscriber) return;
      // created / archived 与 turn 事件同口径；switched 额外允许归一后的 Orca Lead。
      // retry 视为不投，生命周期事件不值得引入重试机制。
      const info = await isGhostEligibleSession(
        data.sessionId,
        kind === 'switched' ? 'session-switch' : 'default',
      );
      if (info.outcome !== 'eligible') {
        if (info.outcome === 'retry') onRetry();
        return;
      }
      // switched 的调用方(renderer 路由上报)只有 sessionId,workdir 从资格
      // 查询顺手补上,与 created/archived 的载荷形状对齐。
      const payload =
        data.workdir === undefined && info.workdir !== undefined
          ? { ...data, workdir: info.workdir }
          : data;
      // switched 在异步归一、资格查询完成后再确认一次焦点代次；确认与去重在同一步完成。
      if (!(await shouldPublish())) return;
      getGhostSubscriptionGateway().publish(
        'session',
        kind === 'created'
          ? 'did-session-created'
          : kind === 'archived'
            ? 'did-session-archived'
            : 'did-session-switched',
        payload,
      );
    } catch {
      /* 订阅事件是旁路,静默 */
    }
  })();
}

/**
 * 会话切换上报入口(renderer MainLayout 路由 effect 经 'ghosts:session-focused'
 * 调,平台无关):Worker 归一到 Lead 后发 did-session-switched。连续指向同一主任务 / 非会话页
 * (null)不发；切走再切回算新切换。原始焦点仍单独保留给旧 preview 缺省落点。
 */
const ghostPrimarySessionFocusTracker = createGhostPrimarySessionFocusTracker(
  (sessionId) =>
    resolveGhostPrimarySessionId(
      sessionId,
      getSessionRowSnapshot,
      async (workerSessionId) =>
        (await getTeamByWorkerSession(workerSessionId))?.leadSessionId ?? null,
    ),
  (sessionId, claim, releaseRaw) =>
    notifyGhostSessionEvent('switched', { sessionId }, claim, releaseRaw),
);
// 原始焦点只供 preview 使用；不能用它的 raw-id 去重阻断 primary tracker 的重试。
const ghostSessionFocusTracker = createGhostSessionFocusTracker(() => {});
export function noteGhostSessionFocused(sessionId: string | null): void {
  // 两个 tracker 都必须收到每次上报：raw tracker 负责 preview，primary tracker
  // 负责 Worker → Lead 归一、异步乱序和失败后的重试。
  ghostPrimarySessionFocusTracker.note(sessionId);
  ghostSessionFocusTracker.note(sessionId);
  void refreshMivoLibraryExtraDirGrant().catch((error) => {
    log.warn('library extraDirs focus sync failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

const ghostSessionFocusByWebContents = new Map<number, string | null>();
const ghostSessionFocusTrackedWebContents = new Set<number>();

function noteGhostWindowSessionFocused(sender: WebContents, sessionId: string | null): void {
  // Renderer route reports are not an authorization source. They may only
  // pause a stale active mutation grant when the window family moves away;
  // retained Viewer grants require Main/Host confirmation or focus to become
  // active again.
  const previous = ghostSessionFocusByWebContents.get(sender.id);
  if (previous !== sessionId) {
    syncIOSSimulatorRendererAccessForSessionChange(sender, sessionId);
    ghostSessionFocusByWebContents.set(sender.id, sessionId);
    if (!ghostSessionFocusTrackedWebContents.has(sender.id)) {
      ghostSessionFocusTrackedWebContents.add(sender.id);
      sender.once('destroyed', () => {
        ghostSessionFocusByWebContents.delete(sender.id);
        ghostSessionFocusTrackedWebContents.delete(sender.id);
      });
    }
  }
  // Keep forwarding same-id reports: the primary tracker may have cleared its
  // raw-id dedupe marker after a transient resolution failure and needs a retry.
  noteGhostSessionFocused(sessionId);
}

function mainShellWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (window) => !window.isDestroyed() && isMainShellWindowUrl(window.webContents.getURL()),
  );
}

function focusedIOSSimulatorContext(): IOSSimulatorSlotFocusContext | null {
  const candidates = mainShellWindows();
  const focused = BrowserWindow.getFocusedWindow();
  const focusedMainShell =
    focused && !focused.isDestroyed() && candidates.includes(focused) ? focused : null;
  // 主壳窗在前台时只认它自己的任务；它在非任务页时不能借用另一窗口的任务。
  const eligible = focusedMainShell
    ? [focusedMainShell]
    : candidates.filter((window) =>
        Boolean(getIOSSimulatorRendererSessionAccess(window.webContents)),
      );
  // 独立插件窗没有可信 opener/task 绑定；只有唯一候选时才允许回落，多窗歧义 fail closed。
  if (eligible.length !== 1) return null;
  const window = eligible[0]!;
  const access = getIOSSimulatorRendererSessionAccess(window.webContents);
  if (!access) return null;
  return {
    sessionId: access.sessionId,
    windowWebContentsId: window.webContents.id,
    revision: access.generation,
  };
}

function focusedIOSSimulatorAuthorizationCandidate(): {
  window: BrowserWindow;
  sessionHint: string;
} | null {
  const candidates = mainShellWindows();
  const focused = BrowserWindow.getFocusedWindow();
  const focusedMainShell =
    focused && !focused.isDestroyed() && candidates.includes(focused) ? focused : null;
  // If a detached plugin/sidebar window has focus, only a single main shell is
  // unambiguous. The renderer report below is an untrusted hint for the native
  // confirmation flow, never the resulting authorization context.
  const window = focusedMainShell ?? (candidates.length === 1 ? candidates[0]! : null);
  if (!window || window.webContents.isDestroyed()) return null;
  const sessionHint = ghostSessionFocusByWebContents.get(window.webContents.id)?.trim();
  return sessionHint ? { window, sessionHint } : null;
}

async function authorizeFocusedIOSSimulatorContext(): Promise<IOSSimulatorSlotFocusContext | null> {
  const existing = focusedIOSSimulatorContext();
  if (existing) return existing;

  const candidate = focusedIOSSimulatorAuthorizationCandidate();
  if (!candidate) return null;
  const granted = await requestIOSSimulatorRendererSessionAccess(
    candidate.window.webContents,
    candidate.sessionHint,
  );
  if (!granted) return null;

  // Confirmation can outlive a focus/route transition. The registry invalidates
  // those pending grants; this second identity check also keeps the candidate
  // window and its route hint stable before reading the authoritative snapshot.
  const currentCandidate = focusedIOSSimulatorAuthorizationCandidate();
  if (
    currentCandidate?.window !== candidate.window ||
    currentCandidate.sessionHint !== candidate.sessionHint
  ) {
    return null;
  }
  const access = getIOSSimulatorRendererSessionAccess(candidate.window.webContents);
  if (!access || access.sessionId !== candidate.sessionHint) return null;
  return {
    sessionId: access.sessionId,
    windowWebContentsId: candidate.window.webContents.id,
    revision: access.generation,
  };
}

function isIOSSimulatorContextCurrent(context: IOSSimulatorSlotFocusContext): boolean {
  const current = focusedIOSSimulatorContext();
  return (
    current?.sessionId === context.sessionId &&
    current.windowWebContentsId === context.windowWebContentsId &&
    current.revision === context.revision
  );
}

let iosSimulatorSlotSingleton: GhostIOSSimulatorSlot | null = null;

/**
 * 插件只获知脱敏状态并可请求当前主窗口打开 Host 面板。实际视频、输入、
 * 生命周期与 fallback 均留在 iOS Simulator Host，不经插件逻辑页中转。
 */
export function getGhostIOSSimulatorSlot(): GhostIOSSimulatorSlot {
  if (!iosSimulatorSlotSingleton) {
    iosSimulatorSlotSingleton = new GhostIOSSimulatorSlot({
      getGhost: findAvailableGhost,
      focusedContext: focusedIOSSimulatorContext,
      authorizeFocusedContext: authorizeFocusedIOSSimulatorContext,
      isContextCurrent: isIOSSimulatorContextCurrent,
      getStatus: getIOSSimulatorPluginStatus,
      focusViewer: (context, instanceId) => {
        if (!isIOSSimulatorContextCurrent(context)) return false;
        const window = mainShellWindows().find(
          (candidate) => candidate.webContents.id === context.windowWebContentsId,
        );
        if (!window) return false;
        try {
          if (window.isDestroyed() || window.webContents.isDestroyed()) return false;
          return focusIOSSimulatorRendererSession(
            context.sessionId,
            instanceId,
            window.webContents,
          );
        } catch {
          return false;
        }
      },
      log,
    });
  }
  return iosSimulatorSlotSingleton;
}

let cindySlotSingleton: GhostCindySlot | null = null;
let networkSlotSingleton: GhostNetworkSlot | null = null;
let notifySlotSingleton: GhostNotifySlot | null = null;
let connectionAudienceResolverSingleton: ConnectionAudienceResolver | null = null;
let connectionTokenProviderSingleton: ConnectionTokenProvider | null = null;
let pluginMarketLedgerSingleton: PluginMarketLedger | null = null;
let ghostFirstPartyFactsLoaderSingleton: GhostFirstPartyFactsLoader | null = null;

function getPluginMarketLedger(): PluginMarketLedger {
  if (!pluginMarketLedgerSingleton) {
    pluginMarketLedgerSingleton = new PluginMarketLedger(() =>
      ownerScopedUserDataPath('plugin-market', 'ledger.v1.json'),
    );
  }
  return pluginMarketLedgerSingleton;
}

/** Read Manifest and byte identity together from one installed ghost.json snapshot. */
function readInstalledGhostManifestIdentity(
  ghostId: string,
): InstalledMarketManifestIdentity | null {
  const ghost = getGhostManager()
    .list()
    .find((candidate) => candidate.manifest.id === ghostId);
  if (!ghost) return null;
  const result = readInstalledGhostManifestSnapshot(
    ghost.dir,
    GHOST_INSTALL_MANIFEST_MAX_BYTES,
  );
  return result.ok ? installedMarketManifestIdentity(result.snapshot) : null;
}

/** Resolve Connection metadata from trusted organization installs or explicit Forge receipts. */
function getConnectionAudienceResolver(): ConnectionAudienceResolver {
  if (!connectionAudienceResolverSingleton) {
    connectionAudienceResolverSingleton = loadConnectionAudienceResolver({
      readInstalledManifestIdentity: readInstalledGhostManifestIdentity,
      readMarketInstallation: (ghostId) =>
        getPluginMarketLedger().lookupInstallationForOidc(ghostId),
      readApprovedPackageSha256: (ghostId) =>
        getGhostManager().approvedInstallEvidence(ghostId)?.packageSha256 ?? null,
      readInstallOrigin: (ghostId) => getGhostManager().readEffectiveInstallOrigin(ghostId),
      lookupOrganizationPrefix: (orgId) =>
        createOrganizationPrefixStore(
          ownerScopedUserDataPath('plugin-market', 'organization.v1.json'),
        ).lookup(orgId),
      log,
    });
  }
  return connectionAudienceResolverSingleton;
}

function resolveConnectionAudienceForGhost(ghostId: string): ConnectionAudienceResolution | null {
  const state = getAuthState();
  const user = state.isAuthenticated ? state.user : null;
  if (!user) return null;
  return getConnectionAudienceResolver().resolve(ghostId, {
    membershipId: user.id,
    membershipKind: user.membershipKind,
    orgId: user.orgId,
    orgSlug: user.orgSlug,
  });
}

function getGhostFirstPartyFactsLoader(): GhostFirstPartyFactsLoader {
  if (!ghostFirstPartyFactsLoaderSingleton) {
    ghostFirstPartyFactsLoaderSingleton = loadGhostFirstPartyFactsLoader({
      readInstalledBuiltin: (ghostId) =>
        getGhostManager().list().find((candidate) => candidate.manifest.id === ghostId)?.builtin ===
        true,
      readMarketInstallation: (ghostId) => getPluginMarketLedger().installationForGhost(ghostId),
      readApprovedPackageSha256: (ghostId) =>
        getGhostManager().approvedInstallEvidence(ghostId)?.packageSha256 ?? null,
      lookupOrganizationPrefix: (orgId) =>
        createOrganizationPrefixStore(
          ownerScopedUserDataPath('plugin-market', 'organization.v1.json'),
        ).lookup(orgId),
      readInstallOrigin: (ghostId) => getGhostManager().readEffectiveInstallOrigin(ghostId),
    });
  }
  return ghostFirstPartyFactsLoaderSingleton;
}

/**
 * 每次调用都重新求值，不做任何缓存或作废——身份变更靠重新求值生效，
 * 不要在这里造平行的失效状态机（AGENTS.md 硬规则）。
 *
 * **为什么不需要额外检查 `isAppSessionBoundaryPending()`**：切身份的窗口期里
 * `getAuthState()` 与 owner 分域路径可能短暂不同步，但前缀缓存是「owner 分域的文件
 * ×  文件内按 orgId 分键」的双键结构，任一侧不同步的结果都是查不到那个键
 * （`absent`）而不是查到别人的前缀——方向是 fail-closed。同账号内切组织时文件同一份、
 * 键各自独立，落后一拍只会拿到旧组织的前缀，随后被判据要求「台账 organizationId 与
 * 当前组织一致」挡掉。所以这里刻意不加闸，别补。
 */
export function loadGhostFirstPartyFactsForGhost(
  ghostId: string,
  purpose: GhostFirstPartyFactsPurpose,
  overrides?: GhostFirstPartyFactsOverrides,
): GhostFirstPartyFactsLoad {
  const state = getAuthState();
  const user = state.isAuthenticated ? state.user : null;
  return getGhostFirstPartyFactsLoader().load(
    ghostId,
    purpose,
    {
      membershipKind: user?.membershipKind ?? 'personal',
      orgId: user?.orgId ?? null,
    },
    overrides,
  );
}

function isGhostTokenBrokerAuthorized(
  ghostId: string,
  purpose: GhostFirstPartyFactsPurpose,
  overrides?: GhostFirstPartyFactsOverrides,
): boolean {
  // Official prefix keeps today's grant without consulting facts.
  if (isBrokerEligibleGhostId(ghostId)) return true;
  return authorizeGhostTokenBroker(
    ghostId,
    loadGhostFirstPartyFactsForGhost(ghostId, purpose, overrides),
  );
}

/** Main-memory-only Connection token issuer/cache. */
export function getConnectionTokenProvider(): ConnectionTokenProvider {
  if (!connectionTokenProviderSingleton) {
    connectionTokenProviderSingleton = new ConnectionTokenProvider({
      issue: (audience) =>
        serverApiFetch<IssuedConnectionToken>('/api/auth/connections/token', {
          method: 'POST',
          body: { audience },
          baseUrl: () => getClientEndpoint('authApiBaseUrl'),
          timeoutMs: 15_000,
          redactErrorDetails: true,
        }),
    });
  }
  return connectionTokenProviderSingleton;
}

/** 意识系统提示通道(main → 全窗口 renderer;宿主 Toast 渲染,带意识身份头)。 */
export const GHOST_NOTIFY_CHANNEL = 'ghosts:notify';

/** 主机代言提示的每意识限速账本(见 broadcastGhostHostNotice)。 */
const hostNoticeLastAt = new Map<string, number>();

/**
 * 主机代言提示(host-origin notice):凭证入库 / 授权成功等**主机权威事件**
 * 的 tips。与意识自发的 notify 槽同通道同渲染(带意识身份头),但不经意识
 * 代码、不占意识 notify 槽限速、不要求声明 notify 槽——事件判定者是主机,
 * 提示资格随事件来。载荷带 textKey/textArgs 而非 text:文案要跟用户语言走,
 * 由 renderer 按 GHOST_HOST_NOTICE_KEYS 白名单翻译(shared/ghost.ts 注释详述)。
 * 自带同款每意识频控(GHOST_NOTIFY_MIN_INTERVAL_MS,超发静默丢):事件虽由
 * 主机判定,但触发权在意识设置页手里(循环 PUT /secrets 就是循环入库成功),
 * 不设闸等于给了绕过 notify 限速的旁路;连续保存多个 key 时后续提示被并掉,
 * 设置页自己的就地反馈仍在,不损知情。
 */
export function broadcastGhostHostNotice(
  ghostId: string,
  notice: {
    textKey: GhostHostNoticeKey;
    textArgs?: Record<string, string>;
    tone?: 'info' | 'success' | 'warning' | 'error';
  },
): void {
  const ghost = findAvailableGhost(ghostId);
  if (!ghost) return; // 卸载竞态:意识已不在,提示无从署名,静默丢
  const now = Date.now();
  const last = hostNoticeLastAt.get(ghostId);
  if (last !== undefined && now - last < GHOST_NOTIFY_MIN_INTERVAL_MS) return;
  hostNoticeLastAt.set(ghostId, now);
  // textArgs 净化收口:manifest label(装入只验长度)与 OAuth 身份标签
  // (来自意识自声明域名的响应,内容完全作者可控)都可能带控制字符——
  // 与 notify 槽同款剥除,换行坍缩成空格(插值片段没有正当的换行用途),
  // 再兜一道 200 字上限。
  const textArgs = notice.textArgs
    ? Object.fromEntries(
        Object.entries(notice.textArgs).map(([k, v]) => [
          k,
          sanitizeGhostNoticeText(v).replace(/\n+/g, ' ').slice(0, 200),
        ]),
      )
    : undefined;
  const payload = {
    ghostId,
    name: ghost.manifest.name,
    ...(ghost.iconDataUrl ? { iconDataUrl: ghost.iconDataUrl } : {}),
    tone: notice.tone ?? 'success',
    textKey: notice.textKey,
    ...(textArgs ? { textArgs } : {}),
  };
  broadcastGhostWindowPush(GHOST_NOTIFY_CHANNEL, payload);
  log.info('ghost host notice shown', { ghostId, textKey: notice.textKey });
}

/**
 * 系统提示槽单例(notify):资格审/净化/限速在 GhostNotifySlot,这里只装配
 * 取意识与广播(全窗口推送,与 hook-fused 同模式)。
 */
export function getGhostNotifySlot(): GhostNotifySlot {
  if (!notifySlotSingleton) {
    notifySlotSingleton = new GhostNotifySlot({
      getGhost: findAvailableGhost,
      broadcast: (payload) => {
        broadcastGhostWindowPush(GHOST_NOTIFY_CHANNEL, payload);
      },
      log,
    });
  }
  return notifySlotSingleton;
}

let badgeSlotSingleton: GhostBadgeSlot | null = null;

/** 意识未读角标通道(main → 全窗口 renderer;插件入口与插件卡上的绿点)。 */
export const GHOST_BADGE_CHANNEL = 'ghosts:badge';

/**
 * 未读全量快照通道(main → 全窗口 renderer)。逐条的 GHOST_BADGE_CHANNEL 只表达
 * 增量,**换账号**必须整表替换:未读账本按 owner 分文件(ownerScopedUserDataPath),
 * 切到账号 B 后 renderer 手上还攥着账号 A 的点和摘要,不推一次快照就是跨账号残留。
 */
export const GHOST_UNREAD_SNAPSHOT_CHANNEL = 'ghosts:unread-snapshot';

/**
 * 未读推送的收口:**只发给可信的 Cindy 自有顶层页面**。
 *
 * 载荷里的 summary 是插件正文(工单标题、邮件主题、任务名)。无条件
 * `getAllWindows().send()` 会把它发给所有窗口,包括已经导航到别处的那些——
 * 出站推送与入站 IPC 是同一道授权边界,不能只守一边(codex review)。
 * 判据复用 `isTrustedAppRendererWindow`,与 `ghosts:unread` 同步读那道闸同源。
 */
export function sendToTrustedAppWindows(channel: string, payload: unknown): number {
  return sendGhostTrustedWindowPush(channel, payload);
}

function broadcastGhostBadge(payload: {
  ghostId: string;
  unread: boolean;
  summary?: string;
  at?: number;
}): void {
  sendToTrustedAppWindows(GHOST_BADGE_CHANNEL, payload);
}

/**
 * 推一份当前 owner 的未读全量快照(登录 / 登出 / 换账号后由 onAuthStateChange 调)。
 * 由 main 主动推而不是让 renderer 自己重读:owner 是否已经切完只有 main 说了算,
 * renderer 猜时机就可能读到旧账号的账本。读失败按空表推——宁可少一颗点,不可
 * 把账号 A 的未读留在账号 B 的界面上。
 */
function broadcastGhostUnreadSnapshot(): void {
  const entries = visibleGhostUnread();
  sendToTrustedAppWindows(GHOST_UNREAD_SNAPSHOT_CHANNEL, { entries });
}

/**
 * 可投影的未读 = 账本里还亮着 **且** 意识当前可用且已启用。
 *
 * 停用**保留记录、只停投影**(不是删记录):用户把插件按沉睡是"先别烦我",
 * 不是"这条我读过了";重新启用时那颗点应该回来。已卸载的残留条目也在这里
 * 被滤掉——包都没了的点用户既点不开也清不掉。
 * 读失败按空表:宁可少一颗点,不可让损坏的账本挡住插件页首屏。
 */
function visibleGhostUnread(): GhostUnreadEntry[] {
  try {
    const entries = loadGhostUnread();
    if (entries.length === 0) return [];
    // **一次快照建索引**,不要逐条 findAvailableGhost():那个函数每次都调
    // GhostManager.list(),而 list() 会同步重扫插件目录、重读每份 manifest /
    // locale / 图标 / 信任文件。账本允许 200 条,逐条查就是 O(未读 × 已装) 次
    // 磁盘扫描,而本函数服务的是**同步** ghosts:unread(首屏渲染路径),
    // 足以卡住启动(codex review)。
    const available = new Map(availableGhosts().map((ghost) => [ghost.manifest.id, ghost]));
    return entries.filter((entry) =>
      isGhostUnreadProjectable(available.get(entry.ghostId) ?? null),
    );
  } catch (error) {
    log.warn('ghost unread 读取失败', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * 未读角标槽单例(badge 槽):资格审/净化/限速在 GhostBadgeSlot,这里只装配
 * 取意识、落盘与广播。落盘失败**不吞成静默**——账本写不进去时角标只在本次
 * 运行期有效,如实记日志,但仍然推给 renderer(用户当下看得见比事后可靠更重要)。
 */
export function getGhostBadgeSlot(): GhostBadgeSlot {
  if (!badgeSlotSingleton) {
    badgeSlotSingleton = new GhostBadgeSlot({
      getGhost: findAvailableGhost,
      mark: (ghostId, summary, at) => {
        try {
          // 触到上限被挤掉的条目要补一条熄灭广播,否则 renderer 表里留着账本
          // 已经删掉的点(卡片与聚合入口一直亮到重启)。
          for (const evictedId of markGhostUnread(ghostId, summary, at).evicted) {
            broadcastGhostBadge({ ghostId: evictedId, unread: false });
          }
          return true;
        } catch (error) {
          // 写不进去就**如实回 false**,由槽决定不广播。此前这里吞掉异常后
          // 照常广播,renderer 会留下一颗账本里根本不存在的点;而后续熄灭
          // 路径查不到记录 → 不广播 → 那颗点再也清不掉(codex review)。
          log.warn('ghost unread 落盘失败', {
            ghostId,
            error: error instanceof Error ? error.message : String(error),
          });
          return false;
        }
      },
      clear: (ghostId) => {
        try {
          return clearGhostUnread(ghostId) !== null;
        } catch (error) {
          log.warn('ghost unread 清除失败', {
            ghostId,
            error: error instanceof Error ? error.message : String(error),
          });
          // 落盘清不掉时仍回 true:让广播照发,界面上的点先灭掉,
          // 否则用户点开了面板却看到点还亮着,属于更可见的错。
          return true;
        }
      },
      broadcast: broadcastGhostBadge,
      log,
    });
  }
  return badgeSlotSingleton;
}

/**
 * 主机侧熄灭未读(用户打开面板 / 停用 / 卸载)。与意识自发的 badge 熄灭同
 * 通道同落盘,但不经意识代码、不占限速——判定者是主机。
 */
function extinguishGhostUnread(ghostId: string, seenAt?: number): void {
  try {
    // null = 没发生变化(本来就没亮,或账本比 seenAt 新)——免掉一轮广播,
    // 也别把仍然亮着的那条误报成已熄灭。
    if (clearGhostUnread(ghostId, seenAt) === null) return;
  } catch (error) {
    log.warn('ghost unread 清除失败', {
      ghostId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  broadcastGhostBadge({ ghostId, unread: false });
}

/**
 * 停用:只停投影,**不删记录**——沉睡是"先别烦我",不是"这条我读过了"。
 * 限速记账一并抹掉,重新唤醒后的第一条不该被上一世的时刻挡住。
 */
function suspendGhostUnreadProjection(ghostId: string): void {
  badgeSlotSingleton?.forget(ghostId);
  broadcastGhostBadge({ ghostId, unread: false });
}

/**
 * 撤销扫尾:插件更新后身份卡不再声明 badge 卡槽时,
 * 既有未读**立即清除**——权限撤了还留一颗点,等于把已收回的能力继续兑现。
 * 挂在 broadcastGhostsChanged 上:装入 / 更新 / 卸载 / 对账都从这一处过,
 * 不用在每条清单变更路径上各补一遍。
 */
function sweepRevokedGhostUnread(ghosts: InstalledGhost[], rosterAuthoritative: boolean): void {
  let entries: GhostUnreadEntry[];
  try {
    entries = loadGhostUnread();
  } catch {
    return; // 账本读不出来时不做任何猜测,交给下一次变更
  }
  for (const id of selectRevokedGhostUnreadIds(entries, ghosts, rosterAuthoritative)) {
    extinguishGhostUnread(id);
  }
}

/** 重新启用:账本里还留着的那颗点要回来(与 suspend 成对)。 */
function resumeGhostUnreadProjection(ghostId: string): void {
  let entry: GhostUnreadEntry | null = null;
  try {
    entry = readGhostUnread(ghostId);
  } catch (error) {
    log.warn('ghost unread 读取失败', {
      ghostId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!entry) return;
  broadcastGhostBadge({
    ghostId,
    unread: true,
    ...(entry.summary ? { summary: entry.summary } : {}),
    at: entry.at,
  });
}

let confirmSlotSingleton: GhostConfirmSlot | null = null;

/** 意识确认弹窗通道(main → **单个**窗口;renderer 用主机同款 ConfirmDialog 渲染)。 */
export const GHOST_CONFIRM_CHANNEL = 'ghosts:confirm-request';
export const FORGE_OIDC_INSTALL_CONFIRM_CHANNEL = 'forge-oidc-install:confirm-request';

function ensureForgeOidcInstallConfirmBridge() {
  return (
    getForgeOidcInstallConfirmBridge() ??
    initForgeOidcInstallConfirmBridge({
      sendToWindow: createForgeOidcInstallMainWindowSender<BrowserWindow>({
        getMainWindow: getDeepLinkMainWindow,
        isTrustedMainWindow: isTrustedAppRendererWindow,
        send: (window, payload) =>
          sendGhostWindowPush(window, FORGE_OIDC_INSTALL_CONFIRM_CHANNEL, payload),
      }),
      log,
    })
  );
}

/**
 * 确认弹窗槽单例(confirm):资格审/净化/限速/单飞在 GhostConfirmSlot,往返与
 * 超时兜底在 GhostConfirmDialogBridge,这里只组装"投给哪个窗口"。
 *
 * 只投**一个**窗口(focused ?? 第一个),不像 notify 那样广播:模态确认框广播
 * 出去会在每个窗口各弹一个、收回多份答案。没有可投窗口时 sendToWindow 回
 * false → 桥 reject → 槽回 UNAVAILABLE(明确区别于"用户拒绝")。
 */
export function getGhostConfirmSlot(): GhostConfirmSlot {
  if (!confirmSlotSingleton) {
    const bridge =
      getGhostConfirmDialogBridge() ??
      initGhostConfirmDialogBridge({
        sendToWindow: (payload) => {
          const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
          if (!win || win.isDestroyed()) return false;
          sendGhostWindowPush(win, GHOST_CONFIRM_CHANNEL, payload);
          return true;
        },
        log,
      });
    confirmSlotSingleton = new GhostConfirmSlot({
      getGhost: findAvailableGhost,
      showConfirm: (params) =>
        bridge.request({
          ghostId: params.ghostId,
          ghostName: params.ghostName,
          ...(params.iconDataUrl ? { iconDataUrl: params.iconDataUrl } : {}),
          body: params.body,
          confirmText: params.confirmText,
          cancelText: params.cancelText,
          danger: params.danger,
        }),
      log,
    });
  }
  return confirmSlotSingleton;
}

let pickSlotSingleton: GhostPickSlot | null = null;

/**
 * 目录选择槽单例(pick):资格审/限速/分档发结果在 GhostPickSlot,这里只
 * 组装 Electron 系统对话框与目录过户票据库。对话框必须挂靠 Cindy 自有窗口
 * (无窗口 = 失败关闭,不弹无主对话框);标题/正文由主机拼装并带插件名。
 */
export function getGhostPickSlot(): GhostPickSlot {
  if (!pickSlotSingleton) {
    pickSlotSingleton = new GhostPickSlot({
      getGhost: findAvailableGhost,
      showDirectoryDialog: async ({ ghostName, purpose }) => {
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        if (!win || win.isDestroyed()) throw new Error('没有可挂靠的宿主窗口');
        // main 侧 t() 只插值 {{appName}},插件名在调用点替换(与 bootstrap 菜单同做法)。
        const message = t('settings.ghosts.pick.dialogMessage').replaceAll('{{name}}', ghostName);
        const result = await dialog.showOpenDialog(win, {
          title: t('settings.ghosts.pick.dialogTitle'),
          message: purpose ? `${message}\n${purpose}` : message,
          properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0];
      },
      // userGranted=true 的授权事实 = 用户刚在系统对话框里亲手选中了这个目录
      // (与确认卡点允许同强度;dirDeposit 注释的授权语义包含本通道)。
      depositDir: (ghostId, dirAbs) =>
        getDirDepositVault().deposit({ ghostId, dirAbs, workdirAbs: null, userGranted: true }),
      // 亲选事实进台账:errand 的 workingDir 转述据此对账(pickGrantsStore)。
      recordPickedDir: recordGhostPickedDir,
      log,
    });
  }
  return pickSlotSingleton;
}

let workspaceSlotSingleton: GhostWorkspaceSlot | null = null;

/**
 * 工作区会话槽单例(workspace):资格审/限速/目录授权/判重在 GhostWorkspaceSlot,
 * 这里只组装 Electron 系统对话框、确认卡桥(lane='workspace')、在途 callId
 * 反查(cardService)与会话目录快照;真实的判重/创建/聚焦服务由 maker-ipc
 * 初始化完成后经 setGhostWorkspaceSessionService 注入(保持 cindy-brain 不
 * 反向依赖 maker-ipc)。
 */
export function getGhostWorkspaceSlot(): GhostWorkspaceSlot {
  if (!workspaceSlotSingleton) {
    workspaceSlotSingleton = new GhostWorkspaceSlot({
      getGhost: findAvailableGhost,
      showDirectoryDialog: async ({ ghostName, purpose }) => {
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        if (!win || win.isDestroyed()) throw new Error('没有可挂靠的宿主窗口');
        // main 侧 t() 只插值 {{appName}},插件名在调用点替换(与 pick 槽同做法)。
        const message = t('settings.ghosts.workspace.dialogMessage').replaceAll(
          '{{name}}',
          ghostName,
        );
        const result = await dialog.showOpenDialog(win, {
          title: t('settings.ghosts.workspace.dialogTitle'),
          message: purpose ? `${message}\n${purpose}` : message,
          properties: ['openDirectory', 'createDirectory'],
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        return result.filePaths[0];
      },
      // 严格在途:交卷/重开后的 callId 不再是有效的目录授权上下文凭证。
      resolveCallContext: (callId) => getGhostCardService().inFlightCallInfoOf(callId),
      getSessionDirInfo: async (sessionId) => {
        const snapshot = await getSessionFsSnapshot(sessionId);
        if (!snapshot) return null;
        return { workingDir: snapshot.workingDir, remoteHostId: snapshot.remoteHostId };
      },
      statDir: async (dirAbs) => {
        try {
          const stat = await fs.promises.stat(dirAbs);
          return stat.isDirectory() ? 'ok' : 'not-directory';
        } catch (error) {
          // ENOTDIR = 路径中间某段不是目录,语义上更接近"不是目录"而非"不存在"。
          return (error as NodeJS.ErrnoException)?.code === 'ENOTDIR'
            ? 'not-directory'
            : 'not-found';
        }
      },
      isInsideWorkdir: (dirAbs, workdirAbs) => {
        try {
          return isPathInsideDir(
            fs.realpathSync.native(workdirAbs),
            fs.realpathSync.native(dirAbs),
          );
        } catch {
          return false;
        }
      },
      confirmDir: async ({ ghostId, sessionId, dirAbs }) => {
        const bridge = getGhostGrantConfirmBridge();
        if (!bridge) {
          throw new Error('确认通道未就绪');
        }
        const decision = await bridge.request(sessionId, {
          ghostId,
          ghostName: findAvailableGhost(ghostId)?.manifest.name ?? ghostId,
          lane: 'workspace',
          items: [{ name: path.basename(dirAbs), absPath: dirAbs, size: 0, isDirectory: true }],
        });
        if (decision.confirmed) return { ok: true };
        return {
          ok: false,
          message:
            decision.reason === 'timeout'
              ? '确认超时:用户未在时限内响应,本次工作区会话请求已取消'
              : '用户拒绝了本次工作区会话请求,不要重试;如确有需要请先与用户沟通',
        };
      },
      log,
    });
  }
  return workspaceSlotSingleton;
}

/** maker-ipc 完成初始化后注入判重/创建/聚焦服务;保持 cindy-brain 不反向依赖它。 */
export function setGhostWorkspaceSessionService(service: WorkspaceSessionService | null): void {
  getGhostWorkspaceSlot().setSessionService(service);
}

export type LibraryExtraDirSyncResult = 'granted' | 'not-granted' | 'superseded';
type LibraryExtraDirSyncFn = (root: string | null) => Promise<LibraryExtraDirSyncResult>;
let libraryExtraDirSync: LibraryExtraDirSyncFn | null = null;
/** 最近一次成功把库根写入 extraDirs 的插件;焦点刷新只复用它,不抓清单第一个。 */
let libraryExtraDirOwnerGhostId: string | null = null;

/** maker-ipc 注入:把 library 根同步进当前 Mivo 会话 extraDirs。cindy-brain 不反向依赖 register。 */
export function setGhostLibraryExtraDirSync(
  sync: LibraryExtraDirSyncFn | null,
): void {
  libraryExtraDirSync = sync;
}

export function getFocusedGhostSessionId(): string | null {
  return ghostSessionFocusTracker.current();
}

/** 已启用且声明 library 能力。不得用写死的 xd-mivo/cindy-mivo 白名单顶替。 */
function isLibraryCapableGhost(ghost: InstalledGhost | null | undefined): ghost is InstalledGhost {
  return Boolean(ghost && ghost.enabled !== false && ghost.manifest.library === true);
}

async function resolveLibraryCapableRoot(ghostId: string): Promise<string | null> {
  if (!isLibraryCapableGhost(findAvailableGhost(ghostId))) return null;
  const resolution = await getGhostLibraryBindingStore().resolveLibraryRoot(ghostId);
  if (resolution.kind === 'custom' && resolution.root === null) return null;
  return resolution.kind === 'custom' && resolution.root !== null
    ? resolution.root
    : ownerScopedUserDataPath('libraries', ghostId);
}

async function refreshMivoLibraryExtraDirGrant(): Promise<void> {
  if (!libraryExtraDirSync) return;
  const focused = ghostSessionFocusTracker.current();
  if (!focused) {
    await libraryExtraDirSync(null);
    return;
  }
  const ownerId = libraryExtraDirOwnerGhostId;
  const root = ownerId ? await resolveLibraryCapableRoot(ownerId) : null;
  if (!root) {
    libraryExtraDirOwnerGhostId = null;
    await libraryExtraDirSync(null);
    return;
  }
  await libraryExtraDirSync(root);
}

/**
 * 槽侧同步:认发起 open 的那个 ghost,不抓清单里第一个 library 插件。
 * root 非空时必须 library 资格审过,否则不得 no-op 成功。
 * 撤槽(root=null)只允许当前 owner;别人撤槽不得把唯一槽拆了。
 * granted = 已把该库根写入 extraDirs;not-granted = 确定没挂上;
 * superseded = 被更新一轮取代,不等于把已挂上的槽拆了。
 */
async function syncMivoLibraryExtraDirFromSlot(
  ghostId: string,
  root: string | null,
): Promise<LibraryExtraDirSyncResult> {
  if (!libraryExtraDirSync) return 'not-granted';
  if (root !== null && !isLibraryCapableGhost(findAvailableGhost(ghostId))) {
    return 'not-granted';
  }
  if (root === null) {
    if (libraryExtraDirOwnerGhostId !== null && libraryExtraDirOwnerGhostId !== ghostId) {
      return 'not-granted';
    }
    const result = await libraryExtraDirSync(null);
    if (result !== 'superseded') libraryExtraDirOwnerGhostId = null;
    return result === 'superseded' ? 'superseded' : 'not-granted';
  }
  const result = await libraryExtraDirSync(root);
  if (result === 'granted') libraryExtraDirOwnerGhostId = ghostId;
  return result;
}

let previewSlotSingleton: GhostPreviewSlot | null = null;

/** 插件预览开页通道(main → 全窗口 renderer;右侧栏开 web-browser 标签)。 */
export const GHOST_PREVIEW_OPEN_CHANNEL = 'ghosts:preview-open';

/**
 * 面板预览槽单例(preview):URL 白名单守门/限速在 GhostPreviewSlot,这里只
 * 组装全窗口广播(与 notify 同模式;renderer 在右侧栏落地标签页)。
 */
export function getGhostPreviewSlot(): GhostPreviewSlot {
  if (!previewSlotSingleton) {
    previewSlotSingleton = new GhostPreviewSlot({
      getGhost: findAvailableGhost,
      focusedSessionId: () => ghostSessionFocusTracker.current(),
      broadcast: (payload) => {
        const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
        windows.forEach((window) => {
          sendGhostWindowPush(window, GHOST_PREVIEW_OPEN_CHANNEL, payload);
        });
        return windows.length > 0;
      },
      log,
    });
  }
  return previewSlotSingleton;
}

let scheduleSlotSingleton: GhostScheduleSlot | null = null;

/** 插件自动化草稿通道(main → **单个**窗口;renderer 开自动化创建面板并预填)。 */
export const GHOST_SCHEDULE_DRAFT_CHANNEL = 'ghosts:schedule-draft';

/**
 * 自动化草稿槽单例(agent 槽的 schedule 加档):资格审/净化/频率钳制/限速在
 * GhostScheduleSlot,这里只组装"投给哪个窗口"。
 *
 * 只投**一个**窗口(focused ?? 第一个),与 confirm / pick 同纪律,**不像 notify /
 * preview 那样广播**:本操作是打断式的 —— renderer 收到会把该窗口导航到自动化页
 * 并弹出创建面板。"在新窗口打开"的会话副窗同样挂载完整 MainLayout、各自持有独立
 * 的 requestId 去重状态,所以广播会让主窗与每个副窗同时跳页弹表单:打断其它窗口
 * 里没保存的内容,还让同一份草稿被重复保存成多条自动化(#1715 review:Greptile P1 /
 * Codex P2 / Copilot 同根因)。状态同步类事件(notify / badge / preview 开标签)才
 * 适合广播,打断式的模态入口一律单投。
 *
 * 没有可投窗口(全部销毁 / 一个都没有)→ 返回 false → 槽回 HOST_NOT_READY,
 * 插件收到明确失败而不是静默丢弃。
 *
 * ⚠️ deps 里**刻意不注入任何建任务的能力** —— 本槽只能开面板,任务必须由用户
 * 在面板上选模型后亲手保存。别为了"省一步"给它接 schedule storage。
 */
export function getGhostScheduleSlot(): GhostScheduleSlot {
  if (!scheduleSlotSingleton) {
    scheduleSlotSingleton = new GhostScheduleSlot({
      getGhost: findAvailableGhost,
      sendToWindow: (payload) => {
        // 候选只取**挂了完整主壳**的窗口:独立的插件面板窗 / 右侧栏窗与 MainLayout
        // 平级,没有这个订阅也去不了自动化页(判据见 isMainShellWindowUrl)。
        // isDestroyed 两路都兜:getFocusedWindow 理论上不返回已销毁的窗,但窗口关闭
        // 与本次投递之间存在时序窗口。
        const candidates = BrowserWindow.getAllWindows().filter(
          (window) => !window.isDestroyed() && isMainShellWindowUrl(window.webContents.getURL()),
        );
        const focused = BrowserWindow.getFocusedWindow();
        // 用户正在插件面板独立窗里点「提醒我」时 focused 不在候选里 —— 回落到第一个
        // 主壳窗(通常就是主窗口),用户会在那里看到弹出的创建面板,而不是什么都没发生。
        const win =
          focused && !focused.isDestroyed() && candidates.includes(focused)
            ? focused
            : candidates[0];
        if (!win) return false;
        win.webContents.send(GHOST_SCHEDULE_DRAFT_CHANNEL, payload);
        return true;
      },
      log,
    });
  }
  return scheduleSlotSingleton;
}

/**
 * 模型槽单例:意识借主机 AI 出图的代办窗口。
 * 生成走主机统一图片通道(art 底层客户端,与聊天画图同一条付费链路);
 * 产物落媒体总仓(blob + 账本,出生=该意识),意识只拿到指纹字符串。
 */
function getVideoProviderRegistry() {
  const registry = getCindyProxyMediaService().backend.videoRegistry;
  if (!registry) return null;
  const xaiCatalogProvider = getActiveCatalog().providers.find(
    (provider) => provider.id === 'xai',
  );
  const xaiCatalogProviderId = xaiCatalogProvider?.id;
  const xaiAliases = xaiCatalogProvider?.videoModels?.map((model) => model.id) ?? [];
  const routableXaiAliases = xaiCatalogProviderId
    ? xaiAliases.filter(
        (alias) =>
          !registry.hasAlias(alias) || registry.hasAlias(alias, xaiCatalogProviderId),
      )
    : [];
  if (
    xaiCatalogProviderId &&
    routableXaiAliases.some((alias) => !registry.hasAlias(alias))
  ) {
    registry.registerOrExtend(
      createXaiVideoProvider({
        modelAliases: routableXaiAliases,
        hasOAuthLogin: () => hasGrokOAuthLogin(),
        getAccessToken: () => getGrokAccessToken(),
        getCredentialGeneration: () => getGrokOAuthCredentialGeneration(),
        getOwnerScopeKey: () => activeOwnerScopeKey(),
        isOwnerBoundaryPending: () => isAppSessionBoundaryPending(),
        fetchImplementation: ((url, init) => outboundFetch(url as string, init)) as typeof fetch,
        beforeDispatch: (model) => assertMediaModelStillEnabled('video', model),
        onAuthRejected: (failure) => invalidateXaiBridgeAuth(failure),
      }),
      xaiCatalogProviderId,
    );
  }
  return registry;
}

/** 视频目录的 provider 级就绪判据；未知来源绝不投影成可选型号。 */
function isVideoCatalogProviderReady(providerId: string): boolean {
  if (providerId === 'xd') return isXdGatewayProviderReady(providerId);
  if (providerId === 'xai') {
    return !isAppSessionBoundaryPending() && hasGrokOAuthLogin();
  }
  return false;
}

const LEGACY_CINDY_REQUEST_IMAGE_GUIDE_ID = 'openai-images-v1';
type LegacyCindyMediaAction = 'generate' | 'edit';

/** 旧 cindy-request 类目清单只保留其固定通道对当前动作真正可执行的 XD 模型。 */
function isXdMediaModelExecutableForCatalog(
  kind: CindyCapabilityKind,
  modelId: string,
  action?: LegacyCindyMediaAction,
): boolean {
  if (kind === 'image') {
    if (action) {
      return isMediaModelExecutableForGuide(
        modelId,
        LEGACY_CINDY_REQUEST_IMAGE_GUIDE_ID,
        action === 'edit' ? 'image.edit' : 'image.generate',
      );
    }
    return (
      isMediaModelExecutableForGuide(
        modelId,
        LEGACY_CINDY_REQUEST_IMAGE_GUIDE_ID,
        'image.generate',
      ) ||
      isMediaModelExecutableForGuide(
        modelId,
        LEGACY_CINDY_REQUEST_IMAGE_GUIDE_ID,
        'image.edit',
      )
    );
  }
  if (kind === 'video') {
    if (action) {
      return isMediaModelExecutable(
        modelId,
        action === 'edit' ? 'video.image_to_video' : 'video.generate',
      );
    }
    return (
      isMediaModelExecutable(modelId, 'video.generate') ||
      isMediaModelExecutable(modelId, 'video.image_to_video')
    );
  }
  return true;
}

/**
 * 当前媒体能力配置(图像/视频同一套推导)——与会话模型列表**同一获取
 * 来源**:active catalog。XD 媒体由 Gateway `/models` 动态投影，第三方媒体
 * 保留各 Provider 的 imageModels/imageDefaults 或 videoModels/videoDefaults。
 * 清单与默认/档位选型全部来自目录,主机代码零
 * 模型字面量;派生规则见 cindyMediaCatalog.ts。
 *
 * 目录里没有该类目的任何模型(极端:远端目录带了 xd 段却不带媒体清单)→
 * `{ models: [], defaults: null }` = 该能力**暂不可用**,不拿打包常量冒充
 * (与聊天侧「无可用性证明不展示」同口径)。下游如实降级:详情页那几行显示
 * 灰字而不是下拉,cindySlot 早拒而不是拿不在册的型号下单。
 */
function getCatalogMediaConfig(
  kind: CindyCapabilityKind,
  action?: LegacyCindyMediaAction,
  selectedProviderId?: string,
): CindyMediaCatalogConfig {
  try {
    // 停用过滤:用户在 设置 → 模型供应商 停用的媒体模型 / 供应商不进候选清单
    // (与对话模型的准入口径同源,见 model-disable-store)。
    const access = readModelDisableOverrides();
    const catalog = getActiveCatalog();
    const xdMediaModelIds = getXdGatewayModels()
      .filter(
        (model) =>
          model.mode === 'image_generation' || model.mode === 'video_generation',
      )
      .map((model) => model.id);
    // 旧 cindy-request 偏好不携带 providerId；同一完整 modelId 同时来自 XD 与
    // 第三方时必须让托管默认来源先参与 first-wins，避免静默改用第三方凭证计费。
    const orderedProviders =
      kind === 'embed'
        ? catalog.providers
        : [
            ...catalog.providers.filter((provider) => provider.id === 'xd'),
            ...catalog.providers.filter((provider) => provider.id !== 'xd'),
          ];
    const providers = selectedProviderId
      ? orderedProviders.filter((provider) => provider.id === selectedProviderId)
      : orderedProviders;
    const videoRegistry = kind === 'video' ? getVideoProviderRegistry() : null;
    return deriveCindyMediaConfig(
      providers,
      kind,
      (providerId, modelId) =>
        isProviderDisabled(access, providerId) ||
        (providerId === 'xd' && kind !== 'embed'
          ? isModelDisabledWithUniqueLegacyBasename(
              access,
              providerId,
              modelId,
              xdMediaModelIds,
            )
          : isModelDisabled(access, providerId, modelId)) ||
        // active catalog 保留 Gateway 原始媒体事实源；旧 cindy-request 的同步目录
        // 必须在消费边界复用已缓存的 Guide 预检结果，不能暴露这版客户端不可执行的型号。
        (providerId === 'xd' && !isXdMediaModelExecutableForCatalog(kind, modelId, action)) ||
        // 向量:目录是热更的,可能给出客户端还不认识的型号 id(比 EmbeddingModelId
        // 这个静态联合更新)。不在这里滤掉的话,它会照常展示、可被钉选、甚至成为
        // 目录默认 —— 而执行侧 isKnownEmbeddingModel 那道纵深防御会把每一次请求
        // 变成 INTERNAL。UI 先宣称可用、下单才失败是最难排查的一种坏体验
        // (PR #1707 review)。滤掉后按既有语义降级:被滤条目不占 first-wins,
        // 目录默认指向它时回落清单首项;整份清单都不认识才是空清单 → NO_CANDIDATE。
        // 执行侧那道防御保留 —— 它管的是这里与执行层之间的窗口。
        (kind === 'embed' && !isKnownEmbeddingModel(modelId)) ||
        // 视频目录可能比当前客户端通道先热更。执行 registry 不认识的型号
        // 必须先过滤，不能把“目录有”冒充成“这版客户端能下单”。
        (kind === 'video' && !(videoRegistry?.hasAlias(modelId, providerId) ?? false)),
      // 执行通道凭证就绪过滤(未就绪的来源整段不进白名单,见 imageChannelRegistry
      // 头注)。视频按目录 provider 归属分别检查：xd 要求账号网关能力与 endpoint
      // 同时在场，xai 要求 SuperGrok OAuth 已连接；未知来源 fail closed。
      // 向量仍只有 xd 一家执行通道。
      kind === 'image'
        ? (providerId) => getImageChannelRegistry().isProviderReady(providerId)
        : kind === 'video'
          ? isVideoCatalogProviderReady
          : isXdGatewayProviderReady,
      // 编辑就绪过滤:仅支持生成的来源(supportsEdit: false)的模型不进编辑清单,
      // 防用户把该型号钉到 image.edit 偏好后在 editImage 路径拿到确定性 400。
      kind === 'image'
        ? (providerId) => getImageChannelRegistry().isProviderEditReady(providerId)
        : undefined,
    );
  } catch (err) {
    // 目录读取异常 = 拿不到可用性证明,同「空清单」处理(不静默顶一份旧名单)。
    log.warn(`read catalog ${kind} config failed, treating capability as unavailable`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return { models: [], defaults: null };
  }
}

const getCatalogImageConfig = (
  action?: LegacyCindyMediaAction,
): ReturnType<typeof getCatalogMediaConfig> => getCatalogMediaConfig('image', action);
const getCatalogVideoConfig = (
  action?: LegacyCindyMediaAction,
): ReturnType<typeof getCatalogMediaConfig> => getCatalogMediaConfig('video', action);
const getCatalogEmbedConfig = (): ReturnType<typeof getCatalogMediaConfig> =>
  getCatalogMediaConfig('embed');

const MEDIA_PREFERENCE_PREFIX = 'media:';

function encodeMediaPreference(providerId: string, modelId: string): string {
  return `${MEDIA_PREFERENCE_PREFIX}${encodeURIComponent(providerId)}:${encodeURIComponent(modelId)}`;
}

function decodeMediaPreference(value: string): { providerId: string; modelId: string } | null {
  if (!value.startsWith(MEDIA_PREFERENCE_PREFIX)) return null;
  const encoded = value.slice(MEDIA_PREFERENCE_PREFIX.length);
  const separator = encoded.indexOf(':');
  if (separator <= 0 || separator === encoded.length - 1) return null;
  try {
    const providerId = decodeURIComponent(encoded.slice(0, separator));
    const modelId = decodeURIComponent(encoded.slice(separator + 1));
    return providerId && modelId ? { providerId, modelId } : null;
  } catch {
    return null;
  }
}

type CindyMediaPreferenceModel = CindyMediaCatalogConfig['models'][number] & {
  modelId: string;
  modelName: string;
  providerName: string;
  group: string;
  routing?: import('@cindy/model-providers').Provider['routing'];
};

interface CindyMediaPreferenceConfig {
  models: CindyMediaPreferenceModel[];
  defaults: { standard: string; draft: string; best: string } | null;
}

/** Art 等插件的媒体偏好统一合并已就绪 Provider 与 Gateway 可执行模型。 */
function getMediaPreferenceConfig(
  capability: GhostMediaCapability,
): CindyMediaPreferenceConfig {
  const kind = capability.startsWith('image.') ? 'image' : 'video';
  const coreCapability: MediaCapability =
    capability === 'video.edit' ? 'video.image_to_video' : capability;
  const providers = new Map(
    getActiveCatalog().providers.map((provider) => [provider.id, provider] as const),
  );
  const providerModels: CindyMediaPreferenceModel[] = selectExecutableCoreMediaModels(
    kind === 'video' ? listLocalProviderVideoModels() : listProviderMediaModels(),
    kind,
    (model) => supportsMediaCapability(model.modalities, coreCapability),
  )
    .map((model) => {
      const provider = providers.get(model.providerId);
      const providerName = provider?.name ?? model.providerId;
      return {
        id: encodeMediaPreference(model.providerId, model.id),
        modelId: model.id,
        label: model.name,
        modelName: model.name,
        providerId: model.providerId,
        providerName,
        group: providerName,
        ...(provider?.routing ? { routing: provider.routing } : {}),
        supportsEdit: supportsMediaCapability(model.modalities, 'image.edit'),
      };
    });
  const gatewayModels: CindyMediaPreferenceModel[] = selectExecutableCoreMediaModels(
    filterEnabledGatewayMediaModels(
      getXdGatewayModels(),
      coreCapability,
      readModelDisableOverrides(),
    ),
    kind,
    (model) => isMediaModelExecutable(model.id, coreCapability),
  )
    .map((model) => {
      const provider = providers.get('xd');
      const providerName = provider?.name ?? 'Cindy AI';
      const modelName = model.name ?? model.id;
      return {
        id: encodeMediaPreference('xd', model.id),
        modelId: model.id,
        label: modelName,
        modelName,
        providerId: 'xd',
        providerName,
        group: providerName,
        ...(provider?.routing ? { routing: provider.routing } : {}),
        supportsEdit: isMediaModelExecutable(
          model.id,
          kind === 'image' ? 'image.edit' : 'video.image_to_video',
        ),
      };
    });
  const models = [...gatewayModels, ...providerModels];
  const standard = gatewayModels[0]?.id ?? providerModels[0]?.id;
  return {
    models,
    defaults: standard ? { standard, draft: standard, best: standard } : null,
  };
}

function resolveMediaPreferenceModel(
  config: CindyMediaPreferenceConfig,
  preference: string | undefined,
): CindyMediaPreferenceModel | null {
  if (!preference) return null;
  const exact = config.models.find((model) => model.id === preference);
  if (exact) return exact;
  if (decodeMediaPreference(preference)) return null;
  if (!preference.includes('/')) {
    const legacyXdMatches = config.models.filter(
      (model) =>
        model.providerId === 'xd' &&
        model.modelId.slice(model.modelId.lastIndexOf('/') + 1) === preference,
    );
    if (legacyXdMatches.length === 1) return legacyXdMatches[0]!;
  }
  return (
    config.models.find((model) => model.providerId === 'xd' && model.modelId === preference) ??
    config.models.find((model) => model.modelId === preference) ??
    null
  );
}

function resolveMediaPreferenceOrDefault(
  config: CindyMediaPreferenceConfig,
  preference: string | undefined,
): CindyMediaPreferenceModel | null {
  return (
    resolveMediaPreferenceModel(config, preference) ??
    resolveMediaPreferenceModel(config, config.defaults?.standard)
  );
}

/**
 * Art 1.12.5–1.13.2 已经走 Core media，但还不会在 prepare 时传
 * providerId。这段兼容窗口对同名模型选择一个可用来源并优先 Cindy AI；
 * 1.13.3 起插件会传完整来源，恢复全部 Provider 选择。
 */
function isProviderBlindCoreArt(ghost: InstalledGhost): boolean {
  return (
    ghost.manifest.id === 'cindy-art' &&
    supportsCindyVersion(ghost.manifest.version, '1.12.5') &&
    !supportsCindyVersion(ghost.manifest.version, '1.13.3')
  );
}

/** 旧插件无法区分同 modelId 的来源：冲突时优先 XD，否则保留第一个可用来源。 */
function collapseProviderBlindMediaModels<T extends { providerId: string }>(
  models: readonly T[],
  modelId: (model: T) => string,
): T[] {
  const grouped = new Map<string, T[]>();
  for (const model of models) {
    const id = modelId(model);
    const group = grouped.get(id) ?? [];
    group.push(model);
    grouped.set(id, group);
  }
  const selected: T[] = [];
  for (const group of grouped.values()) {
    const xd = group.find((model) => model.providerId === 'xd');
    selected.push(xd ?? group[0]!);
  }
  return selected;
}

function getGhostMediaPreferenceConfig(
  ghostId: string,
  capability: GhostMediaCapability,
): CindyMediaPreferenceConfig {
  const config = getMediaPreferenceConfig(capability);
  const ghost = getGhostManager().list().find((candidate) => candidate.manifest.id === ghostId);
  if (!ghost || !isProviderBlindCoreArt(ghost)) return config;
  const models = collapseProviderBlindMediaModels(config.models, (model) => model.modelId);
  const standard = models[0]?.id;
  return {
    models,
    defaults: standard ? { standard, draft: standard, best: standard } : null,
  };
}

/** 存量钉定已失效或旧插件无法表达时，一次性升级为当前可用选型。 */
function resolveAndMigrateGhostMediaPreference(
  ghostId: string,
  capability: GhostMediaCapability,
  config: CindyMediaPreferenceConfig,
  preference: string | undefined,
): CindyMediaPreferenceModel | null {
  const selected = resolveMediaPreferenceOrDefault(config, preference);
  if (preference && selected && preference !== selected.id) {
    try {
      writeGhostCindyOverride(ghostId, capability, selected.id);
      log.info('migrating stale ghost media preference to available model', {
        ghostId,
        capability,
        previousPreference: preference,
        nextPreference: selected.id,
      });
    } catch (error) {
      log.warn('persisting migrated ghost media preference failed; using runtime fallback', {
        ghostId,
        capability,
        previousPreference: preference,
        fallbackPreference: selected.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return selected;
}

/**
 * 插件配置页的模型目录；这里只读目录，不提供任何生成入口。Host 只按 Gateway mode
 * 切图片/视频大类并透传 modalities，具体动作支持度由插件自行解释。
 */
async function getGhostConfigurableMediaModels(
  ghostId: string,
  type: GhostMediaModelType,
): Promise<GhostMediaModelsResult> {
  const ghost = findAvailableGhost(ghostId);
  if (!ghost || !ghost.enabled) {
    return { ok: false, errorCode: 'NOT_AVAILABLE', message: '插件当前不可用' };
  }
  const declared = ghost.manifest.cindy?.[type] ?? [];
  if (declared.length === 0) {
    return {
      ok: false,
      errorCode: 'PERMISSION_DENIED',
      message: `插件未声明 Cindy ${type} 能力`,
    };
  }
  try {
    // 类型目录返回该大类所有至少有一种可执行操作的模型；具体支持动作由
    // Gateway modalities 透传给插件判断，不能把插件声明的多个动作取交集。
    // The generic media-access snapshot is Gateway-first and historically only
    // carried image-provider models. Video providers are host-owned (the video
    // registry executes them), so add their local projection explicitly and do
    // not let an unavailable Gateway snapshot hide an otherwise ready xAI list.
    const localVideoModels = type === 'video' ? listLocalProviderVideoModels() : [];
    const availability = await loadPluginMediaAvailability(
      type,
      localVideoModels.length,
      () => listExecutableMediaModels(),
    );
    const allModels = [...availability.models, ...localVideoModels].filter(
      (model, index, models) =>
        models.findIndex(
          (candidate) => candidate.id === model.id && candidate.providerId === model.providerId,
        ) === index,
    );
    const candidates = selectExecutableCoreMediaModels(allModels, type);
    const models = isProviderBlindCoreArt(ghost)
      ? collapseProviderBlindMediaModels(candidates, (model) => model.id)
      : candidates;
    if (
      models.length === 0 &&
      availability.unavailable.some((model) => model.retryable)
    ) {
      return {
        ok: false,
        errorCode: 'NOT_AVAILABLE',
        message: '媒体调用说明暂时无法读取，请稍后重试',
      };
    }
    if (availability.unavailable.length > 0) {
      log.warn('plugin media catalog skipped unavailable models', {
        ghostId,
        type,
        unavailableModelCount: availability.unavailable.length,
      });
    }
    return {
      ok: true,
      type,
      models: models.map((model) => ({
        id: model.id,
        name: model.name ?? model.id,
        providerId: model.providerId,
        ...(model.modalities
          ? {
              modalities: {
                input: [...model.modalities.input],
                output: [...model.modalities.output],
              },
            }
          : {}),
      })),
      defaultModelId: models.find((model) => model.providerId === 'xd')?.id ?? models[0]?.id ?? null,
      defaultProviderId:
        models.find((model) => model.providerId === 'xd')?.providerId ??
        models[0]?.providerId ??
        null,
    };
  } catch (error) {
    log.warn('read plugin media model catalog failed', {
      ghostId,
      type,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, errorCode: 'NOT_AVAILABLE', message: '媒体模型目录暂不可用' };
  }
}

/**
 * 读取插件在 Host「Cindy 能力」中的现有媒体选型。
 * 已配置模型失效，或旧插件无法表达完整来源时，回落到当前第一个
 * 可用模型，并一次性迁移存量配置，保证页面展示与实际执行一致。
 */
function getGhostConfiguredMediaModel(
  ghostId: string,
  capability: unknown,
): GhostCindyPreferenceResult {
  if (
    typeof capability !== 'string' ||
    !(GHOST_MEDIA_CAPABILITIES as readonly string[]).includes(capability)
  ) {
    return { ok: false, errorCode: 'INVALID_REQUEST', message: '未知的 Cindy 媒体能力' };
  }
  const mediaCapability = capability as GhostMediaCapability;
  const [type, action] = mediaCapability.split('.') as ['image' | 'video', 'generate' | 'edit'];
  const ghost = findAvailableGhost(ghostId);
  if (!ghost || !ghost.enabled) {
    return { ok: false, errorCode: 'NOT_AVAILABLE', message: '插件当前不可用' };
  }
  const declared = ghost.manifest.cindy?.[type] ?? [];
  if (!declared.includes(action)) {
    return {
      ok: false,
      errorCode: 'PERMISSION_DENIED',
      message: `插件未声明 Cindy ${mediaCapability} 能力`,
    };
  }

  const config = getGhostMediaPreferenceConfig(ghostId, mediaCapability);
  const override = readGhostCindyOverrides(ghostId)[mediaCapability];
  const selected = resolveAndMigrateGhostMediaPreference(
    ghostId,
    mediaCapability,
    config,
    override,
  );
  if (!selected) {
    return {
      ok: false,
      errorCode: 'NOT_AVAILABLE',
      message: '当前没有可用的媒体模型',
    };
  }
  return {
    ok: true,
    capability: mediaCapability,
    modelId: selected.modelId,
    providerId: selected.providerId,
  };
}

/**
 * 派发前重查(PR #744 review 第二十轮):cindySlot 从白名单校验到实际下单之间隔着
 * 归属查账、参考图准备等长 await,期间该媒体模型 / 供应商可能被用户停用 —— 在
 * generateImage / editImage / 视频提交边界按**当前** override 重算启用候选再验一次,
 * 不在册即拒,这次付费请求不发出(与 scheduler 派发前重裁决同语义)。
 */
function assertMediaModelStillEnabled(
  kind: 'image' | 'video',
  model: string,
  providerId?: string,
  action: LegacyCindyMediaAction = 'generate',
): void {
  const capability: GhostMediaCapability = `${kind}.${action}`;
  const available =
    providerId && kind === 'image' && providerId !== 'xd'
      ? getMediaPreferenceConfig(capability).models.some(
          (candidate) => candidate.providerId === providerId && candidate.modelId === model,
        )
      : getCatalogMediaConfig(kind, action, providerId).models.some(
          (candidate) =>
            candidate.id === model && (!providerId || candidate.providerId === providerId),
        );
  if (!available) {
    throw new Error(
      kind === 'image'
        ? '图像模型不可用(可能已停用或来源凭证未就绪),本次生成已取消'
        : '视频模型不可用(可能已停用或来源凭证未就绪),本次生成已取消',
    );
  }
}

/**
 * 把图片通道的底层报错翻译成用户可行动的话术(意识交卷失败时 AI 会原样
 * 转述给用户,裸网关英文错误没人看得懂)。
 */
function humanizeImageChannelError(err: unknown): never {
  const raw = err instanceof Error ? err.message : String(err);
  if (/api key not found/i.test(raw)) {
    throw new Error('图像能力不可用:尚未获得模型额度,请先在「设置 → 账号」登录飞书后重试');
  }
  throw err instanceof Error ? err : new Error(raw);
}

/** 参考图扩展名 → data URI 的 mime(视频 provider 收 base64 data URI)。 */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** 磁盘图片 → base64 data URI(edit_video 参考图注入用;意识只经手指纹,路径在主机侧)。 */
async function readImageFileAsDataUri(absPath: string): Promise<string> {
  const mime = IMAGE_MIME_BY_EXT[path.extname(absPath).toLowerCase()];
  if (!mime) throw new Error(`参考图格式不支持:${path.extname(absPath) || '(无扩展名)'}`);
  const bytes = await fs.promises.readFile(absPath);
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

/**
 * 视频代办执行(cindy 槽 → art 视频 provider 层):alias 已过白名单校验,
 * registry 缺席(极端:art 服务未配视频 provider)时人话报错。
 * submit→轮询→下载一条龙在 @cindy/mcps submitAndAwaitVideo(原 lizi_art 工具层
 * 的执行链,工具壳已退役);分钟级长任务,期间 cindySlot 在途名额持续占用。
 */
async function runGhostVideo(
  params: {
    alias: string;
    providerId?: string;
    prompt: string;
    imageDataUris?: string[];
    /** 参考图用法(仅图生视频有);不传 = 执行器缺省的首尾帧。 */
    refMode?: GhostVideoRefMode;
  } & CindyVideoParams,
): Promise<{ buffer: Buffer; mimeType: string; videoParams: GhostVideoResultParams }> {
  const registry = getVideoProviderRegistry();
  if (!registry || !registry.hasAny()) {
    throw new Error('视频能力不可用:主机未配置视频通道');
  }
  if (params.providerId && !registry.hasAlias(params.alias, params.providerId)) {
    throw new Error('视频模型与所选来源不匹配,本次生成已取消');
  }
  // 提交紧前重查(第二十一轮):参考图 data URI 准备是 await,窗口内被停用即拒。
  assertMediaModelStillEnabled(
    'video',
    params.alias,
    params.providerId,
    params.imageDataUris ? 'edit' : 'generate',
  );
  const r = await submitAndAwaitVideo(registry, params);
  return {
    buffer: r.buffer,
    mimeType: r.mimeType,
    // 实际生效参数回执(执行器已把上游上报值与提交值合并过)。
    videoParams: {
      durationSeconds: r.effectiveParams.duration,
      resolution: r.effectiveParams.resolution,
      ratio: r.effectiveParams.ratio,
      fps: r.effectiveParams.fps,
      // 音轨状态执行器可能给不出(型号没这个旋钮 / 支持但没登记上游默认):
      // 给不出就不带这个键,别把"说不上来"写成 false。
      ...(r.effectiveParams.audio !== undefined ? { audio: r.effectiveParams.audio } : {}),
    },
  };
}

/**
 * 某视频型号的画面参数支持集(cindySlot 按型号二次校验用)。registry 缺席
 * 或 alias 查无 → null,cindySlot 据此跳过按型号校验(值仍会被执行器兜底拦下)。
 */
function getGhostVideoCapabilities(
  model: string,
  providerId?: string,
): CindyVideoCapabilities | null {
  try {
    if (providerId) {
      const available = getMediaPreferenceConfig('video.generate').models.some(
        (candidate) => candidate.providerId === providerId && candidate.modelId === model,
      );
      if (!available) return null;
    }
    const registry = getVideoProviderRegistry();
    if (!registry || !registry.hasAny()) return null;
    if (providerId && !registry.hasAlias(model, providerId)) return null;
    const caps = registry.resolveByAlias(model).provider.capabilities;
    return {
      durations: caps.supportedDurations,
      resolutions: caps.supportedResolutions,
      ratios: caps.supportedRatios,
      fps: caps.supportedFps,
      maxImagesByRefMode: caps.maxImagesByRefMode,
      supportsAudio: caps.supportsAudio,
    };
  } catch {
    return null;
  }
}

/** 图像 provider 的型号级编辑上限；slot 用它在文件 IO / 凭证读取前早拒。 */
function getGhostImageCapabilities(
  model: string,
  providerId?: string,
): CindyImageCapabilities | null {
  try {
    return {
      maxEditImages: resolveImageChannelForModel(model, 'edit', providerId).maxEditImages,
    };
  } catch {
    return null;
  }
}

/**
 * 意识画幅意图 → XD Gateway size。三档尺寸是 gpt-image 系的原生枚举
 * (1024x1024 / 1536x1024 / 1024x1536,比例即枚举名);Gemini 系由网关按
 * 比例转译。意识侧枚举扩值域时此表必须同步补齐(Record 穷尽性由类型锁住)。
 */
const GHOST_ASPECT_TO_GATEWAY_SIZE: Record<GhostImageAspectRatio, string> = {
  '1:1': '1024x1024',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
};

/**
 * 图像执行通道注册表单例(见 imageChannelRegistry.ts 头注)。xd 通道在此登记:
 * ready 跟随网关能力(canUseCindyGateway;key 缺失时 requireApiKey 在派发时人话拒,
 * 与历史行为一致),backend 是 cindyProxyMedia 的网关客户端,aspectRatio → 网关
 * size 枚举的翻译在适配层完成(通道各家 wire 不同,意图翻译是通道自己的知识)。
 * 后续来源(gemini / openai / xai)在各自 PR 里追加注册。
 */
let imageChannelRegistrySingleton: ImageChannelRegistry | null = null;
function getImageChannelRegistry(): ImageChannelRegistry {
  if (!imageChannelRegistrySingleton) {
    const registry = new ImageChannelRegistry();
    registry.register('xd', {
      ready: () => getAppCapabilities().canUseCindyGateway,
      generateImage: ({ model, prompt, aspectRatio }) =>
        getCindyProxyMediaService().backend.generateImage({
          model,
          prompt,
          // 不带画幅意图时不传 size,网关缺省 'auto'(模型自定)。
          ...(aspectRatio ? { size: GHOST_ASPECT_TO_GATEWAY_SIZE[aspectRatio] } : {}),
        }),
      editImage: ({ model, prompt, imagePaths, aspectRatio }) =>
        getCindyProxyMediaService().backend.editImage({
          model,
          prompt,
          imagePaths,
          // 改图的 auto 语义 = 跟随源图画幅,与放开之前行为一致。
          ...(aspectRatio ? { size: GHOST_ASPECT_TO_GATEWAY_SIZE[aspectRatio] } : {}),
        }),
    });
    const readXaiApiImageKey = (): string | null => {
      // 图片凭证只取路由命中官方 api.x.ai 端点的 runtime:代理 runtime 的密钥
      // 不得发往官方图片端点(避免 401/403 与凭证披露,见 PR #3875 review)。
      const provider = getActiveCatalog().providers.find(
        (candidate) => candidate.id === XAI_API_CUSTOM_PROVIDER_ID,
      );
      for (const agent of xaiApiOfficialRuntimeAgents(provider)) {
        const value = readCustomProviderKey(XAI_API_CUSTOM_PROVIDER_ID, agent)?.trim();
        if (value) return value;
      }
      return null;
    };
    const hasXaiApiImageKey = (): boolean =>
      getActiveCatalog().providers.some(
        (provider) => provider.id === XAI_API_CUSTOM_PROVIDER_ID,
      ) && readXaiApiImageKey() !== null;
    registry.register(
      'xai-api',
      createXaiImageChannel({
        hasApiKey: hasXaiApiImageKey,
        getApiKey: readXaiApiImageKey,
        hasOAuthLogin: () => false,
        getCredentialGeneration: () => 0,
        getOwnerScopeKey: () => activeOwnerScopeKey(),
        isOwnerBoundaryPending: () => isGhostBoundaryPending(),
        fetchImplementation: ((url, init) => outboundFetch(url as string, init)) as typeof fetch,
        beforeDispatch: (model) => assertMediaModelStillEnabled('image', model, 'xai-api'),
      }),
    );
    registry.register(
      'xai',
      createXaiImageChannel({
        hasOAuthLogin: () => hasGrokOAuthLogin(),
        getAccessToken: () => getGrokAccessToken(),
        getCredentialGeneration: () => getGrokOAuthCredentialGeneration(),
        getOwnerScopeKey: () => activeOwnerScopeKey(),
        isOwnerBoundaryPending: () => isGhostBoundaryPending(),
        fetchImplementation: ((url, init) => outboundFetch(url as string, init)) as typeof fetch,
        beforeDispatch: (model) => assertMediaModelStillEnabled('image', model),
        onAuthRejected: (failure) => invalidateXaiBridgeAuth(failure),
      }),
    );
    // Gemini(BYO API key,generateContent wire):ready = key 已配置。停用轴
    // 派发前重查经 beforeDispatch 注入(与 xd 通道的 cindyProxyMedia beforeDispatch
    // 同语义 —— xd 的挂在网关客户端装配处,gemini 的挂在这里)。
    registry.register(
      'gemini',
      createGeminiImageChannel({
        getApiKey: () => getProviderSecretStore().get('gemini'),
        // googleapis 境外端点经 outboundFetch 吃系统代理:main 的裸 fetch 不读系统
        // 代理设置,代理软件非 TUN 模式下会直连失败(xd 网关域名境内直连,不注)。
        fetchImplementation: ((url, init) => outboundFetch(url as string, init)) as typeof fetch,
        beforeDispatch: (model) => assertMediaModelStillEnabled('image', model),
      }),
    );
    // OpenAI public Images API(BYO 平台 key):与 xd 网关同 wire,整个客户端复用,
    // 只换 baseUrl/品牌话术/凭证读取。ChatGPT/Codex 订阅走下方独立的 hosted-tool
    // 通道;目录 id 带 openai/ 前缀,public API 适配层剥前缀。
    const openaiImagesClient = createGatewayImageClient({
      getApiKey: () => getProviderSecretStore().get('openai-images'),
      logger: log,
      // 境外端点吃系统代理(outboundFetch):main 的裸 fetch 不读系统代理设置,
      // 代理软件非 TUN 模式下会直连失败(2026-07 review;xd 网关通道不注 ——
      // 网关域名境内直连,与现状一致)。
      fetchImplementation: ((url, init) => outboundFetch(url as string, init)) as typeof fetch,
      proxy: {
        baseUrl: 'https://api.openai.com',
        generatePath: '/v1/images/generations',
        editPath: '/v1/images/edits',
      },
      brandLabel: 'OpenAI',
      missingKeyMessage: 'OpenAI 图像 API key 未配置,请到「设置 → 模型供应商 → OpenAI」填入后重试',
      beforeDispatch: (model) =>
        assertMediaModelStillEnabled('image', `openai/${model}`, 'openai'),
    });
    const stripOpenaiPrefix = (id: string) =>
      id.startsWith('openai/') ? id.slice('openai/'.length) : id;
    const hasOpenaiPlatformKey = () =>
      (getProviderSecretStore().get('openai-images')?.trim() ?? '') !== '';
    const codexImagesClient = createCodexImageChannel({
      hasOAuthLogin: hasCodexOAuthLoginReadOnly,
      getAuth: () => getCodexImageAuthBinding().getAuth(),
      onAuthFailure: async (failure) => {
        await getCodexImageAuthBinding().onAuthFailure(failure);
      },
      fetchImplementation: ((url, init) => outboundFetch(url as string, init)) as typeof fetch,
      beforeDispatch: (model) => assertMediaModelStillEnabled('image', model, 'openai'),
    });
    registry.register('openai', {
      // 用户明确配置 Platform key 时优先走确定性的 public Images API；否则复用
      // 已连接的 ChatGPT/Codex 订阅 OAuth hosted tool，不要求再付一份 API 费。
      ready: () => hasOpenaiPlatformKey() || codexImagesClient.ready(),
      generateImage: (params) =>
        hasOpenaiPlatformKey()
          ? openaiImagesClient.generateImage(
              {
                model: stripOpenaiPrefix(params.model),
                prompt: params.prompt,
                ...(params.aspectRatio
                  ? { size: GHOST_ASPECT_TO_GATEWAY_SIZE[params.aspectRatio] }
                  : {}),
              },
              params.signal,
            )
          : codexImagesClient.generateImage(params),
      editImage: (params) =>
        hasOpenaiPlatformKey()
          ? openaiImagesClient.editImage(
              {
                model: stripOpenaiPrefix(params.model),
                prompt: params.prompt,
                imagePaths: params.imagePaths,
                ...(params.aspectRatio
                  ? { size: GHOST_ASPECT_TO_GATEWAY_SIZE[params.aspectRatio] }
                  : {}),
              },
              params.signal,
            )
          : codexImagesClient.editImage(params),
    });
    imageChannelRegistrySingleton = registry;
  }
  return imageChannelRegistrySingleton;
}

/**
 * 按解析出的模型定位归属来源并取执行通道。归属 = 白名单条目的 providerId
 * (cindyMediaCatalog first-wins 定格);白名单查无该模型时视同已停用
 * (assertMediaModelStillEnabled 同窗口语义)。
 */
function resolveImageChannelForModel(
  model: string,
  operation: 'generate' | 'edit' = 'generate',
  providerId?: string,
) {
  if (providerId) {
    const capability: MediaCapability = operation === 'edit' ? 'image.edit' : 'image.generate';
    const exact = getMediaPreferenceConfig(capability).models.find(
      (candidate) => candidate.providerId === providerId && candidate.modelId === model,
    );
    if (!exact) throw new Error('图像模型或来源不可用,本次生成已取消');
    if (operation === 'edit' && !exact.supportsEdit) {
      throw new Error(`图像来源 ${providerId} 不支持图像编辑,请在设置中选择支持编辑的来源`);
    }
    return getImageChannelRegistry().resolve(providerId);
  }
  const entry = getCatalogMediaConfig('image').models.find((m) => m.id === model);
  if (!entry) {
    const slash = model.indexOf('/');
    if (slash > 0) getImageChannelRegistry().resolve(model.slice(0, slash));
    throw new Error('图像模型不可用,本次生成已取消');
  }
  if (operation === 'edit' && !entry.supportsEdit) {
    throw new Error(`图像来源 ${entry.providerId} 不支持图像编辑,请在设置中选择支持编辑的来源`);
  }
  return getImageChannelRegistry().resolve(entry.providerId);
}

function listLocalProviderMediaModels() {
  const access = readModelDisableOverrides();
  return getActiveCatalog().providers.flatMap((provider) => {
    if (
      provider.id === 'xd' ||
      isProviderDisabled(access, provider.id) ||
      !getImageChannelRegistry().isProviderReady(provider.id)
    ) {
      return [];
    }
    const supportsEdit = getImageChannelRegistry().isProviderEditReady(provider.id);
    return (provider.imageModels ?? []).flatMap((model) => {
      if (isModelDisabled(access, provider.id, model.id)) {
        return [];
      }
      // Legacy/provider catalogs may only carry id/name. The channel registry is
      // the executable capability source in that case: every registered image
      // channel accepts text generation, and editable channels additionally
      // accept an image input. Without this normalization, xAI's valid image
      // models are visible in Settings but disappear from Art's media catalog.
      const modalities = model.modalities ?? {
        input: supportsEdit ? ['text', 'image'] : ['text'],
        output: ['image'],
      };
      if (!modalities.output.includes('image')) return [];
      const input = supportsEdit
        ? [...modalities.input]
        : modalities.input.filter((modality) => modality !== 'image');
      return [
        {
          id: model.id,
          name: model.name,
          providerId: provider.id,
          mode: 'image_generation' as const,
          modalities: { input, output: [...modalities.output] },
          ...(model.officialDocs ? { officialDocs: model.officialDocs } : {}),
        },
      ];
    });
  });
}

/**
 * Video models are executed by the host video registry rather than the image
 * provider runtime. Keep their catalog projection beside the image projection
 * so Art can read the same provider-owned models that Settings displays.
 */
function listLocalProviderVideoModels() {
  const access = readModelDisableOverrides();
  const registry = getVideoProviderRegistry();
  if (!registry) return [];
  return getActiveCatalog().providers.flatMap((provider) => {
    if (
      provider.id === 'xd' ||
      isProviderDisabled(access, provider.id) ||
      !isVideoCatalogProviderReady(provider.id)
    ) {
      return [];
    }
    return (provider.videoModels ?? []).flatMap((model) => {
      if (
        isModelDisabled(access, provider.id, model.id) ||
        !registry.hasAlias(model.id, provider.id)
      ) {
        return [];
      }
      const modalities = model.modalities ?? {
        input: ['text', 'image'],
        output: ['video'],
      };
      if (!modalities.output.includes('video')) return [];
      return [
        {
          id: model.id,
          name: model.name,
          providerId: provider.id,
          mode: 'video_generation' as const,
          modalities: { input: [...modalities.input], output: [...modalities.output] },
          ...(model.officialDocs ? { officialDocs: model.officialDocs } : {}),
        },
      ];
    });
  });
}

configureProviderMediaRuntime({
  listModels: listLocalProviderMediaModels,
  invoke: async (request) => {
    if (request.capability !== 'image.generate' && request.capability !== 'image.edit') {
      throw new Error('当前第三方 Provider 执行通道不支持该媒体能力');
    }
    const operation = request.capability === 'image.edit' ? 'edit' : 'generate';
    const channel = resolveImageChannelForModel(request.modelId, operation, request.providerId);
    if (
      operation === 'edit' &&
      channel.maxEditImages !== undefined &&
      request.imagePaths.length > channel.maxEditImages
    ) {
      throw new Error(`当前图像来源最多支持 ${channel.maxEditImages} 张参考图`);
    }
    const response =
      operation === 'edit'
        ? await channel.editImage({
            model: request.modelId,
            prompt: request.prompt,
            imagePaths: request.imagePaths,
            ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
            signal: request.signal,
          })
        : await channel.generateImage({
            model: request.modelId,
            prompt: request.prompt,
            ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
            signal: request.signal,
          });
    return decodeImageResponse(response);
  },
});

/**
 * Plugin media and storage use the same process-local AppSession owner
 * boundary as the rest of the owner-scoped runtime.
 */
function isGhostBoundaryPending(): boolean {
  return isAppSessionBoundaryPending();
}

export function getGhostCindySlot(): GhostCindySlot {
  if (!cindySlotSingleton) {
    cindySlotSingleton = new GhostCindySlot({
      getGhost: (id) => findAvailableGhost(id),
      getOwnerScopeKey: () => activeOwnerScopeKey(),
      isOwnerBoundaryPending: () => isGhostBoundaryPending(),
      // model 已在 modelSlot 按白名单校验;归属来源(providerId)按白名单条目
      // 定位,经 imageChannelRegistry 取对应执行通道(2026-07 图像多来源)。
      generateImage: async ({ prompt, model, providerId, aspectRatio }) => {
        try {
          assertMediaModelStillEnabled('image', model, providerId, 'generate');
          const channel = resolveImageChannelForModel(model, 'generate', providerId);
          return decodeImageResponse(
            await channel.generateImage({
              model,
              prompt,
              ...(aspectRatio ? { aspectRatio } : {}),
            }),
          );
        } catch (err) {
          humanizeImageChannelError(err);
        }
      },
      editImage: async ({ prompt, model, providerId, imagePaths, aspectRatio }) => {
        try {
          assertMediaModelStillEnabled('image', model, providerId, 'edit');
          const channel = resolveImageChannelForModel(model, 'edit', providerId);
          return decodeImageResponse(
            await channel.editImage({
              model,
              prompt,
              imagePaths,
              ...(aspectRatio ? { aspectRatio } : {}),
            }),
          );
        } catch (err) {
          humanizeImageChannelError(err);
        }
      },
      generateVideo: async ({ prompt, model, providerId, ...videoParams }) => {
        try {
          assertMediaModelStillEnabled('video', model, providerId, 'generate');
          return await runGhostVideo({ alias: model, providerId, prompt, ...videoParams });
        } catch (err) {
          humanizeImageChannelError(err);
        }
      },
      editVideo: async ({ prompt, model, providerId, imagePaths, refMode, ...videoParams }) => {
        try {
          assertMediaModelStillEnabled('video', model, providerId, 'edit');
          // 先算总量再读(闸按 refMode 分档:存量首尾帧不设闸,原样)。闸与
          // 读取绑在一个入口里,顺序是那边的结构保证、不是这里的约定;结果
          // 保序——顺序即语义:首/尾帧,或提示词里 [Image 1]… 的序号。
          const imageDataUris = await readRefImagesWithinBudget(
            imagePaths,
            readImageFileAsDataUri,
            refMode,
          );
          return await runGhostVideo({
            alias: model,
            providerId,
            prompt,
            imageDataUris,
            refMode,
            ...videoParams,
          });
        } catch (err) {
          humanizeImageChannelError(err);
        }
      },
      // 画面参数按型号二次校验的数据源(registry capabilities)。
      imageCapabilities: getGhostImageCapabilities,
      videoCapabilities: getGhostVideoCapabilities,
      getMediaOverride: (ghostId, capability) => {
        const value = readGhostCindyOverrides(ghostId)[capability as CindyCapabilityKey] ?? null;
        if (!value) return null;
        const mediaCapability = capability as GhostMediaCapability;
        const config = getGhostMediaPreferenceConfig(ghostId, mediaCapability);
        const videoRegistry = capability.startsWith('video.') ? getVideoProviderRegistry() : null;
        // Core 专用选型不能交给旧执行器。复用存量配置迁移，确保回退后
        // 用户保存的 provider + modelId 与实际执行一致，不影响 Core 清单。
        const executableConfig = capability.startsWith('video.')
          ? filterLegacyCindyMediaConfig(
              config,
              (model) => videoRegistry?.hasAlias(model.modelId, model.providerId) ?? false,
            )
          : config;
        const selected = resolveAndMigrateGhostMediaPreference(
          ghostId,
          mediaCapability,
          executableConfig,
          value,
        );
        return selected
          ? {
              providerId: selected.providerId,
              modelId: selected.modelId,
              label: selected.label,
            }
          : null;
      },
      getOverride: (ghostId, capability) => {
        const value = readGhostCindyOverrides(ghostId)[capability as CindyCapabilityKey] ?? null;
        return value && !decodeMediaPreference(value) ? value : null;
      },
      getImageConfig: getCatalogImageConfig,
      getVideoConfig: getCatalogVideoConfig,
      getEmbedConfig: getCatalogEmbedConfig,
      // 文本转向量(embed.text):走主机统一 embedding 通道(与聊天历史语义检索
      // 同一条付费链路)。只生成不存储 —— embedSync 明确不入队、不写 vec 表,
      // 向量原样返回给意识自己保管。
      //
      // 动态 import 同 oneshotText,且**只对 embedding-host 一家**:它的传递依赖会
      // 拽起 localDb → runtime-configs,静态引入会让所有 import 本模块的单测炸在
      // electron mock 上(PR #1707 review 实测:collabSendOutcome.test.ts 报
      // app.getAppPath is not a function)。@cindy/embedding-client 是零运行依赖的
      // 纯包,已改为顶层静态 import,不必陪着动态化。
      embedText: async ({ texts, model, inputType, dimensions, timeoutMs }) => {
        // ensureEmbeddingServiceForPluginVector 而不是 getEmbeddingService:host 的启停
        // 不归「聊天嵌入」开关独占 —— 那个开关关着时 host 不启动,直接取 service 必抛
        // not-started,已授权的 embed_text 全变 INTERNAL(PR #1707 review)。这里打标
        // 成"插件向量 consumer 在用"并按需懒启动。
        const { ensureEmbeddingServiceForPluginVector } =
          await import('../embedding-host/index.js');
        // 白名单已在 slot 层校验过,这里是纵深防御:目录里出现了 embedding catalog
        // 不认识的 id(两边不同步)时早失败,而不是把不认识的 id 发去网关。
        if (!isKnownEmbeddingModel(model)) {
          throw new Error(`未知的向量模型 ${model}(不在 embedding catalog 内)`);
        }
        const res = await ensureEmbeddingServiceForPluginVector().embedSync(texts, {
          modelId: model,
          ...(inputType !== undefined ? { inputType } : {}),
          ...(dimensions !== undefined ? { dimensions } : {}),
          // slot 层给的时间预算必须原样递到 client —— 中间任何一层吞掉它,
          // 插件那侧就又变成"网关不返数据即永久挂住一格在途额度"。
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        });
        return { embeddings: res.embeddings, modelUsed: res.modelUsed };
      },
      // 上下文化嵌入(voyage-context-* 索引侧):同上,只是 input 按文档分组。
      embedDocuments: async ({ documents, model, inputType, dimensions, timeoutMs }) => {
        const { ensureEmbeddingServiceForPluginVector } =
          await import('../embedding-host/index.js');
        if (!isKnownEmbeddingModel(model)) {
          throw new Error(`未知的向量模型 ${model}(不在 embedding catalog 内)`);
        }
        const res = await ensureEmbeddingServiceForPluginVector().embedDocumentsSync(documents, {
          modelId: model,
          ...(inputType !== undefined ? { inputType } : {}),
          ...(dimensions !== undefined ? { dimensions } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        });
        return { embeddings: res.embeddings, modelUsed: res.modelUsed };
      },
      // 在途并发上限:用户级隐藏配置(ghost-cindy-prefs.json 的 inflightLimits),
      // 缺省 null = 不限并发;每单现读,改配置即生效。
      getInflightLimit: (ghostId) => readGhostCindyInflightLimit(ghostId),
      // Web Search:固定走主机托管的 LiteLLM /v1/messages。endpoint/key 与
      // model-access 下发值同源，模型别名和 Claude 原生 Web Search 工具定义
      // 留在主机侧，意识只拿规范化结果。
      searchWeb: (params) => getCindyProxySearchService().search(params),
      // 快问快答(text.oneshot):走轻量任务模型链(与会话起标题/任务摘要
      // 同一条,用户在设置里配置)。动态 import:utility-model 的传递依赖在
      // 模块顶层读 electron app 路径,静态引入会把这条链拽进所有 import 本
      // 模块的单测(hook-script-generator 同款做法)。失败面折叠成 slot 层
      // 的三档 reason;attempts 细节只进日志,不给沙箱探测面。
      oneshotText: async ({ prompt, maxTokens, timeoutMs, route }) => {
        const [{ requestUtilityText }, { getMaker }] = await Promise.all([
          import('../utility-model/oneShotCandidates.js'),
          import('../maker-host/index.js'),
        ]);
        const r = await requestUtilityText(getMaker(), prompt, {
          maxTokens,
          timeoutMs,
          // 路由两形态:轻量档位键走链档钉(不认的值下游忽略回默认链);
          // 目录钉走显式供应商路径(钉死,不回落)。
          ...(route?.kind === 'utility-profile' ? { pinnedProfileId: route.profileId } : {}),
          ...(route?.kind === 'catalog'
            ? { providerId: route.providerId, agentKind: route.agentKind, model: route.model }
            : {}),
        });
        if (r.ok) {
          // 快问快答不设输出 token 上限:与宿主会话一致,用户主动使用插件的
          // 成本由用户承担,宿主不额外钳制(2026-08-07 决策:全部限制拿掉)。
          return { ok: true, text: r.text, model: `${r.providerId}/${r.model}` };
        }
        log.warn('ghost oneshot_text utility chain failed', {
          reason: r.reason,
          attempts: r.attempts.map((a) => `${a.providerId}/${a.model}:${a.reason}`),
        });
        if (r.reason === 'no_candidate') {
          return {
            ok: false,
            reason: 'no_candidate',
            message: '当前没有可用的快速通道模型(用户未配置或凭证不可用),请如实告知用户并优雅降级',
          };
        }
        if (r.reason === 'timeout') {
          return { ok: false, reason: 'timeout', message: '快问快答超时,请稍后再试' };
        }
        return { ok: false, reason: 'failed', message: '快速通道各候选均失败,请稍后再试' };
      },
      // 身份卡声明的偏好模型(cindy.oneshotModel)→ 当前目录里可路由且有凭证的
      // 条目;目录没有/已停用/不可路由/未配置 = null,slot 层按未声明回落系统默认链。
      resolveOneshotModel: (modelId) =>
        resolveOneshotCatalogModel(
          getActiveCatalog(),
          readModelDisableOverrides(),
          modelId,
          readProviderOrder(),
          hasOneshotProviderCredential,
        ),
      // 管子续命挂钩:同步视频代办(署名单)在途期间替 tool-call 续命,
      // 免得分钟级生成被管子 330s 基础窗口掐掉(任务后台继续烧钱、结果作废)。
      // ghostId 由派发器配对验身:冒用他人在途 callId 不能续命/收短别人的卷。
      holdPipeCall: (ghostId, callId, budgetMs) =>
        getGhostPipeDispatcher().holdCall(ghostId, callId, budgetMs),
      releasePipeCall: (ghostId, callId) => getGhostPipeDispatcher().releaseCall(ghostId, callId),
      claimPipeCall: (ghostId, callId, callerTool, binding, requestKey) =>
        getGhostPipeDispatcher().claimPendingCall(
          ghostId,
          callId,
          callerTool,
          binding,
          requestKey,
        ),
      settlePipeCallClaim: (
        ghostId,
        callId,
        callerTool,
        binding,
        requestKey,
        allowRetry,
      ) =>
        getGhostPipeDispatcher().settlePendingCallClaim(
          ghostId,
          callId,
          callerTool,
          binding,
          requestKey,
          allowRetry,
        ),
      // 视频型号预期耗时(registry 登记值;hold 预算与异步受理返回共用)。
      // registry 缺席/型号查无 → null,cindySlot 用自己的缺省。
      videoExpectedSeconds: (model) => {
        try {
          const registry = getVideoProviderRegistry();
          if (!registry || !registry.hasAny()) return null;
          return registry.resolveByAlias(model).expectedSeconds;
        } catch {
          return null;
        }
      },
      resolveOwnedMedia: async (ghostId, hash, ownerScopeKey) => {
        const assertOwnerScopeCurrent = (): void => {
          if (isGhostBoundaryPending() || activeOwnerScopeKey() !== ownerScopeKey) {
            throw new Error('媒体任务期间账号已切换,本次结果已丢弃');
          }
        };
        // 归属(账本)→ 落盘元数据(账本)→ 磁盘路径(指纹仓校验),
        // 任一环查无即 null;modelSlot 对外统一话术不泄露差异。defaultDb
        // 会随账号动态变化，因此先在稳定 scope 下捕获一次 DB，并让两次查询
        // 始终复用它；每个 await 后再 fail closed，绝不读取新账号账本。
        assertOwnerScopeCurrent();
        const db = getDbClient().drizzle;
        const canRead = await ledger.ghostCanRead(hash, ghostId, db);
        assertOwnerScopeCurrent();
        if (!canRead) return null;
        const info = await ledger.getBlobInfo(hash, db);
        assertOwnerScopeCurrent();
        if (!info) return null;
        let absPath: string;
        try {
          absPath = blobStore.resolveHashRef(hash, info.ext).absPath;
        } catch {
          return null;
        }
        assertOwnerScopeCurrent();
        return absPath;
      },
      saveGhostMedia: async ({ ghostId, buffer, mimeType, ownerScopeKey, label, callId }) => {
        const assertOwnerScopeCurrent = (): void => {
          if (isGhostBoundaryPending() || activeOwnerScopeKey() !== ownerScopeKey) {
            throw new Error('媒体任务期间账号已切换,本次结果已丢弃');
          }
        };
        // defaultDb 会在每次 ledger 调用时现取当前账号 DB。先在稳定 scope 下
        // 捕获同一个句柄，再把失效断言交给统一入库助手覆盖所有 await 边界，
        // 防止旧账号产物在切号窗口被登记到新账号画廊。
        assertOwnerScopeCurrent();
        const db = getDbClient().drizzle;
        const written = await ingestMedia(
          {
            buffer,
            mimeType,
            isCache: false,
            refs: [
              {
                refKind: 'ghost-gallery',
                refId: ghostId,
                originKind: 'ghost',
                originId: ghostId,
                ...(label ? { label } : {}),
              },
            ],
            assertStillValid: assertOwnerScopeCurrent,
            refCompensationScope: captureMediaRefCompensationScope(ownerScopeKey),
          },
          db,
        );
        recordGhostCallMedia(ghostId, callId, written.url);
        return { url: written.url, hash: written.hash, ext: written.ext };
      },
      // ── deposit_media 接线(#784)────────────────────────────────────────
      // 真实类型只认字节:与 network as:'media' 同一魔数实现,再过一道 blobStore
      // 白名单(识别范围与白名单可能不同步时以白名单为准)。
      sniffDepositMime: (buffer) => {
        const sniffed = sniffMediaMime(buffer);
        return sniffed && supportedMime(sniffed) ? sniffed : null;
      },
      // 寄存落仓:走统一入库助手(规则 25),挂 ghost-deposit 引用。
      // originKind 记 'user' 而非 'ghost'——字节是用户的(粘贴/拖入),意识只是
      // 管道;记成 'ghost' 会让 ghostCanRead 的 origin 分支把它当作该意识的
      // 出生物,与"作品"混为一谈。引用方(refId)才是意识,归属由此成立。
      depositMedia: async ({ ghostId, buffer, mimeType, label }) => {
        // 与 saveGhostMedia 同口径的应用会话守卫:寄存器引用按 ghostId
        // 落到 owner 作用域账本,落盘窗口切换账号时必须 fail closed。
        const ownerScopeKey = activeOwnerScopeKey();
        const assertOwnerScopeCurrent = (): void => {
          if (isGhostBoundaryPending() || activeOwnerScopeKey() !== ownerScopeKey) {
            throw new Error('媒体任务期间账号已切换,本次结果已丢弃');
          }
        };
        assertOwnerScopeCurrent();
        const db = getDbClient().drizzle;
        const r = await ingestMedia(
          {
            buffer,
            mimeType,
            isCache: false,
            refs: [
              {
                refKind: 'ghost-deposit',
                refId: ghostId,
                originKind: 'user',
                ...(label ? { label } : {}),
              },
            ],
            assertStillValid: assertOwnerScopeCurrent,
            refCompensationScope: captureMediaRefCompensationScope(ownerScopeKey),
          },
          db,
        );
        return {
          url: r.url,
          hash: r.hash,
          ext: r.ext,
          bytes: r.bytes,
          deduplicated: r.deduplicated,
        };
      },
      depositUsageBytes: (ghostId) => ledger.ghostDepositUsageBytes(ghostId),
      releaseDeposit: ({ ghostId, hash }) => ledger.removeGhostDepositRef({ hash, ghostId }),
      log,
    });
  }
  return cindySlotSingleton;
}

/**
 * OAuth 账号与令牌管理器单例(source:'oauth' 凭证的主机侧真身):授权流程、
 * refresh token 保管续期、access token 内存缓存全在这里;networkSlot 出网
 * 注入与 /oauth 设置页端点共用同一实例(缓存与单飞不分家)。保险库真身 =
 * providerSecretStore(safeStorage;派生键共享 ghost_secret_ 前缀,卸载时
 * removeGhostSecrets 的前缀清扫天然连带)。
 */
let ghostOauthManagerSingleton: GhostOauthAccountManager | null = null;
const ghostOauthOwnerReconciliationGate = createGhostOauthOwnerReconciliationGate();

function ghostOauthMutationLockPath(ghostId: string): string {
  return ownerScopedUserDataPath('ghost-install-state', '.oauth-locks', `${ghostId}.lock`);
}

function withActiveOwnerGhostOauthMutationLock<T>(
  ghostId: string,
  task: () => Promise<T> | T,
): Promise<T> {
  const ownerScope = activeOwnerScopeKey();
  return withGhostOauthMutationLock(
    ownerScope,
    ghostId,
    ghostOauthMutationLockPath(ghostId),
    async () => {
      if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== ownerScope) {
        throw new Error('Plugin OAuth owner boundary changed before mutation');
      }
      return task();
    },
  );
}

/** Reconcile migration markers once for every committed owner scope. */
export async function reconcileGhostOauthAccountsForActiveOwner(): Promise<boolean> {
  const ownerScope = activeOwnerScopeKey();
  return ghostOauthOwnerReconciliationGate.run(ownerScope, async () => {
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== ownerScope) return false;
    const oauthManager = getGhostOauthAccountManager();
    let retryPending = false;
    for (const ghost of getGhostManager().list()) {
      await withActiveOwnerGhostOauthMutationLock(ghost.manifest.id, () => {
        if (activeOwnerScopeKey() !== ownerScope) {
          throw new Error('Plugin OAuth owner changed during reconciliation');
        }
        const reconciliation = oauthManager.reconcileAccountsForInstalledManifestWithResult(
          withRuntimeFiloGoogleClient(ghost.manifest),
        );
        if (reconciliation.retryPending) retryPending = true;
      });
    }
    return !retryPending
      && !isAppSessionBoundaryPending()
      && activeOwnerScopeKey() === ownerScope;
  });
}

function getGhostOauthAccountManager(): GhostOauthAccountManager {
  if (!ghostOauthManagerSingleton) {
    ghostOauthManagerSingleton = new GhostOauthAccountManager({
      vault: {
        read: (ghostId, storageKey) => readGhostSecret(ghostId, storageKey),
        readStrict: (ghostId, storageKey) => readGhostSecretStrict(ghostId, storageKey),
        store: (ghostId, storageKey, value) => storeGhostSecret(ghostId, storageKey, value),
        remove: (ghostId, storageKey) => removeGhostSecret(ghostId, storageKey),
      },
      // 与 networkSlot 同选型:Node 侧 undici fetch(Chromium 栈的 manual redirect 给
      // opaqueredirect,守不住逐跳白名单),但经 outboundFetch 拿到系统代理 ——
      // 意识 OAuth 的 token 端点(Google / Atlassian 等)多在境外。
      fetchImpl: (url, init) => outboundFetch(url, init as RequestInit),
      openExternal: (url) => shell.openExternal(url),
      // 静态官方前缀照旧放行；其余资格由装入来源与当前组织事实共同判定。
      // 校验层保持纯函数不感知装入语境，门控在装入闸与连接闸。经独立 oauth-broker
      // 服务换/刷 token:serverApiFetch 自带登录 JWT 注入与
      // TOKEN_EXPIRED 自动刷新。基地址来自运行期端点清单;当前 region 提供该
      // 服务时恒指 broker,**不再回退主 server 老路由**
      // (2026-07 apiBaseUrl 清理:旧"编译期注入可能为空 → 回退"的分支随
      // 清单机制成为死代码;配错清单时明确 404 暴露,不静默落主 server)。
      broker: createGhostOauthBrokerClient({
        apiPost: (path, body) => {
          requireAppCapability(
            'canUseCindyOAuthBroker',
            'Cindy OAuth broker requires a Cindy account.',
          );
          return serverApiFetch(path, {
            method: 'POST',
            body,
            baseUrl: () => getClientEndpoint('oauthBrokerApiBaseUrl'),
          });
        },
        hasLoginToken: () => getAccessToken() !== null,
        logger: log,
      }),
      // brokerBounce 声明的公网弹跳地址:broker 基地址(端点清单)
      // + 声明路径现拼。不回退主 server——弹跳路由只存在于独立 oauth-broker
      // (slack provider 同款约束:绝不跨服务回退)。
      resolveBrokerPublicUrl: (path) => {
        const base = getClientEndpoint('oauthBrokerApiBaseUrl');
        return `${base.replace(/\/+$/, '')}${path}`;
      },
      logger: log,
      // 钉死回调端口(如 xd-atlassian 的 53682)被外部进程占用时自动查杀
      // 占用者并重试(2026-07-14 与 Lizi 定案;地址护栏见 portReclaim,
      // 第一方门控在 manager.connectAccount——第三方意识拿不到回收器)。
      reclaimPort: (port) => reclaimLoopbackPort(port, log),
      // 授权成功(新连/同身份重连)→ 主机代言 tips(带意识身份头;账号有
      // 展示标签时报"已连接 xxx",没有时报通用授权成功)。
      onAccountConnected: ({ ghostId, label }) => {
        getGhostSetupChangeBus().emit(ghostId, { source: 'oauth' });
        broadcastGhostsChanged(getGhostManager().list(), false, { projectionOnly: true });
        broadcastGhostHostNotice(
          ghostId,
          label
            ? { textKey: 'oauthConnected', textArgs: { label } }
            : { textKey: 'oauthConnectedNoLabel' },
        );
      },
      onAccountStatusChanged: ({ ghostId, secretKey }) => {
        getGhostSetupChangeBus().emit(ghostId, {
          source: 'oauth',
          ref: secretKey,
        });
        broadcastGhostsChanged(getGhostManager().list(), false, { projectionOnly: true });
      },
      isConnectTargetCurrent: (ghostId, secretKey, decl) => {
        const ghost = findAvailableGhost(ghostId);
        const currentDecl = ghost
          ? withRuntimeFiloGoogleClient(ghost.manifest).network?.secrets?.find(
              (secret) => secret.key === secretKey && secret.source === 'oauth',
            )?.oauth
          : undefined;
        return currentDecl !== undefined && isDeepStrictEqual(currentDecl, decl);
      },
      withMutationLock: withActiveOwnerGhostOauthMutationLock,
      isTokenBrokerAuthorized: (ghostId) => isGhostTokenBrokerAuthorized(ghostId, 'runtime'),
    });
  }
  return ghostOauthManagerSingleton;
}

/**
 * 多连接(network.connections)管理器单例:连接清单与 token 的主机侧真身,
 * /connections 设置页端点与 networkSlot 出网注入共用同一实例。保险库真身 =
 * providerSecretStore(safeStorage;派生键共享 ghost_secret_ 前缀,卸载时
 * removeGhostSecrets 的前缀清扫天然连带,无需专门清理代码)。
 */
let ghostConnectionManagerSingleton: GhostConnectionManager | null = null;
function getGhostConnectionManager(): GhostConnectionManager {
  if (!ghostConnectionManagerSingleton) {
    ghostConnectionManagerSingleton = new GhostConnectionManager({
      vault: {
        read: (ghostId, storageKey) => readGhostSecret(ghostId, storageKey),
        store: (ghostId, storageKey, value) => storeGhostSecret(ghostId, storageKey, value),
        remove: (ghostId, storageKey) => removeGhostSecret(ghostId, storageKey),
        readTail: (ghostId, storageKey) => readGhostSecretTail(ghostId, storageKey),
      },
    });
  }
  return ghostConnectionManagerSingleton;
}

let ghostSetupKvStore: GhostKvStore | null = null;

/** 默认 OAuth 账号的授权面陈旧建议；只返回首个凭证槽，保持 envelope 有界。 */
function getGhostOauthReauthSuggest(
  runtimeManifest: GhostManifest,
): GhostSetupReauthSuggest | undefined {
  const oauthManager = getGhostOauthAccountManager();
  return findGhostOauthReauthSuggest(runtimeManifest, (secretKey, decl) => {
    const defaultAccount = oauthManager
      .listAccounts(runtimeManifest.id, secretKey)
      .find((account) => account.isDefault);
    if (defaultAccount?.status === 'expired') return [];
    return oauthManager.defaultMissingScopes(runtimeManifest.id, secretKey, decl);
  });
}

/**
 * Runtime-authoritative setup assessment used by ghost_info, ghost_list and
 * ghost_call. Discovery callers treat assessment failures as best-effort and
 * omit setup; ghost_call preflight is strict, so storage or manifest drift
 * errors block dispatch.
 */
export function getGhostSetupAssessment(ghostId: string): GhostSetupAssessment {
  const ghost = findAvailableGhost(ghostId);
  if (!ghost || !ghostSetupKvStore) {
    throw new Error(`ghost setup unavailable: ${ghostId}`);
  }
  const runtimeManifest = withRuntimeFiloGoogleClient(ghost.manifest);
  const oauthManager = getGhostOauthAccountManager();
  const connectionManager = getGhostConnectionManager();
  let kvSnapshot: Record<string, unknown> | null = null;
  const assessment = evaluateGhostSetupAssessment(
    runtimeManifest,
    {
      secretSaved: (key) => ghostSecretSaved(ghostId, key),
      oauthStatus: (key) => {
        const decl = runtimeManifest.network?.secrets?.find((secret) => secret.key === key)?.oauth;
        const accounts = oauthManager.listAccounts(ghostId, key);
        return {
          clientConfigured: oauthManager.clientConfigured(ghostId, key, decl),
          connected: accounts.filter((account) => account.status === 'connected').length,
          expired: accounts.filter((account) => account.status === 'expired').length,
        };
      },
      connectionCount: (key) => connectionManager.list(ghostId, key).length,
      kvValue: (key) => {
        if (kvSnapshot === null) kvSnapshot = ghostSetupKvStore?.readStrict(ghostId) ?? {};
        return kvSnapshot[key];
      },
    },
    {
      revision: getGhostSetupChangeBus().currentRevision(ghostId),
      strict: true,
      additionalGroups: assessGhostHostSetupRequirements(runtimeManifest, {
        clientConfigReady: (configId) => configId === 'model-provider' && isModelAccessReady(),
      }),
    },
  );
  // 性能短路:required 时建议注定被丢弃,不再为它读保险库。
  // "required 绝不带建议"的契约不变量仍由 appendReadyGhostOauthReauthSuggest 守着。
  if (assessment.state !== 'ready') return assessment;
  return appendReadyGhostOauthReauthSuggest(
    assessment,
    getGhostOauthReauthSuggest(runtimeManifest),
  );
}

/**
 * Executes only Host-generated setup actions. The action id is revalidated by
 * the coordinator against a fresh assessment before this entry is called.
 */
export async function executeGhostSetupAction(args: {
  sessionId: string;
  ghostId: string;
  action: GhostSetupAllowedAction;
  responseTarget?: GhostSetupInteractionResponseTarget;
}): Promise<GhostSetupActionResult> {
  const ghost = findAvailableGhost(args.ghostId);
  if (!ghost) {
    return {
      ok: false,
      errorCode: 'TARGET_UNAVAILABLE',
      message: t('newChat.pluginSetup.pluginUnavailable'),
    };
  }
  if (args.action.kind === 'oauth_connect') {
    const secretKey = parseOauthConnectSecretKey(args.action.id);
    if (!secretKey) {
      return { ok: false, errorCode: 'ACTION_STALE', message: '授权动作已失效' };
    }
    const runtimeManifest = withRuntimeFiloGoogleClient(ghost.manifest);
    const decl = runtimeManifest.network?.secrets?.find(
      (secret) => secret.key === secretKey && secret.source === 'oauth',
    )?.oauth;
    if (!decl) {
      return {
        ok: false,
        errorCode: 'ACTION_STALE',
        message: '授权声明已变更，请重新尝试',
      };
    }
    if (decl.tokenBroker !== undefined && !isGhostTokenBrokerAuthorized(args.ghostId, 'runtime')) {
      return {
        ok: false,
        errorCode: 'AUTH_FAILED',
        message: '当前安装来源或组织身份无权使用授权 broker',
      };
    }
    const connected = await getGhostOauthAccountManager().connectAccount(
      args.ghostId,
      secretKey,
      decl,
      runtimeManifest.network?.hosts?.length
        ? { deliveryHosts: runtimeManifest.network.hosts }
        : undefined,
    );
    return connected.ok
      ? { ok: true }
      : {
          ok: false,
          errorCode: mapGhostOauthConnectError(connected.error),
          // interaction snapshot 只传稳定 errorCode；detail 可能含服务路径或
          // 上游诊断，留在 Main，不下放 Renderer。
          message: connected.detail ?? connected.error,
        };
  }

  const navigation = ghostSetupNavigationForAction(args.ghostId, args.action);
  if (!navigation) {
    return { ok: false, errorCode: 'ACTION_STALE', message: '不支持的插件设置动作' };
  }
  if (!args.responseTarget || args.responseTarget.isDestroyed()) {
    return {
      ok: false,
      errorCode: 'WINDOW_CLOSED',
      message: '发起设置的窗口已关闭，请重新尝试',
    };
  }
  // Settings are rendered by the trusted Desktop Renderer. Main sends only a
  // fixed local route target after validating the action against this ghost;
  // no URL or route supplied by Agent/plugin is accepted. The response target
  // is captured from the trusted RESOLVE_INTERACTION sender, so another window
  // observing the globally-broadcast snapshot is never navigated by this action.
  args.responseTarget.send(MAKER_PUSH.PLUGIN_SETUP_NAVIGATE, {
    sessionId: args.sessionId,
    ...navigation,
  });
  return { ok: true, waitingExternal: true };
}

/**
 * 仅供 trusted Desktop inline-setup IPC 调用。Secret 值不经过通用
 * InteractionDecision，也不进入 assessment、snapshot 或日志。
 */
export async function executeGhostSetupInlineAction(args: {
  sessionId: string;
  ghostId: string;
  action: Extract<GhostSetupAllowedAction, { kind: 'inline_form' }>;
  value: string;
}): Promise<GhostSetupActionResult> {
  return executeGhostSetupInlineSubmission(
    {
      getAssessment: getGhostSetupAssessment,
      getManifest: (ghostId) => {
        const ghost = findAvailableGhost(ghostId);
        return ghost ? withRuntimeFiloGoogleClient(ghost.manifest) : null;
      },
      storeSecret: storeGhostSecret,
      emitChange: (ghostId, secretKey) => {
        getGhostSetupChangeBus().emit(ghostId, {
          source: 'secret',
          ref: secretKey,
        });
      },
      onSaved: (ghostId, label) => {
        broadcastGhostHostNotice(ghostId, {
          textKey: 'secretSaved',
          textArgs: { name: label },
        });
      },
      logger: log,
    },
    args,
  );
}

/**
 * network 槽单例:deps 全部懒取现查——意识清单实扫、凭证保险库现读,
 * 用户填/改 key 后下一单即生效,无需任何重启。
 */
export function getGhostNetworkSlot(): GhostNetworkSlot {
  if (!networkSlotSingleton) {
    networkSlotSingleton = new GhostNetworkSlot({
      getGhost: (id) => {
        const ghost = findAvailableGhost(id);
        return ghost ? { ...ghost, manifest: withRuntimeFiloGoogleClient(ghost.manifest) } : null;
      },
      inFlightCallInfo: (callId) => getGhostCardService().inFlightCallInfoOf(callId),
      readSecret: (ghostId, secretKey) => readGhostSecret(ghostId, secretKey),
      readGhCliToken: () => getSharedGhCliTokenSource().readToken(),
      // source:'login-email' 凭证的值来源:现读登录态(切号/登出下一单即生效)。
      getLoginEmail: () => getAuthState().user?.email ?? null,
      // 用 Node 侧 undici fetch 而非 Electron net.fetch:redirect:'manual' 在 undici
      // 下如实返回 3xx + Location,本槽据此逐跳校验白名单;Chromium 栈的 manual 会给
      // opaqueredirect(读不到 Location),无法逐跳守门。系统代理由 outboundFetch 补上
      // (意识声明的域名大量在境外,裸 undici 直连在「系统代理」模式下出不去)。
      // init 收窄:body 的 Uint8Array 在 lib.dom 的 BodyInit 泛型下对不齐,
      // 运行时 undici 原生支持,按 RequestInit 交给 fetch。
      fetchImpl: (url, init) => outboundFetch(url, init as RequestInit),
      // 未在 manifest / 连接白名单声明的 Agent 在途目标不能复用普通
      // outboundFetch：它会重新解析 hostname，留下 DNS rebinding 窗口。
      // 这里每跳都以复核后的 DNS 地址建立 pinned dispatcher。
      fetchPublicImpl: (url, init, beforeDispatch) =>
        guardedOutboundFetch(url, init as RequestInit, beforeDispatch),
      // 媒体模式(as:'media'):字节直落总仓 + ghost-gallery 记账(出生=该
      // 意识,与 cindy 槽产物同一记账口径),走统一入库助手 ingestMedia
      // (规则 25)。mime 白名单同一来源(blobStore),槽内归一化后再判。
      isSupportedMediaMime: (mime) => supportedMime(mime),
      saveGhostMedia: async ({ ghostId, buffer, mimeType, label, callId }) => {
        // 与 cindy 槽 saveGhostMedia 同口径的应用会话守卫:落盘前与
        // ingestMedia 每个 await 边界都复查,防止当前进程在 fetch 读取窗口切换
        // 账号后,字节仍被登记为 ghost-gallery 作品。
        const ownerScopeKey = activeOwnerScopeKey();
        const assertOwnerScopeCurrent = (): void => {
          if (isGhostBoundaryPending() || activeOwnerScopeKey() !== ownerScopeKey) {
            throw new Error('媒体任务期间账号已切换,本次结果已丢弃');
          }
        };
        assertOwnerScopeCurrent();
        const db = getDbClient().drizzle;
        const r = await ingestMedia(
          {
            buffer,
            mimeType,
            isCache: false,
            refs: [
              {
                refKind: 'ghost-gallery',
                refId: ghostId,
                originKind: 'ghost',
                originId: ghostId,
                ...(label ? { label } : {}),
              },
            ],
            assertStillValid: assertOwnerScopeCurrent,
            refCompensationScope: captureMediaRefCompensationScope(ownerScopeKey),
          },
          db,
        );
        recordGhostCallMedia(ghostId, callId, r.url);
        return { url: r.url, hash: r.hash, ext: r.ext };
      },
      // 上传通道:归属(ghostCanRead)→ 元数据(账本)→ 读盘,三段式与
      // modelSlot 的 resolveOwnedMedia 同口径;任一环查无即 null,槽侧统一
      // 话术不泄露"不存在 vs 不属于你"的差异。
      readGhostMedia: async (ghostId, hash) => {
        if (!(await ledger.ghostCanRead(hash, ghostId))) return null;
        const info = await ledger.getBlobInfo(hash);
        if (!info) return null;
        try {
          const { buffer } = await blobStore.readFile(blobStore.blobUrl(hash, info.ext));
          return { buffer, mimeType: info.mimeType, ext: info.ext };
        } catch {
          return null;
        }
      },
      // 目录上传:凭 ghost_call 目录过户发放的一次性票据取货(dirDeposit
      // 票据库单例,与过户端同一本账)。
      takeDirDeposit: (ghostId, token) => getDirDepositVault().take(ghostId, token),
      // 下行落盘(as:'file'):凭 save 票据把响应字节写进主 agent 过户的
      // workdir 目录(saveDeposit 票据库单例,与过户端同一本账)。
      writeSaveDeposit: (ghostId, token, fileName, bytes) =>
        getSaveDepositVault().write(ghostId, token, fileName, bytes),
      // OAuth 凭证(source:'oauth'):出网现取新鲜 access token 注入,401
      // 作废重刷整链重试一次;账号/令牌真身在管理器单例。
      oauthTokens: {
        getFreshAccessToken: (ghostId, secretKey, decl, accountId) =>
          getGhostOauthAccountManager().getFreshAccessToken(ghostId, secretKey, decl, accountId),
        invalidateAccessToken: (ghostId, secretKey, accountId) =>
          getGhostOauthAccountManager().invalidateAccessToken(ghostId, secretKey, accountId),
      },
      // Cindy Connection JWT:audience 只由 Host 根据组织和插件 id 推导，令牌只留在
      // Main 内存并由 networkSlot 直接注入，插件与 Node Worker 都拿不到。
      connectionTokens: {
        resolve: resolveConnectionAudienceForGhost,
        getToken: (input) => getConnectionTokenProvider().getToken(input),
        invalidate: (input) => getConnectionTokenProvider().invalidate(input),
      },
      // 多连接凭证(network.connections):按在装清单逐 decl 查连接管理器——
      // 用户添加的地址并入动态白名单(hostsFor),出网时按 hostname 精确
      // 匹配注入那条连接自己的 token(tokenFor;同一 hostname 命中多个 decl
      // 时取第一个)。每单现查现读,设置页增删下一单即生效。
      connections: {
        hostsFor: (ghostId) => {
          const decls = findAvailableGhost(ghostId)?.manifest.network?.connections ?? [];
          const mgr = getGhostConnectionManager();
          const hosts: string[] = [];
          for (const decl of decls) {
            for (const host of mgr.hostsOf(ghostId, decl.key)) {
              if (!hosts.includes(host)) hosts.push(host);
            }
          }
          return hosts;
        },
        tokenFor: (ghostId, hostname) => {
          const decls = findAvailableGhost(ghostId)?.manifest.network?.connections ?? [];
          const mgr = getGhostConnectionManager();
          for (const decl of decls) {
            const token = mgr.resolveTokenByHost(ghostId, decl.key, hostname);
            if (token !== null) {
              return { value: token, header: decl.inject.header, format: decl.inject.format };
            }
          }
          return null;
        },
      },
      log,
    });
  }
  return networkSlotSingleton;
}

let fsSlotSingleton: GhostFsSlot | null = null;

/**
 * fs 槽单例(写文件,2026-07-14):deps 全部懒取现查——意识清单实扫、
 * session 快照现查 localDb(用户会话中途切 permission 模式,下一单即生效)、
 * 确认卡桥现取(未初始化时按"确认通道未就绪"拒,不抛)。
 */
export function getGhostFsSlot(): GhostFsSlot {
  if (!fsSlotSingleton) {
    fsSlotSingleton = new GhostFsSlot({
      getGhost: findAvailableGhost,
      dataRootDir: () => ownerScopedUserDataPath('ghost-fs'),
      // callId → 归属/会话反查:与卡片供片同一本账(ghost_call 派单时
      // cardService.registerCall 登记),不信意识自报。
      callInfo: (callId) => getGhostCardService().callInfoOf(callId),
      // 严格在途反查:脚本通道(无会话)的 workdir 写盘授权走它——交卷即失效,
      // 不享宽限窗(目录授权上下文用完即废,与 workspace 槽同一判据)。
      inFlightCallInfo: (callId) => getGhostCardService().inFlightCallInfoOf(callId),
      getSessionSnapshot: (sessionId) => getSessionFsSnapshot(sessionId),
      requestWriteConfirm: async (sessionId, payload) => {
        const bridge = getGhostGrantConfirmBridge();
        if (!bridge) return { confirmed: false, reason: 'session_closed' };
        return bridge.request(sessionId, payload);
      },
      writeSaveDeposit: (ghostId, token, fileName, bytes) =>
        getSaveDepositVault().write(ghostId, token, fileName, bytes),
      log,
    });
  }
  return fsSlotSingleton;
}

let librarySlotSingleton: GhostLibrarySlot | null = null;

/**
 * library 能力单例(持久作品库,2026-08-20):与 fs 能力同款懒取现查——根目录经
 * binding store 解析(默认 = ownerScopedUserDataPath('libraries', id);自定义
 * 位置带漂移判定),owner scope 每请求比对(切换后旧会话作废重解)。SQL 执行
 * 在 per-plugin worker(语句门见 libraryDbCore);本进程只组包与映射结果。
 */
export function getGhostLibrarySlot(): GhostLibrarySlot {
  if (!librarySlotSingleton) {
    const bindingStore = new LibraryBindingStore({
      getFile: () => ownerScopedUserDataPath('libraries-binding.json'),
      // 受管根 = 整个 userData(owners 树/cindy-brain/ghost-* 都在其内),
      // 自定义库根不得落在宿主数据区里。
      getManagedRoots: () => [app.getPath('userData')],
      getDefaultRoot: (ghostId) => ownerScopedUserDataPath('libraries', ghostId),
      log,
    });
    librarySlotSingleton = new GhostLibrarySlot({
      getGhost: findAvailableGhost,
      bindingStore,
      getDefaultRoot: (ghostId) => ownerScopedUserDataPath('libraries', ghostId),
      captureOwnerScope: () => activeOwnerScopeKey(),
      createVault: (deps) => new LibraryVault(deps),
      createSqlService: (deps) => new LibrarySqlService(deps),
      getDiskFreeBytes: (root) => statfsFreeBytes(root),
      workerScriptPath: defaultLibraryDbWorkerPath,
      betterSqliteModulePath: () => resolveBetterSqliteModuleEntry() ?? 'better-sqlite3',
      log,
      syncAgentReadonlyExtraDir: syncMivoLibraryExtraDirFromSlot,
      showItemInFolder: (absPath) => {
        shell.showItemInFolder(absPath);
      },
      showSaveDialog: async (opts) => {
        // 另存为由插件自主发起,必须挂可见主壳窗。不能 `getAllWindows()[0]`:
        // 语音 overlay 是 hidden + focusable:false 的 prewarm 窗,经常排在 [0]
        // (bootstrap-electron.ts / authManager.ts 已踩过);macOS sheet 挂上去
        // 用户看不见,saveAsDialogInFlight 却一直占着。无主壳窗 = 失败关闭。
        const candidates = mainShellWindows().filter(
          (window) => window.isVisible() && !window.isMinimized(),
        );
        const focused = BrowserWindow.getFocusedWindow();
        const win =
          focused && !focused.isDestroyed() && candidates.includes(focused)
            ? focused
            : candidates[0];
        if (!win) throw new Error('没有可挂靠的宿主窗口');
        // main 侧 t() 只插值 {{appName}},插件名在调用点替换(与 pick 槽同做法)。
        // Electron SaveDialogOptions.message 仅 macOS;Windows 只看 title,
        // 已核验插件名必须进跨平台标题,否则用户看不到是谁在另存为。
        const title = t('settings.ghosts.saveAs.dialogTitle').replaceAll(
          '{{name}}',
          opts.ghostName,
        );
        const message = t('settings.ghosts.saveAs.dialogMessage').replaceAll(
          '{{name}}',
          opts.ghostName,
        );
        const picked = await dialog.showSaveDialog(win, {
          title,
          message,
          defaultPath: opts.defaultPath,
        });
        return { canceled: picked.canceled, filePath: picked.filePath };
      },
    });
    // 面板只读投影(cindy-ghost://<id>/library/<relPath>)的解析器:与电子脑
    // read 同源校验(binding 根 + vault 路径纪律),失败折叠 404。
    setGhostLibraryFileResolver((ghostId, relPath) =>
      librarySlotSingleton ? librarySlotSingleton.resolvePanelFilePath(ghostId, relPath) : Promise.resolve(null),
    );
  }
  return librarySlotSingleton;
}

/**
 * 迁移执行体(relocate / revert-default 共用):置迁移只读闸 → dispose 会话 →
 * 无数据直改 binding / 有数据走完整状态机 → 再 dispose 让下一请求用新根。
 * 全程持 owner mutation 租约(账号切换在途即抛,不跨 owner 写 binding)。
 */
async function relocateGhostLibraryTo(
  id: string,
  candidate: string,
  opts?: { allowInsideManagedRoot?: boolean },
): Promise<{ ok: boolean; message?: string }> {
  const releaseMutation = beginGhostMutation();
  const slot = getGhostLibrarySlot();
  slot.setRelocating(id, true);
  try {
    await slot.disposeGhost(id);
    const resolution = await getGhostLibraryBindingStore().resolveLibraryRoot(id);
    const fromRoot = resolution.kind === 'custom' && resolution.root !== null
      ? resolution.root
      : ownerScopedUserDataPath('libraries', id);
    let fromExists = true;
    try {
      await fs.promises.stat(fromRoot);
    } catch {
      fromExists = false;
    }
    if (!fromExists) {
      // 无数据迁移:直接改 binding(等价 bind)。
      const set = await getGhostLibraryBindingStore().setBinding(id, candidate, (root) => statfsFreeBytes(root), {
        allowInsideManagedRoot: opts?.allowInsideManagedRoot,
      });
      await slot.disposeGhost(id);
      await refreshMivoLibraryExtraDirGrant();
      return set.ok ? { ok: true } : { ok: false, message: set.message };
    }
    const result = await migrateGhostLibrary({
      ghostId: id,
      fromRoot,
      candidate,
      deps: {
        getFile: () => ownerScopedUserDataPath('libraries-binding.json'),
        getManagedRoots: () => [app.getPath('userData')],
        getDefaultRoot: (gid) => ownerScopedUserDataPath('libraries', gid),
        getDiskFreeBytes: (root) => statfsFreeBytes(root),
        // sqlite 走在线 backup/quick_check(主进程受控打开,只读)。
        copySqlite: async (from, to) => {
          const db = createBetterSqliteDatabase(from, { readonly: true });
          try {
            await db.backup(to);
          } finally {
            db.close();
          }
        },
        checkSqliteHealthy: async (abs) => {
          const db = createBetterSqliteDatabase(abs, { readonly: true });
          try {
            const row = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
            return row?.quick_check === 'ok';
          } finally {
            db.close();
          }
        },
        log,
      },
      applyBinding: async (c) => {
        const set = await getGhostLibraryBindingStore().setBinding(id, c, undefined, {
          allowInsideManagedRoot: opts?.allowInsideManagedRoot,
        });
        return set.ok ? { ok: true } : { ok: false, message: set.message };
      },
      allowInsideManagedRoot: opts?.allowInsideManagedRoot,
    });
    await slot.disposeGhost(id);
    await refreshMivoLibraryExtraDirGrant();
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  } finally {
    slot.setRelocating(id, false);
    releaseMutation();
  }
}

/**
 * Library 概览(设置页插件详情的数据源):轻量直读 meta/usage(不建会话、
 * 不触发 open 的目录创建),漂移/未声明都给结构化结果,渲染层据此出横幅。
 */
export async function getGhostLibraryOverview(ghostId: string): Promise<GhostLibraryOverview> {
  const ghost = findAvailableGhost(ghostId);
  const supported = ghost?.manifest.library === true;
  const store = getGhostLibraryBindingStore();
  const binding = await store.getBinding(ghostId);
  const resolution = await store.resolveLibraryRoot(ghostId);
  const root = resolution.kind === 'custom' && resolution.root !== null
    ? resolution.root
    : ownerScopedUserDataPath('libraries', ghostId);
  let usedBytes = 0;
  let fileCount = 0;
  let orphaned = false;
  let state: GhostLibraryOverview['state'] = 'ready';
  let reason: string | null = null;
  if (resolution.kind === 'custom' && resolution.root === null) {
    state = 'unavailable';
    reason = resolution.drift;
  } else {
    try {
      const meta = JSON.parse(await fs.promises.readFile(path.join(root, '.cindy-library', 'meta.json'), 'utf8')) as {
        orphaned?: unknown;
      };
      orphaned = meta.orphaned !== undefined;
      try {
        const usage = JSON.parse(await fs.promises.readFile(path.join(root, '.cindy-library', 'usage.json'), 'utf8')) as {
          files?: number;
          bytes?: number;
        };
        usedBytes = Number(usage.bytes ?? 0);
        fileCount = Number(usage.files ?? 0);
      } catch {
        /* 账本缺失按 0 计;设置页可触发重扫 */
      }
    } catch {
      /* 尚未创建过 Library = 全零;不是错误 */
    }
  }
  let diskFreeBytes: number | null = null;
  try {
    diskFreeBytes = await statfsFreeBytes(root);
  } catch {
    diskFreeBytes = null;
  }
  return {
    supported,
    state,
    reason,
    location: binding !== null ? 'custom' : 'default',
    customCandidate: binding?.root ?? null,
    usedBytes,
    fileCount,
    diskFreeBytes,
    softLimitBytes: DEFAULT_LIBRARY_LIMITS.softLimitBytes,
    softLimitExceeded: usedBytes > DEFAULT_LIBRARY_LIMITS.softLimitBytes,
    orphaned,
  };
}

/**
 * 删除 Library(设置页独立确认后的执行体;与卸载是两个操作):作废运行会话,
 * 库根 rename 进 owner 级回收站(30 天回滚窗),撤销 binding。调用方(设置页
 * IPC,后续 commit 接线)必须先取得用户对「删除作品数据」的独立破坏性确认。
 */
export async function deleteGhostLibraryForActiveOwner(ghostId: string): Promise<{ ok: boolean; message?: string }> {
  if (!isValidGhostId(ghostId)) return { ok: false, message: '非法插件 id' };
  await getGhostLibrarySlot().disposeGhost(ghostId);
  const result = await trashGhostLibrary(ghostId, {
    // 默认根与自定义根都经 binding store 的解析口径(漂移时返回 null → 上层
    // 引导恢复位置,不误删)。
    resolveLibraryRoot: async (id) => {
      const resolution = await getGhostLibraryBindingStore().resolveLibraryRoot(id);
      return resolution.kind === 'custom' ? resolution.root : ownerScopedUserDataPath('libraries', id);
    },
    trashRoot: () => ownerScopedUserDataPath('libraries-trash'),
    removeBinding: async (id) => {
      await getGhostLibraryBindingStore().removeBinding(id);
    },
    log,
  });
  if (result.ok) {
    await refreshMivoLibraryExtraDirGrant().catch((error) => {
      log.warn('library extraDirs delete sync failed', {
        ghostId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return { ok: true };
  }
  return { ok: false, message: result.message };
}

let libraryBindingStoreSingleton: LibraryBindingStore | null = null;

/** library 能力的 binding store(单例:读-改-写互斥要落在同一实例链上)。 */
export function getGhostLibraryBindingStore(): LibraryBindingStore {
  if (!libraryBindingStoreSingleton) {
    libraryBindingStoreSingleton = new LibraryBindingStore({
      getFile: () => ownerScopedUserDataPath('libraries-binding.json'),
      getManagedRoots: () => [app.getPath('userData')],
      getDefaultRoot: (ghostId) => ownerScopedUserDataPath('libraries', ghostId),
      log,
    });
  }
  return libraryBindingStoreSingleton;
}

/**
 * 官方保留前缀守门(docs/dev-rules/plugin-security-and-authoring.md):packaged 版本上,用户装入
 * 通道(install/update/inspect 三个 IPC,即拖入/选文件/forge 转交的共同出口)
 * 对 `cindy-` / `filo-` / `xd-` 前缀 id 一律拒装——抢注同 id 的第三方包会冒充官方身份并
 * 蹭走凭证别名(用户历史填过的机器级 key 被注入攻击者白名单域名)。
 * dev 构建默认豁免:方便 `cindy-` / `filo-` / `xd-` 官方前缀插件在本地迭代;需要复现
 * packaged 行为时可设置 `XDT_GHOST_RESERVED_PREFIX_GATE=1`,此开关只能收紧、不能放宽。
 * 若恢复随包 seed,builtinGhostProvisioner 的内部安装路径不经这些 IPC;不要把本闸套到播种路径。
 */
function rejectReservedPublisherSlug(id: string): void {
  if (!isReservedConnectionPluginSlug(id)) return;
  throwIpcError(
    'GHOST_ID_RESERVED',
    `id "${id}" 是主机保留的发布者身份,不可装入`,
  );
}

function rejectReservedGhostId(id: string): void {
  // Member-publisher identity slugs are never installable, including market
  // packages and unpackaged dev builds. Official prefix rejection stays
  // packaged-only by default so first-party iteration can still reload cindy-/filo-/xd- plugins.
  // The hidden dev override can reproduce the packaged gate but can never disable it.
  rejectReservedPublisherSlug(id);
  if (!shouldRejectReservedGhostIds(app.isPackaged)) return;
  if (!isUserInstallReservedGhostId(id)) return;
  throwIpcError(
    'GHOST_ID_RESERVED',
    `id "${id}" 使用了官方保留前缀(cindy- / filo- / xd-),用户通道不可装入`,
  );
}

/**
 * 自定义市场（Git / 本地源）装入前的保留前缀闸。与服务端市场不同，自定义源
 * 的包字节未经 plugin-server 绑定，不享受官方前缀豁免，语义同本地 .cindy 装入。
 */
export function rejectReservedGhostIdForCustomMarket(id: string): void {
  rejectReservedGhostId(id);
}

/**
 * tokenBroker 第一方门控·装入闸。官方前缀命中照今天放行；否则问 first-party
 * 判据。不区分 dev/packaged:broker 是服务端资产,dev 也不豁免。
 */
function rejectUnauthorizedTokenBroker(
  manifest: GhostManifest,
  overrides?: GhostFirstPartyFactsOverrides,
): void {
  if (isBrokerEligibleGhostId(manifest.id)) return;
  const brokered = (manifest.network?.secrets ?? []).some(
    (s) => s.oauth?.tokenBroker !== undefined,
  );
  if (!brokered) return;
  if (isGhostTokenBrokerAuthorized(manifest.id, 'install', overrides)) return;
  const authorizationError = ghostTokenBrokerInstallError();
  throwIpcError(
    authorizationError.code,
    `id "${manifest.id}" 声明了 oauth.tokenBroker——${authorizationError.reason}`,
  );
}

/** 新包装入准入；批准 receipt / 已装目录回读不经过这里。 */
function rejectBrokerWithoutDeclaredRedirectPort(manifest: GhostManifest): void {
  const error = ghostBrokerRedirectPortInstallError(manifest);
  if (error) throwIpcError(error.code, error.reason);
}

/** install 失败分类 → IPC 错误码。 */
function throwInstallError(rejection: InstallRejection): never {
  switch (rejection.code) {
    case 'source-not-found':
      throwIpcError('NOT_FOUND', rejection.reason);
    case 'file-invalid':
      throwIpcError('GHOST_FILE_INVALID', rejection.reason);
    case 'host-unsupported':
      throwIpcError('GHOST_HOST_UNSUPPORTED', rejection.reason);
    case 'already-installed':
      throwIpcError('ALREADY_EXISTS', rejection.reason);
    case 'not-installed':
      throwIpcError('NOT_FOUND', rejection.reason);
    case 'command-conflict':
      throwIpcError('GHOST_COMMAND_CONFLICT', rejection.reason);
    case 'state-changed':
      throwIpcError('PRECONDITION_FAILED', rejection.reason);
    default:
      throwIpcError('INTERNAL', rejection.reason);
  }
}

/** uninstall 失败分类 → IPC 错误码。 */
function throwUninstallError(rejection: UninstallRejection): never {
  switch (rejection.code) {
    case 'invalid-id':
      throwIpcError('INVALID_PARAMS', rejection.reason);
    case 'not-installed':
      throwIpcError('NOT_FOUND', rejection.reason);
    case 'approval-required':
      throwIpcError('PRECONDITION_FAILED', rejection.reason);
    default:
      throwIpcError('INTERNAL', rejection.reason);
  }
}

/**
 * 装入 + 停靠(共享主体):ghosts:install(显式路径)、
 * ghosts:install-via-dialog(系统文件选择框)与双击 .cindy
 * (openFileInstall.ts)都走这里,三个入口行为完全一致。
 */
export async function installAndDock(
  manager: GhostManager,
  lizFilePath: string,
  /**
   * `ghostId` 必填:它同时是**按 id 互斥锁的键**。装入前已由调用方经 inspect
   * 验明(市场路径核对 expected、本地路径核对 sha256 钉住的 probe),所以此处
   * 可信。做成必填而不是可选,是为了让新增装入路径无法"忘记取锁"——签名逼着
   * 它交出 id,锁在这里自动获取(外层已持有时按可重入 no-op)。
   */
  opts: {
    ghostId: string;
    enable?: boolean;
    expectedPackageSha256?: string;
    trustOverride?: GhostHostTrustOverride;
  },
): Promise<InstalledGhost> {
  return withGhostInstallLock(opts.ghostId, () => installAndDockLocked(manager, lizFilePath, opts));
}

async function installAndDockLocked(
  manager: GhostManager,
  lizFilePath: string,
  opts: {
    ghostId: string;
    enable?: boolean;
    expectedPackageSha256?: string;
    trustOverride?: GhostHostTrustOverride;
    installOrigin?: 'agent-forge';
  },
): Promise<InstalledGhost> {
  // 初始启用态由入口显式传入；当前用户导入与市场首装都传 true，覆盖更新
  // 则走 manager.update 延续既有状态。保留 false 缺省以兼容内部受控调用方。
  const result = await manager.install(lizFilePath, {
    initiallyEnabled: opts.enable ?? false,
    ...(opts.expectedPackageSha256
      ? { expectedPackageSha256: opts.expectedPackageSha256 }
      : {}),
    ...(opts.trustOverride ? { trustOverride: opts.trustOverride } : {}),
    ...(opts.installOrigin ? { installOrigin: opts.installOrigin } : {}),
  });
  if ('rejection' in result) throwInstallError(result.rejection);
  // 纵深防御:调用方给错 id 意味着刚才那把锁上在了错误的键上(等于没上锁)。
  // 宁可装完即报错让上层看见,也不要留下"以为串行、其实没有"的假象。
  if (result.ghost.manifest.id !== opts.ghostId) {
    throw new Error(
      `装入包的 ghostId(${result.ghost.manifest.id})与加锁使用的 id(${opts.ghostId})不一致`,
    );
  }
  // 内置墓碑清除已并入 GhostManager 的 durable install journal(marker.clearBuiltinTombstone
  // + 提交时清除 + 崩溃恢复补清),此处不再直接调用:瞬时状态写失败会保留 marker 交由
  // 启动恢复,而不是把已提交的安装误报成错误。
  // 声明了面板的意识装入后立即停进布局树(树上已有 = 重装,原位复活不动树)。
  // 顺序刻意:manager.install 内已广播 ghosts:changed(renderer 先注册面板),
  // 这里再 setLayout 触发 layout:changed(pane 出现时面板组件必然已就位,规则 7)。
  const store = getLayoutStore();
  const docked = layoutWithGhostPanel(store.getLayout(), result.ghost.manifest);
  if (docked) {
    const applied = store.setLayout(docked);
    if ('rejection' in applied) {
      // 停靠失败不阻断装入(意识本体已就绪);记日志供排查。
      log.warn('ghost panel dock rejected', {
        id: result.ghost.manifest.id,
        reason: applied.rejection,
      });
    }
  }
  // 常驻意识(launch: resident)且装入即开启:立刻拉起电子脑。
  spawnIfResident(result.ghost);
  return result.ghost;
}

type InspectedGhostPackage = Exclude<
  Awaited<ReturnType<GhostManager['inspect']>>,
  { rejection: InstallRejection }
>;

/**
 * 本地包原位更新的共享事务。调用方必须已经持有 owner lease 和对应 ghostId
 * 的安装锁；Renderer 导入与 Forge 显式安装共用，避免两条路径在运行时、OAuth、
 * 市场来源解绑和失败恢复上产生漂移。
 */
async function updateLocalGhostPackageLocked(
  manager: GhostManager,
  cindyFilePath: string,
  inspected: InspectedGhostPackage,
  expectedPackageSha256: string,
  expectedInstalledApproval: string,
  installOrigin?: 'agent-forge',
): Promise<InstalledGhost> {
  const runtime = getGhostRuntime();
  const marketLedger = getPluginMarketLedger().bind(
    ownerScopedUserDataPath('plugin-market', 'ledger.v1.json'),
  );
  const previousGhost = manager.list().find((g) => g.manifest.id === inspected.manifest.id);
  runtime.stop(inspected.manifest.id);
  // 等待失败表示旧进程仍可能存活；此时不能恢复 resident，否则会产生
  // 两份后台进程。仅在确认退出后的更新阶段失败时恢复旧版本。
  await getGhostNodeRuntimeBroker().stopAndWait(inspected.manifest.id);
  let marketRecord: PluginMarketInstallationRecord | null;
  try {
    marketRecord = marketLedger.installationForGhost(inspected.manifest.id);
  } catch (error) {
    if (previousGhost) spawnIfResident(previousGhost);
    log.warn('failed to verify Plugin provenance before local update', {
      ghostId: inspected.manifest.id,
      error: error instanceof Error ? error.message : String(error),
    });
    throwIpcError('INTERNAL', 'Unable to verify the installed Plugin source');
  }
  // 用户已明确选择了这份本地真实包：同 id 可以原位替换，市场来源不是永久所有权。
  // 替换前先切断旧市场更新路由；落位失败再恢复，不清理按 ghostId 保存的用户状态。
  const detachMarketRecord = Boolean(marketRecord?.installed);
  const restoreMarketRecord = (): void => {
    if (!detachMarketRecord || !marketRecord) return;
    try {
      // 来源解绑不触碰 opt-out，失败恢复同样只恢复旧路由；用户过去的显式
      // 卸载决定因此既不会被新增，也不会被清除。
      marketLedger.restoreInstallation(marketRecord);
    } catch (error) {
      // 恢复失败时保持路由失效是安全降级：不能让旧市场自动覆盖用户明确选择的本地包。
      log.error('failed to restore Plugin market provenance after local update failure', {
        ghostId: inspected.manifest.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  if (detachMarketRecord) {
    try {
      // 先持久化切断自动更新路由，再改真实包。普通本地/Forge 换源不是
      // 用户显式卸载，不得产生 default-install opt-out。
      marketLedger.markRemoved(inspected.manifest.id, null);
    } catch (error) {
      restoreMarketRecord();
      if (previousGhost) spawnIfResident(previousGhost);
      log.warn('failed to detach Plugin market provenance before local update', {
        ghostId: inspected.manifest.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throwIpcError('INTERNAL', 'Unable to detach the installed Plugin source');
    }
  }
  getGhostAgentSlot().clearGhost(inspected.manifest.id);
  getGhostErrandSlot().clearGhost(inspected.manifest.id);
  let result: Awaited<ReturnType<typeof manager.update>>;
  let packagePlaced = false;
  try {
    result = await withActiveOwnerGhostOauthMutationLock(inspected.manifest.id, () =>
      manager.update(cindyFilePath, {
        expectedPackageSha256,
        expectedInstalledApproval,
        ...(installOrigin ? { installOrigin } : {}),
        ...(previousGhost
          ? {
              beforePackageCommit: () =>
                getGhostOauthAccountManager().prepareAccountsForChangedClients(
                  withRuntimeFiloGoogleClient(previousGhost.manifest),
                  withRuntimeFiloGoogleClient(inspected.canonicalManifest),
                ),
            }
          : {}),
        onPackagePlaced: () => {
          packagePlaced = true;
        },
      }),
    );
  } catch (err) {
    if (!packagePlaced) {
      restoreMarketRecord();
      if (previousGhost) spawnIfResident(previousGhost);
      throw err;
    }
    const placed = manager.list().find((ghost) => ghost.manifest.id === inspected.manifest.id);
    if (!placed) throw err;
    log.warn('local ghost post-placement notification failed', {
      ghostId: inspected.manifest.id,
      error: err instanceof Error ? err.message : String(err),
    });
    result = { ghost: placed };
  }
  if ('rejection' in result) {
    // 回滚失败时安装目录可能已是新字节或缺失，不能恢复旧 runtime 或旧市场来源路由。
    if (!(result.rejection.code === 'io' && result.rejection.rollbackFailed)) {
      restoreMarketRecord();
      if (previousGhost) spawnIfResident(previousGhost);
    }
    throwInstallError(result.rejection);
  }
  runtime.resetFuse(inspected.manifest.id);
  const store = getLayoutStore();
  const docked = layoutWithGhostPanel(store.getLayout(), result.ghost.manifest);
  if (docked) {
    const applied = store.setLayout(docked);
    if ('rejection' in applied) {
      log.warn('ghost panel dock rejected', {
        id: result.ghost.manifest.id,
        reason: applied.rejection,
      });
    }
  }
  spawnIfResident(result.ghost);
  return result.ghost;
}

/**
 * Forge 的显式安装入口。调用方在打包前已经取得 owner lease，并把它持有到本函数
 * 返回；这里复核精确包哈希，再与 Renderer 本地导入共用相同安装/更新事务。
 */
export async function installOrUpdateLocalGhostPackageFromForge(
  cindyFilePath: string,
  expected: { ghostId: string; packageSha256: string },
): Promise<{ ghost: InstalledGhost; action: 'installed' | 'updated' }> {
  const manager = getGhostManager();
  const inspected = await manager.inspect(cindyFilePath);
  if ('rejection' in inspected) throwInstallError(inspected.rejection);
  if (
    inspected.manifest.id !== expected.ghostId ||
    inspected.packageSha256 !== expected.packageSha256
  ) {
    throwIpcError('GHOST_FILE_INVALID', '插件文件在打包后发生了变化，请重新安装');
  }
  rejectReservedGhostId(inspected.manifest.id);
  rejectBrokerWithoutDeclaredRedirectPort(inspected.manifest);

  const authState = getAuthState();
  const user = authState.isAuthenticated ? authState.user : null;
  const membershipKind = user?.membershipKind ?? 'personal';
  const installOrigin = forgeInstallOriginForMembership(membershipKind);
  rejectUnauthorizedTokenBroker(
    inspected.manifest,
    installOrigin ? { installOrigin } : undefined,
  );
  const confirmFacts = forgeOidcInstallConfirmFacts(inspected.manifest, membershipKind);
  if (confirmFacts) {
    let confirmed = false;
    try {
      confirmed = await ensureForgeOidcInstallConfirmBridge().request(confirmFacts);
    } catch {
      throwIpcError('PRECONDITION_FAILED', '当前无法显示企业身份使用确认，请稍后重试');
    }
    if (!confirmed) {
      throwIpcError('MUTATION_CANCELLED', '用户取消了企业身份插件安装');
    }
  }

  return withGhostInstallLock(inspected.manifest.id, async () => {
    const installed = manager.list().find((ghost) => ghost.manifest.id === inspected.manifest.id);
    if (!installed) {
      return {
        ghost: await installAndDockLocked(manager, cindyFilePath, {
          ghostId: inspected.manifest.id,
          enable: true,
          expectedPackageSha256: expected.packageSha256,
          ...(installOrigin ? { installOrigin } : {}),
        }),
        action: 'installed',
      };
    }
    return {
      ghost: await updateLocalGhostPackageLocked(
        manager,
        cindyFilePath,
        inspected,
        expected.packageSha256,
        ghostInstallApprovalToken(installed.approval),
        installOrigin,
      ),
      action: 'updated',
    };
  });
}

/**
 * Plugin 市场专用装入入口。市场包已由 plugin-server 绑定到稳定 Plugin ID，
 * 因而允许官方保留前缀；本地文件入口仍继续走 rejectReservedGhostId。
 * tokenBroker 门控、原子换目录、布局停靠与运行时重启保持和本地安装一致。
 */
export interface MarketGhostPackageCommitEvidence {
  /** SHA-256 of the exact ghost.json entry bytes bound to the accepted package. */
  rawManifestSha256: string;
  /** Digest format read by released clients; derived from the same package entry. */
  legacyManifestDigest: string;
  /** Locale-independent Manifest parsed from those same package entry bytes. */
  canonicalManifest: GhostManifest;
}

export async function installOrUpdateMarketGhostPackage(
  cindyFilePath: string,
  expected: {
    ghostId: string;
    version: string;
    /** receipt 模型并发护栏:更新分支比对 receipt 派生 token(与 main 硬化叠加,决策 A)。 */
    expectedInstalledApproval?: string;
    /**
     * Organization server-market packages pass this Host-built fact because the
     * ledger row is written after install/update. Official-prefix ids never
     * consult it (they short-circuit). Not "first install only": the same
     * commitDownloadedPackage path covers org server-market install, update,
     * defaultInstall, and source replacement.
     */
    pendingMarketRecord?: GhostFirstPartyPendingMarketRecord;
    /** 自定义 Git/本地市场在打包前读取的 Manifest，用于防止打包窗口内能力扩张。 */
    manifestCap?: GhostManifest;
    beforeCommitInLock?: () => void;
    /** 新包已经原子换位；后续异常不能再按落位失败回滚来源路由。 */
    onPackagePlacedInLock?: () => void;
    /** 包与 receipt 已提交，仍持 owner mutation lease；用于原子写入来源账本。 */
    afterCommitInLock?: (
      installed: InstalledGhost,
      evidence: MarketGhostPackageCommitEvidence,
    ) => void | Promise<void>;
    /** 仅 server-market 主机路径可传；custom/local 不传。 */
    officialCindyGithub?: boolean;
  },
): Promise<InstalledGhost> {
  // 卡点:按 ghostId 上锁,覆盖 inspect → 落位整段。服务端与自定义两条市场路径
  // 都经此出口,调用方漏取锁也被兜住;调用方已持有时按可重入 no-op(它们会把
  // 复核与账本写入一起纳入同一把锁,范围比这里更大)。
  return withGhostInstallLock(expected.ghostId, () =>
    installOrUpdateMarketGhostPackageLocked(cindyFilePath, expected),
  );
}

async function installOrUpdateMarketGhostPackageLocked(
  cindyFilePath: string,
  expected: {
    ghostId: string;
    version: string;
    expectedInstalledApproval?: string;
    /** Same Host-built org server-market fact as the exported entry; not first-install only. */
    pendingMarketRecord?: GhostFirstPartyPendingMarketRecord;
    manifestCap?: GhostManifest;
    beforeCommitInLock?: () => void;
    /** 新包已经原子换位；后续异常不能再按落位失败回滚来源路由。 */
    onPackagePlacedInLock?: () => void;
    /** 包与 receipt 已提交，仍持 owner mutation lease；用于原子写入来源账本。 */
    afterCommitInLock?: (
      installed: InstalledGhost,
      evidence: MarketGhostPackageCommitEvidence,
    ) => void | Promise<void>;
    officialCindyGithub?: boolean;
  },
): Promise<InstalledGhost> {
  const mutationOwner = captureGhostMutationOwner();
  let releaseMutation: (() => void) | null = null;
  try {
    const manager = getGhostManager();
    const inspected = await manager.inspect(cindyFilePath);
    if ('rejection' in inspected) throwInstallError(inspected.rejection);
    const commitEvidence: MarketGhostPackageCommitEvidence = {
      rawManifestSha256: inspected.rawManifestSha256,
      legacyManifestDigest: ghostManifestDigest(inspected.releasedLegacyDigestFormat),
      canonicalManifest: inspected.canonicalManifest,
    };
    // Publisher identity slugs stay reserved even on the market path.
    // Official reserved prefixes from shared/ghost.ts remain exempt here; publisher slugs do not.
    rejectReservedPublisherSlug(inspected.canonicalManifest.id);
    if (
      inspected.canonicalManifest.id !== expected.ghostId ||
      inspected.canonicalManifest.version !== expected.version
    ) {
      throwIpcError('GHOST_FILE_INVALID', '下载包清单与市场 Release 不一致');
    }
    const trustOverride: GhostHostTrustOverride | undefined =
      expected.officialCindyGithub === true && expected.ghostId === 'cindy-github'
        ? 'cindy-official'
        : undefined;
    requireGhostAvailableForActiveSession(expected.ghostId);
    // 自定义 Git/本地市场的活目录可能在发现后、打包前变化；它们传入发现时的
    // Manifest 作为 TOCTOU 上限。官方市场由服务端 Release SHA 绑定真实包，目录
    // Manifest 只用于展示，不参与这里的安装准入。
    const installed = manager.list().find((ghost) => ghost.manifest.id === expected.ghostId);
    if (expected.manifestCap) {
      const undeclaredCapabilities = unreviewedGhostPermissionItems(
        expected.manifestCap,
        undefined,
        inspected.canonicalManifest,
      );
      if (
        undeclaredCapabilities.length > 0 ||
        !ghostNetworkAuthorizationWithinCap(expected.manifestCap, inspected.canonicalManifest) ||
        !ghostNodeSecretAuthorizationWithinCap(
          expected.manifestCap,
          inspected.canonicalManifest,
        ) ||
        !ghostSetupAuthorizationWithinCap(expected.manifestCap, inspected.canonicalManifest) ||
        !ghostSettingsUiWithinCap(expected.manifestCap, inspected.canonicalManifest) ||
        !ghostSubscribeAuthorizationWithinCap(expected.manifestCap, inspected.canonicalManifest) ||
        !ghostToolParametersWithinCap(expected.manifestCap, inspected.canonicalManifest) ||
        !ghostUnknownV3FieldsWithinCap(expected.manifestCap, inspected.canonicalManifest)
      ) {
        log.warn('custom market package exceeds discovered manifest capabilities', {
          ghostId: expected.ghostId,
          keys: undeclaredCapabilities.map((item) => item.key),
        });
        throwIpcError(
          'GHOST_FILE_INVALID',
          'Downloaded Plugin package capabilities exceed the market manifest',
        );
      }
    }
    rejectUnauthorizedTokenBroker(
      inspected.canonicalManifest,
      expected.pendingMarketRecord !== undefined
        ? {
            marketRecord: bindPendingMarketRecordToInspectedPackage(
              expected.pendingMarketRecord,
              inspected.packageSha256,
            ),
          }
        : undefined,
    );

    // Manifest 能力只用于 Host 注册、校验和运行时守门。用户点击安装后不再
    // 经过插件级权限确认；自定义活目录还必须通过上面的打包窗口一致性校验。
    // Hold the owner-stability lease only for the actual Ghost filesystem
    // mutation.
    releaseMutation = beginGhostMutation(mutationOwner);
    if (!installed) {
      // 市场首装一律装完即开(defaultInstall 与手动安装归一)，用户不必再手动
      // 点一次开关。市场包走服务端校验 + sha256 下载校验；自定义 Git/本地市场
      // 额外受发现 Manifest 上限约束。本地 .cindy 由明确的文件选择、拖入或双击
      // 动作直接装入。
      // expectedPackageSha256 把"检查过的字节"与"落位的字节"钉死为同一份:
      // inspect 与 install 各自重读磁盘,临时 .cindy 在两读之间被替换时,
      // 所有前置校验(保留前缀/能力上限/签名/解压上限)都会作用在旧字节上。
      // 本地 .cindy 装入通道已强制此对账,市场通道同一口径。
      expected.beforeCommitInLock?.();
      const installedGhost = await installAndDock(manager, cindyFilePath, {
        ghostId: expected.ghostId,
        enable: true,
        expectedPackageSha256: inspected.packageSha256,
        ...(trustOverride ? { trustOverride } : {}),
      });
      await expected.afterCommitInLock?.(installedGhost, commitEvidence);
      return installedGhost;
    }

    expected.beforeCommitInLock?.();
    const runtime = getGhostRuntime();
    runtime.stop(expected.ghostId);
    // 无法确认旧进程已退出时保持停止态，不能启动第二份 resident。只有旧进程
    // 已确认退出、后续目录更新失败时，才恢复原版本。
    await getGhostNodeRuntimeBroker().stopAndWait(expected.ghostId);
    let result: Awaited<ReturnType<typeof manager.update>>;
    let packagePlaced = false;
    try {
      // 市场更新同样会原位 rename 插件目录。Windows 上不能只发停止信号，
      // 必须确认旧 utilityProcess 已离开，否则入口文件仍可能被占用而报 EPERM。
      getGhostAgentSlot().clearGhost(expected.ghostId);
      getGhostErrandSlot().clearGhost(expected.ghostId);
      // receipt 模型下更新必须绑定 receipt token(决策 A:与 main 的 sha 钉扎叠加),
      // 否则并发批准变更绕不过去。
      if (!expected.expectedInstalledApproval) {
        throwIpcError(
          'PRECONDITION_FAILED',
          'Plugin approval state was not bound to the market update',
        );
      }
      // Lock order: owner lease -> install lock -> OAuth security lock. Keep
      // the strict lock through package swap, receipt commit, and compensation.
      result = await withActiveOwnerGhostOauthMutationLock(expected.ghostId, () =>
        manager.update(cindyFilePath, {
          expectedPackageSha256: inspected.packageSha256,
          expectedInstalledApproval: expected.expectedInstalledApproval!,
          ...(trustOverride ? { trustOverride } : {}),
          beforePackageCommit: () =>
            getGhostOauthAccountManager().prepareAccountsForChangedClients(
              withRuntimeFiloGoogleClient(installed.manifest),
              withRuntimeFiloGoogleClient(inspected.canonicalManifest),
            ),
          onPackagePlaced: () => {
            packagePlaced = true;
            expected.onPackagePlacedInLock?.();
          },
        }),
      );
    } catch (error) {
      if (!packagePlaced) {
        spawnIfResident(installed);
        throw error;
      }
      const placed = manager.list().find((ghost) => ghost.manifest.id === expected.ghostId);
      if (!placed) throw error;
      log.warn('market ghost post-placement notification failed', {
        ghostId: expected.ghostId,
        error: error instanceof Error ? error.message : String(error),
      });
      result = { ghost: placed };
    }
    if ('rejection' in result) {
      // 回滚失败 = 安装目录可能已是新字节或缺失,"旧版本还在"不成立,不得按旧
      // InstalledGhost 重启运行时(P1:那会拿旧批准跑未知字节)。
      if (!(result.rejection.code === 'io' && result.rejection.rollbackFailed)) {
        spawnIfResident(installed);
      }
      throwInstallError(result.rejection);
    }
    runtime.resetFuse(expected.ghostId);
    const store = getLayoutStore();
    const docked = layoutWithGhostPanel(store.getLayout(), result.ghost.manifest);
    if (docked) {
      const applied = store.setLayout(docked);
      if ('rejection' in applied) {
        log.warn('market ghost panel dock rejected', {
          id: result.ghost.manifest.id,
          reason: applied.rejection,
        });
      }
    }
    spawnIfResident(result.ghost);
    await expected.afterCommitInLock?.(result.ghost, commitEvidence);
    return result.ghost;
  } finally {
    releaseMutation?.();
  }
}

type GhostUninstallLedgerCompletion = () => Promise<void>;
type GhostUninstallLedgerPreparer = (ghostId: string) => GhostUninstallLedgerCompletion | null;

let prepareGhostUninstallLedgerCompletion: GhostUninstallLedgerPreparer | null = null;

/**
 * 由 Plugin Market 在 IPC 注册期注入账本桥接，保持 cindy-brain 不反向依赖
 * 市场服务。preparer 在卸载开始前捕获 owner，返回的 completion 只在卸载成功后执行。
 */
export function setGhostUninstallLedgerPreparer(preparer: GhostUninstallLedgerPreparer): void {
  prepareGhostUninstallLedgerCompletion = preparer;
}

/**
 * 卸载一张意识并清理其宿主侧凭证、KV、私有文件与最近使用记录。
 * Plugin 市场和本地插件页共用；本地入口还会在成功后同步市场账本。
 */
export async function uninstallGhostAndCleanup(
  id: string,
  options?: { skipMarketLedger?: boolean },
): Promise<void> {
  // 按 ghostId 与装入/更新互斥:卸载与同 id 的市场/本地装入不得交错,否则
  // 市场装入的"目标是否已装"判定会被本卸载在其落位前抽走(反之亦然)。
  return withGhostInstallLock(id, () =>
    withActiveOwnerGhostOauthMutationLock(id, () => uninstallGhostAndCleanupLocked(id, options)),
  );
}

async function uninstallGhostAndCleanupLocked(
  id: string,
  options?: { skipMarketLedger?: boolean },
): Promise<void> {
  const releaseMutation = beginGhostMutation();
  try {
    requireGhostAvailableForActiveSession(id);
    const completeLedger =
      options?.skipMarketLedger === true
        ? null
        : (prepareGhostUninstallLedgerCompletion?.(id) ?? null);
    const manager = getGhostManager();
    const runtime = getGhostRuntime();
    // Library 的 orphaned 标记要在 uninstall 之前取显示名(收走后 list 里就没了)。
    const libraryDisplayName =
      manager.list().find((g) => g.manifest.id === id)?.manifest.name ?? id;
    runtime.stop(id);
    getGhostNodeRuntimeBroker().stop(id);
    getGhostAgentSlot().clearGhost(id);
    getGhostErrandSlot().clearGhost(id);
    getGhostSubscriptionGateway().dropGhost(id);
    const result = await manager.uninstall(id, { notify: false });
    if ('rejection' in result) throwUninstallError(result.rejection);
    removeGhostSecrets(id);
    removeGhostKvBestEffort(
      createGhostKvStore({
        getRootDir: () => ownerScopedUserDataPath('ghost-kv'),
        log,
      }),
      id,
      log,
    );
    if (isValidGhostId(id)) {
      try {
        await fs.promises.rm(ownerScopedUserDataPath('ghost-fs', id), {
          recursive: true,
          force: true,
        });
      } catch (err) {
        log.warn('ghost-fs 私有目录回收失败', {
          id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Library(持久作品库)与 ghost-fs 语义相反:**卸载不删**。只标 orphaned
    // (设置页可见、重装自动重挂)并作废运行会话;删除必须走设置页独立确认
    // (deleteGhostLibraryForActiveOwner)。binding 同样保留——用户亲选的
    // 存储位置不因重装消失(对齐 pick-grants 先例)。best-effort:失败只
    // warn,不把卸载报成失败(与上面清账同纪律)。
    try {
      await getGhostLibrarySlot().disposeGhost(id);
      await refreshMivoLibraryExtraDirGrant();
      const vault = new LibraryVault({
        rootDir: () => ownerScopedUserDataPath('libraries', id),
        ghostId: id,
        log,
      });
      await vault.open();
      const orphanFailure = await vault.markOrphaned(libraryDisplayName);
      if (orphanFailure) {
        log.warn('library 卸载标记失败', { id, errorCode: orphanFailure.errorCode });
      }
    } catch (err) {
      log.warn('library 卸载收口失败(数据不受影响)', {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // 寄存物(#784)随意识回收:删掉本意识的 ghost-deposit 引用行,字节由
    // recycler 按"引用归零"统一处理(用户已发进聊天的那几张有 message ref
    // 兜着,不会被连带清掉)。只清寄存这一类——画廊/引渡的留存语义是既有
    // 产品行为,不在本改动的范围内改。
    // 卸载是用户明确动作,失败只记日志:包已经收走了,不能因为清账失败把
    // 卸载报成失败(与上面 ghost-fs / kv 清理同纪律)。
    try {
      const removed = await ledger.removeRefs({ refKind: 'ghost-deposit', refId: id });
      if (removed > 0) log.info('ghost deposit media refs removed', { id, removed });
    } catch (err) {
      log.warn('ghost deposit media refs 清理失败', {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    let recentIds: string[] | null = null;
    try {
      recentIds = forgetGhostRecentUsage(id);
    } catch (error) {
      log.warn('ghost recent usage 清理失败', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // 未读随意识一起走:包都没了还留一颗点,用户既点不开也清不掉。
    // 限速记账一并抹掉,重装后的第一条不该被上一世的时刻挡住。
    extinguishGhostUnread(id);
    badgeSlotSingleton?.forget(id);
    // 卸载刚落地,manager.list() 就是当下的全部事实(哪怕是空表)——标权威,
    // 好让「卸掉最后一个插件」也能把账本里的孤儿记录一并清掉。
    broadcastGhostsChanged(manager.list(), true);
    if (recentIds) broadcastGhostRecentUsageChanged(recentIds);
    try {
      await completeLedger?.();
    } catch (error) {
      // The package is already gone; a session switch must not report uninstall
      // as failed. The next market snapshot reconciles the ledger conservatively.
      log.warn('market ledger uninstall reconciliation deferred', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    releaseMutation();
  }
}

/** 市场默认安装必须尊重用户对内置插件的显式卸载选择。 */
export function isBuiltinGhostRemovedByUser(id: string): boolean {
  return readBuiltinTombstones(brainRootDir()).includes(id);
}

/**
 * launch: 'resident' 的意识在"唤醒且在场"时保持电子脑常驻——本函数是所有
 * "该在场了"时机的统一入口(应用启动扫描 / 装入即开 / 唤醒 / 更新换代后)。
 * spawn 幂等,重复调用零成本;失败走熔断记账,不抛出(fire-and-forget)。
 */
function spawnIfResident(ghost: InstalledGhost): void {
  if (!isGhostAvailableForActiveSession(ghost.manifest.id)) return;
  if (!ghost.enabled) return;
  // Node 常驻档与浏览器电子脑的 launch:resident 是两份独立声明、两项独立
  // 权限。Node 默认按需；只有明确声明 resident 才在这里提前点火。
  if (ghost.manifest.node?.lifecycle === 'resident') {
    void getGhostNodeRuntimeBroker()
      .startResident(ghost)
      .catch((err) => {
        log.warn('resident ghost node spawn error', {
          id: ghost.manifest.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
  if (ghost.manifest.launch !== 'resident') return;
  void getGhostRuntime()
    .spawn(ghost)
    .then((r) => {
      if (!r.ok)
        log.warn('resident ghost spawn failed', { id: ghost.manifest.id, reason: r.reason });
    })
    .catch((err) => {
      // spawn 已把可预期失败折叠成返回值;这里兜住意外异常,常驻点火绝不
      // 变成 main 进程 unhandledRejection(review P1)。
      log.warn('resident ghost spawn error', {
        id: ghost.manifest.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

function readLegacyJson<T>(
  file: string,
  parse: (raw: unknown) => T | null,
): LegacyMigrationRead<T> {
  try {
    const parsed = parse(JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown);
    return parsed === null
      ? LEGACY_MIGRATION_RETRYABLE_FAILURE
      : legacyMigrationAvailable(parsed);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? LEGACY_MIGRATION_MISSING
      : LEGACY_MIGRATION_RETRYABLE_FAILURE;
  }
}

function readLegacyEncryptedSecret(file: string): LegacyMigrationRead<string> {
  return readLegacyEncryptedValue(
    () => fs.readFileSync(file, 'utf-8'),
    () => safeStorage.isEncryptionAvailable(),
    (encoded) => safeStorage.decryptString(Buffer.from(encoded, 'base64')),
  );
}

export function registerGhostIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  const manager = getGhostManager();
  const runtime = getGhostRuntime();
  // 启动即对账一次 skill 槽链接:上次会话崩溃/异常退出留下的悬空链接、
  // 换账号后的期望态变化,都在这里自愈(后续变更由 ghosts:changed 广播驱动)。
  scheduleGhostSkillReconcile();
  const legacyRecoveryIpc = createLegacyGhostRecoveryIpcHandlers({
    assertTrusted: assertTrustedAppRendererEvent,
    invalid: (message) => throwIpcError('INVALID_PARAMS', message),
    failure: () => throwIpcError('INTERNAL', 'Legacy Plugin recovery failed.'),
    getStatus: getLegacyGhostRecoveryStatusForActiveSession,
    retry: retryLegacyGhostRecoveryForActiveSession,
  });
  ipcMain.handle(LEGACY_GHOST_RECOVERY_STATUS_CHANNEL, legacyRecoveryIpc.status);
  ipcMain.handle(LEGACY_GHOST_RECOVERY_RETRY_CHANNEL, legacyRecoveryIpc.retry);
  setGhostSandboxDevToolsDisabled(app.isPackaged);
  setGhostAppContextProvider(currentGhostAppContext);
  setGhostMediaModelsProvider(getGhostConfigurableMediaModels);
  // 面板唤醒电子脑(cindy-ghost://<id>/wake 供片分支):面板零桥,唤醒经它
  // 自己的协议通道进来。只对"已装且唤醒"的意识放行;熔断态不清账(重载 /
  // 重新唤醒才 resetFuse),spawn 幂等所以重复唤醒零成本。
  setGhostWakeHandler(async (ghostId) => {
    const ghost = findAvailableGhost(ghostId);
    if (!ghost || !ghost.enabled) return { state: 'off' };
    if (runtime.stateOf(ghostId) === 'fused') return { state: 'fused' };
    const spawned = await runtime.spawn(ghost);
    return { state: spawned.ok ? spawned.state : runtime.stateOf(ghostId) };
  });
  // 意识自定义参数 KV(/kv 协议端点的存储接线,FORGE_GUIDE §4.8):
  // 真身单意识单文件落 userData/ghost-kv/;注入 adapter 的是带"在装态守卫"
  // 的包装——分区协议 handler 终身注册,卸下后残留页面的写请求不许复活
  // 出新文件(读也一并挡,统一"卸下即不存在"语义)。
  const ghostKv = createGhostKvStore({
    getRootDir: () => ownerScopedUserDataPath('ghost-kv'),
    log,
  });
  ghostSetupKvStore = ghostKv;
  const ghostInstalled = (ghostId: string): boolean => findAvailableGhost(ghostId) !== null;
  setGhostKvStore({
    read: (ghostId) => (ghostInstalled(ghostId) ? ghostKv.read(ghostId) : {}),
    write: (ghostId, value) => {
      if (!ghostInstalled(ghostId)) return; // 幽灵写静默丢弃,不留文件
      ghostKv.write(ghostId, value);
      getGhostSetupChangeBus().emit(ghostId, { source: 'kv' });
    },
  });
  // /secrets 只写通道(network user 与 node.secretBindings 凭证一律由意识
  // settingsHtml 收单入库——宿主凭证渲染 2026-07-13 整体退役):现查在装
  // 清单拿收单键集(意识更新后立即以新清单为准,不吃分区 handler 闭包里的
  // 旧快照);login-email 派生凭证没有收单动作,不在键集内。保险库真身 =
  // providerSecretStore(safeStorage 键名与官方别名同一套)。卸下后的残留
  // 请求查无此意识,统一 404。
  setGhostSecretsHandler(async ({ ghostId, method, pathname, readBodyText }) => {
    const ghost = findAvailableGhost(ghostId);
    if (!ghost) return { status: 404 };
    const networkSecretDecls = ghost.manifest.network?.secrets ?? [];
    const nodeSecretDecls = ghost.manifest.node?.secretBindings ?? [];
    const userSecretKeys = networkSecretDecls
      // Host 派生与 oauth(主机托管授权)都没有"用户填值"这回事,
      // 不进 /secrets 收单键集(oauth 的 client 凭证走 /oauth 端点)。
      .filter(
        (s) => s.source !== 'login-email' && s.source !== 'oauth' && s.source !== 'oidc-token',
      )
      .map((s) => s.key)
      .concat(nodeSecretDecls.map((s) => s.key));
    // login-email 派生身份:GET 状态回查附 identity(= 当前登录邮箱,设置页
    // 只读展示"用的是哪个身份")。回给意识不算新增泄露面——插件详情已
    // 披露"将使用你的登录邮箱",且注入时它自己的服务端本就可见。写/删 405。
    const identitySecretKeys = networkSecretDecls
      .filter((s) => s.source === 'login-email')
      .map((s) => s.key);
    const managedSecretDecls = networkSecretDecls.filter((s) => s.source === 'oidc-token');
    const connectionResolution =
      managedSecretDecls.length > 0
        ? (() => {
            try {
              return resolveConnectionAudienceForGhost(ghostId);
            } catch {
              return null;
            }
          })()
        : null;
    const managedSecretStates = managedSecretDecls.map((s) => ({
      key: s.key,
      saved: isConnectionSecretReady(s.inject.hosts ?? [], connectionResolution),
    }));
    const isOfficialCindyGithub =
      ghost.manifest.id === 'cindy-github' && isCindyOfficialTrustInfo(ghost.trust);
    const ghCliSecretDecls = isOfficialCindyGithub
      ? networkSecretDecls.filter((s) => s.source === 'gh-cli')
      : [];
    const ghCliAvailable =
      ghCliSecretDecls.length > 0
        ? await getSharedGhCliTokenSource().probeAvailability()
        : false;
    return handleGhostSecretsRequest({
      method,
      pathname,
      readBodyText,
      userSecretKeys,
      identitySecretKeys,
      managedSecretStates,
      hostCredentialStates: ghCliSecretDecls.map((s) => ({
        key: s.key,
        source: 'gh-cli' as const,
        available: ghCliAvailable,
      })),
      getLoginEmail: () => getAuthState().user?.email ?? null,
      ghostId,
      vault: {
        saved: (id, key) => readGhostSecret(id, key) !== null,
        tail: (id, key) => readGhostSecretTail(id, key),
        store: (id, key, value) => {
          const stored = storeGhostSecret(id, key, value);
          if (stored) getGhostSetupChangeBus().emit(id, { source: 'secret', ref: key });
          return stored;
        },
        remove: (id, key) => {
          removeGhostSecret(id, key);
          getGhostSetupChangeBus().emit(id, { source: 'secret', ref: key });
        },
      },
      // 入库成功 → 主机代言 tips("凭证「xxx」已保存",带意识身份头);
      // 文案里的名字用清单声明的 label(给用户看的名称),兜底裸 key。
      onStored: (secretKey) => {
        const label =
          networkSecretDecls.find((s) => s.key === secretKey)?.label ??
          nodeSecretDecls.find((s) => s.key === secretKey)?.label ??
          secretKey;
        broadcastGhostHostNotice(ghostId, { textKey: 'secretSaved', textArgs: { name: label } });
      },
      log,
    });
  });
  // /oauth 通道(source:'oauth' 凭证的设置页动作面,FORGE_GUIDE §4.7):
  // client 凭证只写入库、连接/断开/默认账号由主机代办。同 /secrets 模式
  // 现查在装清单(意识更新立即以新声明为准);卸下后残留请求统一 404。
  setGhostOauthHandler(async ({ ghostId, method, pathname, readBodyText }) => {
    const ghost = findAvailableGhost(ghostId);
    if (!ghost) return { status: 404 };
    const runtimeManifest = withRuntimeFiloGoogleClient(ghost.manifest);
    const oauthSecrets = new Map<string, GhostOauthDecl>();
    for (const s of runtimeManifest.network?.secrets ?? []) {
      if (s.source === 'oauth' && s.oauth) oauthSecrets.set(s.key, s.oauth);
    }
    return handleGhostOauthRequest({
      method,
      pathname,
      readBodyText,
      oauthSecrets,
      networkHosts: runtimeManifest.network?.hosts,
      manager: getGhostOauthAccountManager(),
      ghostId,
      isTokenBrokerAuthorized: (id) => isGhostTokenBrokerAuthorized(id, 'runtime'),
      withMutationLock: withActiveOwnerGhostOauthMutationLock,
      onChanged: (secretKey) => {
        getGhostSetupChangeBus().emit(ghostId, { source: 'oauth', ref: secretKey });
        broadcastGhostsChanged(getGhostManager().list(), false, { projectionOnly: true });
      },
      log,
    });
  });
  // /connections 通道(network.connections 多连接的设置页动作面,FORGE_GUIDE
  // §4.7):地址 + token 成对入库、回查状态、删除、设默认。同 /secrets 模式
  // 现查在装清单(意识更新立即以新声明为准);卸下后残留请求统一 404。
  // 关键闸:**新增地址必须过 main 侧受信确认弹窗**——意识设置页是意识自绘
  // 的不可信界面,动态白名单扩张必须由主机模态拿到用户点头(规则 9:用代码
  // 保证,不靠意识自觉)。
  setGhostConnectionsHandler(async ({ ghostId, method, pathname, readBodyText }) => {
    const ghost = findAvailableGhost(ghostId);
    if (!ghost) return { status: 404 };
    const connectionDecls = ghost.manifest.network?.connections ?? [];
    const decls = new Map<string, { label: string; maxConnections: number }>();
    for (const c of connectionDecls) {
      decls.set(c.key, {
        label: c.label,
        maxConnections: c.maxConnections ?? GHOST_NETWORK_MAX_CONNECTIONS_PER_DECL,
      });
    }
    return handleGhostConnectionsRequest({
      method,
      pathname,
      readBodyText,
      decls,
      manager: getGhostConnectionManager(),
      ghostId,
      // 受信确认:main 侧系统模态(对照 bootstrap 的 moveToApplications 弹窗
      // 用法),默认落在「取消」上防误触;意识名从在装清单现查。
      confirmAddHost: async (declLabel, host) => {
        const ghostName = findAvailableGhost(ghostId)?.manifest.name ?? ghostId;
        // main 迷你 i18n 只内置 {{appName}} 插值,其余变量按其约定在调用点
        // 自行 replace(对照 bootstrap 菜单的用法)。
        const { response } = await dialog.showMessageBox({
          type: 'question',
          title: t('settings.ghosts.connections.confirmTitle'),
          message: t('settings.ghosts.connections.confirmMessage')
            .replaceAll('{{name}}', ghostName)
            .replaceAll('{{host}}', host),
          detail: t('settings.ghosts.connections.confirmDetail').replaceAll('{{label}}', declLabel),
          buttons: [
            t('settings.ghosts.connections.confirmAllow'),
            t('settings.ghosts.connections.confirmCancel'),
          ],
          defaultId: 1,
          cancelId: 1,
        });
        return response === 0;
      },
      onChanged: (declKey) => {
        getGhostSetupChangeBus().emit(ghostId, { source: 'connection', ref: declKey });
      },
      // 新连接添加成功 → 主机代言 tips(带意识身份头;与 secretSaved 同接法)。
      onAdded: (declKey) => {
        const label = connectionDecls.find((c) => c.key === declKey)?.label ?? declKey;
        broadcastGhostHostNotice(ghostId, { textKey: 'connectionAdded', textArgs: { label } });
      },
      log,
    });
  });
  // 主机正常退出:逐个销毁沙箱(docs/dev-rules/plugin-security-and-authoring.md 的"关完才走";
  // 主进程被强杀时 Chromium 会级联回收渲染子进程,无孤儿)。
  app.on('before-quit', () => {
    runtime.destroyAll();
    getGhostNodeRuntimeBroker().destroyAll();
  });

  // Stable-owner 后处理序列：先完成内置插件对账，再恢复常驻插件和旧账号凭证。
  // 旧凭证迁移保持 best-effort，不阻塞其他插件；任一迁移异常会把本 owner scope
  // 保持为 retry-pending，避免被 coordinator 误记为完成。
  const activateGhostsAndMigrateLegacyAccounts = (): 'completed' | 'retry-pending' => {
    for (const ghost of manager.list()) spawnIfResident(ghost);
    let legacyMigrationNeedsRetry = false;
    const activeOwnerId = getActiveAppSession().dataOwnerId;
    const canMigrateLegacyAccounts =
      getAppCapabilities().canUseCindyAccountServices &&
      activeOwnerId !== null &&
      hasLegacyOwnerNamespaceClaim(activeOwnerId);
    // 老 Google 集成 → Filo Google 意识的一次性搬账(lizi_google 退役配套):
    // filoCurrent 档案的账号同 client、refresh token 通用,直接迁入意识
    // 保险库;意识侧已有账号或老存储不存在时为 no-op(模块内幂等)。
    if (
      canMigrateLegacyAccounts &&
      manager.list().some((g) => g.manifest.id === FILO_GOOGLE_GHOST_ID)
    ) {
      try {
        const legacyDir = path.join(app.getPath('userData'), 'safe-storage');
        const migration = migrateFiloGoogleAccountsWithResult({
          readLegacyManifest: () => {
            return readLegacyJson(path.join(legacyDir, 'google_accounts.json'), (raw) => {
              if (!raw || typeof raw !== 'object') return null;
              const candidate = raw as { accounts?: unknown };
              if (!Array.isArray(candidate.accounts)) return null;
              return { accounts: candidate.accounts as LegacyGoogleAccountRow[] };
            });
          },
          readLegacyRefreshToken: (accountId) =>
            readLegacyEncryptedSecret(
              path.join(legacyDir, `google_account_refresh_token_${accountId}.enc`),
            ),
          vault: {
            read: (ghostId, storageKey) => readGhostSecret(ghostId, storageKey),
            store: (ghostId, storageKey, value) => storeGhostSecret(ghostId, storageKey, value),
            remove: (ghostId, storageKey) => removeGhostSecret(ghostId, storageKey),
          },
          log,
        });
        if (migration.retryPending) legacyMigrationNeedsRetry = true;
        if (migration.migrated > 0) {
          getGhostSetupChangeBus().emit(FILO_GOOGLE_GHOST_ID, {
            source: 'oauth',
            ref: FILO_GOOGLE_SECRET_KEY,
          });
        }
      } catch (err) {
        legacyMigrationNeedsRetry = true;
        log.warn('filo-google 搬账意外失败(不阻断启动)', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // 老 Jira/Confluence 集成 → XD Atlassian 意识的一次性搬账(lizi_jira /
    // lizi_confluence 退役配套):老 rt 与 server broker 同一 Atlassian 应用,
    // tokenBroker 模式走同一 broker 刷新,令牌通用;幂等语义同上。
    if (
      canMigrateLegacyAccounts &&
      manager.list().some((g) => g.manifest.id === XD_ATLASSIAN_GHOST_ID)
    ) {
      try {
        const legacyDir = path.join(app.getPath('userData'), 'safe-storage');
        const migration = migrateAtlassianAccountsWithResult({
          readLegacyRefreshToken: () =>
            readLegacyEncryptedSecret(path.join(legacyDir, LEGACY_JIRA_RT_FILE)),
          readLegacyConnection: () =>
            readLegacyJson(path.join(legacyDir, LEGACY_JIRA_CONNECTION_FILE), (raw) => {
              if (!raw || typeof raw !== 'object') return null;
              const candidate = raw as { email?: unknown };
              return { email: typeof candidate.email === 'string' ? candidate.email : null };
            }),
          vault: {
            read: (ghostId, storageKey) => readGhostSecret(ghostId, storageKey),
            store: (ghostId, storageKey, value) => storeGhostSecret(ghostId, storageKey, value),
            remove: (ghostId, storageKey) => removeGhostSecret(ghostId, storageKey),
          },
          log,
        });
        if (migration.retryPending) legacyMigrationNeedsRetry = true;
        if (migration.migrated > 0) {
          getGhostSetupChangeBus().emit(XD_ATLASSIAN_GHOST_ID, {
            source: 'oauth',
            ref: XD_ATLASSIAN_SECRET_KEY,
          });
        }
      } catch (err) {
        legacyMigrationNeedsRetry = true;
        log.warn('xd-atlassian 搬账意外失败(不阻断启动)', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // 老 Slack 官方 MCP → cindy-slack 意识的搬账已随意识退役删除
    // (2026-07-19 Slack 能力并轨 hook 通道;存量意识凭证由
    // RETIRED_BUILTIN_GHOSTS 对账清理)。
    // 老 GitHub 集成 → GitHub 意识(cindy-github)的一次性搬账(lizi_github 退役配套):
    // PAT 直接迁入意识 user 凭证槽;仅迁 github.com 连接(意识白名单静态
    // 钉死 github.com,GHE token 迁了也只会 401);幂等语义同上。
    if (
      canMigrateLegacyAccounts &&
      manager.list().some((g) => g.manifest.id === CINDY_GITHUB_GHOST_ID)
    ) {
      try {
        const legacyDir = path.join(app.getPath('userData'), 'safe-storage');
        const migration = migrateGithubAccountsWithResult({
          readLegacyToken: () =>
            readLegacyEncryptedSecret(path.join(legacyDir, LEGACY_GITHUB_TOKEN_FILE)),
          readLegacyConnection: () =>
            readLegacyJson(path.join(legacyDir, LEGACY_GITHUB_CONNECTION_FILE), (raw) => {
              if (!raw || typeof raw !== 'object') return null;
              const candidate = raw as { host?: unknown };
              return { host: typeof candidate.host === 'string' ? candidate.host : null };
            }),
          vault: {
            read: (ghostId, storageKey) => readGhostSecret(ghostId, storageKey),
            store: (ghostId, storageKey, value) => storeGhostSecret(ghostId, storageKey, value),
          },
          log,
        });
        if (migration.retryPending) legacyMigrationNeedsRetry = true;
        if (migration.migrated > 0) {
          getGhostSetupChangeBus().emit(CINDY_GITHUB_GHOST_ID, {
            source: 'secret',
            ref: CINDY_GITHUB_SECRET_KEY,
          });
        }
      } catch (err) {
        legacyMigrationNeedsRetry = true;
        log.warn('cindy-github 搬账意外失败(不阻断启动)', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // 老 GitLab 集成 → Cindy GitLab 意识(cindy-gitlab)的一次性搬账
    // (lizi_gitlab 退役配套):PAT + 实例地址迁入意识多连接声明
    // (gitlab_conn)并设为默认;仅迁 https 且不带端口的实例(意识出网
    // 仅 https、连接白名单只认裸域,迁了也打不通);幂等语义同上。
    if (
      canMigrateLegacyAccounts &&
      manager.list().some((g) => g.manifest.id === CINDY_GITLAB_GHOST_ID)
    ) {
      try {
        const legacyDir = path.join(app.getPath('userData'), 'safe-storage');
        const migration = migrateGitlabAccountsWithResult({
          readLegacyToken: () =>
            readLegacyEncryptedSecret(path.join(legacyDir, LEGACY_GITLAB_TOKEN_FILE)),
          legacyTokenExists: () => {
            try {
              return fs.existsSync(path.join(legacyDir, LEGACY_GITLAB_TOKEN_FILE));
            } catch {
              return false;
            }
          },
          readLegacyConnection: () =>
            readLegacyJson(path.join(legacyDir, LEGACY_GITLAB_CONNECTION_FILE), (raw) => {
              if (!raw || typeof raw !== 'object') return null;
              const candidate = raw as { baseUrl?: unknown; username?: unknown };
              return {
                baseUrl: typeof candidate.baseUrl === 'string' ? candidate.baseUrl : null,
                username: typeof candidate.username === 'string' ? candidate.username : null,
              };
            }),
          manager: getGhostConnectionManager(),
          log,
        });
        if (migration.retryPending) legacyMigrationNeedsRetry = true;
        if (migration.migrated > 0) {
          getGhostSetupChangeBus().emit(CINDY_GITLAB_GHOST_ID, {
            source: 'connection',
            ref: CINDY_GITLAB_CONNECTION_KEY,
          });
        }
      } catch (err) {
        legacyMigrationNeedsRetry = true;
        log.warn('cindy-gitlab 搬账意外失败(不阻断启动)', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return legacyMigrationNeedsRetry ? 'retry-pending' : 'completed';
  };

  void app.whenReady().then(() => {
    bindForgePackStagingTempDir(() => app.getPath('temp'));
    onAuthStateChange(() => {
      // Login/logout, Membership switches, and refresh integration all cross
      // an auth notification boundary. Discard every short-lived Connection
      // assertion so a late request can never reuse the previous identity.
      connectionTokenProviderSingleton?.clearAll();
      invalidateForgePackTicketsForOwner(getActiveAppSession());
      // 当前任务绑定属于窗口内的 owner 上下文，切账号/会员身份后不得沿用旧快照。
      ghostSessionFocusByWebContents.clear();
      clearIOSSimulatorRendererAccess();
      if (!getAppCapabilities().canUseCindyAccountServices) suspendCindyAccountGhosts();
      // Even when provisioning itself is a no-op, the renderer and agent
      // roster must immediately reflect the new session capability set.
      broadcastGhostsChanged(manager.list());
      // 未读账本按 owner 分文件,换账号后必须整表替换,否则账号 A 的绿点与摘要
      // 会留在账号 B 的插件入口与卡片上(跨账号残留)。
      broadcastGhostUnreadSnapshot();
    });
  });

  stableOwnerPostCommitTask = async (reason, scope) => {
    const outcome = await scheduleBuiltinReconcile(reason, scope);
    if (outcome === 'deferred') return outcome;
    if (
      activeOwnerScopeKey() !== scope.scopeKey
      || getActiveAppSession().dataOwnerId !== scope.dataOwnerId
    ) {
      return 'deferred';
    }
    // Resident activation is account-free for audience:"all" bundled plugins.
    // The migration body has its own committed-owner gate, so signed-out runs
    // the common activation phase without touching legacy account data.
    const activationOutcome = activateGhostsAndMigrateLegacyAccounts();
    return outcome === 'failed'
      ? 'failed'
      : outcome === 'retry-pending' || activationOutcome === 'retry-pending'
      ? 'retry-pending'
      : 'completed';
  };

  // ── 管子(脑机接口)main 侧 handler(docs/dev-rules/plugin-security-and-authoring.md)──────────────
  // 身份不信任 sender 自报,一律按 webContents id 反查绑定表验身。
  // 上行白名单:tool-result(交卷,派发器配对验身)/ tool-progress(长任务
  // 心跳续命,派发器配对验身)/ host-request(公开宿主上下文)/ cindy-request(cindy 槽
  // 代办,返回值即结果)/ card-update(卡槽③供片,cardService 校验链)/
  // notify(系统提示,notifySlot 资格审+限速)/ fs-request(fs 槽代写文件,
  // fsSlot 三档守门)/ agent-request(Agent 新回合,一次性用户票或后台权限
  // 守门)/ agent-errand-request(派活取件,agent.errand 加档 + 频控守门)/
  // node-request(随包 Node JSON-RPC/MCP stdio 中继)/ pick-request
  // (系统级选文件夹,用户亲选即授权)/ preview-request(右侧栏开预览标签,
  // preview.hosts 白名单守门)/ workspace-request(工作区会话入口,亲选或
  // 确认卡授权,判重/创建在 workspaceSlot)。其它类型一律拒。
  ipcMain.handle('ghost-pipe:ping', (event) => {
    const id = ghostIdForLogicWebContents(event.sender.id);
    if (!id) throwIpcError('PERMISSION_DENIED', '非意识电子脑上下文');
    requireGhostAvailableForActiveSession(id);
    return { ok: true, id };
  });
  ipcMain.handle('ghost-pipe:send', async (event, payload: unknown) => {
    const id = ghostIdForLogicWebContents(event.sender.id);
    if (!id) throwIpcError('PERMISSION_DENIED', '非意识电子脑上下文');
    requireGhostAvailableForActiveSession(id);
    const type = (payload as { type?: unknown } | null)?.type;
    if (type === 'tool-result') {
      // 交卷结果不回传细节(accepted=false 的原因只进日志,不给沙箱探测面)。
      const outcome = getGhostPipeDispatcher().handleToolResult(id, payload);
      if (!outcome.accepted) log.warn('ghost tool-result rejected', { id, reason: outcome.reason });
      return { ok: true };
    }
    // tool-progress = 长任务心跳续命(配对/验身/天花板都在派发器;
    // 拒因只进日志,恒回 ok,与 tool-result 同纪律不给沙箱探测面)。
    if (type === 'tool-progress') {
      const outcome = getGhostPipeDispatcher().handleToolProgress(id, payload);
      if (!outcome.accepted)
        log.warn('ghost tool-progress rejected', { id, reason: outcome.reason });
      return { ok: true };
    }
    // host-request = 读取宿主只读信息。app-context 不要求卡槽；cindy-preference
    // 只返回调用插件自己已声明能力的当前选型，不返回其它插件配置或凭证。
    // 未知 kind 明确拒绝，避免接口悄悄扩面。
    if (type === 'host-request') {
      const kind = (payload as { kind?: unknown } | null)?.kind;
      if (kind === 'app-context') return currentGhostAppContext();
      if (kind === 'cindy-preference') {
        return getGhostConfiguredMediaModel(
          id,
          (payload as { capability?: unknown } | null)?.capability,
        );
      }
      throwIpcError('INVALID_PARAMS', '未知的宿主请求类型');
    }
    // cindy-request = 请 Cindy 本体代办;旧名 model-request 静默兼容(更名前的老包)。
    if (type === 'cindy-request' || type === 'model-request') {
      return getGhostCindySlot().handleModelRequest(id, payload);
    }
    // fetch-request = network 槽代理 HTTP(invoke 返回值即响应,机制同上)。
    if (type === 'fetch-request') {
      return getGhostNetworkSlot().handleFetchRequest(id, payload);
    }
    // fs-request = fs 槽代写文件(私有目录/workdir/save 票据三档守门在 fsSlot;
    // invoke 返回值即结构化结果,失败带人话原因供意识作者调试)。
    if (type === 'fs-request') {
      return getGhostFsSlot().handleFsRequest(id, payload);
    }
    // library-request = library 持久作品库(资格审/binding 根解析/owner scope
    // 复核/SQL 语句门在 librarySlot;结果结构化 errorCode,永不 reject)。
    if (type === 'library-request') {
      return getGhostLibrarySlot().handleLibraryRequest(id, payload);
    }
    // agent-request = 让 Cindy Agent 开始一个普通 user 回合；插件文本绝不
    // 进入 system prompt。票据、会话归属、模板和后台权限都在 agentSlot。
    if (type === 'agent-request') {
      return getGhostAgentSlot().handleRequest(id, payload);
    }
    // agent-errand-request = 派活取件(agent 槽 errand 加档):任务进插件
    // 专属 errand 会话跑一轮,最终回复文字取回给插件;任务文本同样只进
    // 普通 user 消息。资格审/频控/任务表在 errandSlot,会话与收口在注入
    // 的 runner(maker-ipc)。
    if (type === 'agent-errand-request') {
      return getGhostErrandSlot().handleRequest(id, payload);
    }
    // node-request 只在 main.js → contextBridge → 主机方向开放。子进程反向
    // JSON-RPC 请求恒被 broker 拒绝，因此 Node 不能绕过 main.js 控制 Cindy。
    if (type === 'node-request') {
      return getGhostNodeRuntimeBroker().handleRequest(id, payload);
    }
    // pick-request = 系统级选文件夹(pick 槽):用户亲手选中即授权,取消即拒;
    // 限速/单发/结果分档在 pickSlot。
    if (type === 'pick-request') {
      return getGhostPickSlot().handleRequest(id, payload);
    }
    // workspace-request = 工作区会话入口(workspace 槽):目录亲选或确认卡
    // 授权,已有 active 会话复用;限速/判重/创建守门在 workspaceSlot。
    if (type === 'workspace-request') {
      return getGhostWorkspaceSlot().handleRequest(id, payload);
    }
    // ios-simulator-request = 当前任务的脱敏只读状态与 Host 面板入口。
    // 视频帧、输入与 Sidecar 进程均不跨插件边界；任务身份由 Host 窗口绑定。
    if (type === 'ios-simulator-request') {
      return getGhostIOSSimulatorSlot().handleRequest(id, payload);
    }
    // preview-request = 右侧栏开预览标签(preview 槽):URL 必须命中身份卡
    // preview.hosts 白名单;守门/限速在 previewSlot,落地在 renderer。
    if (type === 'preview-request') {
      return getGhostPreviewSlot().handleRequest(id, payload);
    }
    // schedule-request = 打开自动化创建面板并预填(agent 槽的 schedule 加档):
    // 只开面板,任务由用户选模型后亲手保存才落库——本槽全程不碰 schedule storage。
    // 资格审/净化/频率钳制/限速在 scheduleSlot,落地在 renderer。
    if (type === 'schedule-request') {
      return getGhostScheduleSlot().handleRequest(id, payload);
    }
    if (type === 'card-update') {
      // 卡槽③供片:校验链(归属/卡槽/限速/净化)在 cardService,拒绝原因
      // 只进日志,恒回 { ok: true }(与 tool-result 同纪律,不给沙箱探测面)。
      getGhostCardService().handleCardUpdate(id, payload);
      return { ok: true };
    }
    if (type === 'event-verdict') {
      // 卡槽①钩子裁决:归属/形状校验在网关,冒名/过期静默丢,恒回 ok
      // (不给沙箱探测面)。
      getGhostSubscriptionGateway().handleVerdict(id, payload);
      return { ok: true };
    }
    // notify = 系统提示(notify 槽):资格审/净化/限速在 notifySlot,
    // invoke 返回值即结构化结果(失败带人话原因,供意识作者调试)。
    if (type === 'notify') {
      return getGhostNotifySlot().handleNotify(id, payload);
    }
    // badge = 未读角标(badge 槽):资格审看 badge 卡槽、
    // 净化/限速/落盘在 badgeSlot。与 notify 的分工是"持久状态"对"一次性 toast"。
    if (type === 'badge') {
      return getGhostBadgeSlot().handleBadge(id, payload);
    }
    // confirm-request = 确认弹窗(confirm 槽):资格审/净化/限速/单飞在
    // confirmSlot,往返与超时兜底在 ghostConfirmDialogBridge。invoke 返回值即
    // 结构化结果:ok:true 只代表问到了,答案看 confirmed。
    if (type === 'confirm-request') {
      return getGhostConfirmSlot().handleRequest(id, payload);
    }
    throwIpcError('INVALID_PARAMS', '未知的管子消息类型');
  });

  // ── 确认弹窗回包(confirm 槽)────────────────────────────────────────
  // renderer 上的确认框被用户点掉之后,把答案送回 main 结算那条挂起的管子请求。
  // 不校验 sender 归属:requestId 是 main 自己铸的 randomUUID,只在本机 renderer
  // 手里;陌生/重复的 id 由桥直接忽略(返回 handled:false),没有可利用面。
  // 非布尔的 confirmed 在桥里一律按"没同意"兜底,不给靠畸形回包骗到同意的路。
  ipcMain.handle('ghosts:confirm:resolve', async (_event, raw: unknown) => {
    const p = raw as { requestId?: unknown; confirmed?: unknown } | null;
    if (
      !p ||
      typeof p.requestId !== 'string' ||
      p.requestId.length === 0 ||
      p.requestId.length > 128
    ) {
      throwIpcError('INVALID_PARAMS', 'requestId must be a non-empty string');
    }
    const bridge = getGhostConfirmDialogBridge();
    if (!bridge) return { handled: false };
    return { handled: bridge.resolve(p.requestId, p.confirmed) };
  });

  ipcMain.handle('forge-oidc-install:resolve-confirm', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const p = raw as { requestId?: unknown; confirmed?: unknown } | null;
    if (
      !p ||
      typeof p.requestId !== 'string' ||
      p.requestId.length === 0 ||
      p.requestId.length > 128 ||
      typeof p.confirmed !== 'boolean'
    ) {
      throwIpcError('INVALID_PARAMS', 'invalid Forge OIDC install confirmation');
    }
    const bridge = getForgeOidcInstallConfirmBridge();
    if (!bridge) return { handled: false };
    return { handled: bridge.resolve(p.requestId, p.confirmed) };
  });

  // ── 意识聊天卡片取件(卡槽③;宿主 renderer 历史回放用)──────────────
  // 查询型 handler:无卡返回 { card: null },renderer 据此降级为通用媒体
  // 渲染(远程会话/被 GC 的历史卡都走这条),不抛 NOT_FOUND——规则 13 的
  // 显式例外(失败面需要 fallback 语义才能正确显示)。
  ipcMain.handle('ghosts:card:get', async (_event, callId: unknown) => {
    if (typeof callId !== 'string' || callId.length === 0 || callId.length > 128) {
      throwIpcError('INVALID_PARAMS', 'callId must be a non-empty string');
    }
    try {
      return { card: await getGhostCard(callId) };
    } catch (err) {
      // DB 未就绪等基建失败:按无卡降级(renderer 走 generic),只记日志。
      log.warn('ghosts:card:get failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { card: null };
    }
  });

  // 会话切换上报(订阅槽①;renderer MainLayout 路由 effect 单向 send,无返回):
  // 非法载荷按 null(切去非会话页)处理,去重与资格门都在 noteGhostSessionFocused 之后。
  ipcMain.on('ghosts:session-focused', (event, sessionId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const normalizedSessionId =
      typeof sessionId === 'string' && sessionId.trim().length > 0 && sessionId.trim().length <= 128
        ? sessionId.trim()
        : null;
    noteGhostWindowSessionFocused(event.sender, normalizedSessionId);
  });

  // 会话批量取卡(卡槽③;宿主 renderer 会话打开时一次性灌 byCallId)。查询型
  // handler:失败返回 { cards: [] } 让 renderer 照常渲染(缺历史卡自动降级),
  // 不抛(规则 13 显式例外)。含 turn 级自绘卡(callId = assistant 消息 clientId)。
  ipcMain.handle('ghosts:card:list-by-session', async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) {
      throwIpcError('INVALID_PARAMS', 'sessionId must be a non-empty string');
    }
    try {
      return { cards: await listGhostCardsBySession(sessionId) };
    } catch (err) {
      log.warn('ghosts:card:list-by-session failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { cards: [] };
    }
  });

  // 权威实测高回填(宿主 renderer 量高后调;可信应用层,意识面板碰不到):
  // 历史回放据此零动画首帧贴合。clamp 与供片同一对常量;行不存在静默跳过。
  ipcMain.handle('ghosts:card:report-height', async (_event, callId: unknown, height: unknown) => {
    const parsed = parseCardHeightReport(callId, height);
    if (!parsed.ok) {
      throwIpcError('INVALID_PARAMS', parsed.error);
    }
    try {
      await updateGhostCardHeight(parsed.callId, parsed.height);
    } catch (err) {
      log.warn('ghosts:card:report-height failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { ok: true };
  });

  // 交互卡(v2)按钮点击回传(宿主受信桥 → 校验归属 → 唤醒意识 → 管子下发
  // card-action)。fire-and-forget:恒回 { ok } 给 renderer(reason 仅日志),
  // 派发器内部永不抛;意识随后自绘 card-update 换新卡走既有回放路径。
  ipcMain.handle(
    'ghosts:card:action',
    async (event, callId: unknown, actionId: unknown, prompt?: unknown) => {
      assertTrustedAppRendererEvent(event);
      const r = await getGhostCardActionDispatcher().dispatch(callId, actionId, prompt);
      return { ok: r.ok };
    },
  );

  ipcMain.on('ghosts:list', (event) => {
    event.returnValue = { ghosts: availableGhosts().map(projectGhostForRenderer) };
  });

  // Plugin 页的已安装快捷行按最近成功使用排序。历史是主机 UI 状态，不写入
  // publisher-owned manifest；同步读保证列表首帧不先按扫描序再跳成最近序。
  ipcMain.on('ghosts:recent-usage', (event) => {
    try {
      event.returnValue = { ids: loadGhostRecentIds() };
    } catch (error) {
      // 最近使用只是快捷行排序元数据，不得因配置文件损坏 /
      // 权限异常阻断 Plugin 页首屏。main 记录后空历史降级。
      log.warn('ghost recent usage 读取失败', {
        error: error instanceof Error ? error.message : String(error),
      });
      event.returnValue = { ids: [] };
    }
  });
  ipcMain.handle('ghosts:mark-used', (_event, id: unknown) => {
    if (typeof id !== 'string' || !isValidGhostId(id)) {
      throwIpcError('INVALID_PARAMS', 'id must be a valid Ghost id');
    }
    if (!findAvailableGhost(id)) {
      throwIpcError('NOT_FOUND', `意识 ${id} 未安装`);
    }
    try {
      const ids = markGhostRecentlyUsed(id);
      broadcastGhostRecentUsageChanged(ids);
      return { ids };
    } catch (error) {
      // 记录 MRU 失败不应把一次已成功的消息发送变成用户错误。
      log.warn('ghost recent usage 写入失败', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ids: [] };
    }
  });

  // 未读角标快照(badge 槽)。同步读的理由与 recent-usage 同款:插件入口
  // 与插件卡的绿点必须**首帧就对**,先渲染成"全无未读"再跳出一颗点是可见跳变。
  // 账本损坏 / 权限异常一律降级成空,不阻断首屏。
  // 来源闸:未读 summary 是**插件正文**(工单标题、邮件主题、任务名),
  // 泄给导航到别处的 renderer / WebView / 插件页就是内容泄漏。
  // 这里用非抛出的判据而不是 assert:sendSync 里抛错会在 renderer 侧变成同步
  // 异常炸掉调用点,而未读只是提醒——不可信来源降级成空表即可(codex review)。
  ipcMain.on('ghosts:unread', (event) => {
    event.returnValue = { entries: isTrustedAppRendererEvent(event) ? visibleGhostUnread() : [] };
  });

  // 用户侧熄灭未读(打开面板 = 明确已读)。不要求意识仍在装:卸载残留的
  // 陈旧条目也该能被清掉,否则界面上会留一颗永远点不掉的点。
  // 来源闸同上:它会改写 owner 作用域的账本,不能让非可信 frame 拿任意合法
  // 插件 id 把别人的未读清掉(codex review)。
  ipcMain.handle('ghosts:clear-unread', (event, id: unknown, seenAt: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof id !== 'string' || !isValidGhostId(id)) {
      throwIpcError('INVALID_PARAMS', 'id must be a valid Ghost id');
    }
    if (seenAt !== undefined && (typeof seenAt !== 'number' || !Number.isFinite(seenAt))) {
      throwIpcError('INVALID_PARAMS', 'seenAt must be a finite number when provided');
    }
    // seenAt = renderer 当时**实际看到的那条**的点亮时刻。清除请求与插件的新点亮
    // 走两条独立 IPC,「新点亮先到、旧清除后到」完全可能发生;按它做条件删除,
    // 陈旧清除不会把用户还没看到的新摘要一并抹掉(codex review)。
    extinguishGhostUnread(id, seenAt as number | undefined);
    return { ok: true };
  });

  // ── 配置就绪检查(使用前置门,判定与 handler 主体在 ghostSetupStatus.ts)──
  // 插件页点「使用」时现查:清单推导需求(有 setup 声明按声明,无则启发式),
  // 逐项核对保险库 / OAuth 账号 / 连接 / kv。全同步毫秒级、不缓存、不唤沙箱;
  // oauth 判定用运行时清单(filo-google 的内置 client 是运行时注入的,读原始
  // 清单会把「开箱即用」误判成未配置)。判定只管存在性:user 凭证只查加密
  // 文件存在(不解密);key 有效性仍由运行期 networkSlot 出网 fail-fast 兜底。
  // 探针意外抛错不捕获——invoke reject 后 renderer 放行(fail-open),
  // 不把「查询失败」折叠成「未配置」误拦。
  ipcMain.handle('ghosts:setup-status', (_event, id: unknown) =>
    handleGhostSetupStatusRequest({
      id,
      getRuntimeManifest: (ghostId) => {
        const ghost = findAvailableGhost(ghostId);
        return ghost ? withRuntimeFiloGoogleClient(ghost.manifest) : null;
      },
      probesFor: (runtimeManifest) => {
        const ghostId = runtimeManifest.id;
        const oauthManager = getGhostOauthAccountManager();
        const connectionManager = getGhostConnectionManager();
        // kv 单意识单文件,同一次判定内最多读一次(多条 kv 需求不重复开盘);
        // 走 readStrict:IO 异常 / 文件损坏上抛 → invoke reject → renderer
        // fail-open,不折叠成「未配置」。secrets 探针同口径(statSync 区分
        // ENOENT 与真 IO 错误)。oauth / connections 沿用与 /oauth、
        // /connections 设置页端点完全相同的读取真身(保险库读取失败折叠为
        // 「无账号 / 无连接」)——有意保持两处口径一致:即便极端情况下保险
        // 库损坏,引导弹窗指向的设置页展示的也是同一状态,不产生自相矛盾的
        // 界面;且这类故障下运行期注入同样不可用,引导去设置页重连本就是
        // 正确动作。
        let kvSnapshot: Record<string, unknown> | null = null;
        return {
          secretSaved: (key) => ghostSecretSaved(ghostId, key),
          oauthStatus: (key) => {
            const decl = runtimeManifest.network?.secrets?.find((s) => s.key === key)?.oauth;
            const accounts = oauthManager.listAccounts(ghostId, key);
            return {
              clientConfigured: oauthManager.clientConfigured(ghostId, key, decl),
              connected: accounts.filter((a) => a.status === 'connected').length,
              expired: accounts.filter((a) => a.status === 'expired').length,
            };
          },
          connectionCount: (key) => connectionManager.list(ghostId, key).length,
          kvValue: (key) => {
            if (kvSnapshot === null) kvSnapshot = ghostKv.readStrict(ghostId);
            return kvSnapshot[key];
          },
        };
      },
    }),
  );

  // ── 面板媒体换发(拖拽引渡 + 右键菜单)──────────────────────────────
  // 只由宿主 renderer(可信应用层)调用——意识面板零桥碰不到 IPC。
  // 校验链与 preview 闸同纪律(纯逻辑在 previewGate.resolveGhostPanelMedia):
  // 形状严校验 → 账本归属绑定 URL 里声明的意识 id → mime 以账本为准。
  // 图片 / 视频都放行:图片换发 cindy-media:// 地址(引渡侧走会话缓存复制的
  // 图片附件链路);视频附带指纹仓磁盘路径 + 体积(不复制字节,引渡侧落成与
  // 「从系统拖 .mp4 进聊天」同款的 file 类别路径附件)。失败统一 NOT_FOUND
  // (调用方 toast / 静默即可,无需区分原因)。
  ipcMain.handle('ghosts:resolve-panel-media', async (_event, uri: unknown, purpose: unknown) => {
    if (typeof uri !== 'string') throwIpcError('INVALID_PARAMS', 'uri must be a string');
    const resolved = await resolveGhostPanelMedia(uri, purpose === 'menu' ? 'menu' : 'attach', {
      ghostCanRead: (hash, ghostId) => ledger.ghostCanRead(hash, ghostId),
      getBlobInfo: (hash) => ledger.getBlobInfo(hash),
      blobUrl: (hash, ext) => blobStore.blobUrl(hash, ext),
      blobAbsPath: (hash, ext) => blobStore.resolveHashRef(hash, ext).absPath,
      statSize: (absPath) => fs.promises.stat(absPath).then((s) => s.size),
    });
    if (!resolved) throwIpcError('NOT_FOUND', '不是本意识名下的可用媒体');
    return resolved;
  });

  // ── cindy 槽后端覆盖(解析表第②层;意识详情页「Cindy 能力」区)──
  // 读走 sendSync:详情页首帧要和其它信息同帧渲染(规则 7 无跳变),
  // 文件读取极小。写走 invoke,白名单在此校验(存储层不感知模型清单)。
  ipcMain.on('ghosts:cindy-prefs', (event, ghostId: unknown) => {
    const storedOverrides = typeof ghostId === 'string' ? readGhostCindyOverrides(ghostId) : {};
    const overrides = { ...storedOverrides };
    for (const capability of GHOST_MEDIA_CAPABILITIES) {
      const value = storedOverrides[capability];
      if (!value) continue;
      const selected = resolveAndMigrateGhostMediaPreference(
        ghostId as string,
        capability,
        getGhostMediaPreferenceConfig(ghostId as string, capability),
        value,
      );
      if (selected) overrides[capability] = selected.id;
      else delete overrides[capability];
    }
    // 每类目一份 options + defaultModel(当前包含 image/video 两类;下拉按
    // 能力键的类目取对应清单)。defaultModel:目录默认选型的展示信息
    // ("默认(GPT Image 2)"),让用户看得见"跟随"当下跟的是谁;
    // null = 目录没有该类目的模型(能力暂不可用),渲染层据此显示灰字而非下拉。
    const byKind = (cfg: CindyMediaCatalogConfig | CindyMediaPreferenceConfig) => {
      const standard = cfg.defaults?.standard;
      return {
        options: cfg.models,
        defaultModel:
          standard === undefined ? null : (cfg.models.find((m) => m.id === standard) ?? null),
      };
    };
    // 文本类(快问快答)的可选项 = 当前供应商目录里的全部文本模型(2026-08-05
    // 与刘佳黎定稿:安装插件即承担其成本,主机如实展示可选面)。每一项精确钉
    // 一组 供应商×agent×模型(cat: 编码)。defaultModel = 当前辅助模型链链首,
    // declaredModel = 身份卡声明的偏好(解析得到才给)——让"跟随默认"
    // 行如实说出当前实际跟的是谁。
    const textChain = getEffectiveAuxiliaryModelChain();
    const textDefaultId = textChain.refs[0] ?? null;
    const textDefaultLabel = textDefaultId === null
      ? null
      : formatAuxiliaryModelRefLabel(textDefaultId);
    const textOptions = buildTextOneshotPinOptions(
      getActiveCatalog(),
      readModelDisableOverrides(),
      readProviderOrder(),
      hasOneshotProviderCredential,
    );
    // 纯展示口径,不走 findAvailableGhost 的"当前会话可用"闸:插件被当前项目
    // 停用时卡片的其余部分(overrides/options)照常渲染,声明偏好也不该凭空消失。
    const declaredRaw = typeof ghostId === 'string'
      ? getGhostManager().list().find((g) => g.manifest.id === ghostId)?.manifest.cindy?.oneshotModel
      : undefined;
    const declaredResolved = declaredRaw
      ? resolveOneshotCatalogModel(
          getActiveCatalog(),
          readModelDisableOverrides(),
          declaredRaw,
          readProviderOrder(),
          hasOneshotProviderCredential,
        )
      : null;
    event.returnValue = {
      overrides,
      image: byKind(getGhostMediaPreferenceConfig(ghostId as string, 'image.generate')),
      imageEdit: byKind(getGhostMediaPreferenceConfig(ghostId as string, 'image.edit')),
      video: byKind(getGhostMediaPreferenceConfig(ghostId as string, 'video.generate')),
      videoEdit: byKind(getGhostMediaPreferenceConfig(ghostId as string, 'video.edit')),
      text: {
        options: textOptions,
        defaultModel:
          textDefaultId === null || textDefaultLabel === null
            ? null
            : { id: textDefaultId, label: textDefaultLabel },
        declaredModel: declaredResolved && declaredRaw
          ? {
              id: encodeCatalogPin(declaredResolved.providerId, declaredResolved.agentKind, declaredResolved.model),
              label: declaredRaw,
            }
          : null,
        // 存量轻量档位钉(目录扩展前钉下的合法值)的展示名表:渲染层据此给
        // 老钉值回显友好名,而不是把合法档位钉当 stale 原样露出 id。
        utilityProfiles: utilityModelPinOptions(),
      },
      // 向量类与图像/视频同源(都走目录派生),不同于文本类的轻量链档位。
      embed: byKind(getCatalogEmbedConfig()),
    };
  });
  // ── 目录级禁用(ghostWorkdirPrefs;插件页的项目范围视图)──
  // 读走 sendSync:切换范围时禁用清单要与卡片同帧渲染(规则 7 无跳变),
  // 文件读取极小且带 mtime 缓存。写走 invoke;写后广播 ghosts:changed
  // (renderer 复用同一订阅热更,多窗口同步)。
  ipcMain.on('ghosts:workdir-prefs', (event, workdir: unknown) => {
    event.returnValue = {
      disabled: typeof workdir === 'string' ? listDisabledGhostIdsForWorkdir(workdir) : [],
    };
  });
  ipcMain.handle(
    'ghosts:workdir-prefs:set',
    (_event, workdir: unknown, ghostId: unknown, disabled: unknown) => {
      if (typeof workdir !== 'string' || workdir.trim().length === 0) {
        throwIpcError('INVALID_PARAMS', 'workdir must be a non-empty string');
      }
      if (typeof ghostId !== 'string' || ghostId.trim().length === 0) {
        throwIpcError('INVALID_PARAMS', 'ghostId must be a non-empty string');
      }
      if (typeof disabled !== 'boolean') {
        throwIpcError('INVALID_PARAMS', 'disabled must be a boolean');
      }
      const wasDisabled = isGhostDisabledForWorkdir(ghostId, workdir);
      const next = setGhostDisabledForWorkdir(workdir, ghostId, disabled);
      // A setup card may already be waiting for this plugin in the affected
      // project. Wake all waiters for the plugin; each one revalidates its own
      // captured workdir and only the matching scope is rejected.
      if (wasDisabled !== disabled) {
        getGhostSetupChangeBus().emit(ghostId, { source: 'workdir_policy' });
      }
      // 生效面变了(新会话花名册 / $ 菜单),借 ghosts:changed 通知所有窗口
      // 重拉——载荷仍是完整已装清单,消费方按需再 sendSync 取目录级清单。
      broadcastGhostsChanged(manager.list());
      return { disabled: next };
    },
  );

  ipcMain.handle(
    'ghosts:cindy-prefs:set',
    (_event, ghostId: unknown, capability: unknown, model: unknown) => {
      if (typeof ghostId !== 'string' || ghostId.trim().length === 0) {
        throwIpcError('INVALID_PARAMS', 'ghostId must be a non-empty string');
      }
      if (!(CINDY_CAPABILITY_KEYS as readonly string[]).includes(capability as string)) {
        throwIpcError('INVALID_PARAMS', `unknown capability: ${String(capability)}`);
      }
      // 白名单按能力键类目分流:image.*/video.*/embed.* 钉各媒体目录模型 id;
      // text.*(快问快答)钉轻量档位键或目录钉(cat: 编码)——与消费方(cindySlot
      // route)同一判据,否则存进去的值链路不认。刻意不查凭证态(与清单的凭证
      // 过滤不同):凭证是瞬态(可以后补/会过期),钉档是持久意图;执行侧
      // fail-closed 兜底,不在这层把「暂时没配 key」当成非法值。
      if (
        !isCindyOverrideModelAllowed(capability as string, model, {
          image: getGhostMediaPreferenceConfig(
            ghostId,
            capability === 'image.edit' ? 'image.edit' : 'image.generate',
          ).models,
          video: getGhostMediaPreferenceConfig(
            ghostId,
            capability === 'video.edit' ? 'video.edit' : 'video.generate',
          ).models,
          embed: getCatalogEmbedConfig().models,
          textPinIds: buildTextOneshotPinOptions(
            getActiveCatalog(),
            readModelDisableOverrides(),
          ).map((o) => o.id),
        })
      ) {
        throwIpcError(
          'INVALID_PARAMS',
          'model must be null or an allowed model of the capability category',
        );
      }
      const overrides = writeGhostCindyOverride(
        ghostId,
        capability as CindyCapabilityKey,
        model as string | null,
      );
      getGhostSetupChangeBus().emit(ghostId, {
        source: 'host_config',
        ref: `cindy-pref:${String(capability)}`,
      });
      return { overrides };
    },
  );

  // ── agent 槽派活(errand)每插件配置(插件详情页「AI 代办」卡)──
  // 读走 sendSync(与 cindy-prefs 同理:详情页首帧同帧渲染);写走 invoke,
  // 整卡替换,值域清洗在存储层(errandPrefsStore.normalizeConfig 白名单,
  // permissionMode 只认 plan/acceptEdits/auto——bypassPermissions 协议上不存在)。
  // model/providerId 不在此处对目录校验:与 sessions:create 同一信任面
  // (可信 renderer 配置面),过期值由 errand runner 建会话时按 mapper 兜底。
  ipcMain.on('ghosts:errand-prefs', (event, ghostId: unknown) => {
    event.returnValue = {
      config: typeof ghostId === 'string' ? readGhostErrandConfig(ghostId) : {},
    };
  });
  ipcMain.handle('ghosts:errand-prefs:set', (_event, ghostId: unknown, config: unknown) => {
    if (typeof ghostId !== 'string' || ghostId.trim().length === 0) {
      throwIpcError('INVALID_PARAMS', 'ghostId must be a non-empty string');
    }
    if (config !== null && (typeof config !== 'object' || Array.isArray(config))) {
      throwIpcError('INVALID_PARAMS', 'config must be an object or null');
    }
    const saved = writeGhostErrandConfig(ghostId, config as Record<string, unknown> | null);
    return { config: saved };
  });

  ipcMain.handle('ghosts:install', async (event, lizFilePath: unknown, opts: unknown) => {
    assertTrustedAppRendererEvent(event);
    // 与市场路径同款 owner 租约:入口处同步捕获 owner,异步 inspect 之后、真正动
    // 文件系统之前取租约并核对 owner 未变 —— manager 的内容根/状态根都是调用时
    // 现解析的,异步窗口里账号切换落定会让后半段写进新 owner 的命名空间。
    const mutationOwner = captureGhostMutationOwner();
    if (typeof lizFilePath !== 'string' || lizFilePath.trim().length === 0) {
      throwIpcError('INVALID_PARAMS', 'lizFilePath must be a non-empty string');
    }
    const installOpts = opts as
      | {
          enable?: unknown;
          expectedPackageSha256?: unknown;
        }
      | undefined;
    const expectedPackageSha256 = installOpts?.expectedPackageSha256;
    if (
      typeof expectedPackageSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(expectedPackageSha256)
    ) {
      throwIpcError('INVALID_PARAMS', 'expectedPackageSha256 must come from ghosts:inspect');
    }
    const probe = await manager.inspect(lizFilePath);
    if ('rejection' in probe) throwInstallError(probe.rejection);
    if (probe.packageSha256 !== expectedPackageSha256) {
      throwIpcError('GHOST_FILE_INVALID', '插件文件在检查后发生了变化，请重新选择');
    }
    rejectReservedGhostId(probe.manifest.id);
    rejectBrokerWithoutDeclaredRedirectPort(probe.manifest);
    rejectUnauthorizedTokenBroker(probe.manifest);
    // Node 等高风险能力在插件详情中如实展示；安装事务不追加能力确认弹窗。
    const enable = installOpts?.enable === true;
    // owner 租约在锁外整段持有(防中途 owner 切换把落位写进新 owner);按 ghostId 的
    // 互斥锁由 installAndDock 自动获取(卡点),这里传 id 即可。二者语义不同,叠加保留。
    const releaseMutation = beginGhostMutation(mutationOwner);
    try {
      return {
        ghost: await installAndDock(manager, lizFilePath, {
          ghostId: probe.manifest.id,
          enable,
          expectedPackageSha256,
        }),
      };
    } finally {
      releaseMutation();
    }
  });

  // 原位更新(同 id 换版):先熄灯沙箱(新代码由下一次派活/面板重挂拉起),
  // 再换目录;唤醒状态与布局位置由 manager.update 保证延续。更新后走一次
  // 停靠(新版本首次声明面板时补位;已停靠则不动树)。
  ipcMain.handle('ghosts:update', async (event, lizFilePath: unknown, opts: unknown) => {
    assertTrustedAppRendererEvent(event);
    // 同 ghosts:install:入口同步捕获 owner,异步 inspect 后、熄灯与换版之前取租约。
    const mutationOwner = captureGhostMutationOwner();
    if (typeof lizFilePath !== 'string' || lizFilePath.trim().length === 0) {
      throwIpcError('INVALID_PARAMS', 'lizFilePath must be a non-empty string');
    }
    const updateOptions = opts as
      | {
          expectedPackageSha256?: unknown;
          expectedInstalledApproval?: unknown;
        }
      | undefined;
    const expectedPackageSha256 = updateOptions?.expectedPackageSha256;
    const expectedInstalledApproval = updateOptions?.expectedInstalledApproval;
    if (
      typeof expectedPackageSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(expectedPackageSha256)
    ) {
      throwIpcError('INVALID_PARAMS', 'expectedPackageSha256 must come from ghosts:inspect');
    }
    if (!isGhostInstallApprovalToken(expectedInstalledApproval)) {
      throwIpcError(
        'INVALID_PARAMS',
        'expectedInstalledApproval must come from ghosts:list',
      );
    }
    const inspected = await manager.inspect(lizFilePath);
    if ('rejection' in inspected) throwInstallError(inspected.rejection);
    if (inspected.packageSha256 !== expectedPackageSha256) {
      throwIpcError('GHOST_FILE_INVALID', '插件文件在检查后发生了变化，请重新选择');
    }
    rejectReservedGhostId(inspected.manifest.id);
    rejectBrokerWithoutDeclaredRedirectPort(inspected.manifest);
    rejectUnauthorizedTokenBroker(inspected.manifest);
    // 从熄灯到换版收尾整段持 owner 租约:熄灯之后每一步都在改"当前 owner"的插件世界,
    // 中途 owner 切换落定会把后半段(update 落盘/停靠/点火)写进新 owner。租约在锁外,
    // 与市场/本地装入/卸载共用的按 ghostId 互斥叠加(二者语义不同,决策 A 都保留)。
    // 锁序不变量(违反即死锁):owner lease → per-id lock。
    const releaseMutation = beginGhostMutation(mutationOwner);
    try {
      return {
        ghost: await withGhostInstallLock(inspected.manifest.id, () =>
          updateLocalGhostPackageLocked(
            manager,
            lizFilePath,
            inspected,
            expectedPackageSha256,
            expectedInstalledApproval,
          ),
        ),
      };
    } finally {
      releaseMutation();
    }
  });

  // 设置页「装入意识…」第一步:系统文件选择框(按 .cindy 过滤),只选不装。
  // 后续 inspect → install 由 renderer 编排；取消选择返回 { canceled: true },不算错误。
  ipcMain.handle('ghosts:pick-file', async (event) => {
    assertTrustedAppRendererEvent(event);
    const win = BrowserWindow.fromWebContents(event.sender);
    const opts = {
      filters: [{ name: 'Cindy Ghost', extensions: ['cindy'] }],
      properties: ['openFile' as const],
    };
    const picked = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (picked.canceled || picked.filePaths.length === 0) return { canceled: true };
    return { filePath: picked.filePaths[0] };
  });

  // 双击 .cindy 的待装路径:renderer 在 install-requested 信号或挂载时原子
  // 取走(取即清空),随后走与按钮/拖入完全相同的装入编排。
  ipcMain.handle('ghosts:take-pending-install', (event) => {
    assertTrustedAppRendererEvent(event);
    return { filePath: takePendingCindyInstall() };
  });

  // 只验不装:读出 .cindy 的真实清单，供兼容性判断与安装摘要使用，零副作用。
  ipcMain.handle('ghosts:inspect', async (event, lizFilePath: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof lizFilePath !== 'string' || lizFilePath.trim().length === 0) {
      throwIpcError('INVALID_PARAMS', 'lizFilePath must be a non-empty string');
    }
    const result = await manager.inspect(lizFilePath);
    if ('rejection' in result) throwInstallError(result.rejection);
    // 官方前缀在 inspect 就拒，install/update 双保险再拦。
    rejectReservedGhostId(result.manifest.id);
    rejectBrokerWithoutDeclaredRedirectPort(result.manifest);
    rejectUnauthorizedTokenBroker(result.manifest);
    return {
      manifest: result.manifest,
      trust: result.trust,
      packageSha256: result.packageSha256,
      unsupportedSlots: result.unsupportedLegacySlots,
      ...(result.iconDataUrl !== undefined ? { iconDataUrl: result.iconDataUrl } : {}),
    };
  });

  ipcMain.handle('ghosts:uninstall', async (event, id: unknown) => {
    // 卸载会停运行时、撤 receipt 批准、清凭证/KV/ghost-fs 并删安装目录 —— 与
    // install/update/set-enabled/export 同级的高权限写路径,来源判定必须由 Main
    // 按真实顶层 frame 完成,不可信任页面自报;不受信 Ghost/WebView 页面若能
    // invoke 此 channel 即可卸载任意插件(评审 P1)。
    assertTrustedAppRendererEvent(event);
    if (typeof id !== 'string' || id.trim().length === 0) {
      throwIpcError('INVALID_PARAMS', 'id must be a non-empty string');
    }
    await uninstallGhostAndCleanup(id);
    return { ok: true };
  });

  // 详情页「导出 .cindy」:把已装插件的安装目录重新打成 zip 包,经系统
  // 保存对话框写到用户选定的位置。取消选择返回 { status: 'canceled' },
  // 不算错误;导出失败抛 IPC 错误(renderer 映射 toast)。
  // 快照是一致性快照(签名包逐文件 sha256 比对 statement;未签名包
  // 第二遍重读重哈希比对),导出与更新/卸载并发也不会产出混合版本
  // 的坏包。
  ipcMain.handle('ghosts:export', async (event, id: unknown) => {
    assertTrustedAppRendererEvent(event);
    // 官方保留前缀在本地装入链路被拒,导出产物装不回——renderer 菜单
    // 只是隐藏,handler 才是真正的强制边界(评审 P1)。
    if (typeof id === 'string') rejectReservedGhostId(id);
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await exportGhostPackage(id, {
      listInstalled: () => manager.list(),
      showSaveDialog: (opts) =>
        win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts),
      getDownloadsDir: () => app.getPath('downloads'),
      fileTypeLabel: t('settings.ghosts.detail.exportFileType'),
      writeFile: (filePath, data) => fs.promises.writeFile(filePath, data),
      // 装入校验本尊 + 装入侧不变量:manager.inspect 带真实 trust
      // registry;指令查重与 tokenBroker 门控只存在于 install/update,
      // inspect 不覆盖,这里按同一口径补齐(评审 P1)。
      inspectPackage: async (filePath) => {
        const probe = await manager.inspect(filePath);
        if ('rejection' in probe) return false;
        // tokenBroker 门控(同 rejectUnauthorizedTokenBroker):官方前缀照旧;
        // 其余问已装的市场来源与当前组织身份。
        const brokered = (probe.manifest.network?.secrets ?? []).some(
          (s) => s.oauth?.tokenBroker !== undefined,
        );
        if (
          brokered &&
          !isGhostTokenBrokerAuthorized(probe.manifest.id, 'install')
        ) {
          return false;
        }
        // 指令查重(同 install/update):与当前已装撞名即拒,排除自身。
        const commandFold = probe.manifest.command?.toLowerCase();
        if (commandFold === undefined) return true;
        return !manager
          .list()
          .some(
            (g) =>
              g.manifest.id !== probe.manifest.id &&
              g.manifest.command !== undefined &&
              g.manifest.command.toLowerCase() === commandFold,
          );
      },
    });
    switch (result.status) {
      case 'saved':
        log.info('ghost exported', { id: String(id) });
        return { status: 'saved' as const, savedPath: result.savedPath };
      case 'canceled':
        return { status: 'canceled' as const };
      case 'invalid_id':
        return throwIpcError('INVALID_PARAMS', 'id must be a valid Ghost id');
      case 'not_installed':
        return throwIpcError('NOT_FOUND', `意识 ${String(id)} 未安装`);
      case 'error':
        return throwIpcError('INTERNAL', `导出插件失败(${result.code})`);
    }
  });

  // 内置意识状态(sendSync:设置页与已装清单同帧渲染,规则 7 无跳变)——
  // builtinIds 给列表分组/打"内置"标,enterpriseIds(其子集)把企业档单列
  // 一组,restorable 给"已抽离可恢复"灰态行。
  ipcMain.on('ghosts:builtin-status', (event) => {
    try {
      event.returnValue = {
        builtinIds: listBuiltinSeedIds(builtinSeedRootDirs()).filter(
          isGhostAvailableForActiveSession,
        ),
        enterpriseIds: listEnterpriseSeedIds(builtinSeedRootDirs(), log).filter(
          isGhostAvailableForActiveSession,
        ),
        restorable: listRestorableBuiltinGhosts({
          seedRootDirs: builtinSeedRootDirs(),
          repoRootDir: brainRootDir(),
          identity: currentProvisionIdentity(),
          log,
        }).filter((ghost) => isGhostAvailableForActiveSession(ghost.id)),
      };
    } catch (err) {
      // sendSync 必须回值,否则 renderer 卡死;失败降级空态(fallback data 例外,规则 13)。
      log.warn('ghosts:builtin-status failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      event.returnValue = { builtinIds: [], enterpriseIds: [], restorable: [] };
    }
  });

  // 恢复被抽离的内置意识:清墓碑 + 立即对账(串行链上排队,装回原位)。
  ipcMain.handle('ghosts:restore-builtin', async (event, id: unknown) => {
    // 恢复内置意识会清墓碑并触发对账装回,同属改写插件世界的写路径,来源判定
    // 与其它写通道对齐,不信任页面自报(评审 P1)。
    assertTrustedAppRendererEvent(event);
    if (typeof id !== 'string' || id.trim().length === 0) {
      throwIpcError('INVALID_PARAMS', 'id must be a non-empty string');
    }
    requireGhostAvailableForActiveSession(id);
    if (!listBuiltinSeedIds(builtinSeedRootDirs()).includes(id)) {
      throwIpcError('NOT_FOUND', `意识 ${id} 不是内置种子`);
    }
    const expectedOwner = captureGhostMutationOwner();
    const releaseMutation = beginGhostMutation(expectedOwner);
    try {
      clearBuiltinTombstone(brainRootDir(), id, log);
      void scheduleBuiltinReconcile('restore');
      await builtinReconcileChain; // 等本轮装完再返回,renderer 拿到结果时列表已就位
      if (!isSameAppSession(expectedOwner, getActiveAppSession())) {
        throw new Error('账号已切换，已取消本次 Plugin 操作');
      }
      return { ok: true };
    } finally {
      releaseMutation();
    }
  });

  // 启用 / 停用(停用 = 面板休眠,布局位置保留;详见 GhostManager.setEnabled)。
  ipcMain.handle('ghosts:set-enabled', async (event, id: unknown, enabled: unknown) => {
    // 启用 Node 插件会获得本机进程能力；即使按钮在 Renderer 里，来源判定也
    // 必须由 Main 按真实顶层 frame 完成，不能信任页面自报。
    assertTrustedAppRendererEvent(event);
    if (typeof id !== 'string' || id.trim().length === 0) {
      throwIpcError('INVALID_PARAMS', 'id must be a non-empty string');
    }
    requireGhostAvailableForActiveSession(id);
    if (typeof enabled !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'enabled must be a boolean');
    }
    // 同 install/update 的 owner 租约:setEnabled 先 await pathExists(旧 owner 的
    // 安装目录)再动态写 receipt —— 不持租约,这个异步窗口里切号落定会拿 A 的镜像
    // 状态改 B 的 receipt(启停同时落在两个 owner 的两半)。
    const releaseMutation = beginGhostMutation(captureGhostMutationOwner());
    try {
      if (!enabled) {
        runtime.stop(id); // 沉睡立即熄灯
        getGhostNodeRuntimeBroker().stop(id); // 随包 Node 也立即关闭
        getGhostSubscriptionGateway().dropGhost(id); // 订阅态清零(缓冲/熔断/seq)
        // 与更新/撤销路径同款:agent 工具授权与 errand 节流/在途记录不跨停用存活,
        // 重新启用后从干净状态开始。
        getGhostAgentSlot().clearGhost(id);
        getGhostErrandSlot().clearGhost(id);
        // 停用即熄灯 Library 会话:db worker 终止、handle 作废——被禁用的插件
        // 不得继续后台读写(数据本体不动,重新启用后重开)。
        await getGhostLibrarySlot().disposeGhost(id);
      }
      const result = await manager.setEnabled(id, enabled);
      if ('rejection' in result) throwUninstallError(result.rejection);
      if (enabled) {
        runtime.resetFuse(id); // 重新唤醒 = 清熔断记账,可再拉起
        const ghost = findAvailableGhost(id);
        if (ghost) spawnIfResident(ghost); // 常驻意识:唤醒即启动
        resumeGhostUnreadProjection(id); // 沉睡期间保留的那颗点回来(#1421)
        await refreshMivoLibraryExtraDirGrant().catch((error) => {
          log.warn('library extraDirs enable sync failed', {
            id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      } else {
        // 未读停止投影(记录保留):沉睡的意识没法把面板里的内容给你看,留一颗点
        // 只是噪声;但用户是"先别烦我"不是"这条我读过了",唤醒要能找回来。
        //
        // **必须在 setEnabled 成功之后**:写 `.disabled` 可能失败(目录只读 / IO
        // 错误),那时插件仍是启用态,可提前熄灭的话未读点就被错误清掉、且不会自愈
        // (要等插件再次上报或重启)。熄灯类操作(runtime/node/订阅)放在前面是既有
        // 行为且幂等,唯独这条会留下用户可见的错状态(copilot + codex review)。
        suspendGhostUnreadProjection(id);
        await refreshMivoLibraryExtraDirGrant().catch((error) => {
          log.warn('library extraDirs disable sync failed', {
            id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      return { ok: true };
    } finally {
      releaseMutation();
    }
  });

  // 运行时状态快照(面板错误接管态的首帧数据源;广播只覆盖后续变化)。
  ipcMain.handle('ghosts:runtime-states', () => ({ states: runtime.listStates() }));

  /* ── Library(持久作品库)设置面 IPC ─────────────────────────────────
   * 目录选择永远由**宿主**弹(pick 同款),插件无权发起;装入确认与设置页
   * 共用同一裁决链(原生选择器 → 候选校验 → binding/迁移)。 */
  ipcMain.handle('ghosts:library-overview', async (event, id: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof id !== 'string' || !isValidGhostId(id)) throwIpcError('INVALID_PARAMS', '非法插件 id');
    return getGhostLibraryOverview(id);
  });
  ipcMain.handle('ghosts:library-pick-location', async (event, id: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof id !== 'string' || !isValidGhostId(id)) throwIpcError('INVALID_PARAMS', '非法插件 id');
    const win = BrowserWindow.fromWebContents(event.sender);
    const picked = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false as const, cancelled: true as const };
    }
    const candidate = picked.filePaths[0];
    const validation = await validateLibraryCandidateLocation({
      candidate,
      ghostId: id,
      deps: {
        getFile: () => ownerScopedUserDataPath('libraries-binding.json'),
        getManagedRoots: () => [app.getPath('userData')],
        getDefaultRoot: (gid) => ownerScopedUserDataPath('libraries', gid),
      },
      getDiskFreeBytes: (root) => statfsFreeBytes(root),
    });
    if (!validation.ok) return { ok: false as const, cancelled: false as const, message: validation.message };
    return { ok: true as const, candidate, warnings: validation.warnings };
  });
  // 装入确认时的「更改位置」:空库(或首次启用),直接记 binding,无需迁移。
  // 持 owner 租约:binding 写的是 owner-scoped 文件,切换在途不得跨 owner。
  ipcMain.handle('ghosts:library-bind', async (event, id: unknown, candidate: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof id !== 'string' || !isValidGhostId(id) || typeof candidate !== 'string') {
      throwIpcError('INVALID_PARAMS', '参数非法');
    }
    const releaseMutation = beginGhostMutation();
    try {
      const set = await getGhostLibraryBindingStore().setBinding(id, candidate, (root) => statfsFreeBytes(root));
      if (!set.ok) return { ok: false as const, message: set.message };
      await getGhostLibrarySlot().disposeGhost(id); // 作废会话,下一请求用新根
      await refreshMivoLibraryExtraDirGrant();
      return { ok: true as const, warnings: set.warnings };
    } finally {
      releaseMutation();
    }
  });
  // 设置页「更改位置」(带数据迁移):precheck→copying→verifying→switching→grace。
  ipcMain.handle('ghosts:library-relocate', async (event, id: unknown, candidate: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof id !== 'string' || !isValidGhostId(id) || typeof candidate !== 'string') {
      throwIpcError('INVALID_PARAMS', '参数非法');
    }
    return relocateGhostLibraryTo(id, candidate);
  });
  // 撤销自定义位置:迁回系统默认并清 binding(反向同一状态机)。
  ipcMain.handle('ghosts:library-revert-default', async (event, id: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof id !== 'string' || !isValidGhostId(id)) throwIpcError('INVALID_PARAMS', '非法插件 id');
    const defaultParent = path.dirname(ownerScopedUserDataPath('libraries', id));
    try {
      await fs.promises.mkdir(defaultParent, { recursive: true });
    } catch {
      /* 校验阶段会再探 */
    }
    // 默认根在宿主数据区内:豁免受管根排斥(那道闸拦的是用户自选数据区)。
    const res = await relocateGhostLibraryTo(id, defaultParent, { allowInsideManagedRoot: true });
    if (!res.ok) return res;
    await getGhostLibraryBindingStore().removeBinding(id);
    await getGhostLibrarySlot().disposeGhost(id);
    await refreshMivoLibraryExtraDirGrant();
    return { ok: true as const };
  });
  // 漂移恢复(位置失效):解除 binding 回默认(原自定义目录数据原样保留,
  // 用户可手工找回;不自动猜测)。
  ipcMain.handle('ghosts:library-unbind', async (event, id: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof id !== 'string' || !isValidGhostId(id)) throwIpcError('INVALID_PARAMS', '非法插件 id');
    const releaseMutation = beginGhostMutation();
    try {
      await getGhostLibraryBindingStore().removeBinding(id);
      await getGhostLibrarySlot().disposeGhost(id);
      await refreshMivoLibraryExtraDirGrant();
      return { ok: true as const };
    } finally {
      releaseMutation();
    }
  });
  ipcMain.handle('ghosts:library-delete', async (event, id: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof id !== 'string' || !isValidGhostId(id)) throwIpcError('INVALID_PARAMS', '非法插件 id');
    // **唯一有效的删除确认在 Main**:preload 即使被其它 trusted renderer
    // 调用也绕不过用户点击(review:Renderer 确认可被内部调用方绕过)。文案走
    // main i18n(与 Renderer 五语同一资源),壳由系统绘制；取消不取得 mutation
    // 租约、不触碰 binding/数据。
    const parent = BrowserWindow.fromWebContents(event.sender);
    const ghostName = findAvailableGhost(id)?.manifest.name ?? id;
    const options = {
      type: 'warning' as const,
      title: t('settings.ghosts.library.deleteConfirmTitle'),
      message: t('settings.ghosts.library.deleteConfirmTitle'),
      detail: `${ghostName}\n\n${t('settings.ghosts.library.deleteConfirmDescription')}`,
      buttons: [
        t('settings.ghosts.library.deleteConfirmText'),
        t('settings.ghosts.library.cancel'),
      ],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const decision = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options);
    if (decision.response !== 0) return { ok: false as const, cancelled: true as const };
    const releaseMutation = beginGhostMutation();
    try {
      const res = await deleteGhostLibraryForActiveOwner(id);
      return res.ok
        ? { ok: true as const }
        : { ok: false as const, cancelled: false as const, message: res.message };
    } finally {
      releaseMutation();
    }
  });

  // 面板错误态的「重载意识」:清熔断记账 + 重新拉起沙箱。
  ipcMain.handle('ghosts:reload', async (event, id: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof id !== 'string' || id.trim().length === 0) {
      throwIpcError('INVALID_PARAMS', 'id must be a non-empty string');
    }
    requireGhostAvailableForActiveSession(id);
    const ghost = findAvailableGhost(id);
    if (!ghost) throwIpcError('NOT_FOUND', `未装入意识 ${id}`);
    if (!ghost.enabled) throwIpcError('INVALID_PARAMS', `意识 ${id} 处于沉睡态`);
    runtime.resetFuse(id);
    const result = await runtime.spawn(ghost);
    if (!result.ok) throwIpcError('INTERNAL', result.reason);
    return { state: result.state };
  });

  // dev-only 运行时控制通道(QA:能起 / 能停 / 能崩 / 能看状态)。
  // packaged 版不注册;正式的按需拉起 / 闲置熄灯由上层自动策略负责。
  if (!app.isPackaged) {
    ipcMain.handle(
      'ghosts:dev-runtime',
      async (event, action: unknown, id: unknown, payload: unknown) => {
        assertTrustedAppRendererEvent(event);
        if (action === 'status') return { states: runtime.listStates() };
        if (typeof id !== 'string' || id.trim().length === 0) {
          throwIpcError('INVALID_PARAMS', 'id must be a non-empty string');
        }
        switch (action) {
          case 'spawn': {
            requireGhostAvailableForActiveSession(id);
            const ghost = findAvailableGhost(id);
            if (!ghost) throwIpcError('NOT_FOUND', `未装入意识 ${id}`);
            if (!ghost.enabled) throwIpcError('INVALID_PARAMS', `意识 ${id} 处于沉睡态,先唤醒`);
            const result = await runtime.spawn(ghost);
            if (!result.ok) throwIpcError('INTERNAL', result.reason);
            return { state: result.state };
          }
          case 'stop':
            runtime.stop(id);
            return { state: runtime.stateOf(id) };
          case 'crash':
            if (!runtime.crashForTest(id)) throwIpcError('INVALID_PARAMS', `意识 ${id} 不在运行中`);
            return { state: runtime.stateOf(id) };
          case 'call': {
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
              throwIpcError('INVALID_PARAMS', 'call payload must be an object');
            }
            const request = payload as { tool?: unknown; args?: unknown };
            if (typeof request.tool !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(request.tool)) {
              throwIpcError('INVALID_PARAMS', 'tool must be a valid plugin tool name');
            }
            const args = request.args ?? {};
            if (!args || typeof args !== 'object' || Array.isArray(args)) {
              throwIpcError('INVALID_PARAMS', 'args must be an object');
            }
            let encodedArgs: string;
            try {
              encodedArgs = JSON.stringify(args);
            } catch {
              throwIpcError('INVALID_PARAMS', 'args must be JSON serializable');
            }
            if (encodedArgs.length > 256 * 1024) {
              throwIpcError('INVALID_PARAMS', 'args are too large');
            }
            requireGhostAvailableForActiveSession(id);
            return getGhostPipeDispatcher().callGhostTool({
              ghostId: id,
              tool: request.tool,
              args: args as Record<string, unknown>,
            });
          }
          default:
            throwIpcError('INVALID_PARAMS', `未知 action ${JSON.stringify(action)}`);
        }
      },
    );
  }
}

/** 面板「点图看大图」推送通道(main → 宿主窗口 renderer;GhostMediaLightboxHost 消费)。 */
export const GHOST_PREVIEW_MEDIA_CHANNEL = 'ghosts:preview-media';

let previewGateSingleton: GhostPreviewGate | null = null;

function getGhostPreviewGate(): GhostPreviewGate {
  if (!previewGateSingleton) {
    previewGateSingleton = new GhostPreviewGate({
      ghostCanRead: (hash, ghostId) => ledger.ghostCanRead(hash, ghostId),
      getBlobInfo: (hash) => ledger.getBlobInfo(hash),
      blobUrl: (hash, ext) => blobStore.blobUrl(hash, ext),
    });
  }
  return previewGateSingleton;
}

/**
 * 面板预览导航的主机侧处理(webview-security 拦下 /preview/ 导航后调用):
 * 过闸(形状/焦点/限速/归属/mime,见 previewGate.ts)→ 把主机拼装的
 * cindy-media:// 地址推给宿主窗口 renderer 弹 ImageLightbox。
 * 一切失败静默(仅 debug 日志),不给沙箱探测面。
 */
export function handleGhostPreviewNavigation(
  ghostId: string,
  url: string,
  hostContents: WebContents,
  guestContents: WebContents,
  isOwnerActive: () => boolean,
): void {
  void runGhostPreviewNavigation(
    { ghostId, url, hostContents, guestContents },
    {
      request: (request) => getGhostPreviewGate().request(request),
      isOwnerActive,
      send: (outcome) => {
        sendGhostContentsPush(hostContents, GHOST_PREVIEW_MEDIA_CHANNEL, {
          ghostId,
          src: outcome.src,
          kind: outcome.kind,
        });
      },
      logger: log,
    },
  );
}

let externalLinkGateSingleton: GhostExternalLinkGate | null = null;

function getGhostExternalLinkGate(): GhostExternalLinkGate {
  if (!externalLinkGateSingleton) {
    externalLinkGateSingleton = new GhostExternalLinkGate({
      declaredExternalUrls: (ghostId) => {
        const ghost = findAvailableGhost(ghostId);
        return ghost && ghost.enabled ? ghostExternalLinkUrls(ghost.manifest) : null;
      },
    });
  }
  return externalLinkGateSingleton;
}

/**
 * 意识 webview 外链导航的主机侧处理(webview-security 拦下 https 导航后调用):
 * 过外链闸(合法 HTTPS / 焦点 / 限速 / 声明或授信直开 / 其余确认,见
 * previewGate.ts 的 GhostExternalLinkGate)→ 转系统浏览器打开。
 * 一切失败静默(仅 debug 日志),不给沙箱探测面。
 */
export function handleGhostExternalLinkNavigation(
  ghostId: string,
  url: string,
  hostContents: WebContents,
  guestContents: WebContents,
  isOwnerActive: () => boolean,
): void {
  void runGhostExternalLinkNavigation(
    { ghostId, url, hostContents, guestContents },
    {
      gate: getGhostExternalLinkGate(),
      resolveOwner: (contents) => BrowserWindow.fromWebContents(contents),
      showMessageBox: (owner, options) => dialog.showMessageBox(owner, options),
      openExternal: (targetUrl) => shell.openExternal(targetUrl),
      translate: t,
      logger: log,
      isOwnerActive,
    },
  );
}

/**
 * 意识 webview 附加验证(webview-security 的意识分区白名单口子):
 * renderer 声明了意识分区的 <webview> 想要附加时,这里验明正身——
 * 分区 id 合法、意识已装且唤醒、src 指向它自己协议下的自绘入口白名单
 * (面板 panel.html、主视图 mainView.html 或设置区 settingsHtml，声明哪个放行哪个；白名单真身
 * 是 shared 的 ghostWebviewEntryPaths,纯函数已单测)。全过才放行,顺手
 * 把协议 handler 挂好(必须先于 webview 首次加载)。任何一条不满足返回
 * null(闸口拒附加)。
 */
export function resolveGhostWebviewAttach(
  partitionClaim: unknown,
  src: unknown,
): {
  ghost: InstalledGhost;
  partition: string;
  owner: { mode: AppSessionMode; dataOwnerId: string };
} | null {
  if (typeof src !== 'string') return null;
  const owner = getActiveAppSession();
  const resolvedPartition = resolveGhostWebviewPartitionClaim(partitionClaim, owner);
  if (!resolvedPartition) return null;
  const ghost = findAvailableGhost(resolvedPartition.ghostId);
  if (!ghost || !ghost.enabled) return null;
  const allowedPaths = ghostWebviewEntryPaths(ghost.manifest);
  if (allowedPaths.length === 0) return null;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.protocol !== `${GHOST_SCHEME}:` || url.host !== resolvedPartition.ghostId) return null;
  if (!allowedPaths.includes(url.pathname)) return null;
  ensureGhostProtocolRegistered(ghost, owner);
  return {
    ghost,
    partition: resolvedPartition.partition,
    owner: { mode: owner.mode, dataOwnerId: owner.dataOwnerId! },
  };
}

/** 播种进行中提示广播(renderer 显示/收起非阻塞胶囊;与退出 overlay 同款视觉)。 */
function broadcastGhostProvisioning(active: boolean): void {
  broadcastGhostWindowPush('ghosts:provisioning', { active });
}

/**
 * `rosterAuthoritative` = 传进来的这份清单是否来自**刚做完的完整扫描**。
 * 只影响未读孤儿扫尾:权威的空表意味着"插件真的一个都没有了",要清账本;
 * 非权威的空表(账号切换窗口里 manager 尚未重扫)必须当作"还不知道",
 * 否则会把用户的未读整批误清。缺省 false = 保守。
 */
function broadcastGhostsChanged(
  ghosts: InstalledGhost[],
  rosterAuthoritative = false,
  opts?: {
    /**
     * true = 花名册没变,只是 renderer 投影字段(OAuth 陈旧角标)需要刷新。
     * 跳过清单指纹、未读扫尾与 skill 链接对账这些只对装/卸/启停/换版有
     * 意义的花名册侧效应,OAuth 账号操作不再连带两趟全量磁盘扫描。
     */
    projectionOnly?: boolean;
  },
): void {
  if (!opts?.projectionOnly) {
    getGhostSetupManifestTracker().note(ghosts);
    sweepRevokedGhostUnread(ghosts, rosterAuthoritative);
  }
  const visible = ghosts
    .filter((ghost) => isGhostAvailableForActiveSession(ghost.manifest.id))
    .map(projectGhostForRenderer);
  broadcastGhostWindowPush('ghosts:changed', { ghosts: visible });
  // 与 renderer 同一份可见清单喂给观察者(独立窗口 controller reconcile 等);
  // 观察者异常不拖垮广播本体。
  if (ghostsChangedObserver) {
    try {
      ghostsChangedObserver(visible);
    } catch (err) {
      log.warn('ghosts-changed observer failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // skill 槽共享链接对账:装/卸/启停/换版全走本广播,一处挂接全覆盖。
  // 异步合并执行,不阻塞广播;用全量 list() 而非 per-session 过滤后的 visible
  // (链接对账关心"装了什么",与当前会话可见性无关)。
  if (!opts?.projectionOnly) scheduleGhostSkillReconcile();
}

// —— skill 槽链接对账调度:合并突发广播(in-flight + pending 双标志),
//    永不并发两趟 fs 对账;失败仅 warn,幂等设计靠下一次广播/启动自愈。
let skillReconcileInFlight = false;
let skillReconcilePending = false;
let skillReconcileRetryTimer: ReturnType<typeof setTimeout> | null = null;
const SKILL_RECONCILE_RETRY_MS = 1_000;

function scheduleGhostSkillReconcileRetry(): void {
  skillReconcilePending = true;
  if (skillReconcileRetryTimer) return;
  skillReconcileRetryTimer = setTimeout(() => {
    skillReconcileRetryTimer = null;
    scheduleGhostSkillReconcile();
  }, SKILL_RECONCILE_RETRY_MS);
  skillReconcileRetryTimer.unref?.();
}

function scheduleGhostSkillReconcile(): void {
  skillReconcilePending = true;
  if (skillReconcileInFlight) return;
  skillReconcileInFlight = true;
  void (async () => {
    try {
      while (skillReconcilePending) {
        skillReconcilePending = false;
        // 每轮 capture owner + 持租约到本轮全部校验/删/建/扇出完成:全局技能根写的是
        // owner-scoped 受管根的投影,不持租约时账号切换可以落在"A 的快照校验通过后、
        // 链接创建前",把全局 ~/.agents/skills 指向 A 的批准快照 —— B 生效后主 Agent
        // 有跨 owner 读取窗口。租约让 session teardown 的 waitForIdle 等本轮收尾;
        // 边界期开轮直接抛,pending 保留,换号完成后的 ghosts:changed 广播重跑。
        let releaseLease: (() => void) | null = null;
        try {
          const owner = captureGhostMutationOwner();
          // 已登出/无 owner 时不建全局技能投影：全局 ~/.agents/skills 中的旧链接
          // 在账号 teardown 时已由 removeGhostSkillLinksForRoots 撤销，这里空跑只会
          // 因为 ownerId 为空被 withGhostSkillProjectionReconcile 拒绝，且错误消息
          // 不命中任何重试条件导致 pending 被清掉（永久不复跑），不如直接跳过。
          if (!owner.dataOwnerId) {
            skillReconcileInFlight = false;
            return;
          }
          const result = await withGhostSkillProjectionReconcile(
            owner.dataOwnerId,
            async () => {
              releaseLease = beginGhostMutation(owner);
              return reconcileGhostSkillLinks({
                ghosts: getGhostManager().list(),
                brainRoot: brainRootDir(),
                approvalStateRoot: getGhostManager().approvalStateRoot(),
                assertOwnerStable: () => assertGhostSkillProjectionStableOwner(owner.dataOwnerId!),
                validateApprovedSkillSnapshot: (ghost) =>
                  getGhostManager().verifyApprovedSkillSnapshot(ghost),
              });
            },
          );
          if (result.warnings.length > 0) {
            log.warn('ghost skill reconcile warnings', { warnings: result.warnings });
          }
          if (result.changed) {
            log.info('ghost skill links reconciled', {
              actions: result.actions.filter((a) => a.op !== 'kept'),
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (
            isAppSessionBoundaryPending()
            || message.includes('projection is not stable')
            || message.includes('boundary lock is busy or unavailable')
          ) {
            // 账号边界期:本轮不动盘,保留 pending 等换号完成后的广播重跑。
            scheduleGhostSkillReconcileRetry();
            break;
          }
          log.warn('ghost skill reconcile failed', {
            error: message,
          });
        } finally {
          const release = releaseLease as (() => void) | null;
          release?.();
        }
      }
    } finally {
      skillReconcileInFlight = false;
    }
  })();
}

let ghostsChangedObserver: ((ghosts: InstalledGhost[]) => void) | null = null;

/**
 * bootstrap 注入:装/卸/启停/换版广播的 main 侧同步观察者(当前消费方:插件面板
 * 独立窗口 controller 的 reconcile)。保持 cindy-brain 不反向依赖窗口模块
 * (与 setGhostAgentTurnRunner 同款倒置)。
 */
export function setGhostsChangedObserver(
  observer: ((ghosts: InstalledGhost[]) => void) | null,
): void {
  ghostsChangedObserver = observer;
}

/**
 * 宿主语言切换后的插件刷新入口：重新按当前语言解析 manifest 并广播；
 * 已运行的逻辑页收到同一份 app-context 变化，可经自身 BroadcastChannel
 * 通知设置页/面板。未运行插件下次启动时直接读取最新语言。
 */
export function refreshGhostLocalization(): void {
  if (!managerSingleton) return;
  const ghosts = managerSingleton.list();
  broadcastGhostsChanged(ghosts);
  const context = currentGhostAppContext();
  for (const ghost of ghosts) {
    sendToGhostLogic(ghost.manifest.id, {
      type: 'host-context-changed',
      ...context,
    });
  }
}

/** Plugin 顶部快捷行的 host-owned MRU 快照，多窗口同步。 */
function broadcastGhostRecentUsageChanged(ids: string[]): void {
  broadcastGhostWindowPush('ghosts:recent-usage-changed', { ids });
}

/** 运行时状态广播(→ 意识面板的错误接管态:crashed / fused 原地显示)。 */
function broadcastGhostRuntimeStates(): void {
  const states = runtimeSingleton?.listStates() ?? {};
  broadcastGhostWindowPush('ghosts:runtime-changed', { states });
}
