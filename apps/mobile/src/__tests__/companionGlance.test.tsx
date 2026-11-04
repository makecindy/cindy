// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：手机伙伴近况的两份数据——「输出内容」列哪些文件（companionGlanceOutputs），
 *   「待办」能否读到宿主第一页（25 条）之后的条目（useCompanionGlanceTodos）。
 * - Bug／规则依据：docs/product-rules/cindy-bots-runtime.md「伙伴近况」；桌面同一入口在 #6681 review 中
 *   被指出只读一页时第 26 条之后看不到、引用不了、删不掉；模拟器目检发现 Hermes 没有 Intl.RelativeTimeFormat，
 *   今天到期的待办让近况整块渲染报错。
 * - 现有覆盖缺口：新入口；顶栏测试只验证打开近况，不覆盖数据。
 * - 最小失败输入：30 条未完成待办；一份含成品、源码、已删文件的完成委派与一份失败委派。
 * - tier：unit（jsdom 驱动真实 hook，device-link 用内存 fake）。
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { todoDateLabel, todoDueSoon, todoLocalDate, type TeammateTodo } from '@cindy/maker-shared/teammate-todo';

const h = vi.hoisted(() => ({ items: [] as unknown[], reads: [] as Array<Record<string, unknown>>,
  liveQuery: false, sessions: [] as any[], queried: [] as any[], delegations: [] as any[], prs: new Map(), activity: new Map(), closed: null as (() => void) | null, openURL: vi.fn(),
}));
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
  Linking: { openURL: h.openURL },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({ children, testID, accessibilityLabel }: any) => createElement('div', { 'data-testid': testID, 'aria-label': accessibilityLabel }, children),
  ScrollView: ({ children }: any) => createElement('div', null, children),
  Pressable: ({ children, testID, accessibilityLabel, onPress, disabled }: any) => createElement('button',
    { 'data-testid': testID, 'aria-label': accessibilityLabel, onClick: onPress, disabled }, children),
}));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => createElement('span', null, children) }));
vi.mock('@/components/RemoteCompanionAvatar', () => ({ RemoteCompanionAvatar: () => null }));
vi.mock('@/components/FileTypeIcon', () => ({ FileTypeIcon: () => null }));
vi.mock('lucide-react-native', () => Object.fromEntries(['Check','ChevronDown','ChevronUp','Monitor','ScanSearch','MessageCircle','X','GitMerge','GitPullRequest','GitPullRequestClosed','GitPullRequestDraft'].map(name => [name, () => createElement('i', { 'data-icon': name })])));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  return { ...tokens, useTheme: () => ({ colors: tokens.lightColors }), useThemedStyles: (fn: any) => fn(tokens.lightColors) };
});
vi.mock('@/platform/chrome/NativePullDownMenu', () => ({ NativePullDownMenu: ({ children }: any) => children }));
vi.mock('@/session/CompanionSheet', () => ({ CompanionSheet: ({ children, onClosed }: any) => { h.closed = onClosed; return children; } }));
vi.mock('@/chat/useCloudCompanion', () => ({ useCloudCompanionHome: () => ({ actors: [], cindyIds: [] }) }));
vi.mock('@/session/remoteSessionStore', () => ({ useRemoteHomeSessions: () => h.sessions,
  remoteSessionStore: { getHomeSessions: () => h.sessions, subscribeHomeStatus: () => () => undefined, getSessionLiveActivity: (id: string) => h.activity.get(id) } }));
