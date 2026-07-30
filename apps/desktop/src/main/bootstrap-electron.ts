import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  Tray,
} from 'electron';
import { resolveVibrancyConfig } from './vibrancyConfig';
import { applyVibrancyToSecondaryWindows } from './secondary-windows';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { machineIdSync } from 'node-machine-id';
import windowStateKeeper from 'electron-window-state';
import { BRAND_NAME } from '@cindy/maker-shared/branding';
import {
  shouldRequestSingleInstanceLock,
  resolveSingleInstanceLockUserDataDir,
} from './devCliFlags.js';
import {
  recordDesktopDevAuthStartupResult,
  markDesktopDevStartupFailed,
  markDesktopDevWindowReady,
} from './devStartupStatus';
import { prewarmMacComputerPermissionGuideHelper } from './computer-permission-guide/MacComputerPermissionGuideNativeHost.js';

const PROCESS_STARTED_AT_MS = Date.now();
// Official Linux binaries total hundreds of MB. Keep one shared deadline for
// both downloads, but allow normal consumer connections to finish while the
// splash displays real byte progress.
const LINUX_AGENT_INSTALL_STARTUP_DEADLINE_MS = 5 * 60_000;

if (
  process.platform === 'linux' &&
  !app.isPackaged &&
  process.env.XDT_DEV_SAFE_STORAGE_BASIC === '1'
) {
  app.commandLine.appendSwitch('password-store', 'basic');
  safeStorage.setUsePlainTextEncryption(true);
}

// TapTap Maker 等站点的 WASM 多线程引擎依赖 SharedArrayBuffer。Chromium 把 SAB 锁在
// crossOriginIsolated(COOP/COEP 响应头)之后,而 Electron 不实现 COOP 进程隔离——
// 即便站点响应头正确,BrowserWindow / `<webview>` 里 crossOriginIsolated 恒为 false,
// SAB 拿不到,RSB 内置浏览器里这类站点直接报"缺少运行时支持"(Electron 41.2.0 实测,
// 真 Chrome 同页面为 true)。这里用 Chromium 官方 feature 开关无条件恢复 SAB 构造器,
// TapTap Maker 桌面端(xdt-maker.exe)、VS Code 同款做法。风险面是向所有网页内容放开
// 高精度共享内存计时器(Spectre 类),缓解依赖远程内容只跑在 webview-security.ts 强制
// 加固的 webview 里(sandbox + webSecurity + 隔离分区,无 Node)。注意 appendSwitch
// 同 key 后写覆盖前写:如需再加其他
// enable-features,必须合并进同一次调用的逗号分隔值,不能另起一行。
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

// agentManager 已在 vendor 大扫除时退役。app 退出 / 崩溃路径走 maker.shutdown()
// 一刀切 — 它内部按 (Layer 1) 关所有 session → (Layer 2) dispose 所有 agent (Codex
// shared app-server 子进程 SIGTERM, Claude no-op) 的固定顺序跑, 调用方不需要分两步。
//
// **必须 await**: m.shutdown() 内部的 kill 是异步串行的 — Layer 1 先 await 所有
// session.close(), Layer 2 才在串行 dispose 里调 AppServerClient.close() 发 SIGTERM。
// 如果在 sync 阶段 fire-and-forget, app.exit(0) 会在 kill 之前就把 Node 主进程掐掉,
// Windows 上 codex app-server 子进程不会随父死 → 残留孤儿, 持有 binary 文件锁,
// 用户下次启动时撞 EBUSY / 端口占用 (anthropic-compat-proxy 等)。
async function shutdownMaker(): Promise<void> {
  // 退出前先把 onClose 重副作用(worktree stash/删除、临时附件清理)一刀切抑制掉:
  // shutdown 触发的批量 onClose 是 fire-and-forget 的,不会被 await,worktree 回收会
  // 和 app.exit 竞争——可能 stash 了一半进程就没了,留下半拆的 worktree。退出期不做
  // 任何回收,worktree 原样留在磁盘,下次启动 recoverPool 对账(clean ephemeral 重新
  // 入池,dirty / 交互式的保留,session 重开可无缝续用)。
  rehydrateCloseSuppression.suppressAllForShutdown();
  try {
    await shutdownLspServerPool();
  } catch (err) {
    console.error('[main] lspPool.shutdown failed:', err);
  }
  try {
    // splash 失败时 maker 未 init / getMakerCore() 抛错 —— 静默兜底, 没东西要清。
    const m = getMakerCore();
    await m.shutdown();
  } catch (err) {
    // maker 未就绪 (getMakerCore 抛) 或 shutdown 自身抛 —— 都不能阻断退出。
    // 注意: getMakerCore 未就绪时抛的是 sync error, await m.shutdown() 也走这里。
    console.error('[main] maker.shutdown failed (or not ready):', err);
  }
  WorktreePool.parkAll();
}

