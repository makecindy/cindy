// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';

vi.mock('@/contexts/WorktreeContext', () => ({
  useWorktreeForSession: () => null,
}));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: () => undefined,
}));

import { useSessionGitContext } from '../useSessionGitContext';

const sessionBase: Session = {
  id: 'session-1',
  userId: 'user-1',
  title: 'Remote task',
  workingDir: '/remote/project',
  workspaceKind: 'project',
  model: 'model',
  effort: 'medium',
  permissionMode: 'default',
  sdkSessionId: null,
  totalTokenUsage: 0,
  totalCostUsd: 0,
  contextTokens: 0,
  contextWindow: 1,
  fastMode: false,
  clearedAt: null,
  pinnedAt: null,
  userSendAt: null,
  status: 'active',
  agentKind: 'codex',
  extraDirs: [],
  remoteHostId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function makeGitContext() {
  return {
    getForSession: vi.fn(),
    watch: vi.fn().mockResolvedValue(undefined),
    unwatch: vi.fn().mockResolvedValue(undefined),
    onChanged: vi.fn(() => () => undefined),
    listPrRefs: vi.fn(),
    getPrStatuses: vi.fn(),
    onPrRefsChanged: vi.fn(() => () => undefined),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useSessionGitContext remote routing', () => {
  it('SSH 会话在本机 main 侧解析远端 HEAD,不注册本地 watcher', async () => {
    const gitContext = makeGitContext();
    gitContext.getForSession.mockResolvedValue({
      workdir: '/srv/project',
      head: { kind: 'branch', branch: 'feature/ssh', shortSha: null },
      source: 'remote',
    });
    gitContext.listPrRefs.mockResolvedValue([]);
    gitContext.getPrStatuses.mockResolvedValue([]);
    window.electronAPI = {
      gitContext,
      deviceLink: { invoke: vi.fn() },
    } as never;

    const session = { ...sessionBase, remoteHostId: 'ssh-1' };
    const { result, unmount } = renderHook(() => useSessionGitContext(session));

    await waitFor(() => expect(result.current.head?.branch).toBe('feature/ssh'));
    expect(gitContext.getForSession).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workingDir: '/remote/project',
      worktreePath: null,
      remoteHostId: 'ssh-1',
    });
    expect(gitContext.onChanged).not.toHaveBeenCalled();
    expect(gitContext.watch).not.toHaveBeenCalled();
    expect(gitContext.listPrRefs).toHaveBeenCalledWith('session-1');
    unmount();
    expect(gitContext.unwatch).not.toHaveBeenCalled();
  });

  it('device-link 会话把 HEAD、PR 引用和状态查询全部发往被控端', async () => {
    const gitContext = makeGitContext();
    const invoke = vi.fn(async (_deviceId: string, channel: string) => {
      if (channel === 'git-context:get-for-session') {
        return {
          workdir: '/controlled/repo',
          head: { kind: 'branch', branch: 'feature/device', shortSha: null },
          source: 'remote',
        };
      }
      if (channel === 'git-context:pr-refs:list') {
        return [
          {
            id: 'ref-1',
            sessionId: 'session-1',
            owner: 'octo',
            repo: 'repo',
            prNumber: 42,
            url: 'https://github.com/octo/repo/pull/42',
            firstSeenAt: 1,
            lastSeenAt: 2,
          },
        ];
      }
      return [
        {
          ok: true,
          owner: 'octo',
          repo: 'repo',
          prNumber: 42,
          status: 'open',
          title: 'Remote PR',
          htmlUrl: 'https://github.com/octo/repo/pull/42',
          branch: 'feature/device',
          unresolvedCount: 0,
        },
      ];
    });
    gitContext.getForSession.mockRejectedValue(new Error('must use device-link'));
    gitContext.listPrRefs.mockRejectedValue(new Error('must use device-link'));
    gitContext.getPrStatuses.mockRejectedValue(new Error('must use device-link'));
    window.electronAPI = {
      gitContext,
      deviceLink: { invoke },
    } as never;

    const session = { ...sessionBase, deviceLinkDeviceId: 'device-1', remoteHostId: 'ssh-1' };
    const { result, unmount } = renderHook(() => useSessionGitContext(session));

    await waitFor(() => {
      expect(result.current.head?.branch).toBe('feature/device');
      expect(result.current.prRefs).toHaveLength(1);
      expect(result.current.prStatuses.size).toBe(1);
    });
    expect(invoke).toHaveBeenCalledWith(
      'device-1',
      'git-context:get-for-session',
      [expect.objectContaining({ sessionId: 'session-1', remoteHostId: 'ssh-1' })],
    );
    expect(invoke).toHaveBeenCalledWith('device-1', 'git-context:pr-refs:list', ['session-1']);
    expect(invoke).toHaveBeenCalledWith('device-1', 'git-context:pr-status', [
      { sessionId: 'session-1', queries: [{ owner: 'octo', repo: 'repo', prNumber: 42 }] },
    ]);
    expect(gitContext.onChanged).not.toHaveBeenCalled();
    expect(gitContext.onPrRefsChanged).not.toHaveBeenCalled();
    unmount();
    expect(gitContext.watch).not.toHaveBeenCalled();
    expect(gitContext.unwatch).not.toHaveBeenCalled();
  });

  it('切换任务或被控端断链时清掉旧的 Git / PR 展示', async () => {
    let disconnected = false;
    const gitContext = makeGitContext();
    const invoke = vi.fn(async (_deviceId: string, channel: string, args: unknown[]) => {
      if (disconnected) throw new Error('disconnected');
      if (channel === 'git-context:get-for-session') {
        return {
          workdir: '/controlled/repo',
          head: { kind: 'branch', branch: 'feature/device', shortSha: null },
          source: 'remote',
        };
      }
      if (channel === 'git-context:pr-refs:list') {
        return [
          {
            id: 'ref-1',
            sessionId: (args[0] as string) ?? 'session-1',
            owner: 'octo',
            repo: 'repo',
            prNumber: 42,
            url: 'https://github.com/octo/repo/pull/42',
            firstSeenAt: 1,
            lastSeenAt: 2,
          },
        ];
      }
      return [
        {
          ok: true,
          owner: 'octo',
          repo: 'repo',
          prNumber: 42,
          status: 'open',
          title: 'Remote PR',
          htmlUrl: 'https://github.com/octo/repo/pull/42',
          branch: 'feature/device',
          unresolvedCount: 0,
        },
      ];
    });
    window.electronAPI = {
      gitContext,
      deviceLink: { invoke },
    } as never;

    const first = { ...sessionBase, deviceLinkDeviceId: 'device-1' };
    const { result, rerender, unmount } = renderHook(
      ({ session }: { session: Session }) => useSessionGitContext(session),
      { initialProps: { session: first } },
    );
    await waitFor(() => {
      expect(result.current.head?.branch).toBe('feature/device');
      expect(result.current.prRefs).toHaveLength(1);
    });

    disconnected = true;
    rerender({ session: { ...first, id: 'session-2' } });
    await waitFor(() => {
      expect(result.current.head).toBeNull();
      expect(result.current.prRefs).toHaveLength(0);
      expect(result.current.prStatuses.size).toBe(0);
    });
    unmount();
  });
});
