import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { buildUserProvider, connectedProvidersForAgent, getModel, isModelSelectableForNewRoute, type PiReasoningEffort, type ProviderView } from '@cindy/model-providers';
import { createWorkerLabel } from '../workerLabel';
import type { CollabDraft } from '@/state/newMakerDraft';
import { resolveSessionExecutionSelection } from '../../../../main/maker-ipc/sessionExecutionSelection';
import * as draftEffort from '../newMakerDraftModelPrefs';
import { resolveDeviceLinkSubmission } from '../deviceLinkCreateArgs';
import { parseRemoteWorktreeCreateResult } from '../remotePrecreatedWorktree';
import { create as createSessionViaIpc } from '@/lib/sessionService';
import type { Effort } from '@/lib/userPreferences.types';
import type { AgentSkillCommand } from '@cindy/maker-core';
import { plainTextToTiptapDoc, type BuiltInSkillDraftIntent } from '@/lib/composerDraftStore';
import { leadingSlashInvocation, rebaseInlineRangesAfterSlashCommandRewrite, rewriteBuiltInSkillDraftForSend } from '@/lib/slashCommands';

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
const collabBuilder = source.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'draftEnableOrcaOptions');
if (!collabBuilder) throw new Error('Draft collaboration builder missing');
const collabBuilderCode = ts.transpileModule(`${collabBuilder.getText(source)}; draftEnableOrcaOptions`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
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
  agentKind?: 'pi' | 'codex' | 'claude-code';
  remoteHostId?: string;
  agentDeviceId?: string;
  message?: string;
  builtInSkillIntent?: BuiltInSkillDraftIntent;
  skills?: AgentSkillCommand[];
  worktreeSkills?: AgentSkillCommand[];
  deviceId?: string;
  worktreeSkillsAfterCollab?: AgentSkillCommand[];
  collab?: CollabDraft;
  slashCommandRanges?: Array<{ start: number; end: number }>;
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
  // Synthetic IPC paths; no filesystem is touched by these renderer fixtures.
  const baseRepo = '/fixture/repo';
  const worktreePath = '/fixture/repo/.cindy-worktrees/creator';
  const hasWorktree = options.worktreeSkills !== undefined;
  let worktreeSkills = options.worktreeSkills;
  const listAgentSkills = vi.fn(async (_agent, params) => ({ success: true,
    skills: params?.workingDir === worktreePath ? worktreeSkills : options.skills ?? [],
  }));
  const invokeRemote = vi.fn(async (_deviceId, channel, args) => {
    if (channel === 'maker:list-agent-skills') return listAgentSkills(args[0], args[1]);
    if (channel === 'maker:list-agent-commands') return { success: true, commands: [] };
    if (channel === 'worktree:create') return { ok: true,
      meta: { ...args[0], path: worktreePath, branch: 'cindy/creator', createdAt: new Date().toISOString() } };
    if (channel === 'maker:create-session') return { sessionId: args[0].id, workDir: args[0].workingDir };
    throw new Error(`Unexpected remote invoke: ${channel}`);
  });
  const enableOrca = vi.fn(async () => {
    worktreeSkills = options.worktreeSkillsAfterCollab;
    return { workerSessionId: 'worker' };
  });
  vi.stubGlobal('window', { electronAPI: {
    deviceLink: { invoke: invokeRemote },
    worktreeCreate: vi.fn(async () => ({ ok: true, meta: { path: worktreePath, branch: 'cindy/creator' } })),
    localDb: { sessions: { create: ipcCreate } }, maker: {
    enableOrca,
    setGoal, listAgentSkills,
    listDesktopCommands: async () => ({ success: true, commands: [] }),
    listAgentCommands: async () => ({ success: true, commands: [] }),
  } } });
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
  let finishWorktree!: () => void;
  const worktreeFinished = new Promise<void>(resolve => { finishWorktree = resolve; });
  const noop = () => {};
  const setPending = vi.fn();
  const toastError = vi.fn();
  const environment = {
    ...draftEffort, getModel, window,
    localProviders: providers, localProvidersLoading: false, providers,
    capabilityAgentKind: agentKind, persistedAgentKind: agentKind,
    calibratedDraftModel: selectedModel, chatPrefs, getProviderModelEffort: () => undefined,
    chatInitialProviderId: selectedProviderId, chatInitialPermissionMode: 'default',
    effectiveSourceId: selectedProviderId,
    sendInFlightRef: { current: false }, effectiveCollab: options.collab ?? { enabled: !!options.worktreeSkillsAfterCollab },
    collabPolicy: { enabled: true }, collabPolicyEligible: true,
    usesDeviceCatalog: !!options.agentDeviceId || !!options.deviceId, deviceLinkInitial: null,
    isDeviceLinkDraft: !!options.deviceId, isRemoteProjectDraft: !!options.remoteHostId,
    isAgentDeviceDraft: !!options.agentDeviceId, remoteModelListStatus: 'ready', remoteDraftState: { status: 'ready' },
    effectiveRemoteHostId: options.remoteHostId, effectiveAgentDeviceId: options.agentDeviceId,
    effectiveWorkingDir: hasWorktree ? baseRepo : options.remoteHostId ? '/remote/project' : null,
    effectiveExtraDirs: [], effectiveWritableDirs: [], effectiveFastMode: false, effectivePlanMode: false,
    effectiveDeviceLinkDeviceId: options.deviceId, effectiveDeviceLinkDeviceName: options.deviceId, catalogDeviceId: options.deviceId,
    agentCatalogProviders: providers, deviceProvidersLoading: false,
    matchNavigationCommandName: () => null,
    wtRef: { current: hasWorktree
      ? { enabled: true, confirmedIneligible: false, baseRepo, name: 'creator', sourceBranch: 'other-branch', branchPreferenceReady: true, supportsRecoveryKeyDiscard: true }
      : { enabled: false, confirmedIneligible: true } },
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
    rehomeDraftAttachments: async () => [], getComposerDraft: () => options.builtInSkillIntent
      ? { builtInSkillIntent: options.builtInSkillIntent } : null,
    NEW_MAKER_DRAFT_KEY: 'fixture', rewriteBrowserCommentsFromRehomedFiles: () => [],
    leadingSlashInvocation, rebaseInlineRangesAfterSlashCommandRewrite, rewriteBuiltInSkillDraftForSend, setPending,
    rewritePiSkillMessageForSend: async ({ message }: { message: string }) => message,
    clearComposerDraftAndNotify: noop, attachmentState: { clearFiles: noop },
    resetDraftWorkspaceAfterSend: noop, navigate: vi.fn(), setWtCreating: noop,
    makeDraftSessionId: () => 'remote-created', resolveDeviceLinkSubmission, parseRemoteWorktreeCreateResult,
    recoverPendingRemotePrecreatedWorktrees: vi.fn(async () => ({ storageReadable: true, retained: 0 })),
    registerPendingRemotePrecreatedWorktree: async () => true,
    createRemoteSessionWithPrecreatedWorktree: async ({ invoke, createArgs }: {
      invoke: (channel: string, args: unknown[]) => Promise<{ sessionId: string }>; createArgs: unknown;
    }) => (await invoke('maker:create-session', [createArgs])).sessionId,
    commitRemoteSessionHandoff: () => {}, rememberRecoverableHandoff: () => {},
    getBranchName: (name: string) => `cindy/${name}`,
    sessionService: { touchUserSend: async () => {}, get: async () => ({ status: 'active' }), update: async () => {} },
    crossAgentConvertService: { detect: async () => ({ items: [] }) },
    refreshWorktreeForSession: async () => {},
    worktreeCreationStore: { clear: finishWorktree, set: (_id: string, state: { status: string }) => {
      if (state.status === 'failed') finishWorktree();
    } },
    saveComposerDraft: vi.fn(),
    draftEnableOrcaOptions: () => ({}), createDeferredUiAssignment: () => undefined,
    rememberDeferredUiAssignment: () => {}, getCurrentRoutePath: () => '/elsewhere',
    dispatchDeferredUiAssignment: async () => {},
    isRemotePrecreatedWorktreeOwnerChangedError: () => false,
    isRemotePrecreatedWorktreeCleanupPendingError: () => false,
    getRemoteWorkingDirErrorMessage: () => null,
    emitAutoTitlePreviewCleared: noop, restoreRemoteOptimisticDraft: noop,
    normalizeAutoTitle: () => null,
    isLocalGoalWorktreeCleanupPendingError: () => false,
    plainTextToTiptapDoc, excludeCommentScreenshots: () => [],
    log: { warn: (...args: unknown[]) => errors.push(args), error: (...args: unknown[]) => errors.push(args) },
    toast: { error: toastError, warning: noop },
  };
  if (options.collab) {
    environment.draftEnableOrcaOptions = runInNewContext(collabBuilderCode, {
      ...environment, connectedProvidersForAgent, isModelSelectableForNewRoute, createWorkerLabel,
    });
  }
  const localDraftEffort = runInNewContext(executable('localDraftEffort'), environment)();
  const selection = runInNewContext(executable('draftInitialSelection'), { ...environment, localDraftEffort })();
  Object.assign(environment, { draftInitialModel: selection.model, draftInitialEffort: selection.effort });
  const callback = runInNewContext(executable(options.entry === 'goal' ? 'handleCreateGoal' : 'handleSend'), environment);
  try {
    if (options.entry === 'goal') {
      try { await callback('hello goal', goalLimits); }
      catch (error) { errors.push(error); }
    } else {
      await callback(options.message ?? 'hello', selectedModel, options.submittedEffort ?? selection.effort ?? '',
        'default', [], [], { providerId: selectedProviderId, slashCommandRanges: options.slashCommandRanges });
    }
    await finished;
    if (hasWorktree && createSession.mock.calls.length) await worktreeFinished;
    return { createSession, ipcCreate, sendMessage, setGoal, errors, environment, setPending, toastError, listAgentSkills, invokeRemote, enableOrca };
  } finally { vi.unstubAllGlobals(); }
}

