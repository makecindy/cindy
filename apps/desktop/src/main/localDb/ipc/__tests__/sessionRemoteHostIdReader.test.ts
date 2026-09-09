/**
 * createSessionRemoteHostIdReader 的缓存语义:
 * 查询成功(含行不存在)缓存;DB 异常返回 null 但不缓存——瞬时 DB 失败
 * 不得永久关闭该 session 的 remote ensure 兜底。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  selectCalls: { count: 0 },
  failNext: { value: false },
  row: null as { remoteHostId: string | null } | null,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../client/current', () => ({
  getCurrentDbClientUserId: () => 'test-user',
  getDbClient: () => {
    if (h.failNext.value) {
      h.failNext.value = false;
      throw new Error('db worker takeover in flight');
    }
    return {
      drizzle: {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => {
                h.selectCalls.count += 1;
                return Promise.resolve(h.row ? [h.row] : []);
              },
            }),
          }),
        }),
      },
    };
  },
}));
vi.mock('../../dialogueWorkspace', () => ({ ensureDialogueWorkspaceDir: vi.fn() }));
vi.mock('../../../git-context/prRefsStore', () => ({
  recomputePrRefsForSession: vi.fn(async () => undefined),
}));
vi.mock('../../../imageCacheStore', () => ({ removeSession: vi.fn(async () => undefined) }));
vi.mock('../recentWorkdirs', () => ({ upsertRecentWorkdir: vi.fn(async () => undefined) }));
vi.mock('../../../device-link/broadcast-tap.js', () => ({
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: vi.fn(),
}));
vi.mock('../../agentIslandSessionPatch', () => ({ notifyAgentIslandSessionPatch: vi.fn() }));
vi.mock('../../../messagePersistBroadcaster', () => ({ noteSessionClearBoundary: vi.fn() }));
vi.mock('../../../sessionIds', () => ({ resolveBusinessSessionId: (id: string) => id }));

import { createSessionRemoteHostIdReader } from '../sessions';

describe('createSessionRemoteHostIdReader', () => {
  beforeEach(() => {
    h.selectCalls.count = 0;
    h.failNext.value = false;
    h.row = null;
  });

  it('caches successful lookups', async () => {
    h.row = { remoteHostId: 'host-1' };
    const read = createSessionRemoteHostIdReader();
    await expect(read('s1')).resolves.toBe('host-1');
    await expect(read('s1')).resolves.toBe('host-1');
    expect(h.selectCalls.count).toBe(1);
  });

  it('normalizes blank remoteHostId to null and caches it', async () => {
    h.row = { remoteHostId: '   ' };
    const read = createSessionRemoteHostIdReader();
    await expect(read('s1')).resolves.toBeNull();
    await expect(read('s1')).resolves.toBeNull();
    expect(h.selectCalls.count).toBe(1);
  });

  it('does NOT cache db errors — a transient failure does not permanently disable the fallback', async () => {
    const read = createSessionRemoteHostIdReader();
    h.failNext.value = true;
    await expect(read('s1')).resolves.toBeNull();

    // 瞬时失败后第二次调用必须重新查库,拿到真实 remoteHostId。
    h.row = { remoteHostId: 'host-1' };
    await expect(read('s1')).resolves.toBe('host-1');
    expect(h.selectCalls.count).toBe(1);

    // 成功后才进缓存。
    await expect(read('s1')).resolves.toBe('host-1');
    expect(h.selectCalls.count).toBe(1);
  });
});
