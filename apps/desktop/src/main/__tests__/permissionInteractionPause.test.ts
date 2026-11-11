import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InteractionDecision, InteractionRequest, InteractionResolver } from '@cindy/maker-core';
import { createSharedPermission, type SharedPermission } from '../maker-ipc/sharedPermission';
import { beginInteractionRoute, installDesktopInteractionHandler, type InteractionHandler, type InteractionSession } from '../maker-ipc/interactionRouter';
import { assertSharedTaskInteractionResolveCurrent, assertSharedTaskInvoke, setSharedTaskInteractionReader, type SharedTaskPeerCapture } from '../device-link/sharedTaskDispatch.js';

// Execute the production listener and control adapter without booting Electron.
const source = readFileSync(new URL('../maker-ipc/register.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('register.ts', source, ts.ScriptTarget.ES2022, true);
const names = new Set([
  'installDesktopInteractionListener', 'clearPendingInteraction',
  'schedulePendingPermissionTimeout',
  'resolvePendingInteraction', 'cancelPendingInteraction', 'defaultDecisionForPending',
  'cleanupPendingAgentInteractionsForSession', 'takePendingInteractionsForSession',
  'bindSharedPermission', 'broadcastToAllWindows', 'getPendingInteractionsForSession',
]);
const functions = ast.statements.filter((node) => ts.isFunctionDeclaration(node)
  && node.name && names.has(node.name.text)).map(node => node.getText(ast).replace(/^export /, ''));
let resolveHandlerSource = '';
let interactionReaderSource = '';
let userActionSource = '';
function visit(node: ts.Node): void {
  if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'onUserAction') {
    userActionSource = node.initializer.getText(ast);
  }
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'setSharedTaskInteractionReader') {
    interactionReaderSource = node.arguments[0].getText(ast);
  }
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'ipcMain.handle'
    && node.arguments[0]?.getText(ast) === 'MAKER_INVOKE.RESOLVE_INTERACTION') {
    resolveHandlerSource = node.arguments[1].getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
if (!resolveHandlerSource) throw new Error('Resolve interaction IPC handler missing');
if (!interactionReaderSource) throw new Error('Shared-task interaction reader missing');
if (!userActionSource) throw new Error('User action callback missing');
const compiled = ts.transpileModule(`${functions.join('\n')}
setSharedTaskInteractionReader(${interactionReaderSource});
return { install: installDesktopInteractionListener,
  answer: resolvePendingInteraction, cleanup: cleanupPendingAgentInteractionsForSession,
  take: takePendingInteractionsForSession, broadcast: broadcastToAllWindows,
  userAction: ${userActionSource}, resolveFromIpc: ${resolveHandlerSource} };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const MINUTE = 60_000;

function harness() {
  let sharedTask: SharedTaskPeerCapture | undefined;
  const held = new Set<string>();
  const coordinator = {
    isExecutionPaused: (id: string) => held.has(id),
    setExecutionPaused: (id: string, value: boolean) => { if (value) held.add(id); else held.delete(id); },
    onInteractionResolved: vi.fn(),
  };
  const listeners = new Map<string, InteractionResolver>();
  const entries = new Map();
  const dismiss = vi.fn();
  const dismissInteractionNotifications = vi.fn();
  const pendingSetup: Array<{ request: { kind: 'plugin_setup'; requestId: string } }> = [];
  const emptyBridge = { pendingSnapshots: () => [] };
  const deps = {
    maker: { getSession: () => ({ submitAsyncQuestionAnswer: vi.fn(async () => true) }) },
    createSharedPermission,
    getDeviceLinkInvokeContext: () => ({ sharedTask }),
    assertSharedTaskInteractionResolveCurrent,
    setSharedTaskInteractionReader,
    isPluginSetupInteractionDecision: () => false,
    assertResolveInteractionOrigin: vi.fn(), isPendingDesktopOnlyConfirmation: () => false,
    issueConfirmBridge: emptyBridge,
    mcpSetupBridge: emptyBridge, renameSessionsConfirmBridge: emptyBridge,
    taskActionConfirmBridge: emptyBridge, orcaWorkerPermissionConfirmBridge: emptyBridge,
    ghostGrantConfirmBridge: emptyBridge,
    getInputHandoffService: () => undefined,
    usageLimitAutoResume: { noteUserAction: vi.fn() },
    pendingInteractionResolvers: entries,
    agentInputCoordinatorHolder: coordinator, inputCoordinator: coordinator,
    PERMISSION_INTERACTION_TIMEOUT_MS: 10 * MINUTE,
    installDesktopInteractionHandler,
    shouldNotifyAgentIslandForSession: () => false,
    flushAssistantBlock: vi.fn(), onInteractionMessage: vi.fn(),
    redactToolInputForUntrustedBoundary: (_tool: string, input: unknown) => input,
    BrowserWindow: { getAllWindows: () => [] },
    getActiveDataOwnerPushStamp: () => undefined,
    isDataOwnerBroadcastScopeCurrent: () => true,
    tapWindowBroadcast: vi.fn(),
    invalidateWorkersByLeadSingleFlight: vi.fn(),
    dismissSessionInteractionNotifications: dismissInteractionNotifications,
    log: { warn: vi.fn() },
    MAKER_PUSH: { INTERACTION_REQUEST: 'request', INTERACTION_DISMISSED: 'dismissed' },
    handleAgentIslandInteractionAfterBroadcast: vi.fn(), handleAgentIslandInteractionDismissed: vi.fn(),
    dismissRendererInteraction: dismiss, persistInteractionDecision: vi.fn(),
    goalAskAnswerObserver: null,
    ghostSetupInteractionBridge: { cleanupForSession: vi.fn(), pendingSnapshots: () => pendingSetup },
  };
  const runtime = new Function(...Object.keys(deps), compiled)(...Object.values(deps)) as {
    install: (session: InteractionSession) => void;
    answer: (id: string, decision: InteractionDecision) => boolean;
    cleanup: (id: string, reason: string) => void;
    take: (id: string) => Array<{ resolve: (decision: InteractionDecision) => void; sharedPermission?: SharedPermission }>;
    resolveFromIpc: (event: unknown, id: string, decision: InteractionDecision) => Promise<{ accepted: boolean }>;
    broadcast: (channel: string, payload: unknown) => void;
    userAction: (sessionId: string) => void;
  };
  dismiss.mockImplementation((entry, requestId, reason, resolvedAs) => runtime.broadcast('dismissed', {
    sessionId: entry.sessionId, requestId, reason, resolvedAs,
  }));
  const request = (id = 'permission', sessionId = 'task', kind: InteractionRequest['kind'] = 'permission', channel?: InteractionHandler, signal?: AbortSignal, isBlocking?: boolean, delivery?: 'async') => {
    const session: InteractionSession = { id: sessionId, setInteractionListener: handler => { if (handler) listeners.set(sessionId, handler); } };
    runtime.install(session);
    const lease = channel ? beginInteractionRoute(session, {
      route: { sessionId, turnId: 'turn', origin: { kind: 'hook', source: 'test' }, interactionSurface: 'channel-card', timeoutMs: 10 * MINUTE },
      handle: channel,
      // A presentation acknowledges cancellation; Router must still finalize it.
      onCancel: () => true,
    }) : undefined;
    const settled = vi.fn();
    const promise = listeners.get(sessionId)!({ kind, requestId: id, ...(delivery ? { delivery } : {}), toolName: 'Shell', input: {}, ...(isBlocking === undefined ? {} : { isBlocking }) } as InteractionRequest, signal);
    void promise.then(settled);
    return { promise, settled, lease };
  };
  return { ...runtime, request, entries, dismiss, dismissInteractionNotifications, pendingSetup,
    setPaused: (id: string, paused: boolean) => coordinator.setExecutionPaused(id, paused),
    setSharedTask: (peer?: SharedTaskPeerCapture) => { sharedTask = peer; } };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { setSharedTaskInteractionReader(null); vi.clearAllTimers(); vi.useRealTimers(); });

// #9944 patch / unit: exercise the actual resolve IPC and main broadcast seam.
// A displayed request or a paused/rejected choice must keep its OS reminder;
// only a successfully handled choice retires it.
it.each(['permission', 'ask_user_question', 'plan_review'] as const)('retires notifications after an accepted %s decision', async (kind) => {
  const h = harness();
  const pending = h.request('request', 'task', kind);
  const decision: InteractionDecision = kind === 'ask_user_question'
    ? { kind, answers: { choice: 'yes' } } : { kind, behavior: 'allow' };
  expect(h.dismissInteractionNotifications).not.toHaveBeenCalled();
  h.setPaused('task', true);
  expect(h.answer('request', decision)).toBe(false);
  expect(h.dismissInteractionNotifications).not.toHaveBeenCalled();
  h.setPaused('task', false);
  await expect(h.resolveFromIpc({}, 'request', decision)).resolves.toEqual({ accepted: true });
  await expect(pending.promise).resolves.toEqual(decision);
  expect(h.dismissInteractionNotifications).toHaveBeenCalledExactlyOnceWith('task');
});

// #9944 review / unit: a queued message can update user activity while an
// unanswered permission still blocks dispatch. Exercise that production callback.
it('keeps interaction reminders when new input only updates user activity', () => {
  const h = harness();
  h.request('permission', 'task');
  h.userAction('task');
  expect(h.entries.has('permission')).toBe(true);
  expect(h.dismissInteractionNotifications).not.toHaveBeenCalled();
});

// #9944 review / unit: one resolved permission must not erase another pending
// async question or Host-owned card. Retire the group only when it is empty.
it('keeps reminders until the last interaction in the task is handled', async () => {
  const h = harness();
  h.request('question', 'task', 'ask_user_question', undefined, undefined, false, 'async');
  h.request('permission', 'task');
  h.request('other-task-permission', 'other-task');
  expect(h.answer('permission', { kind: 'permission', behavior: 'allow' })).toBe(true);
  expect(h.dismissInteractionNotifications).not.toHaveBeenCalled();

  await expect(h.resolveFromIpc({}, 'question', { kind: 'ask_user_question', answers: { choice: 'yes' } }))
    .resolves.toEqual({ accepted: true });
  expect(h.dismissInteractionNotifications).toHaveBeenCalledExactlyOnceWith('task');
  expect(h.entries.has('other-task-permission')).toBe(true);
});

it('keeps reminders while a Host-owned setup confirmation is still pending', () => {
  const h = harness();
  h.request('permission', 'task');
  h.pendingSetup.push({ request: { kind: 'plugin_setup', requestId: 'setup' } });
  expect(h.answer('permission', { kind: 'permission', behavior: 'allow' })).toBe(true);
  expect(h.dismissInteractionNotifications).not.toHaveBeenCalled();
  h.pendingSetup.length = 0;
  h.broadcast('dismissed', { sessionId: 'task', requestId: 'setup', reason: 'resolved' });
  expect(h.dismissInteractionNotifications).toHaveBeenCalledExactlyOnceWith('task');
});

it('does not consume the pending decision when membership is revoked after dispatch admission', async () => {
  const h = harness();
  const p = h.request();
  let authorized = true;
  const peer: SharedTaskPeerCapture = {
    author: { sharedTaskId: 'shared', sessionId: 'task', memberId: 'guest', accountId: 'guest', displayName: 'Guest' },
    isCurrent: () => authorized, authorize: () => authorized,
  };
  const decision = { kind: 'permission', behavior: 'allow' } as const;
  assertSharedTaskInvoke(peer, { channel: 'maker:resolve-interaction', args: ['permission', decision] });
  // Simulate revocation during async admission, without removing the request.
  await Promise.resolve();
  authorized = false;
  h.setSharedTask(peer);
  await expect(h.resolveFromIpc({}, 'permission', decision)).rejects.toThrow('PERMISSION_DENIED');
  expect(h.entries.has('permission')).toBe(true);
  expect(p.settled).not.toHaveBeenCalled();
  expect(h.dismiss).not.toHaveBeenCalled();
  h.setSharedTask(undefined);
  await expect(h.resolveFromIpc({}, 'permission', decision)).resolves.toEqual({ accepted: true });
  await expect(p.promise).resolves.toEqual(decision);
  expect(h.entries.has('permission')).toBe(false);
  expect(h.dismiss).toHaveBeenCalledTimes(1);
});

it.each(['ask_user_question', 'plan_review'] as const)('rejects guest decisions after %s is handed to Feishu, including already-admitted requests', async (kind) => {
  const h = harness();
  const p = h.request(kind, 'task', kind);
  const peer: SharedTaskPeerCapture = {
    author: { sharedTaskId: 'shared', sessionId: 'task', memberId: 'guest', accountId: 'guest', displayName: 'Guest' },
    isCurrent: () => true, authorize: () => true,
  };
  const decision: InteractionDecision = kind === 'ask_user_question'
    ? { kind, answers: { choice: 'yes' } } : { kind, behavior: 'allow' };
  const payload = { channel: 'maker:resolve-interaction', args: [kind, decision] };
  assertSharedTaskInvoke(peer, payload);
  await Promise.resolve();
  const [taken] = h.take('task');
  expect(h.entries.get(kind).migrated).toBe(true);
  expect(() => assertSharedTaskInvoke(peer, payload)).toThrow('PERMISSION_DENIED');
  h.setSharedTask(peer);
  await expect(h.resolveFromIpc({}, kind, decision)).rejects.toThrow('PERMISSION_DENIED');
  expect(h.entries.has(kind)).toBe(true);
  expect(p.settled).not.toHaveBeenCalled();
  taken.resolve(decision);
  await expect(p.promise).resolves.toEqual(decision);
  expect(h.entries.has(kind)).toBe(false);
});

it('keeps an authorized shared-task permission answer available after IM takeover', async () => {
  const h = harness();
  const p = h.request();
  const [taken] = h.take('task');
  expect(h.entries.get('permission').migrated).not.toBe(true);
  h.setSharedTask({
    author: { sharedTaskId: 'shared', sessionId: 'task', memberId: 'guest', accountId: 'guest', displayName: 'Guest' },
    isCurrent: () => true, authorize: () => true,
  });
  const answer = { kind: 'permission', behavior: 'allow' } as const;
  await expect(h.resolveFromIpc({}, 'permission', answer)).resolves.toEqual({ accepted: true });
  taken.resolve({ kind: 'permission', behavior: 'deny' });
  await expect(p.promise).resolves.toEqual(answer);
  expect(h.dismiss).toHaveBeenCalledTimes(1);
});

it('rejects a guest replacement tool input without consuming the pending request', async () => {
  const h = harness();
  const p = h.request();
  h.setSharedTask({
    author: { sharedTaskId: 'shared', sessionId: 'task', memberId: 'guest', accountId: 'guest', displayName: 'Guest' },
    isCurrent: () => true, authorize: () => true,
  });
  await expect(h.resolveFromIpc({}, 'permission', {
    kind: 'permission', behavior: 'allow', updatedInput: { command: 'different-command' },
  })).rejects.toThrow('PERMISSION_DENIED');
  expect(h.entries.has('permission')).toBe(true);
  expect(p.settled).not.toHaveBeenCalled();
  expect(h.dismiss).not.toHaveBeenCalled();
  const originalDecision = { kind: 'permission', behavior: 'allow' } as const;
  await expect(h.resolveFromIpc({}, 'permission', originalDecision)).resolves.toEqual({ accepted: true });
  await expect(p.promise).resolves.toEqual(originalDecision);
});

// Codex Default-mode RPCs must expire with an empty answer, never a selected option.
it('times out an untouched optional question but keeps an active editor pending', async () => {
  const h = harness();
  const untouched = h.request('untouched', 'idle-task', 'ask_user_question', undefined, undefined, false);
  const active = h.request('active', 'editing-task', 'ask_user_question', undefined, undefined, false);
  const blocking = h.request('blocking', 'blocking-task', 'ask_user_question');
  await vi.advanceTimersByTimeAsync(MINUTE);
  expect(untouched.settled).not.toHaveBeenCalled();
  expect(h.answer('active', { kind: 'ask_user_question', answers: {}, inProgress: true })).toBe(true);
  expect(h.answer('blocking', { kind: 'ask_user_question', answers: {}, inProgress: true })).toBe(false);
  expect(active.settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2 * MINUTE);
  await expect(untouched.promise).resolves.toEqual({ kind: 'ask_user_question', answers: {}, dismissed: true });
  expect(active.settled).not.toHaveBeenCalled();
  expect(blocking.settled).not.toHaveBeenCalled();
  h.answer('active', { kind: 'ask_user_question', answers: { choice: 'User answer' } });
  await expect(active.promise).resolves.toMatchObject({ answers: { choice: 'User answer' } });
  h.cleanup('blocking-task', 'session_closed');
});
