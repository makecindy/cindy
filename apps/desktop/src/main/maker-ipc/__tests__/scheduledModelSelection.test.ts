import { describe, expect, it, vi } from 'vitest';
import type { CatalogModel, ProviderView } from '@cindy/model-providers';
import { applyScheduledModelSelection, assertScheduledHarnessSupported, createScheduledModelScope, createScheduledModelSelectionResolver, resolveScheduledModelSelection, ScheduledModelSelectionBusyError, type ScheduledModelSelection } from '../scheduledModelSelection';

const selection: ScheduledModelSelection = {
  agentKind: 'pi', model: 'test-model', providerId: 'custom', effort: null, fastMode: false,
};

// User regression: an automation must not replace the next manually sent turn's
// model/provider/effort/Fast. Existing selection tests only covered applying the
// automation choice. Unit tier, including restart, failure and late cleanup.
describe('one-run automation model preferences', () => {
  function scopeFixture(
    effort: ScheduledModelSelection['effort'] | '' = 'high',
    fastMode: ScheduledModelSelection['fastMode'] = true,
  ) {
    const original: ScheduledModelSelection = {
      agentKind: 'codex', model: 'owner-model', providerId: 'owner-provider',
      effort: effort || null, fastMode,
    };
    let profile = { ...original, effort };
    let baseline: string | null = null;
    let id = 0;
    const deps = {
      createId: () => `scope-${++id}`,
      read: async () => ({ profile, baseline }),
      write: async (_id: string, value: unknown) => { baseline = value ? JSON.stringify(value) : null; },
      isBusy: vi.fn(() => false),
      apply: vi.fn(async (_id: string, value: ScheduledModelSelection) => {
        const { agentKind, model, providerId, effort, fastMode } = value;
        profile = { agentKind, model, providerId, effort, fastMode };
      }),
    };
    return { original, deps, scope: createScheduledModelScope(deps),
      automate: () => { profile = { ...selection }; },
      state: () => ({ profile, baseline }),
      choose: () => { baseline = null; profile = { ...original, model: 'new-owner-model' }; },
    };
  }
  it('stops scope creation when a permanent save wins the baseline compare-and-set', async () => {
    const h = scopeFixture();
    const scope = createScheduledModelScope({ ...h.deps, write: async () => false });
    await expect(scope.begin('task')).rejects.toThrow('changed');
    expect(h.deps.apply).not.toHaveBeenCalled();
  });
  it('stops restoration when a permanent save wins before cleanup', async () => {
    const h = scopeFixture();
    await h.scope.begin('task');
    const scope = createScheduledModelScope({ ...h.deps, write: async () => false });
    await expect(scope.restore('task')).rejects.toThrow('changed');
    expect(h.state().baseline).not.toBeNull();
  });
  it.each(['same-process', 'restart'])('restores all owner settings after %s', async (mode) => {
    const h = scopeFixture();
    await h.scope.begin('task');
    h.automate();
    const scope = mode === 'restart' ? createScheduledModelScope(h.deps) : h.scope;
    await scope.restore('task');
    expect(h.state()).toEqual({ profile: h.original, baseline: null });
  });
  // #6895 unit regression: preparing a newly saved route may defer/fail. The
  // stale session row must not become durable recovery state in that case.
  it('does not capture an old baseline when preparing the saved choice fails', async () => {
    const h = scopeFixture();
    const prepareBaseline = vi.fn(async () => { throw new ScheduledModelSelectionBusyError('waiting'); });
    const scope = createScheduledModelScope({ ...h.deps, prepareBaseline });
    await expect(scope.begin('task')).rejects.toThrow(ScheduledModelSelectionBusyError);
    expect(h.state().baseline).toBeNull();
    await h.scope.begin('task');
    // Existing scopes preserve the owner's original choice without switching
    // away from the automation just to capture it again.
    expect(await scope.begin('task')).toBe('scope-1');
    expect(prepareBaseline).toHaveBeenCalledTimes(1);
  });
  // #6895 unit regression: a lane outside the save's lock snapshot can see
  // Profile B after preparation applied A. Do not stamp A with B's revision.
  it('retries capture when the profile changes during route preparation', async () => {
    const h = scopeFixture();
    let profileRevision = 'A';
    const write = vi.fn(h.deps.write);
    const scope = createScheduledModelScope({ ...h.deps, write,
      read: async () => ({ ...await h.deps.read(), profileRevision }),
      prepareBaseline: async () => { profileRevision = 'B'; },
    });
    await expect(scope.begin('task')).rejects.toThrow(ScheduledModelSelectionBusyError);
    expect(write).not.toHaveBeenCalled();
    expect(h.state().baseline).toBeNull();
  });
  // Main's prepare hook and #6759's durable pending marker must agree before
  // a new automation captures its restore. Failure/owner change must retain it.
  it.each(['failed', 'unaccepted', 'owner-changed'] as const)('retains a pending permanent choice when preparation is %s', async (mode) => {
    const h = scopeFixture();
    await h.deps.write('task', { ...h.original, scopeId: 'pending', pendingBotProfileVersion: 2 });
    const before = h.state().baseline;
    let owner = 'a';
    const write = vi.fn(h.deps.write);
    const scope = createScheduledModelScope({ ...h.deps, write, ownerEpoch: () => owner,
      prepareBaseline: async () => {
        if (mode === 'failed') throw new Error('offline');
        if (mode === 'owner-changed') owner = 'b';
      },
    });
    await expect(scope.begin('task')).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
    expect(h.state().baseline).toBe(before);
  });
  // PR #6559 + #6579 integration: the persisted scope must restore an
  // Ultrafast owner after automation/restart. Existing cases used booleans;
  // minimal failure is baseline JSON with fastMode='ultrafast'. Unit tier.
  it('restores an Ultrafast owner after automation and restart', async () => {
    const h = scopeFixture('high', 'ultrafast');
    const scopeId = await h.scope.begin('task');
    h.automate();
    const restarted = createScheduledModelScope(h.deps);
    expect(await restarted.begin('task')).toBe(scopeId);
    await restarted.restore('task', scopeId);
    expect(h.state()).toEqual({ profile: h.original, baseline: null });
  });
  // PR #6579 P1: prior coverage only saved valid effort tiers. The scope must
  // restore a no-effort owner after automation, including persisted legacy ''.
  // Unit tier: exercise begin/restore with the raw session sentinel and reload.
  it.each(['new-save', 'legacy-restart'])('restores a no-effort owner after %s', async (mode) => {
    const h = scopeFixture('');
    const scopeId = await h.scope.begin('task');
    expect(JSON.parse(h.state().baseline!).effort).toBeNull();
    if (mode === 'legacy-restart') {
      await h.deps.write('task', { ...h.original, effort: '', scopeId });
    }
    h.automate();
    const scope = mode === 'legacy-restart' ? createScheduledModelScope(h.deps) : h.scope;
    // Queue preparation must retain the original owner even for legacy records.
    expect(await scope.begin('task')).toBe(scopeId);
    await scope.restore('task', scopeId);
    expect(h.state()).toEqual({ profile: h.original, baseline: null });
  });
  it('retains the owner selection through a busy turn and a failed restore', async () => {
    const h = scopeFixture();
    await h.scope.begin('task');
    h.automate();
    h.deps.isBusy.mockReturnValue(true);
    await h.scope.restore('task');
    expect(h.state().profile).toEqual(selection);
    expect(h.deps.apply).not.toHaveBeenCalled();
    h.deps.isBusy.mockReturnValue(false);
    h.deps.apply.mockRejectedValueOnce(new Error('offline'));
    await expect(h.scope.restore('task')).rejects.toThrow('offline');
    expect(JSON.parse(h.state().baseline!).model).toBe('owner-model');
    await h.scope.restore('task');
    expect(h.state().profile).toEqual(h.original);
  });
  it('does not replace the saved owner choice when queue preparation enters the same run again', async () => {
    const h = scopeFixture();
    const id = await h.scope.begin('task');
    h.automate();
    expect(await h.scope.begin('task')).toBe(id);
    await h.scope.restore('task');
    expect(h.state().profile).toEqual(h.original);
  });
  it('never lets late cleanup overwrite a newer explicit choice or another run', async () => {
    const h = scopeFixture();
    const old = await h.scope.begin('task');
    h.automate();
    h.choose();
    await h.scope.restore('task', old);
    expect(h.state().profile.model).toBe('new-owner-model');
    const current = await h.scope.begin('task');
    h.automate();
    await h.scope.restore('task', old);
    expect(h.state().profile).toEqual(selection);
    await h.scope.restore('task', current);
    expect(h.state().profile.model).toBe('new-owner-model');
  });
});
function fixture(agentKind: ScheduledModelSelection['agentKind'] = 'codex') {
  return {
    getTarget: vi.fn(async () => ({ agentKind, status: 'active' })),
    isBusy: vi.fn(() => false),
    resolveSelection: vi.fn(async (selection: ScheduledModelSelection) => selection),
    switchHarness: vi.fn(async (_selection: ScheduledModelSelection) => ({ engineReady: true })),
    applyModel: vi.fn(async (_selection: ScheduledModelSelection) => {}),
  };
}

