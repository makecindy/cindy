import type {
  AccountRateLimitResetCredit,
  AccountRateLimitsResponse,
  AccountRateLimitWindow,
} from '@cindy/maker-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RESET_CREDIT_EXPIRY_LEAD_MS,
  accountQuotaWindows,
  createCodexResetCreditAutoUse,
  expiringCreditSpendAt,
  isCodexUsageLimitSignal,
  nextExpiringCreditLookAt,
  quotaHeldUp,
  weeklyQuotaUsedUpUntil,
  type CodexResetCreditAutoUseDeps,
  type WeeklyResetRecord,
} from '../codexResetCreditAutoUse.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const sec = (ms: number) => Math.floor(ms / 1000);

function fiveHour(usedPercent: number, resetsInMs = 2 * HOUR): AccountRateLimitWindow {
  return { usedPercent, windowDurationMins: 300, resetsAt: sec(NOW + resetsInMs) };
}

function weekly(usedPercent: number, resetsInMs = 3 * DAY): AccountRateLimitWindow {
  return { usedPercent, windowDurationMins: 7 * 24 * 60, resetsAt: sec(NOW + resetsInMs) };
}

function credit(id: string, expiresInMs: number | null): AccountRateLimitResetCredit {
  return {
    id,
    resetType: 'codexRateLimits',
    status: 'available',
    grantedAt: sec(NOW - DAY),
    expiresAt: expiresInMs === null ? null : sec(NOW + expiresInMs),
    title: null,
    description: null,
  };
}

function limits(
  primary: AccountRateLimitWindow | null,
  secondary: AccountRateLimitWindow | null,
  credits: AccountRateLimitResetCredit[] | null = [credit('soon', 2 * DAY), credit('later', 5 * DAY)],
  availableCount = credits?.length ?? 1,
): AccountRateLimitsResponse {
  return {
    rateLimits: { primary, secondary },
    rateLimitsByLimitId: null,
    rateLimitResetCredits: { availableCount, credits },
  };
}

function harness(over: Partial<CodexResetCreditAutoUseDeps> = {}) {
  let now = NOW;
  const records = new Map<string, WeeklyResetRecord>();
  let response = limits(fiveHour(40), weekly(100));
  const deps = {
    enabledProviderIds: vi.fn(() => ['openai']),
    isEnabled: vi.fn(() => true),
    readAccountKey: vi.fn(async () => 'workspace-1'),
    readRateLimits: vi.fn(async () => response),
    consumeResetCredit: vi.fn(async () => ({ outcome: 'reset' as const })),
    afterReset: vi.fn(),
    readWeeklyReset: vi.fn((accountKey: string) => records.get(accountKey) ?? null),
    writeWeeklyReset: vi.fn((accountKey: string, record: WeeklyResetRecord) => {
      records.set(accountKey, record);
    }),
    clearWeeklyReset: vi.fn((accountKey: string, record: WeeklyResetRecord) => {
      if (records.get(accountKey) === record) records.delete(accountKey);
    }),
    scopeKey: vi.fn(() => 'owner-a'),
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    now: () => now,
    createIdempotencyKey: vi.fn(() => 'key-1'),
    ...over,
  };
  return {
    deps,
    records,
    service: createCodexResetCreditAutoUse(deps),
    setNow: (value: number) => {
      now = value;
    },
    setResponse: (value: AccountRateLimitsResponse) => {
      response = value;
    },
  };
}

