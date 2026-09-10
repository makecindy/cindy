// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { useClaudeSubscriptionUsage } from '@/hooks/useClaudeSubscriptionUsage';
import { useXaiSubscriptionUsage } from '@/hooks/useXaiSubscriptionUsage';
import { useXaiRateLimit } from '@/hooks/useXaiRateLimit';
import { useAccountUsage } from '@/hooks/useAccountUsage';

afterEach(() => { cleanup(); setDataOwnerGeneration(null); vi.unstubAllGlobals(); });

const sources = [
  { name: 'Anthropic', hook: useClaudeSubscriptionUsage,
    read: 'getClaudeSubscription', push: 'onClaudeSubscriptionChanged' },
  { name: 'xAI', hook: useXaiSubscriptionUsage,
    read: 'getXaiSubscription', push: 'onXaiSubscriptionChanged' },
];
const previous = { accountId: 'a', fiveHour: { utilization: 20 }, creditUsagePercent: 20 };
const next = { ...previous, fiveHour: { utilization: 30 }, creditUsagePercent: 30 };

for (const source of sources) {
  describe(`${source.name} subscription display cache`, () => {
    function setup(reader = vi.fn().mockResolvedValue(previous)) {
      let push: ((value: unknown) => void) | undefined;
      vi.stubGlobal('electronAPI', { maker: { usage: {
        [source.read]: reader,
        [source.push]: (callback: (value: unknown) => void) => { push = callback; return vi.fn(); },
      } } });
      return { reader, push: (value: unknown) => push?.(value) };
    }
    it('reopens and re-enables synchronously with cached data during refresh failures', async () => {
      const { reader } = setup();
      const first = renderHook(({ enabled }) => source.hook(enabled), { initialProps: { enabled: true } });
      await waitFor(() => expect(first.result.current).toBe(previous));
      reader.mockRejectedValue(new Error('offline'));
      first.rerender({ enabled: false });
      expect(first.result.current).toBeNull();
      first.rerender({ enabled: true });
      expect(first.result.current).toBe(previous);
      first.unmount();
      const second = renderHook(() => source.hook(true));
      expect(second.result.current).toBe(previous);
      await act(async () => {});
      expect(second.result.current).toBe(previous);
    });
    it.each([next, null])('new push wins over a delayed read: %j', async value => {
      let resolve!: (value: unknown) => void;
      const { push } = setup(vi.fn().mockImplementation(() => new Promise(done => { resolve = done; })));
      const hook = renderHook(() => source.hook(true));
      act(() => push(value));
      await act(async () => resolve(previous));
      expect(hook.result.current).toBe(value);
    });
    it('receives logout clears while all panels are unmounted', async () => {
      const { reader, push } = setup();
      const first = renderHook(() => source.hook(true));
      await waitFor(() => expect(first.result.current).toBe(previous));
      first.unmount();
      act(() => push(null));
      reader.mockImplementation(() => new Promise(() => {}));
      const second = renderHook(() => source.hook(true));
      expect(second.result.current).toBeNull();
    });
    it('keeps explicit persisted null authoritative', async () => {
      const { reader } = setup();
      const first = renderHook(() => source.hook(true));
      await waitFor(() => expect(first.result.current).toBe(previous));
      first.unmount();
      reader.mockResolvedValue(null);
      const second = renderHook(() => source.hook(true));
      expect(second.result.current).toBe(previous);
      await waitFor(() => expect(second.result.current).toBeNull());
    });
    it('isolates owner changes and rejects old-owner reads', async () => {
      let resolve!: (value: unknown) => void;
      const reader = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done; }))
        .mockImplementation(() => new Promise(() => {}));
      setup(reader);
      const hook = renderHook(() => source.hook(true));
      act(() => setDataOwnerGeneration('other-owner'));
      hook.rerender();
      await act(async () => resolve(previous));
      expect(hook.result.current).toBeNull();
    });
    it('shares refreshed snapshots with other mounted consumers', async () => {
      const { reader } = setup();
      const first = renderHook(() => source.hook(true));
      await waitFor(() => expect(first.result.current).toBe(previous));
      reader.mockResolvedValue(next);
      const second = renderHook(() => source.hook(true));
      await waitFor(() => expect(second.result.current).toBe(next));
      expect(first.result.current).toBe(next);
    });
  });
}

