import ts from 'typescript';
import { buildMobileHomePresentation } from '@/session/mobileHome';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activeContentFilterCount,
  buildHomeSessionInfoPieces,
  toggleProjectFilter,
  toggleTaskInfoField,
  type HomeContentFilters,
} from '@/session/homeDisplaySettings';
import { applyHomeContentFilters, filterSharedHomeRows } from '@/session/homeContentFilters';
import { buildGroupedHomeRows, buildMixedHomeRows } from '@/session/homeSections';
import type { MobileHomePresentation, MobileHomeProjectGroup } from '@/session/mobileHome';
import type { RemoteSessionListItem } from '@/session/sessionList';
import { groupAutomationListItems } from '@cindy/maker-shared/session-list';
import { reorderVisibleProjectByDropIndex } from '@/session/homeProjectOrder';
import {
  __testing as prStoreTesting,
  latestPrRef,
  loadHomeSessionPr,
  readHomeSessionPr,
  refreshHomeSessionPr,
  subscribeHomeSessionPr,
} from '@/session/homeSessionPrStore';

const NOW = Date.parse('2026-10-02T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function item(
  id: string,
  options: { daysAgo?: number; agentKind?: string; createdDaysAgo?: number } = {},
): RemoteSessionListItem {
  const activity = new Date(NOW - (options.daysAgo ?? 0) * DAY).toISOString();
  return {
    lastActivityAt: activity,
    pendingInteractionCount: 0,
    session: {
      agentKind: options.agentKind ?? 'cc',
      createdAt: new Date(NOW - (options.createdDaysAgo ?? options.daysAgo ?? 0) * DAY).toISOString(),
      id,
    },
  } as unknown as RemoteSessionListItem;
}

function project(key: string, sessions: RemoteSessionListItem[]): MobileHomeProjectGroup {
  return {
    key,
    latestActivityAt: sessions.map((entry) => entry.lastActivityAt).sort().at(-1) ?? '',
    sessionCount: sessions.length,
    sessions,
  } as unknown as MobileHomeProjectGroup;
}

function home(over: Partial<MobileHomePresentation>): MobileHomePresentation {
  return { chats: [], pinned: [], projects: [], ...over } as unknown as MobileHomePresentation;
}

function run(id: string, agentKind: string, daysAgo: number): RemoteSessionListItem {
  const base = item(id, { agentKind, daysAgo });
  return {
    ...base,
    scheduleInfo: { scheduleId: 'nightly', scheduleName: 'Nightly', unreadRunIds: [], unreadCount: 0 },
    session: { ...base.session, source: 'scheduler', title: 'Nightly' },
    title: 'Nightly',
  } as unknown as RemoteSessionListItem;
}

const NO_FILTERS: HomeContentFilters = { lastActivity: 'all', projects: 'all', vendor: 'all' };

