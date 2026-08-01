// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

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

  it('stays held while other keys are pressed with the modifier down', () => {
    const { result } = renderHook(() => useModifierHold());
    dispatchKey('keydown', { key: 'Meta', metaKey: true });
    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe(true);
    dispatchKey('keydown', { key: '1', metaKey: true });
    dispatchKey('keyup', { key: '1', metaKey: true });
    expect(result.current).toBe(true);
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

  it('tracks ctrl instead of meta off darwin', () => {
    platformMock.value = 'win32';
    const { result } = renderHook(() => useModifierHold());
    dispatchKey('keydown', { key: 'Meta', metaKey: true });
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(false);
    dispatchKey('keyup', { key: 'Meta', metaKey: false });
    dispatchKey('keydown', { key: 'Control', ctrlKey: true });
    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe(true);
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