vi.mock('@/session/HomeSessionInfoMeta', () => ({ useHomeSessionPr: (_device: string, id: string) => h.prs.get(id) ?? null }));
vi.mock('@/device-link/remoteResourceAvailability', async (original) => ({ ...await original<typeof import('@/device-link/remoteResourceAvailability')>(), readRemoteCollectionCache: () => [], remoteResourceConnectionState: () => 'online' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (s: string) => s, i18n: { language: 'en' } }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => undefined } }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u' }, accountGeneration: 1 }) }));
// Stable like the real context: new functions per render would re-run the read effect forever.
const link = vi.hoisted(() => ({ status: 'online', connectionEpoch: 1, getPresenceAvailability: () => true, invoke: vi.fn(), openLink: async () => undefined, onRemoteResourceChanged: () => () => undefined }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => link, subscribeRemoteBotChanges: () => () => undefined }));
vi.mock('@/device-link/remoteResources', () => ({
  invokeRemoteResourceAction: vi.fn(),
  getRemoteResource: async (_invoke: unknown, _target: unknown, _ref: unknown, _locale: unknown, _primitives: unknown, query: string) => {
    const q = JSON.parse(query) as { view: string; offset: number; limit: number };
    h.reads.push(q);
    const matching = h.items.filter(item => (item as { status: string }).status === (q.view === 'done' ? 'done' : 'open'));
    return { blocks: [{ primitive: 'teammate-todos', data: { items: matching.slice(q.offset, q.offset + q.limit), total: matching.length } }] };
  },
}));
vi.mock('expo-router', async () => { const { useEffect } = await import('react'); return { useFocusEffect: (fn: () => void) => useEffect(fn, [fn]) }; });
vi.mock('@/session/useRemoteCompanionQuery', async importOriginal => {
  const actual = await importOriginal<typeof import('@/session/useRemoteCompanionQuery')>();
  return { useRemoteCompanionQuery: (...args: Parameters<typeof actual.useRemoteCompanionQuery>) => h.liveQuery
    ? actual.useRemoteCompanionQuery(...args)
    : { value: args[1] === 'local-db:sessions:list' ? h.queried : { ok: true, delegations: h.delegations } } };
});
vi.mock('@/session/readTeammateTasks', () => ({ readTeammateTasks: async ({ sessions }: any) => sessions }));

const { useCompanionGlanceTodos } = await import('@/session/useCompanionGlanceTodos');
const { companionGlanceOutputs } = await import('@/session/companionProfileData');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
beforeEach(() => { h.liveQuery = false; h.items = []; h.reads = []; h.sessions = []; h.queried = []; h.delegations = []; h.prs.clear(); h.activity.clear(); h.openURL.mockResolvedValue(undefined); root = createRoot(document.createElement('div')); });
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

const todo = (id: string, status = 'open') => ({ id, status, title: id, revision: 1, sources: [], history: [] }) as unknown as TeammateTodo;

it('reads every page of open todos, not just the host first page of 25', async () => {
  h.items = Array.from({ length: 30 }, (_, index) => todo(`o${index}`));
  let latest: ReturnType<typeof useCompanionGlanceTodos> | null = null;
  function Probe() { latest = useCompanionGlanceTodos({ deviceId: 'pc', deviceName: 'PC', botId: 'bot', enabled: true }); return null; }
  await act(async () => root.render(createElement(Probe)));
  await act(async () => { await Promise.resolve(); });
  expect(latest!.todos.open).toHaveLength(30);
  expect(latest!.todos.openTotal).toBe(30);
  expect(h.reads.filter(read => read.view === 'open').map(read => read.offset)).toEqual([0, 25]);
});

it('keeps the newest completed todos past the 200 cap', async () => {
  h.items = Array.from({ length: 230 }, (_, index) => todo(`d${String(index).padStart(3, '0')}`, 'done'));
  let latest: ReturnType<typeof useCompanionGlanceTodos> | null = null;
  function Probe() { latest = useCompanionGlanceTodos({ deviceId: 'pc', deviceName: 'PC', botId: 'bot', enabled: true }); return null; }
  await act(async () => root.render(createElement(Probe)));
  await act(async () => { await Promise.resolve(); });
  const done = latest!.todos.done;
  expect(done).toHaveLength(200);
  expect(done[0].id).toBe('d229');
  expect(done.some(item => item.id === 'd029')).toBe(false);
  expect(latest!.todos.doneTotal).toBe(230);
});

