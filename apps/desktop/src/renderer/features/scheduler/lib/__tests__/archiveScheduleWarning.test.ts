/**
 * archiveScheduleWarning — 归档前的自动化提醒:只算 active 绑定,本机与远程分别取数。
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TFunction } from 'i18next';

const mocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  getSnapshot: vi.fn(),
  pendingRefresh: vi.fn(),
  getSessionScheduleBindings: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('../schedulesStore', () => ({
  schedulesStore: {
    ensure: mocks.ensure,
    getSnapshot: mocks.getSnapshot,
    pendingRefresh: mocks.pendingRefresh,
  },
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: {
    getSessionScheduleBindings: mocks.getSessionScheduleBindings,
  },
}));

import {
  archiveConfirmDescription,
  archiveScheduleWarningMany,
  COLD_SCHEDULE_LOAD_WAIT_MS,
  loadActiveBoundScheduleNames,
} from '../archiveScheduleWarning';
import { __resetBindingMemoForTest } from '../scheduleBindingIndex';

const t = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key}${JSON.stringify(options)}` : key) as unknown as TFunction;

describe('loadActiveBoundScheduleNames', () => {
  beforeEach(() => {
    __resetBindingMemoForTest();
    mocks.ensure.mockReset();
    mocks.getSnapshot.mockReset();
    mocks.pendingRefresh.mockReset().mockReturnValue(null);
    mocks.getSessionScheduleBindings.mockReset().mockReturnValue([]);
    mocks.invoke.mockReset().mockResolvedValue([]);
    vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke: mocks.invoke } } });
  });

  it('只返回本机任务绑定的 active 自动化', async () => {
    mocks.ensure.mockResolvedValue([
      { id: 'a', name: 'Daily', status: 'active', targetSessionId: 'task' },
      { id: 'b', name: 'Paused', status: 'paused', targetSessionId: 'task' },
      { id: 'c', name: 'Other', status: 'active', targetSessionId: 'other' },
    ]);

    const result = await loadActiveBoundScheduleNames([{ id: 'task' }, { id: 'plain' }]);

    expect([...result]).toEqual([['task', ['Daily']]]);
  });

  it('远程任务总是直取最新绑定,每台设备一次,不信任本地镜像', async () => {
    mocks.invoke.mockResolvedValue([
      { id: 'r', name: 'Remote', status: 'active', targetSessionId: 'a', cronExpr: '* * * * *' },
    ]);

    const result = await loadActiveBoundScheduleNames([
      { id: 'a', deviceLinkDeviceId: 'mac-2' },
      { id: 'b', deviceLinkDeviceId: 'mac-2' },
    ]);

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith('mac-2', 'maker:schedule:list', [
      null,
      { sessionBindings: true },
    ]);
    expect(mocks.getSessionScheduleBindings).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled(); // 远程任务不读本机同 ID
    expect([...result]).toEqual([['a', ['Remote']]]);
  });

  it('远程直取失败或超时时退回镜像里已有的快照', async () => {
    vi.useFakeTimers();
    try {
      mocks.invoke.mockReturnValue(new Promise(() => {}));
      mocks.getSessionScheduleBindings.mockReturnValue([
        { id: 'm', name: 'Mirrored', status: 'active', targetSessionId: 'a' },
      ]);

      const pending = loadActiveBoundScheduleNames([{ id: 'a', deviceLinkDeviceId: 'mac-2' }]);
      await vi.advanceTimersByTimeAsync(COLD_SCHEDULE_LOAD_WAIT_MS);

      expect((await pending).get('a')).toEqual(['Mirrored']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('持续任务与普通绑定任务都会恢复原任务，均提示', async () => {
    mocks.ensure.mockResolvedValue([
      {
        id: 'p',
        name: 'Persistent',
        status: 'active',
        targetSessionId: 'task',
        persistentSession: true,
      },
      { id: 'h', name: 'Heartbeat', status: 'active', targetSessionId: 'task' },
    ]);

    const result = await loadActiveBoundScheduleNames([{ id: 'task' }]);

    expect(result.get('task')).toEqual(['Persistent', 'Heartbeat']);
  });

  it('有缓存时直接使用,不等列表请求', async () => {
    mocks.getSnapshot.mockReturnValue([
      { id: 'a', name: 'Cached', status: 'active', targetSessionId: 'task' },
    ]);
    mocks.ensure.mockReturnValue(new Promise(() => {}));

    const result = await loadActiveBoundScheduleNames([{ id: 'task' }]);

    expect(result.get('task')).toEqual(['Cached']);
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it('刷新在途时缓存可能过期,等那次请求而不是直接用旧缓存', async () => {
    mocks.getSnapshot.mockReturnValue([]);
    mocks.pendingRefresh.mockReturnValue(
      Promise.resolve([{ id: 'n', name: 'Fresh', status: 'active', targetSessionId: 'task' }]),
    );

    const result = await loadActiveBoundScheduleNames([{ id: 'task' }]);

    expect(result.get('task')).toEqual(['Fresh']);
  });

  it('刷新迟迟不返回时超时退回已有缓存', async () => {
    vi.useFakeTimers();
    try {
      mocks.getSnapshot.mockReturnValue([
        { id: 'a', name: 'Cached', status: 'active', targetSessionId: 'task' },
      ]);
      mocks.pendingRefresh.mockReturnValue(new Promise(() => {}));

      const pending = loadActiveBoundScheduleNames([{ id: 'task' }]);
      await vi.advanceTimersByTimeAsync(COLD_SCHEDULE_LOAD_WAIT_MS);

      expect((await pending).get('task')).toEqual(['Cached']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('本机与冷远程设备同时读取,共用一个等待窗口', async () => {
    vi.useFakeTimers();
    try {
      mocks.getSnapshot.mockReturnValue(null);
      mocks.ensure.mockReturnValue(new Promise(() => {}));
      mocks.invoke.mockReturnValue(new Promise(() => {}));

      const pending = loadActiveBoundScheduleNames([
        { id: 'local-task' },
        { id: 'remote-task', deviceLinkDeviceId: 'mac-2' },
      ]);
      await vi.advanceTimersByTimeAsync(COLD_SCHEDULE_LOAD_WAIT_MS);

      expect((await pending).size).toBe(0);
      expect(mocks.invoke).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('冷启动时最多等待一小段时间,超时按无绑定处理', async () => {
    vi.useFakeTimers();
    try {
      mocks.getSnapshot.mockReturnValue(null);
      mocks.ensure.mockReturnValue(new Promise(() => {}));

      const pending = loadActiveBoundScheduleNames([{ id: 'task' }]);
      await vi.advanceTimersByTimeAsync(COLD_SCHEDULE_LOAD_WAIT_MS);

      expect((await pending).size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('批量提示按绑定了自动化的任务数计数', async () => {
    mocks.ensure.mockResolvedValue([
      { id: 'a', name: 'A', status: 'active', targetSessionId: 't1' },
      { id: 'b', name: 'B', status: 'active', targetSessionId: 't1' },
      { id: 'c', name: 'C', status: 'active', targetSessionId: 't2' },
    ]);

    await expect(
      archiveScheduleWarningMany(t, [{ id: 't1' }, { id: 't2' }, { id: 't3' }]),
    ).resolves.toBe('ccAgent.sidebar.confirmArchive.scheduleWarningMany{"count":2}');
    mocks.ensure.mockResolvedValue([]);
    await expect(archiveScheduleWarningMany(t, [{ id: 't3' }])).resolves.toBe('');
  });
});

describe('archiveConfirmDescription', () => {
  it('无自动化、无改动时只有基础说明', () => {
    expect(archiveConfirmDescription(t, { dirtyWorktree: false, scheduleNames: [] })).toBe(
      'ccAgent.sidebar.confirmArchive.description',
    );
  });

  it('追加 worktree 警告与自动化提醒', () => {
    const text = archiveConfirmDescription(t, { dirtyWorktree: true, scheduleNames: ['Daily'] });
    expect(
      text.startsWith(
        'ccAgent.sidebar.confirmArchive.description ccAgent.sidebar.confirmArchive.dirtyWorktreeWarning ',
      ),
    ).toBe(true);
    expect(text).toContain('ccAgent.sidebar.confirmArchive.scheduleWarning{"count":1');
  });
});
