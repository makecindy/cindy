import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { parseGoalCommand } from '@cindy/maker-shared/goal-command';
import { executeMobileGoalCommand, parseMobileDesktopCommand } from '@/session/desktopSlashCommands';
import { humanizeRemoteError } from '@/device-link/remoteStatus';
import { evictDeviceProviders, fetchDeviceProviders, retainedProviderModelKey, type RetainedProviderCatalog } from '@/device-link/deviceProvidersCache';
import { blockedSessionModelAtSend } from '@/session/sessionModelAtSend';
import { isPendingPlainText } from '@/session/outboxBackgroundSend';
import { buildOutboxItem } from '@/session/sessionOutbox';
import { incomingShareSlotOrder } from '@/session/mobileLocalAttachmentUpload';
import { composerDocumentProjectedText, emptyComposerDocument, normalizeComposerDocument, reconcileComposerProjectedText, serializeComposerDocument, textComposerDocument } from '@/session/composerDocument';
import { captureNewSessionOwner } from '@/session/newSessionForm';
import { reconcileNewSessionSubmitDraft } from '@/session/newSessionRuntimeReconciliation';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { deviceDisplayName } from '@/device-link/deviceName';
import {
  applyHostModelGroupResult, applyHostModelGroupRoute, buildHostModelGroupRouteNote, resolveHostModelGroup,
} from '@/session/hostModelGroups';

