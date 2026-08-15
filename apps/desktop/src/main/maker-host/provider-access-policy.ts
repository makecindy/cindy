/**
 * provider-access-policy — runtime gates for user-selectable model providers.
 *
 * Routing and product surfaces consume the same active catalog. This module only
 * applies account-capability gates; regional model policy belongs to Gateway catalog
 * delivery and must not be reimplemented by the open-source client.
 */

import type { Catalog } from '@cindy/model-providers';

export interface ProviderAccessContext {
  /** False for account-free local sessions, in every build flavor. */
  canUseCindyGateway?: boolean;
}

const CINDY_AI_PROVIDER_ID = 'xd';

/** Cindy AI requires a Cindy account session; every membership kind may select it. */
export function isProviderSelectable(providerId: string, context: ProviderAccessContext): boolean {
  return !(providerId === CINDY_AI_PROVIDER_ID && context.canUseCindyGateway === false);
}

/** Whether the projected account catalog can route a Cindy-managed embedding model. */
export function isCindyEmbeddingModelAvailable(catalog: Catalog, modelId: string): boolean {
  return (
    catalog.providers
      .find((provider) => provider.id === CINDY_AI_PROVIDER_ID)
      ?.embeddingModels?.some((model) => model.id === modelId) ?? false
  );
}

/**
 * Return the catalog projection exposed to provider lists and availableModels.
 * Preserve the original object when no gate applies so gated sessions are the
 * only ones paying for a re-allocation.
 */
export function filterProviderCatalogForAccount(
  catalog: Catalog,
  context: ProviderAccessContext,
): Catalog {
  if (isProviderSelectable(CINDY_AI_PROVIDER_ID, context)) return catalog;
  const providers = catalog.providers.filter((provider) =>
    isProviderSelectable(provider.id, context),
  );
  return providers.length === catalog.providers.length ? catalog : { ...catalog, providers };
}
