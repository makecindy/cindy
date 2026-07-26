import type { Maker } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';
import { registerMakerAuthHandlers } from '../authHandlers';
import { MAKER_INVOKE, MAKER_PUSH } from '../channels';
import { registerMakerStatusHandlers } from '../statusHandlers';
import { registerMakerUsageHandlers } from '../usageHandlers';
import { CodexRateLimitResetRejectedError } from '../../usage/codexRateLimitReset';
import { IpcHarness } from './helpers/ipcHarness';
import { zeroUsageMoney } from '../../../shared/regionalMoney';

function createMakerStub(methods: Partial<Maker>): Maker {
  return methods as Maker;
}

describe('maker auth IPC handlers', () => {
  it('delegates auth state lookup to Maker', async () => {
    const harness = new IpcHarness();
    const getAgentAuthState = vi.fn().mockResolvedValue({ authenticated: true });

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ getAgentAuthState }),
      vi.fn(),
      () => null,
    );

    await expect(harness.invoke(MAKER_INVOKE.AUTH_GET_STATE, 'codex')).resolves.toEqual({
      authenticated: true,
    });
    expect(getAgentAuthState).toHaveBeenCalledWith('codex');
  });

  it('normalizes login progress and broadcasts final auth state', async () => {
    const harness = new IpcHarness();
    const broadcast = vi.fn();
    const onCodexAuthChange = vi.fn().mockResolvedValue(undefined);
    const refreshAgentLocalModels = vi.fn().mockResolvedValue(true);
    const triggerAgentLogin = vi
      .fn()
      .mockImplementation(async (_agentKind, options: { onProgress: (msg: string) => void }) => {
        options.onProgress('stdout:https://example.test/oauth');
        options.onProgress('stderr:waiting');
        options.onProgress('done');
        return {
          authenticated: true,
          authSource: 'oauth',
          identity: { email: 'dev@example.test' },
        };
      });

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ triggerAgentLogin, refreshAgentLocalModels }),
      broadcast,
      () => null,
      onCodexAuthChange,
    );

    await expect(harness.invoke(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex')).resolves.toEqual({
      authenticated: true,
      authSource: 'oauth',
      identity: { email: 'dev@example.test' },
    });
    expect(onCodexAuthChange).toHaveBeenCalledOnce();
    expect(refreshAgentLocalModels).toHaveBeenCalledWith('codex');
    expect(onCodexAuthChange).toHaveBeenCalledWith(true, true, expect.any(Function));
    expect(broadcast).toHaveBeenNthCalledWith(1, MAKER_PUSH.AUTH_LOGIN_PROGRESS, {
      agentKind: 'codex',
      phase: 'login-pending',
      detail: 'https://example.test/oauth',
    });
    expect(broadcast).toHaveBeenNthCalledWith(2, MAKER_PUSH.AUTH_LOGIN_PROGRESS, {
      agentKind: 'codex',
      phase: 'login-pending',
      detail: 'waiting',
    });
    expect(broadcast).toHaveBeenNthCalledWith(3, MAKER_PUSH.AUTH_LOGIN_PROGRESS, {
      agentKind: 'codex',
      phase: 'done',
    });
    expect(broadcast).toHaveBeenNthCalledWith(4, MAKER_PUSH.AUTH_STATE_CHANGED, {
      agentKind: 'codex',
      authenticated: true,
      authSource: 'oauth',
      identity: { email: 'dev@example.test' },
    });
  });

  it('keeps login successful and requests disk fallback when live model refresh fails', async () => {
    const harness = new IpcHarness();
    const onCodexAuthChange = vi.fn().mockResolvedValue(undefined);
    const triggerAgentLogin = vi.fn().mockResolvedValue({ authenticated: true, authSource: 'oauth' });
    const refreshAgentLocalModels = vi.fn().mockRejectedValue(new Error('model/list unavailable'));

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ triggerAgentLogin, refreshAgentLocalModels }),
      vi.fn(),
      () => null,
      onCodexAuthChange,
    );

    await expect(harness.invoke(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex')).resolves.toMatchObject({
      authenticated: true,
    });
    expect(onCodexAuthChange).toHaveBeenCalledWith(true, false, expect.any(Function));
  });

  it('drops a stale login refresh when a concurrent logout establishes a newer auth boundary', async () => {
    const harness = new IpcHarness();
    const broadcast = vi.fn();
    let resolveRefresh!: (value: boolean) => void;
    const refreshAgentLocalModels = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveRefresh = resolve;
    }));
    const onCodexAuthChange = vi.fn().mockResolvedValue(undefined);
    const triggerAgentLogin = vi.fn().mockResolvedValue({ authenticated: true, authSource: 'oauth' });
    const logoutAgent = vi.fn().mockResolvedValue(undefined);

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ triggerAgentLogin, refreshAgentLocalModels, logoutAgent }),
      broadcast,
      () => null,
      onCodexAuthChange,
    );

    const login = harness.invoke(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex');
    await vi.waitFor(() => expect(refreshAgentLocalModels).toHaveBeenCalledOnce());
    await expect(harness.invoke(MAKER_INVOKE.AUTH_LOGOUT, 'codex')).resolves.toBeUndefined();
    resolveRefresh(true);

    await expect(login).resolves.toEqual({
      authenticated: false,
      errorReason: 'auth_mutation_superseded',
    });
    expect(onCodexAuthChange).toHaveBeenCalledTimes(1);
    expect(onCodexAuthChange).toHaveBeenCalledWith(false, false, expect.any(Function));
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.AUTH_STATE_CHANGED, {
      agentKind: 'codex',
      authenticated: false,
    });
  });

  it('does not refresh Codex models when login fails', async () => {
    const harness = new IpcHarness();
    const broadcast = vi.fn();
    const onCodexAuthChange = vi.fn();
    const triggerAgentLogin = vi.fn().mockResolvedValue({
      authenticated: false,
      errorReason: 'login_cancelled',
    });

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ triggerAgentLogin }),
      broadcast,
      () => null,
      onCodexAuthChange,
    );

    await expect(harness.invoke(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex')).resolves.toEqual({
      authenticated: false,
      errorReason: 'login_cancelled',
    });
    expect(onCodexAuthChange).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.AUTH_STATE_CHANGED, {
      agentKind: 'codex',
      authenticated: false,
      errorReason: 'login_cancelled',
    });
  });

  it('does not refresh Codex models for an authenticated gateway fallback', async () => {
    const harness = new IpcHarness();
    const onCodexAuthChange = vi.fn();
    const triggerAgentLogin = vi.fn().mockResolvedValue({
      authenticated: true,
      authSource: 'api-key',
      identity: 'API Key · Cindy AI',
    });

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ triggerAgentLogin }),
      vi.fn(),
      () => 'sk-gateway',
      onCodexAuthChange,
    );

    await harness.invoke(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, 'codex');
    expect(onCodexAuthChange).not.toHaveBeenCalled();
  });

  it('broadcasts logged-out state after logout', async () => {
    const harness = new IpcHarness();
    const broadcast = vi.fn();
    const logoutAgent = vi.fn().mockResolvedValue(undefined);

    registerMakerAuthHandlers(harness, createMakerStub({ logoutAgent }), broadcast, () => null);

    await expect(harness.invoke(MAKER_INVOKE.AUTH_LOGOUT, 'claude-code')).resolves.toBeUndefined();
    expect(logoutAgent).toHaveBeenCalledWith('claude-code');
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.AUTH_STATE_CHANGED, {
      agentKind: 'claude-code',
      authenticated: false,
    });
  });

  it('finalizes Codex auth changes before broadcasting logged-out state', async () => {
    const harness = new IpcHarness();
    const calls: string[] = [];
    const logoutAgent = vi.fn().mockImplementation(async () => {
      calls.push('logout');
    });
    const onCodexAuthChange = vi.fn().mockImplementation(async () => {
      calls.push('finalize');
    });
    const broadcast = vi.fn().mockImplementation(() => {
      calls.push('broadcast');
    });

    registerMakerAuthHandlers(
      harness,
      createMakerStub({ logoutAgent }),
      broadcast,
      () => null,
      onCodexAuthChange,
    );

    await expect(harness.invoke(MAKER_INVOKE.AUTH_LOGOUT, 'codex')).resolves.toBeUndefined();
    expect(calls).toEqual(['logout', 'finalize', 'broadcast']);
    expect(onCodexAuthChange).toHaveBeenCalledWith(false, false, expect.any(Function));
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.AUTH_STATE_CHANGED, {
      agentKind: 'codex',
      authenticated: false,
    });
  });

  it('encodes logout persistence failures as an IPC INTERNAL error without broadcasting success', async () => {
    const harness = new IpcHarness();
    const broadcast = vi.fn();
    const logoutAgent = vi.fn().mockRejectedValue(new Error('disconnect marker write failed'));
    registerMakerAuthHandlers(harness, createMakerStub({ logoutAgent }), broadcast, () => null);

    await expect(harness.invoke(MAKER_INVOKE.AUTH_LOGOUT, 'codex')).rejects.toMatchObject({
      code: 'INTERNAL',
    });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('rejects missing agentKind with IPC error code', async () => {
    const harness = new IpcHarness();
    registerMakerAuthHandlers(harness, createMakerStub({}), vi.fn(), () => null);

    await expect(harness.invoke(MAKER_INVOKE.AUTH_GET_STATE)).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });

  it.each([
    MAKER_INVOKE.AUTH_GET_STATE,
    MAKER_INVOKE.AUTH_TRIGGER_LOGIN,
    MAKER_INVOKE.AUTH_CANCEL_LOGIN,
    MAKER_INVOKE.AUTH_LOGOUT,
  ])('rejects an unknown agentKind for %s before calling Maker', async (channel) => {
    const harness = new IpcHarness();
    const getAgentAuthState = vi.fn();
    const triggerAgentLogin = vi.fn();
    const cancelAgentLogin = vi.fn();
    const logoutAgent = vi.fn();
    registerMakerAuthHandlers(
      harness,
      createMakerStub({
        getAgentAuthState,
        triggerAgentLogin,
        cancelAgentLogin,
        logoutAgent,
      }),
      vi.fn(),
      () => null,
    );

    await expect(harness.invoke(channel, 'not-an-agent')).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    expect(getAgentAuthState).not.toHaveBeenCalled();
    expect(triggerAgentLogin).not.toHaveBeenCalled();
    expect(cancelAgentLogin).not.toHaveBeenCalled();
    expect(logoutAgent).not.toHaveBeenCalled();
  });

  it('reports api key presence without exposing the key material', async () => {
    const harness = new IpcHarness();
    registerMakerAuthHandlers(harness, createMakerStub({}), vi.fn(), () => 'sk-secret');

    await expect(harness.invoke(MAKER_INVOKE.API_KEY_PRESENT)).resolves.toEqual({ present: true });

    const absent = new IpcHarness();
    registerMakerAuthHandlers(absent, createMakerStub({}), vi.fn(), () => null);
    await expect(absent.invoke(MAKER_INVOKE.API_KEY_PRESENT)).resolves.toEqual({ present: false });
  });
});

