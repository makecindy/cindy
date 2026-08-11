// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'sidebar.showSessionTime';

describe('useSidebarSessionTimeVisibility', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('defaults to showing session time when no override exists', async () => {
    const { getShowSidebarSessionTime } = await import('@/hooks/useSidebarSessionTimeVisibility');

    expect(getShowSidebarSessionTime()).toBe(true);
  });

  it('reads a stored false override and persists false when disabled', async () => {
    localStorage.setItem(STORAGE_KEY, 'false');
    const { getShowSidebarSessionTime, useSidebarSessionTimeVisibility } =
      await import('@/hooks/useSidebarSessionTimeVisibility');

    expect(getShowSidebarSessionTime()).toBe(false);
    const view = renderHook(() => useSidebarSessionTimeVisibility());

    act(() => view.result.current.setShowSessionTime(false));

    expect(view.result.current.showSessionTime).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('false');
  });

  it('removes the override when restored to the default', async () => {
    localStorage.setItem(STORAGE_KEY, 'false');
    const { useSidebarSessionTimeVisibility } = await import('@/hooks/useSidebarSessionTimeVisibility');
    const view = renderHook(() => useSidebarSessionTimeVisibility());

    act(() => view.result.current.resetShowSessionTime());

    expect(view.result.current.showSessionTime).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('treats invalid stored values as the default', async () => {
    localStorage.setItem(STORAGE_KEY, 'not-a-boolean');
    const { getShowSidebarSessionTime } = await import('@/hooks/useSidebarSessionTimeVisibility');

    expect(getShowSidebarSessionTime()).toBe(true);
  });

  it('shares one window storage listener across multiple hook instances', async () => {
    const addEventListener = vi.spyOn(window, 'addEventListener');
    const removeEventListener = vi.spyOn(window, 'removeEventListener');
    const { useSidebarSessionTimeVisibility } = await import('@/hooks/useSidebarSessionTimeVisibility');

    const view = renderHook(() => ({
      first: useSidebarSessionTimeVisibility(),
      second: useSidebarSessionTimeVisibility(),
    }));

    expect(addEventListener.mock.calls.filter(([type]) => type === 'storage')).toHaveLength(1);

    view.unmount();

    expect(removeEventListener.mock.calls.filter(([type]) => type === 'storage')).toHaveLength(1);
  });
});
