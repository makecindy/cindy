import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import type { Effort, ProviderView } from '@cindy/model-providers';
import { getModel, reconcileInvocationEffort } from '@cindy/model-providers';
import type { RemoteProjectTarget } from '@/components/new-chat/AddRemoteProjectDialog';
import type { AgentCapabilities } from '@/hooks/useAgentCapabilities';
import { parseDeviceProvidersPayload } from '@/hooks/useDeviceProviders';
import { extractIpcError } from '@/utils/ipcError';
import { dbToMakerAgentKind, normalizeDbAgentKind } from '../../../../shared/agentKindConversion';
import { modelCatalogKey } from '../../../../shared/controlledModelCatalog';
import {
  calibrateDraftModel,
  type DraftModelCalibrationResult,
} from '../../../../shared/draftModelCalibration';
import { isProviderShareAgentDeviceId } from '../../../../shared/providerShare';
import {
  resolveDeviceLinkDraftDefaults,
  shouldReseedDeviceLinkDraftDefaults,
  type DeviceLinkDraftSelection,
  type RemoteDraftDefaults,
} from '../deviceLinkDraftDefaults';
import { isSameNewMakerDevice } from '../lib/newMakerRouteState';
import { rememberRemoteDraftDefaults } from '../remoteDraftDefaultsCache';

