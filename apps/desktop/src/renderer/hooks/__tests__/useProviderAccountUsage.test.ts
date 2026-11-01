// @vitest-environment jsdom
// PR #7031: unit/jsdom coverage through the real hook. Existing service tests cannot
// catch renderer results surviving an engine/connection change or a disabled query.
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentKind, ProviderView } from '@cindy/model-providers';
import type { ProviderAccountUsageResult } from '../../../shared/providerAccountUsage';
import { useProviderAccountUsage } from '../useProviderAccountUsage';

const provider = {
  id: 'deepseek',
  auth: { method: 'apiKey' },
  routing: {
    'claude-code': { upstream: 'https://api.deepseek.com/anthropic' },
    pi: { upstream: 'https://api.deepseek.com' },
  },
} as ProviderView;
const ready: ProviderAccountUsageResult = {
  status: 'ready',
  stale: false,
  agent: 'claude-code',
  snapshot: {
    kind: 'deepseek-balance',
    isAvailable: true,
    fetchedAt: 1,
    balances: [
      { currency: 'CNY', totalBalance: '123', grantedBalance: '0', toppedUpBalance: '123' },
    ],
  },
};
const fetchUsage = vi.fn<() => Promise<ProviderAccountUsageResult>>();

beforeEach(() => {
  vi.useFakeTimers();
  fetchUsage.mockReset();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { maker: { fetchProviderAccountUsage: fetchUsage } },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it.each([
  { name: 'engine', nextProvider: provider, nextAgent: 'pi' as AgentKind },
  {
    name: 'connection',
    nextProvider: { ...provider, id: 'deepseek-b' },
    nextAgent: 'claude-code' as AgentKind,
  },
  {
    name: 'route',
    nextProvider: {
      ...provider,
      routing: {
        ...provider.routing,
        'claude-code': {
          ...provider.routing['claude-code']!,
          upstream: 'https://api.deepseek.com/v1',
        },
      },
    },
    nextAgent: 'claude-code' as AgentKind,
  },
])('hides the old account while the new $name is loading', async ({ nextProvider, nextAgent }) => {
  let resolveNext!: (result: ProviderAccountUsageResult) => void;
  fetchUsage.mockResolvedValueOnce(ready).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveNext = resolve;
      }),
  );
  const hook = renderHook(({ source, agent }) => useProviderAccountUsage(source, agent), {
    initialProps: { source: provider, agent: 'claude-code' as AgentKind },
  });
  await act(async () => {});
  expect(hook.result.current.result).toEqual(ready);
  hook.rerender({ source: nextProvider, agent: nextAgent });
  expect(hook.result.current.result).toBeNull();
  await act(async () => resolveNext({ status: 'unavailable', error: 'auth' }));
  expect(hook.result.current.result).toEqual({ status: 'unavailable', error: 'auth' });
});

it('supports the official Zhipu Anthropic upstream with a trailing slash and fetches usage', async () => {
  const zhipuProvider = {
    ...provider,
    id: 'custom-zhipu',
    routing: { 'claude-code': { upstream: 'https://open.bigmodel.cn/api/anthropic/' } },
  } as ProviderView;
  fetchUsage.mockResolvedValueOnce(ready);
  const hook = renderHook(() => useProviderAccountUsage(zhipuProvider, 'claude-code'));
  await act(async () => {});
  expect(hook.result.current.supported).toBe(true);
  expect(fetchUsage).toHaveBeenCalledWith({
    providerId: 'custom-zhipu',
    forceRefresh: false,
    agent: 'claude-code',
  });
});

it('discards a pending result after the query becomes unsupported', async () => {
  let resolvePending!: (result: ProviderAccountUsageResult) => void;
  fetchUsage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolvePending = resolve;
      }),
  );
  const hook = renderHook(({ source }) => useProviderAccountUsage(source, 'pi'), {
    initialProps: { source: provider as ProviderView | undefined },
  });
  hook.rerender({ source: undefined });
  await act(async () => resolvePending(ready));
  expect(hook.result.current.supported).toBe(false);
  expect(hook.result.current.result).toBeNull();
  expect(hook.result.current.busy).toBe(false);
});

