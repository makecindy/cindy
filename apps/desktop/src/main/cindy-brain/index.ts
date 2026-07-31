import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { createLogger } from '../logger.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  type GhostAppRegion,
  CINDY_ACCOUNT_GHOST_IDS,
  GHOST_CARD_HEIGHT_DEFAULT,
  GHOST_CARD_HEIGHT_MAX,
  GHOST_CARD_HEIGHT_MIN,
  GHOST_NETWORK_MAX_CONNECTIONS_PER_DECL,
  GHOST_NOTIFY_MIN_INTERVAL_MS,
  ghostWebviewEntryPaths,
  isCindyAccountGhostId,
  isOfficialGhostId,
  isValidGhostId,
  layoutWithGhostPanel,
  type GhostHostNoticeKey,
  type GhostImageAspectRatio,
  type GhostManifest,
  type GhostSetupAllowedAction,
  type GhostSetupAssessment,
  type GhostVideoRefMode,
  type GhostVideoResultParams,
  type InstalledGhost,
} from '../../shared/ghost.js';
import { getAppCapabilities } from '../appCapabilities.js';
import {
  getActiveAppSession,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
  type ActiveAppSession,
} from '../appSessionState.js';
import { getLayoutStore } from '../layout/index.js';
import { GhostManager, type InstallRejection, type UninstallRejection } from './GhostManager.js';
import { exportGhostPackage } from './exportGhostPackage.js';
import { GhostMutationCoordinator } from './ghostMutationCoordinator.js';
import {
  clearBuiltinTombstone,
  listEligibleBuiltinCommands,
  listBuiltinSeedIds,
  listEnterpriseSeedIds,
  listRestorableBuiltinGhosts,
  provisionBuiltinGhosts,
  readBuiltinTombstones,
  recordBuiltinTombstone,
  type ProvisionIdentity,
} from './builtinGhostProvisioner.js';
import { getAccessToken, getAuthState, onAuthStateChange } from '../authManager.js';
import { serverApiFetch } from '../serverApiClient.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { createGhostOauthBrokerClient } from './ghostOauthBroker.js';
import { readRefImagesWithinBudget } from './refImageBudget.js';
import { resolveGhostRepoRoot } from './repoRoot.js';
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
  setGhostOauthHandler,
  setGhostSandboxDevToolsDisabled,
  setGhostSecretsHandler,
  setGhostWakeHandler,
} from './runtime/electronSandboxAdapter.js';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import {
  createGhostKvStore,
  removeGhostKvBestEffort,
  type GhostKvStore,
} from './ghostKvStore.js';
import {
  evaluateGhostSetupAssessment,
  handleGhostSetupStatusRequest,
} from './ghostSetupStatus.js';
import { getGhostSetupChangeBus } from './ghostSetupChangeBus.js';
import { GhostSetupManifestTracker } from './ghostSetupManifestTracker.js';
import type { GhostSetupActionResult } from './ghostSetupCoordinator.js';
import type { GhostSetupInteractionResponseTarget } from './ghostSetupInteractionBridge.js';
import { executeGhostSetupInlineSubmission } from './ghostSetupInlineExecutor.js';
import { handleGhostSecretsRequest } from './runtime/ghostSecretsEndpoint.js';
import { handleGhostOauthRequest } from './runtime/ghostOauthEndpoint.js';
import { handleGhostConnectionsRequest } from './runtime/ghostConnectionsEndpoint.js';
import { GhostOauthAccountManager, type GhostOauthDecl } from './ghostOauthAccounts.js';
import { mapGhostOauthConnectError } from './ghostOauthSetupError.js';
import { reclaimLoopbackPort } from './portReclaim.js';
import { GhostConnectionManager } from './ghostConnections.js';
import { getResolvedMainLocale, t } from '../i18n.js';
import { reconcileGhostSkillLinks } from './skillSlot.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import {
  FILO_GOOGLE_GHOST_ID,
  FILO_GOOGLE_SECRET_KEY,
  migrateFiloGoogleAccounts,
  type LegacyGoogleAccountRow,
} from './googleAccountsMigration.js';
import { withFiloGoogleBuildClientConfig } from './filoGoogleClientConfig.js';
import {
  LEGACY_JIRA_CONNECTION_FILE,
  LEGACY_JIRA_RT_FILE,
  XD_ATLASSIAN_GHOST_ID,
  XD_ATLASSIAN_SECRET_KEY,
  migrateAtlassianAccounts,
} from './atlassianAccountsMigration.js';
import {
  LEGACY_GITHUB_CONNECTION_FILE,
  LEGACY_GITHUB_TOKEN_FILE,
  CINDY_GITHUB_GHOST_ID,
  CINDY_GITHUB_SECRET_KEY,
  migrateGithubAccounts,
} from './githubAccountsMigration.js';
import {
  LEGACY_GITLAB_CONNECTION_FILE,
  LEGACY_GITLAB_TOKEN_FILE,
  CINDY_GITLAB_GHOST_ID,
  CINDY_GITLAB_CONNECTION_KEY,
  migrateGitlabAccounts,
} from './gitlabAccountsMigration.js';
import { GHOST_SCHEME, ghostExternalLinkUrls, parseGhostPartition } from '../../shared/ghost.js';
import { GhostPipeDispatcher } from './pipeDispatcher.js';
import { GhostCardService, parseCardHeightReport } from './cardService.js';
import { GhostCardActionDispatcher } from './cardActionDispatch.js';
import { GhostSessionActivityTracker } from './ghostSessionActivity.js';
import { sanitizeGhostCardHtml } from './cardSanitizer.js';
import { getGhostCard, listGhostCardsBySession, reassignGhostCards, updateGhostCardHeight, upsertGhostCard } from './cardStoreDb.js';
import { updateMessageContent } from '../localDb/ipc/messages.js';
import { runAssistantReplyHook } from './assistantReplyHook.js';
import { submitAndAwaitVideo } from '../cindy-proxy-media/video/run.js';

