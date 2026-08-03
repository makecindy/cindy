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
import { DEVICE_LINK_RECONCILIATION_PROBE_MARKER } from '@cindy/maker-shared/device-link-contract';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  refreshRemoteDeviceSessions,
  isTransientRemoteError,
} from '@/features/device-link/refreshRemoteSessions';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import {
  applyRemoteSessionActivity,
  clearRemoteSessionActivity,
  getRemoteSessionActivity,
} from '@/features/device-link/remoteSessionActivityStore';

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
  clearRemoteSessionActivity();
  vi.unstubAllGlobals();
});

function session(id: string, partial: Partial<Session> = {}): Session {
  return {
    id,
    userId: 'user-1',
    title: id,
    workingDir: null,
    workspaceKind: 'dialogue',
    model: 'model-1',
    effort: 'medium',
    permissionMode: 'default',
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindow: 0,
    fastMode: false,
    clearedAt: null,
    pinnedAt: null,
    userSendAt: null,
    status: 'active',
    agentKind: 'cc',
    extraDirs: [],
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    ...partial,
  };
}

function legacyMinimalSession(id: string) {
  return {
    id,
    title: id,
    workingDir: null,
    model: 'model-1',
    status: 'active',
    agentKind: 'cc',
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
  };
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

  it('非数组响应不得冒充成功或权威空列表', async () => {
    const d = did();
    invoke.mockResolvedValueOnce(null);

    await expect(refreshRemoteDeviceSessions(d, 'Mac B', { sleep: noSleep })).resolves.toBe(
      'gave-up',
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(remoteProjectsStore.hasDevice(d)).toBe(false);
  });

  it('空数组是权威空任务列表并正常发布', async () => {
    const d = did();
    invoke.mockResolvedValueOnce([]);

    await expect(refreshRemoteDeviceSessions(d, 'Mac B', { sleep: noSleep })).resolves.toBe('ok');

    expect(remoteProjectsStore.hasDevice(d)).toBe(true);
    expect(remoteProjectsStore.getDeviceSessions(d)).toEqual([]);
  });

  it('接受旧端最低任务列表形状，不强制要求新版附加字段', async () => {
    const d = did();
    invoke.mockResolvedValueOnce([legacyMinimalSession('legacy')]);

    await expect(refreshRemoteDeviceSessions(d, 'Mac B', { sleep: noSleep })).resolves.toBe('ok');

    expect(remoteProjectsStore.getDeviceSessions(d)).toEqual([
      expect.objectContaining({ id: 'legacy', title: 'legacy', status: 'active' }),
    ]);
  });

  it('数组混入非法会话时整份失败，保留旧 shard 且不部分应用', async () => {
    const d = did();
    remoteProjectsStore.setDeviceSessions(d, 'Mac B', [session('existing')]);
    invoke.mockResolvedValueOnce([session('fresh'), null]);

    await expect(refreshRemoteDeviceSessions(d, 'Mac B', { sleep: noSleep })).resolves.toBe(
      'gave-up',
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(remoteProjectsStore.getDeviceSessions(d).map((item) => item.id)).toEqual(['existing']);
  });

  it('active 列表混入非 active 会话时按协议损坏处理', async () => {
    const d = did();
    remoteProjectsStore.setDeviceSessions(d, 'Mac B', [session('existing')]);
    invoke.mockResolvedValueOnce([session('archived', { status: 'archived' })]);

    await expect(refreshRemoteDeviceSessions(d, 'Mac B', { sleep: noSleep })).resolves.toBe(
      'gave-up',
    );
    expect(remoteProjectsStore.getDeviceSessions(d).map((item) => item.id)).toEqual(['existing']);
  });

  it('损坏的满窗口响应不会触发 sessions:get 补查或改写旧 shard', async () => {
    const d = did();
    remoteProjectsStore.setDeviceSessions(d, 'Mac B', [session('outside-window')]);
    const malformed = [
      ...Array.from({ length: 199 }, (_, index) => session(`recent-${index}`)),
      null,
    ];
    invoke.mockResolvedValueOnce(malformed);

    await expect(refreshRemoteDeviceSessions(d, 'Mac B', { sleep: noSleep })).resolves.toBe(
      'gave-up',
    );

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(remoteProjectsStore.getDeviceSessions(d).map((item) => item.id)).toEqual([
      'outside-window',
    ]);
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

  it('超时类失败只额外重试 1 次:每次都吃满隧道超时,不许按完整预算连打 6 个', async () => {
    const d = did();
    invoke.mockRejectedValue(new Error('[DEVICE_LINK_TIMEOUT] no invoke-result within 12000ms'));
    await expect(refreshRemoteDeviceSessions(d, 'Mac B', { sleep: noSleep })).resolves.toBe(
      'gave-up',
    );
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('超时账本独立:一次超时不吞掉快速失败瞬态错误的完整预算', async () => {
    const d = did();
    invoke
      .mockRejectedValueOnce(new Error('[DEVICE_LINK_TIMEOUT] no invoke-result within 12000ms'))
      .mockRejectedValueOnce(new Error('DbClient not ready'))
      .mockRejectedValueOnce(new Error('DbClient not ready'))
      .mockResolvedValueOnce([session('s1')]);
    await expect(refreshRemoteDeviceSessions(d, 'Mac B', { sleep: noSleep })).resolves.toBe('ok');
    expect(invoke).toHaveBeenCalledTimes(4);
  });

  it('熔断快速失败(DEVICE_LINK_DEVICE_UNRESPONSIVE)→ 不重试,立即放弃', async () => {
    const d = did();
    invoke.mockRejectedValue(
      new Error('[DEVICE_LINK_DEVICE_UNRESPONSIVE] target device is unresponsive (circuit open)'),
    );
    await expect(refreshRemoteDeviceSessions(d, 'Mac B', { sleep: noSleep })).resolves.toBe(
      'gave-up',
    );
    expect(invoke).toHaveBeenCalledTimes(1);
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

  it('断连使在途快照失效 → 返回 superseded，不冒充终态请求失败', async () => {
    const d = did();
    const snapshot = deferred<Session[]>();
    invoke.mockReturnValueOnce(snapshot.promise);

    const refresh = refreshRemoteDeviceSessions(d, 'Mac B', { sleep: noSleep });
    remoteProjectsStore.markAllDisconnected();
    snapshot.resolve([session('stale')]);

    await expect(refresh).resolves.toBe('superseded');
    expect(remoteProjectsStore.getMergedRemoteSessions()).toHaveLength(0);
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
    const recent = Array.from({ length: 200 }, (_, index) =>
      session(`recent-${index}`, index === 0 ? { title: 'new' } : {}),
    );
    remoteProjectsStore.setDeviceSessions(d, 'Mac B', [
      session('recent-0', { title: 'old' }),
      session('outside-window'),
    ]);
    invoke
      .mockResolvedValueOnce(recent)
      .mockResolvedValueOnce(session('outside-window', { status: 'active' }));

    await refreshRemoteDeviceSessions(d, 'Mac B', {
      sleep: noSleep,
      snapshotMode: 'merge',
    });

    const merged = remoteProjectsStore.getMergedRemoteSessions();
    expect(merged).toHaveLength(201);
    expect(merged.map((s) => s.id)).toContain('outside-window');
    expect(merged[0].title).toBe('new');
    expect(invoke).toHaveBeenNthCalledWith(2, d, 'local-db:sessions:get', [
      'outside-window',
      DEVICE_LINK_RECONCILIATION_PROBE_MARKER,
    ]);
  });

  it('默认事件重拉也按有界快照 merge，保留 200 条窗口外的有效会话', async () => {
    const d = did();
    const recent = Array.from({ length: 200 }, (_, index) => session(`recent-${index}`));
    remoteProjectsStore.setDeviceSessions(d, 'Mac B', [session('outside-window')]);
    invoke
      .mockResolvedValueOnce(recent)
      .mockResolvedValueOnce(session('outside-window', { status: 'active' }));

    await refreshRemoteDeviceSessions(d, 'Mac B', { sleep: noSleep });

    expect(remoteProjectsStore.getMergedRemoteSessions()).toHaveLength(201);
    expect(remoteProjectsStore.getMergedRemoteSessions().map((s) => s.id)).toContain(
      'outside-window',
    );
  });

  it('周期快照未满 200 条时视为完整 active 集合并清理缺席行', async () => {
    const d = did();
    remoteProjectsStore.setDeviceSessions(d, 'Mac B', [
      session('fresh'),
      session('stale-archived'),
    ]);
    applyRemoteSessionActivity(d, {
      sessionId: 'stale-archived',
      phase: 'running',
      compactDetail: 'still running',
    });
    invoke.mockResolvedValueOnce([session('fresh')]);

    await refreshRemoteDeviceSessions(d, 'Mac B', {
      sleep: noSleep,
      snapshotMode: 'merge',
    });

    expect(remoteProjectsStore.getMergedRemoteSessions().map((s) => s.id)).toEqual(['fresh']);
    expect(getRemoteSessionActivity('stale-archived')).toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('周期满窗口用既有 sessions:get 有界补查并清理已归档的窗口外行', async () => {
    const d = did();
    const recent = Array.from({ length: 200 }, (_, index) => session(`recent-${index}`));
    remoteProjectsStore.setDeviceSessions(d, 'Mac B', [session('stale-archived')]);
    applyRemoteSessionActivity(d, {
      sessionId: 'stale-archived',
      phase: 'running',
      compactDetail: 'still running',
    });
    invoke
      .mockResolvedValueOnce(recent)
      .mockResolvedValueOnce(session('stale-archived', { status: 'archived' }));

    await refreshRemoteDeviceSessions(d, 'Mac B', {
      sleep: noSleep,
      snapshotMode: 'merge',
    });

    expect(remoteProjectsStore.getMergedRemoteSessions()).toHaveLength(200);
    expect(remoteProjectsStore.getMergedRemoteSessions().map((s) => s.id)).not.toContain(
      'stale-archived',
    );
    expect(getRemoteSessionActivity('stale-archived')).toBeUndefined();
  });

  it('周期满窗口补查 active 行时回填窗口外会话的权威元数据', async () => {
    const d = did();
    const recent = Array.from({ length: 200 }, (_, index) => session(`recent-${index}`));
    remoteProjectsStore.setDeviceSessions(d, 'Mac B', [
      session('outside-window', { title: 'old', pinnedAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    invoke
      .mockResolvedValueOnce(recent)
      .mockResolvedValueOnce(
        session('outside-window', { status: 'active', title: 'new', pinnedAt: null }),
      );

    await refreshRemoteDeviceSessions(d, 'Mac B', {
      sleep: noSleep,
      snapshotMode: 'merge',
    });

    expect(remoteProjectsStore.getDeviceSessions(d).find((s) => s.id === 'outside-window')).toEqual(
      expect.objectContaining({ title: 'new', pinnedAt: null }),
    );
  });

  it('周期满窗口每轮最多补查 8 个缺席缓存 id', async () => {
    const d = did();
    const recent = Array.from({ length: 200 }, (_, index) => session(`recent-${index}`));
    const outside = Array.from({ length: 12 }, (_, index) => session(`outside-${index}`));
    remoteProjectsStore.setDeviceSessions(d, 'Mac B', outside);
    invoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'local-db:sessions:list') return recent;
      return session(String(args[0]), { status: 'active' });
    });

    await refreshRemoteDeviceSessions(d, 'Mac B', {
      sleep: noSleep,
      snapshotMode: 'merge',
    });

    const probes = invoke.mock.calls.filter(([, channel]) => channel === 'local-db:sessions:get');
    expect(probes).toHaveLength(8);
    expect(remoteProjectsStore.getMergedRemoteSessions()).toHaveLength(212);
  });

  it('周期满窗口的相邻补查批次按 8 条推进，不重复检查上一批', async () => {
    const d = did();
    const recent = Array.from({ length: 200 }, (_, index) => session(`recent-${index}`));
    const outside = Array.from({ length: 20 }, (_, index) => session(`outside-${index}`));
    remoteProjectsStore.setDeviceSessions(d, 'Mac B', outside);
    invoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'local-db:sessions:list') return recent;
      return session(String(args[0]), { status: 'active' });
    });

    await refreshRemoteDeviceSessions(d, 'Mac B', {
      sleep: noSleep,
      snapshotMode: 'merge',
    });
    const firstProbeIds = invoke.mock.calls
      .filter(([, channel]) => channel === 'local-db:sessions:get')
      .map(([, , args]) => String(args[0]));

    invoke.mockClear();
    await refreshRemoteDeviceSessions(d, 'Mac B', {
      sleep: noSleep,
      snapshotMode: 'merge',
    });
    const secondProbeIds = invoke.mock.calls
      .filter(([, channel]) => channel === 'local-db:sessions:get')
      .map(([, , args]) => String(args[0]));

    expect(firstProbeIds).toHaveLength(8);
    expect(secondProbeIds).toHaveLength(8);
    expect(firstProbeIds).toEqual(outside.slice(0, 8).map((item) => item.id));
    expect(secondProbeIds).toEqual(outside.slice(8, 16).map((item) => item.id));
  });

  it('前一批移除终态行后，下一批仍从原队列的紧邻候选继续', async () => {
    const d = did();
    const recent = Array.from({ length: 200 }, (_, index) => session(`recent-${index}`));
    const outside = Array.from({ length: 20 }, (_, index) => session(`outside-${index}`));
    remoteProjectsStore.setDeviceSessions(d, 'Mac B', outside);
    invoke.mockImplementation(async (_deviceId, channel, args) => {
      if (channel === 'local-db:sessions:list') return recent;
      const sessionId = String(args[0]);
      return session(sessionId, {
        status: sessionId === 'outside-0' || sessionId === 'outside-1' ? 'archived' : 'active',
      });
    });

    await refreshRemoteDeviceSessions(d, 'Mac B', {
      sleep: noSleep,
      snapshotMode: 'merge',
    });
    invoke.mockClear();

    await refreshRemoteDeviceSessions(d, 'Mac B', {
      sleep: noSleep,
      snapshotMode: 'merge',
    });
    const secondProbeIds = invoke.mock.calls
      .filter(([, channel]) => channel === 'local-db:sessions:get')
      .map(([, , args]) => String(args[0]));

    expect(secondProbeIds).toEqual(outside.slice(8, 16).map((item) => item.id));
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

  it('慢周期 merge 在途时忽略后续周期 tick，不 bump epoch 自取消', async () => {
    const d = did();
    const snapshot = deferred<Session[]>();
    invoke.mockReturnValueOnce(snapshot.promise);

    const first = refreshRemoteDeviceSessions(d, 'Mac B', {
      sleep: noSleep,
      snapshotMode: 'merge',
      coalescingMode: 'weak',
    });
    const second = refreshRemoteDeviceSessions(d, 'Mac B', {
      sleep: noSleep,
      snapshotMode: 'merge',
      coalescingMode: 'weak',
    });

    snapshot.resolve([session('slow-but-valid')]);
    await expect(Promise.all([first, second])).resolves.toEqual(['ok', 'ok']);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(remoteProjectsStore.getMergedRemoteSessions().map((s) => s.id)).toEqual([
      'slow-but-valid',
    ]);
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

  it('事件型 refresh 排在弱周期 merge 后时保持强语义补跑', async () => {
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
      coalescingMode: 'weak',
    });
    const bootstrap = refreshRemoteDeviceSessions(d, 'Mac B', { sleep: noSleep });

    periodicSnapshot.resolve([session('stale')]);
    await replacementStarted.promise;
    replacementSnapshot.resolve([session('fresh')]);

    await expect(Promise.all([periodic, bootstrap])).resolves.toEqual(['ok', 'ok']);
    expect(remoteProjectsStore.getMergedRemoteSessions().map((s) => s.id)).toEqual(['fresh']);
  });

  it('事件型 refresh 在途时弱周期 tick 直接复用，不补跑也不取消当前请求', async () => {
    const d = did();
    remoteProjectsStore.setDeviceSessions(d, 'Mac B', [session('outside-window')]);
    const bootstrapSnapshot = deferred<Session[]>();
    invoke.mockReturnValueOnce(bootstrapSnapshot.promise);

    const bootstrap = refreshRemoteDeviceSessions(d, 'Mac B', { sleep: noSleep });
    const periodic = refreshRemoteDeviceSessions(d, 'Mac B', {
      sleep: noSleep,
      snapshotMode: 'merge',
      coalescingMode: 'weak',
    });

    bootstrapSnapshot.resolve([session('fresh')]);

    await expect(Promise.all([bootstrap, periodic])).resolves.toEqual(['ok', 'ok']);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(remoteProjectsStore.getMergedRemoteSessions().map((s) => s.id)).toEqual(['fresh']);
  });
});
