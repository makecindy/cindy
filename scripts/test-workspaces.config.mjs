import os from 'node:os';

import { nodeWebstorageEnabled } from './shared/node-webstorage.mjs';

const vitestBin = (...args) => ({ type: 'packageBin', bin: 'vitest', args });
// The unit tier pins the threads pool. Vitest's default `forks` pool keeps
// `isolate` on and so recycles a child process per test file: this tier's ~1845
// files cost ~1.9k process spawns per gate run, measured at 21 LaunchServices
// check-ins/second on an 18-core macOS host. On 2026-07-30 that sustained churn
// took down macOS 27.0 beta's launchservicesd, which came back with an empty
// running-application registry — leaving the session with no frontmost app at
// all: no menu bar, no keyboard input anywhere, Dock tiles vanishing on click,
// and only a reboot to recover. Worker threads keep the same per-file isolation
// at zero process cost (same 180 desktop files: 189 check-ins versus 1,
// identical results, slightly faster).
//
// Not everything moves. The heavy manual tiers (db, migration, git-integration)
// stay on the default pool: they bootstrap runtime assets and drive real
// Git/SQLite subprocesses, and none sits on the PR gate path. A workspace also
// opts out when its tests cannot survive a worker thread; the known blockers
// are recorded at their call site below — desktop needs the webstorage flag on a
// Node that installs those globals, and the flag cannot coexist with worker
// threads (scripts/shared/node-webstorage.mjs), while maker-core fakes HOME,
// which a worker cannot see because `process.env` there is a thread-local copy
// while `os.homedir()` reads the real environment through libuv.
//
// Node 24+ opts desktop out of threads: the suite segfaults during native-addon
// finalization on macOS as well as Windows, even without the webstorage
// execArgv. Older Node 22 macOS runs stay on threads to avoid process churn;
// Windows has no launchservicesd, so it stays on forks regardless of version.
//
// Keep every opt-out listed in the pool regression test, and keep the list
// short: at 1330 of this tier's 1845 files, desktop alone decides whether the
// churn is a trickle or back to where it started.
const UNIT_POOL_DEFAULT = 'threads';
const UNIT_TEST_SHARD_ENV = 'XDT_UNIT_TEST_SHARD';

export function desktopUnitPool(
  platform = process.platform,
  nodeVersion = process.versions.node,
  webstorageEnabled = nodeWebstorageEnabled(),
) {
  const nodeMajor = Number.parseInt(nodeVersion, 10);
  return webstorageEnabled || platform === 'win32' || nodeMajor >= 24 ? 'forks' : 'threads';
}

/**
 * Split every Vitest workspace by the same CI shard so the parallel shard jobs
 * still form one complete unit gate. The runner adds `passWithNoTests` only
 * when a workspace has fewer selected files than the configured shard count.
 */
export function unitTestShardArgs(value = process.env[UNIT_TEST_SHARD_ENV]) {
  if (value == null || String(value).trim() === '') return [];
  const normalized = String(value).trim();
  const match = /^(\d+)\/(\d+)$/.exec(normalized);
  if (!match) throw new Error(`${UNIT_TEST_SHARD_ENV} must use <index>/<count>`);
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index < 1 || count < 1 || index > count) {
    throw new Error(`${UNIT_TEST_SHARD_ENV} must satisfy 1 <= index <= count`);
  }
  return [`--shard=${index}/${count}`];
}

// Workspace-level parallelism owns the global process budget. Keep ordinary
// Vitest workspaces at one worker each so outer concurrency cannot multiply
// every child process's default CPU-sized pool.
const unitVitestCommand = (workers = 1, pool = UNIT_POOL_DEFAULT) =>
  vitestBin('run', `--pool=${pool}`, `--maxWorkers=${workers}`, ...unitTestShardArgs());