it("lists only this teammate's finished deliverables, newest first, each opening its source task", () => {
  const outputs = companionGlanceOutputs({
    ok: true,
    delegations: [
      { id: 'd1', requestingBotId: 'bot', status: 'completed', title: 'Weekly report', childSessionId: 'c1', completedAt: 2, updatedAt: 2,
        artifacts: [{ path: 'out/report.docx', status: 'added' }, { path: 'src/app.ts', status: 'modified' }, { path: 'old.pdf', status: 'deleted' }] },
      { id: 'd2', requestingBotId: 'bot', status: 'completed', title: 'Deck', childSessionId: 'c2', completedAt: 5, updatedAt: 5,
        artifacts: [{ path: 'deck.pptx', status: 'added' }, { path: 'previews/shot.png', status: 'added' }] },
      { id: 'd3', requestingBotId: 'bot', status: 'failed', title: 'x', childSessionId: 'c3', completedAt: 9, updatedAt: 9,
        artifacts: [{ path: 'fail.pdf', status: 'added' }] },
      { id: 'd4', requestingBotId: 'other', status: 'completed', title: 'y', childSessionId: 'c4', completedAt: 9, updatedAt: 9,
        artifacts: [{ path: 'theirs.pdf', status: 'added' }] },
    ],
  } as never, 'bot');
  expect(outputs.map(file => [file.name, file.childSessionId])).toEqual([['deck.pptx', 'c2'], ['report.docx', 'c1']]);
});

it('labels a todo due today with its date where the engine has no relative-time formatting (Hermes)', () => {
  const original = Intl.RelativeTimeFormat;
  const today = todoLocalDate(new Date(), 'UTC');
  const due = { ...todo('t'), sourceDeadline: { kind: 'date', date: today, timeZone: 'UTC' }, deadlineOverride: null } as unknown as TeammateTodo;
  try {
    (Intl as { RelativeTimeFormat?: unknown }).RelativeTimeFormat = undefined;
    expect(todoDateLabel(due, 'zh-CN')).toBe(new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', month: 'numeric', day: 'numeric' })
      .format(new Date(`${today}T12:00:00Z`)));
  } finally {
    (Intl as { RelativeTimeFormat?: unknown }).RelativeTimeFormat = original;
  }
});


// Real sheet rendering covers the new empty state and cross-device task/PR projection;
// the existing hook-only cases cannot catch incorrect labels or navigation targets.
import { CompanionGlanceSheet } from '@/session/CompanionGlanceSheet';

it('hides empty todos and opens attributed tasks on their own host, with existing unread and true PR titles', async () => {
  const host = document.createElement('div');
  await act(async () => root.unmount()); root = createRoot(host);
  const onOpenTask = vi.fn();
  h.sessions = [
    { id: 'remote', title: 'Task B', deviceLinkDeviceId: 'other-pc', status: 'active', updatedAt: '2026-10-28T11:00:00Z', taskTeammate: { id: 'cindy-default' } },
    { id: 'unrelated', title: 'Unrelated task', deviceLinkDeviceId: 'pc', status: 'active', taskTeammate: { id: 'other-bot' } },
  ];
  // The Home snapshot has no local tasks (e.g. its archived filter); glance reads all statuses.
  h.queried = [{ id: 'local', title: 'Task A', status: 'active', updatedAt: '2026-10-28T12:00:00Z', taskTeammate: { id: 'cindy-default' } }];
  h.activity.set('local', { phase: 'completed', attention: true });
  h.activity.set('remote', { phase: 'error', attention: true });
  for (const id of ['local', 'remote']) h.prs.set(id, { ref: { owner: 'example', repo: 'app', prNumber: 7, sessionId: id, lastSeenAt: 1 },
    status: { ok: true, status: 'merged', title: 'Real PR title' } });
  await act(async () => root.render(<CompanionGlanceSheet visible onClose={() => {}} name="Cindy" avatar={undefined} botId="cindy-default"
    deviceId="pc" deviceName="PC" sessionId="chat" online cloudHome={false} onQuoteTodo={() => {}} onOpenTask={onOpenTask}
    onOpenCindy={() => {}} onSwitchHome={() => {}}
    todos={{ loaded: true, failed: false, todos: {
      open: Array.from({ length: 51 }, (_, index) => todo(`old idea ${index}`)),
      done: [todo('completed', 'done')], openTotal: 51, doneTotal: 1, dailyCheck: true,
    } } as any} />));
  expect(host.textContent).not.toContain('devices.glance.todos');
  expect(host.textContent).not.toContain('Unrelated task');
  expect(host.querySelectorAll('[aria-label="devices.glance.unread"]')).toHaveLength(1);
  expect(host.querySelectorAll('[data-testid="companion.glance.pr"]')).toHaveLength(1);
  expect(host.textContent).toContain('Real PR title');
  await act(async () => (host.querySelector('[data-testid="companion.glance.pr"]') as HTMLButtonElement).click());
  expect(h.openURL).toHaveBeenCalledWith('https://github.com/example/app/pull/7');
  await act(async () => (host.querySelectorAll('[data-testid="companion.glance.task"]')[1] as HTMLButtonElement).click());
  expect(onOpenTask).not.toHaveBeenCalled();
  await act(async () => h.closed?.());
  expect(onOpenTask).toHaveBeenCalledWith('remote', 'other-pc');
});

