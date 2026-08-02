import { describe, expect, it, vi } from 'vitest';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { unresponsiveDevicesStore } from '@/device-link/unresponsiveDevicesStore';
import {
  getScheduleIndexInvalidationVersion,
  invalidateOfflineScheduleIndexFailureFor,
  invalidateRunningSessionScheduleEntries,
  invalidateScheduleIndexForDevice,
  invalidateTransientScheduleIndexFailures,
  loadSessionScheduleIndex,
  loadSessionScheduleIndexThrottled,
  replaceSessionScheduleIndexEntries,
  resetScheduleIndexThrottleForTesting,
  SCHEDULE_INDEX_FAILURE_TTL_MS,
  SCHEDULE_INDEX_THROTTLE_TTL_MS,
} from '@/session/scheduleIndex';
import type { RemoteSessionScheduleInfo } from '@/session/sessionList';

function makerWithSchedules(
  listRuns: (scheduleId: string, limit?: number) => Promise<unknown>,
): Pick<MobileMakerTransport, 'schedule'> {
  return {
    schedule: {
      list: async () => [
        { id: 'sched-1', name: '巡检', status: 'active' },
        { id: 'broken', name: '失败任务', status: 'active' },
      ],
      listRuns,
    },
  } as unknown as Pick<MobileMakerTransport, 'schedule'>;
}

