// @vitest-environment jsdom
import { act, createContext, createElement as el, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ cloudRefresh: vi.fn(async () => {}), cloudError: null as string | null, push: vi.fn(),
  openTeammate: vi.fn(async (_row: unknown) => {}),
  cloudActor: null as null | { id: string }, createOptions: null as any, collapsed: false, showAvatars: true, unread: false,
  cacheRevision: 0, cacheListeners: new Set<() => void>(), unreadIds: new Set<string>(),
  stripRenders: [] as string[], avatarRenders: [] as string[], identityReads: 0,
  buddySets: { version: 1 as const, sets: [] as Array<{ buddySetId: string; name: string; buddyIds: string[]; collapsed?: boolean }> },
  buddySetsStatus: 'ready' as string, buddySetsSaveFailed: false,
  updateBuddySets: vi.fn(), retryBuddySets: vi.fn(), retrySaveBuddySets: vi.fn() }));
vi.mock('@/session/useBuddySets', () => ({
  useBuddySets: () => [h.buddySets, h.updateBuddySets, h.buddySetsStatus,
    h.retryBuddySets, h.buddySetsSaveFailed, h.retrySaveBuddySets],
}));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: { subscribe: () => () => {}, getPendingInteractions: () => [], getSessionLiveActivity: () => null } }));
vi.mock('react-native', () => ({
  View: ({ children, testID }: any) => el('div', { 'data-testid': testID }, children),
  ScrollView: ({ children, testID }: any) => el('div', { 'data-testid': testID }, children),
  Pressable: ({ children, testID, disabled, onPress, onPressIn, accessibilityLabel }: any) => {
    if (testID?.startsWith('home.teammatesStrip.bot.')) h.stripRenders.push(testID);
    return el('button', { 'data-testid': testID, disabled, onClick: onPress, onMouseDown: onPressIn, 'aria-label': accessibilityLabel }, children);
  },
  ActivityIndicator: () => el('i', { 'data-testid': 'spinner' }),
  Keyboard: { dismiss: () => {} },
  StyleSheet: { create: (v: unknown) => v, hairlineWidth: 1 },
}));
vi.mock('expo-router/react-navigation', () => ({
  NavigationContext: createContext(null), NavigationRouteContext: createContext(null), useIsFocused: () => true,
}));
vi.mock('expo-router', () => ({ useFocusEffect: () => {} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('lucide-react-native', () => ({ ChevronDown: () => null, ChevronRight: () => null, ChevronUp: () => null, Plus: () => null, RefreshCw: () => null, UsersRound: () => null }));
vi.mock('@/chat/chatInviteIntent', () => ({ openManualChatInvite: vi.fn() }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }));
vi.mock('@/components/AppText', () => ({ Text: ({ children, testID }: any) => el('span', { 'data-testid': testID }, children) }));
vi.mock('@/components/RemoteCompanionAvatar', () => ({ RemoteCompanionAvatar: ({ name, avatar }: any) => {
  h.avatarRenders.push(name);
  return el('i', { 'data-testid': `avatar.${name}` }, avatar?.value);
} }));
vi.mock('@/chat/cloudCompanion', () => ({ CLOUD_ROW_REVISION: 'cloud', cloudActorForRow: () => h.cloudActor, cloudCompanionRows: (items: unknown) => items }));
vi.mock('@/session/teammateNavigation', () => ({ cloudCompanionRoute: () => '/cloud-chat' }));
vi.mock('@/session/botGroupNavigation', () => ({ botGroupRoute: () => '/group-chat' }));
vi.mock('@/chat/useCloudCompanion', () => ({ useCloudCompanionHome: () => ({ supported: true, actors: [], deviceNames: {}, error: h.cloudError, refresh: h.cloudRefresh }) }));
vi.mock('@/device-link/remoteResourceCache', () => ({
  isRemoteResourceUnread: (_owner: string, _device: string, id: string) => h.unread || h.unreadIds.has(id),
  remoteResourceCacheRevision: () => h.cacheRevision,
  subscribeRemoteResourceCache: (listener: () => void) => { h.cacheListeners.add(listener); return () => { h.cacheListeners.delete(listener); }; },
}));
vi.mock('@/utils/useGuardedPush', () => ({ useGuardedPush: () => h.push }));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  const colors = tokens.lightColors;
  return { ...tokens, useThemedStyles: (factory: (value: typeof colors) => unknown) => factory(colors), useTheme: () => ({ colors }) };
});
vi.mock('@/session/BotGroupAvatars', () => ({ BotGroupDuoAvatar: () => null,
  useBotGroupIdentities: () => { h.identityReads++; return () => ({}); } }));
