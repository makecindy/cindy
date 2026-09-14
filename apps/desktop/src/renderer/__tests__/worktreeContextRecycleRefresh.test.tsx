// @vitest-environment jsdom

/** WorktreeContext 只共享快照与 active 任务的探测结果；创建/回收按 sessionId 增量更新。 */

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  WorktreeProvider,
  useWorktrees,
  useRefreshWorktreeForSession,
  useReportWorktreeLiveness,
  useWorktreeForSession,
} from '@/contexts/WorktreeContext';
import { useTaskInfoWorktree } from '@/features/cc-agent/sidebar/sessionWorktreeInfo';
import { emitRefresh } from '@/lib/sessionsBus';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() }),
}));

const mocks = {
  worktreeListAll: vi.fn(),
  worktreeGetForSession: vi.fn(),
  worktreeDetectCwd: vi.fn(),
  findLinkedWorktree: vi.fn(),
  listeners: new Set<(payload: { sessionId: string }) => void>(),
  sessionCreatedListeners: new Set<
    (payload: { sessionId: string }, ownerStamp?: unknown) => void
  >(),
};

function emitWorktreeChanged(sessionId: string): void {
  mocks.listeners.forEach((cb) => cb({ sessionId }));
}

function emitSessionCreated(sessionId: string, ownerStamp?: unknown): void {
  mocks.sessionCreatedListeners.forEach((cb) => cb({ sessionId }, ownerStamp));
}

function Probe() {
  const metas = useWorktrees();
  return (
    <span data-testid="ids">
      {Object.values(metas)
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
        .map((meta) => `${meta.sessionId}:${meta.path}`)
        .join(',')}
    </span>
  );
}

function ActiveProbe() {
  const info = useTaskInfoWorktree({ id: 'open', workingDir: '/repo' }, true, { observeTelemetry: true });
  return <span data-testid="active">{info?.path ?? ''}</span>;
}

