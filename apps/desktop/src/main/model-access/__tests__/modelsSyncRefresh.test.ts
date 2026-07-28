import { describe, expect, it, vi } from 'vitest';

import {
  buildModelsSyncRequest,
  ensureCredentialsReadyForModelsRefresh,
  withModelsSyncOverallDeadline,
  waitForModelsSyncRefresh,
  XD_MODELS_SYNC_TIMEOUT_MS,
  type ModelsSyncFlightSnapshot,
} from '../modelsSyncRefresh.js';

describe('waitForModelsSyncRefresh', () => {
  it('gives the shared XD model-list request a finite deadline', () => {
    expect(buildModelsSyncRequest('https://model-access.example.com')).toEqual({
      path: '/api/model-access/models',
      options: {
        baseUrl: 'https://model-access.example.com',
        timeoutMs: 20_000,
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
    expect(request.options.baseUrl()).toBe(
      'https://model-access.global.example.com',
    );
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
      };
    });
    const status = await ensureCredentialsReadyForModelsRefresh({
      getStatus: () => ({
        state: 'ok',
        source: 'server',
        endpoint: 'https://gateway.example.com',
      }),
      retry,
    });

    expect(status.state).toBe('ok');
    expect(retry).not.toHaveBeenCalled();
    await expect(
      waitForModelsSyncRefresh({
        expectedGeneration: 3,
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
    }));

    await expect(
      ensureCredentialsReadyForModelsRefresh({
        getStatus: () => ({ state: 'failed', source: null, endpoint: null }),
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

  it('stops instead of following a new account when auth changes in flight', async () => {
    let resolveFlight!: () => void;
    const flight = new Promise<void>((resolve) => { resolveFlight = resolve; });
    let generation = 7;
    const outcome = waitForModelsSyncRefresh({
      expectedGeneration: 7,
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
        schedule: vi.fn(),
        snapshot: () => ({ flight: Promise.resolve(), generation: 3, attempt: 9 }),
        currentGeneration: () => 3,
        lastSuccessfulAttempt: () => 8,
      }),
    ).resolves.toBe('failed');
  });
});
