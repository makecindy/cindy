import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
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
  },
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
} from '@/session/offlineInboxIntents';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { RemoteSession } from '@/session/types';

/**
 * 测试价值
 * - 生产入口与可观察结果：Mobile 离线收件箱意图的按账号 AsyncStorage 持久化、登出清空、
 *   remoteSessionStore.getHomeSessions() 乐观投影与重连后的安全重放。
 * - Bug／规则依据：docs/product-rules/task-inbox.md「离线电脑任务的待同步处理」与
 *   docs/dev-rules/credentials-and-local-storage.md（按账号隔离、登出清空）。
 * - 现有覆盖缺口：既有 mobileHomeListCache / useSessionListActions 测试不覆盖离线收件箱队列与重放。
 * - 最小失败输入：离线完成任务后重启 App 意图丢失，或上线遇到 dirty worktree 被静默归档，
 *   或登出后另一账号读到上一账号的待同步意图。
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
    ...overrides,
  } as RemoteSession;
}

describe('mobile offlineInboxIntents', () => {
  beforeEach(() => {
    storage.clear();
    __testing.reset();
    remoteSessionStore.clear();
  });

  it('persists per account, projects onto homeSessions without mutating raw sessions, and clears on logout', async () => {
    const raw = makeSession();
    remoteSessionStore.setDeviceSessions('dev-1', 'Studio', [raw]);

    await queueMobileOfflineInboxComplete('user-a', 'dev-1', 'sess-1', raw);
    expect(remoteSessionStore.getHomeSessions()[0]?.status).toBe('archived');
    // Raw mirror used by cache persistence stays untouched
    expect(remoteSessionStore.getSessions()[0]?.status).toBe('active');

    // Simulate cold restart for same user
    __testing.reset();
    expect(remoteSessionStore.getHomeSessions()[0]?.status).toBe('active');
    await hydrateMobileOfflineInboxIntents('user-a');
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

  it('replays snooze and rejects dirty-worktree complete on reconnect', async () => {
    const raw1 = makeSession({ id: 'sess-1' });
    const raw2 = makeSession({ id: 'sess-2', title: 'Dirty task' });
    remoteSessionStore.setDeviceSessions('dev-1', 'Studio', [raw1, raw2]);

    const until = '2026-11-27T09:00:00.000Z';
    await queueMobileOfflineInboxSnooze('user-a', 'dev-1', 'sess-1', raw1, until);
    await queueMobileOfflineInboxComplete('user-a', 'dev-1', 'sess-2', raw2);

    const patchMeta = vi.fn(async (_dev: string, id: string, patch: Record<string, unknown>) =>
      makeSession({ id, ...(patch as Partial<RemoteSession>) }),
    );
    const notifyRejected = vi.fn();

    await replayMobileOfflineInboxIntentsForDevice({
      userId: 'user-a',
      deviceId: 'dev-1',
      getIntents: getMobileOfflineInboxIntentsForDevice,
      getCurrentIntent: getMobileOfflineInboxIntent,
      removeIntent: removeMobileOfflineInboxIntent,
      isStillCurrent: () => true,
      getCachedFreshSession: (_dev, id) => [raw1, raw2].find((s) => s.id === id),
      fetchFreshSession: async () => null,
      isRunning: () => false,
      hasActiveAutomation: () => false,
      preflightWorktree: async () => 'dirty',
      patchMeta,
      applyPatchedSession: (dev, id, patch) => remoteSessionStore.applySessionPatch(dev, id, patch),
      markAutomationTaskRead: async () => undefined,
      notifyRejected,
      notifySnoozeFailed: vi.fn(),
      nowMs: () => Date.parse('2026-11-26T11:00:00.000Z'),
    });

    expect(patchMeta).toHaveBeenCalledTimes(1);
    expect(patchMeta).toHaveBeenCalledWith('dev-1', 'sess-1', { snoozedUntil: until });
    expect(notifyRejected).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-2' }), 'dirty-worktree');
    expect(getMobileOfflineInboxIntentsForDevice('dev-1')).toEqual([]);
  });
});
