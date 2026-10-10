// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  push: vi.fn(), markRead: vi.fn(), list: vi.fn(), setMode: vi.fn(), homeMode: 'tasks',
  hydrated: true, focused: true, dismiss: vi.fn(), dismissTo: vi.fn(), reset: vi.fn(), routes: [] as Array<{ name: string; params?: unknown }>,
  params: { collectionId: 'tools', targets: JSON.stringify([{ deviceId: 'mac', deviceName: 'My Mac' }]) },
  translation: { t: (key: string) => key, i18n: { language: 'en' } },
  link: { connectionEpoch: 1, status: 'online', presenceVersion: 1, getPresenceAvailability: () => true, openLink: vi.fn(async () => {}), invoke: vi.fn(), onRemoteResourceChanged: vi.fn((_listener: (deviceId: string, payload: { collectionId: string }) => void) => () => {}), subscribe: vi.fn(), unsubscribe: vi.fn() },
  item: { ref: { collectionId: 'tools', kind: 'bot', id: 'bot-1' }, revision: '1', display: { title: 'Writer', preview: 'Unread reply', lastReplyAt: 200 }, links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'chat-1' } }] },
}));
vi.mock('react-native', async () => {
  const { createElement: el, Fragment } = await import('react');
  const view = ({ children, testID }: any) => el('div', { 'data-testid': testID }, children);
  return {
    View: view, ActivityIndicator: view, RefreshControl: () => null, Keyboard: { dismiss() {} },
    Pressable: ({ children, testID, onPress, disabled }: any) => el('button', { 'data-testid': testID, onClick: onPress, disabled }, children),
    FlatList: ({ data, renderItem, ListEmptyComponent }: any) => el('div', { 'data-list': true }, data.length ? data.map((item: any) => el(Fragment, { key: item.key }, renderItem({ item }))) : ListEmptyComponent),
    StyleSheet: { create: (styles: unknown) => styles },
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    Animated: { Value: class { setValue() {} stopAnimation() {} interpolate() { return 0; } }, View: view,
      timing: () => ({ start() {}, stop() {} }), loop: () => ({ start() {}, stop() {} }), sequence: () => ({ start() {}, stop() {} }) },
    Easing: { bezier: () => () => 0, inOut: () => () => 0, ease: () => 0 },
  };
});
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return { Redirect: ({ href }: { href: string }) => <output data-target>{href}</output>, useIsFocused: () => h.focused, useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]), useLocalSearchParams: () => h.params, useRouter: () => ({ dismiss: h.dismiss, dismissTo: h.dismissTo }), useNavigation: () => ({ reset: h.reset, getState: () => ({ index: h.routes.length - 1, routes: h.routes }) }) };
});
vi.mock('@/session/useHomeMode', () => ({ useHomeMode: () => ({ hydrated: h.hydrated, mode: h.homeMode, setMode: h.setMode }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => h.translation }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'div' }));
vi.mock('lucide-react-native', () => ({ ChevronRight: () => null, RefreshCw: () => null, Search: () => null, TriangleAlert: () => null, X: () => null }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => true }));
vi.mock('@/session/WorkingStatusText', () => ({ WorkingStatusText: ({ text }: any) => text }));
vi.mock('@/components/AppText', async () => {
  const { createElement: el } = await import('react');
  return { Text: ({ children }: any) => el('span', null, children), TextInput: ({ testID }: any) => el('input', { 'data-testid': testID }) };
});
vi.mock('@/components/RemoteCompanionAvatar', () => ({ RemoteCompanionAvatar: () => null }));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowEmptyState: () => null, StatusDot: () => null, RemoteListSyncingPlaceholder: () => null }));
vi.mock('@/platform/chrome', () => ({ SimpleStackHeader: () => null, simpleScreenSafeAreaEdges: () => [], simpleScrollInsetProps: {}, simpleScrollScreenSafeAreaEdges: () => [] }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner' }, accountGeneration: 1 }) }));
vi.mock('@/device-link/remoteStatus', () => ({ formatRemoteError: String }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => h.link }));
vi.mock('@/theme', async () => ({ ...await import('@/theme/tokens'), useThemedStyles: () => ({}), useTheme: () => ({ colors: {} }) }));
vi.mock('@/session/sessionList', () => ({ formatRemoteSessionSidebarTime: () => '' }));
vi.mock('@/utils/useMinuteNow', () => ({ useMinuteNow: () => 0 }));
vi.mock('@/utils/useGuardedPush', () => ({ useGuardedPush: () => h.push }));
vi.mock('@/device-link/focusedTopicSubscription', () => ({ startFocusedTopicSubscription: () => () => {} }));
vi.mock('@/device-link/remoteResourceAvailability', async (original) => ({ ...await original<typeof import('@/device-link/remoteResourceAvailability')>(), isRemoteResourceHostOnline: () => true, readRemoteCollectionCache: () => [], writeRemoteCollectionCache: () => {} }));
vi.mock('@/device-link/remoteResourceCache', () => ({
  cacheRemoteResourceItems: vi.fn(), readRemoteResourceSnapshot: async () => ({ items: {} }),
  isRemoteResourceUnread: () => true, markRemoteResourceRead: h.markRead,
  subscribeRemoteResourceCache: () => () => {}, remoteResourceCacheRevision: () => 0,
}));
vi.mock('@/device-link/remoteResources', async (original) => ({
  ...await original<typeof import('@/device-link/remoteResources')>(),
  listRemoteCollection: h.list,
}));
import RemoteCollectionScreen from '../../app/resources/[collectionId]';
import { StackRouter, StackActions } from 'expo-router/build/react-navigation/routers/StackRouter';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => { vi.clearAllMocks(); h.hydrated = true; h.focused = true; h.routes = []; });

