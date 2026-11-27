import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
 * - 生产入口与可观察结果：remoteProjectsStore 的离线意图投影、queue/remove 持久化失败回滚与抛错，
 *   以及 replayOfflineInboxIntentsForDevice 重连后的 fail-closed 安全重放（宿主机 imAttached、
 *   自动化绑定、共享任务、worktree 预检与瞬时断线保留队列）。
 * - Bug／规则依据：docs/product-rules/task-inbox.md「离线电脑任务的待同步处理」。
 * - 现有覆盖缺口：既有 remoteProjectsStore 测试只验证在线 pendingStatus，不覆盖离线收件箱意图投影、
 *   持久化失败回滚与重连 fail-closed 重放。
 * - 最小失败输入：宿主机离线期间被 IM 接管/开启共享/自动化检查失败/worktree 预检不可用仍静默归档，
 *   或本地落盘失败却吞错导致 UI 假成功。
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
    imAttached: false,
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
    fetchFreshSession: async (deviceId, sessionId) => {
      const found = remoteProjectsStore.getDeviceSessions(deviceId).find((s) => s.id === sessionId);
      return found ? { ...found, imAttached: found.imAttached ?? false } : null;
    },
    isRunning: () => false,
    checkActiveBoundAutomation: async () => 'none',
    checkActiveOwnedSharedTask: async () => 'inactive',
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
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    setDataOwnerGeneration('owner-1', 1);
    resetOfflineInboxIntents();
    remoteProjectsStore.clear();
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it('projects offline complete & snooze onto visible sessions without mutating raw shard', async () => {
    const hostSession = makeSession();
    remoteProjectsStore.hydrateFromCache([
      { deviceId: 'dev-1', deviceName: 'Office Mac', sessions: [hostSession] },
    ]);
    remoteProjectsStore.markDeviceDisconnected('dev-1');

    const until = '2026-11-27T09:00:00.000Z';
    await queueOfflineInboxSnooze('dev-1', 'sess-1', hostSession, until);
    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.snoozedUntil).toBe(until);
    expect(remoteProjectsStore.getDeviceSessions('dev-1')[0]?.snoozedUntil).toBeNull();

    await queueOfflineInboxComplete('dev-1', 'sess-1', hostSession);
    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.status).toBe('archived');
    expect(remoteProjectsStore.getDeviceSessions('dev-1')[0]?.status).toBe('active');

    await removeOfflineInboxIntent('dev-1', 'sess-1');
    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.status).toBe('active');
  });

  it('rolls back optimistic UI state and rejects when persistence fails on save or undo', async () => {
    const hostSession = makeSession();
    remoteProjectsStore.hydrateFromCache([
      { deviceId: 'dev-1', deviceName: 'Office Mac', sessions: [hostSession] },
    ]);
    remoteProjectsStore.markDeviceDisconnected('dev-1');

    const upsert = vi.fn<() => Promise<OfflineInboxIntent[]>>();
    const remove = vi.fn<() => Promise<OfflineInboxIntent[]>>();
    (globalThis as { window?: unknown }).window = {
      electronAPI: { deviceLink: { offlineInboxIntents: { upsert, remove } } },
    };

    // Save failure -> rolls back to active and rejects
    upsert.mockRejectedValueOnce(new Error('ENOSPC'));
    await expect(queueOfflineInboxComplete('dev-1', 'sess-1', hostSession)).rejects.toThrow('ENOSPC');
    expect(getOfflineInboxIntent('dev-1', 'sess-1')).toBeUndefined();
    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.status).toBe('active');

    // Save succeeds, then undo persistence fails -> restores queued complete and rejects
    upsert.mockImplementationOnce(async () => [getOfflineInboxIntent('dev-1', 'sess-1')!]);
    await queueOfflineInboxComplete('dev-1', 'sess-1', hostSession);
    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.status).toBe('archived');

    remove.mockRejectedValueOnce(new Error('EIO'));
    await expect(removeOfflineInboxIntent('dev-1', 'sess-1')).rejects.toThrow('EIO');
    expect(getOfflineInboxIntent('dev-1', 'sess-1')?.kind).toBe('complete');
    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.status).toBe('archived');
  });

  it('replays clean offline complete as archive on reconnect', async () => {
    const hostSession = makeSession({ imAttached: false });
    remoteProjectsStore.setDeviceSessions('dev-1', 'Office Mac', [hostSession], 'active');
    await queueOfflineInboxComplete('dev-1', 'sess-1', hostSession);

    const patchMeta = vi.fn(async () => makeSession({ status: 'archived' }));
    const deps = makeDeps({ patchMeta });
    await replayOfflineInboxIntentsForDevice('dev-1', deps);

    expect(patchMeta).toHaveBeenCalledWith('dev-1', 'sess-1', { status: 'archived' });
    expect(getOfflineInboxIntent('dev-1', 'sess-1')).toBeUndefined();
    expect(deps.notifyRejected).not.toHaveBeenCalled();
  });

  it('fails closed when host session is IM-attached, shared, dirty, or precondition checks are unknown', async () => {
    const hostSession = makeSession();
    remoteProjectsStore.setDeviceSessions('dev-1', 'Office Mac', [hostSession], 'active');

    // 1. Target host reports imAttached: true
    await queueOfflineInboxComplete('dev-1', 'sess-1', hostSession);
    const patchMeta = vi.fn();
    const notifyRejected = vi.fn();
    await replayOfflineInboxIntentsForDevice(
      'dev-1',
      makeDeps({
        fetchFreshSession: async () => makeSession({ imAttached: true }),
        patchMeta,
        notifyRejected,
      }),
    );
    expect(patchMeta).not.toHaveBeenCalled();
    expect(notifyRejected).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-1' }), 'attached');

    // 2. Older host omits imAttached (undefined) -> fails closed
    notifyRejected.mockClear();
    await queueOfflineInboxComplete('dev-1', 'sess-1', hostSession);
    await replayOfflineInboxIntentsForDevice(
      'dev-1',
      makeDeps({
        fetchFreshSession: async () => makeSession({ imAttached: undefined }),
        patchMeta,
        notifyRejected,
      }),
    );
    expect(patchMeta).not.toHaveBeenCalled();
    expect(notifyRejected).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-1' }), 'preflight-unknown');

    // 3. Automation lookup fails -> fails closed (never archives)
    notifyRejected.mockClear();
    await queueOfflineInboxComplete('dev-1', 'sess-1', hostSession);
    await replayOfflineInboxIntentsForDevice(
      'dev-1',
      makeDeps({
        checkActiveBoundAutomation: async () => 'unknown',
        patchMeta,
        notifyRejected,
      }),
    );
    expect(patchMeta).not.toHaveBeenCalled();
    expect(notifyRejected).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-1' }), 'preflight-unknown');

    // 4. Shared task check active / unknown -> fails closed
    notifyRejected.mockClear();
    await queueOfflineInboxComplete('dev-1', 'sess-1', hostSession);
    await replayOfflineInboxIntentsForDevice(
      'dev-1',
      makeDeps({
        checkActiveOwnedSharedTask: async () => 'active',
        patchMeta,
        notifyRejected,
      }),
    );
    expect(patchMeta).not.toHaveBeenCalled();
    expect(notifyRejected).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-1' }), 'attached');

    // 5. Dirty worktree -> bounces back
    notifyRejected.mockClear();
    await queueOfflineInboxComplete('dev-1', 'sess-1', hostSession);
    await replayOfflineInboxIntentsForDevice(
      'dev-1',
      makeDeps({ preflightWorktree: async () => 'dirty', patchMeta, notifyRejected }),
    );
    expect(patchMeta).not.toHaveBeenCalled();
    expect(remoteProjectsStore.getMergedRemoteSessions()[0]?.status).toBe('active');
    expect(notifyRejected).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-1' }), 'dirty-worktree');
  });

  it('bounces offline complete back when task had new activity while offline', async () => {
    const cachedSession = makeSession({ lastActivityAt: '2026-11-26T10:00:00.000Z' });
    await queueOfflineInboxComplete('dev-1', 'sess-1', cachedSession);

    const fresherHostSession = makeSession({ lastActivityAt: '2026-11-26T10:30:00.000Z', imAttached: false });
    remoteProjectsStore.setDeviceSessions('dev-1', 'Office Mac', [fresherHostSession], 'active');

    const patchMeta = vi.fn();
    const notifyRejected = vi.fn();
    await replayOfflineInboxIntentsForDevice('dev-1', makeDeps({ patchMeta, notifyRejected }));

    expect(patchMeta).not.toHaveBeenCalled();
    expect(getOfflineInboxIntent('dev-1', 'sess-1')).toBeUndefined();
    expect(notifyRejected).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-1' }), 'new-activity');
  });

  it('marks read instead of archiving when task is bound to an active automation', async () => {
    const hostSession = makeSession({ imAttached: false });
    remoteProjectsStore.setDeviceSessions('dev-1', 'Office Mac', [hostSession], 'active');
    await queueOfflineInboxComplete('dev-1', 'sess-1', hostSession);

    const patchMeta = vi.fn();
    const markAutomationTaskRead = vi.fn(async () => true);
    await replayOfflineInboxIntentsForDevice(
      'dev-1',
      makeDeps({ checkActiveBoundAutomation: async () => 'active', patchMeta, markAutomationTaskRead }),
    );

    expect(patchMeta).not.toHaveBeenCalled();
    expect(markAutomationTaskRead).toHaveBeenCalledWith('dev-1', 'sess-1');
    expect(getOfflineInboxIntent('dev-1', 'sess-1')).toBeUndefined();
  });

  it('keeps intent queued when replay hits transient errors', async () => {
    const hostSession = makeSession({ imAttached: false });
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
