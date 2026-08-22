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

  it('persists only a non-default value and clears it when returning to default', () => {
    const { result } = renderHook(() => useNotificationSettings());
    act(() => result.current.setSoundEnabled(false));
    expect(localStorage.getItem(SOUND_KEY)).toBe('false');
    expect(result.current.soundIsCustomized).toBe(true);

    act(() => result.current.setSoundEnabled(true));
    expect(localStorage.getItem(SOUND_KEY)).toBeNull();
    expect(result.current.soundIsCustomized).toBe(false);
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

  it('removes a legacy stored snapshot that equals the current default', () => {
    localStorage.setItem(SOUND_KEY, 'true');
    expect(getSoundNotificationsEnabled()).toBe(true);
    expect(localStorage.getItem(SOUND_KEY)).toBeNull();
  });
});
