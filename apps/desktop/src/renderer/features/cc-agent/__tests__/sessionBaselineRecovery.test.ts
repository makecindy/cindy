// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useVendorAuthGate } from '../../../hooks/useVendorAuthGate';
import { modelCatalogKey } from '../../../../shared/controlledModelCatalog';
import { matchNavigationCommandName, tryHandleNavigationCommand } from '../../../lib/navigationCommands';

const { revalidate, confirm, navigate } = vi.hoisted(() => ({
  revalidate: vi.fn(), confirm: vi.fn(async () => false), navigate: vi.fn(),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm }) }));
vi.mock('@/hooks/useVendorReadiness', () => ({ useVendorReadiness: () => ({ revalidate }) }));
vi.mock('@/hooks/useDeviceProviders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useDeviceProviders')>()),
  getCachedDeviceProviders: () => null,
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: { getDeviceName: () => 'Source Mac' },
}));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
import { projectSessionRuntimeControl } from '../../../../main/maker-ipc/sessionRuntimeControl';
import { dbToMakerAgentKind } from '../../../../shared/agentKindConversion';
import {
  PI_RUNTIME_SKILL_RETRY_DELAYS_MS,
  leadingSlashInvocation,
  reconcilePiRuntimeCommandForDispatch,
  reconcilePiRuntimeCommandForSessionDispatch,
  rewriteAgentSkillInvocationForDispatch,
  type UnifiedCommand,
} from '../../../lib/slashCommands';

