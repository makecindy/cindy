// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  user: null as { membershipKind: 'org' } | null,
  dataOwnerId: 'owner-a',
  t: (key: string) => key,
  store: {
    skills: [] as SkillhubSkill[],
    projects: [],
    bootstrapped: true,
    learnSkillEnabled: false,
    syncResults: new Map(),
  },
  market: {
    items: [], loading: false, loadingMore: false, hasMore: false,
    resolvedScope: 'market', resolvedMine: false, categoryFilter: 'all',
    setSearchQuery: vi.fn(), setSortBy: vi.fn(), setCatalogScope: vi.fn(),
    setCategoryFilter: vi.fn(), setVisibility: vi.fn(), loadMore: vi.fn(), reload: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: mocks.user, dataOwnerId: mocks.dataOwnerId, mode: 'cloud' }),
}));
vi.mock('../hooks/useSkillhub', () => ({ useSkillhub: () => mocks.store, refresh: vi.fn() }));
vi.mock('../hooks/useMarketList', () => ({
  MARKET_PAGE_SIZE: 24,
  useMarketList: () => mocks.market,
  useCategoryList: () => ({ categories: [] }),
}));
vi.mock('../hooks/useMarketManagement', () => ({
  useMarketManagement: () => ({}), MarketManagementDialogs: () => null,
}));
vi.mock('../components/InstallTargetPicker', () => ({ InstallTargetPicker: () => null }));
vi.mock('../SkillhubMarketPreviewPanel', () => ({ SkillhubMarketPreviewPanel: () => null }));

import { SkillhubHomeView } from '../SkillhubHomeView';
import { SkillhubLocalLayout } from '../SkillhubLocalLayout';
import { useSkillhubHomeNavigation } from '../hooks/useSkillhubHomeNavigation';

function NavigationControls() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">{location.pathname}{location.search}{location.hash}</output>
      <output data-testid="navigation-state">{JSON.stringify(location.state)}</output>
      <button onClick={() => navigate(-1)}>Browser Back</button>
      <button onClick={() => navigate(1)}>Browser Forward</button>
      <button onClick={() => navigate('/away')}>Leave catalog</button>
    </>
  );
}

// Exercise production rename/return navigation after a simulated scanner refresh, without file IPC.
function DetailNavigation() {
  const navigate = useNavigate();
  const { backToCatalog, replaceLocalSkill } = useSkillhubHomeNavigation();
  const rename = () => {
    const renamed = {
      ...mocks.store.skills[0],
      name: 'calendar-renamed',
      absolutePath: '/skills/calendar-renamed',
      mdPath: '/skills/calendar-renamed/SKILL.md',
      sourceKey: 'renamed-source',
    };
    mocks.store.skills = [renamed, ...mocks.store.skills.slice(1)];
    replaceLocalSkill(renamed);
  };
  return (
    <>
      <button onClick={rename}>Rename skill</button>
      <button onClick={() => navigate('/skillhub/local/skill/global/design-tools')}>Another detail</button>
      <button onClick={backToCatalog}>Detail Back</button>
    </>
  );
}

function CatalogHarness({ entry = '/skillhub/local' }: {
  entry?: string | { pathname: string; state: unknown };
}) {
  return (
    <MemoryRouter initialEntries={['/before', entry]}>
      <NavigationControls />
      <Routes>
        <Route element={<SkillhubLocalLayout />}>
          <Route path="/skillhub/detail" element={<DetailNavigation />} />
          <Route path="/skillhub/local">
          <Route index element={null} />
          <Route path="by-path" element={<DetailNavigation />} />
          <Route path=":kind/global/:name" element={<DetailNavigation />} />
          <Route path=":kind/project/:hash/:name" element={<DetailNavigation />} />
          </Route>
        </Route>
        <Route path="/settings" element={<SkillhubHomeView embedded />} />
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>
  );
}

function renderCatalog(entry: string | { pathname: string; state: unknown } = '/skillhub/local') {
  return render(<CatalogHarness entry={entry} />);
}

function expectTab(tab: 'local' | 'public' | 'organization') {
  const name = tab === 'local' ? 'skillhub.home.local' : `skillhub.home.catalogFilter.${tab}`;
  expect(screen.getByRole('radio', { name }).getAttribute('aria-checked')).toBe('true');
}

function selectLocalAndSearch() {
  fireEvent.click(screen.getByRole('radio', { name: 'skillhub.home.local' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'skillhub.home.search' }), {
    target: { value: 'calendar' },
  });
}

