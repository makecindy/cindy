import { providerCatalogId } from '@cindy/model-providers';
import { providerReferencePriceQuote } from '../../shared/modelPriceQuote.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';

/** Share public tariffs while keeping each account's overrides and attribution separate. */
export const accountReferencePriceQuote: typeof providerReferencePriceQuote = (
  providerId, modelId, registry, options,
) => {
  const provider = getActiveCatalog().providers.find(provider => provider.id === providerId);
  const catalogId = provider ? providerCatalogId(provider) : providerId;
  const quote = providerReferencePriceQuote(
    catalogId, modelId, registry, options,
  );
  return quote && catalogId !== providerId ? { ...quote, providerId, modelId } : quote;
};
