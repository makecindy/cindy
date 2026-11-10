import type { AgentEvent, Session } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';
import {
  captureProductTurnFailureOwner,
  createDeferredProductTurnFailureGate,
  createProductTurnFailureFinalizer,
} from '../productTurnFailureOwner.js';

function fakeSession(
  id: string,
  instanceId: string,
  generation: number,
): Session {
  return {
    id,
    instanceId,
    getTurnGeneration: () => generation,
  } as unknown as Session;
}

function terminalError(
  session: Session,
  message: string,
  meta?: Record<string, unknown>,
): AgentEvent {
  return {
    type: 'error',
    source: 'claude-code',
    data: { message, isTerminal: true },
    sessionInstanceId: session.instanceId,
    sessionTurnGeneration: session.getTurnGeneration(),
    ...(meta ? { agentMeta: meta } : {}),
  } as AgentEvent;
}

describe('deferred product turn failure gate', () => {
  // Unit timing regression: delegation persistence adds an await to the finalizer;
  // a replacement turn must not be interrupted after that old receipt finishes.
  it('rechecks ownership after deferred delegation settlement', async () => {
    const session = fakeSession('task', 'old', 1);
    const owner = { ...captureProductTurnFailureOwner(session, terminalError(session, 'failed')),
      delegationTerminal: { pendingInputClientIds: [], resultText: '' } };
    let current = true;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const interrupt = vi.fn(async () => {});
    const settle = createProductTurnFailureFinalizer({
      gate: createDeferredProductTurnFailureGate(), isCurrentOwner: () => current,
      commitActivity: () => {}, settlePluginTasks: () => {},
      settleDelegation: () => pending, interrupt,
    });
    const finishing = settle('task', owner);
    current = false;
    release();
    await finishing;
    expect(interrupt).not.toHaveBeenCalled();
  });

  it('rebinds an outstanding owner across a provider replacement', () => {
    const oldSession = fakeSession('task', 'old', 4);
    const owner = captureProductTurnFailureOwner(
      oldSession,
      terminalError(oldSession, 'token expired'),
    );
    const replacement = fakeSession('task', 'replacement', 0);
    const gate = createDeferredProductTurnFailureGate();
    gate.defer(owner);
    gate.rebindSession('task', replacement);

    let settledSession: Session | undefined;
    expect(
      gate.settle(
        'task',
        (current) => current.session === replacement,
        (current) => {
          settledSession = current.session;
        },
        { data: { message: 'token expired' } },
      ),
    ).toBe(true);
    expect(settledSession).toBe(replacement);
    expect(gate.pending('task')).toBeUndefined();
  });

  it('retires the old owner when a newer turn crosses dispatch', () => {
    const session = fakeSession('task', 'instance', 1);
    const owner = captureProductTurnFailureOwner(session, terminalError(session, 'stale'));
    const gate = createDeferredProductTurnFailureGate();
    gate.defer(owner);
    gate.clearSession('task');

    const interrupted: Session[] = [];
    expect(
      gate.settle('task', () => true, (current) => interrupted.push(current.session), {
        data: { message: 'stale' },
      }),
    ).toBe(false);
    expect(interrupted).toHaveLength(0);
  });

  it('consumes a late callback without interrupting a stale runtime', () => {
    const session = fakeSession('task', 'instance', 3);
    const owner = captureProductTurnFailureOwner(session, terminalError(session, 'late'));
    const gate = createDeferredProductTurnFailureGate();
    gate.defer(owner);

    let callbackCalled = false;
    expect(
      gate.settle(
        'task',
        () => false,
        () => {
          callbackCalled = true;
        },
        { data: { message: 'late' } },
      ),
    ).toBe(false);
    expect(callbackCalled).toBe(false);
    expect(gate.pending('task')).toBeUndefined();
  });

  it('fails closed for identical metadata-free errors and uses metadata when available', () => {
    const firstSession = fakeSession('task', 'first', 1);
    const secondSession = fakeSession('task', 'second', 2);
    const first = captureProductTurnFailureOwner(
      firstSession,
      terminalError(firstSession, 'same failure'),
    );
    const second = captureProductTurnFailureOwner(
      secondSession,
      terminalError(secondSession, 'same failure', { requestId: 'request-2' }),
    );
    const gate = createDeferredProductTurnFailureGate();
    gate.defer(first);
    gate.defer(second);

    expect(
      gate.settle('task', () => true, () => {}, { data: { message: 'same failure' } }),
    ).toBe(false);

    let settled: string | undefined;
    expect(
      gate.settle(
        'task',
        () => true,
        (owner) => {
          settled = owner.instanceId;
        },
        { data: { message: 'same failure' }, meta: { requestId: 'request-2' } },
      ),
    ).toBe(true);
    expect(settled).toBe('second');
    expect(gate.pending('task')?.instanceId).toBe('first');
  });
});