describe('quota window policy', () => {
  it('normalizes app-server windows and finds a used-up weekly window', () => {
    const windows = accountQuotaWindows({ primary: fiveHour(100), secondary: weekly(100) });
    expect(windows).toEqual([
      { usedPercent: 100, windowMinutes: 300, resetsAtMs: sec(NOW + 2 * HOUR) * 1000 },
      { usedPercent: 100, windowMinutes: 10_080, resetsAtMs: sec(NOW + 3 * DAY) * 1000 },
    ]);
    expect(weeklyQuotaUsedUpUntil(windows, NOW)).toBe(sec(NOW + 3 * DAY) * 1000);
  });

  it('never treats a full five-hour window as the weekly quota', () => {
    const windows = accountQuotaWindows({ primary: fiveHour(100), secondary: weekly(80) });
    expect(weeklyQuotaUsedUpUntil(windows, NOW)).toBeNull();
  });

  it('reports when the last stopping window comes back, or null when one does not say', () => {
    expect(quotaHeldUp(accountQuotaWindows({ primary: fiveHour(50), secondary: weekly(50) })))
      .toEqual({ stopped: false, backAtMs: null });
    expect(quotaHeldUp(accountQuotaWindows({ primary: fiveHour(100), secondary: weekly(100) })))
      .toEqual({ stopped: true, backAtMs: sec(NOW + 3 * DAY) * 1000 });
    expect(quotaHeldUp(accountQuotaWindows({ primary: { usedPercent: 100, windowDurationMins: 300 } })))
      .toEqual({ stopped: true, backAtMs: null });
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
    // Back in two hours: the remaining quota is still usable before the reset is due.
    expect(expiringCreditSpendAt(until, NOW, { stopped: true, backAtMs: NOW + 2 * HOUR }))
      .toBe(until - RESET_CREDIT_EXPIRY_LEAD_MS);
    expect(expiringCreditSpendAt(until, NOW, { stopped: true, backAtMs: NOW + DAY })).toBe(NOW);
    expect(expiringCreditSpendAt(until, NOW, { stopped: true, backAtMs: null })).toBe(NOW);
  });

  it('looks several times inside the last hour before expiry', () => {
    const until = NOW + 10 * HOUR;
    expect(nextExpiringCreditLookAt(until, NOW)).toBe(NOW + 30 * MINUTE);
    expect(nextExpiringCreditLookAt(until, until - HOUR - 10 * MINUTE)).toBe(until - HOUR);
    expect(nextExpiringCreditLookAt(until, until - 40 * MINUTE)).toBe(until - 35 * MINUTE);
  });

  it('recognizes Codex usage-limit errors', () => {
    expect(isCodexUsageLimitSignal({ codexErrorInfo: 'usageLimitExceeded' })).toBe(true);
    expect(isCodexUsageLimitSignal({ message: "You've hit your usage limit. Try again later." }))
      .toBe(true);
    expect(isCodexUsageLimitSignal({ message: 'Too many requests' })).toBe(false);
    expect(isCodexUsageLimitSignal({ message: 'stream disconnected' })).toBe(false);
  });
});

