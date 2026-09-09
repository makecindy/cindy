import { describe, expect, it } from 'vitest';

import {
  sortProjectsForSidebar,
  sortSessionsForSidebar,
} from '@/features/cc-agent/lib/sidebarProjectSorting';
import { buildMainListEntries } from '@/features/cc-agent/lib/mainListModel';
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
