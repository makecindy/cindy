import { createHash } from 'node:crypto';
import { getHostWorkspacePrefsStore, commitHostWorkspacePrefs, SHARED_PREFS_CHANNEL, type WorkspacePrefsEntry } from '../hook-control/workspacePrefsStore.js';
import { getHostHookPreferencesContext } from '../hook-control/ipc.js';
import { getWorkspaceProviderSource } from '../hook-control/workspaceProviderSourceStore.js';
import { readSettingsModelCatalog } from './catalog.js';
import { captureSettingsModelGuard } from './additionalModels.js';
import { isModelSelectableForNewRoute, isModelVisible } from '@cindy/model-providers';
import { getModelVisibilityOverride } from '../maker-host/model-visibility-mirror.js';
import { additionalSettingsSchemas, settingsValuesEqual, type SettingsEditableValue } from '../../shared/settingsEditableCatalog.js';
import type { OverrideSettingsCommitOptions } from '../maker-host/override-settings-file.js';
import { HostSettingsError } from './operations.js';
import { HOOK_CHAT_WORKSPACE_ALIAS } from '../../shared/hookControlIpc.js';
type Key = Pick<WorkspacePrefsEntry, 'channel' | 'teamId' | 'workspace'>;
const idFor = (row: Key) => createHash('sha256').update(JSON.stringify([row.channel, row.teamId, row.workspace])).digest('base64url');
// Official bots share one set of project settings; per-channel rows only mirror it to each server.
const meaningful = (row: WorkspacePrefsEntry) => row.channel === SHARED_PREFS_CHANNEL && ['agentKind', 'model', 'effort', 'permissionMode'].some(key => row[key as keyof WorkspacePrefsEntry] !== null);
function project(state: ReturnType<ReturnType<typeof getHostWorkspacePrefsStore>['inspect']>) {
  if (state.status !== 'ready') return state;
  const entries = state.value.entries.filter(meaningful).map(row => ({ workspaceId: idFor(row), harness: row.agentKind === 'cc' ? 'claude-code' : row.agentKind, modelId: row.model, effort: row.effort, permissionMode: row.permissionMode }));
  const value = additionalSettingsSchemas.imWorkspaces.parse({ entries });
  return { status: 'ready' as const, revision: state.revision, value, defaults: { entries: [] }, customizedKeys: entries.length ? ['entries'] : [], isCustomized: entries.length > 0 };
}
function inspect() { return project(getHostWorkspacePrefsStore().inspect()); }
function contextStamp() {
  const context = getHostHookPreferencesContext();
  return JSON.stringify([context?.fingerprint, context?.targets.map(target => [idFor(target), getWorkspaceProviderSource(target.channel, target.teamId, target.workspace)])]);
}
async function choices() {
  const targets = getHostHookPreferencesContext()?.targets ?? [];
  const previous = getHostWorkspacePrefsStore().inspect();
  const historical = previous.status === 'ready' ? previous.value.entries.filter(meaningful).filter(row => !targets.some(target => idFor(target) === idFor(row))) : [];
  const result: Record<string, Array<{ value: SettingsEditableValue; label: string; efforts?: string[] }>> = {
    entries: [...targets.map(target => ({ value: { workspaceId: idFor(target) }, label: target.label })), ...historical.map(row => ({ value: { workspaceId: idFor(row) }, label: row.workspace === HOOK_CHAT_WORKSPACE_ALIAS ? 'Cindy' : row.workspace }))],
  };
  if (!targets.length) return result;
  const catalog = await readSettingsModelCatalog();
  for (const target of targets) {
    const providerId = getWorkspaceProviderSource(target.channel, target.teamId, target.workspace);
    const models = catalog.providers.filter(provider => provider.connected && !provider.suspended && !provider.modelDiscoveryFailure && (!providerId || providerId === provider.id)).flatMap(provider =>
      catalog.agents.flatMap(harness => (provider.models[harness] ?? []).filter(model => model.id.length <= 128 && isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' }) && isModelVisible(getModelVisibilityOverride(harness, provider.id, model.id), model.defaultEnabled))
        .map(model => ({ value: { harness, modelId: model.id }, label: `${model.name} · ${provider.name} · ${harness}`, efforts: model.efforts }))));
    result[`entries:${idFor(target)}`] = models.filter((model, index) => models.findIndex(other => settingsValuesEqual(other.value, model.value)) === index);
  }
  catalog.assertCurrent(); return result;
}
export const nativeWorkspaceSettings = {
  inspect,
  async read() {
    const state = inspect(); if (state.status !== 'ready') return state;
    const options = await choices();
    if (!options.entries.length && !state.isCustomized) return { status: 'unavailable' as const, revision: null };
    return { ...state, choices: options };
  },
  async commit(change: { set: Record<string, SettingsEditableValue>; clear: string[] }, options: OverrideSettingsCommitOptions) {
    const before = inspect(); if (before.status !== 'ready') throw new HostSettingsError('UNREADABLE');
    const entries = change.clear.includes('entries') ? [] : additionalSettingsSchemas.imWorkspaces.parse(change.set).entries;
    const guard = captureSettingsModelGuard(), stamp = contextStamp();
    const available = await choices();
    const targets = getHostHookPreferencesContext()?.targets ?? [];
    const assertCurrent = () => { options.assertCurrent?.(); guard(); if (contextStamp() !== stamp) throw new HostSettingsError('CONFLICT'); };
    assertCurrent();
    for (const row of entries) {
      if (before.value.entries.some(old => settingsValuesEqual(old, row))) continue;
      if (!targets.some(target => idFor(target) === row.workspaceId)) throw new HostSettingsError('UNSUPPORTED_CAPABILITY');
      const model = row.harness === null && row.modelId === null ? null : available[`entries:${row.workspaceId}`]?.find(option => settingsValuesEqual(option.value, { harness: row.harness, modelId: row.modelId }));
      if (model === undefined) throw new HostSettingsError('MODEL_UNAVAILABLE');
      if (row.effort && (!model || !model.efforts?.includes(row.effort))) throw new HostSettingsError('EFFORT_UNSUPPORTED');
    }
    const raw = getHostWorkspacePrefsStore().inspect(); if (raw.status !== 'ready') throw new HostSettingsError('UNREADABLE');
    const keys = new Map([...raw.value.entries, ...targets].map(row => [idFor(row), row]));
    const updates = [];
    for (const id of new Set([...before.value.entries.map(row => row.workspaceId), ...entries.map(row => row.workspaceId)])) {
      const previous = before.value.entries.find(row => row.workspaceId === id), next = entries.find(row => row.workspaceId === id);
      if (settingsValuesEqual(previous, next)) continue;
      const key = keys.get(id); if (!key) throw new HostSettingsError('CONFLICT');
      updates.push({ channel: key.channel, teamId: key.teamId, workspace: key.workspace, patch: { agentKind: next?.harness ?? null, model: next?.modelId ?? null, effort: next?.effort ?? null, permissionMode: next?.permissionMode ?? null } });
    }
    const result = project(await commitHostWorkspacePrefs(updates, { ...options, assertCurrent }));
    if (result.status !== 'ready') throw new HostSettingsError('UNREADABLE');
    let applicationFailed = false;
    try { options.assertCurrent?.(); getHostHookPreferencesContext()?.preferencesChanged(); } catch { applicationFailed = true; }
    return { ...result, applicationFailed };
  },
};
