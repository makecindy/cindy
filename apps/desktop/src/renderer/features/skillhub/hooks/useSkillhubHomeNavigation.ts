import { useCallback } from 'react';
import { useLocation, useNavigate, type Location } from 'react-router-dom';

import type { HomeCatalogTab } from '../lib/homeMarketFilter';
import { skillDetailReturnRoute, withSkillDetailReturn } from '../lib/detailRoutes';
import { buildLocalSkillRoute } from '../lib/localRoutes';

interface HomeViewState {
  catalogTab: HomeCatalogTab;
  query: string;
  sort?: 'downloads' | 'updated_at';
  category?: string;
}

interface SkillhubNavigationState {
  from?: string;
  resetHistory?: boolean;
  skillhubHome?: HomeViewState;
}

/** Keep list state on the history entry so both detail Back and browser Back restore it. */
export function useSkillhubHomeNavigation(navigationLocation?: Location) {
  const currentLocation = useLocation();
  const location = navigationLocation ?? currentLocation;
  const navigate = useNavigate();
  const navState = location.state as SkillhubNavigationState | null;
  const search = new URLSearchParams(location.search);
  const savedTab = navState?.skillhubHome?.catalogTab ?? search.get('tab');
  const catalogTab: HomeCatalogTab = savedTab === 'local' || savedTab === 'organization'
    ? savedTab
    : 'public';
  const query = typeof navState?.skillhubHome?.query === 'string' ? navState.skillhubHome.query : search.get('q') ?? '';

  const savedSort = navState?.skillhubHome?.sort ?? search.get('sort');
  const sort: 'downloads' | 'updated_at' = savedSort === 'updated_at' ? 'updated_at' : 'downloads';
  const category = navState?.skillhubHome?.category ?? search.get('category') ?? 'all';

  const updateHomeState = useCallback((patch: Partial<HomeViewState>) => {
    // Replace the current entry: typing or changing tabs must not add Back steps.
    navigate(`${location.pathname}${location.search}${location.hash}`, {
      replace: true,
      state: { ...location.state, skillhubHome: { catalogTab, query, sort, category, ...patch } },
    });
  }, [catalogTab, location, navigate, query, sort, category]);

  const setCatalogTab = useCallback((tab: HomeCatalogTab) => {
    updateHomeState({ catalogTab: tab });
  }, [updateHomeState]);
  const setQuery = useCallback((value: string) => {
    updateHomeState({ query: value });
  }, [updateHomeState]);

  const setSort = useCallback((value: 'downloads' | 'updated_at') => {
    updateHomeState({ sort: value });
  }, [updateHomeState]);
  const setCategory = useCallback((value: string) => {
    updateHomeState({ category: value });
  }, [updateHomeState]);

  const openLocalSkill = (skill: Parameters<typeof buildLocalSkillRoute>[0]) => {
    navigate(withSkillDetailReturn(buildLocalSkillRoute(skill), `${location.pathname}${location.search}`), {
      state: {
        from: '/skillhub/local',
        resetHistory: true,
        skillhubHome: { catalogTab, query, sort, category },
      } satisfies SkillhubNavigationState,
    });
  };

  const replaceLocalSkill = (skill: Parameters<typeof buildLocalSkillRoute>[0]) => {
    // A rename replaces the current detail, retaining both its source and list filters.
    navigate(withSkillDetailReturn(buildLocalSkillRoute(skill), skillDetailReturnRoute(search, navState?.from === '/skillhub/market' ? '/skillhub/market' : '/skillhub/local')), { replace: true, state: location.state });
  };

  const backToCatalog = () => {
    const target = navState?.from === '/skillhub/market' ? '/skillhub/market' : '/skillhub/local';
    navigate(skillDetailReturnRoute(search, target), { state: { skillhubHome: navState?.skillhubHome } });
  };

  return { sort, category, setSort, setCategory, catalogTab, query, setCatalogTab, setQuery, openLocalSkill, replaceLocalSkill, backToCatalog };
}
