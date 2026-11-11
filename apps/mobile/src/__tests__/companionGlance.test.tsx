// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果：手机伙伴近况的「输出内容」列哪些文件（companionGlanceOutputs）与任务列表。
 * - Bug／规则依据：docs/product-rules/cindy-bots-runtime.md「伙伴近况」；桌面同一入口在 #6681 review 中
 *   被指出只读一页时第 26 条之后看不到、引用不了、删不掉；模拟器目检发现 Hermes 没有 Intl.RelativeTimeFormat，
 *   今天到期的待办让近况整块渲染报错。
 * - 现有覆盖缺口：新入口；顶栏测试只验证打开近况，不覆盖数据。
 * - 最小失败输入：30 条未完成待办；一份含成品、源码、已删文件的完成委派与一份失败委派。
 * - tier：unit（jsdom 驱动真实 hook，device-link 用内存 fake）。
 */
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ items: [] as unknown[], reads: [] as Array<Record<string, unknown>>,
  pageGate: null as Promise<void> | null, dailyCheck: false, liveQuery: false, sessions: [] as any[], queried: [] as any[], delegations: [] as any[], prs: new Map(), activity: new Map(), closed: null as (() => void) | null, openURL: vi.fn(),
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
vi.mock('@/device-link/remoteResourceAvailability', () => ({ readRemoteCollectionCache: () => [], remoteResourceConnectionState: () => 'online' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (s: string) => s, i18n: { language: 'en' } }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => undefined } }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u' }, accountGeneration: 1 }) }));
// Stable like the real context: new functions per render would re-run the read effect forever.
const link = vi.hoisted(() => ({ status: 'online', connectionEpoch: 1, getPresenceAvailability: () => true, invoke: vi.fn(), openLink: async () => undefined, onRemoteResourceChanged: vi.fn((_callback: any) => () => undefined) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => link, subscribeRemoteBotChanges: () => () => undefined }));
vi.mock('@/device-link/remoteResources', () => ({
  invokeRemoteResourceAction: vi.fn(),
  getRemoteResource: vi.fn(),
}));
vi.mock('expo-router', async () => { const { useEffect } = await import('react'); return { useFocusEffect: (fn: () => void) => useEffect(fn, [fn]) }; });
vi.mock('@/session/useRemoteCompanionQuery', async importOriginal => {
  const actual = await importOriginal<typeof import('@/session/useRemoteCompanionQuery')>();
  return { useRemoteCompanionQuery: (...args: Parameters<typeof actual.useRemoteCompanionQuery>) => h.liveQuery
    ? actual.useRemoteCompanionQuery(...args)
    : { value: args[1] === 'local-db:sessions:list' ? h.queried : { ok: true, delegations: h.delegations } } };
});
vi.mock('@/session/readTeammateTasks', () => ({ readTeammateTasks: async ({ sessions }: any) => sessions }));

const { companionGlanceOutputs } = await import('@/session/companionProfileData');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
beforeEach(() => { h.pageGate = null; h.dailyCheck = false; h.liveQuery = false; h.items = []; h.reads = []; h.sessions = []; h.queried = []; h.delegations = []; h.prs.clear(); h.activity.clear(); h.openURL.mockResolvedValue(undefined); root = createRoot(document.createElement('div')); });
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); });

it('pauses retained query reads without discarding layout data, then refreshes on activation', async () => {
  vi.useFakeTimers(); h.liveQuery = true;
  const { useRemoteCompanionQuery } = await import('@/session/useRemoteCompanionQuery');
  let latest: ReturnType<typeof useRemoteCompanionQuery>;
  let finish: ((value: unknown) => void) | undefined;
  link.invoke.mockReset().mockResolvedValue({ id: 'bot', dmThreadsSupported: true });
  function Probe({ active, botId = 'bot' }: { active: boolean; botId?: string }) {
    latest = useRemoteCompanionQuery('pc', 'local-db:bots:get', [botId], { active, refreshIntervalMs: 1000 });
    return null;
  }
  await act(async () => root.render(<Probe active />));
  expect(latest!.value).toEqual({ id: 'bot', dmThreadsSupported: true });
  await act(async () => root.render(<Probe active={false} />));
  await act(async () => vi.advanceTimersByTime(3000));
  expect(link.invoke).toHaveBeenCalledTimes(1);
  expect(latest!.value).toEqual({ id: 'bot', dmThreadsSupported: true });
  link.invoke.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(<Probe active />));
  expect(link.invoke).toHaveBeenCalledTimes(2);
  expect(latest!.value).toEqual({ id: 'bot', dmThreadsSupported: true });
  await act(async () => finish!({ id: 'bot', dmThreadsSupported: false }));
  expect(latest!.value).toEqual({ id: 'bot', dmThreadsSupported: false });
  await act(async () => root.render(<Probe active={false} botId="other-bot" />));
  expect(latest!.value).toBeNull();
});

// Unit regression: the real query used to publish every equal polling response, rebuilding
// retained chat metadata. Pause coverage above did not cover active, unchanged snapshots.
it('publishes only changed companion data while keeping refresh errors and removed fields visible', async () => {
  vi.useFakeTimers(); h.liveQuery = true;
  const { useRemoteCompanionQuery } = await import('@/session/useRemoteCompanionQuery');
  let latest: ReturnType<typeof useRemoteCompanionQuery<any>>;
  const changed = vi.fn();
  let payload: any = { id: 'bot', threads: [{ id: 'one', replies: 1 }], setting: true };
  link.invoke.mockReset().mockImplementation(async () => structuredClone(payload));
  function Probe() {
    latest = useRemoteCompanionQuery('pc', 'local-db:bots:get', ['bot'], { refreshIntervalMs: 1000 });
    useEffect(() => { if (latest.value) changed(latest.value); }, [latest.value]);
    return null;
  }
  await act(async () => root.render(<Probe />));
  const first = latest!.value;
  for (let i = 0; i < 10; i++) await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(link.invoke).toHaveBeenCalledTimes(11);
  expect(changed).toHaveBeenCalledTimes(1);
  payload = { ...payload, setting: false };
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(latest!.value.setting).toBe(false);
  expect(latest!.value.threads).toBe(first.threads);
  payload = { id: 'bot', threads: [{ id: 'one', replies: 2 }] };
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(latest!.value).toEqual(payload);
  payload = { ok: false };
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(latest!.error).toBe(true);
  expect(latest!.value.threads[0].replies).toBe(2);
  payload = { id: 'bot', threads: [{ id: 'one', replies: 2 }] };
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(latest!.error).toBe(false);
  expect(changed).toHaveBeenCalledTimes(3);
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

// Real sheet rendering covers the new empty state and cross-device task/PR projection;
// the existing hook-only cases cannot catch incorrect labels or navigation targets.
import { CompanionGlanceSheet } from '@/session/CompanionGlanceSheet';

it('opens attributed tasks on their own host, with existing unread and true PR titles', async () => {
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
    deviceId="pc" deviceName="PC" sessionId="chat" online cloudHome={false} onOpenTask={onOpenTask}
    onOpenCindy={() => {}} onSwitchHome={() => {}} />));
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
    deviceId="pc" deviceName="PC" sessionId="chat" online cloudHome={false} onOpenTask={() => {}}
    onOpenCindy={() => {}} onSwitchHome={() => {}} />));
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
    deviceId="pc" deviceName="PC" sessionId="chat" online cloudHome={false} onOpenTask={() => {}}
    onOpenCindy={() => {}} onSwitchHome={() => {}} />;
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
