import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { projectSessionRuntimeControl } from '../../../../main/maker-ipc/sessionRuntimeControl';
import { dbToMakerAgentKind } from '../../../../shared/agentKindConversion';
import {
  PI_RUNTIME_SKILL_RETRY_DELAYS_MS,
  leadingSlashInvocation,
  reconcilePiRuntimeCommandForDispatch,
  reconcilePiRuntimeCommandForDispatchWithRetry,
  rewriteAgentSkillInvocationForDispatch,
  type UnifiedCommand,
} from '../../../lib/slashCommands';

// Execute the actual SessionView send callback up to its before-enqueue boundary.
// A disconnected old Harness must not prevent main from restoring the saved one.
const source = ts.createSourceFile('CCAgentSessionView.tsx', readFileSync(
  new URL('../CCAgentSessionView.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map<string, ts.Expression>();
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) &&
      ['handleSend', 'maybeDispatchDesktopSlashCommand', 'getHelpCommandsSnapshot'].includes(node.name.getText(source)) &&
      node.initializer && ts.isCallExpression(node.initializer)) callbacks.set(node.name.getText(source), node.initializer.arguments[0]);
  ts.forEachChild(node, visit);
}
visit(source);
function callbackCode(name: string) {
  const callback = callbacks.get(name);
  if (!callback) throw new Error(`SessionView ${name} callback missing`);
  return ts.transpileModule('(' + callback.getText(source) + ')', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const code = callbackCode('handleSend');
const slashCode = callbackCode('maybeDispatchDesktopSlashCommand');
const catalogCode = callbackCode('getHelpCommandsSnapshot');

it.each(['recovery', 'ordinary', 'missing-offer', 'pending', 'new-provider', 'new-model', 'new-intent', 'no-composer-offer'])(
  'defers old-Harness authentication only for the unchanged recovery route (%s)', async (scenario) => {
    const auth = vi.fn(async () => ({ proceed: false }));
    const beforeEnqueue = vi.fn(async () => false); // Stop before unrelated persistence/workdir work.
    const route = { agentKind: 'codex', model: 'retired', providerId: 'removed' };
    const session = { source: scenario === 'ordinary' ? 'user' : 'bot',
      runtimeBaselineRecoveryPending: scenario !== 'missing-offer',
      runtimePending: scenario === 'pending' ? route : null, runtimeEffective: route };
    const send = runInNewContext(code, { readOnly: false, cindyMakeInputLocked: false,
      invalidateHistoryRecoveryNavigation: vi.fn(), getDataOwnerGeneration: () => 1,
      remoteDeviceId: null, displayAgentKind: 'codex', isCodex: true, session,
      agentSwitchIntent: scenario === 'new-intent' ? { target: 'pi' } : null,
      vendorAuthGate: { checkAndConfirm: auth },
    });
    await send('hello', scenario === 'new-model' ? 'new' : 'retired', '', 'ask', undefined, undefined, {
      literalText: true, baselineRecovery: scenario !== 'no-composer-offer',
      providerId: scenario === 'new-provider' ? 'new' : 'removed', beforeEnqueue,
    });
    expect(auth).toHaveBeenCalledTimes(scenario === 'recovery' ? 0 : 1);
    expect(beforeEnqueue).toHaveBeenCalledTimes(scenario === 'recovery' ? 1 : 0);
  });

it('authenticates the recovered Harness on subsequent sends after a legacy projection patch', async () => {
  const recovered = { agentKind: 'pi' as const, model: 'saved', providerId: 'connected', effort: null, fastMode: false };
  const session = { source: 'bot', agentKind: 'codex', runtimeBaselineRecoveryPending: true,
    ...projectSessionRuntimeControl('recovered-companion', recovered) };
  const auth = vi.fn(async (vendor: string) => ({ proceed: vendor === 'pi' }));
  const beforeEnqueue = vi.fn(async () => false);
  const displayAgentKind = dbToMakerAgentKind(session.agentKind);
  const send = runInNewContext(code, { readOnly: false, cindyMakeInputLocked: false,
    invalidateHistoryRecoveryNavigation: vi.fn(), getDataOwnerGeneration: () => 1,
    remoteDeviceId: null, displayAgentKind, isCodex: displayAgentKind === 'codex', session,
    agentSwitchIntent: null, vendorAuthGate: { checkAndConfirm: auth },
  });
  await send('hello again', recovered.model, '', 'ask', undefined, undefined, {
    literalText: true, providerId: recovered.providerId, beforeEnqueue,
  });
  expect(auth).toHaveBeenCalledWith('pi', expect.anything());
  expect(beforeEnqueue).toHaveBeenCalledOnce();
});

// Ordinary sends (a working directory, no built-in skill dispatch): the composer
// clears on click, so the store must show the bubble before the vendor readiness
// check waits on main. The check runs as the store's beforeEnqueue, and its
// rejection rolls the bubble back so the composer restores the draft.
function setup(options: {
  proceed: boolean; remoteDeviceId?: string | null; rebalance?: boolean; status?: string;
  agentKind?: 'codex' | 'claude-code' | 'pi'; slashCatalog?: Promise<UnifiedCommand[]>;
}) {
  const order: string[] = [];
  const auth = vi.fn(async () => {
    order.push('auth');
    return { proceed: options.proceed };
  });
  const recordRebalance = vi.fn(async () => { order.push('rebalance'); });
  let storeOpts: { beforeEnqueue?: () => Promise<boolean>; onInputCreated?: (id: string) => void } | undefined;
  const storeSend = vi.fn(async (...args: unknown[]) => {
    order.push('store');
    storeOpts = args[7] as typeof storeOpts;
    storeOpts?.onInputCreated?.('client-1');
    return storeOpts?.beforeEnqueue ? await storeOpts.beforeEnqueue() : true;
  });
  const dispatchCommand = vi.fn(async () => undefined);
  const environment = {
    readOnly: false, cindyMakeInputLocked: false, invalidateHistoryRecoveryNavigation: vi.fn(),
    remoteDeviceId: options.remoteDeviceId ?? null, displayAgentKind: 'claude-code', isCodex: false,
    agentSwitchIntent: null, vendorAuthGate: { checkAndConfirm: auth },
    session: { id: 'session-1', agentKind: options.agentKind ?? 'claude-code', source: 'user', status: options.status ?? 'active', workingDir: '/repo' }, sessionId: 'session-1',
    folderPickerOpen: false, sessionHandoffPreparing: false, isOrcaLeadSession: () => false,
    isRunningRef: { current: false }, confirmRebalance: vi.fn(), t: (key: string) => key,
    offerSessionRebalance: async () => (options.rebalance ? recordRebalance : undefined),
    botChatIdentity: null, readSendFollowCancelGeneration: () => 0, requestFollowLatest: vi.fn(),
    sendMessage: storeSend, steerMessage: storeSend,
    dispatchDeferredUiAssignment: async () => undefined,
    dbToMakerAgentKind, CINDY_MAKE_ENABLED: true, isRemoteSession: false,
    allCommandsRef: { current: [] as UnifiedCommand[] }, setAllCommands: vi.fn(),
    loadAllCommands: vi.fn(async () => await (options.slashCatalog ?? Promise.resolve([]))),
    PI_RUNTIME_SKILL_RETRY_DELAYS_MS, leadingSlashInvocation,
    reconcilePiRuntimeCommandForDispatch, reconcilePiRuntimeCommandForDispatchWithRetry,
    rewriteAgentSkillInvocationForDispatch, dispatchCommand,
  };
  Object.assign(environment, { getHelpCommandsSnapshot: runInNewContext(catalogCode, environment) });
  Object.assign(environment, { maybeDispatchDesktopSlashCommand: runInNewContext(slashCode, environment) });
  const send = runInNewContext(code, environment);
  return { send, auth, storeSend, dispatchCommand, recordRebalance, order, getStoreOpts: () => storeOpts };
}

// PR #10998 P1: execute the real send callback and catalog resolver while the
// palette is still loading. Existing literal-text cases bypassed command dispatch.
// Minimal unit input: a steer-mode /help with a deferred catalog; it must reach
// Desktop dispatch once, never the model-input store, for each supported Harness.
it.each(['codex', 'claude-code', 'pi'] as const)(
  'dispatches %s /help on Desktop after the pending catalog loads under the steer default', async (agentKind) => {
    let finish!: (commands: UnifiedCommand[]) => void;
    const slashCatalog = new Promise<UnifiedCommand[]>((resolve) => { finish = resolve; });
    const { send, storeSend, dispatchCommand } = setup({ proceed: true, agentKind, slashCatalog });
    const pending = send('/help', 'model', '', 'ask', undefined, undefined, { deliveryMode: 'steer' });
    await Promise.resolve();
    expect(storeSend).not.toHaveBeenCalled();
    expect(dispatchCommand).not.toHaveBeenCalled();
    finish([{ kind: 'desktop', name: 'help', description: '' }]);
    await expect(pending).resolves.toBe(true);
    expect(dispatchCommand).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: 'desktop', name: 'help' }),
      { sessionId: 'session-1', workingDir: '/repo' },
    );
    expect(storeSend).not.toHaveBeenCalled();
  },
);

