import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  controllerAvailable: true,
  setGoal: vi.fn(),
  getStatus: vi.fn(),
  resumeOnOpen: vi.fn(),
  resumeGoal: vi.fn(),
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
  getGoalController: () => mocks.controllerAvailable
    ? {
        setGoal: mocks.setGoal,
        getStatus: mocks.getStatus,
        resumeOnOpen: mocks.resumeOnOpen,
        resumeGoal: mocks.resumeGoal,
        updateGoal: mocks.updateGoal,
      }
    : null,
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../../device-link/broadcast-tap.js', () => ({
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: vi.fn(),
}));

import {
  GoalSessionRestoreError,
  GoalUpdateSupersededError,
} from '../../goal-host/controller.js';
import { MAKER_INVOKE } from '../channels.js';
import { registerGoalHandlers } from '../goal.js';

function handlerFor(channel: string): (...args: unknown[]) => unknown {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error(`goal handler was not registered: ${channel}`);
  return handler;
}

function updateHandler(): (...args: unknown[]) => unknown {
  return handlerFor(MAKER_INVOKE.GOAL_UPDATE);
}

describe('goal update IPC errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.controllerAvailable = true;
    registerGoalHandlers();
  });

  it('returns INTERNAL when the Goal controller is not ready', async () => {
    mocks.controllerAvailable = false;

    const result = handlerFor(MAKER_INVOKE.GOAL_GET_STATUS)({}, 's1');

    await expect(result).rejects.toMatchObject({
      code: 'INTERNAL',
      message: expect.stringContaining('goal controller not started'),
    });
  });

  it('maps the initial Goal status read failure to INTERNAL without leaking storage details', async () => {
    mocks.getStatus.mockRejectedValueOnce(new Error('sqlite path /private/user-data failed'));

    const result = handlerFor(MAKER_INVOKE.GOAL_GET_STATUS)({}, 's1');

    await expect(result).rejects.toMatchObject({
      code: 'INTERNAL',
      message: expect.stringContaining('failed to read goal status'),
    });
  });

  it('maps the post-recovery Goal status read failure to INTERNAL', async () => {
    mocks.getStatus
      .mockResolvedValueOnce({ sessionId: 's1', status: 'active' })
      .mockRejectedValueOnce(new Error('second read failed'));
    mocks.resumeOnOpen.mockResolvedValueOnce(undefined);

    const result = handlerFor(MAKER_INVOKE.GOAL_GET_STATUS)({}, 's1');

    await expect(result).rejects.toMatchObject({
      code: 'INTERNAL',
      message: expect.stringContaining('failed to read goal status'),
    });
    expect(mocks.resumeOnOpen).toHaveBeenCalledWith('s1', { waitForDispatch: false });
  });

  it('returns the post-recovery blocked state instead of a stale active snapshot', async () => {
    const active = { sessionId: 's1', status: 'active' };
    const blocked = {
      sessionId: 's1',
      status: 'blocked',
      lastReason: 'turn dispatch failed: unable to restore the agent session',
    };
    mocks.getStatus
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(blocked);
    mocks.resumeOnOpen.mockResolvedValueOnce(undefined);

    const result = await handlerFor(MAKER_INVOKE.GOAL_GET_STATUS)({}, 's1');

    expect(result).toEqual(blocked);
    expect(mocks.resumeOnOpen).toHaveBeenCalledWith('s1', { waitForDispatch: false });
    expect(mocks.getStatus).toHaveBeenCalledTimes(2);
  });

  it('returns a structured error when dormant recovery cannot persist blocked state', async () => {
    mocks.getStatus.mockResolvedValueOnce({ sessionId: 's1', status: 'active' });
    mocks.resumeOnOpen.mockRejectedValueOnce(
      new GoalSessionRestoreError(new Error('goal storage unavailable')),
    );

    const result = handlerFor(MAKER_INVOKE.GOAL_GET_STATUS)({}, 's1');

    await expect(result).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('unable to restore the agent session'),
    });
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);
  });

  it('returns active status without waiting for detached prompt acceptance', async () => {
    const active = { sessionId: 's1', status: 'active' };
    const neverAccepted = new Promise<void>(() => {});
    mocks.getStatus
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(active);
    mocks.resumeOnOpen.mockImplementationOnce(
      async (_sessionId: string, opts?: { waitForDispatch?: boolean }) => {
        if (opts?.waitForDispatch !== false) await neverAccepted;
      },
    );

    const result = await handlerFor(MAKER_INVOKE.GOAL_GET_STATUS)({}, 's1');

    expect(result).toEqual(active);
    expect(mocks.resumeOnOpen).toHaveBeenCalledWith('s1', { waitForDispatch: false });
    expect(mocks.getStatus).toHaveBeenCalledTimes(2);
  });

  it('maps an internal dormant recovery read failure to sanitized INTERNAL', async () => {
    mocks.getStatus.mockResolvedValueOnce({ sessionId: 's1', status: 'active' });
    mocks.resumeOnOpen.mockRejectedValueOnce(
      new Error('sqlite path /private/user-data/goal.db failed'),
    );

    const result = handlerFor(MAKER_INVOKE.GOAL_GET_STATUS)({}, 's1');

    let error: unknown;
    try {
      await result;
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: 'INTERNAL',
      message: expect.stringContaining('failed to restore goal status'),
    });
    expect((error as Error).message).not.toContain('/private/user-data');
    expect(mocks.getStatus).toHaveBeenCalledTimes(1);
  });

  it('maps GOAL_SET session restore failures to PRECONDITION_FAILED', async () => {
    mocks.setGoal.mockRejectedValueOnce(new GoalSessionRestoreError());

    const result = handlerFor(MAKER_INVOKE.GOAL_SET)(
      {},
      { sessionId: 's1', objective: 'recover the goal' },
    );

    await expect(result).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('unable to restore the agent session'),
    });
  });

  it('maps GOAL_RESUME session restore failures to PRECONDITION_FAILED', async () => {
    mocks.resumeGoal.mockRejectedValueOnce(new GoalSessionRestoreError());

    const result = handlerFor(MAKER_INVOKE.GOAL_RESUME)({}, 's1');

    await expect(result).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('unable to restore the agent session'),
    });
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
