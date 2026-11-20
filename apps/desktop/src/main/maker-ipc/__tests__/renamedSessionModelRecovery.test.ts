import { describe, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG, type Catalog, type ProviderView } from '@cindy/model-providers';
import { recoverRenamedSessionModelBeforeSend } from '../renamedSessionModelRecovery';
import { createRecoverRenamedSessionModelOnSend } from '../sessionRuntimeSelectionLanding';
import { createProviderService } from '../../maker-host/provider-service';
import { getSessionRuntimeControlSnapshot } from '../sessionRuntimeControl';

const landing = vi.hoisted(() => ({ row: null as object | null, catalog: null as Catalog | null }));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({ drizzle: { select: () => ({ from: () => ({ where: () => ({
    limit: async () => landing.row ? [landing.row] : [],
  }) }) }) } }),
}));
vi.mock('../../maker-host/active-catalog.js', () => ({ getActiveCatalog: () => landing.catalog }));
// Only the other landing factories use harness selection; do not load its host graph here.
vi.mock('../sessionRuntimeHarnessSelection.js', () => ({ pendingHarnessRuntimeMutation: vi.fn() }));

const route = {
  status: 'active',
  model: 'gpt-6-luna',
  providerId: 'openai',
  agentKind: 'codex' as const,
  effort: 'high' as const,
  fastMode: false,
  remoteHostId: null,
  agentDeviceId: null,
};
const provider = (ids: string[]) => ({
  id: 'openai',
  models: { codex: ids.map(id => ({ id })) },
}) as ProviderView;

