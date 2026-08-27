// @vitest-environment jsdom

/** WorktreeContext 全量校验只用于启动/聚焦；回收事件按 sessionId 增量更新。 */

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorktreeProvider, useWorktrees } from '@/contexts/WorktreeContext';
import { emitRefresh } from '@/lib/sessionsBus';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() }),
}));

const mocks = {
  worktreeListAll: vi.fn(),
  worktreeGetForSession: vi.fn(),
  worktreeDetectCwd: vi.fn(),
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

beforeEach(() => {
  mocks.worktreeListAll.mockReset();
  mocks.worktreeGetForSession.mockReset();
  mocks.worktreeDetectCwd.mockReset();
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
      onWorktreeChanged: (cb: (payload: { sessionId: string }) => void) => {
        mocks.listeners.add(cb);
        return () => mocks.listeners.delete(cb);
      },
      localDb: {
        sessionsPush: {
          onCreated: (
            cb: (payload: { sessionId: string }, ownerStamp?: unknown) => void,
          ) => {
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
});

describe('WorktreeContext recycle refresh', () => {
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
    expect(mocks.worktreeDetectCwd).toHaveBeenCalledTimes(2);
  });

  it('validates and updates only the reported worktree', async () => {
    mocks.worktreeListAll.mockResolvedValueOnce([
      { sessionId: 'changed', path: '/tmp/wt/old' },
      { sessionId: 'other', path: '/tmp/wt/other' },
    ]);
    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(mocks.worktreeDetectCwd).toHaveBeenCalledTimes(2));
    mocks.worktreeDetectCwd.mockClear();
    mocks.worktreeGetForSession.mockResolvedValueOnce({
      sessionId: 'changed',
      path: '/tmp/wt/new',
    });

    act(() => emitWorktreeChanged('changed'));

    await waitFor(() => {
      expect(view.getByTestId('ids').textContent).toContain('changed:/tmp/wt/new');
    });
    expect(mocks.worktreeListAll).toHaveBeenCalledTimes(1);
    expect(mocks.worktreeDetectCwd).toHaveBeenCalledOnce();
    expect(mocks.worktreeDetectCwd).toHaveBeenCalledWith({ cwd: '/tmp/wt/new' });
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

    expect(view.getByTestId('ids').textContent).toBe(
      'first:/tmp/wt/first,second:/tmp/wt/second',
    );
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
    expect(mocks.worktreeDetectCwd).toHaveBeenCalledOnce();
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

  it('still performs a full validation when the window regains focus', async () => {
    mocks.worktreeListAll.mockResolvedValue([]);
    render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );
    await waitFor(() => expect(mocks.worktreeListAll).toHaveBeenCalledOnce());

    act(() => window.dispatchEvent(new Event('focus')));

    await waitFor(() => expect(mocks.worktreeListAll).toHaveBeenCalledTimes(2));
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

  it('drops store entries whose directories are no longer linked worktrees', async () => {
    mocks.worktreeListAll.mockResolvedValue([
      { sessionId: 'gone', path: '/tmp/wt/gone' },
      { sessionId: 'live', path: '/tmp/wt/live' },
    ]);
    mocks.worktreeDetectCwd.mockImplementation(async ({ cwd }: { cwd: string }) => ({
      isInsideWorktree: cwd === '/tmp/wt/live',
      isGitRepo: true,
      gitInstalled: true,
    }));

    const view = render(
      <WorktreeProvider>
        <Probe />
      </WorktreeProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId('ids').textContent).toBe('live:/tmp/wt/live');
    });
  });
});
