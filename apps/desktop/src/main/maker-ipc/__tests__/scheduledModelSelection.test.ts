import { describe, expect, it, vi } from 'vitest';
import type { CatalogModel, ProviderView } from '@cindy/model-providers';
import { applyScheduledModelSelection, assertScheduledHarnessSupported, resolveScheduledModelSelection, ScheduledModelSelectionBusyError, type ScheduledModelSelection } from '../scheduledModelSelection';

const selection: ScheduledModelSelection = {
  agentKind: 'pi', model: 'test-model', providerId: 'custom', effort: null, fastMode: false,
};
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
  it.each(['archived', 'deleted'])('leaves %s target recovery to the scheduler', async (status) => {
    const deps = fixture();
    deps.getTarget.mockResolvedValue({ agentKind: 'codex', status });
    await applyScheduledModelSelection(selection, deps);
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
    await applyScheduledModelSelection({ ...selection, providerId: null, fastMode: true }, deps);
    const expected = { ...selection, effort: 'medium', fastMode: false };
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
  it.each([{ remoteHostId: 'ssh-host' }, { orcaRole: 'lead' }, { orcaRole: 'worker' }])(
    'rejects cross-Harness overrides on %j while preserving same-Harness and follow modes', (restriction) => {
      const target = { agentKind: 'codex' as const, status: 'active', ...restriction };
      expect(() => assertScheduledHarnessSupported(target, 'pi')).toThrow('current Harness');
      expect(() => assertScheduledHarnessSupported(target, 'codex')).not.toThrow();
      expect(() => assertScheduledHarnessSupported(target, undefined)).not.toThrow();
    },
  );
  it('preserves ordinary local cross-Harness selection and archived-target recovery', () => {
    expect(() => assertScheduledHarnessSupported({ agentKind: 'codex', status: 'active' }, 'pi')).not.toThrow();
    expect(() => assertScheduledHarnessSupported({ agentKind: 'codex', status: 'archived', remoteHostId: 'ssh-host' }, 'pi')).not.toThrow();
    expect(() => assertScheduledHarnessSupported(null, 'pi')).not.toThrow();
  });
});
