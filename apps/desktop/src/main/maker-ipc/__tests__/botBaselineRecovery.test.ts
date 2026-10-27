import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createIpcError } from '../../../shared/ipc-errors';
import { checkDeviceRoute } from '../../remote-agent/controller/deviceRouteCheck';
import { createBotModelRouteApplier, createBotModelRouteReconciler } from '../botModelRouteReconciler';
import { createScheduledModelScope, type ScheduledModelSelection } from '../scheduledModelSelection';
import { projectSessionRuntimeControl } from '../sessionRuntimeControl';

// Regression for #7177/#7428: an unavailable frozen selection used to reject
// every input before dispatch, despite a usable saved companion configuration.
// Exercise the real scope, reconciler and runtime applier together (unit tier).
function fixture() {
  const saved: ScheduledModelSelection = { agentKind: 'pi', model: 'saved', providerId: 'current', effort: null, fastMode: false };
  const old = JSON.stringify({ ...saved, providerId: 'removed', scopeId: 'old' });
  const state = { chain: [{ harness: 'pi' as const, model: saved.model, providerId: saved.providerId, effort: '' as const, fastMode: false }],
    current: { ...saved }, hasRuntimeOverride: true, scheduledModelBaseline: old as string | null };
  let owner = 'one';
  let activeBot = true;
  let restoreError: Error | null = createIpcError('MODEL_SELECTION_UNAVAILABLE', 'old source unavailable');
  const stage = vi.fn(async (_id: string, route: typeof state.current) => { state.current = { ...route }; });
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
it('offers legacy baseline recovery on reads/pushes and explicitly revokes it after cleanup', () => {
  const project = registeredFunction('projectScheduledPreferences', {
    projectSessionRuntimeControl, makerToDbAgentKind: (kind: string) => kind,
  });
  const baseline = { agentKind: 'pi' as const, model: 'old', providerId: 'removed', effort: null, fastMode: false };
  const legacy = project('projection-test', baseline);
  expect(legacy.runtimeBaselineRecoveryPending).toBe(true);
  expect(legacy.runtimeEffective).toEqual(baseline); // Does not assert a different/available source.
  expect(project('projection-test', { ...baseline, pendingBotProfileVersion: 2 }).runtimeBaselineRecoveryPending).toBe(false);
  const cleared = { ...legacy, ...projectSessionRuntimeControl('projection-test', { ...baseline, providerId: 'saved' }) };
  expect(cleared.runtimeBaselineRecoveryPending).toBe(false); // Shallow-merged patches cannot retain the offer.
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
