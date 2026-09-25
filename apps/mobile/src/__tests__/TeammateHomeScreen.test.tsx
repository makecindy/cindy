// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeMode, LastTeammateIdentity } from '@/session/homeViewPreferenceStore';
import type { HostedRemoteCollectionItem } from '@/device-link/remoteResources';
const h = vi.hoisted(() => ({
  realNavigation: false, stored: null as string | null, tasks: {} as any, dismissTo: vi.fn(),
  focused: true, drawer: {} as any, list: {} as any, accounts: {} as any, push: vi.fn(),
  auth: { user: { id: 'owner' }, accountGeneration: 1, logout: vi.fn(), beginAddAccount: vi.fn() },
  nav: { hydrated: true, lastTeammate: null as LastTeammateIdentity | null, mode: 'teammates' as HomeMode,
    restoreLastTeammate: true, saveFailed: false, openTeammate: vi.fn(), rememberTeammate: vi.fn(), setMode: vi.fn() },
  roster: { createTargets: [], authoritative: true, items: [] as HostedRemoteCollectionItem[], loading: false, refreshing: false, error: null as string | null,
    isOnline: vi.fn(() => true), refresh: vi.fn() },
}));
vi.mock('react-native', async () => {
  const { createElement: el } = await import('react');
  return { View: ({ children }: any) => el('div', {}, children), ActivityIndicator: () => null,
    Keyboard: { dismiss() {} }, Alert: { alert: vi.fn() }, StyleSheet: { create: (value: unknown) => value } };
});
vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, useIsFocused: () => h.focused, useNavigation: () => ({ getState: () => ({ routes: [] }) }), useRouter: () => ({ dismissTo: h.dismissTo }) }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'div' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('lucide-react-native', () => ({ Menu: () => null }));
vi.mock('@/components/AppText', () => ({ Text: 'span' }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => h.auth }));
vi.mock('@/theme', () => ({ useThemedStyles: () => ({}), useTheme: () => ({ colors: {} }) }));
vi.mock('@/utils/useGuardedPush', () => ({ useGuardedPush: () => h.push }));
vi.mock('@/device-link/remoteStatus', () => ({ formatRemoteError: String }));
vi.mock('@/session/TeammateCreateButton', () => ({ TeammateCreateButton: () => null }));
vi.mock('@/session/HomeChromeDrawer', () => ({ HomeChromeDrawer: (props: unknown) => { h.drawer = props; return null; } }));
vi.mock('@/session/AccountSwitcherSheet', () => ({ AccountSwitcherSheet: (props: unknown) => { h.accounts = props; return null; } }));
vi.mock('@/session/HomeHeaderGlassButton', () => ({ HomeHeaderGlassButton: () => null }));
vi.mock('@/session/TeammateList', () => ({ TeammateList: (props: unknown) => { h.list = props; return null; } }));
vi.mock('@/session/useTeammateRoster', () => ({ useTeammateRoster: () => ({ ...h.roster }) }));
vi.mock('@/session/useTeammateNavigation', async original => {
  const actual = await original<typeof import('@/session/useTeammateNavigation')>();
  return { useTeammateNavigation: () => h.realNavigation ? actual.useTeammateNavigation() : { ...h.nav } };
});
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async () => h.stored, setItem: async (_key: string, value: string) => { h.stored = value; },
} }));
vi.mock('@/session/HomeSurface', () => ({ MobileHome: (props: unknown) => { h.tasks = props; return null; } }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: { subscribe: () => () => {}, getSessions: () => [] } }));
import HomeScreen from '../../app/devices/index';
import { TeammateHomeScreen } from '@/session/TeammateHomeScreen';
import { teammateIdentity } from '@/session/teammateNavigation';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const teammate: HostedRemoteCollectionItem = { key: 'mac:bot', host: { deviceId: 'mac', deviceName: 'Mac' },
  item: { ref: { collectionId: 'teammates', kind: 'bot', id: 'writer' }, revision: '1', display: { title: 'Writer' }, links: [] } };
