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
    const run = (id: string, agentKind: string, daysAgo: number) => ({
      ...item(id, { agentKind, daysAgo }),
      scheduleInfo: { scheduleId: 'nightly', scheduleName: 'Nightly', unreadRunIds: [], unreadCount: 0 },
      session: { ...item(id, { agentKind, daysAgo }).session, source: 'scheduler', title: 'Nightly' },
      title: 'Nightly',
    }) as unknown as RemoteSessionListItem;
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
      worktreePath: '/repo/.claude/worktrees/feature-x',
    };
    expect(buildHomeSessionInfoPieces(session, ['cost', 'pr', 'time', 'tokens', 'worktree'])).toEqual([
      { key: 'cost', text: '$3.20' },
      { key: 'pr' },
      { key: 'time' },
      { key: 'tokens', text: '1.4M' },
      { key: 'worktree', name: 'feature-x', path: '/repo/.claude/worktrees/feature-x' },
    ]);
    expect(buildHomeSessionInfoPieces({}, ['tokens', 'cost', 'worktree'])).toEqual([]);
    expect(buildHomeSessionInfoPieces({ totalCostUsd: 12.4 }, ['cost'])).toEqual([{ key: 'cost', text: '$12' }]);
    expect(buildHomeSessionInfoPieces(session, [])).toEqual([]);
  });

  it('appends newly checked fields and removes unchecked ones in place', () => {
    expect(toggleTaskInfoField(['time'], 'cost')).toEqual(['time', 'cost']);
    expect(toggleTaskInfoField(['time', 'cost', 'pr'], 'cost')).toEqual(['time', 'pr']);
  });
});

describe('task info usage wiring', () => {
  const meta = readFileSync(resolve(process.cwd(), 'src/session/HomeSessionInfoMeta.tsx'), 'utf8');
  const store = readFileSync(resolve(process.cwd(), 'src/session/remoteSessionStore.ts'), 'utf8');

  it('reads token / cost per row because the Home projection strips usage fields', () => {
    // Home 列表投影刻意去掉用量(避免用量推送重排分组),行上的 Token / 费用必须单独订阅。
    expect(store).toContain('delete projected.totalTokenUsage;');
    expect(meta).toContain("taskInfoFields.includes('tokens') || taskInfoFields.includes('cost')");
    expect(meta.match(/useRemoteSessionUsage\(/g)?.length).toBe(2);
  });

  it('re-evaluates the last-activity filter on a clock while the list stays open', () => {
    const surface = readFileSync(resolve(process.cwd(), 'src/session/HomeSurface.tsx'), 'utf8');
    expect(surface).toContain("const filterTick = useHomeFilterClock(lastActivityFilter !== 'all' && screenFocused);");
    expect(surface).toContain('applyHomeContentFilters(sharedGroup.home, contentFilters, filterTick || Date.now())');
  });

  it('polls PR status only while the retained home list is visible', () => {
    // 首页被盖住时任务行仍挂载:轮询前检查可见性,回到首页时补查一次。
    expect(meta).toContain("if (AppState.currentState !== 'active' || !isActive()) return;");
    expect(meta).toContain('const stopResume = onResume(refresh);');
    expect(store).toContain('export function useRemoteSessionStoreVisibility()');
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
    refreshHomeSessionPr('k', load, { now: 0, refreshKey: 'a' });
    refreshHomeSessionPr('k', load, { now: 0, refreshKey: 'a' });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(load).toHaveBeenCalledTimes(1);
    expect(readHomeSessionPr('k')?.ref.prNumber).toBe(7);

    // 未过期且任务没变化:不重查;任务有更新但距上次不足 10 秒:也不重查。
    refreshHomeSessionPr('k', load, { now: 5_000, refreshKey: 'a' });
    refreshHomeSessionPr('k', load, { now: 5_000, refreshKey: 'b' });
    expect(load).toHaveBeenCalledTimes(1);

    const failing = vi.fn(async () => { throw new Error('offline'); });
    refreshHomeSessionPr('k', failing, { now: 20_000, refreshKey: 'b' });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    expect(failing).toHaveBeenCalledTimes(1);
    expect(readHomeSessionPr('k')?.ref.prNumber).toBe(7);
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
