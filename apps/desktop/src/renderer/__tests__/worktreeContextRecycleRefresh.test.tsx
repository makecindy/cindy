// @vitest-environment jsdom

/**
 * WorktreeContext 必须等 main 的 worktree:changed 推送才能拿到回收后的真实快照。
 *
 * 归档/删除后 main 侧的回收是 fire-and-forget 的异步链（关子进程 → git worktree
 * remove → 文件系统清理），store 条目被移除的时刻远晚于状态 IPC 返回。调用方在
 * 动作里那次「顺手 refresh」几乎必然快照到仍然存在的旧条目，徽标会一直停在回收前
 * 的状态，直到某次无关刷新才纠正（codex review P1）。
 */

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorktreeProvider, useWorktrees } from '@/contexts/WorktreeContext';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() }),
}));

const mocks = {
  worktreeListAll: vi.fn(),
  worktreeDetectCwd: vi.fn(),
  listeners: new Set<(payload: { sessionId: string }) => void>(),
};

function emitWorktreeChanged(sessionId: string): void {
  mocks.listeners.forEach((cb) => cb({ sessionId }));
}

function Probe() {
  const metas = useWorktrees();
  return <span data-testid="ids">{Object.keys(metas).sort().join(',')}</span>;
}

beforeEach(() => {
  mocks.worktreeListAll.mockReset();
  mocks.worktreeDetectCwd.mockReset();
  mocks.worktreeDetectCwd.mockResolvedValue({
    isInsideWorktree: true,
    isGitRepo: true,
    gitInstalled: true,
  });
  mocks.listeners.clear();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      worktreeListAll: mocks.worktreeListAll,
      worktreeDetectCwd: mocks.worktreeDetectCwd,
      onWorktreeChanged: (cb: (payload: { sessionId: string }) => void) => {
        mocks.listeners.add(cb);
        return () => mocks.listeners.delete(cb);
      },
    },
  });
});

afterEach(() => {
  cleanup();
});

describe('WorktreeContext recycle refresh', () => {
  it('re-pulls the snapshot when main reports the recycle finished', async () => {
    // 归档动作那一刻回收还没跑完 —— listAll 仍然带着即将被回收的条目。
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
      expect(view.getByTestId('ids').textContent).toBe('archived-one,other');
    });

    // 回收链跑完，store 里已经没有那条了。
    mocks.worktreeListAll.mockResolvedValueOnce([{ sessionId: 'other', path: '/tmp/wt/other' }]);
    await act(async () => {
      emitWorktreeChanged('archived-one');
    });

    await waitFor(() => {
      expect(view.getByTestId('ids').textContent).toBe('other');
    });
    expect(mocks.worktreeListAll).toHaveBeenCalledTimes(2);
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

    emitWorktreeChanged('archived-one');
    expect(mocks.worktreeListAll).toHaveBeenCalledTimes(1);
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
      expect(view.getByTestId('ids').textContent).toBe('only');
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
      expect(view.getByTestId('ids').textContent).toBe('live');
    });
  });
});