vi.mock('@/session/BotGroupList', () => ({ OFFLINE_AVATAR_OPACITY: 0.45 }));
vi.mock('@/session/CompanionListRow', () => ({ COMPANION_ROW_AVATAR_SIZE: 44, COMPANION_ROW_DOT_SIZE: 10 }));
vi.mock('@/session/CompanionPresenceRing', () => ({ CompanionPresenceRing: () => null }));
vi.mock('@/session/HomeRosterContext', () => ({ useHomeRoster: () => null }));
vi.mock('@/session/HomeListVisuals', () => ({ homeListStyles: () => ({}) }));
vi.mock('@/session/listDisclosureTransition', () => ({ DisclosureItem: ({ children, testID }: any) => el('div', { 'data-testid': testID }, children) }));
vi.mock('@/session/TeammateCreateController', () => ({ useTeammateCreateController: (options: any) => {
  h.createOptions = options;
  return { renderTrigger: (trigger: unknown) => trigger, press: () => {}, label: 'create', sheets: null };
} }));
// 「伙伴集」表单走原生 FormSheet 链;本用例只验证首页段落,与其它子表单一样用替身隔离。
vi.mock('@/session/BuddySetSheet', () => ({ BuddySetSheet: () => null }));
vi.mock('@/session/TeammateList', () => ({
  useTeammateEntries: (items: any[], groups: any[] = [], query = '') => [...items.map(row => ({ kind: 'bot', row })), ...groups.map(row => ({ kind: 'group', row }))].filter(entry => entry.row.item.display.title.includes(query)),
  useTeammateRowRenderer: (options: any) => (entry: any) => el('button', { key: entry.row.key,
    'data-testid': `row.${entry.kind}`, onClick: () => entry.kind === 'bot' ? options.onSelect(entry.row) : options.groups.onSelect(entry.row) }, entry.row.item.display.title),
}));
vi.mock('@/session/useTeammateNavigation', () => ({ useTeammateNavigation: () => ({
  owner: 'owner', teammatesCollapsed: h.collapsed, showCollapsedTeammateAvatars: h.showAvatars, lastTeammate: null,
  setTeammatesCollapsed: async () => {}, openTeammate: h.openTeammate, openCreatedTeammate: async () => {} }) }));
import { HomeTeammatesSection } from '../session/HomeTeammatesSection';
import { BuddySetGroups } from '../session/BuddySetGroups';
import { getHomeViewSession } from '../session/homeViewSession';
import { CONNECTION_NOTICE_DELAY_MS } from '../components/connectionNoticeDelay';

const item = { key: 'host:bot', host: { deviceId: 'host', deviceName: 'Mac' }, item: {
  ref: { collectionId: 'teammates', kind: 'bot', id: 'bot' }, revision: '1', links: [], display: { title: 'Mimi' } } };
const roster = { items: [item], createTargets: [], groupTargets: [], loading: false, refreshing: false, error: 'LIST_FAILED' as string | null,
  isOnline: () => true, connectionState: undefined, refresh: vi.fn(async () => {}) };
