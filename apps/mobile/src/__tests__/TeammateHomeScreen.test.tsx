// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeMode, LastTeammateIdentity } from '@/session/homeViewPreferenceStore';
import type { HostedRemoteCollectionItem } from '@/device-link/remoteResources';
const h = vi.hoisted(() => ({
  styles: {}, t: (key: string) => key, realNavigation: false, stored: null as string | null, tasks: {} as any, dismissTo: vi.fn(), replace: vi.fn(),
  focused: true, drawer: {} as any, list: {} as any, accounts: {} as any, push: vi.fn(),
  auth: { user: { id: 'owner' }, accountGeneration: 1, logout: vi.fn(), beginAddAccount: vi.fn() },
  nav: { hydrated: true, lastTeammate: null as LastTeammateIdentity | null, mode: 'teammates' as HomeMode,
    saveFailed: false, openTeammate: vi.fn(), setMode: vi.fn(), chooseMode: vi.fn() },
  modeMenu: {} as any, nativeMenus: true,
  roster: { createTargets: [], authoritative: true, items: [] as HostedRemoteCollectionItem[], loading: false, refreshing: false, error: null as string | null,
    isOnline: vi.fn(() => true), refresh: vi.fn(), groupTargets: [] as { deviceId: string; deviceName: string }[] },
  groups: { loading: false, refreshing: false, error: null as string | null, items: [] as HostedRemoteCollectionItem[], supported: false, isOnline: () => true, refresh: vi.fn() },
  groupTargetsSeen: [] as unknown[],
  create: {} as any, chrome: {} as any, titleArgs: [] as number[], nativeHeader: true, headerHeight: 106, barEdge: 'none',
  cloud: { supported: false, actors: [] as Array<{ id: string; kind: string; externalId: string; name: string; avatar: null; homeDeviceId: string | null }>,
    deviceNames: new Map<string, string>(), refresh: vi.fn(), setHome: vi.fn() },
}));
vi.mock('react-native', async () => {
  const { createElement: el } = await import('react');
  return { View: ({ children }: any) => el('div', {}, children), ActivityIndicator: () => null,
    Pressable: ({ children, onPress }: any) => el('button', { onClick: onPress }, children),
    Keyboard: { dismiss: vi.fn() }, Alert: { alert: vi.fn() }, useWindowDimensions: () => ({ width: 402, height: 874 }), StyleSheet: { create: (value: unknown) => value } };
});
vi.mock('@/platform/chrome/homeMenuIcon', () => ({ homeMenuAttentionSize: 6 }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => true }));
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  const { View } = await import('react-native');
  return { default: { View }, useSharedValue: (value: number) => useRef({ value }).current,
    useAnimatedStyle: (factory: () => unknown) => factory(), cancelAnimation: () => {},
    withSpring: (target: number) => target };
});
vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, useIsFocused: () => h.focused, useNavigation: () => ({ getState: () => ({ routes: [] }) }), useRouter: () => ({ dismissTo: h.dismissTo, replace: h.replace }) }));
vi.mock('expo-router/react-navigation', () => ({ useHeaderHeight: () => h.headerHeight }));
vi.mock('@/session/useOptionalHeaderHeight', () => ({ useOptionalHeaderHeight: () => h.headerHeight }));
vi.mock('@/session/SessionHeaderNativeControls', () => ({ SessionHeaderNativeBlur: () => null }));
vi.mock('@/platform/AdaptiveWindowContext', () => ({ useAdaptiveWindow: () => ({ width: 402, insets: { left: 0, right: 0 }, barEdge: h.barEdge }) }));
vi.mock('@/platform/chrome/SimpleStackHeader', () => ({ usesNativeStackHeader: () => h.nativeHeader,
  simpleScreenSafeAreaEdges: () => h.nativeHeader ? ['left', 'right', 'bottom'] : undefined }));
