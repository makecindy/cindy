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
});
