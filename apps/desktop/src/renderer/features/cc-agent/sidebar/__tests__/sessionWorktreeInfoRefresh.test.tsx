// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTaskInfoWorktree } from '../sessionWorktreeInfo';

const mocks = vi.hoisted(() => ({
  official: vi.fn(),
  reportLiveness: vi.fn(),
  detect: vi.fn(),
  findLinked: vi.fn(),
  listeners: new Set<(payload: { sessionId: string }) => void>(),
}));

vi.mock('@/contexts/WorktreeContext', () => ({
  useWorktreeForSession: mocks.official,
  useReportWorktreeLiveness: () => mocks.reportLiveness,
}));

const session = { id: 'open', workingDir: '/repo', worktreePath: '/tmp/wt/open' };

function switchFocus() {
  window.dispatchEvent(new Event('blur'));
  window.dispatchEvent(new Event('focus'));
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.reportLiveness.mockReset();
  mocks.official.mockReset().mockReturnValue({ path: '/tmp/wt/open', name: 'open', branch: 'feature' });
  mocks.detect.mockReset().mockResolvedValue({ isInsideWorktree: true });
  mocks.findLinked.mockReset().mockResolvedValue(null);
  mocks.listeners.clear();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      worktreeDetectCwd: mocks.detect,
      gitContext: { findLinkedWorktree: mocks.findLinked },
      onWorktreeChanged: (cb: (payload: { sessionId: string }) => void) => {
        mocks.listeners.add(cb);
        return () => mocks.listeners.delete(cb);
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('opened worktree refresh', () => {
  it('checks an active task again when it regains focus and hides an externally deleted worktree', async () => {
    const { result } = renderHook(() => useTaskInfoWorktree(session, true, { observeTelemetry: true }));
    await act(async () => {});
    expect(result.current?.source).toBe('managed');

    mocks.detect.mockResolvedValue({ isInsideWorktree: false });
    await act(async () => switchFocus());

    expect(mocks.detect).toHaveBeenCalledTimes(2);
    expect(result.current).toBeNull();
  });

  it('keeps an invalid official worktree hidden until a remount probe confirms it', async () => {
    const official = { path: '/tmp/wt/open', name: 'open', branch: 'feature' };
    mocks.official.mockImplementation((_session, options?: { includeInvalid?: boolean }) =>
      options?.includeInvalid ? official : null,
    );
    let finish!: (value: { isInsideWorktree: boolean }) => void;
    mocks.detect.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));

    const { result } = renderHook(() => useTaskInfoWorktree(session, true, { observeTelemetry: true }));
    expect(result.current).toBeNull();

    await act(async () => finish({ isInsideWorktree: true }));
    expect(result.current?.source).toBe('managed');
  });

  it('resets liveness from the new snapshot when switching tasks in place', async () => {
    const metaA = { path: '/tmp/wt/a', name: 'a', branch: 'feature-a' };
    const metaB = { path: '/tmp/wt/b', name: 'b', branch: 'feature-b' };
    mocks.official.mockImplementation((sessionId: string, options?: { includeInvalid?: boolean }) => {
      if (options?.includeInvalid) return sessionId === 'a' ? metaA : metaB;
      return sessionId === 'a' ? null : metaB;
    });
    mocks.detect.mockResolvedValue({ isInsideWorktree: false });
    const view = renderHook(
      ({ current }) => useTaskInfoWorktree(current, true, { observeTelemetry: true }),
      { initialProps: { current: { ...session, id: 'a' } } },
    );
    await act(async () => {});
    expect(view.result.current).toBeNull();

    mocks.detect.mockResolvedValue({ isInsideWorktree: true });
    await act(async () => view.rerender({ current: { ...session, id: 'b' } }));
    expect(view.result.current?.source).toBe('managed');
  });

  it('keeps invalid liveness through disable, delayed re-enable, and a failed probe', async () => {
    mocks.detect.mockResolvedValue({ isInsideWorktree: false });
    const view = renderHook(
      ({ enabled }) => useTaskInfoWorktree(session, enabled, { observeTelemetry: true }),
      { initialProps: { enabled: true } },
    );
    await act(async () => {});
    expect(view.result.current).toBeNull();

    view.rerender({ enabled: false });
    await act(async () => switchFocus());
    expect(view.result.current).toBeNull();
    expect(mocks.detect).toHaveBeenCalledOnce();
    expect(mocks.listeners.size).toBe(0);

    let reject!: (error: Error) => void;
    mocks.detect.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    view.rerender({ enabled: true });
    expect(view.result.current).toBeNull();
    await act(async () => reject(new Error('[INTERNAL] Worktree directory probe failed')));
    expect(view.result.current).toBeNull();
    expect(mocks.reportLiveness).toHaveBeenCalledTimes(1);

    mocks.detect.mockResolvedValue({ isInsideWorktree: true });
    await act(async () => switchFocus());
    expect(view.result.current?.source).toBe('managed');
    expect(mocks.reportLiveness).toHaveBeenLastCalledWith(expect.anything(), true);
  });

  it('updates liveness after a route switch even when the previous task had the same probe result', async () => {
    const metaA = { path: '/tmp/wt/a', name: 'a', branch: 'feature-a' };
    const metaB = { path: '/tmp/wt/b', name: 'b', branch: 'feature-b' };
    mocks.official.mockImplementation((sessionId: string, options?: { includeInvalid?: boolean }) => {
      if (options?.includeInvalid) return sessionId === 'a' ? metaA : metaB;
      return sessionId === 'a' ? metaA : null;
    });
    const view = renderHook(
      ({ id }) => useTaskInfoWorktree({ ...session, id }, true, { observeTelemetry: true }),
      { initialProps: { id: 'a' } },
    );
    await act(async () => {});
    expect(view.result.current?.path).toBe(metaA.path);

    let finish!: (value: { isInsideWorktree: boolean }) => void;
    mocks.detect.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    view.rerender({ id: 'b' });
    expect(view.result.current).toBeNull();
    await act(async () => finish({ isInsideWorktree: true }));
    expect(view.result.current?.path).toBe(metaB.path);

    mocks.detect.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    view.rerender({ id: 'a' });
    expect(view.result.current?.path).toBe(metaA.path);
    await act(async () => finish({ isInsideWorktree: false }));
    expect(view.result.current).toBeNull();
  });

  it('applies recycle and restore events immediately', async () => {
    const { result } = renderHook(() => useTaskInfoWorktree(session, true, { observeTelemetry: true }));
    await act(async () => {});
    mocks.detect.mockResolvedValue({ isInsideWorktree: false });
    await act(async () => { mocks.listeners.forEach((cb) => cb({ sessionId: 'open' })); });
    expect(result.current).toBeNull();

    mocks.detect.mockResolvedValue({ isInsideWorktree: true });
    await act(async () => { mocks.listeners.forEach((cb) => cb({ sessionId: 'open' })); });
    expect(result.current?.source).toBe('managed');
    expect(mocks.detect).toHaveBeenCalledTimes(3);
    await act(async () => { mocks.listeners.forEach((cb) => cb({ sessionId: 'other' })); });
    expect(mocks.detect).toHaveBeenCalledTimes(3);
  });

  it('coalesces authoritative changes during a pending check and discards its stale result', async () => {
    let finish!: (value: { isInsideWorktree: boolean }) => void;
    mocks.detect.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    mocks.detect.mockResolvedValue({ isInsideWorktree: false });
    const { result } = renderHook(() => useTaskInfoWorktree(session, true, { observeTelemetry: true }));
    await act(async () => {
      for (let i = 0; i < 10; i++) mocks.listeners.forEach((cb) => cb({ sessionId: 'open' }));
      finish({ isInsideWorktree: true });
    });
    expect(mocks.detect).toHaveBeenCalledTimes(2);
    expect(result.current).toBeNull();
  });

  it('does not start queued work after unmount', async () => {
    let finish!: (value: { isInsideWorktree: boolean }) => void;
    mocks.detect.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = renderHook(() => useTaskInfoWorktree(session, true, { observeTelemetry: true }));
    act(() => { mocks.listeners.forEach((cb) => cb({ sessionId: 'open' })); });
    view.unmount();
    await act(async () => {
      finish({ isInsideWorktree: true });
      switchFocus();
    });
    expect(mocks.detect).toHaveBeenCalledOnce();
    expect(mocks.listeners.size).toBe(0);
  });

  it.each([
    { enabled: false, observeTelemetry: true },
    { enabled: true, observeTelemetry: false },
    { enabled: true, observeTelemetry: true, deviceLinkDeviceId: 'remote' },
    { enabled: true, observeTelemetry: true, remoteHostId: 'ssh' },
  ])('never probes disabled, sidebar or remote entries: %j', async (opts) => {
    renderHook(() => useTaskInfoWorktree({ ...session, ...opts }, opts.enabled, opts));
    await act(async () => { switchFocus(); });
    expect(mocks.detect).not.toHaveBeenCalled();
    expect(mocks.findLinked).not.toHaveBeenCalled();
  });
});
