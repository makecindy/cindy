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

  it('isSuppressed reflects the suppression window (register closed-cleanup guard contract)', async () => {
    const suppression = createRehydrateCloseSuppression(makeLog());
    const sideEffect = vi.fn(async () => undefined);

    // 窗口外:未抑制 → register 的 onSessionClosed 会照常执行。
    expect(suppression.isSuppressed('session-1')).toBe(false);
    await suppression.runOnCloseSideEffects('session-1', sideEffect);
    expect(sideEffect).toHaveBeenCalledTimes(1);

    // 窗口内:抑制 → register 跳过 coordinator.onSessionClosed(#1930 修复点)。
    await suppression.withSuppressed('session-1', async () => {
      expect(suppression.isSuppressed('session-1')).toBe(true);
      await suppression.runOnCloseSideEffects('session-1', sideEffect);
    });

    // 窗口结束:恢复放行。
    expect(suppression.isSuppressed('session-1')).toBe(false);
    await suppression.runOnCloseSideEffects('session-1', sideEffect);
    expect(sideEffect).toHaveBeenCalledTimes(2);
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
