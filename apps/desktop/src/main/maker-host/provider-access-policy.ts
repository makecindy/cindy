/**
 * provider-access-policy — runtime gates for user-selectable model providers.
 *
 * Routing keeps consuming the full active catalog. This projection only controls the
 * providers and models exposed as selectable capabilities to product surfaces.
 */

import { classifyModel, type Catalog, type Provider } from '@cindy/model-providers';
import type { CindyRegion } from '@cindy/maker-shared/brand-identity';

export interface ProviderAccessContext {
  /** False for account-free local sessions, in every build flavor. */
  canUseCindyGateway?: boolean;
}

const CINDY_AI_PROVIDER_ID = 'xd';
const MAINLAND_VIDEO_MODEL_IDS: ReadonlySet<string> = new Set([
  'seedance-fast',
  'seedance-pro',
]);

function projectVideoDefaults(
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
 * Build-region projection for Cindy-managed media capabilities. Global keeps
 * the catalog source verbatim; Mainland China and dev expose only the media
 * capabilities that the regional Cindy service supports.
 *
 * Region is a build-time choice for Cindy-owned services, not a restriction on
 * providers the user connected locally. OpenAI/Codex OAuth, xAI OAuth, Gemini
 * API keys and custom providers therefore keep their image catalog in every
 * build. Video dispatch is not provider-aware yet, so non-XD video capabilities
 * stay hidden outside Global until the runtime can route them by provider.
 */
export function projectProviderCatalogForBuildRegion(
  catalog: Catalog,
  region: CindyRegion,
): Catalog {
  if (region === 'global') return catalog;

  let changed = false;
  const providers = catalog.providers.map((provider) => {
    const isCindyAi = provider.id === CINDY_AI_PROVIDER_ID;
    if (!isCindyAi) {
      const models = Object.fromEntries(
        Object.entries(provider.models).map(([agent, list]) => [
          agent,
          (list ?? []).filter((model) => classifyModel(model) !== 'video'),
        ]),
      ) as Provider['models'];
      const hasVideoModels = Object.values(provider.models).some(
        (list) => list?.some((model) => classifyModel(model) === 'video') ?? false,
      );
      const hasVideoCatalog =
        provider.videoModels !== undefined || provider.videoDefaults !== undefined;
      if (!hasVideoModels && !hasVideoCatalog) return provider;

      changed = true;
      const projected: Provider = {
        ...provider,
        models,
        videoModels: [],
      };
      delete projected.videoDefaults;
      return projected;
    }
    changed = true;

    const videoModels = (provider.videoModels ?? []).filter((model) =>
      MAINLAND_VIDEO_MODEL_IDS.has(model.id),
    );
    const videoIds = new Set(videoModels.map((model) => model.id));
    const videoDefaults = projectVideoDefaults(provider.videoDefaults, videoIds);
    const models = Object.fromEntries(
      Object.entries(provider.models).map(([agent, list]) => [
        agent,
        (list ?? []).filter((model) => {
          const group = classifyModel(model);
          return group !== 'image' && (group !== 'video' || MAINLAND_VIDEO_MODEL_IDS.has(model.id));
        }),
      ]),
    ) as Provider['models'];
    const projected: Provider = {
      ...provider,
      models,
      imageModels: [],
      videoModels,
    };
    delete projected.imageDefaults;
    delete projected.videoDefaults;
    if (videoDefaults) projected.videoDefaults = videoDefaults;
    return projected;
  });

  return changed ? { ...catalog, providers } : catalog;
}

/** Cindy AI requires a Cindy account session; every membership kind may select it. */
export function isProviderSelectable(providerId: string, context: ProviderAccessContext): boolean {
  return !(providerId === CINDY_AI_PROVIDER_ID && context.canUseCindyGateway === false);
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
