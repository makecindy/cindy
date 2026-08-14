import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const remoteDispatch = vi.fn();
vi.mock('@/lib/makerTransport', () => ({
  makerApiForDevice: () => ({ dispatchOrcaUiAssignment: remoteDispatch }),
}));

import {
  createDeferredUiAssignment,
  dispatchDeferredUiAssignment,
  getRecoverableDeferredUiAssignment,
  rememberDeferredUiAssignment,
  setDeferredUiAssignmentOwner,
} from '../deferredUiAssignment';

const localDispatch = vi.fn();
const storage = new Map<string, string>();

beforeEach(() => {
  vi.clearAllMocks();
  storage.clear();
  vi.stubGlobal('window', {
    electronAPI: { maker: { dispatchOrcaUiAssignment: localDispatch } },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  setDeferredUiAssignmentOwner('owner-1');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deferredUiAssignment', () => {
  it('只为显式 defer 的非空 initial_task 建立交接凭据', () => {
    expect(
      createDeferredUiAssignment({
        options: {
          workerAgent: 'codex',
          delegateTask: ' Review this PR ',
          deferDelegateTask: true,
        },
        workerSessionId: 'worker-1',
        snapshotBeforeMs: 123,
      }),
    ).toEqual({
      workerSessionId: 'worker-1',
      initialTask: 'Review this PR',
      snapshotBeforeMs: 123,
    });
    expect(
      createDeferredUiAssignment({
        options: { workerAgent: 'codex', delegateTask: 'Review this PR' },
        workerSessionId: 'worker-1',
        snapshotBeforeMs: 123,
      }),
    ).toBeUndefined();
  });

  it('accepted 后按交接归属派给本机或指定被控端', async () => {
    await dispatchDeferredUiAssignment('lead-1', {
      workerSessionId: 'worker-local',
      initialTask: 'Review local',
      snapshotBeforeMs: 101,
    });
    await dispatchDeferredUiAssignment('lead-2', {
      workerSessionId: 'worker-remote',
      initialTask: 'Review remote',
      snapshotBeforeMs: 202,
      deviceId: 'dev-1',
    });

    expect(localDispatch).toHaveBeenCalledWith(
      'lead-1',
      'worker-local',
      'Review local',
      101,
      true,
    );
    expect(remoteDispatch).toHaveBeenCalledWith(
      'lead-2',
      'worker-remote',
      'Review remote',
      202,
      true,
    );
  });

  it('可为不会写入 Lead history 的已消费命令跳过历史门控', async () => {
    await dispatchDeferredUiAssignment(
      'lead-1',
      {
        workerSessionId: 'worker-1',
        initialTask: 'Review independently',
        snapshotBeforeMs: 303,
      },
      { waitForLeadHistory: false },
    );

    expect(localDispatch).toHaveBeenCalledWith(
      'lead-1',
      'worker-1',
      'Review independently',
      303,
      false,
    );
  });

  it('持久化 pending 凭据供下一条 accepted 输入恢复，派发前先阻止自动重试', async () => {
    const assignment = {
      workerSessionId: 'worker-1',
      initialTask: 'Review after restart',
      snapshotBeforeMs: 404,
    };
    rememberDeferredUiAssignment('lead-1', assignment);

    localDispatch.mockRejectedValueOnce(new Error('response lost'));
    await expect(dispatchDeferredUiAssignment('lead-1', undefined)).rejects.toThrow(
      'response lost',
    );
    await dispatchDeferredUiAssignment('lead-1', undefined);

    // 第一次 invoke 可能已被 host 接受，uncertain 状态不会在下一次自动重试。
    expect(localDispatch).toHaveBeenCalledTimes(1);
  });

  it('只用 snapshot 之后已持久化的 Lead user history 恢复 pending 凭据', () => {
    rememberDeferredUiAssignment('lead-1', {
      workerSessionId: 'worker-1',
      initialTask: 'Review after restart',
      snapshotBeforeMs: 1_000,
    });

    expect(
      getRecoverableDeferredUiAssignment({
        leadSessionId: 'lead-1',
        messages: [
          { role: 'user', createdAt: new Date(1_100).toISOString(), isPendingPersist: true },
        ],
        remoteRouteUnavailable: false,
      }),
    ).toBeUndefined();
    expect(
      getRecoverableDeferredUiAssignment({
        leadSessionId: 'lead-1',
        messages: [
          { role: 'user', createdAt: new Date(999).toISOString() },
          { role: 'assistant', createdAt: new Date(1_100).toISOString() },
        ],
        remoteRouteUnavailable: false,
      }),
    ).toBeUndefined();
    expect(
      getRecoverableDeferredUiAssignment({
        leadSessionId: 'lead-1',
        messages: [{ role: 'user', createdAt: new Date(1_000).toISOString() }],
        remoteRouteUnavailable: false,
      }),
    ).toEqual(expect.objectContaining({ workerSessionId: 'worker-1' }));
  });

  it('远程 receipt 等归属设备恢复在线后才允许消费', () => {
    rememberDeferredUiAssignment('lead-remote', {
      workerSessionId: 'worker-remote',
      initialTask: 'Review remotely',
      snapshotBeforeMs: 1_000,
      deviceId: 'device-1',
    });
    const history = [{ role: 'user', createdAt: new Date(1_100).toISOString() }];

    expect(
      getRecoverableDeferredUiAssignment({
        leadSessionId: 'lead-remote',
        messages: history,
        remoteRouteUnavailable: false,
      }),
    ).toBeUndefined();
    expect(
      getRecoverableDeferredUiAssignment({
        leadSessionId: 'lead-remote',
        messages: history,
        deviceId: 'device-1',
        remoteRouteUnavailable: true,
      }),
    ).toBeUndefined();
    expect(
      getRecoverableDeferredUiAssignment({
        leadSessionId: 'lead-remote',
        messages: history,
        deviceId: 'device-1',
        remoteRouteUnavailable: false,
      }),
    ).toEqual(expect.objectContaining({ deviceId: 'device-1' }));
  });

  it('不恢复无 receipt 或已进入 uncertain 的派单', async () => {
    expect(
      getRecoverableDeferredUiAssignment({
        leadSessionId: 'lead-missing',
        messages: [{ role: 'user', createdAt: new Date(2_000).toISOString() }],
        remoteRouteUnavailable: false,
      }),
    ).toBeUndefined();

    rememberDeferredUiAssignment('lead-uncertain', {
      workerSessionId: 'worker-uncertain',
      initialTask: 'Review once',
      snapshotBeforeMs: 1_000,
    });
    localDispatch.mockRejectedValueOnce(new Error('response lost'));
    await expect(dispatchDeferredUiAssignment('lead-uncertain', undefined)).rejects.toThrow(
      'response lost',
    );
    expect(
      getRecoverableDeferredUiAssignment({
        leadSessionId: 'lead-uncertain',
        messages: [{ role: 'user', createdAt: new Date(2_000).toISOString() }],
        remoteRouteUnavailable: false,
      }),
    ).toBeUndefined();
  });

  it('显式 receipt 与恢复入口并发时，同一 Lead 只派一次', async () => {
    let release!: () => void;
    localDispatch.mockImplementationOnce(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    const assignment = {
      workerSessionId: 'worker-1',
      initialTask: 'Review once',
      snapshotBeforeMs: 505,
    };
    rememberDeferredUiAssignment('lead-1', assignment);

    const explicit = dispatchDeferredUiAssignment('lead-1', assignment);
    const recovered = dispatchDeferredUiAssignment('lead-1', undefined);
    expect(localDispatch).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([explicit, recovered]);

    expect(localDispatch).toHaveBeenCalledTimes(1);
  });

  it('派发成功后到达的 stale 显式 receipt 不会再次派单', async () => {
    const assignment = {
      workerSessionId: 'worker-stale',
      initialTask: 'Review once',
      snapshotBeforeMs: 606,
    };
    rememberDeferredUiAssignment('lead-stale', assignment);

    await dispatchDeferredUiAssignment('lead-stale', undefined);
    await dispatchDeferredUiAssignment('lead-stale', assignment);

    expect(localDispatch).toHaveBeenCalledTimes(1);
  });

  it('持久存储不可用且首个响应丢失时，内存 claim 仍阻止 stale receipt 重试', async () => {
    const assignment = {
      workerSessionId: 'worker-quota',
      initialTask: 'Review at most once',
      snapshotBeforeMs: 707,
    };
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    localDispatch.mockRejectedValueOnce(new Error('response lost'));

    await expect(
      dispatchDeferredUiAssignment('lead-quota', assignment),
    ).rejects.toThrow('response lost');
    await dispatchDeferredUiAssignment('lead-quota', assignment);

    expect(localDispatch).toHaveBeenCalledTimes(1);
  });

  it('读取时把超过七天的 initial_task 从持久存储清掉', async () => {
    storage.set(
      'xdt:deferredUiAssignment:v1:owner-1',
      JSON.stringify({
        'lead-1': {
          assignment: {
            workerSessionId: 'worker-1',
            initialTask: 'expired task',
            snapshotBeforeMs: 1,
          },
          state: 'pending',
          createdAt: 1,
        },
      }),
    );
    vi.spyOn(Date, 'now').mockReturnValue(8 * 24 * 60 * 60 * 1000);

    await dispatchDeferredUiAssignment('lead-1', undefined);

    expect(localDispatch).not.toHaveBeenCalled();
    expect(storage.has('xdt:deferredUiAssignment:v1:owner-1')).toBe(false);
  });
});
