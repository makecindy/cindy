import { SETTINGS_SEARCH_ENTRIES } from '../../../src/renderer/components/settings/settingsSearchCatalog';
import { SettingsView } from '../../../src/renderer/components/settings/SettingsView';
import { AppFrame, ctx, mountPage, subscription, forbid } from '../../ui-page/harness';
import { WallpaperSettingsProvider } from '../../../src/renderer/hooks/useWallpaperSettings';
import { SUBAGENT_MODEL_SETTINGS_DEFAULTS } from '../../../src/shared/subagentModelSettings';
import { getDefaultVoiceInputSettings } from '../../../src/shared/voiceInputData';
import { DEFAULT_APPEARANCE_SETTINGS, type AppearanceSettings } from '../../../src/shared/appearanceSettings';
import type { ModelGroupResolveRequest, ModelGroupResolveResult, ModelGroupsConfig } from '../../../src/shared/modelGroups';
import type { UsageHistoryPayload } from '../../../src/renderer/hooks/useUsageHistory';
import { NO_LEGACY_GHOST_RECOVERY } from '../../../src/shared/legacyGhostRecovery';
import { IM_DEFAULT_SETTINGS } from '../../../src/shared/imDefaultSettings';
import { useEffect } from 'react';
import { refreshLocalCatalogSnapshot } from '../../../src/renderer/lib/localCatalogSnapshot';
import type { ProviderView } from '@cindy/model-providers';
import { Route, Routes } from 'react-router-dom';
import { UserInfoSection } from '../../../src/renderer/components/sidebar/UserInfoSection';

const read = <T,>(value: T) => async () => value;
const state = <T extends object>(defaults: T) => ({ ...defaults, defaults, isCustomized: false, customizedKeys: [] });
const voiceSettings = getDefaultVoiceInputSettings(ctx.platform);
Object.assign(window, { settingsFixtureEntries: SETTINGS_SEARCH_ENTRIES });
const zeroMoney = { amount: 0, currency: 'USD', approximate: false, kind: 'actual-cost' } as const;
const creditPool = { remaining: '0', used: '0', total: '0' };
const todayKey = new Date().toLocaleDateString('sv-SE');
const previewUsage = ctx.data.previewUsage === true;
const usageReads = { history: 0, billing: 0, balance: 0 };
Object.assign(window, { usageReads });
const todayTokens = previewUsage ? 24_860 : 0;
const todayMoney = { ...zeroMoney, amount: previewUsage ? 0.48 : 0 } as const;
const dailyUsage = Array.from({ length: 7 }, (_, index) => {
  const date = new Date();
  date.setDate(date.getDate() - index);
  return { day: date.toLocaleDateString('sv-SE'), tokens: Math.round(todayTokens * (1 - index / 10)),
    money: { ...todayMoney, amount: Number((todayMoney.amount * (1 - index / 10)).toFixed(2)) } };
}).reverse();
const usageHistory: UsageHistoryPayload = {
  generatedAt: Date.now(), todayKey, days: previewUsage ? dailyUsage : [],
  modelDaily: previewUsage ? dailyUsage.map((day) => ({ day: day.day, agentKind: 'codex', model: 'gpt-5-mini',
    money: day.money, apiMoney: day.money, subscriptionEstimateMoney: { ...todayMoney, amount: 0 }, tokens: day.tokens })) : [],
  models: previewUsage ? [{ agentKind: 'codex', model: 'gpt-5-mini', money: todayMoney, estimatedMoney: null,
    inputTokens: 22_000, outputTokens: 2860, cacheReadTokens: 0, cacheCreateTokens: 0 }] : [],
  streak: { current: previewUsage ? 7 : 0, longest: previewUsage ? 7 : 0 },
  totals: { today: todayMoney, last30Days: { ...todayMoney, amount: previewUsage ? 2.35 : 0 },
    last30DaysWithEstimatedValue: { ...todayMoney, amount: previewUsage ? 2.35 : 0 },
    last30DaysEstimatedValue: { ...todayMoney, amount: 0 }, todayTokens,
    last30DaysTokens: dailyUsage.reduce((total, day) => total + day.tokens, 0) },
  anomaly: { isAnomalous: false, trailing7DayAvg: null },
};
const balance = previewUsage ? '18.42' : '0';
const botIdle = { status: { kind: 'idle' }, hasSecret: false, hasToken: false, lifecycleAnnouncement: false };
const sampleProvider: ProviderView = {
  id: 'fixture-models', name: '示例供应商', source: 'user', agents: ['codex'], auth: { method: 'apiKey' },
  routing: {}, models: {}, connected: false,
};
function PreviewSettings() {
  useEffect(() => { if (ctx.data.interactivePreview || ctx.data.tab === 'providers') void refreshLocalCatalogSnapshot(); }, []);
  return <div className="h-screen"><SettingsView /></div>;
}
let modelGroups: ModelGroupsConfig = { routes: ctx.data.sampleModels ? [
  { id: 'fixture-daily', name: '日常任务', strategy: 'order', candidates: [{ agentKind: 'codex', providerId: 'fixture-models', model: 'gpt-5-mini' }] },
  { id: 'fixture-economy', name: '节省额度', strategy: 'cheapest', candidates: [] },
] : [] };
if (ctx.data.tab === 'agent-island') localStorage.setItem('notifications.agentIslandEnabled', 'true');
const relayState = {
  available: true, mode: 'official', relay: null, issue: null,
  host: { enabled: false, running: false, error: null, port: 47820, listenAll: false, externalUrl: null, suggestedUrls: [] },
  deployments: [], deployJob: null, bundledRelayVersion: '0.3.1', joinLink: null, pendingRequests: [], join: { status: 'idle' },
};
const emptyDirectory = { bytes: 0, fileCount: 0 };
const visibilityWrites: unknown[] = [];
Object.assign(window, { visibilityWrites });
let appearance: AppearanceSettings = { ...DEFAULT_APPEARANCE_SETTINGS, wallpaperId: 'silent-orbits', wallpaperVisibility: 0.55 };
const appearanceListeners = new Set<(settings: AppearanceSettings) => void>();
const updateAppearance = (patch: Partial<AppearanceSettings>) => {
  appearance = { ...appearance, ...patch };
  appearanceListeners.forEach((listener) => listener(appearance));
  return appearance;
};

