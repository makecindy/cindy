// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MobileVoiceState } from '@/session/mobileVoiceInput';
import { useMobileVoiceProcessingIndicator } from '@/session/useMobileVoiceProcessingIndicator';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let value: ReturnType<typeof useMobileVoiceProcessingIndicator>;
function Probe({ state }: { state: MobileVoiceState }) {
  value = useMobileVoiceProcessingIndicator(state);
  return null;
}
async function render(state: MobileVoiceState) {
  await act(async () => root.render(createElement(Probe, { state })));
}
beforeEach(() => {
  vi.useFakeTimers();
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});

it('keeps the stopping state for 150 ms before showing the processing spinner', async () => {
  await render('listening');
  expect(value).toEqual({ showProcessing: false, stopping: false });
  await render('submitting');
  expect(value).toEqual({ showProcessing: false, stopping: true });
  await act(async () => vi.advanceTimersByTimeAsync(149));
  expect(value.showProcessing).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(value).toEqual({ showProcessing: true, stopping: false });
  // submitting → refining stays one processing phase: no second delay.
  await render('refining');
  expect(value).toEqual({ showProcessing: true, stopping: false });
});

it('never shows the spinner when stop finishes within the delay, and re-arms per stop', async () => {
  await render('submitting');
  await act(async () => vi.advanceTimersByTimeAsync(100));
  await render('done');
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(value).toEqual({ showProcessing: false, stopping: false });
  await render('submitting');
  expect(value).toEqual({ showProcessing: false, stopping: true });
});