let root: Root | undefined;
async function render() { root ??= createRoot(document.createElement('div')); await act(async () => root!.render(createElement(TeammateHomeScreen))); }
let serial = 0;
beforeEach(() => {
  h.realNavigation = false; h.stored = null; h.nav.restoreLastTeammate = true;
  h.auth.user = { id: `owner-${++serial}` }; h.auth.accountGeneration = serial;
  vi.clearAllMocks(); h.focused = true; h.nav.lastTeammate = teammateIdentity(teammate); h.roster.items = [teammate];
  h.nav.mode = 'teammates'; h.roster.authoritative = true;
  h.roster.loading = false; h.roster.error = null; h.roster.isOnline.mockReturnValue(true);
});
afterEach(() => { act(() => root?.unmount()); root = undefined; });
describe('teammate home entry', () => {
  it('reopens a verified last teammate once, without bouncing on Back or refresh', async () => {
    await render(); expect(h.nav.openTeammate).toHaveBeenCalledExactlyOnceWith(teammate);
    h.focused = false; await render(); h.focused = true; await render();
    await act(async () => h.list.onRefresh()); await render();
    expect(h.nav.openTeammate).toHaveBeenCalledTimes(1); expect(h.roster.refresh).toHaveBeenCalledTimes(1);
  });
  it('waits for the initial route to become focused', async () => {
    h.focused = false; await render(); expect(h.nav.openTeammate).not.toHaveBeenCalled();
    h.focused = true; await render(); expect(h.nav.openTeammate).toHaveBeenCalledExactlyOnceWith(teammate);
  });
  it('does not resurrect a deleted teammate or substitute another existing roster member', async () => {
    h.roster.items = [{ ...teammate, item: { ...teammate.item, ref: { ...teammate.item.ref, id: 'different-bot' }, display: { title: 'Cindy' } } }];
    await render(); expect(h.nav.openTeammate).not.toHaveBeenCalled(); expect(h.nav.rememberTeammate).toHaveBeenCalledWith(null);
  });
  it('waits through transient offline startup and restores after reconnect without interaction', async () => {
    h.roster.authoritative = false; h.roster.error = 'offline'; h.roster.isOnline.mockReturnValue(false);
    await render(); expect(h.nav.openTeammate).not.toHaveBeenCalled(); expect(h.nav.rememberTeammate).not.toHaveBeenCalled();
    h.roster.error = null; h.roster.authoritative = true; h.roster.isOnline.mockReturnValue(true); await render(); expect(h.nav.openTeammate).toHaveBeenCalledExactlyOnceWith(teammate);
  });
  it('does not hijack a roster the user started searching while initial synchronization was pending', async () => {
    h.roster.loading = true; await render();
    await act(async () => h.list.onInteract()); h.roster.loading = false; await render();
    expect(h.nav.openTeammate).not.toHaveBeenCalled();
  });
  it.each(['refresh', 'back', 'mode'])('does not hijack reconnect after %s', async (action) => {
    h.roster.authoritative = false; h.roster.isOnline.mockReturnValue(false); await render();
    if (action === 'refresh') await act(async () => h.list.onRefresh());
    if (action === 'back') { h.focused = false; await render(); h.focused = true; }
    if (action === 'mode') { h.nav.mode = 'tasks'; await render(); }
    h.roster.authoritative = true; h.roster.isOnline.mockReturnValue(true); await render();
    expect(h.nav.openTeammate).not.toHaveBeenCalled();
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
  });
});

// Exercise the real page, shared preferences, mode panes and navigation together.
// Only native chrome, list rendering, storage and the router boundary are replaced.
describe('explicit sidebar entry through the home page', () => {
  async function renderHome() {
    root ??= createRoot(document.createElement('div'));
    await act(async () => root!.render(createElement(HomeScreen)));
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
  it('still restores the last companion on an untouched cold startup', async () => {
    h.realNavigation = true;
    h.stored = JSON.stringify({ mode: 'teammates', lastTeammate: teammateIdentity(teammate) });
    await renderHome();
    expect(h.push).toHaveBeenCalledOnce();
    expect(h.push.mock.calls[0][0].params.resourceId).toBe('writer');
  });
});