const groups = { items: [] as any[], supported: true, refreshing: false, error: null, isOnline: () => true, refresh: vi.fn(async () => {}) };
let root: Root; let node: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); node = document.createElement('div'); root = createRoot(node); vi.clearAllMocks(); h.cloudActor = null; vi.useFakeTimers(); roster.error = 'LIST_FAILED'; h.collapsed = false; h.showAvatars = true; h.unread = false; groups.items = [];
  h.cacheRevision = 0; h.unreadIds.clear(); h.stripRenders = []; h.avatarRenders = []; h.identityReads = 0;
  h.cloudError = null; getHomeViewSession().write('teammatesShowAll', false);
  h.buddySets = { version: 1, sets: [] }; h.buddySetsStatus = 'ready'; h.buddySetsSaveFailed = false;
  h.updateBuddySets.mockReset(); h.retryBuddySets.mockReset(); h.retrySaveBuddySets.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });
const render = (refreshKey: number, overrides: Partial<Parameters<typeof HomeTeammatesSection>[0]> = {}) => act(async () => root.render(el(HomeTeammatesSection, {
  context: { navigation: null, route: null, shared: { roster, groups } } as any, active: true, refreshKey,
  visible: true, query: '', showCollapsedAvatars: h.showAvatars, showFooter: false, runDisclosure: (apply: () => void) => apply(), prepareDisclosure: () => {},
  ...overrides,
})));
const byId = (id: string) => node.querySelector<HTMLElement>(`[data-testid="${id}"]`);

// Unit regression: a failed background read must not insert a row above cached teammates.
// The previous test required an immediate alert; now test the real delayed header action.
it('keeps cached teammates and offers a quiet header retry only for a lasting failure', async () => {
  await render(0);
  expect(node.textContent).toContain('Mimi');
  expect(byId('home.teammatesRetry')).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(CONNECTION_NOTICE_DELAY_MS));
  expect(byId('home.teammatesError')).toBeNull();
  expect(byId('home.teammatesRetry')?.getAttribute('aria-label')).toContain('devices.companions.stale');
  expect(byId('home.teammatesRetry')?.parentElement).toBe(byId('home.teammatesHeader')?.parentElement);
  h.cloudRefresh.mockClear();
  await act(async () => byId('home.teammatesRetry')!.click());
  expect(roster.refresh).toHaveBeenCalledTimes(1);
  expect(groups.refresh).not.toHaveBeenCalled();
  expect(h.cloudRefresh).not.toHaveBeenCalled();
  roster.error = null;
  await render(0);
  expect(byId('home.teammatesRetry')).toBeNull();
});

it('never flashes a recovered background error', async () => {
  await render(0);
  await act(async () => vi.advanceTimersByTimeAsync(CONNECTION_NOTICE_DELAY_MS - 1));
  roster.error = null;
  await render(0);
  await act(async () => vi.advanceTimersByTimeAsync(CONNECTION_NOTICE_DELAY_MS));
  expect(byId('home.teammatesRetry')).toBeNull();
  expect(byId('home.teammatesError')).toBeNull();
  expect(node.textContent).toContain('Mimi');
});

// Pull-to-refresh lives on the home list; it reaches the section's cloud companions through the key.
it('re-reads cloud companions on each manual home refresh', async () => {
  await render(0);
  h.cloudRefresh.mockClear();
  await render(1);
  expect(h.cloudRefresh).toHaveBeenCalledTimes(1);
});

// The new collapsed home must retain the chat receipt semantics of expanded rows:
// a thread can be unread after main is read, while a server-read room stays quiet.
it('uses server read receipts and thread unread state in the collapsed group strip', async () => {
  h.collapsed = true; h.showAvatars = true;
  const group = { ...item, key: 'host:group', chatUnread: { count: 1, threadCount: 1 },
    item: { ...item.item, ref: { collectionId: 'bot-groups', kind: 'bot-group', id: 'group' }, display: { title: 'Team' } } };
  groups.items = [group];
  await render(0);
  const cell = () => byId('home.teammatesStrip.group.host.group');
  expect(cell()?.querySelector('[data-testid="teammate.status.unread"]')).not.toBeNull();
  h.unread = true;
  group.chatUnread = { count: 0, threadCount: 0 };
  await render(0);
  expect(cell()?.querySelector('[data-testid="teammate.status.unread"]')).toBeNull();
  group.chatUnread = { count: 2, threadCount: 0 };
  await render(0);
  expect(cell()?.querySelector('[data-testid="teammate.status.unread"]')).not.toBeNull();
});

