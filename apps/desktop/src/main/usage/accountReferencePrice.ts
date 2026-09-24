import { providerCatalogId } from '@cindy/model-providers';
import { providerReferencePriceQuote } from '../../shared/modelPriceQuote.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';

/** Share public tariffs while keeping each account's overrides and attribution separate. */
export const accountReferencePriceQuote: typeof providerReferencePriceQuote = (
  providerId, modelId, registry, options,
) => {
  const provider = getActiveCatalog().providers.find(provider => provider.id === providerId);
  let catalogId = provider ? providerCatalogId(provider) : providerId;
  // API-key subscriptions have account-local IDs. Resolve their public tariff
  // from the selected engine/model's preset, never from another account.
  if (provider?.access?.kind === 'subscription' && provider.auth.method === 'apiKey') {
    const models = options?.agent
      ? provider.models[options.agent] ?? []
      : Object.values(provider.models).flat();
    const presetIds = new Set(models
      .filter(model => model.id === modelId && model.catalogPresetId)
      .map(model => model.catalogPresetId!));
    if (presetIds.size === 1) catalogId = [...presetIds][0];
  }
  const quote = providerReferencePriceQuote(
    catalogId, modelId, registry, options,
  );
  return quote && catalogId !== providerId ? { ...quote, providerId, modelId } : quote;
};
