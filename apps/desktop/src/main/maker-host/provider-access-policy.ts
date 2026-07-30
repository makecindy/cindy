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
 * Build-region projection for the media catalog. Global keeps the catalog
 * source verbatim; Mainland China and dev share the Mainland product semantics
 * and expose only the media capabilities supported there.
 *
 * 2026-07 图像多来源:投影不再只针对 xd —— 大陆版「无图像能力」是产品语义,
 * **所有**供应商的 imageModels/imageDefaults 一律清空(新来源不得绕过地区闸);
 * 视频白名单(seedance 两型号)维持 xd 专属逻辑,其它供应商目前不声明视频清单,
 * 声明了也一并清空(大陆视频能力只经 xd 网关合规通道)。
 */
export function projectProviderCatalogForBuildRegion(
  catalog: Catalog,
  region: CindyRegion,
): Catalog {
  if (region === 'global') return catalog;

  let changed = false;
  const providers = catalog.providers.map((provider) => {
    const hasMedia =
      (provider.imageModels?.length ?? 0) > 0 ||
      provider.imageDefaults !== undefined ||
      (provider.videoModels?.length ?? 0) > 0 ||
      provider.videoDefaults !== undefined ||
      Object.values(provider.models).some((list) =>
        list?.some((m) => { const g = classifyModel(m); return g === 'image' || g === 'video'; }),
      );
    const isCindyAi = provider.id === CINDY_AI_PROVIDER_ID;
    if (!hasMedia && !isCindyAi) return provider;
    changed = true;

    const videoModels = isCindyAi
      ? (provider.videoModels ?? []).filter((model) => MAINLAND_VIDEO_MODEL_IDS.has(model.id))
      : [];
    const videoIds = new Set(videoModels.map((model) => model.id));
    const videoDefaults = projectVideoDefaults(provider.videoDefaults, videoIds);
    const models = Object.fromEntries(
      Object.entries(provider.models).map(([agent, list]) => [
        agent,
        list.filter((model) => {
          const group = classifyModel(model);
          return group !== 'image' && (group !== 'video' || (isCindyAi && MAINLAND_VIDEO_MODEL_IDS.has(model.id)));
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