function readGitText(args: string[]): string | null {
  try {
    const value = execFileSync('git', args, {
      cwd: app.getAppPath(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return value || null;
  } catch {
    return null;
  }
}

interface AppDisplayVersionInfo {
  display: string;
  detail: string;
}

function getAppDisplayVersionInfo(): AppDisplayVersionInfo {
  const version = app.getVersion();
  if (app.isPackaged) {
    return {
      display: version,
      detail: version,
    };
  }

  const branch = readGitText(['branch', '--show-current']);
  const sha = readGitText(['rev-parse', '--short=7', 'HEAD']);
  const current = branch && sha ? `${branch}@${sha}` : sha;
  const display = current ? `${version} · ${current}` : version;

  return {
    display,
    detail: display,
  };
}

import {
  initUpdateService,
  getUpdateLockPath,
  notifyUpdateAutoRelaunchBusyStateChanged,
  setUpdateAutoRelaunchBusyProbe,
} from './updateService';
import {
  createUpdatePresentationRecoveryController,
  decideUpdateRelaunchBusyTransition,
  hasUpdateRelaunchBusyActivity,
  isMacOSUpdateRelaunch,
  readUpdateRelaunchScheduleBusy,
} from './updateRelaunchSafety';
import {
  prepare as binaryPrepare,
  peekNeedsDownload as binaryPeekNeedsDownload,
  broadcastResetForStep2 as binaryBroadcastResetForStep2,
  type PrepareResult,
} from './agent-binaries';
import { RendererBootGuard } from './renderer-boot-guard';
import yaml from 'js-yaml';
import matter from 'gray-matter';
import type { Maker } from '@cindy/maker-core';
import { im, feishuIm, registerTelegramBotConfigIpc, startImOrchestrators, startImConnection, stopImConnection } from './im';
import * as authManager from './authManager';
import { hasPersistedSessionHint } from './authSessionHint';
import { createAccountDeletionIpcHandlers } from './accountDeletionIpc';
import * as profileEdit from './profileEdit';
import { uploadPublicAsset } from './ossPublicUpload';
import { removeRefs as removeMediaRefs } from './cindy-media/ledger';
import {
  installWebviewHardener,
  setRsbPopupHostResolver,
  setRsbPopupOpenerReportSubscriber,
  setRsbPopupOpenerResolver,
} from './webview-security';
import {
  installSelectionContextMenu,
  setSelectionContextMenuLocale,
} from './selection-context-menu.js';
import { installContentSecurityPolicy, parseOrigin } from './security/csp';
import {
  getRsbBrowserBridge,
  registerRsbBrowserBridgeIpc,
  registerTabOpResultHandler,
} from './rsb-browser-bridge';
import { disposeAndroidAdb } from './mcp-integrations/android.js';
import { shutdownCodexEnvironment } from './mcp-integrations/codexEnvironment.js';
import { fetchRemoteMediaImageBytes } from './device-link/remoteMediaProtocol';
import * as imageCacheStore from './imageCacheStore';
import {
  collectStreamWithLimit,
  createLightboxMediaHandlers,
  REMOTE_IMAGE_MAX_BYTES,
} from './lightboxMediaActions';
import { createChatAttachmentSaveHandler } from './chatAttachmentSave';
import { sweepStartupDraftImages } from './imageCacheOrphanSweep';
import { sweepLegacyDialogueWorkingDirs } from './localDb/dialogueWorkdirSelfHeal';
import { BRAND_IDENTITY } from '@cindy/maker-shared/brand-identity';
import * as videoCacheStore from './videoCacheStore';
import { imageSchemePrivilege, registerImageProtocolHandler } from './imageProtocol';
import { videoSchemePrivilege, registerVideoProtocolHandler } from './videoProtocol';
import { modelSchemePrivilege, registerModelProtocolHandler } from './modelProtocol';
import {
  cindyMediaSchemePrivilege,
  registerCindyMediaProtocolHandler,
} from './cindy-media/cindyMediaProtocol';
import * as cindyMediaBlobStore from './cindy-media/blobStore';
import * as cindyChatAttachments from './cindy-media/chatAttachments';
import { removeSessionRefs as removeSessionMediaRefs } from './cindy-media/ledger';
import { createStorageIpcHandlers } from './cindy-media/storageIpc';
import {
  getAllRegisteredDraftUrls,
  reportDraftUrls as registerWindowDraftUrls,
} from './cindy-media/draftUrlRegistry';
import { loadAllQueueSnapshotPayloads } from './localDb/agentInputQueueSnapshots';
import {
  remoteMediaSchemePrivilege,
  registerRemoteMediaProtocolHandler,
} from './device-link/remoteMediaProtocol';
import { localFileSchemePrivilege, registerLocalFileProtocolHandler } from './localFileProtocol';
import { audioFileSchemePrivilege, registerAudioFileProtocolHandler } from './audioFileProtocol';
import {
  buildSystemPathBlocklist,
  getSensitiveMediaBlocklist,
  isPathAllowedAgainst,
} from './filePathPolicy';
import { readFileThumbnail } from './fileThumbnail';
import { resolveShellOpenPathTarget } from './shellOpenPath';
import { cindyGhostSchemePrivilege } from './cindy-brain/runtime/electronSandboxAdapter';
import { fetchReleaseNotes, fetchReleaseNotesIndex } from './releaseNotesService';
import { resolveWorkspacePathCached, resolveWorkspacePathBatchCached } from './pathResolver';
import { registerLocalDbIpc } from './localDb/ipc/registerAll';
import {
  registerLegacyMigrationIpc,
  runLegacyUserDataMigrationForUser,
} from './legacyUserDataMigration';
import { registerFsBrowseIpc } from './fsBrowse/ipc';
import {
  ensureReady as localDbEnsureReady,
  getRawDb as localDbGetRawDb,
  closeDb as localDbCloseDb,
  getCurrentDbPath as localDbGetCurrentDbPath,
} from './localDb/index';
import { createDbClient, createInprocDbClient } from './localDb/client/DbClient';
import { createLifecycleDbClientManager } from './localDb/client/lifecycleDbClient';
import { clearCurrentDbClient, getDbClient, setCurrentDbClient } from './localDb/client/current';
import {
  resolveBetterSqliteModuleEntry,
  resolveBetterSqliteNativeBinding,
} from './localDb/betterSqliteFactory';
import { freezeSessionActiveTurnMarkers } from './localDb/sessionActiveTurn';
import { getDrizzleDir } from './localDb/migrate';
import { resolveSqliteVecExtPath } from './localDb/sqliteVecLoader';
import { startEmbeddingHost, stopEmbeddingHost, isEmbeddingHostStarted } from './embedding-host';
import { readClaudeApiKey } from './maker-host/auth-adapters';
import { outboundFetch } from './maker-host/outbound-fetch';
import { registerDevEmbeddingIpc } from './ipc/dev/embedding';
import { onQuit, installQuitHandler } from './lifecycle';
import { initStartupDiagnostics } from './startup-diagnostics';
import {
  installPowerEventDiagnostics,
  installWindowResponsivenessDiagnostics,
} from './powerWakeDiagnostics';
import {
  broadcastVoiceInputPowerState,
  installVoiceInputPowerRelease,
} from './voice-input/powerReleaseNotifier';
import { reapClaudeOrphansSync } from './claude-orphan-reaper';
import { startAgentProcessPriorityWatcher } from './agent-process-priority';
import { initAppBadgeService, clearAllSessionAttention } from './appBadgeService';
import { initNotificationService } from './notificationService';
import { getAgentIslandService, initAgentIslandService } from './agent-island/service.js';
import {
  isAppContentWindow,
  isFocusedAppContentWindow,
  markAppContentWindow,
} from './windowFocusClassifier.js';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer.js';
import { readFileBytesForPreview } from './fileReadBytes.js';
import { initHeartbeatService } from './heartbeatService';
import { initAnalyticsSettingsService, noteAuthColdStartState } from './analyticsSettingsService';
import { WindowManualDragController } from './windowManualDrag';
// 设备互联(跨设备远程控制): relay 连接 host + 开关/设备列表 IPC
import { initDeviceLinkService, releaseDeviceLinkOwnershipBeforeLogout } from './device-link';
import {
  getUpdateRelaunchControllers,
  hasInFlightRemoteInvokes,
  setSessionsSubscribedListener,
} from './device-link/dispatch';
import {
  registerDeviceLinkIpc,
  defaultDeps as deviceLinkIpcDeps,
  handleInvoke as deviceLinkHandleInvoke,
} from './device-link/ipc';
import { assertCaptureHealthy } from './device-link/invoke-registry';
// worktree-parallel-sessions: IPC 注册 + close-session 内的 fire-and-forget 删除钩子
import {
  registerWorktreeIpc,
  WorktreePool,
  reconcileWorktreesForDeletedSessions,
} from './worktree';
// session-git-pr-context: 会话分支感知 + PR 关联状态 IPC
import { registerGitContextIpc, disposeGitContext } from './git-context';
import { registerGitReviewIpc } from './git-review';
import { registerSidebarSettingsIpc } from './sidebarSettingsStore';
import { registerTerminalHandlers } from './maker-ipc/terminal-handlers';
import { registerLocalThemesIpc } from './local-themes/register';
import {
  registerRemoteSshIpc,
  disposeRemoteSshPool,
  startAutoConnectHostsBackground,
  isCcMgrUpgradeInFlight,
} from './remote-ssh';
import {
  registerHookControlIpc,
  startHookControlAccount,
  stopHookControlAccount,
  resetHookControlOwnerBoundary,
  disposeHookControl,
} from './hook-control';
import { startAccountIntegrationsAfterOwnerDbReady } from './accountIntegrationStartup';
import { registerSkillhubIpc } from './skillhub/registerIpc';
import { SkillhubMarketService } from './skillhub/marketService';
import { skillhubAutoSyncService } from './skillhub/autoSyncService';
import { rehydrateCloseSuppression } from './maker-host/rehydrateCloseSuppression.js';
// Maker Core 一阶段重构（新链路）—— 静态 import 避免 dynamic import 触发 vite chunking
// 让 imageProtocol 等需要 app.ready 前注册的模块跑在错误时机。getMaker() 是 lazy 的，
// 静态 import 不会触发 Maker / Agent 的实例化。
import {
  getMaker as getMakerCore,
  getMakerIfReady,
  resetMaker,
  shutdownLspServerPool,
  prepareCodexForAuthModeChange,
  cancelCodexAuthModeChange,
  finalizeCodexAfterAuthModeChange,
  readCodexRuntimeRoute,
  broadcastClaudeAuthStateChanged,
  broadcastXaiAuthStateChanged,
  refreshProviderAccessAfterAuthChange,
  restartCodexAfterAuthModeChange,
  waitForInitialCustomMcpRefresh,
} from './maker-host/index.js';
import { createDynamicMaker } from './maker-host/dynamic-maker.js';
import {
  ensureActiveCatalogLoaded,
  refreshCustomProvidersIntoCatalog,
} from './maker-host/createDesktopProviderService.js';
import { setClaudeSupportedModelsListener } from '@cindy/maker-core';
import {
  noteAnthropicSdkSupportedModels,
  refreshAnthropicModelsFromHttp,
  clearAnthropicDiscoveredModels,
} from './maker-host/model-discovery/anthropic.js';
import { refreshCustomMcpProviders } from './mcp-integrations/custom-mcp-registry.js';
import { clearXaiRateLimitSnapshot } from './usageBroadcaster.js';
import {
  ensureAnthropicCompatProxyReady,
  disposeAnthropicCompatProxy,
} from './maker-host/anthropic-compat-proxy-host.js';
import {
  onClaudeSessionRouteChange,
  readClaudeSessionRoute,
} from './maker-host/claude-session-route-registry.js';
import {
  disposeCodexProxy,
  getCodexProxyAuthInjectionState,
} from './maker-host/codex-proxy-host.js';
import {
  disposeBrowserRuntime,
  registerBrowserBackendIpc,
  setBrowserSessionUploadRootResolver,
  setMainWindowAccessorForBackend,
  setEnsureHostForBackend,
  setIsDetachedForBackend,
} from './mcp-integrations/browser.js';
import { RsbWindowController } from './right-sidebar-window/controller.js';
import { createRightSidebarWindow } from './right-sidebar-window/window.js';
import { registerRsbWindowIpc } from './right-sidebar-window/ipc.js';
import { GhostPanelWindowsController } from './ghost-panel-window/controller.js';
import { createGhostPanelWindow } from './ghost-panel-window/window.js';
import { registerGhostPanelWindowIpc } from './ghost-panel-window/ipc.js';
import {
  patchGhostPanelWindowEntry,
  readGhostPanelWindowsSettings,
  removeGhostPanelWindowEntry,
} from './ghost-panel-window/settings-store.js';
import {
  readRsbWindowSettings,
  writeRsbWindowSettingsPatch,
} from './right-sidebar-window/settings-store.js';
import {
  anySessionInTurn,
  clearDeferredCodexRestartForOwnerBoundary,
  collectAgentInputQueueScanTexts,
  createAutomationUserTurnGitBaselineHooks,
  registerMakerIpc as registerMakerCoreIpc,
  stopOrcaIdleWatcher,
  setGoalClearObserver,
  setGoalIdleObserver,
  setGoalStopObserver,
  setGoalAskAnswerObserver,
} from './maker-ipc/register.js';
import { MAKER_INVOKE as MAKER_IPC_INVOKE, MAKER_PUSH } from './maker-ipc/channels.js';
import {
  preserveLegacyMakerMemoryDisabled,
  readMemorySettings,
  readMemorySettingsState,
} from './maker-host/memory-settings-store.js';
import {
  createAppFocusAutoRefreshTracker,
  requestProviderModelAutoRefresh,
  resetProviderModelAutoRefreshCooldowns,
} from './maker-host/provider-model-auto-refresh.js';
import {
  readImDefaultSettingsState,
  resetImDefaultSettings,
  resetImDefaultSettingsChannel,
  writeImDefaultSettingsPatch,
} from './im/defaultSettingsStore.js';
import { hasClaudeAiOAuth } from './maker-host/claude-credentials-store.js';
import { disconnectClaudeAiOAuth } from './maker-host/claude-oauth-refresh.js';
import { runClaudeOAuthLogin, cancelClaudeOAuthLogin } from './maker-host/claude-oauth-login.js';
import {
  runGrokOAuthLogin,
  cancelGrokOAuthLogin,
  logoutGrok,
  hasGrokOAuthLogin,
} from './maker-host/grok-oauth-login.js';
import { setXaiAuthInvalidatedHandler } from './maker-host/xai-auth-invalidation-host.js';
import {
  readSilentEncryptedRetrySettingsState,
  resetSilentEncryptedRetrySettings,
  writeSilentEncryptedRetryEnabled,
} from './maker-host/silent-encrypted-retry-store.js';
import { resolveOwnerScopedSecretStorageKey } from './secrets/providerSecretStore.js';
import { isRendererAccessibleSafeStorageKey } from '../shared/providerSecrets.js';
import {
  readCompactionPct,
  readCompactionState,
  resetCompactionPct,
  writeCompactionPct,
} from './maker-host/compaction-settings-store.js';
import {
  readSubagentModelSettings,
  readSubagentModelSettingsState,
  resetSubagentModelSettings,
  writeSubagentModelSettingsPatch,
} from './maker-host/subagent-model-settings-store.js';
import { readLspModeSettings, writeLspModeEnabled } from './maker-host/lsp-mode-store.js';
import {
  readChatEmbeddingSettings,
  readChatEmbeddingSettingsState,
  resetChatEmbeddingSettings,
  writeChatEmbeddingEnabled,
} from './maker-host/chat-embedding-settings-store.js';
import {
  readGitSafetySettingsState,
  resetGitSafetySettings,
  writeGitSafetyAutoSnapshotEnabled,
} from './maker-host/git-safety-settings-store.js';
import {
  setupChatHistoryEmbedder,
  setChatEmbeddingEnabled,
  resetCacheForNewDb as resetChatEmbedderCache,
} from './embedders/chat-history-embedder.js';
import { registerMakerTitleIpc } from './maker-ipc/title.js';
import { registerContactsIpc } from './maker-ipc/contacts-ipc.js';
import { disposeDesktopContactsManager } from './maker-host/maker-contacts-host.js';
import { registerMakerHelpIpc } from './maker-ipc/help.js';
import { registerHelpFeedbackIpc } from './maker-ipc/help-feedback.js';
import { registerMakerPlanWriteIpc } from './maker-ipc/plan-write.js';
import { registerMakerRewindIpc } from './maker-ipc/rewind.js';
import { registerMakerForkIpc } from './maker-ipc/fork.js';
import { registerMakerAuthIpc } from './maker-ipc/auth.js';
import { registerMakerStatusIpc } from './maker-ipc/status.js';
import {
  registerMakerUsageIpc,
  syncClaudeSubscriptionUsageForAuthChange,
} from './maker-ipc/usage.js';
import { prewarmModelPricing } from './usage/modelPricing.js';
import { registerMakerBinaryVersionIpc } from './maker-ipc/binary-version.js';
import { registerCrossAgentConvertIpc } from './cross-agent-convert/ipc.js';
import { registerFileBrowserIpc } from './file-browser/index.js';
import { disposeRemoteFileBrowser } from './file-browser/remote-deps.js';
import { registerFileBrowserDeviceOp } from './file-browser/device-op.js';
import { registerSearchIpc } from './file-browser/search/index.js';
import { registerVoiceInputIpc } from './voice-input/index.js';
import { installWindowHiddenBroadcast } from './windowHiddenBroadcast.js';
import { isSecondaryAppWindow, openSessionInNewWindow } from './secondary-windows.js';
import {
  isGlobalVoiceInputOverlayVisible,
  registerGlobalVoiceInputIpc,
} from './voice-input/global.js';
import { ensureMainAppPresence } from './appPresence.js';
import {
  registerDeepLinkProtocol,
  handleIncomingDeepLink,
  handleIncomingOpenFolder,
  handleIncomingShareFile,
  findDeepLinkInArgv,
  findOpenFolderInArgv,
  findOpenShareFileInArgv,
  setDeepLinkMainWindow,
  takePendingDeepLink,
} from './deepLink.js';
import { registerFolderContextMenu } from './folderContextMenu.js';
import { healWindowsShortcuts } from './windowsShortcutSelfHeal.js';
import { CURRENT_APP_ID } from '../shared/brandRegion.js';
import {
  readWindowBehaviorSettings,
  writeSwallowActivationClick,
  writeWindowsCloseBehavior,
} from './window-behavior-settings-store.js';
import {
  hideWindowToWindowsTray,
  popUpWindowsTrayMenu,
  requestWindowsCloseBehavior,
  requestWindowsTrayQuit,
} from './windowsTrayLifecycle.js';
import { createWindowsClosePromptFallbackController } from './windowsClosePromptFallback.js';
import {
  isWindowsCloseBehavior,
  WINDOW_BEHAVIOR_GET_WINDOWS_CLOSE_BEHAVIOR_CHANNEL,
  WINDOW_BEHAVIOR_SET_SWALLOW_ACTIVATION_CLICK_CHANNEL,
  WINDOW_BEHAVIOR_SET_WINDOWS_CLOSE_BEHAVIOR_CHANNEL,
  WINDOW_BEHAVIOR_WINDOWS_CLOSE_BEHAVIOR_REQUESTED_CHANNEL,
  WINDOW_BEHAVIOR_WINDOWS_CLOSE_BEHAVIOR_SHOWN_CHANNEL,
  type WindowsCloseBehavior,
} from '../shared/windowBehavior.js';
import { getDesktopCommandRegistry, registerBuiltinDesktopCommands } from './commands/index.js';
import { registerRemoteCmdIpc } from './commands/remoteCmdIpc.js';
import {
  resolvePreferredSystemLocale,
  resolveSystemLocale,
} from '../shared/locale.js';
import {
  IM_DEFAULT_SETTINGS,
  isImDefaultAgentKind,
  isImDefaultEffort,
  isImDefaultPermissionMode,
  isImDefaultSettingsChannel,
  isWechatUnsupportedPermissionMode,
  type ImDefaultAgentKind,
  type ImDefaultAgentSettings,
  type ImDefaultSettingsChannel,
  type ImDefaultSettingsPatch,
} from '../shared/imDefaultSettings.js';
import {
  isValidSubagentModelIdInput,
  normalizeSubagentModelId,
  reconcileSubagentModelSettingsPatch,
  type SubagentModelSettingsPatch,
} from '../shared/subagentModelSettings.js';
import { isBrowserOpenablePath } from '../shared/browserOpenableExts.js';
import {
  getClientEndpoint,
  initClientEndpoints,
  registerClientEndpointsIpc,
} from './clientEndpointsService.js';
import { registerBillingIpc } from './billing/index.js';
import {
  initModelAccess,
  noteManualXdKeySaved,
  noteManualXdKeyRemoved,
  refreshXdGatewayModels,
} from './model-access/index.js';
import { effectiveXdGatewayBaseUrl } from './model-access/effectiveEndpoint.js';
import { isLocalDbOwnerCurrent } from './appSessionPolicy.js';
import { getAppCapabilities, requireAppCapability } from './appCapabilities.js';
import {
  beginAppSessionBoundary,
  getActiveAppSession,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from './appSessionState.js';
import {
  resolveNewMakerMenuCommand,
  type ApplicationMenuCommand,
} from '../shared/applicationMenuCommands.js';
import {
  comboToElectronAccelerator,
  matchesElectronInput,
  type AppShortcutId,
} from '../shared/appShortcuts.js';
import {
  getAppShortcutStore,
  isAppShortcutRecordingActive,
  registerAppShortcutIpc,
  subscribeAppShortcutRecording,
} from './app-shortcuts/index.js';
import { installNewMakerWindowShortcut } from './app-shortcuts/new-maker-window-shortcut.js';
import { registerLayoutIpc } from './layout/index.js';
import {
  getGhostManager,
  isGhostAvailableForActiveSession,
  refreshGhostLocalization,
  registerGhostIpc,
  setGhostsChangedObserver,
  suspendAllGhosts,
  waitForGhostMutations,
} from './cindy-brain/index.js';
import { getGhostSetupChangeBus } from './cindy-brain/ghostSetupChangeBus.js';
import { getGhostSetupInteractionBridge } from './cindy-brain/ghostSetupInteractionBridge.js';
import { registerPluginMarketIpc } from './plugin-market/registerIpc.js';
import { findCindyFileInArgv } from './cindy-brain/argv.js';
import { handleIncomingCindyFile } from './cindy-brain/openFileInstall.js';
import { registerCindyFileAssociation } from './cindy-brain/fileAssociation.js';
import { setMainLocale, t } from './i18n.js';
import { throwIpcError } from './utils/ipcValidate.js';
// Scheduler (Phase 3) — 启动单例需要 maker / localDb / mainWindow 都 ready，但
// splash check-environment / user login (触发 ensureReady) 谁先到不固定。
// 通过 attemptStartScheduler 在两个就绪事件源各调一次幂等 startScheduler，最后到的
// 那次真正启动；前面的失败会被 try/catch 吞掉只记 log。
import {
  startScheduler,
  resetScheduler,
  getScheduleStorage,
  getScheduleStorageIfInitialized,
  getProjectAutomationLoader,
} from './scheduler-host/index.js';
import {
  registerScheduleHandlers,
  attachSchedulerEventListeners,
  resetSchedulerReady,
} from './maker-ipc/schedule.js';
import { registerProjectAutomationIpc } from './maker-ipc/project-automation.js';
import { startGoalController, getGoalController } from './goal-host/index.js';
import { startLearnHost, getLearnController, resetLearnController } from './learn-host/index.js';
import { fetchHubSkillReference } from './learn-host/hubReference.js';
import { registerLearnIpc, broadcastLearnEvent } from './learn-host/registerIpc.js';
import { registerGoalHandlers, broadcastGoalStatus } from './maker-ipc/goal.js';
import { createLogger as createSchedulerLogger } from './logger.js';

/**
 * Phase 4: 不再用 `_schedulerStarted` flag —— `startScheduler()` 内部以 `_scheduler`
 * 单例为权威 source of truth（已 set 时直接返回原实例）。本函数只负责"两个前置就绪
 * 都满足时尝试启动"，幂等性由 startScheduler 自己保证；切账号场景 `resetScheduler()`
 * 把 `_scheduler` 置 null，下次进来自然会重新启动。
 *
 * IPC 注册模型(重构):maker:schedule:* handler 在 registerMakerIpcsAfterSplash 内
 * 通过 `registerScheduleHandlers()` 提前一次性注册,**不依赖 scheduler 实例**;
 * 本函数拿到 scheduler 后只调 `attachSchedulerEventListeners(scheduler, storage)`
 * 把 scheduler.on 挂上 + setSchedulerReady 喂入实例 + broadcast 'ready'。
 *
 * 重复 attempt 去重:本函数被 splash 和 localDb onReady 各调一次,startScheduler
 * 第二次返回同一实例,WeakSet 防止 scheduler.on 重复挂第二份 listener。切账号
 * 后 resetScheduler 把 _scheduler 置 null,下一次拿到新实例,WeakSet 里没有,
 * 自然会重新 attach 一次。
 */
async function attemptStartScheduler(): Promise<void> {
  // 两个前置条件必须满足才能启动：
  //   1. maker 单例已构造 (splash check-environment 完成 → registerMakerIpcsAfterSplash)
  //   2. DbClient 已 smoke 通过 (user login → renderer 触发 'local-db:ensure-ready' IPC)
  // 任一未满足时 getMakerCore() / getDbClient() 抛错，整体 try/catch 兜住，等下次触发。
  let maker: Maker;
  try {
    maker = getMakerCore();
  } catch (err) {
    console.log(
      '[bootstrap-electron] attemptStartScheduler: maker not ready yet, will retry on next trigger:',
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  try {
    getDbClient();
  } catch (err) {
    console.log(
      '[bootstrap-electron] attemptStartScheduler: DbClient not ready yet, will retry on next trigger:',
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  // 若本调用是 getMakerCore() 的首次调用（onReady 在 registerMakerIpcsAfterSplash 之前
  // 触发时可能发生），_initialCustomMcpRefresh 刚启动但尚未落地；在 startScheduler 前
  // await，确保第一个 scheduler tick 能看到用户已保存的自定义 MCP 配置。
  // 若 Maker 已被 registerMakerIpcsAfterSplash 构造过，promise 早已 resolve，no-op。
  await waitForInitialCustomMcpRefresh();
  const automationGitBaselineHooks = createAutomationUserTurnGitBaselineHooks();
  try {
    const scheduler = await startScheduler({
      maker,
      getDb: () => getDbClient().drizzle,
      getMainWindow: () => mainWindowRef,
      feishuIm,
      logger: createSchedulerLogger('scheduler-host'),
      ...automationGitBaselineHooks,
    });
    // scheduler 真正 ready 后挂 listener + 喂入 readiness holder。WeakSet 按实例
    // 去重:splash + localDb onReady 各调一次,同实例第二次 no-op;切账号后新实例
    // 不在 set 里,会重新 attach。
    // 注意:schedule:* IPC handler 不在这里注册 — 它们在 registerMakerIpcsAfterSplash
    // 内通过 registerScheduleHandlers() 提前挂好,handler 内部 awaitReady 等本行
    // setSchedulerReady 调用。
    if (!_scheduleIpcRegistered.has(scheduler)) {
      attachSchedulerEventListeners(scheduler, getScheduleStorage());
      registerProjectAutomationIpc(getProjectAutomationLoader());
      _scheduleIpcRegistered.add(scheduler);
    }
  } catch (err) {
    console.error('[bootstrap-electron] startScheduler failed (non-fatal):', err);
  }
  // GoalController 与 scheduler 同就绪点启动(maker + localDb 均 ready):内部幂等
  // (_controller 已存在则直接返回),启动时 resume 所有 active goal。失败非致命。
  try {
    startGoalController({
      maker,
      getDb: () => getDbClient().drizzle,
      broadcastStatus: broadcastGoalStatus,
      ...automationGitBaselineHooks,
    });
  } catch (err) {
    console.error('[bootstrap-electron] startGoalController failed (non-fatal):', err);
  }
  // LearnController 同就绪点启动(maker + localDb 均 ready):内部幂等,
  // 启动时 resume 中断 run / 清理孤儿 staging。失败非致命。
  try {
    // hub 源(/learn hub:<slug> 与 skill hub「学习此技能」共用):main 内直调
    // market service 拉 skill 元数据 + 全部已发布文件(scripts/references/...)
    // 作为蒸馏参考材料 —— learn-host 会把它们写入 staging/_reference/<slug>/
    // 供蒸馏 agent 复制,产物若依赖上游脚本却只有 SKILL.md 可读,装完引用必悬空。
    // 上限:40 个文件、单文件 ≤512KB、跳过 server 标记 truncated 的;
    // 拉取失败逐个降级(参考材料尽力而为,不阻断)。
    const learnMarketService = new SkillhubMarketService();
    startLearnHost({
      maker,
      broadcast: broadcastLearnEvent,
      fetchHubSkill: (slug) => fetchHubSkillReference(learnMarketService, slug),
      ...automationGitBaselineHooks,
    });
  } catch (err) {
    console.error('[bootstrap-electron] startLearnHost failed (non-fatal):', err);
  }
}

const _scheduleIpcRegistered = new WeakSet<object>();

/**
 * embedding-host (Phase 1.1/1.2): localDb ensureReady 完成后按需启动。
 *
 * **chat-embedding setting 控制整个 host 启停**:
 *   - settings.enabled=false → 完全不启动 (没 Worker setInterval, 没 Provider 注册,
 *     没 hook 副作用) — 用户感受不到任何后台轮询
 *   - settings.enabled=true → startEmbeddingHost + setupChatHistoryEmbedder +
 *     setEnabled(true) 触发 cutoff 写入
 *
 * 当前只有 chat 一个 consumer, 直接对齐它的开关最简单。未来加 memory / document
 * 等 consumer 时再重构成"任一 consumer ON → host start"的引用计数模式。
 *
 * 幂等: 第二次调直接 return (isEmbeddingHostStarted 守卫)。sqlite-vec 不可用时
 * 仍启动 (启动后 Worker 自己 idle 不嵌), 不阻塞 app。
 */
function attemptStartEmbeddingHost(): void {
  if (isEmbeddingHostStarted()) return;
  try {
    getDbClient();
  } catch (err) {
    console.log(
      '[bootstrap-electron] attemptStartEmbeddingHost: DbClient not ready yet:',
      err instanceof Error ? err.message : String(err),
    );
    return;
  }
  // setting OFF → 不启动 host, 不创建 Worker, 不注册 hook。
  // 用户 toggle ON 时 CHAT_EMBEDDING_SET IPC 会重新调本函数。
  const settings = readChatEmbeddingSettings();
  if (!settings.enabled) {
    console.log(
      '[bootstrap-electron] chat embedding disabled by settings; embeddingHost not started',
    );
    return;
  }
  try {
    const service = startEmbeddingHost({
      getDbClient: () => getDbClient(),
      isVecAvailable: () => {
        try {
          return getDbClient().vecAvailable;
        } catch {
          return false;
        }
      },
      // XD Gateway /v1/embeddings 走 Bearer ANTHROPIC_API_KEY (与 art / claude 同源)
      getApiKey: () => readClaudeApiKey(),
      // 函数形态:model-access 下发切换 endpoint 后,常驻的 embedding host 无需重启。
      gatewayBaseUrl: () => effectiveXdGatewayBaseUrl(),
      // /v1/embeddings 也要吃系统代理:裸全局 fetch 在「系统代理」模式下裸直连出网
      // (见 maker-host/outbound-fetch.ts)。
      fetchImpl: outboundFetch,
      log: createSchedulerLogger('embeddingHost'),
    });
    // chat-history-embedder consumer 注册 + setEnabled(true) 触发 cutoff 落盘。
    // 走到这里说明 settings.enabled=true, setEnabled 直接传 true。
    try {
      setupChatHistoryEmbedder({
        service,
        getDbClient: () => getDbClient(),
        log: createSchedulerLogger('chatHistoryEmbedder'),
      });
      setChatEmbeddingEnabled(true);
    } catch (err) {
      console.error('[bootstrap-electron] setupChatHistoryEmbedder failed (non-fatal):', err);
    }
  } catch (err) {
    console.error('[bootstrap-electron] startEmbeddingHost failed (non-fatal):', err);
  }
}

// Codex / Claude binary 下载 + 状态查询 全部走 agent-binaries (按 kind 分派)。
// vendor/{claude,codex}/binaryProvisioner.ts 已退役。

// ── Unified logger init ─────────────────────────────────────────────────
// 必须在任何 createLogger() 调用之前。没初始化的话 emit() 默认 isDevMode=false
// 走 packaged 分支,但 logStream 还是 null —— 所有日志都会被静默吞掉。
// dev: 直接 console;packaged: 写 userData/logs/main.log。
import {
  initLogger,
  writeFromRenderer,
  setLogLevel,
  getLogLevel,
  keepRecentSync,
  keepRecentSessionCcDebugSync,
  createLogger,
  writeCcDebugLine,
  type LogLevel,
} from './logger.js';
initLogger();
const dbClientLog = createLogger('DbClient');
const authBoundaryLog = createLogger('auth-boundary');
// 主窗 renderer 加载失败可观测性 + dev 启动看门狗(见 renderer-boot-guard.ts 顶部注释)。
const rendererGuardLog = createLogger('renderer-guard');
const updatePresentationLog = createLogger('update-presentation');
const voicePowerBroadcastLog = createLogger('voice-input-power');
let rendererBootGuard: RendererBootGuard | null = null;

const lifecycleDbClientManager = createLifecycleDbClientManager({
  getCurrentDbPath: localDbGetCurrentDbPath,
  createWorkerClient: createDbClient,
  createInprocClient: () => createInprocDbClient(),
  setCurrentDbClient,
  clearCurrentDbClient,
  log: dbClientLog,
});

async function ensureLifecycleDbClient(userId: string) {
  return lifecycleDbClientManager.ensure(userId, {
    drizzleDir: getDrizzleDir(),
    sqliteVecExtPath: resolveSqliteVecExtPath(),
    nativeBinding: resolveBetterSqliteNativeBinding() ?? undefined,
    // file worker / inline 回滚口都使用主进程解析好的入口，避免 packaged 下
    // worker 自行裸 require('better-sqlite3') 解析到错误目录。
    betterSqliteModulePath: resolveBetterSqliteModuleEntry(),
  });
}

async function teardownAuthAccountBoundary(reason: string): Promise<void> {
  skillhubAutoSyncService.cancelInFlight();
  // Cindy relay owns long-lived transports plus account-scoped task/binding
  // state. Drain ingress before discarding the owner-scoped store; otherwise a
  // late Telegram/Slack callback could write through the next account boundary.
  try {
    await stopHookControlAccount();
  } catch (err) {
    authBoundaryLog.error(`stopHookControlAccount on ${reason} failed (non-fatal):`, err);
  } finally {
    resetHookControlOwnerBoundary();
  }
  // Every Ghost sandbox can retain live OAuth, subscription, or in-memory
  // state. Stop them before changing owners; resident Ghosts are recreated by
  // the auth-change activation pass after the new boundary is committed.
  await waitForGhostMutations();
  suspendAllGhosts();
  // Personal IM channels have the same DB boundary. Relogin restarts them from
  // the next owner DB-ready callback; app:ready-for-bot remains a compatibility
  // retry after the new DbClient is ready.
  try {
    await stopImConnection(reason);
  } catch (err) {
    authBoundaryLog.error(`stopImConnection on ${reason} failed (non-fatal):`, err);
  }
  // Phase 4 切账号:teardown 顺序很关键,分两步 ① readiness holder → ② scheduler。
  // ① 先清 readiness holder,**必须在 await resetScheduler() 之前**。
  // resetScheduler() 内部 await _scheduler.stop() 是异步的;若先 await 它,在
  // stop 进行中的那段窗口里 _current 仍指向正在停的旧实例,期间任何新的
  // withScheduler 调用会 awaitReady → 立即 resolve 到这个 stopping 实例 → 业务
  // cb 在已停 scheduler 上跑。先同步清掉 _current,让窗口内的新调用转为 pending,
  // 等 relogin 后的 setSchedulerReady 喂入**新实例**(与 worker bug #1 的 relogin
  // 路径同构,这里关掉 teardown 路径的对偶窗口)。
  // 不 reject _pending — 让在途请求继续等下次 setSchedulerReady,30s 超时兜底。
  resetSchedulerReady();
  const agentIslandService = getAgentIslandService();
  agentIslandService?.resetRuntimeState();
  // ② 再停旧 scheduler。scheduler 持有旧 user 的 storage drizzle 引用,必须在
  // closeLocalDb 之前先 stop;否则下一秒 tick 会撞 'localDb not ready'。
  // resetScheduler 把 scheduler-host 的 _scheduler 单例置 null,下一次
  // attemptStartScheduler(onReady 触发)会用新 user 的 drizzle 重新启动。
  // 见 Phase 3 changelog «scheduler 不监听 localDb.closeDb(切账号)» 遗留。
  try {
    await resetScheduler();
  } catch (err) {
    authBoundaryLog.error(`resetScheduler on ${reason} failed (non-fatal):`, err);
  }
  // attemptStartScheduler 的 WeakSet 也要给新 scheduler 实例留位置 — 老实例被
  // resetScheduler 置 null 后会被 GC,WeakSet 自动清理;新实例从未 add 过,
  // attempt 时会重新 attach。这里无需手动操作 WeakSet。
  // embedding-host 也持有旧 user 的 db 引用, 切账号前先 stop, 下次 ensureReady
  // 触发的 onReady 会用新 db 重新启动 (attemptStartEmbeddingHost 单例幂等)。
  try {
    await stopEmbeddingHost();
  } catch (err) {
    authBoundaryLog.error(`stopEmbeddingHost on ${reason} failed (non-fatal):`, err);
  }
  // chat-history-embedder 模块级 state (cutoff cache / enabled / deps) 也跟旧 user
  // 的 DB 绑定; 重置后下一次 attemptStartEmbeddingHost → setupChatHistoryEmbedder
  // 会按新 user 的 DB 重新初始化, 切账号无串库风险。
  try {
    resetChatEmbedderCache();
  } catch (err) {
    authBoundaryLog.error(
      `[bootstrap-electron] resetChatEmbedderCache on ${reason} failed (non-fatal):`,
      err,
    );
  }
  // learn-host 单例持有旧 user 的 maker/db 注入依赖与内存 run store;不重置的话
  // relogin 后 startLearnHost 幂等早退,新账号会继续用旧依赖、看到旧账号的
  // in-memory run(Codex review)。dispose 中止活跃蒸馏、解绑 watcher,下次
  // 就绪点用新依赖重建。
  try {
    await resetLearnController();
  } catch (err) {
    authBoundaryLog.error(`resetLearnController on ${reason} failed (non-fatal):`, err);
  }
  try {
    disposeDesktopContactsManager();
  } catch (err) {
    authBoundaryLog.error(`dispose contacts manager on ${reason} failed (non-fatal):`, err);
  }
  // Maker session storage resolves the current DbClient lazily. A late callback
  // from the previous owner must not survive long enough to write into the next
  // owner's database, so shut down and discard the entire runtime before DB swap.
  // 先丢弃旧 owner 的延迟 Codex 重启登记 —— holder 随进程存活,不清会在新 owner
  // 的 Maker 上兑现旧 owner 的记忆设置重启(shutdown 触发的会话关闭事件也会
  // 撞上它,先清再关)。
  clearDeferredCodexRestartForOwnerBoundary();
  try {
    const maker = getMakerIfReady();
    if (maker) await maker.shutdown();
    resetMaker();
  } catch (err) {
    authBoundaryLog.error(`maker shutdown on ${reason} failed (non-fatal):`, err);
    resetMaker();
  }
  // device-link 单持有者仲裁:必须在 dispose DbClient **之前**释放持有权行
  // (dispose 同步 clearCurrentDbClient,之后 store 不可用,只能等 15s+ 心跳
  // 过期,同机幸存实例接管变慢)。内部带 1.5s 超时,不会卡住登出。
  try {
    await releaseDeviceLinkOwnershipBeforeLogout();
  } catch (err) {
    authBoundaryLog.error(
      `[bootstrap-electron] release device-link ownership on ${reason} failed (non-fatal):`,
      err,
    );
  }
  await lifecycleDbClientManager.dispose(reason);
  agentIslandService?.resetRuntimeState();
}

authManager.setAccountSwitchTeardown(async () => {
  await teardownAuthAccountBoundary('runtime-replacement-account-switch');
});
authManager.setAuthSessionTeardown(teardownAuthAccountBoundary);

try {
  reapClaudeOrphansSync();
} catch (err) {
  // Defensive: reapClaudeOrphansSync already catches its own scan/kill errors
  // and logs to debug. This only fires on truly unexpected throws (e.g. module
  // load failure) and must never abort bootstrap.
  createLogger('claude-orphan-reaper').warn('initial reap threw', { error: String(err) });
}

// ── agent 进程优先级降档 watcher(agent 资源占用治理)─────────────────────
// 设置(processPriority)为 normal 且无欠恢复进程时,每 tick 零成本(不扫进程表);
// interval 已 unref,进程退出不被它拖住。所有失败 best-effort,不影响启动。
try {
  startAgentProcessPriorityWatcher();
} catch (err) {
  createLogger('agent-process-priority').warn('watcher start threw', { error: String(err) });
}

// ── 启动诊断 (issue #758) ────────────────────────────────────────────────
// 上次异常退出尸检 (run marker) + Crashpad 本地 minidump + crash dump 扫描。
// 必须在 app ready 前 (crashReporter.start 约束)、userData 定型后 (index.ts 的
// devFlags override 已生效) 调用 —— 此处顶层满足两者。内部全兜底,永不阻断启动。
initStartupDiagnostics();

// ── Dev-only: Chrome DevTools Protocol remote debugging port ─────────────
// 仅 dev 模式开放。开了之后 main 进程会在 127.0.0.1:9222 上提供 /json/list
// 列出所有 renderer/utility 的 webSocketDebuggerUrl, 用 CDP 抓 heap snapshot
// (HeapProfiler.takeHeapSnapshot) 不再依赖人工开 DevTools。
//
// 配套脚本: apps/desktop/scripts/take-heap-snapshot.mjs
//   node apps/desktop/scripts/take-heap-snapshot.mjs --out ./apps/desktop/logs/
//
// packaged 下绝不开 — 任何带 9222 端口的 Chromium 进程都能被本机其他程序
// 注入 JS, 是远程代码执行口子。dev 机器自然不在 attack surface 内。
//
// 端口可用 XDT_CDP_PORT 覆写(仅数字生效):并行多开沙箱时 9222 只有先起的
// 实例能绑上, 后起实例要保住 CDP 调试面就换个端口。

if (!app.isPackaged) {
  const cdpPortOverride = process.env.XDT_CDP_PORT;
  const cdpPort = cdpPortOverride && /^\d{2,5}$/.test(cdpPortOverride) ? cdpPortOverride : '9222';
  app.commandLine.appendSwitch('remote-debugging-port', cdpPort);
}

// ── Webview hardener (RSB Phase 4) ──────────────────────────────────────
// 必须在 app ready 之前 install:Electron 的 `web-contents-created` listener 在
// ready 前注册也有效,内部缓冲到 fire 时才投递,确保主窗 / 任何 webContents
// 首次 attach webview 都走 hardener。详见 webview-security.ts。
installWebviewHardener();

// ── RSB browser bridge (browser-backend Phase 2) ────────────────────────
// Renderer → main 桥,把 RSB `<webview>` 注册到 main 端 TabRegistry,future
// 浏览器自动化 backend(Phase 3+)消费 webContents 句柄。
// 顶层注册:IPC handler 是 ipcMain.handle,在 app ready 前注册也有效;pin/unpin
// 通知用的 host webContents 通过 mainWindowRef lazy 取,主窗未就绪时静默跳过
// (pin 状态由 main 端 registry 保权威,renderer 端会通过 reconciliation 跟上)。
// ── 右侧栏独立子窗口(RSB window)────────────────────────────────────────
// 「侧边栏在新窗口中显示」偏好 + 子窗口生命周期状态机。detached 且窗口开着时,
// RSB host(pin/unpin 通知、tab-op dispatch 的目标 renderer)是子窗口而非主窗,
// 下方三处 RSB bridge wiring 统一经 controller.getHostWebContents() 解析。
// deps 全部是 lazy 闭包(mainWindowRef / isQuitting 在文件更靠后声明+赋值,
// 调用时机远晚于此处构造),状态机本体见 right-sidebar-window/controller.ts。
const rsbWindowController = new RsbWindowController({
  settings: { read: readRsbWindowSettings, writePatch: writeRsbWindowSettingsPatch },
  createWindow: (opts) => createRightSidebarWindow(opts),
  getMainWindow: () => mainWindowRef,
  broadcastState: (state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send(MAKER_PUSH.RSB_WINDOW_STATE_CHANGED, state);
      } catch {
        // window torn down mid-broadcast — ignore
      }
    }
  },
  sendToWindow: (win, channel, payload) => {
    try {
      win.webContents.send(channel, payload);
    } catch {
      // window torn down mid-send — ignore
    }
  },
  contextChannel: MAKER_PUSH.RSB_WINDOW_CONTEXT_CHANGED,
  commandChannel: MAKER_PUSH.RSB_WINDOW_COMMAND,
  isQuitting: () => isQuitting,
  log: createLogger('right-sidebar-window-controller'),
});
registerRsbWindowIpc({
  controller: rsbWindowController,
  getMainWindow: () => mainWindowRef,
});

// ── 插件停靠面板独立窗口(ghost panel window)────────────────────────────
// 每 ghostId 一扇窗:PanelChrome「独立窗口」按钮 → setDetached(id, true) 开窗,
// 主窗布局树里该 pane 停止渲染(树不动);关窗/合并即回停靠。装/卸/启停广播
// 经 setGhostsChangedObserver 喂 reconcile,失去资格的窗口即时收掉。
// deps 同样全 lazy(isQuitting 声明在后),状态机见 ghost-panel-window/controller.ts。
const ghostPanelWindowsController = new GhostPanelWindowsController({
  settings: {
    read: readGhostPanelWindowsSettings,
    patchEntry: patchGhostPanelWindowEntry,
    removeEntry: removeGhostPanelWindowEntry,
  },
  createWindow: (ghostId) => {
    const ghost = getGhostManager()
      .list()
      .find((g) => g.manifest.id === ghostId);
    const title = ghost?.manifest.panel?.title ?? ghost?.manifest.name ?? ghostId;
    return createGhostPanelWindow(ghostId, title);
  },
  isGhostDetachable: (ghostId) => {
    const ghost = getGhostManager()
      .list()
      .find((g) => g.manifest.id === ghostId);
    return (
      ghost !== undefined &&
      ghost.enabled !== false &&
      ghost.manifest.panel !== undefined &&
      ghost.manifest.panel.position !== 'tab' &&
      isGhostAvailableForActiveSession(ghostId)
    );
  },
  broadcastState: (state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send(MAKER_PUSH.GHOST_PANEL_WINDOW_STATE_CHANGED, state);
      } catch {
        // window torn down mid-broadcast — ignore
      }
    }
  },
  isQuitting: () => isQuitting,
  log: createLogger('ghost-panel-window-controller'),
});
registerGhostPanelWindowIpc(ghostPanelWindowsController);
setGhostsChangedObserver((ghosts) => ghostPanelWindowsController.reconcile(ghosts));

registerRsbBrowserBridgeIpc({
  registry: getRsbBrowserBridge(),
  getHostWebContents: () => rsbWindowController.getHostWebContents(),
  logger: createLogger('rsb-browser-bridge-bootstrap'),
});
// popup opener 反查:webview-security 的 popup 路由据此把 window.open 的目标
// tab 归属到发起方 tab 的 session(而不是用户正在看的 session)。
setRsbPopupOpenerResolver((webContentsId) => {
  const record = getRsbBrowserBridge().findByWebContentsId(webContentsId);
  return record ? { tabId: record.tabId, sessionId: record.sessionId } : null;
});
// report 到达事件订阅:归属等待从固定轮询窗口升级为事件驱动 —— report 落地的
// 瞬间完成反查,超时只兜"report 永不来"的极端场景。
setRsbPopupOpenerReportSubscriber((listener) =>
  getRsbBrowserBridge().onReport((record) => listener(record.webContentsId)),
);
// popup 路由目标 host 动态解析:异步等待(归属反查 / deferred URL 捕获)期间用户
// detach 侧边栏或切视图后,捕获时的 hostContents 已过时 —— 发送时刻按当前宿主
// 形态解析(与 tab-op bridge 同一来源),消息才能落到活着的订阅者。
setRsbPopupHostResolver(() => rsbWindowController.getHostWebContents());
// Tab-op result handler for the main → renderer request/response bridge —
// RsbWebviewBackend (Phase 3) uses this to drive `open` / `focus` / `close`
// against the renderer's RSB store.
registerTabOpResultHandler({
  getHostWebContents: () => rsbWindowController.getHostWebContents(),
  logger: createLogger('rsb-browser-bridge-renderer-bridge'),
});

// Phase 5: wire the host accessor into the backend module so the
// RsbWebviewBackend's renderer-bridge can reach the host renderer for
// tab-op dispatch, then register the Settings-driven backend toggle IPC.
// The accessor resolves through the RSB window controller: detached + open →
// sidebar window renderer, otherwise the main window (lazy closure over
// `mainWindowRef`, assigned later in `createMainWindow`). `ensureHost` lets
// an automation tab-op pop the sidebar window first when the user prefers
// detached mode but has the window closed.
setMainWindowAccessorForBackend(() => rsbWindowController.getHostWebContents());
setEnsureHostForBackend(() => rsbWindowController.ensureOpenForAutomation());
setIsDetachedForBackend(() => readRsbWindowSettings().detached);
setBrowserSessionUploadRootResolver(async (sessionId) => {
  try {
    const meta = await getMakerCore().getSessionMeta(sessionId);
    if (!meta?.workDir || meta.remoteHostId) return [];
    return [meta.workDir];
  } catch {
    return [];
  }
});
registerBrowserBackendIpc();

// ── 应用级快捷键 override 存储 IPC ──────────────────────────────────────
// renderer 启动同步拉 overrides、设置页写路径、changed 广播。顶层注册,
// ipcMain.handle 在 app ready 前注册也有效。
registerAppShortcutIpc();

// ── 主界面布局树存储 IPC──────────────────────────────────────────────
// renderer 首帧 sendSync 拉布局(规则 7 无跳变)、set/reset 写路径、changed
// 广播。注册时顺带 ensurePersisted:userData 落 layout.v1.json + 损坏自愈。
registerLayoutIpc();

// ── 意识仓库 IPC──────────────────────────────────────────────────────
// renderer 首帧 sendSync 拉已装意识清单(意识面板与内置面板同帧注册,规则 7
// 无跳变)、install/uninstall 写路径、changed 广播。见 main/cindy-brain/。
registerGhostIpc();
registerPluginMarketIpc();

// ── Custom protocol registration (image-local-cache M2) ──────────────────
// MUST run before app.whenReady(), and MUST be a SINGLE call:
// registerSchemesAsPrivileged replaces the whole privileged-scheme list every
// time it runs, so per-module calls silently wipe each other — only the last
// caller's scheme keeps its privileges. That exact bug shipped once (xdt-model
// lost supportFetchAPI when cindy-remote-media registered after it → 3D preview
// stuck on poster). Every protocol module therefore only EXPORTS its privilege
// entry; this is the one place that registers them.
//   xdt-image:        locally cached chat images (<img>)
//   xdt-video:        locally cached videos; Range 由 handler 手动 206 切片
//                     (stream:false 是现状语义,不在此处改)
//   xdt-file:         arbitrary local file previews (extension whitelist)
//   xdt-audio:        local audio files (<audio>, Range 同 video 手动处理)
//   xdt-model:        mivo 3D model cache — <model-viewer> 用 fetch() 拉模型,
//                     supportFetchAPI 丢失即静默白屏,勿动
//   cindy-remote-media: device-link 入方向媒体(被控端字节经 OSS 中转)
//   cindy-ghost:      意识沙箱文件供片(handler 挂在每意识专属 session 分区,
//                     只认自己安装目录;docs/dev-rules/plugin-security-and-authoring.md)
//   cindy-media:      媒体总仓字节仓取件窗口(内容寻址 blob;新写入媒体的
//                     统一协议,历史 xdt-* 协议只读兼容)
protocol.registerSchemesAsPrivileged([
  imageSchemePrivilege,
  videoSchemePrivilege,
  localFileSchemePrivilege,
  audioFileSchemePrivilege,
  modelSchemePrivilege,
  remoteMediaSchemePrivilege,
  cindyGhostSchemePrivilege,
  cindyMediaSchemePrivilege,
]);

import started from 'electron-squirrel-startup';

import {
  APPLICATION_MENU_LABELS,
  type ApplicationMenuLocale,
} from './applicationMenuLabels.js';

if (started) {
  app.quit();
}

// (Removed: one-shot mivo retirement migration. Mivo MCP was reactivated
// in this branch — see packages/lizi-mcps/src/mivo/. The cleanup migration
// was deleting the freshly-saved mivo_api_key.enc on every startup, gating
// the LiziMcpProvider off so LLM never saw mivo tools. The migration is no
// longer wanted; if a user genuinely never used mivo, the absent file
// remains absent and nothing happens — no migration needed.)

// ── Wait for in-flight update ────────────────────────────────────────────
// The update script creates a .updating lock file while robocopy replaces
// app files. If we launch during that window, the exe/DLLs may be half-
// written → crash. Block here (synchronously) until the lock disappears.
{
  const lockPath = getUpdateLockPath();
  const maxWaitMs = 30_000;
  const pollMs = 500;
  const start = Date.now();
  while (fs.existsSync(lockPath) && Date.now() - start < maxWaitMs) {
    // Busy-wait is acceptable here: this only runs during the brief
    // robocopy window and the app has no UI yet.
    const waitUntil = Date.now() + pollMs;
    while (Date.now() < waitUntil) {
      /* spin */
    }
  }
  // If still locked after 30s, proceed anyway (stale lock).
  try {
    fs.unlinkSync(lockPath);
  } catch {
    /* ignore */
  }
}

// ── File-attachment path policy (F-FI-7 安全) ────────────────────────────
// Shared by `read-file-for-attachment`, `peek-file-header`,
// `text-file:read-preview` and `shell:open-path`. Blocks access to OS
// system directories that an attachment pipeline has no legitimate reason
// to touch — defence in depth on top of the absolute-path check.
//
// The blocklist + containment check now live in `filePathPolicy.ts` so the
// auto-loaded `xdt-file://` media protocol can reuse the same model (with a
// stricter, credential-aware superset). Behavior for the callers here is
// unchanged: same system dirs, same resolve/normalize + case-insensitive-on-
// win32 comparison with separator-boundary safety.
const SYSTEM_PATH_BLOCKLIST: string[] = buildSystemPathBlocklist();

// ApplicationMenuCommand 从 ../shared/applicationMenuCommands 单点导入。
// 应用菜单四语标签抽到 ./applicationMenuLabels,使术语门禁能直接 import 扫描(见该文件注释)。

function resolveApplicationMenuLocale(raw: string | null | undefined): ApplicationMenuLocale {
  return resolveSystemLocale(raw);
}

function getPreferredApplicationLocale(): ApplicationMenuLocale {
  const langs = app.getPreferredSystemLanguages();
  return resolvePreferredSystemLocale(langs.length > 0 ? langs : [app.getLocale()]);
}

function dispatchApplicationMenuCommand(
  menuWindow: BrowserWindow,
  command: ApplicationMenuCommand,
  options: { activateWindow?: boolean } = {},
): void {
  const mainWindow = mainWindowRef && !mainWindowRef.isDestroyed() ? mainWindowRef : menuWindow;
  if (mainWindow.isDestroyed()) return;
  const activateWindow = options.activateWindow ?? true;
  if (activateWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  const sendCommand = () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app-menu:command', command);
    }
  };

  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', sendCommand);
  } else {
    sendCommand();
  }
}

/**
 * 菜单 accelerator 从 app-shortcuts store 取生效值 (默认 + 用户 override)。
 * 组合无法表达为 Electron accelerator 时返回 undefined —— 菜单项不带
 * accelerator (点击仍可用), 实际按键由 renderer / before-input-event 匹配路径生效。
 */
function menuAcceleratorFor(id: AppShortcutId): string | undefined {
  const first = getAppShortcutStore().getEffectiveCombos(id)[0];
  if (!first) return undefined;
  return comboToElectronAccelerator(first, process.platform) ?? undefined;
}

function installApplicationMenu(
  mainWindow: BrowserWindow,
  locale: ApplicationMenuLocale = getPreferredApplicationLocale(),
): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }

  const labels = APPLICATION_MENU_LABELS[locale];
  // Toggle Sidebar: 用 registerAccelerator: false —— 菜单显示 ⌘B 标签且可点击,
  // 但不向 OS 注册热键。真正按键由 MainLayout 里的 renderer keydown 处理 (那段
  // 会跳过非 Tiptap 的 contenteditable, 保留富文本编辑器自己的 Bold 能力)。
  const toggleSidebarItem: Electron.MenuItemConstructorOptions = {
    label: labels.toggleSidebar,
    accelerator: menuAcceleratorFor('toggle-sidebar'),
    registerAccelerator: false,
    click: () => dispatchApplicationMenuCommand(mainWindow, 'toggle-sidebar'),
  };
  // Release 包剔除 reload / forceReload / toggleDevTools — 这三项默认 accelerator
  // (Cmd+R / Shift+Cmd+R / Alt+Cmd+I) 会把 renderer 整页刷掉,丢掉 streaming 中的
  // agent turn、composer 草稿等内存态。dev 模式下展开默认 viewMenu 的项, 把
  // Toggle Sidebar 插到顶部 (role: 'viewMenu' 不允许在里面追加自定义项)。
  // 设置页录制快捷键期间不向系统注册菜单 accelerator (标签仍显示), 否则录制
  // ⌘N / ⌘R / ⌘0 等会被菜单先吃掉直接触发命令, 破坏录制态互斥。录制结束由
  // subscribeAppShortcutRecording 回调重建菜单恢复注册。
  const registerMenuAccelerators = !isAppShortcutRecordingActive();
  const viewMenu: Electron.MenuItemConstructorOptions = app.isPackaged
    ? {
        label: labels.viewMenu,
        submenu: [
          toggleSidebarItem,
          { type: 'separator' },
          { role: 'resetZoom', registerAccelerator: registerMenuAccelerators },
          { role: 'zoomIn', registerAccelerator: registerMenuAccelerators },
          { role: 'zoomOut', registerAccelerator: registerMenuAccelerators },
          { type: 'separator' },
          { role: 'togglefullscreen', registerAccelerator: registerMenuAccelerators },
        ],
      }
    : {
        label: labels.viewMenu,
        submenu: [
          toggleSidebarItem,
          { type: 'separator' },
          { role: 'reload', registerAccelerator: registerMenuAccelerators },
          { role: 'forceReload', registerAccelerator: registerMenuAccelerators },
          { role: 'toggleDevTools', registerAccelerator: registerMenuAccelerators },
          { type: 'separator' },
          { role: 'resetZoom', registerAccelerator: registerMenuAccelerators },
          { role: 'zoomIn', registerAccelerator: registerMenuAccelerators },
          { role: 'zoomOut', registerAccelerator: registerMenuAccelerators },
          { type: 'separator' },
          { role: 'togglefullscreen', registerAccelerator: registerMenuAccelerators },
        ],
      };

  // 应用名相关文案一律走 BRAND_NAME(展示名),不用 app.getName():后者返回
  // package.json productName(过渡期仍是 xdt-maker,机器身份不许跟随改名,
  // 见 maker-shared/branding.ts 顶注)。hide/quit role 的默认标签也吃 app.name,
  // 所以显式给 label。macOS 菜单栏第一项的粗体标题不吃这里的 label(系统取自
  // 可执行 bundle 的 Info.plist CFBundleName),dev 下恒为 "Electron",无法运行时修改。
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: BRAND_NAME,
      submenu: [
        {
          label: labels.about.replace('{{appName}}', BRAND_NAME),
          click: () => dispatchApplicationMenuCommand(mainWindow, 'open-about'),
        },
        { type: 'separator' },
        {
          label: labels.settings,
          accelerator: menuAcceleratorFor('open-settings'),
          registerAccelerator: registerMenuAccelerators,
          click: () => dispatchApplicationMenuCommand(mainWindow, 'open-settings'),
        },
        {
          label: labels.checkForUpdates,
          click: () =>
            dispatchApplicationMenuCommand(mainWindow, 'check-for-updates', {
              activateWindow: false,
            }),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        // hide/hideOthers/quit/minimize 同样吃录制 gate: 否则录制中按
        // ⌘Q/⌘H/⌘M 会先触发原生 role, 用户看不到"系统保留"校验提示就把
        // 应用退出/隐藏了。(close 已改为永不注册 accelerator, 不在此列,
        // 见下方 Window 菜单注释。)
        {
          role: 'hide',
          label: labels.hide.replace('{{appName}}', BRAND_NAME),
          registerAccelerator: registerMenuAccelerators,
        },
        { role: 'hideOthers', registerAccelerator: registerMenuAccelerators },
        { role: 'unhide' },
        { type: 'separator' },
        {
          role: 'quit',
          label: labels.quit.replace('{{appName}}', BRAND_NAME),
          registerAccelerator: registerMenuAccelerators,
        },
      ],
    },
    {
      label: labels.fileMenu,
      submenu: [
        {
          label: labels.newMaker,
          accelerator: menuAcceleratorFor('new-maker'),
          registerAccelerator: registerMenuAccelerators,
          click: (_item, _window, event) =>
            dispatchApplicationMenuCommand(
              mainWindow,
              resolveNewMakerMenuCommand(event.triggeredByAccelerator),
            ),
        },
      ],
    },
    { role: 'editMenu' },
    viewMenu,
    {
      label: labels.windowMenu,
      role: 'window',
      submenu: [
        { role: 'minimize', registerAccelerator: registerMenuAccelerators },
        { role: 'zoom' },
        { type: 'separator' },
        // Close 与 Toggle Sidebar 同款 registerAccelerator: false —— 菜单显示
        // ⌘W 标签且点击仍关闭聚焦窗口, 但不向系统注册热键, 让按键流到 renderer:
        // 焦点在右侧栏 (终端 / 文件浏览器等) 内时先关激活 tab, 否则走
        // window-close-self 关(隐藏)窗口 (见 appShortcuts 'close-tab-or-window'
        // 与 MainLayout / SidebarWindowLayout 的消费点)。永不注册, 也就无需吃
        // 录制 gate。
        { role: 'close', registerAccelerator: false },
      ],
    },
    {
      label: labels.helpMenu,
      submenu: [
        {
          label: labels.help,
          click: () => dispatchApplicationMenuCommand(mainWindow, 'open-help'),
        },
        {
          label: labels.releaseNotes,
          click: () => dispatchApplicationMenuCommand(mainWindow, 'open-release-notes'),
        },
        {
          label: labels.issues,
          click: () => dispatchApplicationMenuCommand(mainWindow, 'open-issues'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

let currentApplicationMenuLocale: ApplicationMenuLocale | null = null;

// 快捷键改绑生效: overrides 变化时用当前 locale 全量重建菜单 (与 locale 变更
// 同一路径)。仅用户在设置页保存改绑时触发, 重建瞬间打开着的菜单会收起, 可接受。
// 录制态切换同理重建 —— 录制中菜单不注册 accelerator (见 installApplicationMenu)。
function reinstallApplicationMenuIfPresent(): void {
  const mainWindow = mainWindowRef && !mainWindowRef.isDestroyed() ? mainWindowRef : null;
  if (mainWindow) {
    installApplicationMenu(
      mainWindow,
      currentApplicationMenuLocale ?? getPreferredApplicationLocale(),
    );
  }
}
getAppShortcutStore().subscribe(reinstallApplicationMenuIfPresent);
subscribeAppShortcutRecording(reinstallApplicationMenuIfPresent);

ipcMain.on('app-locale:get-preferred-system-locale-sync', (event) => {
  event.returnValue = getPreferredApplicationLocale();
});

// renderer 侧 MainLayout mount 后主动拉一次冷启动期间缓存的 deep link /
// --open-folder payload。pull-on-mount 路径专用,take 一次清空,重复调安全。
// 详见 deepLink.ts 的 pending buffer 段。
ipcMain.handle('deep-link:take-pending', () => {
  return takePendingDeepLink();
});

ipcMain.handle('app-menu:set-locale', (_event, locale: unknown): { ok: true } => {
  currentApplicationMenuLocale = resolveApplicationMenuLocale(
    typeof locale === 'string' ? locale : null,
  );
  setSelectionContextMenuLocale(currentApplicationMenuLocale);
  setMainLocale(currentApplicationMenuLocale);
  refreshGhostLocalization();
  const mainWindow = mainWindowRef && !mainWindowRef.isDestroyed() ? mainWindowRef : null;
  if (mainWindow) {
    installApplicationMenu(mainWindow, currentApplicationMenuLocale);
  }
  invalidateWindowsTrayMenu();
  getAgentIslandService()?.refreshLocalization();
  return { ok: true };
});

/**
 * Convert POSIX-style absolute paths emitted by Claude Code SDK on Windows
 * (e.g. `/e/AIWork/xdt-maker/...`) into native Win32 paths (`E:\AIWork\...`).
 *
 * On non-Windows platforms this is a no-op — Mac/Linux already use POSIX
 * paths natively and `fs` can read them as-is. On Windows the SDK frequently
 * emits `/x/...` style paths in tool args (Read/Write/Edit `file_path`); the
 * Node `fs` API on Windows treats those as ENOENT, surfacing in the
 * TextLightbox as "File not found".
 */
function posixToWin32(p: string): string {
  if (process.platform !== 'win32' || !p) return p;
  // `/x/rest` → `X:\rest`. Single drive letter only; deeper segments preserved.
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(p);
  if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
  return p;
}

function isPathAllowed(filePath: string): boolean {
  return isPathAllowedAgainst(filePath, SYSTEM_PATH_BLOCKLIST);
}

// 用户双击图标 / 二次启动时,second-instance 事件要把主窗口拉回前台。
// 不能用 BrowserWindow.getAllWindows()[0] —— 临时浮窗/Toast 也属于
// BrowserWindow，[0] 拿到它再 .focus() 等于啥也没干，用户视觉上以为
// "双击启动不了"。
let mainWindowRef: BrowserWindow | null = null;
// 端点清单阻断门:ready 流程走到正常 createWindow() 前置 true。在此之前
// second-instance / activate 一律不许建窗——阻断循环(错误框重试)期间用户
// 双击图标 / 点 Dock 若能建窗,preload 的模块级 sendSync 会因 handler 未注册
// 而白屏,且窗口会带着烘焙端点绕过"拉不到清单不放行"的语义。
let startupWindowCreationAllowed = false;
let appFocusSyncTimer: ReturnType<typeof setTimeout> | null = null;
const providerModelFocusRefreshTracker = createAppFocusAutoRefreshTracker({
  now: Date.now,
  onMeaningfulForeground: () => {
    void requestProviderModelAutoRefresh('foreground');
  },
});
let mainWindowBackgroundThrottlingAllowed = true;
const isUpdateRelaunchCandidate =
  process.platform === 'darwin' && isMacOSUpdateRelaunch(process.argv);
let updatePresentationRecoveryInitialized = false;
const PAGE_ZOOM_LEVEL_MIN = -3;
const PAGE_ZOOM_LEVEL_MAX = 3;
const PAGE_ZOOM_LEVEL_STEP = 0.5;
const pageZoomLevels = new WeakMap<BrowserWindow, number>();

const updatePresentationRecovery = isUpdateRelaunchCandidate
  ? createUpdatePresentationRecoveryController({
      readScreenState: () => {
        try {
          return powerMonitor.getSystemIdleState(1);
        } catch (err) {
          updatePresentationLog.warn('failed to read initial screen lock state', {
            error: err instanceof Error ? err.message : String(err),
          });
          return 'unknown';
        }
      },
      readWindowState: () => {
        const win = mainWindowRef && !mainWindowRef.isDestroyed() ? mainWindowRef : null;
        return { exists: win !== null, focused: win?.isFocused() === true };
      },
      focusWindow: () => {
        focusMainWindow();
      },
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onEvent: (event) => {
        if (event === 'deferred-locked') {
          updatePresentationLog.info('update window activation deferred until screen unlock');
        } else if (event === 'focus-window') {
          updatePresentationLog.info(
            'restoring update-launched window after presentation became available',
          );
        } else if (event === 'paused-unknown') {
          updatePresentationLog.warn(
            'pausing update window recovery until an explicit screen event because state stayed unknown',
          );
        } else {
          updatePresentationLog.warn(
            'abandoning update window recovery after bounded focus attempts were denied',
          );
        }
      },
    })
  : null;

// macOS 原生 app 行为(Slack / VSCode / 微信): 关窗只 hide 不销毁,点 dock 图标
// 直接 show 回来,renderer 不重新加载。Cmd+Q / before-quit 时把这个标志置 true,
// 让窗口 close handler 放行真正的销毁。
let isQuitting = false;
let windowsTray: Tray | null = null;
// 当前的托盘菜单。我们自己 popUp(见 popUpWindowsTrayMenu 的注释),菜单对象必须由
// JS 侧持有,不能只作为实参交出去。语言切换时置 null,下一次右键按新语言重建。
let windowsTrayMenu: Menu | null = null;
const windowsTrayLog = createLogger('windows-tray');
const WINDOWS_CLOSE_PROMPT_FALLBACK_DELAY_MS = 2_000;

function buildWindowsTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: t('settings.windowBehavior.trayMenu.show'),
      click: () => focusMainWindow(),
    },
    { type: 'separator' },
    {
      label: t('settings.windowBehavior.trayMenu.quit'),
      click: () => quitFromWindowsTray(),
    },
  ]);
}

/** 语言切换后丢弃缓存的菜单,下一次右键按新语言重建。 */
function invalidateWindowsTrayMenu(): void {
  windowsTrayMenu = null;
}

function openWindowsTrayMenu(): void {
  // 这条日志是长期诊断留的,不是临时排查: 上游那条弹不出的 bug 是静默失败(不抛错),
  // 所以日志里有没有这一行,是区分 "右键事件没到" 与 "事件到了但菜单没弹" 的唯一依据。
  // 再有用户报 "右键没反应" 时,先让他看这行。
  // 用 info 而不是 debug: packaged 的默认级别就是 info (logger.ts 的 level 解析),
  // debug 会被 shouldLog 过滤掉 —— 那样它恰好在唯一需要它的场景(用户手上的正式包)
  // 里不会出现。频率上也不担心刷屏: 只有用户真的右键托盘图标才会走到这里。
  windowsTrayLog.info('tray right-click received, opening tray menu');
  popUpWindowsTrayMenu<Menu>({
    tray: windowsTray,
    menu: windowsTrayMenu,
    buildMenu: buildWindowsTrayMenu,
    retainMenu: (menu) => {
      windowsTrayMenu = menu;
    },
    onUnavailable: (reason) => {
      windowsTrayLog.warn('tray menu requested without a live tray icon', { reason });
    },
    onError: (error) => {
      windowsTrayLog.error('failed to open Windows tray menu', {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
}

function quitFromWindowsTray(): void {
  requestWindowsTrayQuit({
    hasActiveTurn: () => {
      try {
        return anySessionInTurn(getMakerCore());
      } catch {
        // A failed busy probe must not turn the tray into an unguarded exit path.
        return true;
      }
    },
    confirmQuit: () =>
      dialog.showMessageBoxSync({
        type: 'warning',
        title: t('titleBar.closeConfirm.title'),
        message: t('titleBar.closeConfirm.title'),
        detail: t('titleBar.closeConfirm.description'),
        buttons: [t('titleBar.closeConfirm.cancel'), t('titleBar.closeConfirm.confirm')],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      }) === 1,
    quit: () => app.quit(),
  });
}

function destroyWindowsTray(): void {
  windowsTray?.destroy();
  windowsTray = null;
  windowsTrayMenu = null;
}

function ensureWindowsTray(): boolean {
  if (windowsTray && !windowsTray.isDestroyed()) return true;

  let tray: Tray | null = null;
  try {
    const iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(__dirname, '../../resources/icon.png');
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error(`tray icon is empty: ${iconPath}`);
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
    tray.setToolTip(BRAND_NAME);
    tray.on('click', () => focusMainWindow());
    tray.on('right-click', () => openWindowsTrayMenu());
    windowsTray = tray;
    windowsTrayMenu = null;
    return true;
  } catch (err) {
    // 图标可能已经进了通知区域: 只置 null 会留下一个仍响应左键、却再也引用不到的
    // 僵尸图标(destroyWindowsTray 摸不到它,右键也没有菜单可弹)。
    try {
      tray?.destroy();
    } catch {
      /* 已经没了,忽略 */
    }
    windowsTrayLog.error('failed to create Windows tray icon', {
      error: err instanceof Error ? err.message : String(err),
    });
    windowsTray = null;
    windowsTrayMenu = null;
    return false;
  }
}

function hideMainWindowToWindowsTray(mainWindow: BrowserWindow): void {
  if (ensureWindowsTray()) {
    hideWindowToWindowsTray(mainWindow);
    return;
  }
  dialog.showMessageBoxSync(mainWindow, {
    type: 'error',
    title: t('settings.windowBehavior.trayError.title'),
    message: t('settings.windowBehavior.trayError.message'),
  });
}

function applyWindowsCloseBehavior(
  mainWindow: BrowserWindow,
  behavior: WindowsCloseBehavior,
): void {
  if (behavior === 'tray') {
    hideMainWindowToWindowsTray(mainWindow);
  } else {
    app.quit();
  }
}

function showNativeWindowsCloseBehaviorPrompt(): WindowsCloseBehavior {
  const options = {
    type: 'question' as const,
    title: t('settings.windowBehavior.closePrompt.title'),
    message: t('settings.windowBehavior.closePrompt.message'),
    detail: t('settings.windowBehavior.closePrompt.detail'),
    buttons: [
      t('settings.windowBehavior.closeBehavior.tray'),
      t('settings.windowBehavior.closeBehavior.quit'),
    ],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const mainWindow = mainWindowRef;
  const choice =
    mainWindow && !mainWindow.isDestroyed()
      ? dialog.showMessageBoxSync(mainWindow, options)
      : dialog.showMessageBoxSync(options);
  return choice === 1 ? 'quit' : 'tray';
}

const windowsClosePromptFallback = createWindowsClosePromptFallbackController(
  {
    readBehavior: () => readWindowBehaviorSettings().windowsCloseBehavior,
    showRendererPrompt: () => {
      const mainWindow = mainWindowRef;
      if (!mainWindow) return;
      requestWindowsCloseBehavior(
        mainWindow,
        WINDOW_BEHAVIOR_WINDOWS_CLOSE_BEHAVIOR_REQUESTED_CHANNEL,
      );
    },
    showNativePrompt: showNativeWindowsCloseBehaviorPrompt,
    persistBehavior: writeWindowsCloseBehavior,
    applyBehavior: (behavior) => {
      const mainWindow = mainWindowRef;
      if (mainWindow && !mainWindow.isDestroyed()) {
        applyWindowsCloseBehavior(mainWindow, behavior);
      } else {
        app.quit();
      }
    },
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
  WINDOWS_CLOSE_PROMPT_FALLBACK_DELAY_MS,
);

app.on('before-quit', () => {
  isQuitting = true;
  windowsClosePromptFallback.dispose();
  destroyWindowsTray();
  disposeUpdatePresentationRecovery();
});

function handleUpdatePresentationLock(): void {
  updatePresentationRecovery?.onScreenLock();
}

function handleUpdatePresentationUnlock(): void {
  updatePresentationRecovery?.onScreenUnlock();
}

function handleProviderModelSystemResume(): void {
  void requestProviderModelAutoRefresh('system-resume');
}

function handleProviderModelScreenUnlock(): void {
  void requestProviderModelAutoRefresh('screen-unlock');
}

function initializeUpdatePresentationRecovery(): void {
  if (!updatePresentationRecovery || updatePresentationRecoveryInitialized) return;
  updatePresentationRecoveryInitialized = true;
  powerMonitor.on('lock-screen', handleUpdatePresentationLock);
  powerMonitor.on('unlock-screen', handleUpdatePresentationUnlock);
  updatePresentationRecovery.arm();
  updatePresentationLog.info('armed one-shot update window recovery');
}

function disposeUpdatePresentationRecovery(): void {
  if (!updatePresentationRecoveryInitialized) return;
  powerMonitor.removeListener('lock-screen', handleUpdatePresentationLock);
  powerMonitor.removeListener('unlock-screen', handleUpdatePresentationUnlock);
  updatePresentationRecovery?.dispose();
  updatePresentationRecoveryInitialized = false;
}

function hasFocusedAppWindow(): boolean {
  return BrowserWindow.getAllWindows().some((win) => isFocusedAppContentWindow(win));
}

function syncAppFocusState(clearAttentionWhenFocused = false): void {
  const appFocused = hasFocusedAppWindow();
  providerModelFocusRefreshTracker.sync(appFocused);
  if (appFocused && clearAttentionWhenFocused) clearAllSessionAttention();
  getAgentIslandService()?.setAppFocused(appFocused);
}

function scheduleAppFocusSync(): void {
  if (appFocusSyncTimer) clearTimeout(appFocusSyncTimer);
  appFocusSyncTimer = setTimeout(() => {
    appFocusSyncTimer = null;
    syncAppFocusState();
  }, 0);
}

app.on('browser-window-focus', (_event, win) => {
  if (win === mainWindowRef) updatePresentationRecovery?.onWindowFocused();
  if (appFocusSyncTimer) {
    clearTimeout(appFocusSyncTimer);
    appFocusSyncTimer = null;
  }
  const focusedAppContent = isAppContentWindow(win);
  syncAppFocusState(focusedAppContent);
  if (focusedAppContent) {
    // OAuth and system settings may complete outside Cindy. Focus is a
    // metadata-only fallback wake-up: each pending plugin is re-assessed, but
    // no stored value crosses the change bus.
    const pendingGhostIds = new Set(
      (getGhostSetupInteractionBridge()?.pendingSnapshots() ?? []).map(
        ({ request }) => request.ghost.id,
      ),
    );
    for (const ghostId of pendingGhostIds) {
      getGhostSetupChangeBus().wake(ghostId, { source: 'focus' });
    }
  }
});

app.on('browser-window-blur', () => {
  scheduleAppFocusSync();
});

// mac ⌘W 回归兜底 (Codex review P2): Window > Close 菜单项不再注册 accelerator
// 后, ⌘W 靠 renderer 的 'close-tab-or-window' 消费, 但 OAuth 登录弹窗等
// 非 app-content 窗口不挂 MainLayout / SidebarWindowLayout, 聚焦它们时 ⌘W 会
// 失效。这里对这类窗口在 main 侧补 before-input-event 兜底, 语义 = 原生 role
// close (win.close())。app-content 判定放在按键时刻做 —— markAppContentWindow
// 在窗口构造完成后才打标, browser-window-created 同步 fire 时还看不到。
// 仅 darwin: win/linux 本就没有应用菜单, Ctrl+W 在这些窗口上历史行为就是无操作。
if (process.platform === 'darwin') {
  app.on('browser-window-created', (_event, win) => {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      // 注意不要直接 if (isAppContentWindow(win)) return —— 它是 type guard,
      // 提前 return 会把后续的 win 收窄成 never。
      const isContent: boolean = isAppContentWindow(win);
      if (isContent) return;
      const combos = getAppShortcutStore().getEffectiveCombos('close-tab-or-window');
      if (!combos.some((c) => matchesElectronInput(input, c))) return;
      event.preventDefault();
      if (!win.isDestroyed()) win.close();
    });
  });
}

function applyMainWindowBackgroundThrottling(): void {
  const win = mainWindowRef;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.setBackgroundThrottling(mainWindowBackgroundThrottlingAllowed);
}

function setMainWindowBackgroundThrottlingForActiveTurn(hasRunningTurn: boolean): void {
  const nextAllowed = !hasRunningTurn;
  if (mainWindowBackgroundThrottlingAllowed === nextAllowed) return;
  mainWindowBackgroundThrottlingAllowed = nextAllowed;
  applyMainWindowBackgroundThrottling();
}

function focusMainWindow(): boolean {
  const win = mainWindowRef;
  if (!win || win.isDestroyed()) return false;
  if (!win.isVisible()) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
  // macOS 上从其它前台应用 (如 OAuth 授权后的浏览器) 手里拿回焦点,单靠
  // win.focus() 不可靠;所有调用方都是用户显式"要回到 app"的场景,steal 语义一致。
  if (process.platform === 'darwin') app.focus({ steal: true });
  return true;
}

function roundPageZoomLevel(level: number): number {
  return Math.round(level / PAGE_ZOOM_LEVEL_STEP) * PAGE_ZOOM_LEVEL_STEP;
}

function clampPageZoomLevel(level: number): number {
  return Math.min(PAGE_ZOOM_LEVEL_MAX, Math.max(PAGE_ZOOM_LEVEL_MIN, roundPageZoomLevel(level)));
}

function getPageZoomLevel(mainWindow: BrowserWindow): number {
  return pageZoomLevels.get(mainWindow) ?? 0;
}

function applyPageZoomLevel(mainWindow: BrowserWindow, nextLevel: number): number {
  const zoomLevel = clampPageZoomLevel(nextLevel);
  pageZoomLevels.set(mainWindow, zoomLevel);
  mainWindow.webContents.setZoomLevel(zoomLevel);
  return zoomLevel;
}

function adjustPageZoomLevel(mainWindow: BrowserWindow, delta: number): number {
  return applyPageZoomLevel(mainWindow, getPageZoomLevel(mainWindow) + delta);
}

// ── Custom URL scheme (cindy://... + 历史 xdt-maker://...) ───────────────
// 必须在 app.whenReady() 之前注册:
//   - registerDeepLinkProtocol() 调 setAsDefaultProtocolClient (Windows/Linux
//     写注册表 / .desktop entry; macOS 走 Info.plist, 此调用是兜底)
//   - app.on('open-url') 是 macOS-only 事件, 冷启动时也会在 ready 之前 fire,
//     提前 attach 才能接住
registerDeepLinkProtocol();
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleIncomingDeepLink(url, 'open-url');
});

// macOS Finder "打开方式 → Cindy" 入口:声明 CFBundleDocumentTypes 接受
// public.folder 后,Finder 把目录路径通过 open-file 事件推过来 (冷启动 / 已运行
// 都走此路径)。事件也可能被文件触发:.cindy 意识走双击装入,其余文件
// 静默忽略。
//
// 必须在 app.whenReady() 之前 attach,与 open-url 同理 (冷启动早于 ready 触发)。
//
// Windows / Linux 不触发此事件,无需平台分支。fs.statSync 是同步调用,主进程
// 阻塞 < 10ms,只在用户主动点 Finder 时触发,非热路径,可接受。
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  // mac 双击 .cindy(CFBundleDocumentTypes 关联):装入 + 停靠,文件存在性
  // 校验在处理器内部完成。
  if (filePath.toLowerCase().endsWith('.cindy')) {
    void handleIncomingCindyFile(filePath, 'open-file');
    return;
  }
  try {
    if (!fs.statSync(filePath).isDirectory()) return;
  } catch {
    return; // 路径不存在 / 权限不足 → 静默忽略
  }
  handleIncomingOpenFolder(filePath, 'open-file');
});

// ── Single instance lock ─────────────────────────────────────────────────
// 正常 dev 与 packaged 一律启用。这是把 OS 因深链(cindy://focus 授权返回 /
// cindy://session 等)/ 右键 "通过 Cindy 打开" 而拉起的第二个进程 redirect 成
// "聚焦已运行窗口" 的唯一机制——两个独立 Electron 进程之间没有别的通道能交接焦点。
//
// 锁按 flavor 分域(resolveSingleInstanceLockUserDataDir):packaged 锁真实
// userData(release 之间单实例);dev 锁 `<userData>/dev-single-instance-lock`
// 子目录(dev 之间单实例、深链 redirect 保持有效)。因此 dev 与正式版可以共库
// 双开——这是明确支持的工作流,跨实例并发由 SQLite WAL + busy_timeout、scheduler
// DB 级原子认领、auth replacement-retry 等既有仲裁收敛(与 --passive 共库多开
// 同一套)。2026-07-19 曾让 dev 与 packaged 抢同一把锁(修 dev 深链冷启动重复
// 实例),误伤了 dev + release 双开,2026-07-20 按 flavor 分域恢复,两个目标同时保住。
//
// dev `--passive` 仍完全跳过锁:它的公开契约是与 primary 共享数据任意多开,一个
// primary 后可并行任意多个 preview。此模式没有 second-instance redirect,deep link
// 落到哪个实例由当前 OS 协议注册归属决定。localDb 首次开库时会只读核对
// schema_version、完整 migration history 与 SQL/companion TS runtime 指纹;
// pending / 超前 / drift 都拒绝启动。passive 自己不迁移/repair schema,并用多
// reader lease 阻止之后的 primary 抢跑 migration。
// 隔离数据实例走 `--isolated[=<名字>]`(独立 userData → 独立锁域,见 docs/dev-rules/desktop-development.md)。
if (
  shouldRequestSingleInstanceLock({
    isPackaged: app.isPackaged,
    schedulerPassive: process.env.XDT_SCHEDULER_PASSIVE === '1',
  })
) {
  const realUserDataDir = app.getPath('userData');
  const lockScopeDir = resolveSingleInstanceLockUserDataDir({
    isPackaged: app.isPackaged,
    userDataDir: realUserDataDir,
  });
  let gotTheLock: boolean;
  if (lockScopeDir === realUserDataDir) {
    gotTheLock = app.requestSingleInstanceLock();
  } else {
    // Electron 没有自定义锁作用域的 API:锁文件 / socket 按调用时刻的 userData
    // 路径生成。这里在同步窗口内临时切换 userData 再还原——主进程单线程,中间
    // 不会有其它 JS 观察到临时值;锁建立后内部通道与 userData 后续取值无关。
    fs.mkdirSync(lockScopeDir, { recursive: true });
    app.setPath('userData', lockScopeDir);
    try {
      gotTheLock = app.requestSingleInstanceLock();
    } finally {
      app.setPath('userData', realUserDataDir);
    }
  }
  if (!gotTheLock) {
    markDesktopDevStartupFailed(
      'SINGLE_INSTANCE_OWNED',
      'Another Cindy instance already owns this single-instance lock scope.',
      { userDataDir: realUserDataDir, lockScopeDir },
    );
    app.quit();
  } else {
    app.on('second-instance', (_event, argv) => {
      // Windows: 用户点 cindy://(或历史 xdt-maker://)链接 / 右键 "通过 Cindy 打开" 时,
      // OS 会再起一个本 app 实例; 单例锁把它 redirect 成 second-instance 事件,
      // URL 或 --open-folder 参数都在 argv 里。macOS 不走这个路径(走 open-url),
      // Linux 由 .desktop 决定。
      //
      // 两类入口互斥 (else if):argv 在现实里只会有其一,但如果手工命令行同时
      // 给了两种,优先 deep link URL (历史语义先行,xdt-maker:// 比 --open-folder
      // 早一个版本上线),避免双 dispatch / 双 navigate 让 renderer 看到一闪而过
      // 的中间态。
      const url = findDeepLinkInArgv(argv);
      if (url) {
        handleIncomingDeepLink(url, 'second-instance');
      } else {
        const openFolder = findOpenFolderInArgv(argv);
        if (openFolder) {
          handleIncomingOpenFolder(openFolder, 'second-instance');
        } else {
          // 双击已关联的 .cindy(Windows):装入 + 停靠。
          const openShareFile = findOpenShareFileInArgv(argv);
          if (openShareFile) {
            handleIncomingShareFile(openShareFile, 'second-instance');
          } else {
            const cindyFile = findCindyFileInArgv(argv);
            if (cindyFile) void handleIncomingCindyFile(cindyFile, 'second-instance');
          }
        }
      }
      // 端点清单阻断期间(startupWindowCreationAllowed=false)禁止建窗:
      // 否则 preload 的模块级 sendSync 找不到 handler 直接白屏,且窗口会带着
      // 烘焙端点绕过"拉不到清单不放行"的阻断语义。deep-link 分发不受影响
      // (deepLink 只向已有窗口投递/排队,不建窗)。
      if (startupWindowCreationAllowed && !focusMainWindow()) {
        createWindow();
      }
    });
  }
}

// 冷启动 argv 扫描 — Windows 上首次点链接 / 右键 "通过 Cindy 打开" 启动 app
// 时, URL 或 --open-folder 在 process.argv 末尾。macOS deep link 走 open-url
// (已在上面 attach), 这里扫到也不会重复 dispatch; --open-folder 是 Windows-only
// 入口 (mac 走 LSItemContentTypes / open-file 事件), 也不会在 mac argv 出现。
//
// 同 second-instance:两类入口互斥, 优先 deep link URL。
if (process.platform !== 'darwin') {
  const coldStartUrl = findDeepLinkInArgv(process.argv);
  if (coldStartUrl) {
    handleIncomingDeepLink(coldStartUrl, 'cold-start-argv');
  } else {
    const coldStartOpenFolder = findOpenFolderInArgv(process.argv);
    if (coldStartOpenFolder) {
      handleIncomingOpenFolder(coldStartOpenFolder, 'cold-start-argv');
    } else {
      // 双击已关联的 .cindy 冷启动(Windows):装入发生在窗口创建前,首帧
      // listSync 即含新意识,面板第一帧就位(规则 7)。
      const coldStartShareFile = findOpenShareFileInArgv(process.argv);
      if (coldStartShareFile) {
        handleIncomingShareFile(coldStartShareFile, 'cold-start-argv');
      } else {
        const coldStartCindy = findCindyFileInArgv(process.argv);
        if (coldStartCindy) void handleIncomingCindyFile(coldStartCindy, 'cold-start-argv');
      }
    }
  }
}

// 启动时尝试自注册 Windows 右键菜单(显示文案走 BRAND_NAME)。fire-and-forget,
// 完全不阻塞启动流程;失败仅 warn log。详见 folderContextMenu.ts 模块头注释。
//
// 位置在 single-instance 锁之后,但 app.quit() 不中止顶层同步代码,第二实例
// (gotTheLock=false)仍会执行到这里——三个自愈都是幂等 + 全吞错,重复执行无害,
// 不为此加门控。
if (app.isPackaged) {
  void registerFolderContextMenu();
  // Windows .cindy 文件关联自注册(双击装入意识)。同款 best-effort 口径。
  registerCindyFileAssociation();
  // 品牌改名快捷方式自愈(XDMaker.lnk → Cindy.lnk;差量更新不重跑安装器,
  // 存量用户靠这里换名)。同款 best-effort 口径,详见模块头注释。
  void healWindowsShortcuts();
}

const createWindow = () => {
  const platformOptions =
    process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 16 } }
      : { frame: false };

  // 首次点击是否透传给页面。默认 true(swallow=不透传),等价于 Electron macOS
  // acceptFirstMouse 默认值;用户在 Settings → 窗口行为里可关掉。macOS 上
  // acceptFirstMouse 是 Cocoa 级参数,只在窗口创建时读一次,所以从 userData
  // 落盘文件读取(renderer 每次改动都会 IPC 同步落盘),用户切完开关需要重启
  // 应用 macOS 侧才生效。Windows 上此参数是 no-op(Chromium 忽略),Windows 侧
  // 效果由 renderer 的 swallowActivationClick DOM adapter 承接,即时生效。
  const swallowActivationClick = readWindowBehaviorSettings().swallowActivationClick;

  // Use nativeTheme to pick initial background color matching OS preference,
  // avoiding white flash on startup for dark mode users.
  // mac:创建期即透明底+sidebar 材质(Electron setBackgroundColor 运行时改 alpha 不可靠,是 vibrancy 不透壁纸的根因;非 CINDY 皮肤 body 不透明会自然盖住,视觉无影响)
  const bgColor =
    process.platform === 'darwin'
      ? '#00000000'
      : nativeTheme.shouldUseDarkColors
        ? '#1f1f1e'
        : '#f8f8f6';
  const winBackdropConfig = resolveVibrancyConfig(
    'cindy',
    nativeTheme.shouldUseDarkColors,
    process.platform,
  );

  // Window state persistence (F-WST-1): remembers position / size / maximized
  // / fullscreen across launches. Falls back to the defaults below on first
  // launch or if the saved state is off-screen (the lib clamps for us).
  // Storage: <userData>/window-state.json
  // 改用顶层 import 而不是运行时 require —— Vite 才能 bundle 进 main 产物，
  // 否则 packaged app 因 pnpm hoisted 布局 + electron-packager 只扫
  // apps/desktop/node_modules 而拿不到这个包，运行时报 Cannot find module。
  const mainWindowState = windowStateKeeper({
    defaultWidth: 1280,
    defaultHeight: 800,
  });

  const mainWindow = new BrowserWindow({
    x: mainWindowState.x,
    y: mainWindowState.y,
    width: mainWindowState.width,
    height: mainWindowState.height,
    minWidth: 800,
    minHeight: 600,
    title: BRAND_NAME,
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(__dirname, '../../resources/icon.png'),
    autoHideMenuBar: true,
    show: false,
    backgroundColor: bgColor,
    ...(process.platform === 'win32' && winBackdropConfig.backgroundMaterial
      ? {
          backgroundMaterial: winBackdropConfig.backgroundMaterial,
          backgroundColor: winBackdropConfig.backgroundColor,
        }
      : {}),
    ...(process.platform === 'darwin' ? { vibrancy: 'hud' as const } : {}), // 创建期材质与缺省定稿一致(hud);运行时按主题族经 applyWindowVibrancy 修正
    acceptFirstMouse: !swallowActivationClick,
    ...platformOptions,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false,
      // 默认保留 Chromium 后台节流；只有 active turn 或 terminal grace 期间才由
      // setMainWindowBackgroundThrottlingForActiveTurn 临时关闭，避免后台 idle 常驻耗电。
      backgroundThrottling: true,
      // RSB Phase 4:开启嵌套 `<webview>` 标签,给 web-browser plugin 用。
      // 安全 prefs 全部在 will-attach-webview 阶段被 hardener 强制覆盖
      // (webview-security.ts),renderer 端写的属性不会破坏 guest 隔离。
      // Feishu OAuth 走 will-navigate 自定义 scheme + 主窗自身 webContents,
      // 跟嵌套 webview 是两条独立路径,不受影响。
      webviewTag: true,
      // File drops are handled by renderer attachment/global-drop handlers.
      // Do not let Chromium navigate the main window to a local dropped path
      // when a platform-specific drag event misses a target.
      navigateOnDragDrop: false,
    },
  });
  markAppContentWindow(mainWindow);
  installSelectionContextMenu(mainWindow);
  installWindowResponsivenessDiagnostics(mainWindow, { label: 'main' });
  mainWindowRef = mainWindow;
  applyMainWindowBackgroundThrottling();
  applyPageZoomLevel(mainWindow, 0);
  // Deep link 模块持有同一个 mainWindow 引用 — 解析出的 URL 通过 webContents.send
  // 推给 renderer (channel 'deep-link:navigate')。关窗时同步清空, 避免给已销毁
  // 的 BrowserWindow 发 IPC 触发 'Object has been destroyed'。
  setDeepLinkMainWindow(mainWindow);
  mainWindow.once('closed', () => {
    if (mainWindowRef === mainWindow) mainWindowRef = null;
    pageZoomLevels.delete(mainWindow);
    setDeepLinkMainWindow(null);
  });
  // Main-window close policy is explicit because hidden utility windows (for
  // example the prewarmed global voice overlay) can keep the process alive.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    // macOS: keep the window + renderer alive and hide only, so Dock activation
    // can restore it without remounting the renderer.
    if (process.platform === 'darwin') {
      event.preventDefault();
      if (mainWindow.isFullScreen()) {
        mainWindow.once('leave-full-screen', () => {
          if (!mainWindow.isDestroyed()) mainWindow.hide();
        });
        mainWindow.setFullScreen(false);
      } else {
        mainWindow.hide();
      }
      return;
    }
    // Windows: first close asks once, then either quits or keeps the main window
    // alive in the system tray. Linux keeps the historical quit behavior.
    event.preventDefault();
    if (process.platform === 'win32') {
      const behavior = readWindowBehaviorSettings().windowsCloseBehavior;
      if (!behavior) {
        windowsClosePromptFallback.request();
        return;
      }
      applyWindowsCloseBehavior(mainWindow, behavior);
      return;
    }
    app.quit();
  });
  void ensureMainAppPresence('main-window-created', mainWindow);

  installApplicationMenu(
    mainWindow,
    currentApplicationMenuLocale ?? getPreferredApplicationLocale(),
  );

  // Windows / Linux 没有 Mac 应用菜单 accelerator。主窗口和会话副窗口都走
  // 同一个窗口级安装器，命令发回实际接收按键的窗口；Mac 安装器会直接 no-op。
  installNewMakerWindowShortcut(mainWindow);

  // Wire resize / move / maximize / fullscreen listeners that persist the
  // state to disk on `close`. Must run before any user resize event fires.
  mainWindowState.manage(mainWindow);

  // dev-only:F12 切换 DevTools 的兜底通道。走 before-input-event 在 main 侧
  // 拦截,按键根本不进 renderer —— 不受页面内快捷键系统 / 输入焦点 / 菜单
  // accelerator 注册状态影响,任何 dev 环境都保证能开。F12 未被应用内任何
  // 快捷键占用,无双触发风险;正式包(app.isPackaged)不挂载,零暴露。
  if (!app.isPackaged) {
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        mainWindow.webContents.toggleDevTools();
      }
    });
  }

  // Show window only after content is rendered — eliminates theme flash
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (!app.isPackaged) markDesktopDevWindowReady();
    // `open` may successfully start the updated process while macOS refuses
    // frontmost activation at the lock/login window. Presentation is not an
    // installation-health signal; retain a one-shot focus grant for unlock.
    updatePresentationRecovery?.onWindowReady();
    if (process.env.OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools();
    }
    // 冷启动阶段缓存的 deep link / --open-folder payload 由 MainLayout mount 后
    // 通过 IPC 'deep-link:take-pending' 主动拉取消费 (见 deepLink.ts pending
    // buffer 注释)。这样未登录用户冷启动后完成 Feishu OAuth → MainLayout 第一次
    // mount → 同一条 pull 路径消费 payload, 不会因为登录流程跳过而丢失意图。
  });

  // Notify renderer when fullscreen state changes (macOS traffic-light adaptation).
  // macOS 26 (Tahoe) + Electron 41 上 `will-enter-full-screen` / `will-leave-full-screen`
  // 这两个 macOS 私有事件不再触发,只有动画 END 的 `enter-full-screen` /
  // `leave-full-screen` 还能用。问题:出全屏时红绿灯在动画一开始就回位,但 padding
  // 要等 `leave-full-screen` (动画 END) 才补回去 → 中间几百毫秒红绿灯和工具栏 icon
  // 重叠。退化方案:监听 `resize`,一旦发现处于 fullscreen 标记态但窗口尺寸已经
  // 小于显示器 → 出全屏动画启动了 → 提前发 false 补 padding。`leave-full-screen`
  // 仍保留作兜底。
  let inFullscreen = false;
  mainWindow.on('enter-full-screen', () => {
    inFullscreen = true;
    mainWindow.webContents.send('fullscreen-change', true);
  });
  mainWindow.on('leave-full-screen', () => {
    if (!inFullscreen) return;
    inFullscreen = false;
    mainWindow.webContents.send('fullscreen-change', false);
  });
  mainWindow.on('resize', () => {
    if (!inFullscreen) return;
    const bounds = mainWindow.getBounds();
    const display = screen.getDisplayMatching(bounds);
    if (bounds.width < display.bounds.width || bounds.height < display.bounds.height) {
      inFullscreen = false;
      mainWindow.webContents.send('fullscreen-change', false);
    }
  });

  // 装饰动画闸门的兜底信号。主窗在 running turn 期间会关掉 backgroundThrottling,
  // 那之后 Renderer 的 visibilityState 就不再反映真实可见性,细节见模块头注释。
  installWindowHiddenBroadcast(mainWindow);

  // App badge: 用户把任意 Cindy 窗口点回前台(Dock 点击 / taskbar / alt-tab / 点窗口)即视为
  // 「已查看」,直接清空整个 dock 红点。badge 是 app 级状态,不该依赖当前停在哪个
  // 路由 / 开没开会话 —— 之前清除逻辑寄生在 cc-agent sidebar 且只清 activeSessionId,
  // 离开会话页(设置 / skillhub)或红点属于后台会话时就清不掉。clearAllSessionAttention
  // 只清 app 级 badge,不向 Agent Island 转发逐 session 已读;in-app 的会话小圆点仍由
  // renderer 自行管理(点进会话才消),随后通过 clearSessionAttention 显式同步。
  // Agent Island smart suppression 同样按 app 级焦点判断:主窗 blur 到「在新窗口打开」
  // 的会话副窗时,用户仍在 Cindy 内,不能把 appFocused 置 false。

  // Find-in-page: forward Chromium's match results back to the renderer overlay.
  // The renderer drives findInPage / stopFindInPage via IPC (see registerIpcHandlers).
  mainWindow.webContents.on('found-in-page', (_event, result) => {
    mainWindow.webContents.send('find-in-page:result', {
      requestId: result.requestId,
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches,
      finalUpdate: result.finalUpdate,
    });
  });

  // Global navigation guard — any http(s) link that tries to navigate the
  // main window or open a new window is redirected to the system browser.
  //
  // Dev caveat: in dev the renderer itself is hosted at http://localhost:<port>,
  // so a naive http(s) check would also send our own internal navigations
  // (e.g. notification-click → navigate('/cc-agent/<id>')) out to the system
  // browser. Whitelist the dev server origin so only true externals leak out.
  // Production loads via file:// which never matches the http(s) check, so the
  // whitelist is a no-op there.
  const devOrigin = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin
    : null;
  const isInternalUrl = (url: string): boolean => {
    if (!devOrigin) return false;
    try {
      return new URL(url).origin === devOrigin;
    } catch {
      return false;
    }
  };
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url)) return;
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternalUrl(url)) return { action: 'allow' };
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // ── Renderer 加载失败可观测性(dev + prod)──────────────────────────────────
  // 黑屏三兄弟以前全是「哑弹」:主进程日志零痕迹、窗口永远黑着。这里把它们全部接进
  // 统一日志;dev 下叠加 RendererBootGuard 超时自动 reload 自愈。
  mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    rendererGuardLog.error(`preload-error path=${preloadPath} error=${error.message}`);
  });
  mainWindow.webContents.on('console-message', (details) => {
    // error 恒记;warning 仅 dev(react dev 告警等噪音不进生产日志)。截断防超长堆栈刷屏。
    const { level, message, lineNumber, sourceId } = details;
    if (level === 'error') {
      rendererGuardLog.error(
        `renderer console.error ${sourceId}:${lineNumber} ${message.slice(0, 2000)}`,
      );
    } else if (level === 'warning' && !app.isPackaged) {
      rendererGuardLog.warn(
        `renderer console.warn ${sourceId}:${lineNumber} ${message.slice(0, 2000)}`,
      );
    }
  });
  let devLoadRetries = 0;
  mainWindow.webContents.on(
    'did-fail-load',
    (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      // -3 (ERR_ABORTED) 是正常导航中断(reload / redirect),不是失败。
      if (!isMainFrame || errorCode === -3) return;
      rendererGuardLog.error(
        `did-fail-load code=${errorCode} desc=${errorDescription} url=${validatedURL}`,
      );
      // dev: vite dev server 未就绪 / 短暂竞态 → 定次退避重试,替代永久黑屏。
      if (MAIN_WINDOW_VITE_DEV_SERVER_URL && devLoadRetries < 5 && !mainWindow.isDestroyed()) {
        devLoadRetries += 1;
        const delayMs = 1000 * devLoadRetries;
        rendererGuardLog.info(`retrying loadURL in ${delayMs}ms (attempt ${devLoadRetries}/5)`);
        setTimeout(() => {
          if (!mainWindow.isDestroyed()) void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
        }, delayMs);
      }
    },
  );

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    // dev-only 启动看门狗:renderer 在模块求值期猝死(stale prebundle 等)时页面不触发
    // did-fail-load,唯一可靠判据是「迟迟没有任何 renderer 侧信号」。存活信号由
    // renderer:log IPC 与 check-environment handler 回调 markAlive()(见 registerIpcHandlers)。
    rendererBootGuard?.dispose();
    rendererBootGuard = new RendererBootGuard(mainWindow.webContents, {
      logError: (msg) => rendererGuardLog.error(msg),
      logInfo: (msg) => rendererGuardLog.info(msg),
    });
    rendererBootGuard.start();
    mainWindow.once('closed', () => {
      rendererBootGuard?.dispose();
      rendererBootGuard = null;
    });
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
};

