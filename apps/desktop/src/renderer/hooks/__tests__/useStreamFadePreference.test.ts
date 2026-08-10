// @vitest-environment jsdom

/**
 * useStreamFadePreference — 覆盖 override 语义(规则 20):
 *  - 默认 'off'(动效关闭,opt-in);localStorage 只存 override
 *  - 切 'on' → 写入;切回 'off' → 删除 key(清 override)
 *  - 非法存储值回落默认
 *  - useStreamFadeEnabled 订阅联动:设置页切换后消息渲染侧即时拿到新值
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import {
  _resetStreamFadePreferenceForTests,
  getStreamFadePreference,
  useStreamFadeEnabled,
  useStreamFadePreference,
} from '../useStreamFadePreference';

const KEY = 'chat.streamFadePreference';

describe('useStreamFadePreference', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetStreamFadePreferenceForTests();
  });

  it('defaults to off with no stored override', () => {
    expect(getStreamFadePreference()).toBe('off');
    const { result } = renderHook(() => useStreamFadePreference());
    expect(result.current.preference).toBe('off');
    expect(result.current.isCustomized).toBe(false);
  });

  it('reads a stored on override', () => {
    localStorage.setItem(KEY, 'on');
    expect(getStreamFadePreference()).toBe('on');
    const { result } = renderHook(() => useStreamFadePreference());
    expect(result.current.isCustomized).toBe(true);
  });

  it('falls back to default on garbage stored value', () => {
    localStorage.setItem(KEY, 'whatever');
    expect(getStreamFadePreference()).toBe('off');
  });

  it('setting on persists override; setting back to off removes the key', () => {
    const { result } = renderHook(() => useStreamFadePreference());
    act(() => result.current.setPreference('on'));
    expect(localStorage.getItem(KEY)).toBe('on');
    expect(getStreamFadePreference()).toBe('on');

    act(() => result.current.setPreference('off'));
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(getStreamFadePreference()).toBe('off');
    expect(result.current.isCustomized).toBe(false);
  });

  it('useStreamFadeEnabled tracks toggles from the settings hook', () => {
    const pref = renderHook(() => useStreamFadePreference());
    const enabled = renderHook(() => useStreamFadeEnabled());
    expect(enabled.result.current).toBe(false);

    act(() => pref.result.current.setPreference('on'));
    expect(enabled.result.current).toBe(true);

    act(() => pref.result.current.setPreference('off'));
    expect(enabled.result.current).toBe(false);
  });

  it('useStreamFadeEnabled tracks storage changes without the settings hook mounted', () => {
    const enabled = renderHook(() => useStreamFadeEnabled());
    expect(enabled.result.current).toBe(false);

    act(() => {
      localStorage.setItem(KEY, 'on');
      window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: 'on' }));
    });
    expect(enabled.result.current).toBe(true);

    act(() => {
      localStorage.removeItem(KEY);
      window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: null }));
    });
    expect(enabled.result.current).toBe(false);
  });
});