// Execute the actual SessionView send callback up to its before-enqueue boundary.
// A disconnected old Harness must not prevent main from restoring the saved one.
const source = ts.createSourceFile('CCAgentSessionView.tsx', readFileSync(
  join(__dirname, '../CCAgentSessionView.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
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
      remoteDeviceId: null, catalogDeviceId: undefined, displayAgentKind: 'codex', isCodex: true, session,
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
    remoteDeviceId: null, catalogDeviceId: undefined, displayAgentKind, isCodex: displayAgentKind === 'codex', session,
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
  catalogDeviceId?: string; remoteHostId?: string; gate?: ReturnType<typeof useVendorAuthGate>;
  vendor?: 'codex' | 'claude-code'; pendingVendor?: 'pi'; switchAgentDeviceId?: string | null;
  currentAgentDeviceId?: string; catalogHostDeviceId?: string;
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
  const agentKind = options.agentKind ?? options.vendor ?? 'claude-code';
  const environment = {
    readOnly: false, cindyMakeInputLocked: false, invalidateHistoryRecoveryNavigation: vi.fn(),
    remoteDeviceId: options.remoteDeviceId ?? null, catalogDeviceId: options.catalogDeviceId,
    displayAgentKind: options.pendingVendor ?? agentKind,
    isCodex: !options.pendingVendor && agentKind === 'codex',
    agentSwitchIntent: options.switchAgentDeviceId !== undefined
      ? { target: options.pendingVendor ?? agentKind, agentDeviceId: options.switchAgentDeviceId } : null,
    modelCatalogKey, controlledModelRoute: { catalogHostDeviceId: options.catalogHostDeviceId },
    vendorAuthGate: options.gate ?? { checkAndConfirm: auth },
    session: { id: 'session-1', agentKind: agentKind === 'claude-code' ? 'cc' : agentKind,
      agentDeviceId: options.currentAgentDeviceId, remoteHostId: options.remoteHostId,
      source: 'user', status: options.status ?? 'active', workingDir: '/repo' }, sessionId: 'session-1',
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
    reconcilePiRuntimeCommandForDispatch, reconcilePiRuntimeCommandForSessionDispatch,
    rewriteAgentSkillInvocationForDispatch, dispatchCommand,
    matchNavigationCommandName, tryHandleNavigationCommand, navigate,
    sessionNavigationVersionRef: { current: 0 }, canNavigateSession: true, navigationMode: 'route',
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

// PR #10998 / discussion 4609117751: execute the real send callback and navigation
// handler. The /help test only covered broadcast commands, not renderer-owned
// navigation. Minimal unit input: a valid /jump-session with the steer default;
// it must change the route without sending to the model or the no-op registry entry.
it.each(['queue', 'steer'] as const)('navigates /jump-session independently of %s delivery', async (deliveryMode) => {
  const get = vi.fn(async () => ({ id: 'jump-target', status: 'active', source: 'user' }));
  vi.stubGlobal('electronAPI', { localDb: { sessions: { get } } });
  const { send, storeSend, dispatchCommand } = setup({
    proceed: true,
    slashCatalog: Promise.resolve([{ kind: 'desktop', name: 'jump-session', description: '' }]),
  });
  await expect(send('/jump-session jump-target', 'model', '', 'ask', undefined, undefined, { deliveryMode }))
    .resolves.toBeUndefined();
  expect(get).toHaveBeenCalledExactlyOnceWith('jump-target');
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/cc-agent/jump-target');
  expect(storeSend).not.toHaveBeenCalled();
  expect(dispatchCommand).not.toHaveBeenCalled();
});

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

// #10183 / unit: execute the actual existing-session callback and actual auth hook.
// Previous boundary tests stubbed the whole gate, missing the local-credential fallback.
// Minimum input: local workspace, remote Codex ready, controller unauthenticated.
// Provider/status IPC and persistence are synthetic; no credentials or real network are used.
it.each([
  ['queue', 'source-mac', undefined],
  ['steer', 'source-mac', undefined],
  ['queue', 'share:source', 'task-host'],
] as const)('sends through the selected remote catalog (%s, %s)', async (deliveryMode, sourceId, taskHost) => {
  revalidate.mockResolvedValue('unauthenticated');
  const invoke = vi.fn(async (_device: string, channel: string, args: unknown[]) => {
    const operation = taskHost ? (args[0] as { channel: string }).channel : channel;
    return operation === 'maker:agent:status'
      ? { binaryReady: true, authReady: true }
      : { providers: [{ id: 'remote', name: 'Remote', connected: true, agents: ['codex'], routing: { codex: {} }, models: { codex: [] } }] };
  });
  vi.stubGlobal('electronAPI', { deviceLink: { invoke } });
  const { result } = renderHook(() => useVendorAuthGate());
  const { send, storeSend } = setup({ proceed: false, vendor: 'codex', gate: result.current,
    catalogDeviceId: modelCatalogKey(sourceId, taskHost) });
  await expect(send('second message', 'model', '', 'ask', undefined, undefined, {
    literalText: true, deliveryMode,
  })).resolves.toBe(true);
  expect(storeSend).toHaveBeenCalledOnce();
  expect(revalidate).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  if (taskHost) {
    expect(invoke).toHaveBeenCalledWith(taskHost, 'maker:model-catalog:read', [{
      op: 'read', agentDeviceId: sourceId, channel: 'maker:agent:status', args: ['codex'],
    }]);
  } else {
    expect(invoke).toHaveBeenCalledWith(sourceId, 'maker:agent:status', ['codex']);
  }
});

it.each([
  ['source', 'logic.confirm.remoteCodexNoSourceTitle'],
  ['binary', 'logic.confirm.remoteCodexBinaryMissingTitle'],
  ['offline', 'newChat.modelSelector.remoteLoadFailedShort'],
] as const)('refuses an unavailable remote %s even when local credentials are ready', async (failure, title) => {
  revalidate.mockResolvedValue('ready');
  const invoke = vi.fn(async (_device: string, channel: string) => {
    if (failure === 'offline') throw new Error('offline');
    return channel === 'maker:agent:status'
      ? { binaryReady: failure !== 'binary', authReady: false }
      : { providers: [] };
  });
  vi.stubGlobal('electronAPI', { deviceLink: { invoke } });
  const { result } = renderHook(() => useVendorAuthGate());
  const { send } = setup({ proceed: true, vendor: 'codex', gate: result.current, catalogDeviceId: 'source-mac' });
  await expect(send('second message', 'model', '', 'ask', undefined, undefined, { literalText: true }))
    .resolves.toBe(false);
  expect(revalidate).not.toHaveBeenCalled();
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title }));
  expect(navigate).not.toHaveBeenCalled();
});

it.each([undefined, 'ssh-host'])('keeps local/SSH sends on the existing local readiness path (%s)', async remoteHostId => {
  revalidate.mockResolvedValue('ready');
  const invoke = vi.fn();
  vi.stubGlobal('electronAPI', { deviceLink: { invoke } });
  const { result } = renderHook(() => useVendorAuthGate());
  const { send } = setup({ proceed: true, vendor: 'codex', gate: result.current, remoteHostId });
  await expect(send('next message', 'model', '', 'ask', undefined, undefined, { literalText: true }))
    .resolves.toBe(true);
  expect(revalidate).toHaveBeenCalledExactlyOnceWith({ includeSuspended: true, skipBinary: Boolean(remoteHostId) });
  expect(invoke).not.toHaveBeenCalled();
});

// A location switch remains an intent until enqueue. Gate the selected next location,
// even if the previous location is offline; null explicitly selects local execution.
it.each([
  ['old-remote', null, undefined],
  ['old-remote', 'next-remote', undefined],
  [undefined, 'next-remote', undefined],
  ['old-remote', 'share:next', 'task-host'],
] as const)('uses pending send location (%s -> %s)', async (current, next, taskHost) => {
  revalidate.mockResolvedValue(next === null ? 'ready' : 'unauthenticated');
  const invoke = vi.fn(async (device: string, channel: string, args: unknown[]) => {
    expect(device).toBe(taskHost ?? next);
    const operation = taskHost ? (args[0] as { channel: string }).channel : channel;
    return operation === 'maker:agent:status'
      ? { binaryReady: true, authReady: true }
      : { providers: [{ id: 'remote', name: 'Remote', connected: true, agents: ['codex'], routing: { codex: {} }, models: { codex: [] } }] };
  });
  vi.stubGlobal('electronAPI', { deviceLink: { invoke } });
  const { result } = renderHook(() => useVendorAuthGate());
  const { send } = setup({ proceed: false, vendor: 'codex', gate: result.current,
    catalogDeviceId: modelCatalogKey(current, taskHost), switchAgentDeviceId: next,
    catalogHostDeviceId: taskHost });
  await expect(send('after location switch', 'model', '', 'ask', undefined, undefined, { literalText: true }))
    .resolves.toBe(true);
  expect(confirm).not.toHaveBeenCalled();
  if (next === null) {
    expect(invoke).not.toHaveBeenCalled();
    expect(revalidate).toHaveBeenCalledExactlyOnceWith({ includeSuspended: true, skipBinary: false });
  } else {
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(revalidate).not.toHaveBeenCalled();
    if (taskHost) expect(invoke).toHaveBeenCalledWith(taskHost, 'maker:model-catalog:read', [{
      op: 'read', agentDeviceId: next, channel: 'maker:agent:status', args: ['codex'],
    }]);
  }
});

// Greptile #11177: a steer joins the current turn without consuming the next-send
// location intent. Exercise the actual callback/hook with the pending peer offline
// (and the inverse), proving both successful dispatch and the current-route denial.
it.each([
  [undefined, 'next-remote', undefined, true, undefined],
  ['current-remote', null, undefined, true, undefined],
  ['share:current', 'next-remote', 'task-host', true, undefined],
  ['current-remote', 'next-remote', undefined, false, undefined],
  ['current-remote', 'next-remote', undefined, true, 'pi'],
] as const)('steers on current location (%s -> %s, host=%s, ready=%s, pending=%s)', async (current, next, taskHost, ready, pendingVendor) => {
  revalidate.mockResolvedValue(current ? 'unauthenticated' : 'ready');
  const invoke = vi.fn(async (device: string, channel: string, args: unknown[]) => {
    const sourceDevice = taskHost ? (args[0] as { agentDeviceId: string }).agentDeviceId : device;
    if (sourceDevice !== current || !ready) throw new Error('offline');
    const operation = taskHost ? (args[0] as { channel: string }).channel : channel;
    return operation === 'maker:agent:status'
      ? { binaryReady: (taskHost ? (args[0] as { args: string[] }).args[0] : args[0]) === 'codex', authReady: true }
      : { providers: [{ id: 'remote', name: 'Remote', connected: true, agents: ['codex'], routing: { codex: {} }, models: { codex: [] } }] };
  });
  vi.stubGlobal('electronAPI', { deviceLink: { invoke } });
  const { result } = renderHook(() => useVendorAuthGate());
  const { send, storeSend } = setup({ proceed: false, vendor: 'codex', gate: result.current,
    catalogDeviceId: modelCatalogKey(current, taskHost), currentAgentDeviceId: current,
    switchAgentDeviceId: next, catalogHostDeviceId: taskHost, pendingVendor });
  await expect(send('join running turn', 'model', '', 'ask', undefined, undefined, {
    literalText: true, deliveryMode: 'steer',
  })).resolves.toBe(ready);
  expect(storeSend).toHaveBeenCalledTimes(ready ? 1 : 0);
  if (!current) {
    expect(invoke).not.toHaveBeenCalled();
    expect(revalidate).toHaveBeenCalledExactlyOnceWith({ includeSuspended: true, skipBinary: false });
  } else {
    expect(revalidate).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith(taskHost ?? current,
      taskHost ? 'maker:model-catalog:read' : 'maker:agent:status',
      taskHost ? [{ op: 'read', agentDeviceId: current, channel: 'maker:agent:status', args: ['codex'] }] : ['codex']);
  }
  expect(confirm).toHaveBeenCalledTimes(ready ? 0 : 1);
});