let disposeSkillhubAutoSyncAuthListener: (() => void) | null = null;
let disposeProviderAccessAuthListener: (() => void) | null = null;

const registerIpcHandlers = () => {
  // Find the primary app window, skipping transient utility BrowserWindows like
  // the voice-input overlay (minimizable:false, maximizable:false). Electron's
  // BrowserWindow.getAllWindows() ordering is not guaranteed to be stable across
  // versions / platforms, so once the overlay has been opened once and stays
  // cached (see voice-input/global.ts), [0] could return the overlay — which
  // would silently no-op window-minimize / window-maximize IPC and make the
  // title bar's min/max buttons appear unresponsive.
  const getWindow = () => {
    // 主窗口优先 —— 「在新窗口打开」的副窗口也是普通可最小化窗口, 不能让它在
    // getAllWindows() 里被 isMinimizable() 命中后劫持 badge / notification /
    // fullscreen-state 这些「主窗口语义」的调用。
    if (mainWindowRef && !mainWindowRef.isDestroyed()) return mainWindowRef;
    const windows = BrowserWindow.getAllWindows();
    return windows.find((w) => !w.isDestroyed() && w.isMinimizable()) ?? windows[0];
  };

  registerBillingIpc({
    getMainWindow: () => mainWindowRef,
    requirePersonalAccount: () => {
      requireAppCapability(
        'canUseCindyAccountServices',
        'Billing requires a personal Cindy account.',
      );
      if (authManager.getAuthState().user?.membershipKind !== 'personal') {
        throwIpcError('PERMISSION_DENIED', 'Billing is only available to personal accounts.');
      }
    },
  });

  initAppBadgeService({
    getWindow: () => getWindow() ?? null,
    onSessionAttentionMarked: (sessionId) => {
      getAgentIslandService()?.handleSessionAttentionMarked(sessionId);
    },
    onSessionAttentionCleared: (sessionId, intent) => {
      getAgentIslandService()?.handleSessionAttentionCleared(sessionId, intent);
    },
  });

  // 系统级通知（CC Agent session 完成时弹出 / 可选飞书私聊）
  initNotificationService({
    getWindow: () => getWindow() ?? null,
    feishuIm,
  });
  initAgentIslandService({
    getMainWindow: () => getWindow() ?? null,
    isPlannedRemoteDaemonClose: isCcMgrUpgradeInFlight,
  })?.setAppFocused(hasFocusedAppWindow());
  setSessionsSubscribedListener(() => {
    getAgentIslandService()?.replaySessionActivity();
  });

  // 「在新窗口打开」会话多开 —— 新建一个完整窗口定位到该 session, 初始 bounds 取主窗。
  ipcMain.handle(MAKER_IPC_INVOKE.OPEN_SESSION_IN_NEW_WINDOW, (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throwIpcError('INVALID_PARAMS', 'sessionId required');
    }
    openSessionInNewWindow(sessionId, mainWindowRef);
  });

  // E4D 毛玻璃(R1 audit,用户裁决透壁纸 2026-07-17):仅 CINDY family 启用毛玻璃透壁纸;
  // 其他 family 恢复不透明。macOS 走 setVibrancy + 透明底;Windows 11 走 setBackgroundMaterial
  // (acrylic/mica,见 resolveVibrancyConfig),Windows 10/Linux 回退不透明 surface。
  // family 切换时经 IPC theme:apply-vibrancy 运行时动态调用,同步主窗口与全部副窗口。
  function applyWindowVibrancy(familyId: string, isDark: boolean): void {
    const win = mainWindowRef;
    if (!win || win.isDestroyed()) return;
    const config = resolveVibrancyConfig(familyId, isDark, process.platform);
    if (process.platform === 'darwin') {
      win.setVibrancy(config.vibrancy as 'under-window' | null);
    }
    if (process.platform === 'win32' && config.backgroundMaterial) {
      win.setBackgroundMaterial(config.backgroundMaterial);
    }
    win.setBackgroundColor(config.backgroundColor);
    applyVibrancyToSecondaryWindows(familyId, isDark);
  }

  ipcMain.on('theme:apply-vibrancy', (_event, payload: { familyId: string; isDark: boolean }) => {
    applyWindowVibrancy(payload.familyId, payload.isDark);
  });

  ipcMain.on('get-app-version', (event) => {
    event.returnValue = app.getVersion();
  });

  ipcMain.on('get-os-release', (event) => {
    event.returnValue = os.release();
  });

  // 首启亮色门的同步会话线索(见 authSessionHint.ts):renderer bootstrap 在
  // 任何渲染前判定「真首启」,localStorage 为空但主进程持有存量会话(持久化
  // refresh token / local 模式)时不得激活亮色门,否则已登录暗色用户会先看到
  // 亮色首帧。必须 sendSync——判定发生在首帧之前,异步 IPC 赶不上。
  ipcMain.on('auth:has-persisted-session-hint-sync', (event) => {
    event.returnValue = hasPersistedSessionHint({ userDataPath: app.getPath('userData') });
  });

  ipcMain.on('get-app-display-version-info', (event) => {
    event.returnValue = getAppDisplayVersionInfo();
  });

  // Renderer → main 日志转发:走 unified logger 的 writeFromRenderer,
  // 让 main 的 level filter 生效(scope 加 r: 前缀以区分来源)。
  ipcMain.on(
    'renderer:log',
    (
      _e,
      level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
      scope: string,
      msg: string,
    ) => {
      // renderer 能发日志 = JS 已跑起来 → 解除 dev 启动看门狗(见 renderer-boot-guard.ts)。
      rendererBootGuard?.markAlive();
      writeFromRenderer(level, scope, msg);
    },
  );

  // Maker memory 启动 IPC —— renderer/index.tsx 在 React mount 前调用，用 main 真值
  // 同步 localStorage 并迁移旧 opt-out；时机远早于 splash 后才注册的交互式 maker:*
  // handler，因此独立提前挂载。迁移只会写持久化值，并在 Maker 已被其它启动路径构造
  // 时顺带 disable 现有 manager；不会为迁移而主动构造 Maker。正常 toggle/reset 仍在
  // register.ts 中注册，因为它们依赖 splash 完成后的完整 agent runtime。
  ipcMain.handle(MAKER_IPC_INVOKE.MEMORY_GET_SETTINGS, async () => {
    return readMemorySettings();
  });
  ipcMain.handle(MAKER_IPC_INVOKE.MEMORY_GET_SETTINGS_STATE, async () => {
    return memorySettingsWire();
  });
  ipcMain.handle(
    MAKER_IPC_INVOKE.MEMORY_PRESERVE_LEGACY_MAKER_DISABLED,
    async (_e, legacyRendererValue: unknown) => {
      const parsedLegacyRendererValue =
        legacyRendererValue === true ? true : legacyRendererValue === false ? false : null;
      try {
        const settings = preserveLegacyMakerMemoryDisabled(parsedLegacyRendererValue);
        // renderer migration 可能晚于 splash 创建 Maker。持久化为 false 后必须立即同步
        // 已存在的 manager，避免当前进程继续按旧的 enabled=true 启动新 Session。
        const maker = getMakerIfReady();
        if (!settings.maker && maker?.makerMemory?.isEnabled()) {
          await maker.makerMemory.disable();
          await maker.setAgentMemory('claude-code', settings.claudeCode);
          await maker.setAgentMemory('codex', settings.codex);
        }
        return settings;
      } catch (err) {
        throwIpcError(
          'INTERNAL',
          `memory settings migration failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );
  ipcMain.handle(MAKER_IPC_INVOKE.IM_DEFAULT_SETTINGS_GET, async (_e, rawChannel: unknown) => {
    return imDefaultSettingsWire(parseImDefaultSettingsChannel(rawChannel));
  });
  ipcMain.handle(
    MAKER_IPC_INVOKE.IM_DEFAULT_SETTINGS_SET,
    async (_e, patch: unknown, rawChannel: unknown) => {
      const channel = parseImDefaultSettingsChannel(rawChannel);
      const parsedPatch = parseImDefaultSettingsPatch(patch);
      if (channel === 'wechat' && isWechatUnsupportedPermissionMode(parsedPatch.permissionMode)) {
        throwIpcError('INVALID_PARAMS', 'personal WeChat does not support this permission mode');
      }
      writeImDefaultSettingsPatch(parsedPatch, channel);
      return imDefaultSettingsWire(channel);
    },
  );
  ipcMain.handle(MAKER_IPC_INVOKE.IM_DEFAULT_SETTINGS_RESET, async (_e, rawChannel: unknown) => {
    const channel = parseImDefaultSettingsChannel(rawChannel);
    if (channel) {
      resetImDefaultSettingsChannel(channel);
    } else {
      resetImDefaultSettings();
    }
    return imDefaultSettingsWire(channel);
  });
  ipcMain.handle(MAKER_IPC_INVOKE.SUBAGENT_MODEL_SETTINGS_GET, async () => {
    return subagentModelSettingsWire();
  });
  ipcMain.handle(MAKER_IPC_INVOKE.SUBAGENT_MODEL_SETTINGS_SET, async (_e, patch: unknown) => {
    // 配对一致性按「patch 合并当前存储」判定:有效模型为 null 时来源强制清空,
    // 同时兜住「清模型漏清来源」与「模型未指定时的 provider-only patch」两类孤儿写入。
    writeSubagentModelSettingsPatch(
      reconcileSubagentModelSettingsPatch(
        parseSubagentModelSettingsPatch(patch),
        readSubagentModelSettings(),
      ),
    );
    return subagentModelSettingsWire();
  });
  ipcMain.handle(MAKER_IPC_INVOKE.SUBAGENT_MODEL_SETTINGS_RESET, async () => {
    resetSubagentModelSettings();
    return subagentModelSettingsWire();
  });

  // Claude Code 自动上下文压缩阈值 IPC —— store 跟 Maker 单例无关, 提前注册。
  // buildDesktopClaudeRuntimeConfig.behaviorFlags 是动态 getter, 下个新 session 读到新值。
  ipcMain.handle(MAKER_IPC_INVOKE.SILENT_ENCRYPTED_RETRY_GET, async () => {
    return silentEncryptedRetryWire();
  });
  ipcMain.handle(MAKER_IPC_INVOKE.SILENT_ENCRYPTED_RETRY_SET, async (_e, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'silent encrypted retry enabled required (boolean)');
    }
    writeSilentEncryptedRetryEnabled(enabled);
    return {
      ...silentEncryptedRetryWire(),
      effective: 'immediate' as const,
    };
  });
  ipcMain.handle(MAKER_IPC_INVOKE.SILENT_ENCRYPTED_RETRY_RESET, async () => {
    resetSilentEncryptedRetrySettings();
    return {
      ...silentEncryptedRetryWire(),
      effective: 'immediate' as const,
    };
  });

  ipcMain.handle(MAKER_IPC_INVOKE.COMPACTION_GET_PCT, async () => {
    return readCompactionPct();
  });
  ipcMain.handle(MAKER_IPC_INVOKE.COMPACTION_GET_STATE, async () => {
    return compactionWire();
  });
  ipcMain.handle(MAKER_IPC_INVOKE.COMPACTION_RESET_PCT, async () => {
    resetCompactionPct();
    return compactionWire();
  });
  ipcMain.handle(MAKER_IPC_INVOKE.COMPACTION_SET_PCT, async (_e, pct: unknown) => {
    if (typeof pct !== 'number' || !Number.isFinite(pct)) {
      throwIpcError('INVALID_PARAMS', 'compaction pct required (number)');
    }
    writeCompactionPct(pct);
    return compactionWire();
  });

  // Window behavior —— swallowActivationClick 保持 renderer 运行时事实标准;
  // Windows close behavior 由 main 读写并执行。
  ipcMain.handle(
    WINDOW_BEHAVIOR_SET_SWALLOW_ACTIVATION_CLICK_CHANNEL,
    async (_e, enabled: unknown) => {
      if (typeof enabled !== 'boolean') {
        throwIpcError('INVALID_PARAMS', 'swallowActivationClick required (boolean)');
      }
      writeSwallowActivationClick(enabled);
      return { ok: true as const };
    },
  );
  ipcMain.handle(WINDOW_BEHAVIOR_GET_WINDOWS_CLOSE_BEHAVIOR_CHANNEL, async () => {
    return readWindowBehaviorSettings().windowsCloseBehavior;
  });
  ipcMain.handle(
    WINDOW_BEHAVIOR_SET_WINDOWS_CLOSE_BEHAVIOR_CHANNEL,
    async (_e, behavior: unknown) => {
      if (!isWindowsCloseBehavior(behavior)) {
        throwIpcError('INVALID_PARAMS', 'Windows close behavior required (quit|tray)');
      }
      windowsClosePromptFallback.acknowledge();
      writeWindowsCloseBehavior(behavior);
      if (behavior === 'quit') destroyWindowsTray();
      return behavior;
    },
  );
  ipcMain.on(WINDOW_BEHAVIOR_WINDOWS_CLOSE_BEHAVIOR_SHOWN_CHANNEL, (event) => {
    if (BrowserWindow.fromWebContents(event.sender) === mainWindowRef) {
      windowsClosePromptFallback.acknowledge();
    }
  });
  // LSP Beta 开关 IPC —— 同 compat-mode 模式:
  // GET 给 renderer 启动期同步 localStorage 镜像; SET 落 JSON 文件 + 更新 cache,
  // mcp providers isEnabled 下次 session.start 时读到新值。已开 session 不变。
  ipcMain.handle(MAKER_IPC_INVOKE.LSP_MODE_GET, async () => {
    return readLspModeSettings();
  });
  ipcMain.handle(MAKER_IPC_INVOKE.LSP_MODE_SET, async (_e, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'lsp mode enabled required (boolean)');
    }
    writeLspModeEnabled(enabled);
    return { effective: 'next-session' as const };
  });

  // 智能通讯录 IPC —— 设置开关 + 数据 CRUD(设置页管理 UI 通道), 提前注册。
  registerContactsIpc();

  // 聊天嵌入开关 IPC —— 与 compat-mode 同理提前注册:
  // renderer 启动 bootstrap 同步 localStorage 镜像, 远早于 splash 完成。
  // SET 路径既落 JSON 也立即把 chat-history-embedder 的运行时 enabled 切换 ——
  // toggle off 后下一条新消息就不再入队, 不需要重启。
  ipcMain.handle(MAKER_IPC_INVOKE.CHAT_EMBEDDING_GET, async () => {
    requireAppCapability('canUseCindyGateway', 'Chat embedding requires a Cindy account.');
    return chatEmbeddingWire();
  });
  ipcMain.handle(MAKER_IPC_INVOKE.CHAT_EMBEDDING_SET, async (_e, enabled: unknown) => {
    requireAppCapability('canUseCindyGateway', 'Chat embedding requires a Cindy account.');
    if (typeof enabled !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'chat embedding enabled required (boolean)');
    }
    // 先落盘 setting (即使后续 host 启停失败, 用户偏好已记下, 下次启动会用)
    writeChatEmbeddingEnabled(enabled);
    if (enabled) {
      // ON: 按需启动 embeddingHost (attemptStartEmbeddingHost 内部会读新 settings,
      // setupChatHistoryEmbedder + setChatEmbeddingEnabled(true) 触发 cutoff 写入)。
      // 极少见: host 已 started (理论上不会, 因为 ON→ON 没意义), 直接 setEnabled(true) 触底。
      if (!isEmbeddingHostStarted()) {
        attemptStartEmbeddingHost();
      } else {
        setChatEmbeddingEnabled(true);
      }
    } else {
      // OFF: 先 setEnabled(false) 让 hook 守卫立即生效 (新消息不再 enqueue),
      // 然后 stopEmbeddingHost 清掉 Worker setInterval (彻底没轮询),
      // 最后 reset chat-embedder 模块级 state (cutoff cache / deps), 下次 ON 时重新挂。
      setChatEmbeddingEnabled(false);
      if (isEmbeddingHostStarted()) {
        await stopEmbeddingHost();
        resetChatEmbedderCache();
      }
    }
    return chatEmbeddingWire();
  });
  ipcMain.handle(MAKER_IPC_INVOKE.CHAT_EMBEDDING_RESET, async () => {
    requireAppCapability('canUseCindyGateway', 'Chat embedding requires a Cindy account.');
    const settings = resetChatEmbeddingSettings();
    if (settings.enabled) {
      if (!isEmbeddingHostStarted()) {
        attemptStartEmbeddingHost();
      } else {
        setChatEmbeddingEnabled(true);
      }
    } else {
      setChatEmbeddingEnabled(false);
      if (isEmbeddingHostStarted()) {
        await stopEmbeddingHost();
        resetChatEmbedderCache();
      }
    }
    return chatEmbeddingWire();
  });

  // Git safety settings IPC —— store 独立于 Maker 单例,提前注册以便 renderer
  // 启动时同步本地镜像。SET 只影响之后的 turn 边界,已运行 turn 不追溯。
  ipcMain.handle(MAKER_IPC_INVOKE.GIT_SAFETY_GET, async () => {
    return gitSafetyWire();
  });
  ipcMain.handle(MAKER_IPC_INVOKE.GIT_SAFETY_SET, async (_e, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'git safety enabled required (boolean)');
    }
    writeGitSafetyAutoSnapshotEnabled(enabled);
    return gitSafetyWire();
  });
  ipcMain.handle(MAKER_IPC_INVOKE.GIT_SAFETY_RESET, async () => {
    resetGitSafetySettings();
    return gitSafetyWire();
  });

  // Codex runtime route GET —— 右下角用量 chip 读 app-server 当前 spawn 冻结的鉴权注入方式
  // (oauth-bearer = 走订阅 / env-key = 走网关 / provider-oauth = proxy 注入供应商 OAuth)。
  // 退役全局鉴权开关后已无 SET,只保留 GET;spawn 凭证形态由 provider 选择决定。
  ipcMain.handle(MAKER_IPC_INVOKE.CODEX_RUNTIME_ROUTE_GET, async () => {
    return readCodexRuntimeRoute();
  });

  // cc 默认路由会话的生效计费路由 —— proxy transform 按请求观察进 registry(路由真值),
  // 用量 chip 优先用它显示订阅 / 网关形态(spawn 凭证冻结, 全局活性状态重算会发散)。
  // GET 读最近观察值; 变化时(每会话生命周期通常一次)广播给所有窗口。
  ipcMain.handle(MAKER_IPC_INVOKE.CLAUDE_SESSION_ROUTE_GET, async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
    return readClaudeSessionRoute(sessionId);
  });
  onClaudeSessionRouteChange((sessionId, route) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send(MAKER_PUSH.CLAUDE_SESSION_ROUTE_CHANGED, { sessionId, route });
      } catch {
        /* no-op */
      }
    }
  });

  // ── Claude.ai 订阅 OAuth 登录(浏览器流程,凭证落系统 ~/.claude) ────────────────
  // 与鉴权模式开关正交:管理订阅凭证本身(像 Codex 的 OAuth 登录独立于 API 模式)。
  // Anthropic 模型清单动态发现接线(2026-07-19 统一重构):
  //   - active-catalog 统一收口 capabilities 刷新 + revision 广播;
  //   - SDK supportedModels 捕获(maker-core 会话 init 后上报)是能力字段权威。
  setClaudeSupportedModelsListener(noteAnthropicSdkSupportedModels);
  ipcMain.handle(MAKER_IPC_INVOKE.CLAUDE_OAUTH_STATUS, async () => {
    return { authorized: hasClaudeAiOAuth() };
  });
  ipcMain.handle(MAKER_IPC_INVOKE.CLAUDE_OAUTH_LOGIN, async () => {
    // 拉浏览器 OAuth;成功写凭证。失败 reason(cancelled/timeout/...)是 renderer 决定提示用的结构化
    // 数据,不抛 throwIpcError(符合规则 13 查询型例外:renderer 需要 reason 做不同 UI)。
    const result = await runClaudeOAuthLogin();
    if (result.ok) {
      resetProviderModelAutoRefreshCooldowns('anthropic');
      // 登录可直接覆盖旧账号凭证,不一定先走登出。先跨授权世代清掉旧清单 / 缓存并
      // 等待旧 SDK 持久化收尾;即使后续 proxy 初始化失败也绝不保留 A 账号清单。
      await clearAnthropicDiscoveredModels();
      // oauth 模式 per-model 路由依赖本地 proxy,确保 ready,再广播鉴权态让 Connections 行刷新。
      await ensureAnthropicCompatProxyReady();
      await broadcastClaudeAuthStateChanged();
      // 订阅余量同步: 换号时清旧账号快照 + 拉新账号余量(内部指纹校验), chip 随 push 更新。
      syncClaudeSubscriptionUsageForAuthChange();
      // 模型清单动态发现:登录成功即后台拉 /v1/models(完成后经 active-catalog 广播刷新,
      // 设置页无需等下次会话就能看到清单;失败保留现值,SDK 通道随后仍会精化)。
      void refreshAnthropicModelsFromHttp();
      return { ok: true, authorized: true };
    }
    return { ok: false, reason: result.reason ?? 'unknown', authorized: hasClaudeAiOAuth() };
  });
  ipcMain.handle(MAKER_IPC_INVOKE.CLAUDE_OAUTH_LOGOUT, async () => {
    // disconnect = 先失效 host 刷新器(在途刷新不写回、预续期撤销)再清凭证 —— 直接
    // clearClaudeAiOAuth 会让「已断开」后的在途刷新回写复活凭证(review 2026-07-04 P2)。
    // 清除自带写后校验:写入被截断 / 校验不过会抛 —— 此时**不**广播「已断开」假成功,
    // 如实抛 IPC 错误让 renderer 提示失败(规则 13)。
    try {
      disconnectClaudeAiOAuth();
      resetProviderModelAutoRefreshCooldowns('anthropic');
    } catch (err) {
      throwIpcError(
        'INTERNAL',
        `claude oauth logout failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await broadcastClaudeAuthStateChanged();
    // 订阅余量同步: 凭证已清, read() 会清快照并广播 null, chip 立即回占位态。
    syncClaudeSubscriptionUsageForAuthChange();
    // 模型清单动态发现:登出完成前清空清单 + 删磁盘缓存,并等待旧 SDK 写盘收尾。
    await clearAnthropicDiscoveredModels();
    return { authorized: hasClaudeAiOAuth() };
  });
  ipcMain.handle(MAKER_IPC_INVOKE.CLAUDE_OAUTH_CANCEL, async () => {
    cancelClaudeOAuthLogin();
    return { authorized: hasClaudeAiOAuth() };
  });

  // 上游作废 xAI 凭证、收口自动登出后,走和手动登出完全一致的 UI 收尾(广播 + 清账号级
  // 限流快照),否则用户会停在「显示已连接、请求连环 403」的假状态。
  setXaiAuthInvalidatedHandler(() => {
    resetProviderModelAutoRefreshCooldowns('xai');
    clearXaiRateLimitSnapshot();
    broadcastXaiAuthStateChanged();
  });

  // xAI(SuperGrok 订阅)OAuth —— 与 claude-oauth 同形态。登录成功后 bridge 的 xai provider 立即可用
  // (buildHeaders 每请求现取 token);连接态由 renderer refetch listProviders 时现读 hasGrokOAuthLogin。
  ipcMain.handle(MAKER_IPC_INVOKE.XAI_OAUTH_LOGIN, async () => {
    // reason 是 renderer 决定提示用的结构化数据,不抛 throwIpcError(规则 13 查询型例外)。
    // 登录成功即生效:订阅直连 handler 每请求经 buildHeaders 现取凭证,无需任何"就绪"步骤。
    const result = await runGrokOAuthLogin();
    if (result.ok) {
      resetProviderModelAutoRefreshCooldowns('xai');
      // 登录成功后广播 provider 变更 —— 其它已打开的窗口(聊天/模型选择器等)跟随刷新
      // xAI 连接态,不再等 remount/手动刷新(对齐 CLAUDE_OAUTH_LOGIN 的 broadcastClaudeAuthStateChanged)。
      // 限流快照是账号级的:重登可能换账号,旧快照一并清掉(等新账号首个 xai/ 轮自然补上)。
      clearXaiRateLimitSnapshot();
      broadcastXaiAuthStateChanged();
      return { ok: true, authorized: true };
    }
    return { ok: false, reason: result.reason ?? 'unknown', authorized: hasGrokOAuthLogin() };
  });
  ipcMain.handle(MAKER_IPC_INVOKE.XAI_OAUTH_LOGOUT, async () => {
    try {
      logoutGrok();
      resetProviderModelAutoRefreshCooldowns('xai');
    } catch (err) {
      throwIpcError(
        'INTERNAL',
        `xai oauth logout failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // 登出后同步广播给其它窗口,让已挂载的 useProviders 立刻重拉连接态;
    // 并清掉账号级限流快照 —— 登出后没有下一个成功响应来覆盖,不清会一直挂着旧账号余量。
    clearXaiRateLimitSnapshot();
    broadcastXaiAuthStateChanged();
    return { authorized: hasGrokOAuthLogin() };
  });
  ipcMain.handle(MAKER_IPC_INVOKE.XAI_OAUTH_CANCEL, async () => {
    cancelGrokOAuthLogin();
    return { authorized: hasGrokOAuthLogin() };
  });

  // 窗口控件按 event.sender 解析目标窗口 —— 「在新窗口打开」会有多个完整窗口,
  // min/max 必须操作"点按钮的那个窗口"而非全局主窗。fallback 到 mainWindowRef 兜底
  // 极端情况(sender 已销毁等)。
  ipcMain.on('window-minimize', (event) => {
    (BrowserWindow.fromWebContents(event.sender) ?? mainWindowRef)?.minimize();
  });
  ipcMain.on('window-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindowRef;
    if (!win) return;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });
  // 手动窗口拖拽:no-drag 元素(会话标题文字等,需要同时响应双击)按住移动
  // 时由 renderer 发起,main 用光标位置驱动窗口跟随;pointerup 后 stop。
  // 详见 windowManualDrag.ts 头注释。
  const windowManualDrag = new WindowManualDragController(screen);
  // start / stop 都严格绑定 sender 窗口,解析不到(窗口销毁中)直接忽略,
  // 不 fallback 主窗:多窗口下副窗的延迟消息若落到主窗上,start 会让主窗
  // 意外粘附光标并误停他窗的合法拖拽,stop 会误停主窗拖拽。已销毁窗口的
  // 拖拽由 controller 的 isDestroyed 巡检自停,无需兜底。
  ipcMain.on('window-drag-move-start', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    windowManualDrag.start(win);
  });
  ipcMain.on('window-drag-move-stop', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    windowManualDrag.stop(win);
  });
  // 关闭语义按窗口区分:
  //  - 主窗(Windows): 走 win.close() 触发 close handler,由 handler 决定托盘隐藏或退出。
  //  - 主窗(或解析不到 sender 的兜底,Windows 之外): 自定义 X 语义是"退出 app",
  //    走 app.quit() 才能 trigger before-quit → disposer chain,把 codex 子进程 / im / db
  //    等都收掉;否则 voice overlay 这种 hidden BrowserWindow 还活着,window-all-closed
  //    不 fire,残留进程。
  //  - 「在新窗口打开」的副窗: 只关自己, 不退出 app(会话活在主进程, 不受影响)。
  ipcMain.on('window-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win === mainWindowRef) {
      if (process.platform === 'win32' && win) {
        win.close();
        return;
      }
      app.quit();
      return;
    }
    win.close();
  });
  // mac ⌘W 的窗口级 fallback (renderer 焦点不在右侧栏时调用): 语义 = 原生菜单
  // role close, 即对 sender 窗口 win.close() —— 主窗在 mac 上被 close handler
  // preventDefault 成隐藏, 副窗 / 子窗正常关闭。与上面 'window-close'(自定义
  // X 按钮, 主窗 = 退出 app)是两种不同语义, 不能合并。
  ipcMain.on('window-close-self', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle('page-zoom:in', (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindowRef;
    if (!targetWindow || targetWindow.isDestroyed()) {
      return { ok: true as const, zoomLevel: 0 };
    }
    return {
      ok: true as const,
      zoomLevel: adjustPageZoomLevel(targetWindow, PAGE_ZOOM_LEVEL_STEP),
    };
  });
  ipcMain.handle('page-zoom:out', (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindowRef;
    if (!targetWindow || targetWindow.isDestroyed()) {
      return { ok: true as const, zoomLevel: 0 };
    }
    return {
      ok: true as const,
      zoomLevel: adjustPageZoomLevel(targetWindow, -PAGE_ZOOM_LEVEL_STEP),
    };
  });
  ipcMain.handle('page-zoom:reset', (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindowRef;
    if (!targetWindow || targetWindow.isDestroyed()) {
      return { ok: true as const, zoomLevel: 0 };
    }
    return {
      ok: true as const,
      zoomLevel: applyPageZoomLevel(targetWindow, 0),
    };
  });

  // Fullscreen state query — renderer calls this on mount to recover from the
  // race where `enter-full-screen` fires before the renderer subscribes (e.g.
  // when window-state restores a fullscreen window on launch).
  ipcMain.handle('get-fullscreen-state', (): boolean => {
    const win = getWindow();
    if (!win) return false;
    return win.isFullScreen() || win.isSimpleFullScreen();
  });

  // Find-in-page (F-FIP-1): renderer overlay drives Chromium's native page search.
  // start: returns the requestId Chromium assigns; renderer correlates with the
  // result event sent from createWindow's `found-in-page` listener.
  ipcMain.handle(
    'find-in-page:start',
    (
      event,
      params: {
        text: string;
        forward?: boolean;
        findNext?: boolean;
        matchCase?: boolean;
      },
    ): number | null => {
      const wc = event.sender;
      if (!wc || wc.isDestroyed() || !params?.text) return null;
      return wc.findInPage(params.text, {
        forward: params.forward ?? true,
        findNext: params.findNext ?? false,
        matchCase: params.matchCase ?? false,
      });
    },
  );
  ipcMain.on(
    'find-in-page:stop',
    (
      event,
      action: 'clearSelection' | 'keepSelection' | 'activateSelection' = 'clearSelection',
    ) => {
      const wc = event.sender;
      if (!wc || wc.isDestroyed()) return;
      wc.stopFindInPage(action);
    },
  );

  // Device ID (hardware-based, survives app reinstall)
  const machineId = machineIdSync();
  ipcMain.handle('get-device-id', () => machineId);

  // CC 网络调试开关 — renderer Settings → Experimental "CC 网络调试日志" 操作此值。
  // 改写 process.env.XDT_CC_DEBUG_NET, 让 buildClaudeEnv 在下次 spawn cc 时注入
  // ANTHROPIC_LOG=debug (完整请求含 headers) + NODE_DEBUG=http,https,net,tls + SDK debug:true。
  // 仅对开关后新建的 session 生效。
  //
  // 状态来源 (按优先级):
  //   1. 用户系统环境变量 XDT_CC_DEBUG_NET=1: 老用法, 兼容
  //   2. renderer Settings 开关 (localStorage 持久化, mount 时 IPC 同步过来)
  // dev 模式不再启动期硬开(理由见下方 2290 行附近注释)。
  //
  // packaged 模式下不持久化主进程值: 重启回 off (防止用户忘关导致日志爆炸),
  // renderer 进 Settings 时再 sync 回来。
  const ccDebugNetLog = createSchedulerLogger('cc-debug-net');

  // cc 子进程内部 debug 的 raw 中转文件 (SDK debugFile 选项)。cc 二进制自己 fopen
  // 写它 (我们没法接管), 下面的 tailer 逐行读出后归一化汇入统一 agent 流
  // (agent-<date>.ndjson, source=cc-debug)。文件名带 .raw 表明它是中转、不是最终日志。
  // dev: apps/desktop/logs/cc-debug.raw.log; packaged: <userData>/logs/cc-debug.raw.log。
  // 任何模式下, 只要 XDT_CC_DEBUG_NET=1 就让 SDK 走 debugFile 路, 绕过 SEA stderr 抑制。
  const ccDebugLogPath = path.join(
    !app.isPackaged
      ? path.resolve(__dirname, '../../logs')
      : path.join(app.getPath('userData'), 'logs'),
    'cc-debug.raw.log',
  );
  process.env.XDT_CC_DEBUG_FILE = ccDebugLogPath;

  // 启动期 trim: 跟 logger.ts 同一策略 — 不留 .1 备份, 砍头保尾。cc 子进程
  // 要等用户起 session 才会 fopen 这个文件, 启动期改动安全。dev 模式 cc-debug
  // 一直在写, 不 trim 容易吃掉几百 MB 仓库空间。
  // 顺手清掉历史版本留下的 .1 (上一版本 rotation 产物, 现在不再创建)。
  try {
    fs.unlinkSync(`${ccDebugLogPath}.1`);
  } catch {
    /* not exist */
  }
  let ccDebugSizeBefore = 0;
  try {
    ccDebugSizeBefore = fs.statSync(ccDebugLogPath).size;
  } catch {
    /* not yet */
  }
  keepRecentSync(ccDebugLogPath);
  if (ccDebugSizeBefore > 5 * 1024 * 1024) {
    ccDebugNetLog.info(`trimmed cc-debug.raw.log on startup (was ${ccDebugSizeBefore} bytes)`);
  }
  // per-session raw (sessions/<id>/cc-debug.raw.log) 同样在启动期砍头保尾 —— 它不经 emit,
  // 平时只靠 cleanupOldSessions 30 天整目录删, 期间一个开着 NODE_DEBUG 的活跃 session 能把单个
  // raw 写爆磁盘。内容已被下面的 tailer 汇入 <date>.ndjson, raw 只是中转, 砍掉旧头不丢有效信息。
  keepRecentSessionCcDebugSync();

  // cc-debug.raw.log → 统一 agent 流 (agent-<date>.ndjson, source=cc-debug):
  // cc 子进程通过 SDK debugFile 直接 fopen 写 raw, 不经 logger; 这里轮询读增量,
  // 逐行调 writeCcDebugLine() 解析行首 UTC-ISO 时间戳后归一化写入当天 agent 流,
  // 跟 maker / proxy 两源合并、共用按天 rotate + 保留策略。
  //
  // - 轮询 2s: cc-debug 不是高频热点, 不需要 fs.watch 的实时性 (排序按解析出的 ts,
  //   不受 2s 轮询延迟影响, 延迟只影响"多久可见")
  // - cc 持有 fd 期间我们 rotate 不掉 raw 文件 (Windows rename 失败, Linux truncate
  //   留稀疏空洞, 都不安全), 所以反向走 ─ 读出内容汇入 agent 流, raw 仅启动期 trim
  // - 检测到文件 size 倒退 (truncate / 启动 rename), 重置 read offset 从 0 开始
  // - 跨读保留尾部不完整行, 跟下一段拼起来再切, 不切坏 multi-line 信息
  // - timer.unref() 防止进程关闭时被卡住
  // per-file tail 状态: filePath → { offset, leftover }。同时 tail 全局 fallback raw
  // (无 sessionId 的 cc, 罕见) + 各 sessions/<id>/cc-debug.raw.log; sessionId 从路径
  // 提取后传给 writeCcDebugLine, 让 cc 网络 debug 归到对应 session 的 <date>.ndjson。
  const ccLogRootDir = path.dirname(ccDebugLogPath);
  const ccTailState = new Map<string, { offset: number; leftover: string }>();

  function tailOneCcFile(filePath: string, sessionId: string): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }
    const st = ccTailState.get(filePath);
    if (!st) {
      // 首次发现: 从当前末尾开始, 跳过已有内容 (避免 app 重启后把旧 session 的 raw 重复
      // 灌进 ndjson)。代价是漏掉文件被发现前 ≤ 轮询间隔 的几行初始 cc 日志, 可接受。
      ccTailState.set(filePath, { offset: stat.size, leftover: '' });
      return;
    }
    if (stat.size < st.offset) {
      st.offset = 0;
      st.leftover = '';
    }
    if (stat.size === st.offset) return;
    let fd: number;
    try {
      fd = fs.openSync(filePath, 'r');
    } catch {
      return;
    }
    try {
      const len = stat.size - st.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.offset);
      st.offset = stat.size;
      st.leftover += buf.toString('utf8');
      const lines = st.leftover.split('\n');
      st.leftover = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length > 0) writeCcDebugLine(line, sessionId);
      }
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }

  function tailCcDebugOnce(): void {
    tailOneCcFile(ccDebugLogPath, ''); // 全局 fallback (无 sessionId 的 cc)
    const sessionsBase = path.join(ccLogRootDir, 'sessions');
    let dirs: fs.Dirent[];
    try {
      dirs = fs.readdirSync(sessionsBase, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      tailOneCcFile(path.join(sessionsBase, d.name, 'cc-debug.raw.log'), d.name);
    }
  }
  setInterval(tailCcDebugOnce, 2000).unref();

  // dev 模式不再启动期硬开(2026-07-11 Lizi 定案):NODE_DEBUG=http,https,net,tls
  // 会顺着 cc 子进程继承进 agent 的 Bash 子命令——所有命令输出被调试日志刷屏,
  // 还会污染"断言输出干净"的单测(slack-hook-server 日志脱敏用例实撞)。
  // 需要网络诊断时走 Settings → Experimental 开关,或起 app 前设 XDT_CC_DEBUG_NET=1。

  // release 用户开 Debug 日志时, 把 main/maker logger 也从 info 抬到 debug, 让
  // maker-core 里 session.ts / maker.ts / codex client 的 logger.debug(...) 一起落盘 —
  // 单开 cc 子进程网络日志没意义, 用户排查问题需要全套上下文。
  // dev 模式默认 trace, 不需要也不应被这里改 (会反向降级)。
  // 关回去时恢复原级别 (release 默认 info)。
  let levelBeforeDebugNet: LogLevel | null = null;
  ipcMain.handle('cc:set-debug-net', (_event, enabled: boolean): { ok: true } => {
    if (enabled) {
      process.env.XDT_CC_DEBUG_NET = '1';
      // release: 抬级。dev: 已经是 trace, 跳过。
      if (app.isPackaged) {
        const cur = getLogLevel();
        // 只在比 debug 弱的级别上抬, 避免把用户通过 LOG_LEVEL=trace 的更高诉求降级
        if (cur === 'info' || cur === 'warn' || cur === 'error' || cur === 'fatal') {
          levelBeforeDebugNet = cur;
          setLogLevel('debug');
          ccDebugNetLog.info(`bumped main/maker logger ${cur} → debug`);
        }
      }
    } else {
      delete process.env.XDT_CC_DEBUG_NET;
      if (app.isPackaged && levelBeforeDebugNet) {
        setLogLevel(levelBeforeDebugNet);
        ccDebugNetLog.info(`restored main/maker logger → ${levelBeforeDebugNet}`);
        levelBeforeDebugNet = null;
      }
    }
    ccDebugNetLog.info(`set ${enabled ? 'on' : 'off'} via renderer`);
    return { ok: true };
  });

  // Release notes (per-version, fetched from CDN). Platform is resolved
  // inside the service so renderer never needs to pass it.
  ipcMain.handle('release-notes:fetch', async (_event, version: string) => {
    return fetchReleaseNotes(version);
  });

  // Release notes index — sorted list of every version with a notice on the
  // CDN. Used by the renderer to compute the unread range on cross-version
  // upgrade and pull every intermediate notice.
  ipcMain.handle('release-notes:fetch-index', async () => {
    return fetchReleaseNotesIndex();
  });

  // safeStorage IPC handlers
  const isValidKey = (key: string): boolean => /^[a-zA-Z0-9_-]+$/.test(key);
  const isValidRendererKey = (key: string): boolean =>
    isValidKey(key) && isRendererAccessibleSafeStorageKey(key);
  const resolveSafeStorageFilepath = (key: string): string | null => {
    const scopedKey = resolveOwnerScopedSecretStorageKey(key);
    return scopedKey
      ? path.join(app.getPath('userData'), 'safe-storage', `${scopedKey}.enc`)
      : null;
  };

  // 共用的 api_key 变更后, 若 Codex app-server 以 env-key 启动(无 OAuth,gateway key 冻入
  // 子进程 env)则重建 —— settings 改/删了 key 进程感知不到, 必须重建才生效。oauth-bearer
  // spawn 的 codex 由 proxy 按请求 live 读 gateway key(_readGatewayKey),改 key 无需重建。
  // 严格 gated: 非 api_key / 非 env-key spawn 一律 no-op, 对 Claude 路径零影响 (Claude 每个
  // session 现读 key, 天然跟随)。改 key → env-key codex 新进程用新 key; 删 key → 变未授权。
  const shouldRestartCodexForApiKeyChange = (key: string): boolean =>
    key === 'api_key' && getCodexProxyAuthInjectionState() === 'env-key';

  const prepareApiKeyChangeMaybeRestartCodex = async (
    key: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (!shouldRestartCodexForApiKeyChange(key)) return { ok: true };
    try {
      await prepareCodexForAuthModeChange();
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      createLogger('codex-api-key-restart').warn('prepare before api_key change failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, error };
    }
  };

  const finalizeApiKeyChangeMaybeRestartCodex = async (
    key: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (!shouldRestartCodexForApiKeyChange(key)) return { ok: true };
    try {
      await finalizeCodexAfterAuthModeChange();
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      createLogger('codex-api-key-restart').warn('restart after api_key change failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, error };
    }
  };

  const cancelApiKeyChangeMaybeRestartCodex = (key: string): void => {
    if (!shouldRestartCodexForApiKeyChange(key)) return;
    cancelCodexAuthModeChange();
  };

  const notifyProviderKeyChanged = (providerId: string): void => {
    getGhostSetupChangeBus().emitAll({
      source: 'host_config',
      ref: `provider:${providerId}`,
    });
  };

  ipcMain.handle(
    'safe-storage-store',
    async (event: Electron.IpcMainInvokeEvent, key: string, value: string): Promise<boolean> => {
      try {
        assertTrustedAppRendererEvent(event);
        if (!isValidRendererKey(key)) return false;
        const filepath = resolveSafeStorageFilepath(key);
        if (!filepath) return false;
        if (!safeStorage.isEncryptionAvailable()) return false;
        const encrypted = safeStorage.encryptString(value);
        const prepareResult = await prepareApiKeyChangeMaybeRestartCodex(key);
        if (!prepareResult.ok) return false;
        const dir = path.dirname(filepath);
        const hadPrevious = fs.existsSync(filepath);
        const previousContent = hadPrevious ? fs.readFileSync(filepath, 'utf-8') : null;
        let mutated = false;
        let finalized = false;
        fs.mkdirSync(dir, { recursive: true });
        try {
          fs.writeFileSync(filepath, encrypted.toString('base64'), 'utf-8');
          mutated = true;
          const restartResult = await finalizeApiKeyChangeMaybeRestartCodex(key);
          finalized = restartResult.ok;
          if (restartResult.ok) {
            // 手填 XD key 保存成功:来源标记翻 manual(endpoint 回落编译期常量,
            // 与 model-access 自动下发的 endpoint 解耦,见 credentialsStore 注释)。
            if (key === 'api_key') {
              noteManualXdKeySaved();
              notifyProviderKeyChanged('xd');
            }
            return true;
          }
          if (hadPrevious && previousContent !== null)
            fs.writeFileSync(filepath, previousContent, 'utf-8');
          else if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
          return false;
        } finally {
          if (!finalized) {
            if (!mutated) cancelApiKeyChangeMaybeRestartCodex(key);
          }
        }
      } catch (err) {
        console.error('[safe-storage-store]', err);
        cancelApiKeyChangeMaybeRestartCodex(key);
        return false;
      }
    },
  );

  ipcMain.handle(
    'safe-storage-read',
    async (event: Electron.IpcMainInvokeEvent, key: string): Promise<string | null> => {
      try {
        assertTrustedAppRendererEvent(event);
        if (!isValidRendererKey(key)) return null;
        const filepath = resolveSafeStorageFilepath(key);
        if (!filepath) return null;
        if (!safeStorage.isEncryptionAvailable()) return null;
        if (!fs.existsSync(filepath)) return null;
        const content = fs.readFileSync(filepath, 'utf-8');
        const buffer = Buffer.from(content, 'base64');
        return safeStorage.decryptString(buffer);
      } catch (err) {
        console.error('[safe-storage-read]', err);
        return null;
      }
    },
  );

  ipcMain.handle(
    'safe-storage-remove',
    async (
      event: Electron.IpcMainInvokeEvent,
      key: string,
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        assertTrustedAppRendererEvent(event);
        if (!isValidRendererKey(key)) {
          return { success: false, error: 'invalid key' };
        }
        const filepath = resolveSafeStorageFilepath(key);
        if (!filepath) return { success: true };
        const prepareResult = await prepareApiKeyChangeMaybeRestartCodex(key);
        if (!prepareResult.ok) {
          return { success: false, error: 'codex_restart_failed' };
        }
        const hadPrevious = fs.existsSync(filepath);
        const previousContent = hadPrevious ? fs.readFileSync(filepath, 'utf-8') : null;
        try {
          if (fs.existsSync(filepath)) {
            fs.unlinkSync(filepath);
          }
        } catch (err: unknown) {
          // ENOENT 表示文件已不存在，删除语义保持幂等。
          if (!(
            err instanceof Error &&
            'code' in err &&
            (err as NodeJS.ErrnoException).code === 'ENOENT'
          )) {
            console.error('[safe-storage-remove]', err);
            cancelApiKeyChangeMaybeRestartCodex(key);
            return {
              success: false,
              error: 'remove_failed',
            };
          }
        }
        const restartResult = await finalizeApiKeyChangeMaybeRestartCodex(key);
        if (!restartResult.ok) {
          if (hadPrevious && previousContent !== null) {
            fs.mkdirSync(path.dirname(filepath), { recursive: true });
            fs.writeFileSync(filepath, previousContent, 'utf-8');
          }
          return { success: false, error: 'codex_restart_failed' };
        }
        // 手填 XD key 被删除(断开):清来源标记,endpoint 回落编译期常量。
        if (key === 'api_key') {
          noteManualXdKeyRemoved();
          notifyProviderKeyChanged('xd');
        }
        return { success: true };
      } catch (err: unknown) {
        console.error('[safe-storage-remove]', err);
        cancelApiKeyChangeMaybeRestartCodex(key);
        return {
          success: false,
          error: 'remove_failed',
        };
      }
    },
  );

  // ── Auth IPC handlers (delegated to authManager) ──

  ipcMain.handle('auth:initialize', async () => {
    try {
      let pendingCompletion: Promise<authManager.AuthState> | null = null;
      const state = await authManager.initialize({
        onColdStartPending: (completion) => {
          pendingCompletion = completion;
        },
      });
      if (!app.isPackaged) {
        recordDesktopDevAuthStartupResult(state, pendingCompletion, () =>
          authManager.getAuthState(),
        );
      }
      // 使用统计同意闸的一次性存量迁移:只认冷启动恢复出来的登录态。内部有 guard,
      // 多个窗口各自 initialize 只会评估一次(见 analyticsSettingsService)。
      // 埋点是 best-effort:再包一层 catch,任何异常都不得让这次认证被判失败
      // (那会让用户被归一成未登录)。
      try {
        noteAuthColdStartState(state, pendingCompletion);
      } catch (analyticsErr) {
        console.warn('[analytics] cold-start consent migration failed', analyticsErr);
      }
      return state;
    } catch (err) {
      if (!app.isPackaged) {
        markDesktopDevStartupFailed(
          'AUTH_INIT_FAILED',
          err instanceof Error ? err.message : String(err),
          {
            phase: 'auth:initialize',
          },
        );
      }
      throw err;
    }
  });

  ipcMain.handle('auth:get-login-state', async () => authManager.getLoginState());

  ipcMain.handle('auth:dispatch-login-action', async (_event, action: unknown) => {
    return authManager.dispatchLoginAction(action);
  });

  ipcMain.handle('auth:logout', async () => {
    const releaseBoundary = beginAppSessionBoundary();
    try {
      await teardownAuthAccountBoundary('logout');
      await authManager.logout();
    } finally {
      releaseBoundary();
    }
  });

  ipcMain.handle('auth:enter-local', async () => {
    if (getActiveAppSession().mode === 'local') {
      return authManager.getAuthState();
    }
    await authManager.waitForSessionInvalidation();
    const releaseBoundary = beginAppSessionBoundary();
    try {
      await teardownAuthAccountBoundary('enter-local-mode');
      return authManager.enterLocalMode();
    } finally {
      releaseBoundary();
    }
  });

  ipcMain.handle('auth:exit-local', async () => {
    if (getActiveAppSession().mode !== 'local') {
      throwIpcError('PRECONDITION_FAILED', 'Local mode is not active.');
    }
    const releaseBoundary = beginAppSessionBoundary();
    try {
      await teardownAuthAccountBoundary('exit-local-mode');
      return authManager.exitLocalMode();
    } finally {
      releaseBoundary();
    }
  });

  ipcMain.handle('auth:refresh', async () => {
    return authManager.refresh();
  });

  // ── Account deletion IPC ──
  // Receipt and auth tokens stay in main. A successful confirm first reuses
  // the full logout account-boundary teardown, then clears only this local
  // session (the server has already revoked its refresh family).
  const accountDeletionLog = createLogger('accountDeletion');
  const accountDeletionHandlers = createAccountDeletionIpcHandlers({
    getAvailability: () => authManager.getAccountDeletionAvailability(),
    requestChallenge: () => authManager.requestAccountDeletionChallenge(),
    confirm: (input) => authManager.confirmAccountDeletion(input),
    getStatus: () => authManager.getAccountDeletionStatus(),
    clearReceipt: () => authManager.clearAccountDeletionReceipt(),
    consumeRestoredNotice: () => authManager.consumeAccountDeletionRestoredNotice(),
    isConfirmedLocalSessionCurrent: () => authManager.isConfirmedAccountDeletionSessionCurrent(),
    teardownAccountBoundary: () => teardownAuthAccountBoundary('account-deletion'),
    clearLocalSession: () => authManager.clearLocalSessionAfterAccountDeletion(),
    logWarn: (message, error) => accountDeletionLog.warn(message, error),
  });

  ipcMain.handle('auth:account-deletion:get-availability', () =>
    accountDeletionHandlers.getAvailability(),
  );
  ipcMain.handle('auth:account-deletion:request-challenge', () =>
    accountDeletionHandlers.requestChallenge(),
  );
  ipcMain.handle('auth:account-deletion:confirm', (_event, input: unknown) =>
    accountDeletionHandlers.confirm(input),
  );
  ipcMain.handle('auth:account-deletion:get-status', () => accountDeletionHandlers.getStatus());
  ipcMain.handle('auth:account-deletion:clear-receipt', () =>
    accountDeletionHandlers.clearReceipt(),
  );
  ipcMain.handle('auth:account-deletion:consume-restored-notice', () =>
    accountDeletionHandlers.consumeRestoredNotice(),
  );

  // ── Profile 编辑 IPC(设置 → 用户卡片编辑;业务体在 profileEdit.ts,
  //    资料直写 auth-server,头像经 oss-server 预签名直传) ──

  const profileEditLog = createLogger('profileEdit');
  const profileEditDeps: profileEdit.ProfileEditDeps = {
    getCurrentUserId: () => authManager.getCurrentUserId(),
    getServerProfile: () => authManager.getServerProfile(),
    showAvatarOpenDialog: async () => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: profileEdit.AVATAR_FILE_EXTENSIONS }],
      });
      return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
    },
    readFile: (filePath) => fs.promises.readFile(filePath),
    uploadAvatar: async ({ buffer, mimeType }) => {
      const result = await uploadPublicAsset(
        {
          fetchImpl: (input, init) => net.fetch(input, init),
          getBaseUrl: () => getClientEndpoint('ossApiBaseUrl'),
          getToken: () => authManager.getAccessToken(),
        },
        { scene: 'avatar', contentType: mimeType, body: buffer },
      );
      if (!result.ok && result.status === 401 && result.code === 'ACCOUNT_UNAVAILABLE') {
        void authManager.invalidateSession('account-unavailable');
      }
      return result;
    },
    patchProfile: (patch) => authManager.updateServerProfile(patch),
    logWarn: (message, err) => profileEditLog.warn(message, err),
  };

  const requireCloudProfile = (): void => {
    if (!getAppCapabilities().canUseCindyAccountServices) {
      throwIpcError('PERMISSION_DENIED', 'Profile editing requires a Cindy account.');
    }
  };

  ipcMain.handle('profile:get-state', async () => {
    requireCloudProfile();
    return profileEdit.getProfileEditState(profileEditDeps);
  });

  ipcMain.handle('profile:choose-avatar', async () => {
    requireCloudProfile();
    return profileEdit.chooseAvatarFile(profileEditDeps);
  });

  ipcMain.handle('profile:update', async (_event, params: unknown) => {
    requireCloudProfile();
    return profileEdit.updateProfile(profileEditDeps, params);
  });

  // Google OAuth 集成已于 2026-07-13 随 lizi_google 退役——Google 能力整体
  // 迁入内置意识 filo-google(设置入口在 意识 → Filo Google)。

  // Jira OAuth (Atlassian 3LO + loopback redirect)

  // Slack 官方 MCP OAuth IPC 已于 2026-07-15 退役(能力迁入内置意识 cindy-slack,
  // 授权走 oauth-broker;老账号由 slackAccountsMigration 无感搬入)。

  // GitHub / GitLab PAT IPC 已于 2026-07-14 退役(GitHub 能力迁入内置意识
  // cindy-github,GitLab 能力迁入内置意识 cindy-gitlab)。

  // Maker Core IPC 注册必须等 splash 把 claude/codex binary 都 provision 好之后再做 ——
  // getMaker() 在构造期就读 binary path, 早于 splash 调用会抛错; 第一次 splash 成功后置 true,
  // 后续 retry 走 check-environment 不重复注册 (重复 ipcMain.handle 会覆盖同名 handler)。
  let makerIpcsRegistered = false;
  const registerMakerIpcsAfterSplash = async (): Promise<void> => {
    if (makerIpcsRegistered) return;
    // 模型供应商目录(providers.json)按「OSS 真源 / bundled 兜底」加载一次存内存:必须在第一次
    // getMakerCore()(下面构造 Maker、同步从 getActiveCatalog() 派生 availableModels)之前完成,
    // 否则首个进程会用内置兜底目录派生模型清单。ensureActiveCatalogLoaded 幂等且永不抛
    // (失败回落 bundled),拉取走 splash 期、被进度条盖住。
    await ensureActiveCatalogLoaded();
    // Anthropic-compat 本地代理在 splash 期恒启动 —— 退役兼容模式开关后 proxy 恒在链路里
    // (per-model / per-session 供应商路由都活在 proxy 的 routingTransform 里, 绕过即失效)。
    // 启动失败会 fail-open 回落真上游 + 打 ERROR 日志, 不阻塞 app。
    //
    // ClaudeCodeAgent.runtimeConfig.endpoint 是 getter (见 runtime-configs.ts),
    // 每次 startSession 都重读 getClaudeEndpoint(), proxy 就绪后新建 session 自动用上 loopback。
    //
    // 订阅直连(chatgpt/ / xai/ 前缀)以 localHandler 形态插在本 proxy 的 routingTransform 里
    // (见 anthropic-compat-proxy-host / anthropic-responses-bridge-host),纯内存懒装配,
    // 无独立 server、无启动 / 关停生命周期。
    await ensureAnthropicCompatProxyReady();
    // codex proxy 两种 spawn 形态(oauth-bearer / env-key)都经它出口,首个 codex session spawn 时
    // 由 prepareCodexExtraSpawnConfig 懒启动(幂等);此处不再按全局开关 eager-start。
    try {
      setUpdateAutoRelaunchBusyProbe(async () => {
        // A remote operator may be viewing a live session or file tree without an agent turn.
        // Keep those paths alive, but do not let the lightweight `sessions` list subscription
        // held by every eligible device block updates forever.
        return hasUpdateRelaunchBusyActivity({
          readSynchronousBusy: () =>
            getUpdateRelaunchControllers().length > 0 ||
            hasInFlightRemoteInvokes() ||
            anySessionInTurn(getMakerCore()),
          readScheduleBusy: () => readUpdateRelaunchScheduleBusy(getScheduleStorageIfInitialized()),
        });
      });
      // getMakerCore() 首次调用触发 Maker 构造，同时发起自定义 MCP 初始加载。
      // await 确保第一个会话的 mcpProviders 数组已填入已保存的自定义 MCP（P2 冷启动竞态修复）。
      getMakerCore();
      await waitForInitialCustomMcpRefresh();
      // IPC handlers live for the whole process, while the concrete Maker is
      // replaced at every data-owner boundary. The facade resolves it lazily.
      const ipcMaker = createDynamicMaker(() => {
        if (isAppSessionBoundaryPending()) {
          throwIpcError(
            'PRECONDITION_FAILED',
            'App session is switching; retry after the owner boundary settles.',
          );
        }
        return getMakerCore();
      });
      registerMakerCoreIpc(ipcMaker, {
        onAnySessionTurnKeepaliveChange: (isRunning) => {
          setMainWindowBackgroundThrottlingForActiveTurn(isRunning);
          notifyUpdateAutoRelaunchBusyStateChanged();
        },
        refreshXdGatewayModels,
      });
      registerMakerTitleIpc();
      registerMakerHelpIpc(ipcMaker);
      registerHelpFeedbackIpc();
      registerMakerPlanWriteIpc();
      registerMakerRewindIpc();
      registerMakerForkIpc();
      registerMakerAuthIpc(ipcMaker);
      registerMakerStatusIpc(ipcMaker);
      registerMakerUsageIpc(ipcMaker);
      registerMakerBinaryVersionIpc();
      registerCrossAgentConvertIpc();
      // Workdir File Browser (vscode-style lazy file tree + content viewer for
      // a session's working directory). Pure local fs IO, no Maker dependency,
      // but lives in this block to keep splash-gating simple.
      registerFileBrowserIpc();
      // device-link 远程文件浏览:file-browser:remote-op handler + fs-watch topic
      // 订阅钩子(被控端角色;invoke-registry 捕获后供控制端隧道调用)。
      registerFileBrowserDeviceOp();
      // Remote SSH host management (Phase A) —— 连接管理 + ~/.ssh/config IO,
      // 暂未涉及 agent-on-remote / session 同步,后续 Phase B 扩展。
      registerRemoteSshIpc();
      // Phase D — 启动后台 autoConnect: 把 prefs 里 autoConnect=true 的 host
      // 提前连好, 用户进新建对话点远程项目时不用等。fire-and-forget, 失败仅
      // log.warn, 不阻塞 bootstrap 后续步骤。注意必须在 registerRemoteSshIpc
      // 之后, 因为 startAutoConnect 内部走 ensureHydrated, 而 pool 是 IPC
      // 注册时初始化的。
      void startAutoConnectHostsBackground().catch((err) => {
        // 兜底防止 unhandled promise — startAutoConnect 内部已 allSettled, 这里
        // 只可能是 ensureHydrated 自己炸了 (磁盘故障级), warn 即可。
        createLogger('remote-ssh:auto-connect').warn('startAutoConnectHostsBackground threw', {
          error: String(err),
        });
      });
      // Hook 连接(外部 hook server 接入): IPC 注册 + 按配置拉起启用的连接。
      // 出厂连接列表为空 —— 没配过的用户此处除一次空文件读取外零行为。
      registerHookControlIpc();
      // 项目级文本搜索 (workdir-browse search panel) — spawn 自带 ripgrep,
      // NDJSON 流式回推到 renderer。完全独立于 file-browser 主链路,放这里
      // 仅为同一启动期注册。
      registerSearchIpc();
      // Desktop slash command registry —— 注册 /help /clear 等内置项,
      // IPC 暴露见 maker-ipc/desktop-commands.ts (待 Step 5 添加)。
      // 单例 + 幂等保护 (makerIpcsRegistered flag) 保证 builtins 只灌一次。
      // remoteInvoke:远程会话(ctx.deviceId)的 /goal /learn /cmd 业务体经隧道路由
      // 到被控端 —— 走与 renderer deviceLink.invoke 同一条 handleInvoke 主路径
      // (控制开关校验 + 错误映射一致)。
      registerBuiltinDesktopCommands(getDesktopCommandRegistry(), {
        getGoalController,
        getLearnController,
        remoteInvoke: (deviceId, channel, args) =>
          deviceLinkHandleInvoke(deviceLinkIpcDeps(), deviceId, channel, args),
      });
      // desktop-cmd:run —— /cmd 的被控端远程执行 handler(仅隧道 dispatch 消费,
      // 本机 /cmd 仍在 builtins 内联执行,不走 IPC 往返)。
      registerRemoteCmdIpc();
      // learn:* handler 提前一次性注册(eager,同 goal);handler 内部 getLearnController()
      // 取单例,invoke 时 controller 已由 startLearnHost 启动。
      registerLearnIpc();
      // maker:schedule:* handler 提前一次性注册;handler 内部 awaitReady 等真实
      // scheduler 实例(由后续 attemptStartScheduler 通过 attachSchedulerEventListeners
      // → setSchedulerReady 喂入)。这条修复 cold-start race:之前 handler 在
      // attemptStartScheduler 内才挂,renderer mount useSchedules 落在那 3 秒窗口
      // 内会拿到 "No handler registered" 错误且无 retry → UI 卡死。
      // getMaker 惰性注入:仅「AI 生成前置检查脚本」handler 用(utility model 单次生成),
      // invoke 时才解引用;maker 未就绪时 handler 内部报 INTERNAL 而非注册期崩溃。
      registerScheduleHandlers(() => {
        try {
          return getMakerCore();
        } catch {
          return null;
        }
      });
      // maker:goal:* handler 同样提前一次性注册(eager);handler 内部 getGoalController()
      // 取单例,invoke 时 controller 已由 attemptStartScheduler → startGoalController 启动。
      registerGoalHandlers();
      // clear-context 清目标 / turn 收尾 idle 兜底续跑(setter 注入,null-safe)。
      setGoalClearObserver((sid) => {
        void getGoalController()?.clearGoal(sid);
      });
      setGoalIdleObserver((sid) => {
        void getGoalController()?.maybeContinueActiveGoal(sid);
      });
      // 用户 Stop 当前 turn → 暂停 active 目标。返回 Promise 让 ABORT_SESSION 在 abort 前 await,
      // 确保目标先 paused + detach 监听,abort 终止事件不再触发续跑判定。
      setGoalStopObserver((sid) => getGoalController()?.pauseGoal(sid, 'paused: stopped by user'));
      // (Option B)用户答完 AskUserQuestion → 即时把所选答案改写为目标(仅首轮、且本次确为
      // "目标澄清问题"时改写;controller 内用 questions 的确定性标记 + 多重 guard 把关)。
      setGoalAskAnswerObserver((sid, answers, questions) => {
        // best-effort:目标改写失败不应冒泡成 unhandled rejection(交互解析链路是 fire-and-forget)。
        void getGoalController()
          ?.applyClarificationAnswer(sid, answers, questions)
          .catch(() => {});
      });
      makerIpcsRegistered = true;
      // device-link 捕获自检放在这里(而非 bootstrap 线性段):maker:create-session / maker:send
      // 由上面的 registerMakerCoreIpc 注册,属 splash 后的延迟注册;若在线性段(initDeviceLinkService
      // 之后)就 assert,会误报这两个 sentinel「未捕获」。此刻所有 sentinel(含线性段已注册的
      // local-db:sessions:list)都已就位,自检结果才准确。installInvokeCapture 在 index.ts 最早期
      // patch 了 ipcMain.handle,故无论延迟与否,这些 handler 都已被捕获。
      assertCaptureHealthy();
    } catch (err) {
      console.error('[bootstrap-electron] failed to register maker:* IPC', err);
      // 不阻塞启动 —— 老链路仍可用; 下次 splash retry 再尝试。
    }

    // Phase 3 恢复上次退出时保留的 worktree pool（未被 session 引用的 clean ephemeral → 入池，dirty → 保留，stale → 清除）。
    // 在 scheduler 之前恢复，确保首个 scheduler job 能命中池缓存。
    await WorktreePool.recoverPool().catch((err) => {
      console.error('[bootstrap-electron] recoverPool failed (non-fatal):', err);
    });
    // P0 重构对账:会话已删除(status='deleted' 或行已缺失)但 worktree 回收没跑完
    // (崩溃窗口/回收失败)的孤儿,启动期补一次回收。fire-and-forget,不阻塞启动。
    void reconcileWorktreesForDeletedSessions().catch((err) => {
      console.error('[bootstrap-electron] worktree reconcile failed (non-fatal):', err);
    });

    // Phase 4 Scheduler 启动尝试 —— attemptStartScheduler 是幂等的，
    // 若 localDb 还没 ready (splash 跑得早于 user login)，本次 no-op；
    // 等 'local-db:ensure-ready' IPC onReady 回调时会再触发一次。
    await attemptStartScheduler();
  };

  // Environment check IPC handler — 顺序检查 claude → codex 两个 vendor binary。
  // 提前 peekNeedsDownload 决定 (x/2) 标签：两个都需要下载时给 step/totalSteps，
  // 否则不带标签（splash 显示单一 "唤醒 Cindy 中..." 文案）。
  ipcMain.handle('check-environment', async () => {
    // splash 首个 invoke = renderer 存活的强信号(与 renderer:log 双保险)。
    rendererBootGuard?.markAlive();
    const platform = process.platform as 'darwin' | 'win32' | 'linux';
    // Packaged Linux may install both CLIs during one startup check. Share a
    // single deadline so sequential fallback installs cannot each consume the
    // full timeout.
    const linuxInstallSignal =
      platform === 'linux' && app.isPackaged
        ? AbortSignal.timeout(LINUX_AGENT_INSTALL_STARTUP_DEADLINE_MS)
        : undefined;

    // ── Phase 0: peek 两个 vendor 是否都需要下载（决定 (x/2) 标签）─────────────
    let claudeNeeds = false;
    let codexNeeds = false;
    try {
      claudeNeeds = await binaryPeekNeedsDownload('claude-code');
    } catch {
      /* 保守: peek 失败按 false 处理，进入 prepare 内部错误流程 */
    }
    try {
      codexNeeds = await binaryPeekNeedsDownload('codex');
    } catch {
      /* 同上 */
    }
    const isMultiDownload = claudeNeeds && codexNeeds;

    // ── Phase 1: claude 段 ───────────────────────────────────────────────────
    let claudeRes: PrepareResult;
    try {
      claudeRes = await binaryPrepare(
        'claude-code',
        isMultiDownload
          ? { step: 1, totalSteps: 2, signal: linuxInstallSignal }
          : { signal: linuxInstallSignal },
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        claudeCode: { status: 'failed' as const, error: message },
        codex: { status: 'skipped' as const },
        allPassed: false,
        platform,
      };
    }

    if (!claudeRes.ready || !claudeRes.path) {
      return {
        claudeCode: {
          status: 'failed' as const,
          error: claudeRes.error ?? 'Claude Code binary not available',
        },
        codex: { status: 'skipped' as const },
        allPassed: false,
        platform,
      };
    }

    // setClaudeCodePath 已退役 —— agent-binaries.prepare() 成功时已写 lastReadyPath cache;
    // 任何需要 claude binary 路径的地方一律走 getReadyBinaryPath('claude-code')。

    // ── Phase 2: codex 段 ────────────────────────────────────────────────────
    // 如果 claude 真发生了下载且 codex 也要下载，先广播 reset payload 让 splash 进度条
    // 瞬间归零（不走 transition 动画），随后 codex 段从 0% 开始正常累加。
    if (isMultiDownload && claudeRes.downloaded) {
      binaryBroadcastResetForStep2('codex');
    }

    let codexRes: PrepareResult;
    try {
      codexRes = await binaryPrepare(
        'codex',
        isMultiDownload
          ? { step: 2, totalSteps: 2, signal: linuxInstallSignal }
          : { signal: linuxInstallSignal },
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        claudeCode: { status: 'passed' as const, path: claudeRes.path },
        codex: { status: 'failed' as const, error: message },
        allPassed: false,
        platform,
      };
    }

    if (!codexRes.ready || !codexRes.path) {
      return {
        claudeCode: { status: 'passed' as const, path: claudeRes.path },
        codex: { status: 'failed' as const, error: codexRes.error ?? 'Codex binary not available' },
        allPassed: false,
        platform,
      };
    }

    // 两个 binary 都 ready,现在才能安全构造 Maker 单例并挂 maker:* / 相关 IPC。
    await registerMakerIpcsAfterSplash();

    return {
      claudeCode: { status: 'passed' as const, path: claudeRes.path },
      codex: { status: 'passed' as const, path: codexRes.path },
      allPassed: true,
      platform,
    };
  });

  // Codex 元 IPC (auth/binary/usage) 已升级到 maker:* 命名空间, 详见
  // maker-ipc/auth.ts / status.ts / usage.ts, 注册于 registerMakerIpcsAfterSplash 内。

  const allowedSystemSettingsUrls = new Set([
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  ]);

  // Open external URL in system default browser, plus a small allowlist of
  // macOS Privacy panes that Settings uses for permission onboarding.
  ipcMain.handle(
    'shell:open-external',
    async (_event: Electron.IpcMainInvokeEvent, url: string): Promise<{ success: boolean }> => {
      try {
        const parsed = new URL(url);
        const isWebUrl = parsed.protocol === 'http:' || parsed.protocol === 'https:';
        const isAllowedSystemSettingsUrl =
          process.platform === 'darwin' && allowedSystemSettingsUrls.has(url);
        if (!isWebUrl && !isAllowedSystemSettingsUrl) {
          return { success: false };
        }
        await shell.openExternal(url);
        return { success: true };
      } catch {
        return { success: false };
      }
    },
  );

  // Show native directory picker dialog
  ipcMain.handle(
    'show-open-directory-dialog',
    async (): Promise<{ canceled: boolean; path?: string }> => {
      const targetWin = getWindow() ?? BrowserWindow.getFocusedWindow();
      if (!targetWin) return { canceled: true };
      const result = await dialog.showOpenDialog(targetWin, {
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
      }
      return { canceled: false, path: result.filePaths[0] };
    },
  );

  // ── Workspace scanning for @ mention panel (command-palette F2 / F5) ──
  //
  // Scans the given workingDir for candidate @-mention items:
  //   - `.claude/agents/*.md` → agent items (name = filename without .md)
  //   - regular files & directories (respects common ignored dirs)
  //
  // Returns up to `cap` items total (agents + files + dirs combined). When
  // truncated, the caller should hint the user to narrow the query.
  //
  // This runs on the main process because Node fs is the only reasonable way
  // to walk the tree; renderer cannot do it through contextBridge safely.
  //
  // Performance: BFS with a hard cap (default 2000) and ignore list. On a
  // medium repo this completes in <500ms (spec target).
  ipcMain.handle(
    'workspace:scan-at-resources',
    async (
      _event: Electron.IpcMainInvokeEvent,
      params: { workingDir: string; cap?: number },
    ): Promise<{
      success: boolean;
      error?: string;
      items?: Array<
        | { type: 'file'; name: string; relPath: string }
        | { type: 'dir'; name: string; relPath: string }
        | { type: 'agent'; name: string; relPath: string }
      >;
      truncated?: boolean;
    }> => {
      try {
        // Clamp caller-supplied cap to the spec's 2000 ceiling — even a
        // well-meaning caller shouldn't be able to force us into a scan
        // that pins the event loop on a huge monorepo (review Minor #7).
        const cap = Math.min(params.cap ?? 2000, 2000);
        const root = params.workingDir;
        if (!root || !path.isAbsolute(root) || !fs.existsSync(root)) {
          return { success: false, error: 'workingDir not found' };
        }

        // Minimal ignore list — don't attempt full .gitignore parsing (out of
        // MVP scope per spec). These are the dirs that would blow up a scan.
        const IGNORE_DIRS = new Set([
          '.git',
          'node_modules',
          '__pycache__',
          '.cache',
          '.vscode',
          '.idea',
          '.env',
          'coverage',
          '.sivi',
          '.cursor',
          'build',
          'dist',
          'out',
          '.next',
          '.turbo',
          '.vite',
        ]);

        const items: Array<
          | { type: 'file'; name: string; relPath: string; description?: string }
          | { type: 'dir'; name: string; relPath: string; description?: string }
          | { type: 'agent'; name: string; relPath: string; description?: string }
        > = [];
        let truncated = false;

        // 1) Scan .claude/agents/*.md — silently skip if missing
        try {
          const agentsDir = path.join(root, '.claude', 'agents');
          if (fs.existsSync(agentsDir) && fs.statSync(agentsDir).isDirectory()) {
            const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
            for (const ent of entries) {
              if (ent.isFile() && ent.name.endsWith('.md')) {
                const name = ent.name.replace(/\.md$/, '');
                // Extract description from YAML frontmatter via gray-matter —
                // handles multi-line / quoted / escaped YAML correctly (the
                // earlier hand-rolled regex only matched single-line strings
                // and dropped any `description: |\n  multi line` content).
                let description: string | undefined;
                try {
                  const raw = fs.readFileSync(path.join(agentsDir, ent.name), 'utf-8');
                  const parsed = matter(raw);
                  const desc = parsed.data?.description;
                  if (typeof desc === 'string' && desc.trim()) {
                    description = desc.trim().slice(0, 200);
                  }
                } catch {
                  /* non-fatal */
                }
                items.push({
                  type: 'agent',
                  name,
                  relPath: path.posix.join('.claude', 'agents', ent.name),
                  description,
                });
                if (items.length >= cap) {
                  truncated = true;
                  return { success: true, items, truncated };
                }
              }
            }
          }
        } catch (err) {
          // Non-fatal — agents are a bonus source
          console.warn('[workspace-scan] agents scan failed:', err);
        }

        // 2) BFS walk of workingDir — dirs then files, breadth-first so the
        // caller sees top-level items first and truncation (if any) cuts off
        // the deepest noise, not the most useful results.
        const queue: string[] = [root];
        while (queue.length > 0 && items.length < cap) {
          const cur = queue.shift();
          if (!cur) break;
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(cur, { withFileTypes: true });
          } catch {
            continue;
          }
          // Sort alphabetically for deterministic truncation
          entries.sort((a, b) => a.name.localeCompare(b.name));
          for (const ent of entries) {
            if (items.length >= cap) {
              truncated = true;
              break;
            }
            if (ent.name.startsWith('.') && ent.name !== '.claude') {
              // Skip most dotfiles/dotdirs except .claude (agents handled above)
              continue;
            }
            if (ent.isDirectory()) {
              if (IGNORE_DIRS.has(ent.name)) continue;
              const abs = path.join(cur, ent.name);
              const rel = path.relative(root, abs).split(path.sep).join('/');
              // `.claude/agents` is handled by step 1 as `type:'agent'` —
              // skip the subtree here so we don't double-report the same
              // *.md files as `type:'file'` entries (review Important #3).
              if (rel === '.claude/agents') continue;
              items.push({ type: 'dir', name: ent.name, relPath: rel });
              queue.push(abs);
            } else if (ent.isFile()) {
              const abs = path.join(cur, ent.name);
              const rel = path.relative(root, abs).split(path.sep).join('/');
              items.push({ type: 'file', name: ent.name, relPath: rel });
            }
          }
        }
        if (items.length >= cap && queue.length > 0) truncated = true;

        return { success: true, items, truncated };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[workspace:scan-at-resources] Failed:', err);
        return { success: false, error: message };
      }
    },
  );

  // Scans `{workingDir}/.claude/commands/*.md` and `.claude/skills/*.md` for
  // user-defined slash commands / skills (command-palette F1).
  // Returns [] if dirs don't exist. No recursion.
  ipcMain.handle(
    'workspace:scan-slash-commands',
    async (
      _event: Electron.IpcMainInvokeEvent,
      params: { workingDir: string },
    ): Promise<{
      success: boolean;
      error?: string;
      commands?: Array<{ name: string; description?: string; source?: 'user' | 'skill' }>;
    }> => {
      try {
        const root = params.workingDir;
        if (!root || !path.isAbsolute(root) || !fs.existsSync(root)) {
          return { success: true, commands: [] };
        }

        /**
         * Parse YAML frontmatter `description` from a .md file's raw content.
         * Uses js-yaml for proper YAML parsing (matches cc-code's approach).
         * Falls back to the first non-empty, non-heading body line.
         */
        const parseDescription = (raw: string): string | undefined => {
          const fmMatch = raw.match(/^---\s*\n([\s\S]*?)---\s*\n?/);
          if (fmMatch) {
            try {
              const parsed = yaml.load(fmMatch[1] || '') as Record<string, unknown> | null;
              if (parsed && typeof parsed === 'object' && typeof parsed.description === 'string') {
                const desc = parsed.description.trim();
                if (desc) return desc.slice(0, 200);
              }
            } catch {
              /* YAML parse error — fall through to body extraction */
            }
          }
          // Fallback: first non-empty, non-heading body line
          const bodyStart = fmMatch ? raw.indexOf(fmMatch[0]) + fmMatch[0].length : 0;
          const firstLine = raw
            .slice(bodyStart)
            .split(/\r?\n/)
            .map((l) => l.trim())
            .find((l) => l.length > 0 && !l.startsWith('#') && l !== '---');
          return firstLine?.slice(0, 200);
        };

        /**
         * Scan `.claude/commands/` — flat .md files: `commands/{name}.md`
         */
        const scanCommands = (
          dirPath: string,
        ): Array<{ name: string; description?: string; source: 'user' | 'skill' }> => {
          if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return [];
          const entries = fs.readdirSync(dirPath, { withFileTypes: true });
          const results: Array<{ name: string; description?: string; source: 'user' | 'skill' }> =
            [];
          for (const ent of entries) {
            if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
            const name = ent.name.replace(/\.md$/, '');
            let description: string | undefined;
            try {
              const raw = fs.readFileSync(path.join(dirPath, ent.name), 'utf-8');
              description = parseDescription(raw);
            } catch {
              /* non-fatal */
            }
            results.push({ name, description, source: 'user' });
          }
          return results;
        };

        /**
         * Scan `.claude/skills/` — subdirectory per skill: `skills/{name}/SKILL.md`
         * (or `skill.md`, case-insensitive).
         */
        const scanSkills = (
          dirPath: string,
        ): Array<{ name: string; description?: string; source: 'user' | 'skill' }> => {
          if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return [];
          const entries = fs.readdirSync(dirPath, { withFileTypes: true });
          const results: Array<{ name: string; description?: string; source: 'user' | 'skill' }> =
            [];
          for (const ent of entries) {
            if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
            // Look for SKILL.md or skill.md inside the subdirectory
            const subDir = path.join(dirPath, ent.name);
            const skillFile = ['SKILL.md', 'skill.md'].find((f) =>
              fs.existsSync(path.join(subDir, f)),
            );
            if (!skillFile) continue;
            let description: string | undefined;
            try {
              const raw = fs.readFileSync(path.join(subDir, skillFile), 'utf-8');
              description = parseDescription(raw);
            } catch {
              /* non-fatal */
            }
            results.push({ name: ent.name, description, source: 'skill' });
          }
          return results;
        };

        // Scan global (~/.claude/) first, then project (overrides on name
        // collision) — matches Claude Code's own discovery precedence and
        // covers Market-installed skills which always land in ~/.claude/skills/.
        const home = os.homedir();
        const merged = new Map<
          string,
          { name: string; description?: string; source: 'user' | 'skill' }
        >();
        for (const cmd of [
          ...scanCommands(path.join(home, '.claude', 'commands')),
          ...scanSkills(path.join(home, '.claude', 'skills')),
          ...scanCommands(path.join(root, '.claude', 'commands')),
          ...scanSkills(path.join(root, '.claude', 'skills')),
        ]) {
          merged.set(cmd.name, cmd);
        }
        const commands = Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
        return { success: true, commands };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message };
      }
    },
  );

  registerSkillhubIpc({ getMaker: getMakerCore });
  disposeSkillhubAutoSyncAuthListener = authManager.onAuthStateChange((state) => {
    if (!state.isAuthenticated) return;
    void skillhubAutoSyncService.runOnceAfterLogin();
  });
  disposeProviderAccessAuthListener = authManager.onAuthStateChange(() => {
    refreshProviderAccessAfterAuthChange();
  });

  // ── Dialog: 目录选择器（v0.6 新增，与旧 show-open-directory-dialog 并存） ──
  ipcMain.handle(
    'dialog:show-open-directory',
    async (_event, { defaultPath }: { defaultPath?: string } = {}) => {
      const targetWin = getWindow() ?? BrowserWindow.getFocusedWindow();
      if (!targetWin) return { success: true, path: null };
      const result = await dialog.showOpenDialog(targetWin, {
        // createDirectory:macOS 显示"新建文件夹"按钮(Windows 自带);
        // 否则用户在 picker 里没法当场建一个目标目录,只能先去 Finder 建。
        properties: ['openDirectory', 'createDirectory'],
        ...(defaultPath ? { defaultPath } : {}),
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { success: true, path: null };
      }
      return { success: true, path: result.filePaths[0] };
    },
  );

  // ── Dialog: 文件选择器(前置检查脚本选取等通用场景;与目录选择器同形) ──
  ipcMain.handle(
    'dialog:show-open-file',
    async (
      _event,
      { defaultPath, filters }: { defaultPath?: string; filters?: Electron.FileFilter[] } = {},
    ) => {
      const targetWin = getWindow() ?? BrowserWindow.getFocusedWindow();
      if (!targetWin) return { success: true, path: null };
      const result = await dialog.showOpenDialog(targetWin, {
        properties: ['openFile'],
        ...(defaultPath ? { defaultPath } : {}),
        ...(filters ? { filters } : {}),
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { success: true, path: null };
      }
      return { success: true, path: result.filePaths[0] };
    },
  );

  // (api-key:test-connection 已随手填录入链路移除,2026-07-17:XD 网关 key 一律由
  //  model-access 自动下发,连通性由同步状态机负责。)

  // ── Generic API request proxy: 已移除(2026-07 apiBaseUrl 清理)──
  // 曾经的 `api:request`(renderer → main → 主 server)通用代理随最后一个
  // 调用者(meService GET /api/me,产品 role 已退役)一起拆除。renderer 从此
  // 对业务 server 零请求;main 内部调用走 serverApiClient.serverApiFetch。

  // ── API Key refresh from server: 已移除 ──
  // XD 网关 key / Mivo key 均为本地 only(safeStorage),没有服务器副本,
  // 因此不再提供 `*:refresh-from-server` 拉取通道。本地 key 失效时由用户在设置里重填。

  // ── File attachment IPC (F-FI-7) ──
  ipcMain.handle(
    'read-file-for-attachment',
    async (
      _event: Electron.IpcMainInvokeEvent,
      params: {
        filePath: string;
        encoding: 'base64' | 'utf8';
        maxSize?: number;
      },
    ): Promise<{
      success: boolean;
      error?: string;
      data?: string;
      size: number;
      truncated?: boolean;
    }> => {
      try {
        const { filePath, encoding } = params;
        const maxSize = Math.min(params.maxSize ?? 30 * 1024 * 1024, 30 * 1024 * 1024);

        if (!path.isAbsolute(filePath)) {
          return { success: false, error: 'Path must be absolute', size: 0 };
        }
        if (!isPathAllowed(filePath)) {
          return { success: false, error: '不允许访问该路径', size: 0 };
        }

        const stat = await fs.promises.stat(filePath);
        const size = stat.size;

        if (size > maxSize) {
          return { success: false, error: 'File too large', size };
        }

        if (encoding === 'base64') {
          const buffer = await fs.promises.readFile(filePath);
          return { success: true, data: buffer.toString('base64'), size, truncated: false };
        }

        // utf8 mode
        const TEXT_LIMIT = 1 * 1024 * 1024; // 1MB
        if (size > TEXT_LIMIT) {
          // Read only the first 1MB
          const fileHandle = await fs.promises.open(filePath, 'r');
          try {
            const buf = Buffer.alloc(TEXT_LIMIT);
            await fileHandle.read(buf, 0, TEXT_LIMIT, 0);
            return { success: true, data: buf.toString('utf8'), size, truncated: true };
          } finally {
            await fileHandle.close();
          }
        }

        const data = await fs.promises.readFile(filePath, 'utf8');
        return { success: true, data, size, truncated: false };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err), size: 0 };
      }
    },
  );

  // Read a local file's raw bytes for in-app rendering (currently PDF preview).
  // Returns a Uint8Array over structured clone instead of base64: pdf.js
  // getDocument({ data }) wants bytes, and skipping base64 avoids a large
  // transient string plus a main-thread atob/charCodeAt decode loop in the
  // renderer. Same 30MB cap as read-file-for-attachment.
  //
  // Path policy is the SENSITIVE-MEDIA blocklist, not the system one used by the
  // attachment IPCs: this channel replaces the xdt-file:// protocol as the byte
  // source for PDF preview, and that protocol denies credential / browser-profile
  // dirs (localFileProtocol.ts). Previewing files out of an agent-writable
  // workdir means the click authorizes "show this PDF", not "read wherever this
  // symlink points", so the stricter list is the right one — a workdir
  // `leak.pdf -> ~/.ssh/id_rsa` must not reach the renderer here when the
  // protocol it replaced would have refused it. Sibling ImagePreview still goes
  // through xdt-file://, so this keeps one policy across the file browser.
  ipcMain.handle(
    'read-file-bytes',
    async (
      event: Electron.IpcMainInvokeEvent,
      params: { filePath: string; maxSize?: number },
    ): Promise<{ bytes: Uint8Array; size: number }> => {
      // Reject any caller that is not the trusted main app renderer — an
      // auxiliary window / child frame / webview bearing the shared preload
      // must not be able to pull raw file bytes. Mirrors the shell:open-path
      // policy (assertTrusted + isPathAllowed) for a path-taking privileged IPC.
      assertTrustedAppRendererEvent(event);
      // Validation + policy + regular-file + size-cap + exact-copy live in the
      // injectable core (fileReadBytes.ts) so they are unit-tested without
      // Electron; failures throw a sanitized IpcError that rejects the invoke().
      // O_NOFOLLOW on the final component: the core opens the realpath'd target,
      // whose last segment is a real file — so a legit open succeeds, but if the
      // final component was swapped to a symlink in the realpath→open race it
      // fails (ELOOP) instead of following into a denied file. Falls back to 0
      // where the platform lacks the flag (Windows), matching saveChatAttachment.
      const noFollow =
        typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
      return readFileBytesForPreview(params, {
        isPathAllowed: (p) => isPathAllowedAgainst(p, getSensitiveMediaBlocklist()),
        realpath: (p) => fs.promises.realpath(p),
        // bigint stats: dev/ino identity must not be rounded (see FileIdentityStat).
        stat: (p) => fs.promises.stat(p, { bigint: true }),
        open: async (p) => {
          const handle = await fs.promises.open(p, fs.constants.O_RDONLY | noFollow);
          return {
            stat: () => handle.stat({ bigint: true }),
            read: (buffer, offset, length, position) =>
              handle.read(buffer, offset, length, position),
            close: () => handle.close(),
          };
        },
      });
    },
  );

  // ── File header peek IPC (F-FI-8 fallback inference) ──
  // Read at most `bytes` (default 8192, hard-cap 64KB) from the head of a file
  // for the renderer to run magic-bytes + UTF-8 sniffing on. Independent from
  // read-file-for-attachment because:
  //   - returns actualBytes / totalSize, not size / truncated
  //   - has no maxSize restriction (peek a head of any file size)
  //   - permission policy may evolve independently
  ipcMain.handle(
    'peek-file-header',
    async (
      _event: Electron.IpcMainInvokeEvent,
      params: {
        filePath: string;
        bytes?: number;
      },
    ): Promise<{
      success: boolean;
      error?: string;
      data?: string;
      actualBytes: number;
      totalSize: number;
    }> => {
      try {
        const { filePath } = params;
        const HARD_CAP = 64 * 1024;
        const requested = Math.max(0, Math.min(params.bytes ?? 8192, HARD_CAP));

        if (!path.isAbsolute(filePath)) {
          return { success: false, error: 'Path must be absolute', actualBytes: 0, totalSize: 0 };
        }
        if (!isPathAllowed(filePath)) {
          return { success: false, error: '不允许访问该路径', actualBytes: 0, totalSize: 0 };
        }

        const stat = await fs.promises.stat(filePath);
        const totalSize = stat.size;

        if (totalSize === 0) {
          return { success: true, actualBytes: 0, totalSize: 0 };
        }

        const toRead = Math.min(requested, totalSize);
        if (toRead === 0) {
          return { success: true, actualBytes: 0, totalSize };
        }

        const fileHandle = await fs.promises.open(filePath, 'r');
        try {
          const buf = Buffer.alloc(toRead);
          const { bytesRead } = await fileHandle.read(buf, 0, toRead, 0);
          const slice = buf.subarray(0, bytesRead);
          return {
            success: true,
            data: slice.toString('base64'),
            actualBytes: bytesRead,
            totalSize,
          };
        } finally {
          await fileHandle.close();
        }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          actualBytes: 0,
          totalSize: 0,
        };
      }
    },
  );

  // ── TextLightbox IPC (text-lightbox F4/F5) ──
  //
  // Reads a text file for the TextLightbox preview. Hard cap is 20 MB per
  // text-lightbox spec; over-cap files are rejected with `oversize` so the
  // renderer can render the Oversize body without re-statting the file.
  // Reuses the same `isPathAllowed` blocklist as file-attachment IPCs.
  ipcMain.handle(
    'text-file:read-preview',
    async (
      _event: Electron.IpcMainInvokeEvent,
      params: { filePath: string },
    ): Promise<{
      success: boolean;
      error?: string;
      /** 'oversize' = file > MAX_PREVIEW_MB; renderer should switch to Oversize body. */
      reason?: 'oversize' | 'not_found' | 'forbidden' | 'read_failed';
      data?: string;
      size: number;
      /** Preview cap in MB — surfaced so renderer can render dynamic copy
       * ("exceeding the {limitMb} MB preview limit") without hard-coding. */
      limitMb?: number;
    }> => {
      try {
        // SDK on Windows emits POSIX-style file_path (`/e/AIWork/...`); convert
        // to native Win32 (`E:\AIWork\...`) before any path checks or fs calls.
        // No-op on Mac/Linux. See posixToWin32() above for context.
        const filePath = posixToWin32(params.filePath);
        // text-lightbox spec — F5 阈值。Surface MB constant so the value is
        // single-sourced for both the byte comparison and the IPC response
        // (renderer reads `limitMb` to render dynamic copy).
        // 10MB:预览走同步全文读 + 主线程高亮渲染,再大会明显卡;附件走路径透传
        // 不占这条预览成本(附件层已不在 renderer 做大小限制),两者解耦。
        const MAX_PREVIEW_MB = 10;
        const MAX_PREVIEW = MAX_PREVIEW_MB * 1024 * 1024;

        if (!filePath || !path.isAbsolute(filePath)) {
          return {
            success: false,
            error: 'Path must be absolute',
            reason: 'forbidden',
            size: 0,
            limitMb: MAX_PREVIEW_MB,
          };
        }
        if (!isPathAllowed(filePath)) {
          return {
            success: false,
            error: '不允许访问该路径',
            reason: 'forbidden',
            size: 0,
            limitMb: MAX_PREVIEW_MB,
          };
        }

        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(filePath);
        } catch {
          return {
            success: false,
            error: 'File not found',
            reason: 'not_found',
            size: 0,
            limitMb: MAX_PREVIEW_MB,
          };
        }
        const size = stat.size;

        if (size > MAX_PREVIEW) {
          // Don't read the body — renderer will switch to Oversize view based
          // on `reason: 'oversize'` and use `size` for the dynamic copy.
          return { success: false, reason: 'oversize', size, limitMb: MAX_PREVIEW_MB };
        }

        const data = await fs.promises.readFile(filePath, 'utf8');
        return { success: true, data, size, limitMb: MAX_PREVIEW_MB };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          reason: 'read_failed',
          size: 0,
          limitMb: 10,
        };
      }
    },
  );

  // ── markdown-monorepo-resolve: smart relative-path resolver ──────────────
  // Implementation lives in ./pathResolver (pure module, unit-tested). This
  // handler just enforces the IPC contract and injects `isPathAllowed` so
  // candidates are subject to the same allow-list as direct file reads.
  ipcMain.handle(
    'fs:resolve-path',
    async (
      _event: Electron.IpcMainInvokeEvent,
      params: { href: string; workingDir: string },
    ): Promise<{
      status: 'unique' | 'multiple' | 'none';
      candidates: string[];
      kind?: 'file' | 'directory';
    }> => {
      try {
        return await resolveWorkspacePathCached(params.href, params.workingDir, {
          isPathAllowed,
        });
      } catch (err) {
        console.error('[fs:resolve-path] failed:', err);
        return { status: 'none', candidates: [] };
      }
    },
  );

  // markdown-monorepo-resolve: BATCH resolver. The markdown renderer resolves
  // every path-shaped target eagerly at render time (chip only when a path
  // uniquely resolves). Switching to a session with hundreds of such targets
  // used to fire hundreds of independent `fs:resolve-path` calls, each doing
  // its own full *synchronous* workspace BFS — the main process froze for
  // seconds. This collapses one render pass's hrefs into a single async walk.
  ipcMain.handle(
    'fs:resolve-path-batch',
    async (
      _event: Electron.IpcMainInvokeEvent,
      params: { hrefs: string[]; workingDir: string },
    ): Promise<
      Record<string, { status: 'unique' | 'multiple' | 'none'; candidates: string[] }>
    > => {
      try {
        return await resolveWorkspacePathBatchCached(params.hrefs, params.workingDir, {
          isPathAllowed,
        });
      } catch (err) {
        createLogger('fs:resolve-path-batch').error('failed', { error: String(err) });
        const fallback: Record<
          string,
          { status: 'unique' | 'multiple' | 'none'; candidates: string[] }
        > = {};
        for (const href of params.hrefs ?? []) {
          fallback[href] = { status: 'none', candidates: [] };
        }
        return fallback;
      }
    },
  );

  // file-chip 右键菜单 "在浏览器中查看":拿绝对路径,校验扩展名在 HTML
  // 白名单内,然后 shell.openExternal(file:// URL) 走系统默认 file://
  // 处理器(绝大多数 OS 上 .html/.htm 都映射到默认浏览器)。和
  // `shell:open-external` 分开是因为后者只放行 http(s) 防滥用;这里收窄到
  // 受控的扩展名集合后,放行 file:// 是可控的。
  ipcMain.handle(
    'shell:open-file-in-browser',
    async (
      _event: Electron.IpcMainInvokeEvent,
      filePath: string,
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        if (!filePath || !path.isAbsolute(filePath)) {
          return { success: false, error: 'Path must be absolute' };
        }
        if (!isPathAllowed(filePath)) {
          return { success: false, error: '不允许访问该路径' };
        }
        if (!isBrowserOpenablePath(filePath)) {
          return { success: false, error: '该文件类型不支持浏览器查看' };
        }
        if (!fs.existsSync(filePath)) {
          return { success: false, error: '文件不存在' };
        }
        // 先试 file:// + openExternal —— 保留原行为(按扩展名走默认处理器,
        // .html / .pdf / .svg 一般落到浏览器)。但 Windows 上 openExternal 对
        // percent-encode 过的 file:// URL(路径含中文 / 空格时)会报
        // 0x2 ERROR_FILE_NOT_FOUND;此时兜底走 shell.openPath(原生路径,不做
        // URL 编码,中文 / 空格都稳)。兜底只在原 file:// URL 本就打不开时触发,
        // 故不会回归任何原本能正常打开的情况。
        const fileUrl = pathToFileURL(filePath).toString();
        try {
          await shell.openExternal(fileUrl);
        } catch (e) {
          // 记录 openExternal 首因再走兜底,否则兜底也失败时只剩 openPath 的
          // 错误,无法区分"file:// 编码问题"还是"文件 / 权限问题",难排障。
          createLogger('shell:open-file-in-browser').warn(
            'openExternal failed, fallback to openPath',
            {
              fileUrl,
              error: String(e),
            },
          );
          const errMsg = await shell.openPath(filePath);
          if (errMsg) return { success: false, error: errMsg };
        }
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // text-lightbox F4: open a file using the OS default application
  // (e.g. .log → Notepad / Console, .ts → editor of choice). Mirrors the
  // `shell:open-external` policy: only allow paths that pass `isPathAllowed`.
  ipcMain.handle(
    'shell:open-path',
    async (
      event: Electron.IpcMainInvokeEvent,
      filePathOrUrl: string,
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        assertTrustedAppRendererEvent(event);
        const filePath = resolveShellOpenPathTarget(filePathOrUrl);
        if (filePath === null) {
          return { success: false, error: 'Path must be absolute' };
        }
        if (!isPathAllowed(filePath)) {
          return { success: false, error: '不允许访问该路径' };
        }
        // shell.openPath returns '' on success, error string on failure.
        const errMsg = await shell.openPath(filePath);
        if (errMsg) return { success: false, error: errMsg };
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // 安全降级附件“另存为”：源文件必须通过统一路径策略，解析真实路径后还要
  // 位于聊天附件/远程文件缓存内；建议名在 main 侧清洗，复制完成后不调用
  // openPath，避免符号链接越界或恢复原扩展名后被自动执行。
  const saveChatAttachment = createChatAttachmentSaveHandler({
    isPathAllowed,
    realpath: (filePath) => fs.promises.realpath(filePath),
    stat: (filePath) => fs.promises.stat(filePath, { bigint: true }),
    openSource: async (filePath) => {
      const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
      const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
      return {
        stat: () => handle.stat({ bigint: true }),
        copyTo: async (targetPath) => {
          await pipeline(
            handle.createReadStream({ autoClose: false, start: 0 }),
            fs.createWriteStream(targetPath),
          );
        },
        close: () => handle.close(),
      };
    },
    showSaveDialog: async (opts) => {
      const targetWin = getWindow() ?? BrowserWindow.getFocusedWindow();
      const result = targetWin
        ? await dialog.showSaveDialog(targetWin, opts)
        : await dialog.showSaveDialog(opts);
      return { canceled: result.canceled, filePath: result.filePath || undefined };
    },
    getDownloadsDir: () => app.getPath('downloads'),
    getAllowedSourceRoots: () => [
      imageCacheStore.getCacheRoot(),
      path.join(app.getPath('userData'), 'remote-file-cache'),
    ],
  });
  ipcMain.handle(
    'chat-attachment:save-as',
    (_event, params: { sourcePath?: unknown; suggestedName?: unknown }) =>
      saveChatAttachment(params),
  );

  // Settings → About: 打开 <userData>/logs 在系统文件管理器。
  // 路径在主进程派生（renderer 不需要也不应该知道 userData 全路径）。
  // 目录不存在时先创建，避免空安装首次点击失败。
  ipcMain.handle('app:open-logs-dir', async (): Promise<{ success: boolean; error?: string }> => {
    try {
      const logDir = path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const errMsg = await shell.openPath(logDir);
      if (errMsg) return { success: false, error: errMsg };
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Native clipboard helpers (media:copy-to-clipboard) ──
  //
  // Electron's `clipboard.writeImage` writes raw bitmap data — pastable in
  // image apps but NOT in Explorer / Finder, which expect a file-list
  // format (CF_HDROP on Windows, NSPasteboardTypeFileURL on macOS). We
  // shell out to the OS clipboard helpers to get a real "copy of file"
  // that paste-into-folder accepts. spawn (no shell) is used to keep the
  // path argument out of any shell-quote interpretation.

  /** Windows: PowerShell `Set-Clipboard -LiteralPath` writes CF_HDROP. */
  function copyFileToClipboardWindows(absPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Single-quoted PS string is literal except for `'` itself; double it
      // to escape. Path can contain spaces, `$`, backticks, etc. — all safe
      // inside single quotes.
      const escaped = absPath.replace(/'/g, "''");
      const psCommand = `Set-Clipboard -LiteralPath '${escaped}'`;
      const proc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCommand], {
        windowsHide: true,
      });
      let stderr = '';
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      proc.on('error', reject);
      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `Set-Clipboard exited ${code}`));
      });
    });
  }

  /**
   * macOS: AppleScript `set the clipboard to (POSIX file …)` writes the
   * NSPasteboardTypeFileURL pasteboard entry. The path is passed as an
   * AppleScript argv to avoid in-script escaping.
   */
  function copyFileToClipboardMacOS(absPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('osascript', [
        '-e',
        'on run argv',
        '-e',
        'set the clipboard to (POSIX file (item 1 of argv))',
        '-e',
        'end run',
        absPath,
      ]);
      let stderr = '';
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      proc.on('error', reject);
      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `osascript exited ${code}`));
      });
    });
  }

  // Right-click → "open file folder". Accepts xdt-image:// / xdt-video:// URLs
  // (resolved via the matching cache store) or an absolute file path. On
  // success, reveals the file in the OS file manager (Explorer / Finder).
  ipcMain.handle(
    'shell:show-item-in-folder',
    async (
      _event: Electron.IpcMainInvokeEvent,
      params: { url?: string; filePath?: string },
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        let absPath: string | null = null;
        if (params?.url?.startsWith('xdt-image://')) {
          try {
            absPath = imageCacheStore.resolveSafe(params.url).absPath;
          } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
          }
        } else if (params?.url?.startsWith('xdt-video://')) {
          try {
            absPath = videoCacheStore.resolveSafe(params.url).absPath;
          } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
          }
        } else if (params?.url?.startsWith('cindy-media://')) {
          // 媒体总仓 blob(意识产物等):与 xdt-image 同为本机缓存,走总仓解析。
          try {
            absPath = cindyMediaBlobStore.resolveSafe(params.url).absPath;
          } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
          }
        } else if (params?.filePath && path.isAbsolute(params.filePath)) {
          absPath = params.filePath;
        }
        if (!absPath) {
          return { success: false, error: 'url 或 filePath 必须二选一' };
        }
        if (!isPathAllowed(absPath)) {
          return { success: false, error: '不允许访问该路径' };
        }
        if (!fs.existsSync(absPath)) {
          return { success: false, error: '文件不存在' };
        }
        shell.showItemInFolder(absPath);
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // Right-click → "copy image / video". Resolves the URL (xdt-image:// or
  // xdt-video://) or absolute path to a file and writes it to the system
  // clipboard as a FILE REFERENCE — not raw bytes. The user can then paste
  // it into Explorer / Finder, chat apps, video editors, etc.
  // Mirrors the URL-or-absolute-path contract of `shell:show-item-in-folder`.
  ipcMain.handle(
    'media:copy-to-clipboard',
    async (
      _event: Electron.IpcMainInvokeEvent,
      params: { url?: string; filePath?: string },
    ): Promise<{ success: boolean; error?: string }> => {
      try {
        let absPath: string | null = null;
        let kind: 'image' | 'video' | 'unknown' = 'unknown';
        if (params?.url?.startsWith('xdt-image://')) {
          try {
            absPath = imageCacheStore.resolveSafe(params.url).absPath;
            kind = 'image';
          } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
          }
        } else if (params?.url?.startsWith('xdt-video://')) {
          try {
            absPath = videoCacheStore.resolveSafe(params.url).absPath;
            kind = 'video';
          } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
          }
        } else if (params?.url?.startsWith('cindy-media://')) {
          // 媒体总仓 blob:kind 按落盘 mime 定(图/视频共用同一协议)。
          try {
            const resolved = cindyMediaBlobStore.resolveSafe(params.url);
            absPath = resolved.absPath;
            kind = resolved.mimeType.startsWith('video/') ? 'video' : 'image';
          } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
          }
        } else if (params?.filePath && path.isAbsolute(params.filePath)) {
          absPath = params.filePath;
        }
        if (!absPath) {
          return { success: false, error: 'url 或 filePath 必须二选一' };
        }
        if (!isPathAllowed(absPath)) {
          return { success: false, error: '不允许访问该路径' };
        }
        if (!fs.existsSync(absPath)) {
          return { success: false, error: '文件不存在' };
        }
        // Copy AS A FILE so the user can paste it into Explorer / Finder
        // (and image / video apps will still accept the file). Electron's
        // standard clipboard API only supports image bitmaps — that pastes
        // into chat / docs but Explorer ignores it, and there is no video
        // equivalent at all. We shell out to the OS-native clipboard helpers
        // to write the file-list format:
        //   - Windows  → PowerShell  Set-Clipboard -LiteralPath
        //   - macOS    → osascript    set the clipboard to (POSIX file ...)
        //   - Linux    → image: fall back to nativeImage bitmap.
        //                video: not supported (no portable file-list format
        //                across DEs without xclip/wl-copy pre-installed).
        try {
          if (process.platform === 'win32') {
            await copyFileToClipboardWindows(absPath);
          } else if (process.platform === 'darwin') {
            await copyFileToClipboardMacOS(absPath);
          } else if (kind === 'image' || kind === 'unknown') {
            const image = nativeImage.createFromPath(absPath);
            if (image.isEmpty()) {
              return { success: false, error: '无法读取图片数据' };
            }
            clipboard.writeImage(image);
          } else {
            return { success: false, error: '当前平台暂不支持复制视频文件' };
          }
        } catch (err) {
          return {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // ── 图片 lightbox 媒体动作(用默认应用打开 / 另存为 / 发送到对话)──
  // 业务体在 lightboxMediaActions.ts(依赖注入,单测用内存 fake 直接调 handler
  // body),这里只做 Electron 接线。
  {
    // 远程图「用默认应用打开」的临时落件放专用子目录:文件名按 URL 哈希稳定
    // (重开覆盖,增长有界),退出时整目录清扫兜底。外部应用可能仍占用文件
    // (尤其 Windows 文件锁),rm 失败静默忽略——同名覆盖 + 下次退出清扫会
    // 继续收敛。
    const remoteImagesTmpDir = path.join(app.getPath('temp'), 'xdt-maker-remote-images');
    app.on('will-quit', () => {
      try {
        fs.rmSync(remoteImagesTmpDir, { recursive: true, force: true });
      } catch {
        // 文件被外部应用占用等:留给下次覆盖/清扫。
      }
    });

    const lightboxMedia = createLightboxMediaHandlers({
      isPathAllowed,
      resolveImageCacheUrl: (url) =>
        url.startsWith('cindy-media://')
          ? cindyMediaBlobStore.resolveSafe(url)
          : imageCacheStore.resolveSafe(url),
      // 规则 25:lightbox「发送到对话」的缓存写同样进媒体总仓(草稿语义,
      // 发送时统一由 register.ts 挂引用),与 IPC from-path/from-buffer 一致。
      cacheImageFromPath: (params) =>
        cindyChatAttachments.ingestChatImageFromPath({
          sourcePath: params.sourcePath,
          originalName: params.originalName,
        }),
      cacheImageFromBuffer: (params) =>
        cindyChatAttachments.ingestChatImageBuffer({
          buffer: params.buffer,
          mimeType: params.mimeType,
        }),
      showSaveDialog: async (opts) => {
        const targetWin = getWindow() ?? BrowserWindow.getFocusedWindow();
        const result = targetWin
          ? await dialog.showSaveDialog(targetWin, opts)
          : await dialog.showSaveDialog(opts);
        return { canceled: result.canceled, filePath: result.filePath || undefined };
      },
      openPath: (absPath) => shell.openPath(absPath),
      // net.fetch 走 Chromium 网络栈(继承代理设置);30s 超时 + 大小上限防御。
      // 限流必须**边读边检**(collectStreamWithLimit):无 / 谎报 Content-Length
      // 的响应若先 arrayBuffer 再检查,会在检查前吃满 main 进程内存(review P1)。
      fetchRemoteImage: async (url) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        try {
          const response = await net.fetch(url, { signal: controller.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const contentLength = Number(response.headers.get('content-length') ?? '0');
          if (contentLength > REMOTE_IMAGE_MAX_BYTES) throw new Error('图片过大,无法下载');
          if (!response.body) throw new Error('empty response body');
          let buffer: Buffer;
          try {
            buffer = await collectStreamWithLimit(
              response.body.getReader(),
              REMOTE_IMAGE_MAX_BYTES,
            );
          } catch (err) {
            controller.abort();
            throw err;
          }
          const rawContentType = response.headers.get('content-type')?.split(';')[0]?.trim();
          return {
            buffer,
            mimeType: rawContentType?.startsWith('image/') ? rawContentType : undefined,
          };
        } finally {
          clearTimeout(timer);
        }
      },
      fetchRemoteMediaImage: (url) => fetchRemoteMediaImageBytes(url),
      getTempDir: () => {
        fs.mkdirSync(remoteImagesTmpDir, { recursive: true });
        return remoteImagesTmpDir;
      },
      fileExists: (absPath) => fs.existsSync(absPath),
      statSize: async (absPath) => (await fs.promises.stat(absPath)).size,
      copyFile: (src, dest) => fs.promises.copyFile(src, dest),
      writeFile: (dest, data) => fs.promises.writeFile(dest, data),
      readFile: (absPath) => fs.promises.readFile(absPath),
      getDownloadsDir: () => app.getPath('downloads'),
      now: () => Date.now(),
    });

    ipcMain.handle('media:open-with-default-app', (_event, params: { url: string }) =>
      lightboxMedia.openWithDefaultApp(params),
    );
    ipcMain.handle('media:save-as', (_event, params: { url: string }) =>
      lightboxMedia.saveAs(params),
    );
    ipcMain.handle(
      'media:cache-for-session',
      (_event, params: { url: string; sessionId: string }) => lightboxMedia.cacheForSession(params),
    );
    ipcMain.handle('media:read-image-bytes', (_event, params: { url: string }) =>
      lightboxMedia.readImageBytes(params),
    );
  }

  // 附件卡缩略图:系统缩略图服务(macOS QuickLook / Windows Shell)按路径出小预览。
  // 高权限入口——先过 sender 闸,再由 readFileThumbnail 做路径策略与 payload 校验;
  // 任何失败都回 null,由 renderer 回落到自绘文件图标。
  ipcMain.handle(
    'file:thumbnail',
    async (
      event: Electron.IpcMainInvokeEvent,
      params: { path: string; size: number; revalidate?: boolean },
    ) => {
      assertTrustedAppRendererEvent(event);
      return readFileThumbnail(params);
    },
  );

  // ── CC Agent SDK IPC handlers (Stage 2 C1 大批退役) ──
  // 老 cc-agent:* handler 全部退役 —— renderer 已切到 maker.* (A4/A5/B/B'/B''/C1/C2)。
  // 各项搬迁去向:
  //   - send-message / stop-session / close-session / update-permission-mode /
  //     set-model / set-effort / set-fast-mode / set-thinking-summaries /
  //     get-context-usage / set-session-visibility / permission-response /
  //     answer-user-question / plan-review-response → maker.* (C1)
  //   - generate-title / plan-file-write → maker-ipc/title.ts + plan-write.ts (C1)
  //   - rewind:preview / rewind:commit → maker-ipc/rewind.ts (C2, 本提交)

  // ── Image local cache IPC handlers (image-local-cache M3) ──
  // 规则 25:粘贴/拖拽写入走 cindy-media 媒体总仓,返回
  // cindy-media:// 内容寻址地址。历史 draft/committed 状态机由引用计数替代:
  // 此处只写 blob 不挂引用(=草稿),发送时 register.ts 挂 session-attachment
  // 引用(=晋升)。sessionId 参数保留兼容 renderer 签名,不再决定落盘位置。
  // F1: drag drop → blob 仓,returns cindy-media:// url
  ipcMain.handle(
    'image-cache:from-path',
    async (
      _event: Electron.IpcMainInvokeEvent,
      params: { sessionId: string; sourcePath: string; originalName: string },
    ): Promise<{ url: string; filename: string }> => {
      return cindyChatAttachments.ingestChatImageFromPath({
        sourcePath: params.sourcePath,
        originalName: params.originalName,
      });
    },
  );

  // F1: clipboard paste → blob 仓,returns cindy-media:// url
  ipcMain.handle(
    'image-cache:from-buffer',
    async (
      _event: Electron.IpcMainInvokeEvent,
      params: {
        sessionId: string;
        buffer: Uint8Array;
        mimeType: string;
        suggestedName?: string;
      },
    ): Promise<{ url: string; filename: string }> => {
      return cindyChatAttachments.ingestChatImageBuffer({
        buffer: params.buffer,
        mimeType: params.mimeType,
      });
    },
  );

  // ── 存储空间卡片(关于页)IPC:媒体总仓回收器 + 对账──
  // 业务体在 cindy-media/storageIpc.ts(依赖注入,规则 14),这里只做接线。
  {
    // 各窗口草稿附件 URL 上报(composerDraftStore mutator 尾部推送;多窗口
    // 时清理取全窗口并集,防误删别的窗口的草稿图)。fire-and-forget send。
    ipcMain.on('cindy-media:report-draft-urls', (event, urls: string[]) => {
      registerWindowDraftUrls(event.sender, urls);
    });

    const storageHandlers = createStorageIpcHandlers({
      getQueueScanTexts: collectAgentInputQueueScanTexts,
      loadSnapshotPayloads: loadAllQueueSnapshotPayloads,
      getRegisteredDraftUrls: getAllRegisteredDraftUrls,
    });
    ipcMain.handle('cindy-media:storage-stats', () => storageHandlers.stats());
    ipcMain.handle('cindy-media:storage-scan', (_event, params: { draftUrls: string[] }) =>
      storageHandlers.scan(params),
    );
    ipcMain.handle(
      'cindy-media:storage-cleanup',
      (
        _event,
        params: {
          draftUrls: string[];
          zeroRefHashes: string[];
          evictCacheHashes: string[];
          deadDirNames: string[];
          cleanTmpFiles: boolean;
        },
      ) => storageHandlers.cleanup(params),
    );
    ipcMain.handle('cindy-media:storage-reconcile', () => storageHandlers.reconcile());
  }

  // F5: SDK send-time temporary base64 read (renderer-initiated; main-initiated
  // is the primary path inside agentManager.buildContentBlocks).
  // 双世界:cindy-media 新地址走 blob 仓,老 xdt-image 地址走冻结的老 store。
  ipcMain.handle(
    'image-cache:read-base64',
    async (
      _event: Electron.IpcMainInvokeEvent,
      params: { url: string },
    ): Promise<{ base64: string; mimeType: string }> => {
      if (typeof params?.url === 'string' && params.url.startsWith('cindy-media://')) {
        const { buffer, mimeType } = await cindyMediaBlobStore.readFile(params.url);
        return { base64: buffer.toString('base64'), mimeType };
      }
      return imageCacheStore.readAsBase64(params.url);
    },
  );

  // F7: cleanup an entire session's cache directory (delete session)
  ipcMain.handle(
    'image-cache:cleanup-session',
    async (_event: Electron.IpcMainInvokeEvent, sessionId: string): Promise<void> => {
      await imageCacheStore.removeSession(sessionId);
      // 媒体总仓对应清理:删本会话名下的媒体引用行(附件/导入/
      // 消息出生引用;画廊等持久引用不动)。失败只警告——引用行残留是
      // 无害的保守方向(blob 多活一阵),由对账工具兜底,不阻塞会话删除。
      try {
        await removeSessionMediaRefs(sessionId);
      } catch (err) {
        createLogger('image-cache').warn('session media ref cleanup failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // F7: cleanup a list of files (移除输入框 chip / 丢弃截图草稿)
  ipcMain.handle(
    'image-cache:cleanup-files',
    async (_event: Electron.IpcMainInvokeEvent, urls: string[]): Promise<void> => {
      if (!Array.isArray(urls)) return;
      const cleanupLog = createLogger('image-cache');
      for (const url of urls) {
        // cindy-media blob 是内容寻址共享字节,chip 移除不删任何东西——
        // 同内容可能被其它消息/画廊引用,删字节必误伤;未发送的无引用 blob
        // 由回收器收走。历史 xdt-image 草稿维持物理删除。
        if (typeof url === 'string' && url.startsWith('cindy-media://')) continue;
        try {
          await imageCacheStore.removeFile(url);
        } catch (err) {
          cleanupLog.warn('cleanup file failed', {
            url,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
  );
};

// ── Smoke-test mode (release-*.mjs post-build verification) ──────────────
// When launched with `--smoke-test`, short-circuit the normal startup flow:
// skip window creation / OAuth / auto-update / deep link / agent / tokens,
// just run localDb init with a fake userId (from `--smoke-user=<id>`), query
// schema_version + core tables, emit JSON to stdout, and exit. Electron's
// native `--user-data-dir` flag is expected to be passed by the smoke script
// so the fake DB lives in a scratch directory.
function parseSmokeArgs(): { enabled: boolean; userId: string } {
  const enabled = process.argv.includes('--smoke-test');
  const userFlag = process.argv.find((a) => a.startsWith('--smoke-user='));
  const userId = userFlag ? userFlag.slice('--smoke-user='.length) : '__smoke_test__';
  return { enabled, userId };
}

async function runSmokeTest(userId: string): Promise<void> {
  try {
    const result = await localDbEnsureReady(userId);
    if (!result.ready) {
      process.stderr.write(
        `${JSON.stringify({ ok: false, error: `ensureReady failed: ${result.error.code} ${result.error.message}` })}\n`,
      );
      localDbCloseDb();
      app.exit(1);
      return;
    }
    const db = localDbGetRawDb();
    const schemaRow = db
      .prepare(`SELECT value FROM migration_meta WHERE key='schema_version'`)
      .get() as { value: string } | undefined;
    const schemaVersion = schemaRow ? parseInt(schemaRow.value, 10) : -1;
    const sessionsCount = (db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number })
      .c;
    const messagesCount = (db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number })
      .c;
    const metaCount = (
      db.prepare('SELECT COUNT(*) AS c FROM migration_meta').get() as { c: number }
    ).c;
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        schema_version: schemaVersion,
        tables: {
          sessions: sessionsCount,
          messages: messagesCount,
          migration_meta: metaCount,
        },
      })}\n`,
    );
    localDbCloseDb();
    app.quit();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${JSON.stringify({ ok: false, error: msg })}\n`);
    try {
      localDbCloseDb();
    } catch {
      /* noop */
    }
    app.exit(1);
  }
}

// AUMID 三位一体:必须与 NSIS appId(forge.config 按构建区域从 brandAppId() 取)
// 与快捷方式 AUMID 逐字符一致。值经 shared/brandRegion 按构建期区域烘焙
// (cn=com.xd.cindycn / global=com.xd.cindy；未注入 region 时默认 global)。
const WINDOWS_APP_USER_MODEL_ID = CURRENT_APP_ID;

/**
 * 清理 Start Menu 里指向 dev `node_modules\electron\dist\electron.exe` 的残留 .lnk。
 *
 * 背景：这类 .lnk 的 target 是裸 dev electron.exe、Arguments 为空，被 Windows 注册
 * 成 AUMID 后（如 `XdtMaker.Dev`、`electron.app.xdt-maker`），一旦 toast 点击触发
 * AUMID 激活机制，就会启动一个没有 app 参数的 electron.exe，弹出 Electron 默认
 * 欢迎页 —— 用户视角看就是"通知点了之后跳到一个空白 Electron 页"。
 *
 * 已知来源：
 *   - 老版本 SnoreToast `-install` 留下的 `XdtMakerDev.lnk`（AUMID `XdtMaker.Dev`）
 *   - Electron 自身按 productName 自动注册的 `Electron.lnk`（AUMID `electron.app.xdt-maker`），
 *     dev 第一次启动后偶现
 *
 * 策略：
 *   1. 快路径：按已知文件名（XdtMakerDev.lnk）直删
 *   2. 防御扫描：枚举 Start Menu Programs 下所有 .lnk，凡是 target 指向
 *      `node_modules\electron\dist\electron.exe` 且 Arguments 为空的一律删除
 *
 * 静默 try/catch：用户手动删过 / 没装过 / 权限问题 / PowerShell 异常都不影响主流程。
 */
function cleanupLegacyDevShortcut(): Promise<void> {
  if (process.platform !== 'win32') return Promise.resolve();
  const appData = process.env.APPDATA;
  if (!appData) return Promise.resolve();
  const startMenuDir = path.join(appData, 'Microsoft\\Windows\\Start Menu\\Programs');

  // 快路径
  const knownLnk = path.join(startMenuDir, 'XdtMakerDev.lnk');
  try {
    if (fs.existsSync(knownLnk)) {
      fs.unlinkSync(knownLnk);
      console.log('[AUMID] cleaned up legacy dev shortcut: %s', knownLnk);
    }
  } catch (err) {
    console.warn('[AUMID] failed to remove legacy dev shortcut: %s', err);
  }

  // 防御扫描：解析 .lnk target 必须走 WScript.Shell COM，所以走 PowerShell。
  // 单引号包路径并把内部 `'` 转成 `''`（PS 单引号字符串转义）。
  const psRoot = startMenuDir.replace(/'/g, "''");
  const ps =
    `$sh = New-Object -ComObject WScript.Shell; ` +
    `$root = '${psRoot}'; ` +
    `if (Test-Path $root) { ` +
    `Get-ChildItem -Path $root -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object { ` +
    `try { ` +
    `$lnk = $sh.CreateShortcut($_.FullName); ` +
    `if ($lnk.TargetPath -match '(?i)node_modules\\\\electron\\\\dist\\\\electron\\.exe$' -and -not $lnk.Arguments) { ` +
    `Remove-Item -LiteralPath $_.FullName -Force; ` +
    `Write-Output ('removed: ' + $_.FullName) ` +
    `} ` +
    `} catch {} ` +
    `} ` +
    `}`;

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 8000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          console.warn('[AUMID] dev shortcut scan failed: %s', err.message);
        } else if (stdout.trim()) {
          for (const line of stdout.trim().split(/\r?\n/)) {
            console.log('[AUMID] %s', line);
          }
        }
        resolve();
      },
    );
  });
}

app.on('ready', async () => {
  // Smoke-test flag short-circuit: skip all normal init paths.
  const smoke = parseSmokeArgs();
  if (smoke.enabled) {
    await runSmokeTest(smoke.userId);
    return;
  }

  // 客户端端点清单:启动第一步、先于一切更新检查,**阻断式**解析(packaged 走
  // 烘焙 hotfix CDN 基址;dev 默认读仓内 config/endpoint.json,--endpoints-cdn
  // 时同 packaged;失败 → 系统错误框重试/退出,无缓存与烘焙兜底)。
  // 必须早于一切端点消费方初始化、且在 createWindow() 前注册 sendSync IPC
  // (preload 模块级同步读取依赖它)。用户在错误框选"退出"时 app.exit 已调用,
  // 这里直接 return 不再继续启动。
  if (!(await initClientEndpoints())) {
    return; // 用户在错误框选择退出,app.exit 已调用
  }
  registerClientEndpointsIpc();

  // 网关凭据自动下发:订阅登录态(登录后向 model-access-server 拉 endpoint +
  // 用户专属 key)+ 注册 model-access:* IPC。须在 initClientEndpoints 之后
  // (依赖 modelAccessApiBaseUrl 端点)、renderer auth:initialize 之前装订阅。
  initModelAccess();

  initializeUpdatePresentationRecovery();

  // mac dev 下 Dock 显示的是 Electron 默认图标——macOS 忽略 BrowserWindow.icon,
  // Dock 图标取自可执行 bundle 的 icns,而 dev 跑的是 node_modules 里的官方
  // Electron 二进制。这里 dev-only 手动设成 Cindy 图标;packaged 版由
  // resources/icon.icns 自然生效,不需要也不该动。
  // 使用 icon-dock.png（generate-mac-icns.mjs 产出，已套 Apple 圆角网格）；
  // setIcon 会原样显示资源，不会替应用图标自动加圆角。
  if (!app.isPackaged && process.platform === 'darwin') {
    try {
      app.dock?.setIcon(path.join(__dirname, '../../resources/icon-dock.png'));
    } catch (err) {
      // 仅影响 dev Dock 观感,失败不挡启动
      createLogger('dock-icon').warn('setIcon failed', { error: String(err) });
    }
  }

  await ensureMainAppPresence('app-ready');

  // macOS App Translocation fix: when the user launches the app without
  // dragging it to /Applications first, macOS runs it from a read-only
  // temporary path, which breaks the in-app auto-updater.  Prompt the
  // user to move the app before any other init work happens.
  //
  // Skipped in dev (`!app.isPackaged`): the dev Electron binary lives in
  // node_modules, isInApplicationsFolder() always returns false, and
  // moveToApplicationsFolder() would actually move the dev binary into
  // /Applications and break the developer's workspace.
  if (app.isPackaged && process.platform === 'darwin' && !app.isInApplicationsFolder()) {
    const chosen = dialog.showMessageBoxSync({
      type: 'info',
      title: t('update.moveToApplications.title'),
      message: t('update.moveToApplications.message'),
      buttons: [t('update.moveToApplications.move'), t('update.moveToApplications.later')],
      defaultId: 0,
      cancelId: 1,
    });
    if (chosen === 0) {
      try {
        app.moveToApplicationsFolder();
      } catch (err) {
        console.error('[main] moveToApplicationsFolder failed:', err);
      }
      return;
    }
  }

  // image-local-cache M2 — must register the protocol handler after ready
  // (the scheme itself was registered as privileged at module top).
  // Windows AUMID：必须和 NSIS 写到 Start Menu 快捷方式 System.AppUserModel.ID
  // 上的值一致，Electron Notification 才不会被通知中枢静默丢弃。
  //
  // 这里必须固定为 forge.config.ts 里的 appId。不要运行时模糊扫描 Get-StartApps：
  // 其他 Start Menu 项的 AppID 也可能包含 "xdt"，误设后 Windows 会按错误 AUMID
  // 对任务栏分组和取图标，导致 xdt-maker 串到别的应用图标。
  //
  // 必须在创建任何 Notification 之前调用。macOS / Linux 不需要。
  if (process.platform === 'win32') {
    await cleanupLegacyDevShortcut();
    app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
    console.log('[AUMID] runtime=%s', WINDOWS_APP_USER_MODEL_ID);
  }

  registerImageProtocolHandler();
  registerVideoProtocolHandler();
  registerLocalFileProtocolHandler();
  registerAudioFileProtocolHandler();
  registerModelProtocolHandler();
  registerRemoteMediaProtocolHandler();
  registerCindyMediaProtocolHandler();

  // Inject a Content-Security-Policy response header onto the app's own
  // top-level document (defaultSession mainFrame) before any window loads.
  // Blocks an XSS from escalating to preload privileges via inline / eval
  // script. Dev (Vite dev server) gets a relaxed policy (unsafe-eval + inline
  // + HMR ws); packaged file:// build gets script-src 'self' 'unsafe-eval'
  // 'wasm-unsafe-eval' (unsafe-eval for vendored drawio, wasm-unsafe-eval for
  // 3D model decoders). External URLs (e.g. OAuth pages) are passed through
  // unmodified. The RSB <webview> uses a
  // separate BROWSER_PARTITION session and is unaffected.
  // "isDev" is keyed off the Vite dev-server URL, which is exactly the runtime
  // condition under which the renderer is served by Vite.
  const cspDevServerUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL || null;
  installContentSecurityPolicy(session.defaultSession, {
    isDev: Boolean(cspDevServerUrl),
    devServerOrigin: parseOrigin(cspDevServerUrl),
  });

  registerIpcHandlers();
  // 本机 FS 目录浏览(项目选择器「添加远程项目」逐级浏览;device-link 经隧道在被控端执行)。
  // 无 DB / 无登录依赖,随其它顶层 handler 一起注册即可。
  registerFsBrowseIpc();
  // chat-data-localization F2/F5：注册 localDb IPC + 干净退出快照钩子。
  // 不立即开 db；ensureReady 由 AuthContext 在登录成功后通过 IPC 触发。
  // onReady 回调 → scheduler-host 启动重试入口 (Phase 3)：splash 跑早于 user login
  // 的话第一次 startScheduler 会因为 localDb 未 ready 而失败；这里在 ensureReady
  // 完成后再触发一次幂等的 startScheduler，谁后到谁负责真正启动。
  // 首登轻量数据迁移(mToc)的确认弹窗 IPC —— 必须先于 registerLocalDbIpc 注册,
  // 保证 beforeEnsureReady 推送 confirm 态时 renderer 已能 invoke 确认通道。
  registerLegacyMigrationIpc();
  registerLocalDbIpc({
    isOwnerCurrent: (userId) =>
      isLocalDbOwnerCurrent(authManager.getAuthState(), userId, isAppSessionBoundaryPending()),
    discardStaleOwner: (userId) =>
      lifecycleDbClientManager.dispose(`stale-owner-after-ready:${userId}`),
    beforeEnsureReady: async (userId) => {
      const user = authManager.getAuthState().user;
      if (user == null || user.id !== userId) return;
      // 首登轻量迁移(老 xdt-maker userData → Cindy):内部自带 marker 防重入与
      // 全量兜底,绝不 throw,失败不阻塞登录(ensureReady 照常建新库)。
      await runLegacyUserDataMigrationForUser(user.id);
    },
    onReady: async (userId) => {
      // 必须先 await ensureLifecycleDbClient(内部 await createDbClient → worker
      // spawn + db open + migration scan + smoke,约 1-2s),把 client 经
      // setCurrentDbClient 暴露给全局 getDbClient() 之后,后续 attemptStartScheduler /
      // attemptStartEmbeddingHost / sweepStartupDraftImages 才能拿到 ready 的 DbClient。
      //
      // 历史:MR2.0 时这里是 fire-and-forget,scheduler/embedding 走老 getDrizzle/getRawDb
      // 路径不受影响。MR2.2 把 158 callsite 切到 DbClient 后,fire-and-forget 让后续
      // attempt 全部撞 "DbClient not ready",scheduler/embedding 永不启动 → renderer
      // 卡在 IPC 等待 → 白屏。
      const dbClientTakeover = await ensureLifecycleDbClient(userId);
      if (dbClientTakeover.mode === 'failed' || dbClientTakeover.mode === 'skipped') {
        dbClientLog.warn('[DbClient] lifecycle client unavailable; skip db-client startup hooks', {
          userId,
          mode: dbClientTakeover.mode,
        });
        return;
      }
      // Phase 1.1: file worker 接管 DB 连接后,释放 main 端的 _db + optimize 定时器。
      // 如果 worker takeover 失败并进入 inproc fallback,main _db 必须继续保留,
      // 否则 fallback 会拿到已关闭的连接。
      if (dbClientTakeover.shouldReleaseMainDb && process.env.XDT_DB_INPROC !== 'true') {
        // 只把连接交给 worker，不能释放 shared-passive schema reader lease：worker
        // 还会长期持有同一 DB；lease 必须留到真正 logout / app quit 才释放。
        localDbCloseDb({ preserveSchemaMigrationLease: true });
        dbClientLog.info('[DbClient] main-side _db released after worker takeover');
      }
      // 自定义 MCP：先 await 刷新 provider 数组，确保 scheduler 启动时能看到已保存的
      // custom MCP 配置。cold start 场景：getMaker 构造时 DB 未就绪，初始 refresh 为
      // no-op，waitForInitialCustomMcpRefresh 立即 resolve；此处补刷，保证第一个
      // scheduler fire / 用户会话都能拿到完整的 mcpProviders 数组。best-effort：失败仅
      // warn，不阻塞后续初始化。
      const accountSwitchLog = createLogger('custom-mcp-account-switch');
      try {
        await refreshCustomMcpProviders();
      } catch (err) {
        accountSwitchLog.warn('refreshCustomMcpProviders on account switch failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // 身份翻转遗留的 dialogue 工作目录自愈:把 legacy userData 前缀的
      // sessions.working_dir 批量改写到当前 userData(详见 dialogueWorkdirSelfHeal.ts)。
      // 必须 await:ensure-ready IPC 返回后 renderer 才拉会话列表,在此之前改写完
      // 才能保证 renderer 拿到的就是新路径(改写后不再命中,稳态零开销)。
      try {
        await sweepLegacyDialogueWorkingDirs({
          db: getDbClient(),
          userDataDir: app.getPath('userData'),
          legacyUserDataDirNames: BRAND_IDENTITY.legacyUserDataDirNames,
          currentDialoguesRoot: ownerScopedUserDataPath('dialogues'),
          additionalLegacyDialogueRoots: [path.join(app.getPath('userData'), 'dialogues')],
          log: createLogger('dialogue-workdir-self-heal'),
        });
      } catch (err) {
        dbClientLog.warn('legacy dialogue workdir sweep failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // Hook and personal IM both require the current owner's DbClient. Start
      // them from this authoritative Main-side readiness point instead of
      // relying only on the renderer's later fire-and-forget
      // app:ready-for-bot signal. That signal can be lost during cold-start
      // auto-login or an owner remount, leaving a saved Feishu bot disconnected
      // and unable to claim the owner from its first p2p message.
      startAccountIntegrationsAfterOwnerDbReady(userId, {
        isOwnerCurrent: (ownerId) =>
          isLocalDbOwnerCurrent(
            authManager.getAuthState(),
            ownerId,
            isAppSessionBoundaryPending(),
          ),
        startHookControlAccount,
        startImConnection,
        log: dbClientLog,
      });
      attemptStartScheduler();
      attemptStartEmbeddingHost();
      // 旧「资料本地覆写」方案退役(2026-07)的一次性清理:清当前账号名下的
      // profile-avatar 媒体引用与 override 条目(文件条目即幂等标记,失败下次登录重试)。
      void (async () => {
        const overridePath = path.join(app.getPath('userData'), 'profile-override.json');
        const legacyProfileLog = createLogger('profileEdit');
        await profileEdit.cleanupLegacyProfileOverride(
          {
            readOverrideFile: () => {
              try {
                return fs.readFileSync(overridePath, 'utf-8');
              } catch {
                return null;
              }
            },
            // tmp+rename 原子写:写一半崩溃不会把剩余账号的条目变成损坏 JSON
            // (损坏文件会被清理逻辑当"无从定位"整体删除,其引用回到泄漏状态)。
            writeOverrideFile: (content) => {
              const tmp = `${overridePath}.tmp`;
              fs.writeFileSync(tmp, content, 'utf-8');
              fs.renameSync(tmp, overridePath);
            },
            deleteOverrideFile: () => fs.unlinkSync(overridePath),
            removeRefs: removeMediaRefs,
            logInfo: (message) => legacyProfileLog.info(message),
            logWarn: (message, err) => legacyProfileLog.warn(message, err),
          },
          userId,
        );
      })().catch((err) => {
        dbClientLog.warn('legacy profile override cleanup threw (non-fatal)', err);
      });
      // 价格表作用域依赖当前 localDb 用户与 provider-secret owner;必须等用户 DB ready 后再预热。
      void prewarmModelPricing();
      // 自定义供应商配置在按 userId 切片的 localDb 里：DB ready / 换账号后重新加载并
      // 注入 active-catalog（让路由 / 来源栏 / 模型选择器跟随当前账号）。best-effort，不阻塞。
      void refreshCustomProvidersIntoCatalog();
      // 自定义 MCP：provider 数组已在上方刷新完成，fire-and-forget 失效 Codex cached
      // spawn 配置，使下一会话按新数组重建。
      // 顺序约束：先 dispose app-server（含 busy 检查），成功后再关 bridge（与 mcpHandlers
      // invalidateCodex 同款模式）。best-effort，不阻塞 DB-ready 其余初始化。
      void (async () => {
        let codexRestarted = false;
        try {
          await restartCodexAfterAuthModeChange();
          codexRestarted = true;
        } catch (err) {
          accountSwitchLog.warn('restartCodexAfterAuthModeChange on account switch failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (codexRestarted) {
          try {
            await shutdownCodexEnvironment();
          } catch (err) {
            accountSwitchLog.warn('shutdownCodexEnvironment on account switch failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        // 账号数据就绪 = 启动链路上最早能确定「owner 绑定已认领、网关凭证已下发」的时机，
        // 也是模型清单该被刷新到最新的时机。在这里强制跑一遍（无视冷却），别再等用户去打开
        // 设置页或模型选择器把清单逼出来 —— 那是全新机器首启只看到少数模型的直接原因。
        //
        // 必须排在上面 codex 重启序列**之后**：那条序列末尾会按 auth 边界重读
        // models_cache（cache miss 即清空防串号），并发跑会让刚发现的清单被空快照覆盖。
        void requestProviderModelAutoRefresh('startup');
      })();
      void sweepStartupDraftImages({
        dbClient: getDbClient(),
        processStartedAtMs: PROCESS_STARTED_AT_MS,
      })
        .then((result) => {
          if (result.removed === 0 && result.removedDanglingMeta === 0 && result.errors === 0)
            return;
          createLogger('image-cache-orphan-sweep').info(
            'startup draft image sweep completed',
            result,
          );
        })
        .catch((err) => {
          createLogger('image-cache-orphan-sweep').warn('startup draft image sweep failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    },
  });
  // dev-only IPC for embedding-host smoke testing (status + sync embed). 安全:
  // 内部自带 app.isPackaged 守卫, packaged build 下 register 是 no-op。
  registerDevEmbeddingIpc();
  // worktree-parallel-sessions: 注册 7 个 worktree:* channel (创建/查询/列表/reveal/...)
  // 删除路径不暴露 IPC; 仅在 cc-agent:close-session 内部调用 removeWorktreeForSession。
  registerWorktreeIpc(ipcMain);
  // session-git-pr-context: git-context:* channel(分支查询/HEAD 监听/PR 引用/PR 状态)
  registerGitContextIpc();
  registerGitReviewIpc({
    isSessionRunning: (sessionId) => {
      try {
        return getMakerCore().getSession(sessionId)?.isTurnRunning() === true;
      } catch {
        return false;
      }
    },
  });
  registerSidebarSettingsIpc();
  // RSB terminal tab: PTY backend + 8 个 terminal:* IPC channels(create/write/resize/dispose/restart
  // + listAvailableShells / get|setDefaultShellPref)。owner WebContents destroyed 时:
  //   - RSB 独立子窗口销毁(收起 / 合并回主窗)→ PTY 转移给主窗保活,输出 sink 改推主窗,
  //     与内嵌形态"收起侧栏不杀终端"语义一致;主窗重挂终端后会幂等 re-attach 接管。
  //   - 主窗销毁(app 退出)→ fallback 解析不到活 webContents,PtyManager 回落 dispose,
  //     无需在这里手动 wire shutdown 钩子。
  registerTerminalHandlers({
    getFallbackOwner: () =>
      mainWindowRef && !mainWindowRef.isDestroyed() ? mainWindowRef.webContents : null,
  });
  registerLocalThemesIpc();
  registerVoiceInputIpc();
  registerGlobalVoiceInputIpc({
    getMainWindow: () => mainWindowRef,
    // 会话副窗口跑同一套路由,设置页在里面照样打得开,所以弹系统授权窗那两条 IPC 要认它。
    isSecondaryAppWindow,
  });
  // 老 'usage:get-today-spend' 已退役 —— renderer 走 maker:usage:today('claude-code') 拉。
  // readTodaySpend 仍在 main/usageBroadcaster.ts 内部被 readAgentTodayUsage 用。
  // 主机飞书 token 链已退役(2026-07-17):飞书授权改由 xd-feishu 意识经
  // OAuth broker 自持。老登录链留在磁盘的飞书 refresh token 一次性清掉
  // (凭证卫生:该 RT 已无任何消费方,不留死凭证)。幂等,失败仅告警。
  try {
    fs.unlinkSync(path.join(app.getPath('userData'), 'safe-storage', 'feishu_refresh_token.enc'));
    createLogger('feishu-legacy-cleanup').info(
      'legacy feishu refresh token removed (host feishu token chain retired)',
    );
  } catch (err) {
    // ENOENT = 从未有过或已清,静默;其它错误(Windows EPERM/EBUSY 等)告警,
    // 下次启动重试(best-effort,不阻断)。
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      createLogger('feishu-legacy-cleanup').warn(
        'legacy feishu refresh token removal failed:',
        err,
      );
    }
  }
  // IM channels (@cindy/im): 完全独立 workspace 包，跟随 app 生命周期。
  // 注册 IPC handlers 必须在 init 之前——init 失败时 emit 的状态事件依赖 IPC bridge 转发。
  // IPC handlers 必须无条件注册:用户在 Settings 页保存凭证时, renderer 走这些
  // channel 跟 main 通信, 跟用户登录态无关。
  im.registerIpc();
  // Telegram 个人 bot 行为/人格/群参与配置的 IPC(设置卡数据面),与 im.registerIpc
  // 同期无条件注册;不能放 host.ts 模块顶层(mock electron 的单测收集期会炸)。
  registerTelegramBotConfigIpc();
  // 挂业务 orchestrator: 订阅 feishuIm.onMessage / .onCardAction。orchestrator
  // 必须在 createWindow 前挂好,避免 renderer 起来后第一波 IPC / event 找不到
  // handler。FeishuBot 的 WS 长连接必须等当前用户 localDb ready 后再启动。
  startImOrchestrators();
  // Renderer → main 的 "应用真正就绪" 兼容信号。LocalDbGate 在
  // localDb.ensureReady 成功之后调一次。Hook 与 FeishuBot 已在 localDb onReady
  // 的 Main 权威时点激活，这里为旧时序与瞬时失败保留幂等重试。
  ipcMain.handle('app:ready-for-bot', (event) => {
    assertTrustedAppRendererEvent(event);
    startHookControlAccount();
    startImConnection();
    return { ok: true };
  });
  // 强制引用避免 tree-shaking 干掉 feishuIm（imHost 已通过 im 间接持有，但 main/im 也直接用它）
  void feishuIm;
  // 端点清单已就绪、IPC 已注册,此后 second-instance / activate 允许按需建窗。
  // 使用统计(TapDB)的同意闸:必须在 createWindow **之前**注册。renderer 的
  // tapdbClient 一挂载就 invoke analytics:settings-get 来决定是否初始化 SDK,
  // handler 还没注册的话那次 invoke 会 reject,而它是 fail closed 的 —— 已同意
  // 的用户会一直不上报,直到手动去设置里拨一下开关。
  initAnalyticsSettingsService();
  startupWindowCreationAllowed = true;
  createWindow();
  // 预热仅服务 dev macOS，延迟执行避免和启动关键路径争用 CPU；失败由入口内部吞掉。
  setTimeout(() => {
    prewarmMacComputerPermissionGuideHelper();
  }, 3_000);
  initUpdateService();
  // 在线人数心跳:App 启动即上报,内部走 deviceId / userId 兜底,登录前后都活
  initHeartbeatService();
  // 设备互联(跨设备远程控制):登录后连 relay,登出即断;开关与设备列表 IPC 一并注册
  let updateRelaunchRemoteBusy = false;
  initDeviceLinkService({
    onUpdateRelaunchBusyChanged: (busy) => {
      const transition = decideUpdateRelaunchBusyTransition(
        updateRelaunchRemoteBusy,
        busy,
      );
      updateRelaunchRemoteBusy = transition.nextBusy;
      if (transition.shouldNotify) notifyUpdateAutoRelaunchBusyStateChanged();
    },
  });
  registerDeviceLinkIpc();
  // 注:invoke-capture 自检(assertCaptureHealthy)不在这里——maker:create-session / maker:send
  // 由 splash 后的 registerMakerIpcsAfterSplash 延迟注册,此刻尚未注册。自检已挪到该函数末尾
  // (见上方),那里所有 sentinel 都已就位,结果才准确。

  // 睡醒白屏取证:suspend/resume/lock/unlock 全部落日志,给 renderer 侧
  // render-watchdog 的漂移/无帧日志提供时间锚点。
  installPowerEventDiagnostics({ powerMonitor });

  // 挂起/锁屏时通知 renderer 释放语音输入的保活麦克风(用户已离开,再占着采集
  // 设备只剩隐私指示灯常亮和 idle-sleep assertion 的代价)。
  installVoiceInputPowerRelease({
    powerMonitor,
    broadcast: (channel, payload) => {
      broadcastVoiceInputPowerState(
        BrowserWindow.getAllWindows(),
        channel,
        payload,
        voicePowerBroadcastLog,
      );
    },
  });

  // ── System resume: refresh tokens after sleep/hibernate ──
  powerMonitor.on('resume', () => {
    authManager.handleResume();
    handleProviderModelSystemResume();
  });
  powerMonitor.on('unlock-screen', handleProviderModelScreenUnlock);

  // Memory diagnostics — dev only, log per-process memory every 30s
  if (!app.isPackaged) {
    setInterval(() => {
      const parts = app
        .getAppMetrics()
        .map(
          (m) =>
            `${m.type}:${(m.memory.workingSetSize / 1024).toFixed(0)}MB/${m.cpu.percentCPUUsage.toFixed(1)}%`,
        );
      console.log(`[mem] ${parts.join(' | ')}`);
    }, 30_000);
  }
});

// ---------------------------------------------------------------------------
// 退出 / 崩溃统一编排 —— 所有清理逻辑通过 onQuit() 注册到 lifecycle 模块的
// 单一 disposer registry, 由 installQuitHandler() 把以下入口都接到同一条 chain:
//
//   - app.on('before-quit')          —— 用户/代码主动退出
//   - process.on('SIGINT'/'SIGTERM') —— Ctrl+C / kill PID (dev 终端必装)
//   - process.on('uncaughtException')—— main 进程未捕获异常
//   - app.on('render-process-gone')  —— renderer 崩 (main 还活)
//
// 三个阶段串成 sync → async(并发+6s 超时, 见下方 installQuitHandler) → post-async,
// 然后 app.exit(<code>)。
// 散落的 fire-and-forget 已经收掉, 进程不会在 disposer 跑完之前死。
// 真硬崩 (segfault / kill -9) JS 层无能为力, 子进程靠 stdin EOF 自死。
// ---------------------------------------------------------------------------

// Sync 阶段: 同步触发, 不等结果。只放真正同步的清理 (释放本地句柄 / 取消定时器)。
//   - reap-claude-children: 必须在 shutdown-maker 之前同步完成；SDK abort 掐掉
//     claude.exe 后 Windows 上子进程会被 reparent 到 System, PPID 链断了就无法安全识别。
//   - authManager / google auth: 同步释放定时器+回调引用。
//     注意 token.dispose() 只清内存状态, 不删盘上的 refresh token (那是 logout 干的)。
// interrupted-turn-resume:退出编排一启动就冻结「turn 在飞」标记的写入 —— 否则
// 下方 shutdown-maker 关 session 触发的 markSessionTurnEnded 会把"退出时还在飞
// 的 turn"伪装成正常收尾,重启后中断卡不出现(只剩硬崩溃能触发)。sync 阶段先于
// async 的 shutdown-maker,顺序有保证。
onQuit(
  'session-active-turn-freeze',
  () => {
    freezeSessionActiveTurnMarkers();
  },
  'sync',
);
onQuit(
  'reap-claude-children',
  () => {
    reapClaudeOrphansSync();
  },
  'sync',
);
onQuit('auth-manager', () => authManager.dispose(), 'sync');
onQuit('app-badge-clear', () => clearAllSessionAttention(), 'sync');
// 自带 adb 的常驻 server 守护进程随退出收掉(fire-and-forget detached spawn,
// 不阻塞)。不收会一直锁安装目录里的 adb.exe,弄挂增量更新(os error 32)。
onQuit('android-adb-kill-server', () => disposeAndroidAdb(), 'sync');
onQuit(
  'skillhub-auto-sync-listener',
  () => {
    disposeSkillhubAutoSyncAuthListener?.();
    disposeSkillhubAutoSyncAuthListener = null;
  },
  'sync',
);
onQuit(
  'provider-access-auth-listener',
  () => {
    disposeProviderAccessAuthListener?.();
    disposeProviderAccessAuthListener = null;
  },
  'sync',
);

// Async 阶段: 并发跑, 6s 超时兜底。
//   - shutdown-maker:       Layer 1 关 sessions → Layer 2 dispose agents (Codex
//                           shared app-server 子进程 SIGTERM)。**必须 await** —
//                           kill 是 Layer 2 才发出, fire-and-forget 会让 app.exit
//                           在 kill 之前就掐掉 Node, Windows 上子进程会变孤儿。
//   - im.dispose:           wsClient.stop() 内部先发 announce offline (quit path waits 4.5s)
//                           再 close WS。**整个改造的核心目标——必须 await。**
//   - codex env shutdown:   关 MCP HTTP bridge。语义上要在 maker.shutdown() 杀完
//                           codex 子进程之后, 这里并发跑最坏是 log noise。
// (clean-exit-snapshot 已移除 — 退出时不再做 db.backup, 容灾改由 SQLite WAL crash
//  recovery 兜底, 详见 localDb/index.ts 文件头 ADR-FE7 修订说明。)
onQuit('shutdown-maker', shutdownMaker, 'async');
onQuit('orca-idle-watcher', () => stopOrcaIdleWatcher(), 'sync');
onQuit('im', () => stopImConnection('quit'), 'async');
onQuit('codex-env', () => shutdownCodexEnvironment(), 'async');
// embedding-host: abort 语义 —— 立刻让出 SQLite 写连接, 不等当前 tick (那批 job 保持
// pending 下次续跑, 写事务同步原子无中断)。
onQuit('embedding-host', () => stopEmbeddingHost(), 'async');
// Anthropic-compat loopback proxy: 立即 destroy 所有 in-flight socket + 等 server.close
// 回调(~10ms 级别)。跟 shutdown-maker 同在 async 阶段并发跑 — 最坏情况是 proxy 先关、
// Claude CLI 子进程收到 ECONNRESET, 但 session 本来就在 close 路径上, 这种 error 直接
// 被吞, 影响可接受。
onQuit('anthropic-compat-proxy', () => disposeAnthropicCompatProxy(), 'async');
// browser-runtime: stop the managed Chrome so it doesn't outlive the app (headed
// browser + locked user-data-dir would otherwise survive quit and force a stale
// SingletonLock recovery next launch). `stop` is idempotent / no-op if never started.
onQuit('browser-runtime', () => disposeBrowserRuntime(), 'async');
onQuit('codex-proxy', () => disposeCodexProxy(), 'async');
// Remote file-service clients: 先于 pool 关闭, 挂断远端 daemon 的 exec channel。
onQuit('remote-file-browser', () => disposeRemoteFileBrowser(), 'async');
// Remote SSH pool: 主动断开所有活动连接, 防止 ssh2 子句柄阻塞 Node 进程退出。
onQuit('remote-ssh-pool', () => disposeRemoteSshPool(), 'async');
// Hook 连接: 停掉全部 WS transport(含重连 timer), 防句柄阻塞退出。
onQuit('hook-control', () => disposeHookControl(), 'sync');
// session-git-pr-context: 取消 .git HEAD 的 parcel watcher 订阅, 防原生句柄阻塞退出。
onQuit('git-context', () => disposeGitContext(), 'async');
onQuit('db-client', () => lifecycleDbClientManager.dispose('quit'), 'async');

// Post-async 阶段: 串行跑, 确保依赖 async 阶段产物的清理 (WAL checkpoint by close)。
onQuit('local-db-close', () => localDbCloseDb(), 'post-async');

installQuitHandler(6000);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // macOS Dock clicks should restore/create the primary app window, not reason
  // about every BrowserWindow in the process. Global voice input keeps a hidden
  // cached overlay window alive after first use; using getAllWindows().length
  // here made Dock activation a no-op when the main window was closed but the
  // overlay still existed.
  //
  // Do not focus the main window while the global voice overlay is visible.
  // Clicking overlay controls also activates the Electron app on macOS; treating
  // that activation like a Dock click makes the main window pop over the
  // user's target app right after they click "Copy" in the failure fallback.
  if (isGlobalVoiceInputOverlayVisible()) return;
  // focusMainWindow() 在 hide-on-close 模式下天然把藏起来的窗口 show 回来,
  // renderer 不重载;返回 false 表示主窗口真没了(异常或首次启动),才 createWindow。
  // 端点清单阻断期间禁止建窗(同 second-instance,防绕过阻断门 + preload 白屏)。
  if (startupWindowCreationAllowed && !focusMainWindow()) {
    createWindow();
  }
});

function memorySettingsWire() {
  const state = readMemorySettingsState();
  return {
    ...state.value,
    isCustomized: state.isCustomized,
    customizedKeys: state.customizedKeys,
    defaults: state.defaults,
  };
}

function imDefaultSettingsWire(channel?: ImDefaultSettingsChannel) {
  const state = readImDefaultSettingsState(channel);
  return {
    ...state.value,
    isCustomized: state.isCustomized,
    customizedKeys: state.customizedKeys,
    defaults: state.defaults,
  };
}

function parseImDefaultSettingsChannel(raw: unknown): ImDefaultSettingsChannel | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isImDefaultSettingsChannel(raw)) {
    throwIpcError('INVALID_PARAMS', 'im default settings channel invalid');
  }
  return raw;
}

function subagentModelSettingsWire() {
  const state = readSubagentModelSettingsState();
  return {
    ...state.value,
    isCustomized: state.isCustomized,
    customizedKeys: state.customizedKeys,
    defaults: state.defaults,
  };
}

function parseSubagentModelSettingsPatch(raw: unknown): SubagentModelSettingsPatch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throwIpcError('INVALID_PARAMS', 'subagent model settings patch required (object)');
  }
  const input = raw as Record<string, unknown>;
  const patch: SubagentModelSettingsPatch = {};
  // providerId 与 model id 同约束(短标识串),共用同一套校验/归一化。
  for (const key of ['claudeCode', 'claudeCodeProviderId', 'codex', 'codexProviderId'] as const) {
    if (!(key in input)) continue;
    const value = input[key];
    if (!isValidSubagentModelIdInput(value)) {
      throwIpcError('INVALID_PARAMS', `subagent model ${key} must be a valid string or null`);
    }
    patch[key] = normalizeSubagentModelId(value);
  }
  return patch;
}

function parseImDefaultSettingsPatch(raw: unknown): ImDefaultSettingsPatch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throwIpcError('INVALID_PARAMS', 'im default settings patch required (object)');
  }
  const input = raw as Record<string, unknown>;
  const patch: ImDefaultSettingsPatch = {};
  if ('agentKind' in input) {
    if (!isImDefaultAgentKind(input.agentKind)) {
      throwIpcError('INVALID_PARAMS', 'im default agentKind invalid');
    }
    patch.agentKind = input.agentKind;
  }
  if ('permissionMode' in input) {
    if (!isImDefaultPermissionMode(input.permissionMode)) {
      throwIpcError('INVALID_PARAMS', 'im default permissionMode invalid');
    }
    patch.permissionMode = input.permissionMode;
  }
  if ('agents' in input) {
    if (!input.agents || typeof input.agents !== 'object' || Array.isArray(input.agents)) {
      throwIpcError('INVALID_PARAMS', 'im default agents must be object');
    }
    const agentInput = input.agents as Record<string, unknown>;
    const agentsPatch: NonNullable<ImDefaultSettingsPatch['agents']> = {};
    if ('claude-code' in agentInput) {
      agentsPatch['claude-code'] = parseImDefaultAgentSettings(
        'claude-code',
        agentInput['claude-code'],
      );
    }
    if ('codex' in agentInput) {
      agentsPatch.codex = parseImDefaultAgentSettings('codex', agentInput.codex);
    }
    patch.agents = agentsPatch;
  }
  if ('providerId' in input || 'model' in input || 'effort' in input) {
    const legacyAgentKind = patch.agentKind ?? IM_DEFAULT_SETTINGS.agentKind;
    patch.agents = {
      ...patch.agents,
      [legacyAgentKind]: parseImDefaultAgentSettings(legacyAgentKind, input),
    };
  }
  return patch;
}

function parseImDefaultAgentSettings(
  agentKind: ImDefaultAgentKind,
  raw: unknown,
): ImDefaultAgentSettings {
  const defaults = IM_DEFAULT_SETTINGS.agents[agentKind];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...defaults };
  }
  const input = raw as Record<string, unknown>;
  let providerId = defaults.providerId;
  let model = defaults.model;
  let effort = defaults.effort;
  if ('providerId' in input) {
    if (input.providerId !== null && typeof input.providerId !== 'string') {
      throwIpcError('INVALID_PARAMS', 'im default providerId must be string or null');
    }
    providerId =
      typeof input.providerId === 'string' && input.providerId.trim()
        ? input.providerId.trim()
        : null;
  }
  if ('model' in input) {
    if (typeof input.model !== 'string' || !input.model.trim()) {
      throwIpcError('INVALID_PARAMS', 'im default model required (string)');
    }
    model = input.model.trim();
  }
  if ('effort' in input) {
    if (!isImDefaultEffort(input.effort)) {
      throwIpcError('INVALID_PARAMS', 'im default effort invalid');
    }
    effort = input.effort;
  }
  return { providerId, model, effort };
}

function silentEncryptedRetryWire() {
  const state = readSilentEncryptedRetrySettingsState();
  return {
    enabled: state.value.enabled,
    isCustomized: state.isCustomized,
    defaultEnabled: state.defaults.enabled,
  };
}

function compactionWire() {
  const state = readCompactionState();
  return {
    pct: state.value.claudeCodeAutoCompactPct,
    isCustomized: state.isCustomized,
    defaultPct: state.defaults.claudeCodeAutoCompactPct,
  };
}

function chatEmbeddingWire() {
  const state = readChatEmbeddingSettingsState();
  return {
    enabled: state.value.enabled,
    isCustomized: state.isCustomized,
    defaultEnabled: state.defaults.enabled,
  };
}

function gitSafetyWire() {
  const state = readGitSafetySettingsState();
  return {
    autoSnapshotEnabled: state.value.autoSnapshotEnabled,
    isCustomized: state.isCustomized,
    defaultAutoSnapshotEnabled: state.defaults.autoSnapshotEnabled,
  };
}

/**
 * bootstrapElectron - exported entry point for dynamic import from index.ts.
 * The Electron startup code above runs as module top-level side effects when
 * this module is dynamically imported. This function exists only to satisfy
 * the import contract; actual boot sequence is initiated by app.on("ready").
 */
export async function bootstrapElectron(): Promise<void> {
  // Side effects already in motion from module-level code above.
  // Return a promise that resolves when app is ready.
  return new Promise<void>((resolve) => {
    if (app.isReady()) {
      resolve();
    } else {
      app.once('ready', () => resolve());
    }
  });
}

// ---------------------------------------------------------------------------
// CJS 缓存自愈(必须是本文件最后一条顶层语句)。
// 依赖 conf(electron-store 底层)的模块级副作用会执行 delete require.cache[__filename]
// ——打包后 __filename 指向整个 bootstrap chunk,等于把主进程 bundle 从 CJS 缓存里踢掉。
// 此后任何运行时动态 import 若命中"require 本 chunk 的分包"(如 drizzle-orm 被拆出的
// 独立 chunk),Node 会把 18MB bundle 从头重新求值:启动副作用全量重跑 → IPC 二次注册
// 抛错 → 求值失败缓存仍空 → 每次重试都泄漏整张模块图,数十次后主进程 V8 堆耗尽 OOM
// (2026-07-12 实事故:意识订阅链路每个会话事件触发一次,约 4 分钟一轮 OOM 循环)。
// conf 的求值先于本文件顶层代码(它是本 chunk 依赖,Rollup 按依赖序前置),所以在顶层
// 末尾把自己塞回缓存即可自愈。构建产物是 CJS,require / module / __filename 均真实存在;
// typeof 守卫兜住测试等非 CJS 求值环境。
if (
  typeof require === 'function' &&
  typeof module !== 'undefined' &&
  typeof __filename === 'string' &&
  require.cache != null &&
  require.cache[__filename] == null
) {
  require.cache[__filename] = module;
}
