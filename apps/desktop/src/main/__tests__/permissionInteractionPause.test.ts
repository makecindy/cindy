import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { captureRememberedAutoCommand, type ApprovalRuleCommandDeps } from '../maker-ipc/approvalRuleCommandHandler';
import { createApprovalRuleStore } from '../maker-host/approval-rule-store';
import { McpSetupBridge } from '../maker-ipc/mcpSetupBridge';
import { normalizeRuleGroup } from '../../../../../packages/maker-core/src/agents/shared/approval-rules/normalize';
import { evaluatePersonalRequirements, matchedPersonalAutoAsks } from '../../../../../packages/maker-core/src/agents/shared/auto-review-decision';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InteractionDecision, InteractionRequest, InteractionResolver } from '@cindy/maker-core';
import { createSharedPermission, type SharedPermission } from '../maker-ipc/sharedPermission';
import { beginInteractionRoute, installDesktopInteractionHandler, type InteractionHandler, type InteractionSession } from '../maker-ipc/interactionRouter';
import { assertSharedTaskInteractionResolveCurrent, assertSharedTaskInvoke, setSharedTaskInteractionReader, type SharedTaskPeerCapture } from '../device-link/sharedTaskDispatch.js';

// Execute the production listener and control adapter without booting Electron.
const source = readFileSync(new URL('../maker-ipc/register.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('register.ts', source, ts.ScriptTarget.ES2022, true);
const names = new Set([
  'installDesktopInteractionListener', 'clearPendingInteraction',
  'schedulePendingPermissionTimeout', 'setPendingInteractionTimeoutsPaused',
  'resolvePendingInteraction', 'cancelPendingInteraction', 'defaultDecisionForPending',
  'cleanupPendingAgentInteractionsForSession', 'takePendingInteractionsForSession',
  'bindSharedPermission',
  'isPermissionInteractionDecision',
]);
const functions = ast.statements.filter((node) => ts.isFunctionDeclaration(node)
  && node.name && names.has(node.name.text)).map(node => node.getText(ast).replace(/^export /, ''));
let holdInputSource = '';
let resolveHandlerSource = '';
let interactionReaderSource = '';
function visit(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'setSharedTaskInteractionReader') {
    interactionReaderSource = node.arguments[0].getText(ast);
  }
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'ipcMain.handle'
    && node.arguments[0]?.getText(ast) === 'MAKER_INVOKE.RESOLVE_INTERACTION') {
    resolveHandlerSource = node.arguments[1].getText(ast);
  }
  if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'holdInput') {
    holdInputSource = node.initializer.getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
if (!holdInputSource) throw new Error('Task holdInput adapter missing');
if (!resolveHandlerSource) throw new Error('Resolve interaction IPC handler missing');
if (!interactionReaderSource) throw new Error('Shared-task interaction reader missing');
const compiled = ts.transpileModule(`${functions.join('\n')}
setSharedTaskInteractionReader(${interactionReaderSource});
return { install: installDesktopInteractionListener, hold: ${holdInputSource},
  answer: resolvePendingInteraction, cleanup: cleanupPendingAgentInteractionsForSession,
  take: takePendingInteractionsForSession, resolveFromIpc: ${resolveHandlerSource} };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const MINUTE = 60_000;

function harness(extra: Record<string, unknown> = {}) {
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
  const deps = {
    createSharedPermission,
    getDeviceLinkInvokeContext: () => ({ sharedTask }),
    assertSharedTaskInteractionResolveCurrent,
    setSharedTaskInteractionReader,
    isPluginSetupInteractionDecision: () => false,
    assertResolveInteractionOrigin: vi.fn(), isPendingDesktopOnlyConfirmation: () => false,
    pendingInteractionResolvers: entries,
    agentInputCoordinatorHolder: coordinator, inputCoordinator: coordinator,
    PERMISSION_INTERACTION_TIMEOUT_MS: 10 * MINUTE,
    installDesktopInteractionHandler,
    shouldNotifyAgentIslandForSession: () => false,
    flushAssistantBlock: vi.fn(), onInteractionMessage: vi.fn(),
    redactToolInputForUntrustedBoundary: (_tool: string, input: unknown) => input,
    broadcastToAllWindows: vi.fn(),
    MAKER_PUSH: { INTERACTION_REQUEST: 'request', INTERACTION_DISMISSED: 'dismissed' },
    handleAgentIslandInteractionAfterBroadcast: vi.fn(), handleAgentIslandInteractionDismissed: vi.fn(),
    dismissRendererInteraction: dismiss, persistInteractionDecision: vi.fn(),
    goalAskAnswerObserver: null, ghostSetupInteractionBridge: { cleanupForSession: vi.fn(), resolve: () => false },
    mcpSetupBridge: new McpSetupBridge({ broadcast: vi.fn() }),
    captureRememberedAutoCommand, rememberApprovalDeps: undefined, isDeepStrictEqual,
    throwIpcError: (_code: string, message: string) => { throw new Error(message); },
    isDeviceLinkInvoke: () => false, assertTrustedAppRendererEvent: () => {},
    handleAgentIslandInteractionDismissedByRequestId: vi.fn(),
    issueConfirmBridge: { resolve: () => false }, renameSessionsConfirmBridge: { resolve: () => false },
    taskActionConfirmBridge: { resolveFromIpc: () => false }, orcaWorkerPermissionConfirmBridge: { resolveFromIpc: () => false },
    ghostGrantConfirmBridge: { resolve: () => false }, getBotAuthorizationService: () => undefined,
    getInputHandoffService: () => undefined, inputHandoffActor: () => undefined, log: { warn: vi.fn() },
    ...extra,
  };
  const runtime = new Function(...Object.keys(deps), compiled)(...Object.values(deps)) as {
    install: (session: InteractionSession) => void;
    hold: (id: string, held: boolean) => string[];
    answer: (id: string, decision: InteractionDecision) => boolean;
    cleanup: (id: string, reason: string) => void;
    take: (id: string) => Array<{ resolve: (decision: InteractionDecision) => void; sharedPermission?: SharedPermission }>;
    resolveFromIpc: (event: unknown, id: string, decision: InteractionDecision) => Promise<{ accepted: boolean }>;
  };
  const request = (id = 'permission', sessionId = 'task', kind: InteractionRequest['kind'] = 'permission', channel?: InteractionHandler, signal?: AbortSignal, autoCommand?: Extract<InteractionRequest, { kind: 'permission' }>['autoCommand']) => {
    const session: InteractionSession = { id: sessionId, setInteractionListener: handler => { if (handler) listeners.set(sessionId, handler); } };
    runtime.install(session);
    const lease = channel ? beginInteractionRoute(session, {
      route: { sessionId, turnId: 'turn', origin: { kind: 'hook', source: 'test' }, interactionSurface: 'channel-card', timeoutMs: 10 * MINUTE },
      handle: channel,
      // A presentation acknowledges cancellation; Router must still finalize it.
      onCancel: () => true,
    }) : undefined;
    const settled = vi.fn();
    const promise = listeners.get(sessionId)!({ kind, requestId: id, toolName: autoCommand?.harness === 'codex' ? 'exec' : autoCommand?.harness === 'pi' ? 'bash' : 'Bash', input: { command: autoCommand?.command }, ...(autoCommand ? { autoCommand } : {}) } as InteractionRequest, signal);
    void promise.then(settled);
    return { promise, settled, lease };
  };
  return { ...runtime, request, entries, dismiss, broadcast: deps.broadcastToAllWindows, setSharedTask: (peer?: SharedTaskPeerCapture) => { sharedTask = peer; } };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { setSharedTaskInteractionReader(null); vi.clearAllTimers(); vi.useRealTimers(); });

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

describe('permission timeout follows the task pause lifecycle', () => {
  // IM permission contract: production listener cancellation must dismiss paused cards too.
  // Existing cases stop the whole task; a single aborted provider request must also settle
  // Desktop and an IM takeover, reject late approval, and leave other tasks alone (unit).
  it.each(['desktop', 'im-takeover'])('dismisses an aborted request while paused on %s', async (surface) => {
    const h = harness();
    const abort = new AbortController();
    const p = h.request('permission', 'task', 'permission', undefined, abort.signal);
    const other = h.request('other', 'other-task');
    const taken = surface === 'im-takeover' ? h.take('task')[0] : undefined;
    h.hold('task', true);
    const allow = { kind: 'permission', behavior: 'allow' } as const;
    if (taken) taken.resolve(allow);
    else expect(h.answer('permission', allow)).toBe(false);
    expect(p.settled).not.toHaveBeenCalled();
    abort.abort();
    const denied = { kind: 'permission', behavior: 'deny', reason: 'session_aborted' };
    await expect(p.promise).resolves.toEqual(denied);
    expect(h.entries.has('permission')).toBe(false);
    expect(h.dismiss).toHaveBeenCalledTimes(1);
    if (taken) await expect(taken.sharedPermission!.result).resolves.toEqual(denied);
    h.hold('task', false);
    expect(h.answer('permission', allow)).toBe(false);
    expect(taken?.sharedPermission?.decide(allow)).not.toBe(true);
    expect(h.entries.has('other')).toBe(true);
    expect(other.settled).not.toHaveBeenCalled();
    expect(h.answer('other', allow)).toBe(true);
    await expect(other.promise).resolves.toEqual(allow);
  });

  it('holds a shared route timeout until resume without closing either surface early', async () => {
    const h = harness();
    h.hold('task', true);
    let shared!: SharedPermission;
    const p = h.request('permission', 'task', 'permission', (_req, permission) => {
      shared = permission!;
      return shared.result;
    });
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(p.settled).not.toHaveBeenCalled();
    expect(shared.decision).toBeUndefined();
    expect(h.dismiss).not.toHaveBeenCalled();
    h.hold('task', false);
    await expect(p.promise).resolves.toMatchObject({ behavior: 'deny', reason: 'interaction_timeout' });
    await expect(shared.result).resolves.toMatchObject({ behavior: 'deny', reason: 'interaction_timeout' });
    p.lease!.release();
  });

  it.each(['resume', 'session_aborted', 'session_closed', 'release'] as const)(
    'keeps a new IM answer provisional until %s and converges every surface', async finish => {
      const h = harness();
      h.hold('task', true);
      let shared!: SharedPermission;
      const presented = vi.fn();
      const p = h.request('permission', 'task', 'permission', (_req, permission) => {
        shared = permission!;
        void shared.result.then(presented);
        // Synchronous channel answers must already see the Host pause gate.
        expect(shared.decide({ kind: 'permission', behavior: 'allow' })).toBe(true);
        expect(shared.decide({ kind: 'permission', behavior: 'deny' })).toBe(false);
        return shared.result;
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(p.settled).not.toHaveBeenCalled();
      expect(presented).not.toHaveBeenCalled();
      expect(h.dismiss).not.toHaveBeenCalled();
      expect(shared.decision).toBeUndefined();
      if (finish === 'resume') h.hold('task', false);
      else if (finish === 'release') p.lease!.release();
      else h.cleanup('task', finish);
      const expected = finish === 'resume'
        ? { kind: 'permission', behavior: 'allow' }
        : { kind: 'permission', behavior: 'deny', reason: finish === 'release' ? 'interaction_route_released' : finish };
      await expect(p.promise).resolves.toEqual(expected);
      await expect(shared.result).resolves.toEqual(expected);
      expect(presented).toHaveBeenCalledExactlyOnceWith(expected);
      expect(h.dismiss).toHaveBeenCalledTimes(1);
      h.hold('task', false);
      expect(shared.decide({ kind: 'permission', behavior: 'allow' })).toBe(false);
      p.lease!.release();
    },
  );

  it('keeps the permission pending across its original deadline and resumes only the remaining budget', async () => {
    const h = harness();
    const p = h.request();
    await vi.advanceTimersByTimeAsync(3 * MINUTE);
    h.hold('task', true);
    expect(h.answer('permission', { kind: 'permission', behavior: 'allow' })).toBe(false);
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(p.settled).not.toHaveBeenCalled();
    expect(h.entries.has('permission')).toBe(true);
    h.hold('task', false);
    await vi.advanceTimersByTimeAsync(7 * MINUTE - 1);
    expect(p.settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(p.settled).toHaveBeenCalledExactlyOnceWith({ kind: 'permission', behavior: 'deny', reason: 'timeout' });
    expect(h.answer('permission', { kind: 'permission', behavior: 'allow' })).toBe(false);
    expect(h.dismiss).toHaveBeenCalledTimes(1);
  });

  it('does not reset or consume the remaining budget on repeated pause/resume', async () => {
    const h = harness();
    const p = h.request();
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    h.hold('task', true);
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    h.hold('task', true);
    h.hold('task', false);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    h.hold('task', false);
    h.hold('task', true);
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    h.hold('task', false);
    await vi.advanceTimersByTimeAsync(4 * MINUTE - 1);
    expect(p.settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(p.settled).toHaveBeenCalledTimes(1);
  });

  it('holds permissions raised after pause and leaves another task safety timeout running', async () => {
    const h = harness();
    h.hold('task', true);
    const paused = h.request();
    const other = h.request('other-permission', 'other-task');
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(paused.settled).not.toHaveBeenCalled();
    expect(other.settled).toHaveBeenCalledExactlyOnceWith({ kind: 'permission', behavior: 'deny', reason: 'timeout' });
    h.hold('task', false);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(paused.settled).toHaveBeenCalledTimes(1);
  });

  it.each(['session_aborted', 'session_closed'])('cleans up a paused permission once on %s without resurrecting its timer', async reason => {
    const h = harness();
    const p = h.request();
    h.hold('task', true);
    h.cleanup('task', reason);
    h.cleanup('task', reason);
    h.hold('task', false);
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(p.settled).toHaveBeenCalledExactlyOnceWith({ kind: 'permission', behavior: 'deny', reason });
    expect(h.entries.size).toBe(0);
    expect(h.dismiss).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts one answer after resume and cancels the remaining timeout', async () => {
    const h = harness();
    const p = h.request();
    h.hold('task', true);
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    h.hold('task', false);
    expect(h.answer('permission', { kind: 'permission', behavior: 'allow' })).toBe(true);
    expect(h.answer('permission', { kind: 'permission', behavior: 'deny' })).toBe(false);
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(p.settled).toHaveBeenCalledExactlyOnceWith({ kind: 'permission', behavior: 'allow' });
    expect(h.dismiss).toHaveBeenCalledTimes(1);
  });

  it.each(['permission', 'ask_user_question', 'plan_review'] as const)('defers a migrated %s answer until resume and ignores duplicates', async kind => {
    const h = harness();
    const p = h.request(kind, 'task', kind);
    const [taken] = h.take('task');
    expect(h.take('task')).toEqual([]);
    h.hold('task', true);
    const answer: InteractionDecision = kind === 'ask_user_question'
      ? { kind, answers: { choice: 'yes' } }
      : { kind, behavior: 'allow' };
    taken.resolve(answer);
    taken.resolve({ kind: 'permission', behavior: 'deny' });
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(p.settled).not.toHaveBeenCalled();
    expect(h.entries.size).toBe(1);
    expect(h.hold('task', false)).toEqual([kind]);
    expect(h.hold('task', false)).toEqual([]);
    await p.promise;
    expect(p.settled).toHaveBeenCalledExactlyOnceWith(answer);
    taken.resolve(answer);
    expect(h.entries.size).toBe(0);
  });

  it.each(['session_aborted', 'session_closed'])('cancels a deferred migrated answer on %s', async reason => {
    const h = harness();
    const p = h.request();
    const [taken] = h.take('task');
    h.hold('task', true);
    taken.resolve({ kind: 'permission', behavior: 'allow' });
    expect(taken.sharedPermission!.decision).toBeUndefined();
    h.cleanup('task', reason);
    h.cleanup('task', reason);
    h.hold('task', false);
    taken.resolve({ kind: 'permission', behavior: 'allow' });
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(p.settled).toHaveBeenCalledExactlyOnceWith({ kind: 'permission', behavior: 'deny', reason });
    await expect(taken.sharedPermission!.result).resolves.toEqual({ kind: 'permission', behavior: 'deny', reason });
    expect(h.entries.size).toBe(0);
  });

  it('defers the migrated channel safety timeout until resume', async () => {
    const h = harness();
    const p = h.request();
    const [taken] = h.take('task');
    h.hold('task', true);
    taken.resolve({ kind: 'permission', behavior: 'deny', reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(p.settled).not.toHaveBeenCalled();
    h.hold('task', false);
    await p.promise;
    expect(p.settled).toHaveBeenCalledExactlyOnceWith({ kind: 'permission', behavior: 'deny', reason: 'timeout' });
  });

  it('keeps transferred permissions out of the Desktop timer lifecycle', async () => {
    const h = harness();
    const p = h.request();
    h.hold('task', true);
    const [taken] = h.take('task');
    h.hold('task', false);
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    expect(p.settled).not.toHaveBeenCalled();
    taken.resolve({ kind: 'permission', behavior: 'allow' });
    await p.promise;
    expect(p.settled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['ask_user_question', 'plan_review'] as const)('does not add a timeout to %s when resumed', async kind => {
    const h = harness();
    const p = h.request(kind, 'task', kind);
    h.hold('task', true);
    h.hold('task', false);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(p.settled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// Real production listener + IPC handler -> actual owner store -> reopened active artifact.
// Existing pause cases did not exercise persistence, identity or save failure; unit, test-only temp owner.
describe('remembered local Auto command confirmation', () => {
  it.each(['claude-code', 'pi', 'codex', 'codex-wrapped', 'claude-code-project'] as const)('persists %s only on remember and leaves ordinary allow once unwritten', async scenario => {
    if (scenario === 'claude-code-project') vi.useRealTimers();
    const target = scenario === 'claude-code-project' ? 'claude-code' : scenario === 'codex-wrapped' ? 'codex' : scenario;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remember-card-'));
    try {
      const row = { status: 'active', source: 'desktop', agentKind: target === 'claude-code' ? 'cc' : target,
        workingDir: dir, workspaceKind: 'project' };
      let ownerCurrent = true;
      let evidenceCurrent = true;
      let runtime = { instanceId: 'instance', stablePermissionModeState: { mode: 'auto', generation: 1 },
        stablePlanModeState: { enabled: false, generation: 1 }, getStatus: () => 'active' };
      const scope = { ownerId: 'owner', executionHostId: 'host', harnesses: [target] };
      const deps: ApprovalRuleCommandDeps = {
        assertTrustedSender: () => {}, isDeviceLinkInvoke: () => false,
        captureOwner: () => ({ ownerId: 'owner', executionHostId: 'host', generation: '1', dbClient: row }),
        ownerCurrent: () => ownerCurrent, getInputGeneration: () => 0, isProvisional: () => false,
        readSession: async () => row as never, withSessionLock: async (_id, run) => run(),
        createStore: (_owner, assertCurrent, consumer) => createApprovalRuleStore({ ownerId: 'owner', ownerDataDir: dir,
          assertCurrent, localManagedCommandHostId: 'host', ...(consumer ? { resolveManagedConsumer: () => consumer } : {}) }),
      };
      let trusted = true;
      let remote = false;
      const h = harness({ rememberApprovalDeps: deps, getMakerIfReady: () => ({ getSession: () => runtime }),
        isDeviceLinkInvoke: () => remote,
        assertTrustedAppRendererEvent: () => { if (!trusted) throw new Error('Untrusted sender'); } });
      const command = { sessionInstanceId: 'instance', harness: target, command: scenario === 'codex-wrapped'
        ? "/bin/bash -lc 'touch /home/xd.guest/approval-test-work/CINDY_REMEMBER_TARGET_c20261026a'"
        : 'git push origin draft', cwd: dir, isCurrent: () => evidenceCurrent };
      const nativeAsk = normalizeRuleGroup({ harness: 'claude-code', sourceId: 'live-user', layer: 'user',
        locator: 'claude-code-live://userSettings/test', dialectVersion: 'live-user-v1', decisionDomain: 'personal-approval' },
        { ...scope, harnesses: ['claude-code'] }, [{ id: 'ask', original: 'Bash(git push origin draft)', decision: 'ask',
          matcher: { kind: 'cc-command', mode: 'exact', pattern: command.command } }]);
      const live = { scope: { ...scope, projectId: fs.realpathSync.native(dir) }, fingerprint: 'live', groups: [nativeAsk] };
      const evidence = { ...command, ...(target === 'claude-code'
        ? { autoAskExceptions: matchedPersonalAutoAsks(live, command.command) } : {}) };
      const store = createApprovalRuleStore({ ownerId: 'owner', ownerDataDir: dir, assertCurrent: () => {} });
      if (scenario === 'claude-code-project') {
        const seed = await captureRememberedAutoCommand(deps, 'task', command, () => true, 'instance');
        await seed!.save();
        const previous = await store.readSnapshot(scope);
        const user = previous.groups[0]!;
        const project = normalizeRuleGroup(user.origin, { ...scope, projectId: fs.realpathSync.native(dir) },
          user.clauses.map(clause => ({ ...clause, decision: 'ask' as const })));
        await store.applyManagedEdit(previous.revision, project.scope, [project], [], undefined, true);
      }
      const originalGroups = (await store.readSnapshot(scope)).groups;
      const once = h.request('once', 'task', 'permission', undefined, undefined, command);
      await vi.waitFor(() => expect(h.entries.get('once')?.remember).toBeTruthy());
      expect(h.broadcast.mock.calls.at(-1)?.[1].request.autoCommand).toBeUndefined();
      expect(h.broadcast.mock.calls.at(-1)?.[1].request.metadata.rememberAutoCommand.command).toBe(command.command);
      expect(h.broadcast.mock.calls.at(-1)?.[1].request.metadata.rememberAutoCommand.projectId)
        .toBe(scenario === 'claude-code-project' ? fs.realpathSync.native(dir) : undefined);
      await h.resolveFromIpc({}, 'once', { kind: 'permission', behavior: 'allow' });
      await once.promise;
      expect((await store.readSnapshot(scope)).groups).toEqual(originalGroups);
      const remembered = h.request('remember', 'task', 'permission', undefined, undefined, evidence);
      await vi.waitFor(() => expect(h.entries.get('remember')?.remember).toBeTruthy());
      // Failure keeps the same pending card; no successful optimistic acknowledgement.
      // A failed marker filesystem read is a real store error, not a mocked save success.
      const markerDir = path.join(dir, 'command-approval-runtime');
      fs.mkdirSync(markerDir, { recursive: true });
      const marker = path.join(markerDir, 'publish-state.json');
      const oldMarker = fs.existsSync(marker) ? fs.readFileSync(marker) : null;
      if (oldMarker) fs.unlinkSync(marker);
      fs.mkdirSync(marker);
      await expect(h.resolveFromIpc({}, 'remember', { kind: 'permission', behavior: 'allow', rememberAutoCommand: true } as never)).rejects.toThrow();
      expect(h.entries.has('remember')).toBe(true);
      expect(remembered.settled).not.toHaveBeenCalled();
      fs.rmdirSync(marker);
      if (oldMarker) fs.writeFileSync(marker, oldMarker);
      expect(await h.resolveFromIpc({}, 'remember', { kind: 'permission', behavior: 'allow', rememberAutoCommand: true } as never))
        .toMatchObject({ accepted: true, remembered: true });
      expect(await remembered.promise).toMatchObject({ kind: 'permission', behavior: 'allow' });
      const fresh = createApprovalRuleStore({ ownerId: 'owner', ownerDataDir: dir, assertCurrent: () => {},
        resolveManagedConsumer: () => ({ scope: { ...scope, projectId: fs.realpathSync.native(dir) }, sessionId: 'task', sessionInstanceId: 'instance' }) });
      const active = await fresh.readPublishedManagedSnapshot();
      expect(active.kind === 'published-managed' && active.groups[0]?.clauses[0]).toMatchObject({ decision: 'allow', matcher: { pattern: command.command, mode: 'exact' } });
      if (scenario === 'claude-code-project' && active.kind === 'published-managed') {
        expect(active.groups).toHaveLength(1);
        expect(active.groups[0]!.scope.projectId).toBe(fs.realpathSync.native(dir));
        expect((await fresh.readSnapshot(scope)).groups.find(group => !group.scope.projectId)?.clauses[0]?.decision).toBe('allow');
      }
      if (target === 'claude-code' && active.kind === 'published-managed') {
        expect(active.groups[0]!.clauses[0]!.autoAskExceptions).toEqual(evidence.autoAskExceptions);
        expect(evaluatePersonalRequirements({ ...live, groups: [nativeAsk, ...active.groups] }, command.command))
          .toMatchObject({ status: 'matched', decision: 'allow' });
      }
      for (const edge of ['untrusted', 'remote', 'default', 'full', 'instance', 'stop', 'explicit-deny'] as const) {
        const id = 'guard-' + edge;
        const guarded = h.request(id, 'task', 'permission', undefined, undefined, command);
        await vi.waitFor(() => expect(h.entries.get(id)?.remember).toBeTruthy());
        const oldMarker = fs.readFileSync(path.join(dir, 'command-approval-runtime', 'publish-state.json'), 'utf8');
        if (edge === 'untrusted') trusted = false;
        if (edge === 'remote') remote = true;
        if (edge === 'default') runtime.stablePermissionModeState = { mode: 'ask', generation: 2 };
        if (edge === 'full') runtime.stablePermissionModeState = { mode: 'bypassPermissions', generation: 3 };
        const previousRuntime = runtime;
        if (edge === 'instance') runtime = { ...runtime, instanceId: 'replacement' };
        if (edge === 'stop') h.cleanup('task', 'session_aborted');
        if (edge === 'explicit-deny') await h.resolveFromIpc({}, id, { kind: 'permission', behavior: 'deny' });
        await expect(h.resolveFromIpc({}, id, { kind: 'permission', behavior: 'allow', rememberAutoCommand: true } as never)).rejects.toThrow();
        expect(fs.readFileSync(path.join(dir, 'command-approval-runtime', 'publish-state.json'), 'utf8')).toBe(oldMarker);
        trusted = true; remote = false; runtime = previousRuntime;
        await h.resolveFromIpc({}, id, { kind: 'permission', behavior: 'allow' });
        await guarded.promise;
        runtime.stablePermissionModeState = { mode: 'auto', generation: 1 };
      }
      const stale = h.request('stale', 'task', 'permission', undefined, undefined, command);
      await vi.waitFor(() => expect(h.entries.get('stale')?.remember).toBeTruthy());
      ownerCurrent = false; evidenceCurrent = false;
      await expect(h.resolveFromIpc({}, 'stale', { kind: 'permission', behavior: 'allow', rememberAutoCommand: true } as never)).rejects.toThrow();
      expect(h.entries.has('stale')).toBe(true);
      await h.resolveFromIpc({}, 'stale', { kind: 'permission', behavior: 'deny' });
      await stale.promise;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
