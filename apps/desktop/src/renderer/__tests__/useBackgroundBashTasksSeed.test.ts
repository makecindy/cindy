// @vitest-environment jsdom

/**
 * useBackgroundBashTasks 快照水合接线:候选集在发起 IPC 前捕获并透传给
 * seedBackgroundTaskSnapshots(stale running 对账);空快照 + 空候选不打扰
 * store;远程镜像会话整条链路关闭。
 */

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  captureRunningClaudeTaskIds: vi.fn((): ReadonlySet<string> => new Set<string>()),
  seedBackgroundTaskSnapshots: vi.fn(),
}));

vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    captureRunningClaudeTaskIds: mocks.captureRunningClaudeTaskIds,
    seedBackgroundTaskSnapshots: mocks.seedBackgroundTaskSnapshots,
  },
}));

vi.mock('@/lib/makerTransport', () => ({
  isRemoteSession: (sessionId: string) => sessionId.startsWith('remote-'),
}));

import { useBackgroundBashTasks } from '@/hooks/useBackgroundBashTasks';

describe('useBackgroundBashTasks 快照水合 + 对账接线', () => {
  let listTasks: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // clearAllMocks 不清 mockReturnValue,显式回位空候选集,避免用例间串状态。
    mocks.captureRunningClaudeTaskIds.mockReturnValue(new Set<string>());
    listTasks = vi.fn(async () => ({ tasks: [] }));
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      maker: { listSessionBackgroundTasks: listTasks },
    };
  });

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
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

  it('远程镜像会话:不拉快照也不对账', async () => {
    renderHook(() => useBackgroundBashTasks('remote-s3', new Map(), true));
    await Promise.resolve();
    expect(listTasks).not.toHaveBeenCalled();
    expect(mocks.captureRunningClaudeTaskIds).not.toHaveBeenCalled();
  });
});