it('xAI instantaneous limits reselect cached pushes without adding a reader', () => {
  let push!: (value: unknown) => void;
  vi.stubGlobal('electronAPI', { maker: { usage: {
    onXaiRateLimitChanged: (callback: typeof push) => { push = callback; return vi.fn(); },
  } } });
  const hook = renderHook(({ enabled }) => useXaiRateLimit(enabled), { initialProps: { enabled: true } });
  const value = { remainingRequests: 12 };
  act(() => push(value));
  hook.rerender({ enabled: false });
  expect(hook.result.current).toBeNull();
  hook.rerender({ enabled: true });
  expect(hook.result.current).toBe(value);
  act(() => setDataOwnerGeneration('next'));
  hook.rerender({ enabled: true });
  expect(hook.result.current).toBeNull();
});

it('OpenAI status quota reselects account/source caches and ignores pre-push reads', async () => {
  const pushes = new Map<string, Array<(value: unknown) => void>>();
  let resolve!: (value: unknown) => void;
  const reader = vi.fn().mockImplementation(() => new Promise(done => { resolve = done; }));
  vi.stubGlobal('electronAPI', { maker: { usage: {
    getAccount: reader,
    onCodexAccountChanged: (callback: (value: unknown) => void, id = 'openai') => {
      pushes.set(id, [...(pushes.get(id) ?? []), callback]); return vi.fn();
    },
  } } });
  const hook = renderHook(({ id }) => useAccountUsage(undefined, 'codex', 'openai-web', 'gpt-6', id),
    { initialProps: { id: 'openai' } });
  const quota = { source: 'openai-web', primary: { usedPercent: 20 } };
  act(() => pushes.get('openai')?.forEach(push => push(quota)));
  await act(async () => resolve({ source: 'openai-web', primary: { usedPercent: 5 } }));
  expect(hook.result.current?.primary?.usedPercent).toBe(20);
  hook.rerender({ id: 'openai-b' });
  expect(hook.result.current).toBeNull();
  hook.rerender({ id: 'openai' });
  expect(hook.result.current?.primary?.usedPercent).toBe(20);
});

describe('OpenAI quota during a deferred account switch', () => {
  it.each([
    ['openai', 'empty'], ['openai', 'offline'],
    ['openai-a', 'empty'], ['openai-a', 'offline'],
  ])('keeps %s turn events out of the selected account when reads are %s', async (runningId, readResult) => {
    setDataOwnerGeneration(`${runningId}-${readResult}`);
    const pushes = new Map<string, Set<(value: unknown) => void>>();
    const events = new Set<(value: unknown) => void>();
    const reader = readResult === 'empty'
      ? vi.fn().mockResolvedValue(null)
      : vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('electronAPI', { maker: {
      onEvent: (callback: (value: unknown) => void) => {
        events.add(callback); return () => events.delete(callback);
      },
      usage: {
        getAccount: reader,
        onCodexAccountChanged: (callback: (value: unknown) => void, id = 'openai') => {
          const listeners = pushes.get(id) ?? new Set();
          listeners.add(callback); pushes.set(id, listeners);
          return () => listeners.delete(callback);
        },
      },
    } });
    const push = (id: string, value: unknown) => pushes.get(id)?.forEach(callback => callback(value));
    const quota = (usedPercent: number) => ({ source: 'codex-app-server', primary: { usedPercent } });
    const hook = renderHook(({ id }) => useAccountUsage('same-session', 'codex', 'app-server', 'gpt-6', id),
      { initialProps: { id: 'openai-b' } });
    act(() => push('openai-b', quota(20)));
    hook.rerender({ id: runningId });
    act(() => push(runningId, quota(40)));
    hook.rerender({ id: 'openai-b' });
    await act(async () => {});
    act(() => {
      events.forEach(callback => callback({ sessionId: 'same-session',
        event: { type: 'account_usage', source: 'codex', data: quota(90) } }));
      push(runningId, quota(90));
    });
    expect(hook.result.current?.primary?.usedPercent).toBe(20);
    hook.rerender({ id: runningId });
    expect(hook.result.current?.primary?.usedPercent).toBe(90);
    hook.rerender({ id: 'openai-b' });
    expect(hook.result.current?.primary?.usedPercent).toBe(20);
    act(() => push('openai-b', null));
    expect(hook.result.current).toBeNull();
  });
});
