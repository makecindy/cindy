// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { sidebarOwnerStorageKey } from '@/lib/sidebarOwnerStorage';
import {
  clearQuickSwitcherFocus,
  clearQuickSwitcherFocusOutsideRoute,
  requestQuickSwitcherFocus,
} from '@/state/quickSwitcherFocus';
import type { ProjectNode } from '../../lib/projectGrouping';
import { deviceLinkProjectKey, projectIdentityKey } from '../../lib/projectGrouping';
import { catalogSessionForGrouping } from '../../lib/quickSwitcher';
import { useCollapsedProjects } from '../useCollapsedProjects';
import { useQuickSwitcherProjectReveal } from '../useQuickSwitcherProjectReveal';

const PROJECT = 'local:/workspace/a';
const OTHER_PROJECT = 'local:/workspace/b';
const ACTIVE_PROJECTS = [PROJECT, OTHER_PROJECT];
const STORAGE_KEY = sidebarOwnerStorageKey('cc-agent.sidebar.collapsedProjects', 'owner-a');

function focusProject(projectKey = PROJECT, kind: 'project' | 'session' = 'project') {
  const project: ProjectNode = {
    projectKey,
    scope: 'local',
    workingDir: projectKey.slice('local:'.length),
    remoteHostId: null,
    deviceLinkDeviceId: null,
    deviceLinkDeviceName: null,
    deviceLinkConnectionStatus: null,
    displayName: projectKey,
    segments: 1,
    sessions: [],
    latestActivityAt: '',
  };
  const session =
    kind === 'session'
      ? catalogSessionForGrouping({
          id: 'target',
          title: 'Target task',
          workingDir: project.workingDir,
          workspaceKind: 'project',
          remoteHostId: null,
          agentKind: 'cc',
          status: 'active',
          pinnedAt: null,
          userSendAt: null,
          createdAt: '',
          updatedAt: '',
          _count: { messages: 1 },
        })
      : null;
  requestQuickSwitcherFocus({ kind, route: '/new', session, project });
}

function setup(activeProjectKeys = ACTIVE_PROJECTS) {
  return renderHook(
    ({ ownerId }) => {
      const saved = useCollapsedProjects(activeProjectKeys, ownerId);
      const visible = useQuickSwitcherProjectReveal(saved, activeProjectKeys);
      return { saved, visible };
    },
    { initialProps: { ownerId: 'owner-a' } },
  );
}

beforeEach(() => {
  setDataOwnerGeneration('owner-a', 1);
  window.localStorage.clear();
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      [PROJECT]: { collapsed: true, lastSeenAt: new Date().toISOString() },
      [OTHER_PROJECT]: { collapsed: true, lastSeenAt: new Date().toISOString() },
    }),
  );
  vi.stubGlobal('CSS', { escape: (value: string) => value });
});

