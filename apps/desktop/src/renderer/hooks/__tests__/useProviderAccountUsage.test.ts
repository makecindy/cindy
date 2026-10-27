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
