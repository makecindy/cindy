import { inspectModelPreferences, commitModelPreferences } from './additionalModelPreferences.js';
import { isModelPresentationDomain, readModelPresentationDomain, commitModelPresentationDomain } from './modelPresentationDomains.js';
import { inspectImSettings, commitImSettings } from './additionalIm.js';
import { app } from 'electron';
import { SETTINGS_WEB_MAX_CHOICES } from '../../shared/settingsWeb.js';
import { isModelSelectableForNewRoute, isModelVisible } from '@cindy/model-providers';
import { additionalSettingsSchema, settingsValuesEqual, isImSettingsDomain, isModelPreferenceDomain, type ModelSettingsDomain, type SettingsEditableValue } from '../../shared/settingsEditableCatalog.js';
import type { HostSettingState } from '../../shared/hostSettings.js';
import { getSubagentModelSettingsStore } from '../maker-host/subagent-model-settings-store.js';
import { getAuxiliaryModelSettingsStore, inspectAuxiliaryModelSettings } from '../utility-model/auxiliary-model-settings-store.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { currentSettingsOwner } from './personalization.js';
import { readSettingsModelCatalog } from './catalog.js';
import { getModelVisibilityOverride } from '../maker-host/model-visibility-mirror.js';
import { getActiveCatalog, getActiveCatalogRevision } from '../maker-host/active-catalog.js';
import { getProviderRouteMutationStamp } from '../maker-host/provider-route.js';
import { readModelDisableOverrides, getHostModelAccessStore } from '../maker-host/model-disable-store.js';
import { getModelVisibilityMirrorSnapshot } from '../maker-host/model-visibility-mirror.js';
import { readProviderOrder } from '../maker-host/provider-order-store.js';
import { buildTextOneshotPinOptions } from '../utility-model/textOneshotPinOptions.js';
import { hasOneshotProviderCredential } from '../utility-model/oneshotProviderUsability.js';
import type { OverrideSettingsCommitOptions, OverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { HostSettingsError } from './operations.js';
import { getHostModelPriceCurrencies } from '../usage/modelPriceOverrideStore.js';

type Values = Record<string, SettingsEditableValue>;
type State = HostSettingState<Values>;
export type SettingsChoice = { value: SettingsEditableValue; label: string; efforts?: string[]; supportsFast?: boolean };
const stores = { subagentModel: getSubagentModelSettingsStore, auxiliaryModel: getAuxiliaryModelSettingsStore };
function storeFor(domain: ModelSettingsDomain) { return stores[domain as keyof typeof stores]() as unknown as OverrideSettingsFile<Values>; }
function project(domain: ModelSettingsDomain, state: State): State {
  if (state.status !== 'ready') return state;
  const schema = additionalSettingsSchema(domain);
  const pick = (raw: Values) => domain === 'subagentModel'
    ? { claudeCode: raw.claudeCode === null ? null : { modelId: raw.claudeCode, providerId: raw.claudeCodeProviderId }, codexSmartSubagentRouting: raw.codexSmartSubagentRouting }
    : Object.fromEntries(Object.keys(schema.shape).map(key => [key, raw[key]]));
  const value = schema.parse(pick(state.value)) as Values;
  const defaults = schema.parse(pick(state.defaults)) as Values;
  const customizedKeys = Object.keys(schema.shape).filter(key => state.customizedKeys.includes(key)
    || domain === 'subagentModel' && key === 'claudeCode' && state.customizedKeys.includes('claudeCodeProviderId'));
  return { ...state, value, defaults, customizedKeys, isCustomized: customizedKeys.length > 0 };
}
export function inspectModelSettings(domain: ModelSettingsDomain): State {
  try {
    if (isModelPreferenceDomain(domain)) return inspectModelPreferences(domain);
    if (isImSettingsDomain(domain)) return inspectImSettings(domain);
    // The app has no vision bridge; the editable catalog keeps the domain for older clients.
    if (domain === 'visionBridge') return { status: 'unavailable', revision: null };
    if (domain === 'auxiliaryModel') {
      const ownerId = currentSettingsOwner()?.dataOwnerId;
      if (!ownerId || inspectAuxiliaryModelSettings({ ownerId, ownerRoot: ownerScopedUserDataPath(), userDataPath: app.getPath('userData') }).status !== 'ready') {
        return { status: 'unavailable', revision: null };
      }
    }
    return project(domain, storeFor(domain).inspect());
  } catch { return { status: 'unreadable', revision: null }; }
}
/** Visibility, engines and favorites live in the app window and are read asynchronously. */
async function currentModelSettings(domain: ModelSettingsDomain): Promise<State> {
  return isModelPresentationDomain(domain) ? readModelPresentationDomain(domain) : inspectModelSettings(domain);
}
export async function modelSettingsChoices(domain: ModelSettingsDomain): Promise<Record<string, SettingsChoice[]>> {
  const catalog = await readSettingsModelCatalog();
  const models = catalog.providers.flatMap(provider => provider.connected && !provider.suspended && !provider.modelDiscoveryFailure
    ? catalog.agents.flatMap(agent => provider.agents.includes(agent) ? (provider.models[agent] ?? [])
      .filter(model => isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' })
        && isModelVisible(getModelVisibilityOverride(agent, provider.id, model.id), model.defaultEnabled))
      .map(model => ({ provider, model, agent })) : []) : []);
  const allModels = catalog.providers.flatMap(provider => catalog.agents.flatMap(agent => provider.agents.includes(agent)
    ? (provider.models[agent] ?? []).map(model => ({ provider, model, agent })) : []));
  const unique = (items: SettingsChoice[]) => items.filter((item, index) => items.findIndex(other => settingsValuesEqual(other.value, item.value)) === index);
  let choices: Record<string, SettingsChoice[]>;
  if (isModelPreferenceDomain(domain)) {
    const routes = allModels.map(({ provider, model, agent }) => ({ value: { providerId: provider.id, modelId: model.id, harness: agent },
      label: `${model.name} · ${provider.name} · ${agent === 'claude-code' ? 'Claude Code' : agent === 'codex' ? 'Codex' : 'Pi'}`, efforts: model.efforts, supportsFast: model.supportsFastMode === true }));
    choices = domain === 'providerNames' ? { entries: catalog.providers.filter(provider => provider.source === 'builtin').map(provider => ({ value: { providerId: provider.id }, label: provider.name })) }
      : domain === 'modelPrices' ? { entries: routes.filter(item => item.value.providerId !== 'xd'), currency: getHostModelPriceCurrencies().map(value => ({ value, label: value })) }
      : domain === 'modelAccess' ? {
      models: unique(allModels.map(({ provider, model }) => ({ value: { providerId: provider.id, modelId: model.id }, label: `${model.name} · ${provider.name}` }))),
      providers: catalog.providers.map(provider => ({ value: provider.id, label: provider.name })),
    } : { entries: routes };
  } else if (isImSettingsDomain(domain)) {
    const permissions = domain === 'imWechat' ? ['ask', 'default', 'plan', 'auto'] : ['ask', 'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
    choices = {
      agentKind: catalog.agents.filter(agent => domain !== 'imWechat' || agent !== 'pi').map(agent => ({ value: agent, label: agent })),
      permissionMode: permissions.map(value => ({ value, label: value })),
      ...Object.fromEntries(['claude-code', 'codex', 'pi'].map(agent => [agent === 'claude-code' ? 'claudeCode' : agent,
        models.filter(item => item.agent === agent).map(({ provider, model }) => ({
          value: { providerId: provider.id, modelId: model.id, effort: model.defaultEffort ?? model.efforts[0] ?? 'high' },
          label: `${model.name} · ${provider.name}`, efforts: model.efforts,
        })),
      ])),
    };
  } else if (domain === 'subagentModel') choices = { claudeCode: models.filter(item => item.agent === 'claude-code').map(({ provider, model }) => ({ value: { providerId: provider.id, modelId: model.id }, label: `${model.name} · ${provider.name}` })) };
  else if (domain === 'auxiliaryModel') {
    choices = { models: buildTextOneshotPinOptions(getActiveCatalog(), readModelDisableOverrides(), readProviderOrder(), hasOneshotProviderCredential)
      .map(option => ({ value: option.id, label: option.label })) };
  } else choices = { modelChain: models.map(({ provider, model, agent }) => ({ value: {
    harness: agent === 'claude-code' ? 'claude' : agent, providerId: provider.id, model: model.id,
    effort: model.defaultEffort && model.efforts.includes(model.defaultEffort) ? model.defaultEffort : '', fastMode: false,
  }, label: `${model.name} · ${provider.name} · ${agent === 'claude-code' ? 'Claude Code' : agent === 'codex' ? 'Codex' : 'Pi'}`, efforts: model.efforts, supportsFast: model.supportsFastMode === true })) };
  catalog.assertCurrent();
  if (Object.values(choices).some(options => options.length > SETTINGS_WEB_MAX_CHOICES || options.some(option => option.label.length > 512))) throw new HostSettingsError('MODEL_CATALOG_TOO_LARGE');
  return choices;
}
export function captureSettingsModelGuard() {
  const stamp = () => [getActiveCatalogRevision(), getProviderRouteMutationStamp(),
    getHostModelAccessStore().inspect().revision, JSON.stringify(getModelVisibilityMirrorSnapshot([], true))].join(':');
  if (!getProviderRouteMutationStamp().endsWith(':0')) throw new HostSettingsError('CONFLICT');
  const expected = stamp();
  const assertCurrent = () => { if (stamp() !== expected) throw new HostSettingsError('CONFLICT'); };
  return assertCurrent;
}
export async function validateModelSettingsChange(domain: ModelSettingsDomain, change: { set: Values; clear: string[] }) {
  // There is no teammate model chain editor and no vision bridge; neither can be written here.
  if (domain === 'botModelChain' || domain === 'visionBridge') throw new HostSettingsError('UNSUPPORTED_CAPABILITY');
  const assertCurrent = captureSettingsModelGuard();
  const choices = await modelSettingsChoices(domain);
  assertCurrent();
  const before = await currentModelSettings(domain);
  if (before.status !== 'ready') throw new HostSettingsError('UNREADABLE');
  for (const [key, value] of Object.entries(change.set)) {
    if (!(key in choices) || value === null) continue;
    const selected = Array.isArray(value) ? value : [value];
    if (domain === 'auxiliaryModel' && !selected.length) throw new HostSettingsError('INVALID_PARAMS');
    const previous = Array.isArray(before.value[key]) ? before.value[key] as SettingsEditableValue[] : [before.value[key]];
    for (const item of selected) {
      const match = (candidate: SettingsEditableValue) => settingsValuesEqual(candidate, item);
      if (previous.some(match)) continue;
      if ((isImSettingsDomain(domain) || isModelPreferenceDomain(domain)) && typeof item === 'object' && item && !Array.isArray(item)) {
        if (isImSettingsDomain(domain) && item.modelId === '' && item.providerId === null) continue;
        const selectedRoute = choices[key]!.find(option => (domain === 'modelAccess' || isImSettingsDomain(domain) ? ['providerId', 'modelId'] : ['harness', 'providerId', 'modelId']).every(part =>
          (option.value as Values)[part] === item[part]));
        if (!selectedRoute) throw new HostSettingsError('MODEL_UNAVAILABLE');
        if (item.effort && selectedRoute.efforts?.length && !selectedRoute.efforts.includes(String(item.effort))) throw new HostSettingsError('EFFORT_UNSUPPORTED');
        if ((item.fastMode || item.fast) && !selectedRoute.supportsFast) throw new HostSettingsError('FAST_UNSUPPORTED');
      } else if (!choices[key]!.some(option => match(option.value))) throw new HostSettingsError('MODEL_UNAVAILABLE');
    }
  }
  return { choices, assertCurrent };
}
export async function commitModelSettings(domain: ModelSettingsDomain, change: { set: Values; clear: string[] }, options: OverrideSettingsCommitOptions): Promise<State & { status: 'ready' }> {
  if (isModelPresentationDomain(domain)) return commitModelPresentationDomain(domain, change, () => options.assertCurrent?.());
  if (isModelPreferenceDomain(domain)) return commitModelPreferences(domain, change, options);
  if (isImSettingsDomain(domain)) return commitImSettings(domain, change, options);
  // subagentModel and auxiliaryModel are saved through their settings sections.
  const result = await storeFor(domain).commitAtomic(change, options);
  return project(domain, result as State) as State & { status: 'ready' };
}

/** Interpret dynamic defaults without writing them as overrides. */
export async function readModelSettings(domain: ModelSettingsDomain) {
  // There is no global teammate model chain editor; it stays read-only.
  if (domain === 'botModelChain' || domain === 'visionBridge') return { status: 'unavailable' as const, revision: null };
  const before = await currentModelSettings(domain);
  if (before.status !== 'ready') return before;
  const choices = await modelSettingsChoices(domain);
  const value = before.value, defaults = before.defaults;
  if (domain === 'auxiliaryModel') {
    const native = inspectAuxiliaryModelSettings({ ownerId: currentSettingsOwner()!.dataOwnerId!, ownerRoot: ownerScopedUserDataPath(), userDataPath: app.getPath('userData') });
    if (native.status !== 'ready') throw new HostSettingsError('UNREADABLE');
    if (native.sources.models === 'override' && !before.customizedKeys.includes('models')) {
      before.customizedKeys.push('models'); before.isCustomized = true;
    }
  }
  if ((await currentModelSettings(domain)).revision !== before.revision) throw new HostSettingsError('CONFLICT');
  return { ...before, value, defaults, choices };
}
