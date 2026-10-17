import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { buildUserProvider, getModel, type PiReasoningEffort, type ProviderView } from '@cindy/model-providers';
import { resolveSessionExecutionSelection } from '../../../../main/maker-ipc/sessionExecutionSelection';
import * as draftEffort from '../newMakerDraftModelPrefs';
import { create as createSessionViaIpc } from '@/lib/sessionService';
import type { Effort } from '@/lib/userPreferences.types';

vi.mock('@/lib/makerTransport', () => ({ makerApiFor: vi.fn() }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ getSessionDeviceId: vi.fn() }));

// Execute the route's actual effort derivation and complete submission callbacks,
// without mounting unrelated home panels. External services and initial React state
// are fixtures; derivation, submit bodies, IPC adapter and Main admission stay real.
const source = ts.createSourceFile('NewMakerDraftRoute.tsx', readFileSync(
  resolve(__dirname, '../NewMakerDraftRoute.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks: Record<string, ts.Expression> = {};
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
    const name = ts.isIdentifier(node.name) ? node.name.text
      : ts.isObjectBindingPattern(node.name) && node.name.elements.some(e => e.name.getText(source) === 'draftInitialEffort')
        ? 'draftInitialSelection' : '';
    if (['handleSend', 'handleCreateGoal', 'localDraftEffort', 'draftInitialSelection'].includes(name)) {
      callbacks[name] = node.initializer.arguments[0];
    }
  }
  ts.forEachChild(node, visit);
}
visit(source);
function executable(name: string) {
  if (!callbacks[name]) throw new Error(`NewMakerDraftRoute.${name} callback missing`);
  return ts.transpileModule(`(${callbacks[name].getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

const modelId = 'qwen3:8b';
const providerId = 'custom:cindy-local-ollama';
const goalLimits = { maxTurns: 3, budgetTokens: null, noProgressLimit: null };
function provider(id = providerId, efforts: PiReasoningEffort[] = []): ProviderView {
  const configured = buildUserProvider({
    id: id.replace(/^custom:/, ''), name: id, auth: { method: 'none' },
    runtimes: { pi: { baseUrl: 'http://127.0.0.1:11434/v1', wireProtocol: 'openai-chat',
      models: [{ id: modelId, name: modelId, reasoning: efforts.length > 0,
        ...(efforts.length ? { reasoningEfforts: efforts } : {}) }],
    } },
  });
  // Tests may use another connection ID; the route must honor that exact ID.
  return { ...configured, id, connected: true } as ProviderView;
}

async function submit(options: {
  entry?: 'send' | 'goal';
  effort?: Effort;
  submittedEffort?: Effort;
  model?: string;
  providers?: ProviderView[];
  backendProviders?: ProviderView[];
  providerId?: string;
  agentKind?: 'pi' | 'codex';
  remoteHostId?: string;
  agentDeviceId?: string;
} = {}) {
  const providers = options.providers ?? [provider()];
  const backend = options.backendProviders ?? providers;
  const agentKind = options.agentKind ?? 'pi';
  const selectedProviderId = options.providerId ?? providerId;
  const selectedModel = options.model ?? modelId;
  const chatPrefs = Object.freeze({ effort: options.effort ?? 'medium' });
  const errors: unknown[] = [];
  const availableProviders = (agent: 'pi' | 'codex' | 'claude-code') =>
    backend.filter(p => p.connected).map(p => ({ id: p.id, name: p.name,
      models: (p.models[agent] ?? []).map(m => m.id),
      effortMetaByModel: Object.fromEntries((p.models[agent] ?? []).map(m => [m.id, m])),
    }));
  const routing = {
    availability: {
      pi: availableProviders('pi'), codex: availableProviders('codex'),
      'claude-code': availableProviders('claude-code'),
    },
    resolveDefaultProviderIdForModel: () => selectedProviderId,
  };
  const admit = (selection: Parameters<typeof resolveSessionExecutionSelection>[0]['selection']) =>
    resolveSessionExecutionSelection({ selection, availableAgents: [agentKind],
      availableModels: backend.flatMap(p => p.models[agentKind] ?? []),
      providerRouting: routing, hasCindyAiApiKey: false });
  const ipcCreate = vi.fn(async (body) => ({
    ...body, ...admit(body), id: 'created', workingDir: '/isolated/dialogue',
  }));
  const setGoal = vi.fn(async () => {
    // Goal starts from the newly persisted selection rather than receiving an
    // independent effort argument. Exercise admission on that creation result.
    admit(await ipcCreate.mock.results[0].value);
  });
  // Real renderer adapter forwards to the simulated IPC transport, whose receiving
  // side runs Main's production admission. No real database or user profile is opened.
  vi.stubGlobal('window', { electronAPI: { localDb: { sessions: { create: ipcCreate } }, maker: { setGoal } } });
  const createSession = vi.fn(async (body) => {
    try { return await createSessionViaIpc(body); }
    catch (error) { errors.push(error); return null; }
  });
  const sendMessage = vi.fn(async (_id, _text, model, effort) => {
    admit({ model, effort, agentKind, providerId: selectedProviderId });
    return true;
  });
  let done!: () => void;
  const finished = new Promise<void>(resolve => { done = resolve; });
  const noop = () => {};
  const environment = {
    ...draftEffort, getModel, window,
    localProviders: providers, localProvidersLoading: false, providers,
    capabilityAgentKind: agentKind, persistedAgentKind: agentKind,
    calibratedDraftModel: selectedModel, chatPrefs, getProviderModelEffort: () => undefined,
    chatInitialProviderId: selectedProviderId, chatInitialPermissionMode: 'default',
    effectiveSourceId: selectedProviderId,
    sendInFlightRef: { current: false }, effectiveCollab: { enabled: false },
    collabPolicy: { enabled: false }, collabPolicyEligible: false,
    usesDeviceCatalog: !!options.agentDeviceId, deviceLinkInitial: null,
    isDeviceLinkDraft: false, isRemoteProjectDraft: !!options.remoteHostId,
    isAgentDeviceDraft: !!options.agentDeviceId, remoteModelListStatus: 'ready', remoteDraftState: { status: 'ready' },
    effectiveRemoteHostId: options.remoteHostId, effectiveAgentDeviceId: options.agentDeviceId,
    effectiveWorkingDir: options.remoteHostId ? '/remote/project' : null,
    effectiveExtraDirs: [], effectiveWritableDirs: [], effectiveFastMode: false, effectivePlanMode: false,
    effectiveDeviceLinkDeviceId: undefined, catalogDeviceId: undefined,
    matchNavigationCommandName: () => null,
    wtRef: { current: { enabled: false, confirmedIneligible: true } },
    wtPreferenceSavingRef: { current: false }, wtPreferenceAuthorityUnknownRef: { current: false },
    wtBranchPreferenceSavingRef: { current: false },
    getDataOwnerGeneration: () => ({ dataOwnerId: 'fixture' }), dataOwnerId: 'fixture',
    isDataOwnerGenerationCurrent: () => true,
    markSendInFlight: (value: boolean) => { if (!value) done(); },
    t: (key: string) => key, authVendor: agentKind,
    vendorAuthGate: { checkAndConfirm: async () => ({ proceed: true }) },
    localDraftSessionIdRef: { current: 'draft-id' }, optimisticFirstMessageTitle: () => null,
    createSession, toastCreateSessionFailed: noop, carryDraftFavoriteAnchorToSession: noop,
    makerChatStore: { setSessionRuntime: noop, sendMessage, autoNameSession: noop }, sessionsStore: { patchLocal: noop },
    markSessionStarting: noop, clearSessionStarting: noop,
    rehomeDraftAttachments: async () => [], getComposerDraft: () => null,
    NEW_MAKER_DRAFT_KEY: 'fixture', rewriteBrowserCommentsFromRehomedFiles: () => [],
    leadingSlashInvocation: () => null,
    rewritePiSkillMessageForSend: async ({ message }: { message: string }) => message,
    clearComposerDraftAndNotify: noop, attachmentState: { clearFiles: noop },
    resetDraftWorkspaceAfterSend: noop, navigate: vi.fn(), setWtCreating: noop,
    dispatchDeferredUiAssignment: async () => {},
    isRemotePrecreatedWorktreeOwnerChangedError: () => false,
    isRemotePrecreatedWorktreeCleanupPendingError: () => false,
    getRemoteWorkingDirErrorMessage: () => null,
    emitAutoTitlePreviewCleared: noop, restoreRemoteOptimisticDraft: noop,
    normalizeAutoTitle: () => null,
    isLocalGoalWorktreeCleanupPendingError: () => false,
    plainTextToTiptapDoc: noop, excludeCommentScreenshots: () => [],
    log: { warn: (...args: unknown[]) => errors.push(args), error: (...args: unknown[]) => errors.push(args) },
    toast: { error: noop, warning: noop },
  };
  const localDraftEffort = runInNewContext(executable('localDraftEffort'), environment)();
  const selection = runInNewContext(executable('draftInitialSelection'), { ...environment, localDraftEffort })();
  Object.assign(environment, { draftInitialModel: selection.model, draftInitialEffort: selection.effort });
  const callback = runInNewContext(executable(options.entry === 'goal' ? 'handleCreateGoal' : 'handleSend'), environment);
  try {
    if (options.entry === 'goal') {
      try { await callback('hello goal', goalLimits); }
      catch (error) { errors.push(error); }
    } else {
      await callback('hello', selectedModel, options.submittedEffort ?? selection.effort ?? '',
        'default', [], [], { providerId: selectedProviderId });
    }
    await finished;
    return { createSession, ipcCreate, sendMessage, setGoal, errors, environment };
  } finally { vi.unstubAllGlobals(); }
}

describe('homepage submission to Main admission and first-message handoff', () => {
  it.each(['low', 'medium', 'high', 'xhigh'] as const)('omits remembered %s for a known no-effort Pi model', async effort => {
    const result = await submit({ effort, submittedEffort: effort });
    expect(result.errors).toEqual([]);
    expect(result.createSession).toHaveBeenCalledWith(expect.objectContaining({
      model: modelId, providerId, agentKind: 'pi', effort: '',
    }));
    expect(result.ipcCreate.mock.calls[0][0].effort).toBe('');
    expect(result.environment.chatPrefs.effort).toBe(effort);
    expect(result.sendMessage).toHaveBeenCalledWith('created', 'hello', modelId, '',
      'default', '/isolated/dialogue', [], [], expect.any(Object));
  });
  it('preserves a supported effort for the exact provider, even when another has no efforts', async () => {
    const result = await submit({ providers: [provider(), provider('other', ['high'])], providerId: 'other', effort: 'high' });
    expect(result.errors).toEqual([]);
    expect(result.createSession.mock.calls[0][0].effort).toBe('high');
    expect(result.sendMessage.mock.calls[0][3]).toBe('high');
  });
  it('still rejects an explicitly invalid effort on a model with supported levels', async () => {
    const result = await submit({ providers: [provider(providerId, ['high'])], submittedEffort: 'medium' });
    expect(String(result.errors[0])).toContain('not supported');
    expect(result.sendMessage).not.toHaveBeenCalled();
  });
  it('does not use a different provider when the submitted identity is absent', async () => {
    const result = await submit({ providerId: 'absent' });
    expect(result.createSession.mock.calls[0][0].effort).toBe('medium');
    expect(result.errors).toHaveLength(1);
    expect(result.sendMessage).not.toHaveBeenCalled();
  });
  it('preserves unknown effort capability', async () => {
    const p = provider(); p.models.pi![0].effortsUnknown = true;
    const result = await submit({ providers: [p] });
    expect(result.errors).toEqual([]);
    expect(result.sendMessage.mock.calls[0][3]).toBe('medium');
  });
  it('does not treat an unloaded catalog as an explicit empty effort table', async () => {
    const result = await submit({ providers: [], backendProviders: [provider(providerId, ['medium'])] });
    expect(result.errors).toEqual([]);
    expect(result.sendMessage.mock.calls[0][3]).toBe('medium');
  });
  it('preserves the supported Pi selection and SSH host routing', async () => {
    const result = await submit({ remoteHostId: 'fixture-host', providers: [provider(providerId, ['medium'])] });
    expect(result.errors).toEqual([]);
    expect(result.sendMessage.mock.calls[0][3]).toBe('medium');
    expect(result.ipcCreate.mock.calls[0][0].remoteHostId).toBe('fixture-host');
  });
  it('does not use local metadata for an Agent running on another computer', async () => {
    const result = await submit({ agentDeviceId: 'other-computer', backendProviders: [provider(providerId, ['medium'])] });
    expect(result.errors).toEqual([]);
    expect(result.sendMessage.mock.calls[0][3]).toBe('medium');
  });
  it('selects metadata by engine as well as provider and model', async () => {
    const p = provider();
    p.models.codex = [{ ...p.models.pi![0], efforts: ['medium'], defaultEffort: 'medium' }];
    const result = await submit({ agentKind: 'codex', providers: [p] });
    expect(result.errors).toEqual([]);
    expect(result.sendMessage.mock.calls[0][3]).toBe('medium');
  });
  it('retains the draft preference when switching away and back to a supported model', async () => {
    const memory = Object.freeze({ effort: 'high' as const });
    const noEffort = await submit({ effort: memory.effort });
    expect(noEffort.errors).toEqual([]);
    expect(noEffort.sendMessage.mock.calls[0][3]).toBe('');
    const supported = await submit({ providers: [provider(providerId, ['low', 'high'])],
      effort: noEffort.environment.chatPrefs.effort,
    });
    expect(supported.errors).toEqual([]);
    expect(supported.sendMessage.mock.calls[0][3]).toBe('high');
    expect(memory.effort).toBe('high');
  });
  it('does not bypass disconnected-provider admission', async () => {
    const p = provider(); p.connected = false;
    const result = await submit({ providers: [p] });
    expect(result.errors).toHaveLength(1);
    expect(result.sendMessage).not.toHaveBeenCalled();
  });
});

describe('homepage New Goal submission to Main admission and goal start', () => {
  it.each(['low', 'medium', 'high', 'xhigh'] as const)('omits remembered %s for a known no-effort Pi model before starting the goal', async effort => {
    const result = await submit({ entry: 'goal', effort });
    expect(result.errors).toEqual([]);
    expect(result.ipcCreate.mock.calls[0][0]).toMatchObject({ model: modelId, providerId, agentKind: 'pi' });
    expect(result.ipcCreate.mock.calls[0][0].effort).toBe('');
    expect(result.setGoal).toHaveBeenCalledWith({ sessionId: 'created', objective: 'hello goal', limits: goalLimits });
    expect(result.sendMessage).not.toHaveBeenCalled();
    expect(result.environment.chatPrefs.effort).toBe(effort);
  });
  it('honors the exact provider rather than another provider with an empty table', async () => {
    const result = await submit({ entry: 'goal', providers: [provider(), provider('other', ['high'])], providerId: 'other', effort: 'high' });
    expect(result.errors).toEqual([]);
    expect(result.ipcCreate.mock.calls[0][0].effort).toBe('high');
    expect(result.setGoal).toHaveBeenCalledOnce();
  });
  it('calibrates the remembered goal effort against the supported table before creation', async () => {
    const result = await submit({ entry: 'goal', providers: [provider(providerId, ['high'])] });
    expect(result.errors).toEqual([]);
    expect(result.ipcCreate.mock.calls[0][0].effort).toBe('high');
    expect(result.environment.chatPrefs.effort).toBe('medium');
    expect(result.setGoal).toHaveBeenCalledOnce();
  });
  it('keeps Main rejection when authoritative goal capabilities differ from the draft catalog', async () => {
    const result = await submit({ entry: 'goal', providers: [provider(providerId, ['medium'])],
      backendProviders: [provider(providerId, ['high'])] });
    expect(String(result.errors[0])).toContain('not supported');
    expect(result.setGoal).not.toHaveBeenCalled();
  });
  it('preserves unknown capability', async () => {
    const p = provider(); p.models.pi![0].effortsUnknown = true;
    const result = await submit({ entry: 'goal', providers: [p] });
    expect(result.errors).toEqual([]);
    expect(result.ipcCreate.mock.calls[0][0].effort).toBe('medium');
    expect(result.setGoal).toHaveBeenCalledOnce();
  });
  it('preserves the effort when the local catalog is not loaded', async () => {
    const result = await submit({ entry: 'goal', providers: [], backendProviders: [provider(providerId, ['medium'])] });
    expect(result.errors).toEqual([]);
    expect(result.ipcCreate.mock.calls[0][0].effort).toBe('medium');
    expect(result.setGoal).toHaveBeenCalledOnce();
  });
  it('preserves the supported Pi goal selection and SSH host routing', async () => {
    const result = await submit({ entry: 'goal', remoteHostId: 'remote-target', providers: [provider(providerId, ['medium'])] });
    expect(result.errors).toEqual([]);
    expect(result.ipcCreate.mock.calls[0][0].effort).toBe('medium');
    expect(result.ipcCreate.mock.calls[0][0].remoteHostId).toBe('remote-target');
    expect(result.setGoal).toHaveBeenCalledOnce();
  });
  it('does not apply local no-effort metadata to an Agent on another computer', async () => {
    const result = await submit({ entry: 'goal', agentDeviceId: 'remote-target', backendProviders: [provider(providerId, ['medium'])] });
    expect(result.errors).toEqual([]);
    expect(result.ipcCreate.mock.calls[0][0].effort).toBe('medium');
    expect(result.ipcCreate.mock.calls[0][0].agentDeviceId).toBe('remote-target');
    expect(result.setGoal).toHaveBeenCalledOnce();
  });
  it('uses the selected engine metadata', async () => {
    const p = provider();
    p.models.codex = [{ ...p.models.pi![0], efforts: ['medium'], defaultEffort: 'medium' }];
    const result = await submit({ entry: 'goal', agentKind: 'codex', providers: [p] });
    expect(result.errors).toEqual([]);
    expect(result.ipcCreate.mock.calls[0][0].effort).toBe('medium');
    expect(result.setGoal).toHaveBeenCalledOnce();
  });
  it('does not use a different provider when the goal target is absent', async () => {
    const result = await submit({ entry: 'goal', providerId: 'absent' });
    expect(result.ipcCreate.mock.calls[0][0].effort).toBe('medium');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.setGoal).not.toHaveBeenCalled();
  });
  it('does not bypass disconnected-provider admission for a goal', async () => {
    const p = provider(); p.connected = false;
    const result = await submit({ entry: 'goal', providers: [p] });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.setGoal).not.toHaveBeenCalled();
  });
});

describe.each(['send', 'goal'] as const)('%s draft model identity', entry => {
  it('uses the selected model rather than another model with no effort levels', async () => {
    const p = provider();
    p.models.pi!.push({ ...p.models.pi![0], id: 'supported-model', efforts: ['high'], defaultEffort: 'high' });
    const result = await submit({ entry, model: 'supported-model', effort: 'high', providers: [p] });
    expect(result.errors).toEqual([]);
    expect(result.ipcCreate.mock.calls[0][0]).toMatchObject({ model: 'supported-model', effort: 'high', providerId });
  });
  it('preserves the draft effort when the exact model is missing from a loaded provider', async () => {
    const p = provider();
    p.models.pi = [];
    const result = await submit({ entry, providers: [p], backendProviders: [provider(providerId, ['medium'])] });
    expect(result.errors).toEqual([]);
    expect(result.ipcCreate.mock.calls[0][0].effort).toBe('medium');
    expect(result.environment.chatPrefs.effort).toBe('medium');
  });
});
