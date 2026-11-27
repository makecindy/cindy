import { getHostPluginPreferenceContext } from '../cindy-brain/index.js';
import { getHostPluginCindyStore, inspectGhostCindyPrefs } from '../cindy-brain/cindyPrefsStore.js';
import { getHostPluginErrandStore, inspectGhostErrandPrefs } from '../cindy-brain/pluginTaskPrefsStore.js';
import { readKnownWorkspaces } from './readKnownWorkspaces.js';
import { readSettingsModelCatalog } from './catalog.js';
import { captureSettingsModelGuard } from './additionalModels.js';
import { isModelSelectableForNewRoute, isModelVisible } from '@cindy/model-providers';
import { getModelVisibilityOverride } from '../maker-host/model-visibility-mirror.js';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { inspectHostSidebarSettings, commitHostSidebarHidden } from '../sidebarSettingsStore.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { additionalSettingsSchema, PLUGIN_CINDY_FIELDS, settingsValuesEqual, type SettingsEditableValue } from '../../shared/settingsEditableCatalog.js';
import type { HostSettingState } from '../../shared/hostSettings.js';
import type { OverrideSettingsCommitOptions } from '../maker-host/override-settings-file.js';
import { HostSettingsError } from './operations.js';
type Values = Record<string, SettingsEditableValue>;
type Domain = 'pluginCindy' | 'pluginSidebar' | 'pluginErrand';
type Choice = { value: SettingsEditableValue; label: string; efforts?: string[]; supportsFast?: boolean };
const workspaceId = (value: string) => createHash('sha256').update(value).digest('base64url');
const errandRouteKeys = ['agentKind', 'model', 'providerId', 'effort', 'fastMode'] as const;
function choices(domain: Domain): Record<string, Choice[]> {
  const plugins = getHostPluginPreferenceContext();
  if (domain === 'pluginErrand') {
    const entries = plugins.filter(plugin => plugin.supported.agent).map(plugin => ({ value: { ghostId: plugin.id }, label: plugin.name }));
    const models = plugins.filter(plugin => plugin.supported.model).map(plugin => ({ value: { ghostId: plugin.id }, label: plugin.name }));
    return { routes: models, permissions: entries, workspaces: entries, directories: readKnownWorkspaces().knownWorkspaces.map(dir => ({ value: workspaceId(dir), label: path.basename(dir) || dir })) };
  }
  if (domain === 'pluginSidebar') return { hidden: plugins.filter(plugin => plugin.supported.mainView).map(plugin => ({ value: plugin.id, label: plugin.name })) };
  const result: Record<string, Choice[]> = {};
  // Keep the wire shape for older controllers, but offer no retired per-capability pins.
  for (const key of Object.keys(PLUGIN_CINDY_FIELDS)) result[key] = [];
  result.inflightLimits = plugins.filter(plugin => plugin.supported.cindy).map(plugin => ({ value: { ghostId: plugin.id }, label: plugin.name }));
  return result;
}
function ready(domain: Domain, revision: string, value: Values): HostSettingState<Values> & { status: 'ready' } {
  additionalSettingsSchema(domain).parse(value);
  const customizedKeys = Object.keys(value).filter(key => (value[key] as unknown[]).length > 0);
  return { status: 'ready', revision, value, defaults: Object.fromEntries(Object.keys(value).map(key => [key, []])), customizedKeys, isCustomized: customizedKeys.length > 0 };
}
function inspect(domain: Domain): HostSettingState<Values> {
  try {
    if (domain === 'pluginErrand') {
      if (inspectGhostErrandPrefs(ownerScopedUserDataPath()).status !== 'ready') return { status: 'unreadable', revision: null };
      const state = getHostPluginErrandStore().inspect();
      if (state.status !== 'ready') return state;
      const entries = Object.entries(state.value.errand);
      return ready(domain, state.revision, {
        routes: entries.filter(([, entry]) => errandRouteKeys.some(key => Object.hasOwn(entry, key))).map(([ghostId, entry]) => ({ ghostId,
          harness: entry.agentKind === 'cc' ? 'claude-code' : entry.agentKind ?? null, providerId: entry.providerId ?? null, modelId: entry.model ?? null, effort: entry.effort ?? null, fastMode: entry.fastMode ?? null })),
        permissions: entries.filter(([, entry]) => entry.permissionMode).map(([ghostId, entry]) => ({ ghostId, permissionMode: entry.permissionMode! })),
        workspaces: entries.filter(([, entry]) => entry.workingDir).map(([ghostId, entry]) => ({ ghostId, workspaceId: workspaceId(entry.workingDir!) })),
      });
    }
    if (domain === 'pluginSidebar') {
      const state = inspectHostSidebarSettings();
      return state.status !== 'ready' ? state : ready(domain, state.revision, { hidden: state.value.hiddenMainViewGhostIds });
    }
    if (inspectGhostCindyPrefs(ownerScopedUserDataPath()).status !== 'ready') return { status: 'unreadable', revision: null };
    const state = getHostPluginCindyStore().inspect();
    if (state.status !== 'ready') return state;
    return ready(domain, state.revision, { ...Object.fromEntries(Object.keys(PLUGIN_CINDY_FIELDS).map(key => [key, []])),
      inflightLimits: Object.entries(state.value.inflightLimits).map(([ghostId, limit]) => ({ ghostId, limit })) });
  } catch { return { status: 'unreadable', revision: null }; }
}
export const nativePluginSettings = {
  inspect,
  async read(domain: Domain) {
    const state = inspect(domain);
    if (state.status !== 'ready') return state;
    const options = choices(domain);
    if (domain === 'pluginErrand') options.modelRoutes = await errandModelChoices();
    if (!state.isCustomized && Object.values(options).every(list => !list.length)) return { status: 'unavailable' as const, revision: null };
    return { ...state, choices: options };
  },
  async commit(domain: Domain, change: { set: Values; clear: string[] }, options: OverrideSettingsCommitOptions) {
    const before = inspect(domain);
    if (before.status !== 'ready') throw new HostSettingsError('UNREADABLE');
    const modelGuard = domain === 'pluginErrand' ? captureSettingsModelGuard() : () => {};
    const routes = domain === 'pluginErrand' ? await errandModelChoices() : [];
    modelGuard();
    const validate = () => {
      options.assertCurrent?.();
      modelGuard();
      const available = choices(domain);
      for (const [field, value] of Object.entries(change.set)) for (const row of value as SettingsEditableValue[]) {
        if ((before.value[field] as SettingsEditableValue[]).some(old => settingsValuesEqual(old, row))) continue;
        if (domain === 'pluginSidebar') { if (!available.hidden?.some(item => item.value === row)) throw new HostSettingsError('UNSUPPORTED_CAPABILITY'); }
        else {
          const item = row as Record<string, string>;
          if (!available[field]?.some(option => (option.value as Values).ghostId === item.ghostId)) throw new HostSettingsError('UNSUPPORTED_CAPABILITY');
          if (domain === 'pluginErrand') {
            if (field === 'routes') {
              const selected = routes.find(option => ['harness', 'providerId', 'modelId'].every(key => (option.value as Values)[key] === (row as Values)[key]));
              if (!selected) throw new HostSettingsError('MODEL_UNAVAILABLE');
              if (item.effort && !selected.efforts?.includes(item.effort)) throw new HostSettingsError('EFFORT_UNSUPPORTED');
              if ((row as Values).fastMode && !selected.supportsFast) throw new HostSettingsError('FAST_UNSUPPORTED');
            } else if (field === 'workspaces' && !available.directories.some(option => option.value === item.workspaceId)) throw new HostSettingsError('UNSUPPORTED_CAPABILITY');
          } else if (field !== 'inflightLimits' && !available[`${field}:${item.ghostId}`]?.some(option => option.value === item.model)) throw new HostSettingsError('MODEL_UNAVAILABLE');
        }
      }
    };
    validate();
    if (domain === 'pluginErrand') {
      const next = { ...before.value, ...Object.fromEntries(change.clear.map(key => [key, []])), ...change.set };
      const state = await getHostPluginErrandStore().commitAtomic((current, rawOverrides) => {
        const errand = structuredClone(rawOverrides.errand ?? current.value.errand);
        const previousPaths = new Map(Object.values(errand).filter(entry => entry.workingDir).map(entry => [workspaceId(entry.workingDir!), entry.workingDir!]));
        const paths = new Map([...previousPaths, ...readKnownWorkspaces().knownWorkspaces.map(dir => [workspaceId(dir), dir] as const)]);
        for (const field of [...change.clear, ...Object.keys(change.set)]) {
          for (const entry of Object.values(errand)) for (const key of field === 'routes' ? errandRouteKeys : field === 'permissions' ? ['permissionMode'] as const : ['workingDir'] as const) delete entry[key];
          for (const row of next[field] as Values[]) {
            const entry = errand[String(row.ghostId)] ??= {};
            if (field === 'routes') {
              if (row.harness) entry.agentKind = row.harness === 'claude-code' ? 'cc' : row.harness as 'codex' | 'pi';
              if (row.providerId) entry.providerId = String(row.providerId);
              if (row.modelId) entry.model = String(row.modelId);
              if (row.effort) entry.effort = row.effort as typeof entry.effort;
              if (row.fastMode !== null) entry.fastMode = row.fastMode === true;
            } else if (field === 'permissions') entry.permissionMode = row.permissionMode as typeof entry.permissionMode;
            else {
              const dir = paths.get(String(row.workspaceId));
              if (!dir) throw new HostSettingsError('UNSUPPORTED_CAPABILITY');
              entry.workingDir = dir;
            }
          }
        }
        for (const [id, entry] of Object.entries(errand)) if (!Object.keys(entry).length) delete errand[id];
        return { set: { errand } };
      }, { ...options, assertCurrent: validate });
      return ready(domain, state.revision, next);
    }
    if (domain === 'pluginSidebar') {
      const hidden = change.clear.includes('hidden') ? [] : change.set.hidden as string[];
      const result = await commitHostSidebarHidden(hidden, { ...options, assertCurrent: validate });
      return ready(domain, result.revision, { hidden });
    }
    // Do not accept older clients' writes to model pins that the runtime does not consume.
    if ([...change.clear, ...Object.keys(change.set)].some(field => field !== 'inflightLimits'))
      throw new HostSettingsError('UNSUPPORTED_CAPABILITY');
    const next = { ...before.value, ...Object.fromEntries(change.clear.map(key => [key, []])), ...change.set };
    const result = await getHostPluginCindyStore().commitAtomic(() => ({ set: {
      inflightLimits: Object.fromEntries((next.inflightLimits as Array<{ ghostId: string; limit: number }>).map(row => [row.ghostId, row.limit])),
    } }), { ...options, assertCurrent: validate });
    return ready(domain, result.revision, next);
  },
};

async function errandModelChoices(): Promise<Choice[]> {
  const catalog = await readSettingsModelCatalog();
  const result = catalog.providers.filter(provider => provider.connected && !provider.suspended && !provider.modelDiscoveryFailure).flatMap(provider =>
    catalog.agents.flatMap(harness => (provider.models[harness] ?? []).filter(model => model.id.length <= 128 && provider.id.length <= 128
      && isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' }) && isModelVisible(getModelVisibilityOverride(harness, provider.id, model.id), model.defaultEnabled))
      .map(model => ({ value: { harness, providerId: provider.id, modelId: model.id }, label: `${model.name} · ${provider.name} · ${harness}`, efforts: model.efforts.filter(effort => effort !== 'minimal'), supportsFast: model.supportsFastMode === true }))));
  catalog.assertCurrent(); return result;
}
