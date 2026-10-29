// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MainViewHistoryProvider } from '@/contexts/MainViewHistoryContext';
import { SidebarRailNavigation, SidebarTopNav, type SidebarRailSearchOptions } from '../SidebarTopNav';
import {
  __testing as navigationTesting,
  getSidebarNavigationPrefs,
  setSidebarNavigationPrefs,
} from '../sidebarNavigationPrefs';

const OWNER = 'owner-1';
const searchMock = vi.hoisted(() => ({ query: '', lockedProjectKey: null as string | null }));
type MainViewMock = { ghostId: string; instanceId: string; title: string; icon: 'globe'; manifest: { name: string } };
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
  ghostId: 'xd-sites', instanceId: 'xd-sites', title: '站点', icon: 'globe', manifest: { name: 'XD Sites' },
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: { name?: string }) => (vars?.name ? `${key}: ${vars.name}` : key),
  }),
}));
const unreadMock = vi.hoisted(() => ({ ordinary: false }));
vi.mock('@/cindy-brain/ghostUnreadStore', () => ({ useAnyGhostUnread: () => unreadMock.ordinary }));
vi.mock('@/cindy-brain/ghostMainViews', () => ({
  useGhostMainViews: () => ({
    declared: mainViewsMock.routeCapable,
    routeCapable: mainViewsMock.routeCapable,
    sidebarVisible: mainViewsMock.sidebarVisible,
  }),
}));
vi.mock('../GhostMainViewNavEntries', () => ({
  GhostMainViewNavEntry: ({ item, variant }: { item: { title: string }; variant: string }) =>
    <button aria-label={item.title} data-variant={variant} />,
  MAIN_VIEW_ICONS: { globe: () => null },
}));
vi.mock('@/features/cc-agent/sidebar/SidebarInlineSearch', () => ({
  // Clicking stands in for typing a query: the real row reports that search became active.
  SidebarInlineSearch: ({ openSignal, onFocusLeave, onSearchActive }: {
    openSignal: number; onFocusLeave?: () => void; onSearchActive?: () => void;
  }) =>
    <button aria-label="Search row" data-open-signal={openSignal} onBlur={onFocusLeave} onClick={onSearchActive}>Search row</button>,
}));
vi.mock('@/features/cc-agent/sidebar/conversationSearchContext', () => ({
  useConversationSearchContext: () => ({ search: searchMock, allKnownProjects: [], openSignal: 0 }),
}));

