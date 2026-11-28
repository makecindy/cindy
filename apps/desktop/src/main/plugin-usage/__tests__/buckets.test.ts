import { afterEach, expect, it, vi } from 'vitest';
import { PluginUsageBuckets } from '../buckets.js';

// Unit uses the production scheduler with a clock and ACK sink. The previous
// SQLite outbox tests could not cover two releases in one slice, sealed replay,
// byte bounds or disable/re-enable while the original transport is pending.
afterEach(() => vi.useRealTimers());

it('coalesces calls by UTC window and release, then drains partial receipts with the same sealed increment', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  vi.setSystemTime(590_000);
  const send = vi.fn<ConstructorParameters<typeof PluginUsageBuckets>[0]['send']>();
  send.mockImplementation(async (_target, rows) => ({
    accepted: rows.slice(0, send.mock.calls.length === 1 ? 1 : rows.length).map(row => ({ eventId: row.eventId, count: row.count })),
    duplicate: [],
    rejected: [],
  }));
  const queue = new PluginUsageBuckets({ send, scope: () => 'owner', jitter: () => 0 });
  const target = { serverRoot: 'https://market.example', ownerId: 'owner', pluginId: 'plugin', scope: 'public' as const, organizationId: null };
  const admission = queue.admit();
  for (let n = 0; n < 5000; n++) queue.add(admission, 'subject', target, 'v1', 590_000);
  queue.add(admission, 'subject', target, 'v2', 590_000);
  queue.add(admission, 'subject', target, 'v2', 600_000);
  await vi.advanceTimersByTimeAsync(599_999);
  expect(send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  const rows = send.mock.calls[0]![1];
  expect(rows.map(row => [row.releaseId, row.bucketStart, row.count])).toEqual([
    ['v1', '1970-01-01T00:00:00.000Z', 5000],
    ['v2', '1970-01-01T00:00:00.000Z', 1],
    ['v2', '1970-01-01T00:10:00.000Z', 1],
  ]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls[1]![1]).toEqual(rows.slice(1));
});

function harness() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  vi.setSystemTime(600_001);
  let scope: string | null = 'owner:global';
  const send = vi.fn<ConstructorParameters<typeof PluginUsageBuckets>[0]['send']>(
    async (_target, rows) => ({ accepted: rows.map(({ eventId, count }) => ({ eventId, count })), duplicate: [], rejected: [] }),
  );
  const queue = new PluginUsageBuckets({ send, scope: () => scope, jitter: () => 0 });
  const target = { serverRoot: 'https://market.example', ownerId: 'owner', pluginId: 'plugin', scope: 'public' as const, organizationId: null };
  return {
    queue, send, setScope: (value: string | null) => { scope = value; },
    add: (release: string) => queue.add(queue.admit(), 'subject', target, release, 600_001),
    target,
  };
}

it.each([
  { releaseLength: 20, batches: [100, 100, 5] },
  { releaseLength: 1_000, batches: [58, 58, 58, 31] },
])('drains 205 increments under item and actual UTF-8 JSON limits', async ({ releaseLength, batches }) => {
  const { add, send } = harness();
  for (let i = 0; i < 205; i++) add(i + 'x'.repeat(releaseLength));
  await vi.advanceTimersByTimeAsync(610_000);
  expect(send.mock.calls.map(([, rows]) => rows.length)).toEqual(batches);
  for (const [, rows] of send.mock.calls)
    expect(Buffer.byteLength(JSON.stringify({ format: 'usage-buckets-v1', buckets: rows }))).toBeLessThanOrEqual(65_536);
  expect(new Set(send.mock.calls.flatMap(([, rows]) => rows.map(row => row.eventId))).size).toBe(205);
});

it('drops queued and stale work on disable, aborts the in-flight batch and admits only new work after enable', async () => {
  const { add, queue, send, target, setScope } = harness();
  let firstSignal: AbortSignal | undefined;
  send.mockImplementationOnce(async (_target, _rows, signal, guard) => {
    firstSignal = signal;
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    guard();
    throw new Error('unexpected');
  });
  const oldAdmission = queue.admit();
  add('sent');
  await vi.advanceTimersByTimeAsync(600_000);
  add('waiting');
  setScope(null);
  queue.invalidate();
  expect(firstSignal?.aborted).toBe(true);
  setScope('owner:global');
  queue.add(oldAdmission, 'subject', target, 'late-callback', 600_001);
  add('new');
  await vi.advanceTimersByTimeAsync(600_000);
  expect(send.mock.calls.map(([, rows]) => rows.map(row => row.releaseId))).toEqual([['sent'], ['new']]);
});

it('retries locked increments after disconnect and discards old work on a region change', async () => {
  const { add, queue, send, setScope } = harness();
  send.mockRejectedValueOnce(new Error('offline'));
  add('v1');
  await vi.advanceTimersByTimeAsync(600_000);
  add('v1');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(send.mock.calls[1]![1]).toEqual(send.mock.calls[0]![1]);
  setScope('owner:cn');
  queue.admit();
  add('v2');
  await vi.advanceTimersByTimeAsync(600_000);
  expect(send.mock.calls.map(([, rows]) => rows.map(row => row.releaseId))).toEqual([['v1'], ['v1'], ['v2']]);
});

it('honors Retry-After and retires only known terminal rejections', async () => {
  const { add, send } = harness();
  send.mockImplementationOnce(async () => { throw { retryAt: Date.now() + 90_000 }; });
  send.mockImplementationOnce(async (_target, rows) => ({
    accepted: [],
    duplicate: [],
    rejected: [
      { eventId: rows[0]!.eventId, code: 'RELEASE_NOT_DELIVERED' },
      { eventId: rows[1]!.eventId, code: 'FUTURE_CODE' },
    ],
  }));
  add('unavailable');
  add('unknown-fate');
  await vi.advanceTimersByTimeAsync(689_999);
  expect(send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(send.mock.calls[1]![1]).toEqual(send.mock.calls[0]![1]);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(send.mock.calls[2]![1]).toEqual(send.mock.calls[0]![1].slice(1));
});