// Execute the actual page callbacks, excluding unrelated native/network UI.
function callback(path: string, name: string) {
  const source = ts.createSourceFile(path, readFileSync(resolve(process.cwd(), path), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body = '';
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) {
      body = node.initializer.arguments[0].getText(source);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!body) throw new Error(`Missing page callback ${name}`);
  return (bindings: Record<string, unknown>) => new Function(...Object.keys(bindings), ts.transpileModule(`return (${body});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(bindings));
}
const newCreate = callback('app/sessions/new.tsx', 'create');
const goalCreate = callback('app/sessions/new.tsx', 'createGoalSession');
const sessionSource = ts.createSourceFile('session.tsx', readFileSync(resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let sendSource = '';
let readRouteParamSource = '';
function findSend(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'send') sendSource = node.getText(sessionSource);
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'readRouteParam') readRouteParamSource = node.getText(sessionSource);
  ts.forEachChild(node, findSend);
}
findSend(sessionSource);
if (!sendSource) throw new Error('Missing complete SessionScreen.send entry');
if (!readRouteParamSource) throw new Error('Missing SessionScreen.readRouteParam helper');
// Keep page-local route parsing with send; missing closure dependencies would
// otherwise be caught by send and surface only as a misleading outbox failure.
const compiledExisting = ts.transpileModule(`${readRouteParamSource}\n${sendSource}\nreturn send;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function newHarness(text = '/goal target', overrides: (bindings: Record<string, unknown>) => void = () => {}) {
  setMobileAuthOwner('test-user');
  const noop = vi.fn();
  const draft = { agentKind: 'pi', model: 'test-model', providerId: 'test-provider', workspaceKind: 'dialogue', workingDir: '', firstMessage: text, agentDeviceId: 'agent-device' };
  const bindings = {
    deviceDisplayName,
    parseGoalCommand, parseMobileDesktopCommand,
    firstMessageRef: { current: text }, slashCommands: [], pendingGoalSkillRef: { current: null as string | null },
    creatingRef: { current: false }, voiceIsBusy: false, attachmentsRef: { current: [] as unknown[] }, pendingUploads: [] as unknown[],
    createMessageSession: vi.fn(), createGoalSession: vi.fn(),
    setError: vi.fn(), setGoalError: vi.fn(), setContextSheetView: vi.fn(), setContextSheetOpen: vi.fn(), t: (key: string) => key,
    leaveForeignOutboxRecovery: () => false, goalBusy: false, runtimePendingRef: { current: false },
    selectedDeviceId: 'host', selectedDeviceName: 'Host', selectedDeviceRef: { current: 'host' },
    draft, remoteAgentPick: {}, deviceProvidersRef: { current: { ready: false } },
    prepareWorktreeCreateIntent: () => ({ applicable: false, enabled: false }), isWorktreeCreateIntentCurrent: () => true,
    setCreating: noop, setGoalBusy: noop, auth: { user: { id: 'test-user' } },
    getMobileAuthOwner, isMobileAuthOwnerCurrent, captureNewSessionOwner,
    agentAuthVerdict: 'ready', applyRemoteAgentPick: (value: unknown) => value,
    // Built-in drafts only: no plugin engine picked.
    pluginEnginePick: null, pluginEngineWorktreeUnsupported: false, applyPluginEnginePick: (value: unknown) => value,
    createNewSessionId: () => 'new-goal-task', saveNewSessionPreferences: noop,
    getDeviceProvidersGen: () => 1, reconcileNewSessionSubmitDraft, targetAgentHasFast: () => false,
    withTransientRemoteRetry: (fn: () => Promise<unknown>) => fn(), openLink: noop, subscribe: vi.fn(async () => {}),
    buildRemoteCreateSessionOptions: (value: unknown) => value, normalizeCreateSessionResult: (value: unknown) => value,
    maker: { createSession: vi.fn(async () => ({ sessionId: 'new-goal-task' })),
      goal: { set: vi.fn(async () => {}) }, getSession: vi.fn(async () => ({ id: 'new-goal-task', title: 'Goal task' })) },
    collabDraft: null, remoteSessionStore: { upsertDeviceSession: noop, setPendingTitlePreview: noop },
    isDefaultDraftSessionTitle: () => false, waitForPendingUploads: noop,
    setAttachments: noop, setMediaAssetAttachments: noop, setAttachmentPreviews: noop, composerAnnotationsRef: { current: null },
    patchDraft: vi.fn(), router: { replace: vi.fn() }, humanizeRemoteError,
    // Model groups (model-groups.md §6.3): none selected unless a test picks one.
    activeHostModelGroup: null as { id: string; name: string } | null, basePillModelSummary: 'test-model',
    resolveHostModelGroup, applyHostModelGroupRoute, applyHostModelGroupResult, buildHostModelGroupRouteNote,
    remoteAgentCatalogs: [], i18nInstance: { language: 'en' },
    confirmAgentUnauthenticated: vi.fn(async () => ({ unauthenticated: false, fresh: null })),
  };
  overrides(bindings);
  bindings.createGoalSession = vi.fn(goalCreate(bindings));
  return { bindings, run: newCreate(bindings) as () => Promise<void> };
}

function existingHarness(args = 'target') {
  const initial = textComposerDocument(`/goal ${args}`);
  const release = vi.fn();
  const noop = vi.fn();
  const session = { id: 'existing-task', agentKind: 'pi', model: 'test-model', permissionMode: 'ask', workingDir: '/test-workdir' };
  const bindings = {
    setError: vi.fn(), setGoalError: vi.fn(), t: (key: string) => key,
    isRemoteSessionMissing: () => false, readSessionRowNow: () => session, goalBusy: false, setGoalBusy: vi.fn(),
    executeMobileGoalCommand, unarchiveSessionAfterSend: vi.fn(), sessionId: 'existing-task', deviceId: 'host', deviceIdRef: { current: 'host' },
    params: {} as Record<string, string | string[] | undefined>,
    outboxSessionAliveRef: { current: 'existing-task' }, getMobileAuthOwner: () => ({}), isMobileAuthOwnerCurrent: () => true,
    maker: { goal: { set: vi.fn(async () => {}), clear: vi.fn(async () => {}), getStatus: vi.fn(async () => ({ status: 'active', objective: 'target' })) } },
    remoteSessionStore: { setGoalStatus: vi.fn(), acquireSessionMessageWork: vi.fn(() => ({ release })), getSessionDeviceId: () => 'host' }, setContextSheetView: vi.fn(), setContextSheetOpen: vi.fn(),
    setGoalRestore: vi.fn(), router: { setParams: vi.fn() }, composerDocumentRef: { current: initial },
    // Native editors have a mounted handle without the optional WebView flush.
    composerInputRef: { current: { blur: vi.fn() } },
    setComposerVoiceHoldArmed: vi.fn(),
    composerDocumentsEqual: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
    applyComposerDocument: vi.fn(), normalizeComposerDocument, humanizeRemoteError,
    composerDraftHydrated: true, voiceState: 'idle', slashCommandsRef: { current: [] }, queueEditingRef: { current: null }, messageEditingRef: { current: null }, messageEditSubmittingRef: { current: false },
    composerDocumentProjectedText, serializeComposerDocument, reconcileComposerProjectedText, emptyComposerDocument,
    canUseComposer: true, attachments: [] as unknown[], attachmentsRef: { current: [] as unknown[] }, pendingUploads: [],
    sendInFlightRef: { current: false }, sending: false, setSending: vi.fn((_sending: boolean) => {}), currentSession: session,
    invalidateHistoryRecoveryNavigation: vi.fn(),
    outboxConnectionBlockedNow: () => false, getPendingUploadCount: () => 0,
    outboxRef: { current: [] }, remoteSessionRunning: false, currentTurnStreaming: false,
    offerMobileSessionRebalance: vi.fn(async () => {}), askMobileSessionRebalance: vi.fn(), invoke: vi.fn(),
    parseMobileLocalSystemCommand: () => null, parseMobileDesktopCommand, pendingSkillSelectionRef: { current: null },
    blockedSessionModelAtSend, remoteRetainedCatalog: undefined, remotePendingCatalog: undefined as RetainedProviderCatalog | undefined,
    composerDeviceProviders: { retainedCatalog: undefined as RetainedProviderCatalog | undefined },
    setModelSheetAgentKind: vi.fn(), setModelSheetOpen: vi.fn(),
    commandNeedsRemoteSession: () => false, extractMobileSessionReferences: () => [], outboxDispatchBlockedNow: () => false,
    runtimeOptions: { planModeSupported: true }, permissionModeOrAsk: (mode: string) => mode,
    dismissPromptRecommendation: noop, hydrateComposerMessageReferenceBodies: async (doc: unknown) => doc,
    resolvePastedSessionLinkLabel: noop, requestMessageListFollowLatest: noop, noteLocalSend: noop, hasPastePlaceholders: () => false,
    beginOutboxAttachmentHandoff: async () => ({ prepare: async () => [], release: noop }),
    attachmentPreviews: {}, incomingShareSlotOrder, buildOutboxItem, createOutboxClientId: () => 'ordinary-message',
    status: 'online', holdBackgroundConnection: () => noop, beginBackgroundWork: noop,
    isPendingPlainText, beginOutboxBackgroundSend: vi.fn(() => noop), mobileDebugLog: noop,
    mobileDurableOutbox: { add: vi.fn(async (_record: unknown) => {}) }, rememberSentAttachmentPreviews: noop,
    releaseUploadedSources: noop, setMediaAssetAttachments: noop, setAttachmentPreviews: noop,
    composerAnnotationsRef: { current: null }, setAttachments: noop, setAttachmentError: noop,
    voiceDictionaryLearningTrackerRef: { current: null }, formatRemoteError: String,
    getPendingCompanionReplyQuote: () => null, clearSentCompanionReplyQuote: noop,
  };
  bindings.setSending = vi.fn((value: boolean) => { bindings.sending = value; });
  bindings.applyComposerDocument = vi.fn((doc: typeof initial) => { bindings.composerDocumentRef.current = doc; });
  return { bindings, release, run: () => new Function(...Object.keys(bindings), compiledExisting)(...Object.values(bindings))() as Promise<void> };
}

describe('new task /goal page callback', () => {
  it('creates one actual task and sets its Goal exactly once, preserving the handoff lock', async () => {
    const h = newHarness();
    await h.run();
    await h.run();
    expect(h.bindings.setGoalError).toHaveBeenLastCalledWith(null);
    expect(h.bindings.maker.createSession).toHaveBeenCalledOnce();
    expect(h.bindings.maker.goal.set).toHaveBeenCalledExactlyOnceWith({ sessionId: 'new-goal-task', objective: 'target' });
    expect(h.bindings.router.replace).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ sessionId: 'new-goal-task' }) }));
    expect(h.bindings.createMessageSession).not.toHaveBeenCalled();
  });
  // PR #11866 review r4650525974, unit, real goal callback: a selected mode picks its source before the
  // sign-in checks. Gap: the goal path checked the draft's own agent first. Minimal input: the draft's agent
  // is signed out on the host, the mode routes to a signed-in Codex source (on the draft's agent computer, so the
  // harness's catalog guard is not involved). Failure: the goal is refused
  // with the old agent's sign-in hint, or the task is created on the draft's model.
  it('lets a selected mode create the goal on its own source when the draft\'s agent is signed out', async () => {
    const h = newHarness('/goal target', (bindings) => {
      Object.assign(bindings, {
        remoteAgentPick: null,
        activeHostModelGroup: { id: 'daily', name: 'Daily' },
        confirmAgentUnauthenticated: vi.fn(async () => ({ unauthenticated: true, fresh: null })),
      });
      Object.assign(bindings.maker as object, {
        resolveModelGroup: vi.fn(async () => ({ outcome: 'routed', groupName: 'Daily', decisionId: 'd1', modelName: 'GPT', sourceName: 'Work',
          route: { agentKind: 'codex', providerId: 'openai-work', model: 'gpt-6', agentDeviceId: 'agent-device' }, why: 'order', trace: [] })),
        commitModelGroupDecision: vi.fn(async () => {}), bindModelGroupSession: vi.fn(async () => {}),
        writeModelGroupRouteNote: vi.fn(async () => {}),
      });
    });
    await h.run();
    expect(h.bindings.confirmAgentUnauthenticated).not.toHaveBeenCalled();
    expect(h.bindings.maker.createSession).toHaveBeenCalledWith(expect.objectContaining({ agentKind: 'codex', model: 'gpt-6', providerId: 'openai-work' }));
    expect((h.bindings.maker as unknown as { bindModelGroupSession: () => void }).bindModelGroupSession).toHaveBeenCalledOnce();
  });
  it('opens the existing panel for bare /goal without creating a task', async () => {
    const h = newHarness('/goal'); await h.run();
    expect(h.bindings.setContextSheetView).toHaveBeenCalledWith('goal');
    expect(h.bindings.maker.createSession).not.toHaveBeenCalled();
  });
  it.each(['clear', 'stop', 'off', 'cancel', 'reset', 'none'])('rejects %s without an existing task', async alias => {
    const h = newHarness(`/goal ${alias}`); await h.run();
    expect(h.bindings.setError).toHaveBeenCalledWith('session.new.goalCommandNeedsSession');
    expect(h.bindings.maker.createSession).not.toHaveBeenCalled();
  });
  it('hands a failed Goal set back to the created task with its objective, without replay', async () => {
    const h = newHarness(); h.bindings.maker.goal.set.mockRejectedValueOnce(new Error('[CHANNEL_NOT_ALLOWED] old host'));
    await h.run(); await h.run();
    expect(h.bindings.maker.createSession).toHaveBeenCalledOnce();
    expect(h.bindings.maker.goal.set).toHaveBeenCalledOnce();
    expect(h.bindings.router.replace).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ sessionId: 'new-goal-task', goalObjective: 'target', goalError: expect.any(String) }) }));
  });
  it('keeps attachments and the command draft instead of creating a task', async () => {
    const h = newHarness(); h.bindings.attachmentsRef.current = [{}]; await h.run();
    expect(h.bindings.firstMessageRef.current).toBe('/goal target');
    expect(h.bindings.setError).toHaveBeenCalledWith('session.screen.goalCommandAttachments');
    expect(h.bindings.maker.createSession).not.toHaveBeenCalled();
  });
  it('preserves an explicit same-name Skill selection', async () => {
    const h = newHarness(); h.bindings.pendingGoalSkillRef.current = 'goal'; await h.run();
    expect(h.bindings.createMessageSession).toHaveBeenCalledOnce();
    expect(h.bindings.maker.goal.set).not.toHaveBeenCalled();
  });
});

