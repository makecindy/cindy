/**
 * Module-level port setters in the desktop and shared modules the Host loads, and what the Host does
 * about each.
 *
 * A shared module can keep a port in a module variable that the desktop fills once at startup
 * (setX(impl)). Unlike a factory port, nothing fails when the Host does not call the setter: the
 * module quietly falls back (null, a no-op, an empty table, a refusal). The desktop guard
 * (hostDesktopSourceContracts.guard.test.ts, "module-level port setters the Host loads") collects
 * these setters from the Host's import graph and compares them with this table both ways: a new
 * setter missing here, or an entry whose setter is gone, fails it.
 *
 * Key: `<file>#<name>`, sorted, one entry per line. Status:
 * - bound: the Host binds it; `where` is the Host file that does (the guard checks that file calls it, mutates
 *   the container, or hands it over as a port value).
 * - pending: the Host has to bind it; `reason` names the release table row or 甲/乙 gap it goes with.
 * - not-applicable: the Host does not need it; `reason` cites the code or release table row.
 * - internal: called by shared code itself when that code runs, or not a port in practice.
 * Release table (docs/host/personal-migration-release-table.md) references are stable ids only: `row N`
 * (section 一), `甲 N` / `乙 N` (section 五 gaps), or a section and item name as written there. Never file lines; they drift.
 */
export type DesktopModuleSetterStatus = 'bound' | 'pending' | 'not-applicable' | 'internal';
export interface DesktopModuleSetterEntry { status: DesktopModuleSetterStatus; where?: string; reason?: string }

