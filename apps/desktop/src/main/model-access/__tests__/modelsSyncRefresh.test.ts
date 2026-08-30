import { describe, expect, it, vi } from 'vitest';
import type { ModelAccessStatus } from '../../../shared/modelAccess.js';

import {
  buildModelsSyncRequest,
  ensureCredentialsReadyForModelsRefresh,
  modelsWithoutStalePaymentUpsell,
  parseModelsSyncPayload,
  shouldPreservePaymentRequiredRoutes,
  withModelsSyncOverallDeadline,
  waitForModelsSyncRefresh,
  XD_MODELS_SYNC_TIMEOUT_MS,
  type ModelsSyncFlightSnapshot,
} from '../modelsSyncRefresh.js';

describe('parseModelsSyncPayload', () => {
  const baseModel = {
    id: 'deepseek/deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    contextWindow: 128_000,
    currency: 'CNY' as const,
    agents: ['claude-code', 'codex'] as const,
    mode: 'chat',
    icon: 'deepseek',
    modalities: { input: ['text'], output: ['text'] },
  };

  it('does not downgrade a v5 sync request to a v1 response', () => {
    expect(parseModelsSyncPayload({ schemaVersion: 1, models: [baseModel] })).toMatchObject({
      ok: false,
    });
  });

  it('does not downgrade a v5 sync request to a v2 response', () => {
    const model = {
      ...baseModel,
      newSessionDefault: ['claude-code', 'codex'] as const,
    };
    expect(parseModelsSyncPayload({ schemaVersion: 2, models: [model] })).toMatchObject({
      ok: false,
    });
  });

  it('rejects a legacy v2 model even when its optional fields remain parseable', () => {
    const { currency: _currency, ...modelWithoutCurrency } = baseModel;

    expect(
      parseModelsSyncPayload({ schemaVersion: 2, models: [modelWithoutCurrency] }),
    ).toMatchObject({ ok: false });
  });

  it('rejects all v2 shapes rather than re-enabling legacy model fallbacks', () => {
    const { agents: _agents, ...modelWithoutAgents } = baseModel;
    const legacyModel = { ...modelWithoutAgents, defaultEffort: null } as const;
    const modelWithOverride = {
      ...baseModel,
      defaultEffort: null,
      perAgent: { codex: { defaultEffort: null } },
    } as const;

    expect(parseModelsSyncPayload({ schemaVersion: 2, models: [legacyModel] })).toMatchObject({
      ok: false,
    });
    expect(parseModelsSyncPayload({ schemaVersion: 2, models: [modelWithOverride] })).toMatchObject(
      {
        ok: false,
      },
    );
  });

  it.each([
    {
      label: 'unknown schema version',
      payload: { schemaVersion: 6, models: [baseModel] },
      errorPath: 'response.schemaVersion',
    },
    {
      label: 'v2-only field in v1',
      payload: {
        schemaVersion: 1,
        models: [{ ...baseModel, newSessionDefault: ['claude-code'] }],
      },
      errorPath: 'response.models[0].newSessionDefault',
    },
    {
      label: 'unknown v2 entry field',
      payload: {
        schemaVersion: 2,
        models: [{ ...baseModel, family: 'deepseek' }],
      },
      errorPath: 'response.models[0].family',
    },
    {
      label: 'default marker outside live agents',
      payload: {
        schemaVersion: 2,
        models: [{ ...baseModel, agents: ['claude-code'], newSessionDefault: ['codex'] }],
      },
      errorPath: 'response.models[0].newSessionDefault',
    },
  ])(
    'rejects $label so the caller keeps its last-known-good snapshot',
    ({ payload, errorPath }) => {
      const parsed = parseModelsSyncPayload(payload);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) throw new Error('unreachable');
      expect(parsed.error).toContain(errorPath);
    },
  );

  it('leaves the caller-owned last-known-good snapshot untouched on rejection', () => {
    const lastKnownGood = [{ id: 'last-known-model' }];
    const parsed = parseModelsSyncPayload({ schemaVersion: 99, models: [] });
    const effectiveModels = parsed.ok ? parsed.models : lastKnownGood;

    expect(effectiveModels).toBe(lastKnownGood);
    expect(lastKnownGood).toEqual([{ id: 'last-known-model' }]);
  });

  it.each([
    'anthropic-messages',
    'openai-responses',
    'openai-completions',
    'google-generative-ai',
  ] as const)(
    'reads v5 Pi %s routing and filters future agent kinds without rejecting the catalog',
    (piWireProtocol) => {
      const payload = {
        schemaVersion: 5,
        accountTier: 'free',
        models: [
          {
            ...baseModel,
            availability: 'requires_payment',
            agents: ['claude-code', 'codex', 'pi', 'future-agent'],
            newSessionDefault: ['pi', 'future-agent'],
            perAgent: {
              'claude-code': { wireProtocol: 'anthropic-messages' },
              codex: { wireProtocol: 'openai-responses' },
              pi: { wireProtocol: piWireProtocol },
              'future-agent': { arbitrary: true },
            },
          },
        ],
      };

      expect(parseModelsSyncPayload(payload)).toEqual({
        ok: true,
        accountTier: 'free',
        models: [
          {
            ...baseModel,
            availability: 'requires_payment',
            agents: ['claude-code', 'codex', 'pi'],
            newSessionDefault: ['pi'],
            perAgent: {
              'claude-code': { wireProtocol: 'anthropic-messages' },
              codex: { wireProtocol: 'openai-responses' },
              pi: { wireProtocol: piWireProtocol },
            },
          },
        ],
      });
    },
  );
});