describe('weekly limit', () => {
  it('spends the reset that expires first and remembers the week', async () => {
    const h = harness();
    await expect(h.service.spendForWeeklyLimit('openai')).resolves.toEqual({ kind: 'reset' });
    expect(h.deps.consumeResetCredit).toHaveBeenCalledWith('openai', {
      idempotencyKey: 'key-1',
      creditId: 'soon',
    });
    expect(h.deps.writeWeeklyReset).toHaveBeenCalledWith('workspace-1', {
      untilMs: sec(NOW + 3 * DAY) * 1000,
      atMs: NOW,
    });
    expect(h.deps.afterReset).toHaveBeenCalledWith('openai');
  });

  it('spends at most one reset per weekly window', async () => {
    const h = harness();
    await h.service.spendForWeeklyLimit('openai');
    h.setNow(NOW + DAY);
    await expect(h.service.spendForWeeklyLimit('openai')).resolves.toEqual({
      kind: 'skipped',
      why: 'already-used',
    });
    expect(h.service.mayUseForUsageLimit('openai')).toBe(false);
    expect(h.deps.consumeResetCredit).toHaveBeenCalledTimes(1);
  });

  it('lets a task interrupted right after another task spent the reset continue', async () => {
    const h = harness();
    await h.service.spendForWeeklyLimit('openai');
    h.setResponse(limits(fiveHour(0), weekly(0)));
    h.setNow(NOW + 2 * MINUTE);
    expect(h.service.mayUseForUsageLimit('openai')).toBe(true);
    await expect(h.service.spendForWeeklyLimit('openai')).resolves.toEqual({ kind: 'restored' });
    expect(h.deps.consumeResetCredit).toHaveBeenCalledTimes(1);
  });

  it('shares one spend between tasks hitting the limit at the same time', async () => {
    const h = harness();
    const [a, b] = await Promise.all([
      h.service.spendForWeeklyLimit('openai'),
      h.service.spendForWeeklyLimit('openai'),
    ]);
    expect(a).toEqual({ kind: 'reset' });
    expect(b).toEqual({ kind: 'reset' });
    expect(h.deps.consumeResetCredit).toHaveBeenCalledTimes(1);
  });

  it('does not spend for the five-hour window and backs off before reading again', async () => {
    const h = harness();
    h.setResponse(limits(fiveHour(100), weekly(70)));
    await expect(h.service.spendForWeeklyLimit('openai')).resolves.toEqual({
      kind: 'skipped',
      why: 'not-used-up',
    });
    expect(h.service.mayUseForUsageLimit('openai')).toBe(false);
    h.setNow(NOW + 2 * MINUTE);
    expect(h.service.mayUseForUsageLimit('openai')).toBe(true);
    expect(h.deps.consumeResetCredit).not.toHaveBeenCalled();
  });

  it('does nothing when disabled, signed out, or without resets', async () => {
    const disabled = harness({ isEnabled: vi.fn(() => false) });
    expect(disabled.service.mayUseForUsageLimit('openai')).toBe(false);
    await expect(disabled.service.spendForWeeklyLimit('openai')).resolves.toEqual({
      kind: 'skipped',
      why: 'disabled',
    });

    const signedOut = harness({ readAccountKey: vi.fn(async () => null) });
    await expect(signedOut.service.spendForWeeklyLimit('openai')).resolves.toEqual({
      kind: 'skipped',
      why: 'no-account',
    });
    expect(signedOut.service.mayUseForUsageLimit('openai')).toBe(false);

    const empty = harness();
    empty.setResponse(limits(fiveHour(40), weekly(100), [], 0));
    await expect(empty.service.spendForWeeklyLimit('openai')).resolves.toEqual({
      kind: 'skipped',
      why: 'no-credit',
    });
    for (const h of [disabled, signedOut, empty]) {
      expect(h.deps.consumeResetCredit).not.toHaveBeenCalled();
    }
  });

  it('does not let the backend pick a credit when the detail rows have no Codex reset', async () => {
    const h = harness();
    h.setResponse(limits(fiveHour(40), weekly(100), [{ ...credit('other', DAY), resetType: 'unknown' }], 1));
    await expect(h.service.spendForWeeklyLimit('openai')).resolves.toEqual({
      kind: 'skipped',
      why: 'no-credit',
    });
    expect(h.deps.consumeResetCredit).not.toHaveBeenCalled();
  });

  it('lets the backend choose when only the count is known', async () => {
    const h = harness();
    h.setResponse(limits(fiveHour(40), weekly(100), null, 1));
    await expect(h.service.spendForWeeklyLimit('openai')).resolves.toEqual({ kind: 'reset' });
    expect(h.deps.consumeResetCredit).toHaveBeenCalledWith('openai', { idempotencyKey: 'key-1' });
  });

  it('keeps the week open when the backend did not reset and backs off', async () => {
    const h = harness({ consumeResetCredit: vi.fn(async () => ({ outcome: 'noCredit' as const })) });
    await expect(h.service.spendForWeeklyLimit('openai')).resolves.toEqual({
      kind: 'failed',
      outcome: 'noCredit',
    });
    // Written ahead of the spend, withdrawn once the backend said nothing was spent.
    expect(h.deps.writeWeeklyReset).toHaveBeenCalledOnce();
    expect(h.records.size).toBe(0);
    await expect(h.service.spendForWeeklyLimit('openai')).resolves.toEqual({
      kind: 'skipped',
      why: 'backoff',
    });
  });

  it('reports a read failure without spending', async () => {
    const h = harness({ readRateLimits: vi.fn(async () => { throw new Error('app-server down'); }) });
    await expect(h.service.spendForWeeklyLimit('openai')).resolves.toEqual({
      kind: 'failed',
      error: 'app-server down',
    });
    expect(h.deps.consumeResetCredit).not.toHaveBeenCalled();
  });

  it('does not continue a task once the Cindy account changed mid-spend', async () => {
    let scope = 'owner-a';
    const h = harness({
      scopeKey: vi.fn(() => scope),
      consumeResetCredit: vi.fn(async () => {
        scope = 'owner-b';
        return { outcome: 'reset' as const };
      }),
    });
    const result = await h.service.spendForWeeklyLimit('openai');
    expect(result.kind).toBe('failed');
    expect(h.deps.afterReset).not.toHaveBeenCalled();
  });

  it('does not spend when the weekly record cannot be saved', async () => {
    const h = harness({
      writeWeeklyReset: vi.fn(() => {
        throw new Error('EACCES');
      }),
    });
    await expect(h.service.spendForWeeklyLimit('openai')).resolves.toEqual({
      kind: 'failed',
      error: 'EACCES',
    });
    expect(h.deps.consumeResetCredit).not.toHaveBeenCalled();
  });

  it('keeps the week closed when a spend request fails without an answer', async () => {
    const h = harness({
      consumeResetCredit: vi.fn(async () => {
        throw new Error('socket hang up');
      }),
    });
    await expect(h.service.spendForWeeklyLimit('openai')).resolves.toEqual({
      kind: 'failed',
      error: 'socket hang up',
    });
    h.setNow(NOW + HOUR);
    await expect(h.service.spendForWeeklyLimit('openai')).resolves.toEqual({
      kind: 'skipped',
      why: 'already-used',
    });
    expect(h.deps.consumeResetCredit).toHaveBeenCalledTimes(1);
  });

  it('does not spend when the account switched workspaces while quota was read', async () => {
    const h = harness();
    vi.mocked(h.deps.readAccountKey)
      .mockResolvedValueOnce('workspace-1')
      .mockResolvedValueOnce('workspace-2');
    await expect(h.service.spendForWeeklyLimit('openai')).resolves.toEqual({
      kind: 'skipped',
      why: 'account-changed',
    });
    expect(h.deps.consumeResetCredit).not.toHaveBeenCalled();
    expect(h.deps.writeWeeklyReset).not.toHaveBeenCalled();
  });

  it('does not spend when the setting was turned off while quota was read', async () => {
    let enabled = true;
    const h = harness({ isEnabled: vi.fn(() => enabled) });
    vi.mocked(h.deps.readRateLimits).mockImplementation(async () => {
      enabled = false;
      return limits(fiveHour(40), weekly(100));
    });
    await expect(h.service.spendForWeeklyLimit('openai')).resolves.toEqual({
      kind: 'skipped',
      why: 'disabled',
    });
    expect(h.deps.consumeResetCredit).not.toHaveBeenCalled();
  });

  it('counts one week per workspace even when two connections share it', async () => {
    const h = harness();
    const [first, second] = await Promise.all([
      h.service.spendForWeeklyLimit('openai'),
      h.service.spendForWeeklyLimit('chatgpt-work'),
    ]);
    expect(first).toEqual({ kind: 'reset' });
    expect(second.kind).not.toBe('reset');
    expect(h.deps.consumeResetCredit).toHaveBeenCalledTimes(1);
  });
});