describe('recoverRenamedSessionModelBeforeSend', () => {
  it('applies the unique replacement on a direct send with no pending selection', async () => {
    const apply = vi.fn(async () => ({ deferred: false, superseded: false }));
    const recovered = await recoverRenamedSessionModelBeforeSend({
      route, effectiveRoute: route, hasPendingSelection: false,
      providers: [provider(['chatgpt/gpt-6-luna'])], apply,
    });
    expect(recovered).toBe(true);
    expect(apply).toHaveBeenCalledExactlyOnceWith('chatgpt/gpt-6-luna', 'openai');
  });

  it('does not override a pending choice or guess between two replacements', async () => {
    const apply = vi.fn(async () => ({ deferred: false, superseded: false }));
    expect(await recoverRenamedSessionModelBeforeSend({
      route, effectiveRoute: route, hasPendingSelection: true,
      providers: [provider(['chatgpt/gpt-6-luna'])], apply,
    })).toBe(false);
    expect(await recoverRenamedSessionModelBeforeSend({
      route, effectiveRoute: route, hasPendingSelection: false,
      providers: [provider(['chatgpt/gpt-6-luna', 'xai/gpt-6-luna'])], apply,
    })).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('preserves an accepted temporary route or axis override', async () => {
    const apply = vi.fn(async () => ({ deferred: false, superseded: false }));
    expect(await recoverRenamedSessionModelBeforeSend({
      route, effectiveRoute: { ...route, model: 'available-fallback' },
      hasPendingSelection: false, providers: [provider(['chatgpt/gpt-6-luna'])], apply,
    })).toBe(false);
    expect(await recoverRenamedSessionModelBeforeSend({
      route, effectiveRoute: { ...route, effort: 'low', fastMode: true },
      hasPendingSelection: false, providers: [provider(['chatgpt/gpt-6-luna'])], apply,
    })).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('does not turn an existing suspended provider into a rejected new route', async () => {
    const apply = vi.fn(async () => ({ deferred: false, superseded: false }));
    const suspended = { ...provider(['chatgpt/gpt-6-luna']), suspended: true };
    expect(await recoverRenamedSessionModelBeforeSend({
      route, effectiveRoute: route, hasPendingSelection: false,
      providers: [suspended], apply,
    })).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it('refuses to send when applying the replacement did not finish', async () => {
    await expect(recoverRenamedSessionModelBeforeSend({
      route, effectiveRoute: route, hasPendingSelection: false,
      providers: [provider(['chatgpt/gpt-6-luna'])],
      apply: async () => ({ deferred: true, superseded: false }),
    })).rejects.toThrow('could not be applied before send');
  });
});

describe('send-time renamed-model recovery', () => {
  // Unit regression for PR #11681 review: an empty cold pool projection is not
  // evidence that a saved model has no rename. Unlike the warm-catalog tests below,
  // start without pool membership and require recovery after native discovery,
  // while account presentation remains stalled. Cover built-in and created pools.
  it.each(['openai', 'openai-sub-cold'])('discovers a cold %s pool before recovering its saved route', async providerId => {
    vi.useFakeTimers();
    const saved = { ...route, providerId };
    const renamed = 'chatgpt/gpt-6-luna';
    const base = BUNDLED_CATALOG.providers.find(candidate => candidate.id === 'openai')!;
    landing.row = saved;
    landing.catalog = { ...BUNDLED_CATALOG, providers: [{ ...base, id: providerId }] };
    let loaded = false;
    let releaseDiscovery!: () => void;
    const discovery = new Promise<void>(resolve => { releaseDiscovery = resolve; });
    const discover = vi.fn(async () => { await discovery; loaded = true; return true; });
    const readAccount = vi.fn(() => new Promise<{ source: 'unknown' }>(() => {}));
    const service = createProviderService({
      getCatalog: () => landing.catalog!,
      projectCatalog: catalog => ({ ...catalog, providers: catalog.providers.map(candidate => ({
        ...candidate, models: { codex: loaded
          ? [{ id: renamed, name: renamed, contextWindow: 200_000, efforts: ['high'], defaultEffort: 'high' }]
          : [] },
      })) }),
      projectProvider: candidate => ({ ...candidate, subscriptionAccountPool: 'openai' }),
      connection: { xd: () => false, anthropic: () => false,
        openai: options => options.snapshotOnly ? loaded : discover(), xai: () => false },
      openAiAccountInfo: readAccount,
    });
    type Ports = Parameters<typeof createRecoverRenamedSessionModelOnSend>[0];
    const apply = vi.fn<Ports['handleSetModel']>(async () => ({ deferred: false, superseded: false }));
    const recover = createRecoverRenamedSessionModelOnSend({
      agentSwitchPending: { get: () => undefined, set: vi.fn(), clear: vi.fn() },
      getDesktopProviderService: () => service,
      readSessionRuntimeProfiles: async () => ({ baseline: saved, effective: saved,
        control: getSessionRuntimeControlSnapshot('cold-send'), pendingMutation: null }),
      handleSetModel: apply,
    });
    const sending = recover('cold-send');
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(apply).not.toHaveBeenCalled();
      releaseDiscovery();
      await vi.advanceTimersByTimeAsync(0);
      expect(apply.mock.calls[0]?.slice(0, 3)).toEqual(['cold-send', renamed, providerId]);
      expect(readAccount).not.toHaveBeenCalled();
      await sending;
      await recover('cold-send');
      expect(discover).toHaveBeenCalledTimes(1);
    } finally {
      releaseDiscovery();
      landing.row = null;
      landing.catalog = null;
      vi.useRealTimers();
    }
  });

  // Unit regression: the production send-time factory used a live provider read, so an
  // unrelated stalled account/model refresh delayed even an unchanged route. The existing
  // pure recovery tests do not exercise that read. Keep discovery pending and require the
  // send check (including a real rename) to finish using the provider service's snapshot.
  it.each([
    { model: 'gpt-6-luna', renamed: false },
    { model: 'chatgpt/gpt-6-luna', renamed: true },
  ])('finishes with $model while native discovery is stalled', async ({ model, renamed }) => {
    vi.useFakeTimers();
    let releaseDiscovery!: (connected: boolean) => void;
    const discovery = new Promise<boolean>(resolve => { releaseDiscovery = resolve; });
    const readAccount = vi.fn(async () => { await discovery; return { source: 'unknown' as const }; });
    const nativeRead = vi.fn((options: { snapshotOnly?: boolean }) => options.snapshotOnly ? true : discovery);
    landing.row = route;
    landing.catalog = {
      ...BUNDLED_CATALOG,
      providers: [{ ...BUNDLED_CATALOG.providers.find(candidate => candidate.id === 'openai')!,
        models: { codex: [{ id: model, name: model, contextWindow: 200_000, efforts: ['high'], defaultEffort: 'high' }] },
      }],
    };
    const service = createProviderService({
      getCatalog: () => landing.catalog!,
      connection: { xd: () => false, anthropic: nativeRead, openai: nativeRead, xai: () => false },
      openAiAccountInfo: readAccount,
      subscriptionAccountInfo: readAccount,
    });
    type Ports = Parameters<typeof createRecoverRenamedSessionModelOnSend>[0];
    const apply = vi.fn<Ports['handleSetModel']>(async () => ({ deferred: false, superseded: false }));
    const recover = createRecoverRenamedSessionModelOnSend({
      agentSwitchPending: { get: () => undefined, set: vi.fn(), clear: vi.fn() },
      getDesktopProviderService: () => service,
      readSessionRuntimeProfiles: async () => ({ baseline: route, effective: route,
        control: getSessionRuntimeControlSnapshot('snapshot-send'), pendingMutation: null }),
      handleSetModel: apply,
    });
    let completed = false;
    const sending = recover('snapshot-send').then(() => { completed = true; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(completed).toBe(true);
      expect(readAccount).not.toHaveBeenCalled();
      if (renamed) expect(apply.mock.calls[0]?.slice(0, 3)).toEqual(['snapshot-send', model, 'openai']);
      else expect(apply).not.toHaveBeenCalled();
    } finally {
      releaseDiscovery(true);
      await sending;
      landing.row = null;
      landing.catalog = null;
      vi.useRealTimers();
    }
  });
});
