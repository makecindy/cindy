// @vitest-environment jsdom

/**
 * useStreamFadePreference — 覆盖 override 语义(规则 20):
 *  - 默认 'on'(动效开启);localStorage 只存 override
 *  - 切 'off' → 写入;切回 'on' → 删除 key(清 override)
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

  it('defaults to on with no stored override', () => {
    expect(getStreamFadePreference()).toBe('on');
    const { result } = renderHook(() => useStreamFadePreference());
    expect(result.current.preference).toBe('on');
    expect(result.current.isCustomized).toBe(false);
  });

  it('reads a stored off override', () => {
    localStorage.setItem(KEY, 'off');
    expect(getStreamFadePreference()).toBe('off');
    const { result } = renderHook(() => useStreamFadePreference());
    expect(result.current.isCustomized).toBe(true);
  });

  it('clears a legacy on override after the default changes to on', () => {
    localStorage.setItem(KEY, 'on');
    expect(getStreamFadePreference()).toBe('on');
    expect(localStorage.getItem(KEY)).toBeNull();
    const { result } = renderHook(() => useStreamFadePreference());
    expect(result.current.isCustomized).toBe(false);
  });

  it('falls back to default on garbage stored value', () => {
    localStorage.setItem(KEY, 'whatever');
    expect(getStreamFadePreference()).toBe('on');
  });

  it('setting off persists override; setting back to on removes the key', () => {
    const { result } = renderHook(() => useStreamFadePreference());
    act(() => result.current.setPreference('off'));
    expect(localStorage.getItem(KEY)).toBe('off');
    expect(getStreamFadePreference()).toBe('off');

    act(() => result.current.setPreference('on'));
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(getStreamFadePreference()).toBe('on');
    expect(result.current.isCustomized).toBe(false);
  });

  it('useStreamFadeEnabled tracks toggles from the settings hook', () => {
    const pref = renderHook(() => useStreamFadePreference());
    const enabled = renderHook(() => useStreamFadeEnabled());
    expect(enabled.result.current).toBe(true);

    act(() => pref.result.current.setPreference('off'));
    expect(enabled.result.current).toBe(false);

    act(() => pref.result.current.setPreference('on'));
    expect(enabled.result.current).toBe(true);
  });

  it('useStreamFadeEnabled tracks storage changes without the settings hook mounted', () => {
    const enabled = renderHook(() => useStreamFadeEnabled());
    expect(enabled.result.current).toBe(true);

    act(() => {
      localStorage.setItem(KEY, 'off');
      window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: 'off' }));
    });
    expect(enabled.result.current).toBe(false);

    act(() => {
      localStorage.removeItem(KEY);
      window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: null }));
    });
    expect(enabled.result.current).toBe(true);
  });
});