describe('scheduleIndex', () => {
  it('loads schedule unread and running metadata without failing the whole index on one bad schedule', async () => {
    const listRuns = vi.fn(async (scheduleId: string) => {
      if (scheduleId === 'broken') throw new Error('remote schedule runs unavailable');
      return [
        {
          id: 'run-unread',
          scheduleId: 'sched-1',
          sessionId: 'session-1',
          status: 'success',
          firedAt: Date.parse('2026-01-01T00:01:00.000Z'),
        },
        {
          id: 'run-running',
          scheduleId: 'sched-1',
          sessionId: 'session-1',
          status: 'running',
          firedAt: Date.parse('2026-01-01T00:02:00.000Z'),
        },
      ];
    });

    const index = await loadSessionScheduleIndex(makerWithSchedules(listRuns));

    expect(listRuns).toHaveBeenCalledWith('sched-1', 50);
    expect(listRuns).toHaveBeenCalledWith('broken', 50);
    expect(index.get('session-1')).toMatchObject({
      allSchedulesStopped: false,
      running: true,
      scheduleId: 'sched-1',
      scheduleName: '巡检',
      unreadCount: 1,
      unreadRunIds: ['run-unread'],
    });
  });

  it('only stops a multi-schedule session when every known binding is paused or expired', async () => {
    const maker = {
      schedule: {
        list: async () => [
          {
            id: 'active-without-run',
            name: '仍在运行',
            status: 'active',
            targetSessionId: 'session-mixed',
          },
          {
            id: 'paused',
            name: '已暂停',
            status: 'paused',
            targetSessionId: 'session-mixed',
          },
          {
            id: 'expired',
            name: '已过期',
            status: 'expired',
            targetSessionId: 'session-stopped',
          },
          {
            id: 'paused-stopped',
            name: '也已暂停',
            status: 'paused',
            targetSessionId: 'session-stopped',
          },
        ],
        listRuns: async (scheduleId: string) => {
          if (scheduleId === 'paused') {
            return [{
              id: 'run-paused',
              scheduleId,
              sessionId: 'session-mixed',
              status: 'success',
              firedAt: 200,
            }];
          }
          if (scheduleId === 'expired') {
            return [{
              id: 'run-expired',
              scheduleId,
              sessionId: 'session-stopped',
              status: 'success',
              firedAt: 100,
            }];
          }
          if (scheduleId === 'paused-stopped') {
            return [{
              id: 'run-paused-stopped',
              scheduleId,
              sessionId: 'session-stopped',
              status: 'success',
              firedAt: 200,
            }];
          }
          return [];
        },
      },
    } as unknown as Pick<MobileMakerTransport, 'schedule'>;

    const index = await loadSessionScheduleIndex(maker);

    expect(index.get('session-mixed')).toMatchObject({
      scheduleStatus: 'paused',
      allSchedulesStopped: false,
    });
    expect(index.get('session-stopped')).toMatchObject({
      scheduleStatus: 'paused',
      allSchedulesStopped: true,
    });
  });

  it('indexes targetSessionId bindings before their first run', async () => {
    const maker = {
      schedule: {
        list: async () => [
          {
            id: 'paused-no-run',
            name: '等待恢复',
            status: 'paused',
            targetSessionId: 'session-paused-no-run',
          },
          {
            id: 'active-no-run',
            name: '等待首次执行',
            status: 'active',
            targetSessionId: 'session-active-no-run',
          },
        ],
        listRuns: async () => [],
      },
    } as unknown as Pick<MobileMakerTransport, 'schedule'>;

    const index = await loadSessionScheduleIndex(maker);

    expect(index.get('session-paused-no-run')).toMatchObject({
      scheduleId: 'paused-no-run',
      scheduleName: '等待恢复',
      scheduleStatus: 'paused',
      allSchedulesStopped: true,
      unreadRunIds: [],
      unreadCount: 0,
      running: false,
      latestRunAt: 0,
    });
    expect(index.get('session-active-no-run')).toMatchObject({
      scheduleId: 'active-no-run',
      scheduleStatus: 'active',
      allSchedulesStopped: false,
    });
  });

  it('ignores historical runs after a schedule is rebound to another session', async () => {
    const maker = {
      schedule: {
        list: async () => [
          {
            id: 'rebound-active',
            name: '已改绑任务',
            status: 'active',
            targetSessionId: 'session-new',
          },
          {
            id: 'paused-old',
            name: '旧会话暂停任务',
            status: 'paused',
            targetSessionId: 'session-old',
          },
        ],
        listRuns: async (scheduleId: string) => scheduleId === 'rebound-active'
          ? [{
              id: 'historical-run',
              scheduleId,
              sessionId: 'session-old',
              status: 'success',
              firedAt: 200,
            }]
          : [],
      },
    } as unknown as Pick<MobileMakerTransport, 'schedule'>;

    const index = await loadSessionScheduleIndex(maker);

    expect(index.get('session-old')).toMatchObject({
      scheduleId: 'paused-old',
      scheduleStatus: 'paused',
      allSchedulesStopped: true,
      unreadCount: 0,
    });
    expect(index.get('session-new')).toMatchObject({
      scheduleId: 'rebound-active',
      scheduleStatus: 'active',
      allSchedulesStopped: false,
      unreadCount: 0,
    });
  });

  it('clears running only for soft-offline device sessions', () => {
    const current = new Map<string, RemoteSessionScheduleInfo>([
      ['session-1', { scheduleId: 'sched-1', scheduleName: 'Daily', scheduleStatus: 'active', allSchedulesStopped: false, unreadRunIds: ['run-1'], unreadCount: 1, running: true, latestRunAt: 2 }],
      ['session-2', { scheduleId: 'sched-2', scheduleName: 'Weekly', scheduleStatus: 'active', allSchedulesStopped: false, unreadRunIds: [], unreadCount: 0, running: false, latestRunAt: 3 }],
      ['other-device-session', { scheduleId: 'keep', scheduleName: 'Keep', scheduleStatus: 'paused', allSchedulesStopped: true, unreadRunIds: ['keep-run'], unreadCount: 1, running: true, latestRunAt: 4 }],
    ]);

    const next = invalidateRunningSessionScheduleEntries(current, ['session-1', 'session-2']);

    expect(next).not.toBe(current);
    expect(next.get('session-1')).toEqual({
      ...current.get('session-1'),
      running: false,
    });
    expect(next.get('session-2')).toBe(current.get('session-2'));
    expect(next.get('other-device-session')).toBe(current.get('other-device-session'));
  });

  it('keeps the existing map reference when no selected schedule is running', () => {
    const current = new Map<string, RemoteSessionScheduleInfo>([
      ['session-1', { scheduleId: 'sched-1', scheduleName: 'Daily', scheduleStatus: 'active', allSchedulesStopped: false, unreadRunIds: [], unreadCount: 0, running: false, latestRunAt: 2 }],
      ['other-device-session', { scheduleId: 'keep', scheduleName: 'Keep', scheduleStatus: 'active', allSchedulesStopped: false, unreadRunIds: [], unreadCount: 0, running: true, latestRunAt: 1 }],
    ]);

    const next = invalidateRunningSessionScheduleEntries(current, ['session-1', 'missing']);

    expect(next).toBe(current);
  });

  it('replaces only entries for the refreshed device sessions', () => {
    const current = new Map([
      ['session-1', { scheduleId: 'old', scheduleName: 'Old', allSchedulesStopped: false, unreadRunIds: ['old-run'], unreadCount: 1, running: false, latestRunAt: 1 }],
      ['other-device-session', { scheduleId: 'keep', scheduleName: 'Keep', allSchedulesStopped: false, unreadRunIds: ['keep-run'], unreadCount: 1, running: false, latestRunAt: 1 }],
    ]);
    const next = new Map([
      ['session-1', { scheduleId: 'new', scheduleName: 'New', allSchedulesStopped: false, unreadRunIds: [], unreadCount: 0, running: true, latestRunAt: 2 }],
      ['outside-refreshed-window', { scheduleId: 'ignored', scheduleName: 'Ignored', allSchedulesStopped: false, unreadRunIds: ['ignored'], unreadCount: 1, running: false, latestRunAt: 2 }],
    ]);

    const merged = replaceSessionScheduleIndexEntries(current, ['session-1', 'session-2'], next);

    expect(merged.get('session-1')).toMatchObject({ running: true, scheduleId: 'new' });
    expect(merged.get('other-device-session')).toMatchObject({ scheduleId: 'keep' });
    expect(merged.has('outside-refreshed-window')).toBe(false);
  });

  it('keeps the existing map reference when a refresh is value-equivalent', () => {
    const current = new Map<string, RemoteSessionScheduleInfo>([
      ['session-1', { scheduleId: 'sched-1', scheduleName: 'Daily', scheduleStatus: 'active', allSchedulesStopped: false, unreadRunIds: ['run-1'], unreadCount: 1, running: true, latestRunAt: 2 }],
      ['other-device-session', { scheduleId: 'keep', scheduleName: 'Keep', scheduleStatus: 'active', allSchedulesStopped: false, unreadRunIds: [], unreadCount: 0, running: false, latestRunAt: 1 }],
    ]);
    const next = new Map<string, RemoteSessionScheduleInfo>([
      ['session-1', { scheduleId: 'sched-1', scheduleName: 'Daily', scheduleStatus: 'active', allSchedulesStopped: false, unreadRunIds: ['run-1'], unreadCount: 1, running: true, latestRunAt: 2 }],
    ]);

    const merged = replaceSessionScheduleIndexEntries(current, ['session-1'], next);

    expect(merged).toBe(current);
  });

  it('updates the map when only schedule status changes', () => {
    const current = new Map<string, RemoteSessionScheduleInfo>([
      ['session-1', { scheduleId: 'sched-1', scheduleName: 'Daily', scheduleStatus: 'active', allSchedulesStopped: false, unreadRunIds: [], unreadCount: 0, running: false, latestRunAt: 2 }],
    ]);
    const next = new Map<string, RemoteSessionScheduleInfo>([
      ['session-1', { scheduleId: 'sched-1', scheduleName: 'Daily', scheduleStatus: 'paused', allSchedulesStopped: true, unreadRunIds: [], unreadCount: 0, running: false, latestRunAt: 2 }],
    ]);

    const merged = replaceSessionScheduleIndexEntries(current, ['session-1'], next);

    expect(merged).not.toBe(current);
    expect(merged.get('session-1')?.scheduleStatus).toBe('paused');
    expect(merged.get('session-1')?.allSchedulesStopped).toBe(true);
  });
});

