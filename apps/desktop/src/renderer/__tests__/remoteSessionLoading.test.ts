// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { useRemoteSessionLoading } from '@/features/cc-agent/hooks/useRemoteSessionLoading';

// Regression: cached history used to suppress every loading signal, even while
// remote content was still syncing. Exercise the production hook and its timer,
// not a copy of its predicate. Fake timers keep this in the unit tier.
const cached = {
  sessionId: 'task-a',
  remoteDeviceId: 'host-a',
  historyLoaded: true,
  contentSyncing: true,
  hasMessages: true,
  connectionNotice: false,
  hasTaskHeader: true,
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

describe('remote task loading feedback', () => {
  it('keeps cached content readable and shows title feedback until content is ready', () => {
    const { result, rerender } = renderHook(useRemoteSessionLoading, { initialProps: cached });
    expect(result.current).toBe('hidden');
    advance(249);
    expect(result.current).toBe('hidden');
    advance(1);
    expect(result.current).toBe('syncing');
    rerender({ ...cached, contentSyncing: false });
    expect(result.current).toBe('hidden');
  });

  it('moves the empty viewport indicator into the title without restarting the delay', () => {
    const props = { ...cached, hasMessages: false, historyLoaded: false };
    const { result, rerender } = renderHook(useRemoteSessionLoading, { initialProps: props });
    advance(250);
    expect(result.current).toBe('loading');
    rerender(cached);
    expect(result.current).toBe('syncing');
    rerender({ ...cached, contentSyncing: false, hasMessages: false });
    expect(result.current).toBe('hidden');
  });

  it('does not flash when cold cache arrives before a fast remote read', () => {
    const props = { ...cached, historyLoaded: false, hasMessages: false };
    const { result, rerender } = renderHook(useRemoteSessionLoading, { initialProps: props });
    advance(50);
    rerender({ ...props, hasMessages: true });
    expect(result.current).toBe('hidden');
    advance(100);
    rerender({ ...cached, contentSyncing: false });
    advance(250);
    expect(result.current).toBe('hidden');
  });

  it('keeps feedback in the viewport when a bot or embedded pane has no task header', () => {
    const props = { ...cached, hasTaskHeader: false };
    const { result, rerender } = renderHook(useRemoteSessionLoading, { initialProps: props });
    advance(250);
    expect(result.current).toBe('inline-syncing');
    rerender({ ...props, hasTaskHeader: true });
    expect(result.current).toBe('syncing');
    rerender({ ...props, connectionNotice: true });
    expect(result.current).toBe('hidden');
  });

  it('never flashes feedback when a read finishes within the delay', () => {
    const { result, rerender } = renderHook(useRemoteSessionLoading, { initialProps: cached });
    advance(100);
    rerender({ ...cached, contentSyncing: false });
    advance(250);
    expect(result.current).toBe('hidden');
  });

  it.each(['sessionId', 'remoteDeviceId'] as const)('resets the delay when %s changes', (key) => {
    const { result, rerender } = renderHook(useRemoteSessionLoading, { initialProps: cached });
    advance(250);
    expect(result.current).toBe('syncing');
    rerender({ ...cached, [key]: 'other' });
    expect(result.current).toBe('hidden');
    advance(250);
    expect(result.current).toBe('syncing');
  });

  it('yields to connection notices, then waits for content after reconnection', () => {
    const { result, rerender } = renderHook(useRemoteSessionLoading, { initialProps: cached });
    advance(250);
    rerender({ ...cached, connectionNotice: true });
    expect(result.current).toBe('hidden');
    advance(1000);
    rerender(cached);
    expect(result.current).toBe('hidden');
    advance(250);
    expect(result.current).toBe('syncing');
  });

  it('never shows remote loading on local tasks', () => {
    const { result } = renderHook(() =>
      useRemoteSessionLoading({ ...cached, remoteDeviceId: undefined, historyLoaded: false }),
    );
    advance(250);
    expect(result.current).toBe('hidden');
  });
});
