import { useCallback, useMemo } from 'react';
import { useLocation, useNavigate, type Location } from 'react-router-dom';

import type { HomeCatalogTab } from '../lib/homeMarketFilter';
import { skillDetailReturnRoute, withSkillDetailReturn } from '../lib/detailRoutes';
import { buildLocalSkillRoute } from '../lib/localRoutes';

interface HomeViewState {
  catalogTab: HomeCatalogTab;
  query: string;
  sort?: 'downloads' | 'updated_at';
  category?: string;
  categoriesByCatalog?: Partial<Record<Exclude<HomeCatalogTab, 'local'>, string>>;
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
  const savedCategories = navState?.skillhubHome?.categoriesByCatalog;
  const homeState = useMemo<HomeViewState>(() => ({
    catalogTab, query, sort, category,
    categoriesByCatalog: {
      ...savedCategories,
      ...(catalogTab === 'local' ? {} : { [catalogTab]: category }),
    },
  }), [catalogTab, query, sort, category, savedCategories]);

  const updateHomeState = useCallback((patch: Partial<HomeViewState>) => {
    // Replace the current entry: typing or changing tabs must not add Back steps.
    navigate(`${location.pathname}${location.search}${location.hash}`, {
      replace: true,
      state: { ...location.state, skillhubHome: { ...homeState, ...patch } },
    });
  }, [homeState, location, navigate]);

  const setCatalogTab = useCallback((tab: HomeCatalogTab) => {
    updateHomeState({
      catalogTab: tab,
      category: tab === 'local' ? category : homeState.categoriesByCatalog?.[tab] ?? 'all',
    });
  }, [category, homeState.categoriesByCatalog, updateHomeState]);
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
        skillhubHome: homeState,
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

  return { homeState, sort, category, setSort, setCategory, catalogTab, query, setCatalogTab, setQuery, openLocalSkill, replaceLocalSkill, backToCatalog };
}
