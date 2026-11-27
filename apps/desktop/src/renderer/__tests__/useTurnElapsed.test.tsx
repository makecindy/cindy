// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useTurnElapsed } from '@/features/cc-agent/hooks/useTurnElapsed';

const remote = vi.fn();
const local = vi.fn();
const view = { sessionId: 'task', deviceId: 'studio', turnKey: 1, running: true, enabled: true };
const sample = (elapsed: number, start = 5000, ended: number | null = null) => ({
  id: 'task', activeTurnStartedAt: start, lastTurnEndedAt: ended, turnElapsedMs: elapsed,
});
async function flush() { await act(async () => {}); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('electronAPI', { deviceLink: { invoke: remote }, localDb: { sessions: { get: local } } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it('opens partway through a remote turn, ticks locally, resyncs on wake and freezes the Host duration', async () => {
  vi.setSystemTime(new Date('2040-01-01'));
  remote.mockResolvedValueOnce(sample(252000));
  const { result, rerender } = renderHook(useTurnElapsed, { initialProps: view });
  await flush();
  expect(remote).toHaveBeenCalledWith('studio', 'local-db:sessions:get', ['task']);
  expect(local).not.toHaveBeenCalled();
  expect(result.current).toBe(252000);
  act(() => vi.advanceTimersByTime(4000));
  expect(result.current).toBe(256000);
  expect(remote).toHaveBeenCalledTimes(1);
  remote.mockResolvedValueOnce(sample(301000));
  vi.setSystemTime(new Date('2040-01-02'));
  act(() => vi.advanceTimersByTime(1000));
  await flush();
  expect(result.current).toBe(301000);
  remote.mockResolvedValueOnce(sample(301734, 5000, 306734));
  rerender({ ...view, running: false });
  await flush();
  act(() => vi.advanceTimersByTime(5000));
  expect(result.current).toBe(301734);
});

it('ignores responses from before reconnect and from the previous turn', async () => {
  let oldRead!: (value: unknown) => void;
  remote.mockImplementationOnce(() => new Promise(resolve => { oldRead = resolve; }));
  const { result, rerender } = renderHook(useTurnElapsed, { initialProps: view });
  rerender({ ...view, enabled: false });
  remote.mockResolvedValueOnce(sample(240000));
  rerender(view);
  await flush();
  expect(result.current).toBe(240000);
  let firstTurn!: (value: unknown) => void;
  remote.mockImplementationOnce(() => new Promise(resolve => { firstTurn = resolve; }));
  act(() => window.dispatchEvent(new Event('focus')));
  remote.mockResolvedValueOnce(sample(1000, 300000));
  rerender({ ...view, turnKey: 2 });
  await flush();
  expect(result.current).toBe(1000);
  await act(async () => {
    oldRead(sample(240001));
    firstTurn(sample(240002));
  });
  expect(result.current).toBe(1000);
});

it('waits for the new local start marker and hides time for old remote hosts', async () => {
  local.mockResolvedValueOnce(sample(12000, 5000, 17000)).mockResolvedValueOnce(sample(400, 25000));
  const { result, rerender } = renderHook(useTurnElapsed, { initialProps: { ...view, deviceId: null as string | null } });
  await flush();
  expect(result.current).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(250));
  expect(result.current).toBe(400);
  remote.mockResolvedValue({ id: 'task', activeTurnStartedAt: 5000 });
  rerender(view);
  await flush();
  act(() => vi.advanceTimersByTime(10000));
  expect(result.current).toBeNull();
  expect(remote).toHaveBeenCalledTimes(1);
});

it('pauses reads and retries while document or native window is hidden, and shares recovery reads', async () => {
  let nativeHidden!: (hidden: boolean) => void;
  window.electronAPI.onWindowHiddenChange = callback => { nativeHidden = callback; return () => {}; };
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  const { rerender, result } = renderHook(useTurnElapsed, { initialProps: view });
  await flush();
  expect(remote).not.toHaveBeenCalled();
  let complete!: (value: unknown) => void;
  remote.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  visibility.mockReturnValue('visible');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await flush();
  act(() => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    vi.setSystemTime(new Date('2040-01-02'));
    vi.advanceTimersByTime(1000);
  });
  expect(remote).toHaveBeenCalledTimes(1);
  await act(async () => complete(sample(1000)));
  act(() => nativeHidden(true));
  rerender({ ...view, turnKey: 2 });
  await act(async () => vi.advanceTimersByTimeAsync(20000));
  expect(remote).toHaveBeenCalledTimes(1);
  remote.mockRejectedValueOnce(new Error('link recovering'));
  act(() => nativeHidden(false));
  await flush();
  expect(remote).toHaveBeenCalledTimes(2);
  act(() => nativeHidden(true));
  await act(async () => vi.advanceTimersByTimeAsync(20000));
  expect(remote).toHaveBeenCalledTimes(2);
  remote.mockResolvedValueOnce(sample(3000, 40000));
  act(() => nativeHidden(false));
  await flush();
  expect(remote).toHaveBeenCalledTimes(3);
  expect(result.current).toBe(3000);
  visibility.mockRestore();
});
