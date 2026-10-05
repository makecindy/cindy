import type {
  MobileCodexRateLimitResetResult,
  MobileCodexRateLimitsResult,
} from '@cindy/maker-shared/device-link-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_TIMER_DELAY_MS,
  RESET_CREDIT_EXPIRY_LEAD_MS,
  createCodexResetCreditAutoUse,
  expiringCreditSpendAt,
  isCodexUsageLimitSignal,
  planExpiringCredit,
  quotaBucketFor,
  quotaHeldUp,
  quotaWindows,
  weeklyQuotaUsedUp,
  type CodexResetCreditAutoUseDeps,
} from '../codexResetCreditAutoUse.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const sec = (ms: number) => Math.floor(ms / 1000);

type Window = { usedPercent: number; windowMinutes: number; resetsAt: number };
type Snapshot = MobileCodexRateLimitsResult['rateLimits'];

function fiveHour(usedPercent: number, resetsInMs = 2 * HOUR): Window {
  return { usedPercent, windowMinutes: 300, resetsAt: sec(NOW + resetsInMs) };
}

function weekly(usedPercent: number, resetsInMs = 3 * DAY): Window {
  return { usedPercent, windowMinutes: 7 * 24 * 60, resetsAt: sec(NOW + resetsInMs) };
}

function snapshot(
  primary: Window | null,
  secondary: Window | null,
  limitId = 'codex',
  limitName: string | null = null,
): Snapshot {
  return { limitId, limitName, primary, secondary, planType: 'plus', rateLimitReachedType: null };
}

function limits(
  primary: Window | null,
  secondary: Window | null,
  opts: {
    available?: number;
    /** Expiry of the reset the offer is bound to; null = it never expires. */
    offerExpiresInMs?: number | null;
    key?: string;
    byLimitId?: Record<string, Snapshot> | null;
  } = {},
): MobileCodexRateLimitsResult {
  const available = opts.available ?? 1;
  const offerExpiresInMs = opts.offerExpiresInMs === undefined ? 2 * DAY : opts.offerExpiresInMs;
  return {
    account: { email: 'pe***@example.com', accountId: '…456789', planType: 'plus' },
    rateLimits: snapshot(primary, secondary),
    rateLimitsByLimitId: opts.byLimitId ?? null,
    rateLimitResetCredits: { availableCount: available, credits: null },
    resetOffer:
      available > 0
        ? {
            idempotencyKey: opts.key ?? 'offer-1',
            expiresAt: offerExpiresInMs === null ? null : sec(NOW + offerExpiresInMs),
            validUntil: NOW + 10 * MINUTE,
          }
        : null,
  };
}

