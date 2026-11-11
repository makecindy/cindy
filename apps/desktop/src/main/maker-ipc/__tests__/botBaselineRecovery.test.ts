import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { ProviderView } from '@cindy/model-providers';
import { createIpcError } from '../../../shared/ipc-errors';
import { checkDeviceRoute } from '../../remote-agent/controller/deviceRouteCheck';
import { createBotModelRouteApplier, createBotModelRouteReconciler } from '../botModelRouteReconciler';
import { applyScheduledModelSelection, createScheduledModelScope, createScheduledModelSelectionResolver, resolveScheduledModelSelection, type ScheduledModelSelection } from '../scheduledModelSelection';
import { readSshCodexModelList } from '../../remote-ssh/codex-model-list';
import type { BotModelRoute } from '../../../shared/botModelChain';
import { projectSessionRuntimeControl } from '../sessionRuntimeControl';

// Regression for #7177/#7428: an unavailable frozen selection used to reject
// every input before dispatch, despite a usable saved companion configuration.
// Exercise the real scope, reconciler and runtime applier together (unit tier).
function fixture() {
  const saved: ScheduledModelSelection = { agentKind: 'pi', model: 'saved', providerId: 'current', effort: null, fastMode: false };
  const old = JSON.stringify({ ...saved, providerId: 'removed', scopeId: 'old' });
  const state = { chain: [{ harness: 'pi' as const, model: saved.model, providerId: saved.providerId, effort: '' as const, fastMode: false }] as BotModelRoute[],
    current: { ...saved }, hasRuntimeOverride: true, followsCindyDefault: false, scheduledModelBaseline: old as string | null };
  let owner = 'one';
  let activeBot = true;
  let restoreError: Error | null = createIpcError('MODEL_SELECTION_UNAVAILABLE', 'old source unavailable');
  const stage = vi.fn(async (_id: string, route: typeof state.current): Promise<typeof state.current | void> => { state.current = { ...route }; });
  const clear = vi.fn(async (_id: string, expected?: string | null) => {
    if (state.scheduledModelBaseline !== expected) return false;
    state.scheduledModelBaseline = null;
    return true;
  });
  const onApplied = vi.fn(async () => { state.scheduledModelBaseline = null; });
  const applier = createBotModelRouteApplier({ stage, isIdle: () => true,
    applyPendingSwitch: async () => {}, hasPendingSwitch: () => false, onApplied });
  const reconcile = createBotModelRouteReconciler({ ownerEpoch: () => owner,
    read: async () => activeBot ? state : null, apply: applier, onSelectionAccepted: clear });
  const write = vi.fn(async () => { throw new Error('normal restore must not write the old route after recovery'); });
  const recover = vi.fn((id: string, baseline: string) => reconcile.recoverUnavailableBaseline(id, baseline));
  const scope = createScheduledModelScope({ createId: () => 'new', ownerEpoch: () => owner, isBusy: () => false,
    read: async () => ({ profile: state.current, baseline: state.scheduledModelBaseline }), write,
    apply: async (_id, route) => { if (restoreError) throw restoreError; state.current = { ...route }; },
    recoverUnavailableBaseline: recover });
  return { old, state, saved, scope, reconcile, stage, clear, recover, write, onApplied,
    setError: (error: Error | null) => { restoreError = error; },
    changeOwner: () => { owner = 'two'; }, disableBot: () => { activeBot = false; } };
}