void mountPage({
  route: ctx.data.accountUsage && !ctx.data.routeTab ? '/' : `/settings?tab=${ctx.data.routeTab ?? ctx.data.tab}`,
  host: {
    ...(ctx.data.interactivePreview ? {
      appearanceSettings: {
        getSync: () => appearance,
        onChanged: (listener: (settings: AppearanceSettings) => void) => {
          appearanceListeners.add(listener);
          return () => appearanceListeners.delete(listener);
        },
        setPatch: async (patch: Partial<AppearanceSettings>) => updateAppearance(patch),
        resetFields: async (fields: Array<keyof AppearanceSettings>) => updateAppearance(
          Object.fromEntries(fields.map((key) => [key, DEFAULT_APPEARANCE_SETTINGS[key]])),
        ),
      },
    } : ctx.data.hiddenBackground || ctx.data.glassBackground || ctx.data.previewBackground ? {
      appearanceSettings: {
        getSync: () => ({ ...DEFAULT_APPEARANCE_SETTINGS, wallpaperId: ctx.data.hiddenBackground ?? ctx.data.glassBackground ?? ctx.data.previewBackground,
          wallpaperVisibility: ctx.data.visibility ?? 0, desktopVisibility: ctx.data.visibility ?? 0, wallpaperBlur: 12 }),
        onChanged: subscription('appearance'),
        setPatch: ctx.data.previewBackground
          ? async (patch: unknown) => { visibilityWrites.push(patch); }
          : forbid('appearance.setPatch'),
      },
    } : {}),
    platform: ctx.data.tab === 'agent-island' ? 'darwin' : ctx.platform, osRelease: '24.0.0',
    agentIsland: { getDisplayOptions: read([]) },
    appVersion: '0.0.0', appDisplayVersion: 'UI fixture', appDisplayVersionDetail: 'UI fixture', supportsBetaUpdateChannel: true,
    clientEndpoints: { websiteUrl: 'https://example.invalid' },
    taskManagement: { read: read({ enabled: ctx.data.tab === 'storage' || !!ctx.data.archiveEnabled, days: 7 }),
      onChanged: subscription('task-management'), onArchived: subscription('task-archive-notice') },
    windowBehavior: { getWindowsCloseBehavior: read('minimize'), getLinuxCloseBehavior: read('minimize') },
    onUpdateChannelSettings: subscription('update-channel'),
    getUpdateChannelSettings: read({ channel: 'stable', isCustomized: false }),
    getAutoUpdateSettings: read({ autoRelaunchOnIdle: false, isCustomized: false, defaultAutoRelaunchOnIdle: false }),
    getAnalyticsSettings: read({ privacyConsentAccepted: true, analyticsEnabled: false, analyticsEnabledCustomized: false, allowed: false }),
    onAnalyticsSettingsChange: subscription('analytics'),
    getLogUploadSettings: read({ enabled: false, isCustomized: false }),
    onLogUploadSettingsChange: subscription('logUpload'),
    ccSetDebugNet: read(undefined),
    localThemes: { list: read({ success: true, themes: [] }), listSync: () => ({ success: true, themes: [] }) },
    appShortcuts: { getState: async () => ({ platform: ctx.platform, overrides: {}, globalFailures: [] }), onChanged: subscription('shortcuts') },
    localDb: {
      orcaWorkflows: { getCollaborationSettings: read({ workerSoftLimit: 4, workerHardLimit: 16, isCustomized: false }) },
      sessions: { list: read([]) },
      maintenance: { getLastResult: read(null) },
      databaseSizeWarning: { getSettings: read({ thresholdGiB: 10, disabled: false, isCustomized: false, defaultThresholdGiB: 10 }), getStatus: read({ databaseBytes: 0 }), onChanged: subscription('database-size') },
      sessionImport: { status: read(null), scan: read({ candidates: [], sources: [], sourceErrors: [], hiddenCounts: { cindy: 0, temp: 0, internal: 0, imported: 0 }, scannedAt: 0 }), onProgress: subscription('import') },
      recentWorkdirs: { list: read([]) },
    },
    maker: {
      auth: { getState: read({ loggedIn: false }), onStateChanged: subscription('agent-auth'), onLoginProgress: subscription('agent-login') },
      onProvidersChanged: subscription('model-providers'),
      listProviders: read({ providers: ctx.data.sampleModels || ctx.data.tab === 'providers' ? [sampleProvider] : [],
        providerOrder: [], ownerGeneration: 0, dataOwnerId: null }),
      requestProviderModelsAutoRefresh: read({ ok: true }),
      scanLocalCli: read({ detections: [] }),
      onChatEmbeddingChanged: subscription('chat-embedding'),
      imDefaultSettingsGet: read(state(IM_DEFAULT_SETTINGS)),
      browser: { status: read({ installed: false, browsers: [] }) },
      computer: { status: read({ installed: false, executablePath: null, version: null, daemonRunning: false, installCommand: '', docsUrl: '' }),
        onPermissionGuideStatusChanged: subscription('computer-permissions'), onPermissionGuideCancelled: subscription('computer-permissions-cancelled') },
      android: { getConfig: read({ value: { adbPathOverride: null, defaultDeviceSerial: null } }) },
      usage: { getHistory: async () => { usageReads.history++; return usageHistory; }, onTodaySpendChanged: subscription('spend'), onTodayTokensChanged: subscription('tokens'), onModelPricingChanged: subscription('pricing') },
      agent: { getBinaryVersion: read({ version: '1.0.0' }) },
      piKernel: { getState: read({ currentVersion: '0.0.0', restartRequired: false, operation: null, official: { release: null, checkedAt: null, error: false }, upstream: { release: null, checkedAt: null, error: false } }) },
      getCapabilities: read({ availableModels: [], hasFastMode: false, effortLevels: [], permissionModes: [] }), listAvailableAgents: read([]), onAgentsChanged: subscription('agents'),
      agentResourceSettingsGet: read(state({ maxConcurrentCommands: 0, processPriority: 'normal', capToolchainThreads: false })),
      gitSafetyGet: read(state({ enabled: true })),
      memoryGet: read({ enabled: true }), memoryGetSettingsState: read(state({ maker: true })),
      subagentModelSettingsGet: read(state(SUBAGENT_MODEL_SETTINGS_DEFAULTS)),
      auxiliaryModelSettingsGet: read(state({ models: ctx.data.customAuxiliary ? ['cat:openrouter:codex:openai/gpt-5-mini'] : [] })),
      silentEncryptedRetryGet: read(state({ enabled: true })),
      codexCompactionGet: read({ enabled: true, isCustomized: false }),
      codexCompactionSet: forbid('codexCompactionSet'),
      listCustomMcpServers: read({ servers: [] }), onMcpChanged: subscription('mcp'),
      plugins: { list: read([]), getState: async (id: string) => ({ effectiveEnabled: id !== 'android' }) },
    },
    billing: {
      getCatalog: read({ products: [] }), getCurrentSubscription: read({ subscription: null }), listOrders: read({ orders: [], nextCursor: null }),
      getBalance: async () => { usageReads.balance++; return { planCredits: balance, purchasedCredits: '0', promotionalCredits: '0', available: balance, scale: 9, observedAt: '2026-11-02T00:00:00Z' }; },
      getCreditUsage: async () => { usageReads.billing++;
        if (ctx.data.legacyBalance) throw new Error('Credit usage unavailable');
        return { available: balance, plan: previewUsage ? { remaining: balance, used: '6.58', total: '25' } : creditPool,
        purchased: creditPool, promotional: creditPool, promotionalGrants: [], promotionalGrantsComplete: true,
        promotionalGrantConsistency: 'OBSERVED', ledgerUpdatedAt: null, scale: 9, observedAt: '2026-11-02T00:00:00Z' }; },
    },
    modelGroups: { get: async () => modelGroups, decisions: read([]),
      resolve: async ({ selection }: ModelGroupResolveRequest): Promise<ModelGroupResolveResult> => {
        const route = modelGroups.routes.find((route) => route.id === selection.id);
        return { outcome: route ? 'unavailable' : 'missing', groupName: route?.name ?? '', trace: [] };
      },
      set: async (config: ModelGroupsConfig) => (modelGroups = config) },
    wechatBot: { getState: read({ phase: 'disconnected', bound: false, queuedTasks: 0 }), getChannelSettings: read(null), onStateChange: subscription('wechat-bot') },
    wecomBot: { getStatus: read(botIdle), onStatusChange: subscription('wecom-bot') },
    feishuBot: { getState: read(botIdle), onStatusChange: subscription('feishu-bot'), onRegistrationStatus: subscription('feishu-registration') },
    dingtalkBot: { getState: read(botIdle), onStatusChange: subscription('dingtalk-bot'), onOwnerChange: subscription('dingtalk-owner') },
    discordBot: { getStatus: read(botIdle), onStatusChange: subscription('discord-bot') },
    telegramBot: { getStatus: read(botIdle), onStatusChange: subscription('telegram-bot') },
    hookControl: { get: read({ hook: null }), onStatusChanged: subscription('official-bots'),
      getSharedProjectPrefs: read({ prefs: { prefs: [] } }), getWorkspaceProviderSources: read({ entries: [] }),
      onSharedProjectPrefsChanged: subscription('official-bot-workspaces'),
      onWorkspaceProviderSourcesChanged: subscription('official-bot-provider-sources') },
    wecomGroupNotification: { getState: read({ configured: false, enabled: false }) },
    sharedTask: { account: read([]) },
    ghosts: { listSync: () => ({ ghosts: [] }), recentUsageSync: () => ({ ids: [] }), legacyRecoveryStatus: read(NO_LEGACY_GHOST_RECOVERY),
      onChanged: subscription('ghosts'), onRecentUsageChanged: subscription('ghost-usage') },
    pluginMarket: { snapshot: read({ items: [], unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] }), onUpdateConsentHoldsChanged: subscription('plugin-consent') },
    deviceLink: { getState: read({ remoteControlEnabled: Boolean(ctx.data.cloud), linkStatus: ctx.data.cloud ? 'online' : 'disconnected', controlledBy: [] }), onControlTargetChanged: subscription('control-target'), onOwnershipChanged: subscription('ownership'), onControlledState: subscription('controlled'), onConnectionIssue: subscription('connection-issue'), getSettings: read({}), getStatus: read({ connected: false }), listDevices: read({ devices: ctx.data.cloud ? [{ deviceId: 'fixture-pc', name: 'Preview PC', isSelf: true, online: true, platform: 'win32', remoteControlEnabled: true, controlEnabled: true }] : [] }), onPresenceChanged: subscription('presence'), onStatusChanged: subscription('device-status') },
    remoteDesktop: { state: read({ enabled: false }) },
    remoteSsh: { list: read({ hosts: [] }), onStatusChanged: subscription('ssh') },
    sidebarSettings: { loadSnapshot: () => ({ hiddenMainViewGhostIds: [], dataOwnerId: null, ownerGeneration: 0 }), onHiddenMainViewGhostIdsChanged: subscription('sidebar') },
    selfHostedRelay: { command: read({ state: relayState }), getState: read(relayState), onChanged: subscription('relay') },
    localAgent: { connections: read([]), developerConnection: read({ state: 'stopped' }), onConnectionsChanged: subscription('local-agent') },
    terminal: { listAvailableShells: read([]), getDefaultShellPref: read('auto') },
    worktreeRecycle: { list: read([]) },
    cindyMediaStorage: { stats: read({ success: true, blobs: { totalCount: 0, totalBytes: 0, cacheCount: 0, cacheBytes: 0 }, legacy: emptyDirectory, fixedCaches: { legacyImages: emptyDirectory, chatAttachments: emptyDirectory }, deadDirs: [] }) },
    voiceInput: {
      getDataSnapshot: () => ({ settings: voiceSettings, dictionaryEntries: [], history: [], usageStats: {} }),
      getHistory: () => [], setGlobalShortcut: read({ ok: true }),
      speakerFilter: { getStatus: read({ supported: true, modelState: 'missing', downloadedBytes: 0, totalBytes: 28925018, enrolled: false }), onStatusChanged: subscription('speaker-status') },
      getSystemPermissions: read({ microphone: { ok: true }, accessibility: { ok: true } }),
      onDataChanged: subscription('voice-data'),
      getSystemPermissionsCached: () => ({ microphone: { ok: true }, accessibility: { ok: true } }),
      getModelSelection: read({ selection: { serviceMode: 'byok', asrProvider: '', refinerProvider: '' }, asrProfiles: [], refinerProfiles: [], readiness: { ok: true, provider: 'openai' }, customAsrApiKeyConfigured: false }),
      getReadinessCached: read({ ok: true }), getMicrophonePermissionCached: read({ ok: true, status: 'granted' }),
    },
    openExternal: forbid('openExternal'),
  },
  render: () => <WallpaperSettingsProvider>
    {ctx.data.accountUsage ? (
      <Routes>
        <Route path="/" element={<AppFrame header={false} sidebar={<UserInfoSection isCollapsed={false} />}>{null}</AppFrame>} />
        <Route path="/settings" element={<PreviewSettings />} />
      </Routes>
    ) : <PreviewSettings />}
  </WallpaperSettingsProvider>,
});
