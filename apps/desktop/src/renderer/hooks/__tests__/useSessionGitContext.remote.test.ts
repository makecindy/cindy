// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';

vi.mock('@/contexts/WorktreeContext', () => ({
  useWorktreeForSession: () => null,
}));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: () => undefined,
}));
// PR 缓存统一后 hook 消费 PrRefsProvider;provider 需要 owner id 才开始加载。
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ dataOwnerId: 'owner-1' }),
}));

import { useSessionGitContext } from '../useSessionGitContext';
import { PrRefsProvider } from '@/contexts/PrRefsContext';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';

/** 统一管线经 PrRefsProvider 拉取 PR;hook 测试统一套一层 provider。 */
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(PrRefsProvider, null, children);

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
    // PrRefsProvider 挂载即全量加载本地引用(统一缓存管线)。
    listAllPrRefs: vi.fn().mockResolvedValue([]),
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
    const { result, unmount } = renderHook(() => useSessionGitContext(session), { wrapper });

    await waitFor(() => expect(result.current.head?.branch).toBe('feature/ssh'));
    expect(gitContext.getForSession).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workingDir: '/remote/project',
      worktreePath: null,
      remoteHostId: 'ssh-1',
    });
    expect(gitContext.onChanged).not.toHaveBeenCalled();
    expect(gitContext.watch).not.toHaveBeenCalled();
    // SSH 会话的引用在本地 db,由统一缓存的全量加载覆盖(不再逐会话查询)。
    expect(gitContext.listAllPrRefs).toHaveBeenCalled();
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
    const { result, unmount } = renderHook(() => useSessionGitContext(session), { wrapper });

    await waitFor(() => {
      expect(result.current.head?.branch).toBe('feature/device');
      expect(result.current.prRefs).toHaveLength(1);
      expect(result.current.prStatuses.size).toBe(1);
    });
    expect(invoke).toHaveBeenCalledWith('device-1', 'git-context:get-for-session', [
      expect.objectContaining({ sessionId: 'session-1', remoteHostId: 'ssh-1' }),
    ]);
    expect(invoke).toHaveBeenCalledWith('device-1', 'git-context:pr-refs:list', ['session-1']);
    expect(invoke).toHaveBeenCalledWith('device-1', 'git-context:pr-status', [
      { sessionId: 'session-1', queries: [{ owner: 'octo', repo: 'repo', prNumber: 42 }] },
    ]);
    // 被控端引用/状态不得走本机 gitContext 直查(mockRejected 的三个方法未被吞错误)。
    expect(gitContext.onChanged).not.toHaveBeenCalled();
    // 注:onPrRefsChanged 由 PrRefsProvider 全局订阅一次(本地会话增量刷新),
    // 不再作为「device-link 不订阅本地事件」的判据;device-link 的隔离由
    // 「refs/状态经 deviceLink.invoke 而非本机 gitContext」两条断言保证。
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
      { initialProps: { session: first }, wrapper },
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

  // 2026-08-13 用户裁决:设备明确断线时不发注定失败的 PR 隧道查询(fail-open:
  // shard 缺失照常尝试,见 prRefsRefreshGating.test.ts 的判定语义)。
  it('被控端标记断线时跳过 PR 引用的隧道查询,重连后恢复', async () => {
    const gitContext = makeGitContext();
    const invoke = vi.fn(async (_deviceId: string, channel: string) => {
      if (channel === 'git-context:get-for-session') {
        return {
          workdir: '/controlled/repo',
          head: { kind: 'branch', branch: 'feature/offline', shortSha: null },
          source: 'remote',
        };
      }
      return [];
    });
    window.electronAPI = {
      gitContext,
      deviceLink: { invoke },
    } as never;

    const session = { ...sessionBase, deviceLinkDeviceId: 'device-1' };
    try {
      // 断线快照:shard 仍在(会话行留在侧栏),连接标记为 disconnected。
      remoteProjectsStore.setDeviceSessions('device-1', 'Test Device', [session]);
      remoteProjectsStore.markDeviceDisconnected('device-1');

      const first = renderHook(() => useSessionGitContext(session), { wrapper });
      await waitFor(() => expect(first.result.current.head?.branch).toBe('feature/offline'));
      // HEAD 走独立通道不受门控;PR 引用的隧道查询被跳过。
      expect(invoke).not.toHaveBeenCalledWith('device-1', 'git-context:pr-refs:list', [
        'session-1',
      ]);
      first.unmount();

      // 重连(权威列表再次到达)→ 下一个触发点(这里用重挂载等价周期/聚焦刷新)恢复查询。
      remoteProjectsStore.setDeviceSessions('device-1', 'Test Device', [session]);
      const second = renderHook(() => useSessionGitContext(session), { wrapper });
      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith('device-1', 'git-context:pr-refs:list', ['session-1']);
      });
      second.unmount();
    } finally {
      // 清掉 shard,别让断线标记漂进同文件其它用例。
      remoteProjectsStore.removeDevice('device-1');
    }
  });
});
