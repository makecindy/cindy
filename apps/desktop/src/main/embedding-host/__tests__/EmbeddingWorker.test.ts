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

  it('keeps ordinary 4xx input/routing errors retryable for later batches', async () => {
    const batches = [[job(1, 'first')], [job(2, 'second')]];
    const query = vi.fn(async () => batches.shift() ?? []);
    const tx = vi.fn(async (_name: string, args: FailureArgs) => ({
      failCount: args.jobs.length,
    }));
    // 400 without model_not_found body maps to BAD_REQUEST, not INVALID_MODEL;
    // 404 routing error maps to TRANSIENT_ERROR. Neither triggers permanent circuit breaker.
    const embed = vi
      .fn()
      .mockRejectedValueOnce(new EmbeddingError('input too large', 'BAD_REQUEST', 400))
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

  it('re-probes the model after the block TTL expires instead of snoozing forever', async () => {
    // Tick 1: model returns INVALID_MODEL → blocked.
    // After 30 min TTL: tick 2 should delete the block and call embed() again
    // instead of silently snoozing the batch (PR #2288 Codex P1).
    vi.useFakeTimers();
    try {
      const T0 = new Date('2026-08-21T12:00:00Z').getTime();
      vi.setSystemTime(T0);
      const batches = [[job(1, 'first')], [job(2, 'second')]];
      const query = vi.fn(async () => batches.shift() ?? []);
      const tx = vi.fn(async (_name: string, args?: FailureArgs) => ({
        failCount: args?.jobs?.length ?? 0,
      }));
      const embed = vi
        .fn()
        .mockRejectedValueOnce(new EmbeddingError('model not found', 'INVALID_MODEL', 404))
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
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      });
      const tick = (worker as unknown as { tick: () => Promise<void> }).tick.bind(worker);

      await tick();
      expect(embed).toHaveBeenCalledTimes(1);
      expect(tx.mock.calls[0]?.[1]).toMatchObject({ terminal: true });

      // Advance past the 30-minute TTL; next tick must re-probe, not snooze.
      vi.setSystemTime(T0 + 31 * 60_000);
      await tick();

      expect(embed).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the batch pending when the model is disabled during an in-flight INVALID_MODEL failure', async () => {
    // embed() in-flight -> user disables the model -> request fails with INVALID_MODEL.
    // The catch branch must re-check isRouteSuspended(modelId) and NOT write a terminal
    // failure / blockedModels entry, otherwise re-enabling the model later won't
    // re-index these rows (PR #2288 review).
    const batches = [[job(1, 'first')], [job(2, 'second')]];
    const query = vi.fn(async () => batches.shift() ?? []);
    const tx = vi.fn(async (_name: string, args: FailureArgs) => ({
      failCount: args.jobs.length,
    }));
    let routeSuspended = false;
    const embed = vi.fn(async () => {
      // Flip "user disabled model" while the request is in flight, before it rejects.
      routeSuspended = true;
      throw new EmbeddingError('model not found', 'INVALID_MODEL', 404);
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
      isRouteSuspended: () => routeSuspended,
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const tick = (worker as unknown as { tick: () => Promise<void> }).tick.bind(worker);

    await tick();

    // embed() was called once; the failure must NOT have been recorded as a terminal
    // batch — those jobs stay pending so they resume when the model is re-enabled.
    expect(embed).toHaveBeenCalledTimes(1);
    expect(tx).not.toHaveBeenCalled();
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
