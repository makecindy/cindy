// @vitest-environment jsdom
import { act, createContext, createElement as el } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ cloudRefresh: vi.fn(async () => {}), push: vi.fn(),
  cloudActor: null as null | { id: string }, createOptions: null as any, collapsed: false, unread: false }));
vi.mock('react-native', () => ({
  View: ({ children, testID }: any) => el('div', { 'data-testid': testID }, children),
  ScrollView: ({ children, testID }: any) => el('div', { 'data-testid': testID }, children),
  Pressable: ({ children, testID, disabled, onPress, accessibilityLabel }: any) => el('button', { 'data-testid': testID, disabled, onClick: onPress, 'aria-label': accessibilityLabel }, children),
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
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }));
vi.mock('@/components/AppText', () => ({ Text: ({ children, testID }: any) => el('span', { 'data-testid': testID }, children) }));
vi.mock('@/components/RemoteCompanionAvatar', () => ({ RemoteCompanionAvatar: () => null }));
vi.mock('@/chat/cloudCompanion', () => ({ CLOUD_ROW_REVISION: 'cloud', cloudActorForRow: () => h.cloudActor, cloudCompanionRows: (items: unknown) => items }));
vi.mock('@/session/teammateNavigation', () => ({ cloudCompanionRoute: () => '/cloud-chat' }));
vi.mock('@/session/botGroupNavigation', () => ({ botGroupRoute: () => '/group-chat' }));
vi.mock('@/chat/useCloudCompanion', () => ({ useCloudCompanionHome: () => ({ supported: true, actors: [], deviceNames: {}, refresh: h.cloudRefresh }) }));
vi.mock('@/device-link/remoteResourceCache', () => ({ isRemoteResourceUnread: () => h.unread, remoteResourceCacheRevision: () => 0, subscribeRemoteResourceCache: () => () => {} }));
vi.mock('@/utils/useGuardedPush', () => ({ useGuardedPush: () => h.push }));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  const colors = tokens.lightColors;
  return { ...tokens, useThemedStyles: (factory: (value: typeof colors) => unknown) => factory(colors), useTheme: () => ({ colors }) };
});
vi.mock('@/session/BotGroupAvatars', () => ({ BotGroupDuoAvatar: () => null, useBotGroupIdentities: () => () => ({}) }));
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
vi.mock('@/session/TeammateList', () => ({
  useTeammateEntries: (items: any[], groups: any[] = []) => [...items.map(row => ({ kind: 'bot', row })), ...groups.map(row => ({ kind: 'group', row }))],
  useTeammateRowRenderer: (options: any) => (entry: any) => el('button', { key: entry.row.key,
    'data-testid': `row.${entry.kind}`, onClick: () => entry.kind === 'bot' ? options.onSelect(entry.row) : options.groups.onSelect(entry.row) }, entry.row.item.display.title),
}));
vi.mock('@/session/useTeammateNavigation', () => ({ useTeammateNavigation: () => ({
  owner: 'owner', teammatesCollapsed: h.collapsed, lastTeammate: null,
  setTeammatesCollapsed: async () => {}, openTeammate: async () => {}, openCreatedTeammate: async () => {} }) }));
import { HomeTeammatesSection } from '../session/HomeTeammatesSection';
import { CONNECTION_NOTICE_DELAY_MS } from '../components/connectionNoticeDelay';

const item = { key: 'host:bot', host: { deviceId: 'host', deviceName: 'Mac' }, item: {
  ref: { collectionId: 'teammates', kind: 'bot', id: 'bot' }, revision: '1', links: [], display: { title: 'Mimi' } } };
const roster = { items: [item], createTargets: [], groupTargets: [], loading: false, refreshing: false, error: 'LIST_FAILED' as string | null,
  isOnline: () => true, connectionState: undefined, refresh: vi.fn(async () => {}) };
const groups = { items: [] as any[], supported: true, refreshing: false, error: null, isOnline: () => true, refresh: vi.fn(async () => {}) };
let root: Root; let node: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); node = document.createElement('div'); root = createRoot(node); vi.clearAllMocks(); h.cloudActor = null; vi.useFakeTimers(); roster.error = 'LIST_FAILED'; h.collapsed = false; h.unread = false; groups.items = []; });
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });
const render = (refreshKey: number, overrides: Partial<Parameters<typeof HomeTeammatesSection>[0]> = {}) => act(async () => root.render(el(HomeTeammatesSection, {
  context: { navigation: null, route: null, shared: { roster, groups } } as any, active: true, refreshKey,
  visible: true, query: '', showFooter: false, runDisclosure: (apply: () => void) => apply(), prepareDisclosure: () => {},
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
  expect(groups.refresh).toHaveBeenCalledTimes(1);
  expect(h.cloudRefresh).toHaveBeenCalledTimes(1);
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
  h.collapsed = true;
  const group = { ...item, key: 'host:group', chatUnread: { count: 1, threadCount: 1 },
    item: { ...item.item, ref: { collectionId: 'bot-groups', kind: 'bot-group', id: 'group' }, display: { title: 'Team' } } };
  groups.items = [group];
  await render(0);
  const cell = () => byId('home.teammatesStrip.group.host.group');
  expect(cell()?.querySelector('[data-testid="home.teammatesStrip.unread"]')).not.toBeNull();
  h.unread = true;
  group.chatUnread = { count: 0, threadCount: 0 };
  await render(0);
  expect(cell()?.querySelector('[data-testid="home.teammatesStrip.unread"]')).toBeNull();
  group.chatUnread = { count: 2, threadCount: 0 };
  await render(0);
  expect(cell()?.querySelector('[data-testid="home.teammatesStrip.unread"]')).not.toBeNull();
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
