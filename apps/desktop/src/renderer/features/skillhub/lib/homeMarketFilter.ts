import type { CatalogScope, SortBy, Visibility } from '../hooks/useMarketList';

export type HomeMarketFilter = 'public' | 'organization';
export type HomeCatalogTab = HomeMarketFilter | 'local';

export interface HomeMarketQuery {
  scope: CatalogScope;
  visibility: Visibility;
  sort: SortBy;
}

export function visibleHomeCatalogTabs(
  showOrganization: boolean,
): HomeCatalogTab[] {
  return showOrganization ? ['public', 'organization', 'local'] : ['public', 'local'];
}

export function isHomeMarketResponseCurrent(
  query: HomeMarketQuery,
  response: { scope: CatalogScope | null; mine: boolean | null },
): boolean {
  return response.scope === query.scope && response.mine === (query.visibility === 'mine');
}

/** Maps home tabs onto the server-owned generic catalog contract. */
export function homeMarketQuery(filter: HomeMarketFilter): HomeMarketQuery {
  if (filter === 'organization') {
    return { scope: 'team', visibility: 'all', sort: 'trending' };
  }
  return { scope: 'market', visibility: 'all', sort: 'trending' };
}