const noCollectableTestsReason = 'No collectable tests yet. Add tests and mark a tier required when this workspace gains testable logic.';
const desktopDbInclude = [
  'src/main/localDb/**/__tests__/*.test.ts',
  'src/main/scheduler-host/__tests__/*.db.test.ts',
  'src/main/__tests__/schemaDriftRepair.test.ts',
  'src/main/__tests__/betterSqliteFactory.test.ts',
  'src/main/__tests__/codexHistoryPromptInit.test.ts',
  'src/main/__tests__/orcaStaleIndexCleanup.test.ts',
  'src/main/__tests__/*LocalSessions.test.ts',
];
const desktopDbExclude = [
  'src/main/localDb/__tests__/migrationReplay.test.ts',
  'src/main/localDb/__tests__/drizzle-proxy-perf.test.ts',
];
const desktopGitIntegrationInclude = [
  'src/main/**/*.git-integration.test.ts',
];
const makerCoreIntegrationInclude = [
  'src/agents/codex/*.integration.test.ts',
  'src/agents/claude-code/__tests__/*.integration.test.ts',
  'src/agents/pi/__tests__/*.integration.test.ts',
];
const makerCoreGuardInclude = [
  'src/agents/shared/auto-review-remote-wiring.test.ts',
];
const makerPiManagerIntegrationInclude = [
  'src/__tests__/pi-manager.integration.test.ts',
];
const desktopE2eInclude = [
  'src/main/maker-host/__tests__/*.e2e.test.ts',
  // Guest fork through a provider group with a real Claude Code; skipped without apps/claude-code-bin.
  'src/main/remote-agent/__tests__/groupRelayClaudeFork.e2e.test.ts',
  'src/main/remote-agent/__tests__/startupProbe.e2e.test.ts',
];
const mobileGuardInclude = [
  // Swift/delegate authorization, recording lifecycle, and native clipping are cross-runtime contracts.
  'src/__tests__/mobileNativeBoundaryContracts.test.ts',
  'src/__tests__/messageNativeLifecycleContracts.test.ts',
  'src/__tests__/nativeE2eContracts.test.ts',
  // Credential ownership, retry protocol, and cross-file design contracts:
  // these read production sources to cover call-site boundaries, not runtime behavior.
  'src/__tests__/authWeakNetworkBootstrap.test.ts',
  'src/__tests__/mobileAuthServerLogin.test.ts',
  'src/__tests__/messageSelectionHighlight.test.ts',
  'src/__tests__/precreatedWorktreeRecoveryBridge.test.ts',
  'src/__tests__/remoteListIncludePinned.test.ts',
  'src/__tests__/revokedAccessTipDismissal.test.ts',
  'src/__tests__/sendEnqueueRetry.test.ts',
  'src/__tests__/sessionScreenshotShare.test.ts',
  'src/auth/__tests__/xdOrgBetaWiring.test.ts',
  // CSP must be applied at the WebView and download call sites, not only in its helper.
  'src/__tests__/htmlPreviewCsp.test.ts',
  'src/auth/__tests__/loginHandoffState.test.ts',
  'src/__tests__/accountDeletion.test.ts',
  'src/__tests__/androidSessionInteractionParity.test.tsx',
  'src/__tests__/chatQuoteCrossDevice.test.ts',
  'src/__tests__/edgeBlurMask.test.ts',
  'src/__tests__/filePreviewPagerWiring.test.ts',
  'src/__tests__/forcedUpdateGate.test.ts',
  'src/__tests__/historyWindowBackfillWiring.test.ts',
  'src/__tests__/homeChromeMenusAndroid.test.ts',
  'src/__tests__/homeDesktopFirst.test.ts',
  'src/__tests__/inactiveSessionListSubscriptions.test.ts',
  'src/__tests__/mobileGoalCommands.test.ts',
  'src/__tests__/mobilePiRosterSessionBinding.test.ts',
  'src/__tests__/mobilePresentationRefresh.test.ts',
  'src/__tests__/mobileProviderLogo.test.ts',
  'src/__tests__/optimisticSessionComposer.test.ts',
  'src/__tests__/orcaCollabScreenWiring.test.ts',
  'src/__tests__/orphanSessionActions.test.ts',
  'src/__tests__/pastedImageAttachment.test.ts',
  'src/__tests__/sessionSwipe.test.ts',
  'src/__tests__/sendingQueueBadge.test.ts',
  'src/__tests__/sessionAgentSwitchWiring.test.ts',
  'src/__tests__/sessionListRemoteAgentMark.test.ts',
  'src/__tests__/sessionMessageMemoryWiring.test.ts',
  'src/__tests__/sessionSendHiddenModelSheet.test.ts',
  'src/__tests__/sessionTitleProjection.test.ts',
  'src/__tests__/startupSplashOverlay.test.ts',
  'src/__tests__/statusBarVcMigration.test.ts',
];
// Static source-contract checks (security, permission, and design rules) run
// in the explicit guard tier. Keeping an exact allowlist makes it impossible
// for a new source scan to silently become part of the ordinary unit gate.
const desktopGuardInclude = [
  // Cross-file host/engine prompt ownership and remote-authorization isolation.
  'src/main/plugin-oauth/__tests__/runtimePrompt.test.ts',
  // Cross-hook voice stop/refine ownership and composer hydration race wiring.
  'src/renderer/__tests__/voiceInputEnterToSend.test.ts',
  'src/renderer/__tests__/sessionAgentSwitchRemoteRouting.contract.test.ts',
  'src/main/__tests__/deviceLinkVoiceCredentialBootstrap.test.ts',
  'src/main/__tests__/discordExternalization.test.ts',
  'src/main/__tests__/sessionRuntimeControlWiring.test.ts',
  // Orca queued acceptance must keep using delivery-scoped authority, not the round guard.
  'src/main/maker-ipc/__tests__/orcaDeliveryWiring.contract.test.ts',
  'src/main/localDb/ipc/__tests__/sessionCreatedBroadcast.test.ts',
  'src/renderer/__tests__/promptRecommendationBadge.test.ts',
  'src/renderer/__tests__/sessionHeaderMenuParity.test.ts',
  'src/renderer/__tests__/typographyDiscipline.test.ts',
  'src/renderer/__tests__/windowBackdropAcrylic.test.ts',
  // Existing credential/permission/protocol contracts, separated from runtime units.
  'src/main/__tests__/analyticsConsentMigrationGuards.test.ts',
  'src/main/__tests__/authAccountDeletionLifecycle.test.ts',
  'src/main/__tests__/authLegacyTokenMirror.test.ts',
  'src/main/__tests__/authPassiveSharedInstance.test.ts',
  'src/main/__tests__/authSessionExpiredDetection.test.ts',
  'src/main/right-sidebar-window/__tests__/preload-contract.test.ts',
  'src/main/maker-ipc/__tests__/piPackageEnableConfirmationIpc.test.ts',
  'src/main/plugin-market/__tests__/ipcErrorBoundary.test.ts',
  'src/renderer/__tests__/xUsageGuideRiskContrast.test.ts',
  'src/main/__tests__/authHostedCallback.contract.test.ts',
  'src/main/__tests__/loginScenarioHarness.contract.test.ts',
  'src/main/__tests__/officialProfileMigrationPolicy.contract.test.ts',
  'src/renderer/__tests__/authContextRace.contract.test.ts',
  'src/main/__tests__/mobileClientPromptNote.contract.test.ts',
  'src/main/cindy-brain/__tests__/legacyGhostRecoveryOrchestration.contract.test.ts',
  'src/main/cindy-brain/__tests__/codexImageAuthBinding.contract.test.ts',
  'src/main/__tests__/authCredentialStoreHealth.contract.test.ts',
  'src/main/__tests__/authLoginFlowReset.contract.test.ts',
  'src/main/maker-ipc/__tests__/messageDeleteHandler.contract.test.ts',
  'src/renderer/__tests__/orcaWorkerAttentionWatcherMount.test.ts',
  'src/renderer/__tests__/userMessageSourceLabels.test.ts',
  // These native host suites also protect cross-runtime privacy/permission
  // and packaging contracts unavailable through a JS-only helper fake.
  'src/main/__tests__/sessionDragReleaseNativeHost.test.ts',
  'src/main/computer-permission-guide/__tests__/MacComputerPermissionGuideNativeHost.test.ts',
  'src/main/cindy-brain/__tests__/libraryExtraDirGrantContract.test.ts',
  'src/main/agent-island/__tests__/nativeContracts.test.ts',
  'src/main/xbox-gamepad/__tests__/nativeContracts.test.ts',
  // Native input caller authentication plus its production Forge/fuse boundary.
  // macOS executes the native probe; other platforms enforce the packaging contract.
  'src/main/remote-desktop/__tests__/macosInput.test.ts',
  'src/main/__tests__/authCaptchaIpcSecurity.test.ts',
  'src/main/__tests__/appearanceUtilityWindowRegistration.test.ts',
  'src/main/__tests__/authSameOwnerRefreshUi.test.ts',
  'src/main/__tests__/browserRuntimeDirStartup.test.ts',
  'src/main/__tests__/clearSessionHandoffOrdering.test.ts',
  'src/main/__tests__/dbSlimmingIpcSecurity.test.ts',
  'src/main/__tests__/deviceLinkAutoTitleWiring.test.ts',
  'src/main/__tests__/deviceLinkInputSteerDedupeWiring.test.ts',
  'src/main/__tests__/endpointEnvUsageGuard.test.ts',
  'src/main/__tests__/gitContextIpcSecurity.test.ts',
  'src/main/__tests__/isolatedOnProductionProfileStartup.test.ts',
  'src/main/__tests__/invokeCaptureHealthOrdering.test.ts',
  'src/main/__tests__/modelVisibilityOwnerClaimOrdering.test.ts',
  'src/main/__tests__/piSubagentQuitEscalation.test.ts',
  'src/main/__tests__/piSubagentUpdateRelaunchGate.test.ts',
  'src/main/__tests__/remoteAgentSetModelWiring.test.ts',
  'src/main/__tests__/writableDirectoryGrantWiring.test.ts',
  'src/main/__tests__/windowThemeVibrancyIpcSecurity.test.ts',
  // This contract executes the exported close-generation functions in isolation because importing
  // the full device-link singleton would start Electron runtime wiring. Keep it in the explicit
  // guard tier rather than letting its source extraction enter ordinary unit tests.
  'src/main/mcp-apps/__tests__/remoteViews.test.ts',
  'src/renderer/features/cc-agent/sidebar/__tests__/sessionCardReviewRegressions.test.ts',
  'src/renderer/__tests__/orcaModelWindowSelection.test.ts',
  'src/renderer/__tests__/markdownRendererXdtAudio.test.ts',
  'src/renderer/__tests__/markdownDiffBlock.test.ts',
  // Cross-file entry isolation and privileged-link propagation contracts;
  // component rendering and cache-lease behavior remain in the unit tier.
  'src/renderer/__tests__/resourceUsageEntryIsolation.test.ts',
  'src/renderer/__tests__/markdownTargetRendererContract.test.ts',
  'src/renderer/__tests__/bulkSessionStatusRouting.test.ts',
  'src/renderer/__tests__/homeUsageDashboardSource.test.ts',
  'src/renderer/features/plugin/__tests__/unreadDotMotion.test.ts',
  'src/renderer/__tests__/workdirBrowseRemoteSafety.test.ts',
  'src/renderer/__tests__/remoteAgentRelocationWiring.test.ts',
  'src/renderer/features/bots/__tests__/botPermissionSwitch.test.ts',
  'src/renderer/features/bots/__tests__/botChatSurface.test.ts',
  // Shared sidebar geometry and non-wrapping metadata are cross-file design
  // contracts retained from main; component behavior stays in sidebar units.
  'src/renderer/features/bots/__tests__/teammatesSectionSpacing.test.ts',
  'src/main/cindy-brain/__tests__/forgeOidcInstallEntry.test.ts',
  'src/main/cindy-brain/__tests__/forge.connection.test.ts',
  'src/main/cindy-brain/__tests__/forge.oauth.test.ts',
  'src/main/cindy-brain/__tests__/sessionFocusRetryContract.test.ts',
  'src/main/cindy-brain/__tests__/ghostDevRuntimeContract.test.ts',
  'src/main/cindy-brain/__tests__/ghostIpcMutationLease.test.ts',
  'src/main/cindy-brain/__tests__/ghostIpcSenderTrust.test.ts',
  'src/main/cindy-brain/__tests__/ghostLocalUpdateSource.wiring.test.ts',
  'src/main/cindy-brain/__tests__/librarySaveAsDialogParent.test.ts',
  'src/main/cindy-brain/__tests__/marketGhostSessionBoundary.test.ts',
  'src/main/cindy-media/__tests__/ccAgentWriteGuard.test.ts',
  'src/main/im/telegram/__tests__/uiText.test.ts',
  'src/main/maker-ipc/__tests__/botMainDependencies.test.ts',
  'src/main/maker-ipc/__tests__/botCompactContinuity.test.ts',
  'src/main/maker-ipc/__tests__/remoteSessionMakerMemory.test.ts',
  'src/main/maker-ipc/__tests__/scheduleProviderDiscoveryWiring.test.ts',
  'src/main/maker-ipc/__tests__/sendToSessionLazyResumePermission.test.ts',
  'src/main/maker-ipc/__tests__/sessionTreeProviderResume.test.ts',
  'src/main/device-link/__tests__/ownershipAccountSource.test.ts',
  'src/main/maker-host/__tests__/codexModelBackfillWiring.test.ts',
  'src/main/maker-ipc/__tests__/orcaUiAssignmentWiring.test.ts',
  'src/main/remote-ssh/__tests__/ccManagerInstallSource.test.ts',
  'src/main/utility-model/__tests__/auxiliaryCustomNoAgentFallback.test.ts',
  'src/main/workdir-probe-host/__tests__/WorkdirProbeHostPackaging.test.ts',
  'src/main/embedding-host/__tests__/hostLifecycle.test.ts',
  'src/main/maker-ipc/__tests__/messageSourceNote.test.ts',
  'src/main/usage/__tests__/accountUsageLimit.test.ts',
  'src/renderer/__tests__/compactComposerTypography.test.ts',
  'src/renderer/__tests__/chatInputModelSelectorRouting.test.ts',
  'src/renderer/__tests__/chatInputSessionFocus.test.ts',
  'src/renderer/__tests__/chatClickabilitySignal.test.ts',
  'src/renderer/__tests__/controlledBannerPlacement.test.ts',
  'src/renderer/__tests__/controlledDraftRemoteAgentWiring.test.ts',
  'src/renderer/__tests__/deviceLinkInteractionScenarios.test.ts',
  'src/renderer/__tests__/dialogueSidebarSection.test.ts',
  'src/renderer/__tests__/dialogScrimDismissal.test.ts',
  'src/renderer/__tests__/disabledCursorVisualContract.test.ts',
  'src/renderer/__tests__/makerExperimentalThemeContract.test.ts',
  'src/renderer/__tests__/iconButtonTooltips.test.ts',
  'src/renderer/__tests__/modalSurfaceContract.test.ts',
  // Existing project-picker source assertions enforce cross-file routing/design contracts.
  'src/renderer/__tests__/newMakerProjectPicker.test.ts',
  'src/renderer/__tests__/orcaWorkflowRoute.test.ts',
  'src/renderer/__tests__/projectsSidebarSection.test.ts',
  'src/renderer/__tests__/remoteWorkerCreationContext.test.ts',
  'src/renderer/__tests__/remoteAgentModelMemoryWiring.test.ts',
  'src/renderer/__tests__/orcaRemoteRoutingInvariants.test.ts',
  'src/renderer/__tests__/sidebarCollapseResetSource.test.ts',
  'src/renderer/__tests__/sessionContentHeaderDragRegion.test.ts',
  'src/renderer/__tests__/sessionTitleProjectionOutlets.test.ts',
  'src/renderer/__tests__/shareSelectionContainment.test.ts',
  'src/renderer/__tests__/toastZIndex.test.ts',
  'src/renderer/__tests__/unsupportedTextPreview.test.ts',
  'src/renderer/hooks/__tests__/useCCAgentChatHiddenFreeze.test.tsx',
];

