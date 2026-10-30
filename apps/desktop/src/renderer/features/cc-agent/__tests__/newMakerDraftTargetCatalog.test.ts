import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import type { Effort, ProviderView } from '@cindy/model-providers';
import type { RemoteProjectTarget } from '@/components/new-chat/AddRemoteProjectDialog';
import type { AgentCapabilities } from '@/hooks/useAgentCapabilities';
import { parseDeviceProvidersPayload } from '@/hooks/useDeviceProviders';
import { extractIpcError } from '@/utils/ipcError';
import { normalizeDbAgentKind } from '../../../../shared/agentKindConversion';
import {
  resolveDeviceLinkDraftDefaults,
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
function callback<T>(name: string, bindings: Record<string, unknown>): T {
  const keys = Object.keys(bindings);
  let factory = factories.get(name);
  if (!factory) {
    let expression: ts.Node | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === name
        && node.initializer && ts.isCallExpression(node.initializer)) {
        expression = node.initializer.arguments[0];
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (!expression) throw new Error(`Missing draft callback: ${name}`);
    const code = ts.transpileModule(`const callback = ${expression.getText(source)};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    factory = new Function(...keys, code + ';return callback;') as (...args: unknown[]) => unknown;
    factories.set(name, factory);
  }
  return factory(...Object.values(bindings)) as T;
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
