import {
  Session,
  type AgentEvent,
  type AgentSessionHandle,
  type SessionStatusListener,
} from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';

import {
  createSessionBindingLifecycle,
  finalizeSessionClose,
  runSessionCloseCleanup,
  type SessionBindingLifecycleDeps,
  type SessionCloseCleanupActions,
} from '../sessionBindingLifecycle.js';
import {
  AgentInputCoordinator,
  type AgentInputCoordinatorDeps,
} from '../agent-input-coordinator.js';
import { createRehydrateCloseSuppression } from '../../maker-host/rehydrateCloseSuppression.js';
import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';

vi.mock('../../localDb/ipc/messages.js', () => ({ createMessage: vi.fn(async () => ({})) }));
vi.mock('../../localDb/ipc/sessions.js', () => ({ touchUserSendInDb: vi.fn(async () => {}) }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Retains captured callbacks so tests can deliver a stale transport notification explicitly. */
class TestSession {
  readonly statuses = new Set<SessionStatusListener>();
  readonly events = new Set<(value: string) => void>();
  readonly setInteractionListener = vi.fn<Session['setInteractionListener']>();
  constructor(readonly id = 'task') {}
  onStatusChange(listener: SessionStatusListener) {
    this.statuses.add(listener);
    return () => {
      this.statuses.delete(listener);
    };
  }
  onEvent(listener: (value: string) => void) {
    this.events.add(listener);
    return () => {
      this.events.delete(listener);
    };
  }
  emitStatus(status: Parameters<SessionStatusListener>[0]) {
    for (const listener of this.statuses) listener(status);
  }
  emitEvent(value: string) {
    for (const listener of this.events) listener(value);
  }
}

function harness<S extends Pick<Session, 'id' | 'onStatusChange' | 'setInteractionListener'>>() {
  const order: string[] = [];
  const context = { settlesDirectAbort: false, preserveAutoResumeIntent: false };
  const actions = {
    cleanupInteractions: vi.fn(() => {
      order.push('interactions');
    }),
    preserveAutoResume: vi.fn(() => {
      order.push('preserve-retry');
    }),
    resetAutoResume: vi.fn(() => {
      order.push('reset-retry');
    }),
    shouldPreserveInputBoundary: vi.fn(() => false),
    closeInputCoordinator: vi.fn<SessionCloseCleanupActions['closeInputCoordinator']>(() => {
      order.push('coordinator');
    }),
    cleanupRuntimeState: vi.fn(() => {
      order.push('runtime');
    }),
  };
  const finalActions = {
    clearTurnState: vi.fn(() => {
      order.push('idle');
    }),
    notifyGoalIdle: vi.fn(() => {
      order.push('goal-idle');
    }),
    cancelGoalResume: vi.fn(() => {
      order.push('cancel-goal');
    }),
  };
  const deps = {
    log: { warn: vi.fn() },
    restoreInteractionListener: vi.fn<(session: S) => void>(() => {
      order.push('restore-interaction');
    }),
    beforeReplace: vi.fn<(session: S) => void>(() => {
      order.push('replace');
    }),
    onBind: vi.fn<(session: S) => void>(() => {
      order.push('bind');
    }),
    broadcastStatus: vi.fn<SessionBindingLifecycleDeps<S, typeof context>['broadcastStatus']>(
      () => {
        order.push('status');
      },
    ),
    captureCloseContext: vi.fn<(session: S) => typeof context>(() => {
      order.push('capture');
      return { ...context };
    }),
    cleanupClosedSession: vi.fn((_session: S, captured: typeof context) => {
      runSessionCloseCleanup(captured.preserveAutoResumeIntent, actions);
    }),
    beforeCloseTeardown: vi.fn<(session: S) => void>(() => {
      order.push('unregister');
      context.settlesDirectAbort = false;
    }),
    finalizeClosedSession: vi.fn((_session: S, captured: typeof context) => {
      finalizeSessionClose(captured.settlesDirectAbort, finalActions);
    }),
  } satisfies SessionBindingLifecycleDeps<S, typeof context>;
  const lifecycle = createSessionBindingLifecycle<S, typeof context>(deps);
  function bind(
    session: S,
    dispose = () => {
      order.push('dispose');
    },
  ) {
    const registration = lifecycle.beginBinding(session);
    if (registration) {
      registration.disposers.push(dispose);
      lifecycle.attachStatusListener(registration);
    }
    return registration;
  }
  return { lifecycle, deps, bind, actions, finalActions, context, order };
}

describe('Desktop Session binding lifecycle', () => {
  it('deduplicates the same instance and detaches the old instance before publishing its replacement', () => {
    const h = harness<TestSession>();
    const old = new TestSession();
    const next = new TestSession();
    const seen: string[] = [];
    const disposeTap = vi.fn(() => {
      expect(h.lifecycle.getSession(old.id)).toBe(old);
      h.order.push('tap-end');
    });
    const registration = h.lifecycle.beginBinding(old)!;
    registration.disposers.push(
      disposeTap,
      old.onEvent((value) => seen.push(value)),
    );
    h.lifecycle.attachStatusListener(registration);
    const staleStatus = [...old.statuses][0];
    expect(h.lifecycle.beginBinding(old)).toBeNull();
    expect(old.statuses.size).toBe(1);
    old.emitEvent('once');
    expect(seen).toEqual(['once']);
    expect(h.deps.restoreInteractionListener).toHaveBeenCalledOnce();

    h.order.length = 0;
    h.bind(next);
    expect(h.order).toEqual(['replace', 'tap-end', 'bind']);
    expect(disposeTap).toHaveBeenCalledOnce();
    expect(old.setInteractionListener).toHaveBeenCalledWith(null);
    expect(old.events.size).toBe(0);
    expect(old.statuses.size).toBe(0);
    staleStatus('closed');
    old.emitEvent('stale');
    expect(seen).toEqual(['once']);
    expect(h.deps.cleanupClosedSession).not.toHaveBeenCalled();
    expect(h.lifecycle.getSession(old.id)).toBe(next);
    next.emitStatus('active');
    expect(h.deps.broadcastStatus).toHaveBeenCalledWith(next, 'active');
  });

  it('keeps unrelated task registrations and teardown independent', () => {
    const h = harness<TestSession>();
    const first = new TestSession('first');
    const second = new TestSession('second');
    h.bind(first);
    h.bind(second);
    first.emitStatus('closed');
    expect(h.lifecycle.getSession(first.id)).toBeUndefined();
    expect(h.lifecycle.getSession(second.id)).toBe(second);
    expect(second.statuses.size).toBe(1);
    second.emitStatus('active');
    expect(h.deps.broadcastStatus).toHaveBeenLastCalledWith(second, 'active');
  });

  it.each([false, true])(
    'captures direct-abort ownership before teardown and reconciles idle first (owner=%s)',
    (ownsAbort) => {
      const h = harness<TestSession>();
      const session = new TestSession();
      h.context.settlesDirectAbort = ownsAbort;
      h.bind(session, () => {
        expect(h.lifecycle.getSession(session.id)).toBeUndefined();
        h.order.push('dispose');
      });
      const staleStatus = [...session.statuses][0];
      h.order.length = 0;
      session.emitStatus('closed');
      expect(h.order).toEqual([
        'status',
        'capture',
        'interactions',
        'reset-retry',
        'coordinator',
        'runtime',
        'unregister',
        'dispose',
        'idle',
        ownsAbort ? 'goal-idle' : 'cancel-goal',
      ]);
      expect(h.context.settlesDirectAbort).toBe(false);
      expect(h.lifecycle.getSession(session.id)).toBeUndefined();
      expect(session.statuses.size).toBe(0);
      staleStatus('closed');
      expect(h.deps.cleanupClosedSession).toHaveBeenCalledOnce();
    },
  );

  it.each(['broadcast', 'cleanup', 'disposer', 'interaction'] as const)(
    'still unregisters and clears busy when %s fails',
    (failure) => {
      const h = harness<TestSession>();
      const session = new TestSession();
      const fail = () => {
        throw new Error(failure);
      };
      const afterFailedDisposer = vi.fn();
      const registration = h.bind(session, failure === 'disposer' ? fail : vi.fn())!;
      registration.disposers.push(afterFailedDisposer);
      if (failure === 'broadcast') h.deps.broadcastStatus.mockImplementation(fail);
      if (failure === 'cleanup') h.actions.cleanupInteractions.mockImplementation(fail);
      if (failure === 'interaction') session.setInteractionListener.mockImplementation(fail);
      expect(() => session.emitStatus('closed')).not.toThrow();
      expect(h.lifecycle.getSession(session.id)).toBeUndefined();
      expect(afterFailedDisposer).toHaveBeenCalledOnce();
      expect(h.finalActions.clearTurnState).toHaveBeenCalledOnce();
      expect(h.finalActions.cancelGoalResume).toHaveBeenCalledOnce();
      expect(h.deps.log.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ error: failure }),
      );
      // Preserve the existing product-cleanup failure boundary; it is not a
      // per-action retry engine. Only the mandatory teardown is guaranteed.
      if (failure === 'cleanup') expect(h.actions.cleanupRuntimeState).not.toHaveBeenCalled();
    },
  );

  it('does not publish a replacement when an old disposer fails', () => {
    const h = harness<TestSession>();
    const old = new TestSession();
    h.bind(old, () => {
      throw new Error('detach failed');
    });
    expect(() => h.bind(new TestSession())).toThrow('detach failed');
    expect(h.lifecycle.getSession(old.id)).toBe(old);
    expect(h.deps.onBind).toHaveBeenCalledOnce();
  });

  it('allows an already accepted old event write to finish after replacement', async () => {
    const h = harness<TestSession>();
    const old = new TestSession();
    const next = new TestSession();
    const write = deferred();
    const persisted: string[] = [];
    const pending: Promise<void>[] = [];
    const registration = h.bind(old)!;
    registration.disposers.push(
      old.onEvent((value) => {
        pending.push(
          write.promise.then(() => {
            persisted.push(value);
          }),
        );
      }),
    );
    old.emitEvent('old-assistant-row');
    h.bind(next);
    old.emitEvent('must-not-start-another-write');
    write.resolve();
    await Promise.all(pending);
    expect(persisted).toEqual(['old-assistant-row']);
    expect(h.lifecycle.getSession(next.id)).toBe(next);
  });
});

