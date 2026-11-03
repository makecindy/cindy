// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useHistoryRecoveryNavigation } from '../session/useHistoryRecoveryNavigation';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); });
function renderHook<T, P = undefined>(hook: (props: P) => T, options?: { initialProps: P }) {
  const root = createRoot(document.createElement('div'));
  const result = {} as { current: T };
  let mounted = true;
  function Harness({ value }: { value: P }) { result.current = hook(value); return null; }
  const rerender = (value: P) => act(() => root.render(<Harness value={value} />));
  const unmount = () => { if (mounted) { act(() => root.unmount()); mounted = false; } };
  cleanups.push(unmount);
  rerender(options?.initialProps as P);
  return { result, rerender, unmount };
}
const idle = { source: 'owner:device:task', running: false, startedAt: 100, endedAt: 101 };
type Recovery = NonNullable<ReturnType<ReturnType<typeof useHistoryRecoveryNavigation>['begin']>>;

function begin(result: { current: ReturnType<typeof useHistoryRecoveryNavigation> }): Recovery {
  let recovery!: Recovery;
  act(() => { recovery = result.current.begin()!; });
  return recovery;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('history recovery navigation', () => {
  it('allows an unchanged source to navigate when recovery completes', async () => {
    const { result, rerender } = renderHook(props => useHistoryRecoveryNavigation(props), { initialProps: idle });
    const pending = deferred();
    const navigate = vi.fn();
    const recovery = begin(result);
    const completion = pending.promise.then(() => { if (recovery.isCurrent()) navigate(); });
    rerender({ ...idle });
    await act(async () => { pending.resolve(); await completion; });
    expect(navigate).toHaveBeenCalledOnce();
  });

  it.each(['running', 'turn-between-renders', 'input', 'route', 'unmount'] as const)(
    'does not navigate after %s supersedes a pending recovery', async change => {
      const { result, rerender, unmount } = renderHook(props => useHistoryRecoveryNavigation(props), { initialProps: idle });
      const pending = deferred();
      const navigate = vi.fn();
      const recovery = begin(result);
      const completion = pending.promise.then(() => { if (recovery.isCurrent()) navigate(); });
      if (change === 'running') {
        rerender({ ...idle, running: true });
        expect(result.current.begin()).toBeNull();
        // Returning to idle must not revive the earlier navigation.
        rerender({ ...idle });
      } else if (change === 'turn-between-renders') {
        rerender({ ...idle, startedAt: 200, endedAt: 201 });
      } else if (change === 'input') {
        act(() => result.current.invalidate());
      } else if (change === 'route') {
        rerender({ ...idle, source: 'owner:device:other-task' });
        rerender({ ...idle });
      } else {
        unmount();
      }
      await act(async () => { pending.resolve(); await completion; });
      expect(navigate).not.toHaveBeenCalled();
    },
  );

  it('allows a later recovery without reviving the superseded one', () => {
    const { result } = renderHook(() => useHistoryRecoveryNavigation(idle));
    const old = begin(result);
    act(() => result.current.invalidate());
    expect(old.isCurrent()).toBe(false);
    act(() => old.release());
    const fresh = begin(result);
    expect(fresh.isCurrent()).toBe(true);
    act(() => old.release());
    expect(result.current.pending).toBe(true);
    expect(result.current.isPending()).toBe(true);
  });

  it.each(['source-first', 'destination-first'] as const)(
    'keeps pending recovery scoped to its task when completion order is %s', order => {
      const { result, rerender } = renderHook(props => useHistoryRecoveryNavigation(props), { initialProps: idle });
      const sourceRecovery = begin(result);
      expect(result.current.pending).toBe(true);
      expect(result.current.isPending()).toBe(true);
      expect(result.current.begin()).toBeNull();

      const destination = { ...idle, source: 'owner:device:other-task' };
      rerender(destination);
      expect(result.current.pending).toBe(false);
      expect(result.current.isPending()).toBe(false);
      expect(sourceRecovery.isCurrent()).toBe(false);
      const destinationRecovery = begin(result);
      expect(result.current.pending).toBe(true);

      const first = order === 'source-first' ? sourceRecovery : destinationRecovery;
      const last = order === 'source-first' ? destinationRecovery : sourceRecovery;
      act(() => first.release());
      expect(result.current.pending).toBe(order === 'source-first');
      expect(result.current.isPending()).toBe(order === 'source-first');
      rerender(idle);
      expect(result.current.pending).toBe(order === 'destination-first');
      expect(result.current.isPending()).toBe(order === 'destination-first');
      expect(sourceRecovery.isCurrent()).toBe(false);
      act(() => last.release());
      expect(result.current.pending).toBe(false);
      rerender(destination);
      expect(result.current.pending).toBe(false);
    },
  );

  it('locks synchronously before a second same-task request can start', () => {
    const { result } = renderHook(() => useHistoryRecoveryNavigation(idle));
    act(() => {
      expect(result.current.begin()).not.toBeNull();
      expect(result.current.isPending()).toBe(true);
      expect(result.current.begin()).toBeNull();
    });
  });
});
