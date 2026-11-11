import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { watchSharedTaskAccess } from '@/device-link/sharedTaskAccessWatch';

const active = { sharedTaskId: 'sharedTask', sessionId: 'session', status: 'active' };
const disposers: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { disposers.splice(0).forEach(stop => stop()); vi.useRealTimers(); });
function start(read: () => Promise<typeof active>, isCurrent = () => true) {
  const onRevoked = vi.fn();
  const stop = watchSharedTaskAccess({ ...active, read, isCurrent, onRevoked });
  disposers.push(stop);
  return { onRevoked, stop };
}

it('only polls again after the previous read settles', async () => {
  let resolve!: (value: typeof active) => void;
  const read = vi.fn(() => new Promise<typeof active>(done => { resolve = done; }));
  const watch = start(read);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(read).toHaveBeenCalledTimes(1);
  resolve(active);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
  expect(watch.onRevoked).not.toHaveBeenCalled();
});

it.each([
  new ApiError('UNAUTHORIZED', 401, 'login expired'),
  new ApiError('ROUTE_NOT_FOUND', 404, 'unsupported'),
  new ApiError('NOT_FOUND', 503, 'unavailable'),
  new Error('timeout'),
])('does not infer revoked access from %s', async error => {
  const read = vi.fn().mockRejectedValue(error);
  const watch = start(read);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(watch.onRevoked).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(2);
});

it.each(['missing', 'closed'])('revokes once after a confirmed %s membership', async state => {
  const read = state === 'missing'
    ? vi.fn().mockRejectedValue(new ApiError('NOT_FOUND', 404, 'not found'))
    : vi.fn().mockResolvedValue({ ...active, status: 'closed' });
  const watch = start(read);
  const other = start(async () => active);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(watch.onRevoked).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(1);
  expect(other.onRevoked).not.toHaveBeenCalled();
});

it.each(['stop', 'owner'])('ignores late responses after %s changes', async boundary => {
  let reject!: (reason: Error) => void;
  let current = true;
  const read = vi.fn(() => new Promise<typeof active>((_, fail) => { reject = fail; }));
  const old = start(read, () => current);
  if (boundary === 'stop') old.stop(); else current = false;
  const next = start(async () => active);
  reject(new ApiError('NOT_FOUND', 404, 'not found'));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(old.onRevoked).not.toHaveBeenCalled();
  expect(next.onRevoked).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(1);
});

it('ignores a closed detail for a different task', async () => {
  const watch = start(async () => ({ ...active, sessionId: 'other', status: 'closed' }));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(watch.onRevoked).not.toHaveBeenCalled();
});
