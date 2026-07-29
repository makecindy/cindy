// @vitest-environment jsdom

/**
 * useClaudeSessionRoute 的会话绑定契约:观察值与产生它的 sessionId 绑定并在
 * 渲染期比对——组件保持挂载、仅切换 sessionId 的同一帧即返回 null,不泄漏
 * 上一个会话的路由(PR review P1)。
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useClaudeSessionRoute } from '../useClaudeSessionRoute';

type Route = 'gateway' | 'subscription';
type Deferred = { promise: Promise<Route | null>; resolve: (v: Route | null) => void };

function deferred(): Deferred {
  let resolve!: Deferred['resolve'];
  const promise = new Promise<Route | null>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const pending: Deferred[] = [];

beforeEach(() => {
  pending.length = 0;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      claudeSessionRouteGet: vi.fn(() => {
        const d = deferred();
        pending.push(d);
        return d.promise;
      }),
      onClaudeSessionRouteChanged: vi.fn(() => () => {}),
    },
  };
});

describe('useClaudeSessionRoute session binding', () => {
  it('returns the observed route only for the session that produced it', async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useClaudeSessionRoute(id, true),
      { initialProps: { id: 's1' } },
    );
    expect(result.current).toBeNull();
    await act(async () => {
      pending[0].resolve('gateway');
      await pending[0].promise;
    });
    await waitFor(() => expect(result.current).toBe('gateway'));

    // 切会话:同一帧即为 null,不得沿用 s1 的 gateway 观察值。
    rerender({ id: 's2' });
    expect(result.current).toBeNull();

    await act(async () => {
      pending[1].resolve('subscription');
      await pending[1].promise;
    });
    await waitFor(() => expect(result.current).toBe('subscription'));
  });

  it('returns null while disabled even with a stored observation', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useClaudeSessionRoute('s1', enabled),
      { initialProps: { enabled: true } },
    );
    await act(async () => {
      pending[0].resolve('gateway');
      await pending[0].promise;
    });
    await waitFor(() => expect(result.current).toBe('gateway'));

    rerender({ enabled: false });
    expect(result.current).toBeNull();
  });
});
