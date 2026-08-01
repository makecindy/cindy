// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import {
  _resetComposerSendShortcutPreferenceForTests,
  getComposerSendShortcutPreference,
  resolveComposerEnterIntent,
  useComposerSendShortcutPreference,
  type ComposerSendShortcutPreference,
} from '../useComposerSendShortcutPreference';

const KEY = 'chat.sendShortcutPreference';

function enterEvent(
  overrides: Partial<Pick<KeyboardEvent, 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey' | 'repeat' | 'isComposing'>> = {},
): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Enter', ...overrides });
}

describe('useComposerSendShortcutPreference', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetComposerSendShortcutPreferenceForTests();
  });

  it('defaults to Enter and treats the default as not customized', () => {
    expect(getComposerSendShortcutPreference()).toBe('enter');

    const { result } = renderHook(() => useComposerSendShortcutPreference());

    expect(result.current.preference).toBe('enter');
    expect(result.current.isCustomized).toBe(false);
  });

  it('only accepts the modifier-enter override from storage', () => {
    localStorage.setItem(KEY, 'modifier-enter');
    expect(getComposerSendShortcutPreference()).toBe('modifier-enter');

    _resetComposerSendShortcutPreferenceForTests();
    localStorage.setItem(KEY, 'enter');
    expect(getComposerSendShortcutPreference()).toBe('enter');

    _resetComposerSendShortcutPreferenceForTests();
    localStorage.setItem(KEY, 'garbage');
    expect(getComposerSendShortcutPreference()).toBe('enter');
  });

  it('persists the non-default override and removes it when reset', () => {
    const { result } = renderHook(() => useComposerSendShortcutPreference());

    act(() => result.current.setPreference('modifier-enter'));
    expect(localStorage.getItem(KEY)).toBe('modifier-enter');
    expect(getComposerSendShortcutPreference()).toBe('modifier-enter');
    expect(result.current.isCustomized).toBe(true);

    act(() => result.current.setPreference('enter'));
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(getComposerSendShortcutPreference()).toBe('enter');
    expect(result.current.isCustomized).toBe(false);
  });

  it('updates mounted hooks when another renderer changes the preference', () => {
    const { result } = renderHook(() => useComposerSendShortcutPreference());

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: KEY,
          newValue: 'modifier-enter',
        }),
      );
    });

    expect(result.current.preference).toBe('modifier-enter');
    expect(result.current.isCustomized).toBe(true);
  });

  describe('resolveComposerEnterIntent', () => {
    const cases: Array<{
      name: string;
      preference: ComposerSendShortcutPreference;
      turnRunning: boolean;
      event: KeyboardEvent;
      expected: 'queue' | 'steer' | 'native' | 'ignore' | null;
    }> = [
      {
        name: 'sends with plain Enter in Enter mode',
        preference: 'enter',
        turnRunning: false,
        event: enterEvent(),
        expected: 'queue',
      },
      {
        name: 'steers with Cmd/Ctrl+Enter while a turn is running in Enter mode',
        preference: 'enter',
        turnRunning: true,
        event: enterEvent({ metaKey: true }),
        expected: 'steer',
      },
      {
        name: 'queues with Cmd/Ctrl+Enter while idle in Enter mode',
        preference: 'enter',
        turnRunning: false,
        event: enterEvent({ ctrlKey: true }),
        expected: 'queue',
      },
      {
        name: 'uses native Enter for a newline in modifier-enter mode',
        preference: 'modifier-enter',
        turnRunning: true,
        event: enterEvent(),
        expected: 'native',
      },
      {
        name: 'queues with Cmd/Ctrl+Enter in modifier-enter mode',
        preference: 'modifier-enter',
        turnRunning: true,
        event: enterEvent({ metaKey: true }),
        expected: 'queue',
      },
      {
        name: 'ignores a repeated Enter send',
        preference: 'enter',
        turnRunning: true,
        event: enterEvent({ repeat: true }),
        expected: 'ignore',
      },
      {
        name: 'leaves IME composition to the native editor path',
        preference: 'enter',
        turnRunning: false,
        event: enterEvent({ isComposing: true }),
        expected: 'native',
      },
      {
        name: 'ignores Shift+Enter so list and hard-break handling can run',
        preference: 'enter',
        turnRunning: false,
        event: enterEvent({ shiftKey: true }),
        expected: null,
      },
      {
        name: 'ignores Alt+Enter so hard-break handling can run',
        preference: 'modifier-enter',
        turnRunning: false,
        event: enterEvent({ altKey: true }),
        expected: null,
      },
      {
        name: 'ignores other keys',
        preference: 'enter',
        turnRunning: false,
        event: new KeyboardEvent('keydown', { key: 'Escape' }),
        expected: null,
      },
    ];

    it.each(cases)('$name', ({ preference, turnRunning, event, expected }) => {
      expect(resolveComposerEnterIntent(event, preference, { turnRunning })).toBe(expected);
    });
  });
});
