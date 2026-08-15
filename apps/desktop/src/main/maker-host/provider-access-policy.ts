/**
 * provider-access-policy — runtime gates for user-selectable model providers.
 *
 * Routing and product surfaces consume the same active catalog. Successful Gateway
 * catalogs and local provider discovery are never region-filtered here. The only
 * regional projection below applies to unverified compatibility fallbacks, which must
 * not claim that bundled XD media is currently routable by a regional endpoint.
 */

import { classifyModel, type Catalog, type Provider } from '@cindy/model-providers';
import type { CindyRegion } from '@cindy/maker-shared/brand-identity';

export interface ProviderAccessContext {
  /** False for account-free local sessions, in every build flavor. */
  canUseCindyGateway?: boolean;
}

const CINDY_AI_PROVIDER_ID = 'xd';
const MAINLAND_FALLBACK_VIDEO_MODEL_IDS: ReadonlySet<string> = new Set([
  'seedance-fast',
  'seedance-pro',
  'bytedance/seedance-2.5',
]);

function projectFallbackVideoDefaults(
  defaults: Provider['videoDefaults'],
  allowedIds: ReadonlySet<string>,
): Provider['videoDefaults'] | undefined {
  if (!defaults || !allowedIds.has(defaults.standard)) return undefined;
  return {
    standard: defaults.standard,
    ...(defaults.draft && allowedIds.has(defaults.draft) ? { draft: defaults.draft } : {}),
    ...(defaults.best && allowedIds.has(defaults.best) ? { best: defaults.best } : {}),
  };
}

/**
 * A bundled/LKG/legacy snapshot is useful for compatibility metadata, but it is not
 * evidence that the current regional Gateway can execute every XD media model baked
 * into that snapshot. Keep the historical CN-safe XD subset until the configured
 * current catalog source succeeds. Non-XD providers are intentionally untouched:
 * locally connected providers and their discovery results do not belong to Gateway
 * regional policy.
 */
export function projectUnverifiedCatalogFallbackForBuildRegion(
  catalog: Catalog,
  region: CindyRegion,
): Catalog {
  if (region === 'global') return catalog;

  let changed = false;
  const providers = catalog.providers.map((provider) => {
    if (provider.id !== CINDY_AI_PROVIDER_ID) return provider;

    const videoModels = (provider.videoModels ?? []).filter((model) =>
      MAINLAND_FALLBACK_VIDEO_MODEL_IDS.has(model.id),
    );
    const videoIds = new Set(videoModels.map((model) => model.id));
    const videoDefaults = projectFallbackVideoDefaults(provider.videoDefaults, videoIds);
    const models = Object.fromEntries(
      Object.entries(provider.models).map(([agent, list]) => [
        agent,
        (list ?? []).filter((model) => {
          const group = classifyModel(model);
          if (group === 'image' || group === 'embedding') return false;
          return group !== 'video' || MAINLAND_FALLBACK_VIDEO_MODEL_IDS.has(model.id);
        }),
      ]),
    ) as Provider['models'];
    const projected: Provider = {
      ...provider,
      models,
      imageModels: [],
      videoModels,
      embeddingModels: [],
    };
    delete projected.imageDefaults;
    delete projected.videoDefaults;
    delete projected.embeddingDefaults;
    if (videoDefaults) projected.videoDefaults = videoDefaults;
    changed = true;
    return projected;
  });

  return changed ? { ...catalog, providers } : catalog;
}

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