describe('reset about to expire', () => {
  it('waits while the reset is far from expiring', async () => {
    const h = harness();
    h.setResponse(limits(fiveHour(40), weekly(60), [credit('soon', 5 * HOUR)]));
    await expect(h.service.checkExpiring('openai')).resolves.toEqual({ kind: 'idle' });
    expect(h.deps.consumeResetCredit).not.toHaveBeenCalled();
  });

  it('spends it in the last half hour, the one that expires first', async () => {
    const h = harness();
    h.setResponse(limits(fiveHour(40), weekly(60), [credit('later', DAY), credit('soon', 20 * MINUTE)]));
    await expect(h.service.checkExpiring('openai')).resolves.toEqual({ kind: 'reset' });
    expect(h.deps.consumeResetCredit).toHaveBeenCalledWith('openai', {
      idempotencyKey: 'key-1',
      creditId: 'soon',
    });
    // An expiring spend does not use up the weekly-limit allowance.
    expect(h.deps.writeWeeklyReset).not.toHaveBeenCalled();
  });

  it('spends it at once when the account is held up until after the spend time', async () => {
    const h = harness();
    h.setResponse(limits(fiveHour(40), weekly(100, 2 * DAY), [credit('soon', 6 * HOUR)]));
    await expect(h.service.checkExpiring('openai')).resolves.toEqual({ kind: 'reset' });
  });

  it('keeps waiting when a held-up account is free again before the spend time', async () => {
    const h = harness();
    h.setResponse(limits(fiveHour(100, HOUR), weekly(60), [credit('soon', 6 * HOUR)]));
    await expect(h.service.checkExpiring('openai')).resolves.toEqual({ kind: 'idle' });
    expect(h.deps.consumeResetCredit).not.toHaveBeenCalled();
  });

  it('re-checks the setting and the workspace right before spending', async () => {
    let enabled = true;
    const turnedOff = harness({ isEnabled: vi.fn(() => enabled) });
    turnedOff.setResponse(limits(fiveHour(40), weekly(60), [credit('soon', 20 * MINUTE)]));
    vi.mocked(turnedOff.deps.readRateLimits).mockImplementation(async () => {
      enabled = false;
      return limits(fiveHour(40), weekly(60), [credit('soon', 20 * MINUTE)]);
    });
    await expect(turnedOff.service.checkExpiring('openai')).resolves.toEqual({ kind: 'idle' });

    const switched = harness();
    switched.setResponse(limits(fiveHour(40), weekly(60), [credit('soon', 20 * MINUTE)]));
    vi.mocked(switched.deps.readAccountKey)
      .mockResolvedValueOnce('workspace-1')
      .mockResolvedValueOnce('workspace-2');
    await expect(switched.service.checkExpiring('openai')).resolves.toEqual({ kind: 'idle' });

    expect(turnedOff.deps.consumeResetCredit).not.toHaveBeenCalled();
    expect(switched.deps.consumeResetCredit).not.toHaveBeenCalled();
  });

  it('lets a reset expire when no window has been used', async () => {
    const h = harness();
    h.setResponse(limits(fiveHour(0), weekly(0), [credit('soon', 10 * MINUTE)]));
    await expect(h.service.checkExpiring('openai')).resolves.toEqual({ kind: 'idle' });
    expect(h.deps.consumeResetCredit).not.toHaveBeenCalled();
  });

  it('reads an account again only when its next look is due', async () => {
    const h = harness();
    h.setResponse(limits(fiveHour(40), weekly(60), [credit('soon', 10 * HOUR)]));
    await h.service.checkExpiring('openai');
    await h.service.checkExpiring('openai');
    expect(h.deps.readRateLimits).toHaveBeenCalledTimes(1);
    h.setNow(NOW + 30 * MINUTE);
    await h.service.checkExpiring('openai');
    expect(h.deps.readRateLimits).toHaveBeenCalledTimes(2);
  });

  it('reads accounts without an expiring reset rarely, and again after the setting changes', async () => {
    const h = harness();
    h.setResponse(limits(fiveHour(40), weekly(60), [credit('forever', null)]));
    await h.service.checkExpiring('openai');
    h.setNow(NOW + 5 * HOUR);
    await h.service.checkExpiring('openai');
    expect(h.deps.readRateLimits).toHaveBeenCalledTimes(1);
    h.service.noteSettingChanged('openai');
    await h.service.checkExpiring('openai');
    expect(h.deps.readRateLimits).toHaveBeenCalledTimes(2);
  });

  it('serializes an expiring spend with a weekly-limit spend on the same account', async () => {
    const h = harness();
    h.setResponse(limits(fiveHour(40), weekly(100, 2 * DAY), [credit('soon', 20 * MINUTE), credit('later', DAY)]));
    let release: () => void = () => undefined;
    let calls = 0;
    vi.mocked(h.deps.consumeResetCredit).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) await new Promise<void>((resolve) => { release = resolve; });
      // The first spend reset the windows.
      h.setResponse(limits(fiveHour(0), weekly(0), [credit('later', DAY)]));
      return { outcome: 'reset' as const };
    });
    const expiring = h.service.checkExpiring('openai');
    const weeklyLimit = h.service.spendForWeeklyLimit('openai');
    await vi.waitFor(() => expect(calls).toBe(1));
    release();
    await expect(expiring).resolves.toEqual({ kind: 'reset' });
    await expect(weeklyLimit).resolves.toEqual({ kind: 'skipped', why: 'not-used-up' });
    expect(calls).toBe(1);
  });
});

describe('background sweep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts three minutes after launch and repeats every five minutes until stopped', async () => {
    const h = harness({ now: () => Date.now() });
    h.setResponse(limits(fiveHour(40), weekly(60), [credit('soon', 40 * MINUTE)]));
    h.service.start();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(h.deps.readRateLimits).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(h.deps.readRateLimits).toHaveBeenCalledTimes(1);
    expect(h.deps.consumeResetCredit).not.toHaveBeenCalled();
    // 40 minutes left at the first look; due 10 minutes later.
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(h.deps.consumeResetCredit).toHaveBeenCalledTimes(1);
    h.service.stop();
    const reads = vi.mocked(h.deps.readRateLimits).mock.calls.length;
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(h.deps.readRateLimits).toHaveBeenCalledTimes(reads);
  });
});
