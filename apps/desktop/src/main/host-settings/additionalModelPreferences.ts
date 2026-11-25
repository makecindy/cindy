import { additionalSettingsSchema, additionalSettingsSchemas, type ModelPreferenceDomain, type SettingsEditableValue } from '../../shared/settingsEditableCatalog.js';
import type { HostSettingState } from '../../shared/hostSettings.js';
import { getHostModelContextStore, inspectModelContextLimits, modelContextLimitKey } from '../maker-host/model-context-limit-store.js';
import { getHostModelAccessStore, inspectModelDisableOverrides } from '../maker-host/model-disable-store.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { modelDisableKey } from '@cindy/model-providers';
import type { OverrideSettingsCommitOptions } from '../maker-host/override-settings-file.js';
import { HostSettingsError } from './operations.js';
import { getHostProviderPresentationStore, inspectProviderPresentations } from '../maker-host/provider-presentation-store.js';
import { getHostModelPriceStore, readModelPriceOverrideView, inspectModelPriceOverrides, commitHostModelPrices } from '../usage/modelPriceOverrideStore.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
type Values = Record<string, SettingsEditableValue>;
type State = HostSettingState<Values>;
type Entry = { harness: 'claude-code' | 'codex' | 'pi'; providerId: string; modelId: string; limit?: number };
function parseTarget(key: string, withHarness = true) {
  const parts = key.split(':');
  const harness = withHarness ? parts.shift() : undefined;
  const providerId = parts.shift(), modelId = parts.join(':');
  if (!providerId || !modelId || withHarness && !['claude-code', 'codex', 'pi'].includes(harness!)) throw new HostSettingsError('UNREADABLE');
  return { ...(withHarness ? { harness } : {}), providerId, modelId };
}
function ready(domain: ModelPreferenceDomain, revision: string, value: Values): State & { status: 'ready' } {
  additionalSettingsSchema(domain).parse(value);
  const defaults = Object.fromEntries(Object.keys(value).map(key => [key, []]));
  const customizedKeys = Object.entries(value).filter(([, value]) => Array.isArray(value) && value.length > 0).map(([key]) => key);
  return { status: 'ready', revision, value, defaults, customizedKeys, isCustomized: customizedKeys.length > 0 };
}
export function inspectModelPreferences(domain: ModelPreferenceDomain): State {
  try {
    if (domain === 'providerNames') {
      if (inspectProviderPresentations(ownerScopedUserDataPath()).status !== 'ready') return { status: 'unreadable', revision: null };
      const state = getHostProviderPresentationStore().inspect();
      if (state.status !== 'ready') return state;
      const entries = Object.entries({ openai: state.value, ...state.value.providers }).filter(([, value]) => value.name).map(([providerId, value]) => ({ providerId, name: value.name! }));
      return ready(domain, state.revision, { entries });
    }
    if (domain === 'modelPrices') {
      if (inspectModelPriceOverrides(ownerScopedUserDataPath()).status !== 'ready') return { status: 'unreadable', revision: null };
      const state = getHostModelPriceStore().inspect();
      if (state.status !== 'ready') return state;
      const entries = Object.values(state.value.entries).map(item => {
        const quote = readModelPriceOverrideView(item, getActiveCatalog().modelRegistry).effective;
        if (!quote) throw new HostSettingsError('UNREADABLE');
        return { harness: item.agent, providerId: item.providerId, modelId: item.modelId, currency: quote.currency,
          inputPerMtok: quote.inputPerMtok, outputPerMtok: quote.outputPerMtok, cacheReadPerMtok: quote.cacheReadPerMtok ?? null, cacheCreatePerMtok: quote.cacheCreatePerMtok ?? null };
      });
      return ready(domain, state.revision, { entries });
    }
    if (domain === 'modelContext') {
      if (inspectModelContextLimits(ownerScopedUserDataPath()).status !== 'ready') return { status: 'unreadable', revision: null };
      const state = getHostModelContextStore().inspect();
      return state.status !== 'ready' ? state : ready(domain, state.revision, { entries: Object.entries(state.value.limits).map(([key, limit]) => ({ ...parseTarget(key), limit })) } as Values);
    }
    if (domain === 'modelAccess') {
      if (inspectModelDisableOverrides(ownerScopedUserDataPath()).status !== 'ready') return { status: 'unreadable', revision: null };
      const state = getHostModelAccessStore().inspect();
      return state.status !== 'ready' ? state : ready(domain, state.revision, { models: Object.keys(state.value.disabledModels).map(key => parseTarget(key, false)), providers: Object.keys(state.value.disabledProviders) } as Values);
    }
    // Visibility, engines and favorites are read asynchronously through the app (modelPresentationDomains).
    return { status: 'unavailable', revision: null };
  } catch { return { status: 'unreadable', revision: null }; }
}
export async function commitModelPreferences(domain: ModelPreferenceDomain, change: { set: Values; clear: string[] }, options: OverrideSettingsCommitOptions): Promise<State & { status: 'ready' }> {
  const values = (key: string) => change.clear.includes(key) ? [] : change.set[key] as Entry[] | undefined;
  if (domain === 'providerNames') {
    const entries = change.clear.includes('entries') ? [] : additionalSettingsSchemas.providerNames.parse(change.set).entries;
    const state = await getHostProviderPresentationStore().commitAtomic((current, rawOverrides) => {
      if (inspectModelPreferences(domain).status !== 'ready') throw new HostSettingsError('UNREADABLE');
      const providers = structuredClone(rawOverrides.providers ?? current.value.providers ?? {});
      for (const value of Object.values(providers)) delete value.name;
      const set: { name?: string; providers: typeof providers } = { providers };
      for (const entry of entries) {
        if (entry.providerId === 'openai') set.name = entry.name;
        else providers[entry.providerId] = { ...providers[entry.providerId], name: entry.name };
      }
      return { set, clear: set.name ? [] : ['name'] };
    }, options);
    return ready(domain, state.revision, { entries });
  }
  if (domain === 'modelPrices') {
    const entries = change.clear.includes('entries') ? [] : additionalSettingsSchemas.modelPrices.parse(change.set).entries;
    const state = await commitHostModelPrices(entries.map(({ harness, ...entry }) => ({ ...entry, agent: harness })), getActiveCatalog().modelRegistry, options);
    return ready(domain, state.revision, { entries });
  }
  if (domain === 'modelContext') {
    const state = await getHostModelContextStore().commitAtomic(() => {
      if (inspectModelPreferences(domain).status !== 'ready') throw new HostSettingsError('UNREADABLE');
      const entries = values('entries')!;
      return entries.length ? { set: { limits: Object.fromEntries(entries.map(item => [modelContextLimitKey(item.harness, item.providerId, item.modelId), item.limit!])) } } : { clear: ['limits'] };
    }, options);
    return ready(domain, state.revision, { entries: values('entries')! } as unknown as Values);
  }
  if (domain === 'modelAccess') {
    const state = await getHostModelAccessStore().commitAtomic(() => {
      if (inspectModelPreferences(domain).status !== 'ready') throw new HostSettingsError('UNREADABLE');
      const models = values('models'), providers = values('providers') as unknown as string[] | undefined;
      const set: { disabledModels?: Record<string, true>; disabledProviders?: Record<string, true> } = {}, clear: Array<'disabledModels' | 'disabledProviders'> = [];
      if (models !== undefined) { if (models.length) set.disabledModels = Object.fromEntries(models.map(item => [modelDisableKey(item.providerId, item.modelId), true])); else clear.push('disabledModels'); }
      if (providers !== undefined) { if (providers.length) set.disabledProviders = Object.fromEntries(providers.map(id => [id, true])); else clear.push('disabledProviders'); }
      return { set, clear };
    }, options);
    return ready(domain, state.revision, { models: Object.keys(state.value.disabledModels).map(key => parseTarget(key, false)), providers: Object.keys(state.value.disabledProviders) } as Values);
  }
  throw new HostSettingsError('UNSUPPORTED_CAPABILITY');
}
