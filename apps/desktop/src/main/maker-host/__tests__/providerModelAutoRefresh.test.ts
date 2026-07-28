import { describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';
import type { BuiltinRefreshableProviderId } from '../../../shared/providerModelRefresh.js';

import {
  createAppFocusAutoRefreshTracker,
  createProviderModelRefreshCoordinator,
  PROVIDER_MODEL_AUTO_REFRESH_COOLDOWN_MS,
  PROVIDER_MODEL_AUTO_REFRESH_FAILURE_COOLDOWN_MS,
  PROVIDER_MODEL_FOREGROUND_BACKGROUND_THRESHOLD_MS,
} from '../provider-model-auto-refresh.js';

function view(
  id: string,
  connected: boolean,
  source: 'builtin' | 'user' = 'builtin',
): ProviderView {
  return { id, connected, source } as unknown as ProviderView;
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('provider model auto-refresh coordinator', () => {
  it('refreshes only connected built-ins and applies a per-provider cooldown', async () => {
    let now = 1_000;
    const refreshProvider =
      vi.fn<(providerId: BuiltinRefreshableProviderId) => Promise<void>>();
    refreshProvider.mockResolvedValue(undefined);
    const listProviders = vi.fn(async (_options: { allowSideEffects: true }) => [
      view('xd', true),
      view('anthropic', true),
      view('openai', false),
      view('custom-provider', true),
      view('xai', true, 'user'),
    ]);
    const coordinator = createProviderModelRefreshCoordinator({
      listProviders,
      refreshProvider,
      now: () => now,
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    await coordinator.requestAutoRefresh('providers-open');
    expect(listProviders).toHaveBeenLastCalledWith({ allowSideEffects: true });
    expect(refreshProvider.mock.calls.map(([id]) => id)).toEqual(['xd', 'anthropic']);

    await coordinator.requestAutoRefresh('model-selector-open');
    expect(refreshProvider).toHaveBeenCalledTimes(2);

    now += PROVIDER_MODEL_AUTO_REFRESH_COOLDOWN_MS;
    await coordinator.requestAutoRefresh('foreground');
    expect(refreshProvider.mock.calls.map(([id]) => id)).toEqual([
      'xd',
      'anthropic',
      'xd',
      'anthropic',
    ]);
  });

  it('joins auto/manual in-flight work and lets manual refresh bypass cooldown', async () => {
    const first = deferred();
    const refreshProvider = vi
      .fn<(providerId: 'xd' | 'anthropic' | 'openai' | 'xai') => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const coordinator = createProviderModelRefreshCoordinator({
      listProviders: async () => [view('xd', true)],
      refreshProvider,
      now: () => 10_000,
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    const automatic = coordinator.requestAutoRefresh('providers-open');
    await vi.waitFor(() => expect(refreshProvider).toHaveBeenCalledOnce());
    const manualJoining = coordinator.refreshManually('xd');
    expect(refreshProvider).toHaveBeenCalledOnce();

    first.resolve();
    await Promise.all([automatic, manualJoining]);

    await coordinator.requestAutoRefresh('model-selector-open');
    expect(refreshProvider).toHaveBeenCalledOnce();

    await coordinator.refreshManually('xd');
    expect(refreshProvider).toHaveBeenCalledTimes(2);
  });

  it('starts fresh work after an account scope change and ignores stale failures', async () => {
    let now = 1_000;
    let scope = 1;
    const first = deferred();
    const refreshProvider = vi
      .fn<(providerId: BuiltinRefreshableProviderId) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(undefined);
    const coordinator = createProviderModelRefreshCoordinator({
      listProviders: async () => [view('openai', true)],
      refreshProvider,
      getScopeKey: () => scope,
      now: () => now,
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    const oldAccountRefresh = coordinator.requestAutoRefresh('providers-open');
    await vi.waitFor(() => expect(refreshProvider).toHaveBeenCalledOnce());

    scope = 2;
    await coordinator.requestAutoRefresh('model-selector-open');
    expect(refreshProvider).toHaveBeenCalledTimes(2);

    first.reject(new Error('old account failed late'));
    await oldAccountRefresh;

    now += PROVIDER_MODEL_AUTO_REFRESH_FAILURE_COOLDOWN_MS;
    await coordinator.requestAutoRefresh('foreground');
    expect(refreshProvider).toHaveBeenCalledTimes(2);
  });

  it('swallows and logs automatic listing/source failures', async () => {
    const warn = vi.fn();
    let now = 0;
    const sourceFailure = createProviderModelRefreshCoordinator({
      listProviders: async () => [view('xai', true)],
      refreshProvider: async () => {
        throw new Error('catalog unavailable');
      },
      now: () => now,
      log: { debug: vi.fn(), warn },
    });
    await expect(sourceFailure.requestAutoRefresh('foreground')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'provider model auto-refresh failed',
      expect.objectContaining({ providerId: 'xai', trigger: 'foreground' }),
    );
    now += PROVIDER_MODEL_AUTO_REFRESH_FAILURE_COOLDOWN_MS - 1;
    await sourceFailure.requestAutoRefresh('system-resume');
    expect(warn).toHaveBeenCalledTimes(1);
    now += 1;
    await sourceFailure.requestAutoRefresh('screen-unlock');
    expect(warn).toHaveBeenCalledTimes(2);

    warn.mockClear();
    const listingFailure = createProviderModelRefreshCoordinator({
      listProviders: async () => {
        throw new Error('registry unavailable');
      },
      refreshProvider: vi.fn(async () => {}),
      now: () => 0,
      log: { debug: vi.fn(), warn },
    });
    await expect(listingFailure.requestAutoRefresh('providers-open')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      'provider model auto-refresh could not list providers',
      expect.objectContaining({ trigger: 'providers-open' }),
    );
  });
});

describe('app focus auto-refresh tracker', () => {
  it('only emits after a false-to-true transition beyond the background threshold', () => {
    let now = 0;
    const onMeaningfulForeground = vi.fn();
    const tracker = createAppFocusAutoRefreshTracker({
      now: () => now,
      onMeaningfulForeground,
    });

    tracker.sync(true);
    tracker.sync(true);
    tracker.sync(false);
    now += PROVIDER_MODEL_FOREGROUND_BACKGROUND_THRESHOLD_MS - 1;
    tracker.sync(true);
    expect(onMeaningfulForeground).not.toHaveBeenCalled();

    tracker.sync(false);
    now += PROVIDER_MODEL_FOREGROUND_BACKGROUND_THRESHOLD_MS;
    tracker.sync(true);
    tracker.sync(true);
    expect(onMeaningfulForeground).toHaveBeenCalledOnce();
  });

  it('does not treat the first focused observation as a foreground return', () => {
    const onMeaningfulForeground = vi.fn();
    const tracker = createAppFocusAutoRefreshTracker({
      now: () => PROVIDER_MODEL_FOREGROUND_BACKGROUND_THRESHOLD_MS * 10,
      onMeaningfulForeground,
    });

    tracker.sync(true);
    expect(onMeaningfulForeground).not.toHaveBeenCalled();
  });
});
