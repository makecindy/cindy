// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { sidebarOwnerStorageKey } from '@/lib/sidebarOwnerStorage';
import { useCollapsedProjects } from '../useCollapsedProjects';

const PROJECT = 'local:/workspace/a';
const PROJECT_B = 'local:/workspace/b';
const STORAGE_KEY = 'cc-agent.sidebar.collapsedProjects';

beforeEach(() => {
  window.localStorage.clear();
});

describe('collapsed project owner state', () => {
  it('does not expose one owner collapse state to another owner', () => {
    const ownerA = renderHook(() => useCollapsedProjects([PROJECT], 'owner-a'));
    act(() => ownerA.result.current.toggle(PROJECT));
    expect(ownerA.result.current.collapsed.has(PROJECT)).toBe(true);
    ownerA.unmount();

    const ownerB = renderHook(() => useCollapsedProjects([PROJECT], 'owner-b'));
    expect(ownerB.result.current.collapsed.has(PROJECT)).toBe(false);
    ownerB.unmount();

    const ownerAReloaded = renderHook(() => useCollapsedProjects([PROJECT], 'owner-a'));
    expect(ownerAReloaded.result.current.collapsed.has(PROJECT)).toBe(true);
  });

  it('moves a legacy collapse value only into the first owner namespace', () => {
    window.localStorage.setItem(
      'cc-agent.sidebar.collapsedProjects',
      JSON.stringify({
        [PROJECT]: { collapsed: true, lastSeenAt: new Date().toISOString() },
      }),
    );

    const ownerA = renderHook(() => useCollapsedProjects([PROJECT], 'owner-a'));
    expect(ownerA.result.current.collapsed.has(PROJECT)).toBe(true);
    ownerA.unmount();

    const ownerB = renderHook(() => useCollapsedProjects([PROJECT], 'owner-b'));
    expect(ownerB.result.current.collapsed.has(PROJECT)).toBe(false);
  });

  it('reloads the new owner before GC and keeps mutations in that owner namespace', () => {
    const stale = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    const ownerAKey = sidebarOwnerStorageKey(STORAGE_KEY, 'owner-a');
    const ownerBKey = sidebarOwnerStorageKey(STORAGE_KEY, 'owner-b');
    const ownerAValue = JSON.stringify({
      [PROJECT]: { collapsed: true, lastSeenAt: stale },
    });
    const ownerBValue = JSON.stringify({
      [PROJECT_B]: { collapsed: true, lastSeenAt: fresh },
    });
    window.localStorage.setItem(ownerAKey, ownerAValue);
    window.localStorage.setItem(ownerBKey, ownerBValue);

    const hook = renderHook(
      ({ active, ownerId }: { active: string[]; ownerId: string }) =>
        useCollapsedProjects(active, ownerId),
      { initialProps: { active: [PROJECT], ownerId: 'owner-a' } },
    );
    expect(hook.result.current.collapsed).toEqual(new Set([PROJECT]));
    const staleOwnerAToggle = hook.result.current.toggle;

    hook.rerender({ active: [PROJECT_B], ownerId: 'owner-b' });
    expect(hook.result.current.collapsed).toEqual(new Set([PROJECT_B]));
    expect(window.localStorage.getItem(ownerAKey)).toBe(ownerAValue);
    expect(window.localStorage.getItem(ownerBKey)).toBe(ownerBValue);

    act(() => staleOwnerAToggle(PROJECT));
    expect(hook.result.current.collapsed).toEqual(new Set([PROJECT_B]));
    expect(window.localStorage.getItem(ownerAKey)).toBe(ownerAValue);
    expect(window.localStorage.getItem(ownerBKey)).toBe(ownerBValue);

    act(() => hook.result.current.toggle(PROJECT_B));
    expect(hook.result.current.collapsed.size).toBe(0);
    expect(window.localStorage.getItem(ownerAKey)).toBe(ownerAValue);
    expect(window.localStorage.getItem(ownerBKey)).toBe('{}');
  });
});