describe('loadSessionScheduleIndexThrottled (单飞 + TTL 节流)', () => {
  it('TTL 内的重复触发复用同一在途/已完成 promise,不重复加载', async () => {
    resetScheduleIndexThrottleForTesting();
    const load = vi.fn(async () => new Map<string, RemoteSessionScheduleInfo>());
    let clock = 1000;
    const now = () => clock;
    const first = loadSessionScheduleIndexThrottled('dev-1', load, { now });
    clock += 5_000;
    const second = loadSessionScheduleIndexThrottled('dev-1', load, { now });
    expect(second).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    await first;
  });

  it('TTL 过期后重新加载;不同 key 互不影响', async () => {
    resetScheduleIndexThrottleForTesting();
    const load = vi.fn(async () => new Map<string, RemoteSessionScheduleInfo>());
    let clock = 1000;
    const now = () => clock;
    await loadSessionScheduleIndexThrottled('dev-1', load, { now });
    clock += SCHEDULE_INDEX_THROTTLE_TTL_MS + 1;
    await loadSessionScheduleIndexThrottled('dev-1', load, { now });
    expect(load).toHaveBeenCalledTimes(2);
    await loadSessionScheduleIndexThrottled('dev-2', load, { now });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('force 绕过 TTL 立即重拉', async () => {
    resetScheduleIndexThrottleForTesting();
    const load = vi.fn(async () => new Map<string, RemoteSessionScheduleInfo>());
    const now = () => 1000;
    await loadSessionScheduleIndexThrottled('dev-1', load, { now });
    await loadSessionScheduleIndexThrottled('dev-1', load, { now, force: true });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('offline invalidation evicts success cache and increments generation', async () => {
    resetScheduleIndexThrottleForTesting();
    const load = vi.fn()
      .mockResolvedValueOnce(new Map([['s1', { running: true } as RemoteSessionScheduleInfo]]))
      .mockResolvedValueOnce(new Map([['s1', { running: false } as RemoteSessionScheduleInfo]]));
    const now = () => 1000;
    await loadSessionScheduleIndexThrottled('dev-1', load, { now });
    const before = getScheduleIndexInvalidationVersion('dev-1');
    invalidateScheduleIndexForDevice('dev-1');
    expect(getScheduleIndexInvalidationVersion('dev-1')).toBe(before + 1);
    const next = await loadSessionScheduleIndexThrottled('dev-1', load, { now });
    expect(next.get('s1')?.running).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('stale in-flight completion cannot repopulate after offline invalidation', async () => {
    resetScheduleIndexThrottleForTesting();
    let resolveLoad!: (value: Map<string, RemoteSessionScheduleInfo>) => void;
    const load = vi.fn(() => new Promise<Map<string, RemoteSessionScheduleInfo>>((resolve) => {
      resolveLoad = resolve;
    }));
    const first = loadSessionScheduleIndexThrottled('dev-1', load);
    invalidateScheduleIndexForDevice('dev-1');
    resolveLoad(new Map([['s1', { running: true } as RemoteSessionScheduleInfo]]));
    await first;
    expect(getScheduleIndexInvalidationVersion('dev-1')).toBe(1);
  });

  it('失败负缓存:reject 后 TTL 内复用同一次失败不重放批次,过期后正常重试', async () => {
    resetScheduleIndexThrottleForTesting();
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(new Map<string, RemoteSessionScheduleInfo>());
    let at = 1000;
    const now = () => at;
    await expect(loadSessionScheduleIndexThrottled('dev-1', load, { now })).rejects.toThrow('boom');
    // 失败时间戳写入是微任务,先让它落地。
    await Promise.resolve();
    // 失败 TTL 内的被动触发直接吃负缓存(同一个 rejected promise),不再压请求上管道:
    // 旧的「失败即清坑」+ 多触发源交叠,是被控端无响应时反复全量重放的放大器。
    at += SCHEDULE_INDEX_FAILURE_TTL_MS - 1;
    await expect(loadSessionScheduleIndexThrottled('dev-1', load, { now })).rejects.toThrow('boom');
    expect(load).toHaveBeenCalledTimes(1);
    // 负缓存过期后正常重试
    at += 1;
    await expect(loadSessionScheduleIndexThrottled('dev-1', load, { now })).resolves.toBeInstanceOf(Map);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('失败负缓存:force(用户显式动作)穿透负缓存立即重拉', async () => {
    resetScheduleIndexThrottleForTesting();
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(new Map<string, RemoteSessionScheduleInfo>());
    const now = () => 1000;
    await expect(loadSessionScheduleIndexThrottled('dev-1', load, { now })).rejects.toThrow('boom');
    await Promise.resolve();
    await expect(loadSessionScheduleIndexThrottled('dev-1', load, { now, force: true })).resolves.toBeInstanceOf(Map);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each(['NOT_CONNECTED', 'BACKPRESSURE'])(
    '瞬态失败(%s)的负缓存在重连失效钩子后立即重拉(review P1)',
    async (code) => {
    // 普通断线的负缓存若挺过重连,30s 内 reseed 会吃旧 rejected promise,
    // 详情页替换成空索引且无人补拉;rehydrate 开始时调用失效钩子解决。
    resetScheduleIndexThrottleForTesting();
    const load = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('not connected'), { code }))
      .mockResolvedValueOnce(new Map<string, RemoteSessionScheduleInfo>());
    const now = () => 1000;
    await expect(loadSessionScheduleIndexThrottled('dev-n', load, { now })).rejects.toMatchObject({
      code,
    });
    await Promise.resolve();
    // 失效前:TTL 内复用负缓存
    await expect(loadSessionScheduleIndexThrottled('dev-n', load, { now })).rejects.toMatchObject({
      code,
    });
    expect(load).toHaveBeenCalledTimes(1);
    // 重连(rehydrate 开始)→ 瞬态负缓存失效 → 立即重拉
    invalidateTransientScheduleIndexFailures();
    await expect(loadSessionScheduleIndexThrottled('dev-n', load, { now })).resolves.toBeInstanceOf(Map);
    expect(load).toHaveBeenCalledTimes(2);
    },
  );

  it('DEVICE_OFFLINE 负缓存:仅该设备 presence 恢复时失效,全局重连钩子不碰(review P1)', async () => {
    // DEVICE_OFFLINE 是逐设备状态:若挂在全局重连钩子上,B 设备的任何 rehydrate
    // 都会反复清掉仍离线的 A 设备的 30s 负缓存,请求风暴止损失效。
    resetScheduleIndexThrottleForTesting();
    const load = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('device offline'), { code: 'DEVICE_OFFLINE' }))
      .mockResolvedValueOnce(new Map<string, RemoteSessionScheduleInfo>());
    const now = () => 1000;
    await expect(loadSessionScheduleIndexThrottled('dev-o', load, { now })).rejects.toMatchObject({
      code: 'DEVICE_OFFLINE',
    });
    await Promise.resolve();
    // 全局重连钩子(NOT_CONNECTED 类专用)不清 DEVICE_OFFLINE 负缓存
    invalidateTransientScheduleIndexFailures();
    await expect(loadSessionScheduleIndexThrottled('dev-o', load, { now })).rejects.toMatchObject({
      code: 'DEVICE_OFFLINE',
    });
    expect(load).toHaveBeenCalledTimes(1);
    // 别的设备 presence 恢复也不清
    invalidateOfflineScheduleIndexFailureFor('dev-other');
    await expect(loadSessionScheduleIndexThrottled('dev-o', load, { now })).rejects.toMatchObject({
      code: 'DEVICE_OFFLINE',
    });
    expect(load).toHaveBeenCalledTimes(1);
    // 该设备 presence 恢复:立即失效、重拉
    invalidateOfflineScheduleIndexFailureFor('dev-o');
    await expect(loadSessionScheduleIndexThrottled('dev-o', load, { now })).resolves.toBeInstanceOf(Map);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('DEVICE_OFFLINE 的 message-only 形态同样按离线分类(review:不只认 code)', async () => {
    resetScheduleIndexThrottleForTesting();
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('[DEVICE_OFFLINE] target host not online'))
      .mockResolvedValueOnce(new Map<string, RemoteSessionScheduleInfo>());
    const now = () => 1000;
    await expect(loadSessionScheduleIndexThrottled('dev-m', load, { now })).rejects.toThrow('DEVICE_OFFLINE');
    await Promise.resolve();
    invalidateOfflineScheduleIndexFailureFor('dev-m');
    await expect(loadSessionScheduleIndexThrottled('dev-m', load, { now })).resolves.toBeInstanceOf(Map);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('末项竞态的 INVOKE_TIMEOUT 失败:熔断 open 时同样按未响应记负缓存,恢复即旁路', async () => {
    // 末项竞态抛的是原始 INVOKE_TIMEOUT(非快速失败码);节流层补查 store
    // (key 即 deviceId)才能让这类失败同样享受「恢复即旁路」。
    resetScheduleIndexThrottleForTesting();
    const load = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('invoke timed out'), { code: 'INVOKE_TIMEOUT' }))
      .mockResolvedValueOnce(new Map<string, RemoteSessionScheduleInfo>());
    const now = () => 1000;
    unresponsiveDevicesStore.markUnresponsive('dev-t');
    try {
      await expect(loadSessionScheduleIndexThrottled('dev-t', load, { now })).rejects.toMatchObject({
        code: 'INVOKE_TIMEOUT',
      });
      await Promise.resolve();
      unresponsiveDevicesStore.clearUnresponsive('dev-t');
      await expect(loadSessionScheduleIndexThrottled('dev-t', load, { now })).resolves.toBeInstanceOf(Map);
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      unresponsiveDevicesStore.clearUnresponsive('dev-t');
    }
  });

  it('DEVICE_UNRESPONSIVE 负缓存:熔断仍 open 时复用,恢复后立即旁路重拉(review P1)', async () => {
    // 熔断关闭触发的 reseed/重载若在失败 TTL 内吃到同一个 rejected promise,
    // 索引会被 catch 路径替换成空集,且无定时器在 TTL 过期后补拉——徽标要等
    // 无关触发源才回来。恢复(设备移出 unresponsive 集合)必须使负缓存失效。
    resetScheduleIndexThrottleForTesting();
    const unresponsiveError = Object.assign(
      new Error('target device dev-1 is unresponsive (circuit open)'),
      { code: 'DEVICE_UNRESPONSIVE' },
    );
    const load = vi.fn()
      .mockRejectedValueOnce(unresponsiveError)
      .mockResolvedValueOnce(new Map<string, RemoteSessionScheduleInfo>());
    const now = () => 1000;
    unresponsiveDevicesStore.markUnresponsive('dev-1');
    try {
      await expect(loadSessionScheduleIndexThrottled('dev-1', load, { now })).rejects.toMatchObject({
        code: 'DEVICE_UNRESPONSIVE',
      });
      await Promise.resolve();
      // 熔断仍 open:失败 TTL 内复用负缓存,不压请求
      await expect(loadSessionScheduleIndexThrottled('dev-1', load, { now })).rejects.toMatchObject({
        code: 'DEVICE_UNRESPONSIVE',
      });
      expect(load).toHaveBeenCalledTimes(1);
      // 设备恢复(探测成功关熔断):TTL 未过也立即旁路重拉
      unresponsiveDevicesStore.clearUnresponsive('dev-1');
      await expect(loadSessionScheduleIndexThrottled('dev-1', load, { now })).resolves.toBeInstanceOf(Map);
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      unresponsiveDevicesStore.clearUnresponsive('dev-1');
    }
  });

  it('DEVICE_UNRESPONSIVE:批循环命中立即止损并上抛,不产出部分索引', async () => {
    const listRuns = vi.fn(async () => {
      throw Object.assign(
        new Error('target device dev-1 is unresponsive (circuit open)'),
        { code: 'DEVICE_UNRESPONSIVE' },
      );
    });
    const maker = {
      schedule: {
        list: async () => [
          { id: 'sched-1', name: 'a', status: 'active', targetSessionId: 'session-a' },
          { id: 'sched-2', name: 'b', status: 'active' },
          { id: 'sched-3', name: 'c', status: 'active' },
        ],
        listRuns,
      },
    } as unknown as Pick<MobileMakerTransport, 'schedule'>;
    // 上抛而不是截断成功(review P1):部分索引若被当成功提交,会进入 30s 正
    // 缓存,首页/详情页拿着不完整徽标还以为是新鲜数据;上抛让节流层走失败负
    // 缓存,熔断恢复后重拉全量。
    await expect(loadSessionScheduleIndex(maker)).rejects.toMatchObject({
      code: 'DEVICE_UNRESPONSIVE',
    });
    // 熔断快速失败会在每个 listRuns 上重复出现:第一个命中后立即止损
    expect(listRuns).toHaveBeenCalledTimes(1);
  });

  it('末项竞态:最后一个 listRuns 的超时恰好开熔断时同样上抛,不产出部分索引(review P1)', async () => {
    // 该超时是凑满阈值的第 3 条:settle 开了熔断,但本次在途请求抛出的仍是
    // 原始 INVOKE_TIMEOUT 而非快速失败码——必须查实时熔断状态兜住。
    let calls = 0;
    const maker = {
      schedule: {
        list: async () => [
          { id: 'sched-1', name: 'a', status: 'active', targetSessionId: 'session-a' },
          { id: 'sched-2', name: 'b', status: 'active', targetSessionId: 'session-b' },
        ],
        listRuns: vi.fn(async () => {
          calls += 1;
          if (calls === 1) return [];
          throw Object.assign(new Error('invoke timed out'), { code: 'INVOKE_TIMEOUT' });
        }),
      },
    } as unknown as Pick<MobileMakerTransport, 'schedule'>;
    await expect(
      loadSessionScheduleIndex(maker, { isDeviceUnresponsive: () => calls >= 2 }),
    ).rejects.toMatchObject({ code: 'INVOKE_TIMEOUT' });
  });

  it('listRuns 串行执行(同一时刻最多一个在途,不挤占 device-link 管道)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const maker = {
      schedule: {
        list: async () => [
          { id: 'sched-1', name: 'a', status: 'active' },
          { id: 'sched-2', name: 'b', status: 'active' },
          { id: 'sched-3', name: 'c', status: 'active' },
        ],
        listRuns: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Promise.resolve();
          inFlight -= 1;
          return [];
        },
      },
    } as unknown as Pick<MobileMakerTransport, 'schedule'>;
    await loadSessionScheduleIndex(maker);
    expect(maxInFlight).toBe(1);
  });
});