describe('close/rebuild input policy', () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    'keeps input preservation (%s) independent from retry preservation (%s)',
    async (preserveInput, preserveRetry) => {
      const h = harness<TestSession>();
      const session = new TestSession();
      const coordinator = new AgentInputCoordinator({
        sendToAgent: vi.fn(),
        steerToAgent: vi.fn(),
        abortSession: vi.fn(),
        isTurnRunning: () => false,
        hasPendingInteraction: () => false,
        getAgentKind: () => 'codex',
        getSdkSessionId: async () => undefined,
        emitProjection: vi.fn(),
      });
      const input = coordinator.getInputAbortSignal(session.id);
      const preparation = deferred();
      const nextDispatch = preparation.promise.then(() => !input.aborted);
      h.actions.shouldPreserveInputBoundary.mockReturnValue(preserveInput);
      h.context.preserveAutoResumeIntent = preserveRetry;
      h.actions.closeInputCoordinator.mockImplementation((options) =>
        coordinator.onSessionClosed(session.id, options),
      );
      h.bind(session);
      session.emitStatus('closed');
      const replacement = new TestSession();
      h.bind(replacement);
      preparation.resolve();
      expect(await nextDispatch).toBe(preserveInput);
      expect(h.actions.closeInputCoordinator).toHaveBeenCalledWith({
        preserveInputBoundary: preserveInput,
        preserveAutoResumeIntent: preserveRetry,
      });
      expect(h.actions.resetAutoResume).toHaveBeenCalledTimes(preserveRetry ? 0 : 1);
      expect(h.actions.preserveAutoResume).toHaveBeenCalledTimes(preserveRetry ? 1 : 0);
      expect(h.actions.cleanupRuntimeState).toHaveBeenCalledOnce();
      expect(h.lifecycle.getSession(session.id)).toBe(replacement);
    },
  );
});

