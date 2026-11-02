import { describe, expect, it } from 'vitest';

import { groupSessionsByActivityDate } from '@/features/cc-agent/lib/dateSessionGrouping';
import type { Session } from '@/lib/ccAgent.types';

let id = 0;

function s(partial: Partial<Session>): Session {
  id += 1;
  // 侧栏排序时间轴现在只看 updatedAt(scheduler 自动 fire 也 bump),测试助手
  // 相应把 userSendAt 视作"活动时刻"的语义等价 —— 若调用者只给了 userSendAt,
  // 就同步用它作为 updatedAt,让原有 case 直接表达"最近活动 = 该时刻"。
  const updatedAt = partial.updatedAt ?? partial.userSendAt ?? '2026-05-17T00:00:00';
  const userSendAt = partial.userSendAt !== undefined ? partial.userSendAt : updatedAt;
  return {
    id: partial.id ?? `s${id}`,
    userId: 'u',
    title: partial.title ?? `Session ${id}`,
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
    userSendAt,
    lastActivityAt: partial.lastActivityAt,
    status: partial.status ?? 'active',
    agentKind: partial.agentKind ?? 'cc',
    parentSessionId: partial.parentSessionId ?? null,
    forkedAtMessageId: partial.forkedAtMessageId ?? null,
    worktreePath: partial.worktreePath ?? null,
    usedProjectContext: partial.usedProjectContext ?? false,
    extraDirs: partial.extraDirs ?? [],
    createdAt: partial.createdAt ?? updatedAt,
    updatedAt,
    _count: partial._count,
  };
}

describe('groupSessionsByActivityDate', () => {
  it('mixes new handoff timestamps with legacy human-send and metadata fallbacks', () => {
    const groups = groupSessionsByActivityDate([
      s({ id: 'legacy', userSendAt: '2026-05-16T12:00:00', updatedAt: '2026-05-17T15:00:00' }),
      s({ id: 'handoff', lastActivityAt: '2026-05-17T10:00:00', userSendAt: '2026-05-01T00:00:00' }),
      s({ id: 'draft', userSendAt: null, updatedAt: '2026-05-17T09:00:00' }),
    ], new Date('2026-05-17T12:00:00'));
    expect(groups.map(group => group.sessions.map(session => session.id))).toEqual([
      ['handoff', 'draft'], ['legacy'],
    ]);
  });
  it('groups sessions into Today, Yesterday, concrete dates, and Older', () => {
    const now = new Date('2026-05-17T12:00:00');
    const groups = groupSessionsByActivityDate(
      [
        s({ id: 'older', userSendAt: '2026-05-01T09:00:00' }),
        s({ id: 'today', userSendAt: '2026-05-17T01:00:00' }),
        s({ id: 'may15', userSendAt: '2026-05-15T01:00:00' }),
        s({ id: 'yesterday', userSendAt: '2026-05-16T01:00:00' }),
      ],
      now,
    );

    expect(groups.map((g) => g.kind)).toEqual(['today', 'yesterday', 'date', 'older']);
    expect(groups[2].dayKey).toBe('2026-05-15');
    expect(groups.map((g) => g.sessions.map((session) => session.id))).toEqual([
      ['today'],
      ['yesterday'],
      ['may15'],
      ['older'],
    ]);
  });

  it('uses updatedAt when userSendAt is missing', () => {
    const now = new Date('2026-05-17T12:00:00');
    const groups = groupSessionsByActivityDate(
      [
        s({
          id: 'fallback',
          userSendAt: null,
          updatedAt: '2026-05-17T08:00:00',
        }),
      ],
      now,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('today');
    expect(groups[0].sessions[0].id).toBe('fallback');
  });

  it('sorts sessions by activity descending inside each group', () => {
    const now = new Date('2026-05-17T12:00:00');
    const groups = groupSessionsByActivityDate(
      [
        s({ id: 'early', userSendAt: '2026-05-17T01:00:00' }),
        s({ id: 'late', userSendAt: '2026-05-17T11:00:00' }),
      ],
      now,
    );

    expect(groups[0].sessions.map((session) => session.id)).toEqual(['late', 'early']);
  });

  it('sorts sessions chronologically when requested', () => {
    const now = new Date('2026-05-17T12:00:00');
    const groups = groupSessionsByActivityDate(
      [
        s({ id: 'today', userSendAt: '2026-05-17T11:00:00' }),
        s({ id: 'old', userSendAt: '2026-05-01T09:00:00' }),
        s({ id: 'yesterday', userSendAt: '2026-05-16T01:00:00' }),
      ],
      now,
      'time',
    );

    expect(groups.map((g) => g.kind)).toEqual(['older', 'yesterday', 'today']);
    expect(groups.map((g) => g.sessions.map((session) => session.id))).toEqual([
      ['old'],
      ['yesterday'],
      ['today'],
    ]);
  });
});
