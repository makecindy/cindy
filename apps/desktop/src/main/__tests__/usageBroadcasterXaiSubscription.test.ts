/**
 * xAI 周用量快照:磁盘 hydrate 不得在本进程 record 之前交给 Renderer。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryOne: vi.fn(),
  exec: vi.fn(async () => undefined),
  getCurrentUserId: vi.fn(() => 'user-1'),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../localDb/dailySpend', () => ({
  incrementDailySpend: vi.fn(),
  getTodaySpend: vi.fn(async () => 0),
  localDayKey: () => '2026-07-02',
}));
vi.mock('../localDb/dailyModelUsage', () => ({
  incrementDailyModelUsage: vi.fn(),
}));
vi.mock('../localDb/client/current', () => ({
  getDbClient: () => ({ queryOne: mocks.queryOne, exec: mocks.exec, drizzle: {} }),
}));
vi.mock('../localDb/index', () => ({
  getCurrentUserId: mocks.getCurrentUserId,
}));

describe('xai subscription snapshot hydration', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.queryOne.mockReset();
    mocks.exec.mockReset().mockResolvedValue(undefined);
    mocks.getCurrentUserId.mockReturnValue('user-1');
  });

  it('does not serve a disk snapshot until this process records one', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue({
      snapshot: JSON.stringify({
        planLabel: 'Account A',
        creditUsagePercent: 40,
        accountFingerprint: 'aaaa',
        updatedAt: 1,
      }),
    });

    await expect(broadcaster.readXaiSubscriptionUsageSnapshot()).resolves.toBeNull();

    await broadcaster.recordXaiSubscriptionUsageSnapshot({
      planLabel: 'Account B',
      creditUsagePercent: 2,
      accountFingerprint: 'bbbb',
      updatedAt: 2,
    });
    await expect(broadcaster.readXaiSubscriptionUsageSnapshot()).resolves.toMatchObject({
      planLabel: 'Account B',
      accountFingerprint: 'bbbb',
    });
  });

  it('does not merge an unsourced first record into a leftover disk snapshot', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue({
      snapshot: JSON.stringify({
        planLabel: 'Account A',
        creditUsagePercent: 40,
        accountFingerprint: 'aaaa',
        updatedAt: 1,
      }),
    });

    await expect(broadcaster.readXaiSubscriptionUsageSnapshot()).resolves.toBeNull();

    await broadcaster.recordXaiSubscriptionUsageSnapshot({
      planLabel: 'Account B',
      creditUsagePercent: 2,
      accountFingerprint: null,
      updatedAt: 2,
    });
    await expect(broadcaster.readXaiSubscriptionUsageSnapshot()).resolves.toEqual({
      planLabel: 'Account B',
      creditUsagePercent: 2,
      accountFingerprint: null,
      updatedAt: 2,
    });
  });

  it('does not let a later partial record null out cached plan or weekly percent', async () => {
    const broadcaster = await import('../usageBroadcaster');
    mocks.queryOne.mockResolvedValue(null);
    await broadcaster.recordXaiSubscriptionUsageSnapshot({
      planLabel: 'SuperGrok Heavy',
      creditUsagePercent: 2,
      accountFingerprint: 'bbbb',
      updatedAt: 2,
    });
    await broadcaster.recordXaiSubscriptionUsageSnapshot({
      planLabel: null,
      creditUsagePercent: 5,
      accountFingerprint: 'bbbb',
      updatedAt: 3,
    });
    await expect(broadcaster.readXaiSubscriptionUsageSnapshot()).resolves.toMatchObject({
      planLabel: 'SuperGrok Heavy',
      creditUsagePercent: 5,
      accountFingerprint: 'bbbb',
    });
  });
});
