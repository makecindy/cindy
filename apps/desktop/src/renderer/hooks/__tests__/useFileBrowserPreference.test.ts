// @vitest-environment jsdom

/**
 * useFileBrowserPreference — 覆盖「显示被忽略的目录」的 override 语义(规则 20):
 *  - 默认关闭(保持历史行为);localStorage 只存 override
 *  - 打开 → 写入;改回默认 → 删除 key(清 override)
 *  - 非法存储值回落默认
 *  - 误写入的默认值('false')也算显式 override(Cindy 会显示「恢复默认」)
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import {
  _resetFileBrowserPreferenceForTests,
  getShowIgnoredDirs,
  useFileBrowserPreference,
} from '../useFileBrowserPreference';

const KEY = 'fileBrowser.showIgnoredDirs';

describe('useFileBrowserPreference', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetFileBrowserPreferenceForTests();
  });

  it('无 override 时默认隐藏被忽略目录', () => {
    expect(getShowIgnoredDirs()).toBe(false);
    const { result } = renderHook(() => useFileBrowserPreference());
    expect(result.current.showIgnoredDirs).toBe(false);
    expect(result.current.isCustomized).toBe(false);
  });

  it('读取已存的开启 override', () => {
    localStorage.setItem(KEY, 'true');
    expect(getShowIgnoredDirs()).toBe(true);
    const { result } = renderHook(() => useFileBrowserPreference());
    expect(result.current.showIgnoredDirs).toBe(true);
    expect(result.current.isCustomized).toBe(true);
  });

  it('非法存储值回落默认', () => {
    localStorage.setItem(KEY, 'whatever');
    expect(getShowIgnoredDirs()).toBe(false);
  });

  it('开启写 override;改回默认删除 key', () => {
    const { result } = renderHook(() => useFileBrowserPreference());

    act(() => result.current.setShowIgnoredDirs(true));
    expect(localStorage.getItem(KEY)).toBe('true');
    expect(getShowIgnoredDirs()).toBe(true);
    expect(result.current.isCustomized).toBe(true);

    act(() => result.current.setShowIgnoredDirs(false));
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(getShowIgnoredDirs()).toBe(false);
    expect(result.current.isCustomized).toBe(false);
  });

  it('存储不可用时内存 SoT 仍生效', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled');
      },
    });
    try {
      const { result } = renderHook(() => useFileBrowserPreference());
      act(() => result.current.setShowIgnoredDirs(true));
      expect(result.current.showIgnoredDirs).toBe(true);
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});
