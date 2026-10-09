// @vitest-environment jsdom
import { act, createElement as el } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ awaiting: new Set<string>() }));
vi.mock('react-native', () => ({
  View: ({ children, testID, style }: any) => el('div', { 'data-testid': testID, style: Object.assign({}, ...[style].flat().filter(Boolean)) }, children),
  Pressable: ({ children, testID, accessibilityLabel, disabled, onPress, style }: any) => el('button', { 'data-testid': testID, 'aria-label': accessibilityLabel, disabled, onClick: onPress,
    style: Object.assign({}, ...[typeof style === 'function' ? style({ pressed: false }) : style].flat().filter(Boolean)) }, children),
  ActivityIndicator: () => null, RefreshControl: () => null, Image: () => null,
  Animated: { View: ({ children, testID }: any) => el('div', { 'data-testid': testID }, children), Value: class { setValue() {} }, timing: () => ({ start() {}, stop() {} }), loop: () => ({ start() {}, stop() {} }), sequence: () => ({}) },
  Easing: { inOut: () => undefined, ease: undefined },
  StyleSheet: { create: (v: unknown) => v, hairlineWidth: 1 },
  FlatList: ({ ListHeaderComponent, ListEmptyComponent, data, renderItem }: any) => el('div', null, ListHeaderComponent, data.length ? data.map((item: any) => renderItem({ item })) : ListEmptyComponent),
}));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: async () => ({ blocks: [] }) }) }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: {
  subscribe: () => () => {},
  getSessionLiveActivity: (id: string) => h.awaiting.has(id) ? { phase: 'needs-interaction' } : null,
  getPendingInteractions: () => [],
} }));
vi.mock('@/hooks/useReduceMotion', () => ({ useReduceMotionEnabled: () => true }));
vi.mock('@/session/CompanionPresenceRing', () => ({ CompanionPresenceRing: ({ active }: any) => active ? el('i', { 'data-testid': 'ring' }) : null }));
vi.mock('@/session/SessionRightSpinner', () => ({ SessionRightSpinner: ({ testID }: any) => el('i', { 'data-testid': testID }) }));
vi.mock('@/session/BotGroupList', () => ({ OFFLINE_AVATAR_OPACITY: 0.45,
  BotGroupListRow: ({ row, onPress }: any) => el('button', { 'data-testid': `group.${row.item.ref.id}`, onClick: onPress }, row.item.display.title) }));
vi.mock('@/components/AppText', () => ({ Text: ({ children, testID }: any) => el('span', { 'data-testid': testID }, children), TextInput: ({ testID, autoFocus }: any) => el('input', { 'data-testid': testID, 'data-autofocus': String(autoFocus) }) }));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowEmptyState: ({ title, copy }: any) => el('div', null, title, copy),
  RemoteListSyncingPlaceholder: ({ testID }: any) => el('div', { 'data-testid': testID }),
  StatusDot: ({ tone }: any) => el('i', { 'data-testid': 'status-dot', 'data-tone': tone }) }));
