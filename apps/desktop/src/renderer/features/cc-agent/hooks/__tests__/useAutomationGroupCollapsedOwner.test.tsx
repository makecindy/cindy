// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  __testing as dataOwnerGenerationTesting,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import { sidebarOwnerStorageKey } from '@/lib/sidebarOwnerStorage';
import {
  setAutomationGroupCollapsed,
  useAutomationGroupCollapsed,
} from '../useAutomationGroupCollapsed';

const STORAGE_KEY = 'cc-agent.sidebar.collapsedAutomationGroups';

beforeEach(() => {
  window.localStorage.clear();
  dataOwnerGenerationTesting.reset();
});

describe('automation group collapsed owner binding', () => {
  it('reloads owner and group changes while stale callbacks cannot cross a generation boundary', () => {
    const ownerAKey = sidebarOwnerStorageKey(STORAGE_KEY, 'owner-a');
    const ownerBKey = sidebarOwnerStorageKey(STORAGE_KEY, 'owner-b');
    setAutomationGroupCollapsed('schedule:a', true, 'owner-a');
    setAutomationGroupCollapsed('schedule:b', true, 'owner-b');
    const ownerAValue = window.localStorage.getItem(ownerAKey);
    const ownerBValue = window.localStorage.getItem(ownerBKey);

    setDataOwnerGeneration('owner-a', 1);
    const hook = renderHook(
      ({ groupKey }: { groupKey: string }) => useAutomationGroupCollapsed(groupKey),
      { initialProps: { groupKey: 'schedule:a' } },
    );
    expect(hook.result.current[0]).toBe(true);
    const staleOwnerAToggle = hook.result.current[1];

    setDataOwnerGeneration('owner-a', 2);
    act(() => staleOwnerAToggle());
    expect(hook.result.current[0]).toBe(true);
    expect(window.localStorage.getItem(ownerAKey)).toBe(ownerAValue);

    setDataOwnerGeneration('owner-b', 3);
    act(() => staleOwnerAToggle());
    expect(hook.result.current[0]).toBe(true);
    expect(window.localStorage.getItem(ownerAKey)).toBe(ownerAValue);
    expect(window.localStorage.getItem(ownerBKey)).toBe(ownerBValue);

    hook.rerender({ groupKey: 'schedule:a' });
    expect(hook.result.current[0]).toBe(false);
    const staleOwnerBGroupAToggle = hook.result.current[1];

    hook.rerender({ groupKey: 'schedule:b' });
    expect(hook.result.current[0]).toBe(true);

    act(() => staleOwnerBGroupAToggle());
    expect(hook.result.current[0]).toBe(true);
    expect(window.localStorage.getItem(ownerBKey)).toBe(ownerBValue);

    act(() => hook.result.current[1]());
    expect(hook.result.current[0]).toBe(false);
    expect(window.localStorage.getItem(ownerAKey)).toBe(ownerAValue);
    expect(JSON.parse(window.localStorage.getItem(ownerBKey) ?? '{}')).not.toHaveProperty(
      'schedule:b',
    );
  });
});