export function desktopUnitWorkerCount(
  availableParallelism = os.availableParallelism(),
) {
  const available = Number.isFinite(availableParallelism)
    ? Math.floor(availableParallelism)
    : 1;
  return Math.max(1, Math.min(8, available));
}

const noCollectableWorkspace = (name, cwd, reason = noCollectableTestsReason) => ({
  name,
  cwd,
  status: 'notApplicable',
  reason,
  tiers: {},
});

const requiredUnitWorkspace = (name, cwd, { workers = 1, execution, pool, exclude } = {}) => ({
  name,
  cwd,
  status: 'required',
  tiers: {
    unit: {
      status: 'required',
      ...(execution ? { execution } : {}),
      command: unitVitestCommand(workers, pool),
      ...(exclude?.length ? { exclude } : {}),
    },
  },
});

export default {
  workspaces: [
    requiredUnitWorkspace('cindy-headless', 'apps/cindy-headless'),
    {
      name: 'desktop',
      cwd: 'apps/desktop',
      status: 'required',
      tiers: {
        unit: {
          status: 'required',
          execution: 'exclusive',
          // Desktop unit tests spawn many Git/filesystem subprocesses. Benchmarking
          // found eight workers to be the best complexity/resource tradeoff.
          // Lower-CPU hosts stay capped by their available parallelism.
          // It runs exclusively so these workers never overlap outer workspaces.
          // The pool follows the webstorage flag, because the flag cannot
          // coexist with worker threads — see scripts/shared/node-webstorage.mjs
          // for the crash it causes and the measurements. On Node 22, which is
          // what local dev and CI run, the flag is a no-op, so this suite's 1330
          // files take threads and stop spawning a process each. On a
          // webstorage-enabled Node the flag wins and the suite stays on forks.
          // win32 stays on forks unconditionally — threads segfaults there and
          // the churn threads exists to avoid is macOS-only (see the pool note
          // at the top of this file).
          command: unitVitestCommand(
            desktopUnitWorkerCount(),
            desktopUnitPool(),
          ),
          exclude: [
            '**/*.git-integration.test.ts',
            '**/*.integration.test.ts',
            '**/*.e2e.test.ts',
            'src/main/localDb/**',
            'src/main/__tests__/*Migration.test.ts',
            'src/main/__tests__/schemaDriftRepair.test.ts',
            'src/main/__tests__/betterSqliteFactory.test.ts',
            'src/main/__tests__/*LocalSessions.test.ts',
            'src/main/__tests__/codexHistoryPromptInit.test.ts',
            'src/main/__tests__/orcaStaleIndexCleanup.test.ts',
            'src/main/scheduler-host/__tests__/*.db.test.ts',
            'src/main/__tests__/directSessionSendGuard.test.ts',
            'src/main/__tests__/makerSendToSessionOrdering.test.ts',
            ...desktopGuardInclude,
            '**/*.bench.ts',
          ],
        },
        integration: {
          status: 'manual',
          reason: 'Local application Agent protocol tests open real loopback sockets and temporary authorization stores.',
          execution: 'exclusive',
          coverage: 'allowlist',
          command: vitestBin('run', '--maxWorkers=2'),
          include: ['src/main/local-agent/__tests__/*.integration.test.ts'],
        },
        'git-integration': {
          status: 'manual',
          reason: 'Full real-Git coverage is explicit because it spawns hundreds of local subprocesses and is coordinated across worktrees.',
          execution: 'exclusive',
          coverage: 'allowlist',
          command: vitestBin('run', `--maxWorkers=${desktopUnitWorkerCount()}`),
          include: desktopGitIntegrationInclude,
        },
        e2e: {
          status: 'manual',
          reason: 'Desktop E2E tests spawn the real Codex binary and are explicit because they are platform and binary dependent.',
          execution: 'exclusive',
          coverage: 'allowlist',
          command: vitestBin('run', '--pool=forks', '--maxWorkers=1'),
          include: desktopE2eInclude,
        },
        db: {
          status: 'manual',
          reason: 'Desktop DB tests remain an explicit DB tier because they bootstrap runtime assets and cover localDb behavior outside fast unit.',
          coverage: 'allowlist',
          preflight: [
            { type: 'packageScript', script: 'ensure-deps' },
            { type: 'packageScript', script: 'ensure-dev-runtime-assets' },
          ],
          command: vitestBin('run'),
          include: desktopDbInclude,
          exclude: desktopDbExclude,
        },
        migration: {
          status: 'manual',
          reason: 'Migration replay remains an explicit DB tier because it replays SQLite history fixtures outside fast unit.',
          coverage: 'allowlist',
          preflight: [
            { type: 'packageScript', script: 'ensure-deps' },
            { type: 'packageScript', script: 'ensure-dev-runtime-assets' },
          ],
          command: vitestBin('run'),
          include: [
            'src/main/localDb/__tests__/migrationReplay.test.ts',
            'src/main/__tests__/*Migration.test.ts',
          ],
        },
        'db-perf': {
          status: 'manual',
          reason: 'DB proxy performance is intentionally explicit because strict timing is host-sensitive.',
          coverage: 'allowlist',
          command: { type: 'packageScript', script: 'test:db-proxy-perf' },
          include: ['src/main/localDb/__tests__/drizzle-proxy-perf.test.ts'],
        },
        guard: {
          status: 'required',
          coverage: 'allowlist',
          // The typed-send guard builds a ~1 GiB TypeScript Program. Give it
          // the workspace budget and keep other Desktop files out of its CPU
          // slot rather than letting two default-sized guard pools contend.
          execution: 'exclusive',
          command: vitestBin('run', '--maxWorkers=1'),
          include: [
            'src/main/__tests__/directSessionSendGuard.test.ts',
            'src/main/__tests__/makerSendToSessionOrdering.test.ts',
            ...desktopGuardInclude,
          ],
        },
      },
    },
    // Mobile has enough test files to become the critical path at one worker.
    // Give it the full worker budget, but never overlap it with other workspaces.
    {
      name: 'mobile',
      cwd: 'apps/mobile',
      status: 'required',
      tiers: {
        unit: {
          status: 'required',
          execution: 'exclusive',
          command: unitVitestCommand(4),
          exclude: mobileGuardInclude,
        },
        guard: {
          status: 'required',
          coverage: 'allowlist',
          command: vitestBin('run'),
          include: mobileGuardInclude,
        },
      },
    },
    // Stays on forks: palette-scanner's tests stub HOME and the scanner resolves
    // it through os.homedir(), which a worker thread cannot see (see
    // UNIT_POOL_DEFAULT above).
    // At one worker it was the last workspace still running in every CI shard;
    // it scales linearly (2026-10-16: 248s / 125s / 65s at 1 / 2 / 4 workers),
    // so it runs exclusively with the full worker budget, like mobile.
    {
      name: '@cindy/maker-core',
      cwd: 'packages/maker-core',
      status: 'required',
      tiers: {
        unit: {
          status: 'required',
          execution: 'exclusive',
          command: unitVitestCommand(desktopUnitWorkerCount(), 'forks'),
          exclude: ['**/*.integration.test.ts', '**/*.e2e.test.ts', '**/*.git-integration.test.ts', ...makerCoreGuardInclude],
        },
        guard: {
          status: 'required',
          coverage: 'allowlist',
          execution: 'exclusive',
          command: vitestBin('run', '--maxWorkers=1'),
          include: makerCoreGuardInclude,
        },
        'git-integration': {
          status: 'manual',
          reason: 'Full real-Git coverage is explicit because each case builds temporary repos, linked worktrees and separate-git-dir clones via git subprocesses.',
          coverage: 'allowlist',
          command: vitestBin('run', '--maxWorkers=1'),
          include: ['src/**/*.git-integration.test.ts'],
        },
        integration: {
          status: 'manual',
          reason: 'Claude/Pi/Codex integration tests spawn real agent binaries and local protocol servers.',
          execution: 'exclusive',
          coverage: 'allowlist',
          command: vitestBin('run', '--pool=forks', '--maxWorkers=1'),
          include: makerCoreIntegrationInclude,
        },
      },
    },
    requiredUnitWorkspace('@cindy/anthropic-compat-proxy', 'packages/anthropic-compat-proxy'),
    requiredUnitWorkspace('@cindy/anthropic-responses-bridge', 'packages/anthropic-responses-bridge'),
    requiredUnitWorkspace('@cindy/responses-anthropic-bridge', 'packages/responses-anthropic-bridge'),
    requiredUnitWorkspace('@cindy/model-compat', 'packages/model-compat'),
    requiredUnitWorkspace('@cindy/responses-chat-bridge', 'packages/responses-chat-bridge'),
    requiredUnitWorkspace('@cindy/auth-client', 'packages/auth-client'),
    requiredUnitWorkspace('@cindy/browser-control-runtime', 'packages/browser-control-runtime'),
    requiredUnitWorkspace('cindy-tools', 'packages/cindy-tools'),
    requiredUnitWorkspace('@cindy/device-link', 'packages/device-link'),
    requiredUnitWorkspace('@cindy/device-link-relay', 'packages/device-link-relay'),
    noCollectableWorkspace('@cindy/embedding-client', 'packages/embedding-client'),
    requiredUnitWorkspace('@cindy/file-browser-core', 'packages/file-browser-core'),
    noCollectableWorkspace('@cindy/github-client', 'packages/github-client'),
    noCollectableWorkspace('@cindy/gitlab-client', 'packages/gitlab-client'),
    noCollectableWorkspace('@cindy/heartbeat-client', 'packages/heartbeat-client'),
    requiredUnitWorkspace('@cindy/im', 'packages/lizi-im'),
    requiredUnitWorkspace('@cindy/mcps', 'packages/lizi-mcps'),
    requiredUnitWorkspace('@cindy/maker-cc-manager', 'packages/maker-cc-manager'),
    requiredUnitWorkspace('@cindy/maker-remote-ssh', 'packages/maker-remote-ssh'),
    // 轮 42:新包 maker-pi-manager(TS 单例 pi daemon)已随 SSH remote 交付;
    // 漏登记会让 test-workspaces 的 manifest 覆盖校验失败(全量门禁拒跑)。
    {
      name: '@cindy/maker-pi-manager',
      cwd: 'packages/maker-pi-manager',
      status: 'required',
      tiers: {
        unit: {
          status: 'required',
          command: unitVitestCommand(),
          exclude: ['src/__tests__/pi-manager.integration.test.ts'],
        },
        integration: {
          status: 'manual',
          reason: 'Pi manager integration tests spawn real processes and sockets.',
          execution: 'exclusive',
          coverage: 'allowlist',
          command: vitestBin('run', '--pool=forks', '--maxWorkers=1'),
          include: makerPiManagerIntegrationInclude,
        },
      },
    },
    requiredUnitWorkspace('@cindy/maker-scheduler', 'packages/maker-scheduler'),
    requiredUnitWorkspace('@cindy/maker-shared', 'packages/maker-shared'),
    requiredUnitWorkspace('@cindy/model-providers', 'packages/model-providers'),
    noCollectableWorkspace('@jackwener/opencli', 'packages/opencli-vendor',
      'Pinned production adapter sources; execution, host credentials and discovery are tested through @cindy/mcps and the browser-control-runtime.'),
    {
      name: '@cindy/orca-workflow',
      cwd: 'packages/orca-workflow',
      status: 'required',
      tiers: {
        unit: {
          status: 'required',
          command: unitVitestCommand(),
          include: ['src/__tests__/**/*.test.ts'],
        },
      },
    },
    noCollectableWorkspace('project-context', 'packages/project-context'),
    requiredUnitWorkspace('@cindy/remote-file-service', 'packages/remote-file-service'),
    requiredUnitWorkspace('@cindy/voice-input-core', 'packages/voice-input-core'),
    requiredUnitWorkspace('@cindy/wechat-ilink', 'packages/wechat-ilink'),
    noCollectableWorkspace('@cindy/device-link-protocol', 'packages/device-link-protocol'),
    requiredUnitWorkspace('@cindy/plugin-protocol', 'packages/plugin-protocol'),
    requiredUnitWorkspace('@cindy/slack-hook-protocol', 'packages/slack-hook-protocol'),
    requiredUnitWorkspace('@cindy/design-tokens', 'packages/design-tokens'),
  ],
};