describe('maker status IPC handlers', () => {
  it('delegates agent status lookup to Maker', async () => {
    const harness = new IpcHarness();
    const getAgentStatus = vi.fn().mockResolvedValue({ binaryReady: true, authReady: false });

    registerMakerStatusHandlers(harness, createMakerStub({ getAgentStatus }));

    await expect(harness.invoke(MAKER_INVOKE.AGENT_STATUS, 'codex')).resolves.toEqual({
      binaryReady: true,
      authReady: false,
    });
    expect(getAgentStatus).toHaveBeenCalledWith('codex');
  });
});

describe('maker usage IPC handlers', () => {
  const emptyHistory = {
    generatedAt: 0,
    todayKey: '2026-06-11',
    estimatesPending: false,
    days: [],
    modelDaily: [],
    models: [],
    streak: { current: 0, longest: 0 },
    totals: {
      today: zeroUsageMoney(),
      last30Days: zeroUsageMoney(),
      last30DaysWithEstimatedValue: zeroUsageMoney(),
      last30DaysEstimatedValue: zeroUsageMoney('value-estimate'),
      todayTokens: 0,
      last30DaysTokens: 0,
    },
    anomaly: { isAnomalous: false, trailing7DayAvg: null },
  };

  function makeUsageDeps(over: Record<string, unknown> = {}) {
    return {
      readAgentTodayUsage: vi.fn(),
      readCodexAccountUsageSnapshot: vi.fn(),
      readCodexRateLimits: vi.fn(),
      consumeCodexRateLimitReset: vi.fn(),
      readClaudeSubscriptionUsageSnapshot: vi.fn().mockResolvedValue(null),
      readClaudeAccountUsageSnapshot: vi.fn(),
      triggerClaudeAccountUsageRefresh: vi.fn(),
      readModelPricing: vi.fn(),
      readUsageHistory: vi.fn().mockResolvedValue(emptyHistory),
      emptyUsageHistory: vi.fn(() => emptyHistory),
      ...over,
    };
  }

  it('reads today usage through injected host dependency', async () => {
    const harness = new IpcHarness();
    const readAgentTodayUsage = vi.fn().mockResolvedValue({ day: '2026-06-10', totalTokens: 42 });

    registerMakerUsageHandlers(harness, makeUsageDeps({ readAgentTodayUsage }));

    await expect(harness.invoke(MAKER_INVOKE.USAGE_TODAY, 'codex')).resolves.toEqual({
      day: '2026-06-10',
      totalTokens: 42,
    });
    expect(readAgentTodayUsage).toHaveBeenCalledWith('codex');
  });

  it('warm-starts Claude account usage refresh when snapshot is empty', async () => {
    const harness = new IpcHarness();
    const triggerClaudeAccountUsageRefresh = vi.fn().mockResolvedValue(undefined);

    registerMakerUsageHandlers(
      harness,
      makeUsageDeps({
        readClaudeAccountUsageSnapshot: vi.fn(() => null),
        triggerClaudeAccountUsageRefresh,
      }),
    );

    await expect(harness.invoke(MAKER_INVOKE.USAGE_ACCOUNT, 'claude-code')).resolves.toBeNull();
    expect(triggerClaudeAccountUsageRefresh).toHaveBeenCalledWith(true);
  });

  it('keeps the legacy device-link pricing channel flat and USD-only', async () => {
    const harness = new IpcHarness();
    const pricing = {
      xd: {
        'claude-sonnet-4-6': {
          providerId: 'xd',
          modelId: 'claude-sonnet-4-6',
          currency: 'USD',
          source: 'gateway',
          approximate: false,
          inputPerMtok: 3,
          outputPerMtok: 15,
          cacheReadPerMtok: 0.3,
        },
        'claude-opus-4-6': {
          providerId: 'xd',
          modelId: 'claude-opus-4-6',
          currency: 'CNY',
          source: 'gateway',
          approximate: false,
          inputPerMtok: 5,
          outputPerMtok: 25,
        },
      },
    };
    const readModelPricing = vi.fn().mockResolvedValue(pricing);

    registerMakerUsageHandlers(harness, makeUsageDeps({ readModelPricing }));

    await expect(harness.invoke(MAKER_INVOKE.USAGE_MODEL_PRICING)).resolves.toEqual({
      'claude-sonnet-4-6': {
        inputUsdPerMtok: 3,
        outputUsdPerMtok: 15,
        cacheReadUsdPerMtok: 0.3,
      },
    });
    await expect(harness.invoke(MAKER_INVOKE.USAGE_MODEL_PRICING_V2)).resolves.toEqual(pricing);
    expect(readModelPricing).toHaveBeenCalledTimes(2);
  });

  it('reads Codex reset credits and consumes only a UUID offer key', async () => {
    const harness = new IpcHarness();
    const snapshot = {
      account: { email: 'pe***@example.com', accountId: '…456789', planType: 'plus' },
      rateLimits: { planType: 'plus', primary: { usedPercent: 100 } },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: { availableCount: 1, credits: null },
      resetOffer: {
        idempotencyKey: '018f4ec7-c6d8-7f10-8d43-9f8791d33000',
        expiresAt: null,
        validUntil: 123,
      },
    };
    const readCodexRateLimits = vi.fn().mockResolvedValue(snapshot);
    const consumeCodexRateLimitReset = vi.fn().mockResolvedValue({
      outcome: 'reset',
      rateLimits: snapshot,
    });

    registerMakerUsageHandlers(harness, makeUsageDeps({
      readCodexRateLimits,
      consumeCodexRateLimitReset,
    }));

    await expect(harness.invoke(MAKER_INVOKE.USAGE_CODEX_RATE_LIMITS)).resolves.toEqual(snapshot);
    await expect(harness.invoke(
      MAKER_INVOKE.USAGE_CODEX_RATE_LIMIT_RESET,
      '018f4ec7-c6d8-7f10-8d43-9f8791d33000',
    )).resolves.toEqual({ outcome: 'reset', rateLimits: snapshot });
    expect(consumeCodexRateLimitReset).toHaveBeenCalledWith(
      '018f4ec7-c6d8-7f10-8d43-9f8791d33000',
    );
  });

  it('rejects arbitrary reset input before it reaches the mutation dependency', async () => {
    const harness = new IpcHarness();
    const consumeCodexRateLimitReset = vi.fn();
    registerMakerUsageHandlers(harness, makeUsageDeps({ consumeCodexRateLimitReset }));

    await expect(harness.invoke(
      MAKER_INVOKE.USAGE_CODEX_RATE_LIMIT_RESET,
      'credit-id-from-client',
    )).rejects.toThrow(/idempotencyKey must be a UUID/);
    expect(consumeCodexRateLimitReset).not.toHaveBeenCalled();
  });

  it('encodes stale reset offers as a stable IPC precondition error', async () => {
    const harness = new IpcHarness();
    const consumeCodexRateLimitReset = vi.fn().mockRejectedValue(
      new CodexRateLimitResetRejectedError('OFFER_EXPIRED', 'refresh usage'),
    );
    registerMakerUsageHandlers(harness, makeUsageDeps({ consumeCodexRateLimitReset }));

    await expect(harness.invoke(
      MAKER_INVOKE.USAGE_CODEX_RATE_LIMIT_RESET,
      '018f4ec7-c6d8-7f10-8d43-9f8791d33000',
    )).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('OFFER_EXPIRED'),
    });
  });

  it('encodes account changes during rate-limit reads as a stable IPC precondition error', async () => {
    const harness = new IpcHarness();
    const readCodexRateLimits = vi.fn().mockRejectedValue(
      new CodexRateLimitResetRejectedError('ACCOUNT_CHANGED', 'retry after account settles'),
    );
    registerMakerUsageHandlers(harness, makeUsageDeps({ readCodexRateLimits }));

    await expect(harness.invoke(MAKER_INVOKE.USAGE_CODEX_RATE_LIMITS)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('ACCOUNT_CHANGED'),
    });
  });

  it('passes numeric days through to readUsageHistory and drops invalid values', async () => {
    const harness = new IpcHarness();
    const readUsageHistory = vi.fn().mockResolvedValue(emptyHistory);

    registerMakerUsageHandlers(harness, makeUsageDeps({ readUsageHistory }));

    await harness.invoke(MAKER_INVOKE.USAGE_HISTORY, { days: 140 });
    expect(readUsageHistory).toHaveBeenLastCalledWith({ days: 140 });

    await harness.invoke(MAKER_INVOKE.USAGE_HISTORY, { days: 'lots' });
    expect(readUsageHistory).toHaveBeenLastCalledWith(undefined);

    await harness.invoke(MAKER_INVOKE.USAGE_HISTORY, { days: 140, forceRefresh: true });
    expect(readUsageHistory).toHaveBeenLastCalledWith({ days: 140, forceRefresh: true });

    await harness.invoke(MAKER_INVOKE.USAGE_HISTORY, { forceRefresh: true });
    expect(readUsageHistory).toHaveBeenLastCalledWith({ forceRefresh: true });

    await harness.invoke(MAKER_INVOKE.USAGE_HISTORY);
    expect(readUsageHistory).toHaveBeenLastCalledWith(undefined);
  });

  it('falls back to empty history payload when the read throws', async () => {
    const harness = new IpcHarness();
    const readUsageHistory = vi.fn().mockRejectedValue(new Error('db gone'));

    registerMakerUsageHandlers(harness, makeUsageDeps({ readUsageHistory }));

    await expect(harness.invoke(MAKER_INVOKE.USAGE_HISTORY)).resolves.toEqual(emptyHistory);
  });
});
