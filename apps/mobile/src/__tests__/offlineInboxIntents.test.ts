import { beforeEach, describe, expect, it, vi } from 'vitest';

const { storage, asyncStorageMock } = vi.hoisted(() => {
  const storage = new Map<string, string>();
  const asyncStorageMock = {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      storage.delete(key);
    }),
    getAllKeys: vi.fn(async () => [...storage.keys()]),
    multiRemove: vi.fn(async (keys: string[]) => {
      for (const k of keys) storage.delete(k);
    }),
  };
  return { storage, asyncStorageMock };
});
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: asyncStorageMock,
}));

import {
  __testing,
  clearAllMobileOfflineInboxIntents,
  getMobileOfflineInboxIntent,
  getMobileOfflineInboxIntentsForDevice,
  hydrateMobileOfflineInboxIntents,
  queueMobileOfflineInboxComplete,
  queueMobileOfflineInboxSnooze,
  removeMobileOfflineInboxIntent,
  replayMobileOfflineInboxIntentsForDevice,
  subscribeMobileOfflineInboxIntents,
} from '@/session/offlineInboxIntents';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { RemoteSession } from '@/session/types';

/**
 * 测试价值
 * - 生产入口与可观察结果：Mobile 离线收件箱意图的按账号 AsyncStorage 持久化、写盘/撤销失败回滚、
 *   冷启动水合通知触发重放、remoteSessionStore.getHomeSessions() 乐观投影与 fail-closed 安全重放。
 * - Bug／规则依据：docs/product-rules/task-inbox.md「离线电脑任务的待同步处理」与
 *   docs/dev-rules/credentials-and-local-storage.md（按账号隔离、登出清空）。
 * - 现有覆盖缺口：既有 mobileHomeListCache / useSessionListActions 测试不覆盖离线收件箱队列、
 *   持久化失败回滚与重连 fail-closed 重放。
 * - 最小失败输入：写盘失败吞错导致 UI 假成功；离线完成在目标电脑自动化索引未就绪、IM 接管、
 *   共享任务活跃或 worktree 预检不可用时仍被静默归档；冷启动水合晚于首屏同步错过重放。
 * - tier：unit（node 环境 + 内存 AsyncStorage fake）。
 */
function makeSession(overrides: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id: 'sess-1',
    title: 'Mobile offline task',
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
    workingDir: '/repo/app',
    deviceLinkDeviceId: 'dev-1',
    deviceLinkDeviceName: 'Studio',
    imAttached: false,
    ...overrides,
  } as RemoteSession;
}

