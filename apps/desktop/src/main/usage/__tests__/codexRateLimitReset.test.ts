import type { AccountRateLimitsResponse } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';

import {
  CodexRateLimitResetRejectedError,
  createCodexRateLimitResetService,
} from '../codexRateLimitReset.js';

const NOW_MS = Date.UTC(2026, 6, 22, 12, 0, 0);
const KEY = '018f4ec7-c6d8-7f10-8d43-9f8791d33000';
const NEXT_KEY = '018f4ec7-c6d8-7f10-8d43-9f8791d33001';

function response(over: Partial<AccountRateLimitsResponse> = {}): AccountRateLimitsResponse {
  return {
    rateLimits: {
      planType: 'plus',
      primary: { usedPercent: 100, windowDurationMins: 300 },
    },
    rateLimitsByLimitId: null,
    rateLimitResetCredits: {
      availableCount: 2,
      credits: [
        {
          id: 'later',
          status: 'available',
          resetType: 'codexRateLimits',
          grantedAt: 20,
          expiresAt: 300,
          title: 'Later',
          description: null,
        },
        {
          id: 'earlier',
          status: 'available',
          resetType: 'codexRateLimits',
          grantedAt: 10,
          expiresAt: 200,
          title: 'Earlier',
          description: null,
        },
      ],
    },
    ...over,
  };
}

function harness(over: Partial<Parameters<typeof createCodexRateLimitResetService>[0]> = {}) {
  const deps = {
    readRateLimits: vi.fn().mockResolvedValue(response()),
    consumeResetCredit: vi.fn().mockResolvedValue({ outcome: 'reset' as const }),
    readAccountIdentity: vi.fn().mockResolvedValue({
      email: 'person@example.com',
      accountId: 'workspace-123456789',
    }),
    recordRateLimitSnapshot: vi.fn().mockResolvedValue(undefined),
    now: () => NOW_MS,
    createIdempotencyKey: vi.fn()
      .mockReturnValueOnce(KEY)
      .mockReturnValueOnce(NEXT_KEY),
    ...over,
  };
  return { deps, service: createCodexRateLimitResetService(deps) };
}