vi.mock('@/components/RemoteCompanionAvatar', () => ({ RemoteCompanionAvatar: () => null }));
vi.mock('lucide-react-native', () => ({ RefreshCw: () => null, Search: () => null, X: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  const colors = { ...tokens.lightColors, statusDone: 'green', statusError: 'red', textTertiary: 'gray' };
  return { ...tokens, useThemedStyles: (factory: (value: typeof colors) => unknown) => factory(colors), useTheme: () => ({ colors }) };
});
vi.mock('@/session/WorkingStatusText', () => ({ WorkingStatusText: ({ text }: any) => el('span', null, text) }));
vi.mock('@/device-link/remoteResourceCache', () => ({ isRemoteResourceUnread: () => false }));
vi.mock('@/session/sessionList', () => ({ formatRemoteSessionSidebarTime: () => '' }));
vi.mock('@/utils/useMinuteNow', () => ({ useMinuteNow: () => Date.now() }));
import { TeammateList } from '../session/TeammateList';
it('shows the localized cloud configuration error even alongside cached teammate rows', async () => {
  await act(async () => root.render(el(TeammateList, { items: [item], error: 'CHAT_ENDPOINT_UNAVAILABLE', isOnline: () => false,
    loading: false, refreshing: false, onRefresh: vi.fn(), onSelect: vi.fn(), embedded: true })));
  expect(node.querySelector('[data-testid="teammates.error"]')?.textContent).toBe('groupChat.server.endpointUnavailable');
});
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
  // Desktop parity: the cached reply stays readable while the host is offline.
  expect(node.textContent).toContain('Last reply');
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

it('shows shared public generation instead of raw preview without changing online dot', async () => {
  const busy = { ...item, item: { ...item.item, display: { ...item.item.display,
    preview: 'Raw tool commentary', generation: { phase: 'replying', startedAt: 1 } } } };
  await act(async () => root.render(el(TeammateList, { items: [busy], error: null, isOnline: () => true,
    loading: false, refreshing: false, onRefresh: vi.fn(), onSelect: vi.fn(), embedded: true })));
  expect(node.textContent).toContain('devices.companions.working.replying');
  expect(node.textContent).not.toContain('Raw tool commentary');
  expect(node.querySelector('[data-testid="teammate.connection"] [data-testid="status-dot"]')?.getAttribute('data-tone')).toBe('ready');
  await render(null, false);
  expect(node.querySelector('[data-testid="teammate.connection"] [data-testid="status-dot"]')?.getAttribute('data-tone')).toBe('off');
  expect(node.textContent).not.toContain('devices.companions.working.replying');
  await render('Model error', true);
  expect(node.querySelector('[data-testid="teammate.connection"] [data-testid="status-dot"]')?.getAttribute('data-tone')).toBe('ready');
});

it('keeps the connection green when the list cannot be used, and unknown neutral', async () => {
  for (const connected of [true, null]) {
    await act(async () => root.render(el(TeammateList, { items: [item], error: 'API failed', isOnline: () => false,
      connectionState: () => connected, loading: false, refreshing: false, onRefresh: vi.fn(), onSelect: vi.fn(), embedded: true })));
    expect(node.textContent).not.toContain('devices.resources.hostOffline');
    const tone = node.querySelector('[data-testid="teammate.connection"] [data-testid="status-dot"]')?.getAttribute('data-tone');
    expect(tone).not.toBe('off');
    if (connected) expect(tone).toBe('ready');
    else {
      expect(tone).toBe('muted');
      expect(node.textContent).toContain('devices.resources.connectionUnknown');
    }
  }
});

it('falls back to the description, then an invitation, and flags a teammate that needs attention', async () => {
  const described = { ...item, key: 'host:described', item: { ...item.item, ref: { ...item.item.ref, id: 'described' },
    display: { title: 'Aster', subtitle: 'Weekly reports' } } };
  const empty = { ...item, key: 'host:empty', item: { ...item.item, ref: { ...item.item.ref, id: 'empty' },
    display: { title: 'Nova', status: { label: 'Needs attention', tone: 'warning' } } } };
  await act(async () => root.render(el(TeammateList, { items: [described, empty], error: null, isOnline: () => true,
    loading: false, refreshing: false, onRefresh: vi.fn(), onSelect: vi.fn(), embedded: true })));
  expect(node.textContent).toContain('Weekly reports');
  expect(node.textContent).toContain('devices.companions.startChat');
  // Attention reads as words before the preview (no colored flag in the time slot).
  const flags = node.querySelectorAll('[data-testid="teammate.attention"]');
  expect(flags).toHaveLength(1);
  expect(flags[0].textContent).toBe('Needs attention · ');
});

it('keeps every row 78pt with the divider on the text column, none under the last row', async () => {
  const second = { ...item, key: 'host:second', item: { ...item.item, ref: { ...item.item.ref, id: 'second' }, display: { title: 'Aster', preview: 'Hi' } } };
  await act(async () => root.render(el(TeammateList, { items: [item, second], error: null, isOnline: () => true,
    loading: false, refreshing: false, onRefresh: vi.fn(), onSelect: vi.fn(), embedded: true })));
  const rows = [...node.querySelectorAll('[data-testid^="teammates.item."]')] as HTMLElement[];
  expect(rows.map((row) => row.style.height)).toEqual(['78px', '78px']);
  const bodies = rows.map((row) => row.children[1] as HTMLElement);
  expect(bodies[0].style.borderBottomWidth).toBe('1px');
  expect(bodies[1].style.borderBottomWidth).toBe('');
});

it('shows the computer name only when two teammates share a name, on the title line', async () => {
  const twin = { ...item, key: 'other:bot', host: { deviceId: 'other', deviceName: 'Office iMac' } };
  await act(async () => root.render(el(TeammateList, { items: [item, twin], error: null, isOnline: () => true,
    loading: false, refreshing: false, onRefresh: vi.fn(), onSelect: vi.fn(), embedded: true })));
  expect(node.textContent).toContain('· Computer identity');
  expect(node.textContent).toContain('· Office iMac');
});

it('prefixes a teammate stopped on a question or permission with 「等你确认」', async () => {
  const waiting = { ...item, item: { ...item.item, links: [{ rel: 'conversation', target: { kind: 'session' as const, sessionId: 's1' } }] } };
  h.awaiting = new Set(['s1']);
  await act(async () => root.render(el(TeammateList, { items: [waiting], error: null, isOnline: () => true,
    loading: false, refreshing: false, onRefresh: vi.fn(), onSelect: vi.fn(), embedded: true })));
  expect(node.textContent).toContain('devices.companions.awaiting · Last reply');
  h.awaiting = new Set();
});

it('mixes group chats into the list by latest activity', async () => {
  const older = { ...item, item: { ...item.item, display: { title: 'Mimi', preview: 'Old', timestamp: 1 } } };
  const group = { key: 'host:g1', host: item.host, item: { ref: { collectionId: 'bot-groups', kind: 'bot-group', id: 'g1' }, revision: '1', links: [],
    display: { title: 'Launch', timestamp: 5 } } };
  const onGroup = vi.fn();
  await act(async () => root.render(el(TeammateList, { items: [older], error: null, isOnline: () => true,
    loading: false, refreshing: false, onRefresh: vi.fn(), onSelect: vi.fn(), embedded: true,
    groups: { items: [group], isOnline: () => true, onSelect: onGroup } })));
  const order = [...node.querySelectorAll('[data-testid^="teammates.item."], [data-testid^="group."]')].map((entry) => entry.getAttribute('data-testid'));
  expect(order).toEqual(['group.g1', 'teammates.item.host.bot']);
  await act(async () => (node.querySelector('[data-testid="group.g1"]') as HTMLButtonElement).click());
  expect(onGroup).toHaveBeenCalledWith(group);
});
