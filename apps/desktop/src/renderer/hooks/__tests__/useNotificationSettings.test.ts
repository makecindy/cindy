// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('electronAPI', undefined);

import { getSoundNotificationsEnabled, useNotificationSettings } from '../useNotificationSettings';

const SOUND_KEY = 'notifications.soundEnabled';

describe('useNotificationSettings sound override', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('uses the default without persisting an override', () => {
    expect(getSoundNotificationsEnabled()).toBe(true);
    const { result } = renderHook(() => useNotificationSettings());
    expect(result.current.soundEnabled).toBe(true);
    expect(result.current.soundIsCustomized).toBe(false);
    expect(localStorage.getItem(SOUND_KEY)).toBeNull();
  });

  it('persists an explicit value even when it matches the current default', () => {
    const { result } = renderHook(() => useNotificationSettings());
    act(() => result.current.setSoundEnabled(false));
    expect(localStorage.getItem(SOUND_KEY)).toBe('false');
    expect(result.current.soundIsCustomized).toBe(true);

    act(() => result.current.setSoundEnabled(true));
    expect(localStorage.getItem(SOUND_KEY)).toBe('true');
    expect(result.current.soundIsCustomized).toBe(true);
  });

  it('reset removes the override and follows the current default', () => {
    localStorage.setItem(SOUND_KEY, 'false');
    const { result } = renderHook(() => useNotificationSettings());
    expect(result.current.soundIsCustomized).toBe(true);

    act(() => result.current.resetSoundEnabled());

    expect(result.current.soundEnabled).toBe(true);
    expect(result.current.soundIsCustomized).toBe(false);
    expect(localStorage.getItem(SOUND_KEY)).toBeNull();
  });

  it('treats a stored value equal to the current default as an explicit override', () => {
    localStorage.setItem(SOUND_KEY, 'true');
    expect(getSoundNotificationsEnabled()).toBe(true);
    const { result } = renderHook(() => useNotificationSettings());
    expect(result.current.soundIsCustomized).toBe(true);
    expect(localStorage.getItem(SOUND_KEY)).toBe('true');
  });
});