// PR #7079: unit-tier component coverage of the cloud/group routes that bypass the teammate hook.
// Existing coverage only refreshed the roster. A deferred host push must prevent navigation until
// drawer close; the creation receipt is a separate entry after its own sheet has already closed.
it.each(['cloud', 'group', 'created-group'] as const)('defers the %s route until the drawer closes', async kind => {
  let routeAfterClose: (() => void) | undefined;
  const bot = { ...item, item: { ...item.item, revision: 'cloud' } };
  const group = { ...item, key: 'host:group', item: { ...item.item, ref: { ...item.item.ref, id: 'group' } } };
  h.cloudActor = { id: 'actor' };
  await render(0, { push: href => { routeAfterClose = () => h.push(href); },
    context: { navigation: null, route: null, shared: { roster: { ...roster, items: [bot] }, groups: { ...groups, items: [group] } } } as any });
  await act(async () => {
    if (kind === 'created-group') h.createOptions.onGroupCreated(item.host, 'group');
    else byId(`row.${kind === 'cloud' ? 'bot' : 'group'}`)!.click();
  });
  expect(h.push).not.toHaveBeenCalled();
  routeAfterClose?.();
  expect(h.push).toHaveBeenCalledExactlyOnceWith(kind === 'cloud' ? '/cloud-chat' : '/group-chat');
});

// Unit performance regression through the real home section: the old strip
// subscribes ordinary bots to group identities and rerenders all cells on every
// unrelated cache/parent update. Count work, then verify real unread/avatar/navigation
// updates; no native FPS or wall-time claim is inferred from this synthetic load.
// One bot plus one unrelated notification is the minimal trigger; 50 x 10
// exercises the representative repeated-refresh load without a timing assertion.
it('keeps a 50-companion strip quiet through ten refreshes and updates only the affected cell', async () => {
  h.collapsed = true; h.showAvatars = true;
  const items = Array.from({ length: 50 }, (_, index) => ({ ...item, key: `host:bot${index}`,
    item: { ...item.item, ref: { ...item.item.ref, id: `bot${index}` }, display: { title: `Bot ${index}`, avatar: undefined as any } } }));
  const show = (rows: typeof items) => render(0, { context: {
    navigation: null, route: null, shared: { roster: { ...roster, items: rows }, groups },
  } } as any);
  await show(items);
  expect(h.avatarRenders).toHaveLength(50);
  h.stripRenders = []; h.avatarRenders = []; h.identityReads = 0;
  let latest = items;
  for (let index = 0; index < 10; index++) {
    latest = structuredClone(items);
    latest[17].item.revision = String(index + 2);
    await show(latest);
    await act(async () => { h.cacheRevision++; h.cacheListeners.forEach(listener => listener()); });
  }
  expect(h.stripRenders).toHaveLength(0);
  expect(h.avatarRenders).toHaveLength(0);
  expect(h.identityReads).toBe(0);
  await act(async () => { h.unreadIds.add('bot17'); h.cacheRevision++; h.cacheListeners.forEach(listener => listener()); });
  expect(h.stripRenders).toEqual(['home.teammatesStrip.bot.host.bot17']);
  expect(byId('home.teammatesStrip.bot.host.bot17')?.querySelector('[data-testid="teammate.status.unread"]')).not.toBeNull();
  expect(h.avatarRenders).toHaveLength(0);
  h.stripRenders = [];
  await act(async () => { h.unreadIds.clear(); h.cacheRevision++; h.cacheListeners.forEach(listener => listener()); });
  expect(h.stripRenders).toEqual(['home.teammatesStrip.bot.host.bot17']);
  expect(byId('home.teammatesStrip.bot.host.bot17')?.querySelector('[data-testid="teammate.status.unread"]')).toBeNull();
  expect(h.avatarRenders).toHaveLength(0);
  h.stripRenders = [];
  latest[17] = { ...latest[17], item: { ...latest[17].item, display: {
    ...latest[17].item.display, avatar: { kind: 'emoji', value: '🤖', fallbackText: 'B' },
  } } };
  await show([...latest]);
  expect(h.stripRenders).toEqual(['home.teammatesStrip.bot.host.bot17']);
  expect(h.avatarRenders).toEqual(['Bot 17']);
  expect(byId('avatar.Bot 17')?.textContent).toBe('🤖');
  await act(async () => byId('home.teammatesStrip.bot.host.bot17')!.click());
  expect(h.openTeammate).toHaveBeenCalledExactlyOnceWith(latest[17]);
});

