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
  it('synchronizes mounted groups with the batch collapse control', () => {
    setDataOwnerGeneration('owner-a', 1);
    const hook = renderHook(() => {
      const [groupACollapsed] = useAutomationGroupCollapsed('schedule:a');
      const [groupBCollapsed] = useAutomationGroupCollapsed('schedule:b');
      const [allCollapsed, setAllCollapsed] = useAutomationGroupsCollapsed([
        'schedule:a',
        'schedule:b',
      ]);
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

  it('keeps mounted single and batch state when persistence is temporarily blocked', () => {
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
      const [groupBCollapsed] = useAutomationGroupCollapsed('schedule:b');
      const [allCollapsed, setAllCollapsed] = useAutomationGroupsCollapsed([
        'schedule:a',
        'schedule:b',
      ]);
      return {
        groupACollapsed,
        groupBCollapsed,
        allCollapsed,
        toggleGroupA,
        setAllCollapsed,
      };
    });
    const ownerStorageKey = sidebarOwnerStorageKey(STORAGE_KEY, 'owner-a');

    act(() => hook.result.current.toggleGroupA());
    expect(hook.result.current).toMatchObject({
      groupACollapsed: false,
      groupBCollapsed: true,
      allCollapsed: false,
    });

    act(() => hook.result.current.toggleGroupA());
    expect(hook.result.current.groupACollapsed).toBe(true);

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