beforeEach(() => {
  mocks.worktreeListAll.mockReset();
  mocks.worktreeGetForSession.mockReset();
  mocks.worktreeDetectCwd.mockReset();
  mocks.findLinkedWorktree.mockReset().mockResolvedValue(null);
  mocks.worktreeDetectCwd.mockResolvedValue({
    isInsideWorktree: true,
    isGitRepo: true,
    gitInstalled: true,
  });
  mocks.listeners.clear();
  mocks.sessionCreatedListeners.clear();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      worktreeListAll: mocks.worktreeListAll,
      worktreeGetForSession: mocks.worktreeGetForSession,
      worktreeDetectCwd: mocks.worktreeDetectCwd,
      gitContext: { findLinkedWorktree: mocks.findLinkedWorktree },
      onWorktreeChanged: (cb: (payload: { sessionId: string }) => void) => {
        mocks.listeners.add(cb);
        return () => mocks.listeners.delete(cb);
      },
      localDb: {
        sessionsPush: {
          onCreated: (cb: (payload: { sessionId: string }, ownerStamp?: unknown) => void) => {
            mocks.sessionCreatedListeners.add(cb);
            return () => mocks.sessionCreatedListeners.delete(cb);
          },
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('WorktreeContext recycle refresh', () => {
  it('shares external deletion with sidebar badges, retains metadata for reopening and detects external restoration', async () => {
    const meta = { sessionId: 'open', path: '/tmp/wt/open' };
    mocks.worktreeListAll.mockResolvedValue([meta, { sessionId: 'idle', path: '/tmp/wt/idle' }]);
    const content = (active: boolean) => <WorktreeProvider><Probe />{active && <ActiveProbe />}</WorktreeProvider>;
    const view = render(content(true));
    await act(async () => {});
    expect(view.getByTestId('active').textContent).toBe(meta.path);

    mocks.worktreeDetectCwd.mockResolvedValue({ isInsideWorktree: false });
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(view.getByTestId('active').textContent).toBe('');
    expect(view.getByTestId('ids').textContent).toBe('idle:/tmp/wt/idle');

    view.rerender(content(false));
    mocks.worktreeDetectCwd.mockClear().mockResolvedValue({ isInsideWorktree: true });
    view.rerender(content(true));
    await act(async () => {});
    expect(view.getByTestId('active').textContent).toBe(meta.path);
    expect(view.getByTestId('ids').textContent).toContain('open:/tmp/wt/open');
    expect(mocks.worktreeDetectCwd).toHaveBeenCalledExactlyOnceWith({ cwd: meta.path });
    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
    expect(mocks.worktreeGetForSession).not.toHaveBeenCalled();
  });

  it('rechecks same-path restoration through refreshSession without requiring a changed push or focus', async () => {
    const meta = { sessionId: 'open', path: '/tmp/wt/open' };
    mocks.worktreeListAll.mockResolvedValue([meta]);
    mocks.worktreeDetectCwd.mockResolvedValue({ isInsideWorktree: false });
    let refresh!: (sessionId: string) => Promise<void>;
    function Actions() {
      refresh = useRefreshWorktreeForSession();
      return <><Probe /><ActiveProbe /></>;
    }
    const view = render(<WorktreeProvider><Actions /></WorktreeProvider>);
    await act(async () => {});
    expect(view.getByTestId('active').textContent).toBe('');
    expect(view.getByTestId('ids').textContent).toBe('');

    mocks.worktreeGetForSession.mockResolvedValue({ ...meta });
    mocks.worktreeDetectCwd.mockClear().mockResolvedValue({ isInsideWorktree: true });
    await act(async () => { await refresh('open'); });
    expect(view.getByTestId('active').textContent).toBe(meta.path);
    expect(view.getByTestId('ids').textContent).toBe(`open:${meta.path}`);
    expect(mocks.worktreeDetectCwd).toHaveBeenCalledExactlyOnceWith({ cwd: meta.path });
    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
  });

  it('does not hide a live worktree when its probe rejects', async () => {
    mocks.worktreeListAll.mockResolvedValue([{ sessionId: 'open', path: '/tmp/wt/open' }]);
    const view = render(<WorktreeProvider><Probe /><ActiveProbe /></WorktreeProvider>);
    await act(async () => {});
    mocks.worktreeDetectCwd.mockRejectedValue(new Error('probe timeout'));
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    expect(view.getByTestId('active').textContent).toBe('/tmp/wt/open');
    expect(view.getByTestId('ids').textContent).toBe('open:/tmp/wt/open');
  });

  it.each(['/tmp/wt/open', '/tmp/wt/restored'])(
    'uses replacement metadata at %s while its probe is pending or fails, ignoring old results',
    async (restoredPath) => {
      const meta = { sessionId: 'open', path: '/tmp/wt/open' };
      mocks.worktreeListAll.mockResolvedValue([meta]);
      mocks.worktreeDetectCwd.mockResolvedValue({ isInsideWorktree: false });
      let refresh!: (sessionId: string) => Promise<void>;
      function Actions() {
        refresh = useRefreshWorktreeForSession();
        return <><Probe /><ActiveProbe /></>;
      }
      const view = render(<WorktreeProvider><Actions /></WorktreeProvider>);
      await act(async () => {});
      expect(view.getByTestId('active').textContent).toBe('');
      expect(view.getByTestId('ids').textContent).toBe('');

      let finishOld!: (value: { isInsideWorktree: boolean }) => void;
      mocks.worktreeDetectCwd.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
      await act(async () => { window.dispatchEvent(new Event('focus')); });

      let rejectNew!: (reason: Error) => void;
      mocks.worktreeGetForSession.mockResolvedValue({ ...meta, path: restoredPath });
      mocks.worktreeDetectCwd.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectNew = reject; }));
      await act(async () => { await refresh('open'); });
      expect(view.getByTestId('ids').textContent).toBe(`open:${restoredPath}`);
      expect(view.getByTestId('active').textContent).toBe(restoredPath);
      expect(mocks.worktreeDetectCwd).toHaveBeenLastCalledWith({ cwd: restoredPath });

      await act(async () => { finishOld({ isInsideWorktree: false }); });
      expect(view.getByTestId('active').textContent).toBe(restoredPath);
      expect(view.getByTestId('ids').textContent).toBe(`open:${restoredPath}`);
      await act(async () => { rejectNew(new Error('[INTERNAL] Worktree directory probe failed')); });
      expect(view.getByTestId('active').textContent).toBe(restoredPath);
      expect(view.getByTestId('ids').textContent).toBe(`open:${restoredPath}`);

      // A conclusive result for the new metadata must still update both views.
      await act(async () => { window.dispatchEvent(new Event('focus')); });
      expect(view.getByTestId('active').textContent).toBe('');
      expect(view.getByTestId('ids').textContent).toBe('');
      expect(mocks.worktreeDetectCwd).toHaveBeenCalledTimes(4);
      expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
      expect(mocks.worktreeGetForSession).toHaveBeenCalledExactlyOnceWith('open');
    },
  );

  it('ignores liveness reports captured before same-path restoration or recycling', async () => {
    const meta = { sessionId: 'open', path: '/tmp/wt/open' };
    mocks.worktreeListAll.mockResolvedValue([meta]);
    let report!: ReturnType<typeof useReportWorktreeLiveness>;
    let original!: NonNullable<ReturnType<typeof useWorktreeForSession>>;
    let refresh!: (sessionId: string) => Promise<void>;
    function Actions() {
      report = useReportWorktreeLiveness();
      original = useWorktreeForSession('open') ?? original;
      refresh = useRefreshWorktreeForSession();
      return <Probe />;
    }
    const view = render(<WorktreeProvider><Actions /></WorktreeProvider>);
    await act(async () => {});
    const oldMeta = original;
    mocks.worktreeGetForSession.mockResolvedValue({ ...meta });
    await act(async () => { await refresh('open'); });
    await act(async () => { report(oldMeta, false); });
    expect(view.getByTestId('ids').textContent).toBe('open:/tmp/wt/open');
    mocks.worktreeGetForSession.mockResolvedValue(null);
    await act(async () => { await refresh('open'); });
    await act(async () => { report(original, true); });
    expect(view.getByTestId('ids').textContent).toBe('');
    expect(mocks.worktreeDetectCwd).not.toHaveBeenCalled();
  });

  it('removes only the reported session without reloading the full snapshot', async () => {
    mocks.worktreeListAll.mockResolvedValueOnce([
      { sessionId: 'archived-one', path: '/tmp/wt/archived-one' },
      { sessionId: 'other', path: '/tmp/wt/other' },
    ]);
    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => {
      expect(view.getByTestId('ids').textContent).toContain('archived-one:/tmp/wt/archived-one');
    });

    mocks.worktreeGetForSession.mockResolvedValueOnce(null);
    await act(async () => {
      emitWorktreeChanged('archived-one');
    });

    await waitFor(() => {
      expect(view.getByTestId('ids').textContent).toBe('other:/tmp/wt/other');
    });
    expect(mocks.worktreeGetForSession).toHaveBeenCalledWith('archived-one');
    expect(mocks.worktreeListAll).toHaveBeenCalledTimes(1);
  });

  it('updates only the reported worktree', async () => {
    mocks.worktreeListAll.mockResolvedValueOnce([
      { sessionId: 'changed', path: '/tmp/wt/old' },
      { sessionId: 'other', path: '/tmp/wt/other' },
    ]);
    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    mocks.worktreeGetForSession.mockResolvedValueOnce({
      sessionId: 'changed',
      path: '/tmp/wt/new',
    });

    act(() => emitWorktreeChanged('changed'));

    await waitFor(() => {
      expect(view.getByTestId('ids').textContent).toContain('changed:/tmp/wt/new');
    });
    expect(mocks.worktreeListAll).toHaveBeenCalledTimes(1);
  });

  it('keeps the newest response when the same session changes twice', async () => {
    mocks.worktreeListAll.mockResolvedValueOnce([{ sessionId: 'same', path: '/tmp/wt/start' }]);
    let resolveFirst!: (value: { sessionId: string; path: string }) => void;
    mocks.worktreeGetForSession
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ sessionId: 'same', path: '/tmp/wt/newest' });
    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(view.getByTestId('ids').textContent).toContain('/tmp/wt/start'));

    act(() => {
      emitWorktreeChanged('same');
      emitWorktreeChanged('same');
    });
    await waitFor(() => expect(view.getByTestId('ids').textContent).toContain('/tmp/wt/newest'));

    await act(async () => {
      resolveFirst({ sessionId: 'same', path: '/tmp/wt/stale' });
    });
    expect(view.getByTestId('ids').textContent).toBe('same:/tmp/wt/newest');
  });

  it('applies concurrent events for different sessions independently', async () => {
    mocks.worktreeListAll.mockResolvedValueOnce([]);
    let resolveFirst!: (value: { sessionId: string; path: string }) => void;
    mocks.worktreeGetForSession.mockImplementation((sessionId: string) => {
      if (sessionId === 'first') {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({ sessionId, path: `/tmp/wt/${sessionId}` });
    });
    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(mocks.worktreeListAll).toHaveBeenCalledOnce());

    act(() => {
      emitWorktreeChanged('first');
      emitWorktreeChanged('second');
    });
    await waitFor(() => expect(view.getByTestId('ids').textContent).toContain('second'));
    await act(async () => {
      resolveFirst({ sessionId: 'first', path: '/tmp/wt/first' });
    });

    expect(view.getByTestId('ids').textContent).toBe('first:/tmp/wt/first,second:/tmp/wt/second');
    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
  });

  it('does not turn a sessions refresh into a worktree scan', async () => {
    mocks.worktreeListAll.mockResolvedValueOnce([]);
    render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(mocks.worktreeListAll).toHaveBeenCalledOnce());

    act(() => emitRefresh());

    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
  });

  it('discovers a worktree created by a local background session without scanning all worktrees', async () => {
    mocks.worktreeListAll.mockResolvedValueOnce([]);
    mocks.worktreeGetForSession.mockResolvedValueOnce({
      sessionId: 'background',
      path: '/tmp/wt/background',
    });
    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(mocks.worktreeListAll).toHaveBeenCalledOnce());

    act(() => emitSessionCreated('background'));

    await waitFor(() => {
      expect(view.getByTestId('ids').textContent).toBe('background:/tmp/wt/background');
    });
    expect(mocks.worktreeGetForSession).toHaveBeenCalledWith('background');
    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
  });

  it('does not run Git validation for a local background session without a worktree', async () => {
    mocks.worktreeListAll.mockResolvedValueOnce([]);
    mocks.worktreeGetForSession.mockResolvedValueOnce(null);
    render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(mocks.worktreeListAll).toHaveBeenCalledOnce());

    act(() => emitSessionCreated('notification-only'));

    await waitFor(() => {
      expect(mocks.worktreeGetForSession).toHaveBeenCalledWith('notification-only');
    });
    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
    expect(mocks.worktreeDetectCwd).not.toHaveBeenCalled();
  });

  it('refreshes explicit creation, recycling and restoration repeatedly without a full scan', async () => {
    mocks.worktreeListAll.mockResolvedValue([]);
    let refresh!: (sessionId: string) => Promise<void>;
    function Actions() {
      refresh = useRefreshWorktreeForSession();
      return <Probe />;
    }
    const view = render(<WorktreeProvider><Actions /></WorktreeProvider>);
    await act(async () => {});
    for (let i = 0; i < 3; i++) {
      mocks.worktreeGetForSession.mockResolvedValueOnce({
        sessionId: 'restored', path: `/tmp/wt/restored-${i}`,
      });
      await act(async () => { await refresh('restored'); });
      expect(view.getByTestId('ids').textContent).toBe(`restored:/tmp/wt/restored-${i}`);
      mocks.worktreeGetForSession.mockResolvedValueOnce(null);
      await act(async () => { emitWorktreeChanged('restored'); });
      expect(view.getByTestId('ids').textContent).toBe('');
    }
    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
    expect(mocks.worktreeGetForSession).toHaveBeenCalledTimes(6);
  });

  it('ignores remote session creation pushes for the local worktree cache', async () => {
    mocks.worktreeListAll.mockResolvedValueOnce([]);
    render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(mocks.worktreeListAll).toHaveBeenCalledOnce());

    act(() => {
      emitSessionCreated('remote-collision', {
        dataOwnerId: 'owner',
        ownerGeneration: 1,
      });
    });

    expect(mocks.worktreeGetForSession).not.toHaveBeenCalled();
    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
  });

  it('loads idle worktree metadata without Git probes or a periodic full scan', async () => {
    vi.useFakeTimers();
    mocks.worktreeListAll.mockResolvedValue(Array.from({ length: 69 }, (_, i) => ({
      sessionId: `session-${i}`,
      path: `/tmp/wt/${i}`,
    })));
    const view = render(<WorktreeProvider><Probe /></WorktreeProvider>);

    await act(async () => {});
    expect(view.getByTestId('ids').textContent).toContain('session-68:/tmp/wt/68');
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(15 * 60_000);
    });

    expect(mocks.worktreeListAll).toHaveBeenCalledOnce();
    expect(mocks.worktreeDetectCwd).not.toHaveBeenCalled();
  });

  it('keeps creation and recycling events newer than a pending metadata snapshot', async () => {
    let finishList!: (value: Array<{ sessionId: string; path: string }>) => void;
    mocks.worktreeListAll.mockImplementation(() => new Promise((resolve) => {
      finishList = resolve;
    }));
    mocks.worktreeGetForSession.mockImplementation(async (sessionId: string) => (
      sessionId === 'new' ? { sessionId, path: '/tmp/wt/new' } : null
    ));
    const view = render(<WorktreeProvider><Probe /></WorktreeProvider>);
    await act(async () => {
      emitSessionCreated('new');
      emitWorktreeChanged('recycled');
    });
    await act(async () => {
      finishList([{ sessionId: 'recycled', path: '/tmp/wt/recycled' }]);
    });
    expect(view.getByTestId('ids').textContent).toBe('new:/tmp/wt/new');
  });

  it('unsubscribes on unmount so a later push cannot refresh a dead tree', async () => {
    mocks.worktreeListAll.mockResolvedValue([]);
    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(mocks.worktreeListAll).toHaveBeenCalledTimes(1));

    view.unmount();
    expect(mocks.listeners.size).toBe(0);
    expect(mocks.sessionCreatedListeners.size).toBe(0);

    emitWorktreeChanged('archived-one');
    expect(mocks.worktreeListAll).toHaveBeenCalledTimes(1);
    expect(mocks.worktreeGetForSession).not.toHaveBeenCalled();
  });

  it('still mounts when the push channel is unavailable', async () => {
    // 老 preload / 非 Electron 宿主下 onWorktreeChanged 可能缺失，不能让 Provider 崩。
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { worktreeListAll: mocks.worktreeListAll },
    });
    mocks.worktreeListAll.mockResolvedValue([{ sessionId: 'only', path: '/tmp/wt/only' }]);

    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId('ids').textContent).toBe('only:/tmp/wt/only');
    });
  });

});
