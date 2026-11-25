import { additionalSettingsRuntime, additionalNativeOperations } from './additionalRuntime.js';
import { getHostBrowserBackendStore } from '../browser-backend-settings-store.desktop.js';
import { inspectHostChatEmbeddingSettings, commitHostChatEmbeddingSettings } from '../maker-host/chat-embedding-settings-store.js';
import { additionalSettingsSchema, RETIRED_ADDITIONAL_SETTINGS_DOMAINS, type AdditionalSettingsDomain, type SettingsEditableValue } from '../../shared/settingsEditableCatalog.js';
import type { HostSettingState } from '../../shared/hostSettings.js';
import type { OverrideSettingsCommitOptions, OverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { getCollaborationSettingsStore } from '../maker-host/collaboration-settings-store.js';
import { getAgentResourceSettingsStore } from '../maker-host/agent-resource-settings-store.js';
import { getGitSafetySettingsStore } from '../maker-host/git-safety-settings-store.js';
import { getMemorySettingsStore } from '../maker-host/memory-settings-store.js';
import { getClaudeCompactionSettingsStore, getPiCompactionSettingsStore, inspectPiCompactionSettings, sealExplicitPiCompactionChoice } from '../maker-host/compaction-settings-store.js';
import { getSilentEncryptedRetrySettingsStore } from '../maker-host/silent-encrypted-retry-store.js';
import { getLspSettingsStore } from '../maker-host/lsp-mode-store.js';
import { getAnalyticsSettingsStore } from '../analytics-settings-store.js';
import { getLogUploadSettingsStore } from '../log-upload/logUploadSettingsStore.js';
import { getWindowBehaviorSettingsStore } from '../window-behavior-settings-store.js';
import { getTelegramBehaviorSettingsStore, getTelegramPersonaSettingsStore } from '../im/telegram/behaviorStore.js';
import { getTerminalSettingsStore } from '../terminal/terminalPrefsStore.js';
import { isDesktopPreferenceDomain, readDesktopPreferenceDomain } from './desktopPreferenceDomains.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { HostSettingsError } from './operations.js';
import { probeAvailableShells } from '../terminal/shellResolver.js';
import { SettingsReader } from '../maker-host/plugins/settings-reader.js';
import { DEFAULT_DISABLED_PLUGIN_IDS } from '../maker-host/plugins/types.js';

type Values = Record<string, SettingsEditableValue>;
type State = HostSettingState<Values> & { workspaceId?: string; workspaceLabel?: string; choices?: Record<string, Array<{ value: SettingsEditableValue; label: string }>> };
// Correlated native types are checked by the fixed schema before every commit.
const stores = {
  collaboration: getCollaborationSettingsStore, agentResource: getAgentResourceSettingsStore,
  gitSafety: getGitSafetySettingsStore, memory: getMemorySettingsStore,
  claudeCompaction: getClaudeCompactionSettingsStore, piCompaction: getPiCompactionSettingsStore,
  silentEncryptedRetry: getSilentEncryptedRetrySettingsStore, browserBackend: getHostBrowserBackendStore,
  telegramPersona: getTelegramPersonaSettingsStore,
  lsp: getLspSettingsStore, privacy: getAnalyticsSettingsStore, diagnostics: getLogUploadSettingsStore,
  linuxWindow: getWindowBehaviorSettingsStore, telegramBehavior: getTelegramBehaviorSettingsStore,
  terminal: getTerminalSettingsStore,
};
// Retired domains stay in the wire catalog for existing callers and always read as unavailable.
const retiredDomains = new Set<AdditionalSettingsDomain>(RETIRED_ADDITIONAL_SETTINGS_DOMAINS);
const toolDomains = new Set(['builtinTools', 'browserTools', 'computerTools', 'androidTools']);
function toolReader() { return new SettingsReader({ userDataPath: ownerScopedUserDataPath(), logger: { warn() {} } }); }
function projectTools(domain: AdditionalSettingsDomain, snapshot: ReturnType<SettingsReader['inspectUserDefaults']>): State {
  if (snapshot.status !== 'ready') return snapshot;
  const raw = (snapshot.value.builtinTools ?? snapshot.value.plugins ?? {}) as Record<string, { enabled: boolean }>;
  const keys = Object.keys(additionalSettingsSchema(domain).shape);
  const defaults = Object.fromEntries(keys.map(key => [key, !DEFAULT_DISABLED_PLUGIN_IDS.has(key)]));
  return project(domain, { ...snapshot, defaults,
    value: Object.fromEntries(keys.map(key => [key, raw[key]?.enabled ?? defaults[key]])), customizedKeys: keys.filter(key => Object.hasOwn(raw, key)) });
}
function storeFor(domain: AdditionalSettingsDomain): OverrideSettingsFile<Values> {
  return stores[domain as keyof typeof stores]() as unknown as OverrideSettingsFile<Values>;
}
function project(domain: AdditionalSettingsDomain, state: { status: string; revision?: string | null; value?: unknown; defaults?: unknown; customizedKeys?: string[] }): State {
  if (state.status !== 'ready') return { status: state.status === 'unreadable' ? 'unreadable' : 'unavailable', revision: null };
  const fields = Object.keys(additionalSettingsSchema(domain).shape);
  const pick = (value: unknown) => Object.fromEntries(fields.map(key => [key, (value as Values)[key]]));
  const legacyGit = (value: unknown) => domain === 'gitSafety' ? { autoSnapshotEnabled: (value as { mode: string }).mode !== 'off' } : value;
  const value = additionalSettingsSchema(domain).parse(pick(legacyGit(state.value))) as Values;
  const defaults = additionalSettingsSchema(domain).parse(pick(legacyGit(state.defaults))) as Values;
  const customizedKeys = fields.filter(key => state.customizedKeys?.includes(key) || (domain === 'gitSafety' && state.customizedKeys?.includes('mode')));
  return { status: 'ready', revision: state.revision!, value, defaults, customizedKeys, isCustomized: customizedKeys.length > 0 };
}
export function inspectAdditionalSettings(domain: AdditionalSettingsDomain, workspaceId?: string): State {
  try {
    if (retiredDomains.has(domain)) return { status: 'unavailable', revision: null };
    if (domain === 'imWorkspaceProviders') return additionalNativeOperations()?.imWorkspaceProviders.inspect() ?? { status: 'unavailable', revision: null };
    if (domain === 'workspaceTools') return additionalNativeOperations()?.workspaceTools.read(workspaceId) ?? { status: 'unavailable', revision: null };
    if (domain === 'imWorkspaces') return additionalNativeOperations()?.imWorkspaces.inspect() ?? { status: 'unavailable', revision: null };
    if (domain === 'wecomNotifications') return additionalNativeOperations()?.wecomNotifications.read() ?? { status: 'unavailable', revision: null };
    if (domain === 'officialHooks') return additionalNativeOperations()?.officialHooks.read() ?? { status: 'unavailable', revision: null };
    if (domain === 'telegramGroups') return additionalNativeOperations()?.telegramGroups.inspect() ?? { status: 'unavailable', revision: null };
    if (domain === 'pluginCindy' || domain === 'pluginSidebar' || domain === 'pluginErrand') return (additionalNativeOperations()?.plugins.inspect(domain) ?? { status: 'unavailable', revision: null }) as State;
    if (domain === 'shortcuts') return (additionalNativeOperations()?.shortcuts.read() ?? { status: 'unavailable', revision: null }) as State;
    if (domain === 'browserBackend' && !additionalNativeOperations()) return { status: 'unavailable', revision: null };
    if (domain === 'chatEmbedding') {
      const runtime = additionalSettingsRuntime()?.chatEmbedding;
      return runtime && runtime.available() ? project(domain, inspectHostChatEmbeddingSettings(runtime.context())) : { status: 'unavailable', revision: null };
    }
    if (toolDomains.has(domain)) return projectTools(domain, toolReader().inspectUserDefaults());
    if (domain === 'linuxWindow' && process.platform !== 'linux') return { status: 'unavailable', revision: null };
    if (domain === 'piCompaction' && inspectPiCompactionSettings(ownerScopedUserDataPath()).status !== 'ready') return { status: 'unavailable', revision: null };
    // Desktop preferences live in the app window and are only read asynchronously (readAdditionalSettings).
    if (isDesktopPreferenceDomain(domain)) return { status: 'unavailable', revision: null };
    return project(domain, storeFor(domain).inspect());
  } catch { return { status: 'unreadable', revision: null }; }
}
export async function readAdditionalSettings(domain: AdditionalSettingsDomain, workspaceId?: string): Promise<State> {
  if (domain === 'imWorkspaceProviders') return await additionalNativeOperations()?.imWorkspaceProviders.read() ?? { status: 'unavailable', revision: null };
  if (domain === 'imWorkspaces') return await additionalNativeOperations()?.imWorkspaces.read() ?? { status: 'unavailable', revision: null };
  if (domain === 'telegramGroups') return await additionalNativeOperations()?.telegramGroups.read() ?? { status: 'unavailable', revision: null };
  if (domain === 'pluginCindy' || domain === 'pluginSidebar' || domain === 'pluginErrand') return (await additionalNativeOperations()?.plugins.read(domain) ?? { status: 'unavailable', revision: null }) as State;
  if (isDesktopPreferenceDomain(domain)) return readDesktopPreferenceDomain(domain, () => additionalNativeOperations()?.themeChoices() ?? []);
  return inspectAdditionalSettings(domain, workspaceId);
}
export async function commitAdditionalSettings(domain: AdditionalSettingsDomain, change: { set: Values; clear: string[] }, options: OverrideSettingsCommitOptions, workspaceId?: string): Promise<State & { status: 'ready'; applicationFailed?: boolean }> {
  options.assertCurrent?.();
  if (retiredDomains.has(domain)) throw new HostSettingsError('UNSUPPORTED_CAPABILITY');
  if (inspectAdditionalSettings(domain, workspaceId).status !== 'ready') throw new HostSettingsError('UNREADABLE');
  if (domain === 'imWorkspaceProviders') {
    const native = additionalNativeOperations(); if (!native) throw new HostSettingsError('NOT_READY');
    return native.imWorkspaceProviders.commit(change, options);
  }
  if (domain === 'workspaceTools') {
    const native = additionalNativeOperations(); if (!native || !workspaceId) throw new HostSettingsError('INVALID_PARAMS');
    return native.workspaceTools.commit(workspaceId, change, options);
  }
  if (domain === 'imWorkspaces') {
    const native = additionalNativeOperations(); if (!native) throw new HostSettingsError('NOT_READY');
    return native.imWorkspaces.commit(change, options);
  }
  if (domain === 'wecomNotifications') {
    const native = additionalNativeOperations(); if (!native) throw new HostSettingsError('NOT_READY');
    return native.wecomNotifications.commit(change, options);
  }
  if (domain === 'officialHooks') {
    const native = additionalNativeOperations(); if (!native) throw new HostSettingsError('NOT_READY');
    return native.officialHooks.commit(change, options);
  }
  if (domain === 'telegramGroups') {
    const native = additionalNativeOperations(); if (!native) throw new HostSettingsError('NOT_READY');
    return native.telegramGroups.commit(change, options);
  }
  if (domain === 'pluginCindy' || domain === 'pluginSidebar' || domain === 'pluginErrand') {
    const native = additionalNativeOperations();
    if (!native) throw new HostSettingsError('NOT_READY');
    return await native.plugins.commit(domain, change, options) as State & { status: 'ready' };
  }
  if (domain === 'shortcuts') {
    const native = additionalNativeOperations();
    if (!native) throw new HostSettingsError('NOT_READY');
    return await native.shortcuts.commit(change, options) as State & { status: 'ready' };
  }
  if (domain === 'browserBackend') {
    const native = additionalNativeOperations();
    if (!native) throw new HostSettingsError('NOT_READY');
    const state = await native.commit(domain, change, options);
    return { ...project(domain, state), applicationFailed: state.applicationFailed } as State & { status: 'ready'; applicationFailed: boolean };
  }
  if (domain === 'chatEmbedding') {
    const runtime = additionalSettingsRuntime()?.chatEmbedding;
    if (!runtime || !runtime.available()) throw new HostSettingsError('UNSUPPORTED_CAPABILITY');
    return project(domain, await commitHostChatEmbeddingSettings(change as never, runtime.context(), options)) as State & { status: 'ready' };
  }
  if (toolDomains.has(domain)) {
    const result = await toolReader().commitUserDefaults(change as { set: Record<string, boolean>; clear: string[] }, options);
    return projectTools(domain, result) as State & { status: 'ready' };
  }
  const result = await storeFor(domain).commitAtomic(state => {
    const next = { ...state.value, ...Object.fromEntries(change.clear.map(key => [key, state.defaults[key]])), ...change.set };
    if (domain === 'collaboration' && Number(next.workerHardLimit) < Number(next.workerSoftLimit)) throw new HostSettingsError('INVALID_PARAMS');
    if (domain === 'terminal' && change.set.defaultShellPref !== undefined && change.set.defaultShellPref !== 'auto'
      && !probeAvailableShells().some(shell => shell.id === change.set.defaultShellPref)) throw new HostSettingsError('INVALID_PARAMS');
    if (domain === 'piCompaction') sealExplicitPiCompactionChoice();
    return change;
  }, options);
  return project(domain, result) as State & { status: 'ready' };
}