// Run the real async project-selection and target-transition callbacks. Only their
// React setters and IPC are replaced; catalog parsing and effort resolution stay real.
const source = ts.createSourceFile(
  'NewMakerDraftRoute.tsx',
  readFileSync(resolve(__dirname, '..', 'NewMakerDraftRoute.tsx'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const factories = new Map<string, (...args: unknown[]) => unknown>();
function compile<T>(id: string, find: (node: ts.Node) => ts.Node | undefined, bindings: Record<string, unknown>): T {
  const keys = Object.keys(bindings);
  let factory = factories.get(id);
  if (!factory) {
    let expression: ts.Node | undefined;
    const visit = (node: ts.Node) => {
      expression ??= find(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (!expression) throw new Error(`Missing draft callback: ${id}`);
    const code = ts.transpileModule(`const callback = ${expression.getText(source)};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    factory = new Function(...keys, code + ';return callback;') as (...args: unknown[]) => unknown;
    factories.set(id, factory);
  }
  return factory(...Object.values(bindings)) as T;
}
function callback<T>(name: string, bindings: Record<string, unknown>): T {
  return compile<T>(name, node => ts.isVariableDeclaration(node) && node.name.getText(source) === name
    && node.initializer && ts.isCallExpression(node.initializer)
    ? node.initializer.arguments[0]
    : undefined, bindings);
}
// Effects are anonymous, so their log line identifies them.
function effect(marker: string, bindings: Record<string, unknown>): () => void {
  return compile<() => void>(marker, node => ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect'
    && node.getText(source).includes(marker)
    ? node.arguments[0]
    : undefined, bindings);
}

function provider(id: string, efforts: Effort[]): ProviderView {
  return {
    id, name: id, source: 'user', connected: true,
    agents: ['pi'], auth: { method: 'none' },
    routing: { pi: { upstream: 'https://provider.invalid', authStrategy: 'none' } },
    models: { pi: [{
      id: 'shared-model', name: 'Shared model', contextWindow: 200_000,
      efforts, defaultEffort: efforts.at(-1) ?? null, effortsUnknown: false,
    }] },
  };
}

function selection(effort: Effort | null): DeviceLinkDraftSelection {
  return { model: 'shared-model', providerId: 'source', effort, fastMode: false, permissionMode: 'default' };
}

function harness(options: {
  sameDevice?: boolean;
  separateAgent?: boolean;
  previous?: DeviceLinkDraftSelection | null;
  targetEfforts?: Effort[];
} = {}) {
  let current = options.previous ?? null;
  const defaults: RemoteDraftDefaults = { ...selection('medium'), modelChosenByUser: true };
  // A second source makes the flat Pi effort intersection empty even though the
  // selected target source supports medium/high. It cannot replace source-level data.
  const capabilities: AgentCapabilities = {
    availableModels: [{
      id: 'shared-model', displayName: 'Shared model', contextWindow: 200_000,
      efforts: [], defaultEffort: null, effortsUnknown: false,
    }],
    hasFastMode: false, effortLevels: [],
    permissionModes: [{ id: 'default', displayName: 'Default' }],
  };
  const targetProviders = [provider('source', options.targetEfforts ?? ['medium', 'high']), provider('other', [])];
  const invoke = vi.fn(async (deviceId: string, channel: string): Promise<unknown> => {
    if (deviceId !== 'target-device') throw new Error('Unexpected device');
    switch (channel) {
      case 'maker:get-capabilities': return capabilities;
      case 'maker:provider:list': return { providers: targetProviders };
      case 'maker:get-new-maker-defaults': return defaults;
      default: throw new Error(`Unexpected channel: ${channel}`);
    }
  });
  const patchDraft = vi.fn();
  const setRemoteDraftState = vi.fn();
  const dlSeedKeyRef = { current: null as string | null };
  const bindings = {
    // These are target-machine POSIX paths, not local filesystem paths.
    draft: { vendor: 'pi', workingDir: '/remote/project' },
    effectiveDeviceLinkDeviceId: options.sameDevice ? 'target-device' : 'old-device',
    effectiveRemoteHostId: null,
    effectiveAgentDeviceId: options.separateAgent ? 'agent-device' : undefined,
    capabilityAgentKind: 'pi',
    agentCatalogProviders: [provider('source', ['low'])],
    isSameNewMakerDevice, normalizeDbAgentKind, resolveDeviceLinkDraftDefaults,
    parseDeviceProvidersPayload, extractIpcError, patchDraft, setRemoteDraftState,
    rememberRemoteDraftDefaults, wtPreferenceTransactionRef: { current: null },
    window: { electronAPI: { deviceLink: { invoke } } },
    setDlSel: (next: DeviceLinkDraftSelection | null | ((prev: DeviceLinkDraftSelection | null) => DeviceLinkDraftSelection | null)) => {
      current = typeof next === 'function' ? next(current) : next;
    },
    dlSeedKeyRef, dlSeedCapabilitiesRef: { current: null }, dlSeedDefaultsRef: { current: null },
    dlRuntimeTouchedRef: { current: true }, skipDefaultsRefetchRef: { current: false },
    wtBranchReadSeqRef: { current: 0 }, wtBranchWriteSeqRef: { current: 0 },
    wtBranchPreferenceSavingRef: { current: false }, wtBranchTargetRef: { current: null },
    wtBranchSyncRef: { current: null }, wtBranchPreferenceErrorRef: { current: false },
    wtPreferenceWriteSeqRef: { current: 0 }, wtPreferenceSavingRef: { current: false },
    stripProjectRelativeMentions: vi.fn(),
    evictDeviceCapabilities: vi.fn(), evictDeviceProviders: vi.fn(), evictDeviceGitSafetySettings: vi.fn(),
    prefetchDeviceCapabilities: vi.fn(), prefetchDeviceProviders: vi.fn(), prefetchDeviceGitSafetySettings: vi.fn(),
    setWtBranchPreferenceSaving: vi.fn(), setWtBranchSync: vi.fn(), setWtBranchPreferenceError: vi.fn(),
    setWtBaseRepo: vi.fn(), setWtSourceBranch: vi.fn(), setWtSupportsRecoveryKeyDiscard: vi.fn(),
    setWtConfirmedIneligible: vi.fn(), setWtPreferenceSaving: vi.fn(),
  };
  const applyDraftTarget = callback<(request: unknown) => void>('applyDraftTarget', bindings);
  const add = callback<(target: RemoteProjectTarget) => Promise<void>>('handleRemoteProjectAdded', { ...bindings, applyDraftTarget });
  return {
    invoke, patchDraft, setRemoteDraftState, defaults, dlSeedKeyRef,
    current: () => current,
    add: () => add({ kind: 'device-link', deviceId: 'target-device', deviceName: 'Target', path: '/remote/project' }),
  };
}

describe('remote project draft catalog ownership', () => {
  it.each([false, true])('seeds the new task device using its source-level efforts (previous separate Agent: %s)', async (separateAgent) => {
    const h = harness({ separateAgent, previous: selection('low') });
    await h.add();
    expect(h.current()).toEqual(selection('medium'));
    expect(h.dlSeedKeyRef.current).toBe('target-device:pi');
    expect(h.patchDraft).toHaveBeenCalledWith(expect.objectContaining({ deviceLinkDeviceId: 'target-device' }));
  });

  it.each([false, true])('clears effort when the target source explicitly has no efforts (same device: %s)', async (sameDevice) => {
    const h = harness({ sameDevice, previous: selection('low'), targetEfforts: [] });
    await h.add();
    expect(h.current()).toEqual(selection(null));
  });

  it('recalibrates a preserved empty selection when the same source gains effort levels', async () => {
    const h = harness({ sameDevice: true, previous: selection(null) });
    await h.add();
    expect(h.current()).toEqual(selection('high'));
  });

  it('seeds from the fresh catalog when the same device has no prior selection', async () => {
    const h = harness({ sameDevice: true });
    await h.add();
    expect(h.current()).toEqual(selection('medium'));
  });

  it('does not overwrite a separate Agent selection when refreshing the same task device', async () => {
    const previous = selection('low');
    const h = harness({ sameDevice: true, separateAgent: true, previous });
    await h.add();
    expect(h.current()).toBe(previous);
    expect(h.setRemoteDraftState).toHaveBeenCalledWith({ status: 'ready', value: h.defaults });
  });

  it('leaves the current draft intact if the target provider response is malformed', async () => {
    const previous = selection('low');
    const h = harness({ previous });
    h.invoke.mockImplementation(async (_device, channel) => channel === 'maker:provider:list' ? null : {});
    await expect(h.add()).rejects.toThrow('Invalid provider list response');
    expect(h.current()).toBe(previous);
    expect(h.patchDraft).not.toHaveBeenCalled();
    expect(h.setRemoteDraftState).not.toHaveBeenCalled();
  });
});

// A task computer's source list can offer the controller itself, which the
// controller's own device list never contains.
describe('Agent location chosen on a controlled new-task draft', () => {
  function runLocationFallback(catalogHostDeviceId: string | undefined) {
    const patchDraft = vi.fn();
    effect('selected agent computer is no longer selectable', {
      effectiveAgentDeviceId: 'controller-device',
      selectableDevices: [{ deviceId: 'task-device' }],
      selectableDevicesLoaded: true,
      controlledModelRoute: { catalogHostDeviceId },
      isProviderShareAgentDeviceId, patchDraft, log: { warn: vi.fn() },
    })();
    return patchDraft;
  }

  it('keeps a location offered by the task computer', () => {
    expect(runLocationFallback('task-device')).not.toHaveBeenCalled();
  });

  it('still drops a location missing from the device list when this computer owns that list', () => {
    expect(runLocationFallback(undefined)).toHaveBeenCalledWith({ agentDeviceId: null, agentDeviceName: null });
  });

  it('does not reseed the chosen model when its catalog is read through the task computer', () => {
    const dlSeedKeyRef = { current: null as string | null };
    const dlRuntimeTouchedRef = { current: false };
    const patchDraft = vi.fn();
    const select = callback<(selection: unknown) => void>('handleUnifiedDraftSelect', {
      setDraftFavoriteAnchor: vi.fn(), getDraft: () => ({}), switchVendor: vi.fn(), setDlSel: vi.fn(),
      normalizeDbAgentKind, dbToMakerAgentKind, modelCatalogKey, patchDraft,
      effectiveAgentDeviceId: undefined, isDeviceLinkDraft: true, deviceLinkInitial: null,
      controlledModelRoute: { catalogHostDeviceId: 'task-device' },
      dlRuntimeTouchedRef, dlSeedKeyRef, dlSeedCapabilitiesRef: { current: null },
    });
    select({
      vendor: 'codex', providerId: 'source', modelId: 'chosen', effort: 'high', fast: false,
      favoriteUid: null, agentDevice: { deviceId: 'controller-device', name: 'Controller' },
    });
    expect(patchDraft).toHaveBeenCalledWith({ agentDeviceId: 'controller-device', agentDeviceName: 'Controller' });
    // Same key useRemoteDraftSelection builds once the draft reads this routed catalog.
    expect(shouldReseedDeviceLinkDraftDefaults({
      currentSeedKey: dlSeedKeyRef.current,
      nextSeedKey: `${modelCatalogKey('controller-device', 'task-device')}:codex`,
      capabilitiesChanged: true,
      controllerTouched: dlRuntimeTouchedRef.current,
      remoteModelChosenByUser: true,
    })).toBe(false);
  });
});

// A new task whose Agent runs on another computer (or on a shared provider) resolves its
// model against **that** catalog. The local draft's model id is usually not offered there
// (the gateway models and the share host's own subscription models barely overlap), and the
// old code carried that id over unchanged: no row of the target catalog matched it, so the
// model picker came up empty on every new conversation (#9353).
describe('new task model resolves against the catalog it will use', () => {
  function providerWithModel(id: string, modelId: string): ProviderView {
    return {
      id, name: id, source: 'user', connected: true,
      agents: ['pi'], auth: { method: 'none' },
      routing: { pi: { upstream: 'https://provider.invalid', authStrategy: 'none' } },
      models: { pi: [{
        id: modelId, name: modelId, contextWindow: 200_000,
        efforts: ['medium'], defaultEffort: 'medium', effortsUnknown: false,
      }] },
    };
  }

  function calibrate(options: {
    targetProviders: ProviderView[];
    localProviders: ProviderView[];
    draftModel: string;
    chosenByUser?: boolean;
    usesDeviceCatalog?: boolean;
    rememberedModel?: string;
  }): DraftModelCalibrationResult {
    const shared = {
      usesDeviceCatalog: options.usesDeviceCatalog !== false,
      capabilityAgentKind: 'pi',
      effectiveAgentDeviceId: options.usesDeviceCatalog === false ? undefined : 'share:abc',
      recallAgentDeviceSelection: () =>
        options.rememberedModel ? { model: options.rememberedModel } : null,
      chatPrefs: {
        model: options.draftModel, effort: 'medium', permissionMode: 'auto',
        planMode: false, providerId: null,
      },
      calibrateDraftModel,
      isModelEnabled: () => true,
      sshCodexDraftHostId: null,
      draftPreferredProviderId: null,
      draftModelChosenByUser: options.chosenByUser === true,
      draftLocalProvidersLoading: false,
      autoCalibrationProviders: options.localProviders,
      deviceProvidersLoading: false,
      agentCatalogProviders: options.targetProviders,
    };
    const remote = callback<() => DraftModelCalibrationResult | null>('remoteCatalogCalibration', shared);
    const draft = callback<() => DraftModelCalibrationResult>('draftCalibration', {
      ...shared,
      remoteCatalogCalibration: remote(),
    });
    return draft();
  }

  it('picks a model the target catalog offers instead of the local draft model', () => {
    const result = calibrate({
      targetProviders: [providerWithModel('shared-source', 'shared-model')],
      localProviders: [providerWithModel('local-source', 'local-model')],
      draftModel: 'local-model',
    });
    expect(result.model).toBe('shared-model');
  });

  it('keeps the model the user picked on that computer', () => {
    const result = calibrate({
      targetProviders: [providerWithModel('shared-source', 'shared-model')],
      localProviders: [providerWithModel('local-source', 'local-model')],
      draftModel: 'local-model',
      rememberedModel: 'shared-model',
    });
    expect(result.model).toBe('shared-model');
  });

  it('falls back to the local default when the target catalog offers nothing', () => {
    const result = calibrate({
      targetProviders: [],
      localProviders: [providerWithModel('local-source', 'local-model')],
      draftModel: 'local-model',
    });
    expect(result.model).toBe('local-model');
  });

  it('keeps the local draft model on a local draft even when the user chose it', () => {
    const result = calibrate({
      usesDeviceCatalog: false,
      targetProviders: [],
      localProviders: [providerWithModel('local-source', 'local-model')],
      draftModel: 'local-model',
      chosenByUser: true,
    });
    expect(result.model).toBe('local-model');
  });
});

// A catalog that offers no model seeds an empty model id; an empty id would leave the
// composer pill blank and resolve no source, so the calibrated model takes over.
describe('new task model falls back when the seeded model is empty', () => {
  function initialModel(options: {
    deviceLinkInitial: { model: string; effort: Effort | null } | null;
    targetEfforts?: Effort[];
    localEffort?: Effort | null;
    rememberedEffort?: Effort;
  }): { model: string; effort: Effort | null } {
    const initial = compile<() => { model: string; effort: Effort | null }>(
      'draftInitialModel',
      (node) =>
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.name.elements.some((element) => element.name.getText(source) === 'draftInitialModel') &&
        node.initializer &&
        ts.isCallExpression(node.initializer)
          ? node.initializer.arguments[0]
          : undefined,
      {
        usesDeviceCatalog: true,
        deviceLinkInitial: options.deviceLinkInitial,
        calibratedDraftModel: 'shared-model',
        localDraftEffort: options.localEffort ?? 'medium',
        agentCatalogProviders: [
          providerWithEfforts('shared-source', 'shared-model', options.targetEfforts ?? ['medium']),
        ],
        capabilityAgentKind: 'pi',
        effectiveAgentDeviceId: 'share:abc',
        recallAgentDeviceSelection: () =>
          options.rememberedEffort ? { model: 'shared-model', effort: options.rememberedEffort } : null,
        getModel,
        reconcileInvocationEffort,
      },
    );
    return initial();
  }

  function providerWithEfforts(id: string, modelId: string, efforts: Effort[]): ProviderView {
    return {
      id, name: id, source: 'user', connected: true,
      agents: ['pi'], auth: { method: 'none' },
      routing: { pi: { upstream: 'https://provider.invalid', authStrategy: 'none' } },
      models: { pi: [{
        id: modelId, name: modelId, contextWindow: 200_000,
        efforts, defaultEffort: efforts[0] ?? null, effortsUnknown: false,
      }] },
    };
  }

  it('uses the seeded model when the catalog offers one', () => {
    expect(initialModel({ deviceLinkInitial: { model: 'seeded-model', effort: 'high' } }))
      .toEqual({ model: 'seeded-model', effort: 'high' });
  });

  it('uses the calibrated model when the seeded model is empty', () => {
    expect(initialModel({ deviceLinkInitial: { model: '', effort: null } }))
      .toEqual({ model: 'shared-model', effort: 'medium' });
  });

  // Codex review #9369: the local effort pref is not validated against the target model —
  // a local high would sit in the pill next to a medium-only target model until send.
  it('re-resolves the local effort pref against the target model', () => {
    expect(initialModel({
      deviceLinkInitial: { model: '', effort: null },
      targetEfforts: ['low', 'medium'],
      localEffort: 'high',
    })).toEqual({ model: 'shared-model', effort: 'low' });
  });

  it('keeps the effort the user picked on that device when the target model supports it', () => {
    expect(initialModel({
      deviceLinkInitial: { model: '', effort: null },
      targetEfforts: ['low', 'medium'],
      localEffort: 'high',
      rememberedEffort: 'medium',
    })).toEqual({ model: 'shared-model', effort: 'medium' });
  });
});
