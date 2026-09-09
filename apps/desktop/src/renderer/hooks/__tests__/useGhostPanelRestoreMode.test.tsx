// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  __resetGhostPanelRestoreModeForTest,
  getGhostPanelRestoreMode,
  setGhostPanelRestoreMode,
  useGhostPanelRestoreMode,
} from '../useGhostPanelRestoreMode';

afterEach(() => {
  cleanup();
  window.localStorage.removeItem('ghostPanel.restoreMode');
  __resetGhostPanelRestoreModeForTest();
});

describe('useGhostPanelRestoreMode', () => {
  it('默认沿用浮动气泡且不写默认值快照', () => {
    expect(getGhostPanelRestoreMode()).toBe('bubble');
    expect(window.localStorage.getItem('ghostPanel.restoreMode')).toBeNull();
  });

  it('切换到侧栏会持久化并通知同窗口消费者', () => {
    const first = renderHook(() => useGhostPanelRestoreMode());
    const second = renderHook(() => useGhostPanelRestoreMode());

    act(() => first.result.current.setMode('sidebar'));

    expect(first.result.current.mode).toBe('sidebar');
    expect(second.result.current.mode).toBe('sidebar');
    expect(window.localStorage.getItem('ghostPanel.restoreMode')).toBe('sidebar');
  });

  it('切回默认气泡会删除 override', () => {
    setGhostPanelRestoreMode('sidebar');
    expect(window.localStorage.getItem('ghostPanel.restoreMode')).toBe('sidebar');

    setGhostPanelRestoreMode('bubble');

    expect(getGhostPanelRestoreMode()).toBe('bubble');
    expect(window.localStorage.getItem('ghostPanel.restoreMode')).toBeNull();
  });

  it('接收其他窗口的偏好变更', () => {
    const view = renderHook(() => useGhostPanelRestoreMode());

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'ghostPanel.restoreMode',
          newValue: 'sidebar',
        }),
      );
    });

    expect(view.result.current.mode).toBe('sidebar');
  });
});
