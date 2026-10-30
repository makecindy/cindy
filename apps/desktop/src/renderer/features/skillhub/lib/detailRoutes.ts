import type { SkillhubCatalogScope } from '../../../../shared/skillhubCatalog';

export function skillDetailReturnRoute(search: URLSearchParams, fallback = '/skillhub/local'): string {
  const value = search.get('returnTo') ?? fallback;
  return /^\/skillhub\/(local|market)(\?|$)/.test(value) ? value : '/skillhub/local';
}

export function buildMarketSkillRoute(
  skill: { name: string; catalogScope?: SkillhubCatalogScope },
  returnTo = '/skillhub/market',
): string {
  return `/skillhub/detail?${new URLSearchParams({
    view: 'market', remote: skill.name, catalog: skill.catalogScope ?? 'native', returnTo,
  })}`;
}

export function withSkillDetailReturn(route: string, returnTo: string): string {
  const [pathname, query] = route.split('?');
  const search = new URLSearchParams(query);
  search.set('returnTo', returnTo);
  return `${pathname}?${search}`;
}

/** Legacy links remain resolvable; new links carry the same source identity in search. */
export function skillDetailLocalParams(search: URLSearchParams) {
  return {
    kind: search.get('kind') ?? undefined,
    name: search.has('name') ? encodeURIComponent(search.get('name')!) : undefined,
    projectHash: search.get('project') ?? undefined,
  };
}

export function skillDetailCatalog(search: URLSearchParams): SkillhubCatalogScope | undefined {
  const scope = search.get('catalog');
  return scope === 'market' || scope === 'team' ? scope : undefined;
}
