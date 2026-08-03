// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { installEarlyKeyDownCapture } from '../../lib/earlyKeyDownCapture';
import { useModifierHold } from '../useModifierHold';

const platformMock = vi.hoisted(() => ({ value: 'darwin' }));

vi.mock('../../lib/appShortcutStore', () => ({
  getAppShortcutPlatform: () => platformMock.value,
}));

function dispatchKey(type: 'keydown' | 'keyup', init: KeyboardEventInit) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent(type, init));
  });
}

describe('useModifierHold', () => {
  beforeEach(() => {
    platformMock.value = 'darwin';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete document.body.dataset.appShortcutRecording;
  });

  it('activates only after holding meta past the delay on darwin', () => {
    const { result } = renderHook(() => useModifierHold());
    dispatchKey('keydown', { key: 'Meta', metaKey: true });
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(499));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
    dispatchKey('keyup', { key: 'Meta', metaKey: false });
    expect(result.current).toBe(false);
  });

  it('quick combos (meta pressed briefly) never activate', () => {
    const { result } = renderHook(() => useModifierHold());
    dispatchKey('keydown', { key: 'Meta', metaKey: true });
    dispatchKey('keydown', { key: 'c', metaKey: true });
    dispatchKey('keyup', { key: 'c', metaKey: true });
    dispatchKey('keyup', { key: 'Meta', metaKey: false });
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(false);
  });

  it.each([
    ['control', { key: 'Control', ctrlKey: true }],
    ['shift', { key: 'Shift', shiftKey: true }],
    ['alt', { key: 'Alt', altKey: true }],
    ['regular key', { key: '1' }],
  ] satisfies Array<[string, KeyboardEventInit]>)(
    'hides after %s joins the held modifier and waits for a fresh hold',
    (_label, otherKey) => {
      const { result } = renderHook(() => useModifierHold());
      dispatchKey('keydown', { key: 'Meta', metaKey: true });
      act(() => vi.advanceTimersByTime(500));
      expect(result.current).toBe(true);

      dispatchKey('keydown', { ...otherKey, metaKey: true });
      expect(result.current).toBe(false);
      dispatchKey('keyup', { ...otherKey, metaKey: true });
      act(() => vi.advanceTimersByTime(1000));
      expect(result.current).toBe(false);

      dispatchKey('keyup', { key: 'Meta', metaKey: false });
      dispatchKey('keydown', { key: 'Meta', metaKey: true });
      act(() => vi.advanceTimersByTime(500));
      expect(result.current).toBe(true);
    },
  );

  it('cancels a pending hold as soon as another key is pressed', () => {
    const { result } = renderHook(() => useModifierHold());
    dispatchKey('keydown', { key: 'Meta', metaKey: true });
    act(() => vi.advanceTimersByTime(250));
    dispatchKey('keydown', { key: 'c', metaKey: true });
    dispatchKey('keyup', { key: 'c', metaKey: true });
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(false);
  });

  it('observes keydown before an earlier shortcut listener stops immediate propagation', () => {
    const disposeCapture = installEarlyKeyDownCapture();
    const blocker = (event: KeyboardEvent) => event.stopImmediatePropagation();
    window.addEventListener('keydown', blocker, true);
    const preserveOnKeyDown = vi.fn(() => false);

    const { result, unmount } = renderHook(() => useModifierHold({ preserveOnKeyDown }));
    try {
      dispatchKey('keydown', { key: 'Meta', metaKey: true });
      act(() => vi.advanceTimersByTime(500));
      expect(result.current).toBe(true);

      dispatchKey('keydown', { key: 'f', metaKey: true });
      expect(result.current).toBe(false);
      expect(preserveOnKeyDown).toHaveBeenCalledTimes(1);
    } finally {
      unmount();
      window.removeEventListener('keydown', blocker, true);
      disposeCapture();
    }
  });

  it('keeps the hold while explicitly permitted shortcut keys are pressed', () => {
    const { result } = renderHook(() =>
      useModifierHold({
        preserveOnKeyDown: (event) =>
          (event.code === 'Digit1' || event.code === 'Digit2') &&
          event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.shiftKey,
      }),
    );
    dispatchKey('keydown', { key: 'Meta', code: 'MetaLeft', metaKey: true });
    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe(true);

    dispatchKey('keydown', { key: '1', code: 'Digit1', metaKey: true });
    dispatchKey('keyup', { key: '1', code: 'Digit1', metaKey: true });
    dispatchKey('keydown', { key: '2', code: 'Digit2', metaKey: true });
    dispatchKey('keyup', { key: '2', code: 'Digit2', metaKey: true });
    expect(result.current).toBe(true);

    dispatchKey('keydown', { key: '3', code: 'Digit3', metaKey: true });
    expect(result.current).toBe(false);
  });

  it('restores a qualified hold for an explicitly permitted shortcut with extra modifiers', () => {
    const { result } = renderHook(() =>
      useModifierHold({
        preserveOnKeyDown: (event) =>
          event.code === 'Digit1' &&
          event.metaKey &&
          event.shiftKey &&
          !event.ctrlKey &&
          !event.altKey,
      }),
    );
    dispatchKey('keydown', { key: 'Meta', code: 'MetaLeft', metaKey: true });
    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe(true);

    dispatchKey('keydown', { key: 'Shift', metaKey: true, shiftKey: true });
    expect(result.current).toBe(false);
    dispatchKey('keydown', { key: '1', code: 'Digit1', metaKey: true, shiftKey: true });
    expect(result.current).toBe(true);
    dispatchKey('keyup', { key: '1', code: 'Digit1', metaKey: true, shiftKey: true });
    dispatchKey('keyup', { key: 'Shift', metaKey: true, shiftKey: false });
    expect(result.current).toBe(true);

    dispatchKey('keydown', { key: 'x', code: 'KeyX', metaKey: true });
    expect(result.current).toBe(false);
  });

  it('does not let a permitted extra-modifier shortcut bypass the hold delay', () => {
    const { result } = renderHook(() =>
      useModifierHold({
        preserveOnKeyDown: (event) =>
          event.code === 'Digit1' &&
          event.metaKey &&
          event.shiftKey &&
          !event.ctrlKey &&
          !event.altKey,
      }),
    );
    dispatchKey('keydown', { key: 'Meta', code: 'MetaLeft', metaKey: true });
    act(() => vi.advanceTimersByTime(250));
    dispatchKey('keydown', { key: 'Shift', metaKey: true, shiftKey: true });
    dispatchKey('keydown', { key: '1', code: 'Digit1', metaKey: true, shiftKey: true });
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(249));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it('does not start the hold delay when the primary modifier was pressed into an existing chord', () => {
    const { result } = renderHook(() =>
      useModifierHold({
        preserveOnKeyDown: (event) =>
          event.code === 'Digit1' &&
          event.metaKey &&
          event.shiftKey &&
          !event.ctrlKey &&
          !event.altKey,
      }),
    );
    dispatchKey('keydown', { key: 'Shift', shiftKey: true });
    dispatchKey('keydown', { key: 'Meta', metaKey: true, shiftKey: true });
    dispatchKey('keydown', { key: '1', code: 'Digit1', metaKey: true, shiftKey: true });
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(false);
  });

  it('keeps the macOS screenshot chord hidden when the OS swallows its keyup sequence', () => {
    const { result } = renderHook(() => useModifierHold());
    dispatchKey('keydown', { key: 'Meta', metaKey: true });
    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe(true);

    dispatchKey('keydown', { key: 'Shift', metaKey: true, shiftKey: true });
    dispatchKey('keydown', {
      key: 'Control',
      metaKey: true,
      shiftKey: true,
      ctrlKey: true,
    });
    dispatchKey('keydown', {
      key: '4',
      metaKey: true,
      shiftKey: true,
      ctrlKey: true,
    });
    expect(result.current).toBe(false);

    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(false);

    dispatchKey('keydown', { key: 'Meta', metaKey: true, repeat: true });
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(false);

    dispatchKey('keydown', { key: 'Meta', metaKey: true, repeat: false });
    act(() => vi.advanceTimersByTime(499));
    expect(result.current).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
  });

  it('treats primary-modifier keyup as released even when its modifier flag is stale', () => {
    const { result } = renderHook(() => useModifierHold());
    dispatchKey('keydown', { key: 'Meta', metaKey: true });
    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe(true);

    dispatchKey('keyup', { key: 'Meta', metaKey: true });
    expect(result.current).toBe(false);
  });

  it('window blur resets the held state (lost keyup)', () => {
    const { result } = renderHook(() => useModifierHold());
    dispatchKey('keydown', { key: 'Meta', metaKey: true });
    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe(true);
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(result.current).toBe(false);
  });

  it('pointermove without the modifier clears a stuck hold (keyup swallowed by native menu)', () => {
    const { result } = renderHook(() => useModifierHold());
    dispatchKey('keydown', { key: 'Meta', metaKey: true });
    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe(true);
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { metaKey: false }));
    });
    expect(result.current).toBe(false);
  });

  it('pointermove with the modifier held does not disturb the hold', () => {
    const { result } = renderHook(() => useModifierHold());
    dispatchKey('keydown', { key: 'Meta', metaKey: true });
    act(() => vi.advanceTimersByTime(500));
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { metaKey: true }));
    });
    expect(result.current).toBe(true);
  });

  it('uses the same exclusive-hold behavior for ctrl off darwin', () => {
    platformMock.value = 'win32';
    const { result } = renderHook(() =>
      useModifierHold({
        preserveOnKeyDown: (event) =>
          event.code === 'Digit1' &&
          event.ctrlKey &&
          event.shiftKey &&
          !event.metaKey &&
          !event.altKey,
      }),
    );
    dispatchKey('keydown', { key: 'Meta', metaKey: true });
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(false);
    dispatchKey('keyup', { key: 'Meta', metaKey: false });
    dispatchKey('keydown', { key: 'Control', ctrlKey: true });
    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe(true);

    dispatchKey('keydown', { key: 'Shift', ctrlKey: true, shiftKey: true });
    expect(result.current).toBe(false);
    dispatchKey('keydown', { key: '1', code: 'Digit1', ctrlKey: true, shiftKey: true });
    dispatchKey('keyup', { key: '1', code: 'Digit1', ctrlKey: true, shiftKey: true });
    dispatchKey('keyup', { key: 'Shift', ctrlKey: true, shiftKey: false });
    expect(result.current).toBe(true);

    dispatchKey('keydown', { key: 'Alt', ctrlKey: true, altKey: true });
    expect(result.current).toBe(false);
    dispatchKey('keyup', { key: 'Alt', ctrlKey: true });
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(false);
  });

  it('is suppressed while the settings shortcut recorder is active', () => {
    document.body.dataset.appShortcutRecording = '1';
    const { result } = renderHook(() => useModifierHold());
    dispatchKey('keydown', { key: 'Meta', metaKey: true });
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(false);
  });

  it('enabled=false keeps the state off and drops listeners', () => {
    const { result, rerender } = renderHook(({ enabled }) => useModifierHold({ enabled }), {
      initialProps: { enabled: true },
    });
    dispatchKey('keydown', { key: 'Meta', metaKey: true });
    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe(true);
    rerender({ enabled: false });
    expect(result.current).toBe(false);
    dispatchKey('keydown', { key: 'Meta', metaKey: true });
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(false);
  });
});
