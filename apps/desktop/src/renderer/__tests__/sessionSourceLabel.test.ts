/**
 * sessionSourceLabel — vitest unit tests
 *
 * 覆盖 buildSessionSourceLabelMap 的分支:独立对话不标 / ProjectNode 命中 /
 * workingDir basename 回退(POSIX + Windows 分隔符)/ 拿不到来源时不注入。
 * 该 helper 由 DateGroupedSessionsSection 与 PinnedSection 共用,提取自两处
 * 原本逐字节重复的 useMemo(PR #533 follow-up)。
 */

import { describe, expect, it } from 'vitest';

import { buildSessionSourceLabelMap } from '@/features/cc-agent/lib/sessionSourceLabel';
import { projectIdentityKeyForSession, type ProjectNode } from '@/features/cc-agent/lib/projectGrouping';
import type { Session } from '@/lib/ccAgent.types';

/* ---------------- helpers ---------------- */

let seq = 0;
function s(partial: Partial<Session>): Session {
  seq += 1;
  const updatedAt = partial.updatedAt ?? '2026-01-01T00:00:00.000Z';
  return {
    id: partial.id ?? `s${seq}`,
    userId: 'u',
    title: partial.title ?? `t${seq}`,
    workingDir: partial.workingDir ?? null,
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
    pinnedAt: partial.pinnedAt ?? null,
    userSendAt: partial.userSendAt !== undefined ? partial.userSendAt : updatedAt,
    status: partial.status ?? 'active',
    agentKind: partial.agentKind ?? 'cc',
    remoteHostId: partial.remoteHostId ?? null,
    deviceLinkDeviceId: partial.deviceLinkDeviceId,
    deviceLinkDeviceName: partial.deviceLinkDeviceName,
    deviceLinkConnectionStatus: partial.deviceLinkConnectionStatus,
    extraDirs: partial.extraDirs ?? [],
    createdAt: partial.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt,
    _count: partial._count,
  };
}

/** 用一个已知 session 反推它的 projectKey,构造一个能命中的 ProjectNode。 */
function projectNodeFor(session: Session, displayName: string): ProjectNode {
  const projectKey = projectIdentityKeyForSession(session);
  if (!projectKey) throw new Error('test session has no project key');
  return {
    projectKey,
    scope: 'local',
    workingDir: session.workingDir ?? '',
    remoteHostId: null,
    deviceLinkDeviceId: null,
    deviceLinkDeviceName: null,
    deviceLinkConnectionStatus: null,
    displayName,
    segments: 1,
    sessions: [session],
    latestActivityAt: session.updatedAt,
  };
}

/* ============================== tests ============================== */

describe('buildSessionSourceLabelMap', () => {
  it('does not label standalone dialogue sessions', () => {
    const d = s({ id: 'd1', workspaceKind: 'dialogue' });
    const map = buildSessionSourceLabelMap([d], []);
    expect(map.has('d1')).toBe(false);
  });

  it('uses the matching ProjectNode displayName for a project session', () => {
    const p = s({ id: 'p1', workspaceKind: 'project', workingDir: '/home/me/repo-a' });
    const node = projectNodeFor(p, 'parent/repo-a');
    const map = buildSessionSourceLabelMap([p], [node]);
    expect(map.get('p1')).toBe('parent/repo-a');
  });

  it('falls back to POSIX workingDir basename when no ProjectNode matches', () => {
    const p = s({ id: 'p2', workspaceKind: 'project', workingDir: '/home/me/my-proj' });
    const map = buildSessionSourceLabelMap([p], []);
    expect(map.get('p2')).toBe('my-proj');
  });

  it('falls back to Windows workingDir basename (backslash separator)', () => {
    const p = s({ id: 'p3', workspaceKind: 'project', workingDir: 'D:\\code\\win-proj' });
    const map = buildSessionSourceLabelMap([p], []);
    expect(map.get('p3')).toBe('win-proj');
  });

  it('does not inject a label when a project session has no workingDir', () => {
    const p = s({ id: 'p4', workspaceKind: 'project', workingDir: null });
    const map = buildSessionSourceLabelMap([p], []);
    expect(map.has('p4')).toBe(false);
  });

  it('handles a mixed batch, only injecting resolvable project sources', () => {
    const d = s({ id: 'm-d', workspaceKind: 'dialogue' });
    const named = s({ id: 'm-named', workspaceKind: 'project', workingDir: '/x/named-proj' });
    const node = projectNodeFor(named, 'named-proj');
    const fallback = s({ id: 'm-fb', workspaceKind: 'project', workingDir: '/x/fallback-proj' });
    const empty = s({ id: 'm-empty', workspaceKind: 'project', workingDir: null });

    const map = buildSessionSourceLabelMap([d, named, fallback, empty], [node]);

    expect(map.has('m-d')).toBe(false);
    expect(map.get('m-named')).toBe('named-proj');
    expect(map.get('m-fb')).toBe('fallback-proj');
    expect(map.has('m-empty')).toBe(false);
    expect(map.size).toBe(2);
  });
});
