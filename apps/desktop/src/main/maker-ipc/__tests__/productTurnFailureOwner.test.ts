import type { AgentEvent, Session } from '@cindy/maker-core';
import { describe, expect, it } from 'vitest';
import {
  captureProductTurnFailureOwner,
  createDeferredProductTurnFailureGate,
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
