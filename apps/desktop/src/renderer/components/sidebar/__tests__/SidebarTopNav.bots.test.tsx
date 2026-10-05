// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MainViewHistoryProvider } from '@/contexts/MainViewHistoryContext';
import { publishNavigationAttention } from '@/lib/navigationAttentionStore';
import { SidebarRailNavigation, SidebarTopNav, type SidebarRailSearchOptions } from '../SidebarTopNav';
import {
  __testing as navigationTesting,
  getSidebarNavigationPrefs,
  setSidebarNavigationPrefs,
} from '../sidebarNavigationPrefs';

const OWNER = 'owner-1';
const searchMock = vi.hoisted(() => ({ query: '', lockedProjectKey: null as string | null }));
type MainViewMock = { ghostId: string; title: string; icon: 'globe'; manifest: { name: string } };
const mainViewsMock = vi.hoisted(() => ({
  routeCapable: [] as MainViewMock[],
  sidebarVisible: [] as MainViewMock[],
}));
const authMock = vi.hoisted(() => ({ owner: 'owner-1' as string | null }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: authMock.owner }) }));
// A non-empty installed roster marks the plugin list as loaded (Main sends none mid-switch).
const installedMock = vi.hoisted(() => ({ ghosts: [{ manifest: { id: 'bundled' } }] as unknown[] }));
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({ useInstalledGhosts: () => installedMock.ghosts }));
const SITES: MainViewMock = {
  ghostId: 'xd-sites', title: '站点', icon: 'globe', manifest: { name: 'XD Sites' },
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: { name?: string }) =>
      ({ 'sidebar.tabs.bots': '伙伴', 'sidebar.backToSessions': '返回任务' })[key] ??
        (vars?.name ? `${key}: ${vars.name}` : key),
  }),
}));
vi.mock('@/cindy-brain/ghostUnreadStore', () => ({ useAnyGhostUnread: () => false }));
vi.mock('@/cindy-brain/ghostMainViews', () => ({
  useGhostMainViews: () => ({
    declared: mainViewsMock.routeCapable,
    routeCapable: mainViewsMock.routeCapable,
    sidebarVisible: mainViewsMock.sidebarVisible,
  }),
}));
vi.mock('@/cindy-brain/GhostPanelRestoreEntry', () => ({ GhostPanelRestoreEntry: () => null }));
vi.mock('../GhostMainViewNavEntries', () => ({
  GhostMainViewNavEntry: ({ item, variant }: { item: { title: string }; variant: string }) =>
    <button aria-label={item.title} data-variant={variant} />,
  MAIN_VIEW_ICONS: { globe: () => null },
}));
vi.mock('@/features/cc-agent/sidebar/SidebarInlineSearch', () => ({
  SidebarInlineSearch: ({ openSignal, onFocusLeave }: { openSignal: number; onFocusLeave?: () => void }) =>
    <button aria-label="Search row" data-open-signal={openSignal} onBlur={onFocusLeave}>Search row</button>,
}));
vi.mock('@/features/cc-agent/sidebar/conversationSearchContext', () => ({
  useConversationSearchContext: () => ({ search: searchMock, allKnownProjects: [], openSignal: 0 }),
}));

afterEach(() => { cleanup(); publishNavigationAttention({ tasks: 0, teammates: 0 }); });

/** Pretend the owner's first run already happened, so plugins keep their default (More). */
function seedKnownPlugins(ids: string[]) {
  localStorage.setItem('sidebar-navigation:apps:v1', JSON.stringify({ [OWNER]: { known: ids, unseen: [] } }));
  navigationTesting.resetArrivals();
}
beforeEach(() => {
  searchMock.query = '';
  searchMock.lockedProjectKey = null;
  mainViewsMock.routeCapable = [];
  mainViewsMock.sidebarVisible = [];
  authMock.owner = 'owner-1';
  installedMock.ghosts = [{ manifest: { id: 'bundled' } }];
  localStorage.removeItem('sidebar-navigation:apps:v1');
  navigationTesting.resetArrivals();
  setSidebarNavigationPrefs(OWNER, {
    order: ['automations', 'plugins', 'bots', 'search'],
    visible: ['automations', 'plugins', 'bots', 'search'],
  });
});

