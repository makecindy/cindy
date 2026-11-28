// @vitest-environment jsdom

import { transferableAbortController } from 'node:util';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginNavigationDirectorySource } from '@/cindy-brain/pluginViewDirectorySource';
import type { PluginViewDirectorySource } from '../../../../shared/pluginViewDirectoryContext';
import { MainViewHistoryProvider } from '@/contexts/MainViewHistoryContext';
import { SidebarRailNavigation, SidebarTopNav, type SidebarRailSearchOptions } from '../SidebarTopNav';
import {
  __testing as navigationTesting,
  getSidebarNavigationPrefs,
  setSidebarNavigationPrefs,
} from '../sidebarNavigationPrefs';

const OWNER = 'owner-1';
const searchMock = vi.hoisted(() => ({ query: '', lockedProjectKey: null as string | null }));
type MainViewMock = {
  ghostId: string; instanceId: string; title: string; icon: 'globe'; manifest: { name: string };
  installedGhost?: {
    enabled: boolean; approval: { state: 'approved'; revision: string };
    manifest: { viewDirectoryContext: true }; viewDirectoryContextApproved: true;
  };
};
const mainViewsMock = vi.hoisted(() => ({
  routeCapable: [] as MainViewMock[],
  sidebarVisible: [] as MainViewMock[],
}));
const authMock = vi.hoisted(() => ({ owner: 'owner-1' as string | null }));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ toast: { error: toastError } }));
const preloadPluginPage = vi.hoisted(() => vi.fn());
vi.mock('@/features/plugin/GhostPluginRoute', () => ({ preloadPluginPage }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: authMock.owner }) }));
// A non-empty installed roster marks the plugin list as loaded (Main sends none mid-switch).
const installedMock = vi.hoisted(() => ({ ghosts: [{ manifest: { id: 'bundled' } }] as unknown[] }));
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({ useInstalledGhosts: () => installedMock.ghosts,
  readInstalledGhostsSnapshot: () => installedMock.ghosts }));
