import { describe, expect, it } from 'vitest';

import {
  sortProjectsForSidebar,
  sortSessionsForSidebar,
} from '@/features/cc-agent/lib/sidebarProjectSorting';
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

function project(partial: Partial<ProjectNode> & Pick<ProjectNode, 'workingDir' | 'displayName'>): ProjectNode {
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
      'manual',
      ['local:/p/gamma', 'local:/p/alpha'],
    );

    expect(sorted.map((p) => p.workingDir)).toEqual(['/p/gamma', '/p/alpha', '/p/beta']);
  });

  it('applies a stored Windows manual order to representatives with different casing', () => {
    const sorted = sortProjectsForSidebar(
      [
        project({ workingDir: 'd:/école/alpha', displayName: 'alpha' }),
        project({ workingDir: 'd:/école/beta', displayName: 'beta' }),
      ],
      'manual',
      ['local:D:/École/BETA', 'local:D:/École/ALPHA'],
      'win32',
    );

    expect(sorted.map((p) => p.workingDir)).toEqual(['d:/école/beta', 'd:/école/alpha']);
  });

  it('sorts projects alphabetically by display name', () => {
    const sorted = sortProjectsForSidebar(
      [
        project({ workingDir: '/p/zeta', displayName: 'zeta' }),
        project({ workingDir: '/p/alpha', displayName: 'alpha' }),
        project({ workingDir: '/p/Project 2', displayName: 'Project 2' }),
        project({ workingDir: '/p/Project 10', displayName: 'Project 10' }),
      ],
      'alphabetic',
      [],
    );

    expect(sorted.map((p) => p.displayName)).toEqual(['alpha', 'Project 2', 'Project 10', 'zeta']);
  });

  it('sorts sessions by userSendAt, ignoring later updatedAt bumps', () => {
    // 排序时钟 = userSendAt ?? updatedAt（以用户最近一次按下发送为主键）。
    // laterSend.updatedAt 有意设得比 earlierSend 更新（模拟 agent 回复 / scheduler
    // fire 只 bump updatedAt），验证这类改动不再重排：time 排序“最早优先”，
    // 谁的 userSendAt 更早谁排前面，与 updatedAt 无关。
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

    expect(sortSessionsForSidebar([laterSend, earlierSend], 'time').map((s) => s.id)).toEqual([
      'earlier-send',
      'later-send',
    ]);
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

    // time 排序最早优先：noSend 回落到 updatedAt=01-01，早于 withSend 的 userSendAt=01-08。
    expect(sortSessionsForSidebar([withSend, noSend], 'time').map((s) => s.id)).toEqual([
      'no-send',
      'with-send',
    ]);
  });
});