import { deriveCindyMediaConfig, type CindyMediaCatalogConfig } from './cindyMediaCatalog.js';
import {
  GhostCindySlot,
  type CindyVideoCapabilities,
  type CindyVideoParams,
} from './cindySlot.js';
import { GhostAgentSlot, type GhostAgentTurnRunner } from './agentSlot.js';
import { GhostErrandSlot, type GhostErrandRunner } from './errandSlot.js';
import { readGhostErrandConfig, writeGhostErrandConfig } from './errandPrefsStore.js';
import { GhostNodeRuntimeBroker } from './nodeRuntimeBroker.js';
import { GhostPickSlot } from './pickSlot.js';
import { recordGhostPickedDir } from './pickGrantsStore.js';
import { GhostPreviewSlot } from './previewSlot.js';
import { GhostWorkspaceSlot, type WorkspaceSessionService } from './workspaceSlot.js';
import type { GhostTrustRegistry } from './ghostSignature.js';
import { GhostNotifySlot, sanitizeGhostNoticeText } from './notifySlot.js';
import { GhostConfirmSlot } from './confirmSlot.js';
import {
  getGhostConfirmDialogBridge,
  initGhostConfirmDialogBridge,
} from './ghostConfirmDialogBridge.js';
import { GhostNetworkSlot } from './networkSlot.js';
import { GhostFsSlot } from './fsSlot.js';
import { getGhostGrantConfirmBridge } from './ghostGrantConfirmBridge.js';
import { getSessionFsSnapshot } from '../localDb/ipc/sessions.js';
import { getDirDepositVault, getSaveDepositVault, isPathInsideDir } from './dirDeposit.js';
import {
  GhostSubscriptionGateway,
  GhostTurnTranslator,
  createGhostSessionFocusTracker,
  isGhostEligibleSessionRow,
  type GhostScreenResult,
  type MinimalAgentEvent,
} from './subscriptionGateway.js';
import { GhostExternalLinkGate, GhostPreviewGate, resolveGhostPanelMedia } from './previewGate.js';
import {
  ghostSecretSaved,
  readGhostSecret,
  getProviderSecretStore,
  readGhostSecretTail,
  removeGhostSecret,
  removeGhostSecrets,
  storeGhostSecret,
} from '../secrets/providerSecretStore.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { projectProviderCatalogForBuildRegion } from '../maker-host/provider-access-policy.js';
import { isModelDisabled, isProviderDisabled } from '@cindy/model-providers';
import { readModelDisableOverrides } from '../maker-host/model-disable-store.js';
import { outboundFetch } from '../maker-host/outbound-fetch.js';
import { hasCodexOAuthLoginReadOnly } from '../maker-host/codex-oauth-readiness.js';
import { getUtilityModelChainProfiles } from '../utility-model/UtilityModelSelection.js';
import { utilityModelPinOptions } from '../../shared/utilityModelProfiles.js';
import {
  CINDY_CAPABILITY_KEYS,
  readGhostCindyOverrides,
  readGhostCindyInflightLimit,
  writeGhostCindyOverride,
  type CindyCapabilityKey,
} from './cindyPrefsStore.js';
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
import { getCindyProxyMediaService } from '../mcp-integrations/cindyProxyMedia.js';
import { ImageChannelRegistry, decodeImageResponse } from './imageChannelRegistry.js';
import { createGeminiImageChannel } from './geminiImageClient.js';
import { createCodexImageChannel } from './codexImageClient.js';
import { getCodexImageAuthBinding } from './codexImageAuthBinding.js';
import { createGatewayImageClient } from '../cindy-proxy-media/api/gatewayImageClient.js';
import * as blobStore from '../cindy-media/blobStore.js';
import * as ledger from '../cindy-media/ledger.js';
import { ingestMedia, supportedMime } from '../cindy-media/ingest.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';
import { recordGhostCallMedia } from './ghostMediaLedger.js';
import { MAKER_PUSH } from '../maker-ipc/channels.js';
import { ghostSetupNavigationForAction } from './ghostSetupNavigation.js';
import { assessGhostHostSetupRequirements } from './ghostHostSetupRequirements.js';
import { isModelAccessReady } from '../model-access/readiness.js';
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
  getLegacyGhostRecoveryStatus,
  hasLegacyOwnerNamespaceClaim,
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
    context: { region, locale: getResolvedMainLocale() },
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
  if (expectedOwner) {
    const currentOwner = getActiveAppSession();
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

function isSameAppSession(a: ActiveAppSession, b: ActiveAppSession): boolean {
  return a.mode === b.mode && a.dataOwnerId === b.dataOwnerId && a.generation === b.generation;
}

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
          listLegacyGhostTombstoneRoots(ownerId, app.getPath('userData')).flatMap((root) =>
            readBuiltinTombstones(root),
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
  return getLegacyGhostRecoveryStatus(
    currentLegacyGhostMigrationSession(),
    undefined,
    isAppSessionBoundaryPending(),
    { reservedCommands: reservedBuiltinCommands },
  );
}

async function retryLegacyGhostRecoveryForActiveSession(): Promise<LegacyGhostRecoveryStatus> {
  const expectedOwner = captureGhostMutationOwner();
  if (expectedOwner.mode !== 'cloud' || !expectedOwner.dataOwnerId) {
    return getLegacyGhostRecoveryStatusForActiveSession();
  }
  const initialStatus = getLegacyGhostRecoveryStatusForActiveSession();
  if (!initialStatus.canRetry) return initialStatus;

  const releaseMutation = beginGhostMutation(expectedOwner);
  try {
    const shouldAbort = (): boolean =>
      isAppSessionBoundaryPending() || !isSameAppSession(expectedOwner, getActiveAppSession());
    if (shouldAbort()) return getLegacyGhostRecoveryStatusForActiveSession();
    const authorizedStatus = getLegacyGhostRecoveryStatusForActiveSession();
    if (!authorizedStatus.canRetry) return authorizedStatus;

    const existingGhosts = getGhostManager().list();
    const existingGhostById = new Map(
      existingGhosts.map((ghost) => [ghost.manifest.id, ghost]),
    );
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
      listLegacyGhostTombstoneRoots(
        expectedOwner.dataOwnerId,
        app.getPath('userData'),
      ).flatMap((root) => readBuiltinTombstones(root)),
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
    const restoreGhostRuntimes = (
      ghost: InstalledGhost,
      stopped: StoppedActiveGhost,
    ): void => {
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
          rejectReservedIds: app.isPackaged,
        },
      );
    } catch (error) {
      if (!shouldAbort()) restartStoppedActiveGhosts();
      throw error;
    }
    if (shouldAbort()) return getLegacyGhostRecoveryStatusForActiveSession();
    if (result.moved === 0 && !result.provisioningStateMoved) {
      restartStoppedActiveGhosts();
      return getLegacyGhostRecoveryStatusForActiveSession();
    }
    if (result.moved > 0 || result.provisioningStateMoved) {
      brainRootCache = null;
      const restoredBeforeReconcile = getGhostManager().list();
      const movedGhostIds = new Set<string>();
      for (const ghost of restoredBeforeReconcile) {
        const previousDir = existingGhostDirs.get(ghost.manifest.id);
        if (
          previousDir !== undefined &&
          path.resolve(previousDir) !== path.resolve(ghost.dir)
        ) {
          movedGhostIds.add(ghost.manifest.id);
          getGhostRuntime().stop(ghost.manifest.id);
          getGhostNodeRuntimeBroker().stop(ghost.manifest.id);
        }
      }
      const builtinReconcileSucceeded =
        result.deferredReason !== 'concurrent-live-instances' &&
        await scheduleBuiltinReconcile('legacy-recovery');
      if (shouldAbort()) return getLegacyGhostRecoveryStatusForActiveSession();
      const ghosts = getGhostManager().list();
      for (const ghost of ghosts) {
        const previousDir = existingGhostDirs.get(ghost.manifest.id);
        const relocatedExistingGhost =
          movedGhostIds.has(ghost.manifest.id) ||
          (previousDir !== undefined &&
            path.resolve(previousDir) !== path.resolve(ghost.dir));
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
  return !isCindyAccountGhostId(id) || getAppCapabilities().canUseCindyAccountServices;
}

function availableGhosts(): InstalledGhost[] {
  return getGhostManager().list().filter((ghost) =>
    isGhostAvailableForActiveSession(ghost.manifest.id),
  );
}

function findAvailableGhost(id: string): InstalledGhost | null {
  if (!isGhostAvailableForActiveSession(id)) return null;
  return getGhostManager().list().find((ghost) => ghost.manifest.id === id) ?? null;
}

function requireGhostAvailableForActiveSession(id: string): void {
  if (!isGhostAvailableForActiveSession(id)) {
    throwIpcError('PERMISSION_DENIED', 'This Plugin requires a Cindy account.');
  }
}

/** Stop any account-managed sandbox before an auth/data-owner boundary switch. */
export function suspendCindyAccountGhosts(): void {
  if (!runtimeSingleton) return;
  for (const id of CINDY_ACCOUNT_GHOST_IDS) runtimeSingleton.stop(id);
}

/** Stop every sandbox before changing the active data owner. */
export function suspendAllGhosts(): void {
  runtimeSingleton?.destroyAll();
  brainRootCache = null;
}
let ipcRegistered = false;

/** 意识仓库根(userData/cindy-brain;旧 brain 目录首次解析时原地迁移)。 */
let brainRootCache: string | null = null;
function brainRootDir(): string {
  if (!brainRootCache) {
    brainRootCache = resolveGhostRepoRoot({
      userDataDir: ownerScopedUserDataPath(),
      exists: (p) => fs.existsSync(p),
      rename: (from, to) => fs.renameSync(from, to),
      log,
    });
  }
  return brainRootCache;
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
 * 内置意识对账的串行链:startup 与 auth-change 的触发共用一条 promise 链,
 * 保证任意时刻只有一个 reconcile 在跑(登录抖动 / 快速切号不并发写盘)。
 * 单次失败吞掉并 warn(下次触发重试),链永不断。
 */
let builtinReconcileChain: Promise<void> = Promise.resolve();

function scheduleBuiltinReconcile(reason: string): Promise<boolean> {
  const scheduled = builtinReconcileChain
    .catch((err) => {
      log.warn('builtin ghost activation error; reconcile chain resumed', {
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .then(async () => {
      try {
        await reconcileBuiltinGhosts(reason);
        return true;
      } catch (err) {
        log.warn('builtin ghost reconcile error', {
          reason,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
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
      id, error: err instanceof Error ? err.message : String(err),
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
        id, target, error: err instanceof Error ? err.message : String(err),
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
      fromId, toId, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 单轮对账:播种 → (有变化时)广播 + 首装停靠 + 常驻点火。 */
async function reconcileBuiltinGhosts(reason: string): Promise<void> {
  const manager = getGhostManager();
  // 改名前置:用户自主状态(墓碑=卸载过 / .disabled=停用)随改名带到新 id,
  // 不能让"明确卸载/停用过"的用户在升级后被以新 id 重新装上并点亮(播种器
  // "用户自主权豁免"支柱)。墓碑:旧 id 有 → 给新 id 记墓碑并清掉旧墓碑
  // (旧种子已不随包,旧墓碑是死数据;清掉也避免用户日后手动恢复新 id 时被
  // 本处反复重新盖墓)。停用态:抓在播种前(孤儿回收会删旧目录),装上后补。
  const renameDisabledCarry = new Map<string, boolean>();
  for (const [fromId, toId] of RENAMED_BUILTIN_GHOSTS) {
    const tombstones = readBuiltinTombstones(brainRootDir());
    if (tombstones.includes(fromId)) {
      if (!tombstones.includes(toId)) recordBuiltinTombstone(brainRootDir(), toId, log);
      clearBuiltinTombstone(brainRootDir(), fromId, log);
      log.info('builtin ghost tombstone carried over rename', { fromId, toId });
    }
    renameDisabledCarry.set(
      toId,
      fs.existsSync(path.join(brainRootDir(), fromId, '.disabled')),
    );
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
      beforeRemove: (id) => {
        getGhostRuntime().stop(id);
        getGhostNodeRuntimeBroker().stop(id);
        getGhostAgentSlot().clearGhost(id);
        getGhostErrandSlot().clearGhost(id);
      },
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
  for (const [fromId, toId] of RENAMED_BUILTIN_GHOSTS) {
    void reassignGhostCards(fromId, toId).catch((err) =>
      log.warn('ghost card reassign failed', {
        fromId, toId, error: err instanceof Error ? err.message : String(err),
      }),
    );
    migrateGhostKvOnRename(fromId, toId);
  }
  // 退役意识的存量数据清理(孤儿回收只删包不删数据;每轮幂等,见台账注释)
  for (const retiredId of RETIRED_BUILTIN_GHOSTS) {
    cleanupRetiredGhostData(retiredId);
  }
  // 改名停用态补挂:新 id 本轮首装且旧 id 此前处于停用 → 新目录补 .disabled
  // (播种首装默认启用,这里还原用户选择;放在广播/停靠之前,清单首帧即正确)。
  for (const manifest of outcome.installed) {
    if (!renameDisabledCarry.get(manifest.id)) continue;
    try {
      fs.writeFileSync(path.join(brainRootDir(), manifest.id, '.disabled'), '');
      log.info('builtin ghost disabled state carried over rename', { id: manifest.id });
    } catch (err) {
      log.warn('builtin ghost disabled carry failed', {
        id: manifest.id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (outcome.installed.length === 0 && outcome.updated.length === 0 && outcome.removed.length === 0) return;
  log.info('builtin ghost reconcile applied changes', {
    reason,
    installed: outcome.installed.map((m) => m.id),
    updated: outcome.updated.map((m) => m.id),
    removed: outcome.removed,
  });
  // 播种绕过 manager 写盘,广播由这里补上(renderer 首帧 sendSync 早于对账
  // 完成时,靠 ghosts:changed 热更新兜底,多窗口同一套通道)。
  broadcastGhostsChanged(manager.list());
  // 首装的意识停进布局树(与 installAndDock 同一套停靠逻辑;覆盖更新 id 未变,
  // 布局位置天然保留,不动树;回收不动树 —— 与 uninstall 口径一致,位置记录
  // 由布局引擎保留)。
  const store = getLayoutStore();
  for (const manifest of outcome.installed) {
    const docked = layoutWithGhostPanel(store.getLayout(), manifest);
    if (docked) {
      const applied = store.setLayout(docked);
      if ('rejection' in applied) {
        log.warn('builtin ghost panel dock rejected', { id: manifest.id, reason: applied.rejection });
      }
    }
    // 登录触发的对账装上常驻意识时,这里就是它的点火时机(启动那趟扫描早过了)。
    const ghost = manager.list().find((g) => g.manifest.id === manifest.id);
    if (ghost) spawnIfResident(ghost);
  }
}

export function getGhostManager(): GhostManager {
  if (!managerSingleton) {
    managerSingleton = new GhostManager({
      getRootDir: brainRootDir,
      onChanged: broadcastGhostsChanged,
      getLocale: getResolvedMainLocale,
      trustRegistry: loadGhostTrustRegistry(),
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

let agentSlotSingleton: GhostAgentSlot | null = null;

/** Agent 新回合槽单例：一次性点击票、后台权限与模板替换的统一守门点。 */
export function getGhostAgentSlot(): GhostAgentSlot {
  if (!agentSlotSingleton) {
    agentSlotSingleton = new GhostAgentSlot({
      getGhost: (id) => getGhostManager().list().find((g) => g.manifest.id === id) ?? null,
      log,
    });
  }
  return agentSlotSingleton;
}

/** maker-ipc 完成初始化后注入真实会话 runner；保持 cindy-brain 不反向依赖它。 */
export function setGhostAgentTurnRunner(runner: GhostAgentTurnRunner | null): void {
  getGhostAgentSlot().setRunner(runner);
}

let errandSlotSingleton: GhostErrandSlot | null = null;

/** 派活取件槽单例(agent 槽 errand 加档):资格审/频控/任务表的统一守门点。 */
export function getGhostErrandSlot(): GhostErrandSlot {
  if (!errandSlotSingleton) {
    errandSlotSingleton = new GhostErrandSlot({
      getGhost: (id) => getGhostManager().list().find((g) => g.manifest.id === id) ?? null,
      // wait 模式的署名单在途期间替管子那头的 tool-call 续命(同 cindy 槽契约)。
      holdPipeCall: (ghostId, callId, budgetMs) =>
        getGhostPipeDispatcher().holdCall(ghostId, callId, budgetMs),
      releasePipeCall: (ghostId, callId) => getGhostPipeDispatcher().releaseCall(ghostId, callId),
      log,
    });
  }
  return errandSlotSingleton;
}

/** maker-ipc 完成初始化后注入真实派活 runner;传 null 用于退出清理。 */
export function setGhostErrandRunner(runner: GhostErrandRunner | null): void {
  getGhostErrandSlot().setRunner(runner);
}

/** 插件展示名(errand 会话默认标题等宿主侧使用;未装返回 null)。 */
export function getInstalledGhostName(id: string): string | null {
  return getGhostManager().list().find((g) => g.manifest.id === id)?.manifest.name ?? null;
}

let nodeRuntimeBrokerSingleton: GhostNodeRuntimeBroker | null = null;

/** 随包 Node 工作进程单例：每个活跃插件一个进程，main.js 经主机中继调用。 */
export function getGhostNodeRuntimeBroker(): GhostNodeRuntimeBroker {
  if (!nodeRuntimeBrokerSingleton) {
    nodeRuntimeBrokerSingleton = new GhostNodeRuntimeBroker({
      getGhost: (id) => getGhostManager().list().find((g) => g.manifest.id === id) ?? null,
      readSecret: (ghostId, secretKey) => readGhostSecret(ghostId, secretKey),
      sendToGhost: (ghostId, payload) => {
        sendToGhostLogic(ghostId, payload);
      },
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
        BrowserWindow.getAllWindows().forEach((window) => {
          if (window.isDestroyed()) return;
          window.webContents.send(GHOST_SESSION_ACTIVITY_CHANNEL, { sessionId, busy });
        });
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
        return !!g && g.enabled && g.manifest.slots.includes('card');
      },
      sanitize: sanitizeGhostCardHtml,
      persist: (row) => upsertGhostCard(row),
      broadcast: (payload) => {
        BrowserWindow.getAllWindows().forEach((window) => {
          if (window.isDestroyed()) return;
          window.webContents.send(GHOST_CARD_UPDATED_CHANNEL, payload);
        });
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
      onActivityStart: (key, sessionId) =>
        getGhostSessionActivityTracker().begin(key, sessionId),
      now: () => Date.now(),
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
      onHookFused: (ghost) => {
        BrowserWindow.getAllWindows().forEach((window) => {
          if (window.isDestroyed()) return;
          window.webContents.send(GHOST_HOOK_FUSED_CHANNEL, {
            ghostId: ghost.manifest.id,
            name: ghost.manifest.name,
          });
        });
      },
      log,
    });
  }
  return subscriptionGatewaySingleton;
}

/**
 * 会话是否在订阅事件的投递范围(用户主会话:desktop/shared 来源、非 orca;
 * 行级判定见 subscriptionGateway.isGhostEligibleSessionRow)。
 * outcome 三值:eligible / ineligible(查到行且明确不合格,可终身缓存)/
 * retry(DB 未就绪、查询抛错、行还没落库——都是暂时态,调用方稍后重试;
 * 2026-07-12 实测:启动期会话接线早于 DbClient 就绪,一次性判定会把
 * 所有重连会话终身误杀)。
 */
async function isGhostEligibleSession(
  sessionId: string,
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
    if (isGhostEligibleSessionRow(row)) {
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

/**
 * 会话事件 tap 工厂(register.ts wireSessionToIpc 对每个新会话叠加一个
 * onEvent 监听):把 AgentEvent 折叠成 did-turn-* 发进网关。
 * - 只投用户主会话(desktop、非 orca;资格 DB 现查,判定期事件小缓冲回放);
 * - 自动化轮次(turnOrigin 非 user)不投——hook-control 后台会话由此天然滤除。
 */
export function createGhostSessionTap(sessionId: string): {
  handleEvent(ev: MinimalAgentEvent & { turnOrigin?: { kind?: string } }): void;
} {
  let translator: GhostTurnTranslator | null = null;
  // 资格判定**惰性化 + 可重试**:接线发生在启动重连期,DbClient 可能还没
  // 就绪——判定挪到第一个事件到达时(用户已在交互,DB 必然可用);暂时性
  // 失败(retry)不定性,下个事件再试,封顶后放弃(防怪会话反复打 DB)。
  let state: 'unknown' | 'resolving' | 'eligible' | 'ineligible' = 'unknown';
  let attempts = 0;
  const MAX_ATTEMPTS = 5;
  const pending: MinimalAgentEvent[] = [];

  const kickResolve = (): void => {
    if (state !== 'unknown') return;
    if (attempts >= MAX_ATTEMPTS) {
      state = 'ineligible';
      pending.length = 0;
      return;
    }
    state = 'resolving';
    attempts += 1;
    void isGhostEligibleSession(sessionId).then((info) => {
      if (info.outcome === 'retry') {
        state = 'unknown'; // 暂时态:留着 pending,下个事件再试
        return;
      }
      if (info.outcome === 'ineligible') {
        state = 'ineligible';
        pending.length = 0;
        return;
      }
      const gw = getGhostSubscriptionGateway();
      translator = new GhostTurnTranslator({
        sessionId,
        agent: info.agentKind ?? 'unknown',
        now: () => Date.now(),
        sink: {
          turnStart: (d) => gw.publish('turn', 'did-turn-start', d),
          turnEnd: (d) => gw.publish('turn', 'did-turn-end', d),
        },
      });
      state = 'eligible';
      log.debug('ghost session tap eligible', { sessionId, replay: pending.length });
      for (const ev of pending) translator.handleEvent(ev);
      pending.length = 0;
    });
  };

  return {
    handleEvent(ev) {
      if (ev.turnOrigin?.kind && ev.turnOrigin.kind !== 'user') return;
      if (state === 'eligible') {
        translator?.handleEvent(ev);
        return;
      }
      if (state === 'ineligible') return;
      if (pending.length < 32) pending.push({ type: ev.type, data: ev.data, source: ev.source });
      kickResolve();
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
  try {
    const hasHookGhost = availableGhosts()
      .some((g) => g.enabled && g.manifest.subscribe?.hooks?.includes('will-user-message'));
    if (!hasHookGhost) return { action: 'allow' };
    // retry(DB 未就绪)也放行:拦截是尽力而为的旁路,fail-open 不挡发送。
    if ((await isGhostEligibleSession(sessionId)).outcome !== 'eligible') return { action: 'allow' };
    return await getGhostSubscriptionGateway().screenUserMessage({ sessionId, text });
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
  BrowserWindow.getAllWindows().forEach((window) => {
    if (window.isDestroyed()) return;
    window.webContents.send(GHOST_MESSAGE_BLOCKED_CHANNEL, payload);
  });
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
  BrowserWindow.getAllWindows().forEach((window) => {
    if (window.isDestroyed()) return;
    window.webContents.send(GHOST_MESSAGE_REWRITTEN_CHANNEL, payload);
  });
}

/** 是否有启用的意识声明了 will-assistant-message(出口钩子快路径同步守卫)。 */
export function hasEnabledGhostAssistantHook(): boolean {
  return availableGhosts()
    .some((g) => g.enabled && g.manifest.subscribe?.hooks?.includes('will-assistant-message'));
}

/** 广播:AI 回复被出口钩子改写(renderer 气泡静默换文本)。 */
function broadcastGhostAssistantRewritten(payload: {
  sessionId: string;
  clientId: string;
  ghostId: string;
  ghostName: string;
  text: string;
}): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (window.isDestroyed()) return;
    window.webContents.send(GHOST_ASSISTANT_REWRITTEN_CHANNEL, payload);
  });
}

/** 广播:出口钩子后台处理中/完成的轻指示。 */
function broadcastGhostAssistantPending(sessionId: string, clientId: string, pending: boolean): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (window.isDestroyed()) return;
    window.webContents.send(GHOST_ASSISTANT_PENDING_CHANNEL, { sessionId, clientId, pending });
  });
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
): Promise<void> {
  const sanitized = sanitizeGhostCardHtml(card.html);
  if (!sanitized.ok) {
    log.warn('ghost assistant render card rejected by sanitizer', { sessionId, reason: sanitized.reason });
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
  BrowserWindow.getAllWindows().forEach((window) => {
    if (window.isDestroyed()) return;
    window.webContents.send(GHOST_CARD_UPDATED_CHANNEL, {
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
    });
  });
}

/**
 * will-assistant-message 出口钩子入口(register.ts done 边界 fire-and-forget 调)。
 * 快路径 + eligibility + 网关裁决 + 落地(rewrite/render)全在独立续跑里,绝不
 * 阻塞 turn 结束记账;真实 deps 装配在此,核心编排在 assistantReplyHook.ts。
 * clientId = 本轮 assistant 消息持久化 id(consumeLastAssistantPersistId 取得)。
 */
export function runGhostAssistantReplyHook(sessionId: string, clientId: string, text: string): void {
  void runAssistantReplyHook(
    {
      hasHook: hasEnabledGhostAssistantHook,
      isEligible: async (sid) => (await isGhostEligibleSession(sid)).outcome === 'eligible',
      screen: (sid, t) => getGhostSubscriptionGateway().screenAssistantMessage({ sessionId: sid, text: t }),
      persistRewrite: async (sid, cid, t) => {
        await updateMessageContent(sid, cid, t);
      },
      applyRenderCard: (sid, cid, cardArg) => applyGhostAssistantRenderCard(sid, cid, cardArg),
      broadcastRewritten: broadcastGhostAssistantRewritten,
      setPending: broadcastGhostAssistantPending,
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
): void {
  void (async () => {
    try {
      // 快路径:没人订 session topic 就不查 DB(纯内存判断,调用方零负担)。
      const hasSubscriber = availableGhosts()
        .some((g) => g.enabled && g.manifest.subscribe?.topics?.includes('session'));
      if (!hasSubscriber) return;
      // 投递范围与 turn 事件同口径:只投用户主会话(retry 视为不投,
      // 生命周期事件不值得重试机制)。
      const info = await isGhostEligibleSession(data.sessionId);
      if (info.outcome !== 'eligible') return;
      // switched 的调用方(renderer 路由上报)只有 sessionId,workdir 从资格
      // 查询顺手补上,与 created/archived 的载荷形状对齐。
      const payload = data.workdir === undefined && info.workdir !== undefined
        ? { ...data, workdir: info.workdir }
        : data;
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
 * 调,平台无关):去重后发 did-session-switched。连续同 id / 非会话页(null)
 * 不发;切走再切回算新切换(去重语义见 createGhostSessionFocusTracker)。
 */
const ghostSessionFocusTracker = createGhostSessionFocusTracker((sessionId) =>
  notifyGhostSessionEvent('switched', { sessionId }),
);
export function noteGhostSessionFocused(sessionId: string | null): void {
  ghostSessionFocusTracker.note(sessionId);
}

let cindySlotSingleton: GhostCindySlot | null = null;
let networkSlotSingleton: GhostNetworkSlot | null = null;
let notifySlotSingleton: GhostNotifySlot | null = null;

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
  notice: { textKey: GhostHostNoticeKey; textArgs?: Record<string, string>; tone?: 'info' | 'success' | 'warning' | 'error' },
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
  BrowserWindow.getAllWindows().forEach((window) => {
    if (window.isDestroyed()) return;
    window.webContents.send(GHOST_NOTIFY_CHANNEL, payload);
  });
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
        BrowserWindow.getAllWindows().forEach((window) => {
          if (window.isDestroyed()) return;
          window.webContents.send(GHOST_NOTIFY_CHANNEL, payload);
        });
      },
      log,
    });
  }
  return notifySlotSingleton;
}

let confirmSlotSingleton: GhostConfirmSlot | null = null;

/** 意识确认弹窗通道(main → **单个**窗口;renderer 用主机同款 ConfirmDialog 渲染)。 */
export const GHOST_CONFIRM_CHANNEL = 'ghosts:confirm-request';

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
          win.webContents.send(GHOST_CONFIRM_CHANNEL, payload);
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
        const message = t('settings.ghosts.workspace.dialogMessage').replaceAll('{{name}}', ghostName);
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
          return isPathInsideDir(fs.realpathSync.native(workdirAbs), fs.realpathSync.native(dirAbs));
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
          window.webContents.send(GHOST_PREVIEW_OPEN_CHANNEL, payload);
        });
        return windows.length > 0;
      },
      log,
    });
  }
  return previewSlotSingleton;
}

/**
 * 模型槽单例:意识借主机 AI 出图的代办窗口。
 * 生成走主机统一图片通道(art 底层客户端,与聊天画图同一条付费链路);
 * 产物落媒体总仓(blob + 账本,出生=该意识),意识只拿到指纹字符串。
 */
/**
 * 当前媒体能力配置(图像/视频同一套推导)——与会话模型列表**同一获取
 * 来源**:providers.json 运行时目录(getActiveCatalog,OSS 热更 + 内置兜底),
 * 汇总各供应商的 imageModels/imageDefaults 或 videoModels/videoDefaults
 * (今天只有 xd 网关一家有)。清单与默认/档位选型全部来自目录,主机代码零
 * 模型字面量;派生规则见 cindyMediaCatalog.ts。
 *
 * 目录里没有该类目的任何模型(极端:远端目录带了 xd 段却不带媒体清单)→
 * `{ models: [], defaults: null }` = 该能力**暂不可用**,不拿打包常量冒充
 * (与聊天侧「无可用性证明不展示」同口径)。下游如实降级:详情页那几行显示
 * 灰字而不是下拉,cindySlot 早拒而不是拿不在册的型号下单。
 */
function getCatalogMediaConfig(kind: 'image' | 'video'): CindyMediaCatalogConfig {
  try {
    // 停用过滤:用户在 设置 → 模型供应商 停用的媒体模型 / 供应商不进候选清单
    // (与对话模型的准入口径同源,见 model-disable-store)。
    const access = readModelDisableOverrides();
    const catalog = projectProviderCatalogForBuildRegion(
      getActiveCatalog(),
      CURRENT_CINDY_REGION,
    );
    return deriveCindyMediaConfig(
      catalog.providers,
      kind,
      (providerId, modelId) =>
        isProviderDisabled(access, providerId) ||
        isModelDisabled(access, providerId, modelId),
      // 执行通道凭证就绪过滤(未就绪的来源整段不进白名单,见 imageChannelRegistry
      // 头注)。图像走 registry;视频通道今天只有 xd 一家、不经 registry,但同样要求
      // 网关能力在场 —— 未登录本地模式(canUseCindyGateway=false)下 xd 的视频型号
      // 不能进清单,否则用户在本地模式钉选/点名视频型号就是"可选但必失败"
      // (2026-07 review:与图像的就绪语义对齐)。
      kind === 'image'
        ? (providerId) => getImageChannelRegistry().isProviderReady(providerId)
        : (providerId) => providerId !== 'xd' || getAppCapabilities().canUseCindyGateway,
      // 编辑就绪过滤:仅支持生成的来源(supportsEdit: false)的模型不进编辑清单,
      // 防用户把该型号钉到 image.edit 偏好后在 editImage 路径拿到确定性 400。
      kind === 'image' ? (providerId) => getImageChannelRegistry().isProviderEditReady(providerId) : undefined,
    );
  } catch (err) {
    // 目录读取异常 = 拿不到可用性证明,同「空清单」处理(不静默顶一份旧名单)。
    log.warn(`read catalog ${kind} config failed, treating capability as unavailable`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return { models: [], defaults: null };
  }
}

const getCatalogImageConfig = (): ReturnType<typeof getCatalogMediaConfig> => getCatalogMediaConfig('image');
const getCatalogVideoConfig = (): ReturnType<typeof getCatalogMediaConfig> => getCatalogMediaConfig('video');

/**
 * 派发前重查(PR #744 review 第二十轮):cindySlot 从白名单校验到实际下单之间隔着
 * 归属查账、参考图准备等长 await,期间该媒体模型 / 供应商可能被用户停用 —— 在
 * generateImage / editImage / 视频提交边界按**当前** override 重算启用候选再验一次,
 * 不在册即拒,这次付费请求不发出(与 scheduler 派发前重裁决同语义)。
 */
function assertMediaModelStillEnabled(kind: 'image' | 'video', model: string): void {
  if (!getCatalogMediaConfig(kind).models.some((m) => m.id === model)) {
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
    prompt: string;
    imageDataUris?: string[];
    /** 参考图用法(仅图生视频有);不传 = 执行器缺省的首尾帧。 */
    refMode?: GhostVideoRefMode;
  } & CindyVideoParams,
): Promise<{ buffer: Buffer; mimeType: string; videoParams: GhostVideoResultParams }> {
  const registry = getCindyProxyMediaService().backend.videoRegistry;
  if (!registry || !registry.hasAny()) {
    throw new Error('视频能力不可用:主机未配置视频通道');
  }
  // 提交紧前重查(第二十一轮):参考图 data URI 准备是 await,窗口内被停用即拒。
  assertMediaModelStillEnabled('video', params.alias);
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
    },
  };
}

/**
 * 某视频型号的画面参数支持集(cindySlot 按型号二次校验用)。registry 缺席
 * 或 alias 查无 → null,cindySlot 据此跳过按型号校验(值仍会被执行器兜底拦下)。
 */
function getGhostVideoCapabilities(model: string): CindyVideoCapabilities | null {
  try {
    const registry = getCindyProxyMediaService().backend.videoRegistry;
    if (!registry || !registry.hasAny()) return null;
    const caps = registry.resolveByAlias(model).provider.capabilities;
    return {
      durations: caps.supportedDurations,
      resolutions: caps.supportedResolutions,
      ratios: caps.supportedRatios,
      fps: caps.supportedFps,
      maxImagesByRefMode: caps.maxImagesByRefMode,
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
    // Gemini(BYO API key,generateContent wire):ready = key 已配置。停用轴
    // 派发前重查经 beforeDispatch 注入(与 xd 通道的 cindyProxyMedia beforeDispatch
    // 同语义 —— xd 的挂在网关客户端装配处,gemini 的挂在这里)。
    registry.register('gemini', createGeminiImageChannel({
      getApiKey: () => getProviderSecretStore().get('gemini'),
      // googleapis 境外端点经 outboundFetch 吃系统代理:main 的裸 fetch 不读系统
      // 代理设置,代理软件非 TUN 模式下会直连失败(xd 网关域名境内直连,不注)。
      fetchImplementation: ((url, init) => outboundFetch(url as string, init)) as typeof fetch,
      beforeDispatch: (model) => assertMediaModelStillEnabled('image', model),
    }));
    // OpenAI public Images API(BYO 平台 key):与 xd 网关同 wire,整个客户端复用,
    // 只换 baseUrl/品牌话术/凭证读取。ChatGPT/Codex 订阅走下方独立的 hosted-tool
    // 通道;目录 id 带 openai/ 前缀,public API 适配层剥前缀。
    const openaiImagesClient = createGatewayImageClient({
      getApiKey: () => getProviderSecretStore().get('openai-images'),
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
      missingKeyMessage:
        'OpenAI 图像 API key 未配置,请到「设置 → 模型供应商 → OpenAI」填入后重试',
      beforeDispatch: (model) => assertMediaModelStillEnabled('image', `openai/${model}`),
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
      beforeDispatch: (model) => assertMediaModelStillEnabled('image', model),
    });
    registry.register('openai', {
      // 用户明确配置 Platform key 时优先走确定性的 public Images API；否则复用
      // 已连接的 ChatGPT/Codex 订阅 OAuth hosted tool，不要求再付一份 API 费。
      ready: () => hasOpenaiPlatformKey() || codexImagesClient.ready(),
      generateImage: (params) =>
        hasOpenaiPlatformKey()
          ? openaiImagesClient.generateImage({
              model: stripOpenaiPrefix(params.model),
              prompt: params.prompt,
              ...(params.aspectRatio ? { size: GHOST_ASPECT_TO_GATEWAY_SIZE[params.aspectRatio] } : {}),
            })
          : codexImagesClient.generateImage(params),
      editImage: (params) =>
        hasOpenaiPlatformKey()
          ? openaiImagesClient.editImage({
              model: stripOpenaiPrefix(params.model),
              prompt: params.prompt,
              imagePaths: params.imagePaths,
              ...(params.aspectRatio ? { size: GHOST_ASPECT_TO_GATEWAY_SIZE[params.aspectRatio] } : {}),
            })
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
function resolveImageChannelForModel(model: string, operation: 'generate' | 'edit' = 'generate') {
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

export function getGhostCindySlot(): GhostCindySlot {
  if (!cindySlotSingleton) {
    cindySlotSingleton = new GhostCindySlot({
      getGhost: (id) => findAvailableGhost(id),
      // model 已在 modelSlot 按白名单校验;归属来源(providerId)按白名单条目
      // 定位,经 imageChannelRegistry 取对应执行通道(2026-07 图像多来源)。
      generateImage: async ({ prompt, model, aspectRatio }) => {
        try {
          assertMediaModelStillEnabled('image', model);
          const channel = resolveImageChannelForModel(model);
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
      editImage: async ({ prompt, model, imagePaths, aspectRatio }) => {
        try {
          assertMediaModelStillEnabled('image', model);
          const channel = resolveImageChannelForModel(model, 'edit');
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
      generateVideo: async ({ prompt, model, ...videoParams }) => {
        try {
          assertMediaModelStillEnabled('video', model);
          return await runGhostVideo({ alias: model, prompt, ...videoParams });
        } catch (err) {
          humanizeImageChannelError(err);
        }
      },
      editVideo: async ({ prompt, model, imagePaths, refMode, ...videoParams }) => {
        try {
          assertMediaModelStillEnabled('video', model);
          // 先算总量再读(闸按 refMode 分档:存量首尾帧不设闸,原样)。闸与
          // 读取绑在一个入口里,顺序是那边的结构保证、不是这里的约定;结果
          // 保序——顺序即语义:首/尾帧,或提示词里 [Image 1]… 的序号。
          const imageDataUris = await readRefImagesWithinBudget(
            imagePaths,
            readImageFileAsDataUri,
            refMode,
          );
          return await runGhostVideo({ alias: model, prompt, imageDataUris, refMode, ...videoParams });
        } catch (err) {
          humanizeImageChannelError(err);
        }
      },
      // 画面参数按型号二次校验的数据源(registry capabilities)。
      videoCapabilities: getGhostVideoCapabilities,
      getOverride: (ghostId, capability) => {
        return readGhostCindyOverrides(ghostId)[capability as CindyCapabilityKey] ?? null;
      },
      getImageConfig: getCatalogImageConfig,
      getVideoConfig: getCatalogVideoConfig,
      // 在途并发上限:用户级隐藏配置(ghost-cindy-prefs.json 的 inflightLimits),
      // 缺省 null = 不限并发;每单现读,改配置即生效。
      getInflightLimit: (ghostId) => readGhostCindyInflightLimit(ghostId),
      // 快问快答(text.oneshot):走轻量任务模型链(与会话起标题/任务摘要
      // 同一条,用户在设置里配置)。动态 import:utility-model 的传递依赖在
      // 模块顶层读 electron app 路径,静态引入会把这条链拽进所有 import 本
      // 模块的单测(hook-script-generator 同款做法)。失败面折叠成 slot 层
      // 的三档 reason;attempts 细节只进日志,不给沙箱探测面。
      oneshotText: async ({ prompt, maxTokens, timeoutMs, pinnedProfileId }) => {
        const [{ requestUtilityText }, { getMaker }] = await Promise.all([
          import('../utility-model/oneShotCandidates.js'),
          import('../maker-host/index.js'),
        ]);
        const r = await requestUtilityText(getMaker(), prompt, {
          maxTokens,
          timeoutMs,
          pinnedProfileId,
        });
        if (r.ok) {
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
      // 管子续命挂钩:同步视频代办(署名单)在途期间替 tool-call 续命,
      // 免得分钟级生成被管子 330s 基础窗口掐掉(任务后台继续烧钱、结果作废)。
      // ghostId 由派发器配对验身:冒用他人在途 callId 不能续命/收短别人的卷。
      holdPipeCall: (ghostId, callId, budgetMs) => getGhostPipeDispatcher().holdCall(ghostId, callId, budgetMs),
      releasePipeCall: (ghostId, callId) => getGhostPipeDispatcher().releaseCall(ghostId, callId),
      // 视频型号预期耗时(registry 登记值;hold 预算与异步受理返回共用)。
      // registry 缺席/型号查无 → null,cindySlot 用自己的缺省。
      videoExpectedSeconds: (model) => {
        try {
          const registry = getCindyProxyMediaService().backend.videoRegistry;
          if (!registry || !registry.hasAny()) return null;
          return registry.resolveByAlias(model).expectedSeconds;
        } catch {
          return null;
        }
      },
      resolveOwnedMedia: async (ghostId, hash) => {
        // 归属(账本)→ 落盘元数据(账本)→ 磁盘路径(指纹仓校验),
        // 任一环查无即 null;modelSlot 对外统一话术不泄露差异。
        if (!(await ledger.ghostCanRead(hash, ghostId))) return null;
        const info = await ledger.getBlobInfo(hash);
        if (!info) return null;
        try {
          return blobStore.resolveHashRef(hash, info.ext).absPath;
        } catch {
          return null;
        }
      },
      saveGhostMedia: async ({ ghostId, buffer, mimeType, label, callId }) => {
        const written = await blobStore.writeBlob({ buffer, mimeType });
        await ledger.recordBlob({
          hash: written.hash,
          ext: written.ext,
          mimeType: written.mimeType,
          bytes: written.bytes,
          isCache: false,
        });
        // 意识产物挂自己画廊 ref(出生=该意识)——面板归属校验与
        // "不被回收"同时成立;消息级引用由消息落库链路维护,
        // 配额上限由权限策略负责。
        await ledger.addRef({
          hash: written.hash,
          refKind: 'ghost-gallery',
          refId: ghostId,
          originKind: 'ghost',
          originId: ghostId,
          ...(label ? { label } : {}),
        });
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
        const r = await ingestMedia({
          buffer,
          mimeType,
          isCache: false,
          refs: [{
            refKind: 'ghost-deposit',
            refId: ghostId,
            originKind: 'user',
            ...(label ? { label } : {}),
          }],
        });
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
function getGhostOauthAccountManager(): GhostOauthAccountManager {
  if (!ghostOauthManagerSingleton) {
    ghostOauthManagerSingleton = new GhostOauthAccountManager({
      vault: {
        read: (ghostId, storageKey) => readGhostSecret(ghostId, storageKey),
        store: (ghostId, storageKey, value) => storeGhostSecret(ghostId, storageKey, value),
        remove: (ghostId, storageKey) => removeGhostSecret(ghostId, storageKey),
      },
      // 与 networkSlot 同选型:Node 侧 undici fetch(Chromium 栈的 manual redirect 给
      // opaqueredirect,守不住逐跳白名单),但经 outboundFetch 拿到系统代理 ——
      // 意识 OAuth 的 token 端点(Google / Atlassian 等)多在境外。
      fetchImpl: (url, init) => outboundFetch(url, init as RequestInit),
      openExternal: (url) => shell.openExternal(url),
      // tokenBroker 声明的意识(仅第一方,门控在装入闸与连接闸)经独立
      // oauth-broker 服务换/刷 token:serverApiFetch 自带登录 JWT 注入与
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

/**
 * Runtime-authoritative setup assessment used by ghost_list and ghost_call.
 * Unlike the legacy plugin-page projection this path is strict: storage or
 * manifest drift errors propagate and therefore block dispatch.
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
  return evaluateGhostSetupAssessment(
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
        clientConfigReady: (configId) =>
          configId === 'model-provider' && isModelAccessReady(),
      }),
    },
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
    const prefix = 'oauth_connect:secret:';
    if (!args.action.id.startsWith(prefix)) {
      return { ok: false, errorCode: 'ACTION_STALE', message: '授权动作已失效' };
    }
    const secretKey = args.action.id.slice(prefix.length);
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
      readSecret: (ghostId, secretKey) => readGhostSecret(ghostId, secretKey),
      // source:'login-email' 凭证的值来源:现读登录态(切号/登出下一单即生效)。
      getLoginEmail: () => getAuthState().user?.email ?? null,
      // 用 Node 侧 undici fetch 而非 Electron net.fetch:redirect:'manual' 在 undici
      // 下如实返回 3xx + Location,本槽据此逐跳校验白名单;Chromium 栈的 manual 会给
      // opaqueredirect(读不到 Location),无法逐跳守门。系统代理由 outboundFetch 补上
      // (意识声明的域名大量在境外,裸 undici 直连在「系统代理」模式下出不去)。
      // init 收窄:body 的 Uint8Array 在 lib.dom 的 BodyInit 泛型下对不齐,
      // 运行时 undici 原生支持,按 RequestInit 交给 fetch。
      fetchImpl: (url, init) => outboundFetch(url, init as RequestInit),
      // 媒体模式(as:'media'):字节直落总仓 + ghost-gallery 记账(出生=该
      // 意识,与 cindy 槽产物同一记账口径),走统一入库助手 ingestMedia
      // (规则 25)。mime 白名单同一来源(blobStore),槽内归一化后再判。
      isSupportedMediaMime: (mime) => supportedMime(mime),
      saveGhostMedia: async ({ ghostId, buffer, mimeType, label, callId }) => {
        const r = await ingestMedia({
          buffer,
          mimeType,
          isCache: false,
          refs: [{
            refKind: 'ghost-gallery',
            refId: ghostId,
            originKind: 'ghost',
            originId: ghostId,
            ...(label ? { label } : {}),
          }],
        });
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
      // 多连接凭证(network.connections):按在装清单逐 decl 查连接管理器——
      // 用户添加的地址并入动态白名单(hostsFor),出网时按 hostname 精确
      // 匹配注入那条连接自己的 token(tokenFor;同一 hostname 命中多个 decl
      // 时取第一个)。每单现查现读,设置页增删下一单即生效。
      connections: {
        hostsFor: (ghostId) => {
          const decls =
            findAvailableGhost(ghostId)?.manifest.network
              ?.connections ?? [];
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
          const decls =
            findAvailableGhost(ghostId)?.manifest.network
              ?.connections ?? [];
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

/**
 * 官方保留前缀守门(docs/dev-rules/plugin-security-and-authoring.md):packaged 版本上,用户装入
 * 通道(install/update/inspect 三个 IPC,即拖入/选文件/forge 转交的共同出口)
 * 对 `cindy-` 前缀 id 一律拒装——卸载内置意识后抢注同 id 的第三方包,会冒充
 * 官方身份并蹭走凭证别名(用户历史填过的机器级 key 被注入攻击者白名单域名)。
 * dev 构建豁免:内置意识(cindy-art / cindy-web-search)的开发迭代靠打包重装。
 * 官方预装(builtinGhostProvisioner)走内部安装路径,不经这些 IPC。
 */
function rejectReservedGhostId(id: string): void {
  if (!app.isPackaged) return;
  if (!isOfficialGhostId(id)) return;
  throwIpcError('GHOST_ID_RESERVED', `id "${id}" 使用了官方保留前缀(cindy- / filo- / xd-),用户通道不可装入`);
}

/**
 * tokenBroker 第一方门控·装入闸:oauth 详单声明了 tokenBroker 的意识,XDT
 * server 的授权 broker(带用户登录 JWT 的服务端资产)只对官方前缀 id 开放,
 * 第三方包声明即拒装(连接闸在 /oauth connect 端点二次兜底)。不区分
 * dev/packaged:broker 是服务端资产,dev 也不豁免。
 */
function rejectUnauthorizedTokenBroker(manifest: GhostManifest): void {
  if (isOfficialGhostId(manifest.id)) return;
  const brokered = (manifest.network?.secrets ?? []).some((s) => s.oauth?.tokenBroker !== undefined);
  if (!brokered) return;
  throwIpcError(
    'GHOST_FILE_INVALID',
    `id "${manifest.id}" 声明了 oauth.tokenBroker——XDT 授权 broker 仅第一方官方意识可用`,
  );
}

/** install 失败分类 → IPC 错误码。 */
function throwInstallError(rejection: InstallRejection): never {
  switch (rejection.code) {
    case 'source-not-found':
      throwIpcError('NOT_FOUND', rejection.reason);
    case 'file-invalid':
      throwIpcError('GHOST_FILE_INVALID', rejection.reason);
    case 'already-installed':
      throwIpcError('ALREADY_EXISTS', rejection.reason);
    case 'not-installed':
      throwIpcError('NOT_FOUND', rejection.reason);
    case 'command-conflict':
      throwIpcError('GHOST_COMMAND_CONFLICT', rejection.reason);
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
  opts?: { enable?: boolean; expectedPackageSha256?: string },
): Promise<InstalledGhost> {
  // 默认沉睡(2026-07-09 Lizi 定案):装入 ≠ 授权运行,用户在确认框显式勾选
  // "立即开启"才带电;沉睡态面板不渲染、总机不列、沙箱不拉起。
  const result = await manager.install(lizFilePath, {
    initiallyEnabled: opts?.enable ?? false,
    ...(opts?.expectedPackageSha256
      ? { expectedPackageSha256: opts.expectedPackageSha256 }
      : {}),
  });
  if ('rejection' in result) throwInstallError(result.rejection);
  // 用户手动重装同 id 的内置意识 = 重新跟随包内版本(清墓碑,播种恢复对账)。
  clearBuiltinTombstone(brainRootDir(), result.ghost.manifest.id, log);
  // 声明了面板的意识装入后立即停进布局树(树上已有 = 重装,原位复活不动树)。
  // 顺序刻意:manager.install 内已广播 ghosts:changed(renderer 先注册面板),
  // 这里再 setLayout 触发 layout:changed(pane 出现时面板组件必然已就位,规则 7)。
  const store = getLayoutStore();
  const docked = layoutWithGhostPanel(store.getLayout(), result.ghost.manifest);
  if (docked) {
    const applied = store.setLayout(docked);
    if ('rejection' in applied) {
      // 停靠失败不阻断装入(意识本体已就绪);记日志供排查。
      log.warn('ghost panel dock rejected', { id: result.ghost.manifest.id, reason: applied.rejection });
    }
  }
  // 常驻意识(launch: resident)且装入即开启:立刻拉起电子脑。
  spawnIfResident(result.ghost);
  return result.ghost;
}

/**
 * Plugin 市场专用装入入口。市场包已由 plugin-server 绑定到稳定 Plugin ID，
 * 因而允许官方保留前缀；本地文件入口仍继续走 rejectReservedGhostId。
 * tokenBroker 门控、原子换目录、布局停靠与运行时重启保持和本地安装一致。
 */
export async function installOrUpdateMarketGhostPackage(
  cindyFilePath: string,
  expected: {
    ghostId: string;
    version: string;
  },
): Promise<InstalledGhost> {
  const mutationOwner = captureGhostMutationOwner();
  let releaseMutation: (() => void) | null = null;
  try {
    const manager = getGhostManager();
    const inspected = await manager.inspect(cindyFilePath);
    if ('rejection' in inspected) throwInstallError(inspected.rejection);
    if (
      inspected.manifest.id !== expected.ghostId ||
      inspected.manifest.version !== expected.version
    ) {
      throwIpcError(
        'GHOST_FILE_INVALID',
        '下载包清单与市场 Release 不一致',
      );
    }
    requireGhostAvailableForActiveSession(expected.ghostId);
    rejectUnauthorizedTokenBroker(inspected.manifest);

    const installed = manager.list().find((ghost) => ghost.manifest.id === expected.ghostId);
    // Node 高风险条目由 renderer 装入确认卡权限清单如实展示;
    // 2026-07-24 Lizi 定案:不再有 Main 侧原生二次确认弹窗(PR #333,本处为其
    // 漏删的市场安装路径调用点,一并对齐)。
    // Hold the owner-stability lease only for the actual Ghost filesystem
    // mutation.
    releaseMutation = beginGhostMutation(mutationOwner);
    if (!installed) {
      // 2026-07-26 定案:市场首装一律装完即开(defaultInstall 与手动安装归一),
      // 用户不必再手动点一次开关。市场包走官方分发链路(服务端校验 + sha256
      // 校验下载),且确认框如实展示权限清单,确认安装即授权运行;本地 .cindy
      // 文件装入的初始启用态仍由确认框勾选决定(勾选默认开启,main 侧
      // installAndDock 缺省不启用,授权判断始终来自 UI 显式值)。
      return installAndDock(manager, cindyFilePath, { enable: true });
    }

    const runtime = getGhostRuntime();
    runtime.stop(expected.ghostId);
    getGhostNodeRuntimeBroker().stop(expected.ghostId);
    getGhostAgentSlot().clearGhost(expected.ghostId);
    getGhostErrandSlot().clearGhost(expected.ghostId);
    let result: Awaited<ReturnType<typeof manager.update>>;
    try {
      result = await manager.update(cindyFilePath);
    } catch (error) {
      spawnIfResident(installed);
      throw error;
    }
    if ('rejection' in result) {
      spawnIfResident(installed);
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
    return result.ghost;
  } finally {
    releaseMutation?.();
  }
}

type GhostUninstallLedgerCompletion = () => Promise<void>;
type GhostUninstallLedgerPreparer = (
  ghostId: string,
) => GhostUninstallLedgerCompletion | null;

let prepareGhostUninstallLedgerCompletion: GhostUninstallLedgerPreparer | null = null;

/**
 * 由 Plugin Market 在 IPC 注册期注入账本桥接，保持 cindy-brain 不反向依赖
 * 市场服务。preparer 在卸载开始前捕获 owner，返回的 completion 只在卸载成功后执行。
 */
export function setGhostUninstallLedgerPreparer(
  preparer: GhostUninstallLedgerPreparer,
): void {
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
  const releaseMutation = beginGhostMutation();
  try {
    requireGhostAvailableForActiveSession(id);
    const completeLedger =
      options?.skipMarketLedger === true
        ? null
        : (prepareGhostUninstallLedgerCompletion?.(id) ?? null);
    const manager = getGhostManager();
    const runtime = getGhostRuntime();
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
    if (listBuiltinSeedIds(builtinSeedRootDirs()).includes(id)) {
      recordBuiltinTombstone(brainRootDir(), id, log);
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
    broadcastGhostsChanged(manager.list());
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
    void getGhostNodeRuntimeBroker().startResident(ghost).catch((err) => {
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
      if (!r.ok) log.warn('resident ghost spawn failed', { id: ghost.manifest.id, reason: r.reason });
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
  const ghostInstalled = (ghostId: string): boolean =>
    findAvailableGhost(ghostId) !== null;
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
      // login-email(派生)与 oauth(主机托管授权)都没有"用户填值"这回事,
      // 不进 /secrets 收单键集(oauth 的 client 凭证走 /oauth 端点)。
      .filter((s) => s.source !== 'login-email' && s.source !== 'oauth')
      .map((s) => s.key)
      .concat(nodeSecretDecls.map((s) => s.key));
    // login-email 派生身份:GET 状态回查附 identity(= 当前登录邮箱,设置页
    // 只读展示"用的是哪个身份")。回给意识不算新增泄露面——装入确认框已
    // 披露"将使用你的登录邮箱",且注入时它自己的服务端本就可见。写/删 405。
    const identitySecretKeys = networkSecretDecls
      .filter((s) => s.source === 'login-email')
      .map((s) => s.key);
    return handleGhostSecretsRequest({
      method,
      pathname,
      readBodyText,
      userSecretKeys,
      identitySecretKeys,
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
      onChanged: (secretKey) => {
        getGhostSetupChangeBus().emit(ghostId, { source: 'oauth', ref: secretKey });
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
        const ghostName =
          findAvailableGhost(ghostId)?.manifest.name ?? ghostId;
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

  // 启动序列(必须等 app ready:registerGhostIpc 在 bootstrap 顶层(ready 前)
  // 执行,而沙箱创建(session.fromPartition / new BrowserWindow)在 ready 前会
  // 直接 throw(review P0——早点火会把该意识状态机与协议分区一起打死)):
  // 1) 内置意识播种对账:「永远以最新包为准」+ 受众(provisioning.json)。
  //    启动跑一次(authManager 已在 bootstrap 恢复持久化登录态,此刻身份可读),
  //    此后登录 / 登出 / 切账号每次变化再对账 —— 定向种子登录后装上、登出回收;
  //    'all' 种子与身份无关,登出也在。对账串行化(chain),auth 抖动不并发。
  // 2) 常驻意识开机点火:把"已唤醒 + launch: resident"的电子脑拉起(§4 懒加载
  //    的显式例外——作者声明过、装入确认框摊过牌)。刻意排在首次对账之后,新
  //    播种的常驻意识同一趟点火;后续对账装上的由 reconcile 自己点火。
  const activateGhostsAndMigrateLegacyAccounts = (): void => {
      for (const ghost of manager.list()) spawnIfResident(ghost);
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
          const migrated = migrateFiloGoogleAccounts({
            readLegacyManifest: () => {
              try {
                const raw = JSON.parse(
                  fs.readFileSync(path.join(legacyDir, 'google_accounts.json'), 'utf-8'),
                ) as { accounts?: unknown };
                if (!Array.isArray(raw.accounts)) return null;
                return { accounts: raw.accounts as LegacyGoogleAccountRow[] };
              } catch {
                return null;
              }
            },
            readLegacyRefreshToken: (accountId) => {
              try {
                if (!safeStorage.isEncryptionAvailable()) return null;
                const file = path.join(legacyDir, `google_account_refresh_token_${accountId}.enc`);
                if (!fs.existsSync(file)) return null;
                return safeStorage.decryptString(Buffer.from(fs.readFileSync(file, 'utf-8'), 'base64'));
              } catch {
                return null;
              }
            },
            vault: {
              read: (ghostId, storageKey) => readGhostSecret(ghostId, storageKey),
              store: (ghostId, storageKey, value) => storeGhostSecret(ghostId, storageKey, value),
              remove: (ghostId, storageKey) => removeGhostSecret(ghostId, storageKey),
            },
            log,
          });
          if (migrated > 0) {
            getGhostSetupChangeBus().emit(FILO_GOOGLE_GHOST_ID, {
              source: 'oauth',
              ref: FILO_GOOGLE_SECRET_KEY,
            });
          }
        } catch (err) {
          log.warn('filo-google 搬账意外失败(不阻断启动)', { err: err instanceof Error ? err.message : String(err) });
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
          const migrated = migrateAtlassianAccounts({
            readLegacyRefreshToken: () => {
              try {
                if (!safeStorage.isEncryptionAvailable()) return null;
                const file = path.join(legacyDir, LEGACY_JIRA_RT_FILE);
                if (!fs.existsSync(file)) return null;
                return safeStorage.decryptString(Buffer.from(fs.readFileSync(file, 'utf-8'), 'base64'));
              } catch {
                return null;
              }
            },
            readLegacyConnection: () => {
              try {
                const raw = JSON.parse(
                  fs.readFileSync(path.join(legacyDir, LEGACY_JIRA_CONNECTION_FILE), 'utf-8'),
                ) as { email?: unknown };
                return { email: typeof raw.email === 'string' ? raw.email : null };
              } catch {
                return null;
              }
            },
            vault: {
              read: (ghostId, storageKey) => readGhostSecret(ghostId, storageKey),
              store: (ghostId, storageKey, value) => storeGhostSecret(ghostId, storageKey, value),
              remove: (ghostId, storageKey) => removeGhostSecret(ghostId, storageKey),
            },
            log,
          });
          if (migrated > 0) {
            getGhostSetupChangeBus().emit(XD_ATLASSIAN_GHOST_ID, {
              source: 'oauth',
              ref: XD_ATLASSIAN_SECRET_KEY,
            });
          }
        } catch (err) {
          log.warn('xd-atlassian 搬账意外失败(不阻断启动)', { err: err instanceof Error ? err.message : String(err) });
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
          const migrated = migrateGithubAccounts({
            readLegacyToken: () => {
              try {
                if (!safeStorage.isEncryptionAvailable()) return null;
                const file = path.join(legacyDir, LEGACY_GITHUB_TOKEN_FILE);
                if (!fs.existsSync(file)) return null;
                return safeStorage.decryptString(Buffer.from(fs.readFileSync(file, 'utf-8'), 'base64'));
              } catch {
                return null;
              }
            },
            readLegacyConnection: () => {
              try {
                const raw = JSON.parse(
                  fs.readFileSync(path.join(legacyDir, LEGACY_GITHUB_CONNECTION_FILE), 'utf-8'),
                ) as { host?: unknown };
                return { host: typeof raw.host === 'string' ? raw.host : null };
              } catch {
                return null;
              }
            },
            vault: {
              read: (ghostId, storageKey) => readGhostSecret(ghostId, storageKey),
              store: (ghostId, storageKey, value) => storeGhostSecret(ghostId, storageKey, value),
            },
            log,
          });
          if (migrated > 0) {
            getGhostSetupChangeBus().emit(CINDY_GITHUB_GHOST_ID, {
              source: 'secret',
              ref: CINDY_GITHUB_SECRET_KEY,
            });
          }
        } catch (err) {
          log.warn('cindy-github 搬账意外失败(不阻断启动)', { err: err instanceof Error ? err.message : String(err) });
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
          const migrated = migrateGitlabAccounts({
            readLegacyToken: () => {
              try {
                if (!safeStorage.isEncryptionAvailable()) return null;
                const file = path.join(legacyDir, LEGACY_GITLAB_TOKEN_FILE);
                if (!fs.existsSync(file)) return null;
                return safeStorage.decryptString(Buffer.from(fs.readFileSync(file, 'utf-8'), 'base64'));
              } catch {
                return null;
              }
            },
            legacyTokenExists: () => {
              try {
                return fs.existsSync(path.join(legacyDir, LEGACY_GITLAB_TOKEN_FILE));
              } catch {
                return false;
              }
            },
            readLegacyConnection: () => {
              try {
                const raw = JSON.parse(
                  fs.readFileSync(path.join(legacyDir, LEGACY_GITLAB_CONNECTION_FILE), 'utf-8'),
                ) as { baseUrl?: unknown; username?: unknown };
                return {
                  baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : null,
                  username: typeof raw.username === 'string' ? raw.username : null,
                };
              } catch {
                return null;
              }
            },
            manager: getGhostConnectionManager(),
            log,
          });
          if (migrated > 0) {
            getGhostSetupChangeBus().emit(CINDY_GITLAB_GHOST_ID, {
              source: 'connection',
              ref: CINDY_GITLAB_CONNECTION_KEY,
            });
          }
        } catch (err) {
          log.warn('cindy-gitlab 搬账意外失败(不阻断启动)', { err: err instanceof Error ? err.message : String(err) });
        }
      }
  };

  void app.whenReady().then(() => {
    void scheduleBuiltinReconcile('startup');
    builtinReconcileChain = builtinReconcileChain.then(
      activateGhostsAndMigrateLegacyAccounts,
    );
    onAuthStateChange(() => {
      if (!getAppCapabilities().canUseCindyAccountServices) suspendCindyAccountGhosts();
      // Even when provisioning itself is a no-op, the renderer and agent
      // roster must immediately reflect the new session capability set.
      broadcastGhostsChanged(manager.list());
      void scheduleBuiltinReconcile('auth-change');
      builtinReconcileChain = builtinReconcileChain.then(
        activateGhostsAndMigrateLegacyAccounts,
      );
    });
  });

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
      if (!outcome.accepted) log.warn('ghost tool-progress rejected', { id, reason: outcome.reason });
      return { ok: true };
    }
    // host-request = 读取宿主公开上下文;不要求卡槽,只返回构建 region,
    // 不含登录态/路径/设备信息。未知 kind 明确拒绝,避免接口悄悄扩面。
    if (type === 'host-request') {
      const kind = (payload as { kind?: unknown } | null)?.kind;
      if (kind === 'app-context') return currentGhostAppContext();
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
    // preview-request = 右侧栏开预览标签(preview 槽):URL 必须命中身份卡
    // preview.hosts 白名单;守门/限速在 previewSlot,落地在 renderer。
    if (type === 'preview-request') {
      return getGhostPreviewSlot().handleRequest(id, payload);
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
    if (!p || typeof p.requestId !== 'string' || p.requestId.length === 0 || p.requestId.length > 128) {
      throwIpcError('INVALID_PARAMS', 'requestId must be a non-empty string');
    }
    const bridge = getGhostConfirmDialogBridge();
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
  ipcMain.on('ghosts:session-focused', (_event, sessionId: unknown) => {
    noteGhostSessionFocused(typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null);
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
  ipcMain.handle('ghosts:card:action', async (event, callId: unknown, actionId: unknown, prompt?: unknown) => {
    assertTrustedAppRendererEvent(event);
    const r = await getGhostCardActionDispatcher().dispatch(callId, actionId, prompt);
    return { ok: r.ok };
  });

  ipcMain.on('ghosts:list', (event) => {
    event.returnValue = { ghosts: availableGhosts() };
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
    const overrides = typeof ghostId === 'string' ? readGhostCindyOverrides(ghostId) : {};
    // 每类目一份 options + defaultModel(当前包含 image/video 两类;下拉按
    // 能力键的类目取对应清单)。defaultModel:目录默认选型的展示信息
    // ("默认(GPT Image 2)"),让用户看得见"跟随"当下跟的是谁;
    // null = 目录没有该类目的模型(能力暂不可用),渲染层据此显示灰字而非下拉。
    const byKind = (cfg: CindyMediaCatalogConfig) => {
      const standard = cfg.defaults?.standard;
      return {
        options: cfg.models,
        defaultModel:
          standard === undefined ? null : (cfg.models.find((m) => m.id === standard) ?? null),
      };
    };
    // 文本类(快问快答)的可选项不来自媒体目录,而是轻量任务模型链的档位表
    // ——每一项就是一组供应商×模型。defaultModel = 当前"跟随默认"实际会用的
    // 那一档(链首),让用户看得见跟的是谁。
    const textChain = getUtilityModelChainProfiles();
    const textOptions = utilityModelPinOptions();
    const textDefaultId = textChain[0]?.id ?? null;
    event.returnValue = {
      overrides,
      image: byKind(getCatalogImageConfig()),
      video: byKind(getCatalogVideoConfig()),
      text: {
        options: textOptions,
        defaultModel:
          textDefaultId === null ? null : (textOptions.find((o) => o.id === textDefaultId) ?? null),
      },
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
  ipcMain.handle('ghosts:workdir-prefs:set', (_event, workdir: unknown, ghostId: unknown, disabled: unknown) => {
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
  });

  ipcMain.handle('ghosts:cindy-prefs:set', (_event, ghostId: unknown, capability: unknown, model: unknown) => {
    if (typeof ghostId !== 'string' || ghostId.trim().length === 0) {
      throwIpcError('INVALID_PARAMS', 'ghostId must be a non-empty string');
    }
    if (!(CINDY_CAPABILITY_KEYS as readonly string[]).includes(capability as string)) {
      throwIpcError('INVALID_PARAMS', `unknown capability: ${String(capability)}`);
    }
    // 白名单按能力键类目取(video.* 钉的是视频清单里的 alias)。
    const cfg = (capability as string).startsWith('video.') ? getCatalogVideoConfig() : getCatalogImageConfig();
    const isEditCap = capability === 'image.edit';
    if (model !== null && !cfg.models.some((m) => m.id === model && (!isEditCap || m.supportsEdit))) {
      throwIpcError('INVALID_PARAMS', 'model must be null or a catalog model of the capability category');
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
  });

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
    if (typeof lizFilePath !== 'string' || lizFilePath.trim().length === 0) {
      throwIpcError('INVALID_PARAMS', 'lizFilePath must be a non-empty string');
    }
    const installOpts = opts as
      | { enable?: unknown; expectedPackageSha256?: unknown }
      | undefined;
    if (
      typeof installOpts?.expectedPackageSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(installOpts.expectedPackageSha256)
    ) {
      throwIpcError('INVALID_PARAMS', 'expectedPackageSha256 must come from ghosts:inspect');
    }
    const probe = await manager.inspect(lizFilePath);
    if ('rejection' in probe) throwInstallError(probe.rejection);
    if (probe.packageSha256 !== installOpts.expectedPackageSha256) {
      throwIpcError('GHOST_FILE_INVALID', '插件文件在确认后发生了变化，请重新选择并确认');
    }
    rejectReservedGhostId(probe.manifest.id);
    rejectUnauthorizedTokenBroker(probe.manifest);
    // Node 高风险提示在 renderer 装入确认卡的权限清单里如实展示;
    // 2026-07-24 Lizi 定案:不再追加 Main 原生二次确认弹窗。
    const enable = installOpts.enable === true;
    return {
      ghost: await installAndDock(manager, lizFilePath, {
        enable,
        expectedPackageSha256: installOpts.expectedPackageSha256,
      }),
    };
  });

  // 原位更新(同 id 换版):先熄灯沙箱(新代码由下一次派活/面板重挂拉起),
  // 再换目录;唤醒状态与布局位置由 manager.update 保证延续。更新后走一次
  // 停靠(新版本首次声明面板时补位;已停靠则不动树)。
  ipcMain.handle('ghosts:update', async (event, lizFilePath: unknown, opts: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof lizFilePath !== 'string' || lizFilePath.trim().length === 0) {
      throwIpcError('INVALID_PARAMS', 'lizFilePath must be a non-empty string');
    }
    const expectedPackageSha256 = (opts as { expectedPackageSha256?: unknown } | undefined)
      ?.expectedPackageSha256;
    if (
      typeof expectedPackageSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(expectedPackageSha256)
    ) {
      throwIpcError('INVALID_PARAMS', 'expectedPackageSha256 must come from ghosts:inspect');
    }
    const inspected = await manager.inspect(lizFilePath);
    if ('rejection' in inspected) throwInstallError(inspected.rejection);
    if (inspected.packageSha256 !== expectedPackageSha256) {
      throwIpcError('GHOST_FILE_INVALID', '插件文件在确认后发生了变化，请重新选择并确认');
    }
    rejectReservedGhostId(inspected.manifest.id);
    rejectUnauthorizedTokenBroker(inspected.manifest);
    const previousGhost = manager.list().find((g) => g.manifest.id === inspected.manifest.id);
    runtime.stop(inspected.manifest.id);
    getGhostNodeRuntimeBroker().stop(inspected.manifest.id);
    getGhostAgentSlot().clearGhost(inspected.manifest.id);
    getGhostErrandSlot().clearGhost(inspected.manifest.id);
    let result: Awaited<ReturnType<typeof manager.update>>;
    try {
      result = await manager.update(lizFilePath, { expectedPackageSha256 });
    } catch (err) {
      // 更新失败:恢复旧版本的常驻 Node 工作进程(如果是 resident 且已启用)
      if (previousGhost) spawnIfResident(previousGhost);
      throw err;
    }
    if ('rejection' in result) {
      if (previousGhost) spawnIfResident(previousGhost);
      throwInstallError(result.rejection);
    }
    runtime.resetFuse(inspected.manifest.id); // 换了代码,给新版本干净的熔断记账
    const store = getLayoutStore();
    const docked = layoutWithGhostPanel(store.getLayout(), result.ghost.manifest);
    if (docked) {
      const applied = store.setLayout(docked);
      if ('rejection' in applied) {
        log.warn('ghost panel dock rejected', { id: result.ghost.manifest.id, reason: applied.rejection });
      }
    }
    spawnIfResident(result.ghost); // 常驻意识:换完代码立即用新版本点火
    return { ghost: result.ghost };
  });

  // 设置页「装入意识…」第一步:系统文件选择框(按 .cindy 过滤),只选不装。
  // 后续 inspect → 确认弹窗 → install 由 renderer 编排(三个装入入口共用
  // "先验明正身再确认"的契约)。取消选择返回 { canceled: true },不算错误。
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
  // 取走(取即清空),随后走与按钮/拖入完全相同的确认装入编排。
  ipcMain.handle('ghosts:take-pending-install', (event) => {
    assertTrustedAppRendererEvent(event);
    return { filePath: takePendingCindyInstall() };
  });

  // 只验不装:读出 .cindy 的清单给确认弹窗展示,零副作用。
  ipcMain.handle('ghosts:inspect', async (event, lizFilePath: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof lizFilePath !== 'string' || lizFilePath.trim().length === 0) {
      throwIpcError('INVALID_PARAMS', 'lizFilePath must be a non-empty string');
    }
    const result = await manager.inspect(lizFilePath);
    if ('rejection' in result) throwInstallError(result.rejection);
    // 官方前缀在 inspect 就拒(确认弹窗都不该弹出来),install/update 双保险再拦。
    rejectReservedGhostId(result.manifest.id);
    rejectUnauthorizedTokenBroker(result.manifest);
    return result;
  });

  ipcMain.handle('ghosts:uninstall', async (_event, id: unknown) => {
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
        // tokenBroker 门控(同 rejectUnauthorizedTokenBroker):第三方包
        // 声明即不可装入,官方前缀豁免。
        const brokered = (probe.manifest.network?.secrets ?? []).some(
          (s) => s.oauth?.tokenBroker !== undefined,
        );
        if (brokered && !isOfficialGhostId(probe.manifest.id)) return false;
        // 指令查重(同 install/update):与当前已装撞名即拒,排除自身。
        const commandFold = probe.manifest.command?.toLowerCase();
        if (commandFold === undefined) return true;
        return !manager.list().some(
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
      log.warn('ghosts:builtin-status failed', { error: err instanceof Error ? err.message : String(err) });
      event.returnValue = { builtinIds: [], enterpriseIds: [], restorable: [] };
    }
  });

  // 恢复被抽离的内置意识:清墓碑 + 立即对账(串行链上排队,装回原位)。
  ipcMain.handle('ghosts:restore-builtin', async (_event, id: unknown) => {
    if (typeof id !== 'string' || id.trim().length === 0) {
      throwIpcError('INVALID_PARAMS', 'id must be a non-empty string');
    }
    requireGhostAvailableForActiveSession(id);
    if (!listBuiltinSeedIds(builtinSeedRootDirs()).includes(id)) {
      throwIpcError('NOT_FOUND', `意识 ${id} 不是内置种子`);
    }
    clearBuiltinTombstone(brainRootDir(), id, log);
    void scheduleBuiltinReconcile('restore');
    await builtinReconcileChain; // 等本轮装完再返回,renderer 拿到结果时列表已就位
    return { ok: true };
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
    if (!enabled) {
      runtime.stop(id); // 沉睡立即熄灯
      getGhostNodeRuntimeBroker().stop(id); // 随包 Node 也立即关闭
      getGhostSubscriptionGateway().dropGhost(id); // 订阅态清零(缓冲/熔断/seq)
    }
    const result = await manager.setEnabled(id, enabled);
    if ('rejection' in result) throwUninstallError(result.rejection);
    if (enabled) {
      runtime.resetFuse(id); // 重新唤醒 = 清熔断记账,可再拉起
      const ghost = findAvailableGhost(id);
      if (ghost) spawnIfResident(ghost); // 常驻意识:唤醒即启动
    }
    return { ok: true };
  });

  // 运行时状态快照(面板错误接管态的首帧数据源;广播只覆盖后续变化)。
  ipcMain.handle('ghosts:runtime-states', () => ({ states: runtime.listStates() }));

  // 面板错误态的「重载意识」:清熔断记账 + 重新拉起沙箱。
  ipcMain.handle('ghosts:reload', async (_event, id: unknown) => {
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
    ipcMain.handle('ghosts:dev-runtime', async (_event, action: unknown, id: unknown) => {
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
        default:
          throwIpcError('INVALID_PARAMS', `未知 action ${JSON.stringify(action)}`);
      }
    });
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
): void {
  void getGhostPreviewGate()
    .request({
      ghostId,
      url,
      isPanelFocused: () => !guestContents.isDestroyed() && guestContents.isFocused(),
    })
    .then((outcome) => {
      if (!outcome.ok) {
        log.debug('ghost preview rejected', { ghostId, reason: outcome.reason });
        return;
      }
      if (hostContents.isDestroyed()) return;
      hostContents.send(GHOST_PREVIEW_MEDIA_CHANNEL, { ghostId, src: outcome.src, kind: outcome.kind });
    })
    .catch((err) => {
      log.warn('ghost preview failed', {
        ghostId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

let externalLinkGateSingleton: GhostExternalLinkGate | null = null;

function getGhostExternalLinkGate(): GhostExternalLinkGate {
  if (!externalLinkGateSingleton) {
    externalLinkGateSingleton = new GhostExternalLinkGate({
      declaredExternalUrls: (ghostId) => {
        const ghost = findAvailableGhost(ghostId);
        return ghost && ghost.enabled ? ghostExternalLinkUrls(ghost.manifest) : [];
      },
    });
  }
  return externalLinkGateSingleton;
}

/**
 * 意识 webview 外链导航的主机侧处理(webview-security 拦下 https 导航后调用):
 * 过外链闸(身份卡声明白名单/焦点/限速,见 previewGate.ts 的
 * GhostExternalLinkGate)→ 转系统浏览器打开(shell.openExternal)。
 * 一切失败静默(仅 debug 日志),不给沙箱探测面。
 */
export function handleGhostExternalLinkNavigation(
  ghostId: string,
  url: string,
  guestContents: WebContents,
): void {
  const outcome = getGhostExternalLinkGate().request({
    ghostId,
    url,
    isPanelFocused: () => !guestContents.isDestroyed() && guestContents.isFocused(),
  });
  if (!outcome.ok) {
    log.debug('ghost external link rejected', { ghostId, reason: outcome.reason });
    return;
  }
  void shell.openExternal(outcome.url).catch((err) => {
    log.warn('ghost external link open failed', {
      ghostId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * 意识 webview 附加验证(webview-security 的意识分区白名单口子):
 * renderer 声明了意识分区的 <webview> 想要附加时,这里验明正身——
 * 分区 id 合法、意识已装且唤醒、src 指向它自己协议下的自绘入口白名单
 * (面板 panel.html 或设置区 settingsHtml,声明哪个放行哪个;白名单真身
 * 是 shared 的 ghostWebviewEntryPaths,纯函数已单测)。全过才放行,顺手
 * 把协议 handler 挂好(必须先于 webview 首次加载)。任何一条不满足返回
 * null(闸口拒附加)。
 */
export function resolveGhostWebviewAttach(partition: unknown, src: unknown): InstalledGhost | null {
  const id = parseGhostPartition(partition);
  if (!id || typeof src !== 'string') return null;
  const ghost = findAvailableGhost(id);
  if (!ghost || !ghost.enabled) return null;
  const allowedPaths = ghostWebviewEntryPaths(ghost.manifest);
  if (allowedPaths.length === 0) return null;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.protocol !== `${GHOST_SCHEME}:` || url.host !== id) return null;
  if (!allowedPaths.includes(url.pathname)) return null;
  ensureGhostProtocolRegistered(ghost);
  return ghost;
}

/** 播种进行中提示广播(renderer 显示/收起非阻塞胶囊;与退出 overlay 同款视觉)。 */
function broadcastGhostProvisioning(active: boolean): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (window.isDestroyed()) return;
    window.webContents.send('ghosts:provisioning', { active });
  });
}

function broadcastGhostsChanged(ghosts: InstalledGhost[]): void {
  getGhostSetupManifestTracker().note(ghosts);
  const visible = ghosts.filter((ghost) => isGhostAvailableForActiveSession(ghost.manifest.id));
  BrowserWindow.getAllWindows().forEach((window) => {
    if (window.isDestroyed()) return;
    window.webContents.send('ghosts:changed', { ghosts: visible });
  });
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
  scheduleGhostSkillReconcile();
}

// —— skill 槽链接对账调度:合并突发广播(in-flight + pending 双标志),
//    永不并发两趟 fs 对账;失败仅 warn,幂等设计靠下一次广播/启动自愈。
let skillReconcileInFlight = false;
let skillReconcilePending = false;
function scheduleGhostSkillReconcile(): void {
  skillReconcilePending = true;
  if (skillReconcileInFlight) return;
  skillReconcileInFlight = true;
  void (async () => {
    try {
      while (skillReconcilePending) {
        skillReconcilePending = false;
        try {
          const result = await reconcileGhostSkillLinks({
            ghosts: getGhostManager().list(),
            brainRoot: brainRootDir(),
          });
          if (result.warnings.length > 0) {
            log.warn('ghost skill reconcile warnings', { warnings: result.warnings });
          }
          if (result.changed) {
            log.info('ghost skill links reconciled', {
              actions: result.actions.filter((a) => a.op !== 'kept'),
            });
          }
        } catch (err) {
          log.warn('ghost skill reconcile failed', {
            error: err instanceof Error ? err.message : String(err),
          });
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
  BrowserWindow.getAllWindows().forEach((window) => {
    if (window.isDestroyed()) return;
    window.webContents.send('ghosts:recent-usage-changed', { ids });
  });
}

/** 运行时状态广播(→ 意识面板的错误接管态:crashed / fused 原地显示)。 */
function broadcastGhostRuntimeStates(): void {
  const states = runtimeSingleton?.listStates() ?? {};
  BrowserWindow.getAllWindows().forEach((window) => {
    if (window.isDestroyed()) return;
    window.webContents.send('ghosts:runtime-changed', { states });
  });
}
