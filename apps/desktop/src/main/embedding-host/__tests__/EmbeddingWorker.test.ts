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
    // After 30 min TTL: tick 2 should allow a probe and call embed() again
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

  it('stops re-probing after the reprobe budget is exhausted (PR #2288 Greptile P1)', async () => {
    // A genuinely invalid model should not be hit every 30 minutes forever.
    // After MODEL_BLOCK_MAX_REPROBES failed reprobes, the worker keeps snoozing
    // without calling embed() until restart.
    vi.useFakeTimers();
    try {
      let now = new Date('2026-08-21T12:00:00Z').getTime();
      vi.setSystemTime(now);
      let rowid = 0;
      const query = vi.fn(async () => [{ ...job(++rowid, `msg-${rowid}`) }]);
      const tx = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ failCount: 0 }));
      const embed = vi.fn(async () => {
        throw new EmbeddingError('model not found', 'INVALID_MODEL', 404);
      });
      const TTL = 30 * 60_000;

      registerProvider({
        source: 'chat',
        getTextsForJobs: async (jobs) =>
          jobs.map(({ rowid: r, sourceId }) => ({ rowid: r, text: sourceId })),
      });

      const worker = new EmbeddingWorker({
        getDbClient: () => ({ query, tx }) as never,
        getClient: () => ({ embed }) as never,
        isVecAvailable: () => true,
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      });
      const tick = (worker as unknown as { tick: () => Promise<void> }).tick.bind(worker);

      // Tick 1: initial block.
      await tick();
      const callsAfterFirst = embed.mock.calls.length;

      // Two TTL windows: each may use one reprobe attempt.
      for (let i = 0; i < 2; i++) {
        now += 31 * 60_000;
        vi.setSystemTime(now);
        await tick();
      }
      const callsAfterReprobes = embed.mock.calls.length;
      // 1 initial + 2 reprobes = 3 calls.
      expect(callsAfterReprobes).toBe(callsAfterFirst + 2);

      // Third TTL window: reprobe budget exhausted, snooze only, no more embed().
      now += 31 * 60_000;
      vi.setSystemTime(now);
      await tick();
      expect(embed.mock.calls.length).toBe(callsAfterReprobes);

      // The exhausted-budget snooze must schedule into the FUTURE (now + TTL),
      // not blockedAt + TTL which is already in the past once the window
      // expired — otherwise the batch is re-selected every 5s tick and rewrites
      // the DB in a hot loop, starving other models (PR #2288 Greptile/Codex P1).
      const exhaustedCall = tx.mock.calls.find(
        (call): call is [string, { terminal?: boolean; snoozeUntil?: number }] =>
          call[0] === 'embedding.recordFailures'
          && call[1]?.terminal === true
          && typeof call[1]?.snoozeUntil === 'number'
          && (call[1]?.snoozeUntil ?? 0) >= now,
      );
      expect(exhaustedCall).toBeDefined();
      expect(exhaustedCall?.[1].snoozeUntil).toBe(now + TTL);
    } finally {
      vi.useRealTimers();
    }
  });

  it('snoozes a transient reprobe failure without consuming retry attempts (PR #2288 Greptile P1)', async () => {
    // When a TTL-expired reprobe hits a transient error (NETWORK / RATE_LIMITED
    // / 5xx) while already circuit-broken, the batch must be snoozed (terminal,
    // attempts NOT incremented) rather than recorded as an ordinary failure —
    // a job already near MAX_ATTEMPTS would otherwise be permanently marked
    // failed by the transient error and never resume after the model recovers.
    vi.useFakeTimers();
    try {
      let now = new Date('2026-08-21T12:00:00Z').getTime();
      vi.setSystemTime(now);
      let rowid = 0;
      const query = vi.fn(async () => [{ ...job(++rowid, `msg-${rowid}`), attempts: 4 }]);
      const tx = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ failCount: 0 }));
      const embed = vi
        .fn()
        .mockRejectedValueOnce(new EmbeddingError('model not found', 'INVALID_MODEL', 404))
        .mockRejectedValueOnce(new EmbeddingError('connection reset', 'NETWORK_ERROR'));

      registerProvider({
        source: 'chat',
        getTextsForJobs: async (jobs) =>
          jobs.map(({ rowid: r, sourceId }) => ({ rowid: r, text: sourceId })),
      });

      const worker = new EmbeddingWorker({
        getDbClient: () => ({ query, tx }) as never,
        getClient: () => ({ embed }) as never,
        isVecAvailable: () => true,
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      });
      const tick = (worker as unknown as { tick: () => Promise<void> }).tick.bind(worker);

      // Tick 1: initial INVALID_MODEL block.
      await tick();
      // TTL 1: reprobe hits NETWORK_ERROR.
      now += 31 * 60_000;
      vi.setSystemTime(now);
      await tick();
      expect(embed).toHaveBeenCalledTimes(2);

      // The transient reprobe failure must be recorded as terminal (snooze,
      // attempts not incremented) so failCount stays 0 even though the job
      // entered with attempts=4 (one ordinary failure from permanent fail).
      const failureCalls = tx.mock.calls.filter(
        (call): call is [string, { terminal?: boolean; snoozeUntil?: number }] =>
          call[0] === 'embedding.recordFailures',
      );
      expect(failureCalls.length).toBeGreaterThan(0);
      const lastFailure = failureCalls.at(-1)![1];
      expect(lastFailure.terminal).toBe(true);
      // Snooze is either explicit (short-circuit path) or defaults to now +
      // TTL in the DB layer; either way it must not be a past timestamp.
      if (lastFailure.snoozeUntil !== undefined) {
        expect(lastFailure.snoozeUntil).toBeGreaterThanOrEqual(now);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves probeCount across a transient reprobe failure (PR #2288 Greptile P1)', async () => {
    // TTL-expired reprobe hits a transient error: block entry stays (blockedAt
    // refreshed) but probeCount is NOT reset. If the next reprobe after TTL
    // returns INVALID_MODEL, probeCount must accumulate so the max-reprobe
    // cap can still be reached — otherwise the budget never exhausts and a
    // permanently invalid model gets probed forever.
    vi.useFakeTimers();
    try {
      let now = new Date('2026-08-21T12:00:00Z').getTime();
      vi.setSystemTime(now);
      let rowid = 0;
      const query = vi.fn(async () => [{ ...job(++rowid, `msg-${rowid}`) }]);
      const tx = vi.fn(async () => ({ failCount: 0 }));
      const embed = vi
        .fn()
        // Tick 1: initial INVALID_MODEL
        .mockRejectedValueOnce(new EmbeddingError('model not found', 'INVALID_MODEL', 404))
        // TTL 1: first reprobe — transient error
        .mockRejectedValueOnce(new EmbeddingError('connection reset', 'NETWORK_ERROR'))
        // TTL 2: second reprobe — INVALID_MODEL (probeCount should be 1)
        .mockRejectedValueOnce(new EmbeddingError('model not found', 'INVALID_MODEL', 404))
        // TTL 3: third reprobe — INVALID_MODEL (probeCount should be 2, at cap)
        .mockRejectedValueOnce(new EmbeddingError('model not found', 'INVALID_MODEL', 404))
        // After cap exhausted, should NOT call embed again
        .mockResolvedValueOnce({ embeddings: [[0.1]], tokensUsed: 0, cacheHits: 0 });

      registerProvider({
        source: 'chat',
        getTextsForJobs: async (jobs) =>
          jobs.map(({ rowid: r, sourceId }) => ({ rowid: r, text: sourceId })),
      });

      const worker = new EmbeddingWorker({
        getDbClient: () => ({ query, tx }) as never,
        getClient: () => ({ embed }) as never,
        isVecAvailable: () => true,
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      });
      const tick = (worker as unknown as { tick: () => Promise<void> }).tick.bind(worker);

      // Tick 1: initial block.
      await tick();
      expect(embed).toHaveBeenCalledTimes(1);

      // TTL 1: first reprobe (probeCount 0→1) returns transient error.
      now += 31 * 60_000;
      vi.setSystemTime(now);
      await tick();
      expect(embed).toHaveBeenCalledTimes(2);

      // TTL 2: second reprobe (probeCount should still be 1, increments to 2)
      // returns INVALID_MODEL.
      now += 31 * 60_000;
      vi.setSystemTime(now);
      await tick();
      expect(embed).toHaveBeenCalledTimes(3);

      // TTL 3: probeCount is now 2 (== MAX_REPROBES), so embed must NOT be
      // called — the batch is snoozed without a network call.
      now += 31 * 60_000;
      vi.setSystemTime(now);
      await tick();
      expect(embed).toHaveBeenCalledTimes(3); // still 3, not 4
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
