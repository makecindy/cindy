// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionUsageLimitFallback } from '../hooks/useSessionUsageLimitFallback';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const maker = {
  sessionUsageLimitFallbackGet: vi.fn(),
  sessionUsageLimitFallbackSet: vi.fn(),
  sessionUsageLimitFallbackClear: vi.fn(),
};

beforeEach(() => {
  maker.sessionUsageLimitFallbackGet.mockReset();
  maker.sessionUsageLimitFallbackSet.mockReset();
  maker.sessionUsageLimitFallbackClear.mockReset();
  maker.sessionUsageLimitFallbackGet.mockImplementation(async () => ({
    target: null,
    stale: false,
  }));
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { maker },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

const savedTarget = { providerId: 'xd', model: 'deepseek-v4-flash' };

describe('useSessionUsageLimitFallback', () => {
  it('exposes the error code so the UI can speak the user\'s language', async () => {
    maker.sessionUsageLimitFallbackSet.mockReturnValueOnce(
      Promise.resolve({
        ok: false as const,
        errorCode: 'ROUTE_UNAVAILABLE' as const,
        message: 'provider "xd" is not connected',
      }),
    );

    const { result } = renderHook(() => useSessionUsageLimitFallback('task-a'));
    await waitFor(() => expect(maker.sessionUsageLimitFallbackGet).toHaveBeenCalledWith('task-a'));

    await act(async () => {
      expect(await result.current.setTarget(savedTarget)).toBe(false);
    });

    // 码给界面拿去翻译；原文只当诊断信息保留。
    expect(result.current.errorCode).toBe('ROUTE_UNAVAILABLE');
    expect(result.current.error).toBe('provider "xd" is not connected');

    // 下一次写入成功时��码与错误都要清掉，不能把旧错误留在界面上。
    maker.sessionUsageLimitFallbackSet.mockReturnValueOnce(
      Promise.resolve({ ok: true as const, target: savedTarget }),
    );
    await act(async () => {
      expect(await result.current.setTarget(savedTarget)).toBe(true);
    });
    expect(result.current.errorCode).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('does not send IPC before a task exists', async () => {
    const { result } = renderHook(() => useSessionUsageLimitFallback(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(maker.sessionUsageLimitFallbackGet).not.toHaveBeenCalled();
    expect(await result.current.setTarget(savedTarget)).toBe(false);
    expect(maker.sessionUsageLimitFallbackSet).not.toHaveBeenCalled();
  });

  it('refuses to apply a write that resolved after the task was switched', async () => {
    const pendingWrite = deferred<{ ok: true; target: typeof savedTarget }>();
    maker.sessionUsageLimitFallbackSet.mockReturnValueOnce(pendingWrite.promise);

    const { result, rerender } = renderHook(
      ({ sessionId }) => useSessionUsageLimitFallback(sessionId),
      { initialProps: { sessionId: 'task-a' } },
    );
    await waitFor(() => expect(maker.sessionUsageLimitFallbackGet).toHaveBeenCalledWith('task-a'));

    let writeResult: Promise<boolean> | undefined;
    act(() => {
      writeResult = result.current.setTarget(savedTarget);
    });

    // 用户在写入途中换了任务：B 自己的读取还挂着，此时 A 的结果不能落到 B 上。
    rerender({ sessionId: 'task-b' });
    await act(async () => {
      pendingWrite.resolve({ ok: true, target: savedTarget });
      await writeResult;
    });

    expect(result.current.target).toBeNull();
  });

  it('keeps a failed write from leaking its error and loading state into the next task', async () => {
    const pendingWrite = deferred<never>();
    const pendingReadB = deferred<{ target: null; stale: boolean }>();
    maker.sessionUsageLimitFallbackSet.mockReturnValueOnce(pendingWrite.promise);
    maker.sessionUsageLimitFallbackGet.mockImplementation((sessionId: string) =>
      sessionId === 'task-b'
        ? pendingReadB.promise
        : Promise.resolve({ target: null, stale: false }),
    );

    const { result, rerender } = renderHook(
      ({ sessionId }) => useSessionUsageLimitFallback(sessionId),
      { initialProps: { sessionId: 'task-a' } },
    );
    await waitFor(() => expect(maker.sessionUsageLimitFallbackGet).toHaveBeenCalledWith('task-a'));

    let writeResult: Promise<boolean> | undefined;
    act(() => {
      writeResult = result.current.setTarget(savedTarget);
    });

    // 换到 B：B 自己的读取还挂着，所以 B 此刻处于 loading。
    rerender({ sessionId: 'task-b' });
    await waitFor(() => expect(result.current.loading).toBe(true));

    await act(async () => {
      pendingWrite.reject(new Error('task a write failed'));
      await writeResult;
    });

    // A 的错误与收尾都不能写进 B：B 不报 A 的错，也不能被 A 提前关掉 loading。
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);

    await act(async () => {
      pendingReadB.resolve({ target: null, stale: false });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
  });
});