vi.mock('@/platform/chrome/HomeStackHeader', () => ({ centeredHomeTitleWidth: (...args: number[]) => { h.titleArgs = args; return 226; }, HomeStackHeader: (props: any) => {
  h.chrome = props; return createElement('div', { 'data-testid': 'native-home-bar' }, props.title, props.children);
} }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'div' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: h.t, i18n: { language: 'en' } }) }));
vi.mock('lucide-react-native', () => ({ ChevronDown: () => null, Menu: () => null }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => createElement('span', null, children) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('@/theme', () => ({ useThemedStyles: () => h.styles, useTheme: () => ({ colors: {} }) }));
vi.mock('@/utils/useGuardedPush', () => ({ useGuardedPush: () => h.push }));
vi.mock('@/device-link/remoteStatus', () => ({ formatRemoteError: String }));
vi.mock('@/session/TeammateCreateButton', () => ({ TeammateCreateButton: (props: any) => { if (props.appearance !== 'cta') h.create = props; return null; } }));
vi.mock('@/session/HomeChromeDrawer', () => ({ HomeChromeDrawer: (props: unknown) => { h.drawer = props; return null; } }));
vi.mock('@/platform/chrome', () => ({ NativePullDownMenu: (props: any) => { h.modeMenu = props; return props.children; }, usesNativePullDownMenu: () => h.nativeMenus }));
vi.mock('@/session/AccountSwitcherSheet', () => ({ AccountSwitcherSheet: (props: unknown) => { h.accounts = props; return null; } }));
vi.mock('@/session/HomeHeaderGlassButton', () => ({ HomeHeaderGlassButton: () => null }));
vi.mock('@/session/TeammateList', () => ({ TeammateList: (props: unknown) => { h.list = props; return null; } }));
vi.mock('@/session/useTeammateRoster', () => ({ useTeammateRoster: () => ({ ...h.roster }) }));
vi.mock('@/chat/useCloudCompanion', () => ({ useCloudCompanionHome: () => h.cloud }));
vi.mock('@/session/useBotGroupRoster', () => ({ useBotGroupRoster: (targets: unknown) => { h.groupTargetsSeen.push(targets); return h.groups; } }));
vi.mock('@/session/useTeammateNavigation', async original => {
  const actual = await original<typeof import('@/session/useTeammateNavigation')>();
  return { useTeammateNavigation: () => h.realNavigation ? actual.useTeammateNavigation() : { ...h.nav } };
});
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async () => h.stored, setItem: async (_key: string, value: string) => { h.stored = value; },
} }));
vi.mock('@/session/HomeSurface', () => ({ MobileHome: (props: unknown) => { h.tasks = props; return null; } }));
vi.mock('@/session/remoteSessionStore', () => ({
  remoteSessionStore: { subscribe: () => () => {}, getSessions: () => [] },
  RemoteSessionStoreSubscriptionGate: ({ children }: { children: React.ReactNode }) => children,
  useRemoteHomeSessions: () => [], useRemoteHomeStatusVersion: () => 0,
}));
import HomeScreen from '../../app/devices/index';
import { HomeModeProgressContext } from '@/session/HomeModeTransition';
import { Keyboard } from 'react-native';
import { TeammateHomeScreen } from '@/session/TeammateHomeScreen';
import { teammateIdentity } from '@/session/teammateNavigation';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const teammate: HostedRemoteCollectionItem = { key: 'mac:bot', host: { deviceId: 'mac', deviceName: 'Mac' },
  item: { ref: { collectionId: 'teammates', kind: 'bot', id: 'writer' }, revision: '1', display: { title: 'Writer' }, links: [] } };
