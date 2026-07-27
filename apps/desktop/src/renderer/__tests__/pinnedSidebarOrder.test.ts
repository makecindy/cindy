import { describe, expect, it } from 'vitest';

import {
  activePinnedSidebarEntryIds,
  isPinnedProjectEntryId,
  pinnedProjectEntryId,
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
