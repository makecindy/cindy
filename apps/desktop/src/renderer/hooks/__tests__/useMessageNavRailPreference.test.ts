// @vitest-environment jsdom

/**
 * useMessageNavRailPreference — 覆盖 override 语义(规则 20):
 *  - 默认开启;localStorage 只存 override
 *  - 关闭 → 写入;开回默认 → 删除 key(清 override)
 *  - 非法存储值回落默认
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import {
  _resetMessageNavRailPreferenceForTests,
  getMessageNavRailEnabled,
  useMessageNavRailPreference,
} from '../useMessageNavRailPreference';

const KEY = 'chat.messageNavRail.enabled';

describe('useMessageNavRailPreference', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetMessageNavRailPreferenceForTests();
  });

  it('defaults to enabled with no stored override', () => {
    expect(getMessageNavRailEnabled()).toBe(true);
    const { result } = renderHook(() => useMessageNavRailPreference());
    expect(result.current.enabled).toBe(true);
    expect(result.current.isCustomized).toBe(false);
  });

  it('reads a stored disabled override', () => {
    localStorage.setItem(KEY, 'false');
    expect(getMessageNavRailEnabled()).toBe(false);
    const { result } = renderHook(() => useMessageNavRailPreference());
    expect(result.current.enabled).toBe(false);
    expect(result.current.isCustomized).toBe(true);
  });

  it('keeps an older stored enabled value as a user override', () => {
    localStorage.setItem(KEY, 'true');
    expect(getMessageNavRailEnabled()).toBe(true);
    const { result } = renderHook(() => useMessageNavRailPreference());
    expect(result.current.enabled).toBe(true);
    expect(result.current.isCustomized).toBe(true);
  });

  it('falls back to default on garbage stored value', () => {
    localStorage.setItem(KEY, 'whatever');
    expect(getMessageNavRailEnabled()).toBe(true);
  });

  it('disabling persists override; enabling removes the key', () => {
    const { result } = renderHook(() => useMessageNavRailPreference());
    act(() => result.current.setEnabled(false));
    expect(localStorage.getItem(KEY)).toBe('false');
    expect(getMessageNavRailEnabled()).toBe(false);

    act(() => result.current.setEnabled(true));
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(getMessageNavRailEnabled()).toBe(true);
    expect(result.current.isCustomized).toBe(false);
  });
});
