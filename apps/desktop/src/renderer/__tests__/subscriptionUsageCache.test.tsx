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
    // Unit r4389409976: new live-only recovery may queue behind an ordinary
    // consumer, but clear/unmount must cancel it even while that consumer stays.
    // The old owner/clear tests had no pending recovery request to cancel.
    it.each(['clear', 'unmount'] as const)('cancels a live recovery reread after %s', async stop => {
      let resolve!: (value: unknown) => void;
      const { reader, push } = setup(vi.fn().mockImplementation(() => new Promise(done => { resolve = done; })));
      const other = renderHook(() => source.hook(true));
      const live = renderHook(({ enabled }) => source.hook(enabled, undefined, { live: true }),
        { initialProps: { enabled: true } });
      live.rerender({ enabled: false });
      live.rerender({ enabled: true });
      expect(reader).toHaveBeenCalledTimes(1);
      if (stop === 'clear') act(() => push(null));
      else live.unmount();
      await act(async () => resolve(previous));
      expect(reader).toHaveBeenCalledTimes(1);
      expect(other.result.current).toBe(stop === 'clear' ? null : previous);
    });

    // Default consumers still supersede old reads; live queuing must stay opt-in.
    it('retains latest-read priority for ordinary simultaneous consumers', async () => {
      const replies: Array<(value: unknown) => void> = [];
      setup(vi.fn().mockImplementation(() => new Promise(resolve => replies.push(resolve))));
      const first = renderHook(() => source.hook(true));
      const second = renderHook(() => source.hook(true));
      expect(replies).toHaveLength(2);
      await act(async () => replies[1](next));
      await act(async () => replies[0](previous));
      expect(first.result.current).toBe(next);
      expect(second.result.current).toBe(next);
    });

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

// Unit r4391955043: account warm starts previously had no live observation
// coverage. Exercise the real hook with another ordinary subscriber retained;
// only the recovering card owns its queued reread, and identity changes fence it.
it.each(['close', 'clear', 'owner', 'provider'] as const)('cancels a live Codex account recovery queue on %s', async stop => {
  setDataOwnerGeneration(`account-live-${stop}`);
  const value = (id: string, usedPercent: number) => ({ providerId: id, primary: { usedPercent } });
  const pushes = new Map<string, Set<(payload: unknown) => void>>();
  let finish!: (payload: unknown) => void;
  const reader = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockImplementation((_kind, id: string) => Promise.resolve(value(id, 96)));
  vi.stubGlobal('electronAPI', { maker: { usage: {
    getAccount: reader,
    onCodexAccountChanged: (callback: (payload: unknown) => void, id: string) => {
      const listeners = pushes.get(id) ?? new Set();
      listeners.add(callback); pushes.set(id, listeners);
      return () => listeners.delete(callback);
    },
  } } });
  const id = 'openai-live-account';
  const ordinary = renderHook(() => useAccountUsage(undefined, 'codex', 'app-server', undefined, id));
  const live = renderHook(({ enabled, providerId }) => useAccountUsage(undefined, enabled ? 'codex' : undefined,
    'app-server', undefined, providerId, { live: true }), { initialProps: { enabled: true, providerId: id } });
  const second = renderHook(() => useAccountUsage(undefined, 'codex', 'app-server', undefined, id, { live: true }));
  expect(reader).toHaveBeenCalledTimes(1); // Ordinary + first two live cards share.
  live.rerender({ enabled: false, providerId: id });
  live.rerender({ enabled: true, providerId: id }); // One queued recovery behind the first read.
  expect(reader).toHaveBeenCalledTimes(1);
  if (stop === 'close') {
    ordinary.unmount(); // The remaining live card still owns the shared result.
    live.unmount();
  }
  else if (stop === 'clear') act(() => pushes.get(id)?.forEach(push => push(null)));
  else {
    if (stop === 'owner') setDataOwnerGeneration('next-account-owner');
    live.rerender({ enabled: true, providerId: stop === 'provider' ? 'openai-other' : id });
    await act(async () => {});
    expect(live.result.current?.primary?.usedPercent).toBe(96);
  }
  await act(async () => finish(value(id, 73)));
  expect(reader).toHaveBeenCalledTimes(stop === 'close' || stop === 'clear' ? 1 : 2);
  if (stop === 'close' || stop === 'provider') {
    if (stop === 'provider') expect(ordinary.result.current?.primary?.usedPercent).toBe(73);
    expect(second.result.current?.primary?.usedPercent).toBe(73);
  } else expect(ordinary.result.current).toBeNull();
  if (stop === 'clear') expect(live.result.current).toBeNull();
  if (stop === 'owner' || stop === 'provider') expect(live.result.current?.primary?.usedPercent).toBe(96);
});

// The optional live path must not change a normal chip's cancelled warm start.
it('keeps ordinary Codex warm-start cancellation when no live card shared it', async () => {
  setDataOwnerGeneration('ordinary-account-cancel');
  let finish!: (payload: unknown) => void;
  const reader = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockRejectedValue(new Error('temporarily unavailable'));
  vi.stubGlobal('electronAPI', { maker: { usage: { getAccount: reader } } });
  const hook = renderHook(({ enabled }) => useAccountUsage(undefined, enabled ? 'codex' : undefined),
    { initialProps: { enabled: true } });
  hook.rerender({ enabled: false });
  hook.rerender({ enabled: true });
  expect(reader).toHaveBeenCalledTimes(2);
  await act(async () => finish({ primary: { usedPercent: 73 } }));
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

it('isolates Grok instantaneous limits per connection and clears an unmounted account only', () => {
  const pushes = new Map<string, (value: unknown) => void>();
  vi.stubGlobal('electronAPI', { maker: { usage: {
    onXaiRateLimitChanged: (cb: (value: unknown) => void, id: string) => { pushes.set(id, cb); return vi.fn(); },
  } } });
  const hook = renderHook(({ id }) => useXaiRateLimit(true, id), { initialProps: { id: 'xai-a' } });
  const a = { remainingRequests: 12 };
  act(() => pushes.get('xai-a')?.(a));
  hook.rerender({ id: 'xai-b' });
  expect(hook.result.current).toBeNull();
  const b = { remainingRequests: 3 };
  act(() => pushes.get('xai-b')?.(b));
  act(() => pushes.get('xai-a')?.(null));
  expect(hook.result.current).toBe(b);
  hook.rerender({ id: 'xai-a' });
  expect(hook.result.current).toBeNull();
  hook.rerender({ id: 'xai-b' });
  expect(hook.result.current).toBe(b);
});
