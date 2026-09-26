import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  computeHash: vi.fn(),
  executeOnce: vi.fn(),
  withRetry: vi.fn(),
}));

vi.mock('../integrity', () => ({ computeHash: mocks.computeHash }));
vi.mock('../transport', () => ({ executeOnce: mocks.executeOnce }));
vi.mock('../retry', () => ({ withRetry: mocks.withRetry }));
vi.mock('../resume', () => ({ deletePart: vi.fn(), deleteMeta: vi.fn() }));
vi.mock('../../logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

import { Scheduler } from '../scheduler';
import { createDownloader, download } from '../index';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function options(url: string, targetPath: string, sha256: string, signal?: AbortSignal) {
  return { url, targetPath, sha256, signal };
}

describe('downloader scheduler queued cancellation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.computeHash.mockResolvedValue('not-the-expected-hash');
    mocks.withRetry.mockImplementation(async (run: () => Promise<unknown>) => run());
  });

  it('bulk consumer queues cannot block the host download queue', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    mocks.executeOnce.mockImplementation(async (ctx: { opts: { url: string; sha256: string } }) => {
      if (ctx.opts.url.includes('bulk')) await gate;
      return { size: 1, sha256: ctx.opts.sha256 };
    });
    const bulk = createDownloader();
    const pending = bulk(options('https://bulk.invalid', '/tmp/cindy-bulk', HASH_A));
    try {
      await expect(
        download(options('https://host.invalid', '/tmp/cindy-host', HASH_B)),
      ).resolves.toMatchObject({ sha256: HASH_B });
    } finally {
      release();
    }
    await pending;
  });

  it('rejects an aborted queued task immediately instead of waiting behind an active download', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let executeCount = 0;
    mocks.executeOnce.mockImplementation(async (ctx: { opts: { sha256: string } }) => {
      executeCount += 1;
      if (executeCount === 1) await firstGate;
      return { size: 1, sha256: ctx.opts.sha256 };
    });

    const scheduler = new Scheduler({ maxConcurrent: 1 });
    const first = scheduler.enqueue(options('https://first.invalid', '/tmp/cindy-first', HASH_A));
    await vi.waitFor(() => expect(mocks.executeOnce).toHaveBeenCalledTimes(1));

    const controller = new AbortController();
    const second = scheduler.enqueue(
      options('https://second.invalid', '/tmp/cindy-second', HASH_B, controller.signal),
    );
    controller.abort();

    await expect(second).rejects.toMatchObject({ code: 'ABORTED' });
    expect(mocks.executeOnce).toHaveBeenCalledTimes(1);

    releaseFirst();
    await expect(first).resolves.toMatchObject({ sha256: HASH_A });
  });
});

it('cancels the scheduler cache hash without entering transport or retry', async () => {
  const abort = new AbortController();
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  mocks.computeHash.mockImplementation(
    (_path, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        expect(signal).toBe(abort.signal);
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        entered();
      }),
  );
  mocks.withRetry.mockClear();
  mocks.executeOnce.mockClear();
  const scheduler = new Scheduler({ maxConcurrent: 1 });
  const result = scheduler.enqueue(
    options('https://example.invalid/cache', __filename, HASH_A, abort.signal),
  );
  const rejected = expect(result).rejects.toMatchObject({ code: 'ABORTED' });
  await ready;
  abort.abort();
  await rejected;
  expect(mocks.withRetry).not.toHaveBeenCalled();
  expect(mocks.executeOnce).not.toHaveBeenCalled();
});
