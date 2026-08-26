// @vitest-environment jsdom

/**
 * scheduleRunReadSync — 「标记已读动作 → renderer 本地无条件刷新」回归。
 *
 * 覆盖的缺陷(2026-07 双实例红点卡死):main 的 markRunRead / markAllRunsRead
 * 在 DB 已是已读时 no-op 且不广播事件,跨实例过期的未读红点因此永远等不到
 * 'read' 事件、无法自愈。本模块保证动作发起方在 IPC settle 后无条件通知本地
 * 订阅者——即使 main 全程 no-op、甚至 IPC 抛错。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  markAllScheduleRunsReadAndSync,
  markScheduleRunReadAndSync,
  markScheduleRunsReadAndSync,
  subscribeScheduleRunReadSync,
} from '../scheduleRunReadSync';

function stubScheduleApi(overrides: {
  markRunRead?: ReturnType<typeof vi.fn>;
  markAllRunsRead?: ReturnType<typeof vi.fn>;
}): { markRunRead: ReturnType<typeof vi.fn>; markAllRunsRead: ReturnType<typeof vi.fn> } {
  const markRunRead = overrides.markRunRead ?? vi.fn().mockResolvedValue(undefined);
  const markAllRunsRead = overrides.markAllRunsRead ?? vi.fn().mockResolvedValue(0);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: { schedule: { markRunRead, markAllRunsRead } },
  };
  return { markRunRead, markAllRunsRead };
}

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('scheduleRunReadSync', () => {
  it('批量标记:逐条打 IPC,settle 后通知订阅者(与 main 是否 no-op 无关)', async () => {
    const { markRunRead } = stubScheduleApi({});
    const listener = vi.fn();
    const off = subscribeScheduleRunReadSync(listener);
    try {
      await markScheduleRunsReadAndSync(['run-1', 'run-2']);
      expect(markRunRead).toHaveBeenCalledTimes(2);
      expect(markRunRead).toHaveBeenCalledWith('run-1');
      expect(markRunRead).toHaveBeenCalledWith('run-2');
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it('单条 IPC 拒绝不阻塞其余,也不吞掉刷新通知', async () => {
    const markRunRead = vi
      .fn()
      .mockRejectedValueOnce(new Error('already read (no-op)'))
      .mockResolvedValue(undefined);
    stubScheduleApi({ markRunRead });
    const listener = vi.fn();
    const off = subscribeScheduleRunReadSync(listener);
    try {
      await expect(markScheduleRunsReadAndSync(['run-1', 'run-2'])).resolves.toEqual({
        processed: ['run-2'],
        failed: ['run-1'],
        firstError: 'already read (no-op)',
      });
      expect(markRunRead).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it('单条包装转发到批量路径', async () => {
    const { markRunRead } = stubScheduleApi({});
    const listener = vi.fn();
    const off = subscribeScheduleRunReadSync(listener);
    try {
      await markScheduleRunReadAndSync('run-solo');
      expect(markRunRead).toHaveBeenCalledWith('run-solo');
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it('全部标已读:main 返回 0(全 no-op)也照样通知刷新', async () => {
    const { markAllRunsRead } = stubScheduleApi({});
    const listener = vi.fn();
    const off = subscribeScheduleRunReadSync(listener);
    try {
      await expect(markAllScheduleRunsReadAndSync()).resolves.toBe(0);
      expect(markAllRunsRead).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it('全部标已读 IPC 抛错:错误上抛给调用方(toast 路径),刷新仍执行', async () => {
    const markAllRunsRead = vi.fn().mockRejectedValue(new Error('ipc down'));
    stubScheduleApi({ markAllRunsRead });
    const listener = vi.fn();
    const off = subscribeScheduleRunReadSync(listener);
    try {
      await expect(markAllScheduleRunsReadAndSync()).rejects.toThrow('ipc down');
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it('退订后不再收到通知', async () => {
    stubScheduleApi({});
    const listener = vi.fn();
    const off = subscribeScheduleRunReadSync(listener);
    off();
    await markScheduleRunsReadAndSync(['run-1']);
    expect(listener).not.toHaveBeenCalled();
  });
});