function harness(over: Partial<CodexResetCreditAutoUseDeps> = {}) {
  let now = NOW;
  let response = limits(fiveHour(40), weekly(100));
  let enabled = true;
  const readRateLimits = vi.fn<(providerId: string) => Promise<MobileCodexRateLimitsResult>>(
    async () => response,
  );
  const consumeReset = vi.fn<
    (providerId: string, key: string) => Promise<MobileCodexRateLimitResetResult>
  >(async () => ({
    outcome: 'reset',
    rateLimits: limits(fiveHour(0), weekly(0), { available: 0 }),
  }));
  const onAutoUsed = vi.fn();
  const deps = {
    enabledProviderIds: vi.fn(() => ['openai']),
    isEnabled: vi.fn(() => enabled),
    readRateLimits,
    consumeReset,
    onAutoUsed,
    scopeKey: vi.fn(() => 'owner-a'),
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    now: () => now,
    ...over,
  };
  return {
    deps,
    readRateLimits,
    consumeReset,
    onAutoUsed,
    service: createCodexResetCreditAutoUse(deps),
    setNow: (value: number) => {
      now = value;
    },
    setResponse: (value: MobileCodexRateLimitsResult) => {
      response = value;
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
  };
}

describe('quota policy', () => {
  it('reads windows and tells a used-up weekly window from a full five-hour one', () => {
    const both = quotaWindows(snapshot(fiveHour(100), weekly(100)));
    expect(weeklyQuotaUsedUp(both, NOW)).toBe(true);
    expect(quotaHeldUp(both)).toEqual({ stopped: true, backAtMs: sec(NOW + 3 * DAY) * 1000 });
    const shortOnly = quotaWindows(snapshot(fiveHour(100), weekly(80)));
    expect(weeklyQuotaUsedUp(shortOnly, NOW)).toBe(false);
    expect(quotaHeldUp(shortOnly).stopped).toBe(true);
    expect(quotaHeldUp(quotaWindows(snapshot(fiveHour(50), weekly(50))))).toEqual({
      stopped: false,
      backAtMs: null,
    });
  });

  it('judges a task by the bucket of its model, the general one otherwise', () => {
    const spark = snapshot(fiveHour(10), weekly(100), 'codex_bengalfox', 'GPT-5.3-Codex-Spark');
    const general = snapshot(fiveHour(10), weekly(20));
    const result = limits(null, null, { byLimitId: { codex: general, codex_bengalfox: spark } });
    expect(quotaBucketFor(result, 'gpt-5.3-codex-spark', NOW)).toBe(spark);
    expect(quotaBucketFor(result, 'gpt-5.5', NOW)).toBe(general);
    expect(quotaBucketFor(result, null, NOW)).toBe(general);
  });

  it('spends an expiring reset as late as is safe', () => {
    const until = NOW + 2 * HOUR;
    const free = { stopped: false, backAtMs: null };
    expect(expiringCreditSpendAt(until, NOW, free)).toBe(until - RESET_CREDIT_EXPIRY_LEAD_MS);
    expect(expiringCreditSpendAt(until, until - 10 * MINUTE, free)).toBe(until - 10 * MINUTE);
    expect(expiringCreditSpendAt(until, until, free)).toBeNull();
  });

  it('spends at once only when the account is held up past the spend time', () => {
    const until = NOW + 5 * HOUR;
    expect(expiringCreditSpendAt(until, NOW, { stopped: true, backAtMs: NOW + 2 * HOUR })).toBe(
      until - RESET_CREDIT_EXPIRY_LEAD_MS,
    );
    expect(expiringCreditSpendAt(until, NOW, { stopped: true, backAtMs: NOW + DAY })).toBe(NOW);
    expect(expiringCreditSpendAt(until, NOW, { stopped: true, backAtMs: null })).toBe(NOW);
  });

  it('plans from the offer the reset service picked, and lets an unused reset expire', () => {
    const expiresAtMs = sec(NOW + 5 * HOUR) * 1000;
    expect(planExpiringCredit(limits(fiveHour(40), weekly(60), { offerExpiresInMs: 5 * HOUR }), NOW)).toEqual({
      action: 'at',
      atMs: expiresAtMs - RESET_CREDIT_EXPIRY_LEAD_MS,
      expiresAtMs,
    });
    expect(
      planExpiringCredit(limits(fiveHour(40), weekly(60), { offerExpiresInMs: 20 * MINUTE }), NOW).action,
    ).toBe('spend-now');
    expect(
      planExpiringCredit(limits(fiveHour(0), weekly(0), { offerExpiresInMs: 20 * MINUTE }), NOW).action,
    ).toBe('none');
    expect(
      planExpiringCredit(limits(fiveHour(40), weekly(60), { offerExpiresInMs: null }), NOW).action,
    ).toBe('none');
    expect(planExpiringCredit(limits(fiveHour(40), weekly(60), { available: 0 }), NOW).action).toBe('none');
  });

  it('recognizes Codex usage-limit errors', () => {
    expect(isCodexUsageLimitSignal({ codexErrorInfo: 'usageLimitExceeded' })).toBe(true);
    expect(isCodexUsageLimitSignal({ message: "You've hit your usage limit. Try again later." })).toBe(true);
    expect(isCodexUsageLimitSignal({ message: 'Too many requests' })).toBe(false);
    expect(isCodexUsageLimitSignal({ message: 'stream disconnected' })).toBe(false);
  });
});

describe('usage limit', () => {
  it('spends the offered reset when the weekly window is used up, and says so first', async () => {
    const h = harness();
    const onSpending = vi.fn();
    await expect(h.service.resolveUsageLimit('openai', 'gpt-5.5', onSpending)).resolves.toEqual({
      kind: 'reset',
    });
    expect(onSpending).toHaveBeenCalledOnce();
    expect(h.consumeReset).toHaveBeenCalledWith('openai', 'offer-1');
    expect(h.onAutoUsed).toHaveBeenCalledWith('openai', { atMs: NOW, kind: 'usage-limit' });
  });

  it('continues without spending when the account is no longer held up', async () => {
    const h = harness();
    h.setResponse(limits(fiveHour(10), weekly(5)));
    const onSpending = vi.fn();
    await expect(h.service.resolveUsageLimit('openai', null, onSpending)).resolves.toEqual({
      kind: 'restored',
    });
    expect(onSpending).not.toHaveBeenCalled();
    expect(h.consumeReset).not.toHaveBeenCalled();
  });

  it('leaves a full five-hour window to recover on its own', async () => {
    const h = harness();
    h.setResponse(limits(fiveHour(100), weekly(70)));
    await expect(h.service.resolveUsageLimit('openai', null)).resolves.toEqual({
      kind: 'skipped',
      why: 'short-window',
    });
    expect(h.consumeReset).not.toHaveBeenCalled();
  });

  it('judges by the task model bucket rather than the general one', async () => {
    const h = harness();
    const spark = snapshot(fiveHour(10), weekly(100), 'codex_bengalfox', 'GPT-5.3-Codex-Spark');
    const general = snapshot(fiveHour(10), weekly(20));
    h.setResponse(limits(null, null, { byLimitId: { codex: general, codex_bengalfox: spark } }));
    await expect(h.service.resolveUsageLimit('openai', 'gpt-5.5')).resolves.toEqual({ kind: 'restored' });
    await expect(h.service.resolveUsageLimit('openai', 'gpt-5.3-codex-spark')).resolves.toEqual({
      kind: 'reset',
    });
  });

  it('gives the error back when no reset is available', async () => {
    const h = harness();
    h.setResponse(limits(fiveHour(40), weekly(100), { available: 0 }));
    await expect(h.service.resolveUsageLimit('openai', null)).resolves.toEqual({
      kind: 'skipped',
      why: 'no-credit',
    });
    expect(h.consumeReset).not.toHaveBeenCalled();
  });

  it('does not spend when the setting is off, or turned off while quota was read', async () => {
    const off = harness();
    off.setEnabled(false);
    expect(off.service.mayUseForUsageLimit('openai')).toBe(false);
    await expect(off.service.resolveUsageLimit('openai', null)).resolves.toEqual({
      kind: 'skipped',
      why: 'disabled',
    });

    const turnedOff = harness();
    turnedOff.readRateLimits.mockImplementationOnce(async () => {
      turnedOff.setEnabled(false);
      return limits(fiveHour(40), weekly(100));
    });
    await expect(turnedOff.service.resolveUsageLimit('openai', null)).resolves.toEqual({
      kind: 'skipped',
      why: 'disabled',
    });
    expect(off.consumeReset).not.toHaveBeenCalled();
    expect(turnedOff.consumeReset).not.toHaveBeenCalled();
  });

  it('shares one decision between tasks hitting the limit at the same time', async () => {
    const h = harness();
    const first = vi.fn();
    const second = vi.fn();
    const [a, b] = await Promise.all([
      h.service.resolveUsageLimit('openai', 'gpt-5.5', first),
      h.service.resolveUsageLimit('openai', 'gpt-5.5', second),
    ]);
    expect(a).toEqual({ kind: 'reset' });
    expect(b).toEqual({ kind: 'reset' });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(h.readRateLimits).toHaveBeenCalledTimes(1);
    expect(h.consumeReset).toHaveBeenCalledTimes(1);
  });

  it('continues a task that arrives after another task already spent the reset', async () => {
    const h = harness();
    await h.service.resolveUsageLimit('openai', null);
    h.setResponse(limits(fiveHour(0), weekly(0), { available: 0 }));
    await expect(h.service.resolveUsageLimit('openai', null)).resolves.toEqual({ kind: 'restored' });
    expect(h.consumeReset).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['nothingToReset', { kind: 'restored' }],
    ['noCredit', { kind: 'skipped', why: 'no-credit' }],
    ['alreadyRedeemed', { kind: 'failed', outcome: 'alreadyRedeemed' }],
  ] as const)('maps the reset service outcome %s', async (outcome, expected) => {
    const h = harness();
    h.consumeReset.mockResolvedValueOnce({ outcome, rateLimits: null });
    await expect(h.service.resolveUsageLimit('openai', null)).resolves.toEqual(expected);
    expect(h.onAutoUsed).not.toHaveBeenCalled();
  });

  it('still reports a reset when recording or notifying it fails', async () => {
    const h = harness({
      onAutoUsed: vi.fn(() => {
        throw new Error('notification unavailable');
      }),
    });
    await expect(h.service.resolveUsageLimit('openai', null)).resolves.toEqual({ kind: 'reset' });
  });

  it('reports a failed read or spend without claiming a reset', async () => {
    const read = harness();
    read.readRateLimits.mockRejectedValueOnce(new Error('ACCOUNT_CHANGED: retry'));
    await expect(read.service.resolveUsageLimit('openai', null)).resolves.toEqual({
      kind: 'failed',
      error: 'ACCOUNT_CHANGED: retry',
    });
    const spend = harness();
    spend.consumeReset.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(spend.service.resolveUsageLimit('openai', null)).resolves.toEqual({
      kind: 'failed',
      error: 'socket hang up',
    });
    expect(spend.onAutoUsed).not.toHaveBeenCalled();
  });
});

describe('reset about to expire', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function timed(over: Partial<CodexResetCreditAutoUseDeps> = {}) {
    return harness({ now: () => Date.now(), ...over });
  }

  it('schedules one timer at expiry minus the lead and spends only after a fresh read', async () => {
    const h = timed();
    const read = limits(fiveHour(40), weekly(60), { offerExpiresInMs: 3 * HOUR });
    h.setResponse(read);
    h.service.noteRateLimits('openai', read);
    await vi.advanceTimersByTimeAsync(3 * HOUR - RESET_CREDIT_EXPIRY_LEAD_MS - MINUTE);
    expect(h.readRateLimits).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(h.readRateLimits).toHaveBeenCalledOnce();
    expect(h.consumeReset).toHaveBeenCalledWith('openai', 'offer-1');
    expect(h.onAutoUsed).toHaveBeenCalledWith('openai', expect.objectContaining({ kind: 'expiring' }));
  });

  it('does not spend when the reset is gone by the time the timer fires', async () => {
    const h = timed();
    h.service.noteRateLimits('openai', limits(fiveHour(40), weekly(60), { offerExpiresInMs: HOUR }));
    h.setResponse(limits(fiveHour(40), weekly(60), { available: 0 }));
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(h.readRateLimits).toHaveBeenCalledOnce();
    expect(h.consumeReset).not.toHaveBeenCalled();
  });

  it('cancels the timer when a later read shows no reset, or the setting turns off', async () => {
    const h = timed();
    h.service.noteRateLimits('openai', limits(fiveHour(40), weekly(60), { offerExpiresInMs: HOUR }));
    h.service.noteRateLimits('openai', limits(fiveHour(40), weekly(60), { available: 0 }));
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(h.readRateLimits).not.toHaveBeenCalled();

    h.service.noteRateLimits('openai', limits(fiveHour(40), weekly(60), { offerExpiresInMs: 3 * HOUR }));
    h.setEnabled(false);
    h.service.noteSettingChanged('openai');
    await vi.advanceTimersByTimeAsync(4 * HOUR);
    expect(h.readRateLimits).not.toHaveBeenCalled();
    expect(h.consumeReset).not.toHaveBeenCalled();
  });

  it('spends at once when the account is held up past the spend time', async () => {
    const h = timed();
    const read = limits(fiveHour(40), weekly(100, 2 * DAY), { offerExpiresInMs: 6 * HOUR });
    h.setResponse(read);
    h.service.noteRateLimits('openai', read);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.consumeReset).toHaveBeenCalledOnce();
  });

  it('lets a reset expire when no window has been used', async () => {
    const h = timed();
    const read = limits(fiveHour(0), weekly(0), { offerExpiresInMs: 20 * MINUTE });
    h.setResponse(read);
    h.service.noteRateLimits('openai', read);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(h.consumeReset).not.toHaveBeenCalled();
  });

  it('re-checks the setting right before spending', async () => {
    const h = timed();
    h.service.noteRateLimits('openai', limits(fiveHour(40), weekly(60), { offerExpiresInMs: HOUR }));
    h.readRateLimits.mockImplementationOnce(async () => {
      h.setEnabled(false);
      return limits(fiveHour(40), weekly(60), { offerExpiresInMs: HOUR });
    });
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(h.readRateLimits).toHaveBeenCalledOnce();
    expect(h.consumeReset).not.toHaveBeenCalled();
  });

  it('schedules the next reset after spending one', async () => {
    const h = timed();
    const first = limits(fiveHour(40), weekly(60), { offerExpiresInMs: HOUR, key: 'offer-1' });
    h.setResponse(first);
    h.consumeReset.mockResolvedValueOnce({
      outcome: 'reset',
      rateLimits: limits(fiveHour(0), weekly(0), { offerExpiresInMs: 3 * DAY, key: 'offer-2' }),
    });
    h.service.noteRateLimits('openai', first);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(h.consumeReset).toHaveBeenCalledTimes(1);
    h.setResponse(limits(fiveHour(40), weekly(60), { offerExpiresInMs: 3 * DAY, key: 'offer-2' }));
    await vi.advanceTimersByTimeAsync(3 * DAY - HOUR - RESET_CREDIT_EXPIRY_LEAD_MS);
    expect(h.consumeReset).toHaveBeenLastCalledWith('openai', 'offer-2');
  });

  it('splits timers longer than setTimeout allows', async () => {
    const h = timed();
    const far = 40 * DAY;
    const read = limits(fiveHour(40), weekly(60), { offerExpiresInMs: far });
    h.setResponse(read);
    h.service.noteRateLimits('openai', read);
    await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS);
    expect(h.readRateLimits).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(sec(NOW + far) * 1000 - NOW - RESET_CREDIT_EXPIRY_LEAD_MS - MAX_TIMER_DELAY_MS);
    expect(h.consumeReset).toHaveBeenCalledOnce();
  });

  it('reschedules by the wall clock after waking from sleep', async () => {
    const expired = timed();
    const read = limits(fiveHour(40), weekly(60), { offerExpiresInMs: 3 * HOUR });
    expired.setResponse(read);
    expired.service.noteRateLimits('openai', read);
    // Asleep for four hours: the wall clock moved on, no timer fired, and the reset expired.
    vi.setSystemTime(NOW + 4 * HOUR);
    expired.service.reschedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(expired.consumeReset).not.toHaveBeenCalled();

    vi.setSystemTime(NOW);
    const due = timed();
    const soon = limits(fiveHour(40), weekly(60), { offerExpiresInMs: 4 * HOUR + 10 * MINUTE });
    due.setResponse(soon);
    due.service.noteRateLimits('openai', soon);
    vi.setSystemTime(NOW + 4 * HOUR);
    due.service.reschedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(due.consumeReset).toHaveBeenCalledOnce();
  });

  it('drops timers of another Cindy account', async () => {
    let scope = 'owner-a';
    const h = timed({ scopeKey: vi.fn(() => scope) });
    h.service.noteRateLimits('openai', limits(fiveHour(40), weekly(60), { offerExpiresInMs: HOUR }));
    scope = 'owner-b';
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(h.readRateLimits).not.toHaveBeenCalled();
    expect(h.consumeReset).not.toHaveBeenCalled();
  });

  it('reads each enabled account once shortly after launch and then stops reading', async () => {
    const h = timed();
    h.setResponse(limits(fiveHour(40), weekly(60), { offerExpiresInMs: 5 * DAY }));
    h.service.start();
    await vi.advanceTimersByTimeAsync(MINUTE - 1);
    expect(h.readRateLimits).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.readRateLimits).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(DAY);
    expect(h.readRateLimits).toHaveBeenCalledOnce();
    h.service.stop();
  });
});
