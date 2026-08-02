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

  it('rejects an aborted queued task immediately instead of waiting behind an active download', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
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
