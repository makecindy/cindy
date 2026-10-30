import { afterEach, expect, it, vi } from 'vitest';
import { createFileTransferProgressReporter } from '../transfer-progress';

afterEach(() => vi.useRealTimers());

it('throttles byte updates but preserves initial, phase, fallback and final events', () => {
  vi.useFakeTimers();
  const publish = vi.fn();
  const report = createFileTransferProgressReporter(
    { workdir: '/w', relPath: 'a', requestId: 'r' },
    publish,
  );
  report(0, 100);
  report(10, 100);
  vi.advanceTimersByTime(100);
  report(50, 100);
  report(0, 100); // Direct attempt discarded, even within the same 100 ms window.
  report(0, 100, 'upload');
  report(100, 100, 'upload');
  report(0, 0, 'extract');
  expect(publish.mock.calls.map(([e]) => [e.received, e.phase])).toEqual([
    [0, 'download'],
    [50, 'download'],
    [0, 'download'],
    [0, 'upload'],
    [100, 'upload'],
    [0, 'extract'],
  ]);
  for (const [e] of publish.mock.calls)
    expect(e).toMatchObject({ workdir: '/w', relPath: 'a', requestId: 'r' });
});

it('bounds correlation IDs and throttles unknown-size transfers too', () => {
  vi.useFakeTimers();
  const publish = vi.fn();
  const report = createFileTransferProgressReporter(
    { workdir: '/w', relPath: 'a', requestId: 'x'.repeat(65) },
    publish,
  );
  report(0, 0);
  for (let i = 1; i < 100; i++) report(i, 0);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(publish.mock.calls[0][0].requestId).toBeUndefined();
});
