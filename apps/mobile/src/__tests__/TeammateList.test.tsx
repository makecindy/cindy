// @vitest-environment jsdom
import { act, createElement as el } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('react-native', () => ({
  View: ({ children, testID }: any) => el('div', { 'data-testid': testID }, children),
  Pressable: ({ children, testID, accessibilityLabel, disabled, onPress }: any) => el('button', { 'data-testid': testID, 'aria-label': accessibilityLabel, disabled, onClick: onPress }, children),
  ActivityIndicator: () => null, RefreshControl: () => null,
  StyleSheet: { create: (v: unknown) => v, hairlineWidth: 1 },
  FlatList: ({ ListHeaderComponent, ListEmptyComponent, data, renderItem }: any) => el('div', null, ListHeaderComponent, data.length ? data.map((item: any) => renderItem({ item })) : ListEmptyComponent),
}));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => el('span', null, children), TextInput: () => null }));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowEmptyState: ({ title, copy }: any) => el('div', null, title, copy) }));
vi.mock('@/components/RemoteCompanionAvatar', () => ({ RemoteCompanionAvatar: () => null }));
vi.mock('lucide-react-native', () => ({ RefreshCw: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }));
vi.mock('@/theme', () => ({ useThemedStyles: () => ({}), useTheme: () => ({ colors: {} }) }));
vi.mock('@/device-link/remoteResourceCache', () => ({ isRemoteResourceUnread: () => false }));
vi.mock('@/session/sessionList', () => ({ formatRemoteSessionSidebarTime: () => '' }));
vi.mock('@/utils/useMinuteNow', () => ({ useMinuteNow: () => Date.now() }));
import { TeammateList } from '../session/TeammateList';
const item = { key: 'host:bot', host: { deviceId: 'host', deviceName: 'Computer identity' }, item: {
  ref: { collectionId: 'teammates', kind: 'bot', id: 'bot' }, revision: '1', links: [], display: { title: 'Mimi', preview: 'Last reply' },
} };
let root: Root; let node: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); node = document.createElement('div'); root = createRoot(node); });
afterEach(async () => { await act(async () => root.unmount()); });
async function render(error: string | null, online = true) {
  await act(async () => root.render(el(TeammateList, { items: [item], error, isOnline: () => online, loading: false, refreshing: false, onRefresh: vi.fn(), onSelect: vi.fn(), embedded: true })));
}
it('shows no retry button merely because the list is embedded in a picker', async () => {
  await render(null);
  expect(node.querySelector('[data-testid="teammates.refresh"]')).toBeNull();
  expect(node.textContent).toContain('Last reply');
});
it('uses a concise recovery notice, not device IDs or transport diagnostics', async () => {
  await render('[DEVICE_UNRESPONSIVE] private-device-id is unresponsive (circuit open)', false);
  expect(node.textContent).toContain('devices.companions.stale');
  expect(node.textContent).not.toMatch(/private-device-id|DEVICE_UNRESPONSIVE|circuit open|Computer identity/);
  expect(node.querySelector('[data-testid="teammates.refresh"]')).not.toBeNull();
  expect(node.textContent).toContain('devices.resources.hostOffline');
  expect(node.textContent).not.toContain('Last reply');
});
it('shows readable message previews rather than Markdown delimiters or link targets', async () => {
  const formatted = { ...item, item: { ...item.item, display: {
    title: 'Mimi', preview: '**Ready** — [Weekly brief](https://example.com/brief)\n`notes.md`',
  } } };
  await act(async () => root.render(el(TeammateList, { items: [formatted], error: null, isOnline: () => true,
    loading: false, refreshing: false, onRefresh: vi.fn(), onSelect: vi.fn(), embedded: true })));
  expect(node.textContent).toContain('Ready — Weekly brief notes.md');
  expect(node.textContent).not.toMatch(/\*\*|https:\/\/|`/);
});
