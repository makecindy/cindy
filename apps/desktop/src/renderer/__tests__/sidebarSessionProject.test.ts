import { describe, expect, it } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import {
  groupSessions,
  projectIdentityKeyForSession,
} from '@/features/cc-agent/lib/projectGrouping';
import {
  sidebarSessionProject,
  sidebarProjectIdentityKeyForSession,
} from '@/features/cc-agent/lib/sidebarSessionProject';
import {
  isSessionInProject,
  sidebarSessionsWithHiddenProjectsAsDialogues,
} from '@/features/cc-agent/lib/sidebarProjectVisibility';
import { buildSessionSourceLabelMap } from '@/features/cc-agent/lib/sessionSourceLabel';
import { createProjectGroupsSelector } from '@/features/cc-agent/lib/projectGroupsSelector';

const session = {
  id: 'task',
  title: 'Task',
  status: 'active',
  workingDir: '/projects/source',
  workspaceKind: 'project',
  userSendAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:00.000Z',
  pinnedAt: null,
  _count: { messages: 2 },
} as Session;

describe('background project move display', () => {
  it('groups by the requested project without changing the task passed to file/run consumers', () => {
    const moving = { ...session, projectMoveTarget: { workingDir: '/projects/target' } };
    const grouped = groupSessions([moving]);
    expect(grouped.projects[0].workingDir).toBe('/projects/target');
    expect(grouped.projects[0].sessions[0]).toBe(moving);
    expect(moving.workingDir).toBe('/projects/source');
    expect(projectIdentityKeyForSession(moving)).toBe('local:/projects/source');
    expect(sidebarProjectIdentityKeyForSession(moving)).toBe('local:/projects/target');
    expect(isSessionInProject(moving, '/projects/target', 'darwin')).toBe(true);
    expect(isSessionInProject(moving, '/projects/source', 'darwin')).toBe(false);
    expect(buildSessionSourceLabelMap([moving], grouped.projects).get(moving.id)).toBe('target');
  });

  it('can move either direction between dialogue and project while preserving runtime fields', () => {
    const toDialogue = { ...session, projectMoveTarget: { workingDir: null } };
    expect(groupSessions([toDialogue]).dialogues).toEqual([toDialogue]);
    expect(sidebarSessionProject(toDialogue)).toEqual({
      workingDir: null,
      workspaceKind: 'dialogue',
    });
    expect(buildSessionSourceLabelMap([toDialogue], [], 'Dialogue').get(session.id)).toBe(
      'Dialogue',
    );
    const toProject = {
      ...session,
      workspaceKind: 'dialogue' as const,
      projectMoveTarget: { workingDir: '/new' },
    };
    expect(groupSessions([toProject]).projects[0].workingDir).toBe('/new');
    expect(toProject.workspaceKind).toBe('dialogue');
  });

  it('rebuilds grouping for repeated moves and restores actual membership after a failure clear', () => {
    const select = createProjectGroupsSelector();
    const first = { ...session, projectMoveTarget: { workingDir: '/first' } };
    expect(select([first]).projects[0].workingDir).toBe('/first');
    expect(
      select([{ ...first, projectMoveTarget: { workingDir: '/second' } }]).projects[0].workingDir,
    ).toBe('/second');
    expect(select([{ ...first, projectMoveTarget: null }]).projects[0].workingDir).toBe(
      '/projects/source',
    );
  });

  it('uses the remote owner and handles hidden target projects without leaking display state into runtime cwd', () => {
    const moving = {
      ...session,
      deviceLinkDeviceId: 'host',
      projectMoveTarget: { workingDir: '/target' },
    };
    expect(sidebarProjectIdentityKeyForSession(moving)).toBe('device:host:/target');
    const local = { ...session, projectMoveTarget: { workingDir: '/target' } };
    const display = sidebarSessionsWithHiddenProjectsAsDialogues(
      [local],
      new Set(['/target']),
      'darwin',
    );
    expect(groupSessions(display).dialogues).toHaveLength(1);
    expect(display[0].workingDir).toBe('/projects/source');
    expect(local.projectMoveTarget.workingDir).toBe('/target');
  });
});
