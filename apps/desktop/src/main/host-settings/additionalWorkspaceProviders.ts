import { createHash } from 'node:crypto';
import { getHostWorkspaceProviderSourceStore, commitHostWorkspaceProviderSources, type WorkspaceProviderSourceEntry } from '../hook-control/workspaceProviderSourceStore.js';
import { SHARED_PREFS_CHANNEL } from '../hook-control/workspacePrefsStore.js';
import { getHostHookPreferencesContext, notifyHostWorkspaceProviderSourcesChanged } from '../hook-control/ipc.js';
import { readSettingsModelCatalog } from './catalog.js';
import { captureSettingsModelGuard } from './additionalModels.js';
import { additionalSettingsSchemas, settingsValuesEqual, type SettingsEditableValue } from '../../shared/settingsEditableCatalog.js';
import type { OverrideSettingsCommitOptions } from '../maker-host/override-settings-file.js';
import { HostSettingsError } from './operations.js';
import { HOOK_CHAT_WORKSPACE_ALIAS } from '../../shared/hookControlIpc.js';
type Key = Pick<WorkspaceProviderSourceEntry, 'channel' | 'teamId' | 'workspace'>;
const idFor = (row: Key) => createHash('sha256').update(JSON.stringify([row.channel, row.teamId, row.workspace])).digest('base64url');
// Official bots share one set of project sources; per-channel rows are older data kept as is.
const shared = (row: Key) => row.channel === SHARED_PREFS_CHANNEL;
function project(state: ReturnType<ReturnType<typeof getHostWorkspaceProviderSourceStore>['inspect']>) {
  if (state.status !== 'ready') return state;
  const value = additionalSettingsSchemas.imWorkspaceProviders.parse({ entries: state.value.entries.filter(shared).map(row => ({ workspaceId: idFor(row), providerId: row.providerId })) });
  return { status: 'ready' as const, revision: state.revision, value, defaults: { entries: [] }, customizedKeys: value.entries.length ? ['entries'] : [], isCustomized: value.entries.length > 0 };
}
function inspect() { return project(getHostWorkspaceProviderSourceStore().inspect()); }
export const nativeWorkspaceProviderSettings = {
  inspect,
  async read() {
    const raw = getHostWorkspaceProviderSourceStore().inspect();
    const state = project(raw); if (state.status !== 'ready' || raw.status !== 'ready') return state;
    const targets = getHostHookPreferencesContext()?.targets ?? [];
    if (!targets.length && !state.isCustomized) return { status: 'unavailable' as const, revision: null };
    const historical = raw.value.entries.filter(shared).filter(row => !targets.some(target => idFor(target) === idFor(row)));
    const catalog = await readSettingsModelCatalog(); catalog.assertCurrent();
    return { ...state, choices: {
      entries: [...targets.map(row => ({ value: { workspaceId: idFor(row) }, label: row.label })), ...historical.map(row => ({ value: { workspaceId: idFor(row) }, label: row.workspace === HOOK_CHAT_WORKSPACE_ALIAS ? 'Cindy' : row.workspace }))],
      providers: catalog.providers.filter(provider => provider.connected && !provider.suspended && !provider.modelDiscoveryFailure && provider.id.length <= 128).map(provider => ({ value: provider.id, label: provider.name })),
    } };
  },
  async commit(change: { set: Record<string, SettingsEditableValue>; clear: string[] }, options: OverrideSettingsCommitOptions) {
    const raw = getHostWorkspaceProviderSourceStore().inspect(), before = project(raw);
    if (before.status !== 'ready' || raw.status !== 'ready') throw new HostSettingsError('UNREADABLE');
    const desired = change.clear.includes('entries') ? [] : additionalSettingsSchemas.imWorkspaceProviders.parse(change.set).entries;
    const guard = captureSettingsModelGuard();
    const context = getHostHookPreferencesContext();
    const stamp = JSON.stringify([context?.fingerprint, context?.targets]);
    const catalog = await readSettingsModelCatalog();
    const assertCurrent = () => {
      options.assertCurrent?.(); guard(); catalog.assertCurrent();
      const latest = getHostHookPreferencesContext();
      if (JSON.stringify([latest?.fingerprint, latest?.targets]) !== stamp) throw new HostSettingsError('CONFLICT');
    };
    assertCurrent();
    const keys = new Map([...raw.value.entries, ...(context?.targets ?? [])].map(row => [idFor(row), row]));
    const entries = desired.map(row => {
      const key = keys.get(row.workspaceId); if (!key) throw new HostSettingsError('UNSUPPORTED_CAPABILITY');
      const changed = !before.value.entries.some(old => settingsValuesEqual(row, old));
      if (changed && (!(context?.targets ?? []).some(target => idFor(target) === row.workspaceId)
        || !catalog.providers.some(provider => provider.id === row.providerId && provider.connected && !provider.suspended && !provider.modelDiscoveryFailure))) throw new HostSettingsError('MODEL_UNAVAILABLE');
      // 仅对本次改动了供应商的行清掉智能路由；未改动的行由 commitHostWorkspaceProviderSources 保留原元数据。
      return {
        channel: key.channel,
        teamId: key.teamId,
        workspace: key.workspace,
        providerId: row.providerId,
        ...(changed ? { modelGroup: undefined } : {}),
      };
    });
    const kept = raw.value.entries.filter(row => !shared(row));
    const edited = [...new Set([...before.value.entries, ...desired].filter(row => !before.value.entries.some(old => settingsValuesEqual(old, row)) || !desired.some(next => settingsValuesEqual(next, row))).map(row => keys.get(row.workspaceId)?.workspace).filter((name): name is string => name !== undefined))];
    const result = project(await commitHostWorkspaceProviderSources([...kept, ...entries], { ...options, assertCurrent }));
    if (result.status !== 'ready') throw new HostSettingsError('UNREADABLE');
    let applicationFailed = false;
    try { options.assertCurrent?.(); notifyHostWorkspaceProviderSourcesChanged(edited); } catch { applicationFailed = true; }
    return { ...result, applicationFailed };
  },
};