describe('mobile offlineInboxIntents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage.clear();
    __testing.reset();
    remoteSessionStore.clear();
  });

  it('persists per account, notifies subscribers on hydration, and clears on logout', async () => {
    const raw = makeSession();
    remoteSessionStore.setDeviceSessions('dev-1', 'Studio', [raw]);

    await queueMobileOfflineInboxComplete('user-a', 'dev-1', 'sess-1', raw);
    expect(remoteSessionStore.getHomeSessions()[0]?.status).toBe('archived');
    expect(remoteSessionStore.getSessions()[0]?.status).toBe('active');

    // Simulate cold restart where hydration finishes after home list mounted
    __testing.reset();
    expect(remoteSessionStore.getHomeSessions()[0]?.status).toBe('active');
    const onChange = vi.fn();
    const off = subscribeMobileOfflineInboxIntents(onChange);
    await hydrateMobileOfflineInboxIntents('user-a');
    off();
    expect(onChange).toHaveBeenCalled();
    expect(getMobileOfflineInboxIntent('dev-1', 'sess-1')?.kind).toBe('complete');
    expect(remoteSessionStore.getHomeSessions()[0]?.status).toBe('archived');

    // Different account must not read user-a's intents
    await hydrateMobileOfflineInboxIntents('user-b');
    expect(getMobileOfflineInboxIntent('dev-1', 'sess-1')).toBeUndefined();
    expect(remoteSessionStore.getHomeSessions()[0]?.status).toBe('active');

    // Logout wipes persisted intents across accounts
    await clearAllMobileOfflineInboxIntents();
    expect([...storage.keys()]).toEqual([]);
  });

  it('rolls back optimistic UI state and rejects when AsyncStorage write or undo fails', async () => {
    const raw = makeSession();
    remoteSessionStore.setDeviceSessions('dev-1', 'Studio', [raw]);

    asyncStorageMock.setItem.mockRejectedValueOnce(new Error('disk full'));
    await expect(queueMobileOfflineInboxComplete('user-a', 'dev-1', 'sess-1', raw)).rejects.toThrow('disk full');
    expect(getMobileOfflineInboxIntent('dev-1', 'sess-1')).toBeUndefined();
    expect(remoteSessionStore.getHomeSessions()[0]?.status).toBe('active');

    await queueMobileOfflineInboxComplete('user-a', 'dev-1', 'sess-1', raw);
    expect(remoteSessionStore.getHomeSessions()[0]?.status).toBe('archived');

    asyncStorageMock.removeItem.mockRejectedValueOnce(new Error('io error'));
    await expect(removeMobileOfflineInboxIntent('user-a', 'dev-1', 'sess-1')).rejects.toThrow('io error');
    expect(getMobileOfflineInboxIntent('dev-1', 'sess-1')?.kind).toBe('complete');
    expect(remoteSessionStore.getHomeSessions()[0]?.status).toBe('archived');
  });

  it('replays snooze and enforces fail-closed host checks on reconnect complete', async () => {
    const raw1 = makeSession({ id: 'sess-1' });
    const raw2 = makeSession({ id: 'sess-2', title: 'Dirty task' });
    const raw3 = makeSession({ id: 'sess-3', title: 'Shared task' });
    const raw4 = makeSession({ id: 'sess-4', title: 'Unknown preflight task' });
    const raw5 = makeSession({ id: 'sess-5', title: 'Automation task' });
    remoteSessionStore.setDeviceSessions('dev-1', 'Studio', [raw1, raw2, raw3, raw4, raw5]);

    const until = '2026-11-27T09:00:00.000Z';
    await queueMobileOfflineInboxSnooze('user-a', 'dev-1', 'sess-1', raw1, until);
    await queueMobileOfflineInboxComplete('user-a', 'dev-1', 'sess-2', raw2);
    await queueMobileOfflineInboxComplete('user-a', 'dev-1', 'sess-3', raw3);
    await queueMobileOfflineInboxComplete('user-a', 'dev-1', 'sess-4', raw4);
    await queueMobileOfflineInboxComplete('user-a', 'dev-1', 'sess-5', raw5);

    const patchMeta = vi.fn(async (_dev: string, id: string, patch: Record<string, unknown>) =>
      makeSession({ id, ...(patch as Partial<RemoteSession>) }),
    );
    const markAutomationTaskRead = vi.fn(async () => undefined);
    const notifyRejected = vi.fn();

    await replayMobileOfflineInboxIntentsForDevice({
      userId: 'user-a',
      deviceId: 'dev-1',
      getIntents: getMobileOfflineInboxIntentsForDevice,
      getCurrentIntent: getMobileOfflineInboxIntent,
      removeIntent: removeMobileOfflineInboxIntent,
      isStillCurrent: () => true,
      getCachedFreshSession: (_dev, id) => [raw1, raw2, raw3, raw4, raw5].find((s) => s.id === id),
      fetchFreshSession: async (_dev, id) => [raw1, raw2, raw3, raw4, raw5].find((s) => s.id === id) ?? null,
      isRunning: () => false,
      checkActiveBoundAutomation: async (_dev, session) => (session.id === 'sess-5' ? 'active' : 'none'),
      checkActiveOwnedSharedTask: async (_dev, id) => (id === 'sess-3' ? 'active' : 'inactive'),
      preflightWorktree: async (_dev, id) => (id === 'sess-2' ? 'dirty' : 'unknown'),
      patchMeta,
      applyPatchedSession: (dev, id, patch) => remoteSessionStore.applySessionPatch(dev, id, patch),
      markAutomationTaskRead,
      notifyRejected,
      notifySnoozeFailed: vi.fn(),
      nowMs: () => Date.parse('2026-11-26T11:00:00.000Z'),
    });

    expect(patchMeta).toHaveBeenCalledTimes(1);
    expect(patchMeta).toHaveBeenCalledWith('dev-1', 'sess-1', { snoozedUntil: until });
    expect(markAutomationTaskRead).toHaveBeenCalledWith('dev-1', raw5);
    expect(notifyRejected).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-2' }), 'dirty-worktree');
    expect(notifyRejected).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-3' }), 'attached');
    expect(notifyRejected).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-4' }), 'preflight-unknown');
    expect(getMobileOfflineInboxIntentsForDevice('dev-1')).toEqual([]);
  });
});
