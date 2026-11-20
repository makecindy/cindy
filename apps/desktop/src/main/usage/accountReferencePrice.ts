import {
  findBaseModel,
  findModelRegistryRoute,
  providerCatalogId,
  type AgentKind,
  type ModelRegistry,
  type Provider,
} from '@cindy/model-providers';
import { providerReferencePriceQuote } from '../../shared/modelPriceQuote.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';

/** Official direct-API preset IDs whose Registry routes live under the canonical vendor ID. */
const DIRECT_API_PRESET_REGISTRY_IDS: Readonly<Record<string, string>> = {
  'openai-api': 'openai',
  'anthropic-api': 'anthropic',
  'xai-api': 'xai',
};

function candidateRegistryModelIds(catalogId: string, modelId: string): string[] {
  if (catalogId === 'xai' && !modelId.startsWith('xai/')) {
    return [modelId, `xai/${modelId}`];
  }
  return [modelId];
}

function candidateCatalogIds(
  provider: Provider | undefined,
  providerId: string,
  modelId: string,
  agent?: AgentKind,
): string[] {
  if (providerId === 'xd' || provider?.id === 'xd') return [];
  const ids: string[] = [];
  const add = (id: string | undefined): void => {
    if (!id || id === 'xd' || ids.includes(id)) return;
    ids.push(id);
  };
  const baseCatalogId = provider ? providerCatalogId(provider) : providerId;
  // API-key connections (both pay-as-you-go presets and API-key subscriptions) can carry
  // account-local IDs. Resolve their public tariff from the selected engine/model's preset,
  // never from another account.
  if (provider?.auth.method === 'apiKey') {
    const models = agent
      ? provider.models[agent] ?? []
      : Object.values(provider.models).flat();
    const presetIds = new Set(models
      .filter(model => model.id === modelId && model.catalogPresetId)
      .map(model => model.catalogPresetId!));
    if (presetIds.size === 1) {
      const presetId = [...presetIds][0]!;
      add(presetId);
      add(DIRECT_API_PRESET_REGISTRY_IDS[presetId]);
    }
  }
  add(baseCatalogId);
  add(DIRECT_API_PRESET_REGISTRY_IDS[baseCatalogId]);
  return ids;
}

/** Whether the Model Registry authoritatively declares a tariff table for this connection/model. */
export function providerHasRegistryReferenceTariff(
  provider: Provider | undefined,
  providerId: string,
  modelId: string,
  registry: ModelRegistry | null | undefined,
  agent?: AgentKind,
): boolean {
  if (!registry) return false;
  const registryAgent = agent === 'pi' ? undefined : agent;
  for (const catalogId of candidateCatalogIds(provider, providerId, modelId, agent)) {
    for (const candidateModelId of candidateRegistryModelIds(catalogId, modelId)) {
      const matched = findModelRegistryRoute(registry, catalogId, candidateModelId, registryAgent);
      if (!matched) continue;
      if ((matched.route.referencePrices?.length ?? 0) > 0) return true;
      if (matched.route.referencePriceGroup && matched.entry.modelRef) {
        const base = findBaseModel(registry, matched.entry.modelRef);
        if (base?.referencePriceGroups?.some(
          group => group.id === matched.route.referencePriceGroup && group.prices.length > 0,
        )) {
          return true;
        }
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
  for (const catalogId of candidateCatalogIds(provider, providerId, modelId, options?.agent)) {
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
  for (const catalogId of candidateCatalogIds(provider, provider.id, modelId, options?.agent)) {
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
