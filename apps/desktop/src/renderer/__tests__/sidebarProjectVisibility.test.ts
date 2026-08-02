import { describe, expect, it } from 'vitest';

import {
  isSessionInHiddenProject,
  sidebarSessionsWithHiddenProjectsAsDialogues,
  visibleSidebarProjects,
} from '@/features/cc-agent/lib/sidebarProjectVisibility';
import type { ProjectNode } from '@/features/cc-agent/lib/projectGrouping';
import type { Session } from '@/lib/ccAgent.types';

type VisibilitySession = Pick<
  Session,
  'workingDir' | 'remoteHostId' | 'deviceLinkDeviceId' | 'workspaceKind'
>;

function session(partial: Partial<VisibilitySession>): VisibilitySession {
  return {
    workingDir: partial.workingDir ?? '/repo',
    remoteHostId: partial.remoteHostId ?? null,
    deviceLinkDeviceId: partial.deviceLinkDeviceId,
    workspaceKind: partial.workspaceKind ?? 'project',
  };
}

function project(projectKey: string): ProjectNode {
  return { projectKey } as ProjectNode;
}

describe('sidebar project visibility', () => {
  it('keeps local, SSH, and device projects with the same path isolated', () => {
    const hidden = new Set(['local:/repo']);

    expect(isSessionInHiddenProject(session({ workingDir: '/repo' }), hidden)).toBe(true);
    expect(
      isSessionInHiddenProject(session({ workingDir: '/repo', remoteHostId: 'host-a' }), hidden),
    ).toBe(false);
    expect(
      isSessionInHiddenProject(
        session({ workingDir: '/repo', deviceLinkDeviceId: 'device-a' }),
        hidden,
      ),
    ).toBe(false);
  });

  it('never hides dialogue tasks even when their working directory matches', () => {
    expect(
      isSessionInHiddenProject(
        session({ workingDir: '/repo', workspaceKind: 'dialogue' }),
        new Set(['local:/repo']),
      ),
    ).toBe(false);
  });

  it('presents hidden project tasks as Chat entries without mutating their ownership', () => {
    const projectTask = session({ workingDir: '/repo' }) as Session;
    const dialogueTask = session({
      workingDir: '/repo',
      workspaceKind: 'dialogue',
    }) as Session;

    const presented = sidebarSessionsWithHiddenProjectsAsDialogues(
      [projectTask, dialogueTask],
      new Set(['local:/repo']),
    );

    expect(presented).toEqual([
      expect.objectContaining({ workingDir: '/repo', workspaceKind: 'dialogue' }),
      dialogueTask,
    ]);
    expect(presented[0]).not.toBe(projectTask);
    expect(presented[1]).toBe(dialogueTask);
    expect(projectTask.workspaceKind).toBe('project');
  });

  it('collapses managed worktrees to the hidden base project key', () => {
    expect(
      isSessionInHiddenProject(
        session({ workingDir: '/repo/.cindy-worktrees/issue-1338/src' }),
        new Set(['local:/repo']),
      ),
    ).toBe(true);
  });

  it('filters only hidden projects from a project catalogue', () => {
    expect(
      visibleSidebarProjects(
        [project('local:/one'), project('remote:host-a:/one'), project('local:/two')],
        new Set(['local:/one']),
      ).map((entry) => entry.projectKey),
    ).toEqual(['remote:host-a:/one', 'local:/two']);
  });
});
