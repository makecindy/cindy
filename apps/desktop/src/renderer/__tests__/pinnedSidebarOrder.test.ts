import { describe, expect, it } from 'vitest';

import {
  activePinnedSidebarEntryIds,
  buildPinnedSidebarRank,
  isPinnedProjectEntryId,
  pinnedProjectEntryId,
  pinnedSidebarEntryComparisonKey,
  projectKeyFromPinnedEntryId,
  sortPinnedSidebarEntries,
  type PinnedSidebarEntry,
} from '@/features/cc-agent/lib/pinnedSidebarOrder';
import type { Session } from '@/lib/ccAgent.types';
import {
  mergeVisibleReorder,
  normalizeManualPinnedOrder,
} from '@/features/cc-agent/hooks/helpers/sidebarFilterCore';

describe('pinned sidebar mixed project/conversation order', () => {
  // 测试价值：用户要求置顶可选最近活动。生产排序入口此前只有手动顺序覆盖；
  // 最小输入为旧任务排在新任务前，另加项目混排、时间相同和空项目分支。unit。
  it('sorts mixed pins by task activity and restores the untouched manual order', () => {
    const task = (id: string, lastActivityAt: string, updatedAt = lastActivityAt) =>
      ({ id, lastActivityAt, updatedAt }) as Session;
    const old = task('old', '2026-11-01T00:00:00Z', '2026-11-16T00:00:00Z');
    const newer = task('new', '2026-11-03T00:00:00Z');
    const newest = task('project-newest', '2026-11-04T00:00:00Z');
    const entries: PinnedSidebarEntry[] = [
      { kind: 'session', id: old.id, session: old },
      {
        kind: 'project',
        id: 'project:a',
        project: { sessions: [old, newest] },
        displaySessions: [old],
      } as PinnedSidebarEntry,
      { kind: 'session', id: newer.id, session: newer },
    ];
    expect(sortPinnedSidebarEntries(entries, 'recency').map((entry) => entry.id)).toEqual([
      'project:a',
      'new',
      'old',
    ]);
    expect(sortPinnedSidebarEntries(entries, 'manual').map((entry) => entry.id)).toEqual([
      'old',
      'project:a',
      'new',
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(['old', 'project:a', 'new']);
  });

  it('keeps manual tie order and places pins without valid activity last', () => {
    const task = (id: string, updatedAt: string) => ({ id, updatedAt }) as Session;
    const entries: PinnedSidebarEntry[] = [
      {
        kind: 'project',
        id: 'empty',
        project: { sessions: [] },
        displaySessions: [],
      } as unknown as PinnedSidebarEntry,
      { kind: 'session', id: 'first', session: task('first', '2026-11-01T00:00:00Z') },
      { kind: 'session', id: 'invalid', session: task('invalid', 'invalid-date') },
      { kind: 'session', id: 'second', session: task('second', '2026-11-01T00:00:00Z') },
    ];
    expect(sortPinnedSidebarEntries(entries, 'recency').map((entry) => entry.id)).toEqual([
      'first',
      'second',
      'empty',
      'invalid',
    ]);
  });

  it('encodes the stable project identity without depending on its display name', () => {
    const projectKey = 'remote:host-a:/workspace/my-project';
    const entryId = pinnedProjectEntryId(projectKey);

    expect(entryId).toBe('project:remote:host-a:/workspace/my-project');
    expect(isPinnedProjectEntryId(entryId)).toBe(true);
    expect(projectKeyFromPinnedEntryId(entryId)).toBe(projectKey);
    expect(projectKeyFromPinnedEntryId('conversation-id')).toBeNull();
  });

  it('keeps project pins while garbage-collecting stale conversation pins', () => {
    const project = pinnedProjectEntryId('local:/workspace/project-a');
    const active = activePinnedSidebarEntryIds(
      ['stale-conversation', project, 'active-conversation'],
      ['active-conversation'],
    );

    expect(
      normalizeManualPinnedOrder(['stale-conversation', project, 'active-conversation'], active),
    ).toEqual([project, 'active-conversation']);
  });

  it('deduplicates Windows project pins by comparison identity while preserving stored spelling', () => {
    const stored = pinnedProjectEntryId('local:D:/École/Project-A');
    const live = pinnedProjectEntryId('local:d:/école/project-a');

    expect(activePinnedSidebarEntryIds([stored, live], [], 'win32')).toEqual([stored]);
  });

  it('keeps the first persisted rank for duplicate Windows project identities', () => {
    const stored = pinnedProjectEntryId('local:D:/École/Project-A');
    const duplicate = pinnedProjectEntryId('local:d:/école/project-a');
    const identity = pinnedSidebarEntryComparisonKey(stored, 'win32');

    expect(Array.from(buildPinnedSidebarRank([stored, 'session-a', duplicate], 'win32'))).toEqual([
      [identity, 0],
      ['session-a', 1],
    ]);
  });

  it('reorders visible projects and conversations together while hidden entries keep their slots', () => {
    const projectA = pinnedProjectEntryId('local:/workspace/a');
    const projectB = pinnedProjectEntryId('local:/workspace/b');
    const full = [projectA, 'hidden-conversation', 'visible-conversation', projectB];

    expect(mergeVisibleReorder(full, [projectB, 'visible-conversation', projectA])).toEqual([
      projectB,
      'hidden-conversation',
      'visible-conversation',
      projectA,
    ]);
  });
});
