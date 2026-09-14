// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  __testing as dataOwnerGenerationTesting,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import {
  __testing as sidebarOwnerStorageTesting,
  sidebarOwnerStorageKey,
} from '@/lib/sidebarOwnerStorage';
import {
  isAutomationGroupCollapsed,
  setAutomationGroupCollapsed,
  useAutomationGroupCollapsed,
  useAutomationGroupsCollapsed,
} from '../useAutomationGroupCollapsed';

const STORAGE_KEY = 'cc-agent.sidebar.collapsedAutomationGroups';

beforeEach(() => {
  window.localStorage.clear();
  dataOwnerGenerationTesting.reset();
  sidebarOwnerStorageTesting.setOwnerAuthorityReader(null);
});

describe('automation group collapsed owner binding', () => {
  it('copies a legacy schedule preference to every device key and lets each device override it', () => {
    setDataOwnerGeneration('owner-a', 1);
    const ownerStorageKey = sidebarOwnerStorageKey(STORAGE_KEY, 'owner-a');
    window.localStorage.setItem(
      ownerStorageKey,
      JSON.stringify({
        'schedule:a': { collapsed: false, lastSeenAt: '2026-08-01T00:00:00.000Z' },
      }),
    );

    expect(isAutomationGroupCollapsed('schedule:a:device:dev-a', 'owner-a', 'schedule:a')).toBe(
      false,
    );
    expect(isAutomationGroupCollapsed('schedule:a:device:dev-b', 'owner-a', 'schedule:a')).toBe(
      false,
    );

    setAutomationGroupCollapsed('schedule:a:device:dev-a', true, 'owner-a', 'schedule:a');

    expect(isAutomationGroupCollapsed('schedule:a:device:dev-a', 'owner-a', 'schedule:a')).toBe(
      true,
    );
    expect(isAutomationGroupCollapsed('schedule:a:device:dev-b', 'owner-a', 'schedule:a')).toBe(
      false,
    );
    expect(JSON.parse(window.localStorage.getItem(ownerStorageKey) ?? '{}')).toMatchObject({
      'schedule:a': { collapsed: false },
      'schedule:a:device:dev-a': { collapsed: true },
      'schedule:a:device:dev-b': { collapsed: false },
    });
  });

  it('keeps a device group collapsed when the local legacy group is expanded later', () => {
    setDataOwnerGeneration('owner-a', 1);
    const ownerStorageKey = sidebarOwnerStorageKey(STORAGE_KEY, 'owner-a');

    setAutomationGroupCollapsed('schedule:a:device:dev-a', true, 'owner-a', 'schedule:a');
    setAutomationGroupCollapsed('schedule:a', false, 'owner-a');

    expect(isAutomationGroupCollapsed('schedule:a:device:dev-a', 'owner-a', 'schedule:a')).toBe(
      true,
    );
    expect(JSON.parse(window.localStorage.getItem(ownerStorageKey) ?? '{}')).toMatchObject({
      'schedule:a': { collapsed: false },
      'schedule:a:device:dev-a': { collapsed: true },
    });
  });

  it('synchronizes mounted groups with the batch collapse control', () => {
    setDataOwnerGeneration('owner-a', 1);
    const hook = renderHook(() => {
      const [allCollapsed, setAllCollapsed, isCollapsed] = useAutomationGroupsCollapsed(
        ['schedule:a', 'schedule:b'],
        'flat',
      );
      const groupACollapsed = isCollapsed('schedule:a');
      const groupBCollapsed = isCollapsed('schedule:b');
      return { groupACollapsed, groupBCollapsed, allCollapsed, setAllCollapsed };
    });

    expect(hook.result.current).toMatchObject({
      groupACollapsed: true,
      groupBCollapsed: true,
      allCollapsed: true,
    });

    act(() => hook.result.current.setAllCollapsed(false));
    expect(hook.result.current).toMatchObject({
      groupACollapsed: false,
      groupBCollapsed: false,
      allCollapsed: false,
    });

    act(() => hook.result.current.setAllCollapsed(true));
    expect(hook.result.current).toMatchObject({
      groupACollapsed: true,
      groupBCollapsed: true,
      allCollapsed: true,
    });
  });

  it('keeps controlled single and batch state across remounts when persistence is blocked', () => {
    sidebarOwnerStorageTesting.setOwnerAuthorityReader((ownerId) => ({
      dataOwnerId: ownerId,
      ownerGeneration: 1,
      claimed: false,
      canInitialize: false,
      pinnedLegacyConsumed: false,
    }));
    setDataOwnerGeneration('owner-a', 1);
    const hook = renderHook(
      ({ groupKeys }: { groupKeys: readonly string[] }) => {
        const [allCollapsed, setAllCollapsed, isCollapsed, setCollapsed] =
          useAutomationGroupsCollapsed(groupKeys, 'flat');
        const groupACollapsed = isCollapsed('schedule:a');
        const groupBCollapsed = isCollapsed('schedule:b');
        return {
          groupACollapsed,
          groupBCollapsed,
          allCollapsed,
          setGroupACollapsed: (collapsed: boolean) => setCollapsed('schedule:a', collapsed),
          setAllCollapsed,
        };
      },
      { initialProps: { groupKeys: ['schedule:a', 'schedule:b'] } },
    );
    const ownerStorageKey = sidebarOwnerStorageKey(STORAGE_KEY, 'owner-a');

    act(() => hook.result.current.setGroupACollapsed(false));
    expect(hook.result.current).toMatchObject({
      groupACollapsed: false,
      groupBCollapsed: true,
      allCollapsed: false,
    });

    hook.rerender({ groupKeys: ['schedule:b'] });
    hook.rerender({ groupKeys: ['schedule:a', 'schedule:b'] });
    expect(hook.result.current.groupACollapsed).toBe(false);

    act(() => hook.result.current.setAllCollapsed(false));
    expect(hook.result.current).toMatchObject({
      groupACollapsed: false,
      groupBCollapsed: false,
      allCollapsed: false,
    });

    hook.rerender({ groupKeys: ['schedule:a'] });
    hook.rerender({ groupKeys: ['schedule:a', 'schedule:b'] });
    expect(hook.result.current).toMatchObject({
      groupACollapsed: false,
      groupBCollapsed: false,
      allCollapsed: false,
    });

    act(() => hook.result.current.setAllCollapsed(true));
    expect(hook.result.current).toMatchObject({
      groupACollapsed: true,
      groupBCollapsed: true,
      allCollapsed: true,
    });
    expect(window.localStorage.getItem(ownerStorageKey)).toBeNull();
  });

  it('reloads persistence after another display mode updates the same group', () => {
    setDataOwnerGeneration('owner-a', 1);
    const hook = renderHook(
      ({ projectionScope }: { projectionScope: 'flat' | 'project' }) => {
        const [, , isCollapsed, setCollapsed] = useAutomationGroupsCollapsed(
          ['schedule:a'],
          projectionScope,
        );
        return {
          groupACollapsed: isCollapsed('schedule:a'),
          setGroupACollapsed: (collapsed: boolean) => setCollapsed('schedule:a', collapsed),
        };
      },
      {
        initialProps: {
          projectionScope: 'flat' as 'flat' | 'project',
        },
      },
    );

    act(() => hook.result.current.setGroupACollapsed(false));
    expect(hook.result.current.groupACollapsed).toBe(false);

    hook.rerender({ projectionScope: 'project' });
    act(() => setAutomationGroupCollapsed('schedule:a', true, 'owner-a'));
    hook.rerender({ projectionScope: 'flat' });

    expect(hook.result.current.groupACollapsed).toBe(true);
  });

  it('keeps the uncontrolled group behavior local to its mounted component', () => {
    sidebarOwnerStorageTesting.setOwnerAuthorityReader((ownerId) => ({
      dataOwnerId: ownerId,
      ownerGeneration: 1,
      claimed: false,
      canInitialize: false,
      pinnedLegacyConsumed: false,
    }));
    setDataOwnerGeneration('owner-a', 1);
    const hook = renderHook(() => {
      const [groupACollapsed, toggleGroupA] = useAutomationGroupCollapsed('schedule:a');
      return {
        groupACollapsed,
        toggleGroupA,
      };
    });
    const ownerStorageKey = sidebarOwnerStorageKey(STORAGE_KEY, 'owner-a');

    act(() => hook.result.current.toggleGroupA());
    expect(hook.result.current).toMatchObject({
      groupACollapsed: false,
    });

    act(() => hook.result.current.toggleGroupA());
    expect(hook.result.current.groupACollapsed).toBe(true);
    expect(window.localStorage.getItem(ownerStorageKey)).toBeNull();
  });

  it('reloads owner and group changes while stale callbacks cannot cross a generation boundary', () => {
    const ownerAKey = sidebarOwnerStorageKey(STORAGE_KEY, 'owner-a');
    const ownerBKey = sidebarOwnerStorageKey(STORAGE_KEY, 'owner-b');
    setAutomationGroupCollapsed('schedule:a', false, 'owner-a');
    setAutomationGroupCollapsed('schedule:b', false, 'owner-b');
    const ownerAValue = window.localStorage.getItem(ownerAKey);
    const ownerBValue = window.localStorage.getItem(ownerBKey);

    setDataOwnerGeneration('owner-a', 1);
    const hook = renderHook(
      ({ groupKey }: { groupKey: string }) => useAutomationGroupCollapsed(groupKey),
      { initialProps: { groupKey: 'schedule:a' } },
    );
    expect(hook.result.current[0]).toBe(false);
    const staleOwnerAToggle = hook.result.current[1];

    setDataOwnerGeneration('owner-a', 2);
    act(() => staleOwnerAToggle());
    expect(hook.result.current[0]).toBe(false);
    expect(window.localStorage.getItem(ownerAKey)).toBe(ownerAValue);

    setDataOwnerGeneration('owner-b', 3);
    act(() => staleOwnerAToggle());
    expect(hook.result.current[0]).toBe(false);
    expect(window.localStorage.getItem(ownerAKey)).toBe(ownerAValue);
    expect(window.localStorage.getItem(ownerBKey)).toBe(ownerBValue);

    hook.rerender({ groupKey: 'schedule:a' });
    expect(hook.result.current[0]).toBe(true);
    const staleOwnerBGroupAToggle = hook.result.current[1];

    hook.rerender({ groupKey: 'schedule:b' });
    expect(hook.result.current[0]).toBe(false);

    act(() => staleOwnerBGroupAToggle());
    expect(hook.result.current[0]).toBe(false);
    expect(window.localStorage.getItem(ownerBKey)).toBe(ownerBValue);

    act(() => hook.result.current[1]());
    expect(hook.result.current[0]).toBe(true);
    expect(window.localStorage.getItem(ownerAKey)).toBe(ownerAValue);
    expect(JSON.parse(window.localStorage.getItem(ownerBKey) ?? '{}')).not.toHaveProperty(
      'schedule:b',
    );
  });
});