describe('automatic companion baseline recovery', () => {
  it('accepts saved settings even when they equal the current route, then permits repeated input', async () => {
    const h = fixture();
    let dispatches = 0;
    for (let i = 0; i < 3; i++) {
      await h.scope.restore('bot');
      await h.reconcile('bot', true);
      dispatches++;
    }
    expect(dispatches).toBe(3);
    expect(h.stage).toHaveBeenCalledTimes(1); // Must validate/apply even a no-op route.
    expect(h.state.scheduledModelBaseline).toBeNull();
    expect(h.state.current).toEqual(h.saved);
    expect(h.clear).toHaveBeenCalledWith('bot', h.old);
    expect(h.onApplied).not.toHaveBeenCalled(); // No unconditional early cleanup.
    expect(h.write).not.toHaveBeenCalled(); // No old route persistence after fallback.
  });
  it('dispatches after the ordinary switch rebinds the saved provider', async () => {
    const h = fixture();
    h.stage.mockImplementation(async (_id, route) => {
      const resolved = { ...route, providerId: 'xai' };
      h.state.current = resolved;
      return resolved;
    });
    await h.scope.restore('bot');
    expect(h.state.current.providerId).toBe('xai');
    expect(h.state.scheduledModelBaseline).toBeNull();
    expect(h.clear).toHaveBeenCalledWith('bot', h.old);
  });
  // #7471 review: group membership is committed only by the pending switch.
  // Unit: a valid member must unblock input; unrelated/stale bindings must not.
  it.each(['local-group', 'remote-group', 'wrong-group', 'wrong-owner', 'stale-binding', 'wrong-model', 'wrong-harness'] as const)(
    'checks the committed group member before retiring a baseline: %s', async (outcome) => {
      const h = fixture();
      const groupDeviceId = outcome === 'local-group' ? null : 'group-owner';
      const route = { ...h.saved, providerId: 'group-entry', agentDeviceId: groupDeviceId };
      h.state.chain = [{ ...h.state.chain[0]!, providerId: route.providerId, agentDeviceId: groupDeviceId }];
      let pending = false;
      const applier = createBotModelRouteApplier({
        stage: async () => { pending = true; return route; }, isIdle: () => true,
        applyPendingSwitch: async () => {
          h.state.current = { ...h.saved, providerId: 'member-provider', agentDeviceId: 'member-device',
            ...(outcome === 'wrong-model' ? { model: 'unrelated' } : {}),
            ...(outcome === 'wrong-harness' ? { agentKind: 'codex' as const } : {}) };
          pending = false;
        },
        hasPendingSwitch: () => pending, onApplied: h.onApplied,
      });
      const reconcile = createBotModelRouteReconciler({ ownerEpoch: () => 'one', read: async () => h.state,
        apply: applier, onSelectionAccepted: h.clear,
        readAppliedGroup: async () => outcome === 'stale-binding' ? null : ({
          providerId: outcome === 'wrong-group' ? 'another-group' : route.providerId,
          groupDeviceId: outcome === 'wrong-owner' ? 'another-owner' : groupDeviceId,
        }),
      });
      if (outcome === 'local-group' || outcome === 'remote-group') {
        await expect(reconcile.recoverUnavailableBaseline('bot', h.old)).resolves.toBe(true);
        expect(h.state.scheduledModelBaseline).toBeNull();
        expect(h.state.current.providerId).toBe('member-provider');
      } else {
        await expect(reconcile.recoverUnavailableBaseline('bot', h.old)).rejects.toThrow('did not become ready');
        expect(h.state.scheduledModelBaseline).toBe(h.old);
        expect(h.clear).not.toHaveBeenCalled();
      }
    });
  it.each([false, true])('preserves a later runtime fallback after recovery (default=%s)', async (followsCindyDefault) => {
    const h = fixture();
    h.state.followsCindyDefault = followsCindyDefault;
    await h.scope.restore('bot');
    h.state.current = { ...h.saved, model: 'working-fallback' };
    await h.reconcile('bot', true);
    await h.reconcile('bot', true);
    expect(h.stage).toHaveBeenCalledTimes(1);
    expect(h.state.current.model).toBe('working-fallback');
    expect(await h.reconcile.preview('bot')).toEqual(h.state.current);
  });
  it('keeps recovery state when the configuration source changes during application', async () => {
    const h = fixture();
    h.stage.mockImplementation(async (_id, route) => {
      h.state.current = { ...route };
      h.state.followsCindyDefault = true;
    });
    await expect(h.scope.restore('bot')).rejects.toThrow('changed');
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.state.scheduledModelBaseline).toBe(h.old);
  });
  it('retains recovery state when the resolved provider does not land', async () => {
    const h = fixture();
    h.stage.mockImplementation(async (_id, route) => ({ ...route, providerId: 'xai' }));
    await expect(h.scope.restore('bot')).rejects.toThrow('did not become ready');
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.state.scheduledModelBaseline).toBe(h.old);
  });
  it('keeps the old record if the saved route also fails', async () => {
    const h = fixture();
    h.stage.mockRejectedValue(new Error('saved route unavailable'));
    await expect(h.scope.restore('bot')).rejects.toThrow('saved route unavailable');
    expect(h.state.scheduledModelBaseline).toBe(h.old);
    expect(h.clear).not.toHaveBeenCalled();
  });
  it('does not consume state when the final compare-and-set loses', async () => {
    const h = fixture();
    h.clear.mockResolvedValue(false);
    await expect(h.scope.restore('bot')).rejects.toThrow('changed');
    expect(h.state.scheduledModelBaseline).toBe(h.old);
  });
  it('keeps recovery state when a switch returns without landing the saved route', async () => {
    const h = fixture();
    h.state.current = { ...h.saved, model: 'temporary-automation' };
    h.stage.mockResolvedValue(undefined);
    await expect(h.scope.restore('bot')).rejects.toThrow('did not become ready');
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.state.scheduledModelBaseline).toBe(h.old);
  });
  it.each(['REMOTE_AGENT_DEVICE_UNREACHABLE', 'REMOTE_AGENT_SHARE_UNAVAILABLE', 'PRECONDITION_FAILED', 'INVALID_PARAMS', 'HARNESS_SWITCH_NOT_READY'] as const)(
    'does not replace a choice after %s', async (code) => {
      const h = fixture();
      const error = createIpcError(code, 'temporary or unrelated failure');
      h.setError(error);
      await expect(h.scope.restore('bot')).rejects.toBe(error);
      expect(h.recover).not.toHaveBeenCalled();
      expect(h.state.scheduledModelBaseline).toBe(h.old);
    });
  it('preserves the original error for an ordinary or inactive companion task', async () => {
    const h = fixture();
    h.disableBot();
    await expect(h.scope.restore('ordinary')).rejects.toThrow('old source unavailable');
    expect(h.stage).not.toHaveBeenCalled();
    expect(h.state.scheduledModelBaseline).toBe(h.old);
  });
  it('does not consume a newer scope created during validation', async () => {
    const h = fixture();
    const newer = h.old.replace('old', 'new');
    h.stage.mockImplementation(async () => { h.state.scheduledModelBaseline = newer; });
    await expect(h.scope.restore('bot')).rejects.toThrow('changed');
    expect(h.state.scheduledModelBaseline).toBe(newer);
    expect(h.clear).not.toHaveBeenCalled();
  });
  it('does not clear state after an account change', async () => {
    const h = fixture();
    h.stage.mockImplementation(async () => { h.changeOwner(); });
    await expect(h.scope.restore('bot')).rejects.toThrow('owner changed');
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.state.scheduledModelBaseline).toBe(h.old);
  });
  it('does not consume a newer saved configuration during application', async () => {
    const h = fixture();
    h.stage.mockImplementation(async () => {
      h.state.chain = [{ ...h.state.chain[0]!, model: 'newer' }];
      h.reconcile.invalidate('bot');
    });
    await expect(h.scope.restore('bot')).rejects.toThrow('changed');
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.state.scheduledModelBaseline).toBe(h.old);
  });
  it('retains a record while the saved runtime switch is still pending', async () => {
    const h = fixture();
    const pendingApply = createBotModelRouteApplier({ stage: h.stage, isIdle: () => false,
      hasPendingSwitch: () => true, applyPendingSwitch: async () => {}, onApplied: h.onApplied });
    const reconcile = createBotModelRouteReconciler({ ownerEpoch: () => 'one', read: async () => h.state,
      apply: pendingApply, onSelectionAccepted: h.clear });
    await expect(reconcile.recoverUnavailableBaseline('bot', h.old)).rejects.toThrow('pending');
    expect(h.state.scheduledModelBaseline).toBe(h.old);
    expect(h.clear).not.toHaveBeenCalled();
  });
  it('leaves explicit saves and mismatched scheduled cleanup to their existing paths', async () => {
    const h = fixture();
    await h.scope.restore('bot', 'other-scope');
    h.state.scheduledModelBaseline = JSON.stringify({ ...JSON.parse(h.old), pendingBotProfileVersion: 'v2' });
    await h.scope.restore('bot');
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.stage).not.toHaveBeenCalled();
  });
});

