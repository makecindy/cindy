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
      add(DIRECT_API_PRESET_REGISTRY_IDS.get(presetId));
    }
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
  for (const catalogId of candidateCatalogIds(provider, providerId, modelId, agent)) {
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
