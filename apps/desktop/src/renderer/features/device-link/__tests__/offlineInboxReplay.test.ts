import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfflineInboxIntent } from '@cindy/maker-shared/offline-inbox-intent';
import type { Session } from '@/lib/ccAgent.types';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import {
  getOfflineInboxIntent,
  getOfflineInboxIntentsForDevice,
  queueOfflineInboxComplete,
  queueOfflineInboxSnooze,
  removeOfflineInboxIntent,
  resetOfflineInboxIntents,
} from '../offlineInboxIntentsStore';
import {
  replayOfflineInboxIntentsForDevice,
  type OfflineInboxReplayDeps,
} from '../offlineInboxReplay';
import { remoteProjectsStore } from '../remoteProjectsStore';

/**
 * 测试价值
 * - 生产入口与可观察结果：remoteProjectsStore 的离线意图投影、queue/remove 交互及
 *   replayOfflineInboxIntentsForDevice 重连后的安全重放（clean 归档、dirty 退回、自动化只标已读、
 *   新活动退回、瞬时断线保留队列）。
 * - Bug／规则依据：docs/product-rules/task-inbox.md「离线电脑任务的待同步处理」。
 * - 现有覆盖缺口：既有 remoteProjectsStore 测试只验证在线 pendingStatus，不覆盖离线收件箱意图投影与重放。
 * - 最小失败输入：离线完成一个有未提交改动的 worktree 任务，上线重放若不拦 dirty 预检会静默回收 worktree；
 *   或离线完成会污染 raw shard 镜像导致无法区分宿主机真值。
 * - tier：unit（纯 node、内存注入依赖，无真实 Electron/IPC）。
 */
function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    title: 'Offline task',
    status: 'active',
    source: 'desktop',
    createdAt: '2026-11-26T09:00:00.000Z',
    updatedAt: '2026-11-26T10:00:00.000Z',
    lastActivityAt: '2026-11-26T10:00:00.000Z',
    userSendAt: '2026-11-26T09:55:00.000Z',
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    agentKind: 'codex',
    workspaceKind: 'project',
    workingDir: '/repo/project',
    ...overrides,
  } as Session;
}

function makeDeps(overrides: Partial<OfflineInboxReplayDeps> = {}): OfflineInboxReplayDeps {
  return {
    getIntents: getOfflineInboxIntentsForDevice,
    getCurrentIntent: getOfflineInboxIntent,
    removeIntent: removeOfflineInboxIntent,
    isDeviceConnected: () => true,
    getCachedFreshSession: (deviceId, sessionId) =>
      remoteProjectsStore.getDeviceSessions(deviceId).find((s) => s.id === sessionId),
    fetchFreshSession: async () => null,
    isRunning: () => false,
    isAttached: async () => false,
    hasActiveBoundAutomation: () => false,
    hasActiveOwnedSharedTask: async () => false,
    preflightWorktree: async () => 'clean',
    patchMeta: async (_deviceId, _sessionId, patch) => makeSession(patch as Partial<Session>),
    applyPatchedSession: (deviceId, sessionId, patch) =>
      remoteProjectsStore.applyPatch(deviceId, sessionId, patch),
    markAutomationTaskRead: async () => true,
    notifyRejected: vi.fn(),
    notifySnoozeFailed: vi.fn(),
    nowMs: () => Date.parse('2026-11-26T11:00:00.000Z'),
    ...overrides,
  };
}

