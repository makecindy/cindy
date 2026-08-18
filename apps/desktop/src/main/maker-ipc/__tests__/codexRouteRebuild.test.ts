import { describe, expect, it, vi } from 'vitest';

import {
  CodexRouteRebuildService,
  type CodexRouteRebuildSession,
} from '../codexRouteRebuild.js';
import { CodexThreadRotationSupersededError } from '../codexThreadRotation.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const runWithoutSessionLock = <T>(_sessionId: string, task: () => Promise<T>): Promise<T> => task();

function createSessionLock() {
  let tail = Promise.resolve();
  return async <T>(_sessionId: string, task: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

function createHarness(initialSessions: CodexRouteRebuildSession[]) {
  const sessions = [...initialSessions];
  let currentRequiresCodeModeOnly = false;
  let reconciliationBlocked = false;
  const closeSession = vi.fn(async (sessionId: string) => {
    const index = sessions.findIndex((session) => session.id === sessionId);
    if (index >= 0) sessions.splice(index, 1);
  });
  const abortSession = vi.fn(async () => {});
  const onApplied = vi.fn();
  const service = new CodexRouteRebuildService({
    maker: {
      listActiveSessions: () => sessions,
      closeSession,
    },
    abortSession,
    withSessionLock: runWithoutSessionLock,
    isReconciliationBlocked: () => reconciliationBlocked,
    resolveRequiresCodeModeOnly: async () => currentRequiresCodeModeOnly,
    onApplied,
    retryDelayMs: 60_000,
  });
  return {
    service,
    sessions,
    closeSession,
    abortSession,
    onApplied,
    setCurrentRequiresCodeModeOnly(value: boolean) {
      currentRequiresCodeModeOnly = value;
    },
    setReconciliationBlocked(value: boolean) {
      reconciliationBlocked = value;
    },
  };
}

function localCodex(
  id: string,
  frozen: boolean,
  isTurnRunning: () => boolean = () => false,
): CodexRouteRebuildSession {
  return {
    id,
    instanceId: `${id}-instance`,
    agentKind: 'codex',
    remoteHostId: null,
    model: 'codex/gpt-5.5',
    sdkSessionId: `thread-${id}`,
    workDir: '/work',
    providerId: 'xd',
    codexRouteRequiresCodeModeOnly: frozen,
    isTurnRunning,
  };
}

describe('CodexRouteRebuildService', () => {
  it('keeps an idle session when the live catalog capability is unchanged', async () => {
    const h = createHarness([localCodex('same', false)]);

    await h.service.reconcile(1);

    expect(h.closeSession).not.toHaveBeenCalled();
    expect(h.service.has('same')).toBe(false);
  });

  it.each([
    { frozen: false, current: true },
    { frozen: true, current: false },
  ])('closes an idle local Codex session across $frozen -> $current', async ({ frozen, current }) => {
    const h = createHarness([localCodex('idle', frozen)]);
    h.setCurrentRequiresCodeModeOnly(current);

    await h.service.reconcile(2);

    expect(h.closeSession).toHaveBeenCalledWith('idle');
    expect(h.service.has('idle')).toBe(false);
    expect(h.onApplied).toHaveBeenCalledWith('idle');
  });

  it('rotates the native thread before an idle catalog rebuild', async () => {
    const sessions = [localCodex('rotate', false)];
    const closeSession = vi.fn(async () => {
      sessions.splice(0, 1);
    });
    const prepareCodexThreadRotation = vi.fn(async () => ({
      newSdkSessionId: 'thread-rotate-new',
      rollback: vi.fn(async () => undefined),
    }));
    const service = new CodexRouteRebuildService({
      maker: { listActiveSessions: () => sessions, closeSession },
      abortSession: vi.fn(async () => undefined),
      withSessionLock: runWithoutSessionLock,
      resolveRequiresCodeModeOnly: async () => true,
      prepareCodexThreadRotation,
      retryDelayMs: 60_000,
    });

    await service.reconcile(2);

    expect(prepareCodexThreadRotation).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'rotate',
      sourceSdkSessionId: 'thread-rotate',
      sourceProviderId: 'xd',
    }));
    expect(prepareCodexThreadRotation.mock.invocationCallOrder[0]).toBeLessThan(
      closeSession.mock.invocationCallOrder[0],
    );
  });

  it('holds the session route lock until thread rotation and close finish', async () => {
    const sessions = [localCodex('locked-rotation', false)];
    const rotationBarrier = deferred<void>();
    const events: string[] = [];
    const withSessionLock = createSessionLock();
    const closeSession = vi.fn(async () => {
      events.push('close');
      sessions.splice(0, 1);
    });
    const prepareCodexThreadRotation = vi.fn(async () => {
      events.push('rotation-start');
      await rotationBarrier.promise;
      events.push('rotation-finish');
      return {
        newSdkSessionId: 'thread-locked-rotation-new',
        rollback: vi.fn(async () => undefined),
      };
    });
    const service = new CodexRouteRebuildService({
      maker: { listActiveSessions: () => sessions, closeSession },
      abortSession: vi.fn(async () => undefined),
      withSessionLock,
      resolveRequiresCodeModeOnly: async () => true,
      prepareCodexThreadRotation,
      retryDelayMs: 60_000,
    });

    const reconcile = service.reconcile(2);
    await vi.waitFor(() => expect(prepareCodexThreadRotation).toHaveBeenCalledTimes(1));
    const directSend = withSessionLock('locked-rotation', async () => {
      events.push('direct-send');
    });

    await Promise.resolve();
    expect(events).toEqual(['rotation-start']);

    rotationBarrier.resolve();
    await reconcile;
    await directSend;

    expect(events).toEqual(['rotation-start', 'rotation-finish', 'close', 'direct-send']);
  });

  it('retires a stale catalog rebuild when a newer lifecycle owns the thread binding', async () => {
    const sessions = [localCodex('rotation-superseded', false)];
    const prepareCodexThreadRotation = vi.fn(async () => {
      throw new CodexThreadRotationSupersededError('rotation-superseded');
    });
    const onApplied = vi.fn();
    const service = new CodexRouteRebuildService({
      maker: {
        listActiveSessions: () => sessions,
        closeSession: vi.fn(async () => undefined),
      },
      abortSession: vi.fn(async () => undefined),
      withSessionLock: runWithoutSessionLock,
      resolveRequiresCodeModeOnly: async () => true,
      prepareCodexThreadRotation,
      onApplied,
      retryDelayMs: 60_000,
    });

    await service.reconcile(2);

    expect(prepareCodexThreadRotation).toHaveBeenCalledTimes(1);
    expect(service.has('rotation-superseded')).toBe(false);
    expect(onApplied).toHaveBeenCalledWith('rotation-superseded');
  });

  it('interrupts a busy turn once, then closes after the terminal boundary', async () => {
    let running = true;
    const h = createHarness([localCodex('busy', false, () => running)]);
    h.setCurrentRequiresCodeModeOnly(true);

    await h.service.reconcile(3);
    expect(h.service.has('busy')).toBe(true);
    expect(h.abortSession).toHaveBeenCalledWith('busy');
    expect(h.closeSession).not.toHaveBeenCalled();

    await h.service.reconcile(4);
    expect(h.abortSession).toHaveBeenCalledTimes(1);

    running = false;
    await h.service.onTurnSettled('busy');

    expect(h.closeSession).toHaveBeenCalledWith('busy');
    expect(h.service.has('busy')).toBe(false);
    expect(h.onApplied).toHaveBeenCalledWith('busy');
  });

  it('interrupts a confirmed busy route change before slower comparisons settle', async () => {
    let running = true;
    const sessions = [
      localCodex('busy-fast', false, () => running),
      localCodex('slow-lookup', false),
    ];
    const slowLookup = deferred<boolean>();
    const abortSession = vi.fn(async () => {});
    const closeSession = vi.fn(async () => {});
    const service = new CodexRouteRebuildService({
      maker: {
        listActiveSessions: () => sessions,
        closeSession,
      },
      abortSession,
      withSessionLock: runWithoutSessionLock,
      resolveRequiresCodeModeOnly: (session) =>
        session.id === 'slow-lookup' ? slowLookup.promise : Promise.resolve(true),
      retryDelayMs: 60_000,
    });

    const reconcile = service.reconcile(4);
    await vi.waitFor(() => expect(service.has('slow-lookup')).toBe(true));

    expect(service.has('busy-fast')).toBe(true);
    await vi.waitFor(() => expect(abortSession).toHaveBeenCalledWith('busy-fast'));

    slowLookup.resolve(false);
    await reconcile;

    expect(abortSession).toHaveBeenCalledTimes(1);
    running = false;
    await service.onTurnSettled('busy-fast');
  });

  it('does not rotate when an unrelated close races an unchanged catalog comparison', async () => {
    const sessions = [localCodex('close-before-compare', false)];
    const lookup = deferred<boolean>();
    const prepareCodexThreadRotation = vi.fn(async () => ({
      newSdkSessionId: 'thread-close-before-compare-new',
      rollback: vi.fn(async () => undefined),
    }));
    const onApplied = vi.fn();
    const service = new CodexRouteRebuildService({
      maker: {
        listActiveSessions: () => sessions,
        closeSession: vi.fn(async () => undefined),
      },
      abortSession: vi.fn(async () => undefined),
      withSessionLock: runWithoutSessionLock,
      resolveRequiresCodeModeOnly: () => lookup.promise,
      prepareCodexThreadRotation,
      onApplied,
      retryDelayMs: 60_000,
    });

    const reconcile = service.reconcile(4);
    await vi.waitFor(() => expect(service.has('close-before-compare')).toBe(true));
    sessions.splice(0, 1);
    service.onSessionClosed('close-before-compare');

    expect(prepareCodexThreadRotation).not.toHaveBeenCalled();
    lookup.resolve(false);
    await reconcile;

    expect(prepareCodexThreadRotation).not.toHaveBeenCalled();
    expect(service.has('close-before-compare')).toBe(false);
    expect(onApplied).toHaveBeenCalledWith('close-before-compare');
  });

  it('keeps the queue gated if the terminal signal arrives before abort settles', async () => {
    let running = true;
    const sessions = [localCodex('abort-terminal-race', false, () => running)];
    const abortBarrier = deferred<void>();
    const abortSession = vi.fn(async () => abortBarrier.promise);
    const closeSession = vi.fn(async () => {
      sessions.splice(0, 1);
    });
    const onApplied = vi.fn();
    const service = new CodexRouteRebuildService({
      maker: {
        listActiveSessions: () => sessions,
        closeSession,
      },
      abortSession,
      withSessionLock: runWithoutSessionLock,
      resolveRequiresCodeModeOnly: async () => true,
      onApplied,
      retryDelayMs: 60_000,
    });

    const reconcile = service.reconcile(4);
    await vi.waitFor(() => expect(abortSession).toHaveBeenCalledWith('abort-terminal-race'));

    running = false;
    await service.onTurnSettled('abort-terminal-race');
    expect(closeSession).not.toHaveBeenCalled();
    expect(service.has('abort-terminal-race')).toBe(true);

    abortBarrier.resolve();
    await reconcile;

    expect(closeSession).toHaveBeenCalledWith('abort-terminal-race');
    expect(service.has('abort-terminal-race')).toBe(false);
    expect(onApplied).toHaveBeenCalledWith('abort-terminal-race');
  });

  it('keeps a pending rebuild queue-gated while a Provider route mutation is active', async () => {
    let running = true;
    const h = createHarness([localCodex('mutation-pending', false, () => running)]);
    h.setCurrentRequiresCodeModeOnly(true);
    await h.service.reconcile(4);
    expect(h.service.has('mutation-pending')).toBe(true);

    running = false;
    h.setReconciliationBlocked(true);
    await h.service.onTurnSettled('mutation-pending');
    // The interrupted thread is closed immediately so direct send paths cannot
    // reuse it, but the queue remains gated until the route mutation commits.
    expect(h.closeSession).toHaveBeenCalledWith('mutation-pending');
    expect(h.service.has('mutation-pending')).toBe(true);
    expect(h.onApplied).not.toHaveBeenCalled();

    // A close notification/retry while the mutation is still active must not
    // release the queue merely because the old session is already absent.
    await h.service.onTurnSettled('mutation-pending');
    expect(h.service.has('mutation-pending')).toBe(true);
    expect(h.onApplied).not.toHaveBeenCalled();

    h.setReconciliationBlocked(false);
    await h.service.onTurnSettled('mutation-pending');
    expect(h.service.has('mutation-pending')).toBe(false);
    expect(h.onApplied).toHaveBeenCalledWith('mutation-pending');
  });

  it('keeps the session gated when a Provider mutation invalidates an async snapshot', async () => {
    const sessions = [localCodex('mutation-race', false)];
    let blocked = false;
    let finishResolve!: (value: boolean) => void;
    const closeSession = vi.fn(async () => {});
    const service = new CodexRouteRebuildService({
      maker: {
        listActiveSessions: () => sessions,
        closeSession,
      },
      abortSession: vi.fn(async () => {}),
      withSessionLock: runWithoutSessionLock,
      isReconciliationBlocked: () => blocked,
      resolveRequiresCodeModeOnly: () =>
        new Promise<boolean>((resolve) => {
          finishResolve = resolve;
        }),
      retryDelayMs: 60_000,
    });

    const reconcile = service.reconcile(5);
    await vi.waitFor(() => expect(finishResolve).toBeTypeOf('function'));
    blocked = true;
    finishResolve(true);
    await reconcile;

    expect(closeSession).not.toHaveBeenCalled();
    expect(service.has('mutation-race')).toBe(true);
  });

  it('retries abort after a concurrent reconciliation updates the pending revision', async () => {
    let running = true;
    let rejectFirstAbort!: (reason?: unknown) => void;
    const firstAbort = new Promise<void>((_resolve, reject) => {
      rejectFirstAbort = reject;
    });
    const sessions = [localCodex('abort-retry', false, () => running)];
    const closeSession = vi.fn(async () => {
      sessions.splice(0, 1);
    });
    const abortSession = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => firstAbort)
      .mockImplementationOnce(async () => {
        running = false;
      });
    const service = new CodexRouteRebuildService({
      maker: {
        listActiveSessions: () => sessions,
        closeSession,
      },
      abortSession,
      withSessionLock: runWithoutSessionLock,
      resolveRequiresCodeModeOnly: async () => true,
      retryDelayMs: 60_000,
    });

    const firstReconcile = service.reconcile(6);
    await vi.waitFor(() => expect(abortSession).toHaveBeenCalledTimes(1));
    await service.reconcile(7);

    rejectFirstAbort(new Error('abort failed'));
    await firstReconcile;
    expect(service.has('abort-retry')).toBe(true);
    expect(closeSession).not.toHaveBeenCalled();

    await service.onTurnSettled('abort-retry');

    expect(abortSession).toHaveBeenCalledTimes(2);
    expect(closeSession).toHaveBeenCalledWith('abort-retry');
    expect(service.has('abort-retry')).toBe(false);
  });

  it('claims one close when duplicate settle signals finish revalidation together', async () => {
    let running = true;
    const h = createHarness([localCodex('duplicate-settle', false, () => running)]);
    h.setCurrentRequiresCodeModeOnly(true);
    await h.service.reconcile(7);
    running = false;

    await Promise.all([
      h.service.onTurnSettled('duplicate-settle'),
      h.service.onTurnSettled('duplicate-settle'),
    ]);

    expect(h.closeSession).toHaveBeenCalledTimes(1);
  });

  it('does not wake the queue when a Provider mutation overlaps session close', async () => {
    let routeGeneration = 0;
    const sessions = [localCodex('close-mutation-race', false)];
    const closeBarrier = deferred<void>();
    const closeSession = vi.fn(async (sessionId: string) => {
      const index = sessions.findIndex((session) => session.id === sessionId);
      if (index >= 0) sessions.splice(index, 1);
      await closeBarrier.promise;
    });
    const onApplied = vi.fn();
    const service = new CodexRouteRebuildService({
      maker: {
        listActiveSessions: () => sessions,
        closeSession,
      },
      abortSession: vi.fn(async () => {}),
      withSessionLock: runWithoutSessionLock,
      getReconciliationGeneration: () => routeGeneration,
      resolveRequiresCodeModeOnly: async () => true,
      onApplied,
      retryDelayMs: 60_000,
    });

    const firstReconcile = service.reconcile(11);
    await vi.waitFor(() => expect(closeSession).toHaveBeenCalledWith('close-mutation-race'));

    routeGeneration += 1;
    await service.reconcile(12);
    expect(onApplied).not.toHaveBeenCalled();

    closeBarrier.resolve();
    await firstReconcile;
    expect(service.has('close-mutation-race')).toBe(true);
    expect(onApplied).not.toHaveBeenCalled();

    await service.onTurnSettled('close-mutation-race');
    expect(service.has('close-mutation-race')).toBe(false);
    expect(onApplied).toHaveBeenCalledWith('close-mutation-race');
  });

  it('does not release an interrupted session when a later catalog revision restores the frozen value', async () => {
    let running = true;
    const sessions = [localCodex('reverted', false, () => running)];
    let currentRequiresCodeModeOnly = true;
    const abortBarrier = deferred<void>();
    const abortSession = vi.fn(async () => abortBarrier.promise);
    const closeSession = vi.fn(async () => {});
    const onApplied = vi.fn();
    const service = new CodexRouteRebuildService({
      maker: {
        listActiveSessions: () => sessions,
        closeSession,
      },
      abortSession,
      withSessionLock: runWithoutSessionLock,
      resolveRequiresCodeModeOnly: async () => currentRequiresCodeModeOnly,
      onApplied,
      retryDelayMs: 60_000,
    });

    const firstReconcile = service.reconcile(8);
    await vi.waitFor(() => expect(abortSession).toHaveBeenCalledWith('reverted'));
    expect(service.has('reverted')).toBe(true);

    currentRequiresCodeModeOnly = false;
    await service.reconcile(9);
    expect(service.has('reverted')).toBe(true);
    expect(onApplied).not.toHaveBeenCalled();

    running = false;
    abortBarrier.resolve();
    await firstReconcile;

    expect(service.has('reverted')).toBe(false);
    expect(closeSession).toHaveBeenCalledWith('reverted');
    expect(onApplied).toHaveBeenCalledWith('reverted');
  });

  it('ignores remote Codex sessions', async () => {
    const remote = {
      ...localCodex('remote', false),
      remoteHostId: 'ssh-host',
    };
    const h = createHarness([remote]);
    h.setCurrentRequiresCodeModeOnly(true);

    await h.service.reconcile(10);

    expect(h.closeSession).not.toHaveBeenCalled();
    expect(h.service.has('remote')).toBe(false);
  });
});
