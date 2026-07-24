/**
 * refreshRemoteSessionsRetry.test.ts —— 控制端首拉对「被控端刚上线 DB 未就绪」的瞬态重试。
 *
 * 真机实测根因:被控端宣布在线早于自身 localDb 迁移完成 → 控制端首拉 `local-db:sessions:list`
 * 撞「DbClient not ready」→ 旧实现静默放弃 → 控制端永远看不到被控端会话。本测试锁:
 *   - isTransientRemoteError 正确分类瞬态 / 永久错误;
 *   - 瞬态错误退避重试,直到成功 → setDeviceSessions(被控端会话出现在控制端);
 *   - 永久错误(被控开关关 / channel 不允许)立即放弃,不空转;
 *   - 重试耗尽后放弃,不抛。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  refreshRemoteDeviceSessions,
  isTransientRemoteError,
} from '@/features/device-link/refreshRemoteSessions';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';

const invoke = vi.fn();
let n = 0;
const did = () => `retry-dev-${n++}`;
const noSleep = async () => {};

beforeEach(() => {
  invoke.mockReset();
  vi.stubGlobal('window', { electronAPI: { deviceLink: { invoke } } });
});

afterEach(() => {
  remoteProjectsStore.clear();
  vi.unstubAllGlobals();
});

function session(id: string, partial: Partial<Session> = {}): Session {
  return { id, ...partial } as Session;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('isTransientRemoteError', () => {
  it('瞬态标记 → true', () => {
    expect(isTransientRemoteError('Error: DbClient not ready')).toBe(true);
    expect(isTransientRemoteError('[NOT_CONNECTED] not connected to relay')).toBe(true);
    expect(isTransientRemoteError('DEVICE_OFFLINE target device offline')).toBe(true);
    // invoke 超时:renderer 实际看到的是 main IPC 层映射后的 [DEVICE_LINK_TIMEOUT],
    // 而非原始 INVOKE_TIMEOUT —— 必须按映射后的码匹配才能触发瞬态重试。
    expect(isTransientRemoteError('[DEVICE_LINK_TIMEOUT] no result within 30000ms')).toBe(true);
  });
  it('永久标记 → false(即便含其它字样也不重试)', () => {
    expect(isTransientRemoteError('[REMOTE_DISABLED] remote control disabled')).toBe(false);
    expect(isTransientRemoteError("[CHANNEL_NOT_ALLOWED] channel 'x' not allowed")).toBe(false);
  });
  it('未知错误 → false(不空转)', () => {
    expect(isTransientRemoteError('some unexpected error')).toBe(false);
  });
});

describe('refreshRemoteDeviceSessions retry', () => {
  it('被控端 DB 未就绪:重试两次后成功 → 会话出现在控制端', async () => {
    const d = did();
    invoke
      .mockRejectedValueOnce(new Error('DbClient not ready'))
      .mockRejectedValueOnce(new Error('DbClient not ready'))
      .mockResolvedValueOnce([session('s1'), session('s2')]);

    await refreshRemoteDeviceSessions(d, 'Mac B', { sleep: noSleep });

    expect(invoke).toHaveBeenCalledTimes(3);
    const ids = remoteProjectsStore.getMergedRemoteSessions().map((s) => s.id);
    expect(ids).toContain('s1');
    expect(ids).toContain('s2');
  });

  it('永久错误(REMOTE_DISABLED)→ 不重试,立即放弃(返回 gave-up)', async () => {
    const d = did();
    invoke.mockRejectedValue(new Error('[REMOTE_DISABLED] remote control disabled'));
    await expect(refreshRemoteDeviceSessions(d, 'Mac B', { sleep: noSleep })).resolves.toBe(
      'gave-up',
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(remoteProjectsStore.getMergedRemoteSessions()).toHaveLength(0);
  });

  it('访问被撤销(DEVICE_LINK_ACCESS_REVOKED)→ 不重试,返回 revoked(调用方据此 handleRevoked)', async () => {
    const d = did();
    invoke.mockRejectedValue(new Error('[DEVICE_LINK_ACCESS_REVOKED] revoked'));
    await expect(refreshRemoteDeviceSessions(d, 'Mac B', { sleep: noSleep })).resolves.toBe(
      'revoked',
    );
    expect(invoke).toHaveBeenCalledTimes(1); // 终态,不重试
    expect(remoteProjectsStore.getMergedRemoteSessions()).toHaveLength(0);
  });

  it('重试耗尽 → 放弃,不抛(返回 gave-up,尝试次数 = maxAttempts)', async () => {
    const d = did();
    invoke.mockRejectedValue(new Error('DbClient not ready'));
    await expect(
      refreshRemoteDeviceSessions(d, 'Mac B', { sleep: noSleep, maxAttempts: 4 }),
    ).resolves.toBe('gave-up');
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(remoteProjectsStore.getMergedRemoteSessions()).toHaveLength(0);
  });

  it('首次即成功 → 不重试', async () => {
    const d = did();
    invoke.mockResolvedValueOnce([session('only')]);
    await refreshRemoteDeviceSessions(d, 'Mac B', { sleep: noSleep });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(remoteProjectsStore.getMergedRemoteSessions().map((s) => s.id)).toContain('only');
  });

  it('首拉 active 列表时要求被控端补齐置顶,避免旧置顶被 200 条窗口截掉', async () => {
    const d = did();
    invoke.mockResolvedValueOnce([
      session('recent-1'),
      session('recent-2'),
      session('old-pinned-1'),
      session('old-pinned-2'),
    ]);

    await refreshRemoteDeviceSessions(d, 'Mac B', { sleep: noSleep });

    expect(invoke).toHaveBeenCalledWith(d, 'local-db:sessions:list', [
      200,
      'active',
      { includePinned: true },
    ]);
    expect(remoteProjectsStore.getMergedRemoteSessions().map((s) => s.id)).toEqual([
      'recent-1',
      'recent-2',
      'old-pinned-1',
      'old-pinned-2',
    ]);
  });

  it('周期有界快照更新命中行但保留 200 条窗口外的有效会话', async () => {
    const d = did();
    remoteProjectsStore.setDeviceSessions(d, 'Mac B', [
      session('recent', { title: 'old' }),
      session('outside-window'),
    ]);
    invoke.mockResolvedValueOnce([session('recent', { title: 'new' })]);

    await refreshRemoteDeviceSessions(d, 'Mac B', {
      sleep: noSleep,
      snapshotMode: 'merge',
    });

    const merged = remoteProjectsStore.getMergedRemoteSessions();
    expect(merged.map((s) => s.id)).toEqual(['recent', 'outside-window']);
    expect(merged[0].title).toBe('new');
  });

  it('同设备并发重拉合并为单飞执行,期间新触发只补跑一次', async () => {
    const d = did();
    invoke.mockResolvedValueOnce([session('old')]).mockResolvedValueOnce([session('fresh')]);

    const first = refreshRemoteDeviceSessions(d, 'Mac B', { sleep: noSleep });
    const second = refreshRemoteDeviceSessions(d, 'Mac B', { sleep: noSleep });
    await expect(Promise.all([first, second])).resolves.toEqual(['ok', 'ok']);

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(remoteProjectsStore.getMergedRemoteSessions().map((s) => s.id)).toEqual(['fresh']);
  });

  it('同设备补跑排队时立即作废当前 snapshot,避免旧结果短暂覆盖 push 状态', async () => {
    const d = did();
    const firstSnapshot = deferred<Session[]>();
    const secondSnapshot = deferred<Session[]>();
    const secondStarted = deferred<void>();
    invoke.mockReturnValueOnce(firstSnapshot.promise).mockImplementationOnce(() => {
      secondStarted.resolve();
      return secondSnapshot.promise;
    });

    const first = refreshRemoteDeviceSessions(d, 'Mac B', { sleep: noSleep });
    const second = refreshRemoteDeviceSessions(d, 'Mac B', { sleep: noSleep });

    firstSnapshot.resolve([session('old')]);
    await secondStarted.promise;
    expect(remoteProjectsStore.getMergedRemoteSessions()).toHaveLength(0);

    secondSnapshot.resolve([session('fresh')]);
    await expect(Promise.all([first, second])).resolves.toEqual(['ok', 'ok']);
    expect(remoteProjectsStore.getMergedRemoteSessions().map((s) => s.id)).toEqual(['fresh']);
  });

  it('正常 refresh 排在周期 merge 后时恢复 replace 语义', async () => {
    const d = did();
    remoteProjectsStore.setDeviceSessions(d, 'Mac B', [session('outside-window')]);
    const periodicSnapshot = deferred<Session[]>();
    const replacementSnapshot = deferred<Session[]>();
    const replacementStarted = deferred<void>();
    invoke.mockReturnValueOnce(periodicSnapshot.promise).mockImplementationOnce(() => {
      replacementStarted.resolve();
      return replacementSnapshot.promise;
    });

    const periodic = refreshRemoteDeviceSessions(d, 'Mac B', {
      sleep: noSleep,
      snapshotMode: 'merge',
    });
    const bootstrap = refreshRemoteDeviceSessions(d, 'Mac B', { sleep: noSleep });

    periodicSnapshot.resolve([session('stale')]);
    await replacementStarted.promise;
    replacementSnapshot.resolve([session('fresh')]);

    await expect(Promise.all([periodic, bootstrap])).resolves.toEqual(['ok', 'ok']);
    expect(remoteProjectsStore.getMergedRemoteSessions().map((s) => s.id)).toEqual(['fresh']);
  });

  it('周期 merge 排在正常 refresh 后时不能降级 replace 语义', async () => {
    const d = did();
    remoteProjectsStore.setDeviceSessions(d, 'Mac B', [session('outside-window')]);
    const bootstrapSnapshot = deferred<Session[]>();
    const periodicSnapshot = deferred<Session[]>();
    const periodicStarted = deferred<void>();
    invoke.mockReturnValueOnce(bootstrapSnapshot.promise).mockImplementationOnce(() => {
      periodicStarted.resolve();
      return periodicSnapshot.promise;
    });

    const bootstrap = refreshRemoteDeviceSessions(d, 'Mac B', { sleep: noSleep });
    const periodic = refreshRemoteDeviceSessions(d, 'Mac B', {
      sleep: noSleep,
      snapshotMode: 'merge',
    });

    bootstrapSnapshot.resolve([session('stale')]);
    await periodicStarted.promise;
    periodicSnapshot.resolve([session('fresh')]);

    await expect(Promise.all([bootstrap, periodic])).resolves.toEqual(['ok', 'ok']);
    expect(remoteProjectsStore.getMergedRemoteSessions().map((s) => s.id)).toEqual(['fresh']);
  });
});