afterEach(() => {
  cleanup();
  clearQuickSwitcherFocus();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('quick-switch project expansion', () => {
  it.each(['project', 'session'] as const)(
    'reveals a %s without changing its saved preference and restores it on navigation',
    (kind) => {
      const hook = setup();
      const storedBefore = window.localStorage.getItem(STORAGE_KEY);
      const writes = vi.spyOn(Storage.prototype, 'setItem');
      expect(hook.result.current.visible.isAllCollapsed).toBe(true);

      act(() => focusProject(PROJECT, kind));

      expect(hook.result.current.visible.collapsed).toEqual(new Set([OTHER_PROJECT]));
      expect(hook.result.current.visible.isAllCollapsed).toBe(false);
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe(storedBefore);
      expect(writes).not.toHaveBeenCalled();
      expect(hook.result.current.saved.collapsed).toEqual(new Set(ACTIVE_PROJECTS));

      act(() => clearQuickSwitcherFocusOutsideRoute('/settings'));

      expect(hook.result.current.visible.collapsed).toEqual(new Set(ACTIVE_PROJECTS));
      expect(hook.result.current.visible.isAllCollapsed).toBe(true);
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe(storedBefore);
    },
  );

  it('moves temporary expansion between destinations and preserves preferences across remounts', () => {
    const hook = setup();
    const storedBefore = window.localStorage.getItem(STORAGE_KEY);
    act(() => focusProject());
    act(() => focusProject(OTHER_PROJECT));
    expect(hook.result.current.visible.collapsed).toEqual(new Set([PROJECT]));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(storedBefore);

    hook.unmount();
    act(() => clearQuickSwitcherFocus());
    const reloaded = setup();
    expect(reloaded.result.current.visible.collapsed).toEqual(new Set(ACTIVE_PROJECTS));
  });

  it('collapses a manually toggled revealed project instead of expanding its saved preference', () => {
    const hook = setup();
    const storedBefore = window.localStorage.getItem(STORAGE_KEY);
    act(() => focusProject());
    act(() => hook.result.current.visible.toggle(PROJECT));
    expect(hook.result.current.visible.collapsed).toEqual(new Set(ACTIVE_PROJECTS));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(storedBefore);

    act(() => hook.result.current.visible.toggle(PROJECT));
    expect(hook.result.current.visible.collapsed).toEqual(new Set([OTHER_PROJECT]));
    expect(hook.result.current.saved.collapsed).toEqual(new Set([OTHER_PROJECT]));
  });

  it('persists an explicit collapse when the revealed project was originally expanded', () => {
    const hook = setup();
    act(() => hook.result.current.visible.toggle(PROJECT));
    const storedBefore = window.localStorage.getItem(STORAGE_KEY);
    act(() => focusProject());
    act(() => clearQuickSwitcherFocus());
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(storedBefore);
    expect(hook.result.current.visible.collapsed.has(PROJECT)).toBe(false);

    act(() => focusProject());
    act(() => hook.result.current.visible.toggle(PROJECT));
    expect(hook.result.current.saved.collapsed.has(PROJECT)).toBe(true);
    expect(hook.result.current.visible.collapsed.has(PROJECT)).toBe(true);
  });

  it('respects toggling another project and ends the temporary expansion', () => {
    const hook = setup();
    act(() => focusProject());
    act(() => hook.result.current.visible.toggle(OTHER_PROJECT));
    expect(hook.result.current.visible.collapsed).toEqual(new Set([PROJECT]));
    expect(hook.result.current.saved.collapsed).toEqual(new Set([PROJECT]));
  });

  it.each(['collapseAll', 'expandAll'] as const)(
    'respects explicit %s during a reveal',
    (action) => {
      const hook = setup();
      act(() => focusProject());
      act(() => hook.result.current.visible[action]());
      const expected = new Set(action === 'collapseAll' ? ACTIVE_PROJECTS : []);
      expect(hook.result.current.visible.collapsed).toEqual(expected);
      expect(hook.result.current.saved.collapsed).toEqual(expected);
      expect(hook.result.current.visible.isAllCollapsed).toBe(action === 'collapseAll');
    },
  );

  it('does not project stale focus into another owner', () => {
    const hook = setup();
    const ownerBKey = sidebarOwnerStorageKey('cc-agent.sidebar.collapsedProjects', 'owner-b');
    const storedBefore = window.localStorage.getItem(STORAGE_KEY)!;
    window.localStorage.setItem(ownerBKey, storedBefore);
    act(() => focusProject());
    setDataOwnerGeneration('owner-b', 2);
    hook.rerender({ ownerId: 'owner-b' });
    expect(hook.result.current.visible.collapsed).toEqual(new Set(ACTIVE_PROJECTS));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(storedBefore);
    expect(window.localStorage.getItem(ownerBKey)).toBe(storedBefore);
  });

  it('does not expand projects on other hosts with the same working directory', () => {
    const remoteKey = projectIdentityKey('remote', '/workspace/a', 'ssh-host');
    const deviceKey = deviceLinkProjectKey('device-a', '/workspace/a');
    const keys = [PROJECT, remoteKey, deviceKey];
    const storedBefore = JSON.stringify(
      Object.fromEntries(
        keys.map((key) => [key, { collapsed: true, lastSeenAt: new Date().toISOString() }]),
      ),
    );
    window.localStorage.setItem(STORAGE_KEY, storedBefore);
    const hook = setup(keys);
    act(() => focusProject());
    expect(hook.result.current.visible.collapsed).toEqual(new Set([remoteKey, deviceKey]));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(storedBefore);
  });

  it('keeps an empty project catalogue out of the all-collapsed state', () => {
    const hook = setup([]);
    act(() => focusProject());
    expect(hook.result.current.visible.isAllCollapsed).toBe(false);
  });
});
