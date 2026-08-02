import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  updateGoal: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    },
  },
}));

vi.mock('../../goal-host/index.js', () => ({
  getGoalController: () => ({ updateGoal: mocks.updateGoal }),
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../../device-link/broadcast-tap.js', () => ({
  tapWindowBroadcast: vi.fn(),
}));

import { GoalUpdateSupersededError } from '../../goal-host/controller.js';
import { MAKER_INVOKE } from '../channels.js';
import { registerGoalHandlers } from '../goal.js';

function updateHandler(): (...args: unknown[]) => unknown {
  const handler = mocks.handlers.get(MAKER_INVOKE.GOAL_UPDATE);
  if (!handler) throw new Error('goal update handler was not registered');
  return handler;
}

describe('goal update IPC errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    registerGoalHandlers();
  });

  it('maps a superseded lifecycle update to PRECONDITION_FAILED', async () => {
    mocks.updateGoal.mockRejectedValueOnce(new GoalUpdateSupersededError());

    const result = updateHandler()(
      {},
      {
        sessionId: 's1',
        patch: { objective: 'updated objective' },
      },
    );

    await expect(result).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('keeps GOAL_NOT_FOUND for an authoritative missing row', async () => {
    mocks.updateGoal.mockResolvedValueOnce(null);

    const result = updateHandler()(
      {},
      {
        sessionId: 's1',
        patch: { maxTurns: 10 },
      },
    );

    await expect(result).rejects.toMatchObject({ code: 'GOAL_NOT_FOUND' });
  });
});