describe('home content filters (desktop 筛选 parity)', () => {
  const fixture = home({
    chats: [item('chat-cc'), item('chat-codex', { agentKind: 'codex' })],
    pinned: [item('pin-old', { daysAgo: 40 }), item('pin-codex', { agentKind: 'codex' })],
    projects: [
      project('p1', [item('p1-new'), item('p1-old', { daysAgo: 10 })]),
      project('p2', [item('p2-pi', { agentKind: 'pi' })]),
    ],
  });

  it('filters by multiple teammate identities, preserves pinned rows and excludes unknown shared owners', () => {
    const filters: HomeContentFilters = { ...NO_FILTERS, teammates: ['cindy', 'filo'],
      teammateKey: row => row.session.id === 'chat-cc' ? 'cindy' : row.session.id === 'p2-pi' ? 'filo' : undefined };
    const result = applyHomeContentFilters(fixture, filters, NOW);
    expect(result.chats.map(row => row.session.id)).toEqual(['chat-cc']);
    expect(result.projects.map(row => row.key)).toEqual(['p2']);
    expect(result.pinned).toBe(fixture.pinned);
    expect(activeContentFilterCount(filters)).toBe(1);
    const hidden = applyHomeContentFilters(fixture, { ...filters, teammates: 'none' }, NOW);
    expect(hidden.chats.map(row => row.session.id)).toEqual(fixture.chats.filter(row => row.session.id !== 'chat-cc').map(row => row.session.id));
    expect(hidden.projects.map(row => row.key)).toEqual(['p1']);
    expect(hidden.pinned).toBe(fixture.pinned);
    expect(filterSharedHomeRows([{ id: 'unknown' }, { id: 'known', item: item('chat-cc') }], { ...filters, teammates: 'none' }, NOW).map(row => row.id)).toEqual(['unknown']);
    expect(filterSharedHomeRows([{ id: 'unknown' }, { id: 'known', item: item('chat-cc') }], filters, NOW).map(row => row.id)).toEqual(['known']);
  });

  it('returns the same presentation when nothing is filtered', () => {
    expect(applyHomeContentFilters(fixture, NO_FILTERS, NOW)).toBe(fixture);
    expect(activeContentFilterCount(NO_FILTERS)).toBe(0);
  });

  it('narrows by harness outside the pinned section and drops emptied projects', () => {
    const result = applyHomeContentFilters(fixture, { ...NO_FILTERS, vendor: 'codex' }, NOW);
    expect(result.chats.map((entry) => entry.session.id)).toEqual(['chat-codex']);
    // 与桌面一致:筛选不作用于置顶区。
    expect(result.pinned).toBe(fixture.pinned);
    expect(result.projects).toEqual([]);
  });

  it('narrows by last activity and keeps project counts consistent', () => {
    const result = applyHomeContentFilters(fixture, { ...NO_FILTERS, lastActivity: '7d' }, NOW);
    expect(result.pinned.map((entry) => entry.session.id)).toEqual(['pin-old', 'pin-codex']);
    expect(result.projects.map((entry) => [entry.key, entry.sessionCount])).toEqual([['p1', 1], ['p2', 1]]);
    expect(result.projects[0].sessions.map((entry) => entry.session.id)).toEqual(['p1-new']);
  });

  it('project filter hides other projects and chats but never hides pinned tasks', () => {
    const result = applyHomeContentFilters(fixture, { ...NO_FILTERS, projects: ['p2'] }, NOW);
    expect(result.projects.map((entry) => entry.key)).toEqual(['p2']);
    expect(result.chats).toEqual([]);
    expect(result.pinned).toHaveLength(2);
    const chatsOnly = applyHomeContentFilters(fixture, { ...NO_FILTERS, projects: ['dialogue'] }, NOW);
    expect(chatsOnly.projects).toEqual([]);
    expect(chatsOnly.chats).toHaveLength(2);
    expect(activeContentFilterCount({ lastActivity: '1d', projects: ['p2'], vendor: 'pi' })).toBe(3);
  });

  it('filters automation runs individually instead of trusting the group representative', () => {
    const [group] = groupAutomationListItems(
      [run('old-cc', 'cc', 9), run('new-codex-1', 'codex', 0), run('new-codex-2', 'codex', 1)],
      NOW,
    );
    expect(group.automationGroup?.items).toHaveLength(3);
    const fixture = home({ chats: [group] });

    const codex = applyHomeContentFilters(fixture, { ...NO_FILTERS, vendor: 'codex' }, NOW).chats;
    expect(codex).toHaveLength(1);
    expect(codex[0].automationGroup?.items.map((entry) => entry.session.id)).toEqual(['new-codex-1', 'new-codex-2']);
    expect(codex[0].automationGroup?.sessionCount).toBe(2);
    expect(codex[0].automationGroup?.key).toBe(group.automationGroup?.key);

    const cc = applyHomeContentFilters(fixture, { ...NO_FILTERS, vendor: 'cc' }, NOW).chats;
    expect(cc.map((entry) => [entry.session.id, !!entry.automationGroup])).toEqual([['old-cc', false]]);
    expect(applyHomeContentFilters(fixture, { ...NO_FILTERS, vendor: 'pi' }, NOW).chats).toEqual([]);
  });

  it('counts the runs of a filtered automation group in the project total', () => {
    const [group] = groupAutomationListItems(
      [run('old-cc', 'cc', 9), run('new-codex-1', 'codex', 0), run('new-codex-2', 'codex', 1)],
      NOW,
    );
    const fixture = home({ projects: [project('p', [group, item('plain-cc'), item('plain-codex', { agentKind: 'codex' })])] });
    const [filtered] = applyHomeContentFilters(fixture, { ...NO_FILTERS, vendor: 'codex' }, NOW).projects;
    expect(filtered.sessions).toHaveLength(2);
    // 自动化组行剩 2 次运行 + 1 条普通任务。
    expect(filtered.sessionCount).toBe(3);
  });

  it('applies harness and activity filters to shared rows but keeps discovery-only rows', () => {
    const rows = [
      { key: 'a', item: item('shared-codex', { agentKind: 'codex' }) },
      { key: 'b', item: item('shared-cc') },
      { key: 'c' },
    ];
    expect(filterSharedHomeRows(rows, NO_FILTERS, NOW)).toBe(rows);
    expect(filterSharedHomeRows(rows, { ...NO_FILTERS, projects: ['p1'] }, NOW)).toBe(rows);
    expect(filterSharedHomeRows(rows, { ...NO_FILTERS, vendor: 'codex' }, NOW).map((row) => row.key)).toEqual(['a', 'c']);
  });

  it('toggles projects like the desktop: first pick narrows, last un-pick restores all', () => {
    expect(toggleProjectFilter('all', 'p1')).toEqual(['p1']);
    expect(toggleProjectFilter(['p1'], 'p2')).toEqual(['p1', 'p2']);
    expect(toggleProjectFilter(['p1', 'p2'], 'p1')).toEqual(['p2']);
    expect(toggleProjectFilter(['p2'], 'p2')).toBe('all');
  });
});