it('shows only approaching deadlines in the real mobile sheet', async () => {
  const host = document.createElement('div');
  await act(async () => root.unmount()); root = createRoot(host);
  const due = { ...todo('Due today'), sourceDeadline: { kind: 'date', date: todoLocalDate(new Date(), 'UTC'), timeZone: 'UTC' } };
  const far = { ...todo('Next month'), sourceDeadline: { kind: 'date', date: todoLocalDate(new Date(Date.now() + 30 * 86_400_000), 'UTC'), timeZone: 'UTC' } };
  await act(async () => root.render(<CompanionGlanceSheet visible onClose={() => {}} name="Cindy" avatar={undefined} botId="cindy-default"
    deviceId="pc" deviceName="PC" sessionId="chat" online cloudHome={false} onQuoteTodo={() => {}} onOpenTask={() => {}}
    onOpenCindy={() => {}} onSwitchHome={() => {}}
    todos={{ loaded: true, failed: false, todos: { open: [due, far, todo('Old idea')], done: [], openTotal: 3, doneTotal: 0, dailyCheck: false } } as any} />));
  expect(host.querySelectorAll('[data-testid="companion.glance.todo"]')).toHaveLength(1);
  expect(host.textContent).toContain('Due today');
  expect(host.textContent).not.toContain('Old idea');
  expect(host.textContent).not.toContain('Next month');
});

// Regression: mixed output types must share the same preview budget and expand/collapse action.
it('mixes PRs and files by time and expands all outputs together', async () => {
  const host = document.createElement('div');
  await act(async () => root.unmount()); root = createRoot(host);
  h.queried = [{ id: 'task', title: 'Task', status: 'active', taskTeammate: { id: 'cindy-default' } }];
  const pr = (at: number) => ({ ref: { sessionId: 'task', owner: 'example', repo: 'app', prNumber: at, lastSeenAt: at }, status: { ok: true, status: 'merged', title: `PR title ${at}` } });
  h.prs.set('task', { ...pr(4), additional: [pr(2)] });
  h.delegations = [3, 1].map(at => ({ id: `d${at}`, requestingBotId: 'cindy-default', status: 'completed',
    title: 'Task', childSessionId: 'task', completedAt: at, updatedAt: at,
    artifacts: [{ path: `file-${at}.pdf`, status: 'added' }] }));
  await act(async () => root.render(<CompanionGlanceSheet visible onClose={() => {}} name="Cindy" avatar={undefined} botId="cindy-default"
    deviceId="pc" deviceName="PC" sessionId="chat" online cloudHome={false} onQuoteTodo={() => {}} onOpenTask={() => {}}
    onOpenCindy={() => {}} onSwitchHome={() => {}}
    todos={{ loaded: true, failed: false, todos: { open: [], done: [], openTotal: 0, doneTotal: 0, dailyCheck: false } } as any} />));
  const rows = () => [...host.querySelectorAll('[data-testid="companion.glance.pr"], [data-testid="companion.glance.output"]')]
    .map(row => row.querySelector('span')?.textContent);
  expect(rows()).toEqual(['PR title 4', 'file-3.pdf', 'PR title 2']);
  expect(host.querySelectorAll('[data-testid="companion.glance.output.more"]')).toHaveLength(1);
  expect(host.querySelector('[data-testid="companion.glance.pr.more"]')).toBeNull();
  const more = () => host.querySelector('[data-testid="companion.glance.output.more"]') as HTMLButtonElement;
  await act(async () => more().click());
  expect(rows()).toEqual(['PR title 4', 'file-3.pdf', 'PR title 2', 'file-1.pdf']);
  await act(async () => more().click());
  expect(rows()).toHaveLength(3);
});