let root: Root | undefined;
async function render(active = true) { root ??= createRoot(document.createElement('div')); await act(async () => root!.render(createElement(TeammateHomeScreen, { active }))); }
let serial = 0;
beforeEach(() => {
  h.realNavigation = false; h.stored = null;
  h.auth.user = { id: `owner-${++serial}` }; h.auth.accountGeneration = serial;
  vi.clearAllMocks(); h.focused = true; h.nav.lastTeammate = teammateIdentity(teammate); h.roster.items = [teammate];
  h.nav.mode = 'teammates'; h.nav.chooseMode.mockReset(); h.roster.authoritative = true;
  h.modeMenu = {}; h.nativeMenus = true; h.nativeHeader = true; h.headerHeight = 106; h.barEdge = 'none'; h.chrome = {};
  h.groups.loading = false; h.groups.refreshing = false; h.groups.error = null;
  h.roster.loading = false; h.roster.error = null; h.roster.isOnline.mockReturnValue(true);
  h.cloud.supported = false; h.cloud.actors = []; h.cloud.deviceNames = new Map();
});
afterEach(() => { act(() => root?.unmount()); root = undefined; });
describe('teammate home entry', () => {
  it('lands on the roster and never opens the remembered teammate on its own', async () => {
    // A remembered, online teammate on a settled roster used to be reopened at launch (#4912); the
    // roster is the destination now, in every focus, refresh and remount.
    await render(); expect(h.nav.openTeammate).not.toHaveBeenCalled();
    h.focused = false; await render(); h.focused = true; await render();
    await act(async () => h.list.onRefresh()); await render();
    act(() => root!.unmount()); root = undefined; await render();
    expect(h.nav.openTeammate).not.toHaveBeenCalled();
    expect(h.roster.refresh).toHaveBeenCalledTimes(1);
    // Choosing a row still opens it.
    await act(async () => h.list.onSelect(teammate));
    expect(h.nav.openTeammate).toHaveBeenCalledExactlyOnceWith(teammate);
  });
  it('preserves every utility/account action and waits for the drawer to close before switching mode', async () => {
    h.nav.lastTeammate = null; await render();
    expect(h.drawer.mode).toBe('teammates');
    await act(async () => h.drawer.onModeChange('tasks')); expect(h.nav.setMode).not.toHaveBeenCalled();
    await act(async () => h.drawer.onClosed()); expect(h.nav.setMode).toHaveBeenCalledWith('tasks');
    await act(async () => { h.drawer.onOpenDevices(); h.drawer.onClosed(); }); expect(h.push).toHaveBeenCalledWith('/devices/manage');
    await act(async () => { h.drawer.onOpenSettings(); h.drawer.onClosed(); }); expect(h.push).toHaveBeenCalledWith('/settings');
    await act(async () => { h.drawer.onOpenAccounts(); h.drawer.onClosed(); }); expect(h.accounts.visible).toBe(true);
    await act(async () => { h.drawer.onOpenSearch(); h.drawer.onClosed(); }); expect(h.list.autoFocusSearch).toBe(true);
    h.auth.logout.mockResolvedValue(undefined); await act(async () => h.drawer.onLogout()); expect(h.auth.logout).toHaveBeenCalledOnce();
    expect(h.replace).toHaveBeenCalledWith('/login');
  });
  it('keeps a top mode menu available for returning to tasks', async () => {
    await render();
    await act(async () => h.modeMenu.onAction('tasks'));
    expect(h.nav.chooseMode).toHaveBeenCalledWith('tasks');
  });
  it('dismisses search before opening the title fallback drawer and switching to tasks', async () => {
    h.nativeMenus = false;
    await render();
    expect(h.drawer.open).toBe(false);
    await act(async () => h.modeMenu.children.props.onPress());
    expect(Keyboard.dismiss).toHaveBeenCalledOnce();
    expect(h.drawer.open).toBe(true);
    await act(async () => h.drawer.onModeChange('tasks'));
    expect(h.nav.setMode).not.toHaveBeenCalled();
    await act(async () => h.drawer.onClosed());
    expect(h.nav.setMode).toHaveBeenCalledExactlyOnceWith('tasks');
    expect(Keyboard.dismiss).toHaveBeenCalledOnce();
  });
});

// Exercise the real page, shared preferences, mode panes and navigation together.
// Only native chrome, list rendering, storage and the router boundary are replaced.
describe('explicit sidebar entry through the home page', () => {
  async function renderHome() {
    root ??= createRoot(document.createElement('div'));
    // The root ResidentHomeListProvider owns this clock in the app; its slide is covered by HomeModePanes.test.
    await act(async () => root!.render(createElement(HomeModeProgressContext.Provider, { value: { value: 1 } as any }, createElement(HomeScreen))));
  }
  it.each([1, 2])('keeps a %i-companion roster open across refresh and remount until a row is chosen', async count => {
    h.realNavigation = true;
    h.stored = JSON.stringify({ mode: 'tasks', lastTeammate: teammateIdentity(teammate) });
    const second = { ...teammate, key: 'mac:second', item: { ...teammate.item, ref: { ...teammate.item.ref, id: 'second' } } };
    const items = count === 1 ? [teammate] : [teammate, second];
    h.roster.items = []; h.roster.loading = true;
    await renderHome();
    await act(async () => h.tasks.onModeChange('teammates'));
    h.roster.items = items; h.roster.loading = false;
    await renderHome();
    expect(h.push).not.toHaveBeenCalled();
    expect(h.list.items).toEqual(items);
    await act(async () => h.list.onRefresh()); await renderHome();
    act(() => root!.unmount()); root = undefined;
    await renderHome();
    expect(h.push).not.toHaveBeenCalled();
    await act(async () => h.list.onSelect(items.at(-1)));
    expect(h.push).toHaveBeenCalledOnce();
    expect(h.push.mock.calls[0][0].params.resourceId).toBe(items.at(-1)!.item.ref.id);
  });
  it('keeps an untouched cold startup on the roster instead of reopening the last companion', async () => {
    h.realNavigation = true;
    h.stored = JSON.stringify({ mode: 'teammates', lastTeammate: teammateIdentity(teammate) });
    await renderHome();
    expect(h.push).not.toHaveBeenCalled();
  });
});

