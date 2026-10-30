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

  /**
   * 评审 P1：本窗口在没有任何消费者的窗口期里摘掉了 storage listener，期间另一个
   * 窗口改了偏好就收不到事件；重挂载时 readPreference 又会走模块级缓存早退，会让
   * 开关与文件树永久陈旧到下一次变更或刷新。所以首个监听者（重）挂载时要让缓存
   * 失效、回落 localStorage。
   */
  it('无消费者窗口期后重挂载会重读 localStorage', () => {
    const first = renderHook(() => useFileBrowserPreference());
    expect(first.result.current.showIgnoredDirs).toBe(false);
    first.unmount(); // → 本窗口没有监听者了

    // 另一个窗口改了偏好：只落 localStorage，本窗口收不到 storage 事件。
    localStorage.setItem(KEY, 'true');

    const second = renderHook(() => useFileBrowserPreference());
    expect(second.result.current.showIgnoredDirs).toBe(true);
    expect(second.result.current.isCustomized).toBe(true);
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
