import { describe, expect, it } from 'vitest';
import {
  groupWorkspaceProjects,
  mergeWorkspaceOrder,
} from '@/features/cc-agent/lib/workspaceProjectGrouping';
import { projectKeyComparisonKey, type ProjectNode } from '@/features/cc-agent/lib/projectGrouping';
import type { ProjectWorkspace } from '../../shared/projectWorkspaceSettings';

function project(key: string): ProjectNode {
  return {
    projectKey: key,
    scope: 'local',
    workingDir: key,
    remoteHostId: null,
    deviceLinkDeviceId: null,
    deviceLinkDeviceName: null,
    deviceLinkConnectionStatus: null,
    displayName: key,
    segments: 1,
    sessions: [],
    latestActivityAt: '2026-10-08T00:00:00Z',
  };
}

function workspace(id: string, projectKeys: string[]): ProjectWorkspace {
  return { id, name: id, projectKeys, collapsed: false };
}

const identity = (key: string) => key;

describe('workspace project grouping', () => {
  it('retains every visible project once and preserves the current project order', () => {
    const projects = ['local:/second', 'local:/first', 'local:/other'].map(project);
    const result = groupWorkspaceProjects(
      projects,
      [workspace('business', ['local:/first', 'local:/second'])],
      identity,
    );
    expect(result.groups[0]?.projects).toEqual(projects.slice(0, 2));
    expect(result.ungrouped).toEqual([projects[2]]);
    expect(result.groups[0]?.projects[0]).toBe(projects[0]);
  });

  it('keeps empty workspaces and does not resurrect hidden projects from saved membership', () => {
    const visible = project('local:/visible');
    const result = groupWorkspaceProjects(
      [visible],
      [workspace('empty', []), workspace('filtered', ['local:/hidden'])],
      identity,
    );
    expect(result.groups.map((group) => group.projects)).toEqual([[], []]);
    expect(result.ungrouped).toEqual([visible]);
  });

  it('deleting a workspace returns its projects to the ungrouped list without modifying them', () => {
    const projects = [project('local:/client')];
    const result = groupWorkspaceProjects(projects, [], identity);
    expect(result.ungrouped).toEqual(projects);
    expect(result.ungrouped[0]).toBe(projects[0]);
  });

  it('distinguishes local and remote projects sharing a directory path', () => {
    const projects = [project('local:/client'), project('device:remote:/client')];
    const result = groupWorkspaceProjects(
      projects,
      [workspace('local', ['local:/client'])],
      identity,
    );
    expect(result.groups[0]?.projects).toEqual([projects[0]]);
    expect(result.ungrouped).toEqual([projects[1]]);
  });

  it('uses the established Windows comparison rules for project identity', () => {
    const projects = [project('local:C:/Work/Client')];
    const result = groupWorkspaceProjects(
      projects,
      [workspace('client', ['local:c:/work/client'])],
      (key) => projectKeyComparisonKey(key, 'win32') ?? key,
    );
    expect(result.groups[0]?.projects).toEqual(projects);
    expect(result.ungrouped).toEqual([]);
  });

  it('does not duplicate a project if an older snapshot contains conflicting memberships', () => {
    const projects = [project('local:/client')];
    const result = groupWorkspaceProjects(
      projects,
      [workspace('first', ['local:/client']), workspace('second', ['local:/client'])],
      identity,
    );
    expect(result.groups.map((group) => group.projects.length)).toEqual([1, 0]);
  });

  it('reorders a visible subset without moving hidden workspaces', () => {
    const groups = ['first', 'hidden', 'last'].map((id) => workspace(id, []));
    expect(mergeWorkspaceOrder(groups, ['last', 'first'])).toEqual(['last', 'hidden', 'first']);
    expect(mergeWorkspaceOrder(groups, ['unknown', 'last', 'last', 'first'])).toEqual([
      'last',
      'hidden',
      'first',
    ]);
  });
});
