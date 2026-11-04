import { describe, expect, it } from 'vitest';

import {
  sortProjectsForSidebar,
  sortSessionsForSidebar,
} from '@/features/cc-agent/lib/sidebarProjectSorting';
import { advanceViewedPriorityHold, buildMainListEntries, type MainListPriorityContext } from '@/features/cc-agent/lib/mainListModel';
import { LIVE_TASK_PRIORITY } from '../../shared/liveTaskPriority';
import { sessionActivityMs } from '@/features/cc-agent/lib/dateSessionGrouping';
import type { ProjectNode } from '@/features/cc-agent/lib/projectGrouping';
import type { Session } from '@/lib/ccAgent.types';

function session(partial: Partial<Session>): Session {
  const updatedAt = partial.updatedAt ?? '2026-01-01T00:00:00.000Z';
  return {
    id: partial.id ?? 's',
    userId: 'u',
    title: partial.title ?? 'session',
    workingDir: partial.workingDir ?? '/repo',
    workspaceKind: partial.workspaceKind ?? 'project',
    model: 'm',
    effort: 'medium' as Session['effort'],
    permissionMode: 'default' as Session['permissionMode'],
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindow: 0,
    fastMode: false,
    clearedAt: null,
    pinnedAt: null,
    // 显式传 null 时保留 null（测试回落逻辑）；仅在字段缺省时默认到 updatedAt。
    userSendAt: 'userSendAt' in partial ? (partial.userSendAt ?? null) : updatedAt,
    status: partial.status ?? 'active',
    agentKind: partial.agentKind ?? 'cc',
    extraDirs: [],
    createdAt: partial.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt,
    _count: partial._count,
  };
}