describe('Codex rate-limit reset control plane', () => {
  it('selects the earliest eligible credit without exposing its id to mobile', async () => {
    const { deps, service } = harness();
    const snapshot = await service.read();

    expect(snapshot.account).toEqual({
      email: 'pe***@example.com',
      accountId: '…456789',
      planType: 'plus',
    });
    expect(snapshot.rateLimits.primary).toEqual({
      usedPercent: 100,
      windowMinutes: 300,
      resetsAt: undefined,
    });
    expect(snapshot.resetOffer).toEqual({
      idempotencyKey: KEY,
      expiresAt: 200,
      validUntil: NOW_MS + 10 * 60 * 1000,
    });
    expect(snapshot.rateLimitResetCredits?.credits?.[0]).not.toHaveProperty('id');
    expect(deps.recordRateLimitSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      primary: expect.objectContaining({ windowMinutes: 300 }),
    }));

    await service.consume(KEY);
    expect(deps.consumeResetCredit).toHaveBeenCalledWith({
      idempotencyKey: KEY,
      creditId: 'earlier',
    });
  });

  function detailedHarness(over: Partial<Parameters<typeof createCodexRateLimitResetService>[0]> = {}) {
    const value = response();
    for (const credit of value.rateLimitResetCredits!.credits!) credit.expiresAt! += NOW_MS / 1000;
    let next = 0;
    return harness({
      readRateLimits: vi.fn().mockResolvedValue(value),
      createIdempotencyKey: () => `018f4ec7-c6d8-7f10-8d43-${String(next++).padStart(12, '0')}`,
      ...over,
    });
  }

  it('binds each displayed row to its own credit and keeps keys stable across reads', async () => {
    const { deps, service } = detailedHarness();
    const first = await service.read();
    const second = await service.read();
    const [later, earlier] = first.rateLimitResetCredits!.credits!;
    expect(earlier.resetOffer).toEqual(first.resetOffer);
    expect(later.resetOffer!.idempotencyKey).not.toBe(first.resetOffer!.idempotencyKey);
    expect(second.rateLimitResetCredits).toEqual(first.rateLimitResetCredits);
    expect(second.resetOffer).toEqual(first.resetOffer);
    expect(later).not.toHaveProperty('id');
    await service.consume(later.resetOffer!.idempotencyKey);
    expect(deps.consumeResetCredit).toHaveBeenCalledExactlyOnceWith({
      idempotencyKey: later.resetOffer!.idempotencyKey, creditId: 'later',
    });
  });

  it('joins retries of the selected row and blocks another row during the same attempt', async () => {
    let finish!: (result: { outcome: 'reset' }) => void;
    const consumeResetCredit = vi.fn(() => new Promise<{ outcome: 'reset' }>(resolve => { finish = resolve; }));
    const { service } = detailedHarness({ consumeResetCredit });
    const snapshot = await service.read();
    const key = snapshot.rateLimitResetCredits!.credits![0].resetOffer!.idempotencyKey;
    const first = service.consume(key);
    const retry = service.consume(key);
    await expect(service.consume(snapshot.resetOffer!.idempotencyKey)).rejects.toMatchObject({ reason: 'RESET_IN_PROGRESS' });
    await vi.waitFor(() => expect(consumeResetCredit).toHaveBeenCalledOnce());
    finish({ outcome: 'reset' });
    const [result, retryResult] = await Promise.all([first, retry]);
    expect(result).toEqual(retryResult);
    await expect(service.consume(key)).resolves.toEqual(result);
    expect(consumeResetCredit).toHaveBeenCalledOnce();
  });

  it('freezes an ambiguous selected-row attempt until that same key is retried', async () => {
    const consumeResetCredit = vi.fn().mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ outcome: 'alreadyRedeemed' });
    const { service } = detailedHarness({ consumeResetCredit });
    const snapshot = await service.read();
    const key = snapshot.rateLimitResetCredits!.credits![0].resetOffer!.idempotencyKey;
    await expect(service.consume(key)).rejects.toThrow('offline');
    const refreshed = await service.read();
    expect(refreshed.resetOffer!.idempotencyKey).toBe(key);
    await expect(service.consume(snapshot.resetOffer!.idempotencyKey)).rejects.toMatchObject({ reason: 'RESET_IN_PROGRESS' });
    await service.consume(key);
    expect(consumeResetCredit.mock.calls).toEqual([
      [{ idempotencyKey: key, creditId: 'later' }], [{ idempotencyKey: key, creditId: 'later' }],
    ]);
  });

  it('revokes withdrawn row offers and reuses the surviving row as the new default', async () => {
    const { deps, service } = detailedHarness();
    const snapshot = await service.read();
    const later = snapshot.rateLimitResetCredits!.credits![0].resetOffer!;
    const value: AccountRateLimitsResponse = await deps.readRateLimits();
    value.rateLimitResetCredits!.credits = value.rateLimitResetCredits!.credits!.filter(credit => credit.id === 'later');
    value.rateLimitResetCredits!.availableCount = 1;
    const refreshed = await service.read();
    expect(refreshed.resetOffer).toEqual(later);
    expect(refreshed.rateLimitResetCredits!.credits![0].resetOffer).toEqual(later);
    await expect(service.consume(snapshot.resetOffer!.idempotencyKey)).rejects.toMatchObject({ reason: 'OFFER_EXPIRED' });
    value.rateLimitResetCredits = { availableCount: 0, credits: [] };
    await service.read();
    await expect(service.consume(later.idempotencyKey)).rejects.toMatchObject({ reason: 'OFFER_EXPIRED' });
    expect(deps.consumeResetCredit).not.toHaveBeenCalled();
  });

  it('rejects a selected row after the account changes', async () => {
    const readAccountIdentity = vi.fn().mockResolvedValue({ email: 'person@example.com', accountId: 'workspace-123456789' });
    const { deps, service } = detailedHarness({ readAccountIdentity });
    const snapshot = await service.read();
    readAccountIdentity.mockResolvedValue({ email: 'other@example.com', accountId: 'other-workspace' });
    await expect(service.consume(snapshot.rateLimitResetCredits!.credits![0].resetOffer!.idempotencyKey))
      .rejects.toMatchObject({ reason: 'ACCOUNT_CHANGED' });
    expect(deps.consumeResetCredit).not.toHaveBeenCalled();
  });

  it('persists normalized account credits without exposing them to mobile', async () => {
    const { deps, service } = harness({
      readRateLimits: vi.fn().mockResolvedValue(response({
        rateLimits: {
          planType: 'plus',
          primary: { usedPercent: 42, windowDurationMins: 300 },
          credits: { hasCredits: false, unlimited: false, balance: null },
        },
      })),
    });

    const snapshot = await service.read();

    expect(snapshot.rateLimits).not.toHaveProperty('credits');
    expect(deps.recordRateLimitSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      primary: expect.objectContaining({ windowMinutes: 300 }),
      credits: { hasCredits: false, unlimited: false, balance: null },
    }));
  });

  it('reuses a count-only offer and lets app-server select the credit', async () => {
    const createIdempotencyKey = vi.fn()
      .mockReturnValueOnce(KEY)
      .mockReturnValueOnce(NEXT_KEY);
    const { deps, service } = harness({
      createIdempotencyKey,
      readRateLimits: vi.fn().mockResolvedValue(response({
        rateLimitResetCredits: { availableCount: 1, credits: null },
      })),
    });

    const first = await service.read();
    const second = await service.read();
    expect(first).toMatchObject({
      rateLimitResetCredits: { availableCount: 1, credits: null },
      resetOffer: {
        idempotencyKey: KEY,
        expiresAt: null,
        validUntil: NOW_MS + 10 * 60 * 1000,
      },
    });
    expect(second.resetOffer).toEqual(first.resetOffer);
    expect(createIdempotencyKey).toHaveBeenCalledOnce();

    await service.consume(KEY);
    expect(deps.consumeResetCredit).toHaveBeenCalledWith({ idempotencyKey: KEY });
  });

  it('replaces an unused offer when a fresh read selects a different credit', async () => {
    const replacement = {
      id: 'replacement',
      status: 'available' as const,
      resetType: 'codexRateLimits' as const,
      grantedAt: 30,
      expiresAt: 400,
      title: 'Replacement',
      description: null,
    };
    const readRateLimits = vi.fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValue(response({
        rateLimitResetCredits: { availableCount: 1, credits: [replacement] },
      }));
    const { deps, service } = harness({ readRateLimits });

    await expect(service.read()).resolves.toMatchObject({
      resetOffer: { idempotencyKey: KEY, expiresAt: 200 },
    });
    await expect(service.read()).resolves.toMatchObject({
      resetOffer: { idempotencyKey: NEXT_KEY, expiresAt: 400 },
    });
    await expect(service.consume(KEY)).rejects.toMatchObject({ reason: 'OFFER_EXPIRED' });
    await service.consume(NEXT_KEY);
    expect(deps.consumeResetCredit).toHaveBeenCalledWith({
      idempotencyKey: NEXT_KEY,
      creditId: 'replacement',
    });
  });

  it('coalesces concurrent consumes and caches the terminal result for retries', async () => {
    let resolveConsume!: (value: { outcome: 'reset' }) => void;
    const consumeResetCredit = vi.fn(() => new Promise<{ outcome: 'reset' }>((resolve) => {
      resolveConsume = resolve;
    }));
    const { service } = harness({ consumeResetCredit });
    await service.read();

    const first = service.consume(KEY);
    const second = service.consume(KEY);
    await vi.waitFor(() => expect(consumeResetCredit).toHaveBeenCalledOnce());
    resolveConsume({ outcome: 'reset' });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(consumeResetCredit).toHaveBeenCalledOnce();
    await expect(service.consume(KEY)).resolves.toEqual(firstResult);
    expect(consumeResetCredit).toHaveBeenCalledOnce();
  });

  it('issues a fresh offer for the next credit after a settled redemption', async () => {
    const readRateLimits = vi.fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response({
        rateLimitResetCredits: {
          availableCount: 1,
          credits: [{
            id: 'later',
            status: 'available',
            resetType: 'codexRateLimits',
            grantedAt: 20,
            expiresAt: 300,
            title: 'Later',
            description: null,
          }],
        },
      }))
      .mockResolvedValueOnce(response({
        rateLimitResetCredits: { availableCount: 0, credits: [] },
      }));
    const createIdempotencyKey = vi.fn()
      .mockReturnValueOnce(KEY)
      .mockReturnValueOnce(NEXT_KEY);
    const { deps, service } = harness({ readRateLimits, createIdempotencyKey });

    await service.read();
    const firstResult = await service.consume(KEY);
    expect(firstResult.rateLimits?.resetOffer).toEqual({
      idempotencyKey: NEXT_KEY,
      expiresAt: 300,
      validUntil: NOW_MS + 10 * 60 * 1000,
    });

    await service.consume(NEXT_KEY);
    expect(deps.consumeResetCredit).toHaveBeenNthCalledWith(1, {
      idempotencyKey: KEY,
      creditId: 'earlier',
    });
    expect(deps.consumeResetCredit).toHaveBeenNthCalledWith(2, {
      idempotencyKey: NEXT_KEY,
      creditId: 'later',
    });
  });

  it('does not evict an in-flight offer when the registry reaches its soft limit', async () => {
    let activeIdentity = { email: 'person-0@example.com', accountId: 'workspace-0' };
    let resolveConsume!: (value: { outcome: 'reset' }) => void;
    const consumeResetCredit = vi.fn(() => new Promise<{ outcome: 'reset' }>((resolve) => {
      resolveConsume = resolve;
    }));
    let keyIndex = 0;
    const { service } = harness({
      consumeResetCredit,
      createIdempotencyKey: () => `key-${keyIndex++}`,
      readAccountIdentity: vi.fn(async () => activeIdentity),
    });

    await service.read();
    const firstConsume = service.consume('key-0');
    await vi.waitFor(() => expect(consumeResetCredit).toHaveBeenCalledOnce());

    for (let index = 1; index <= 64; index += 1) {
      activeIdentity = {
        email: `person-${index}@example.com`,
        accountId: `workspace-${index}`,
      };
      await service.read();
    }

    const retry = service.consume('key-0');
    activeIdentity = { email: 'person-0@example.com', accountId: 'workspace-0' };
    resolveConsume({ outcome: 'reset' });
    const [firstResult, retryResult] = await Promise.all([firstConsume, retry]);
    expect(retryResult).toEqual(firstResult);
    expect(consumeResetCredit).toHaveBeenCalledOnce();
  });

  it('does not evict a cached terminal result before its retry TTL expires', async () => {
    let activeIdentity = { email: 'person-0@example.com', accountId: 'workspace-0' };
    let keyIndex = 0;
    const { deps, service } = harness({
      createIdempotencyKey: () => `key-${keyIndex++}`,
      readAccountIdentity: vi.fn(async () => activeIdentity),
    });

    await service.read();
    const firstResult = await service.consume('key-0');

    for (let index = 1; index <= 64; index += 1) {
      activeIdentity = {
        email: `person-${index}@example.com`,
        accountId: `workspace-${index}`,
      };
      await service.read();
    }

    activeIdentity = { email: 'person-0@example.com', accountId: 'workspace-0' };
    await expect(service.consume('key-0')).resolves.toEqual(firstResult);
    expect(deps.consumeResetCredit).toHaveBeenCalledOnce();
  });

  it('rejects a cached terminal result after the account changes', async () => {
    let identity = { email: 'person@example.com', accountId: 'workspace-a' };
    const { deps, service } = harness({
      readAccountIdentity: vi.fn(async () => identity),
    });
    await service.read();
    await service.consume(KEY);

    identity = { email: 'person@example.com', accountId: 'workspace-b' };
    await expect(service.consume(KEY)).rejects.toMatchObject({
      reason: 'ACCOUNT_CHANGED',
    });
    expect(deps.consumeResetCredit).toHaveBeenCalledOnce();
  });

  it('fails closed when either account or workspace identity changes', async () => {
    const readAccountIdentity = vi.fn()
      .mockResolvedValueOnce({ email: 'person@example.com', accountId: 'workspace-a' })
      .mockResolvedValueOnce({ email: 'person@example.com', accountId: 'workspace-a' })
      .mockResolvedValueOnce({ email: 'person@example.com', accountId: 'workspace-b' });
    const { deps, service } = harness({ readAccountIdentity });
    await service.read();

    await expect(service.consume(KEY)).rejects.toMatchObject({
      reason: 'ACCOUNT_CHANGED',
      message: expect.stringContaining('Codex account changed'),
    });
    expect(deps.consumeResetCredit).not.toHaveBeenCalled();
  });

  it('does not record or mint an offer when identity changes during a rate-limit read', async () => {
    const readAccountIdentity = vi.fn()
      .mockResolvedValueOnce({ email: 'person@example.com', accountId: 'workspace-a' })
      .mockResolvedValueOnce({ email: 'person@example.com', accountId: 'workspace-b' });
    const { deps, service } = harness({ readAccountIdentity });

    await expect(service.read()).rejects.toMatchObject({ reason: 'ACCOUNT_CHANGED' });
    expect(deps.recordRateLimitSnapshot).not.toHaveBeenCalled();
    expect(deps.createIdempotencyKey).not.toHaveBeenCalled();
  });

  it('invalidates a terminal offer when identity changes across consume', async () => {
    let identity = { email: 'person@example.com', accountId: 'workspace-a' };
    const consumeResetCredit = vi.fn(async () => {
      identity = { email: 'person@example.com', accountId: 'workspace-b' };
      return { outcome: 'reset' as const };
    });
    const { service } = harness({
      consumeResetCredit,
      readAccountIdentity: vi.fn(async () => identity),
    });
    await service.read();

    await expect(service.consume(KEY)).rejects.toMatchObject({ reason: 'ACCOUNT_CHANGED' });
    await expect(service.consume(KEY)).rejects.toMatchObject({ reason: 'OFFER_EXPIRED' });
    expect(consumeResetCredit).toHaveBeenCalledOnce();
  });

  it('does not issue an offer when returned credit details have no eligible row', async () => {
    const { service } = harness({
      readRateLimits: vi.fn().mockResolvedValue(response({
        rateLimitResetCredits: {
          availableCount: 1,
          credits: [{
            id: 'future-reset',
            status: 'available',
            resetType: 'unknown',
            grantedAt: 10,
            expiresAt: 200,
            title: 'Future reset',
            description: null,
          }],
        },
      })),
    });

    await expect(service.read()).resolves.toMatchObject({ resetOffer: null });
  });

  it('uses a typed rejection when the offer expires', async () => {
    const { service } = harness();

    await expect(service.consume(KEY)).rejects.toBeInstanceOf(CodexRateLimitResetRejectedError);
    await expect(service.consume(KEY)).rejects.toMatchObject({ reason: 'OFFER_EXPIRED' });
  });

  it('returns the authoritative outcome when the post-consume refresh fails', async () => {
    const readRateLimits = vi.fn()
      .mockResolvedValueOnce(response())
      .mockRejectedValueOnce(new Error('refresh offline'));
    const { deps, service } = harness({ readRateLimits });
    await service.read();

    await expect(service.consume(KEY)).resolves.toEqual({ outcome: 'reset', rateLimits: null });
    await expect(service.consume(KEY)).resolves.toEqual({ outcome: 'reset', rateLimits: null });
    expect(deps.consumeResetCredit).toHaveBeenCalledOnce();
  });

  it('reuses the same backend idempotency key after an ambiguous consume failure', async () => {
    const readRateLimits = vi.fn()
      .mockResolvedValueOnce(response())
      .mockResolvedValue(response({
        rateLimitResetCredits: { availableCount: 0, credits: [] },
      }));
    const consumeResetCredit = vi.fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ outcome: 'alreadyRedeemed' as const });
    const { service } = harness({ consumeResetCredit, readRateLimits });
    await service.read();

    await expect(service.consume(KEY)).rejects.toThrow('response lost');
    await expect(service.read()).resolves.toMatchObject({
      resetOffer: { idempotencyKey: KEY, expiresAt: 200 },
    });
    await expect(service.consume(KEY)).resolves.toMatchObject({ outcome: 'alreadyRedeemed' });
    expect(consumeResetCredit).toHaveBeenCalledTimes(2);
    expect(consumeResetCredit.mock.calls[0][0]).toEqual({
      idempotencyKey: KEY,
      creditId: 'earlier',
    });
    expect(consumeResetCredit.mock.calls[1][0]).toEqual({
      idempotencyKey: KEY,
      creditId: 'earlier',
    });
  });

  it('does not issue a consumable offer unless both email and workspace are known', async () => {
    const missingEmail = harness({
      readAccountIdentity: vi.fn().mockResolvedValue({ email: null, accountId: 'workspace-a' }),
    });
    const missingWorkspace = harness({
      readAccountIdentity: vi.fn().mockResolvedValue({ email: 'person@example.com', accountId: null }),
    });

    await expect(missingEmail.service.read()).resolves.toMatchObject({ resetOffer: null });
    await expect(missingWorkspace.service.read()).resolves.toMatchObject({ resetOffer: null });
    expect(missingEmail.deps.recordRateLimitSnapshot).toHaveBeenCalledOnce();
    expect(missingWorkspace.deps.recordRateLimitSnapshot).not.toHaveBeenCalled();
  });
});