// Run the actual register.ts validation functions: restoration must recognize
// deterministic rejection without treating offline/payment failures as obsolete
// preferences. Ordinary picker and cross-device IPC error codes stay unchanged.
const register = ts.createSourceFile('register.ts', readFileSync(new URL('../register.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
function registeredFunction(name: string, deps: Record<string, unknown>) {
  let declaration: ts.FunctionDeclaration | ts.ArrowFunction | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node;
    if (ts.isVariableDeclaration(node) && node.name.getText(register) === name && node.initializer && ts.isArrowFunction(node.initializer)) declaration = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(register);
  if (!declaration) throw new Error('Production function missing: ' + name);
  const js = ts.transpileModule('return (' + declaration.getText(register) + ');', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(deps), js)(...Object.values(deps));
}
it.each(['same-harness', 'same-harness-staged', 'cross-harness', 'back-to-task-device'] as const)('returns the validated provider from %s production staging', async (path) => {
  const route = { agentDeviceId: null, agentKind: 'pi', model: 'saved', providerId: 'gateway', effort: null, fastMode: false };
  const apply = vi.fn(async () => path === 'same-harness-staged'
    ? { deferred: true, superseded: false, pendingUntilSend: true } : { effectiveProviderId: 'xai' });
  const switchAgent = vi.fn(async () => {});
  const stage = registeredFunction('stageSessionRouteSelection', {
    readSessionAgentDeviceId: async () => path === 'back-to-task-device' ? 'other-device' : null,
    performSessionAgentSwitch: switchAgent, agentSwitchDeps: {},
    agentSwitchPending: { get: () => ({ targetAgentKind: 'pi', model: 'saved', providerId: 'xai' }) },
    applyWithVerifiedModelWindow: (run: () => unknown) => run(), applySessionRuntimeSelection: apply,
  });
  const sameHarness = path === 'same-harness' || path === 'same-harness-staged';
  await expect(stage('bot', route, sameHarness ? 'pi' : 'codex')).resolves.toMatchObject({
    agentKind: 'pi', model: 'saved', providerId: 'xai',
  });
  expect(apply).toHaveBeenCalledTimes(sameHarness ? 1 : 0);
  if (path === 'back-to-task-device') {
    expect(switchAgent).toHaveBeenCalledWith({}, expect.objectContaining({ agentDeviceId: null }));
  }
});
it.each(['claude-code', 'codex', 'pi'] as const)('restores all projected axes after recovering a legacy baseline to %s', (agentKind) => {
  const project = registeredFunction('projectScheduledPreferences', {
    projectSessionRuntimeControl, makerToDbAgentKind: (kind: string) => kind,
  });
  const baseline = { agentKind: 'codex' as const, model: 'old', providerId: 'removed', effort: null, fastMode: false };
  const legacy = project('projection-test', baseline);
  expect(legacy.runtimeBaselineRecoveryPending).toBe(true);
  expect(legacy.runtimeEffective).toEqual(baseline); // Does not assert a different/available source.
  expect(project('projection-test', { ...baseline, pendingBotProfileVersion: 2 }).runtimeBaselineRecoveryPending).toBe(false);
  const recovered = { ...baseline, agentKind, model: 'saved-model', providerId: 'saved' };
  const cleared = { ...legacy, ...projectSessionRuntimeControl('projection-test', recovered) };
  expect(cleared.runtimeBaselineRecoveryPending).toBe(false); // Shallow-merged patches cannot retain the offer.
  expect(cleared.agentKind).toBe(agentKind === 'claude-code' ? 'cc' : agentKind);
  expect(cleared.runtimeEffective).toEqual(recovered);
});
describe('SSH baseline restoration through production profile application', () => {
  it.each(['valid-remote-only', 'absent-on-host', 'host-offline', 'payment-required'] as const)('%s uses the SSH catalog before deciding recovery', async (outcome) => {
    const saved: ScheduledModelSelection = { agentKind: 'codex', model: 'profile-model', providerId: 'openai', effort: 'low', fastMode: false };
    const frozen = { ...saved, model: 'remote-override', effort: 'high' as const, fastMode: true };
    const original = JSON.stringify({ ...frozen, scopeId: 'ssh-run' });
    let baseline: string | null = original;
    let applied: ScheduledModelSelection | undefined;
    const views = [{ id: 'openai', connected: true, agents: ['codex'], source: 'user', routing: { codex: {} }, models: { codex: [{
      id: outcome === 'absent-on-host' ? 'profile-model' : frozen.model,
      efforts: ['low', 'high'], defaultEffort: 'low', supportsFastMode: true,
      ...(outcome === 'payment-required' ? { availability: 'requires_payment' as const } : {}),
    }] } }] as ProviderView[];
    const ssh = vi.fn(async () => {
      if (outcome === 'host-offline') throw new Error('SSH connection closed');
      return views;
    });
    const local = vi.fn(async () => { throw createIpcError('MODEL_SELECTION_UNAVAILABLE', 'not in local catalog'); });
    const apply = registeredFunction('applyScheduledProfile', {
      applyScheduledModelSelection, createScheduledModelSelectionResolver, resolveScheduledModelSelection,
      readSshCodexModelList, listSshCodexProviders: ssh,
      agentSwitchDeps: { getSessionRow: async () => ({ agentKind: 'codex', status: 'active', remoteHostId: 'ssh-builder', agentDeviceId: 'stale-device' }) },
      dbToMakerAgentKind: (kind: string) => kind,
      isSessionInTurn: () => false, maker: { getSession: () => undefined },
      readUsableAgentDeviceProviders: vi.fn(() => { throw new Error('must not query another computer'); }),
      assertModelRouteUsable: local, resolveScheduledModelSelectionLive: local,
      applySessionRuntimeSelection: async (_id: string, model: string, providerId: string, axes: Pick<ScheduledModelSelection, 'effort' | 'fastMode'>) => {
        applied = { ...frozen, model, providerId, ...axes };
        return {};
      },
      runtimeSelectionRequiresModelWindowConfirmation: () => false,
    });
    const recover = vi.fn(async () => { applied = saved; baseline = null; return true; });
    const scope = createScheduledModelScope({
      createId: () => 'new', isBusy: () => false,
      read: async () => ({ profile: saved, baseline }),
      write: async () => { baseline = null; },
      apply: async (id, route) => { await apply(id, route); },
      recoverUnavailableBaseline: recover,
    });
    if (outcome === 'payment-required') {
      await expect(scope.restore('ssh-bot')).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
      expect(baseline).toBe(original);
      expect(applied).toBeUndefined();
      expect(recover).not.toHaveBeenCalled();
    } else if (outcome === 'host-offline') {
      await expect(scope.restore('ssh-bot')).rejects.toMatchObject({ code: 'SSH_EXEC_FAILED' });
      expect(baseline).toBe(original);
      expect(applied).toBeUndefined();
      expect(recover).not.toHaveBeenCalled();
    } else {
      await scope.restore('ssh-bot');
      expect(baseline).toBeNull();
      if (outcome === 'valid-remote-only') {
        expect(applied).toEqual(frozen);
        expect(recover).not.toHaveBeenCalled();
      } else {
        expect(recover).toHaveBeenCalledWith('ssh-bot', original);
      }
    }
    expect(ssh).toHaveBeenCalledWith('ssh-builder');
    expect(local).not.toHaveBeenCalled();
  });
});
// #7471 review: entry existence in checkDeviceRoute does not establish payment
// admission. Exercise the remote catalog resolver inside the real restore scope.
it.each([
  ['requires_payment', 'source'], ['requires_payment', null], ['retired', 'source'],
] as const)('keeps remote payment failures distinct from obsolete models: %s / %s', async (reason, providerId) => {
  const saved: ScheduledModelSelection = { agentKind: 'pi', model: 'old-model', providerId, effort: null, fastMode: false };
  const original = JSON.stringify({ ...saved, agentDeviceId: 'execution-pc', scopeId: 'run' });
  let baseline: string | null = original;
  const views = [{ id: 'source', connected: true, source: 'user', agents: ['pi'], routing: { pi: {} },
    models: { pi: [{ id: saved.model, ...(reason === 'requires_payment'
      ? { availability: reason } : { status: reason }) }] } }] as ProviderView[];
  const recover = vi.fn(async () => { baseline = null; return true; });
  const applyModel = vi.fn();
  const resolve = createScheduledModelSelectionResolver({
    readRemoteProviders: async () => {
      expect(await checkDeviceRoute(async () => views, 'pi', saved.providerId, saved.model)).toBeNull();
      return views;
    },
    readSshCodexProviders: async () => { throw new Error('unexpected SSH read'); },
    resolveLocalSelection: async () => { throw new Error('unexpected local read'); },
  });
  const scope = createScheduledModelScope({ createId: () => 'new', isBusy: () => false,
    read: async () => ({ profile: saved, baseline }), write: async () => { baseline = null; },
    apply: async (_id, selection) => { await applyScheduledModelSelection(selection, {
      getTarget: async () => ({ agentKind: 'pi', status: 'active', agentDeviceId: 'execution-pc' }),
      isBusy: () => false, resolveSelection: resolve, applyModel,
      switchHarness: async () => { throw new Error('unexpected switch'); },
    }); }, recoverUnavailableBaseline: recover,
  });
  if (reason === 'requires_payment') {
    await expect(scope.restore('bot')).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(baseline).toBe(original);
    expect(recover).not.toHaveBeenCalled();
  } else {
    await scope.restore('bot');
    expect(recover).toHaveBeenCalledWith('bot', original);
    expect(baseline).toBeNull();
  }
  expect(applyModel).not.toHaveBeenCalled();
});
describe('production restoration rejection classification', () => {
  const throwIpcError = (code: Parameters<typeof createIpcError>[0], message: string): never => { throw createIpcError(code, message); };
  it.each(['explicit-source-unavailable', 'explicit-source-disabled', 'model-retired', 'payment-required'])('%s retains ordinary semantics and marks only recoverable restoration failures', async (reason) => {
    const guard = registeredFunction('assertModelRouteUsable', { throwIpcError,
      verdictForModelRoute: async () => ({ kind: 'reject', reason }), describeModelRouteRejection: () => reason });
    await expect(guard('pi', 'saved', 'old')).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(guard('pi', 'saved', 'old', undefined, 'MODEL_SELECTION_UNAVAILABLE')).rejects.toMatchObject({
      code: reason === 'payment-required' ? 'INVALID_PARAMS' : 'MODEL_SELECTION_UNAVAILABLE',
    });
  });
  it.each(['not-offered', 'REMOTE_AGENT_SHARE_REMOVED', 'REMOTE_AGENT_SHARE_PAUSED', 'unreachable', 'REMOTE_AGENT_SHARE_UNAVAILABLE'])(
    'classifies remote %s before IPC downgrade, retaining transient errors', async (rejection) => {
      const read = registeredFunction('readUsableAgentDeviceProviders', { throwIpcError, checkDeviceRoute,
        remoteBackgroundInvoke: vi.fn(), isProviderShareAgentDeviceId: () => false,
        isDeviceLinkInvoke: () => true, log: { warn: vi.fn() },
        readDeviceProviderViews: async () => {
          if (rejection === 'not-offered') return [];
          throw new Error(rejection === 'unreachable' ? 'offline' : '[' + rejection + ']');
        } });
      await expect(read('device', 'pi', 'model', 'old')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      await expect(read('device', 'pi', 'model', 'old', 'MODEL_SELECTION_UNAVAILABLE')).rejects.toMatchObject({
        code: rejection === 'not-offered' || rejection === 'REMOTE_AGENT_SHARE_REMOVED'
          ? 'MODEL_SELECTION_UNAVAILABLE' : 'PRECONDITION_FAILED',
      });
    });
});
