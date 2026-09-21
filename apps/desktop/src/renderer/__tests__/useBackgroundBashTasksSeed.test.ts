// @vitest-environment jsdom

/**
 * useBackgroundBashTasks 快照水合接线:候选集在发起 IPC 前捕获并透传给
 * seedBackgroundTaskSnapshots(stale running 对账);空快照 + 空候选不打扰
 * store。
 *
 * device-link 远程镜像会话同样拉快照 —— 路由交给 listSessionBackgroundTasksFor
 * (它按粘滞归属决定本机 IPC 还是隧道;路由本身在 makerTransportStopRouting 覆盖),
 * 本 hook 只负责「远程也不关闭运行集信号」+「粘滞远程只 seed 不对账」。
 */

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  captureRunningClaudeTaskIds: vi.fn((): ReadonlySet<string> => new Set<string>()),
  seedBackgroundTaskSnapshots: vi.fn(),
  // 粘滞判定可独立标记:覆盖「非粘滞误判本机、粘滞仍认远程」的重连窗口分支。
  stickyRemoteIds: new Set<string>(),
}));

vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    captureRunningClaudeTaskIds: mocks.captureRunningClaudeTaskIds,
    seedBackgroundTaskSnapshots: mocks.seedBackgroundTaskSnapshots,
  },
}));

const transport = vi.hoisted(() => ({
  readSessionBackgroundTasks: vi.fn(),
  listSessionBackgroundTasksFor: vi.fn(),
  stopAgentTaskFor: vi.fn(),
}));

vi.mock('@/lib/makerTransport', () => ({
  isRemoteSession: (sessionId: string) => sessionId.startsWith('remote-'),
  isRemoteSessionSticky: (sessionId: string) =>
    sessionId.startsWith('remote-') || mocks.stickyRemoteIds.has(sessionId),
  readSessionBackgroundTasks: transport.readSessionBackgroundTasks,
  listSessionBackgroundTasksFor: transport.listSessionBackgroundTasksFor,
  stopAgentTaskFor: transport.stopAgentTaskFor,
}));

import { useBackgroundBashTasks } from '@/hooks/useBackgroundBashTasks';

