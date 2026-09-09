// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  push: vi.fn(), markRead: vi.fn(),
  params: { collectionId: 'teammates', targets: JSON.stringify([{ deviceId: 'mac', deviceName: 'My Mac' }]) },
  translation: { t: (key: string) => key, i18n: { language: 'en' } },
  link: { connectionEpoch: 1, status: 'online', presenceVersion: 1, getPresenceAvailability: () => true, invoke: vi.fn(), onRemoteResourceChanged: () => () => {}, subscribe: vi.fn(), unsubscribe: vi.fn() },
  item: { ref: { collectionId: 'teammates', kind: 'bot', id: 'bot-1' }, revision: '1', display: { title: 'Writer', preview: 'Unread reply', lastReplyAt: 200 } },
}));
vi.mock('react-native', async () => {
  const { createElement: el, Fragment } = await import('react');
  const view = ({ children, testID }: any) => el('div', { 'data-testid': testID }, children);
  return {
    View: view, ActivityIndicator: view, RefreshControl: () => null,
    Pressable: ({ children, testID, onPress, disabled }: any) => el('button', { 'data-testid': testID, onClick: onPress, disabled }, children),
    FlatList: ({ data, renderItem, ListEmptyComponent }: any) => data.length ? el(Fragment, {}, ...data.map((item: any) => el(Fragment, { key: item.key }, renderItem({ item })))) : ListEmptyComponent,
    StyleSheet: { create: (styles: unknown) => styles },
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  };
});
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return { useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]), useLocalSearchParams: () => h.params, useRouter: () => ({}) };
});
vi.mock('react-i18next', () => ({ useTranslation: () => h.translation }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'div' }));
vi.mock('lucide-react-native', () => ({ ChevronRight: () => null }));
vi.mock('@/components/AppText', () => ({ Text: 'span' }));
vi.mock('@/components/RemoteCompanionAvatar', () => ({ RemoteCompanionAvatar: () => null }));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowEmptyState: () => null, StatusDot: () => null }));
vi.mock('@/platform/chrome', () => ({ SimpleStackHeader: () => null, simpleScreenSafeAreaEdges: () => [] }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner' }, accountGeneration: 1 }) }));
vi.mock('@/device-link/remoteStatus', () => ({ formatRemoteError: String }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => h.link }));
vi.mock('@/theme', () => ({ useThemedStyles: () => ({}), useTheme: () => ({ colors: {} }) }));
vi.mock('@/utils/useGuardedPush', () => ({ useGuardedPush: () => h.push }));
vi.mock('@/device-link/focusedTopicSubscription', () => ({ startFocusedTopicSubscription: () => () => {} }));
vi.mock('@/device-link/remoteResourceAvailability', () => ({ isRemoteResourceHostOnline: () => true, readRemoteCollectionCache: () => [], writeRemoteCollectionCache: () => {} }));
vi.mock('@/device-link/remoteResourceCache', () => ({
  cacheRemoteResourceItems: vi.fn(), readRemoteResourceSnapshot: async () => ({ items: {} }),
  isRemoteResourceUnread: () => true, markRemoteResourceRead: h.markRead,
  subscribeRemoteResourceCache: () => () => {}, remoteResourceCacheRevision: () => 0,
}));
vi.mock('@/device-link/remoteResources', async (original) => ({
  ...await original<typeof import('@/device-link/remoteResources')>(),
  listRemoteCollection: async () => ({ collectionId: 'teammates', revision: '1', items: [h.item] }),
}));
import RemoteCollectionScreen from '../../app/resources/[collectionId]';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it('opening a companion only navigates; unread survives until the destination confirms content display', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(RemoteCollectionScreen)));
    const button = container.querySelector<HTMLButtonElement>('[data-testid="remoteResources.item.bot-1"]');
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    expect(h.push).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/resources/[collectionId]/[resourceId]' }));
    expect(h.markRead).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); }
});
