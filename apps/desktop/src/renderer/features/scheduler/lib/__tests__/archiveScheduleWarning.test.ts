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
  getError: vi.fn(),
  pendingRefresh: vi.fn(),
  getSessionScheduleBindings: vi.fn(),
  getVisibleMergedRemoteSessions: vi.fn(),
  getSessionDeviceId: vi.fn(),
  getByFilter: vi.fn(),
  listRetainedWorkerProjections: vi.fn(),
  invoke: vi.fn(),
  listWorkersByLead: vi.fn(),
}));

vi.mock('../schedulesStore', () => ({
  schedulesStore: {
    ensure: mocks.ensure,
    getSnapshot: mocks.getSnapshot,
    getError: mocks.getError,
    pendingRefresh: mocks.pendingRefresh,
  },
}));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  remoteProjectsStore: {
    getSessionScheduleBindings: mocks.getSessionScheduleBindings,
    getVisibleMergedRemoteSessions: mocks.getVisibleMergedRemoteSessions,
    getSessionDeviceId: mocks.getSessionDeviceId,
  },
}));
vi.mock('@/lib/sessionsStore', () => ({
  sessionsStore: {
    getByFilter: mocks.getByFilter,
  },
}));
vi.mock('@/features/cc-agent/hooks/workerProjectionStore', () => ({
  listRetainedWorkerProjections: mocks.listRetainedWorkerProjections,
}));

import { setCurrentAuthDeviceId } from '@/lib/authDeviceIdStore';
import {
  archiveConfirmDescription,
  archiveDeleteScheduleWarning,
  archiveScheduleWarningMany,
  COLD_SCHEDULE_LOAD_WAIT_MS,
  deleteBoundSchedules,
  loadActiveBoundScheduleNames,
  loadActiveBoundSchedules,
  loadConfirmedActiveBoundScheduleNames,
} from '../archiveScheduleWarning';
import { __resetBindingMemoForTest } from '../scheduleBindingIndex';