describe('group chats in the teammate list', () => {
  const group: HostedRemoteCollectionItem = { key: 'mac:g1', host: { deviceId: 'mac', deviceName: 'Mac' },
    item: { ref: { collectionId: 'bot-groups', kind: 'bot-group', id: 'g1' }, revision: '1', display: { title: '官网' }, links: [] } };
  afterEach(() => { h.roster.groupTargets = []; h.groups = { loading: false, refreshing: false, error: null, items: [], supported: false, isOnline: () => true, refresh: vi.fn() }; h.create = {}; });

  it('leaves group chats out when no computer supports them (older desktops)', async () => {
    h.nav.lastTeammate = null; await render();
    expect(h.list.groups).toBeUndefined();
  });

  it('mixes the discovered computers’ groups into the list, opens one on its computer and creates from the + menu', async () => {
    h.nav.lastTeammate = null;
    h.roster.groupTargets = [{ deviceId: 'mac', deviceName: 'Mac' }, { deviceId: 'pc', deviceName: 'PC' }];
    h.groups = { items: [group], supported: true, isOnline: (host: { deviceId: string }) => host.deviceId === 'mac', refresh: vi.fn() } as any;
    await render();
    expect(h.groupTargetsSeen.at(-1)).toBe(h.roster.groupTargets);
    expect(h.list.groups.items).toEqual([group]);
    // Only online computers can host a new group.
    expect(h.create.groupTargets).toEqual([{ deviceId: 'mac', deviceName: 'Mac' }]);
    await act(async () => h.list.groups.onSelect(group));
    expect(h.push).toHaveBeenLastCalledWith({ pathname: '/companions/groups/[groupId]', params: { groupId: 'g1', deviceId: 'mac', deviceName: 'Mac' } });
    await act(async () => h.create.onGroupCreated({ deviceId: 'pc', deviceName: 'PC' }, 'g2'));
    expect(h.push).toHaveBeenLastCalledWith({ pathname: '/companions/groups/[groupId]', params: { groupId: 'g2', deviceId: 'pc', deviceName: 'PC' } });
    expect(h.nav.openTeammate).not.toHaveBeenCalled();
  });
});


describe('server groups in the actual teammate home', () => {
  it('shows group loading/failure and refreshes it even without any computer target', async () => {
    h.roster.items = []; h.groups.items = []; h.groups.supported = true; h.groups.loading = true;
    await render(); expect(h.list.loading).toBe(true);
    h.groups.loading = false; h.groups.error = 'CHAT_LIST_FAILED';
    await render(); expect(h.list.error).toBe('CHAT_LIST_FAILED');
    await act(async () => h.list.onRefresh()); expect(h.groups.refresh).toHaveBeenCalledOnce();
  });
});