describe('offlineInboxIntents projection & replay', () => {
  beforeEach(() => {
    setDataOwnerGeneration('owner-1', 1);
    resetOfflineInboxIntents();
    remoteProjectsStore.clear();
  });

  it('projects offline complete & snooze onto visible sessions without mutating raw shard', async () => {
    const hostSession = makeSession();
    remoteProjectsStore.hydrateFromCache([
      { deviceId: 'dev-1', deviceName: 'Office Mac', sessions: [hostSession] },
    ]);
    remoteProjectsStore.markDeviceDisconnected('dev-1');

    // Queue offline snooze
    const until = '2026-11-27T09:00:00.000Z';
    await queueOfflineInboxSnooze('dev-1', 'sess-1', hostSession, until);
    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.snoozedUntil).toBe(until);
    // Raw host shard stays untouched
    expect(remoteProjectsStore.getDeviceSessions('dev-1')[0]?.snoozedUntil).toBeNull();

    // Queue offline complete -> projected as archived
    await queueOfflineInboxComplete('dev-1', 'sess-1', hostSession);
    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.status).toBe('archived');
    expect(remoteProjectsStore.getDeviceSessions('dev-1')[0]?.status).toBe('active');

    // Undo offline complete -> immediately returns to active without RPC
    await removeOfflineInboxIntent('dev-1', 'sess-1');
    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.status).toBe('active');
  });

  it('replays clean offline complete as archive on reconnect', async () => {
    const hostSession = makeSession();
    remoteProjectsStore.setDeviceSessions('dev-1', 'Office Mac', [hostSession], 'active');
    await queueOfflineInboxComplete('dev-1', 'sess-1', hostSession);

    const patchMeta = vi.fn(async () => makeSession({ status: 'archived' }));
    const deps = makeDeps({ patchMeta });
    await replayOfflineInboxIntentsForDevice('dev-1', deps);

    expect(patchMeta).toHaveBeenCalledWith('dev-1', 'sess-1', { status: 'archived' });
    expect(getOfflineInboxIntent('dev-1', 'sess-1')).toBeUndefined();
    expect(deps.notifyRejected).not.toHaveBeenCalled();
  });

  it('bounces offline complete back to Pending when worktree preflight is dirty', async () => {
    const hostSession = makeSession();
    remoteProjectsStore.setDeviceSessions('dev-1', 'Office Mac', [hostSession], 'active');
    await queueOfflineInboxComplete('dev-1', 'sess-1', hostSession);

    const patchMeta = vi.fn();
    const notifyRejected = vi.fn();
    await replayOfflineInboxIntentsForDevice(
      'dev-1',
      makeDeps({ preflightWorktree: async () => 'dirty', patchMeta, notifyRejected }),
    );

    expect(patchMeta).not.toHaveBeenCalled();
    expect(getOfflineInboxIntent('dev-1', 'sess-1')).toBeUndefined();
    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.status).toBe('active');
    expect(notifyRejected).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-1' }), 'dirty-worktree');
  });

  it('bounces offline complete back when task had new activity while offline', async () => {
    const cachedSession = makeSession({ lastActivityAt: '2026-11-26T10:00:00.000Z' });
    await queueOfflineInboxComplete('dev-1', 'sess-1', cachedSession);

    const fresherHostSession = makeSession({ lastActivityAt: '2026-11-26T10:30:00.000Z' });
    remoteProjectsStore.setDeviceSessions('dev-1', 'Office Mac', [fresherHostSession], 'active');

    const patchMeta = vi.fn();
    const notifyRejected = vi.fn();
    await replayOfflineInboxIntentsForDevice('dev-1', makeDeps({ patchMeta, notifyRejected }));

    expect(patchMeta).not.toHaveBeenCalled();
    expect(getOfflineInboxIntent('dev-1', 'sess-1')).toBeUndefined();
    expect(notifyRejected).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-1' }), 'new-activity');
  });

  it('marks read instead of archiving when task is bound to an active automation', async () => {
    const hostSession = makeSession();
    remoteProjectsStore.setDeviceSessions('dev-1', 'Office Mac', [hostSession], 'active');
    await queueOfflineInboxComplete('dev-1', 'sess-1', hostSession);

    const patchMeta = vi.fn();
    const markAutomationTaskRead = vi.fn(async () => true);
    await replayOfflineInboxIntentsForDevice(
      'dev-1',
      makeDeps({ hasActiveBoundAutomation: () => true, patchMeta, markAutomationTaskRead }),
    );

    expect(patchMeta).not.toHaveBeenCalled();
    expect(markAutomationTaskRead).toHaveBeenCalledWith('dev-1', 'sess-1');
    expect(getOfflineInboxIntent('dev-1', 'sess-1')).toBeUndefined();
  });

  it('keeps intent queued when replay hits a transient DEVICE_OFFLINE error', async () => {
    const hostSession = makeSession();
    remoteProjectsStore.setDeviceSessions('dev-1', 'Office Mac', [hostSession], 'active');
    const until = '2026-11-27T09:00:00.000Z';
    await queueOfflineInboxSnooze('dev-1', 'sess-1', hostSession, until);

    const notifySnoozeFailed = vi.fn();
    await replayOfflineInboxIntentsForDevice(
      'dev-1',
      makeDeps({
        patchMeta: async () => {
          throw new Error('[DEVICE_OFFLINE] peer disconnected');
        },
        notifySnoozeFailed,
      }),
    );

    const stillQueued: OfflineInboxIntent | undefined = getOfflineInboxIntent('dev-1', 'sess-1');
    expect(stillQueued?.kind).toBe('snooze');
    expect(stillQueued?.snoozedUntil).toBe(until);
    expect(notifySnoozeFailed).not.toHaveBeenCalled();
  });
});
