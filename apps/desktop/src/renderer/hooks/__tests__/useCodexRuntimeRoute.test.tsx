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

beforeEach(() => {
  pending.length = 0;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      codexRuntimeRouteGet: vi.fn(() => {
        const d = deferred();
        pending.push(d);
        return d.promise;
      }),
      onCodexRuntimeRouteChanged: vi.fn(() => () => {}),
      auth: { onStateChanged: vi.fn(() => () => {}) },
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
