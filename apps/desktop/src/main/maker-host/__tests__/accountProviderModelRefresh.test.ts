import { describe, expect, it, vi } from 'vitest';

import { refreshProviderModelsAfterAccountReady } from '../account-provider-model-refresh.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('refreshProviderModelsAfterAccountReady', () => {
  it('keeps all account-scoped provider refreshes inside readiness', async () => {
    const anthropicRefresh = deferred();
    const backgroundRefresh = deferred();
    const events: string[] = [];
    const operation = refreshProviderModelsAfterAccountReady({
      restartCodex: async () => {
        events.push('restart');
      },
      shutdownCodexEnvironment: async () => {
        events.push('shutdown');
      },
      loadXaiLkg: async () => {
        events.push('xai-lkg');
        return true;
      },
      refreshProviderModels: async (trigger, providerIds) => {
        events.push(`refresh:${trigger}:${providerIds?.join(',')}`);
        await (providerIds?.includes('anthropic')
          ? anthropicRefresh.promise
          : backgroundRefresh.promise);
      },
      log: { warn: vi.fn() },
    });

    let settled = false;
    void operation.then(() => {
      settled = true;
    });
    await vi.waitFor(() =>
      expect(events).toEqual([
        'restart',
        'shutdown',
        'xai-lkg',
        'refresh:startup:xd,openai,xai',
        'refresh:startup:anthropic',
      ]),
    );
    expect(settled).toBe(false);

    anthropicRefresh.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    backgroundRefresh.resolve();
    await operation;
    expect(settled).toBe(true);
  });

  it('still discovers providers when Codex reset steps fail', async () => {
    const warn = vi.fn();
    const refreshProviderModels = vi.fn(async () => {});

    await expect(
      refreshProviderModelsAfterAccountReady({
        restartCodex: async () => {
          throw new Error('restart unavailable');
        },
        shutdownCodexEnvironment: vi.fn(async () => {}),
        loadXaiLkg: vi.fn(async () => false),
        refreshProviderModels,
        log: { warn },
      }),
    ).resolves.toBeUndefined();

    expect(refreshProviderModels).toHaveBeenCalledWith('startup', ['xd', 'openai', 'xai']);
    expect(refreshProviderModels).toHaveBeenCalledWith('startup', ['anthropic']);
    expect(warn).toHaveBeenCalledWith('restartCodexAfterAuthModeChange on account switch failed', {
      error: 'restart unavailable',
    });
  });

  it('keeps account readiness best-effort when discovery itself fails', async () => {
    const warn = vi.fn();
    await expect(
      refreshProviderModelsAfterAccountReady({
        restartCodex: vi.fn(async () => {}),
        shutdownCodexEnvironment: vi.fn(async () => {}),
        loadXaiLkg: vi.fn(async () => false),
        refreshProviderModels: async () => {
          throw new Error('discovery unavailable');
        },
        log: { warn },
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('background provider model startup refresh failed', {
      error: 'discovery unavailable',
    });
    expect(warn).toHaveBeenCalledWith('Anthropic model startup refresh failed', {
      error: 'discovery unavailable',
    });
  });

  it('loads the current owner xAI LKG before starting account refreshes', async () => {
    const releaseLkg = deferred();
    const events: string[] = [];
    const operation = refreshProviderModelsAfterAccountReady({
      restartCodex: async () => {},
      shutdownCodexEnvironment: async () => {},
      loadXaiLkg: async () => {
        events.push('lkg:start');
        await releaseLkg.promise;
        events.push('lkg:end');
        return true;
      },
      refreshProviderModels: async () => {
        events.push('refresh');
      },
      log: { warn: vi.fn() },
    });
    await vi.waitFor(() => expect(events).toEqual(['lkg:start']));
    releaseLkg.resolve();
    await operation;
    expect(events).toEqual(['lkg:start', 'lkg:end', 'refresh', 'refresh']);
  });
});
