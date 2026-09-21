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
  listSessionBackgroundTasksFor: vi.fn(),
  stopAgentTaskFor: vi.fn(),
}));

vi.mock('@/lib/makerTransport', () => ({
  isRemoteSession: (sessionId: string) => sessionId.startsWith('remote-'),
  isRemoteSessionSticky: (sessionId: string) =>
    sessionId.startsWith('remote-') || mocks.stickyRemoteIds.has(sessionId),
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
    transport.listSessionBackgroundTasksFor.mockImplementation(listTasks);
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

  it('远程镜像会话:照拉快照(隧道由 helper 负责),但不捕获对账候选集', async () => {
    renderHook(() => useBackgroundBashTasks('remote-s3', new Map(), true));
    await waitFor(() => expect(transport.listSessionBackgroundTasksFor).toHaveBeenCalledWith('remote-s3'));
    // 远程快照有老端降级空表窗口,不可当权威 —— 只 seed 不对账。
    expect(mocks.captureRunningClaudeTaskIds).not.toHaveBeenCalled();
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

  it('重连窗口(非粘滞误判本机、粘滞仍认远程):只 seed 不对账,空快照不收口', async () => {
    const sid = 's4-blip';
    mocks.stickyRemoteIds.add(sid);
    mocks.captureRunningClaudeTaskIds.mockReturnValue(new Set(['t-mirror-running']));

    renderHook(() => useBackgroundBashTasks(sid, new Map(), true));
    await waitFor(() => expect(listTasks).toHaveBeenCalledWith(sid));

    // 粘滞命中远程:候选集不捕获;本机空快照下 seed 不被调用(不得收口镜像任务)
    expect(mocks.captureRunningClaudeTaskIds).not.toHaveBeenCalled();
    expect(mocks.seedBackgroundTaskSnapshots).not.toHaveBeenCalled();

    // 快照非空:仍然 seed —— 粘滞远程会话的常规水合就走这条(不 non-空就无法
    // 把被控端运行中的任务带回控制端);代价是本机撞 id 的理论分支也会 seed,
    // 与后台任务面板（BackgroundTasksBody）同款取舍。
    listTasks.mockResolvedValueOnce({ tasks: [{ taskId: 't-new' }] });
    renderHook(() => useBackgroundBashTasks(sid, new Map(), false));
    await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(mocks.seedBackgroundTaskSnapshots).toHaveBeenCalledWith(sid, [{ taskId: 't-new' }], undefined);
  });
});
