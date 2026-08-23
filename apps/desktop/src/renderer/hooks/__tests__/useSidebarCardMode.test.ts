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

    act(() => result.current.setVisible(false));

    expect(result.current.visible).toBe(false);
    expect(localStorage.getItem('sidebar.pinnedSourceLabelVisible')).toBe('false');
  });

  it('restores the persisted source-label preference', async () => {
    localStorage.setItem('sidebar.pinnedSourceLabelVisible', 'false');
    const { usePinnedSourceLabelPreference } = await import('../useSidebarCardMode');
    const { result } = renderHook(() => usePinnedSourceLabelPreference());

    expect(result.current.visible).toBe(false);
  });
});
