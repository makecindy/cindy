import { describe, expect, it, vi } from 'vitest';

import {
  closeOrcaWorkerRuntimeWhileLocked,
  fenceOrcaWorkerSessionsForDisable,
  isOrcaWorkerSessionDisableFenced,
  type OrcaDisableWorkerRuntimeDeps,
  withOrcaWorkerSessionLocks,
} from '../orcaDisableWorkerRuntime';

function createSerialLock() {
  const tails = new Map<string, Promise<void>>();
  return async function withSessionLock<T>(
    sessionId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = tails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    tails.set(sessionId, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (tails.get(sessionId) === tail) tails.delete(sessionId);
    }
  };
}

describe('Orca disable Worker runtime locking', () => {
  it('waits for rehydrate and closes the replacement Session', async () => {
    const withSessionLock = createSerialLock();
    const oldSession = { isTurnRunning: vi.fn(() => false), abort: vi.fn() };
    const replacementSession = { isTurnRunning: vi.fn(() => false), abort: vi.fn() };
    let liveSession = oldSession;
    let finishRehydrate!: () => void;
    const rehydrateGate = new Promise<void>((resolve) => {
      finishRehydrate = resolve;
    });
    const rehydrateHasLock = new Promise<void>((resolve) => {
      void withSessionLock('worker-session', async () => {
        resolve();
        await rehydrateGate;
        liveSession = replacementSession;
      });
    });
    await rehydrateHasLock;

    let closedSession: typeof oldSession | undefined;
    const closeSession = vi.fn(async () => {
      closedSession = liveSession;
    });
    const deps: OrcaDisableWorkerRuntimeDeps = {
      getSession: vi.fn(() => liveSession),
      closeSession,
      beforeClose: vi.fn(),
      afterClose: vi.fn(),
      log: { warn: vi.fn() },
    };
    const disable = withOrcaWorkerSessionLocks(
      withSessionLock,
      ['worker-session'],
      () => closeOrcaWorkerRuntimeWhileLocked(deps, 'worker-session'),
    );

    await Promise.resolve();
    expect(deps.getSession).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();

    finishRehydrate();
    await disable;

    expect(deps.getSession).toHaveBeenCalledWith('worker-session');
    expect(replacementSession.isTurnRunning).toHaveBeenCalledTimes(1);
    expect(oldSession.isTurnRunning).not.toHaveBeenCalled();
    expect(closeSession).toHaveBeenCalledWith('worker-session');
    expect(closedSession).toBe(replacementSession);
    expect(deps.beforeClose).toHaveBeenCalledTimes(1);
    expect(deps.afterClose).toHaveBeenCalledTimes(1);
  });

  it('keeps a following send blocked until the team transition is durable', async () => {
    const withSessionLock = createSerialLock();
    let finishTeamTransition!: () => void;
    const teamTransitionGate = new Promise<void>((resolve) => {
      finishTeamTransition = resolve;
    });
    const runtimeClosed = vi.fn();
    const teamArchived = vi.fn();
    const disable = withOrcaWorkerSessionLocks(
      withSessionLock,
      ['worker-session'],
      async () => {
        runtimeClosed();
        await teamTransitionGate;
        teamArchived();
      },
    );
    await Promise.resolve();
    expect(runtimeClosed).toHaveBeenCalledTimes(1);

    const sendStarted = vi.fn();
    const send = withSessionLock('worker-session', async () => {
      sendStarted();
    });
    await Promise.resolve();
    expect(sendStarted).not.toHaveBeenCalled();

    finishTeamTransition();
    await disable;
    await send;
    expect(teamArchived).toHaveBeenCalledTimes(1);
    expect(sendStarted).toHaveBeenCalledTimes(1);
    expect(teamArchived.mock.invocationCallOrder[0]).toBeLessThan(
      sendStarted.mock.invocationCallOrder[0]!,
    );
  });

  it('still closes after abort fails', async () => {
    const abort = vi.fn(async () => {
      throw new Error('abort failed');
    });
    const closeSession = vi.fn(async () => undefined);
    const warn = vi.fn();

    await closeOrcaWorkerRuntimeWhileLocked(
      {
        getSession: () => ({ isTurnRunning: () => true, abort }),
        closeSession,
        beforeClose: vi.fn(),
        afterClose: vi.fn(),
        log: { warn },
      },
      'worker-session',
    );

    expect(closeSession).toHaveBeenCalledWith('worker-session');
    expect(warn).toHaveBeenCalledWith(
      'disableOrca: abort failed (continuing to close)',
      { sessionId: 'worker-session', err: 'abort failed' },
    );
  });

  it('still closes when the running-state probe throws', async () => {
    const closeSession = vi.fn(async () => undefined);
    const afterClose = vi.fn();

    await closeOrcaWorkerRuntimeWhileLocked(
      {
        getSession: () => ({
          isTurnRunning: () => {
            throw new Error('probe failed');
          },
          abort: vi.fn(),
        }),
        closeSession,
        beforeClose: vi.fn(),
        afterClose,
        log: { warn: vi.fn() },
      },
      'worker-probe-failure',
    );

    expect(closeSession).toHaveBeenCalledWith('worker-probe-failure');
    expect(afterClose).toHaveBeenCalledTimes(1);
  });

  it('times out a stuck close, keeps the fence, and completes cleanup', async () => {
    vi.useFakeTimers();
    try {
      const afterClose = vi.fn();
      const warn = vi.fn();
      fenceOrcaWorkerSessionsForDisable(['worker-timeout']);
      const closing = closeOrcaWorkerRuntimeWhileLocked(
        {
          getSession: () => ({ isTurnRunning: () => false, abort: vi.fn() }),
          closeSession: () => new Promise<void>(() => undefined),
          beforeClose: vi.fn(),
          afterClose,
          timeoutMs: 30_000,
          log: { warn },
        },
        'worker-timeout',
      );

      await vi.advanceTimersByTimeAsync(30_000);
      await closing;

      expect(afterClose).toHaveBeenCalledTimes(1);
      expect(isOrcaWorkerSessionDisableFenced('worker-timeout')).toBe(true);
      expect(warn).toHaveBeenCalledWith(
        'disableOrca: closeSession timed out; runtime remains fenced',
        { sessionId: 'worker-timeout', timeoutMs: 30_000 },
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
