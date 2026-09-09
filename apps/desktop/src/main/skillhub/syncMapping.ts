import { mapHubSkillInfoToDesktopInfo, type HubSkillInfoForDesktop } from './infoMapping';
import { skillhubCatalogKey, type SkillhubCatalogScope } from '../../shared/skillhubCatalog';

export interface SkillhubSyncRef {
  slug: string;
  catalogScope?: SkillhubCatalogScope;
}

export interface SkillhubBatchDetailResponse {
  items?: HubSkillInfoForDesktop[];
  availableCount?: number;
}

export function buildSkillhubSyncResponse(
  refs: SkillhubSyncRef[],
  detailResponses: Array<{ catalogScope?: SkillhubCatalogScope; response: SkillhubBatchDetailResponse }>,
) {
  const mappedBySlug = new Map<string, ReturnType<typeof mapHubSkillInfoToDesktopInfo>>();
  let availableUninstalledCount: number | undefined;

  for (const { catalogScope, response: resp } of detailResponses) {
    if (availableUninstalledCount === undefined && typeof resp.availableCount === 'number') {
      availableUninstalledCount = resp.availableCount;
    }
    for (const hub of resp.items ?? []) {
      mappedBySlug.set(
        skillhubCatalogKey(hub.slug, catalogScope),
        mapHubSkillInfoToDesktopInfo(hub, { catalogScope }),
      );
    }
  }

  const results = refs.map(({ slug, catalogScope }) => {
    const mapped = mappedBySlug.get(skillhubCatalogKey(slug, catalogScope));
    return mapped
      ? { exists: true as const, ...mapped }
      : {
          name: slug,
          ...(catalogScope ? { catalogScope } : {}),
          exists: false as const,
        };
  });

  return {
    success: true as const,
    results,
    ...(typeof availableUninstalledCount === 'number' ? { availableUninstalledCount } : {}),
  };
}