function project(
  partial: Partial<ProjectNode> & Pick<ProjectNode, 'workingDir' | 'displayName'>,
): ProjectNode {
  const projectKey = partial.projectKey ?? `local:${partial.workingDir}`;
  return {
    projectKey,
    scope: partial.scope ?? 'local',
    remoteHostId: partial.remoteHostId ?? null,
    deviceLinkDeviceId: partial.deviceLinkDeviceId ?? null,
    deviceLinkDeviceName: partial.deviceLinkDeviceName ?? null,
    deviceLinkConnectionStatus: partial.deviceLinkConnectionStatus ?? null,
    segments: 1,
    sessions: [],
    latestActivityAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('sidebar project sorting', () => {
  // #7469, unit: grouping reuse must survive both production sorting stages.
  // Existing ordering assertions did not catch needless project replacement.
  it('retains an unchanged project through sidebar and main-list sorting but applies a changed order', () => {
    const older = session({ id: 'older', updatedAt: '2026-01-01T00:00:00Z' });
    const newer = session({ id: 'newer', updatedAt: '2026-01-02T00:00:00Z' });
    const node = project({ workingDir: '/repo', displayName: 'repo', sessions: [newer, older] });
    const sorted = sortProjectsForSidebar([node], 'recency', []);
    expect(sorted[0]).toBe(node);
    const entries = buildMainListEntries({
      projects: sorted, dialogues: [], unclassified: [], groupBy: 'project',
      groupDialogue: false, sortBy: 'recency', manualProjectOrder: [],
    });
    expect(entries[0].kind).toBe('project');
    if (entries[0].kind !== 'project') throw new Error('Missing project');
    expect(entries[0].project).toBe(node);
    const reversed = { ...node, sessions: [older, newer] };
    const changed = buildMainListEntries({
      projects: [reversed], dialogues: [], unclassified: [], groupBy: 'project',
      groupDialogue: false, sortBy: 'recency', manualProjectOrder: [],
    });
    expect(changed[0].kind).toBe('project');
    if (changed[0].kind !== 'project') throw new Error('Missing project');
    expect(changed[0].project.sessions).toEqual([newer, older]);
    expect(reversed.sessions).toEqual([older, newer]);
  });

  it('applies manual project order with unranked projects after ranked projects', () => {
    const sorted = sortProjectsForSidebar(
      [
        project({ workingDir: '/p/alpha', displayName: 'alpha' }),
        project({ workingDir: '/p/beta', displayName: 'beta' }),
        project({ workingDir: '/p/gamma', displayName: 'gamma' }),
      ],
      'recency',
      ['local:/p/gamma', 'local:/p/alpha'],
      'custom',
    );

    expect(sorted.map((p) => p.workingDir)).toEqual(['/p/gamma', '/p/alpha', '/p/beta']);
  });

  it('applies a stored Windows order to persistent representatives with different casing', () => {
    const sorted = sortProjectsForSidebar(
      [
        project({ workingDir: 'd:/école/alpha', displayName: 'alpha' }),
        project({ workingDir: 'd:/école/beta', displayName: 'beta' }),
      ],
      'recency',
      ['local:D:/École/BETA', 'local:D:/École/ALPHA'],
      'custom',
      'win32',
    );

    expect(sorted.map((p) => p.workingDir)).toEqual(['d:/école/beta', 'd:/école/alpha']);
  });

  // 排序时钟 = userSendAt ?? updatedAt(以用户最近一次按下发送为主键)。原先经
  // sortSessionsForSidebar(…, 'time') 间接验证;'time'(最早优先)2026-08-12 用户
  // 裁决删除后,直接对时钟函数断言——不变量本身没变,只是不再借道那个档位。
  it('uses userSendAt as the sort clock, ignoring later updatedAt bumps', () => {
    // laterSend.updatedAt 有意设得比 earlierSend 更新(模拟 agent 回复 / scheduler
    // fire 只 bump updatedAt),验证这类改动不影响排序时钟。
    const earlierSend = session({
      id: 'earlier-send',
      userSendAt: '2026-01-05T00:00:00.000Z',
      updatedAt: '2026-01-06T00:00:00.000Z',
    });
    const laterSend = session({
      id: 'later-send',
      userSendAt: '2026-01-10T00:00:00.000Z',
      updatedAt: '2026-01-20T00:00:00.000Z',
    });

    expect(sessionActivityMs(earlierSend)).toBeLessThan(sessionActivityMs(laterSend));
    expect(sessionActivityMs(laterSend)).toBe(new Date('2026-01-10T00:00:00.000Z').getTime());
  });

  it('falls back to updatedAt when userSendAt is null', () => {
    // userSendAt == null（scheduler fire / 从未发送的会话）回落到 updatedAt。
    const noSend = session({
      id: 'no-send',
      userSendAt: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const withSend = session({
      id: 'with-send',
      userSendAt: '2026-01-08T00:00:00.000Z',
      updatedAt: '2026-01-09T00:00:00.000Z',
    });

    expect(sessionActivityMs(noSend)).toBe(new Date('2026-01-01T00:00:00.000Z').getTime());
    expect(sessionActivityMs(noSend)).toBeLessThan(sessionActivityMs(withSend));
  });

  // 时间档位删除后,会话顺序由调用方(mainListModel / 上游查询)决定,本函数不再重排。
  it('keeps the incoming session order for every remaining sort mode', () => {
    const a = session({ id: 'a', userSendAt: '2026-01-10T00:00:00.000Z' });
    const b = session({ id: 'b', userSendAt: '2026-01-05T00:00:00.000Z' });
    expect(sortSessionsForSidebar([a, b], 'recency').map((s) => s.id)).toEqual(['a', 'b']);
    expect(sortSessionsForSidebar([b, a], 'priority').map((s) => s.id)).toEqual(['b', 'a']);
  });
});

it('sorts project-panel tasks by creation time, with stable ties and no activity fallback', () => {
  const old = session({ id: 'old', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z' });
  const a = session({ id: 'a', createdAt: '2026-02-01T00:00:00Z' });
  const b = session({ id: 'b', createdAt: a.createdAt });
  const invalid = session({ id: 'invalid', createdAt: 'invalid', updatedAt: '2026-09-09T00:00:00Z' });
  const input = [old, b, invalid, a];
  expect(sortSessionsForSidebar(input, 'created').map((s) => s.id)).toEqual(['a', 'b', 'old', 'invalid']);
  expect(input.map((s) => s.id)).toEqual(['old', 'b', 'invalid', 'a']);
});


it.each(['activity', 'custom'] as const)('keeps collapsed and expanded project ordering consistent for %s order', (projectOrder) => {
  const older = project({
    workingDir: '/older', displayName: 'older',
    sessions: [session({ id: 'older', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z' })],
  });
  const newer = project({
    workingDir: '/newer', displayName: 'newer',
    sessions: [session({ id: 'newer', createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' })],
  });
  const projects = [older, newer];
  const manualOrder = [older.projectKey, newer.projectKey];
  const collapsed = sortProjectsForSidebar(projects, 'created', manualOrder, projectOrder);
  const expanded = buildMainListEntries({
    projects, dialogues: [], groupBy: 'project', groupDialogue: false,
    sortBy: 'created', projectOrder, manualProjectOrder: manualOrder,
  });
  const keys = collapsed.map((item) => item.projectKey);
  expect(keys).toEqual(projectOrder === 'custom' ? manualOrder : [...manualOrder].reverse());
  expect(keys).toEqual(expanded.map((entry) => entry.kind === 'project' ? entry.project.projectKey : 'unexpected'));
});

function projectKeys(projects: readonly { projectKey: string }[]): string[] {
  return projects.map((item) => item.projectKey);
}

// PR #6983 拆分：原面板缺少同一项目内 priority 状态排序覆盖。
// 生产入口 sortProjectsForSidebar；最小失败输入是较新空闲任务 + 较旧运行任务。
// unit tier；同时覆盖状态结束后的重排、手动项目顺序与输入不可变。
it('sorts project-panel children by priority without changing manual project order', () => {
  const idle = session({ id: 'idle', userSendAt: '2026-03-01T00:00:00Z' });
  const running = session({ id: 'running', userSendAt: '2026-01-01T00:00:00Z' });
  const waiting = session({ id: 'waiting', userSendAt: '2026-02-01T00:00:00Z' });
  const first = project({ workingDir: '/first', displayName: 'first', sessions: [idle, running, waiting] });
  const second = project({ workingDir: '/second', displayName: 'second' });
  const context: MainListPriorityContext = {
    runningSessionIds: new Set(['running']),
    attentionSessionIds: new Set(['waiting']),
    waitingSessionIds: new Set(['waiting']),
  };
  const sorted = sortProjectsForSidebar(
    [first, second], 'priority', [first.projectKey, second.projectKey], 'custom', '', context,
  );
  expect(sorted.map((item) => item.projectKey)).toEqual([first.projectKey, second.projectKey]);
  expect(sorted[0].sessions.map((item) => item.id)).toEqual(['waiting', 'running', 'idle']);
  expect(first.sessions.map((item) => item.id)).toEqual(['idle', 'running', 'waiting']);
  expect(sortProjectsForSidebar(
    [first], 'priority', [], 'activity', '', { ...context, runningSessionIds: new Set() },
  )[0].sessions.map((item) => item.id)).toEqual(['waiting', 'idle', 'running']);
});

function expandedProjectKeys(
  projects: ProjectNode[],
  sortBy: 'priority' | 'recency' | 'created',
  projectOrder: 'activity' | 'custom',
  manualOrder: readonly string[],
  priorityContext?: MainListPriorityContext,
): string[] {
  return buildMainListEntries({
    projects,
    dialogues: [],
    groupBy: 'project',
    groupDialogue: false,
    sortBy,
    projectOrder,
    manualProjectOrder: manualOrder,
    priorityContext,
  }).map((entry) => (entry.kind === 'project' ? entry.project.projectKey : 'unexpected'));
}

it('orders collapsed projects with the same priority context as the expanded list', () => {
  const newer = project({
    workingDir: '/synthetic/newer',
    displayName: 'newer',
    sessions: [session({ id: 'newer', updatedAt: '2026-03-02T00:00:00.000Z', userSendAt: '2026-03-02T00:00:00.000Z' })],
  });
  const waiting = project({
    workingDir: '/synthetic/waiting',
    displayName: 'waiting',
    sessions: [session({ id: 'waiting', updatedAt: '2026-01-01T00:00:00.000Z', userSendAt: '2026-01-01T00:00:00.000Z' })],
  });
  const unread = project({
    workingDir: '/synthetic/unread',
    displayName: 'unread',
    sessions: [session({ id: 'unread', updatedAt: '2026-02-01T00:00:00.000Z', userSendAt: '2026-02-01T00:00:00.000Z' })],
  });
  const running = project({
    workingDir: '/synthetic/running',
    displayName: 'running',
    sessions: [session({ id: 'running', updatedAt: '2026-04-01T00:00:00.000Z', userSendAt: '2026-04-01T00:00:00.000Z' })],
  });
  const projects = [newer, waiting, unread, running];
  const inputKeys = projectKeys(projects);
  const ctx: MainListPriorityContext = {
    runningSessionIds: new Set(['running']),
    attentionSessionIds: new Set(['waiting', 'unread']),
    waitingSessionIds: new Set(['waiting']),
  };
  const collapsed = sortProjectsForSidebar(projects, 'priority', [], 'activity', '', ctx);
  expect(projectKeys(collapsed)).toEqual(['local:/synthetic/waiting', 'local:/synthetic/unread', 'local:/synthetic/running', 'local:/synthetic/newer']);
  expect(projectKeys(collapsed)).toEqual(expandedProjectKeys(projects, 'priority', 'activity', [], ctx));
  expect(projectKeys(projects)).toEqual(inputKeys);

  const manual = ['local:/synthetic/newer', 'local:/synthetic/waiting', 'local:/synthetic/unread', 'local:/synthetic/running'];
  const custom = sortProjectsForSidebar(projects, 'priority', manual, 'custom', '', ctx);
  expect(projectKeys(custom)).toEqual(manual);
  expect(projectKeys(custom)).toEqual(expandedProjectKeys(projects, 'priority', 'custom', manual, ctx));

  const byRecency = sortProjectsForSidebar(projects, 'recency', [], 'activity', '', ctx);
  expect(projectKeys(byRecency)).toEqual(inputKeys);
  const byCreated = sortProjectsForSidebar(projects, 'created', [], 'activity', '', ctx);
  expect(projectKeys(byCreated)).toEqual(expandedProjectKeys(projects, 'created', 'activity', []));
});

it('keeps a held unread project ahead of newer idle work and uses recently viewed time within rest', () => {
  const held = project({
    workingDir: '/held',
    displayName: 'held',
    sessions: [session({ id: 'held', updatedAt: '2026-01-01T00:00:00.000Z', userSendAt: '2026-01-01T00:00:00.000Z' })],
  });
  const fresh = project({
    workingDir: '/fresh',
    displayName: 'fresh',
    sessions: [session({ id: 'fresh', updatedAt: '2026-04-01T00:00:00.000Z', userSendAt: '2026-04-01T00:00:00.000Z' })],
  });
  const viewed = project({
    workingDir: '/viewed',
    displayName: 'viewed',
    sessions: [session({ id: 'viewed', updatedAt: '2026-01-02T00:00:00.000Z', userSendAt: '2026-01-02T00:00:00.000Z' })],
  });
  const quiet = project({
    workingDir: '/quiet',
    displayName: 'quiet',
    sessions: [session({ id: 'quiet', updatedAt: '2026-03-01T00:00:00.000Z', userSendAt: '2026-03-01T00:00:00.000Z' })],
  });
  const projects = [fresh, quiet, viewed, held];
  const ctx: MainListPriorityContext = {
    runningSessionIds: new Set(),
    attentionSessionIds: new Set(),
    heldPriorityRanks: new Map([['held', LIVE_TASK_PRIORITY.unread]]),
    recentlyViewedAtMs: new Map([['viewed', Date.parse('2026-05-01T00:00:00.000Z')]]),
  };
  const collapsed = sortProjectsForSidebar(projects, 'priority', [], 'activity', '', ctx);
  expect(projectKeys(collapsed)).toEqual(['local:/held', 'local:/viewed', 'local:/fresh', 'local:/quiet']);
  expect(projectKeys(collapsed)).toEqual(expandedProjectKeys(projects, 'priority', 'activity', [], ctx));
});

it('keeps one recently viewed timestamp after the hold is committed', () => {
  const natural = {
    runningSessionIds: new Set<string>(),
    attentionSessionIds: new Set(['leaving']),
  };
  const switched = advanceViewedPriorityHold(
    {
      prevViewedId: 'leaving',
      heldPriorityRanks: new Map([['leaving', LIVE_TASK_PRIORITY.unread]]),
      recentlyViewedAtMs: new Map(),
    },
    'next',
    natural,
    1_700_000_000_000,
  );
  expect(switched.recentlyViewedAtMs.get('leaving')).toBe(1_700_000_000_000);
  expect(switched.heldPriorityRanks.has('leaving')).toBe(false);
  expect(switched.prevViewedId).toBe('next');
  const again = advanceViewedPriorityHold(
    {
      prevViewedId: switched.prevViewedId,
      heldPriorityRanks: new Map(switched.heldPriorityRanks),
      recentlyViewedAtMs: new Map(switched.recentlyViewedAtMs),
    },
    'next',
    natural,
    1_800_000_000_000,
  );
  expect(again.recentlyViewedAtMs.get('leaving')).toBe(1_700_000_000_000);
  const running = advanceViewedPriorityHold(
    {
      prevViewedId: 'running-task',
      heldPriorityRanks: new Map([['running-task', LIVE_TASK_PRIORITY.unread]]),
      recentlyViewedAtMs: new Map(),
    },
    'running-task',
    { runningSessionIds: new Set(['running-task']), attentionSessionIds: new Set(['running-task']) },
    1_700_000_000_000,
  );
  expect(running.heldPriorityRanks.get('running-task')).toBe(LIVE_TASK_PRIORITY.running);
});