function NavigationHarness() {
  const location = useLocation();
  const navigate = useNavigate();
  const isTask = location.pathname.startsWith('/cc-agent');
  return (
    <>
      <SidebarTopNav section={isTask ? 'pinned' : 'all'} />
      {isTask && <SidebarTopNav section="scrollable" />}
      <output data-testid="location">{location.pathname + location.search + location.hash}</output>
      <button onClick={() => navigate('/bots/teammate-2')}>Open teammate</button>
      <button onClick={() => navigate('/plugins')}>Open plugins</button>
      <button onClick={() => navigate('/cc-agent/new-owner-session?remoteHostId=new-host#message-3')}>Open task</button>
    </>
  );
}

function Harness({ initialPath, owner = 'one' }: { initialPath: string; owner?: string }) {
  return (
    <MainViewHistoryProvider key={owner}>
      <MemoryRouter initialEntries={[initialPath]}>
        <NavigationHarness />
      </MemoryRouter>
    </MainViewHistoryProvider>
  );
}

describe('Sidebar teammate return action', () => {
  const openMore = () => {
    fireEvent.pointerDown(screen.getByRole('button', { name: 'sidebar.navigation.more' }), {
      button: 0,
      ctrlKey: false,
    });
  };

  it('shows the destination count, preserves it when switching sections, hides zero and reuses 99+ overflow', () => {
    publishNavigationAttention({ tasks: 4, teammates: 105 });
    render(<Harness initialPath="/cc-agent" />);
    expect(screen.getByRole('button', { name: '伙伴' }).textContent).toBe('伙伴99+');
    fireEvent.click(screen.getByRole('button', { name: '伙伴' }));
    expect(screen.getByRole('button', { name: '返回任务' }).textContent).toBe('返回任务4');
    fireEvent.click(screen.getByRole('button', { name: '返回任务' }));
    expect(screen.getByRole('button', { name: '伙伴' }).textContent).toBe('伙伴99+');
    act(() => publishNavigationAttention({ tasks: 4, teammates: 0 }));
    expect(screen.getByRole('button', { name: '伙伴' }).textContent).toBe('伙伴');
  });

  it('keeps the teammate count on its More item and narrow rail tile', () => {
    publishNavigationAttention({ tasks: 0, teammates: 3 });
    setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'plugins', 'bots', 'search'],
      visible: ['automations', 'plugins', 'search'],
    });
    render(<Harness initialPath="/cc-agent" />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'sidebar.navigation.more' }), { button: 0, ctrlKey: false });
    expect(screen.getByRole('menuitem', { name: /伙伴/ }).textContent).toBe('伙伴3');
    cleanup();
    setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'plugins', 'bots', 'search'],
      visible: ['automations', 'plugins', 'bots', 'search'],
    });
    render(<MainViewHistoryProvider><MemoryRouter initialEntries={['/cc-agent']}>
      <SidebarRailNavigation renderSearch={() => null} />
    </MemoryRouter></MainViewHistoryProvider>);
    expect(screen.getByRole('button', { name: '伙伴' }).textContent).toBe('3');
  });

  it('moves every unchecked entry into More and opens the same destination', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['bots', 'plugins', 'search', 'automations'],
      visible: [],
    });
    render(<Harness initialPath="/cc-agent/session-1" />);
    expect(screen.queryByRole('button', { name: 'ccAgent.layout.automations' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'sidebar.tabs.plugins' })).toBeNull();
    expect(screen.queryByRole('button', { name: '伙伴' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Search row' })).toBeNull();

    openMore();
    const hidden = ['伙伴', 'sidebar.tabs.plugins', 'sidebar.navigation.items.search', 'ccAgent.layout.automations'];
    const items = hidden.map((name) => screen.getByRole('menuitem', { name }));
    expect(items.every((item, index) =>
      index === 0 || Boolean(items[index - 1].compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING),
    )).toBe(true);
    fireEvent.click(items[0]);
    expect(screen.getByTestId('location').textContent).toBe('/bots/list');

    openMore();
    fireEvent.click(screen.getByRole('menuitem', { name: '返回任务' }));
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent/session-1');

    openMore();
    fireEvent.click(screen.getByRole('menuitem', { name: 'sidebar.tabs.plugins' }));
    expect(screen.getByTestId('location').textContent).toBe('/plugins');

    openMore();
    fireEvent.click(screen.getByRole('menuitem', { name: 'ccAgent.layout.automations' }));
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent/scheduled');
  });

  it('opens an unchecked Search from More without changing its saved visibility', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'plugins', 'bots', 'search'],
      visible: ['automations', 'plugins', 'bots'],
    });
    render(<Harness initialPath="/cc-agent" />);
    expect(screen.queryByRole('button', { name: 'Search row' })).toBeNull();
    openMore();
    fireEvent.click(screen.getByRole('menuitem', { name: 'sidebar.navigation.items.search' }));
    expect(screen.getByRole('button', { name: 'Search row' }).getAttribute('data-open-signal')).toBe('1');
    openMore();
    expect(screen.getByRole('menuitem', { name: 'sidebar.navigation.items.search' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'sidebar.navigation.items.search' }), { key: 'Escape' });
    fireEvent.blur(screen.getByRole('button', { name: 'Search row' }));
    expect(screen.queryByRole('button', { name: 'Search row' })).toBeNull();
  });

  it('keeps checked entries out of More', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'plugins', 'bots', 'search'],
      visible: ['automations', 'search'],
    });
    render(<Harness initialPath="/cc-agent" />);
    openMore();
    expect(screen.queryByRole('menuitem', { name: 'ccAgent.layout.automations' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'sidebar.navigation.items.search' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'sidebar.tabs.plugins' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '伙伴' })).toBeTruthy();
  });

  it('places Search in the saved order and does not add an Issue entry', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['search', 'plugins', 'automations', 'bots'],
      visible: ['search', 'plugins', 'automations', 'bots'],
    });
    render(<Harness initialPath="/cc-agent" />);
    const search = screen.getByRole('button', { name: 'Search row' });
    const plugins = screen.getByRole('button', { name: 'sidebar.tabs.plugins' });
    expect(search.compareDocumentPosition(plugins) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'sidebar.tabs.issues' })).toBeNull();
  });

  it('hides Search until an active query needs its input again', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'plugins', 'bots', 'search'],
      visible: ['automations', 'plugins', 'bots'],
    });
    const view = render(<Harness initialPath="/cc-agent" />);
    expect(screen.queryByRole('button', { name: 'Search row' })).toBeNull();
    searchMock.query = 'needle';
    view.rerender(<Harness initialPath="/cc-agent" />);
    expect(screen.getByRole('button', { name: 'Search row' })).toBeTruthy();
    // More stays reachable while the query is pinned.
    expect(screen.getByRole('button', { name: 'sidebar.navigation.more' })).toBeTruthy();
    searchMock.query = '';
    view.rerender(<Harness initialPath="/cc-agent" />);
    expect(screen.queryByRole('button', { name: 'Search row' })).toBeNull();
  });

  it('keeps entries after a mid-list Search reachable while a query is pinned', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'search', 'plugins', 'bots'],
      visible: ['automations', 'search', 'plugins', 'bots'],
    });
    searchMock.query = 'needle';
    render(<Harness initialPath="/cc-agent" />);
    const search = screen.getByRole('button', { name: 'Search row' });
    const plugins = screen.getByRole('button', { name: 'sidebar.tabs.plugins' });
    expect(search.compareDocumentPosition(plugins) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: '伙伴' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'sidebar.navigation.more' })).toBeTruthy();
  });

  it('keeps a hidden Search accessible for a project-scoped search', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'plugins', 'bots', 'search'],
      visible: ['automations', 'plugins', 'bots'],
    });
    searchMock.lockedProjectKey = 'project-1';
    render(<Harness initialPath="/cc-agent" />);
    expect(screen.getByRole('button', { name: 'Search row' })).toBeTruthy();
  });
  it('places a plugin main view in the saved order like any other entry', () => {
    mainViewsMock.routeCapable = [SITES];
    mainViewsMock.sidebarVisible = [SITES];
    setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'app:xd-sites', 'plugins', 'bots', 'search'],
      visible: ['automations', 'plugins', 'bots', 'search'],
    });
    render(<Harness initialPath="/cc-agent" />);
    const automations = screen.getByRole('button', { name: 'ccAgent.layout.automations' });
    const sites = screen.getByRole('button', { name: '站点' });
    const plugins = screen.getByRole('button', { name: 'sidebar.tabs.plugins' });
    expect(automations.compareDocumentPosition(sites) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sites.compareDocumentPosition(plugins) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    openMore();
    expect(screen.queryByRole('menuitem', { name: /站点/ })).toBeNull();
  });
  it('keeps a plugin without a top-level placement in More and opens its page', () => {
    seedKnownPlugins(['xd-sites']);
    mainViewsMock.routeCapable = [SITES];
    mainViewsMock.sidebarVisible = [SITES];
    render(<Harness initialPath="/cc-agent" />);
    expect(screen.queryByRole('button', { name: '站点' })).toBeNull();
    openMore();
    fireEvent.click(screen.getByRole('menuitem', { name: /站点/ }));
    expect(screen.getByTestId('location').textContent).toBe('/apps/xd-sites');
  });
  it('leaves a plugin out of the sidebar and More once its own switch is off', () => {
    mainViewsMock.routeCapable = [SITES];
    render(<Harness initialPath="/cc-agent" />);
    expect(screen.queryByRole('button', { name: '站点' })).toBeNull();
    openMore();
    expect(screen.queryByRole('menuitem', { name: /站点/ })).toBeNull();
  });
  it('keeps a Customize choice from forcing a switched-on plugin to the top level', () => {
    mainViewsMock.routeCapable = [SITES];
    mainViewsMock.sidebarVisible = [SITES];
    render(<Harness initialPath="/cc-agent" />);
    expect(screen.getByRole('button', { name: '站点' })).toBeTruthy();
    act(() => setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'plugins', 'bots', 'search'],
      visible: ['automations', 'plugins', 'bots', 'search'],
      appsAtTop: [],
    }));
    expect(screen.queryByRole('button', { name: '站点' })).toBeNull();
  });
  it('keeps the plugin manage action on its More item', () => {
    seedKnownPlugins(['xd-sites']);
    mainViewsMock.routeCapable = [SITES];
    mainViewsMock.sidebarVisible = [SITES];
    render(<Harness initialPath="/cc-agent" />);
    openMore();
    const item = screen.getByRole('menuitem', { name: /站点/ });
    const manage = within(item).getByRole('button', { name: 'settings.ghosts.page.manageAria: XD Sites' });
    fireEvent.click(manage);
    expect(screen.getByTestId('location').textContent).toBe('/settings?tab=ghosts&ghost=xd-sites');
    // The flag is one-shot: the next plain selection opens the plugin page again.
    openMore();
    fireEvent.click(screen.getByRole('menuitem', { name: /站点/ }));
    expect(screen.getByTestId('location').textContent).toBe('/apps/xd-sites');
  });
  it('lists only unchecked entries and Customize in More', () => {
    render(<Harness initialPath="/cc-agent" />);
    openMore();
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent))
      .toEqual(['sidebar.navigation.customize.title']);
  });
  it('respects hidden teammate navigation in the narrow rail', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'plugins', 'bots', 'search'],
      visible: ['automations', 'plugins'],
    });
    render(<MainViewHistoryProvider><MemoryRouter initialEntries={['/cc-agent']}>
      <SidebarTopNav section="rail" />
    </MemoryRouter></MainViewHistoryProvider>);
    expect(screen.queryByRole('button', { name: '伙伴' })).toBeNull();
    act(() => setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'plugins', 'bots', 'search'],
      visible: ['automations', 'plugins', 'bots', 'search'],
    }));
  });
  it('keeps the previous task when visiting automations before teammates', () => {
    const sessionPath = '/cc-agent/session-1?remoteHostId=host-1#message-2';
    render(<Harness initialPath={sessionPath} />);
    fireEvent.click(screen.getByRole('button', { name: 'ccAgent.layout.automations' }));
    expect(screen.getByRole('button', { name: 'ccAgent.layout.automations' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('button', { name: '伙伴' }));
    fireEvent.click(screen.getByRole('button', { name: '返回任务' }));
    expect(screen.getByTestId('location').textContent).toBe(sessionPath);
    expect(screen.getByRole('button', { name: 'ccAgent.layout.automations' }).hasAttribute('aria-current')).toBe(false);
  });

  it.each(['/cc-agent/scheduled', '/cc-agent/scheduled/?filter=enabled#schedule-1'])(
    'returns to the task index after entering teammates from %s without a previous task',
    (initialPath) => {
      render(<Harness initialPath={initialPath} />);
      fireEvent.click(screen.getByRole('button', { name: '伙伴' }));
      fireEvent.click(screen.getByRole('button', { name: '返回任务' }));
      expect(screen.getByTestId('location').textContent).toBe('/cc-agent');
      expect(screen.getByRole('button', { name: 'ccAgent.layout.automations' }).hasAttribute('aria-current')).toBe(false);
    },
  );

  it('does not seed a new owner from the unchanged router entry', () => {
    const oldPath = '/cc-agent/old-owner-session?remoteHostId=old-host#message-2';
    function OwnerRouter({ owner }: { owner: string }) {
      const location = useLocation();
      return (
        <MainViewHistoryProvider ownerKey={owner} locationKey={location.key}>
          <NavigationHarness key={owner} />
        </MainViewHistoryProvider>
      );
    }
    function PersistentRouter({ owner }: { owner: string }) {
      return <MemoryRouter initialEntries={[oldPath]}><OwnerRouter owner={owner} /></MemoryRouter>;
    }
    const view = render(<PersistentRouter owner="one" />);
    view.rerender(<PersistentRouter owner="two" />);
    expect(screen.getByTestId('location').textContent).toBe(oldPath);
    fireEvent.click(screen.getByRole('button', { name: '伙伴' }));
    fireEvent.click(screen.getByRole('button', { name: '返回任务' }));
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent');

    const newPath = '/cc-agent/new-owner-session?remoteHostId=new-host#message-3';
    fireEvent.click(screen.getByRole('button', { name: 'Open task' }));
    view.rerender(<PersistentRouter owner="two" />);
    fireEvent.click(screen.getByRole('button', { name: '伙伴' }));
    fireEvent.click(screen.getByRole('button', { name: '返回任务' }));
    expect(screen.getByTestId('location').textContent).toBe(newPath);
  });

  it('changes the existing entry and restores both destinations across sidebar remounts', () => {
    const sessionPath = '/cc-agent/session-1?remoteHostId=host-1#message-2';
    render(<Harness initialPath={sessionPath} />);
    const initialButtonCount = screen.getAllByRole('button').length;
    const entry = screen.getByRole('button', { name: '伙伴' });
    expect(entry.querySelector('.lucide-bot')).not.toBeNull();
    fireEvent.click(entry);

    const back = screen.getByRole('button', { name: '返回任务' });
    expect(back.textContent).toBe('返回任务');
    expect(back.querySelector('.lucide-arrow-left')).not.toBeNull();
    expect(back.hasAttribute('aria-current')).toBe(false);
    expect(back.hasAttribute('aria-pressed')).toBe(false);
    expect(back.className).not.toContain('bg-sidebar-item-active');
    expect(screen.queryByRole('button', { name: '伙伴' })).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(initialButtonCount);

    fireEvent.click(screen.getByRole('button', { name: 'Open teammate' }));
    fireEvent.click(screen.getByRole('button', { name: '返回任务' }));
    expect(screen.getByTestId('location').textContent).toBe(sessionPath);
    fireEvent.click(screen.getByRole('button', { name: '伙伴' }));
    expect(screen.getByTestId('location').textContent).toBe('/bots/teammate-2');
  });

  it('returns a direct teammate entry to the session index, even after visiting plugins', () => {
    render(<Harness initialPath="/bots/teammate-2" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open plugins' }));
    fireEvent.click(screen.getByRole('button', { name: '伙伴' }));
    expect(screen.getByTestId('location').textContent).toBe('/bots/teammate-2');
    fireEvent.click(screen.getByRole('button', { name: '返回任务' }));
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent');
  });

  it('discards remembered destinations when the account scope changes', () => {
    const view = render(<Harness initialPath="/cc-agent/private-session" />);
    fireEvent.click(screen.getByRole('button', { name: '伙伴' }));
    view.rerender(<Harness initialPath="/bots" owner="two" />);
    fireEvent.click(screen.getByRole('button', { name: '返回任务' }));
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent');
  });
});

describe('Narrow rail navigation', () => {
  function RailHarness({ forceSearch = false }: { forceSearch?: boolean }) {
    const location = useLocation();
    return (
      <>
        <SidebarRailNavigation
          forceSearch={forceSearch}
          renderSearch={({ defaultOpen, onOpenChange }: SidebarRailSearchOptions) => (
            <button
              aria-label="Rail search"
              data-default-open={String(defaultOpen)}
              onClick={() => onOpenChange(false)}
            />
          )}
        />
        <output data-testid="location">{location.pathname}</output>
      </>
    );
  }
  const renderRail = (props: { forceSearch?: boolean } = {}) => render(
    <MainViewHistoryProvider>
      <MemoryRouter initialEntries={['/cc-agent/session-1']}>
        <RailHarness {...props} />
      </MemoryRouter>
    </MainViewHistoryProvider>,
  );
  const openMore = () => {
    fireEvent.pointerDown(screen.getByRole('button', { name: 'sidebar.navigation.more' }), {
      button: 0,
      ctrlKey: false,
    });
  };

  it('lays out checked entries in the saved order', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['search', 'bots', 'automations', 'plugins'],
      visible: ['search', 'bots', 'automations', 'plugins'],
    });
    renderRail();
    const names = ['Rail search', '伙伴', 'ccAgent.layout.automations', 'sidebar.tabs.plugins'];
    const tiles = names.map((name) => screen.getByRole('button', { name }));
    expect(tiles.every((tile, index) =>
      index === 0 || Boolean(tiles[index - 1].compareDocumentPosition(tile) & Node.DOCUMENT_POSITION_FOLLOWING),
    )).toBe(true);
  });

  it('drops More when nothing is hidden', () => {
    renderRail();
    expect(screen.queryByRole('button', { name: 'sidebar.navigation.more' })).toBeNull();
    act(() => setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'plugins', 'bots', 'search'],
      visible: ['automations', 'bots', 'search'],
    }));
    openMore();
    expect(screen.getByRole('menuitem', { name: 'sidebar.tabs.plugins' })).toBeTruthy();
  });

  it('lays out plugin main views in the saved order and keeps hidden ones in More', () => {
    const other: MainViewMock = { ghostId: 'other', title: 'Other', icon: 'globe', manifest: { name: 'Other' } };
    const off: MainViewMock = { ghostId: 'off', title: 'Off', icon: 'globe', manifest: { name: 'Off' } };
    seedKnownPlugins(['xd-sites', 'other']);
    mainViewsMock.routeCapable = [SITES, other, off];
    mainViewsMock.sidebarVisible = [SITES, other];
    setSidebarNavigationPrefs(OWNER, {
      order: ['app:xd-sites', 'automations', 'plugins', 'bots', 'search', 'app:other', 'app:off'],
      visible: ['automations', 'plugins', 'bots', 'search'],
      appsAtTop: ['app:xd-sites'],
    });
    renderRail();
    const sites = screen.getByRole('button', { name: '站点' });
    expect(sites.getAttribute('data-variant')).toBe('rail');
    expect(sites.compareDocumentPosition(screen.getByRole('button', { name: 'ccAgent.layout.automations' }))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Other' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Off' })).toBeNull();
    openMore();
    expect(screen.queryByRole('menuitem', { name: /Off/ })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: /Other/ }));
    expect(screen.getByTestId('location').textContent).toBe('/apps/other');
  });

  it('moves unchecked entries into More and opens the same destination', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['plugins', 'automations', 'bots', 'search'],
      visible: ['search'],
    });
    renderRail();
    expect(screen.queryByRole('button', { name: 'sidebar.tabs.plugins' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'ccAgent.layout.automations' })).toBeNull();
    expect(screen.queryByRole('button', { name: '伙伴' })).toBeNull();

    openMore();
    expect(screen.queryByRole('menuitem', { name: 'sidebar.navigation.items.search' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'sidebar.navigation.customize.title' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'ccAgent.layout.automations' }));
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent/scheduled');

    openMore();
    fireEvent.click(screen.getByRole('menuitem', { name: 'sidebar.tabs.plugins' }));
    expect(screen.getByTestId('location').textContent).toBe('/plugins');

    openMore();
    fireEvent.click(screen.getByRole('menuitem', { name: '伙伴' }));
    expect(screen.getByTestId('location').textContent).toBe('/bots/list');
  });

  it('opens an unchecked Search from More and hides it again once closed', async () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'plugins', 'bots', 'search'],
      visible: ['automations', 'plugins', 'bots'],
    });
    renderRail();
    expect(screen.queryByRole('button', { name: 'Rail search' })).toBeNull();
    openMore();
    fireEvent.click(screen.getByRole('menuitem', { name: 'sidebar.navigation.items.search' }));
    const search = await screen.findByRole('button', { name: 'Rail search' });
    expect(search.getAttribute('data-default-open')).toBe('true');
    fireEvent.click(search);
    expect(screen.queryByRole('button', { name: 'Rail search' })).toBeNull();
  });

  it('keeps a hidden Search for a project-scoped search request', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'plugins', 'bots', 'search'],
      visible: ['automations', 'plugins', 'bots'],
    });
    renderRail({ forceSearch: true });
    expect(screen.getByRole('button', { name: 'Rail search' }).getAttribute('data-default-open'))
      .toBe('false');
  });
});