const t = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key}${JSON.stringify(options)}` : key) as unknown as TFunction;

describe('loadActiveBoundScheduleNames', () => {
  beforeEach(() => {
    __resetBindingMemoForTest();
    setCurrentAuthDeviceId(null);
    mocks.ensure.mockReset();
    mocks.getSnapshot.mockReset();
    mocks.getError.mockReset().mockReturnValue(null);
    mocks.pendingRefresh.mockReset().mockReturnValue(null);
    mocks.getSessionScheduleBindings.mockReset().mockReturnValue([]);
    mocks.getVisibleMergedRemoteSessions.mockReset().mockReturnValue([]);
    mocks.getSessionDeviceId.mockReset().mockReturnValue(undefined);
    mocks.getByFilter.mockReset().mockReturnValue([]);
    mocks.listRetainedWorkerProjections.mockReset().mockReturnValue([]);
    mocks.invoke.mockReset().mockResolvedValue([]);
    mocks.listWorkersByLead.mockReset().mockResolvedValue([]);
    vi.stubGlobal('window', {
      electronAPI: {
        deviceLink: { invoke: mocks.invoke },
        localDb: { orcaWorkflows: { listWorkersByLead: mocks.listWorkersByLead } },
      },
    });
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

  // Review of PR 9147: silent archive has no confirm dialog, so "could not read" must not look like "no bindings".
  // Review of PR 9147: a failed refresh leaves the old cache in place with an error recorded.
  it('严格读取:上次刷新失败后留下的旧缓存不算读到', async () => {
    mocks.getSnapshot.mockReturnValue([{ id: 'a', name: 'Cached', status: 'active', targetSessionId: 'task' }]);
    mocks.getError.mockReturnValue('list failed');
    expect(await loadConfirmedActiveBoundScheduleNames([{ id: 'other' }])).toBeNull();
    expect((await loadActiveBoundScheduleNames([{ id: 'task' }])).get('task')).toEqual(['Cached']);
  });

  it('严格读取:读到了才给结果,超时、失败或只有可能过期的缓存时给 null', async () => {
    mocks.getSnapshot.mockReturnValue([{ id: 'a', name: 'Cached', status: 'active', targetSessionId: 'task' }]);
    expect((await loadConfirmedActiveBoundScheduleNames([{ id: 'task' }]))?.get('task')).toEqual(['Cached']);
    expect((await loadConfirmedActiveBoundScheduleNames([{ id: 'other' }]))?.size).toBe(0);

    vi.useFakeTimers();
    try {
      mocks.pendingRefresh.mockReturnValue(new Promise(() => {}));
      const stalled = loadConfirmedActiveBoundScheduleNames([{ id: 'task' }]);
      await vi.advanceTimersByTimeAsync(COLD_SCHEDULE_LOAD_WAIT_MS);
      expect(await stalled).toBeNull();

      mocks.pendingRefresh.mockReturnValue(null);
      mocks.invoke.mockReturnValue(new Promise(() => {}));
      mocks.getSessionScheduleBindings.mockReturnValue([]);
      const remote = loadConfirmedActiveBoundScheduleNames([{ id: 'a', deviceLinkDeviceId: 'mac-2' }]);
      await vi.advanceTimersByTimeAsync(COLD_SCHEDULE_LOAD_WAIT_MS);
      expect(await remote).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    mocks.invoke.mockReset().mockRejectedValue(new Error('offline'));
    expect(await loadConfirmedActiveBoundScheduleNames([{ id: 'a', deviceLinkDeviceId: 'mac-2' }])).toBeNull();
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

  // 规则：task-inbox.md / archive-pauses-automations.md；此前只按 Lead 自身 targetSessionId 查绑定，
  // 自动化挂在协同 Worker（同机或跨设备远端）上时，收件箱「完成」与归档确认都会漏判并直接归档 Lead。
  it('Orca Lead 汇总同机与跨设备活跃 Worker 绑定的自动化，忽略已释放或非 Lead 会话', async () => {
    setCurrentAuthDeviceId('laptop');
    mocks.getByFilter.mockReturnValue([
      { id: 'lead-local', status: 'active', orcaRole: 'lead' },
      { id: 'worker-local', status: 'active', orcaRole: 'worker', orcaLeadSessionId: 'lead-local' },
      { id: 'worker-archived', status: 'archived', orcaRole: 'worker', orcaLeadSessionId: 'lead-ended' },
      { id: 'lead-ended', status: 'active', orcaRole: null },
      {
        id: 'worker-on-laptop-for-mini',
        status: 'active',
        orcaRemoteLead: { leadDeviceId: 'mac-mini', leadSessionId: 'lead-mini', workerLabel: 'w1' },
      },
    ]);
    mocks.getVisibleMergedRemoteSessions.mockReturnValue([
      { id: 'lead-mini', status: 'active', orcaRole: 'lead', deviceLinkDeviceId: 'mac-mini' },
      {
        id: 'worker-on-mini',
        status: 'active',
        orcaRole: 'worker',
        orcaLeadSessionId: 'lead-mini',
        deviceLinkDeviceId: 'mac-mini',
      },
      {
        id: 'worker-remote-for-local',
        status: 'active',
        deviceLinkDeviceId: 'mac-mini',
        orcaRemoteLead: { leadDeviceId: 'laptop', leadSessionId: 'lead-local', workerLabel: 'relay' },
      },
      {
        id: 'worker-released',
        status: 'active',
        deviceLinkDeviceId: 'mac-mini',
        orcaRemoteLead: {
          leadDeviceId: 'laptop',
          leadSessionId: 'lead-ended',
          workerLabel: 'old',
          releasedAt: 1700000000000,
        },
      },
    ]);
    mocks.getSnapshot.mockReturnValue([
      { id: 's-local-w', name: 'Local PR Watch', status: 'active', targetSessionId: 'worker-local' },
      { id: 's-laptop-remote-w', name: 'Cross Watch', status: 'active', targetSessionId: 'worker-on-laptop-for-mini' },
      { id: 's-archived-w', name: 'Archived Watch', status: 'active', targetSessionId: 'worker-archived' },
    ]);
    mocks.invoke.mockImplementation(async (_device: string, channel: string) => {
      if (channel === 'local-db:orca-workflows:list-workers-by-lead') {
        return [
          { id: 'w-hidden', sessionId: 'worker-outside-window', role: 'developer', status: 'idle' },
        ];
      }
      return [
        { id: 's-mini-w', name: 'Mini Worker PR #11923', status: 'active', targetSessionId: 'worker-on-mini', cronExpr: '*/10 * * * *' },
        { id: 's-mini-hidden', name: 'Window Outside Watch', status: 'active', targetSessionId: 'worker-outside-window', cronExpr: '*/10 * * * *' },
        { id: 's-mini-remote-w', name: 'Remote Relay Follow', status: 'active', targetSessionId: 'worker-remote-for-local', cronExpr: '*/10 * * * *' },
        { id: 's-released', name: 'Released Watch', status: 'active', targetSessionId: 'worker-released', cronExpr: '*/10 * * * *' },
      ];
    });

    const result = await loadActiveBoundScheduleNames([
      { id: 'lead-local', orcaRole: 'lead' },
      { id: 'lead-mini', deviceLinkDeviceId: 'mac-mini', orcaRole: 'lead' },
      { id: 'lead-ended' },
    ]);

    expect(result.get('lead-local')).toEqual(['Local PR Watch', 'Remote Relay Follow']);
    expect(new Set(result.get('lead-mini'))).toEqual(
      new Set(['Mini Worker PR #11923', 'Cross Watch', 'Window Outside Watch']),
    );
    expect(result.has('lead-ended')).toBe(false);
    expect(
      mocks.invoke.mock.calls.filter(([, channel]) => channel === 'maker:schedule:list'),
    ).toHaveLength(1);
  });

  it('严格读取:Orca Lead 的跨设备 Worker 或远端 Worker 列表不可达时返回 null，不静默归档', async () => {
    setCurrentAuthDeviceId('laptop');
    mocks.getByFilter.mockReturnValue([{ id: 'lead-local', status: 'active', orcaRole: 'lead' }]);
    mocks.listWorkersByLead.mockResolvedValue([
      {
        id: 'w-1',
        sessionId: 'proxy-1',
        executionDevice: { deviceId: 'mac-mini', remoteSessionId: 'remote-w-1' },
      },
    ]);
    mocks.getSnapshot.mockReturnValue([]);
    mocks.invoke.mockRejectedValue(new Error('offline'));

    await expect(
      loadConfirmedActiveBoundScheduleNames([{ id: 'lead-local', orcaRole: 'lead' }]),
    ).resolves.toBeNull();
    await expect(
      loadConfirmedActiveBoundScheduleNames([{ id: 'lead-mini', deviceLinkDeviceId: 'mac-mini', orcaRole: 'lead' }]),
    ).resolves.toBeNull();
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

describe('loadActiveBoundSchedules and deleteBoundSchedules', () => {
  const deleteLocal = vi.fn();

  beforeEach(() => {
    __resetBindingMemoForTest();
    setCurrentAuthDeviceId(null);
    mocks.ensure.mockReset();
    mocks.getSnapshot.mockReset();
    mocks.getError.mockReset().mockReturnValue(null);
    mocks.pendingRefresh.mockReset().mockReturnValue(null);
    mocks.getSessionScheduleBindings.mockReset().mockReturnValue([]);
    mocks.getVisibleMergedRemoteSessions.mockReset().mockReturnValue([]);
    mocks.getSessionDeviceId.mockReset().mockReturnValue(undefined);
    mocks.getByFilter.mockReset().mockReturnValue([]);
    mocks.listRetainedWorkerProjections.mockReset().mockReturnValue([]);
    mocks.invoke.mockReset().mockResolvedValue([]);
    mocks.listWorkersByLead.mockReset().mockResolvedValue([]);
    deleteLocal.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal('window', {
      electronAPI: {
        deviceLink: { invoke: mocks.invoke },
        localDb: { orcaWorkflows: { listWorkersByLead: mocks.listWorkersByLead } },
        maker: { schedule: { delete: deleteLocal } },
      },
    });
  });

  it('区分可删除的用户自动化与不可从归档框删除的 project 自动化', async () => {
    mocks.getSnapshot.mockReturnValue([
      { id: 'u1', name: 'PR #1', status: 'active', source: 'user', targetSessionId: 'task' },
      { id: 'p1', name: 'Repo Lint', status: 'active', source: 'project', targetSessionId: 'task' },
    ]);

    const result = await loadActiveBoundSchedules([{ id: 'task' }]);

    expect(result.get('task')).toEqual([
      { id: 'u1', name: 'PR #1', deviceId: null, deletable: true },
      { id: 'p1', name: 'Repo Lint', deviceId: null, deletable: false },
    ]);
  });

  it('按本机/远程归属删除勾选自动化，跳过 project 项，幂等忽略已不存在，并汇总失败项', async () => {
    deleteLocal
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Schedule not found: local-gone'));
    mocks.invoke
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('device offline'));

    const outcome = await deleteBoundSchedules([
      { id: 'local-1', name: 'Local 1', deviceId: null, deletable: true },
      { id: 'local-gone', name: 'Already Gone', deviceId: null, deletable: true },
      { id: 'proj-1', name: 'Repo Config', deviceId: null, deletable: false },
      { id: 'remote-1', name: 'Remote OK', deviceId: 'mac-2', deletable: true },
      { id: 'remote-fail', name: 'Remote Fail', deviceId: 'mac-2', deletable: true },
    ]);

    expect(deleteLocal).toHaveBeenCalledTimes(2);
    expect(deleteLocal).toHaveBeenNthCalledWith(1, 'local-1');
    expect(deleteLocal).toHaveBeenNthCalledWith(2, 'local-gone');
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'mac-2', 'maker:schedule:delete', ['remote-1']);
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'mac-2', 'maker:schedule:delete', ['remote-fail']);
    expect(outcome.deleted.map((s) => s.id)).toEqual(['local-1', 'local-gone', 'remote-1']);
    expect(outcome.failed.map((s) => s.id)).toEqual(['remote-fail']);
  });

  it('archiveDeleteScheduleWarning 在空列表返回空串，非空时格式化自动化名称', () => {
    expect(archiveDeleteScheduleWarning(t, [])).toBe('');
    expect(archiveDeleteScheduleWarning(t, ['PR #13076'])).toContain(
      'ccAgent.sidebar.confirmArchive.deleteScheduleWarning{"count":1',
    );
  });
});
