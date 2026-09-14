import { describe, expect, it } from 'vitest';

import {
  activePinnedSidebarEntryIds,
  buildPinnedSidebarRank,
  isPinnedProjectEntryId,
  pinnedProjectEntryId,
  pinnedSidebarEntryComparisonKey,
  projectKeyFromPinnedEntryId,
} from '@/features/cc-agent/lib/pinnedSidebarOrder';
import {
  mergeVisibleReorder,
  normalizeManualPinnedOrder,
} from '@/features/cc-agent/hooks/helpers/sidebarFilterCore';

describe('pinned sidebar mixed project/conversation order', () => {
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
