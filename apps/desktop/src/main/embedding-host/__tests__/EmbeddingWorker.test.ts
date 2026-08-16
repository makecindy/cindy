import { EmbeddingError } from '@cindy/embedding-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EmbeddingWorker } from '../EmbeddingWorker';
import { clearProviders, registerProvider } from '../providers';

interface FailureArgs {
  jobs: Array<{ rowid: number; attempts: number }>;
  errMsg: string;
  terminal?: boolean;
}

describe('EmbeddingWorker invalid-model circuit breaker', () => {
  afterEach(() => clearProviders());

  it('fails the first 404 batch immediately and skips API calls for later batches of that model', async () => {
    const batches = [[job(1, 'first')], [job(2, 'second')]];
    const query = vi.fn(async () => batches.shift() ?? []);
    const tx = vi.fn(async (_name: string, args: FailureArgs) => ({
      failCount: args.jobs.length,
    }));
    const embed = vi.fn(async () => {
      throw new EmbeddingError('model is unsupported', 'INVALID_MODEL', 404);
    });

    registerProvider({
      source: 'chat',
      getTextsForJobs: async (jobs) =>
        jobs.map(({ rowid, sourceId }) => ({ rowid, text: sourceId })),
    });

    const worker = new EmbeddingWorker({
      getDbClient: () => ({ query, tx }) as never,
      getClient: () => ({ embed }) as never,
      isVecAvailable: () => true,
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tick = (worker as unknown as { tick: () => Promise<void> }).tick.bind(worker);

    await tick();
    await tick();

    expect(embed).toHaveBeenCalledTimes(1);
    expect(tx).toHaveBeenCalledTimes(2);
    expect(tx.mock.calls[0]?.[1]).toMatchObject({
      jobs: [{ rowid: 1, attempts: 0 }],
      terminal: true,
    });
    expect(tx.mock.calls[1]?.[1]).toMatchObject({
      jobs: [{ rowid: 2, attempts: 0 }],
      terminal: true,
    });
  });

  it('keeps ordinary invalid-model 4xx failures retryable for later batches', async () => {
    const batches = [[job(1, 'first')], [job(2, 'second')]];
    const query = vi.fn(async () => batches.shift() ?? []);
    const tx = vi.fn(async (_name: string, args: FailureArgs) => ({
      failCount: args.jobs.length,
    }));
    const embed = vi
      .fn()
      .mockRejectedValueOnce(new EmbeddingError('gateway rejected the request', 'INVALID_MODEL', 400))
      .mockResolvedValueOnce({ embeddings: [[0.1]], tokensUsed: 0, cacheHits: 0 });

    registerProvider({
      source: 'chat',
      getTextsForJobs: async (jobs) =>
        jobs.map(({ rowid, sourceId }) => ({ rowid, text: sourceId })),
    });

    const worker = new EmbeddingWorker({
      getDbClient: () => ({ query, tx }) as never,
      getClient: () => ({ embed }) as never,
      isVecAvailable: () => true,
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tick = (worker as unknown as { tick: () => Promise<void> }).tick.bind(worker);

    await tick();
    await tick();

    expect(embed).toHaveBeenCalledTimes(2);
    expect(tx.mock.calls[0]?.[1]).toMatchObject({
      jobs: [{ rowid: 1, attempts: 0 }],
      terminal: false,
    });
  });
});

function job(rowid: number, sourceId: string) {
  return {
    rowid,
    source: 'chat',
    source_id: sourceId,
    chunk_index: 0,
    model_id: 'voyage/voyage-4',
    vec_table: 'chat_vec',
    attempts: 0,
  };
}