it.each(['queue', 'steer'] as const)(
  'checks vendor readiness at the appropriate boundary for %s sends', async (deliveryMode) => {
    const { send, order, storeSend } = setup({ proceed: true, rebalance: true });
    await expect(send('hello', 'model', '', 'ask', undefined, undefined, {
      literalText: true, deliveryMode,
    })).resolves.toBe(true);
    expect(storeSend).toHaveBeenCalledOnce();
    // Steer joins the running turn, so it never offers an account rebalance.
    expect(order).toEqual(deliveryMode === 'steer' ? ['auth', 'store'] : ['store', 'auth', 'rebalance']);
  });

it('rejects through beforeEnqueue so the store rolls the bubble back and the composer restores', async () => {
  const { send, order, recordRebalance } = setup({ proceed: false, rebalance: true });
  await expect(send('hello', 'model', '', 'ask', undefined, undefined, { literalText: true }))
    .resolves.toBe(false);
  expect(order).toEqual(['store', 'auth']);
  expect(recordRebalance).not.toHaveBeenCalled();
});

it('leaves device-link sends to the task computer without a renderer check', async () => {
  const { send, auth, getStoreOpts } = setup({ proceed: false, remoteDeviceId: 'device-1' });
  await expect(send('hello', 'model', '', 'ask', undefined, undefined, { literalText: true }))
    .resolves.toBe(true);
  expect(auth).not.toHaveBeenCalled();
  expect(getStoreOpts()?.beforeEnqueue).toBeUndefined();
});

// Regression: a denied send must not reach auto-unarchive or local steer dispatch.
// Existing queue tests only exercised store rollback; these precheck paths must
// return false before any persistence or input dispatch (unit tier).
it.each(['archived', 'steer'] as const)('rejects %s sends before dispatch or unarchive', async (scenario) => {
  const { send, order, storeSend } = setup({ proceed: false,
    status: scenario === 'archived' ? 'archived' : 'active' });
  await expect(send('hello', 'model', '', 'ask', undefined, undefined, {
    literalText: true, deliveryMode: scenario === 'steer' ? 'steer' : 'queue',
  })).resolves.toBe(false);
  expect(order).toEqual(['auth']);
  expect(storeSend).not.toHaveBeenCalled();
});