const kimiProvider = {
  ...provider, id: 'kimi-test', connected: true,
  auth: { method: 'oauth', oauth: { tokenUrl: 'https://auth.kimi.com/api/oauth/token' } },
  routing: { pi: { upstream: 'https://api.kimi.com/coding/v1' } },
} as ProviderView;
const kimiReady: ProviderAccountUsageResult = {
  status: 'ready', stale: false, snapshot: { kind: 'kimi-coding-quota', fetchedAt: 10, windows: [{ id: 'limit_5h', usedPercent: 20, resetsAt: null }] },
};
// Unit/jsdom: same provider id on two computers must not borrow local quota or trust
// malformed remote values. No live network or credentials are used.
it('reads only the selected remote Kimi account and rejects malformed remote quota', async () => {
  const invoke = vi.fn().mockResolvedValueOnce(kimiReady).mockResolvedValueOnce({ status: 'ready', stale: false, snapshot: { kind: 'kimi-coding-quota', fetchedAt: 10, windows: [{ id: 'limit_5h', usedPercent: 'bad' }] } });
  Object.assign(window.electronAPI, { deviceLink: { invoke } });
  const remoteProvider = { ...kimiProvider, routing: { pi: {} }, kimiCodingUsageAgents: ['pi'] } as unknown as ProviderView;
  const hook = renderHook(({ device }) => useProviderAccountUsage(remoteProvider, 'pi', device), { initialProps: { device: 'mac-a' } });
  await act(async () => {});
  expect(hook.result.current.result).toEqual(kimiReady);
  expect(invoke).toHaveBeenCalledWith('mac-a', 'maker:usage:kimi-coding', [{ providerId: 'kimi-test', agent: 'pi', forceRefresh: false }]);
  expect(fetchUsage).not.toHaveBeenCalled();
  hook.rerender({ device: 'mac-b' });
  expect(hook.result.current.result).toBeNull();
  await act(async () => {});
  expect(hook.result.current.result).toEqual({ status: 'unavailable', error: 'invalid-response' });
  hook.rerender({ device: 'share:guest' });
  expect(hook.result.current.supported).toBe(false);
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('clears Kimi quota when the host broadcasts a credential change on the same connection', async () => {
  let changed!: () => void;
  Object.assign(window.electronAPI.maker, { onProvidersChanged: (callback: () => void) => { changed = callback; return () => {}; } });
  fetchUsage.mockResolvedValueOnce(kimiReady).mockImplementationOnce(() => new Promise(() => {}));
  const hook = renderHook(() => useProviderAccountUsage(kimiProvider, 'pi'));
  await act(async () => {});
  expect(hook.result.current.result).toEqual(kimiReady);
  act(() => changed());
  expect(hook.result.current.result).toBeNull();
  expect(fetchUsage).toHaveBeenCalledTimes(2);
});

// Unit: live pending coalescing must survive StrictMode's observation replay;
// ordinary cancellation tests do not retain the first pending request. Minimal
// input: one pending read during replay, followed by a successful fresh read.
it('settles live Kimi quota after StrictMode replays the observation', async () => {
  let finish!: (result: ProviderAccountUsageResult) => void;
  fetchUsage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue(kimiReady);
  const hook = renderHook(() => useProviderAccountUsage(kimiProvider, 'pi', null, { live: true }), {
    reactStrictMode: true,
  });
  await act(async () => {});
  expect(fetchUsage).toHaveBeenCalledTimes(1);
  await act(async () => finish(kimiReady));
  expect(fetchUsage).toHaveBeenCalledTimes(2);
  expect(hook.result.current.result).toEqual(kimiReady);
});
