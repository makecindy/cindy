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
  // Unit regression for PR #11681: neither a cold empty pool nor an unavailable
  // retained list proves there is no rename. Exercise the production factory and
  // provider projection with the retired ID still present after discovery failed;
  // the previous empty-only fallback missed it. Native discovery owns retries:
  // a failed refresh is read once, and a suspended provider is never revived.
  // Alias metadata is presentation, not evidence of readiness. Claude's async
  // probe must settle before reading the recovery view (review on ef4d63fd533).
  it.each([
    { providerId: 'openai', unavailable: false, suspended: false, retainedFailure: false },
    { providerId: 'openai-sub-cold', unavailable: false, suspended: false, retainedFailure: false },
    { providerId: 'openai', unavailable: true, suspended: false, retainedFailure: false },
    { providerId: 'openai-sub-cold', unavailable: true, suspended: false, retainedFailure: false },
    { providerId: 'openai', unavailable: true, suspended: true, retainedFailure: false },
    { providerId: 'openai', unavailable: true, suspended: false, retainedFailure: true },
    { providerId: 'codex-legacy', unavailable: false, suspended: false, retainedFailure: false },
    { providerId: 'codex-legacy', unavailable: true, suspended: false, retainedFailure: false },
    { providerId: 'anthropic', unavailable: false, suspended: false, retainedFailure: false },
    { providerId: 'anthropic', unavailable: true, suspended: false, retainedFailure: false },
    { providerId: 'unpublished', unavailable: false, suspended: false, retainedFailure: false },
  ])('recovers $providerId (unavailable=$unavailable, suspended=$suspended, retainedFailure=$retainedFailure)', async ({ providerId, unavailable, suspended, retainedFailure }) => {
    vi.useFakeTimers();
    const claude = providerId === 'anthropic';
    const alias = providerId === 'codex-legacy';
    const agentKind = claude ? 'claude-code' as const : 'codex' as const;
    const saved = { ...route, providerId, agentKind, model: claude ? 'claude-old' : route.model };
    const renamed = claude ? 'claude-new' : `chatgpt/${saved.model}`;
    const base = BUNDLED_CATALOG.providers.find(candidate => candidate.id === (claude ? 'anthropic' : 'openai'))!;
    landing.row = saved;
    landing.catalog = { ...BUNDLED_CATALOG, providers: [{ ...base, id: providerId }] };
    let loaded = false;
    let releaseDiscovery!: () => void;
    const discovery = new Promise<void>(resolve => { releaseDiscovery = resolve; });
    const discover = vi.fn(async () => { await discovery; loaded = true; return true; });
    const readAccount = vi.fn(() => new Promise<{ source: 'unknown' }>(() => {}));
    const service = createProviderService({
      getCatalog: () => landing.catalog!,
      projectCatalog: catalog => ({ ...catalog, providers: catalog.providers
        .filter(() => providerId !== 'unpublished' || loaded).map(candidate => ({
        ...candidate, models: { [agentKind]: (loaded || unavailable)
          ? [{ id: loaded && !retainedFailure ? renamed : saved.model,
            name: renamed, contextWindow: 200_000, efforts: ['high'], defaultEffort: 'high' }]
          : [] },
      })) }),
      projectProvider: candidate => ({ ...candidate, suspended,
        ...(alias ? { subscriptionPoolAlias: true as const, subscriptionPoolTarget: 'openai' }
          : { subscriptionAccountPool: claude ? 'anthropic' as const : 'openai' as const }),
      }),
      subscriptionReadUnavailable: () => unavailable && (!loaded || retainedFailure),
      connection: { xd: () => false,
        anthropic: options => {
          if (!claude) return false;
          if (options.snapshotOnly) return loaded || unavailable;
          const probing = discover();
          // Match the production reader: ordinary lists start Claude discovery
          // in the background; routing must explicitly wait for its result.
          return options.waitForDiscovery ? probing : true;
        },
        openai: options => claude ? false : options.snapshotOnly ? loaded || unavailable : discover(),
        xai: () => false },
      openAiAccountInfo: readAccount,
      subscriptionAccountInfo: readAccount,
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
    let completed = false;
    const sending = recover('cold-send').then(() => { completed = true; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(apply).not.toHaveBeenCalled();
      expect(completed).toBe(suspended);
      releaseDiscovery();
      await vi.advanceTimersByTimeAsync(0);
      // Native Claude ids are not bridge-prefix renames. Its observable contract
      // is waiting for discovery, without inventing an unsupported replacement.
      if (claude || suspended || retainedFailure) expect(apply).not.toHaveBeenCalled();
      else expect(apply.mock.calls[0]?.slice(0, 3)).toEqual(['cold-send', renamed, providerId]);
      expect(readAccount).not.toHaveBeenCalled();
      await sending;
      if (!retainedFailure) await recover('cold-send');
      expect(discover).toHaveBeenCalledTimes(suspended ? 0 : 1);
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
      projectProvider: candidate => ({ ...candidate, subscriptionAccountPool: 'openai' }),
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
