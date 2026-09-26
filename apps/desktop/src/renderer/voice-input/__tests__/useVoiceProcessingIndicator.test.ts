// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VoiceInputState } from '@cindy/voice-input-core';
import { useVoiceProcessingIndicator } from '../useVoiceProcessingIndicator';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('never shows processing when stop completes within 150 ms', () => {
  const h = renderHook(
    ({ state }: { state: VoiceInputState }) => useVoiceProcessingIndicator(state),
    { initialProps: { state: 'listening' as VoiceInputState } },
  );
  h.rerender({ state: 'submitting' });
  act(() => vi.advanceTimersByTime(100));
  expect(h.result.current).toBe(false);
  h.rerender({ state: 'done' });
  act(() => vi.advanceTimersByTime(200));
  expect(h.result.current).toBe(false);
});

it('counts submitting and refining as one continuous wait', () => {
  const h = renderHook(
    ({ state }: { state: VoiceInputState }) => useVoiceProcessingIndicator(state),
    { initialProps: { state: 'submitting' as VoiceInputState } },
  );
  act(() => vi.advanceTimersByTime(100));
  h.rerender({ state: 'refining' });
  act(() => vi.advanceTimersByTime(49));
  expect(h.result.current).toBe(false);
  act(() => vi.advanceTimersByTime(1));
  expect(h.result.current).toBe(true);
  h.rerender({ state: 'done' });
  expect(h.result.current).toBe(false);
});

it('clears the timer on cancellation and starts fresh for another recording', () => {
  const h = renderHook(
    ({ state }: { state: VoiceInputState }) => useVoiceProcessingIndicator(state),
    { initialProps: { state: 'submitting' as VoiceInputState } },
  );
  act(() => vi.advanceTimersByTime(150));
  expect(h.result.current).toBe(true);
  h.rerender({ state: 'error' });
  h.rerender({ state: 'listening' });
  h.rerender({ state: 'submitting' });
  expect(h.result.current).toBe(false);
  h.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