// Integration: leaving the full home and mounting its sidebar used to collapse the
// expanded roster and invalidate the retained scroll offset.
it('keeps the expanded roster when the home presentation remounts', async () => {
  const original = roster.items;
  roster.items = Array.from({ length: 5 }, (_, index) => ({ ...item, key: String(index), item: { ...item.item, display: { title: `Teammate ${index}` } } }));
  try {
    await render(0);
    await act(async () => byId('home.teammatesShowAll')!.click());
    expect(node.querySelectorAll('[data-testid="row.bot"]')).toHaveLength(5);
    await act(async () => root.unmount()); root = createRoot(node);
    await render(0);
    expect(node.querySelectorAll('[data-testid="row.bot"]')).toHaveLength(5);
  } finally { roster.items = original; }
});
it('retries a cloud roster failure without restarting healthy computer or group lists', async () => {
  roster.error = null; h.cloudError = 'CLOUD_ROSTER_FAILED';
  await render(0); h.cloudRefresh.mockClear();
  await act(async () => vi.advanceTimersByTimeAsync(CONNECTION_NOTICE_DELAY_MS));
  await act(async () => byId('home.teammatesRetry')!.click());
  expect(h.cloudRefresh).toHaveBeenCalledTimes(1);
  expect(roster.refresh).not.toHaveBeenCalled(); expect(groups.refresh).not.toHaveBeenCalled();
});

// Unit merge regression: a zero-computer invite must survive header-only and avatar-strip settings.
it.each([[false, false, false], [true, false, false], [false, true, false], [false, true, true]])(
  'retains only a compact invite trigger with no computers (loading=%s, collapsed=%s, avatars=%s)', async (loading, collapsed, showAvatars) => {
  const original = roster.items;
  try {
    roster.items = []; roster.loading = loading; roster.error = null;
    h.collapsed = collapsed; h.showAvatars = showAvatars;
    await render(0);
    expect(byId('home.teammatesCreate')).not.toBeNull();
    expect(byId('home.teammatesAdd')).toBeNull();
    expect(h.createOptions.onInvite).toBeTypeOf('function');
    await render(0, { query: 'missing' });
    expect(byId('home.teammates')).toBeNull();
  } finally { roster.items = original; roster.loading = false; }
});

