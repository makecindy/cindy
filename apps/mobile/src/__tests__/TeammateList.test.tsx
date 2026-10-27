// @vitest-environment jsdom
import { act, createElement as el } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ awaiting: new Set<string>(), unread: new Set<string>(),
  listeners: new Set<() => void>(), rowRenders: [] as string[] }));
vi.mock('react-native', () => ({
  View: ({ children, testID, style }: any) => el('div', { 'data-testid': testID, style: Object.assign({}, ...[style].flat().filter(Boolean)) }, children),
  Pressable: ({ children, testID, accessibilityLabel, disabled, onPress, style }: any) => {
    if (testID?.startsWith('teammates.item.')) h.rowRenders.push(testID);
    return el('button', { 'data-testid': testID, 'aria-label': accessibilityLabel, disabled, onClick: onPress,
      style: Object.assign({}, ...[typeof style === 'function' ? style({ pressed: false }) : style].flat().filter(Boolean)) }, children);
  },
  StyleSheet: { create: (v: unknown) => v, hairlineWidth: 1 },
}));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: async () => ({ blocks: [] }) }) }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: {
  subscribe: (listener: () => void) => { h.listeners.add(listener); return () => { h.listeners.delete(listener); }; },
  getSessionLiveActivity: (id: string) => h.awaiting.has(id) ? { phase: 'needs-interaction' } : null,
  getPendingInteractions: () => [],
} }));
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
vi.mock('@/device-link/remoteResourceCache', () => ({ isRemoteResourceUnread: (_owner: string, _device: string, id: string) => h.unread.has(id) }));
vi.mock('@/session/sessionList', () => ({ formatRemoteSessionSidebarTime: () => '' }));
vi.mock('@/utils/useMinuteNow', () => ({ useMinuteNow: () => Date.now() }));
import { useTeammateEntries, useTeammateRowRenderer } from '../session/TeammateList';
import * as markdown from '../session/messageMarkdown';
/** The task home section's rows: the same entries and row renderer, without the section chrome. */
function Rows(props: Parameters<typeof useTeammateRowRenderer>[0]) {
  const entries = useTeammateEntries(props.items, props.groups?.items);
  const render = useTeammateRowRenderer(props);
  return el('div', null, entries.map((entry, index) => render(entry, index === entries.length - 1)));
}
const item = { key: 'host:bot', host: { deviceId: 'host', deviceName: 'Computer identity' }, item: {
  ref: { collectionId: 'teammates', kind: 'bot', id: 'bot' }, revision: '1', links: [], display: { title: 'Mimi', preview: 'Last reply' },
} };
let root: Root; let node: HTMLDivElement;
beforeEach(() => { h.rowRenders = []; h.awaiting.clear(); h.unread.clear(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); node = document.createElement('div'); root = createRoot(node); });
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks(); });
async function render(online = true) {
  await act(async () => root.render(el(Rows, { items: [item], isOnline: () => online, onSelect: vi.fn() })));
}
it('marks an offline teammate in words, without device identity', async () => {
  await render(false);
  expect(node.textContent).not.toMatch(/Computer identity/);
  expect(node.textContent).toContain('devices.resources.hostOffline');
  // Desktop parity: the cached reply stays readable while the host is offline.
  expect(node.textContent).toContain('Last reply');
});
it('shows readable message previews rather than Markdown delimiters or link targets', async () => {
  const formatted = { ...item, item: { ...item.item, display: {
    title: 'Mimi', preview: '**Ready** — [Weekly brief](https://example.com/brief)\n`notes.md`',
  } } };
  await act(async () => root.render(el(Rows, { items: [formatted], isOnline: () => true,
    onSelect: vi.fn() })));
  expect(node.textContent).toContain('Ready — Weekly brief notes.md');
  expect(node.textContent).not.toMatch(/\*\*|https:\/\/|`/);
});

it('shows shared public generation instead of raw preview without changing online dot', async () => {
  const busy = { ...item, item: { ...item.item, display: { ...item.item.display,
    preview: 'Raw tool commentary', generation: { phase: 'replying', startedAt: 1 } } } };
  await act(async () => root.render(el(Rows, { items: [busy], isOnline: () => true,
    onSelect: vi.fn() })));
  expect(node.textContent).toContain('devices.companions.working.replying');
  expect(node.textContent).not.toContain('Raw tool commentary');
  expect(node.querySelector('[data-testid="teammate.connection"] [data-testid="status-dot"]')?.getAttribute('data-tone')).toBe('ready');
  await render(false);
  expect(node.querySelector('[data-testid="teammate.connection"] [data-testid="status-dot"]')?.getAttribute('data-tone')).toBe('off');
  expect(node.textContent).not.toContain('devices.companions.working.replying');
});

it('keeps the connection green while the roster is unverified, and unknown neutral', async () => {
  for (const connected of [true, null]) {
    await act(async () => root.render(el(Rows, { items: [item], isOnline: () => false,
      connectionState: () => connected, onSelect: vi.fn() })));
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
  await act(async () => root.render(el(Rows, { items: [described, empty], isOnline: () => true,
    onSelect: vi.fn() })));
  expect(node.textContent).toContain('Weekly reports');
  expect(node.textContent).toContain('devices.companions.startChat');
  // Attention reads as words before the preview (no colored flag in the time slot).
  const flags = node.querySelectorAll('[data-testid="teammate.attention"]');
  expect(flags).toHaveLength(1);
  expect(flags[0].textContent).toBe('Needs attention · ');
});

it('keeps every row 78pt with the divider on the text column, none under the last row', async () => {
  const second = { ...item, key: 'host:second', item: { ...item.item, ref: { ...item.item.ref, id: 'second' }, display: { title: 'Aster', preview: 'Hi' } } };
  await act(async () => root.render(el(Rows, { items: [item, second], isOnline: () => true,
    onSelect: vi.fn() })));
  const rows = [...node.querySelectorAll('[data-testid^="teammates.item."]')] as HTMLElement[];
  expect(rows.map((row) => row.style.height)).toEqual(['78px', '78px']);
  const bodies = rows.map((row) => row.children[1] as HTMLElement);
  expect(bodies[0].style.borderBottomWidth).toBe('1px');
  expect(bodies[1].style.borderBottomWidth).toBe('');
});

it('shows the computer name only when two teammates share a name, on the title line', async () => {
  const twin = { ...item, key: 'other:bot', host: { deviceId: 'other', deviceName: 'Office iMac' } };
  await act(async () => root.render(el(Rows, { items: [item, twin], isOnline: () => true,
    onSelect: vi.fn() })));
  expect(node.textContent).toContain('· Computer identity');
  expect(node.textContent).toContain('· Office iMac');
});

// #7237 / unit: two equally named teammates on ID-as-name hosts. The existing
// named-host case missed identical fallback suffixes; press must keep its host.
it('distinguishes unnamed teammate hosts in visible and accessible labels', async () => {
  const rows = ['host-b', 'host-a'].map(deviceId => ({ ...item, key: `${deviceId}:bot`,
    host: { deviceId, deviceName: deviceId } }));
  const onSelect = vi.fn();
  await act(async () => root.render(el(Rows, { items: rows, isOnline: () => true, onSelect })));
  for (const [id, ordinal] of [['host-a', 1], ['host-b', 2]] as const) {
    const row = node.querySelector(`[data-testid="teammates.item.${id}.bot"]`) as HTMLButtonElement;
    expect(row.textContent).toContain(`another computer (${ordinal})`);
    expect(row.getAttribute('aria-label')).toContain(`another computer (${ordinal})`);
    await act(async () => row.click());
    expect(onSelect).toHaveBeenLastCalledWith(rows.find(item => item.host.deviceId === id));
  }
});

it('prefixes a teammate stopped on a question or permission with 「等你确认」', async () => {
  const waiting = { ...item, item: { ...item.item, links: [{ rel: 'conversation', target: { kind: 'session' as const, sessionId: 's1' } }] } };
  h.awaiting = new Set(['s1']);
  await act(async () => root.render(el(Rows, { items: [waiting], isOnline: () => true,
    onSelect: vi.fn() })));
  expect(node.textContent).toContain('devices.companions.awaiting · Last reply');
  h.awaiting = new Set();
});

it('mixes group chats into the list by latest activity', async () => {
  const older = { ...item, item: { ...item.item, display: { title: 'Mimi', preview: 'Old', timestamp: 1 } } };
  const group = { key: 'host:g1', host: item.host, item: { ref: { collectionId: 'bot-groups', kind: 'bot-group', id: 'g1' }, revision: '1', links: [],
    display: { title: 'Launch', timestamp: 5 } } };
  const onGroup = vi.fn();
  await act(async () => root.render(el(Rows, { items: [older], isOnline: () => true,
    onSelect: vi.fn(),
    groups: { items: [group], isOnline: () => true, onSelect: onGroup } })));
  const order = [...node.querySelectorAll('[data-testid^="teammates.item."], [data-testid^="group."]')].map((entry) => entry.getAttribute('data-testid'));
  expect(order).toEqual(['group.g1', 'teammates.item.host.bot']);
  await act(async () => (node.querySelector('[data-testid="group.g1"]') as HTMLButtonElement).click());
  expect(onGroup).toHaveBeenCalledWith(group);
});


it.each([false, null, true])('opens cached teammates while connection evidence is %s and the roster is unverified', async connected => {
  const select = vi.fn();
  await act(async () => root.render(el(Rows, { items: [item], isOnline: () => false,
    connectionState: () => connected, onSelect: select })));
  const button = node.querySelector<HTMLButtonElement>('[data-testid="teammates.item.host.bot"]')!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(select).toHaveBeenCalledExactlyOnceWith(item);
  if (connected === true) expect(button.textContent).not.toContain('devices.resources.hostOffline');
});

it('keeps a cloud companion quiet while its main computer looks offline: no offline text, dot or dimming', async () => {
  await act(async () => root.render(el(Rows, { items: [item], isOnline: () => false, quietPresence: () => true,
    onSelect: vi.fn() })));
  expect(node.textContent).not.toContain('devices.resources.hostOffline');
  expect(node.querySelector('[data-testid="teammate.connection"] [data-testid="status-dot"]')).toBeNull();
});

/**
 * Performance regression through the production row renderer (unit, no timing budget):
 * existing visual cases never refresh a roster with new-but-equal objects/callbacks.
 * Two rows and one changed reply suffice to expose unnecessary native-row renders;
 * clicking the retained row must still navigate with the latest resource and handler.
 */
it('only redraws the changed teammate after a roster refresh and opens the latest resource', async () => {
  const parse = vi.spyOn(markdown, 'parseMobileMarkdownInlines');
  const second = { ...item, key: 'host:second', item: { ...item.item,
    ref: { ...item.item.ref, id: 'second' }, display: { title: 'Aster', preview: 'Unchanged' } } };
  const firstSelect = vi.fn();
  await act(async () => root.render(el(Rows, { items: [item, second], isOnline: () => true, onSelect: firstSelect })));
  h.rowRenders = [];
  parse.mockClear();
  const fresh = structuredClone([item, second]);
  // A new revision/link is navigation data, even when no visible field changed.
  fresh[1].item.revision = '2';
  fresh[1].item.links = [{ rel: 'conversation', target: { kind: 'session', sessionId: 'latest' } }] as any;
  const latestSelect = vi.fn();
  await act(async () => root.render(el(Rows, { items: fresh, isOnline: () => true, onSelect: latestSelect })));
  expect(h.rowRenders).toEqual([]);
  expect(parse).not.toHaveBeenCalled();
  fresh[0] = { ...fresh[0], item: { ...fresh[0].item, display: { title: 'Mimi', preview: '**New reply**' } } };
  await act(async () => root.render(el(Rows, { items: [...fresh], isOnline: () => true, onSelect: latestSelect })));
  expect(h.rowRenders).toEqual(['teammates.item.host.bot']);
  expect(parse).toHaveBeenCalledExactlyOnceWith('**New reply**');
  expect(node.textContent).toContain('New reply');
  expect(node.textContent).toContain('Unchanged');
  await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="teammates.item.host.second"]')!.click());
  expect(latestSelect).toHaveBeenCalledExactlyOnceWith(fresh[1]);
  expect(firstSelect).not.toHaveBeenCalled();
  // The ordering helper deduplicates by retaining the last resource snapshot.
  const duplicate = { ...fresh[1], item: { ...fresh[1].item, revision: '3' } };
  await act(async () => root.render(el(Rows, { items: [...fresh, duplicate], isOnline: () => true, onSelect: latestSelect })));
  await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="teammates.item.host.second"]')!.click());
  expect(latestSelect).toHaveBeenLastCalledWith(duplicate);
});

// A retained row must still reflect live interaction, read acknowledgement and
// connectivity changes; none changes the cached preview's Markdown input.
it('updates waiting, unread and connection states without reparsing the reply', async () => {
  const parse = vi.spyOn(markdown, 'parseMobileMarkdownInlines');
  const waiting = { ...item, item: { ...item.item,
    links: [{ rel: 'conversation', target: { kind: 'session' as const, sessionId: 's1' } }] } };
  const props = { items: [waiting], isOnline: () => true, onSelect: vi.fn() };
  await act(async () => root.render(el(Rows, props)));
  parse.mockClear();
  await act(async () => { h.awaiting.add('s1'); h.listeners.forEach(listener => listener()); });
  expect(node.textContent).toContain('devices.companions.awaiting · Last reply');
  h.unread.add('bot');
  await act(async () => root.render(el(Rows, { ...props })));
  expect(node.querySelector('[data-testid="companion.row.unread"]')).not.toBeNull();
  h.unread.clear();
  await act(async () => root.render(el(Rows, { ...props, isOnline: () => false })));
  expect(node.querySelector('[data-testid="companion.row.unread"]')).toBeNull();
  expect(node.textContent).toContain('devices.resources.hostOffline · Last reply');
  expect(node.textContent).not.toContain('devices.companions.awaiting');
  expect(parse).not.toHaveBeenCalled();
});
