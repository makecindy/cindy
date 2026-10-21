// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PENDING_PREVIEW_TAB_TTL_MS,
  _resetPendingPreviewTabsForTests,
  clearPendingPreviewTab,
  getPendingPreviewTabIds,
  markPendingPreviewTab,
  usePendingPreviewActive,
  usePendingPreviewTab,
} from '../pendingPreviewTabs';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  _resetPendingPreviewTabsForTests();
  vi.useRealTimers();
});

describe('pendingPreviewTabs', () => {
  it('tracks tabs until cleared and drives both hooks', () => {
    const one = renderHook(() => usePendingPreviewTab('t1'));
    const any = renderHook(() => usePendingPreviewActive());
    expect(one.result.current).toBe(false);
    expect(any.result.current).toBe(false);

    act(() => markPendingPreviewTab('t1'));
    expect(one.result.current).toBe(true);
    expect(any.result.current).toBe(true);
    expect([...getPendingPreviewTabIds()]).toEqual(['t1']);

    act(() => clearPendingPreviewTab('t1'));
    expect(one.result.current).toBe(false);
    expect(any.result.current).toBe(false);
  });

  it('expires on its own so a guest that never loads cannot pin the layer forever', () => {
    markPendingPreviewTab('t1');
    act(() => {
      vi.advanceTimersByTime(PENDING_PREVIEW_TAB_TTL_MS + 1);
    });
    expect(getPendingPreviewTabIds().size).toBe(0);
  });

  it('clearing an unknown tab is a no-op', () => {
    markPendingPreviewTab('t1');
    clearPendingPreviewTab('other');
    expect([...getPendingPreviewTabIds()]).toEqual(['t1']);
  });
});
