import { describe, expect, it } from 'vitest';

import {
  buildProjectKeyComparisonSet,
  isProjectHidden,
  isSessionInHiddenProject,
  projectKeyComparisonSetHas,
  sidebarSessionsWithHiddenProjectsAsDialogues,
  visibleSidebarProjects,
} from '@/features/cc-agent/lib/sidebarProjectVisibility';
import { groupSessions, type ProjectNode } from '@/features/cc-agent/lib/projectGrouping';
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

    expect(isSessionInHiddenProject(session({ workingDir: '/repo' }), hidden, 'linux')).toBe(true);
    expect(
      isSessionInHiddenProject(
        session({ workingDir: '/repo', remoteHostId: 'host-a' }),
        hidden,
        'linux',
      ),
    ).toBe(false);
    expect(
      isSessionInHiddenProject(
        session({ workingDir: '/repo', deviceLinkDeviceId: 'device-a' }),
        hidden,
        'linux',
      ),
    ).toBe(false);
  });

  it('never hides dialogue tasks even when their working directory matches', () => {
    expect(
      isSessionInHiddenProject(
        session({ workingDir: '/repo', workspaceKind: 'dialogue' }),
        new Set(['local:/repo']),
        'linux',
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
      'linux',
    );

    expect(presented).toEqual([
      expect.objectContaining({ workingDir: '/repo', workspaceKind: 'dialogue' }),
      dialogueTask,
    ]);
    expect(presented[0]).not.toBe(projectTask);
    expect(presented[1]).toBe(dialogueTask);
    expect(projectTask.workspaceKind).toBe('project');
  });

  it('keeps a projected hidden-project task in the Pinned section', () => {
    const pinnedTask = {
      ...session({ workingDir: '/repo' }),
      id: 'pinned-task',
      status: 'active',
      pinnedAt: '2026-08-02T08:00:00.000Z',
      userSendAt: '2026-08-02T07:00:00.000Z',
      updatedAt: '2026-08-02T07:00:00.000Z',
    } as Session;

    const [presented] = sidebarSessionsWithHiddenProjectsAsDialogues(
      [pinnedTask],
      new Set(['local:/repo']),
      'linux',
    );

    expect(presented).toEqual(
      expect.objectContaining({ workspaceKind: 'dialogue', pinnedAt: pinnedTask.pinnedAt }),
    );
    expect(groupSessions([presented]).pinned).toEqual([presented]);
  });

  it('collapses managed worktrees to the hidden base project key', () => {
    expect(
      isSessionInHiddenProject(
        session({ workingDir: '/repo/.cindy-worktrees/issue-1338/src' }),
        new Set(['local:/repo']),
        'linux',
      ),
    ).toBe(true);
  });

  it('matches local Windows project and session keys regardless of path casing', () => {
    const hidden = new Set(['local:C:/Users/Lee/Repo']);

    expect(isProjectHidden('local:c:/users/lee/repo', hidden, 'win32')).toBe(true);
    expect(
      isSessionInHiddenProject(
        session({ workingDir: 'c:\\users\\lee\\repo' }),
        hidden,
        'win32',
      ),
    ).toBe(true);
  });

  it('does not hide a different-cased POSIX double-slash project', () => {
    const hidden = new Set(['local://mnt/Repo']);
    const lowerCaseProjectTask = session({ workingDir: '//mnt/repo' }) as Session;

    expect(isProjectHidden('local://mnt/repo', hidden, 'linux')).toBe(false);
    expect(
      isSessionInHiddenProject(lowerCaseProjectTask, hidden, 'linux'),
    ).toBe(false);
    expect(
      sidebarSessionsWithHiddenProjectsAsDialogues(
        [lowerCaseProjectTask],
        hidden,
        'linux',
      ),
    ).toEqual([lowerCaseProjectTask]);
  });

  it('uses Windows comparison keys for bulk projections without folding other scopes', () => {
    const hidden = new Set([
      'local:C:/Repo',
      'remote:host-a:C:/Repo',
      'device:device-a:C:/Repo',
      'local:/Users/Lee/Repo',
    ]);
    const projects = [
      project('local:c:/repo'),
      project('remote:host-a:c:/repo'),
      project('device:device-a:c:/repo'),
      project('local:/users/lee/repo'),
    ];
    const hiddenComparisonKeys = buildProjectKeyComparisonSet(hidden, 'win32');

    expect(projectKeyComparisonSetHas(hiddenComparisonKeys, 'local:c:/repo', 'win32')).toBe(true);
    expect(projectKeyComparisonSetHas(hiddenComparisonKeys, 'remote:host-a:c:/repo', 'win32')).toBe(false);
    expect(projectKeyComparisonSetHas(hiddenComparisonKeys, 'device:device-a:c:/repo', 'win32')).toBe(false);
    expect(projectKeyComparisonSetHas(hiddenComparisonKeys, 'local:/users/lee/repo', 'win32')).toBe(false);

    expect(
      visibleSidebarProjects(projects, hidden, 'win32').map((entry) => entry.projectKey),
    ).toEqual([
      'remote:host-a:c:/repo',
      'device:device-a:c:/repo',
      'local:/users/lee/repo',
    ]);

    const localWindowsSession = session({ workingDir: 'c:\\repo' }) as Session;
    const remoteSession = session({
      workingDir: 'c:\\repo',
      remoteHostId: 'host-a',
    }) as Session;
    const deviceSession = session({
      workingDir: 'c:\\repo',
      deviceLinkDeviceId: 'device-a',
    }) as Session;
    const posixSession = session({ workingDir: '/users/lee/repo' }) as Session;

    const presented = sidebarSessionsWithHiddenProjectsAsDialogues(
      [localWindowsSession, remoteSession, deviceSession, posixSession],
      hidden,
      'win32',
    );
    expect(presented[0]).toEqual(
      expect.objectContaining({ workspaceKind: 'dialogue' }),
    );
    expect(presented[1]).toBe(remoteSession);
    expect(presented[2]).toBe(deviceSession);
    expect(presented[3]).toBe(posixSession);
  });

  it('filters only hidden projects from a project catalogue', () => {
    expect(
      visibleSidebarProjects(
        [project('local:/one'), project('remote:host-a:/one'), project('local:/two')],
        new Set(['local:/one']),
        'linux',
      ).map((entry) => entry.projectKey),
    ).toEqual(['remote:host-a:/one', 'local:/two']);
  });
});
