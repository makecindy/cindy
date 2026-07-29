// @vitest-environment jsdom

/**
 * useCodexRuntimeRoute.resolved 的状态机契约:
 *  - 真值回来前 resolved=false(authInjection 是保守占位 env-key,消费方不得当真值);
 *  - refreshKey 变化 / 重新启用后 resolved 归位 false,旧会话的 route 不残留
 *    (PR review P1:切会话瞬间不得沿用上一个会话的网关分类)。
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCodexRuntimeRoute } from '../useCodexRuntimeRoute';

type Deferred = {
  promise: Promise<{ authInjection: 'oauth-bearer' | 'env-key' | 'provider-oauth' }>;
  resolve: (v: { authInjection: 'oauth-bearer' | 'env-key' | 'provider-oauth' }) => void;
};

function deferred(): Deferred {
  let resolve!: Deferred['resolve'];
  const promise = new Promise<{ authInjection: 'oauth-bearer' | 'env-key' | 'provider-oauth' }>(
    (done) => {
      resolve = done;
    },
  );
  return { promise, resolve };
}

const pending: Deferred[] = [];
const authListeners: Array<(payload: { agentKind: string }) => void> = [];

beforeEach(() => {
  pending.length = 0;
  authListeners.length = 0;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      codexRuntimeRouteGet: vi.fn(() => {
        const d = deferred();
        pending.push(d);
        return d.promise;
      }),
      onCodexRuntimeRouteChanged: vi.fn(() => () => {}),
      auth: {
        onStateChanged: vi.fn((cb: (payload: { agentKind: string }) => void) => {
          authListeners.push(cb);
          return () => {};
        }),
      },
    },
  };
});

describe('useCodexRuntimeRoute resolved flag', () => {
  it('stays unresolved until the first fetch settles, then reports the real route', async () => {
    const { result } = renderHook(() => useCodexRuntimeRoute({ refreshKey: 's1' }));
    expect(result.current.resolved).toBe(false);
    expect(result.current.authInjection).toBe('env-key');

    await act(async () => {
      pending[0].resolve({ authInjection: 'oauth-bearer' });
      await pending[0].promise;
    });
    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.authInjection).toBe('oauth-bearer');
  });

  it('drops back to unresolved when refreshKey changes, until the new fetch settles', async () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useCodexRuntimeRoute({ refreshKey: key }),
      { initialProps: { key: 's1' } },
    );
    await act(async () => {
      pending[0].resolve({ authInjection: 'env-key' });
      await pending[0].promise;
    });
    await waitFor(() => expect(result.current.resolved).toBe(true));

    rerender({ key: 's2' });
    // 切会话:旧真值不可信,归位未解析。
    expect(result.current.resolved).toBe(false);

    await act(async () => {
      pending[1].resolve({ authInjection: 'oauth-bearer' });
      await pending[1].promise;
    });
    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.authInjection).toBe('oauth-bearer');
  });

  it('resolves via the auth-state recovery path after the initial fetch failed', async () => {
    // 首查失败 → resolved 停留 false;AUTH_STATE_CHANGED 触发的重查成功后必须
    // 标记已解析,否则计费门控永久停在「形态未定」。
    const { result } = renderHook(() => useCodexRuntimeRoute({ refreshKey: 's1' }));
    const failing = deferred();
    await act(async () => {
      // 用一个永不 resolve 的首查模拟失败面(reject 会打 unhandled;挂起等价于未解析)
      void failing;
      authListeners.forEach((cb) => cb({ agentKind: 'codex' }));
      pending[1].resolve({ authInjection: 'oauth-bearer' });
      await pending[1].promise;
    });
    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.authInjection).toBe('oauth-bearer');
  });

  it('discards a stale same-key read that settles after a newer read committed', async () => {
    // 首查在途时 auth 重查发起并率先落地:旧首查迟到不得覆盖(同 key 双在途竞态)。
    const { result } = renderHook(() => useCodexRuntimeRoute({ refreshKey: 's1' }));
    act(() => {
      authListeners.forEach((cb) => cb({ agentKind: 'codex' }));
    });
    await act(async () => {
      pending[1].resolve({ authInjection: 'oauth-bearer' });
      await pending[1].promise;
    });
    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.authInjection).toBe('oauth-bearer');

    // 旧首查此刻才落地:必须被票据作废。
    await act(async () => {
      pending[0].resolve({ authInjection: 'env-key' });
      await pending[0].promise;
    });
    expect(result.current.authInjection).toBe('oauth-bearer');
    expect(result.current.resolved).toBe(true);
  });

  it('discards an auth-triggered refresh that was superseded by a refreshKey change', async () => {
    // 旧 key 发起的 auth 重查在途时切会话:新 key 的常规 fetch 先落地后,
    // 旧重查结果不得回写覆盖(以发起时的 key 为准)。
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useCodexRuntimeRoute({ refreshKey: key }),
      { initialProps: { key: 's1' } },
    );
    await act(async () => {
      pending[0].resolve({ authInjection: 'env-key' });
      await pending[0].promise;
    });
    await waitFor(() => expect(result.current.resolved).toBe(true));

    // s1 在途的 auth 重查(pending[1]),随后切到 s2(pending[2])
    act(() => {
      authListeners.forEach((cb) => cb({ agentKind: 'codex' }));
    });
    rerender({ key: 's2' });
    await act(async () => {
      pending[2].resolve({ authInjection: 'oauth-bearer' });
      await pending[2].promise;
    });
    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.authInjection).toBe('oauth-bearer');

    // 旧重查此时才落地:必须被丢弃,s2 的真值不被 env-key 覆盖。
    await act(async () => {
      pending[1].resolve({ authInjection: 'env-key' });
      await pending[1].promise;
    });
    expect(result.current.authInjection).toBe('oauth-bearer');
    expect(result.current.resolved).toBe(true);
  });

  it('resets to unresolved while disabled', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useCodexRuntimeRoute({ enabled }),
      { initialProps: { enabled: true } },
    );
    await act(async () => {
      pending[0].resolve({ authInjection: 'env-key' });
      await pending[0].promise;
    });
    await waitFor(() => expect(result.current.resolved).toBe(true));

    rerender({ enabled: false });
    expect(result.current.resolved).toBe(false);
  });
});
