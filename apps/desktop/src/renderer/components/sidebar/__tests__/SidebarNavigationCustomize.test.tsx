// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SidebarNavigationCustomize } from '../SidebarNavigationCustomize';
import {
  __testing as navigationTesting,
  getSidebarKnownApps,
  mergeAbsentOrderEntries,
  reconcileSidebarAppArrivals,
  getSidebarNavigationPrefs,
  setSidebarNavigationPrefs,
} from '../sidebarNavigationPrefs';

type MainViewMock = { ghostId: string; title: string; icon: 'globe' };
const OWNER = 'owner-1';
const PREFS_KEY = `sidebar-navigation:v2.owner.${OWNER}`;
const mainViewsMock = vi.hoisted(() => ({
  routeCapable: [] as MainViewMock[],
  sidebarVisible: [] as MainViewMock[],
}));
const visibilityMock = vi.hoisted(() => ({
  write: vi.fn<(owner: unknown, ghostId: string, visible: boolean) => Promise<boolean>>(
    async () => true,
  ),
}));
const SITES: MainViewMock = { ghostId: 'xd-sites', title: '站点', icon: 'globe' };

vi.mock('@/cindy-brain/ghostMainViews', () => ({
  useGhostMainViews: () => ({
    declared: mainViewsMock.routeCapable,
    routeCapable: mainViewsMock.routeCapable,
    sidebarVisible: mainViewsMock.sidebarVisible,
  }),
}));
vi.mock('@/cindy-brain/mainViewVisibilityStore', () => ({
  currentMainViewVisibilityOwner: () => ({ dataOwnerId: 'owner', generation: 1 }),
  writeMainViewSidebarVisible: visibilityMock.write,
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: 'owner-1' }) }));
vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => false }));
// SortableJS needs real pointer geometry; jsdom cannot drive it. Capture the list
// props so tests can assert the drag contract and replay a finished drag.
const sortableMock = vi.hoisted(() => ({
  props: null as null | { onReorder: (ids: string[]) => void; filter?: string },
}));
vi.mock('../SortableList', () => ({
  SortableList: (props: {
    items: readonly string[];
    renderItem: (item: string, index: number) => React.ReactNode;
    onReorder: (ids: string[]) => void;
    filter?: string;
  }) => {
    sortableMock.props = props;
    return (
      <div>
        {props.items.map((item, index) => (
          <div key={item}>{props.renderItem(item, index)}</div>
        ))}
      </div>
    );
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: { name?: string }) => (vars?.name ? `${key}: ${vars.name}` : key),
  }),
}));

const defaults = () => ({
  order: ['automations', 'plugins', 'bots', 'search'] as const,
  visible: ['automations', 'plugins', 'bots', 'search'] as const,
});

