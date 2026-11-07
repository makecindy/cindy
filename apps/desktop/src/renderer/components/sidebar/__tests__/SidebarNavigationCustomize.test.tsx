// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PermissionPrompt } from '@/components/new-chat/PermissionPrompt';

import { SidebarNavigationCustomize } from '../SidebarNavigationCustomize';
import {
  __testing as navigationTesting,
  getSidebarKnownApps,
  mergeAbsentOrderEntries,
  reconcileSidebarAppArrivals,
  getSidebarNavigationPrefs,
  setSidebarNavigationPrefs,
} from '../sidebarNavigationPrefs';

type MainViewMock = { ghostId: string; instanceId: string; title: string; icon: 'globe' };
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
const SITES: MainViewMock = { ghostId: 'xd-sites', instanceId: 'xd-sites', title: '站点', icon: 'globe' };

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
  order: ['automations', 'plugins', 'search'] as const,
  visible: ['automations', 'plugins', 'search'] as const,
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
    act(() => sortableMock.props!.onReorder(['plugins', 'search', 'automations']));
    expect(order()).toEqual([
      'sidebar.navigation.items.plugins',
      'sidebar.navigation.items.search',
      'sidebar.navigation.items.automations',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.done' }));
    expect(getSidebarNavigationPrefs(OWNER).order).toEqual([
      'plugins',
      'search',
      'automations',
    ]);
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual({
      order: ['plugins', 'search', 'automations'],
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
        visible: ['plugins', 'search'],
      }),
    );
    expect(order()[0]).toBe('sidebar.navigation.items.plugins');
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.done' }));
    expect(getSidebarNavigationPrefs(OWNER)).toEqual({
      order: ['plugins', 'automations', 'search'],
      visible: ['plugins'],
      appsAtTop: [],
    });
  });

  it('keeps the saved state in memory if storage fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    setSidebarNavigationPrefs(OWNER, {
      order: [...defaults().order],
      visible: ['automations', 'plugins'],
    });
    expect(getSidebarNavigationPrefs(OWNER).visible).not.toContain('search');
  });

  it('clears overrides when resetting to the product defaults', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['search', 'plugins', 'automations'],
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

  it('drops the retired Issue and Teammates entries from saved v2 preferences', () => {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        order: ['plugins', 'issues', 'bots', 'automations'],
        visibility: { issues: true, bots: false, plugins: false },
      }),
    );
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: PREFS_KEY })));
    expect(getSidebarNavigationPrefs(OWNER)).toEqual({
      order: ['plugins', 'automations', 'search'],
      visible: ['automations', 'search'],
      appsAtTop: [],
    });
    render(<SidebarNavigationCustomize onDone={() => {}} />);
    expect(order()).not.toContain('sidebar.navigation.items.issues');
    expect(order()).not.toContain('sidebar.navigation.items.bots');
  });

  it('keeps edits made after choosing reset', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['plugins', 'automations', 'search'],
      visible: ['plugins'],
    });
    render(<SidebarNavigationCustomize onDone={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.reset' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'sidebar.navigation.items.search' }));
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.done' }));
    expect(getSidebarNavigationPrefs(OWNER)).toEqual({
      order: [...defaults().order],
      visible: ['automations', 'plugins'],
      appsAtTop: [],
    });
  });
  it('lists sidebar plugins and saves unchecking as a move into More', () => {
    mainViewsMock.routeCapable = [SITES];
    mainViewsMock.sidebarVisible = [SITES];
    setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'plugins', 'search'],
      visible: ['automations', 'plugins', 'search'],
      appsAtTop: ['app:xd-sites'],
    });
    render(<SidebarNavigationCustomize onDone={() => {}} />);
    expect(order()).toEqual([
      'sidebar.navigation.items.automations',
      'sidebar.navigation.items.plugins',
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
  it.each([
    { label: 'short', namespace: 'acme' },
    { label: 'maximum-length', namespace: 'a'.repeat(128) },
  ])('saves independent placement and order for same-name root and enterprise instances with $label namespace', ({ namespace }) => {
    const root = { ...SITES, instanceId: '_root__xd-sites', title: 'Root sites' };
    const organization = { ...SITES, instanceId: '_ns__' + namespace + '__xd-sites', title: 'Enterprise sites' };
    const organizationEntryId = `app:${organization.instanceId}` as const;
    mainViewsMock.routeCapable = [root, organization];
    mainViewsMock.sidebarVisible = [root, organization];
    const savedOrder = ['app:_root__xd-sites', organizationEntryId, ...defaults().order] as const;
    setSidebarNavigationPrefs(OWNER, { order: [...savedOrder], visible: [...defaults().visible],
      appsAtTop: ['app:_root__xd-sites'] });
    render(<SidebarNavigationCustomize onDone={() => {}} />);
    expect(screen.getByRole('checkbox', { name: 'Root sites' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('checkbox', { name: 'Enterprise sites' }).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Root sites' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enterprise sites' }));
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.done' }));
    navigationTesting.resetPrefsCache();
    expect(getSidebarNavigationPrefs(OWNER)).toEqual({ order: [...savedOrder],
      visible: [...defaults().visible], appsAtTop: [organizationEntryId] });
  });

  it('leaves out plugins switched off in their own settings and keeps their saved place', () => {
    mainViewsMock.routeCapable = [SITES];
    setSidebarNavigationPrefs(OWNER, {
      order: ['automations', 'plugins', 'search'],
      visible: ['automations', 'plugins', 'search'],
      appsAtTop: ['app:xd-sites'],
    });
    render(<SidebarNavigationCustomize onDone={() => {}} />);
    expect(screen.queryByRole('checkbox', { name: '站点' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'sidebar.navigation.items.search' }));
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.done' }));
    expect(getSidebarNavigationPrefs(OWNER).appsAtTop).toEqual(['app:xd-sites']);
  });

  it('drops every plugin placement on reset, including ones switched off for now', () => {
    const off = { ghostId: 'off', instanceId: 'off', title: 'Off', icon: 'globe' as const };
    mainViewsMock.routeCapable = [SITES, off];
    mainViewsMock.sidebarVisible = [SITES];
    setSidebarNavigationPrefs(OWNER, {
      order: ['app:xd-sites', 'automations', 'plugins', 'search'],
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
      order: ['automations', 'plugins', 'search'],
      visible: ['automations', 'plugins', 'search'],
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

  it('discards the draft and closes on an unclaimed Esc', () => {
    const onDone = vi.fn();
    render(<SidebarNavigationCustomize onDone={onDone} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'sidebar.navigation.items.search' }));
    act(() => sortableMock.props!.onReorder(['plugins', 'search', 'automations']));
    const before = localStorage.getItem(PREFS_KEY);
    // Focus is on the body after the More menu closes, so the press reaches window.
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      document.body.dispatchEvent(event);
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(getSidebarNavigationPrefs(OWNER)).toEqual({
      order: [...defaults().order],
      visible: [...defaults().visible],
      appsAtTop: [],
    });
    expect(localStorage.getItem(PREFS_KEY)).toBe(before);
  });

  it('closes on Esc from its own controls but leaves claimed presses alone', () => {
    const onDone = vi.fn();
    render(<SidebarNavigationCustomize onDone={onDone} />);
    const escape = (target: EventTarget, init: KeyboardEventInit = {}) =>
      act(() => {
        target.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }),
        );
      });
    // Held key auto-repeat, modifiers and IME composition never close the panel.
    escape(document.body, { repeat: true });
    escape(document.body, { shiftKey: true });
    escape(document.body, { isComposing: true });
    // An editable field elsewhere keeps its Esc.
    const input = document.createElement('input');
    document.body.appendChild(input);
    escape(input);
    // A press already handled by an inner layer is not taken again.
    const claimed = (event: Event) => event.preventDefault();
    window.addEventListener('keydown', claimed, true);
    escape(document.body);
    window.removeEventListener('keydown', claimed, true);
    // An open preview closes first.
    const lightbox = document.createElement('div');
    lightbox.setAttribute('data-lightbox-layer', '');
    document.body.appendChild(lightbox);
    escape(document.body);
    lightbox.remove();
    // An open composer MorphPopover (focus on its panel surface) closes first.
    const morph = document.createElement('div');
    morph.setAttribute('role', 'group');
    morph.setAttribute('data-morph-side', 'top');
    morph.tabIndex = -1;
    document.body.appendChild(morph);
    escape(morph);
    morph.remove();
    input.remove();
    expect(onDone).not.toHaveBeenCalled();
    // Esc on the panel's own checkbox still closes it.
    escape(screen.getByRole('checkbox', { name: 'sidebar.navigation.items.plugins' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('stops listening for Esc once closed', () => {
    const onDone = vi.fn();
    const view = render(<SidebarNavigationCustomize onDone={onDone} />);
    view.unmount();
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(onDone).not.toHaveBeenCalled();
  });

  it('takes focus on open so an earlier decision card yields Esc to it', () => {
    // A permission card mounted first registers its window Esc (deny) before the panel.
    const onRespond = vi.fn();
    render(
      <PermissionPrompt
        permission={{ requestId: 'req-1', toolName: 'Bash', input: { command: 'ls' } }}
        onRespond={onRespond}
      />,
    );
    const onDone = vi.fn();
    render(<SidebarNavigationCustomize onDone={onDone} />);
    // A real press targets the focused element; before the fix that was the body,
    // and the card denied the request.
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onRespond).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('keeps an Esc pressed in the panel from reaching background window shortcuts', () => {
    // Like leaving right-sidebar maximize: registered first, and it neither checks nor
    // sets defaultPrevented.
    const background = vi.fn();
    window.addEventListener('keydown', background);
    try {
      const onDone = vi.fn();
      render(<SidebarNavigationCustomize onDone={onDone} />);
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      expect(onDone).toHaveBeenCalledTimes(1);
      expect(background).not.toHaveBeenCalled();
      // Keys the panel does not take still reach them.
      fireEvent.keyDown(document.activeElement!, { key: 'Escape', shiftKey: true });
      expect(background).toHaveBeenCalledTimes(1);
      expect(onDone).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', background);
    }
  });

  it('keeps focus in the panel after a click on a row label or its padding', async () => {
    // Clicking non-focusable panel content moves focus to the nearest focusable
    // ancestor. Without one that is the body, and the next Esc skips the panel's own
    // handler: an earlier decision card denies first, or right-sidebar maximize also
    // exits.
    const onRespond = vi.fn();
    render(
      <PermissionPrompt
        permission={{ requestId: 'req-1', toolName: 'Bash', input: { command: 'ls' } }}
        onRespond={onRespond}
      />,
    );
    const background = vi.fn();
    window.addEventListener('keydown', background);
    try {
      const onDone = vi.fn();
      render(<SidebarNavigationCustomize onDone={onDone} />);
      const user = userEvent.setup();
      await user.click(screen.getByText('sidebar.navigation.items.plugins'));
      expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
      await user.click(screen.getByRole('heading', { name: 'sidebar.navigation.customize.title' }));
      expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
      await user.keyboard('{Escape}');
      expect(onRespond).not.toHaveBeenCalled();
      expect(background).not.toHaveBeenCalled();
      expect(onDone).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', background);
    }
  });

  it('toggles from anywhere in the row except the drag handle', () => {
    render(<SidebarNavigationCustomize onDone={() => {}} />);
    const plugins = screen.getByRole('checkbox', { name: 'sidebar.navigation.items.plugins' });
    expect(plugins.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByText('sidebar.navigation.items.plugins'));
    expect(plugins.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(plugins.parentElement!);
    expect(plugins.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(plugins);
    expect(plugins.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(
      screen.getByRole('button', {
        name: 'sidebar.navigation.customize.reorder: sidebar.navigation.items.plugins',
      }),
    );
    expect(plugins.getAttribute('aria-checked')).toBe('false');
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
    // Teammates are a sidebar section of their own now, not a customizable entry.
    expect(screen.queryByRole('checkbox', { name: 'sidebar.navigation.items.bots' })).toBeNull();
    expect(rowOf('sidebar.navigation.items.search').querySelector('.lucide-search')).not.toBeNull();
    expect(rowOf('站点').querySelector('.lucide-globe')).not.toBeNull();
  });
  it('keeps a separate layout for each account', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['search', 'automations', 'plugins'],
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
      order: ['automations', 'app:xd-sites', 'plugins', 'search'],
      visible: ['automations', 'plugins', 'search'],
    });
    render(<SidebarNavigationCustomize onDone={() => {}} />);
    expect(order()).not.toContain('站点');
    act(() => sortableMock.props!.onReorder(['plugins', 'automations', 'search']));
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.done' }));
    expect(getSidebarNavigationPrefs(OWNER).order).toEqual([
      'plugins',
      'automations',
      'app:xd-sites',
      'search',
    ]);
  });

  it('keeps a plugin switched off in another window at its place on save', () => {
    mainViewsMock.routeCapable = [SITES];
    mainViewsMock.sidebarVisible = [SITES];
    setSidebarNavigationPrefs(OWNER, {
      order: ['app:xd-sites', 'automations', 'plugins', 'search'],
      visible: ['automations', 'plugins', 'search'],
    });
    const view = render(<SidebarNavigationCustomize onDone={() => {}} />);
    mainViewsMock.sidebarVisible = [];
    view.rerender(<SidebarNavigationCustomize onDone={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'sidebar.navigation.items.search' }));
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.done' }));
    expect(getSidebarNavigationPrefs(OWNER).order).toEqual([
      'app:xd-sites',
      'automations',
      'plugins',
      'search',
    ]);
  });

  it('keeps a reorder made after choosing reset', () => {
    setSidebarNavigationPrefs(OWNER, {
      order: ['search', 'plugins', 'automations'],
      visible: ['search'],
    });
    render(<SidebarNavigationCustomize onDone={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.reset' }));
    act(() => sortableMock.props!.onReorder(['plugins', 'automations', 'search']));
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.navigation.customize.done' }));
    expect(getSidebarNavigationPrefs(OWNER).order).toEqual([
      'plugins',
      'automations',
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