afterEach(() => { cleanup(); });

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
  unreadMock.ordinary = false;
  localStorage.removeItem('sidebar-navigation:apps:v1');
  navigationTesting.resetArrivals();
  setSidebarNavigationPrefs(OWNER, {
    order: ['automations', 'plugins', 'search'],
    visible: ['automations', 'plugins', 'search'],
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

describe('Retirement attention across sidebar navigation placements', () => {
  it.each(['row', 'more', 'rail', 'rail-more'] as const)(
    'keeps the notice visible in %s and clears only its own unread state',
    (placement) => {
      installedMock.ghosts = [{ manifest: { id: 'ios-simulator' }, retirement: { unread: true } }];
      const inMore = placement.endsWith('more');
      if (inMore) {
        setSidebarNavigationPrefs(OWNER, {
          order: ['automations', 'plugins', 'search'],
          visible: ['automations', 'search'],
        });
      }
      const ui = () => (
        <MainViewHistoryProvider>
          <MemoryRouter initialEntries={['/cc-agent/session-1']}>
            {placement.startsWith('rail')
              ? <SidebarRailNavigation renderSearch={() => null} />
              : <SidebarTopNav />}
          </MemoryRouter>
        </MainViewHistoryProvider>
      );
      const view = render(ui());
      if (inMore) {
        fireEvent.pointerDown(screen.getByRole('button', { name: 'sidebar.navigation.more' }), {
          button: 0, ctrlKey: false,
        });
      }
      const entry = () => screen.getByRole(inMore ? 'menuitem' : 'button', { name: 'sidebar.tabs.plugins' });
      const dot = (tone: string) => Array.from(entry().querySelectorAll('span')).find((span) =>
        span.className.includes(`--card-status-${tone}`),
      );
      expect(dot('awaiting')).toBeTruthy();
      expect(dot('awaiting')?.className).not.toContain('session-card-dot');

      // Acknowledging retirement must preserve another plugin's ordinary unread dot.
      installedMock.ghosts = [{ manifest: { id: 'ios-simulator' }, retirement: { unread: false } }];
      unreadMock.ordinary = true;
      view.rerender(ui());
      expect(dot('awaiting')).toBeUndefined();
      expect(dot('done')).toBeTruthy();

      unreadMock.ordinary = false;
      view.rerender(ui());
      expect(dot('done')).toBeUndefined();
    },
  );
});

describe('Sidebar navigation rows and More', () => {
  const openMore = () => {
    fireEvent.pointerDown(screen.getByRole('button', { name: 'sidebar.navigation.more' }), {
      button: 0,
      ctrlKey: false,
    });
  };
  const activateSearch = () => fireEvent.click(screen.getByRole('button', { name: 'Search row' }));

  it('no longer offers Teammates as a navigation entry or a More item', () => {
    render(<Harness initialPath="/cc-agent" />);
    expect(screen.queryByRole('button', { name: 'sidebar.tabs.bots' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'sidebar.backToSessions' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open teammate' }));
    // On a teammate chat the same rows stay; there is no "back to tasks" swap.
    expect(screen.queryByRole('button', { name: 'sidebar.backToSessions' })).toBeNull();
    expect(screen.getByRole('button', { name: 'sidebar.tabs.plugins' })).toBeTruthy();
    openMore();
    expect(screen.queryByRole('menuitem', { name: /sidebar\.tabs\.bots|sidebar\.backToSessions/ })).toBeNull();
  });

  it('moves every unchecked entry into More and opens the same destination', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['plugins', 'search', 'automations'],
      visible: [],
    });
    render(<Harness initialPath="/cc-agent/session-1" />);
    expect(screen.queryByRole('button', { name: 'ccAgent.layout.automations' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'sidebar.tabs.plugins' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Search row' })).toBeNull();

    openMore();
    const hidden = ['sidebar.tabs.plugins', 'sidebar.navigation.items.search', 'ccAgent.layout.automations'];
    const items = hidden.map((name) => screen.getByRole('menuitem', { name }));
    expect(items.every((item, index) =>
      index === 0 || Boolean(items[index - 1].compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING),
    )).toBe(true);
    fireEvent.click(items[0]);
    expect(screen.getByTestId('location').textContent).toBe('/plugins');

    openMore();
    fireEvent.click(screen.getByRole('menuitem', { name: 'ccAgent.layout.automations' }));
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent/scheduled');
  });

  it('opens an unchecked Search from More without changing its saved visibility', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'plugins', 'search'],
      visible: ['automations', 'plugins'],
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

  it('opens More on hover, stays open on click, and closes once the pointer leaves', () => {
    vi.useFakeTimers();
    try {
      setSidebarNavigationPrefs(OWNER, {
        order: ['automations', 'plugins', 'search'],
        visible: ['automations', 'search'],
      });
      render(<Harness initialPath="/cc-agent" />);
      // Hover never moves focus: whatever had it (here the search row) keeps it throughout.
      const focused = screen.getByRole('button', { name: 'Search row' });
      act(() => { focused.focus(); });
      const more = screen.getByRole('button', { name: 'sidebar.navigation.more' });
      fireEvent.mouseEnter(more);
      expect(screen.queryByRole('menu')).toBeNull();
      act(() => { vi.advanceTimersByTime(100); });
      const menu = screen.getByRole('menu');
      expect(within(menu).getByRole('menuitem', { name: 'sidebar.tabs.plugins' })).toBeTruthy();
      expect(document.activeElement).toBe(focused);
      // A click on the already open trigger keeps the menu.
      fireEvent.pointerDown(more, { button: 0, ctrlKey: false });
      expect(screen.getByRole('menu')).toBeTruthy();
      // Crossing from the trigger into the menu keeps it open.
      fireEvent.mouseLeave(more);
      fireEvent.mouseEnter(menu);
      act(() => { vi.advanceTimersByTime(300); });
      expect(screen.getByRole('menu')).toBeTruthy();
      fireEvent.mouseLeave(menu);
      act(() => { vi.advanceTimersByTime(300); });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(focused);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still moves focus into More when it is opened from the keyboard', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'plugins', 'search'],
      visible: ['automations', 'search'],
    });
    render(<Harness initialPath="/cc-agent" />);
    const more = screen.getByRole('button', { name: 'sidebar.navigation.more' });
    act(() => { more.focus(); });
    fireEvent.keyDown(more, { key: 'Enter' });
    const menu = screen.getByRole('menu');
    expect(menu.contains(document.activeElement)).toBe(true);
  });

  it('keeps checked entries out of More', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'plugins', 'search'],
      visible: ['automations', 'search'],
    });
    render(<Harness initialPath="/cc-agent" />);
    openMore();
    expect(screen.queryByRole('menuitem', { name: 'ccAgent.layout.automations' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'sidebar.navigation.items.search' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'sidebar.tabs.plugins' })).toBeTruthy();
  });

  it('places Search in the saved order and does not add an Issue entry', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['search', 'plugins', 'automations'],
      visible: ['search', 'plugins', 'automations'],
    });
    render(<Harness initialPath="/cc-agent" />);
    const search = screen.getByRole('button', { name: 'Search row' });
    const plugins = screen.getByRole('button', { name: 'sidebar.tabs.plugins' });
    expect(search.compareDocumentPosition(plugins) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'sidebar.tabs.issues' })).toBeNull();
  });

  it('hides Search until an active query needs its input again', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'plugins', 'search'],
      visible: ['automations', 'plugins'],
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
      order: ['automations', 'search', 'plugins'],
      visible: ['automations', 'search', 'plugins'],
    });
    searchMock.query = 'needle';
    render(<Harness initialPath="/cc-agent" />);
    const search = screen.getByRole('button', { name: 'Search row' });
    const plugins = screen.getByRole('button', { name: 'sidebar.tabs.plugins' });
    expect(search.compareDocumentPosition(plugins) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: 'sidebar.navigation.more' })).toBeTruthy();
  });

  it('keeps a hidden Search accessible for a project-scoped search', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'plugins', 'search'],
      visible: ['automations', 'plugins'],
    });
    searchMock.lockedProjectKey = 'project-1';
    render(<Harness initialPath="/cc-agent" />);
    expect(screen.getByRole('button', { name: 'Search row' })).toBeTruthy();
  });
  it('places a plugin main view in the saved order like any other entry', () => {
    mainViewsMock.routeCapable = [SITES];
    mainViewsMock.sidebarVisible = [SITES];
    setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'app:xd-sites', 'plugins', 'search'],
      visible: ['automations', 'plugins', 'search'],
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
      order: ['automations', 'plugins', 'search'],
      visible: ['automations', 'plugins', 'search'],
      appsAtTop: [],
    }));
    expect(screen.queryByRole('button', { name: '站点' })).toBeNull();
  });
  it.each(['xd-sites', '_root__xd-sites', '_ns__acme__xd-sites'])(
    'opens the page and manage action for the exact %s instance in More', (instanceId) => {
    seedKnownPlugins([instanceId]);
    const sites = { ...SITES, instanceId };
    mainViewsMock.routeCapable = [sites];
    mainViewsMock.sidebarVisible = [sites];
    render(<Harness initialPath="/cc-agent" />);
    expect(screen.queryByRole('button', { name: '站点' })).toBeNull();
    openMore();
    const item = screen.getByRole('menuitem', { name: /站点/ });
    const manage = within(item).getByRole('button', { name: 'settings.ghosts.page.manageAria: XD Sites' });
    fireEvent.click(manage);
    expect(screen.getByTestId('location').textContent).toBe('/settings?tab=ghosts&ghost=' + instanceId);
    // The flag is one-shot: the next plain selection opens the plugin page again.
    openMore();
    fireEvent.click(screen.getByRole('menuitem', { name: /站点/ }));
    expect(screen.getByTestId('location').textContent).toBe('/apps/' + instanceId);
  });
  it('keeps same-name root and enterprise arrivals separate in More', () => {
    const root = { ...SITES, instanceId: '_root__xd-sites', title: 'Root sites' };
    const organization = { ...SITES, instanceId: '_ns__acme__xd-sites', title: 'Enterprise sites' };
    seedKnownPlugins([root.instanceId]);
    mainViewsMock.routeCapable = [root, organization];
    mainViewsMock.sidebarVisible = [root, organization];
    render(<Harness initialPath="/cc-agent" />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'sidebar.navigation.more · sidebar.navigation.new' }), {
      button: 0,
      ctrlKey: false,
    });
    const rootEntry = screen.getByRole('menuitem', { name: /Root sites/ });
    const orgEntry = screen.getByRole('menuitem', { name: /Enterprise sites/ });
    expect(rootEntry.textContent).not.toContain('sidebar.navigation.new');
    expect(orgEntry.textContent).toContain('sidebar.navigation.new');
    fireEvent.click(orgEntry);
    expect(screen.getByTestId('location').textContent).toBe('/apps/' + organization.instanceId);
    expect(JSON.parse(localStorage.getItem('sidebar-navigation:apps:v1')!)[OWNER].known)
      .toEqual([root.instanceId, organization.instanceId]);
  });
  it('lists only unchecked entries and Customize in More', () => {
    render(<Harness initialPath="/cc-agent" />);
    openMore();
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent))
      .toEqual(['sidebar.navigation.customize.title']);
  });
  it('renders nothing in the rail slot other features borrow', () => {
    // Teammates used to lend other features' rails a tile here; the task rail's
    // CollapsedView owns that entry now.
    const view = render(<MainViewHistoryProvider><MemoryRouter initialEntries={['/plugins']}>
      <SidebarTopNav section="rail" />
    </MemoryRouter></MainViewHistoryProvider>);
    expect(view.container.childElementCount).toBe(0);
  });

  it('keeps the previous task when visiting automations before plugins', () => {
    const sessionPath = '/cc-agent/session-1?remoteHostId=host-1#message-2';
    render(<Harness initialPath={sessionPath} />);
    fireEvent.click(screen.getByRole('button', { name: 'ccAgent.layout.automations' }));
    expect(screen.getByRole('button', { name: 'ccAgent.layout.automations' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.tabs.plugins' }));
    expect(screen.getByTestId('location').textContent).toBe('/plugins');
    // Searching outside the task view returns to it, where the results are drawn.
    activateSearch();
    expect(screen.getByTestId('location').textContent).toBe(sessionPath);
    expect(screen.getByRole('button', { name: 'ccAgent.layout.automations' }).hasAttribute('aria-current')).toBe(false);
  });

  it.each(['/cc-agent/scheduled', '/cc-agent/scheduled/?filter=enabled#schedule-1'])(
    'returns to the task index after entering plugins from %s without a previous task',
    (initialPath) => {
      render(<Harness initialPath={initialPath} />);
      fireEvent.click(screen.getByRole('button', { name: 'sidebar.tabs.plugins' }));
      activateSearch();
      expect(screen.getByTestId('location').textContent).toBe('/cc-agent');
      expect(screen.getByRole('button', { name: 'ccAgent.layout.automations' }).hasAttribute('aria-current')).toBe(false);
    },
  );

  it('keeps a teammate chat open when search becomes active on it', () => {
    // Teammates share the task sidebar, so results show in place instead of leaving the chat.
    render(<Harness initialPath="/bots/teammate-2" />);
    activateSearch();
    expect(screen.getByTestId('location').textContent).toBe('/bots/teammate-2');
    fireEvent.click(screen.getByRole('button', { name: 'Open plugins' }));
    activateSearch();
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent');
  });

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
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.tabs.plugins' }));
    activateSearch();
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent');

    const newPath = '/cc-agent/new-owner-session?remoteHostId=new-host#message-3';
    fireEvent.click(screen.getByRole('button', { name: 'Open task' }));
    view.rerender(<PersistentRouter owner="two" />);
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.tabs.plugins' }));
    activateSearch();
    expect(screen.getByTestId('location').textContent).toBe(newPath);
  });

  it('discards remembered destinations when the account scope changes', () => {
    const view = render(<Harness initialPath="/cc-agent/private-session" />);
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.tabs.plugins' }));
    view.rerender(<Harness initialPath="/plugins" owner="two" />);
    activateSearch();
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
      order: ['search', 'plugins', 'automations'],
      visible: ['search', 'plugins', 'automations'],
    });
    renderRail();
    const names = ['Rail search', 'sidebar.tabs.plugins', 'ccAgent.layout.automations'];
    const tiles = names.map((name) => screen.getByRole('button', { name }));
    expect(tiles.every((tile, index) =>
      index === 0 || Boolean(tiles[index - 1].compareDocumentPosition(tile) & Node.DOCUMENT_POSITION_FOLLOWING),
    )).toBe(true);
  });

  it('drops More when nothing is hidden', () => {
    renderRail();
    expect(screen.queryByRole('button', { name: 'sidebar.navigation.more' })).toBeNull();
    act(() => setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'plugins', 'search'],
      visible: ['automations', 'search'],
    }));
    openMore();
    expect(screen.getByRole('menuitem', { name: 'sidebar.tabs.plugins' })).toBeTruthy();
  });

  it('lays out plugin main views in the saved order and keeps hidden ones in More', () => {
    const other: MainViewMock = { ghostId: 'other', instanceId: 'other', title: 'Other', icon: 'globe', manifest: { name: 'Other' } };
    const off: MainViewMock = { ghostId: 'off', instanceId: 'off', title: 'Off', icon: 'globe', manifest: { name: 'Off' } };
    seedKnownPlugins(['xd-sites', 'other']);
    mainViewsMock.routeCapable = [SITES, other, off];
    mainViewsMock.sidebarVisible = [SITES, other];
    setSidebarNavigationPrefs(OWNER, {
      order: ['app:xd-sites', 'automations', 'plugins', 'search', 'app:other', 'app:off'],
      visible: ['automations', 'plugins', 'search'],
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
      order: ['plugins', 'automations', 'search'],
      visible: ['search'],
    });
    renderRail();
    expect(screen.queryByRole('button', { name: 'sidebar.tabs.plugins' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'ccAgent.layout.automations' })).toBeNull();

    openMore();
    expect(screen.queryByRole('menuitem', { name: 'sidebar.navigation.items.search' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'sidebar.navigation.customize.title' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'ccAgent.layout.automations' }));
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent/scheduled');

    openMore();
    fireEvent.click(screen.getByRole('menuitem', { name: 'sidebar.tabs.plugins' }));
    expect(screen.getByTestId('location').textContent).toBe('/plugins');
  });

  it('opens an unchecked Search from More and hides it again once closed', async () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'plugins', 'search'],
      visible: ['automations', 'plugins'],
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
      order: ['automations', 'plugins', 'search'],
      visible: ['automations', 'plugins'],
    });
    renderRail({ forceSearch: true });
    expect(screen.getByRole('button', { name: 'Rail search' }).getAttribute('data-default-open'))
      .toBe('false');
  });
});

