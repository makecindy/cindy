// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearRateHistoryCache } from '@cindy/maker-shared';
import { useRunningTokenRateHistory } from '../session/useRunningTokenRateHistory';

type Input = Parameters<typeof useRunningTokenRateHistory>[0];
const initial: Input = {
  sessionKey: 'owner/device/task',
  startedAt: 1,
  outputTokens: 1000,
  generationDurationMs: 10_000,
  generationReliable: true,
};
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let current: Input;
function Probe(props: Input) {
  const history = useRunningTokenRateHistory(props);
  return <span>{history.latestRate ?? 'waiting'}</span>;
}
function report(patch: Partial<Input> = {}) {
  current = { ...current, ...patch };
  act(() => root.render(<Probe key={current.sessionKey} {...current} />));
  return host.textContent;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  clearRateHistoryCache();
  host = document.createElement('div');
  root = createRoot(host);
  current = { ...initial };
});
afterEach(() => {
  act(() => root.unmount());
  clearRateHistoryCache();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('waits for a paired interval and shows its rate instead of the turn average', () => {
  expect(report()).toBe('waiting');
  expect(report({ outputTokens: 1025, generationDurationMs: 10_500 })).toBe('waiting');
  expect(report({ outputTokens: 1100, generationDurationMs: 12_000 })).toBe('50');
  // Clock ticks and time-only reports do not manufacture slower throughput.
  act(() => vi.advanceTimersByTime(5000));
  expect(host.textContent).toBe('50');
  expect(report({ generationDurationMs: 14_000 })).toBe('50');
  expect(report({ outputTokens: 1140 })).toBe('20');
});

it('expires stale samples after 60 seconds and resumes on a new paired report', () => {
  report();
  report({ outputTokens: 1100, generationDurationMs: 12_000 });
  act(() => vi.advanceTimersByTime(59_999));
  expect(host.textContent).toBe('50');
  act(() => vi.advanceTimersByTime(1));
  expect(host.textContent).toBe('waiting');
  expect(report({ outputTokens: 1140, generationDurationMs: 14_000 })).toBe('20');
});

it('resets the baseline for a new turn and for counter rollback', () => {
  report();
  report({ outputTokens: 1100, generationDurationMs: 12_000 });
  expect(report({ startedAt: 2, outputTokens: 0, generationDurationMs: 0 })).toBe('waiting');
  expect(report({ outputTokens: 100, generationDurationMs: 1000 })).toBe('100');
  expect(report({ outputTokens: 10, generationDurationMs: 100 })).toBe('waiting');
});

it('records the final interval when the terminal report clears the remote start', () => {
  report();
  expect(report({ outputTokens: 1100, generationDurationMs: 12_000 })).toBe('50');
  expect(report({ startedAt: null, outputTokens: 1140, generationDurationMs: 14_000 })).toBe('20');
  act(() => vi.advanceTimersByTime(600));
  expect(report()).toBe('20');
  // A real next turn still resets the terminal sample.
  expect(report({ startedAt: 2, outputTokens: 0, generationDurationMs: 0 })).toBe('waiting');
});

it('discards unreliable or reconnecting measurements instead of reviving the old rate', () => {
  report();
  report({ outputTokens: 1100, generationDurationMs: 12_000 });
  expect(report({ generationReliable: false })).toBe('waiting');
  expect(report({ generationReliable: true })).toBe('waiting');
  expect(report({ outputTokens: 1140, generationDurationMs: 14_000 })).toBe('20');
});

it('isolates tasks and restores only fresh cached measurements on return', () => {
  report();
  report({ outputTokens: 1100, generationDurationMs: 12_000 });
  expect(report({ sessionKey: 'other/device/task' })).toBe('waiting');
  expect(report({ sessionKey: initial.sessionKey })).toBe('50');
  report({ sessionKey: 'other/device/task' });
  act(() => vi.advanceTimersByTime(60_000));
  expect(report({ sessionKey: initial.sessionKey })).toBe('waiting');
});

it('keeps measured zero distinct from missing data', () => {
  expect(report({ outputTokens: 0, generationDurationMs: 0 })).toBe('waiting');
  expect(report({ generationDurationMs: 1000 })).toBe('0');
});

it('does not show the previous rate before the next remote turn starts', () => {
  report();
  expect(report({ outputTokens: 1100, generationDurationMs: 12_000 })).toBe('50');
  act(() => root.unmount());
  root = createRoot(host);
  current = {
    ...current,
    startedAt: null,
    streaming: true,
    outputTokens: 1100,
    generationDurationMs: 12_000,
  };
  act(() => root.render(<Probe key={current.sessionKey} {...current} />));
  expect(host.textContent).toBe('waiting');

  act(() => root.unmount());
  root = createRoot(host);
  current = { ...current, streaming: false };
  act(() => root.render(<Probe key={current.sessionKey} {...current} />));
  expect(host.textContent).toBe('waiting');
});

it('drops the previous rate when a new local turn starts during the terminal linger', () => {
  report();
  expect(report({ outputTokens: 1100, generationDurationMs: 12_000 })).toBe('50');
  expect(
    report({
      startedAt: null,
      outputTokens: 1140,
      generationDurationMs: 14_000,
      streaming: false,
    }),
  ).toBe('20');
  expect(report({ streaming: true })).toBe('waiting');
  expect(
    report({
      startedAt: 2,
      outputTokens: 0,
      generationDurationMs: 0,
      streaming: true,
    }),
  ).toBe('waiting');
  expect(report({ outputTokens: 40, generationDurationMs: 1000 })).toBe('40');
});
