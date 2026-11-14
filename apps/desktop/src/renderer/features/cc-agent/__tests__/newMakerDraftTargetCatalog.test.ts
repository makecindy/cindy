import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import type { Effort, ProviderView } from '@cindy/model-providers';
import { chatEligibleSourcesForModel, effectiveSourceIdForModel, getModel, isModelSelectableForNewRoute, reconcileInvocationEffort } from '@cindy/model-providers';
import { isDeviceModelVisible, resolveFastSupported } from '@/lib/providerModels';
import type { RemoteProjectTarget } from '@/components/new-chat/AddRemoteProjectDialog';
import type { AgentCapabilities } from '@/hooks/useAgentCapabilities';
import { parseDeviceProvidersPayload } from '@/hooks/useDeviceProviders';
import { extractIpcError } from '@/utils/ipcError';
import { dbToMakerAgentKind, normalizeDbAgentKind } from '../../../../shared/agentKindConversion';
import { modelCatalogKey } from '../../../../shared/controlledModelCatalog';
import {
  calibrateDraftModel,
  filterHealthyDraftProviders,
  pickDraftProviderForModel,
  resolveDraftFastProviderId,
  resolveDraftProviderForModel,
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
function compile<T>(
  id: string,
  find: (node: ts.Node) => ts.Node | undefined,
  bindings: Record<string, unknown>,
  src: ts.SourceFile = source,
  cache: Map<string, (...args: unknown[]) => unknown> = factories,
): T {
  const keys = Object.keys(bindings);
  let factory = cache.get(id);
  if (!factory) {
    let expression: ts.Node | undefined;
    const visit = (node: ts.Node) => {
      expression ??= find(node);
      ts.forEachChild(node, visit);
    };
    visit(src);
    if (!expression) throw new Error(`Missing draft callback: ${id}`);
    const code = ts.transpileModule(`const callback = ${expression.getText(src)};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    factory = new Function(...keys, code + ';return callback;') as (...args: unknown[]) => unknown;
    cache.set(id, factory);
  }
  return factory(...Object.values(bindings)) as T;
}
function callback<T>(name: string, bindings: Record<string, unknown>): T {
  return compile<T>(name, node => ts.isVariableDeclaration(node) && node.name.getText(source) === name
    && node.initializer && ts.isCallExpression(node.initializer)
    ? node.initializer.arguments[0]
    : undefined, bindings);
}
// 目标目录里**可选**的型号清单:与路由同一份过滤(新路由准入 + 被控端自己的显示/隐藏)。
function selectableProviders(
  providers: ProviderView[],
  overrides?: Record<string, boolean>,
): ProviderView[] {
  return callback<() => ProviderView[]>('targetSelectableProviders', {
    usesDeviceCatalog: true,
    agentCatalogProviders: providers,
    capabilityAgentKind: 'pi',
    deviceModelVisibilityOverrides: overrides,
    isModelSelectableForNewRoute,
    isDeviceModelVisible,
  })();
}

// Effects are anonymous, so their log line identifies them.
function effect(marker: string, bindings: Record<string, unknown>): () => void {
  return compile<() => void>(marker, node => ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect'
    && node.getText(source).includes(marker)
    ? node.arguments[0]
    : undefined, bindings);
}

// 播种 effect 在 useRemoteDraftDefaults.ts（不是路由文件），单独开一份源文件编译。
const defaultsSource = ts.createSourceFile(
  'useRemoteDraftDefaults.ts',
  readFileSync(resolve(__dirname, '..', 'useRemoteDraftDefaults.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const defaultsFactories = new Map<string, (...args: unknown[]) => unknown>();
function defaultsEffect(marker: string, bindings: Record<string, unknown>): () => void {
  return compile<() => void>(marker, node => ts.isCallExpression(node)
    && node.expression.getText(defaultsSource) === 'useEffect'
    && node.getText(defaultsSource).includes(marker)
    ? node.arguments[0]
    : undefined, bindings, defaultsSource, defaultsFactories);
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
    dlRuntimeTouchedRef: { current: true }, dlExplicitChoiceRef: { current: false },
    skipDefaultsRefetchRef: { current: false },
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
      dlRuntimeTouchedRef, dlExplicitChoiceRef: { current: false },
      dlSeedKeyRef, dlSeedCapabilitiesRef: { current: null },
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
  function providerWithModel(
    id: string,
    modelId: string,
    options: {
      connected?: boolean;
      suspended?: boolean;
      access?: ProviderView['access'];
      retired?: boolean;
      requiresPayment?: boolean;
    } = {},
  ): ProviderView {
    return {
      id, name: id, source: 'user', connected: options.connected !== false,
      ...(options.suspended ? { suspended: true } : {}),
      ...(options.access ? { access: options.access } : {}),
      agents: ['pi'], auth: { method: 'none' },
      routing: { pi: { upstream: 'https://provider.invalid', authStrategy: 'none' } },
      models: { pi: [{
        id: modelId, name: modelId, contextWindow: 200_000,
        efforts: ['medium'], defaultEffort: 'medium', effortsUnknown: false,
        ...(options.retired ? { status: 'retired' } : {}),
        ...(options.requiresPayment ? { availability: 'requires_payment' as const } : {}),
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
    rememberedProviderId?: string | null;
    /** 记忆里的来源是用户选的,还是自动播种的(agentDeviceDraftMemory 一直写这个标记)。 */
    rememberedChosenByUser?: boolean;
    modelVisibilityOverrides?: Record<string, boolean>;
  }): DraftModelCalibrationResult {
    const shared = {
      usesDeviceCatalog: options.usesDeviceCatalog !== false,
      capabilityAgentKind: 'pi',
      effectiveAgentDeviceId: options.usesDeviceCatalog === false ? undefined : 'share:abc',
      // 真实记忆总是带这个标记(rememberAgentDeviceSelection 每次都写):true = 用户选的,
      // false = 自动播种的。缺标记的老记忆按「用户选的」处理,与设备快照同一保守口径。
      recallAgentDeviceSelection: () =>
        options.rememberedModel || options.rememberedProviderId
          ? {
              model: options.rememberedModel,
              providerId: options.rememberedProviderId ?? null,
              modelChosenByUser: options.rememberedChosenByUser !== false,
            }
          : null,
      chatPrefs: {
        model: options.draftModel, effort: 'medium', permissionMode: 'auto',
        planMode: false, providerId: null,
      },
      calibrateDraftModel,
      chatEligibleSourcesForModel,
      filterHealthyDraftProviders,
      pickDraftProviderForModel,
      isModelEnabled: () => true,
      sshCodexDraftHostId: null,
      draftPreferredProviderId: null,
      draftModelChosenByUser: options.chosenByUser === true,
      draftLocalProvidersLoading: false,
      autoCalibrationProviders: options.localProviders,
      deviceProvidersLoading: false,
      agentCatalogProviders: options.targetProviders,
    };
    // 目标目录里可选的型号清单:同一份过滤只做一次,校准与播种都用它。
    const targetSelectableProviders = selectableProviders(
      options.targetProviders, options.modelVisibilityOverrides);
    const remote = callback<() => DraftModelCalibrationResult | null>('remoteCatalogCalibration', {
      ...shared, targetSelectableProviders,
    });
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

  // Codex review #9369:记忆里那家来源若是**自动播种**的(modelChosenByUser === false),
  // 它就不是用户选的来源 —— 清单发现失败时应当让位给目录里健康的那家,而不是把首条消息
  // 钉在发不出去的来源上。健康过滤里的那道「显式选择例外」只对用户真选过的那家生效。
  it('yields an automatically seeded source that failed discovery to a healthy source', () => {
    const failed = providerWithModel('auto-source', 'stale-model');
    failed.modelDiscoveryFailure = { kind: 'unauthorized', at: '2026-11-13T00:00:00Z' };
    const result = calibrate({
      targetProviders: [failed, providerWithModel('healthy-source', 'healthy-model')],
      localProviders: [providerWithModel('local-source', 'local-model')],
      draftModel: 'local-model',
      rememberedModel: 'stale-model',
      rememberedProviderId: 'auto-source',
      rememberedChosenByUser: false,
    });
    expect(result.model).toBe('healthy-model');
    expect(result.providerId).toBe('healthy-source');
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

  // Codex review #9369: the target catalog *offering* a model is not the same as that model
  // being routable there. A source that is disconnected, suspended, has its runtime turned
  // off or has the model entry disabled cannot carry the request — keeping it strands the
  // draft on a model the picker cannot route and Send cannot send.
  it('skips a target model whose source is not connected', () => {
    const result = calibrate({
      targetProviders: [
        providerWithModel('shared-source', 'shared-model', { connected: false }),
        providerWithModel('other-source', 'other-model'),
      ],
      localProviders: [providerWithModel('local-source', 'local-model')],
      draftModel: 'shared-model',
    });
    expect(result.model).toBe('other-model');
    expect(result.providerId).toBe('other-source');
  });

  it('skips a target model whose source is suspended', () => {
    const result = calibrate({
      targetProviders: [
        providerWithModel('shared-source', 'shared-model', { suspended: true }),
        providerWithModel('other-source', 'other-model'),
      ],
      localProviders: [providerWithModel('local-source', 'local-model')],
      draftModel: 'shared-model',
    });
    expect(result.model).toBe('other-model');
    expect(result.providerId).toBe('other-source');
  });

  // Codex review #9369: the source has to travel with the model. The native default for
  // claude-code is the XD gateway, so a target that offers the same model through an
  // Anthropic subscription would silently bill the gateway instead of the paid plan.
  it('carries the subscription source with the target model', () => {
    const result = calibrate({
      targetProviders: [
        providerWithModel('xd', 'shared-model'),
        providerWithModel('anthropic', 'shared-model', {
          access: { kind: 'subscription', product: 'Claude' },
        }),
      ],
      localProviders: [providerWithModel('local-source', 'local-model')],
      draftModel: 'shared-model',
    });
    expect(result.model).toBe('shared-model');
    expect(result.providerId).toBe('anthropic');
  });

  it('keeps the source the user picked for that target', () => {
    const result = calibrate({
      targetProviders: [
        providerWithModel('xd', 'shared-model'),
        providerWithModel('anthropic', 'shared-model', {
          access: { kind: 'subscription', product: 'Claude' },
        }),
      ],
      localProviders: [providerWithModel('local-source', 'local-model')],
      draftModel: 'shared-model',
      rememberedModel: 'shared-model',
      rememberedProviderId: 'xd',
    });
    expect(result.model).toBe('shared-model');
    expect(result.providerId).toBe('xd');
  });

  // The source travels with the model into the composer and into the submission. The
  // native default for claude-code is the XD gateway, so a target that offers the same
  // model through an Anthropic subscription has to name that subscription explicitly.
  describe('the new task source travels with the model', () => {
    function initialProvider(options: {
      targetProviders: ProviderView[];
      model: string;
      rememberedProviderId?: string | null;
      /** 记忆里的来源是用户选的,还是自动播种的。 */
      rememberedChosenByUser?: boolean;
      /** 用户为这个目标**明确选过**的来源(清单发现失败时也保留)。 */
      pinnedProviderId?: string | null;
      calibrated?: DraftModelCalibrationResult | null;
      /** 观察本次的候选来源清单。 */
      onCandidates?: (ids: string[]) => void;
    }): string | null {
      return callback<() => string | null>('draftInitialProviderId', {
        usesDeviceCatalog: true,
        agentCatalogProviders: options.targetProviders,
        targetSelectableProviders: selectableProviders(options.targetProviders),
        explicitDraftProviderId: options.pinnedProviderId ?? null,
        draftInitialModel: options.model,
        capabilityAgentKind: 'pi',
        remoteCatalogCalibration: options.calibrated ?? null,
        effectiveAgentDeviceId: 'share:abc',
        recallAgentDeviceSelection: () =>
          options.rememberedProviderId
            ? {
                model: options.model,
                providerId: options.rememberedProviderId,
                modelChosenByUser: options.rememberedChosenByUser !== false,
              }
            : null,
        chatEligibleSourcesForModel,
        filterHealthyDraftProviders,
        pickDraftProviderForModel: (sources: ProviderView[], preferred?: string | null) => {
          options.onCandidates?.(sources.map((provider) => provider.id));
          return pickDraftProviderForModel(sources, preferred);
        },
      })();
    }

    it('prefers the subscription source over the gateway', () => {
      expect(initialProvider({
        targetProviders: [
          providerWithModel('xd', 'shared-model'),
          providerWithModel('anthropic', 'shared-model', {
            access: { kind: 'subscription', product: 'Claude' },
          }),
        ],
        model: 'shared-model',
      })).toBe('anthropic');
    });

    it('carries the calibrated source with its model', () => {
      expect(initialProvider({
        targetProviders: [
          providerWithModel('xd', 'shared-model'),
          providerWithModel('anthropic', 'shared-model', {
            access: { kind: 'subscription', product: 'Claude' },
          }),
        ],
        model: 'shared-model',
        calibrated: { model: 'shared-model', providerId: 'anthropic' },
      })).toBe('anthropic');
    });

    it('keeps the source the user picked for that target', () => {
      expect(initialProvider({
        targetProviders: [
          providerWithModel('xd', 'shared-model'),
          providerWithModel('anthropic', 'shared-model', {
            access: { kind: 'subscription', product: 'Claude' },
          }),
        ],
        model: 'shared-model',
        rememberedProviderId: 'xd',
      })).toBe('xd');
    });

    // Codex review #9369:记忆里那家若是**自动播种**的,就不是用户选的来源 —— 它不该在
    // 最终来源的挑选里优先(那会让首条消息继续落在一家用户没选过的来源上)。
    it('does not prefer an automatically seeded remembered source', () => {
      expect(initialProvider({
        targetProviders: [
          providerWithModel('xd', 'shared-model'),
          providerWithModel('anthropic', 'shared-model', {
            access: { kind: 'subscription', product: 'Claude' },
          }),
        ],
        model: 'shared-model',
        rememberedProviderId: 'xd',
        rememberedChosenByUser: false,
      })).toBe('anthropic');
    });

    // Codex review #9369:清单发现失败(unauthorized / regionBlocked)的来源手里握的是陈旧
    // 清单,订阅优先的挑选会先挑中它 —— 首条消息对着一个发不出去的来源建任务。
    it('skips a discovery-failed subscription when no source is pinned', () => {
      const failed = providerWithModel('anthropic', 'shared-model', {
        access: { kind: 'subscription', product: 'Claude' },
      });
      failed.modelDiscoveryFailure = { kind: 'unauthorized', at: '2026-11-12T00:00:00Z' };
      expect(initialProvider({
        targetProviders: [failed, providerWithModel('xd', 'shared-model')],
        model: 'shared-model',
      })).toBe('xd');
    });

    // 用户**明确选过**的那一家是例外:失败时照样留在候选里 —— 执行端按它报不可用,而不是
    // 悄悄换成另一家账号 / 计费路径(provider-sharing §5.3)。
    it('keeps the explicitly chosen source in the candidate list', () => {
      const failed = providerWithModel('anthropic', 'shared-model', {
        access: { kind: 'subscription', product: 'Claude' },
      });
      failed.modelDiscoveryFailure = { kind: 'unauthorized', at: '2026-11-12T00:00:00Z' };
      const targetProviders = [failed, providerWithModel('xd', 'shared-model')];
      const pinned: string[] = [];
      initialProvider({
        targetProviders,
        model: 'shared-model',
        pinnedProviderId: 'anthropic',
        onCandidates: (ids) => pinned.push(...ids),
      });
      expect(pinned).toContain('anthropic');
      const unpinned: string[] = [];
      initialProvider({
        targetProviders,
        model: 'shared-model',
        onCandidates: (ids) => unpinned.push(...ids),
      });
      expect(unpinned).not.toContain('anthropic');
    });
  });

/**
 * 目标目录里**可选**的型号才配当默认值(Codex review #9369)。
 *
 * 被退役 / 要付费的型号,以及被控端自己藏起来的型号:选择器里没有它们,主进程的新路由
 * 准入(model-route-guard)也会拒掉首发 —— 草稿停在这样的型号上,首条消息必然失败,
 * 而那份目录里明明还有别的可选型号。
 */
describe('the target model must be selectable on that target', () => {
  it('falls back to another target model when the target retired it', () => {
    const result = calibrate({
      targetProviders: [
        providerWithModel('shared-source', 'shared-model', { retired: true }),
        providerWithModel('other-source', 'other-model'),
      ],
      localProviders: [providerWithModel('local-source', 'local-model')],
      draftModel: 'local-model',
      rememberedModel: 'shared-model',
    });
    expect(result.model).toBe('other-model');
  });

  it('falls back to another target model when the target hid it', () => {
    const result = calibrate({
      targetProviders: [
        providerWithModel('shared-source', 'shared-model'),
        providerWithModel('other-source', 'other-model'),
      ],
      localProviders: [providerWithModel('local-source', 'local-model')],
      draftModel: 'local-model',
      rememberedModel: 'shared-model',
      modelVisibilityOverrides: { 'pi:shared-source:shared-model': false },
    });
    expect(result.model).toBe('other-model');
  });
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
    /** 用户为这个目标**明确选过**的来源(清单发现失败时也保留)。 */
    pinnedProviderId?: string | null;
    /** 覆盖默认的那一家来源(清单发现失败 / 多家档位表不同这类场景)。 */
    providers?: ProviderView[];
  }): { model: string; effort: Effort | null } {
    const agentCatalogProviders = options.providers ?? [
      providerWithEfforts(
        'shared-source',
        ['shared-model', 'seeded-model'],
        options.targetEfforts ?? ['medium'],
      ),
    ];
    // 目标目录里可选的型号清单(新路由准入 + 被控端自己的显示/隐藏)。
    const targetSelectableProviders = selectableProviders(agentCatalogProviders);
    // 播种分支:被控端给的型号与档位原样用。
    const seeded = compile<() => { model: string; effort: Effort | null } | null>(
      'draftSeedSelection',
      (node) =>
        ts.isVariableDeclaration(node) &&
        node.name.getText(source) === 'draftSeedSelection' &&
        node.initializer &&
        ts.isCallExpression(node.initializer)
          ? node.initializer.arguments[0]
          : undefined,
      {
        usesDeviceCatalog: true,
        deviceLinkInitial: options.deviceLinkInitial,
        agentCatalogProviders,
        targetSelectableProviders,
        capabilityAgentKind: 'pi',
        chatEligibleSourcesForModel,
        filterHealthyDraftProviders,
        resolveDraftProviderForModel,
        explicitDraftProviderId: options.pinnedProviderId ?? null,
        deviceProvidersLoading: false,
        deviceProvidersUnsupported: false,
      },
    )();
    const effort = compile<() => Effort | null>(
      'draftInitialEffort',
      (node) =>
        ts.isVariableDeclaration(node) &&
        node.name.getText(source) === 'draftInitialEffort' &&
        node.initializer &&
        ts.isCallExpression(node.initializer)
          ? node.initializer.arguments[0]
          : undefined,
      {
        draftSeedSelection: seeded,
        usesDeviceCatalog: true,
        draftInitialModel: seeded?.model ?? 'shared-model',
        calibratedDraftModel: 'shared-model',
        localDraftEffort: options.localEffort ?? 'medium',
        agentCatalogProviders,
        targetSelectableProviders,
        capabilityAgentKind: 'pi',
        effectiveAgentDeviceId: 'share:abc',
        deviceDraftDefaults: null,
        // 目录里只有这一家来源,最终来源就是它。
        chatInitialProviderId: 'shared-source',
        recallAgentDeviceSelection: () =>
          options.rememberedEffort ? { model: 'shared-model', effort: options.rememberedEffort } : null,
        getModel,
        reconcileInvocationEffort,
      },
    )();
    return { model: seeded?.model ?? 'shared-model', effort };
  }

  function providerWithEfforts(id: string, modelIds: string[], efforts: Effort[]): ProviderView {
    return {
      id, name: id, source: 'user', connected: true,
      agents: ['pi'], auth: { method: 'none' },
      routing: { pi: { upstream: 'https://provider.invalid', authStrategy: 'none' } },
      models: { pi: modelIds.map((modelId) => ({
        id: modelId, name: modelId, contextWindow: 200_000,
        efforts, defaultEffort: efforts[0] ?? null, effortsUnknown: false,
      })) },
    };
  }

  it('uses the seeded model when the catalog offers one', () => {
    // 种子档位是**请求值**:它来自被控端 capabilities 的跨来源并集,最终路由落到的来源
    // 只支持 medium —— 原样显示 high 会让 pill 与发送时 reconcile 出来的值不一致
    // (Codex review #9369)。模型本身仍是播种那个。
    expect(initialModel({ deviceLinkInitial: { model: 'seeded-model', effort: 'high' } }))
      .toEqual({ model: 'seeded-model', effort: 'medium' });
  });

  // Codex review #9369: the seed comes from the target's flat capabilities list (a union
  // across every source that computer has), while the target catalog only opens some of
  // those sources. A seed the target cannot route leaves the composer pill empty and the
  // submission without a source.
  it('drops a seeded model the target catalog cannot route', () => {
    expect(initialModel({ deviceLinkInitial: { model: 'flat-only-model', effort: 'high' } }))
      .toEqual({ model: 'shared-model', effort: 'medium' });
  });

  it('uses the calibrated model when the seeded model is empty', () => {
    expect(initialModel({ deviceLinkInitial: { model: '', effort: null } }))
      .toEqual({ model: 'shared-model', effort: 'medium' });
  });

  // Codex review #9369:清单发现失败的来源(unauthorized / regionBlocked 这类确定性失败)
  // 手里握的是**上次成功**的陈旧清单。播种型号只在它那儿还能路由时,旧口径把种子算成
  // 可路由,于是种子盖过下面那份健康校准,首条消息对着一个发不出去的来源建任务 ——
  // 同 remoteCatalogCalibration / 本机自动路径的口径:这种来源不当默认值送人。
  it('drops a seeded model only a discovery-failed source still offers', () => {
    const failed = providerWithEfforts('stale-source', ['seeded-model'], ['high']);
    failed.modelDiscoveryFailure = { kind: 'unauthorized', at: '2026-11-12T00:00:00Z' };
    const healthy = providerWithEfforts('healthy-source', ['shared-model'], ['medium']);
    expect(initialModel({
      deviceLinkInitial: { model: 'seeded-model', effort: 'high' },
      providers: [failed, healthy],
    })).toEqual({ model: 'shared-model', effort: 'medium' });
  });

  // 同上,但全部来源都在失败态:那时没有更好的选择,陈旧清单也好过一个都挑不出来 ——
  // 种子照旧生效(档位仍按最终型号的档位表对一遍,high 在这张表里所以保留)。
  it('keeps a seeded model when every source failed discovery', () => {
    const failed = providerWithEfforts('stale-source', ['seeded-model'], ['high']);
    failed.modelDiscoveryFailure = { kind: 'unauthorized', at: '2026-11-12T00:00:00Z' };
    expect(initialModel({
      deviceLinkInitial: { model: 'seeded-model', effort: 'high' },
      providers: [failed],
    })).toEqual({ model: 'seeded-model', effort: 'high' });
  });

  // Codex review #9369:健康口径的例外是**用户明确选过**的那一家 —— 它清单发现失败时照样
  // 保留候选,播种型号不因此被悄悄换成另一家账号 / 计费路径。他选的就是这一家,执行端按
  // 选定来源报不可用才对(provider-sharing §5.3)。
  it('keeps the seed when the explicitly chosen source failed discovery', () => {
    const failed = providerWithEfforts('stale-source', ['seeded-model'], ['high']);
    failed.modelDiscoveryFailure = { kind: 'unauthorized', at: '2026-11-12T00:00:00Z' };
    const healthy = providerWithEfforts('healthy-source', ['shared-model'], ['medium']);
    expect(initialModel({
      deviceLinkInitial: { model: 'seeded-model', effort: 'high' },
      providers: [failed, healthy],
      pinnedProviderId: 'stale-source',
    })).toEqual({ model: 'seeded-model', effort: 'high' });
  });

  // Codex review #9369:同一条修法的另一半 —— 显式选的那家**暂时断连 / 被暂停**时,
  // 可路由检查(只看已连接来源)会把它剔掉;播种型号如果只有它提供,种子就被整个丢掉、
  // 校准成另一家的型号,holder 同步再把他选的那一对永久改写。断线是连接状态,不是
  // 「这家不提供这个型号」:保留种子,Send 按选定来源报不可用,而不是静默换账号
  // (provider-sharing §5.3)。
  it('keeps the seed when the explicitly chosen source is offline', () => {
    const offline = { ...providerWithEfforts('chosen', ['seeded-model'], ['high']), connected: false };
    const healthy = providerWithEfforts('healthy-source', ['shared-model'], ['medium']);
    expect(initialModel({
      deviceLinkInitial: { model: 'seeded-model', effort: 'high' },
      providers: [offline, healthy],
      pinnedProviderId: 'chosen',
    })).toEqual({ model: 'seeded-model', effort: 'high' });
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

/**
 * 来源必须与**最终**的型号成对(Codex review #9369)。
 *
 * 播种值来自被控端;当播种型号在目标目录里路由不出去时,最终型号会换成目录里的另一个 ——
 * 播种来源往往不提供那个型号。发送侧(resolveDeviceLinkSubmission)会原样保留显式来源,
 * 于是任务建在一个路由不出该型号的来源上,首条消息必然失败。
 */
describe('the source follows the final model', () => {
  function sourceProvider(id: string, modelId: string): ProviderView {
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

  it('keeps the seeded source only when it offers the final model', () => {
    const providers = [sourceProvider('good', 'shared-model'), sourceProvider('stale', 'other-model')];
    const pick = callback<() => string | null>('chatInitialProviderId', {
      usesDeviceCatalog: true,
      localProviderIdForDraft: null,
      deviceLinkInitial: { providerId: 'stale' },
      explicitDraftProviderId: 'stale',
      draftInitialModel: 'shared-model',
      agentCatalogProviders: providers,
      targetSelectableProviders: selectableProviders(providers),
      capabilityAgentKind: 'pi',
      draftInitialProviderId: 'good',
      resolveDraftProviderForModel,
      effectiveSourceIdForModel,
    });
    expect(pick()).toBe('good');
  });

  it('keeps an explicitly chosen source the catalog cannot vouch against', () => {
    // 旧被控端没有供应商目录(providers 为空):无法证明用户选的那家不提供最终型号 ——
    // 保留显式来源,不静默换成默认来源(Codex review #9369,provider-sharing §5.3)。
    const pickFromEmptyCatalog = callback<() => string | null>('chatInitialProviderId', {
      usesDeviceCatalog: true,
      localProviderIdForDraft: null,
      deviceLinkInitial: { providerId: 'chosen' },
      explicitDraftProviderId: 'chosen',
      draftInitialModel: 'shared-model',
      agentCatalogProviders: [],
      targetSelectableProviders: selectableProviders([]),
      capabilityAgentKind: 'pi',
      draftInitialProviderId: 'other',
      resolveDraftProviderForModel,
      effectiveSourceIdForModel,
    });
    expect(pickFromEmptyCatalog()).toBe('chosen');

    // 目录里有这家、型号也在,只是暂时断连:同样是状态问题,不是「不提供」。
    const offline = { ...sourceProvider('chosen', 'shared-model'), connected: false };
    const pickFromOfflineCatalog = callback<() => string | null>('chatInitialProviderId', {
      usesDeviceCatalog: true,
      localProviderIdForDraft: null,
      deviceLinkInitial: { providerId: 'chosen' },
      explicitDraftProviderId: 'chosen',
      draftInitialModel: 'shared-model',
      agentCatalogProviders: [offline, sourceProvider('other', 'shared-model')],
      targetSelectableProviders: selectableProviders([offline, sourceProvider('other', 'shared-model')]),
      capabilityAgentKind: 'pi',
      draftInitialProviderId: 'other',
      resolveDraftProviderForModel,
      effectiveSourceIdForModel,
    });
    expect(pickFromOfflineCatalog()).toBe('chosen');
  });

  // Codex review #9369:自动默认也会把 providerId 落进被控端快照(applySuggestedDefaultTuple,
  // modelChosenByUser === false)—— 那家不是用户选的,不能按「显式选择保留」的口径把它
  // 钉在提交身份上:它断连 / 清单失败时让位给目录里健康的那家,首条消息才不会发不出去。
  it('yields an automatically seeded source to a healthy source', () => {
    const auto = { ...sourceProvider('auto', 'shared-model'), connected: false };
    const healthy = sourceProvider('good', 'shared-model');
    const pick = callback<() => string | null>('chatInitialProviderId', {
      usesDeviceCatalog: true,
      localProviderIdForDraft: null,
      deviceLinkInitial: { providerId: 'auto' },
      explicitDraftProviderId: null,
      draftInitialModel: 'shared-model',
      agentCatalogProviders: [auto, healthy],
      targetSelectableProviders: selectableProviders([auto, healthy]),
      capabilityAgentKind: 'pi',
      draftInitialProviderId: 'good',
      resolveDraftProviderForModel,
      effectiveSourceIdForModel,
    });
    expect(pick()).toBe('good');
  });

  it('derives Fast from the final model and source', () => {
    const providers = [sourceProvider('good', 'shared-model'), sourceProvider('stale', 'other-model')];
    const resolveFastSupportedSpy = vi.fn(() => true);
    const supportsFast = callback<() => boolean>('supportsFastMode', {
      usesDeviceCatalog: true,
      dlSel: { providerId: 'stale', model: 'other-model' },
      agentCatalogProviders: providers,
      targetSelectableProviders: selectableProviders(providers),
      draftInitialModel: 'shared-model',
      draftInitialProviderId: 'good',
      draftInitialFastMode: false,
      effectiveSourceId: null,
      calibratedDraftModel: 'shared-model',
      catalogDeviceId: 'device-1',
      deviceProviders: providers,
      draftLocalProviders: [],
      capabilities: null,
      capabilityAgentKind: 'pi',
      resolveDraftFastProviderId,
      resolveFastSupported: resolveFastSupportedSpy,
    });
    expect(supportsFast()).toBe(true);
    // Fast 是 per-provider 能力:判定必须落在最终那一对上,而不是播种那一代。
    expect(resolveFastSupportedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'good', modelId: 'shared-model' }),
    );
  });

  // Codex review #9369 第十三轮:resolveFastSupported 只在 fastMode === 'ultrafast' 时查
  // supportsUltrafastMode —— 判定不带档位,一个只支持普通 Fast 的最终来源会放行
  // ultrafast,effectiveFastMode 原样保留、显示与提交都带着不支持的档位。
  it('clears an ultrafast preset the final source cannot run', () => {
    const codexFast = {
      id: 'good', name: 'good', source: 'user', connected: true,
      agents: ['codex'], auth: { method: 'none' },
      routing: { codex: { upstream: 'https://provider.invalid', authStrategy: 'none' } },
      models: { codex: [{
        id: 'shared-model', name: 'Shared model', contextWindow: 200_000,
        efforts: ['high'], defaultEffort: 'high', effortsUnknown: false,
        supportsFastMode: true, // 普通 Fast 支持;没有 supportsUltrafastMode。
      }] },
    } as ProviderView;
    const capabilities = {
      hasFastMode: true,
      availableModels: [{
        id: 'shared-model', displayName: 'Shared model', contextWindow: 200_000,
        efforts: ['high'], defaultEffort: 'high', supportsFastMode: true,
      }],
      effortLevels: [{ id: 'high', displayName: 'High' }],
      permissionModes: [{ id: 'default', displayName: 'Default' }],
    };
    const compileSupports = (fastMode: boolean | 'ultrafast') =>
      callback<() => boolean>('supportsFastMode', {
        usesDeviceCatalog: true,
        dlSel: { providerId: 'good', model: 'shared-model' },
        agentCatalogProviders: [codexFast],
        targetSelectableProviders: [codexFast],
        draftInitialModel: 'shared-model',
        draftInitialProviderId: 'good',
        draftInitialFastMode: fastMode,
        effectiveSourceId: null,
        calibratedDraftModel: 'shared-model',
        catalogDeviceId: 'device-1',
        deviceProviders: [codexFast],
        draftLocalProviders: [],
        capabilities,
        capabilityAgentKind: 'codex',
        resolveDraftFastProviderId,
        resolveFastSupported,
      })();
    // 不带档位判定(旧行为)会放行:普通 Fast 支持 → true。
    // 带上当前档位后,ultrafast 在缺 supportsUltrafastMode 的来源上必须被清掉。
    expect(compileSupports('ultrafast')).toBe(false);
    // 普通档位不受影响:同一个来源的普通 Fast 照旧可用。
    expect(compileSupports(false)).toBe(true);
  });
});

/**
 * 「用户明确选过哪一家来源」的判定本身(Codex review #9369)。
 *
 * 快照 / agent-device 记忆里的 providerId 不一定来自用户:自动默认
 * (applySuggestedDefaultTuple)与自动播种都会把那家写进去;反过来,控制端当场的实时选择
 * 要立刻生效 —— 选择记忆要等 effect 才落进外部 Map,判定不跟着 holder 走的话,刚选的
 * 那家赶不上下一次渲染。对 agent-device,deviceDraftDefaults 就是那份记忆
 * (recall),标记由 remember effect 按「控制端动过这份草稿」如实写入。
 */
describe('the explicit source is the user\'s own choice', () => {
  function explicitPin(bindings: {
    /** 用户**明确选过**模型 / 来源(不是「动过这份草稿」)。 */
    touched?: boolean;
    dlSel?: { providerId: string | null } | null;
    /** 快照 / agent-device 记忆(agent-device 下 deviceDraftDefaults 即 recall)。 */
    snapshot?: RemoteDraftDefaults | null;
  }): string | null {
    return callback<() => string | null>('explicitDraftProviderId', {
      dlExplicitChoiceRef: { current: bindings.touched ?? false },
      dlSel: bindings.dlSel ?? null,
      deviceDraftDefaults: bindings.snapshot ?? null,
    })();
  }

  it('keeps the live selection the user just made', () => {
    // 选择记忆要等 effect 才写进外部 Map:判定只读记忆的话,会停在播种时的旧值,
    // 刚选的那家又被健康校准改回去。
    expect(explicitPin({
      touched: true,
      dlSel: { providerId: 'just-chosen' },
      snapshot: { model: 'shared-model', providerId: 'snapshot', modelChosenByUser: true },
    })).toBe('just-chosen');
  });

  it('does not pin an automatically seeded provider', () => {
    expect(explicitPin({
      snapshot: { model: 'shared-model', providerId: 'auto', modelChosenByUser: false },
    })).toBeNull();
  });

  it('pins the provider the remote says the user chose', () => {
    expect(explicitPin({
      snapshot: { model: 'shared-model', providerId: 'chosen', modelChosenByUser: true },
    })).toBe('chosen');
  });

  it('keeps an old host\'s snapshot provider', () => {
    // 旧被控端没有 modelChosenByUser 标记(undefined):无法证明那家不是用户选的,
    // 与 shouldReseedDeviceLinkDraftDefaults 同一口径保守保留。
    expect(explicitPin({
      snapshot: { model: 'shared-model', providerId: 'legacy' },
    })).toBe('legacy');
  });
});

/**
 * agent-device 的选择记忆必须如实区分「自动播种 / holder 同步」与「用户当场选的」
 * (Codex review #9369 第十三轮):标记写成 true,自动来的那家会被下游当显式来源钉死。
 */
describe('the agent-device memory records the choice marker honestly', () => {
  function rememberFlag(explicitChoice: boolean): boolean | undefined {
    const spy = vi.fn();
    effect('标记跟着「用户明确选过模型 / 来源」走', {
      isAgentDeviceDraft: true,
      effectiveAgentDeviceId: 'dev-1',
      capabilityAgentKind: 'pi',
      dlSel: { model: 'shared-model', providerId: 'seeded', effort: null, fastMode: false },
      dlExplicitChoiceRef: { current: explicitChoice },
      rememberAgentDeviceSelection: spy,
    })();
    expect(spy).toHaveBeenCalledTimes(1);
    return spy.mock.calls[0]?.[3];
  }

  it('marks an untouched automatic seed as not user-chosen', () => {
    expect(rememberFlag(false)).toBe(false);
  });

  it('marks a selection the user just made as user-chosen', () => {
    expect(rememberFlag(true)).toBe(true);
  });
});

/**
 * Fast 的取值要落在**最终型号**上(Codex review #9369)。
 *
 * 播种型号 M 的 Fast 是开的,校准把型号换成 N:那是 M 的值,不能带到 N 上 —— N 可能压根
 * 不支持 Fast,或者它自己的记忆里是关的。开关与建出来的任务都得按 N 重取。
 */
describe('the Fast value follows the final model', () => {
  function fastOf(bindings: {
    deviceLinkInitial: { model: string; fastMode: boolean | 'ultrafast' } | null;
    draftInitialModel: string;
    deviceDraftDefaults?: RemoteDraftDefaults | null;
    chatInitialProviderId?: string | null;
  }): boolean | 'ultrafast' {
    return compile<() => boolean | 'ultrafast'>(
      'draftInitialFastMode',
      (node) =>
        ts.isVariableDeclaration(node) &&
        node.name.getText(source) === 'draftInitialFastMode' &&
        node.initializer &&
        ts.isCallExpression(node.initializer)
          ? node.initializer.arguments[0]
          : undefined,
      {
        usesDeviceCatalog: true,
        deviceLinkInitial: bindings.deviceLinkInitial,
        draftInitialModel: bindings.draftInitialModel,
        effectiveAgentDeviceId: null,
        capabilityAgentKind: 'pi',
        deviceDraftDefaults: bindings.deviceDraftDefaults ?? null,
        chatInitialProviderId: bindings.chatInitialProviderId ?? null,
        recallAgentDeviceSelection: () => null,
      },
    )();
  }

  it('re-resolves Fast when the calibration replaced the seed model', () => {
    // 播种型号的 Fast 是开的,新型号在被控端没有记过 Fast:不能把旧型号的值带过来。
    expect(fastOf({
      deviceLinkInitial: { model: 'seeded-model', fastMode: true },
      draftInitialModel: 'shared-model',
      deviceDraftDefaults: { model: 'seeded-model', fastMode: true },
    })).toBe(false);
  });

  it('takes the Fast the controlled device remembers for the final model', () => {
    expect(fastOf({
      deviceLinkInitial: { model: 'seeded-model', fastMode: false },
      draftInitialModel: 'shared-model',
      deviceDraftDefaults: {
        model: 'seeded-model',
        fastMode: false,
        providerModelMemory: {
          'pi:*': { effortByModel: {}, fastByModel: { 'shared-model': true } },
        },
      },
    })).toBe(true);
  });

  it('keeps the Fast the user toggled on the displayed model', () => {
    expect(fastOf({
      deviceLinkInitial: { model: 'shared-model', fastMode: true },
      draftInitialModel: 'shared-model',
      deviceDraftDefaults: { model: 'shared-model', fastMode: false },
    })).toBe(true);
  });
});

/**
 * 档位要按**最终来源 + 最终型号**这一对来解析(Codex review #9369)。
 *
 * 同一个型号在多个来源上都有条目时,各家的档位表可以不一样;档位记忆也是**按模型**的:
 * 上一次选的是别的型号时,那个档位不能带过来。
 */
describe('the effort follows the final provider and model', () => {
  function effortOf(bindings: {
    agentCatalogProviders: ProviderView[];
    chatInitialProviderId: string | null;
    calibratedDraftModel?: string;
    draftSeedSelection?: { model: string; effort: Effort | null } | null;
    localDraftEffort?: Effort | null;
    recallAgentDeviceSelection?: () => unknown;
    deviceDraftDefaults?: unknown;
    effectiveAgentDeviceId?: string | null;
  }): Effort | null {
    const calibratedDraftModel = bindings.calibratedDraftModel ?? 'shared-model';
    const draftSeedSelection = bindings.draftSeedSelection === undefined
      ? null
      : bindings.draftSeedSelection;
    return callback<() => Effort | null>('draftInitialEffort', {
      draftSeedSelection,
      usesDeviceCatalog: true,
      calibratedDraftModel,
      // 路由里档位按**最终型号**解析;没有种子时最终型号就是校准型号。
      draftInitialModel: draftSeedSelection?.model ?? calibratedDraftModel,
      localDraftEffort: bindings.localDraftEffort ?? 'medium',
      agentCatalogProviders: bindings.agentCatalogProviders,
      targetSelectableProviders: selectableProviders(bindings.agentCatalogProviders),
      capabilityAgentKind: 'pi',
      effectiveAgentDeviceId: bindings.effectiveAgentDeviceId === undefined ? 'share:abc' : bindings.effectiveAgentDeviceId,
      deviceDraftDefaults: bindings.deviceDraftDefaults ?? null,
      chatInitialProviderId: bindings.chatInitialProviderId,
      recallAgentDeviceSelection: bindings.recallAgentDeviceSelection ?? (() => null),
      getModel,
      reconcileInvocationEffort,
    })();
  }

  it('resolves the effort from the selected provider, not the first catalog copy', () => {
    // 第一份目录条目明确没有档位,选中的却是后面那份订阅:按目录顺序取会把档位算到
    // 另一个账号上,会话就在那个账号的默认档(这里是 null)上建起来(Codex review #9369)。
    const providers = [provider('first', []), provider('chosen', ['low', 'high'])];
    expect(effortOf({
      agentCatalogProviders: providers,
      chatInitialProviderId: 'chosen',
      localDraftEffort: 'low',
    })).toBe('low');
  });

  it('does not carry the effort of another model into the fallback model', () => {
    // 上一次选的是别的型号(那个型号的档位是 low):旧型号与新型号都接受 low 时,
    // reconcile 会把旧值保留下来,会话就在 low 上建起来 —— 新型号自己记住的是 high。
    const providers = [provider('chosen', ['low', 'high'])];
    const effort = effortOf({
      agentCatalogProviders: providers,
      chatInitialProviderId: 'chosen',
      recallAgentDeviceSelection: () => ({
        model: 'other-model',
        effort: 'low',
        providerModelMemory: { 'pi:chosen': { effortByModel: { 'shared-model': 'high' } } },
      }),
    });
    expect(effort).toBe('high');
  });

  it('resolves the fallback effort from the controlled-device snapshot for an ordinary draft', () => {
    // 普通 device-link 草稿(没有 agent-device 绑定,effectiveAgentDeviceId 为空):被控端
    // 快照(deviceDraftDefaults)的 providerModelMemory 为 N 记着 high。强制落空会让 requested
    // 一路掉到**控制端**的 localDraftEffort(low),reconcile 一保留,被控端为 N 记着 high 的
    // 目标就被建成了 low(Codex review #9369)。
    const providers = [provider('chosen', ['low', 'high'])];
    const effort = effortOf({
      agentCatalogProviders: providers,
      chatInitialProviderId: 'chosen',
      effectiveAgentDeviceId: null,
      deviceDraftDefaults: {
        model: 'other-model',
        effort: 'low',
        providerModelMemory: { 'pi:chosen': { effortByModel: { 'shared-model': 'high' } } },
      },
      localDraftEffort: 'low',
    });
    expect(effort).toBe('high');
  });

  // Codex review #9369:种子档位来自被控端 capabilities 的跨来源并集(或种子来源自己的
  // 档位表),最终路由却落在另一家 —— 原样返回会让 pill 显示一个最终型号不支持的档,
  // 发送时被 reconcile 成别的值,显示的和建成的不是同一个。
  it('reconciles the seeded effort against the final source effort table', () => {
    const providers = [provider('seed-source', ['high']), provider('final-source', ['low', 'medium'])];
    const effort = effortOf({
      agentCatalogProviders: providers,
      chatInitialProviderId: 'final-source',
      draftSeedSelection: { model: 'shared-model', effort: 'high' },
      localDraftEffort: 'low',
    });
    // high 不在最终来源的档位表里:落到该表自己的默认档,而不是继续显示 high。
    expect(effort).toBe('medium');
  });

  it('keeps a seeded effort the final source supports', () => {
    const providers = [provider('seed-source', ['high']), provider('final-source', ['low', 'high'])];
    const effort = effortOf({
      agentCatalogProviders: providers,
      chatInitialProviderId: 'final-source',
      draftSeedSelection: { model: 'shared-model', effort: 'high' },
      localDraftEffort: 'low',
    });
    expect(effort).toBe('high');
  });

  // Codex review #9369:种子档位为 **null** 是明确「这个型号没有档位」,不是「没有值」。
  // 最终来源那份条目是空表(effortsUnknown 不为 false)时无法核对,requested 原样返回 ——
  // 把 null 当成缺失会掉到控制端的 localDraftEffort,给一个根本没有档位的型号指定了档位。
  it('keeps an explicit no-effort seed on an unknown effort table', () => {
    const legacy = provider('chosen', []);
    const entry = legacy.models.pi?.[0];
    if (entry) delete entry.effortsUnknown;
    const effort = effortOf({
      agentCatalogProviders: [legacy],
      chatInitialProviderId: 'chosen',
      draftSeedSelection: { model: 'shared-model', effort: null },
      localDraftEffort: 'high',
    });
    expect(effort).toBeNull();
  });

  // Codex review #9369:被控端 providerModelMemory 的权威槽是 `${agent}:*`(模型级全局
  // 预设),来源槽只是旧 v2 兼容副本。现代被控端可能只在权威槽里为这个型号记过档 ——
  // 只读来源槽会漏掉它、一路掉到控制端的 localDraftEffort,两边都支持时 reconcile 保留
  // 控制端那个值,被控端为目标记着的档位就没了。读序同 main 侧 getNewMakerModelTuning。
  it('reads the controlled-device global preset slot before the source copy', () => {
    const providers = [provider('chosen', ['low', 'high'])];
    const effort = effortOf({
      agentCatalogProviders: providers,
      chatInitialProviderId: 'chosen',
      effectiveAgentDeviceId: null,
      deviceDraftDefaults: {
        model: 'other-model',
        effort: 'low',
        // 权威槽为这个型号记着 high,来源 B 的兼容槽是空的。
        providerModelMemory: { 'pi:*': { effortByModel: { 'shared-model': 'high' } } },
      },
      localDraftEffort: 'low',
    });
    expect(effort).toBe('high');
  });
});

// Codex review #9369(第八轮):播种型号在目标目录里路由不出去、被换成目录里的另一个型号时,
// holder 还握着旧型号 —— 改档 / 改 Fast 会把**新型号**的改动写到旧型号的远端草稿记忆上,
// agent-device 草稿还会被 rememberAgentDeviceSelection 再记一次旧型号。
describe('the remote draft holder follows the displayed model', () => {
  const staleHolder: DeviceLinkDraftSelection = {
    model: 'shared-model', providerId: 'source', effort: 'high', fastMode: false,
  };
  function pushBindings() {
    const invoke = vi.fn<
      (deviceId: string, channel: string, payload: unknown[]) => Promise<undefined>
    >(async () => undefined);
    return {
      isDeviceLinkDraft: true,
      effectiveDeviceLinkDeviceId: 'target-device',
      effectiveAgentDeviceId: undefined,
      capabilityAgentKind: 'pi',
      draftInitialModel: 'other-model',
      dlSel: staleHolder,
      deviceLinkInitial: staleHolder,
      remoteDraftRevisionRef: { current: 0 },
      forgetRemoteDraftDefaults: vi.fn(),
      window: { electronAPI: { deviceLink: { invoke } } },
      invoke,
    };
  }
  function pushPref(bindings: ReturnType<typeof pushBindings>) {
    return callback<
      (patch: { effort?: Effort; fast?: boolean | 'ultrafast' }) => void
    >('pushActiveDraftPref', bindings);
  }

  it('writes the displayed model to the controlled draft, not the stale seed model', () => {
    const bindings = pushBindings();
    pushPref(bindings)({ effort: 'low' });
    expect(bindings.invoke).toHaveBeenCalledWith(
      'target-device',
      'maker:apply-new-maker-draft-pref',
      [expect.objectContaining({ modelId: 'other-model', effort: 'low' })],
    );
  });

  it('does not push the stale model\'s effort onto the displayed model', () => {
    const bindings = pushBindings();
    pushPref(bindings)({ fast: true });
    const payload = (bindings.invoke.mock.calls[0][2] as Record<string, unknown>[])[0];
    expect(payload.modelId).toBe('other-model');
    expect(payload).not.toHaveProperty('effort');
  });

  it('synchronizes the holder to the calibrated tuple', () => {
    const setDlSel = vi.fn();
    effect('holder 同步到显示的那一对', {
      usesDeviceCatalog: true,
      dlSel: staleHolder,
      draftInitialModel: 'other-model',
      chatInitialProviderId: 'other',
      draftInitialEffort: 'medium',
      draftInitialFastMode: false,
      setDlSel,
    })();
    expect(setDlSel).toHaveBeenCalledWith({
      ...staleHolder,
      model: 'other-model',
      providerId: 'other',
      effort: 'medium',
      fastMode: false,
    });
  });

  it('leaves the holder alone while the seed model is still the displayed one', () => {
    const setDlSel = vi.fn();
    effect('holder 同步到显示的那一对', {
      usesDeviceCatalog: true,
      dlSel: staleHolder,
      draftInitialModel: 'shared-model',
      chatInitialProviderId: 'source',
      draftInitialEffort: 'high',
      draftInitialFastMode: false,
      setDlSel,
    })();
    expect(setDlSel).not.toHaveBeenCalled();
  });

  it('synchronizes the holder when only the seed provider lost the model', () => {
    // 播种型号还能路由,但只剩**另一个来源**提供它(播种来源不再提供该型号):显示与提交
    // 都落在那个来源上,holder 留在播种来源会让 effort / Fast 写穿打到不提供该型号的来源上,
    // agent-device 记忆也会留住旧来源(Codex review #9369)。
    const setDlSel = vi.fn();
    effect('holder 同步到显示的那一对', {
      usesDeviceCatalog: true,
      dlSel: staleHolder,
      draftInitialModel: 'shared-model',
      chatInitialProviderId: 'other',
      draftInitialEffort: 'high',
      draftInitialFastMode: false,
      setDlSel,
    })();
    expect(setDlSel).toHaveBeenCalledWith({
      ...staleHolder,
      model: 'shared-model',
      providerId: 'other',
      effort: 'high',
      fastMode: false,
    });
  });
});

// Codex review #9369:Permission / Effort / Fast 只说明「动过这份草稿」,不说明用户选定了
// 来源。控制端动过草稿时把 holder 里那家当成显式来源钉死,自动播种的那家一旦断连 / 清单
// 发现失败,首条消息就对着发不出去的来源发 —— 与本机草稿同一口径:只有明确选了模型 /
// 来源才打标,只改思考档 / Fast 不打标。
describe('the seeded source is pinned only by an explicit model or source choice', () => {
  function harness() {
    const dlRuntimeTouchedRef = { current: false };
    const dlExplicitChoiceRef = { current: false };
    const dlSel: { model: string; providerId: string | null; effort: Effort; fastMode: boolean } = {
      model: 'shared-model', providerId: 'seeded-source', effort: 'medium', fastMode: false,
    };
    const setDlSel = vi.fn((update: unknown) => {
      const next = typeof update === 'function'
        ? (update as (prev: typeof dlSel) => typeof dlSel)(dlSel)
        : update;
      if (next) Object.assign(dlSel, next);
    });
    const common = {
      dlRuntimeTouchedRef,
      dlExplicitChoiceRef,
      setDlSel,
      sshCodexDraftHostId: null,
      patchSshDraftSelection: vi.fn(),
      usesDeviceCatalog: true,
      capabilities: null,
      deviceDraftDefaults: null,
      capabilityAgentKind: 'pi',
      agentCatalogProviders: [],
      markDefaultTupleCustomized: vi.fn(),
      patchActiveTuplePrefs: vi.fn(),
      patchActivePrefs: vi.fn(),
      pushActiveDraftPref: vi.fn(),
    };
    // 显式来源(用户为这个目标**明确选过**的那家)。没有显式选择时是 null。
    const explicitProviderId = () => callback<() => string | null>('explicitDraftProviderId', {
      dlExplicitChoiceRef,
      dlSel,
      // 被控端 / 记忆都说「用户没选过模型」→ 那家是自动默认,不是显式来源。
      deviceDraftDefaults: { providerId: 'seeded-source', modelChosenByUser: false },
    })();
    return { dlRuntimeTouchedRef, dlExplicitChoiceRef, dlSel, common, explicitProviderId };
  }

  it('does not pin the seeded source after a permission-only edit', () => {
    const h = harness();
    callback<(mode: string) => void>('handlePermissionModeDidChange', {
      ...h.common, isDeviceLinkDraft: true,
    })('auto');
    expect(h.dlRuntimeTouchedRef.current).toBe(true);
    expect(h.dlExplicitChoiceRef.current).toBe(false);
    expect(h.explicitProviderId()).toBeNull();
  });

  it('does not pin the seeded source after an effort-only edit', () => {
    const h = harness();
    callback<(effort: Effort) => void>('handleEffortDidChange', h.common)('low');
    expect(h.dlRuntimeTouchedRef.current).toBe(true);
    expect(h.dlExplicitChoiceRef.current).toBe(false);
    expect(h.explicitProviderId()).toBeNull();
  });

  it('does not pin the seeded source after a Fast-only edit', () => {
    const h = harness();
    callback<(enabled: boolean) => void>('handleFastModeChange', h.common)(true);
    expect(h.dlRuntimeTouchedRef.current).toBe(true);
    expect(h.dlExplicitChoiceRef.current).toBe(false);
    expect(h.explicitProviderId()).toBeNull();
  });

  it('pins the source once the user picks a model explicitly', () => {
    const h = harness();
    callback<(modelId: string) => void>('handleModelDidChange', h.common)('other-model');
    expect(h.dlExplicitChoiceRef.current).toBe(true);
    expect(h.explicitProviderId()).toBe('seeded-source');
  });

  it('pins the source once the user picks a source explicitly', () => {
    const h = harness();
    callback<(providerId: string | null) => void>('handleProviderDidChange', h.common)('picked-source');
    expect(h.dlExplicitChoiceRef.current).toBe(true);
    expect(h.dlSel.providerId).toBe('picked-source');
    expect(h.explicitProviderId()).toBe('picked-source');
  });
});

/**
 * 播种 effect（useRemoteDraftSelection）在换目标时的显式标记处理。
 *
 * 测试价值（engineering-conventions §3.2）：
 * - 生产入口与可观察结果：真实编译 useRemoteDraftDefaults.ts 里 useRemoteDraftSelection 的
 *   播种 effect，断言换目标播种后 dlExplicitChoiceRef 的取值 —— 它是 explicitDraftProviderId
 *   的第一分支，也是 remember effect 写回记忆的标记来源（用户可观察结果：切回远程 Agent
 *   草稿后，他以前明确选过的来源在断连 / 清单发现失败时仍被保护，不静默换账号）。
 * - Bug／规则依据：Greptile P1（#9369 NewMakerDraftRoute.tsx:1864-1868 写回处）——播种无条件
 *   清零 ref，随后 remember effect 把 false 写回记忆，恢复出来的明确选择被降级成自动默认。
 * - 现有覆盖缺口：explicitPin 用例只测「快照标记 → 钉不钉」，rememberFlag 用例只测
 *   「ref → 记忆标记」的透传，没人测播种这一环把 ref 清成什么 —— 断链正好在中间。
 * - 最小失败输入：deviceDraftDefaults 带 modelChosenByUser: true 的新目标播种，断言 ref 为 true
 *   （改动前恒为 false）；自动播种（标着 false）仍须记 false，防止把修复过头。
 * - 反向验证：把播种处的 `deviceDraftDefaults?.modelChosenByUser === true` 改回 false，
 *   第一条用例立刻变红、第二条仍绿（已实测）。
 * - tier：unit（编译真实 effect 源码 + 内存 fake，无网络 / 无真实等待）。
 */
describe('the seed keeps a restored explicit choice', () => {
  function runSeed(options: {
    /** 换回的目标记着的默认值：带 modelChosenByUser 即「恢复」，不带 / false 即自动播种。 */
    deviceDraftDefaults: RemoteDraftDefaults | null;
  }) {
    const dlExplicitChoiceRef = { current: false };
    const dlRuntimeTouchedRef = { current: true };
    const setDlSel = vi.fn();
    const capabilities: AgentCapabilities = {
      availableModels: [{
        id: 'shared-model', displayName: 'Shared model', contextWindow: 200_000,
        efforts: ['medium', 'high'], defaultEffort: 'high', effortsUnknown: false,
      }],
      hasFastMode: false,
      effortLevels: [
        { id: 'medium', displayName: 'Medium' },
        { id: 'high', displayName: 'High' },
      ],
      permissionModes: [{ id: 'default', displayName: 'Default' }],
    };
    defaultsEffect('provider revision 驱逐时 hook 会保留旧快照但标 loading', {
      usesDeviceCatalog: true,
      catalogDeviceId: 'dev-1',
      capabilityAgentKind: 'pi',
      capabilities,
      capabilitiesLoading: false,
      deviceProvidersLoading: false,
      deviceProvidersUnsupported: false,
      deviceDraftDefaultsReady: true,
      deviceDraftDefaults: options.deviceDraftDefaults,
      isAgentDeviceDraft: true,
      agentCatalogProviders: [provider('source', ['medium', 'high'])],
      shouldReseedDeviceLinkDraftDefaults,
      resolveDeviceLinkDraftDefaults,
      dlSeedKeyRef: { current: null as string | null },
      dlSeedCapabilitiesRef: { current: null as unknown },
      dlSeedDefaultsRef: { current: null as unknown },
      dlRuntimeTouchedRef,
      dlExplicitChoiceRef,
      setDlSel,
    })();
    return { dlExplicitChoiceRef, dlRuntimeTouchedRef, setDlSel };
  }

  it('keeps the restored explicit choice when switching back to a target', () => {
    const restored = runSeed({
      deviceDraftDefaults: {
        model: 'shared-model', providerId: 'source', effort: 'medium',
        fastMode: false, modelChosenByUser: true,
      },
    });
    // 恢复的标记保住：既让 explicitDraftProviderId 当场钉住那家，也保证随后的 remember
    // effect 写回 true —— 否则记忆被改成 false，下一次进入就再也证明不了那是他选的。
    expect(restored.dlExplicitChoiceRef.current).toBe(true);
    expect(restored.dlRuntimeTouchedRef.current).toBe(false);
    expect(restored.setDlSel).toHaveBeenCalled();
  });

  it('still records a genuine automatic seed as not user-chosen', () => {
    const seeded = runSeed({
      deviceDraftDefaults: {
        model: 'shared-model', providerId: 'source', effort: 'medium',
        fastMode: false, modelChosenByUser: false,
      },
    });
    expect(seeded.dlExplicitChoiceRef.current).toBe(false);
    expect(seeded.setDlSel).toHaveBeenCalled();
  });

  it('the restored marker survives the seed → remember round-trip', () => {
    const { dlExplicitChoiceRef } = runSeed({
      deviceDraftDefaults: {
        model: 'shared-model', providerId: 'source', effort: 'medium',
        fastMode: false, modelChosenByUser: true,
      },
    });
    const spy = vi.fn();
    effect('标记跟着「用户明确选过模型 / 来源」走', {
      isAgentDeviceDraft: true,
      effectiveAgentDeviceId: 'dev-1',
      capabilityAgentKind: 'pi',
      dlSel: { model: 'shared-model', providerId: 'source', effort: 'medium', fastMode: false },
      dlExplicitChoiceRef,
      rememberAgentDeviceSelection: spy,
    })();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[3]).toBe(true);
  });
});
