// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  push: vi.fn(), markRead: vi.fn(), list: vi.fn(),
  params: { collectionId: 'teammates', targets: JSON.stringify([{ deviceId: 'mac', deviceName: 'My Mac' }]) },
  translation: { t: (key: string) => key, i18n: { language: 'en' } },
  link: { connectionEpoch: 1, status: 'online', presenceVersion: 1, getPresenceAvailability: () => true, openLink: vi.fn(async () => {}), invoke: vi.fn(), onRemoteResourceChanged: vi.fn((_listener: (deviceId: string, payload: { collectionId: string }) => void) => () => {}), subscribe: vi.fn(), unsubscribe: vi.fn() },
  item: { ref: { collectionId: 'teammates', kind: 'bot', id: 'bot-1' }, revision: '1', display: { title: 'Writer', preview: 'Unread reply', lastReplyAt: 200 }, links: [{ rel: 'conversation', target: { kind: 'session', sessionId: 'chat-1' } }] },
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
  };
});
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return { useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]), useLocalSearchParams: () => h.params, useRouter: () => ({}), useNavigation: () => ({ getState: () => ({ index: 0, routes: [] }) }) };
});
vi.mock('@/session/useHomeMode', () => ({ useHomeMode: () => ({ selectTeammate: async () => {}, setMode: async () => {} }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => h.translation }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'div' }));
vi.mock('lucide-react-native', () => ({ ChevronRight: () => null, RefreshCw: () => null, TriangleAlert: () => null }));
vi.mock('@/session/WorkingStatusText', () => ({ WorkingStatusText: ({ text }: any) => text }));
vi.mock('@/components/AppText', () => ({ Text: 'span', TextInput: 'input' }));
vi.mock('@/components/RemoteCompanionAvatar', () => ({ RemoteCompanionAvatar: () => null }));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowEmptyState: () => null, StatusDot: () => null }));
vi.mock('@/platform/chrome', () => ({ SimpleStackHeader: () => null, simpleScreenSafeAreaEdges: () => [] }));
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
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('opening a companion only navigates; unread survives until the destination confirms content display', async () => {
  h.list.mockResolvedValue({ collectionId: 'teammates', revision: '1', items: [h.item] });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(RemoteCollectionScreen)));
    const button = container.querySelector<HTMLButtonElement>('[data-testid="teammates.item.mac.bot-1"]');
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    expect(h.push).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/sessions/[sessionId]', params: expect.objectContaining({ sessionId: 'chat-1', resourceId: 'bot-1' }) }));
    expect(h.markRead).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); }
});


it('serializes bursts of generation pushes on the resource route and preserves the final refresh', async () => {
  h.list.mockClear();
  let settle!: (value: unknown) => void;
  h.list.mockReturnValue(new Promise(resolve => { settle = resolve; }));
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(RemoteCollectionScreen)));
    const notify = h.link.onRemoteResourceChanged.mock.calls.at(-1)![0];
    await act(async () => { for (let n = 0; n < 20; n++) notify('mac', { collectionId: 'teammates' }); });
    expect(h.list).toHaveBeenCalledTimes(1);
    h.list.mockResolvedValue({ items: [h.item] });
    await act(async () => settle({ items: [] }));
    expect(h.list).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="teammates.item.mac.bot-1"]')).not.toBeNull();
    const list = container.querySelector<HTMLDivElement>('[data-list]')!; list.scrollTop = 120;
    // A queued refresh must not issue another RPC after leaving the route.
    h.list.mockReturnValue(new Promise(resolve => { settle = resolve; }));
    await act(async () => { notify('mac', { collectionId: 'teammates' }); notify('mac', { collectionId: 'teammates' }); });
    expect(container.querySelector('[data-list]')).toBe(list);
    expect(list.scrollTop).toBe(120);
    expect(container.querySelector('[data-testid="teammates.item.mac.bot-1"]')).not.toBeNull();
    act(() => root.unmount());
    await act(async () => settle({ items: [] }));
    expect(h.list).toHaveBeenCalledTimes(3);
  } finally { act(() => root.unmount()); }
});
