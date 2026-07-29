// @vitest-environment jsdom

/**
 * useClaudeSessionRoute 的会话绑定契约:观察状态与产生它的 sessionId 绑定并在
 * 渲染期比对——组件保持挂载、仅切换 sessionId 的同一帧即返回空状态,不泄漏
 * 上一个会话的路由(PR review P1)。lastFailedRequestBridge(失败归因,响应侧
 * 落账)与 route 同一状态载体,同样受绑定约束。
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useClaudeSessionRoute } from '../useClaudeSessionRoute';

type RouteState = { route: 'gateway' | 'subscription' | null; lastFailedRequestBridge: boolean };
type Deferred = { promise: Promise<RouteState | null>; resolve: (v: RouteState | null) => void };

function deferred(): Deferred {
  let resolve!: Deferred['resolve'];
  const promise = new Promise<RouteState | null>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const pending: Deferred[] = [];
let pushListener: ((payload: RouteState & { sessionId: string }) => void) | null = null;

beforeEach(() => {
  pending.length = 0;
  pushListener = null;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      claudeSessionRouteGet: vi.fn(() => {
        const d = deferred();
        pending.push(d);
        return d.promise;
      }),
      onClaudeSessionRouteChanged: vi.fn(
        (cb: (payload: RouteState & { sessionId: string }) => void) => {
          pushListener = cb;
          return () => {
            pushListener = null;
          };
        },
      ),
    },
  };
});

describe('useClaudeSessionRoute session binding', () => {
  it('returns the observed state only for the session that produced it', async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useClaudeSessionRoute(id, true),
      { initialProps: { id: 's1' } },
    );
    expect(result.current).toEqual({ route: null, lastFailedRequestBridge: false });
    await act(async () => {
      pending[0].resolve({ route: 'gateway', lastFailedRequestBridge: false });
      await pending[0].promise;
    });
    await waitFor(() => expect(result.current.route).toBe('gateway'));

    // 切会话:同一帧即为空状态,不得沿用 s1 的 gateway 观察值。
    rerender({ id: 's2' });
    expect(result.current).toEqual({ route: null, lastFailedRequestBridge: false });

    await act(async () => {
      pending[1].resolve({ route: 'subscription', lastFailedRequestBridge: false });
      await pending[1].promise;
    });
    await waitFor(() => expect(result.current.route).toBe('subscription'));
  });

  it('returns the empty state while disabled even with a stored observation', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useClaudeSessionRoute('s1', enabled),
      { initialProps: { enabled: true } },
    );
    await act(async () => {
      pending[0].resolve({ route: 'gateway', lastFailedRequestBridge: false });
      await pending[0].promise;
    });
    await waitFor(() => expect(result.current.route).toBe('gateway'));

    rerender({ enabled: false });
    expect(result.current).toEqual({ route: null, lastFailedRequestBridge: false });
  });

  it('carries lastFailedRequestBridge through pushes without dropping the observed route', async () => {
    // bridge 子代理失败置归因、主路由不变;下一笔非 bridge 失败覆写归因。
    const { result } = renderHook(() => useClaudeSessionRoute('s1', true));
    await act(async () => {
      pending[0].resolve({ route: 'gateway', lastFailedRequestBridge: false });
      await pending[0].promise;
    });
    await waitFor(() => expect(result.current.route).toBe('gateway'));

    act(() => {
      pushListener?.({ sessionId: 's1', route: 'gateway', lastFailedRequestBridge: true });
    });
    expect(result.current).toEqual({ route: 'gateway', lastFailedRequestBridge: true });

    act(() => {
      pushListener?.({ sessionId: 's1', route: 'gateway', lastFailedRequestBridge: false });
    });
    expect(result.current).toEqual({ route: 'gateway', lastFailedRequestBridge: false });
  });
});
