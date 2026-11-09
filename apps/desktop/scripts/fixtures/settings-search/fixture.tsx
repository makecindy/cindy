import { SETTINGS_SEARCH_ENTRIES } from '../../../src/renderer/components/settings/settingsSearchCatalog';
import { SettingsView } from '../../../src/renderer/components/settings/SettingsView';
import { ctx, mountPage, subscription, forbid } from '../../ui-page/harness';
import { WallpaperSettingsProvider } from '../../../src/renderer/hooks/useWallpaperSettings';
import { SUBAGENT_MODEL_SETTINGS_DEFAULTS } from '../../../src/shared/subagentModelSettings';
import { VISION_BRIDGE_SETTINGS_DEFAULTS } from '../../../src/shared/visionBridgeSettings';
import { getDefaultVoiceInputSettings } from '../../../src/shared/voiceInputData';
import { DEFAULT_APPEARANCE_SETTINGS } from '../../../src/shared/appearanceSettings';

const read = <T,>(value: T) => async () => value;
const state = <T extends object>(defaults: T) => ({ ...defaults, defaults, isCustomized: false, customizedKeys: [] });
const voiceSettings = getDefaultVoiceInputSettings(ctx.platform);
Object.assign(window, { settingsFixtureEntries: SETTINGS_SEARCH_ENTRIES });
const zeroMoney = { amount: 0, currency: 'USD', approximate: false, kind: 'actual-cost' };
const creditPool = { remaining: '0', used: '0', total: '0' };
if (ctx.data.tab === 'agent-island') localStorage.setItem('notifications.agentIslandEnabled', 'true');
const relayState = {
  available: true, mode: 'official', relay: null, issue: null,
  host: { enabled: false, running: false, error: null, port: 47820, listenAll: false, externalUrl: null, suggestedUrls: [] },
  deployments: [], deployJob: null, bundledRelayVersion: '0.3.1', joinLink: null, pendingRequests: [], join: { status: 'idle' },
};
const emptyDirectory = { bytes: 0, fileCount: 0 };
const visibilityWrites: unknown[] = [];
let systemSharingEnabled = false;
let systemSharingMode = 'high';
Object.assign(window, { visibilityWrites });

void mountPage({
  route: `/settings?tab=${ctx.data.tab}`,
  host: {
    ...(ctx.data.hiddenBackground || ctx.data.glassBackground || ctx.data.previewBackground ? {
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
    appVersion: '0.0.0', appDisplayVersion: 'UI fixture', supportsBetaUpdateChannel: true,
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
      usage: { getHistory: read({ generatedAt: 1793577600000, todayKey: '2026-11-02', days: [], modelDaily: [], models: [], streak: { current: 0, longest: 0 }, totals: { today: zeroMoney, last30Days: zeroMoney, last30DaysWithEstimatedValue: zeroMoney, last30DaysEstimatedValue: zeroMoney, todayTokens: 0, last30DaysTokens: 0 }, anomaly: { isAnomalous: false, trailing7DayAvg: null } }), onTodaySpendChanged: subscription('spend'), onTodayTokensChanged: subscription('tokens'), onModelPricingChanged: subscription('pricing') },
      agent: { getBinaryVersion: read({ version: '1.0.0' }) },
      piKernel: { getState: read({ currentVersion: '0.0.0', restartRequired: false, operation: null, official: { release: null, checkedAt: null, error: false }, upstream: { release: null, checkedAt: null, error: false } }) },
      getCapabilities: read({ availableModels: [], hasFastMode: false, effortLevels: [], permissionModes: [] }), listAvailableAgents: read([]), onAgentsChanged: subscription('agents'),
      agentResourceSettingsGet: read(state({ maxConcurrentCommands: 0, processPriority: 'normal', capToolchainThreads: false })),
      gitSafetyGet: read(state({ enabled: true })),
      memoryGet: read({ enabled: true }), memoryGetSettingsState: read(state({ maker: true })),
      subagentModelSettingsGet: read(state(SUBAGENT_MODEL_SETTINGS_DEFAULTS)),
      auxiliaryModelSettingsGet: read(state({ models: ctx.data.customAuxiliary ? ['cat:openrouter:codex:openai/gpt-5-mini'] : [] })),
      visionBridgeSettingsGet: read(state(VISION_BRIDGE_SETTINGS_DEFAULTS)),
      silentEncryptedRetryGet: read(state({ enabled: true })),
      listCustomMcpServers: read({ servers: [] }), onMcpChanged: subscription('mcp'),
      plugins: { list: read([]), getState: read({ effectiveEnabled: true }) },
    },
    billing: {
      getCatalog: read({ products: [] }), getCurrentSubscription: read({ subscription: null }), listOrders: read({ orders: [], nextCursor: null }),
      getBalance: read({ planCredits: '0', purchasedCredits: '0', promotionalCredits: '0', available: '0', scale: 9, observedAt: '2026-11-02T00:00:00Z' }),
      getCreditUsage: read({ available: '0', plan: creditPool, purchased: creditPool, promotional: creditPool, promotionalGrants: [], promotionalGrantsComplete: true, promotionalGrantConsistency: 'OBSERVED', ledgerUpdatedAt: null, scale: 9, observedAt: '2026-11-02T00:00:00Z' }),
    },
    sharedTask: { account: read([]) },
    ghosts: { listSync: () => ({ ghosts: [] }), recentUsageSync: () => ({ ids: [] }), onChanged: subscription('ghosts'), onRecentUsageChanged: subscription('ghost-usage') },
    pluginMarket: { snapshot: read({ items: [], unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] }), onUpdateConsentHoldsChanged: subscription('plugin-consent') },
    deviceLink: { getState: read({ remoteControlEnabled: Boolean(ctx.data.cloud), linkStatus: ctx.data.cloud ? 'online' : 'disconnected', controlledBy: [] }), onControlTargetChanged: subscription('control-target'), onOwnershipChanged: subscription('ownership'), onControlledState: subscription('controlled'), onConnectionIssue: subscription('connection-issue'), getSettings: read({}), getStatus: read({ connected: false }), listDevices: read({ devices: ctx.data.cloud ? [{ deviceId: 'fixture-pc', name: 'Preview PC', isSelf: true, online: true, platform: 'win32', remoteControlEnabled: true, controlEnabled: true }] : [] }), onPresenceChanged: subscription('presence'), onStatusChanged: subscription('device-status') },
    remoteDesktop: {
      state: read({ enabled: false }),
      systemSharing: async () => ({ enabled: systemSharingEnabled, mode: systemSharingMode }),
      setSystemSharing: async (enabled: boolean) => {
        systemSharingEnabled = enabled;
        return { enabled, mode: systemSharingMode };
      },
      setSystemSharingMode: async (mode: string) => {
        systemSharingMode = mode;
        return { enabled: systemSharingEnabled, mode };
      },
    },
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
  render: () => <WallpaperSettingsProvider><div className="h-screen"><SettingsView /></div></WallpaperSettingsProvider>,
});