describe('binding with the real maker-core Session', () => {
  function realSession() {
    const closeStarted = deferred();
    const closeFinished = deferred();
    const eventReady = deferred();
    const logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: () => logger,
    };
    const handle = {
      id: 'provider-thread',
      agentKind: 'codex',
      model: 'test-model',
      send: vi.fn(async () => {}),
      setInteractionResolver: vi.fn(),
      close: vi.fn(async () => {
        closeStarted.resolve();
        await closeFinished.promise;
      }),
      async *events() {
        await eventReady.promise;
        yield { type: 'text', data: 'late provider output', source: 'codex' } as AgentEvent;
        await closeFinished.promise;
      },
    } as unknown as AgentSessionHandle;
    const session = new Session({
      id: 'task',
      agentKind: 'codex',
      workDir: process.cwd(),
      handle,
      capabilities: {} as never,
      logger,
      turnStallMs: 0,
    });
    return { session, handle, closeStarted, closeFinished, eventReady };
  }

  it.each([true, false])(
    'dispatches queued input across a real close/rebuild only when suppressed (%s)',
    async (preserve) => {
      const h = harness<Session>();
      const old = realSession(),
        next = realSession();
      const preparation = deferred(),
        entered = deferred(),
        dispatched = deferred();
      const suppression = createRehydrateCloseSuppression({ debug: vi.fn(), warn: vi.fn() });
      let signal: AbortSignal | undefined;
      const sendToAgent = vi.fn<AgentInputCoordinatorDeps['sendToAgent']>(
        async (_sid, message, _opts, sendOpts) => {
          signal = sendOpts.signal;
          entered.resolve();
          await preparation.promise;
          const text = typeof message === 'string' ? message : message.content;
          if (typeof text !== 'string') throw new Error('This fixture sends text only');
          const result = await h.lifecycle
            .getSession('task')!
            .send(text, { signal: sendOpts.signal });
          dispatched.resolve();
          if (result.accepted === false)
            return {
              kind: 'session-dispatch',
              source: 'lifecycle-test',
              dispatched: false,
              reason: 'cancelled-before-dispatch',
              message: 'cancelled',
              context: 'lifecycle-test',
            };
          return {
            kind: 'session-dispatch' as const,
            source: 'lifecycle-test',
            dispatched: true,
          };
        },
      );
      const coordinator = new AgentInputCoordinator({
        sendToAgent,
        steerToAgent: vi.fn(),
        abortSession: vi.fn(),
        isTurnRunning: () => false,
        hasPendingInteraction: () => false,
        getAgentKind: () => 'codex',
        getSdkSessionId: async () => undefined,
        emitProjection: vi.fn(),
      });
      h.actions.shouldPreserveInputBoundary.mockImplementation(() =>
        suppression.isSuppressed('task'),
      );
      h.actions.closeInputCoordinator.mockImplementation((options) =>
        coordinator.onSessionClosed('task', options),
      );
      h.bind(old.session);
      const item = (id: string): AgentInputQueuedMessage => ({
        clientId: id,
        text: id,
        persistedContent: id,
        model: 'test-model',
        effort: 'medium',
        permissionMode: 'default',
        workingDir: '/unused',
        chatMessage: {
          clientId: id,
          role: 'user',
          content: id,
          isStreaming: false,
          createdAt: '2026-09-05T00:00:00.000Z',
        },
        createOpts: {
          agentKind: 'codex',
          workingDir: '/unused',
          model: 'test-model',
          effort: 'medium',
          permissionMode: 'default',
          userPrompt: '',
          makerMemoryEnabled: false,
          displayReasoning: 'summarized',
        },
      });
      const queued = coordinator.enqueue('task', item('first'));
      await entered.promise;
      old.closeFinished.resolve();
      const rebuild = async () => {
        await old.session.close();
        h.bind(next.session);
      };
      if (preserve) await suppression.withSuppressed('task', rebuild);
      else await rebuild();
      expect(signal?.aborted).toBe(!preserve);
      preparation.resolve();
      await dispatched.promise;
      await queued;
      expect(old.handle.send).not.toHaveBeenCalled();
      expect(next.handle.send).toHaveBeenCalledTimes(preserve ? 1 : 0);
      // Close cleared the old active input: a later user input remains dispatchable.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await coordinator.enqueue('task', item('second'));
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(next.handle.send).toHaveBeenCalledTimes(preserve ? 2 : 1);
      expect(suppression.isSuppressed('task')).toBe(false);
      next.closeFinished.resolve();
      await next.session.close();
      suppression.resetForTest();
    },
  );

  it('rejects send during provider close and ignores late output while closing exactly once', async () => {
    const h = harness<Session>();
    const r = realSession();
    const seen = vi.fn();
    const registration = h.bind(r.session)!;
    registration.disposers.push(r.session.onEvent(seen));
    const closing = r.session.close();
    await r.closeStarted.promise;
    await expect(r.session.send('new input')).rejects.toThrow('closing');
    expect(r.handle.send).not.toHaveBeenCalled();
    r.eventReady.resolve();
    await Promise.resolve();
    expect(h.lifecycle.getSession(r.session.id)).toBe(r.session);
    const repeatedClose = r.session.close();
    r.closeFinished.resolve();
    await Promise.all([closing, repeatedClose]);
    expect(seen).not.toHaveBeenCalled();
    expect(r.handle.close).toHaveBeenCalledOnce();
    expect(h.lifecycle.getSession(r.session.id)).toBeUndefined();
    expect(h.finalActions.clearTurnState).toHaveBeenCalledOnce();
  });

  it('retains the binding on provider close failure and tears down after a successful retry', async () => {
    const h = harness<Session>();
    const r = realSession();
    vi.mocked(r.handle.close).mockRejectedValueOnce(new Error('transport still alive'));
    h.bind(r.session);
    await expect(r.session.close()).rejects.toThrow('transport still alive');
    expect(r.session.getStatus()).toBe('error');
    expect(h.lifecycle.getSession(r.session.id)).toBe(r.session);
    expect(h.deps.cleanupClosedSession).not.toHaveBeenCalled();
    const closing = r.session.close();
    r.closeFinished.resolve();
    await closing;
    expect(r.session.getStatus()).toBe('closed');
    expect(h.deps.cleanupClosedSession).toHaveBeenCalledOnce();
    expect(h.lifecycle.getSession(r.session.id)).toBeUndefined();
  });
});
