// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import {
  COMPOSER_FOLLOW_UP_STORAGE_KEY as KEY,
  _resetComposerFollowUpPreferenceForTests,
  getComposerFollowUpBehavior,
  useComposerFollowUpPreference,
} from '../useComposerFollowUpPreference';

describe('useComposerFollowUpPreference', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetComposerFollowUpPreferenceForTests();
  });

  it('defaults to queue without an override and falls back from unknown stored values', () => {
    expect(getComposerFollowUpBehavior()).toBe('queue');

    _resetComposerFollowUpPreferenceForTests();
    localStorage.setItem(KEY, 'interrupt');
    const { result } = renderHook(() => useComposerFollowUpPreference());
    expect(result.current.preference).toBe('queue');
    expect(result.current.isCustomized).toBe(false);
  });

  it('stores only the steer override and deletes it when restored to the default', () => {
    const { result } = renderHook(() => useComposerFollowUpPreference());

    act(() => result.current.setPreference('steer'));
    expect(localStorage.getItem(KEY)).toBe('steer');
    expect(getComposerFollowUpBehavior()).toBe('steer');
    expect(result.current.isCustomized).toBe(true);

    act(() => result.current.setPreference('queue'));
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(getComposerFollowUpBehavior()).toBe('queue');
    expect(result.current.isCustomized).toBe(false);
  });

  it('follows another window through storage events, including a removed override', () => {
    const { result } = renderHook(() => useComposerFollowUpPreference());

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: 'steer' }));
    });
    expect(result.current.preference).toBe('steer');
    expect(getComposerFollowUpBehavior()).toBe('steer');

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: null }));
    });
    expect(result.current.preference).toBe('queue');
  });
});