describe('useBackgroundBashTasks 快照水合 + 对账接线', () => {
  let listTasks: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // clearAllMocks 不清 mockReturnValue,显式回位空候选集,避免用例间串状态。
    mocks.captureRunningClaudeTaskIds.mockReturnValue(new Set<string>());
    listTasks = vi.fn(async () => ({ tasks: [] }));
    transport.readSessionBackgroundTasks.mockImplementation(async (sid: string) => {
      // 路由在**发起时**就定了(与真实实现同构):source 必须在 await 之前取,
      // 否则测试会掩盖「请求在飞期间归属才水合」的真实现象。
      const source =
        sid.startsWith('remote-') || mocks.stickyRemoteIds.has(sid) ? 'remote' : 'local';
      return { ...(await listTasks(sid)), source };
    });
    transport.listSessionBackgroundTasksFor.mockImplementation(async (sid: string) => {
      const { tasks, pendingContinuations } = await transport.readSessionBackgroundTasks(sid);
      return pendingContinuations === undefined ? { tasks } : { tasks, pendingContinuations };
    });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      maker: { listSessionBackgroundTasks: listTasks },
    };
  });

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    mocks.stickyRemoteIds.clear();
    vi.clearAllMocks();
  });

  it('候选集在发起 IPC 前捕获,空快照 + 非空候选仍触发 seed(对账信号)', async () => {
    const candidates = new Set(['t-stale']);
    mocks.captureRunningClaudeTaskIds.mockReturnValue(candidates);

    renderHook(() => useBackgroundBashTasks('s1', new Map(), true));

    await waitFor(() => {
      expect(mocks.seedBackgroundTaskSnapshots).toHaveBeenCalledWith('s1', [], {
        staleRunningCandidates: candidates,
      });
    });
    // 捕获必须先于 IPC 发起(时序契约:请求在飞窗口内新启动的任务不得进候选集)
    expect(mocks.captureRunningClaudeTaskIds.mock.invocationCallOrder[0]).toBeLessThan(
      listTasks.mock.invocationCallOrder[0],
    );
  });

  it('空快照 + 空候选:不打扰 store', async () => {
    renderHook(() => useBackgroundBashTasks('s2', new Map(), true));
    await waitFor(() => expect(listTasks).toHaveBeenCalled());
    expect(mocks.seedBackgroundTaskSnapshots).not.toHaveBeenCalled();
  });

  it('远程镜像会话:权威快照可收口 stale running(含 hook 运行集里的 PI 命令)', async () => {
    mocks.captureRunningClaudeTaskIds.mockReturnValue(new Set(['t-claude']));
    renderHook(() => useBackgroundBashTasks('remote-s3', new Map(), true));
    await waitFor(() =>
      expect(transport.readSessionBackgroundTasks).toHaveBeenCalledWith('remote-s3'),
    );
    // 权威远程空快照 + 非空候选 → 必须收口:否则被控端已停而镜像终态丢包时,
    // 控制端会永久保留 running 并反复提供「全部停止」(greptile P1)。
    await waitFor(() =>
      expect(mocks.seedBackgroundTaskSnapshots).toHaveBeenCalledWith('remote-s3', [], {
        staleRunningCandidates: new Set(['t-claude']),
      }),
    );
  });

  it('远程降级空表(source=null)不可当权威:只 seed 不收口', async () => {
    mocks.captureRunningClaudeTaskIds.mockReturnValue(new Set(['t-mirror']));
    transport.readSessionBackgroundTasks.mockResolvedValueOnce({ tasks: [], source: null });
    renderHook(() => useBackgroundBashTasks('remote-s6', new Map(), true));
    await waitFor(() => expect(transport.readSessionBackgroundTasks).toHaveBeenCalled());
    await Promise.resolve();
    // 老被控端无 channel / 隧道失败与「确实没有任务」不可区分 → 不得收口。
    expect(mocks.seedBackgroundTaskSnapshots).not.toHaveBeenCalled();
  });

  it('在飞窗口:响应落地前会话被识别为远程 → 整体丢弃本机快照,不收口', async () => {
    const sid = 's5-inflight';
    mocks.captureRunningClaudeTaskIds.mockReturnValue(new Set(['t-mirror']));
    let resolveList!: (v: { tasks: unknown[] }) => void;
    listTasks.mockReturnValue(
      new Promise((r) => {
        resolveList = r;
      }),
    );

    renderHook(() => useBackgroundBashTasks(sid, new Map(), true));
    await waitFor(() => expect(listTasks).toHaveBeenCalledWith(sid));

    // 请求在飞期间远程注册表完成会话水合
    mocks.stickyRemoteIds.add(sid);
    resolveList({ tasks: [] });
    await waitFor(() => expect(listTasks).toHaveBeenCalled());
    await Promise.resolve();

    expect(mocks.seedBackgroundTaskSnapshots).not.toHaveBeenCalled();
  });

  it('重连窗口(非粘滞误判本机、粘滞仍认远程):归属不符的整体丢弃,归属一致才收口', async () => {
    const sid = 's4-blip';
    mocks.stickyRemoteIds.add(sid);
    mocks.captureRunningClaudeTaskIds.mockReturnValue(new Set(['t-mirror-running']));

    // 本机来源(路由在发起时按旧归属定的)对远程会话无意义 → 整体丢弃
    transport.readSessionBackgroundTasks.mockResolvedValueOnce({ tasks: [], source: 'local' });
    renderHook(() => useBackgroundBashTasks(sid, new Map(), true));
    await waitFor(() => expect(transport.readSessionBackgroundTasks).toHaveBeenCalled());
    await Promise.resolve();
    expect(mocks.seedBackgroundTaskSnapshots).not.toHaveBeenCalled();

    // 归属一致的远程快照:非空照旧 seed(把被控端运行中的任务带回控制端)
    listTasks.mockResolvedValueOnce({ tasks: [{ taskId: 't-new' }] });
    renderHook(() => useBackgroundBashTasks(sid, new Map(), false));
    await waitFor(() => expect(transport.readSessionBackgroundTasks).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(mocks.seedBackgroundTaskSnapshots).toHaveBeenCalledWith(
        sid,
        [{ taskId: 't-new' }],
        { staleRunningCandidates: new Set(['t-mirror-running']) },
      ),
    );
  });
});