it('does not migrate a hidden legacy route underneath an active task', async () => {
  h.params.collectionId = 'teammates'; h.focused = false;
  h.routes = [{ name: 'resources/[collectionId]', params: { collectionId: 'teammates' } }, { name: 'sessions/[sessionId]' }];
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(createElement(RemoteCollectionScreen)));
    expect(h.setMode).not.toHaveBeenCalled();
    expect(h.reset).not.toHaveBeenCalled();
    expect(h.dismiss).not.toHaveBeenCalled();
    expect(h.dismissTo).not.toHaveBeenCalled();
  } finally { h.params.collectionId = 'tools'; act(() => root.unmount()); }
});

it.each(['index', 'devices/index'])('migrates the retired collection by returning to the existing %s without duplicating home', async name => {
  h.params.collectionId = 'teammates';
  h.hydrated = false;
  const router = StackRouter({ initialRouteName: name });
  const options = { routeNames: [name, 'resources/[collectionId]'], routeParamList: {}, routeGetIdList: {}, routeKeyChanges: [] };
  let state = router.getInitialState(options);
  const home = state.routes[0];
  state = router.getStateForAction(state, StackActions.push('resources/[collectionId]', { collectionId: 'teammates' }), options)! as typeof state;
  h.routes = state.routes;
  h.dismiss.mockImplementationOnce(count => { state = router.getStateForAction(state, StackActions.pop(count), options)! as typeof state; });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(RemoteCollectionScreen)));
    expect(container.querySelector('[data-target]')).toBeNull();
    expect(h.setMode).not.toHaveBeenCalled();
    expect(h.dismiss).not.toHaveBeenCalled();
    h.hydrated = true;
    await act(async () => root.render(createElement(RemoteCollectionScreen)));
    expect(h.setMode).toHaveBeenCalledWith('teammates');
    expect(h.dismiss).toHaveBeenCalledExactlyOnceWith(1);
    expect(h.dismissTo).not.toHaveBeenCalled();
    expect(state.routes).toEqual([home]);
    expect(state.routes[0]).toBe(home);
    expect(container.querySelector('[data-target]')).toBeNull();
    expect(h.list).not.toHaveBeenCalled();
  } finally {
    h.params.collectionId = 'tools';
    h.homeMode = 'tasks';
    act(() => root.unmount());
  }
});

it('opens a generic resource without marking it read', async () => {
  h.list.mockResolvedValue({ collectionId: 'tools', revision: '1', items: [h.item] });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(RemoteCollectionScreen)));
    const button = container.querySelector<HTMLButtonElement>('[data-testid="remoteResources.item.bot-1"]');
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    expect(h.push).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/resources/[collectionId]/[resourceId]', params: expect.objectContaining({ collectionId: 'tools', resourceId: 'bot-1' }) }));
    expect(h.markRead).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); }
});


it('serializes bursts of generation pushes on the generic resource route and preserves the final refresh', async () => {
  h.list.mockClear();
  let settle!: (value: unknown) => void;
  h.list.mockReturnValue(new Promise(resolve => { settle = resolve; }));
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(RemoteCollectionScreen)));
    const notify = h.link.onRemoteResourceChanged.mock.calls.at(-1)![0];
    await act(async () => { for (let n = 0; n < 20; n++) notify('mac', { collectionId: 'tools' }); });
    expect(h.list).toHaveBeenCalledTimes(1);
    h.list.mockResolvedValue({ items: [h.item] });
    await act(async () => settle({ items: [] }));
    expect(h.list).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="remoteResources.item.bot-1"]')).not.toBeNull();
    const list = container.querySelector<HTMLDivElement>('[data-list]')!; list.scrollTop = 120;
    // A queued refresh must not issue another RPC after leaving the route.
    h.list.mockReturnValue(new Promise(resolve => { settle = resolve; }));
    await act(async () => { notify('mac', { collectionId: 'tools' }); notify('mac', { collectionId: 'tools' }); });
    expect(container.querySelector('[data-list]')).toBe(list);
    expect(list.scrollTop).toBe(120);
    expect(container.querySelector('[data-testid="remoteResources.item.bot-1"]')).not.toBeNull();
    act(() => root.unmount());
    await act(async () => settle({ items: [] }));
    expect(h.list).toHaveBeenCalledTimes(3);
  } finally { act(() => root.unmount()); }
});