beforeEach(() => {
  mocks.user = null;
  mocks.dataOwnerId = 'owner-a';
  mocks.store.skills = ['calendar-tools', 'design-tools'].map((name) => ({
    id: name, urlKey: `skill/global/${name}`, name, engine: 'claude-code',
    kind: 'skill', scope: 'global', linkedEngines: [],
    absolutePath: `/skills/${name}`, mdPath: `/skills/${name}/SKILL.md`, files: [],
    registryEntry: null,
  }));
});
afterEach(cleanup);

describe('Skill home navigation', () => {
  it('still opens a fresh catalog on Public', () => {
    renderCatalog();
    expectTab('public');
  });

  it.each([
    ['global', 'Detail Back'], ['global', 'Browser Back'],
    ['project', 'Detail Back'], ['project', 'Browser Back'],
  ] as const)('restores Local and search after opening a %s skill and using %s', async (scope, back) => {
    if (scope === 'project') {
      Object.assign(mocks.store.skills[0], { scope, projectRoot: '/repo', projectHash: 'repo-hash' });
    }
    renderCatalog();
    selectLocalAndSearch();
    const list = screen.getByRole('main');
    const card = screen.getByRole('button', { name: /calendar-tools/ });
    list.scrollTop = 720;
    fireEvent.click(screen.getByRole('button', { name: /calendar-tools/ }));
    expect(screen.queryByRole('radio', { name: 'skillhub.home.local' })).toBeNull();
    expect(new URLSearchParams(screen.getByTestId('location').textContent!.split('?')[1]).get('scope')).toBe(scope);
    expect(list.isConnected).toBe(true);
    expect(list.closest('[inert]')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('main')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: back }));
    await waitFor(() => expectTab('local'));
    expect(screen.getByRole('main')).toBe(list);
    expect(list.scrollTop).toBe(720);
    expect(screen.getByRole('button', { name: /calendar-tools/ })).toBe(card);
    expect(list.closest('[inert]')).toBeNull();
    expect((screen.getByRole('textbox', { name: 'skillhub.home.search' }) as HTMLInputElement).value)
      .toBe('calendar');
    expect(screen.getByRole('button', { name: /calendar-tools/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /design-tools/ })).toBeNull();
  });

  it('does not add browser history entries while changing filters or typing', () => {
    renderCatalog();
    selectLocalAndSearch();
    fireEvent.change(screen.getByRole('textbox', { name: 'skillhub.home.search' }), {
      target: { value: 'calendar-tools' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Browser Back' }));
    expect(screen.getByTestId('location').textContent).toBe('/before');
  });

  it.each([
    ['global', 'Detail Back'], ['global', 'Browser Back'],
    ['project', 'Detail Back'], ['project', 'Browser Back'],
  ] as const)('preserves filters and replaces the %s detail history entry on rename before %s', async (scope, back) => {
    if (scope === 'project') {
      Object.assign(mocks.store.skills[0], { scope, projectRoot: '/repo', projectHash: 'repo-hash' });
    }
    renderCatalog();
    selectLocalAndSearch();
    const list = screen.getByRole('main');
    list.scrollTop = 480;
    fireEvent.click(screen.getByRole('button', { name: /calendar-tools/ }));
    const detailState = screen.getByTestId('navigation-state').textContent;

    fireEvent.click(screen.getByRole('button', { name: 'Rename skill' }));
    const location = screen.getByTestId('location').textContent;
    const query = new URLSearchParams(location!.split('?')[1]);
    expect(query.get('scope')).toBe(scope);
    expect(query.get('name')).toBe('calendar-renamed');
    expect(query.get('engine')).toBe('claude-code');
    expect(query.get('source')).toBe('renamed-source');
    expect(screen.getByTestId('navigation-state').textContent).toBe(detailState);
    expect(list.isConnected).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: back }));
    await waitFor(() => expectTab('local'));
    expect(screen.getByRole('main')).toBe(list);
    expect(list.scrollTop).toBe(480);
    expect((screen.getByRole('textbox', { name: 'skillhub.home.search' }) as HTMLInputElement).value)
      .toBe('calendar');
    expect(screen.getByRole('button', { name: /calendar-renamed/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /calendar-tools|design-tools/ })).toBeNull();
  });

  it('keeps the Settings URL while changing embedded catalog filters', () => {
    renderCatalog('/settings?tab=ghosts#catalog');
    selectLocalAndSearch();
    expect(screen.getByTestId('location').textContent).toBe('/settings?tab=ghosts#catalog');
  });

  it('returns from an embedded Settings skill detail to the main catalog with saved filters', async () => {
    renderCatalog('/settings?tab=ghosts#catalog');
    selectLocalAndSearch();
    fireEvent.click(screen.getByRole('button', { name: /calendar-tools/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Detail Back' }));
    await waitFor(() => expectTab('local'));
    expect(screen.getByTestId('location').textContent?.split('?')[0]).toBe('/skillhub/local');
    expect((screen.getByRole('textbox', { name: 'skillhub.home.search' }) as HTMLInputElement).value)
      .toBe('calendar');
  });

  it.each([true, false])('restores an organization tab only while it is available (%s)', async (stillMember) => {
    mocks.user = { membershipKind: 'org' };
    renderCatalog();
    fireEvent.click(screen.getByRole('radio', { name: 'skillhub.home.catalogFilter.organization' }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave catalog' }));
    if (!stillMember) mocks.user = null;
    fireEvent.click(screen.getByRole('button', { name: 'Browser Back' }));
    await waitFor(() => expectTab(stillMember ? 'organization' : 'public'));
  });

  it('keeps the market return destination across a local skill rename', () => {
    renderCatalog({
      pathname: '/skillhub/local/skill/global/calendar-tools',
      state: { from: '/skillhub/market', resetHistory: true },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rename skill' }));
    expect(new URLSearchParams(screen.getByTestId('location').textContent!.split('?')[1]).get('name')).toBe('calendar-renamed');
    fireEvent.click(screen.getByRole('button', { name: 'Detail Back' }));
    expect(screen.getByTestId('location').textContent).toBe('/skillhub/market');
  });

  it('keeps the same catalog through browser Back and Forward, including its latest scroll offset', () => {
    renderCatalog();
    selectLocalAndSearch();
    const list = screen.getByRole('main');
    list.scrollTop = 720;
    fireEvent.click(screen.getByRole('button', { name: /calendar-tools/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Browser Back' }));
    expect(screen.getByRole('main')).toBe(list);
    expect(list.scrollTop).toBe(720);
    list.scrollTop = 980;
    fireEvent.click(screen.getByRole('button', { name: 'Browser Forward' }));
    expect(list.isConnected).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Detail Back' }));
    expect(screen.getByRole('main')).toBe(list);
    expect(list.scrollTop).toBe(980);
  });

  it('does not let another detail URL reset the hidden catalog filters', () => {
    renderCatalog();
    selectLocalAndSearch();
    const search = screen.getByRole('textbox', { name: 'skillhub.home.search' }) as HTMLInputElement;
    fireEvent.click(screen.getByRole('button', { name: /calendar-tools/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Another detail' }));
    expect(screen.getByTestId('navigation-state').textContent).toBe('null');
    expect(search.isConnected).toBe(true);
    expect(search.value).toBe('calendar');
    expect(document.querySelector('[role="radio"][aria-checked="true"]')?.textContent)
      .toBe('skillhub.home.local');
  });

  it.each([
    '/skillhub/local/skill/global/calendar-tools',
    '/skillhub/local/skill/project/repo-hash/calendar-tools',
    '/skillhub/local/by-path?path=%2Fskills%2Fcalendar-tools',
    '/skillhub/detail?view=local&kind=skill&scope=global&name=calendar-tools',
  ])('does not mount a hidden catalog for a direct detail URL: %s', (entry) => {
    renderCatalog(entry);
    expect(document.querySelector('main')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Detail Back' }));
    expectTab('public');
    expect(screen.getByRole('main').scrollTop).toBe(0);
  });

  it('releases the catalog after leaving its routes', () => {
    renderCatalog();
    selectLocalAndSearch();
    const list = screen.getByRole('main');
    fireEvent.click(screen.getByRole('button', { name: /calendar-tools/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave catalog' }));
    expect(list.isConnected).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Browser Back' }));
    expect(document.querySelector('main')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Detail Back' }));
    expect(screen.getByRole('main')).not.toBe(list);
  });

  it('releases the hidden catalog when the data owner changes', () => {
    const view = renderCatalog();
    selectLocalAndSearch();
    const list = screen.getByRole('main');
    fireEvent.click(screen.getByRole('button', { name: /calendar-tools/ }));
    mocks.dataOwnerId = 'owner-b';
    view.rerender(<CatalogHarness />);
    expect(list.isConnected).toBe(false);
    expect(document.querySelector('main')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Detail Back' }));
    expect(screen.getByRole('main')).not.toBe(list);
  });
});