describe('Plugins joining the sidebar', () => {
  const NEWCOMER: MainViewMock = { ghostId: 'newcomer', instanceId: 'newcomer', title: 'Newcomer', icon: 'globe', manifest: { name: 'Newcomer' } };
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
      order: ['automations', 'plugins', 'search'],
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
      order: ['automations', 'plugins', 'search'],
      visible: ['automations'],
    });
    const view = renderNav();
    openMore();
    fireEvent.click(screen.getByRole('menuitem', { name: 'sidebar.navigation.customize.title' }));
    // Account A unchecks Plugins in the draft (Search stays checked), then the account
    // switches before Done.
    fireEvent.click(screen.getByRole('checkbox', { name: 'sidebar.navigation.items.plugins' }));
    authMock.owner = 'owner-2';
    view.rerender(
      <MainViewHistoryProvider>
        <MemoryRouter initialEntries={['/cc-agent']}>
          <SidebarTopNav section="all" />
        </MemoryRouter>
      </MainViewHistoryProvider>,
    );
    expect(screen.getByRole('checkbox', { name: 'sidebar.navigation.items.search' }).getAttribute('aria-checked'))
      .toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.done' }));
    expect(getSidebarNavigationPrefs('owner-2').visible).toEqual(['automations']);
    expect(getSidebarNavigationPrefs(OWNER).visible).toEqual(['automations', 'plugins', 'search']);
  });
});