describe('saved automation model selection at dispatch', () => {
  it('hands history to the target Harness before applying the complete model configuration', async () => {
    const deps = fixture();
    await applyScheduledModelSelection(selection, deps);
    expect(deps.switchHarness).toHaveBeenCalledWith(selection);
    expect(deps.applyModel).toHaveBeenCalledWith(selection);
    expect(deps.switchHarness.mock.invocationCallOrder[0]).toBeLessThan(deps.applyModel.mock.invocationCallOrder[0]);
  });
  it('uses the ordinary model path without a handoff for the same Harness', async () => {
    const deps = fixture('pi');
    await applyScheduledModelSelection(selection, deps);
    expect(deps.switchHarness).not.toHaveBeenCalled();
    expect(deps.applyModel).toHaveBeenCalledWith(selection);
  });
  it('defers busy work without changing or staging either configuration', async () => {
    const deps = fixture();
    deps.isBusy.mockReturnValue(true);
    await expect(applyScheduledModelSelection(selection, deps)).rejects.toBeInstanceOf(ScheduledModelSelectionBusyError);
    expect(deps.switchHarness).not.toHaveBeenCalled();
    expect(deps.applyModel).not.toHaveBeenCalled();
  });
  // PR #6832: recovery must not depend on a dead target's catalog. The previous
  // fixture only resolved successfully, hiding offline/revoked-share failures.
  // Unit tier: unresolved saved preferences reach the runner without remote I/O.
  it.each(['missing', 'archived', 'deleted'])('preserves the saved choice for %s recovery without resolving the old catalog', async (status) => {
    const deps = fixture();
    deps.getTarget.mockResolvedValue(status === 'missing' ? null as never : { agentKind: 'codex', status });
    deps.resolveSelection.mockRejectedValue(new Error('old target offline or share revoked'));
    await expect(applyScheduledModelSelection(selection, deps)).resolves.toEqual(selection);
    expect(deps.resolveSelection).not.toHaveBeenCalled();
    expect(deps.switchHarness).not.toHaveBeenCalled();
    expect(deps.applyModel).not.toHaveBeenCalled();
  });
  it('does not apply a model to a Harness that failed to become ready', async () => {
    const deps = fixture();
    deps.switchHarness.mockResolvedValue({ engineReady: false });
    await expect(applyScheduledModelSelection(selection, deps)).rejects.toThrow('did not become ready');
    expect(deps.applyModel).not.toHaveBeenCalled();
  });

  it('resolves omitted effort before either the Harness switch or model application', async () => {
    const deps = fixture();
    deps.resolveSelection.mockImplementation(async (choice) => resolveScheduledModelSelection(choice, [provider('custom')]));
    await applyScheduledModelSelection(selection, deps);
    const expected = { ...selection, effort: 'medium' };
    expect(deps.switchHarness).toHaveBeenCalledWith(expected);
    expect(deps.applyModel).toHaveBeenCalledWith(expected);
    expect(deps.resolveSelection.mock.invocationCallOrder[0]).toBeLessThan(deps.switchHarness.mock.invocationCallOrder[0]);
  });

  it('leaves the target untouched when the saved provider is unavailable', async () => {
    const deps = fixture();
    deps.resolveSelection.mockImplementation(async (choice) => resolveScheduledModelSelection(choice, [provider('other')]));
    await expect(applyScheduledModelSelection(selection, deps)).rejects.toThrow('unavailable');
    expect(deps.switchHarness).not.toHaveBeenCalled();
    expect(deps.applyModel).not.toHaveBeenCalled();
  });
  it('clears stale Fast before switching Harness or applying the saved selection', async () => {
    const deps = fixture();
    deps.resolveSelection.mockImplementation(async (choice) => resolveScheduledModelSelection(choice, [provider('custom')]));
    const expected = { ...selection, effort: 'medium', fastMode: false };
    await expect(applyScheduledModelSelection({ ...selection, providerId: null, fastMode: true }, deps))
      .resolves.toEqual(expected);
    expect(deps.switchHarness).toHaveBeenCalledWith(expected);
    expect(deps.applyModel).toHaveBeenCalledWith(expected);
  });
  it('rejects an unsupported bound Harness before route preparation or runtime mutation', async () => {
    const deps = { ...fixture(), getTarget: vi.fn(async () => ({
      agentKind: 'codex' as const, status: 'active', remoteHostId: 'ssh-host',
    })) };
    await expect(applyScheduledModelSelection(selection, deps)).rejects.toThrow('current Harness');
    expect(deps.resolveSelection).not.toHaveBeenCalled();
    expect(deps.switchHarness).not.toHaveBeenCalled();
    expect(deps.applyModel).not.toHaveBeenCalled();
  });
});

