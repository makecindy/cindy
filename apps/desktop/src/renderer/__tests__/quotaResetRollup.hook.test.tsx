// @vitest-environment jsdom

import * as React from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ROLLUP_DURATION_MS,
  ROLLUP_SETTLE_MS,
  useQuotaResetRollup,
  type ChipWindowSlot,
} from '../components/status/quotaResetRollup';

const NOW = 10_000_000;
const oldSlot: ChipWindowSlot = { key: 'account:5h', remainingPercent: 60, resetsAtMs: NOW - 1_000 };
const newSlot: ChipWindowSlot = { ...oldSlot, remainingPercent: 98, resetsAtMs: NOW + 18_000_000 };

function mount(slot: ChipWindowSlot | null = oldSlot) {
  return renderHook(({ value }) => useQuotaResetRollup(value), {
    initialProps: { value: slot },
    wrapper: ({ children }) => <React.StrictMode>{children}</React.StrictMode>,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('quota reset animation lifecycle', () => {
  it('rolls a confirmed reset once, survives new object identities, then settles', () => {
    const hook = mount();
    expect(hook.result.current).toEqual({ percent: 60, celebrating: false });
    hook.rerender({ value: newSlot });
    expect(hook.result.current).toEqual({ percent: 0, celebrating: true });
    act(() => vi.advanceTimersByTime(600));
    const halfway = hook.result.current?.percent;
    expect(halfway).toBeGreaterThan(60);
    hook.rerender({ value: { ...newSlot } });
    expect(hook.result.current?.percent).toBe(halfway);
    act(() => vi.advanceTimersByTime(ROLLUP_DURATION_MS + ROLLUP_SETTLE_MS));
    expect(hook.result.current).toEqual({ percent: 98, celebrating: false });
    hook.rerender({ value: { ...newSlot } });
    expect(hook.result.current).toEqual({ percent: 98, celebrating: false });
  });

  it.each(['different-window', 'missing'] as const)(
    'does not revive settled 98%% celebration after switching through %s',
    (kind) => {
      const hook = mount();
      hook.rerender({ value: newSlot });
      act(() => vi.advanceTimersByTime(ROLLUP_DURATION_MS + 32));
      expect(hook.result.current).toEqual({ percent: 98, celebrating: true });
      hook.rerender({ value: kind === 'missing' ? null : { ...newSlot, key: 'other:5h' } });
      hook.rerender({ value: newSlot });
      expect(hook.result.current).toEqual({ percent: 98, celebrating: false });
      act(() => vi.advanceTimersByTime(ROLLUP_SETTLE_MS));
      expect(hook.result.current).toEqual({ percent: 98, celebrating: false });
    },
  );

  it('cancels mid-roll when the window disappears and cleans up pending work', () => {
    const hook = mount();
    hook.rerender({ value: newSlot });
    act(() => vi.advanceTimersByTime(300));
    hook.rerender({ value: null });
    expect(hook.result.current).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    hook.rerender({ value: newSlot });
    expect(hook.result.current).toEqual({ percent: 98, celebrating: false });
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('ignores old-cycle replay (already celebrated: %s)', (celebrated) => {
    const hook = mount(celebrated ? oldSlot : newSlot);
    hook.rerender({ value: newSlot });
    act(() => vi.advanceTimersByTime(2_000));
    hook.rerender({ value: oldSlot });
    expect(hook.result.current).toEqual({ percent: 60, celebrating: false });
    hook.rerender({ value: newSlot });
    expect(hook.result.current).toEqual({ percent: 98, celebrating: false });
  });

  it('cancels an active reveal on old-cycle replay without restarting on recovery', () => {
    const hook = mount();
    hook.rerender({ value: newSlot });
    act(() => vi.advanceTimersByTime(300));
    hook.rerender({ value: oldSlot });
    hook.rerender({ value: newSlot });
    expect(hook.result.current).toEqual({ percent: 98, celebrating: false });
  });

  it('does not celebrate a same-cycle 98 → 60 → 98 correction', () => {
    const hook = mount(newSlot);
    hook.rerender({ value: { ...newSlot, remainingPercent: 60 } });
    hook.rerender({ value: newSlot });
    expect(hook.result.current).toEqual({ percent: 98, celebrating: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([null, NOW - 2_000])(
    'advances displayed remaining while retaining the cycle baseline (%s)',
    (resetsAtMs) => {
      const hook = mount();
      hook.rerender({ value: { ...newSlot, resetsAtMs } });
      expect(hook.result.current).toEqual({ percent: 98, celebrating: false });
      hook.rerender({ value: { ...newSlot, resetsAtMs } });
      hook.rerender({ value: newSlot });
      expect(hook.result.current).toEqual({ percent: 98, celebrating: false });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('does not lose the latest cycle after a reset-less percentage update', () => {
    const hook = mount(newSlot);
    hook.rerender({ value: { ...newSlot, remainingPercent: 60, resetsAtMs: null } });
    hook.rerender({ value: oldSlot });
    hook.rerender({ value: newSlot });
    expect(hook.result.current).toEqual({ percent: 98, celebrating: false });
  });

  it('skips the entire celebration for reduced motion', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const hook = mount();
    hook.rerender({ value: newSlot });
    expect(hook.result.current).toEqual({ percent: 98, celebrating: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});