beforeEach(() => {
  localStorage.clear();
  navigationTesting.resetArrivals();
  navigationTesting.resetPrefsCache();
  mainViewsMock.routeCapable = [];
  mainViewsMock.sidebarVisible = [];
  visibilityMock.write.mockClear();
  setSidebarNavigationPrefs(OWNER, {
    order: [...defaults().order],
    visible: [...defaults().visible],
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function order(): string[] {
  return screen.getAllByRole('checkbox').map((element) => element.getAttribute('aria-label') ?? '');
}

describe('sidebar navigation customization', () => {
  it('applies a finished drag and saves only explicit overrides', () => {
    render(<SidebarNavigationCustomize onDone={() => {}} />);
    // Rows drag from anywhere except the checkbox, which stays a plain toggle.
    expect(sortableMock.props?.filter).toBe("[role='checkbox']");
    act(() => sortableMock.props!.onReorder(['plugins', 'bots', 'search', 'automations']));
    expect(order()).toEqual([
      'sidebar.navigation.items.plugins',
      'sidebar.navigation.items.bots',
      'sidebar.navigation.items.search',
      'sidebar.navigation.items.automations',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.done' }));
    expect(getSidebarNavigationPrefs(OWNER).order).toEqual([
      'plugins',
      'bots',
      'search',
      'automations',
    ]);
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual({
      order: ['plugins', 'bots', 'search', 'automations'],
    });
  });

  it('reorders with arrow keys and preserves untouched external changes', () => {
    render(<SidebarNavigationCustomize onDone={() => {}} />);
    const grip = screen.getByRole('button', {
      name: 'sidebar.navigation.customize.reorder: sidebar.navigation.items.plugins',
    });
    fireEvent.keyDown(grip, { key: 'ArrowUp' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'sidebar.navigation.items.search' }));
    act(() =>
      setSidebarNavigationPrefs(OWNER, {
        order: [...defaults().order],
        visible: ['automations', 'plugins', 'search'],
      }),
    );
    expect(order()[0]).toBe('sidebar.navigation.items.plugins');
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.done' }));
    expect(getSidebarNavigationPrefs(OWNER)).toEqual({
      order: ['plugins', 'automations', 'bots', 'search'],
      visible: ['automations', 'plugins'],
      appsAtTop: [],
    });
  });

  it('keeps the saved state in memory if storage fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    setSidebarNavigationPrefs(OWNER, {
      order: [...defaults().order],
      visible: ['automations', 'plugins', 'bots'],
    });
    expect(getSidebarNavigationPrefs(OWNER).visible).not.toContain('search');
  });

  it('clears overrides when resetting to the product defaults', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['bots', 'search', 'plugins', 'automations'],
      visible: ['search'],
    });
    render(<SidebarNavigationCustomize onDone={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.reset' }));
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.done' }));
    expect(getSidebarNavigationPrefs(OWNER)).toEqual({
      order: [...defaults().order],
      visible: [...defaults().visible],
      appsAtTop: [],
    });
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual({});
  });

  it('drops the retired Issue entry from saved v2 preferences', () => {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        order: ['plugins', 'issues', 'automations', 'bots'],
        visibility: { issues: true, plugins: false },
      }),
    );
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: PREFS_KEY })));
    expect(getSidebarNavigationPrefs(OWNER)).toEqual({
      order: ['plugins', 'automations', 'bots', 'search'],
      visible: ['automations', 'bots', 'search'],
      appsAtTop: [],
    });
    render(<SidebarNavigationCustomize onDone={() => {}} />);
    expect(order()).not.toContain('sidebar.navigation.items.issues');
  });

  it('keeps edits made after choosing reset', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['bots', 'automations', 'plugins', 'search'],
      visible: ['bots'],
    });
    render(<SidebarNavigationCustomize onDone={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.reset' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'sidebar.navigation.items.search' }));
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.done' }));
    expect(getSidebarNavigationPrefs(OWNER)).toEqual({
      order: [...defaults().order],
      visible: ['automations', 'plugins', 'bots'],
      appsAtTop: [],
    });
  });
  it('lists sidebar plugins and saves unchecking as a move into More', () => {
    mainViewsMock.routeCapable = [SITES];
    mainViewsMock.sidebarVisible = [SITES];
    setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'plugins', 'bots', 'search'],
      visible: ['automations', 'plugins', 'bots', 'search'],
      appsAtTop: ['app:xd-sites'],
    });
    render(<SidebarNavigationCustomize onDone={() => {}} />);
    expect(order()).toEqual([
      'sidebar.navigation.items.automations',
      'sidebar.navigation.items.plugins',
      'sidebar.navigation.items.bots',
      'sidebar.navigation.items.search',
      '站点',
    ]);
    const sites = screen.getByRole('checkbox', { name: '站点' });
    expect(sites.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sites);
    expect(sites.getAttribute('aria-checked')).toBe('false');
    fireEvent.keyDown(
      screen.getByRole('button', { name: 'sidebar.navigation.customize.reorder: 站点' }),
      { key: 'ArrowUp' },
    );
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.done' }));
    // Unchecking only moves the plugin into More; its own sidebar switch is untouched.
    expect(visibilityMock.write).not.toHaveBeenCalled();
    expect(getSidebarNavigationPrefs(OWNER).appsAtTop).toEqual([]);
    expect(getSidebarNavigationPrefs(OWNER).order).toEqual([
      'automations',
      'plugins',
      'bots',
      'app:xd-sites',
      'search',
    ]);
  });

  it('shows a sidebar plugin without a placement unchecked, as it sits in More', () => {
    mainViewsMock.routeCapable = [SITES];
    mainViewsMock.sidebarVisible = [SITES];
    render(<SidebarNavigationCustomize onDone={() => {}} />);
    expect(screen.getByRole('checkbox', { name: '站点' }).getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  it('leaves out plugins switched off in their own settings and keeps their saved place', () => {
    mainViewsMock.routeCapable = [SITES];
    setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'plugins', 'bots', 'search'],
      visible: ['automations', 'plugins', 'bots', 'search'],
      appsAtTop: ['app:xd-sites'],
    });
    render(<SidebarNavigationCustomize onDone={() => {}} />);
    expect(screen.queryByRole('checkbox', { name: '站点' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'sidebar.navigation.items.bots' }));
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.done' }));
    expect(getSidebarNavigationPrefs(OWNER).appsAtTop).toEqual(['app:xd-sites']);
  });

  it('drops every plugin placement on reset, including ones switched off for now', () => {
    const off = { ghostId: 'off', title: 'Off', icon: 'globe' as const };
    mainViewsMock.routeCapable = [SITES, off];
    mainViewsMock.sidebarVisible = [SITES];
    setSidebarNavigationPrefs(OWNER, {
      order: ['app:xd-sites', 'automations', 'plugins', 'bots', 'search'],
      visible: ['automations', 'plugins'],
      appsAtTop: ['app:xd-sites', 'app:off'],
    });
    render(<SidebarNavigationCustomize onDone={() => {}} />);
    expect(screen.getByRole('checkbox', { name: '站点' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.reset' }));
    expect(screen.getByRole('checkbox', { name: '站点' }).getAttribute('aria-checked')).toBe(
      'false',
    );
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.done' }));
    expect(getSidebarNavigationPrefs(OWNER)).toEqual({
      order: ['automations', 'plugins', 'bots', 'search'],
      visible: ['automations', 'plugins', 'bots', 'search'],
      appsAtTop: [],
    });
    // No overrides remain, so later product defaults keep applying.
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual({});
  });

  it('keeps a plugin re-checked after reset at the top level', () => {
    mainViewsMock.routeCapable = [SITES];
    mainViewsMock.sidebarVisible = [SITES];
    render(<SidebarNavigationCustomize onDone={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.reset' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '站点' }));
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.done' }));
    expect(getSidebarNavigationPrefs(OWNER).appsAtTop).toEqual(['app:xd-sites']);
  });

  it('toggles from anywhere in the row except the drag handle', () => {
    render(<SidebarNavigationCustomize onDone={() => {}} />);
    const bots = screen.getByRole('checkbox', { name: 'sidebar.navigation.items.bots' });
    expect(bots.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByText('sidebar.navigation.items.bots'));
    expect(bots.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(bots.parentElement!);
    expect(bots.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(bots);
    expect(bots.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(
      screen.getByRole('button', {
        name: 'sidebar.navigation.customize.reorder: sidebar.navigation.items.bots',
      }),
    );
    expect(bots.getAttribute('aria-checked')).toBe('false');
  });
  it('shows each entry with the icon it uses in the sidebar', () => {
    mainViewsMock.routeCapable = [SITES];
    mainViewsMock.sidebarVisible = [SITES];
    render(<SidebarNavigationCustomize onDone={() => {}} />);
    const rowOf = (name: string) => screen.getByRole('checkbox', { name }).parentElement!;
    expect(
      rowOf('sidebar.navigation.items.automations').querySelector('.lucide-timer'),
    ).not.toBeNull();
    expect(rowOf('sidebar.navigation.items.plugins').querySelector('.lucide-plug')).not.toBeNull();
    expect(rowOf('sidebar.navigation.items.bots').querySelector('.lucide-bot')).not.toBeNull();
    expect(rowOf('sidebar.navigation.items.search').querySelector('.lucide-search')).not.toBeNull();
    expect(rowOf('站点').querySelector('.lucide-globe')).not.toBeNull();
  });
  it('keeps a separate layout for each account', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['search', 'automations', 'plugins', 'bots'],
      visible: ['search'],
    });
    expect(getSidebarNavigationPrefs('owner-2')).toEqual({
      order: [...defaults().order],
      visible: [...defaults().visible],
      appsAtTop: [],
    });
    expect(localStorage.getItem('sidebar-navigation:v2.owner.owner-2')).toBeNull();
    // A fresh window reads each account's layout back from its own key.
    navigationTesting.resetPrefsCache();
    expect(getSidebarNavigationPrefs(OWNER).visible).toEqual(['search']);
    // Without an account the defaults apply and nothing is written.
    setSidebarNavigationPrefs(null, { order: [...defaults().order], visible: [] });
    expect(getSidebarNavigationPrefs(null).visible).toEqual([...defaults().visible]);
  });
  it('keeps a switched-off plugin at its place when other entries are reordered', () => {
    mainViewsMock.routeCapable = [SITES];
    setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'app:xd-sites', 'plugins', 'bots', 'search'],
      visible: ['automations', 'plugins', 'bots', 'search'],
    });
    render(<SidebarNavigationCustomize onDone={() => {}} />);
    expect(order()).not.toContain('站点');
    act(() => sortableMock.props!.onReorder(['plugins', 'automations', 'bots', 'search']));
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.done' }));
    expect(getSidebarNavigationPrefs(OWNER).order).toEqual([
      'plugins',
      'automations',
      'app:xd-sites',
      'bots',
      'search',
    ]);
  });

  it('keeps a plugin switched off in another window at its place on save', () => {
    mainViewsMock.routeCapable = [SITES];
    mainViewsMock.sidebarVisible = [SITES];
    setSidebarNavigationPrefs(OWNER, {
      order: ['app:xd-sites', 'automations', 'plugins', 'bots', 'search'],
      visible: ['automations', 'plugins', 'bots', 'search'],
    });
    const view = render(<SidebarNavigationCustomize onDone={() => {}} />);
    mainViewsMock.sidebarVisible = [];
    view.rerender(<SidebarNavigationCustomize onDone={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'sidebar.navigation.items.bots' }));
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.done' }));
    expect(getSidebarNavigationPrefs(OWNER).order).toEqual([
      'app:xd-sites',
      'automations',
      'plugins',
      'bots',
      'search',
    ]);
  });

  it('keeps a reorder made after choosing reset', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['search', 'bots', 'plugins', 'automations'],
      visible: ['search'],
    });
    render(<SidebarNavigationCustomize onDone={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.reset' }));
    act(() => sortableMock.props!.onReorder(['bots', 'automations', 'plugins', 'search']));
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.done' }));
    expect(getSidebarNavigationPrefs(OWNER).order).toEqual([
      'bots',
      'automations',
      'plugins',
      'search',
    ]);
  });

  it('places entries missing from an edited order after their previous neighbour', () => {
    expect(
      mergeAbsentOrderEntries(
        ['plugins', 'automations', 'search'],
        ['app:first', 'automations', 'app:mid', 'plugins', 'search', 'app:last'],
      ),
    ).toEqual(['app:first', 'plugins', 'automations', 'app:mid', 'search', 'app:last']);
  });

  it('records nothing until the installed roster is known', () => {
    reconcileSidebarAppArrivals(OWNER, [], false);
    expect(localStorage.getItem('sidebar-navigation:apps:v1')).toBeNull();
    // The real roster arriving afterwards is the first run: existing plugins stay at the top.
    reconcileSidebarAppArrivals(OWNER, ['xd-sites'], true);
    expect(getSidebarKnownApps(OWNER)).toEqual(['xd-sites']);
    expect(getSidebarNavigationPrefs(OWNER).appsAtTop).toEqual(['app:xd-sites']);
  });

  it('starts the first sidebar plugin in More after an empty but known baseline', () => {
    reconcileSidebarAppArrivals(OWNER, [], true);
    expect(getSidebarKnownApps(OWNER)).toEqual([]);
    reconcileSidebarAppArrivals(OWNER, ['xd-sites'], true);
    // No placement is written: plugins default to More.
    expect(getSidebarNavigationPrefs(OWNER).appsAtTop).toEqual([]);
    expect(getSidebarKnownApps(OWNER)).toEqual(['xd-sites']);
  });

  it('retries the first run when the top-level placement of existing plugins cannot be stored', () => {
    const originalSetItem = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key.startsWith('sidebar-navigation:v2.owner.')) throw new Error('refused');
      originalSetItem.call(this, key, value);
    });
    reconcileSidebarAppArrivals(OWNER, ['xd-sites'], true);
    expect(localStorage.getItem('sidebar-navigation:apps:v1')).toBeNull();
    setItem.mockRestore();
    // Once storage accepts the placement, the same first run is recorded.
    reconcileSidebarAppArrivals(OWNER, ['xd-sites'], true);
    expect(getSidebarKnownApps(OWNER)).toEqual(['xd-sites']);
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).visibility).toEqual({
      'app:xd-sites': true,
    });
  });
});