describe('Plugins joining the sidebar', () => {
  const NEWCOMER: MainViewMock = { ghostId: 'newcomer', title: 'Newcomer', icon: 'globe', manifest: { name: 'Newcomer' } };
  const renderNav = () => render(
    <MainViewHistoryProvider>
      <MemoryRouter initialEntries={['/cc-agent']}>
        <SidebarTopNav section="all" />
      </MemoryRouter>
    </MainViewHistoryProvider>,
  );
  const openMore = (name: string | RegExp = /sidebar\.navigation\.more/) => {
    fireEvent.pointerDown(screen.getByRole('button', { name }), { button: 0, ctrlKey: false });
  };

  it('keeps plugins already in the sidebar where they are on the first run', () => {
    mainViewsMock.routeCapable = [SITES];
    mainViewsMock.sidebarVisible = [SITES];
    renderNav();
    expect(screen.getByRole('button', { name: '站点' })).toBeTruthy();
    expect(screen.queryByText('sidebar.navigation.new')).toBeNull();
    expect(getSidebarNavigationPrefs(OWNER).appsAtTop).toEqual(['app:xd-sites']);
  });

  it('places a newly arrived plugin in More and flags it until More has been opened', () => {
    mainViewsMock.routeCapable = [SITES];
    mainViewsMock.sidebarVisible = [SITES];
    const view = renderNav();
    mainViewsMock.routeCapable = [SITES, NEWCOMER];
    mainViewsMock.sidebarVisible = [SITES, NEWCOMER];
    view.rerender(
      <MainViewHistoryProvider>
        <MemoryRouter initialEntries={['/cc-agent']}>
          <SidebarTopNav section="all" />
        </MemoryRouter>
      </MainViewHistoryProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Newcomer' })).toBeNull();
    // The newcomer needs no placement write: plugins default to More.
    expect(getSidebarNavigationPrefs(OWNER).appsAtTop).toEqual(['app:xd-sites']);
    const more = screen.getByRole('button', { name: 'sidebar.navigation.more · sidebar.navigation.new' });
    expect(within(more).getByText('sidebar.navigation.new')).toBeTruthy();

    openMore();
    const item = screen.getByRole('menuitem', { name: /Newcomer/ });
    expect(within(item).getByText('sidebar.navigation.new')).toBeTruthy();
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(screen.queryByText('sidebar.navigation.new')).toBeNull();
    expect(screen.getByRole('button', { name: 'sidebar.navigation.more' })).toBeTruthy();
  });

  it('waits for the account before deciding which plugins are new', () => {
    authMock.owner = null;
    mainViewsMock.routeCapable = [SITES];
    mainViewsMock.sidebarVisible = [SITES];
    const view = renderNav();
    expect(localStorage.getItem('sidebar-navigation:apps:v1')).toBeNull();
    authMock.owner = 'owner-1';
    view.rerender(
      <MainViewHistoryProvider>
        <MemoryRouter initialEntries={['/cc-agent']}>
          <SidebarTopNav section="all" />
        </MemoryRouter>
      </MainViewHistoryProvider>,
    );
    expect(screen.getByRole('button', { name: '站点' })).toBeTruthy();
    expect(getSidebarNavigationPrefs(OWNER).appsAtTop).toEqual(['app:xd-sites']);
  });

  it('marks the narrow rail More button while a new plugin waits there', () => {
    localStorage.setItem('sidebar-navigation:apps:v1', JSON.stringify({ 'owner-1': { known: [], unseen: [] } }));
    navigationTesting.resetArrivals();
    mainViewsMock.routeCapable = [NEWCOMER];
    mainViewsMock.sidebarVisible = [NEWCOMER];
    render(
      <MainViewHistoryProvider>
        <MemoryRouter initialEntries={['/cc-agent']}>
          <SidebarRailNavigation renderSearch={() => null} />
        </MemoryRouter>
      </MainViewHistoryProvider>,
    );
    expect(screen.queryByRole('button', { name: 'Newcomer' })).toBeNull();
    expect(screen.getByRole('button', { name: 'sidebar.navigation.more · sidebar.navigation.new' })).toBeTruthy();
  });

  it('shows each account its own navigation layout', () => {
    setSidebarNavigationPrefs('owner-2', {
      order: ['automations', 'plugins', 'bots', 'search'],
      visible: ['automations'],
    });
    const view = renderNav();
    expect(screen.getByRole('button', { name: 'sidebar.tabs.plugins' })).toBeTruthy();
    authMock.owner = 'owner-2';
    view.rerender(
      <MainViewHistoryProvider>
        <MemoryRouter initialEntries={['/cc-agent']}>
          <SidebarTopNav section="all" />
        </MemoryRouter>
      </MainViewHistoryProvider>,
    );
    expect(screen.queryByRole('button', { name: 'sidebar.tabs.plugins' })).toBeNull();
    expect(screen.getByRole('button', { name: 'ccAgent.layout.automations' })).toBeTruthy();
  });

  it('defers the first run while the installed roster is still empty', () => {
    installedMock.ghosts = [];
    mainViewsMock.routeCapable = [SITES];
    mainViewsMock.sidebarVisible = [SITES];
    renderNav();
    expect(localStorage.getItem('sidebar-navigation:apps:v1')).toBeNull();
    expect(getSidebarNavigationPrefs(OWNER).appsAtTop).toEqual([]);
  });

  it('starts a fresh Customize draft when the account changes while it is open', () => {
    setSidebarNavigationPrefs('owner-2', {
      order: ['automations', 'plugins', 'bots', 'search'],
      visible: ['automations', 'search'],
    });
    const view = renderNav();
    openMore();
    fireEvent.click(screen.getByRole('menuitem', { name: 'sidebar.navigation.customize.title' }));
    // Account A unchecks Plugins in the draft, then the account switches before Done.
    fireEvent.click(screen.getByRole('checkbox', { name: 'sidebar.navigation.items.plugins' }));
    authMock.owner = 'owner-2';
    view.rerender(
      <MainViewHistoryProvider>
        <MemoryRouter initialEntries={['/cc-agent']}>
          <SidebarTopNav section="all" />
        </MemoryRouter>
      </MainViewHistoryProvider>,
    );
    expect(screen.getByRole('checkbox', { name: 'sidebar.navigation.items.bots' }).getAttribute('aria-checked'))
      .toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.done' }));
    expect(getSidebarNavigationPrefs('owner-2').visible).toEqual(['automations', 'search']);
    expect(getSidebarNavigationPrefs(OWNER).visible).toEqual(['automations', 'plugins', 'bots', 'search']);
  });
});
