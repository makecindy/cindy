import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InteractionDecision, InteractionRequest } from '@cindy/maker-core';

// Execute the production listener and control adapter without booting Electron.
const source = readFileSync(new URL('../maker-ipc/register.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('register.ts', source, ts.ScriptTarget.ES2022, true);
const names = new Set([
  'installDesktopInteractionListener', 'clearPendingInteraction',
  'schedulePendingPermissionTimeout', 'setPendingInteractionTimeoutsPaused',
  'resolvePendingInteraction', 'defaultDecisionForPending',
  'cleanupPendingAgentInteractionsForSession', 'takePendingInteractionsForSession',
]);
const functions = ast.statements.filter((node) => ts.isFunctionDeclaration(node)
  && node.name && names.has(node.name.text)).map(node => node.getText(ast).replace(/^export /, ''));
let holdInputSource = '';
function visit(node: ts.Node): void {
  if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'holdInput') {
    holdInputSource = node.initializer.getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
if (!holdInputSource) throw new Error('Task holdInput adapter missing');
const compiled = ts.transpileModule(`${functions.join('\n')}
return { install: installDesktopInteractionListener, hold: ${holdInputSource},
  answer: resolvePendingInteraction, cleanup: cleanupPendingAgentInteractionsForSession,
  take: takePendingInteractionsForSession };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const MINUTE = 60_000;

function harness() {
  const held = new Set<string>();
  const coordinator = {
    isExecutionPaused: (id: string) => held.has(id),
    setExecutionPaused: (id: string, value: boolean) => { if (value) held.add(id); else held.delete(id); },
    onInteractionResolved: vi.fn(),
  };
  const listeners = new Map<string, (request: InteractionRequest) => Promise<InteractionDecision>>();
  const entries = new Map();
  const dismiss = vi.fn();
  const deps = {
    pendingInteractionResolvers: entries,
    agentInputCoordinatorHolder: coordinator, inputCoordinator: coordinator,
    PERMISSION_INTERACTION_TIMEOUT_MS: 10 * MINUTE,
    installDesktopInteractionHandler: (session: { id: string }, handler: (request: InteractionRequest) => Promise<InteractionDecision>) => listeners.set(session.id, handler),
    shouldNotifyAgentIslandForSession: () => false,
    flushAssistantBlock: vi.fn(), onInteractionMessage: vi.fn(),
    redactToolInputForUntrustedBoundary: (_tool: string, input: unknown) => input,
    broadcastToAllWindows: vi.fn(),
    MAKER_PUSH: { INTERACTION_REQUEST: 'request', INTERACTION_DISMISSED: 'dismissed' },
    handleAgentIslandInteractionAfterBroadcast: vi.fn(), handleAgentIslandInteractionDismissed: vi.fn(),
    dismissRendererInteraction: dismiss, persistInteractionDecision: vi.fn(),
    goalAskAnswerObserver: null, ghostSetupInteractionBridge: { cleanupForSession: vi.fn() },
  };
  const runtime = new Function(...Object.keys(deps), compiled)(...Object.values(deps)) as {
    install: (session: { id: string }) => void;
    hold: (id: string, held: boolean) => void;
    answer: (id: string, decision: InteractionDecision) => boolean;
    cleanup: (id: string, reason: string) => void;
    take: (id: string) => Array<{ resolve: (decision: InteractionDecision) => void }>;
  };
  const request = (id = 'permission', sessionId = 'task', kind: InteractionRequest['kind'] = 'permission') => {
    runtime.install({ id: sessionId });
    const settled = vi.fn();
    const promise = listeners.get(sessionId)!({ kind, requestId: id, toolName: 'Shell', input: {} } as InteractionRequest);
    void promise.then(settled);
    return { promise, settled };
  };
  return { ...runtime, request, entries, dismiss };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('permission timeout follows the task pause lifecycle', () => {
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