describe('modelsWithoutStalePaymentUpsell', () => {
  it('保留旧快照中的可执行模型，但移除已无法在线确认的付费锁定行', () => {
    expect(modelsWithoutStalePaymentUpsell([
      { id: 'available', currency: 'CNY', agents: [], availability: 'available' },
      { id: 'locked', currency: 'CNY', agents: [], availability: 'requires_payment' },
    ])).toEqual([
      { id: 'available', currency: 'CNY', agents: [], availability: 'available' },
    ]);
  });
});

describe('shouldPreservePaymentRequiredRoutes', () => {
  const status = (state: ModelAccessStatus['state']): ModelAccessStatus => ({
    state,
    source: null,
    endpoint: null,
    accountTier: null,
  });

  it('只在同账号凭据临时失败时保留付费拒绝快照', () => {
    expect(shouldPreservePaymentRequiredRoutes(status('failed'))).toBe(true);
    expect(shouldPreservePaymentRequiredRoutes(status('disabled'))).toBe(false);
    expect(shouldPreservePaymentRequiredRoutes(status('unsupported'))).toBe(false);
    expect(shouldPreservePaymentRequiredRoutes(status('idle'))).toBe(false);
  });
});

describe('waitForModelsSyncRefresh', () => {
  it('gives the shared XD model-list request a finite deadline', () => {
    expect(buildModelsSyncRequest('https://model-access.example.com')).toEqual({
      path: '/api/model-access/models?schemaVersion=5',
      options: {
        baseUrl: 'https://model-access.example.com',
        timeoutMs: 20_000,
        cache: 'no-store',
      },
    });
    expect(Number.isFinite(XD_MODELS_SYNC_TIMEOUT_MS)).toBe(true);
    expect(XD_MODELS_SYNC_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('preserves a live endpoint resolver for post-refresh realm changes', () => {
    const resolveBaseUrl = vi.fn(() => 'https://model-access.global.example.com');
    const request = buildModelsSyncRequest(resolveBaseUrl);

    expect(request.options.baseUrl).toBe(resolveBaseUrl);
    if (typeof request.options.baseUrl !== 'function') {
      throw new Error('expected a live endpoint resolver');
    }
    expect(request.options.baseUrl()).toBe('https://model-access.global.example.com');
  });

  it('bounds the complete fetch lifecycle without cancelling the underlying auth refresh', async () => {
    vi.useFakeTimers();
    try {
      let resolveOperation!: (value: string) => void;
      const operation = new Promise<string>((resolve) => {
        resolveOperation = resolve;
      });
      const bounded = withModelsSyncOverallDeadline(operation, 25);
      const rejection = expect(bounded).rejects.toThrow(
        'Cindy AI model list refresh timed out after 25ms',
      );

      await vi.advanceTimersByTimeAsync(25);
      await rejection;

      // Token rotation is deliberately non-abortable; it may settle safely after the
      // model single-flight has already been released for a later retry.
      resolveOperation('late-safe-result');
      await expect(operation).resolves.toBe('late-safe-result');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses ready credentials and preserves the prior snapshot when the model request fails', async () => {
    const existingModels = ['last-known-model'];
    const retry = vi.fn(async () => {
      existingModels.length = 0;
      return {
        state: 'failed' as const,
        source: null,
        endpoint: null,
        accountTier: null,
      };
    });
    const status = await ensureCredentialsReadyForModelsRefresh({
      getStatus: () => ({
        state: 'ok',
        source: 'server',
        endpoint: 'https://gateway.example.com',
        accountTier: null,
      }),
      retry,
    });

    expect(status.state).toBe('ok');
    expect(retry).not.toHaveBeenCalled();
    await expect(
      waitForModelsSyncRefresh({
        expectedGeneration: 3,
        minimumAttempt: 9,
        schedule: vi.fn(),
        snapshot: () => ({ flight: Promise.resolve(), generation: 3, attempt: 9 }),
        currentGeneration: () => 3,
        lastSuccessfulAttempt: () => 8,
      }),
    ).resolves.toBe('failed');
    expect(existingModels).toEqual(['last-known-model']);
  });

  it('retries credential acquisition when credentials are not ready', async () => {
    const retry = vi.fn(async () => ({
      state: 'ok' as const,
      source: 'server' as const,
      endpoint: 'https://gateway.example.com',
      accountTier: null,
    }));

    await expect(
      ensureCredentialsReadyForModelsRefresh({
        getStatus: () => ({
          state: 'failed',
          source: null,
          endpoint: null,
          accountTier: null,
        }),
        retry,
      }),
    ).resolves.toMatchObject({ state: 'ok' });
    expect(retry).toHaveBeenCalledOnce();
  });

  it('waits through an old-account flight and accepts the current successful attempt', async () => {
    const oldFlight = Promise.resolve();
    const currentFlight = Promise.resolve();
    const snapshots: ModelsSyncFlightSnapshot[] = [
      { flight: oldFlight, generation: 1, attempt: 4 },
      { flight: currentFlight, generation: 2, attempt: 5 },
    ];
    let index = 0;
    let scheduleCalls = 0;

    await expect(
      waitForModelsSyncRefresh({
        expectedGeneration: 2,
        minimumAttempt: 5,
        schedule: () => {
          if (scheduleCalls > 0) index = 1;
          scheduleCalls += 1;
        },
        snapshot: () => snapshots[index],
        currentGeneration: () => 2,
        lastSuccessfulAttempt: () => 5,
      }),
    ).resolves.toBe('succeeded');
  });

  it('waits through a same-account prepayment flight and requires a newer attempt', async () => {
    let resolveOldFlight!: () => void;
    const oldFlight = new Promise<void>((resolve) => {
      resolveOldFlight = resolve;
    });
    const newFlight = Promise.resolve();
    let snapshot: ModelsSyncFlightSnapshot = {
      flight: oldFlight,
      generation: 4,
      attempt: 8,
    };
    let scheduleCalls = 0;
    const outcome = waitForModelsSyncRefresh({
      expectedGeneration: 4,
      minimumAttempt: 9,
      schedule: () => {
        if (scheduleCalls > 0) {
          snapshot = { flight: newFlight, generation: 4, attempt: 9 };
        }
        scheduleCalls += 1;
      },
      snapshot: () => snapshot,
      currentGeneration: () => 4,
      lastSuccessfulAttempt: () => 9,
    });

    resolveOldFlight();
    await expect(outcome).resolves.toBe('succeeded');
    expect(scheduleCalls).toBe(2);
  });

  it('stops instead of following a new account when auth changes in flight', async () => {
    let resolveFlight!: () => void;
    const flight = new Promise<void>((resolve) => {
      resolveFlight = resolve;
    });
    let generation = 7;
    const outcome = waitForModelsSyncRefresh({
      expectedGeneration: 7,
      minimumAttempt: 3,
      schedule: vi.fn(),
      snapshot: () => ({ flight, generation: 7, attempt: 3 }),
      currentGeneration: () => generation,
      lastSuccessfulAttempt: () => 3,
    });

    generation = 8;
    resolveFlight();
    await expect(outcome).resolves.toBe('account-changed');
  });

  it('does not mistake an older successful attempt for the current failed request', async () => {
    await expect(
      waitForModelsSyncRefresh({
        expectedGeneration: 3,
        minimumAttempt: 9,
        schedule: vi.fn(),
        snapshot: () => ({ flight: Promise.resolve(), generation: 3, attempt: 9 }),
        currentGeneration: () => 3,
        lastSuccessfulAttempt: () => 8,
      }),
    ).resolves.toBe('failed');
  });
});