describe('existing task /goal send boundary', () => {
  // #11693: the local command can finish, but a hidden model must not consume the next ordinary draft.
  it('preserves the follow-up and opens reselection when only the retained catalog marks the model hidden', async () => {
    const h = existingHarness();
    const base = await fetchDeviceProviders('host', async () => ({ providers: [], deferredProviderIds: ['off'] }));
    try {
      h.bindings.composerDeviceProviders.retainedCatalog = {
        base, key: retainedProviderModelKey({ agent: 'pi', modelId: 'test-model', providerId: null }),
        payload: { providers: [], modelVisibilityOverrides: { 'pi:off:test-model': false } },
      };
      await h.run();
      expect(h.bindings.maker.goal.set).toHaveBeenCalledOnce();
      const draft = textComposerDocument('ordinary follow-up');
      h.bindings.composerDocumentRef.current = draft;
      await h.run();
      expect(h.bindings.setModelSheetAgentKind).toHaveBeenCalledWith('pi');
      expect(h.bindings.setModelSheetOpen).toHaveBeenCalledWith(true);
      expect(h.bindings.composerDocumentRef.current).toEqual(draft);
      expect(h.bindings.mobileDurableOutbox.add).not.toHaveBeenCalled();
    } finally {
      evictDeviceProviders('host');
    }
  });

  it.each([false, true])('preserves a normal draft while checking a pending hidden model (connection blocked: %s)', async blocked => {
    const h = existingHarness();
    h.bindings.outboxConnectionBlockedNow = () => blocked;
    const intent = { targetAgentKind: 'codex', model: 'next', providerId: 'off', agentDeviceId: 'executor' };
    Object.assign(h.bindings.currentSession, { agentSwitchIntent: intent });
    const draft = textComposerDocument('next message');
    h.bindings.composerDocumentRef.current = draft;
    const base = await fetchDeviceProviders('executor', async () => ({ providers: [], deferredProviderIds: ['off'] }));
    try {
      await h.run();
      expect(h.bindings.setError).toHaveBeenCalledWith('models.picker.loadingDefault');
      h.bindings.remotePendingCatalog = { base, key: retainedProviderModelKey({ agent: 'codex', modelId: 'next', providerId: 'off' }),
        payload: { providers: [], modelVisibilityOverrides: { 'codex:off:next': false } } };
      await h.run();
      expect(h.bindings.setError).toHaveBeenCalledWith('session.common.modelHiddenReselect');
      expect(h.bindings.setModelSheetAgentKind).toHaveBeenCalledWith('codex');
      expect(h.bindings.composerDocumentRef.current).toEqual(draft);
      expect(h.bindings.mobileDurableOutbox.add).not.toHaveBeenCalled();
    } finally {
      evictDeviceProviders('executor');
    }
  });

  it('sets the associated task Goal and projects its real status', async () => {
    const h = existingHarness(); await h.run();
    expect(h.bindings.maker.goal.set).toHaveBeenCalledExactlyOnceWith({ sessionId: 'existing-task', objective: 'target' });
    expect(h.bindings.remoteSessionStore.setGoalStatus).toHaveBeenCalledWith('existing-task', { status: 'active', objective: 'target' });
    expect(h.bindings.applyComposerDocument).toHaveBeenCalledWith(emptyComposerDocument());
    expect(h.bindings.invalidateHistoryRecoveryNavigation).toHaveBeenCalledOnce();
  });
  it('bare /goal opens the existing panel', async () => {
    const h = existingHarness(''); await h.run();
    expect(h.bindings.setContextSheetOpen).toHaveBeenCalledWith(true);
    expect(h.bindings.maker.goal.set).not.toHaveBeenCalled();
  });
  it('keeps bare /goal when the host cannot read Goal status', async () => {
    const h = existingHarness('');
    h.bindings.maker.goal.getStatus.mockRejectedValueOnce(new Error('[CHANNEL_NOT_ALLOWED] old host'));
    await h.run();
    expect(h.bindings.applyComposerDocument).not.toHaveBeenCalled();
    expect(h.bindings.setContextSheetOpen).not.toHaveBeenCalled();
    expect(h.bindings.setError).toHaveBeenCalledWith(humanizeRemoteError(new Error('[CHANNEL_NOT_ALLOWED] old host')));
  });
  it.each(['[CHANNEL_NOT_ALLOWED] old host', '[NOT_CONNECTED] offline'])('retains the draft on %s', async error => {
    const h = existingHarness(); h.bindings.maker.goal.set.mockRejectedValueOnce(new Error(error)); await h.run();
    expect(h.bindings.applyComposerDocument).not.toHaveBeenCalled();
    expect(h.bindings.setError).toHaveBeenCalledWith(humanizeRemoteError(new Error(error)));
  });
  it('does not consume newer input while Goal is being set', async () => {
    const h = existingHarness(); h.bindings.maker.goal.set.mockImplementationOnce(async () => { h.bindings.composerDocumentRef.current = textComposerDocument('new input'); }); await h.run();
    expect(h.bindings.applyComposerDocument).not.toHaveBeenCalled();
  });
  it('rejects attachments and retains the command', async () => {
    const h = existingHarness(); h.bindings.attachmentsRef.current = [{}]; await h.run();
    expect(h.bindings.setError).toHaveBeenCalledWith('session.screen.goalCommandAttachments');
    expect(h.bindings.maker.goal.set).not.toHaveBeenCalled();
    expect(h.bindings.applyComposerDocument).not.toHaveBeenCalled();
  });
  it('ignores a late result after switching tasks', async () => {
    const h = existingHarness(); h.bindings.maker.goal.set.mockImplementationOnce(async () => { h.bindings.outboxSessionAliveRef.current = 'other-task'; }); await h.run();
    expect(h.bindings.remoteSessionStore.setGoalStatus).not.toHaveBeenCalled();
    expect(h.bindings.applyComposerDocument).not.toHaveBeenCalled();
    expect(h.bindings.sendInFlightRef.current).toBe(false);
    expect(h.release).toHaveBeenCalledOnce();
  });
  it('keeps the send lock while Goal is in flight and rejects a duplicate submission', async () => {
    const h = existingHarness();
    let finish!: () => void;
    h.bindings.maker.goal.set.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = h.run();
    expect(h.bindings.sendInFlightRef.current).toBe(true);
    await h.run();
    expect(h.bindings.maker.goal.set).toHaveBeenCalledOnce();
    expect(h.bindings.invalidateHistoryRecoveryNavigation).toHaveBeenCalledOnce();
    expect(h.release).not.toHaveBeenCalled();
    finish();
    await first;
    expect(h.bindings.sendInFlightRef.current).toBe(false);
    expect(h.bindings.sending).toBe(false);
    expect(h.release).toHaveBeenCalledOnce();
  });
  it.each(['set', 'clear', 'bare', 'failure', 'attachments', 'busy'] as const)('releases the complete send boundary after Goal %s so an ordinary message can follow', async scenario => {
    const h = existingHarness(scenario === 'clear' ? 'clear' : scenario === 'bare' ? '' : 'target');
    if (scenario === 'failure') h.bindings.maker.goal.set.mockRejectedValueOnce(new Error('[NOT_CONNECTED] offline'));
    if (scenario === 'attachments') h.bindings.attachmentsRef.current = [{}];
    if (scenario === 'busy') h.bindings.goalBusy = true;
    await h.run();
    expect(h.bindings.beginOutboxBackgroundSend).not.toHaveBeenCalled();
    expect(h.bindings.sendInFlightRef.current).toBe(false);
    expect(h.bindings.sending).toBe(false);
    expect(h.release).toHaveBeenCalledOnce();
    h.bindings.goalBusy = false;
    h.bindings.attachmentsRef.current = [];
    h.bindings.composerDocumentRef.current = textComposerDocument('ordinary follow-up');
    h.bindings.setError.mockClear();
    await h.run();
    expect(h.bindings.setError).toHaveBeenCalledExactlyOnceWith(null);
    expect(h.bindings.beginOutboxBackgroundSend).toHaveBeenCalledOnce();
    expect(h.bindings.mobileDurableOutbox.add).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      item: expect.objectContaining({ sessionId: 'existing-task', text: 'ordinary follow-up' }),
    }));
    expect(h.bindings.composerInputRef.current.blur).toHaveBeenCalledOnce();
    expect(h.bindings.setComposerVoiceHoldArmed).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.bindings.sendInFlightRef.current).toBe(false);
    expect(h.bindings.sending).toBe(false);
    expect(h.release).toHaveBeenCalledTimes(2);
    expect(h.bindings.invalidateHistoryRecoveryNavigation).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('preserves the bot resource on a follow-up after Goal, array route params=%s', async arrayParams => {
    const h = existingHarness();
    const routeValue = (value: string) => arrayParams ? [value] : value;
    h.bindings.params = {
      resourceKind: routeValue('bot'),
      resourceCollectionId: routeValue('companions'),
      resourceId: routeValue('bot-1'),
    };
    await h.run();
    h.bindings.composerDocumentRef.current = textComposerDocument('ordinary follow-up');
    await h.run();
    expect(h.bindings.setError).toHaveBeenLastCalledWith(null);
    expect(h.bindings.mobileDurableOutbox.add).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      item: expect.objectContaining({ sessionId: 'existing-task', text: 'ordinary follow-up' }),
      resourceRef: { collectionId: 'companions', kind: 'bot', id: 'bot-1' },
    }));
  });
});