// Unit: explicitly hiding avatars must remove the entire body, including an empty create row.
// Keep header-only/search transitions and the independent fold covered through the real section.
it('keeps only the header when avatars are disabled, restores the strip when enabled, and never changes the fold when the setting changes', async () => {
  h.collapsed = true; h.showAvatars = false;
  await render(0);
  expect(byId('home.teammatesHeader')).not.toBeNull();
  expect(byId('home.teammatesStrip')).toBeNull();
  expect(byId('row.bot')).toBeNull();
  h.showAvatars = true; await render(0);
  expect(byId('home.teammatesStrip')).not.toBeNull();
  await act(async () => byId('home.teammatesHeader')!.click());
  h.showAvatars = false; await render(0);
  expect(byId('row.bot')).not.toBeNull();
  await act(async () => byId('home.teammatesHeader')!.click());
  expect(byId('row.bot')).toBeNull();
  expect(byId('home.teammatesStrip')).toBeNull();
  await render(0, { query: 'Mimi' });
  expect(byId('row.bot')).not.toBeNull();
  await render(0, { query: 'no match' });
  expect(byId('home.teammates')).toBeNull();
  await render(0);
  expect(byId('row.bot')).toBeNull();
  expect(byId('home.teammatesStrip')).toBeNull();
});
it('keeps the compact create action without an empty body when collapsed with avatars disabled', async () => {
  h.collapsed = true; h.showAvatars = false;
  await render(0, { context: { navigation: null, route: null, shared: {
    roster: { ...roster, items: [], createTargets: [item.host] }, groups,
  } } } as any);
  expect(byId('home.teammatesCreate')).not.toBeNull();
  expect(byId('home.teammatesAdd')).toBeNull();
  expect(byId('home.teammatesStripCreate')).toBeNull();
  await act(async () => byId('home.teammatesHeader')!.click());
  expect(byId('home.teammatesAdd')).not.toBeNull();
});
it('carries unread and pending attention on the hidden header without opening it or changing read receipts', async () => {
  h.collapsed = true; h.showAvatars = false;
  const group = { ...item, key: 'host:group', chatUnread: { count: 1, threadCount: 1 },
    item: { ...item.item, ref: { collectionId: 'bot-groups', kind: 'bot-group', id: 'group' }, display: { title: 'Team' } } };
  groups.items = [group];
  await render(0);
  expect(byId('home.teammatesAttention')).not.toBeNull();
  expect(byId('home.teammatesHeader')?.getAttribute('aria-label')).toContain('devices.companions.unread');
  group.chatUnread = { count: 0, threadCount: 0 };
  await render(0);
  expect(byId('home.teammatesAttention')).toBeNull();
  await act(async () => { h.unreadIds.add('bot'); h.cacheListeners.forEach(listener => listener()); });
  expect(byId('home.teammatesAttention')).not.toBeNull();
  expect(byId('home.teammatesStrip')).toBeNull();
  expect(byId('row.bot')).toBeNull();
  await act(async () => { h.unreadIds.clear(); h.cacheListeners.forEach(listener => listener()); });
  expect(byId('home.teammatesAttention')).toBeNull();
  await render(0, { context: { navigation: null, route: null, shared: {
    roster: { ...roster, items: [{ ...item, item: { ...item.item, display: { title: 'Mimi', status: { tone: 'warning', label: 'Needs attention' } } } }] }, groups,
  } } } as any);
  expect(byId('home.teammatesAttention')).not.toBeNull();
  expect(byId('home.teammatesStrip')).toBeNull();
  // Merge regression: hidden avatars must keep a pending decision visible even
  // when the host also sends generation/warning, without changing the fold or receipt.
  await render(0, { context: { navigation: null, route: null, shared: {
    roster: { ...roster, items: [{ ...item, item: { ...item.item, display: { title: 'Mimi',
      teammateActivity: { phase: 'needs-interaction' }, generation: { phase: 'replying', startedAt: 1 },
      status: { tone: 'warning', label: 'Needs attention' } } } }] }, groups,
  } } } as any);
  expect(byId('home.teammatesHeader')?.getAttribute('aria-label')).toContain('devices.companions.awaiting');
  expect(byId('home.teammatesHeader')?.getAttribute('aria-label')).not.toContain('Needs attention');
  expect(byId('home.teammatesAttention')).not.toBeNull();
  expect(byId('home.teammatesStrip')).toBeNull();
});

