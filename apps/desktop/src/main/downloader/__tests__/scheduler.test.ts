import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  computeHash: vi.fn(),
  executeOnce: vi.fn(),
  withRetry: vi.fn(),
}));

vi.mock('../integrity', () => ({ computeHash: mocks.computeHash }));
vi.mock('../transport', () => ({ executeOnce: mocks.executeOnce, assertDownloadUrl: vi.fn() }));
vi.mock('../retry', () => ({ withRetry: mocks.withRetry }));
vi.mock('../resume', () => ({ deletePart: vi.fn(), deleteMeta: vi.fn() }));
vi.mock('../../logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

import { Scheduler } from '../scheduler';
import { createDownloader, download } from '../index';

let root: string;
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function options(url: string, targetPath: string, sha256: string, signal?: AbortSignal) {
  return { url, targetPath, sha256, signal };
}

describe('downloader scheduler queued cancellation', () => {
  it('starts the total timeout only when a queued transfer obtains its slot', async () => {
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      mocks.executeOnce
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = () => resolve({ size: 1, sha256: HASH_A });
            }),
        )
        .mockImplementationOnce(
          ({ signal }) =>
            new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            }),
        );
      mocks.withRetry.mockImplementation(async (run: () => Promise<unknown>) => run());
      const scheduler = new Scheduler({ maxConcurrent: 1 });
      const first = scheduler.enqueue(
        options('https://first.invalid', path.join(root, 'first'), HASH_A),
      );
      const second = scheduler.enqueue({
        ...options('https://second.invalid', path.join(root, 'second'), HASH_B),
        timeout: { totalMs: 120_000 },
      });
      const rejected = expect(second).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(180_000);
      expect(mocks.executeOnce).toHaveBeenCalledTimes(1);
      finish();
      await first;
      expect(mocks.executeOnce).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(120_000);
      await rejected;
      expect(scheduler.listActive()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-scheduler-'));
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
    const first = scheduler.enqueue(
      options('https://first.invalid', path.join(root, 'first'), HASH_A),
    );
    await vi.waitFor(() => expect(mocks.executeOnce).toHaveBeenCalledTimes(1));

    const controller = new AbortController();
    const second = scheduler.enqueue(
      options('https://second.invalid', path.join(root, 'second'), HASH_B, controller.signal),
    );
    controller.abort();

    await expect(second).rejects.toMatchObject({ code: 'ABORTED' });
    expect(mocks.executeOnce).toHaveBeenCalledTimes(1);

    releaseFirst();
    await expect(first).resolves.toMatchObject({ sha256: HASH_A });
  });
  it('holds its slot during cache hashing and starts the queue after a cache hit', async () => {
    const scheduler = new Scheduler({ maxConcurrent: 1 });
    const cached = path.join(root, 'cached');
    fs.writeFileSync(cached, 'cached');
    let finishHash!: (hash: string) => void;
    mocks.computeHash.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishHash = resolve;
        }),
    );
    mocks.executeOnce.mockResolvedValue({ size: 1, sha256: HASH_B });
    const first = scheduler.enqueue(options('https://first.invalid', cached, HASH_A));
    const second = scheduler.enqueue(
      options('https://second.invalid', path.join(root, 'next'), HASH_B),
    );
    expect(mocks.executeOnce).not.toHaveBeenCalled();
    expect(scheduler.listActive()).toHaveLength(1);
    finishHash(HASH_A);
    await expect(first).resolves.toMatchObject({ fromCache: true });
    await expect(second).resolves.toMatchObject({ sha256: HASH_B });
    expect(scheduler.listActive()).toEqual([]);
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
        // The scheduler hashes under its own active-budget signal, linked to the caller's.
        expect(signal.aborted).toBe(false);
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
