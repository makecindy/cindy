import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import * as slash from '../../../lib/slashCommands';
import { rebaseQueueComposerEditContentAfterSlashCommandRewrite } from '../../../lib/queueComposerEdit';

// #11112: execute the actual send/dispatch closures, not copies of their logic.
// Guard tier: this cross-hook startup race cannot be reproduced by testing the
// reconciler alone (which already supports preparation). The large view closes
// over navigation, stores and IPC; isolate those ports instead of booting the app.
// Minimum failure: cold /demo, discovered with no runtime alias, normal or steer.
const source = ts.createSourceFile('CCAgentSessionView.tsx', readFileSync(
  new URL('../CCAgentSessionView.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map<string, string>();
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
    const call = node.initializer as ts.CallExpression;
    if (call.expression.getText(source) === 'useCallback') {
      callbacks.set(node.name.getText(source), ts.transpileModule(`(${call.arguments[0].getText(source)})`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText);
    }
  }
  ts.forEachChild(node, visit);
}
visit(source);

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function harness(agentKind = 'pi', remoteDeviceId?: string, runtimeOnly = false) {
  vi.stubGlobal('window', { setTimeout });
  const discovered: slash.UnifiedCommand = {
    kind: 'agent-skill', source: 'skill', name: 'demo', scope: 'repo', runtimeStatus: 'discovered',
  };
  const loaded: slash.UnifiedCommand = { ...discovered, runtimeStatus: 'loaded', runtimeCommandName: 'skill:demo' };
  let ready = false;
  let release!: () => void;
  const preparation = new Promise<void>(resolve => { release = () => { ready = true; resolve(); }; });
  const create = vi.fn((..._args: any[]) => preparation.then((): { accepted: boolean; piRuntimePrepared?: true } => ({ accepted: true, piRuntimePrepared: true })));
  const send = vi.fn(async (..._args: any[]) => false);
  const session = { id: 'cold', agentKind, model: 'saved-model', effort: 'high', permissionMode: 'ask',
    workingDir: '/project', status: 'active', source: 'user', orcaRole: null,
    extraDirs: ['/reference', 'cindy-library:/library'], writableDirs: ['/output'] };
  const environment: Record<string, any> = {
    ...slash, toast: { error: vi.fn() }, extractIpcError: () => null, session, sessionId: session.id, remoteDeviceId, catalogDeviceId: remoteDeviceId,
    dbToMakerAgentKind: (kind: string) => kind,
    buildCreateOptsForCurrentSession: (_id: string, model: string, effort: string, permissionMode: string, workingDir: string) =>
      ({ model, effort, permissionMode, workingDir }),
    window: { setTimeout, electronAPI: { maker: { prewarmSession: create }, deviceLink: { invoke: create } } },
    CINDY_MAKE_ENABLED: true, allCommandsRef: { current: [discovered] },
    getHelpCommandsSnapshot: async () => [discovered],
    loadAllCommands: async () => ready ? [loaded] : runtimeOnly ? [] : [discovered],
    setAllCommands: vi.fn(), isRemoteSession: false,
    readOnly: false, cindyMakeInputLocked: false, invalidateHistoryRecoveryNavigation: vi.fn(),
    matchNavigationCommandName: () => null, tryHandleNavigationCommand: async () => false,
    navigate: vi.fn(), t: (key: string) => key, canNavigateSession: true, navigationMode: 'default',
    maybeShowContextUsage: async () => false, sessionRef: { current: session },
    displayAgentKind: agentKind, isCodex: agentKind === 'codex', agentSwitchIntent: null,
    vendorAuthGate: { checkAndConfirm: async () => ({ proceed: true }) },
    folderPickerOpen: false, sessionHandoffPreparing: false, isOrcaLeadSession: () => false,
    isRunningRef: { current: true }, botChatIdentity: null,
    readSendFollowCancelGeneration: () => 0, requestFollowLatest: vi.fn(), sendMessage: send, steerMessage: send,
  };
  const bind = (name: string) => {
    const code = callbacks.get(name);
    if (!code) return undefined;
    return environment[name] = runInNewContext(code, environment);
  };
  bind('preparePiRuntimeForDispatch');
  bind('maybeDispatchDesktopSlashCommand');
  const handleSend = bind('handleSend');
  return { create, send, release, environment, handleSend, bind };
}

it.each(['queue', 'steer'])('waits beyond the retry budget before sending a cold skill (%s)', async deliveryMode => {
  vi.useFakeTimers();
  const h = harness();
  const submission = h.handleSend('/demo hello', 'chosen-model', 'medium', 'ask', [], [], {
    deliveryMode, pastedTextRanges: [{ start: 6, end: 11 }],
  });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(h.send).not.toHaveBeenCalled();
  expect(h.create).toHaveBeenCalledOnce();
  h.release();
  await submission;
  expect(h.send.mock.calls[0][0]).toBe('/skill:demo hello');
  expect(h.send.mock.calls[0][7].pastedTextRanges).toEqual([{ start: 12, end: 17 }]);
  expect(h.create.mock.calls[0][1]).toMatchObject({
    purpose: 'pi-skill-dispatch', model: 'chosen-model', workingDir: '/project',
  });
  // Host restores grants from its DB; never forward the private Library slot.
  expect(h.create.mock.calls[0][1].extraDirs).toBeUndefined();
  expect(h.create.mock.calls[0][1].writableDirs).toBeUndefined();
});

it('prepares on the controlled device for callers without a custom preparation callback', async () => {
  const h = harness('pi', 'controlled-device');
  const dispatch = h.environment.maybeDispatchDesktopSlashCommand('/demo', [], {
    allowDesktopDispatch: false, piRuntimeRetryDelaysMs: [], workingDirOverride: '/selected-project',
  });
  h.release();
  await expect(dispatch).resolves.toMatchObject({ message: '/skill:demo', handled: false });
  expect(h.create.mock.calls[0]).toEqual(['controlled-device', 'maker:session:prewarm', ['cold', expect.objectContaining({
    purpose: 'pi-skill-dispatch', workingDir: '/selected-project', model: 'saved-model',
  })]]);
});

it('keeps the draft when a legacy controlled Desktop only schedules prewarming', async () => {
  const h = harness('pi', 'controlled-device');
  h.create.mockResolvedValueOnce({ accepted: true });
  await expect(h.handleSend('/demo', 'chosen-model', 'medium', 'ask')).rejects.toThrow();
  expect(h.send).not.toHaveBeenCalled();
});

it.each(['failed', 'unknown'])('reconciles a transient %s catalog until the alias loads', async status => {
  const h = harness();
  const load = h.environment.loadAllCommands;
  h.environment.loadAllCommands = async (...args: any[]) => {
    args.find(arg => arg?.onPiRuntimeStatus)?.onPiRuntimeStatus(status);
    return load(...args);
  };
  const sent = h.handleSend('/demo', 'chosen-model', 'medium', 'ask');
  // Keep the first reload unavailable even though preparation can now complete.
  await vi.waitFor(() => expect(h.create).toHaveBeenCalledOnce());
  h.release();
  await sent;
  expect(h.send.mock.calls[0][0]).toBe('/skill:demo');
});

it.each([true, false])('waits for late Pi capture and preserves input on exhaustion (recovers=%s)', async recovers => {
  vi.useFakeTimers();
  const h = harness();
  const first = await h.environment.loadAllCommands();
  const start = Date.now();
  h.environment.loadAllCommands = async () => recovers && Date.now() - start >= 53_000
    ? [{ ...first[0], runtimeStatus: 'loaded', runtimeCommandName: 'skill:demo' }] : first;
  h.release();
  const sent = h.handleSend('/demo', 'chosen-model', 'medium', 'ask');
  const outcome = recovers ? sent : expect(sent).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(8_000);
  expect(h.send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(55_000);
  await outcome;
  if (recovers) expect(h.send.mock.calls[0][0]).toBe('/skill:demo');
  else expect(h.send).not.toHaveBeenCalled();
});

it.each([true, false])('admits an archived Skill send before activating the task (allowed=%s)', async allowed => {
  const h = harness();
  const env = h.environment;
  env.session.status = 'archived';
  env.vendorAuthGate.checkAndConfirm = vi.fn(async () => ({ proceed: allowed }));
  let persisted = false;
  env.sessionService = { setStatus: vi.fn(async () => { await Promise.resolve(); persisted = true; }) };
  env.patchLocalSession = env.setServerSession = env.emitRefresh = vi.fn();
  h.create.mockImplementation(async () => {
    expect(persisted).toBe(true);
    h.release();
    return { accepted: true, piRuntimePrepared: true };
  });
  await h.handleSend('/demo', 'chosen-model', 'medium', 'ask');
  expect(env.sessionService.setStatus).toHaveBeenCalledTimes(allowed ? 1 : 0);
  expect(h.create).toHaveBeenCalledTimes(allowed ? 1 : 0);
  if (allowed) expect(h.send.mock.calls[0][0]).toBe('/skill:demo');
  else expect(h.send).not.toHaveBeenCalled();
});

it.each(['queue', 'steer'] as const)('uses the selected engine only for the next %s input', async deliveryMode => {
  const h = harness('codex');
  h.environment.agentSwitchIntent = { target: 'pi', model: 'chosen-model' };
  h.environment.displayAgentKind = 'pi';
  h.create.mockImplementation(async () => {
    h.release();
    return { accepted: true, piRuntimePrepared: true, pendingRouteApplied: true };
  });
  await h.handleSend('/demo', 'chosen-model', 'medium', 'ask', [], [], { deliveryMode });
  expect(h.create).toHaveBeenCalledTimes(deliveryMode === 'steer' ? 0 : 1);
  expect(h.send.mock.calls[0][0]).toBe(deliveryMode === 'steer' ? '/demo' : '/skill:demo');
});

it('ignores the previous Pi alias when the next input switches away from Pi', async () => {
  const h = harness();
  h.environment.agentSwitchIntent = { target: 'codex' };
  h.environment.displayAgentKind = 'codex';
  h.environment.allCommandsRef.current = [{ name: 'demo', kind: 'agent-skill', runtimeCommandName: 'skill:demo' }];
  h.environment.loadAllCommands = async () => [];
  await h.handleSend('/demo', 'chosen-model', 'medium', 'ask');
  expect(h.create).not.toHaveBeenCalled();
  expect(h.send.mock.calls[0][0]).toBe('/demo');
});

it.each(['literal', 'codex', 'claude-code'])('leaves %s input unchanged without starting Pi', async kind => {
  const h = harness(kind === 'literal' ? 'pi' : kind);
  await h.handleSend('/demo hello', 'chosen-model', 'medium', 'ask', [], [], { literalText: kind === 'literal' });
  expect(h.create).not.toHaveBeenCalled();
  expect(h.send.mock.calls[0][0]).toBe('/demo hello');
});

it('does not send plain text after runtime preparation fails', async () => {
  const h = harness();
  h.create.mockRejectedValueOnce(new Error('runtime unavailable'));
  await expect(h.handleSend('/demo', 'chosen-model', 'medium', 'ask')).rejects.toThrow('runtime unavailable');
  expect(h.environment.toast.error).toHaveBeenCalledWith(expect.stringContaining('runtime unavailable'));
  expect(h.send).not.toHaveBeenCalled();
});

it('keeps unknown commands literal without starting Pi', async () => {
  const h = harness();
  await h.handleSend('/unknown hello', 'chosen-model', 'medium', 'ask');
  expect(h.create).not.toHaveBeenCalled();
  expect(h.send.mock.calls[0][0]).toBe('/unknown hello');
});

it('waits for a cold skill before saving a queue edit and rebases its metadata', async () => {
  const h = harness();
  const update = vi.fn(async () => true);
  Object.assign(h.environment, {
    activeQueueComposerEdit: { clientId: 'queued', sessionId: 'cold', draftKey: 'draft' },
    queueComposerEditSavingRef: { current: false }, queueComposerEditCleanupRef: { current: null },
    rebaseQueueComposerEditContentAfterSlashCommandRewrite, updateQueueItemContent: update,
    clearComposerDraftAndNotify: vi.fn(), isCurrentQueueComposerEdit: () => false,
  });
  const submission = h.bind('submitQueueComposerEdit')('queued', {
    text: '/demo hello', pastedTextRanges: [{ start: 6, end: 11 }], agentReferences: [], slashCommandRanges: [],
  }, []);
  await vi.waitFor(() => expect(h.create).toHaveBeenCalledOnce());
  expect(update).not.toHaveBeenCalled();
  h.release();
  await expect(submission).resolves.toBe(true);
  expect(update).toHaveBeenCalledWith('queued', expect.objectContaining({ content: expect.objectContaining({
    text: '/skill:demo hello', pastedTextRanges: [{ start: 12, end: 17 }],
  }) }));
});

it.each([undefined, 'controlled-device'])('resumes directory selection with the pending model and rewritten skill (device: %s)', async remoteDeviceId => {
  const h = harness('pi', remoteDeviceId, true);
  let completed!: () => void;
  const submission = new Promise<void>(resolve => { completed = resolve; });
  Object.assign(h.environment, {
    refreshServerSession: vi.fn(), log: { warn: vi.fn() },
    pendingSendRef: { current: {
      message: '/demo hello', model: 'pending-model', effort: 'medium', permissionMode: 'ask',
      files: [], mentions: [], pastedTextRanges: [{ start: 6, end: 11 }], resolveSubmission: completed,
    } },
  });
  h.bind('handleWorkingDirChange')('/selected-project');
  await vi.waitFor(() => expect(h.create).toHaveBeenCalledOnce());
  expect(h.send).not.toHaveBeenCalled();
  h.release();
  await submission;
  expect(h.send.mock.calls[0][0]).toBe('/skill:demo hello');
  expect(h.send.mock.calls[0][4]).toBe('/selected-project');
  expect(h.send.mock.calls[0][7].pastedTextRanges).toEqual([{ start: 12, end: 17 }]);
  const createOpts = expect.objectContaining({ model: 'pending-model', effort: 'medium', permissionMode: 'ask', workingDir: '/selected-project' });
  expect(h.create.mock.calls[0]).toEqual(remoteDeviceId
    ? [remoteDeviceId, 'maker:session:prewarm', ['cold', createOpts]]
    : ['cold', createOpts]);
});