export const DESKTOP_MODULE_SETTERS: Readonly<Record<string, DesktopModuleSetterEntry>> = {
  'apps/desktop/src/main/appSessionState.ts#setAppSessionCommitBoundaryHook': { status: 'pending', reason: '甲 (after 4b, the owner-switch cleanup; release table id to be assigned): on an owner commit the desktop clears session providers, runtime axes and runtime control states (bootstrap-electron.ts:3065-3067); the Host commits owners (main.ts) without clearing them. The other steps of the hook are window-only' },
  'apps/desktop/src/main/cindy-brain/forgePackStaging.ts#bindForgePackStagingTempDir': { status: 'pending', reason: 'Plugin batch (release table row 33), classified with the plugin turn hooks' },
  'apps/desktop/src/main/cindy-brain/ghostGrantConfirmBridge.ts#initGhostGrantConfirmBridge': { status: 'pending', reason: 'Plugin batch (release table row 33); the Host builds its own GhostGrantConfirmBridge (main.ts)' },
  'apps/desktop/src/main/cindy-brain/ghostSetupCoordinator.ts#initGhostSetupCoordinator': { status: 'pending', reason: 'Plugin batch (release table row 33)' },
  'apps/desktop/src/main/cindy-brain/ghostSetupInteractionBridge.ts#initGhostSetupInteractionBridge': { status: 'pending', reason: 'Plugin batch (release table row 33)' },
  'apps/desktop/src/main/cindy-brain/ghostSnapshotCapability.ts#configureGhostSnapshotProcess': { status: 'bound', where: 'apps/host/src/main.ts' },
  'apps/desktop/src/main/device-link/controllerPlatform.ts#setControllerPlatform': { status: 'bound', where: 'apps/host/src/device-link.ts' },
  'apps/desktop/src/main/device-link/historyViewPush.ts#setHistoryWorkPageReader': { status: 'not-applicable', reason: 'M2 push channel (release table section 六, row to be added): unbound, controllers get { kind: refresh } and reload the page (historyViewPush.ts:74)' },
  'apps/desktop/src/main/device-link/remoteBotSessionBoundary.ts#setRemoteBotSessionLookup': { status: 'bound', where: 'apps/host/src/device-link.ts' },
  'apps/desktop/src/main/device-link/sharedTaskDispatch.ts#setSharedTaskDispatchHost': { status: 'not-applicable', reason: 'Shared tasks are M3 (release table row 22: sharedTask M3); unbound, share peers get no session (sharedTaskDispatch.ts:34, :39)' },
  'apps/desktop/src/main/device-link/sharedTaskDispatch.ts#setSharedTaskInteractionReader': { status: 'not-applicable', reason: 'Shared tasks are M3 (release table row 22)' },
  'apps/desktop/src/main/device-link/sharedTaskDispatch.ts#setSharedTaskQueueReader': { status: 'not-applicable', reason: 'Shared tasks are M3 (release table row 22)' },
  'apps/desktop/src/main/device-link/subscriptions.ts#setTopicsReleasedListener': { status: 'not-applicable', reason: 'Bound by the remote file browser (file-browser/device-op.ts), which the Host does not load' },
  'apps/desktop/src/main/device-link/subscriptions.ts#setTopicsSubscribedListener': { status: 'not-applicable', reason: 'Bound by the remote file browser (file-browser/device-op.ts), which the Host does not load' },
  'apps/desktop/src/main/downloader/transport.ts#configureDefaultDownloadRequest': { status: 'not-applicable', reason: 'The only Host downloader is the plugin download slot, which passes its own request each time (cindy-brain/downloadSlot.ts:242-267)' },
  'apps/desktop/src/main/embedding-host/index.ts#registerEmbeddingHostLazyStart': { status: 'not-applicable', reason: 'The Host runs no embedding host; history search falls back to full-text by design (localDb/chatHistorySearch.ts:14-17, :435-443). Plugin vectors go with the plugin batch' },
  'apps/desktop/src/main/embedding-host/providers.ts#registerProvider': { status: 'internal', reason: 'Called by the embedding service itself (embedders/chat-history-embedder.ts, EmbeddingService.ts)' },
  'apps/desktop/src/main/embedding-host/providers.ts#setProviderSuspended': { status: 'internal', reason: 'Called by the embedding worker itself (embedding-host/EmbeddingWorker.ts)' },
  'apps/desktop/src/main/git-context/githubReadRuntime.ts#setGithubReadRuntime': { status: 'pending', reason: 'With the cindy_helper github port (M1, release table row 22); unbound it throws HOST_NOT_READY (githubReadRuntime.ts:20, :28)' },
  'apps/desktop/src/main/input-handoff/askpass/index.ts#initInputHandoffAskpass': { status: 'not-applicable', reason: 'Input handoff is M2 (release table row 22)' },
  'apps/desktop/src/main/localDb/client/current.ts#setCurrentDbClient': { status: 'bound', where: 'apps/host/src/main.ts' },
  'apps/desktop/src/main/localDb/mapper.ts#setSessionRuntimeProjector': { status: 'pending', reason: '甲 (after 4b, with the owner-switch cleanup; release table id to be assigned): clients read the projection (ChatInput.tsx runtimeEffective/runtimePending, CCAgentSessionView.tsx, mobile remoteSessionStore.ts); the Host writes runtime control state (runtime-selection.ts) but its rows carry only the database baseline (mapper.ts:117-119)' },
  'apps/desktop/src/main/localDb/migrationRuntime.ts#configureMigrationRuntime': { status: 'internal', reason: 'Called by localDb/startupCore.ts when the owner database opens' },
  'apps/desktop/src/main/localDb/provisionalSessions.ts#configureProvisionalSessions': { status: 'bound', where: 'apps/host/src/main.ts' },
  'apps/desktop/src/main/localDb/sessionActiveTurn.ts#setOnSessionTurnEndedPersisted': { status: 'not-applicable', reason: 'M2 push channel (release table section 六, row to be added): the Host writes turn markers but does not push the lastTurnEndedAt patch (sessionActiveTurn.ts:142)' },
  'apps/desktop/src/main/localDb/sessionOpening.ts#setSessionOpeningModelAdmission': { status: 'bound', where: 'apps/host/src/main.ts' },
  'apps/desktop/src/main/localDb/sessionRestoreRetention.ts#setSessionRestoreObserver': { status: 'pending', reason: 'To be checked read-only (甲 or 乙; release table id to be assigned): restoring an archived task on the Host (task-restore.ts) records no restoredAt, so automatic archiving may archive it again (task-management/store.ts:89-99, eligibility.ts:71); task-management/store.ts loads without Electron' },
  'apps/desktop/src/main/localDb/sqliteVecLoader.ts#configureSqliteVecExtPath': { status: 'internal', reason: 'Called by localDb/startupCore.ts when the owner database opens' },
  'apps/desktop/src/main/maker-host/active-catalog.ts#setActiveCatalogChangedListener': { status: 'not-applicable', reason: 'The Host refreshes model lists after listProviders and before each start (release table section 二, item 引擎模型清单刷新)' },
  'apps/desktop/src/main/maker-host/active-catalog.ts#setAnthropicDiscoveredModels': { status: 'not-applicable', reason: 'Model discovery and provider views are M2 (release table section 二, subsection 订阅账号放置与供应商视图（rc10）)' },
  'apps/desktop/src/main/maker-host/active-catalog.ts#setCodexApiModelCapabilities': { status: 'not-applicable', reason: 'Model discovery and provider views are M2 (release table section 二, subsection 订阅账号放置与供应商视图（rc10）)' },
  'apps/desktop/src/main/maker-host/active-catalog.ts#setCustomProviderConfigs': { status: 'bound', where: 'apps/host/src/agent/provider-config.ts' },
  'apps/desktop/src/main/maker-host/active-catalog.ts#setCustomProviders': { status: 'bound', where: 'apps/host/src/agent/provider-config.ts' },
  'apps/desktop/src/main/maker-host/active-catalog.ts#setDiscoveredCodexModels': { status: 'internal', reason: 'Called by maker-host/codexLocalModelSink.ts, which the Host Codex runtime uses' },
  'apps/desktop/src/main/maker-host/active-catalog.ts#setDiscoveredProviderMediaModels': { status: 'not-applicable', reason: 'Model discovery and provider views are M2 (release table section 二, subsection 订阅账号放置与供应商视图（rc10）)' },
  'apps/desktop/src/main/maker-host/active-catalog.ts#setDiscoveredProviderModels': { status: 'not-applicable', reason: 'Subscription pool discovery is M2 (release table section 二, item 订阅池按账号发现的 Codex 模型清单, and subsection 订阅账号放置与供应商视图（rc10）)' },
  'apps/desktop/src/main/maker-host/active-catalog.ts#setManagedProviders': { status: 'not-applicable', reason: 'Model discovery and provider views are M2 (release table section 二, subsection 订阅账号放置与供应商视图（rc10）)' },
  'apps/desktop/src/main/maker-host/active-catalog.ts#setSubscriptionPoolProviders': { status: 'bound', where: 'apps/host/src/agent/provider-config.ts' },
  'apps/desktop/src/main/maker-host/active-catalog.ts#setXaiDiscoveredModels': { status: 'not-applicable', reason: 'Model discovery and provider views are M2 (release table section 二, subsection 订阅账号放置与供应商视图（rc10）)' },
  'apps/desktop/src/main/maker-host/active-catalog.ts#setXdGatewayModels': { status: 'bound', where: 'apps/host/src/main.ts' },
  'apps/desktop/src/main/maker-host/claude-auto-permission-fallback.ts#setClaudeAutoClassifierUnavailableListener': { status: 'bound', where: 'apps/host/src/agent/runtime.ts' },
  'apps/desktop/src/main/maker-host/claude-native-cli-status.ts#setClaudeCliLoginStatusListenerErrorHandler': { status: 'internal', reason: 'Called by maker-host/claude-native-cli.ts, which the Host provider config uses' },
  'apps/desktop/src/main/maker-host/claude-rate-limit-headers-observer.ts#setClaudeRateLimitHeadersListener': { status: 'internal', reason: 'No production caller (only its own module and tests)' },
  'apps/desktop/src/main/maker-host/claude-session-background-activity.ts#setClaudeBackgroundActivityBroadcaster': { status: 'not-applicable', reason: 'M2 push channel (release table section 六, row maker:session-background-activity); the Host keeps the state (idle-release.ts)' },
  'apps/desktop/src/main/maker-host/claude-session-background-activity.ts#setClaudeBackgroundCommandWorkBroadcaster': { status: 'not-applicable', reason: 'M2 push channel (release table section 六, row maker:session-background-activity)' },
  'apps/desktop/src/main/maker-host/codex-api-model-capabilities.ts#setCodexApiModelProbe': { status: 'not-applicable', reason: 'Backfills Codex API model capabilities after a custom provider catalog refresh (createDesktopProviderService.ts:711, :740); provider views are M2 (release table section 二, subsection 订阅账号放置与供应商视图（rc10）)' },
  'apps/desktop/src/main/maker-host/codex-custom-provider-route.ts#registerCodexScopedCustomProviderRoutes': { status: 'internal', reason: 'Called by maker-host/codexSpawnConfigCore.ts when a Codex process starts' },
  'apps/desktop/src/main/maker-host/codex-custom-provider-route.ts#setCodexAppliedCustomProviderRoutes': { status: 'bound', where: 'apps/host/src/agent/codex-runtime.ts' },
  'apps/desktop/src/main/maker-host/codex-text-only-policy.ts#registerCodexTextOnlyPolicy': { status: 'bound', where: 'apps/host/src/agent/codex-runtime.ts' },
  'apps/desktop/src/main/maker-host/guest-provider-route-store.ts#registerGuestProviderRoute': { status: 'not-applicable', reason: 'Provider sharing is M3 (release table 乙 6); share guests get ACCESS_REVOKED on the Host (device-link.test.mjs)' },
  'apps/desktop/src/main/maker-host/mcp-tool-approval-policy.ts#setGhostToolApprovalResolver': { status: 'pending', reason: 'Plugin batch (release table row 33)' },
  'apps/desktop/src/main/maker-host/model-usage-pricing.ts#registerUsagePricing': { status: 'bound', where: 'apps/host/src/agent/start-options.ts' },
  'apps/desktop/src/main/maker-host/newMakerDefaultsCache.ts#setNewMakerDraftCache': { status: 'internal', reason: 'No production caller (only its own module and tests)' },
  'apps/desktop/src/main/maker-host/newMakerDefaultsCache.ts#setProviderModelMemoryCache': { status: 'not-applicable', reason: 'Renderer mirror; the Host copy stays empty until the M2 push channel (release table row 6d)' },
  'apps/desktop/src/main/maker-host/newMakerDefaultsCache.ts#setThinkingEnabledInMemory': { status: 'internal', reason: 'Called by maker-ipc/agentSwitchDepsCore.ts, shared with the Host' },
  'apps/desktop/src/main/maker-host/newMakerDefaultsCache.ts#setWorkerCreationPrefsCache': { status: 'not-applicable', reason: 'Orca worker defaults; the Host refuses Orca tasks (send-preflight.ts:18)' },
  'apps/desktop/src/main/maker-host/pi-proxy-session-auth.ts#registerPiProxySession': { status: 'bound', where: 'apps/host/src/agent/claude-proxy-runtime.ts' },
  'apps/desktop/src/main/maker-host/provider-route.ts#setVisionGatewayKeyReader': { status: 'bound', where: 'apps/host/src/agent/vision-bridge.ts' },
  'apps/desktop/src/main/maker-host/provider-upstream-error-observer.ts#setProviderUpstreamErrorBroadcaster': { status: 'not-applicable', reason: 'M2 push channel (release table section 六, row to be added): unbound it is a no-op (provider-upstream-error-observer.ts:60)' },
  'apps/desktop/src/main/maker-host/session-effort-store.ts#setSessionEffort': { status: 'bound', where: 'apps/host/src/agent/runtime-selection.ts' },
  'apps/desktop/src/main/maker-host/session-effort-store.ts#setSessionFastMode': { status: 'bound', where: 'apps/host/src/agent/runtime-selection.ts' },
  'apps/desktop/src/main/maker-host/session-model-interface.ts#configureSessionModelInterfaceStorage': { status: 'bound', where: 'apps/host/src/agent/start-options.ts' },
  'apps/desktop/src/main/maker-host/session-provider-store.ts#bindHostedSessionProvider': { status: 'not-applicable', reason: 'Remote agent hosting; the Host refuses remote execution (send-preflight.ts:17)' },
  'apps/desktop/src/main/maker-host/session-provider-store.ts#setSessionProvider': { status: 'bound', where: 'apps/host/src/agent/turn-executor.mjs' },
  'apps/desktop/src/main/maker-ipc/botAuthorizationService.ts#initBotAuthorizationService': { status: 'not-applicable', reason: 'Teammates; the Host refuses teammate tasks (send-preflight.ts:19)' },
  'apps/desktop/src/main/maker-ipc/sessionContextWindowBudgetState.ts#appliedContextWindowBudgets': { status: 'bound', where: 'apps/host/src/agent/runtime-selection.ts' },
  'apps/desktop/src/main/maker-ipc/sessionContextWindowBudgetState.ts#pendingSessionContextWindowBudgetReconciles': { status: 'bound', where: 'apps/host/src/agent/runtime-selection.ts' },
  'apps/desktop/src/main/mcp-integrations/hostToolCaller.ts#setHostToolProviders': { status: 'not-applicable', reason: 'The Host builds plugin host tool runtimes from its own providers (host-tools.ts createProviderHostToolRuntime)' },
  'apps/desktop/src/main/ownerContext.ts#configureOwnerContext': { status: 'bound', where: 'apps/host/src/agent/claude-auth.mjs' },
  'apps/desktop/src/main/process-monitor/codex-process-registry.ts#registerAgentProcess': { status: 'bound', where: 'apps/host/src/agent/runtime.ts' },
  'apps/desktop/src/main/scheduler-host/silent-output.ts#setSilencedRunProbe': { status: 'internal', reason: 'Called by scheduler-host/index.ts; scheduled runs are M3 (release table section 四, item 自动化／定时任务的宿主直发接入)' },
  'apps/desktop/src/main/subscription-accounts/session.ts#registerSessionSubscriptionAccount': { status: 'pending', reason: 'Subscription account native session handoff (release table row 30: not done on the Host)' },
  'apps/desktop/src/main/turn-change-set/store.ts#setTurnChangeSetWindowBroadcast': { status: 'not-applicable', reason: 'Change records are written on the Host; viewing and undo come with M2 (release table row 7)' },
  'apps/desktop/src/main/userDataPath.ts#configureAppDataDir': { status: 'bound', where: 'apps/host/src/main.ts' },
  'apps/desktop/src/main/userDataPath.ts#configureUserDataDir': { status: 'bound', where: 'apps/host/src/agent/claude-auth.mjs' },
  'apps/desktop/src/main/vision-bridge/vision-bridge-controller.ts#setVisionBridgeController': { status: 'bound', where: 'apps/host/src/agent/vision-bridge.ts' },
  'apps/desktop/src/main/windowsAtomicRename.ts#configureWindowsAtomicRename': { status: 'bound', where: 'apps/host/src/main.ts' },
  'packages/browser-control-runtime/src/shim/media-understanding-runtime.ts#setDescribeImageFile': { status: 'internal', reason: 'No production caller (only its own module and tests)' },
  'packages/browser-control-runtime/src/shim/runtime-env.ts#registerUnhandledRejectionHandler': { status: 'internal', reason: 'Called by the browser runtime itself (_generated/extension/src/browser/unhandled-rejections.ts)' },
  'packages/lizi-mcps/src/browser/tools.ts#registerBrowserTools': { status: 'internal', reason: 'Called by lizi-mcps/src/browser/server.ts when the browser MCP server is built' },
  'packages/lizi-mcps/src/session-path-auth.ts#setSessionPathAuthorizer': { status: 'pending', reason: '甲, plugin batch (release table row 33): unbound, paths outside the workdir are refused (session-path-auth.ts:98-104), also those under granted directories, for cindy_computer on the Host' },
  'packages/maker-core/src/agents/claude-code/index.ts#setClaudeRateLimitInfoListener': { status: 'not-applicable', reason: 'Feeds subscription usage snapshots (maker-ipc/usage.ts:471); subscription usage is M2 (release table row 22)' },
  'packages/maker-core/src/agents/claude-code/index.ts#setClaudeSupportedModelsListener': { status: 'not-applicable', reason: 'Feeds Anthropic model discovery (model-discovery/anthropic.ts); provider views are M2 (release table section 二, subsection 订阅账号放置与供应商视图（rc10）)' },
  'packages/maker-core/src/agents/shared/image-resizer.ts#configureDefaultImageResizer': { status: 'not-applicable', reason: 'The desktop only gives it a logger; resizing works on the defaults' },
  'packages/maker-core/src/session-send-terminal.ts#bindSessionSendOwner': { status: 'internal', reason: 'Called by maker-core session.ts' },
};