describe('cloud companions (main computer offline)', () => {
  const actorId = '00000000-0000-4000-8000-000000000001';
  const copy = (deviceId: string): HostedRemoteCollectionItem => ({ ...teammate, key: `${deviceId}:writer`, host: { deviceId, deviceName: deviceId.toUpperCase() } });
  it('keeps a listed companion quiet and in its normal chat while its main computer looks offline', async () => {
    h.cloud.supported = true;
    h.cloud.actors = [{ id: actorId, kind: 'bot', externalId: 'writer', name: 'Writer', avatar: null, homeDeviceId: 'mac' }];
    h.roster.items = [teammate, copy('pc')];
    h.roster.isOnline.mockReturnValue(false);
    await render();
    expect(h.list.items.map((row: HostedRemoteCollectionItem) => row.key)).toEqual(['mac:bot']);
    expect(h.list.quietPresence(teammate)).toBe(true);
    await act(async () => h.list.onSelect(teammate));
    expect(h.nav.openTeammate).toHaveBeenCalledExactlyOnceWith(teammate);
    expect(h.push).not.toHaveBeenCalledWith(expect.objectContaining({ pathname: '/companions/cloud/[actorId]' }));
  });
  it('opens the cloud conversation only for a companion this phone knows from the cloud alone', async () => {
    h.cloud.supported = true;
    h.cloud.deviceNames = new Map([['mac', 'Mac']]);
    h.cloud.actors = [{ id: actorId, kind: 'bot', externalId: 'writer', name: 'Writer', avatar: null, homeDeviceId: 'mac' }];
    h.roster.items = [copy('pc')];
    await render();
    const [row] = h.list.items as HostedRemoteCollectionItem[];
    expect(row.item.revision).toBe('cloud');
    expect(h.list.quietPresence(row)).toBe(true);
    await act(async () => h.list.onSelect(row));
    expect(h.push).toHaveBeenLastCalledWith({ pathname: '/companions/cloud/[actorId]',
      params: { actorId, botId: 'writer', deviceId: 'mac', deviceName: 'Mac', title: 'Writer' } });
    expect(h.nav.openTeammate).not.toHaveBeenCalled();
  });
  it('re-reads main computers when the listed rows change and on pull-to-refresh', async () => {
    h.cloud.supported = true;
    h.cloud.refresh = vi.fn();
    h.roster.items = [teammate];
    await render();
    const afterMount = h.cloud.refresh.mock.calls.length;
    await render();
    expect(h.cloud.refresh).toHaveBeenCalledTimes(afterMount);
    // Another device moved the companion: the new main computer now lists it.
    h.roster.items = [teammate, copy('pc')];
    await render();
    expect(h.cloud.refresh).toHaveBeenCalledTimes(afterMount + 1);
    // Both computers were already cached: the new main computer re-lists the same row.
    h.roster.items = [teammate, { ...copy('pc'), item: { ...copy('pc').item, revision: 'taken-over' } }];
    await render();
    expect(h.cloud.refresh).toHaveBeenCalledTimes(afterMount + 2);
    await act(async () => h.list.onRefresh());
    expect(h.cloud.refresh).toHaveBeenCalledTimes(afterMount + 3);
  });
  it('keeps the per-computer behavior on an older server or an online computer', async () => {
    h.cloud.actors = [{ id: actorId, kind: 'bot', externalId: 'writer', name: 'Writer', avatar: null, homeDeviceId: 'mac' }];
    h.roster.items = [teammate, copy('pc')];
    h.roster.isOnline.mockReturnValue(false);
    await render();
    expect(h.list.items).toHaveLength(2);
    expect(h.list.quietPresence(teammate)).toBe(false);
    h.cloud.supported = true; h.roster.isOnline.mockReturnValue(true);
    await render();
    await act(async () => h.list.onSelect(teammate));
    expect(h.nav.openTeammate).toHaveBeenCalledExactlyOnceWith(teammate);
  });
});

describe('shared native home chrome', () => {
  it('uses the measured bar inset once and opens the existing drawer from the shared menu', async () => {
    await render();
    expect(h.list.topInset).toBe(106);
    expect(h.list.scrollInsetProps).toBeUndefined();
    expect(h.chrome.menuTestID).toBe('teammates.navigation');
    // Centered between mirrored margins for the single create item, whatever the task title does.
    expect(h.titleArgs).toEqual([402, 1]);
    expect(h.chrome.title.props.style.at(-1).width).toBe(226);
    await act(async () => h.chrome.onOpenMenu());
    expect(Keyboard.dismiss).toHaveBeenCalledOnce();
    expect(h.drawer.open).toBe(true);
    h.headerHeight = 84; await render();
    expect(h.list.topInset).toBe(84);
  });
  it('does not register a native toolbar while the kept-alive pane is hidden', async () => {
    await render(false);
    expect(h.chrome).toEqual({});
    await render(true);
    expect(h.chrome.menuTestID).toBe('teammates.navigation');
    h.chrome = {};
    await render(false);
    expect(h.chrome).toEqual({});
  });
  it('keeps the Duo top-left exception and the Android fallback', async () => {
    h.barEdge = 'right'; await render();
    expect(h.chrome.keepMenuTopLeft).toBe(true);
    h.nativeHeader = false; h.chrome = {}; await render();
    expect(h.chrome).toEqual({});
    expect(h.list.topInset).toBeUndefined();
  });
});

it('keeps native title and create toolbar stable through unrelated roster refreshes', async () => {
  await render();
  const title = h.chrome.title;
  const actions = h.chrome.children;
  h.roster.refreshing = true;
  await render();
  expect(h.chrome.title).toBe(title);
  expect(h.chrome.children).toBe(actions);
  h.roster.refreshing = false;
});

it('starts drawer page navigation during exit, while search still waits for the drawer to close', async () => {
  await render();
  await act(async () => h.chrome.onOpenMenu());
  await act(async () => h.drawer.onOpenSettings());
  expect(h.drawer.open).toBe(false);
  expect(h.push).toHaveBeenCalledExactlyOnceWith('/settings');
  await act(async () => h.drawer.onClosed());
  expect(h.push).toHaveBeenCalledTimes(1);
  await act(async () => h.chrome.onOpenMenu());
  await act(async () => h.drawer.onOpenSearch());
  expect(h.list.autoFocusSearch).toBe(false);
  await act(async () => h.drawer.onClosed());
  expect(h.list.autoFocusSearch).toBe(true);
});