// Regression for the P2 review finding on BuddySetGroups.tsx: a fold changes the
// list height, so it must commit inside the home disclosure window (DESIGN.md
// §14.4) rather than firing onChange directly on press. Minimal failing input: a
// controller that records apply without running it. Before the fix the rows vanish
// in one frame and runDisclosure is never called; after it the rows stay until the
// window applies. tier: unit, in-memory fakes, no native animation.
it('defers a buddy set fold into the home disclosure window', async () => {
  const initial = { version: 1 as const, sets: [{ buddySetId: 'set-1', name: 'Trio', buddyIds: ['bot:host:bot'] }] };
  const prepareDisclosure = vi.fn();
  let pendingApply: (() => void) | undefined;
  const runDisclosure = vi.fn((apply: () => void) => { pendingApply = apply; });
  function Harness() {
    const [state, setState] = useState(initial);
    return el(BuddySetGroups, {
      entries: [{ kind: 'bot', row: item }], buddySets: state, onChange: setState,
      onEditSet: () => {}, renderRow: (_entry: unknown) => el('span', { key: 'row', 'data-testid': 'buddy.row' }, 'Mimi'),
      query: '', runDisclosure, prepareDisclosure,
    } as any);
  }
  await act(async () => root.render(el(Harness)));
  const header = () => node.querySelector<HTMLElement>('button[aria-label^="Trio"]');
  expect(byId('buddy.row')).not.toBeNull();
  expect(header()?.getAttribute('aria-label')).toContain('collapse');

  // Press-in opens the window before the state commit.
  await act(async () => { header()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
  expect(prepareDisclosure).toHaveBeenCalledTimes(1);
  await act(async () => { header()!.click(); });
  expect(runDisclosure).toHaveBeenCalledTimes(1);
  // No one-frame jump: the rows stay visible until the window applies the fold.
  expect(byId('buddy.row')).not.toBeNull();
  await act(async () => { pendingApply!(); });
  expect(byId('buddy.row')).toBeNull();
  expect(header()?.getAttribute('aria-label')).toContain('expand');
});

/**
 * 测试价值(本轮新增段头失败反馈用例)
 * - 生产入口与可观察结果:HomeTeammatesSection 在仅显示段头时仍给出伙伴集读/写失败的
 *   可点击重试点,且不渲染被折叠门隐藏的列表内重试行。
 * - Bug／规则依据:PR #11701 的 headerOnly 保存失败反馈 P2;DESIGN.md §4「折叠态保留可发现状态」。
 * - 现有覆盖缺口:已有折叠态用例只覆盖名册未读/待关注点,不覆盖本地伙伴集持久化失败。
 * - 最小失败输入:collapsed=true、showCollapsedAvatars=false,并令 hook 返回 error 或 saveFailed。
 * - tier:unit(jsdom,真实首页段落 + hook 替身),纯同步、无真实等待。
 * - 实测耗时:3.46s(单独运行整个既有 19 用例文件,含启动;用例本身 158ms)。
 */
it('keeps buddy-set read and save retries visible when only the header is shown', async () => {
  h.collapsed = true; h.showAvatars = false; h.buddySetsStatus = 'error';
  await render(0);
  expect(byId('home.buddySetsRetry')).toBeNull();
  const readRetry = byId('home.buddySetsHeaderRetry');
  expect(readRetry).not.toBeNull();
  await act(async () => readRetry!.click());
  expect(h.retryBuddySets).toHaveBeenCalledOnce();

  h.buddySetsStatus = 'ready'; h.buddySetsSaveFailed = true;
  await render(1);
  expect(byId('home.buddySetsSaveRetry')).toBeNull();
  const saveRetry = byId('home.buddySetsHeaderRetry');
  expect(saveRetry).not.toBeNull();
  await act(async () => saveRetry!.click());
  expect(h.retrySaveBuddySets).toHaveBeenCalledOnce();
});
