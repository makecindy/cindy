/**
 * 每轮用量:任务用量是模型用量的细分,模型行没记上时不能单独计入任务排行。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  incrementDailyModelUsage: vi.fn(async () => undefined),
  incrementDailySessionUsage: vi.fn(async () => undefined),
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
  localDayKey: () => '2026-09-27',
}));
vi.mock('../localDb/dailyModelUsage', () => ({
  incrementDailyModelUsage: mocks.incrementDailyModelUsage,
}));
vi.mock('../localDb/dailySessionUsage', () => ({
  incrementDailySessionUsage: mocks.incrementDailySessionUsage,
}));
vi.mock('../localDb/client/current', () => ({
  getDbClient: () => ({ queryOne: vi.fn(), exec: vi.fn(), drizzle: {} }),
  getCurrentDbClientUserId: () => 'user-1',
}));

import { recordModelTurnUsage } from '../usageBroadcaster';

const delta = {
  sessionId: 's1',
  agentKind: 'pi' as const,
  model: 'gpt-5.5',
  inputTokensDelta: 10,
  outputTokensDelta: 5,
  cacheReadTokensDelta: 2,
  cacheCreateTokensDelta: 0,
};

describe('recordModelTurnUsage', () => {
  beforeEach(() => {
    mocks.incrementDailyModelUsage.mockReset().mockResolvedValue(undefined);
    mocks.incrementDailySessionUsage.mockReset().mockResolvedValue(undefined);
  });

  it('adds the turn tokens to the task after the model row is recorded', async () => {
    await recordModelTurnUsage(delta, 1);
    expect(mocks.incrementDailySessionUsage).toHaveBeenCalledWith('s1', 17, 1);
  });

  it('does not count the task when the model row failed', async () => {
    mocks.incrementDailyModelUsage.mockRejectedValue(new Error('worker restarted'));
    await expect(recordModelTurnUsage(delta, 1)).resolves.toBeUndefined();
    expect(mocks.incrementDailySessionUsage).not.toHaveBeenCalled();
  });
});