// Review regression: production query timer must replace the open sheet snapshot, including deletions.
// Unit: real query + component, fake host; fake timers avoid wall-clock waits.
it('refreshes tasks in an open sheet and stops querying after closing it', async () => {
  vi.useFakeTimers(); h.liveQuery = true;
  const host = document.createElement('div');
  await act(async () => root.unmount()); root = createRoot(host);
  const task = (id: string, title: string) => ({ id, title, status: 'active', taskTeammate: { id: 'cindy-default' } });
  h.queried = [task('old', 'Original task')];
  link.invoke.mockImplementation(async (_device, channel) => channel === 'local-db:sessions:list' ? h.queried : { ok: true, delegations: [] });
  const render = (visible: boolean) => <CompanionGlanceSheet visible={visible} onClose={() => {}} name="Cindy" avatar={undefined} botId="cindy-default"
    deviceId="pc" deviceName="PC" sessionId="chat" online cloudHome={false} onQuoteTodo={() => {}} onOpenTask={() => {}}
    onOpenCindy={() => {}} onSwitchHome={() => {}}
    todos={{ loaded: true, failed: false, todos: { open: [], done: [], openTotal: 0, doneTotal: 0, dailyCheck: false } } as any} />;
  await act(async () => root.render(render(true)));
  expect(host.textContent).toContain('Original task');
  h.queried = [task('old', 'Renamed task'), task('new', 'New task')];
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(host.textContent).toContain('Renamed task');
  expect(host.textContent).toContain('New task');
  expect(host.textContent).not.toContain('Original task');
  h.queried = [];
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(host.querySelector('[data-testid="companion.glance.task"]')).toBeNull();
  await act(async () => root.render(render(false)));
  const reads = link.invoke.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(link.invoke.mock.calls).toHaveLength(reads);
});

// The production demo must contain a due row so its existing actions remain reachable.
it('keeps the demo todo visible and preserves its empty and restore states', async () => {
  const { teammateVisualFixture } = await import('@/debug/teammateVisualFixture');
  const { REMOTE_RESOURCE_GET_CHANNEL, REMOTE_RESOURCE_INVOKE_CHANNEL } = await import('@cindy/device-link');
  const read = (view = 'open') => teammateVisualFixture(REMOTE_RESOURCE_GET_CHANNEL, [{ ref: { id: 'todos:cindy-default' }, query: JSON.stringify({ view }) }]) as any;
  const data = () => read().blocks[0].data;
  expect(data().items).toHaveLength(1);
  expect(todoDueSoon(data().items[0])).toBe(true);
  expect(data().dailyCheck).toBe(true);
  expect(read('done').blocks[0].data.items).toHaveLength(0);
  const update = (operation: string) => teammateVisualFixture(REMOTE_RESOURCE_INVOKE_CHANNEL, [{ resourceRef: { id: 'todos:cindy-default' }, actionId: 'todo-update', input: { operation } }]);
  update('delete');
  expect(data().items).toHaveLength(0);
  update('restore');
  expect(todoDueSoon(data().items[0])).toBe(true);
});
