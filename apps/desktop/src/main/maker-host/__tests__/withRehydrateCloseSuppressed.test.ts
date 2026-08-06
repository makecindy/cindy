import { describe, it, expect, vi, afterEach } from 'vitest';

import { createRehydrateCloseSuppression } from '../rehydrateCloseSuppression';

function makeLog() {
  return {
    debug: vi.fn(),
    warn: vi.fn(),
  };
}

describe('withRehydrateCloseSuppressed', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips onClose side-effects while suppressed', async () => {
    const log = makeLog();
    const suppression = createRehydrateCloseSuppression(log);
    const sideEffect = vi.fn(async () => undefined);

    await suppression.withSuppressed('session-1', async () => {
      await suppression.runOnCloseSideEffects('session-1', sideEffect);
    });

    expect(sideEffect).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      'skip onClose side-effects during rehydrate',
      { sessionId: 'session-1' },
    );
  });

  it('runs onClose side-effects again after helper finishes', async () => {
    const suppression = createRehydrateCloseSuppression(makeLog());
    const sideEffect = vi.fn(async () => undefined);

    await suppression.withSuppressed('session-1', async () => undefined);
    await suppression.runOnCloseSideEffects('session-1', sideEffect);

    expect(sideEffect).toHaveBeenCalledTimes(1);
  });

  it('preserves the active input while replacing a session runtime', async () => {
    const log = makeLog();
    const suppression = createRehydrateCloseSuppression(log);
    const onSessionClosed = vi.fn();

    await suppression.withInputPreservingRuntimeReplacementClose('session-1', async () => {
      suppression.runInputCoordinatorSessionClosed('session-1', onSessionClosed);
    });

    expect(onSessionClosed).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      'skip input coordinator close during runtime replacement',
      { sessionId: 'session-1' },
    );

    suppression.runInputCoordinatorSessionClosed('session-1', onSessionClosed);
    expect(onSessionClosed).toHaveBeenCalledTimes(1);
  });

  it('does not preserve input for the broader onClose suppression window', async () => {
    const suppression = createRehydrateCloseSuppression(makeLog());
    const onSessionClosed = vi.fn();

    await suppression.withSuppressed('session-1', async () => {
      suppression.runInputCoordinatorSessionClosed('session-1', onSessionClosed);
    });

    expect(onSessionClosed).toHaveBeenCalledTimes(1);
  });

  it('releases input preservation when runtime replacement throws', async () => {
    const suppression = createRehydrateCloseSuppression(makeLog());
    const onSessionClosed = vi.fn();

    await expect(
      suppression.withInputPreservingRuntimeReplacementClose('session-1', async () => {
        throw new Error('close failed');
      }),
    ).rejects.toThrow('close failed');

    suppression.runInputCoordinatorSessionClosed('session-1', onSessionClosed);
    expect(onSessionClosed).toHaveBeenCalledTimes(1);
  });

  it('keeps input preservation active until the outer nested replacement completes', async () => {
    const suppression = createRehydrateCloseSuppression(makeLog());
    const onSessionClosed = vi.fn();

    await suppression.withInputPreservingRuntimeReplacementClose('session-1', async () => {
      await suppression.withInputPreservingRuntimeReplacementClose('session-1', async () => {
        suppression.runInputCoordinatorSessionClosed('session-1', onSessionClosed);
      });
      suppression.runInputCoordinatorSessionClosed('session-1', onSessionClosed);
    });

    expect(onSessionClosed).not.toHaveBeenCalled();
    suppression.runInputCoordinatorSessionClosed('session-1', onSessionClosed);
    expect(onSessionClosed).toHaveBeenCalledTimes(1);
  });

  it('releases suppression when the wrapped function throws', async () => {
    const suppression = createRehydrateCloseSuppression(makeLog());
    const sideEffect = vi.fn(async () => undefined);

    await expect(suppression.withSuppressed('session-1', async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    await suppression.runOnCloseSideEffects('session-1', sideEffect);

    expect(sideEffect).toHaveBeenCalledTimes(1);
  });

  it('suppressAllForShutdown skips side-effects for every session, irreversibly', async () => {
    const log = makeLog();
    const suppression = createRehydrateCloseSuppression(log);
    const sideEffect = vi.fn(async () => undefined);

    suppression.suppressAllForShutdown();

    // 任意 session,不需要事先 withSuppressed 登记
    await suppression.runOnCloseSideEffects('session-a', sideEffect);
    await suppression.runOnCloseSideEffects('session-b', sideEffect);

    expect(sideEffect).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      'skip onClose side-effects during shutdown',
      { sessionId: 'session-a' },
    );

    // per-session 抑制窗口结束也不解除 shutdown 抑制
    await suppression.withSuppressed('session-a', async () => undefined);
    await suppression.runOnCloseSideEffects('session-a', sideEffect);
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it('resetForTest clears shutdown suppression', async () => {
    const suppression = createRehydrateCloseSuppression(makeLog());
    const sideEffect = vi.fn(async () => undefined);

    suppression.suppressAllForShutdown();
    suppression.resetForTest();
    await suppression.runOnCloseSideEffects('session-a', sideEffect);

    expect(sideEffect).toHaveBeenCalledTimes(1);
  });

  it('releases suppression after timeout', async () => {
    vi.useFakeTimers();
    const log = makeLog();
    const suppression = createRehydrateCloseSuppression(log, 30_000);
    const sideEffect = vi.fn(async () => undefined);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const pending = suppression.withSuppressed('session-1', async () => {
      await gate;
    });
    expect(suppression.isSuppressed('session-1')).toBe(true);

    vi.advanceTimersByTime(30_000);
    expect(suppression.isSuppressed('session-1')).toBe(false);
    await suppression.runOnCloseSideEffects('session-1', sideEffect);

    release();
    await pending;
    expect(sideEffect).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      'rehydrate suppress timeout, releasing',
      { sessionId: 'session-1' },
    );
  });
});