const SITES: MainViewMock = {
  ghostId: 'xd-sites', instanceId: 'xd-sites', title: '站点', icon: 'globe', manifest: { name: 'XD Sites' },
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: { name?: string }) => (vars?.name ? `${key}: ${vars.name}` : key),
  }),
}));
const unreadMock = vi.hoisted(() => ({ ordinary: false }));
const reviewMock = vi.hoisted(() => ({ updates: [] as Array<{ unread: boolean; status: string }> }));
vi.mock('@/contexts/PluginReviewUpdatesContext', () => ({ usePluginReviewUpdates: () => reviewMock }));
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

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** Pretend the owner's first run already happened, so plugins keep their default (More). */
function seedKnownPlugins(ids: string[]) {
  localStorage.setItem('sidebar-navigation:apps:v1', JSON.stringify({ [OWNER]: { known: ids, unseen: [] } }));
  navigationTesting.resetArrivals();
}
const NativeAbortController = transferableAbortController().constructor;
beforeEach(() => {
  // React Router pairs the native Request with this realm's AbortSignal.
  vi.stubGlobal('AbortController', NativeAbortController);
  toastError.mockClear();
  preloadPluginPage.mockClear();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  searchMock.query = '';
  searchMock.lockedProjectKey = null;
  mainViewsMock.routeCapable = [];
  mainViewsMock.sidebarVisible = [];
  authMock.owner = 'owner-1';
  installedMock.ghosts = [{ manifest: { id: 'bundled' } }];
  unreadMock.ordinary = false;
  reviewMock.updates = [];
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

const RouteFixtureContext = createContext<ReactNode>(null);

function RouteFixture() {
  return useContext(RouteFixtureContext);
}

function SidebarTestRouter({ initialEntries, children }: { initialEntries: string[]; children: ReactNode }) {
  const [router] = useState(() => createMemoryRouter(
    [{ path: '*', element: <RouteFixture /> }],
    { initialEntries },
  ));
  return (
    <RouteFixtureContext.Provider value={children}>
      <RouterProvider router={router} />
    </RouteFixtureContext.Provider>
  );
}

function Harness({ initialPath, owner = 'one' }: { initialPath: string; owner?: string }) {
  return (
    <MainViewHistoryProvider key={owner}>
      <SidebarTestRouter initialEntries={[initialPath]}>
        <NavigationHarness />
      </SidebarTestRouter>
    </MainViewHistoryProvider>
  );
}

it('requests an early plugin load only on intent at the sidebar entry', () => {
  render(<Harness initialPath="/cc-agent/session-1" />);
  const plugins = screen.getByRole('button', { name: 'sidebar.tabs.plugins' });
  expect(preloadPluginPage).not.toHaveBeenCalled();
  fireEvent.focus(screen.getByRole('button', { name: 'ccAgent.layout.automations' }));
  expect(preloadPluginPage).not.toHaveBeenCalled();
  fireEvent.mouseEnter(plugins);
  expect(preloadPluginPage).toHaveBeenCalledTimes(1);
  fireEvent.focus(plugins);
  expect(preloadPluginPage).toHaveBeenCalledTimes(2);
});

// Unit / 工程约定 §7: a pending plugin route should highlight the real
// sidebar row while keeping the mounted task. Immediate MemoryRouter routes
// cannot reproduce the pending module that used to leave the row unselected.
it('selects Plugins while keeping the task visible until the plugin module is ready', async () => {
  const module = Promise.withResolvers<{ Component: () => React.JSX.Element }>();
  const router = createMemoryRouter([{
    element: <><SidebarTopNav /><Outlet /></>,
    children: [
      { path: '/cc-agent/session-1', element: <main>Current task</main> },
      { path: '/plugins', lazy: () => module.promise },
    ],
  }], { initialEntries: ['/cc-agent/session-1'] });
  render(<MainViewHistoryProvider><RouterProvider router={router} /></MainViewHistoryProvider>);
  const plugins = screen.getByRole('button', { name: 'sidebar.tabs.plugins' });
  const task = screen.getByRole('main');
  expect(plugins.getAttribute('aria-current')).toBeNull();

  await act(async () => { fireEvent.click(plugins); });
  expect(plugins.getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('main')).toBe(task);
  expect(screen.queryByRole('status')).toBeNull();

  await act(async () => { module.resolve({ Component: () => <main>Installed plugins</main> }); });
  expect(screen.getByRole('main').textContent).toBe('Installed plugins');
  expect(plugins.getAttribute('aria-current')).toBe('page');
  expect(screen.queryByRole('status')).toBeNull();
});

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
          <SidebarTestRouter initialEntries={['/cc-agent/session-1']}>
            {placement.startsWith('rail')
              ? <SidebarRailNavigation renderSearch={() => null} />
              : <SidebarTopNav />}
          </SidebarTestRouter>
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
    const view = render(<MainViewHistoryProvider><SidebarTestRouter initialEntries={['/plugins']}>
      <SidebarTopNav section="rail" />
    </SidebarTestRouter></MainViewHistoryProvider>);
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
      return <SidebarTestRouter initialEntries={[oldPath]}><OwnerRouter owner={owner} /></SidebarTestRouter>;
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
        <output data-testid="location" data-directory={JSON.stringify(location.state?.directorySource)}>{location.pathname}</output>
      </>
    );
  }
  const renderRail = (props: { forceSearch?: boolean } = {}, directorySource: PluginViewDirectorySource | null = null) => render(
    <PluginNavigationDirectorySource.Provider value={directorySource}>
      <MainViewHistoryProvider>
        <SidebarTestRouter initialEntries={['/cc-agent/session-1']}>
          <RailHarness {...props} />
        </SidebarTestRouter>
      </MainViewHistoryProvider>
    </PluginNavigationDirectorySource.Provider>,
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
    const other: MainViewMock = {
      ghostId: 'other', instanceId: 'other', title: 'Other', icon: 'globe', manifest: { name: 'Other' },
      installedGhost: { enabled: true, approval: { state: 'approved', revision: 'receipt' },
        manifest: { viewDirectoryContext: true }, viewDirectoryContextApproved: true },
    };
    const off: MainViewMock = { ghostId: 'off', instanceId: 'off', title: 'Off', icon: 'globe', manifest: { name: 'Off' } };
    seedKnownPlugins(['xd-sites', 'other']);
    mainViewsMock.routeCapable = [SITES, other, off];
    mainViewsMock.sidebarVisible = [SITES, other];
    setSidebarNavigationPrefs(OWNER, {
      order: ['app:xd-sites', 'automations', 'plugins', 'search', 'app:other', 'app:off'],
      visible: ['automations', 'plugins', 'search'],
      appsAtTop: ['app:xd-sites'],
    });
    const directorySource = { kind: 'task', sessionId: 'session-1' } as const;
    renderRail({}, directorySource);
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
    // Unit, #13556: the former More-only navigation reached the right route
    // but dropped the approved task context even though the regular row sent it.
    expect(screen.getByTestId('location').getAttribute('data-directory')).toBe(JSON.stringify(directorySource));
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
      <SidebarTestRouter initialEntries={['/cc-agent']}>
        <SidebarTopNav section="all" />
      </SidebarTestRouter>
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
        <SidebarTestRouter initialEntries={['/cc-agent']}>
          <SidebarTopNav section="all" />
        </SidebarTestRouter>
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
        <SidebarTestRouter initialEntries={['/cc-agent']}>
          <SidebarTopNav section="all" />
        </SidebarTestRouter>
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
        <SidebarTestRouter initialEntries={['/cc-agent']}>
          <SidebarRailNavigation renderSearch={() => null} />
        </SidebarTestRouter>
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
        <SidebarTestRouter initialEntries={['/cc-agent']}>
          <SidebarTopNav section="all" />
        </SidebarTestRouter>
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
        <SidebarTestRouter initialEntries={['/cc-agent']}>
          <SidebarTopNav section="all" />
        </SidebarTestRouter>
      </MainViewHistoryProvider>,
    );
    expect((screen.getByRole('checkbox', { name: 'sidebar.navigation.items.search' }) as HTMLInputElement).checked)
      .toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.done' }));
    expect(getSidebarNavigationPrefs('owner-2').visible).toEqual(['automations']);
    expect(getSidebarNavigationPrefs(OWNER).visible).toEqual(['automations', 'plugins', 'search']);
  });
});