describe('homepage submission to Main admission and first-message handoff', () => {
  // PR #6787, unit: the form stored both computers but the real draft builder
  // dropped the model computer. Existing route tests stubbed that builder. Use
  // the same production callback harness with the actual builder and assert IPC.
  it.each(['send', 'goal'] as const)('forwards both Worker computers when creating a local %s', async entry => {
    const result = await submit({ entry, collab: { enabled: true, worker: 'codex', workerConfig: {
      role: 'developer', model: 'remote-only', providerId: 'remote-provider',
      executionDeviceId: 'work-pc', executionWorkingDir: '/worker', agentDeviceId: 'model-pc',
    } } });
    expect(result.errors).toEqual([]);
    expect(result.enableOrca).toHaveBeenCalledExactlyOnceWith('created', expect.objectContaining({
      workerAgent: 'codex', model: 'remote-only', providerId: 'remote-provider',
      executionDeviceId: 'work-pc', workingDir: '/worker', agentDeviceId: 'model-pc',
    }));
  });
  // Unit: a Claude-prefilled creator draft must be resolved again after switching
  // to Pi, including when Pi uses another computer as its provider. Exercise the
  // actual home submit callback before any session creation/handoff.
  it('re-resolves the built-in creator for the final engine before handing off the first message', async () => {
    const result = await submit({
      message: '/cindy:cindy-plugin-creator Make a plugin', agentDeviceId: 'provider-computer',
      providers: [provider(providerId, ['medium'])],
      slashCommandRanges: [{ start: 0, end: '/cindy:cindy-plugin-creator'.length }],
      builtInSkillIntent: { name: 'cindy-plugin-creator', commandName: 'cindy:cindy-plugin-creator' },
      skills: [{ kind: 'agent-skill', source: 'skill', name: 'cindy-plugin-creator', builtIn: true, runtimeCommandName: 'skill:cindy-plugin-creator' }],
    });
    expect(result.errors).toEqual([]);
    expect(result.listAgentSkills).toHaveBeenCalledWith('pi', { forceReload: true });
    expect(result.ipcCreate.mock.calls[0][0].agentDeviceId).toBe('provider-computer');
    expect(result.setPending).toHaveBeenCalledWith('created', expect.objectContaining({
      text: '/skill:cindy-plugin-creator Make a plugin',
      builtInSkillIntent: { name: 'cindy-plugin-creator', commandName: 'skill:cindy-plugin-creator' },
      slashCommandRanges: [{ start: 0, end: '/skill:cindy-plugin-creator'.length }],
    }));
  });
  it('preserves the creator draft without creating a session when the final environment lacks the built-in', async () => {
    const result = await submit({
      message: '/cindy:cindy-plugin-creator Make a plugin',
      builtInSkillIntent: { name: 'cindy-plugin-creator', commandName: 'cindy:cindy-plugin-creator' },
      skills: [{ kind: 'agent-skill', source: 'skill', name: 'cindy-plugin-creator' }],
    });
    expect(result.errors).toEqual([]);
    expect(result.createSession).not.toHaveBeenCalled();
    expect(result.setPending).not.toHaveBeenCalled();
    expect(result.toastError).toHaveBeenCalledWith('settings.ghosts.page.creatorUnavailable');
    expect(result.environment.getComposerDraft()?.builtInSkillIntent).toBeDefined();
  });
  // PR #6433: the selected source branch can add/remove a conflicting project
  // skill. The complete send callback must use the post-checkout catalog (unit).
  it.each([
    [undefined, 'cindy-plugin-creator', 'cindy:cindy-plugin-creator'],
    [undefined, 'cindy:cindy-plugin-creator', 'cindy-plugin-creator'],
    ['task-computer', 'cindy-plugin-creator', 'cindy:cindy-plugin-creator'],
    ['task-computer', 'cindy:cindy-plugin-creator', 'cindy-plugin-creator'],
  ])('resolves the final worktree command on %s: %s to %s', async (deviceId, before, after) => {
    const original = 'cindy:cindy-plugin-creator';
    const p = provider();
    p.models['claude-code'] = [{ ...p.models.pi![0], efforts: ['medium'], defaultEffort: 'medium' }];
    const result = await submit({
      agentKind: 'claude-code', providers: [p], message: `/${original} Make a plugin`, deviceId,
      slashCommandRanges: [{ start: 0, end: original.length + 1 }],
      builtInSkillIntent: { name: 'cindy-plugin-creator', commandName: original },
      skills: [{ kind: 'agent-skill', source: 'skill', name: before, builtIn: true }],
      worktreeSkills: [{ kind: 'agent-skill', source: 'skill', name: after, builtIn: true }],
    });
    expect(result.errors).toEqual([]);
    if (deviceId) {
      expect(result.setPending).toHaveBeenCalledWith('remote-created', expect.objectContaining({
        text: `/${after} Make a plugin`, builtInSkillIntent: { name: 'cindy-plugin-creator', commandName: after }, slashCommandRanges: [{ start: 0, end: after.length + 1 }],
      }));
    } else {
      expect(result.sendMessage).toHaveBeenCalledWith('created', `/${after} Make a plugin`,
        modelId, 'medium', 'default', '/fixture/repo/.cindy-worktrees/creator', [], [],
        expect.objectContaining({ slashCommandRanges: [{ start: 0, end: after.length + 1 }] }));
    }
  });
  it('resolves the built-in identity after asynchronous collaboration preparation', async () => {
    const p = provider();
    p.models['claude-code'] = [{ ...p.models.pi![0], efforts: ['medium'], defaultEffort: 'medium' }];
    const official: AgentSkillCommand = { kind: 'agent-skill', source: 'skill', name: 'cindy-plugin-creator', builtIn: true };
    const result = await submit({
      agentKind: 'claude-code', providers: [p], message: '/cindy-plugin-creator Make a plugin',
      builtInSkillIntent: { name: 'cindy-plugin-creator', commandName: 'cindy-plugin-creator' },
      skills: [official], worktreeSkills: [official],
      worktreeSkillsAfterCollab: [{ ...official, builtIn: false }, { ...official, name: 'cindy:cindy-plugin-creator' }],
    });
    expect(result.errors).toEqual([]);
    expect(result.sendMessage.mock.calls[0]?.[1]).toBe('/cindy:cindy-plugin-creator Make a plugin');
  });
  it.each([undefined, 'task-computer'])('retains the first message when the final worktree on %s lacks the built-in creator', async deviceId => {
    const result = await submit({
      message: '/cindy-plugin-creator Make a plugin', deviceId,
      builtInSkillIntent: { name: 'cindy-plugin-creator', commandName: 'cindy-plugin-creator' },
      skills: [{ kind: 'agent-skill', source: 'skill', name: 'cindy-plugin-creator', builtIn: true }],
      worktreeSkills: [{ kind: 'agent-skill', source: 'skill', name: 'cindy-plugin-creator' }],
    });
    expect(result.errors).toEqual([]);
    expect(result.sendMessage).not.toHaveBeenCalled();
    if (deviceId) {
      expect(result.setPending).not.toHaveBeenCalled();
      expect(result.invokeRemote.mock.calls.some(([, channel]) => channel === 'maker:create-session')).toBe(false);
      expect(result.environment.recoverPendingRemotePrecreatedWorktrees).toHaveBeenCalledTimes(2);
      expect(result.environment.recoverPendingRemotePrecreatedWorktrees).toHaveBeenLastCalledWith(expect.objectContaining({
        deviceId, dataOwnerId: 'fixture',
      }));
      expect(result.invokeRemote.mock.calls.every(([target]) => target === deviceId)).toBe(true);
    } else {
      expect(result.environment.saveComposerDraft).toHaveBeenCalledWith('created', expect.objectContaining({
        text: plainTextToTiptapDoc('/cindy-plugin-creator Make a plugin'),
        builtInSkillIntent: { name: 'cindy-plugin-creator', commandName: 'cindy-plugin-creator' },
      }));
    }
    expect(result.toastError).toHaveBeenCalledWith('settings.ghosts.page.creatorUnavailable');
  });
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