describe('task info pieces (desktop 任务信息 parity)', () => {
  it('keeps the checked order and skips fields without data', () => {
    const session = {
      totalCostUsd: 0,
      totalMoney: { amount: 3.2, approximate: false, currency: 'USD', kind: 'actual-cost' },
      totalTokenUsage: 1_400_000,
    };
    expect(buildHomeSessionInfoPieces(session, ['cost', 'pr', 'time', 'tokens'])).toEqual([
      { key: 'cost', text: '$3.20' },
      { key: 'pr' },
      { key: 'time' },
      { key: 'tokens', text: '1.4M' },
    ]);
    expect(buildHomeSessionInfoPieces({}, ['tokens', 'cost'])).toEqual([]);
    expect(buildHomeSessionInfoPieces({ totalCostUsd: 12.4 }, ['cost'])).toEqual([{ key: 'cost', text: '$12' }]);
    expect(buildHomeSessionInfoPieces(session, [])).toEqual([]);
  });

  it('appends newly checked fields and removes unchecked ones in place', () => {
    expect(toggleTaskInfoField(['time'], 'cost')).toEqual(['time', 'cost']);
    expect(toggleTaskInfoField(['time', 'cost', 'pr'], 'cost')).toEqual(['time', 'pr']);
  });
});

const surface = ts.createSourceFile('home.tsx', readFileSync(resolve(process.cwd(), 'src/session/HomeSurface.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function evaluate(node: ts.Node, file: ts.SourceFile, scope: Record<string, unknown>): any {
  const compiled = ts.transpileModule('function evaluate() { return (' + node.getText(file) + '); }', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText;
  return new Function(...Object.keys(scope), compiled + '; return evaluate();')(...Object.values(scope));
}
function surfaceValue(name: string, scope: Record<string, unknown>): any {
  let initializer: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (!initializer && ts.isVariableDeclaration(node) && node.name.getText(surface) === name) initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(surface);
  if (!initializer) throw new Error('Missing production Home initializer: ' + name);
  return evaluate(initializer, surface, scope);
}
const useMemo = (build: () => unknown) => build();

describe('task info and retained Home behavior', () => {
  it('keeps worktree off the mobile task info (desktop-only per sidebar plan 3.4)', async () => {
    const { normalizeTaskInfoFields } = await import('@/session/homeDisplaySettings');
    expect(normalizeTaskInfoFields(['worktree', 'pr'])).toEqual(['pr']);
  });

  it('counts each dialogue automation run in the actual display-menu input', () => {
    const projectFilterUniverse = { chats: [item('normal'), { ...item('automation'), automationGroup: { sessionCount: 4 } }], projects: [] };
    const options = surfaceValue('homeDisplayPullDownActions', { useMemo, projectFilterUniverse,
      selectedDeviceId: null, teammateOptions: [], displayMenuState: {}, t: (key: string) => key,
      buildHomeDisplayPullDownActions: (value: unknown) => value });
    expect(options.dialogueCount).toBe(5);
  });

  it('keeps hidden project slots when applying the actual host-visible subset', () => {
    const visible = surfaceValue('visibleKeys', { visibleProjectKeys: ['A', 'C', 'read-only'], hostWritable: new Set(['A', 'B', 'C']) });
    expect(reorderVisibleProjectByDropIndex(['A', 'B', 'C'], visible, 'C', 0)).toEqual(['C', 'B', 'A']);
  });

  it('keeps real project candidates available despite nonmatching search and status', () => {
    const sessions = ['A', 'B'].map((name) => ({ ...item(name).session, title: name, workingDir: '/' + name,
      workspaceKind: 'project', status: 'active', deviceLinkDeviceId: 'd', deviceLinkDeviceName: 'Computer' }));
    // Keep the existing production-expression fixture complete when aliases become an optional Home input.
    const result = surfaceValue('projectFilterUniverse', { useMemo, buildMobileHomePresentation,
      deviceModels: [], scheduleIndex: new Map(), selectedDeviceId: null, homeSessions: sessions,
      projectAliases: new Map([['device:d:/A', 'Customer Portal']]),
      t: (key: string) => key, searchQuery: 'no match', statusFilter: 'running' });
    expect(result.projects.map((project: { workingDir: string }) => project.workingDir).sort()).toEqual(['/A', '/B']);
    // #7026: the production initializer consumes host aliases; keep that input
    // in this unit fixture and verify its visible title without filtering candidates.
    expect(result.projects.find((project: { workingDir: string }) => project.workingDir === '/A')?.title)
      .toBe('Customer Portal');
  });

  it('expires active-time rows using the actual clock input while Home stays open', () => {
    for (const [filter, focused, enabled] of [['all', true, false], ['1d', false, false], ['1d', true, true]] as const) {
      expect(surfaceValue('filterTick', { lastActivityFilter: filter, screenFocused: focused,
        useHomeFilterClock: (active: boolean) => active })).toBe(enabled);
    }
    const input = home({ chats: [item('recent', { daysAgo: 0.5 })] });
    const scope = { useMemo, sharedGroup: { home: input }, applyHomeContentFilters,
      contentFilters: { ...NO_FILTERS, lastActivity: '1d' } };
    expect(surfaceValue('filteredHome', { ...scope, filterTick: NOW }).chats).toHaveLength(1);
    expect(surfaceValue('filteredHome', { ...scope, filterTick: NOW + DAY }).chats).toHaveLength(0);
  });

  it('pauses PR polling under another page and refreshes on resume, with cleanup', () => {
    const file = ts.createSourceFile('meta.tsx', readFileSync(resolve(process.cwd(), 'src/session/HomeSessionInfoMeta.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const hook = file.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'useHomeSessionPr');
    let callback: ts.Expression | undefined;
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(file) === 'useEffect') callback = node.arguments[0];
      ts.forEachChild(node, visit);
    }
    if (!hook) throw new Error('Missing PR hook');
    visit(hook);
    if (!callback) throw new Error('Missing PR lifecycle effect');
    let visible = true;
    let poll!: () => void;
    let resume!: () => void;
    let foreground!: (state: string) => void;
    const remove = vi.fn(), stopResume = vi.fn(), clearInterval = vi.fn();
    const refreshHomeSessionPr = vi.fn((_key: string, _load: () => unknown, _options: unknown) => 0);
    const AppState = { currentState: 'active', addEventListener: (_event: string, callback: typeof foreground) => { foreground = callback; return { remove }; } };
    const effect = evaluate(callback, file, { key: 'cache', deviceId: 'd', sessionId: 's', online: true, foreground: false, includeRelated: false,
      isActive: () => visible, AppState, refreshHomeSessionPr, loadHomeSessionPr: vi.fn(), link: {}, refreshKey: 'updated',
      PR_STATUS_REFRESH_INTERVAL_MS: 90_000, Date, clearInterval, clearTimeout: vi.fn(),
      setInterval: (fn: () => void) => { poll = fn; return 1; }, setTimeout: vi.fn(),
      onResume: (fn: () => void) => { resume = fn; return stopResume; } });
    const cleanup = effect();
    expect(refreshHomeSessionPr).toHaveBeenCalledTimes(1);
    visible = false; poll(); resume();
    expect(refreshHomeSessionPr).toHaveBeenCalledTimes(1);
    visible = true; resume();
    expect(refreshHomeSessionPr).toHaveBeenCalledTimes(2);
    expect(refreshHomeSessionPr.mock.calls[1]?.[2]).toMatchObject({ eventful: true });
    AppState.currentState = 'background'; poll();
    expect(refreshHomeSessionPr).toHaveBeenCalledTimes(2);
    AppState.currentState = 'active'; foreground('active');
    expect(refreshHomeSessionPr).toHaveBeenCalledTimes(3);
    cleanup(); expect(clearInterval).toHaveBeenCalledWith(1);
    expect(remove).toHaveBeenCalledOnce(); expect(stopResume).toHaveBeenCalledOnce();
  });
});

describe('creation-time task sort', () => {
  it('orders sessions and folders by creation time, ignoring later activity', () => {
    const presentation = home({
      chats: [
        item('old-but-active', { createdDaysAgo: 9, daysAgo: 0 }),
        item('new-but-idle', { createdDaysAgo: 1, daysAgo: 5 }),
      ],
      projects: [project('p', [item('p-mid', { createdDaysAgo: 3, daysAgo: 3 })])],
    });
    expect(buildMixedHomeRows(presentation, { sortBy: 'created' }).map((row) => row.key)).toEqual([
      'chat:new-but-idle',
      'project:p:p-mid',
      'chat:old-but-active',
    ]);
    expect(buildGroupedHomeRows(presentation, { sortBy: 'created' }).map((row) => row.key)).toEqual([
      'chat:new-but-idle',
      'p',
      'chat:old-but-active',
    ]);
  });

  it('sorts an automation group by its newest run, not by an older representative', () => {
    const [group] = groupAutomationListItems([run('run-old', 'cc', 9), run('run-new', 'cc', 0)], NOW);
    // 组代表可能是较旧的未读 / 待处理运行。
    const olderPrimary = {
      ...group,
      session: { ...group.session, createdAt: new Date(NOW - 9 * DAY).toISOString() },
    } as RemoteSessionListItem;
    const presentation = home({ chats: [item('mid', { createdDaysAgo: 3, daysAgo: 3 }), olderPrimary] });
    expect(buildMixedHomeRows(presentation, { sortBy: 'created' }).map((row) => row.key)).toEqual([
      `chat:${olderPrimary.automationGroup?.key}`,
      'chat:mid',
    ]);
  });
});

describe('home PR cache', () => {
  beforeEach(() => prStoreTesting.reset());

  it('picks the most recently seen valid PR reference', () => {
    expect(latestPrRef([
      { owner: 'a', repo: 'r', prNumber: 1, lastSeenAt: 10 },
      { owner: 'a', repo: 'r', prNumber: 2, lastSeenAt: 30 },
      { owner: 'a', repo: 'r', prNumber: 0, lastSeenAt: 99 },
      null,
    ])?.prNumber).toBe(2);
    expect(latestPrRef(null)).toBeNull();
  });

  it('dedupes loads, keeps the last value on failure and refreshes only when stale', async () => {
    const ref = { id: '1', sessionId: 's', owner: 'a', repo: 'r', prNumber: 7, url: '', firstSeenAt: 1, lastSeenAt: 1 };
    const listener = vi.fn();
    subscribeHomeSessionPr('k', listener);
    const load = vi.fn(async () => ({ ref, status: null }));
    expect(refreshHomeSessionPr('k', load, { now: 0, refreshKey: 'a' })).toBe(0);
    // 在途期间同一状态不排补查;任务有变化时让调用方稍后补查。
    expect(refreshHomeSessionPr('k', load, { now: 0, refreshKey: 'a' })).toBe(0);
    expect(refreshHomeSessionPr('k', load, { now: 500, refreshKey: 'b' })).toBe(9_500);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(load).toHaveBeenCalledTimes(1);
    expect(readHomeSessionPr('k')?.ref.prNumber).toBe(7);

    // 未过期且任务没变化:不重查;任务有更新但距上次不足 10 秒:不重查,告知补查等待时长。
    expect(refreshHomeSessionPr('k', load, { now: 5_000, refreshKey: 'a' })).toBe(0);
    expect(refreshHomeSessionPr('k', load, { now: 5_000, refreshKey: 'b' })).toBe(5_000);
    // 回到首页 / 前台:同样绕过 90 秒缓存期,只保留 10 秒防抖。
    expect(refreshHomeSessionPr('k', load, { now: 5_000, refreshKey: 'a', eventful: true })).toBe(5_000);
    expect(load).toHaveBeenCalledTimes(1);

    const failing = vi.fn(async () => { throw new Error('offline'); });
    refreshHomeSessionPr('k', failing, { now: 20_000, refreshKey: 'b' });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    expect(failing).toHaveBeenCalledTimes(1);
    expect(readHomeSessionPr('k')?.ref.prNumber).toBe(7);

    // 同一任务状态下,回到前台在 90 秒缓存期内(距上次 15 秒)也会重查。
    expect(refreshHomeSessionPr('k', load, { now: 35_000, refreshKey: 'b' })).toBe(0);
    expect(load).toHaveBeenCalledTimes(1);
    expect(refreshHomeSessionPr('k', load, { now: 35_000, refreshKey: 'b', eventful: true })).toBe(0);
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(3));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps the last known status of the same PR when the status lookup fails', async () => {
    const ref = { id: '1', sessionId: 's', owner: 'a', repo: 'r', prNumber: 7, url: '', firstSeenAt: 1, lastSeenAt: 1 };
    const merged = { owner: 'a', repo: 'r', prNumber: 7, ok: true, status: 'merged' };
    const invoke = vi.fn(async (_device: string, channel: string) => {
      if (channel === 'git-context:pr-refs:list') return [ref];
      throw new Error('offline');
    }) as never;
    const previous = { ref, status: merged } as never;
    await expect(loadHomeSessionPr(invoke, 'd', 's', previous)).resolves.toEqual({ ref, status: merged });
    // 换成另一个 PR 时没有可沿用的状态。
    const other = { ref: { ...ref, prNumber: 8 }, status: { ...merged, prNumber: 8 } } as never;
    await expect(loadHomeSessionPr(invoke, 'd', 's', other)).resolves.toEqual({ ref, status: null });
  });
});


// Glance needs multiple associated PRs; the existing Home row keeps its one-PR contract.
it('loads the bounded PR list for glance and retains each known title through lookup failure', async () => {
  const refs = [1, 2, 3, 4].map(n => ({ id: String(n), sessionId: 's', owner: 'example', repo: 'app', prNumber: n, lastSeenAt: n }));
  const invoke = vi.fn(async (_device: string, channel: string) => channel.endsWith('list') ? refs :
    refs.map(ref => ({ ...ref, ok: true, status: 'merged', title: `Actual PR ${ref.prNumber}` }))) as any;
  const result = await loadHomeSessionPr(invoke, 'd', 's', null, true);
  expect([result, ...result!.additional!].map(row => row!.ref.prNumber)).toEqual([4, 3, 2]);
  expect(result!.status).toMatchObject({ title: 'Actual PR 4' });
  invoke.mockImplementation(async (_device: string, channel: string) => { if (channel.endsWith('list')) return refs; throw new Error('offline'); });
  expect(await loadHomeSessionPr(invoke, 'd', 's', result, true)).toEqual(result);
});
