import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UtilityTextResult } from '../../../shared/utilityTextResult.js';
import { DEDICATED_AUTO_REVIEW_CANDIDATES } from '../../utility-model/oneShotCandidates.js';
import {
  AUTO_REVIEW_CHAIN_TIMEOUT_MS,
  createAutoReviewModelRouter,
} from '../auto-review-model-router.js';

const logger = () => ({ debug: vi.fn(), warn: vi.fn() });

function failed(
  candidate: (typeof DEDICATED_AUTO_REVIEW_CANDIDATES)[number],
  reason: 'timeout' | 'empty_response' | 'request_failed' | 'http_error',
  httpStatus?: number,
): UtilityTextResult {
  return {
    ok: false,
    reason: reason === 'timeout' || reason === 'empty_response' ? reason : 'all_candidates_failed',
    attempts: [reason === 'http_error'
      ? {
        providerId: candidate.providerId,
        model: candidate.model,
        transport: candidate.transport,
        status: 'failed',
        reason,
        httpStatus: httpStatus ?? 500,
      }
      : {
        providerId: candidate.providerId,
        model: candidate.model,
        transport: candidate.transport,
        status: 'failed',
        reason,
      }],
  };
}

function succeeded(
  candidate: (typeof DEDICATED_AUTO_REVIEW_CANDIDATES)[number],
  text: string,
): UtilityTextResult {
  return {
    ok: true,
    text,
    providerId: candidate.providerId,
    model: candidate.model,
    transport: candidate.transport,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('dedicated Auto-review candidate policy', () => {
  it('contains only the managed Gateway and supported subscription models in fixed order', () => {
    expect(DEDICATED_AUTO_REVIEW_CANDIDATES.map((candidate) => [
      candidate.providerId,
      candidate.model,
    ])).toEqual([
      ['xd', 'cindy/auto-review'],
      ['openai', 'gpt-5.4-nano'],
      ['openai', 'gpt-5.6-luna'],
      ['anthropic', 'claude-haiku-4-5'],
    ]);
    expect(JSON.stringify(DEDICATED_AUTO_REVIEW_CANDIDATES)).not.toMatch(
      /xai|deepseek|kimi|custom/i,
    );
  });

  it('continues across malformed JSON, HTTP errors, and empty responses', async () => {
    const log = logger();
    const calls: string[] = [];
    const requestCandidate = vi.fn(async (_prompt, candidate) => {
      calls.push(candidate.id);
      switch (candidate.id) {
        case 'cindy-gateway':
          return succeeded(candidate, 'not json');
        case 'chatgpt-nano':
          return failed(candidate, 'http_error', 400);
        case 'chatgpt-luna':
          return failed(candidate, 'empty_response');
        case 'claude-haiku':
          return succeeded(candidate, '{"verdict":"allow","reason":"Routine"}');
        default:
          throw new Error('Unexpected Auto-review candidate');
      }
    });
    const route = createAutoReviewModelRouter({ logger: log, requestCandidate });

    await expect(route('classify')).resolves.toBe(
      '{"verdict":"allow","reason":"Routine"}',
    );
    expect(calls).toEqual([
      'cindy-gateway',
      'chatgpt-nano',
      'chatgpt-luna',
      'chatgpt-luna',
      'claude-haiku',
    ]);
  });

  it('retries a quick transient provider failure in place', async () => {
    const candidate = DEDICATED_AUTO_REVIEW_CANDIDATES[0];
    const requestCandidate = vi.fn()
      .mockRejectedValueOnce(new Error('credential refresh failed with sensitive details'))
      .mockResolvedValueOnce(succeeded(candidate, '{"verdict":"block"}'));
    const route = createAutoReviewModelRouter({ logger: logger(), requestCandidate });

    await expect(route('classify')).resolves.toBe('{"verdict":"block"}');
    expect(requestCandidate).toHaveBeenCalledTimes(2);
    expect(requestCandidate.mock.calls.map((call) => call[1].id)).toEqual([
      'cindy-gateway',
      'cindy-gateway',
    ]);
  });

  it('moves to the next provider after a full candidate timeout instead of starving fallback', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const requestCandidate = vi.fn((_prompt, candidate) => {
      calls.push(candidate.id);
      if (candidate.id === 'cindy-gateway') {
        // Simulates credential refresh that ignores AbortSignal and never settles.
        return new Promise<UtilityTextResult>(() => undefined);
      }
      return Promise.resolve(succeeded(candidate, '{"verdict":"allow"}'));
    });
    const route = createAutoReviewModelRouter({ logger: logger(), requestCandidate });

    const pending = route('classify');
    await vi.advanceTimersByTimeAsync(12_000);

    await expect(pending).resolves.toBe('{"verdict":"allow"}');
    expect(calls).toEqual(['cindy-gateway', 'chatgpt-nano']);
  });

  it('aborts the in-flight request at the total deadline without starting another chain', async () => {
    vi.useFakeTimers();
    const observedSignals: AbortSignal[] = [];
    const repeatedCandidates = Array.from(
      { length: 8 },
      () => DEDICATED_AUTO_REVIEW_CANDIDATES[0],
    );
    const requestCandidate = vi.fn((_prompt, _candidate, opts) => {
      observedSignals.push(opts.signal as AbortSignal);
      return new Promise<UtilityTextResult>(() => undefined);
    });
    const route = createAutoReviewModelRouter({
      logger: logger(),
      candidates: repeatedCandidates,
      requestCandidate,
    });

    const pending = route('classify');
    await vi.advanceTimersByTimeAsync(AUTO_REVIEW_CHAIN_TIMEOUT_MS);

    await expect(pending).resolves.toBeNull();
    expect(requestCandidate).toHaveBeenCalledTimes(5);
    expect(observedSignals).toHaveLength(5);
    expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it('stops immediately when the owning reviewer aborts', async () => {
    const controller = new AbortController();
    const requestCandidate = vi.fn((_prompt, candidate, opts) =>
      new Promise<UtilityTextResult>((resolve) => {
        opts.signal?.addEventListener(
          'abort',
          () => resolve(failed(candidate, 'timeout')),
          { once: true },
        );
      }));
    const route = createAutoReviewModelRouter({ logger: logger(), requestCandidate });

    const pending = route('classify', controller.signal);
    controller.abort();

    await expect(pending).resolves.toBeNull();
    expect(requestCandidate).toHaveBeenCalledTimes(1);
  });
});
