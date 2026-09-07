// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { shouldNotifyMainOnPinnedModeMount } from '../useSidebarCardMode';

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('shouldNotifyMainOnPinnedModeMount', () => {
  it('本 renderer 首次挂载才通知 main', () => {
    expect(shouldNotifyMainOnPinnedModeMount(false)).toBe(true);
  });

  it('重挂载不再通知,避免失败的 setItem 旧值盖回 main', () => {
    expect(shouldNotifyMainOnPinnedModeMount(true)).toBe(false);
  });
});

describe('usePinnedSourceLabelPreference', () => {
  it('defaults to showing source labels and persists an explicit opt-out', async () => {
    const { usePinnedSourceLabelPreference } = await import('../useSidebarCardMode');
    const { result } = renderHook(() => usePinnedSourceLabelPreference());

    expect(result.current.visible).toBe(true);
    expect(result.current.isOverridden).toBe(false);

    act(() => result.current.setVisible(false));

    expect(result.current.visible).toBe(false);
    expect(result.current.isOverridden).toBe(true);
    expect(localStorage.getItem('sidebar.pinnedSourceLabelVisible')).toBe('false');
  });

  it('removes the override when restoring the default and synchronizes subscribers', async () => {
    const { usePinnedSourceLabelPreference } = await import('../useSidebarCardMode');
    const first = renderHook(() => usePinnedSourceLabelPreference());
    const second = renderHook(() => usePinnedSourceLabelPreference());

    act(() => first.result.current.setVisible(false));
    expect(second.result.current.visible).toBe(false);

    act(() => first.result.current.resetToDefault());
    expect(first.result.current).toMatchObject({ visible: true, isOverridden: false });
    expect(second.result.current).toMatchObject({ visible: true, isOverridden: false });
    expect(localStorage.getItem('sidebar.pinnedSourceLabelVisible')).toBeNull();
  });

  it('restores the persisted source-label preference', async () => {
    localStorage.setItem('sidebar.pinnedSourceLabelVisible', 'false');
    const { usePinnedSourceLabelPreference } = await import('../useSidebarCardMode');
    const { result } = renderHook(() => usePinnedSourceLabelPreference());

    expect(result.current.visible).toBe(false);
  });
});
