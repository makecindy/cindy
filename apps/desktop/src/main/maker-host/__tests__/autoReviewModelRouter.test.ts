import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAutoReviewDelegateHardCeilingMs } from '@cindy/maker-core';

import type { UtilityTextResult } from '../../../shared/utilityTextResult.js';
import { DEDICATED_AUTO_REVIEW_CANDIDATES, type AutoReviewAuxiliaryFallback } from '../../utility-model/oneShotCandidates.js';
import {
  AUTO_REVIEW_CANDIDATE_TIMEOUT_MS,
  AUTO_REVIEW_CHAIN_TIMEOUT_MS,
  AUTO_REVIEW_AUXILIARY_TIMEOUT_MS,
  AUTO_REVIEW_TOTAL_TIMEOUT_MS,
  AUTO_REVIEW_ROUTER_GUARD_TIMEOUT_MS,
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
  it('keeps both routing phases inside the host and core deadlines', () => {
    expect(AUTO_REVIEW_TOTAL_TIMEOUT_MS).toBe(AUTO_REVIEW_CHAIN_TIMEOUT_MS + AUTO_REVIEW_AUXILIARY_TIMEOUT_MS);
    expect(AUTO_REVIEW_ROUTER_GUARD_TIMEOUT_MS).toBeGreaterThan(AUTO_REVIEW_TOTAL_TIMEOUT_MS);
    expect(AUTO_REVIEW_ROUTER_GUARD_TIMEOUT_MS).toBeLessThan(getAutoReviewDelegateHardCeilingMs());
  });

  it('preserves dedicated review when reading auxiliary settings fails', async () => {
    const route = createAutoReviewModelRouter({
      logger: logger(),
      createAuxiliaryFallback: () => { throw new Error('settings unavailable'); },
      requestCandidate: async (_prompt, candidate) => succeeded(candidate, '{"verdict":"allow"}'),
    });
    await expect(route('classify')).resolves.toBe('{"verdict":"allow"}');
  });

  it('uses the captured custom fallback only after all dedicated candidates fail', async () => {
    const calls: string[] = [];
    const fallback = vi.fn(async (_prompt, opts) => {
      calls.push('custom');
      expect(opts.validateResponse('not json')).toBe(false);
      expect(opts.validateResponse('{"verdict":"ask"}')).toBe(true);
      return succeeded(DEDICATED_AUTO_REVIEW_CANDIDATES[0], '{"verdict":"allow"}');
    });
    const capture = vi.fn(() => {
      calls.push('capture');
      return fallback;
    });
    const route = createAutoReviewModelRouter({
      logger: logger(),
      createAuxiliaryFallback: capture,
      requestCandidate: async (_prompt, candidate) => {
        calls.push(candidate.id);
        return failed(candidate, 'http_error', 402);
      },
    });

    await expect(route('classify')).resolves.toBe('{"verdict":"allow"}');
    expect(calls).toEqual(['capture', 'cindy-gateway', 'chatgpt-auto-review', 'chatgpt-luna', 'custom']);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it.each(['allow', 'block', 'ask'])('stops on a valid dedicated %s decision', async (verdict) => {
    const fallback = vi.fn();
    const requestCandidate = vi.fn(async (_prompt, candidate) => succeeded(candidate, JSON.stringify({ verdict })));
    const route = createAutoReviewModelRouter({
      logger: logger(), requestCandidate, createAuxiliaryFallback: () => fallback,
    });

    await expect(route('classify')).resolves.toBe(JSON.stringify({ verdict }));
    expect(requestCandidate).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each(['malformed', 'throws', 'unavailable'])('returns unavailable when the custom fallback %s', async (failure) => {
    const route = createAutoReviewModelRouter({
      logger: logger(),
      requestCandidate: async (_prompt, candidate) => failed(candidate, 'http_error', 402),
      createAuxiliaryFallback: () => async () => {
        if (failure === 'throws') throw new Error('private credential detail');
        if (failure === 'unavailable') return { ok: false, reason: 'no_candidate', attempts: [] };
        return succeeded(DEDICATED_AUTO_REVIEW_CANDIDATES[0], 'not a decision');
      },
    });
    await expect(route('classify')).resolves.toBeNull();
  });

  it('reserves a full auxiliary budget after the dedicated phase exhausts its deadline', async () => {
    vi.useFakeTimers();
    const fallback = vi.fn<AutoReviewAuxiliaryFallback>(() => new Promise<UtilityTextResult>(() => undefined));
    const route = createAutoReviewModelRouter({
      logger: logger(),
      candidates: Array.from({ length: 8 }, () => DEDICATED_AUTO_REVIEW_CANDIDATES[0]),
      requestCandidate: () => new Promise<UtilityTextResult>(() => undefined),
      createAuxiliaryFallback: () => fallback,
    });
    const pending = route('classify');
    await vi.advanceTimersByTimeAsync(AUTO_REVIEW_CHAIN_TIMEOUT_MS);
    expect(fallback).toHaveBeenCalledTimes(1);
    const signal = fallback.mock.calls[0]![1].signal!;
    await vi.advanceTimersByTimeAsync(AUTO_REVIEW_AUXILIARY_TIMEOUT_MS - 1);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeNull();
    expect(signal.aborted).toBe(true);
  });

  it('cancels an auxiliary request even if it ignores its abort signal', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const fallbackStarted = new Promise<void>((resolve) => { started = resolve; });
    let signal!: AbortSignal;
    const route = createAutoReviewModelRouter({
      logger: logger(),
      requestCandidate: async (_prompt, candidate) => failed(candidate, 'http_error', 402),
      createAuxiliaryFallback: () => async (_prompt, opts) => {
        signal = opts.signal!;
        started();
        return new Promise<UtilityTextResult>(() => undefined);
      },
    });
    const pending = route('classify', controller.signal);
    await fallbackStarted;
    controller.abort();
    await expect(pending).resolves.toBeNull();
    expect(signal.aborted).toBe(true);
  });

  it('budgets exactly one full timeout per candidate plus a small margin', () => {
    expect(AUTO_REVIEW_CHAIN_TIMEOUT_MS).toBe(
      DEDICATED_AUTO_REVIEW_CANDIDATES.length * AUTO_REVIEW_CANDIDATE_TIMEOUT_MS + 4_000,
    );
  });

  it('contains only the managed Gateway and supported subscription models in fixed order', () => {
    expect(DEDICATED_AUTO_REVIEW_CANDIDATES.map((candidate) => [
      candidate.providerId,
      candidate.model,
    ])).toEqual([
      ['xd', 'cindy/auto-review'],
      ['openai', 'codex-auto-review'],
      ['openai', 'gpt-6-luna'],
    ]);
    // Claude 订阅只供内置 Claude Code CLI 使用,不作为 Cindy 直连审阅的候选。
    expect(JSON.stringify(DEDICATED_AUTO_REVIEW_CANDIDATES)).not.toMatch(
      /xai|deepseek|kimi|custom|anthropic|claude/i,
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
        case 'chatgpt-auto-review':
          return failed(candidate, 'http_error', 400);
        case 'chatgpt-luna':
          // 首次空响应在原位重试一次,重试成功即收口。
          return calls.filter((id) => id === 'chatgpt-luna').length === 1
            ? failed(candidate, 'empty_response')
            : succeeded(candidate, '{"verdict":"allow","reason":"Routine"}');
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
      'chatgpt-auto-review',
      'chatgpt-luna',
      'chatgpt-luna',
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
    expect(calls).toEqual(['cindy-gateway', 'chatgpt-auto-review']);
  });

  it('retries a timed-out gateway after unavailable fallbacks skip instantly', async () => {
    vi.useFakeTimers();
    const log = logger();
    const calls: string[] = [];
    const requestCandidate = vi.fn((_prompt, candidate) => {
      calls.push(candidate.id);
      if (candidate.id === 'cindy-gateway') {
        return calls.length === 1
          ? new Promise<UtilityTextResult>(() => undefined)
          : Promise.resolve(succeeded(candidate, '{"verdict":"allow"}'));
      }
      // 本机没有可用 OpenAI 凭证:立即返回,不占预算。
      return Promise.resolve<UtilityTextResult>({ ok: false, reason: 'no_candidate', attempts: [] });
    });
    const route = createAutoReviewModelRouter({ logger: log, requestCandidate });

    const pending = route('classify');
    await vi.advanceTimersByTimeAsync(AUTO_REVIEW_CANDIDATE_TIMEOUT_MS);

    await expect(pending).resolves.toBe('{"verdict":"allow"}');
    expect(calls).toEqual(['cindy-gateway', 'chatgpt-auto-review', 'chatgpt-luna', 'cindy-gateway']);
    expect(log.warn).toHaveBeenCalledWith('auto-review model candidate failed', expect.objectContaining({
      candidateId: 'cindy-gateway',
      reason: 'timeout',
      retrying: 'deferred',
    }));
  });

  it('keeps an earlier deferred gateway retry ahead of a later fallback retry', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const requestCandidate = vi.fn((_prompt, candidate) => {
      calls.push(candidate.id);
      if (candidate.id === 'chatgpt-auto-review') {
        return Promise.resolve<UtilityTextResult>({ ok: false, reason: 'no_candidate', attempts: [] });
      }
      if (candidate.id === 'cindy-gateway' && calls.length > 1) {
        return Promise.resolve(succeeded(candidate, '{"verdict":"allow"}'));
      }
      // 首次网关与 luna 都耗满超时。
      return new Promise<UtilityTextResult>(() => undefined);
    });
    const route = createAutoReviewModelRouter({ logger: logger(), requestCandidate });

    const pending = route('classify');
    await vi.advanceTimersByTimeAsync(AUTO_REVIEW_CANDIDATE_TIMEOUT_MS * 2);

    await expect(pending).resolves.toBe('{"verdict":"allow"}');
    // luna 不得原位重试插到已排队的网关重试前面。
    expect(calls).toEqual(['cindy-gateway', 'chatgpt-auto-review', 'chatgpt-luna', 'cindy-gateway']);
  });

  it('does not retry a timed-out candidate without a full timeout left', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const requestCandidate = vi.fn((_prompt, candidate) => {
      calls.push(candidate.id);
      return new Promise<UtilityTextResult>(() => undefined);
    });
    const log = logger();
    const route = createAutoReviewModelRouter({ logger: log, requestCandidate });

    const pending = route('classify');
    await vi.advanceTimersByTimeAsync(AUTO_REVIEW_CHAIN_TIMEOUT_MS);

    await expect(pending).resolves.toBeNull();
    expect(calls).toEqual(['cindy-gateway', 'chatgpt-auto-review', 'chatgpt-luna']);
    // 已排队的延后重试因预算不足被跳过时要留下记录,不能只剩一条 deferred。
    const skipped = log.warn.mock.calls
      .filter(([message]) => message === 'auto-review model candidate retry skipped')
      .map(([, fields]) => fields.candidateId);
    expect(skipped).toEqual(['cindy-gateway', 'chatgpt-auto-review', 'chatgpt-luna']);
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
    const attempts = Math.ceil(AUTO_REVIEW_CHAIN_TIMEOUT_MS / AUTO_REVIEW_CANDIDATE_TIMEOUT_MS);
    expect(requestCandidate).toHaveBeenCalledTimes(attempts);
    expect(observedSignals).toHaveLength(attempts);
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