function provider(id: string, model: Partial<CatalogModel> = {}): ProviderView {
  return {
    id, name: id, source: 'user', connected: true, agents: ['pi'],
    auth: { method: 'none' }, routing: { pi: {} },
    models: { pi: [{ id: 'test-model', name: 'Test model', contextWindow: 128_000,
      efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', ...model }] },
  } as ProviderView;
}

describe('saved effort uses the selected provider and Harness catalog copy', () => {
  it.each([null, 'ultra'] as const)('fills or reconciles %s to the route default', (effort) => {
    const selected = provider('custom', { efforts: ['low', 'high'], defaultEffort: 'high' });
    const other = provider('other', { efforts: ['low'], defaultEffort: 'low' });
    selected.models.codex = [{ ...selected.models.pi![0]!, efforts: ['medium'], defaultEffort: 'medium' }];
    expect(resolveScheduledModelSelection({ ...selection, effort }, [other, selected]))
      .toMatchObject({ agentKind: 'pi', providerId: 'custom', effort: 'high' });
  });
  it('preserves a supported explicit tier rather than replacing it with the default', () => {
    expect(resolveScheduledModelSelection({ ...selection, effort: 'low' }, [provider('custom')]).effort).toBe('low');
  });
  it('materializes the default provider before resolving its effort', () => {
    expect(resolveScheduledModelSelection({ ...selection, providerId: null }, [provider('custom')]))
      .toMatchObject({ providerId: 'custom', effort: 'medium' });
  });
  it('clears stale effort for a model with no adjustable tiers', () => {
    expect(resolveScheduledModelSelection({ ...selection, effort: 'high' }, [
      provider('custom', { efforts: [], defaultEffort: undefined }),
    ]).effort).toBeNull();
  });
  it.each([true, false, undefined])('uses only the selected route Fast capability (%s)', (supportsFastMode) => {
    const selected = provider('custom', { supportsFastMode });
    selected.models.codex = [{ ...selected.models.pi![0]!, supportsFastMode: true }];
    const providers = [provider('other', { supportsFastMode: true }), selected];
    expect(resolveScheduledModelSelection({ ...selection, fastMode: true }, providers).fastMode)
      .toBe(supportsFastMode === true);
    expect(resolveScheduledModelSelection(selection, providers).fastMode).toBe(false);
  });
});

describe('bound target Harness capability', () => {
  it.each([{ remoteHostId: 'ssh-host' }, { remoteHostId: 'ssh-host', orcaRole: 'lead' }])(
    'rejects cross-Harness overrides on %j while preserving same-Harness and follow modes', (restriction) => {
      const target = { agentKind: 'codex' as const, status: 'active', ...restriction };
      expect(() => assertScheduledHarnessSupported(target, 'pi')).toThrow('current Harness');
      expect(() => assertScheduledHarnessSupported(target, 'codex')).not.toThrow();
      expect(() => assertScheduledHarnessSupported(target, undefined)).not.toThrow();
    },
  );
  // Regression: ordinary Orca switching supports all three Harnesses, but the
  // scheduled guard blocked both the override and the next manual send's restore.
  // Unit tier: enter a persisted scope, switch, reload it and restore via the real
  // selection entry; the old guard fails before any model can be applied.
  it.each(['lead', 'worker'])('applies and restores a cross-Harness override for an Orca %s', async (orcaRole) => {
    let profile: ScheduledModelSelection = { ...selection, agentKind: 'codex', model: 'owner-model' };
    const original = { ...profile };
    let baseline: string | null = null;
    const apply = async (_id: string, choice: ScheduledModelSelection) => {
      await applyScheduledModelSelection(choice, {
        getTarget: async () => ({ agentKind: profile.agentKind, status: 'active', orcaRole }),
        isBusy: () => false,
        resolveSelection: async (value) => value,
        switchHarness: async (value) => { profile = { ...profile, agentKind: value.agentKind }; return { engineReady: true }; },
        applyModel: async (value) => { profile = { ...value }; },
      });
    };
    const deps = {
      createId: () => 'scope', isBusy: () => false,
      read: async () => ({ profile, baseline }),
      write: async (_id: string, value: unknown) => { baseline = value ? JSON.stringify(value) : null; },
      apply,
    };
    expect(() => assertScheduledHarnessSupported({ agentKind: 'codex', status: 'active', orcaRole }, 'pi')).not.toThrow();
    await createScheduledModelScope(deps).begin('task');
    await apply('task', selection);
    expect(profile).toEqual(selection);
    await createScheduledModelScope(deps).restore('task');
    expect(profile).toMatchObject(original);
    expect(baseline).toBeNull();
  });
  it('preserves ordinary local cross-Harness selection and archived-target recovery', () => {
    expect(() => assertScheduledHarnessSupported({ agentKind: 'codex', status: 'active' }, 'pi')).not.toThrow();
    expect(() => assertScheduledHarnessSupported({ agentKind: 'codex', status: 'archived', remoteHostId: 'ssh-host' }, 'pi')).not.toThrow();
    expect(() => assertScheduledHarnessSupported(null, 'pi')).not.toThrow();
  });
});

// #6745: invoke the same production resolver wired into register.ts with the
// real persisted-scope lifecycle; only catalog, storage and engine I/O are fakes.
const remoteChoice: ScheduledModelSelection = {
  agentKind: 'codex', model: 'test-model', providerId: 'openai-shared', effort: 'high', fastMode: false,
};
function remoteCatalog(id: string): ProviderView[] {
  return [{ id, connected: true, agents: ['codex'], routing: { codex: {} }, source: 'user', models: { codex: [{
    id: 'test-model', efforts: ['low', 'high'], defaultEffort: 'low', supportsFastMode: false,
  }] } }] as ProviderView[];
}
function remoteFixture(device: string | null = 'share:test', status = 'active') {
  let current = { ...remoteChoice, agentDeviceId: device };
  let baseline: string | null = JSON.stringify({ ...remoteChoice, scopeId: 'old-run' });
  const local = remoteCatalog('openai');
  const remote = vi.fn(async () => remoteCatalog('openai-shared'));
  const guard = vi.fn(async (_agent: string, _model: string, providerId: string | null) => {
    if (!local.some(p => p.id === providerId)) throw new Error('provider unavailable on this computer');
    return undefined;
  });
  const switchHarness = vi.fn(async () => ({ engineReady: true }));
  const applyModel = vi.fn(async (route: ScheduledModelSelection) => {
    current = { ...current, ...route };
  });
  const apply = async (_id: string, selection: ScheduledModelSelection) => applyScheduledModelSelection(selection, {
    getTarget: async () => status === 'missing' ? null : ({ ...current, status }),
    isBusy: () => false,
    resolveSelection: createScheduledModelSelectionResolver({
      readRemoteProviders: remote,
      resolveLocalSelection: async route => {
        await guard(route.agentKind, route.model, route.providerId);
        return resolveScheduledModelSelection(route, local);
      },
    }),
    switchHarness, applyModel,
  });
  const deps = {
    read: async () => ({ profile: current, baseline }),
    write: async (_id: string, value: unknown) => { baseline = value ? JSON.stringify(value) : null; },
    isBusy: () => false, createId: () => 'new-run',
    apply: async (id: string, profile: ScheduledModelSelection) => { await apply(id, profile); },
  };
  return { deps, apply, remote, guard, switchHarness, applyModel, scope: createScheduledModelScope(deps),
    state: () => ({ current, baseline }), save: (value: unknown) => { baseline = JSON.stringify(value); } };
}

describe('automation restore uses the execution computer', () => {
  it.each(['share:test', 'other-device'])('restores a legacy baseline on %s after restart', async device => {
    const h = remoteFixture(device);
    await createScheduledModelScope(h.deps).restore('task');
    expect(h.remote).toHaveBeenCalledWith(device, 'codex', 'test-model', 'openai-shared');
    expect(h.guard).not.toHaveBeenCalled();
    expect(h.applyModel).toHaveBeenCalledOnce();
    expect(h.state().baseline).toBeNull();
    expect(h.state().current).toMatchObject(remoteChoice);
  });
  it('validates an automation choice on the same remote execution computer', async () => {
    const h = remoteFixture();
    await h.apply('task', remoteChoice);
    expect(h.remote).toHaveBeenCalledWith('share:test', 'codex', 'test-model', 'openai-shared');
    expect(h.guard).not.toHaveBeenCalled();
    expect(h.switchHarness).not.toHaveBeenCalled();
    expect(h.state().current.agentDeviceId).toBe('share:test');
  });
  it('keeps ordinary local-provider validation for a local task', async () => {
    const h = remoteFixture(null);
    h.save({ ...remoteChoice, providerId: 'openai', scopeId: 'old-run' });
    await h.scope.restore('task');
    expect(h.guard).toHaveBeenCalledWith('codex', 'test-model', 'openai');
    expect(h.remote).not.toHaveBeenCalled();
    expect(h.state().current.providerId).toBe('openai');
    expect(h.state().baseline).toBeNull();
  });
  it('does not substitute a local provider when the remote catalog no longer contains the source', async () => {
    const h = remoteFixture();
    h.remote.mockResolvedValueOnce(remoteCatalog('another-source'));
    await expect(h.scope.restore('task')).rejects.toThrow('unavailable');
    expect(h.applyModel).not.toHaveBeenCalled();
    expect(h.guard).not.toHaveBeenCalled();
    expect(h.state().baseline).not.toBeNull();
  });
  it('preserves the standard admission exception for a custom user-owned model group', async () => {
    const h = remoteFixture();
    const views = remoteCatalog('openai-shared');
    const model = 'gpt-4o-audio-preview';
    views[0].models.codex![0].id = model;
    views[0].models.codex![0].group = 'custom:openai-shared';
    h.save({ ...remoteChoice, model, scopeId: 'old-run' });
    h.remote.mockResolvedValueOnce(views);
    await h.scope.restore('task');
    expect(h.state().baseline).toBeNull();
    expect(h.state().current).toMatchObject({ ...remoteChoice, model });
  });
  it.each([{ status: 'retired' }, { availability: 'requires_payment' }, { mode: 'image' }])(
    'rejects a remote catalog entry outside new-route admission: %j', async flags => {
      const h = remoteFixture();
      const before = h.state();
      const views = remoteCatalog('openai-shared');
      Object.assign(views[0].models.codex![0], flags);
      h.remote.mockResolvedValueOnce(views);
      await expect(h.scope.restore('task')).rejects.toThrow('unavailable');
      expect(h.state()).toEqual(before);
      expect(h.applyModel).not.toHaveBeenCalled();
      expect(h.switchHarness).not.toHaveBeenCalled();
    },
  );
  it.each(['provider', 'model'] as const)('preserves the baseline when the remote %s is disabled after restart', async disabled => {
    const h = remoteFixture();
    const before = h.state();
    const views = remoteCatalog('openai-shared');
    if (disabled === 'provider') views[0].suspended = true;
    else views[0].models.codex![0].disabled = true;
    h.remote.mockResolvedValueOnce(views);
    await expect(h.scope.restore('task')).rejects.toThrow('unavailable');
    expect(h.state()).toEqual(before);
    expect(h.applyModel).not.toHaveBeenCalled();
    expect(h.switchHarness).not.toHaveBeenCalled();
    expect(h.guard).not.toHaveBeenCalled();
  });
  // #6759: the model can remain in the catalog after its Harness route is
  // removed or disabled. Exercise the production resolver and persisted restore.
  it.each(['agent-removed', 'route-missing', 'route-disabled'] as const)(
    'preserves the baseline when the remote Harness is unavailable: %s', async reason => {
      const h = remoteFixture();
      const before = h.state();
      const views = remoteCatalog('openai-shared');
      if (reason === 'agent-removed') views[0].agents = [];
      else if (reason === 'route-missing') views[0].routing = {};
      else views[0].routing.codex!.disabled = true;
      h.remote.mockResolvedValueOnce(views);
      await expect(createScheduledModelScope(h.deps).restore('task')).rejects.toThrow('unavailable');
      expect(h.state()).toEqual(before);
      expect(h.applyModel).not.toHaveBeenCalled();
      expect(h.switchHarness).not.toHaveBeenCalled();
      expect(h.guard).not.toHaveBeenCalled();
    },
  );
  it.each(['archived', 'deleted', 'missing'])('defers a %s replacement to the runner without querying either catalog', async status => {
    const h = remoteFixture('share:test', status);
    const before = h.state();
    h.remote.mockRejectedValue(new Error('REMOTE_AGENT_SHARE_PAUSED'));
    const localChoice = { ...remoteChoice, providerId: 'openai' };
    await expect(h.apply('task', localChoice)).resolves.toEqual(localChoice);
    expect(h.remote).not.toHaveBeenCalled();
    expect(h.guard).not.toHaveBeenCalled();
    expect(h.applyModel).not.toHaveBeenCalled();
    expect(h.switchHarness).not.toHaveBeenCalled();
    expect(h.state()).toEqual(before);
  });
  it.each(['archived', 'deleted'])('preserves the saved remote source for runner recovery of a %s target', async status => {
    const h = remoteFixture('share:test', status);
    await expect(h.apply('task', remoteChoice)).resolves.toEqual(remoteChoice);
    expect(h.remote).not.toHaveBeenCalled();
    expect(h.applyModel).not.toHaveBeenCalled();
    expect(h.switchHarness).not.toHaveBeenCalled();
  });
  it('retains the scope and task when the sharing host rejects access', async () => {
    const h = remoteFixture();
    h.remote.mockRejectedValueOnce(new Error('REMOTE_AGENT_SHARE_PAUSED'));
    await expect(h.scope.restore('task')).rejects.toThrow('REMOTE_AGENT_SHARE_PAUSED');
    expect(h.state().baseline).not.toBeNull();
    expect(h.applyModel).not.toHaveBeenCalled();
    expect(h.guard).not.toHaveBeenCalled();
  });
  it('rejects a missing local provider without guessing a remote source', async () => {
    const h = remoteFixture(null);
    await expect(h.scope.restore('task')).rejects.toThrow('provider unavailable');
    expect(h.remote).not.toHaveBeenCalled();
    expect(h.state().baseline).not.toBeNull();
  });
});
