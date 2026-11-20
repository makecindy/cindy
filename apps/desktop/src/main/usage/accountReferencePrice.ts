import {
  findBaseModel,
  findModelRegistryRoute,
  providerCatalogId,
  providerEndpointBindings,
  providerWireProtocolForApi,
  type Catalog,
  type AgentKind,
  type ModelRegistry,
  type Provider,
  type ProviderWireProtocol,
} from '@cindy/model-providers';
import { providerReferencePriceQuote } from '../../shared/modelPriceQuote.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';

/** Official direct-API preset IDs whose Registry routes live under the canonical vendor ID. */
const DIRECT_API_PRESET_REGISTRY_IDS: ReadonlyMap<string, string> = new Map([
  ['openai-api', 'openai'],
  ['anthropic-api', 'anthropic'],
  ['xai-api', 'xai'],
]);

function calendarDate(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

function candidateRegistryModelIds(catalogId: string, modelId: string): string[] {
  if (catalogId === 'xai' && !modelId.startsWith('xai/')) {
    return [modelId, `xai/${modelId}`];
  }
  return [modelId];
}

type TariffEndpoint = { baseUrl: string; wireProtocol: ProviderWireProtocol; requestPath?: string };

const defaultRequestPaths: Partial<Record<ProviderWireProtocol, string>> = {
  'openai-chat': '/chat/completions',
  'openai-responses': '/responses',
  'anthropic-messages': '/v1/messages',
};

function tariffBaseUrl({ baseUrl, wireProtocol }: TariffEndpoint): string {
  // DeepSeek publishes both spellings for its OpenAI-compatible endpoint. Do not
  // strip a version from arbitrary routes: another path can identify a different channel.
  if ((wireProtocol === 'openai-chat' || wireProtocol === 'openai-responses') &&
      baseUrl.replace(/\/+$/, '') === 'https://api.deepseek.com/v1') return 'https://api.deepseek.com';
  return baseUrl;
}

export function matchesTariffEndpoint(actual: TariffEndpoint, declared: TariffEndpoint): boolean {
  if (actual.wireProtocol !== declared.wireProtocol) return false;
  const defaultPath = defaultRequestPaths[actual.wireProtocol];
  return (actual.requestPath || defaultPath) === (declared.requestPath || defaultPath) &&
    providerEndpointBindings(tariffBaseUrl(declared), tariffBaseUrl(actual)) !== null;
}

// A projection is reused for every historical day; a catalog refresh replaces its snapshot.
const presetIndexes = new WeakMap<Catalog, WeakMap<Provider, Map<string, string | null>>>();

function verifiedPresets(provider: Provider) {
  const catalog = getActiveCatalog();
  let providers = presetIndexes.get(catalog);
  if (!providers) {
    providers = new WeakMap();
    presetIndexes.set(catalog, providers);
  }
  let index = providers.get(provider);
  if (index) return index;
  index = new Map();
  for (const [engine, models] of Object.entries(provider.models)) {
    const agent = engine as AgentKind;
    const routing = provider.routing[agent];
    if (!routing) continue;
    const defaultWire = agent === 'pi' ? 'openai-chat' : agent === 'codex' ? 'openai-responses' : 'anthropic-messages';
    for (const model of models) {
      const presetId = model.catalogPresetId ?? provider.id;
      const runtime = catalog.presets?.find(p => p.id === presetId)?.runtimes[agent];
      const declared = runtime?.models.find(m => m.id === model.id);
      const actualUrl = model.route?.baseUrl ?? routing.upstream;
      const actualWire = model.route?.wireProtocol ?? providerWireProtocolForApi(model.api ?? model.piApi) ?? routing.wireProtocol ?? defaultWire;
      const actualPath = model.route?.requestPath ?? routing.requestPath ?? '';
      const expected = model.selectedInterface?.providerId === presetId ? model.selectedInterface.route : declared?.route;
      const matches = runtime && !model.interfaceUnavailable && matchesTariffEndpoint(
        { baseUrl: actualUrl, wireProtocol: actualWire, requestPath: actualPath },
        {
          baseUrl: expected?.baseUrl ?? runtime.baseUrl,
          wireProtocol: expected?.wireProtocol ?? providerWireProtocolForApi(declared?.api ?? declared?.piApi) ?? runtime.wireProtocol ?? defaultWire,
          requestPath: expected?.requestPath ?? runtime.requestPath,
        },
      );
      const id = matches ? presetId : null;
      index.set(agent + '\0' + model.id, id);
      // An agent-independent lookup must agree across every engine exposing this model.
      if (!index.has(model.id)) index.set(model.id, id);
      else if (index.get(model.id) !== id) index.set(model.id, null);
    }
  }
  providers.set(provider, index);
  return index;
}

const tariffProviders = new WeakMap<ModelRegistry, Set<string>>();

function candidateCatalogIds(
  provider: Provider | undefined,
  providerId: string,
  modelId: string,
  registry: ModelRegistry | null | undefined,
  agent?: AgentKind,
): string[] {
  if (!registry || providerId === 'xd' || provider?.id === 'xd') return [];
  let channels = tariffProviders.get(registry);
  if (!channels) {
    channels = new Set(registry.models.flatMap(entry => entry.routes.map(route => route.providerId)));
    tariffProviders.set(registry, channels);
  }
  const ids: string[] = [];
  const add = (id: string | undefined): void => {
    if (!id || id === 'xd' || !channels.has(id) || ids.includes(id)) return;
    ids.push(id);
  };
  const baseCatalogId = provider ? providerCatalogId(provider) : providerId;
  // API-key connections (both pay-as-you-go presets and API-key subscriptions) can carry
  // account-local IDs. Resolve their public tariff from the selected engine/model's preset,
  // never from another account.
  if (provider?.source === 'user' && provider.auth.method === 'apiKey') {
    const presetId = verifiedPresets(provider).get(agent ? agent + '\0' + modelId : modelId);
    if (presetId) {
      add(presetId);
      add(DIRECT_API_PRESET_REGISTRY_IDS.get(presetId));
    }
    return ids;
  }
  add(baseCatalogId);
  add(DIRECT_API_PRESET_REGISTRY_IDS.get(baseCatalogId));
  return ids;
}

/**
 * Whether the Model Registry has already ended a standard tariff for this connection/model
 * on or before `at` (e.g. a deprecation cutoff such as `effectiveUntil: "2026-12-01"`).
 * Pre-adoption historical dates strictly before `effectiveFrom` return `false` so existing
 * connections keep their `model.cost` fallback for historical usage estimation.
 */
export function providerRegistryTariffEndedAt(
  provider: Provider | undefined,
  providerId: string,
  modelId: string,
  registry: ModelRegistry | null | undefined,
  at?: string | Date,
  agent?: AgentKind,
): boolean {
  if (!registry) return false;
  const day = calendarDate(at);
  const registryAgent = agent === 'pi' ? undefined : agent;
  for (const catalogId of candidateCatalogIds(provider, providerId, modelId, registry, agent)) {
    for (const candidateModelId of candidateRegistryModelIds(catalogId, modelId)) {
      const matched = findModelRegistryRoute(registry, catalogId, candidateModelId, registryAgent);
      if (!matched) continue;
      const prices = matched.route.referencePrices
        ?? (matched.route.referencePriceGroup && matched.entry.modelRef
          ? findBaseModel(registry, matched.entry.modelRef)?.referencePriceGroups?.find(
            group => group.id === matched.route.referencePriceGroup,
          )?.prices
          : undefined);
      if (prices?.some(
        price => price.variant === 'standard' && price.effectiveUntil !== undefined && day >= price.effectiveUntil,
      )) {
        return true;
      }
    }
  }
  return false;
}

/** Share public tariffs while keeping each account's overrides and attribution separate. */
export const accountReferencePriceQuote: typeof providerReferencePriceQuote = (
  providerId, modelId, registry, options,
) => {
  const provider = getActiveCatalog().providers.find(candidate => candidate.id === providerId);
  for (const catalogId of candidateCatalogIds(provider, providerId, modelId, registry, options?.agent)) {
    for (const candidateModelId of candidateRegistryModelIds(catalogId, modelId)) {
      const quote = providerReferencePriceQuote(catalogId, candidateModelId, registry, options);
      if (quote) {
        return catalogId !== providerId || candidateModelId !== modelId
          ? { ...quote, providerId, modelId }
          : quote;
      }
    }
  }
  return undefined;
};

/** Resolve a Registry quote for an explicit Provider snapshot without re-reading the active catalog. */
export function providerSnapshotReferencePriceQuote(
  provider: Provider,
  modelId: string,
  registry: ModelRegistry | null | undefined,
  options?: Parameters<typeof providerReferencePriceQuote>[3],
) {
  for (const catalogId of candidateCatalogIds(provider, provider.id, modelId, registry, options?.agent)) {
    for (const candidateModelId of candidateRegistryModelIds(catalogId, modelId)) {
      const quote = providerReferencePriceQuote(catalogId, candidateModelId, registry, options);
      if (quote) {
        return catalogId !== provider.id || candidateModelId !== modelId
          ? { ...quote, providerId: provider.id, modelId }
          : quote;
      }
    }
  }
  return undefined;
}
