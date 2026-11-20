import { describe, expect, it, vi } from 'vitest';

import { DbErrorBoundary } from '../DbErrorBoundary.js';

describe('DbErrorBoundary', () => {
  it('catches and rethrows RPC errors through wrap', async () => {
    const boundary = new DbErrorBoundary();
    const err = new Error('boom');
    await expect(boundary.wrap('query', async () => {
      throw err;
    })).rejects.toBe(err);
  });

  it('allows one auto restart and blocks subsequent terminations', () => {
    const boundary = new DbErrorBoundary({ maxAutoRestart: 1 });
    expect(boundary.onWorkerTerminated({ code: 1, signal: null })).toEqual({
      shouldRestart: true,
    });
    expect(boundary.onWorkerTerminated({ code: 1, signal: null })).toEqual({
      shouldRestart: false,
    });
  });

  it('does not create unhandledRejection when the wrapped promise rejects and is awaited', async () => {
    const boundary = new DbErrorBoundary();
    const handler = vi.fn();
    process.once('unhandledRejection', handler);
    await expect(boundary.wrap('query', async () => {
      throw new Error('handled');
    })).rejects.toThrow('handled');
    await new Promise((resolve) => setImmediate(resolve));
    expect(handler).not.toHaveBeenCalled();
    process.off('unhandledRejection', handler);
  });
});

// #9555: code-based isolation must not turn syntax/constraint/busy errors or
// arbitrary prose into a permanent outage. No native resources in this matrix.
it.each(['SQLITE_CORRUPT', 'SQLITE_CORRUPT_INDEX', 'SQLITE_CORRUPT_SEQUENCE', 'SQLITE_CORRUPT_VTAB'])('blocks re-entry and restart after %s', async (code) => {
  const notify = vi.fn();
  const boundary = new DbErrorBoundary({ onCorruption: notify });
  const cause = Object.assign(new Error('native failure'), { code });
  await expect(boundary.wrap('query', async () => { throw cause; })).rejects.toBe(cause);
  const next = vi.fn(async () => 1);
  await expect(boundary.wrap('query', next)).rejects.toMatchObject({ code: 'DB_TRANSPORT_NOT_SENT', cause });
  expect(next).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledOnce();
  expect(boundary.onWorkerTerminated({ code: 1, signal: null }).shouldRestart).toBe(false);
  await expect(boundary.wrap('dispose', next)).resolves.toBe(1);
});
it.each(['SQLITE_BUSY', 'SQLITE_ERROR', 'SQLITE_CONSTRAINT', 'SQLITE_CORRUPT_FAKE', undefined])('keeps ordinary error %s recoverable', async (code) => {
  const boundary = new DbErrorBoundary();
  await expect(boundary.wrap('query', async () => { throw Object.assign(new Error('malformed'), { code }); })).rejects.toThrow('malformed');
  await expect(boundary.wrap('query', async () => 7)).resolves.toBe(7);
});
