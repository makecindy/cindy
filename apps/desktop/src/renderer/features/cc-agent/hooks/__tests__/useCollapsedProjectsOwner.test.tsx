// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useCollapsedProjects } from '../useCollapsedProjects';

const PROJECT = 'local:/workspace/a';

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
});