// Sidebar/rail must show the same result semantics as the author's detail, using
// existing AttentionDot tokens. Previously only rejection selected error (unit).
it.each(['disabled', 'archived', 'revoked', 'enabled', 'approved'])('uses the result tone for an unread %s event', status => {
  reviewMock.updates = [{ status, unread: true }];
  render(<Harness initialPath="/cc-agent/session-1" />);
  const entry = screen.getByRole('button', { name: 'sidebar.tabs.plugins' });
  const tone = status === 'enabled' || status === 'approved' ? 'done' : 'error';
  expect([...entry.querySelectorAll('span')].some(span => span.className.includes(`--card-status-${tone}`))).toBe(true);
});

// 测试价值:
// - 生产入口与可观察结果: SidebarTopNav 左侧导航「新建」按钮；验证 macOS Command+点击、Windows Ctrl+点击、
//   右键 / 键盘菜单「在新窗口打开」执行行为与平台对应快捷键提示（复用 sidebarNewWindowActivation 的
//   openInNewWindowShortcutMac / openInNewWindowShortcutOther，且快捷键标为 aria-hidden 不污染菜单项可访问名称），
//   普通点击仍原地跳转。
// - Bug／规则依据: 左侧导航新建按钮需支持按住 Command 点击在新窗口打开、右键菜单在新窗口打开并与侧栏任务右键菜单
//   共用同一套右侧快捷键提示逻辑；跨平台遵循工程约定 §4，菜单样式遵循 DESIGN.md §4 Select & Dropdown。
// - 现有覆盖缺口: 此前未覆盖「新建」按钮右键菜单右侧快捷键提示在 macOS / Windows / Linux 下的展示与无障碍隔离。
// - 最小失败输入: 在 macOS / Windows / Linux 下右键点击「新建」按钮，检查「在新窗口打开」菜单项内的快捷键提示文本与 aria-hidden。
// - tier: unit（jsdom）。
describe('left navigation New button open-in-new-window', () => {
  const stubDesktopApi = (
    platform: 'darwin' | 'win32' | 'linux',
    openSessionInNewWindow = vi.fn(async () => undefined),
  ) => {
    vi.stubGlobal('electronAPI', {
      platform,
      maker: { openSessionInNewWindow },
    });
    return openSessionInNewWindow;
  };

  it('opens a new window on Command+Click on macOS while keeping plain click and Ctrl+Click in-window', async () => {
    const openSessionInNewWindow = stubDesktopApi('darwin');
    render(<Harness initialPath="/cc-agent/session-1" />);
    const newButton = screen.getByRole('button', { name: 'ccAgent.layout.new' });

    fireEvent.click(newButton, { metaKey: true });
    await waitFor(() => expect(openSessionInNewWindow).toHaveBeenCalledWith('/cc-agent/new', undefined));
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent/session-1');

    // Ctrl+Click on macOS must not hijack the native context-menu modifier as a new-window click.
    openSessionInNewWindow.mockClear();
    fireEvent.click(newButton, { ctrlKey: true });
    expect(openSessionInNewWindow).not.toHaveBeenCalled();
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent/new');
  });

  it('opens a new window on Ctrl+Click on Windows while keeping Meta+Click in-window', async () => {
    const openSessionInNewWindow = stubDesktopApi('win32');
    render(<Harness initialPath="/cc-agent/session-1" />);
    const newButton = screen.getByRole('button', { name: 'ccAgent.layout.new' });

    fireEvent.click(newButton, { ctrlKey: true });
    await waitFor(() => expect(openSessionInNewWindow).toHaveBeenCalledWith('/cc-agent/new', undefined));
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent/session-1');

    openSessionInNewWindow.mockClear();
    fireEvent.click(newButton, { metaKey: true });
    expect(openSessionInNewWindow).not.toHaveBeenCalled();
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent/new');
  });

  it('opens a new window from the right-click and keyboard context menu and reports failures', async () => {
    const openSessionInNewWindow = stubDesktopApi('darwin');
    render(<Harness initialPath="/cc-agent/session-1" />);
    const newButton = screen.getByRole('button', { name: 'ccAgent.layout.new' });

    fireEvent.contextMenu(newButton, { clientX: 48, clientY: 88 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'ccAgent.sidebar.sessionMenu.openInNewWindow' }));
    await waitFor(() => expect(openSessionInNewWindow).toHaveBeenCalledWith('/cc-agent/new', undefined));
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent/session-1');

    openSessionInNewWindow.mockRejectedValueOnce(new Error('window failed'));
    fireEvent.keyDown(newButton, { key: 'F10', shiftKey: true });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'ccAgent.sidebar.sessionMenu.openInNewWindow' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('ccAgent.common.openFailed'));
  });

  it.each([
    ['darwin', 'ccAgent.sidebar.sessionMenu.openInNewWindowShortcutMac'],
    ['win32', 'ccAgent.sidebar.sessionMenu.openInNewWindowShortcutOther'],
    ['linux', 'ccAgent.sidebar.sessionMenu.openInNewWindowShortcutOther'],
  ] as const)(
    'displays the %s modifier-click shortcut hint beside Open in new window',
    async (platform, expectedShortcutKey) => {
      stubDesktopApi(platform);
      render(<Harness initialPath="/cc-agent/session-1" />);
      const newButton = screen.getByRole('button', { name: 'ccAgent.layout.new' });

      fireEvent.contextMenu(newButton, { clientX: 48, clientY: 88 });
      const menuItem = await screen.findByRole('menuitem', {
        name: 'ccAgent.sidebar.sessionMenu.openInNewWindow',
      });
      const shortcut = within(menuItem).getByText(expectedShortcutKey);
      expect(shortcut.getAttribute('aria-hidden')).toBe('true');
    },
  );
});
