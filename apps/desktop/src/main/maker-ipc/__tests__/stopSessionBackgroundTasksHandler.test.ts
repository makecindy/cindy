import { describe, expect, it, vi } from 'vitest';

import { MAKER_INVOKE } from '../channels';
import { registerStopSessionBackgroundTasksHandler } from '../stopSessionBackgroundTasksHandler';
import { IpcHarness } from './helpers/ipcHarness';

describe('stop session background tasks IPC handler', () => {
  it('validates sessionId before closing the session', async () => {
    const harness = new IpcHarness();
    const closeSession = vi.fn();
    const clearBackgroundActivity = vi.fn();
    const noteSessionReset = vi.fn();
    const notifyGoalStop = vi.fn();

    registerStopSessionBackgroundTasksHandler(harness, {
      closeSession,
      clearBackgroundActivity,
      noteSessionReset,
      notifyGoalStop,
    });

    await expect(
      harness.invoke(MAKER_INVOKE.STOP_SESSION_BACKGROUND_TASKS, undefined),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(closeSession).not.toHaveBeenCalled();
    expect(clearBackgroundActivity).not.toHaveBeenCalled();
  });

  it('closes the session even when its active turn reports running', async () => {
    const harness = new IpcHarness();
    const closeSession = vi.fn().mockResolvedValue(undefined);
    const clearBackgroundActivity = vi.fn();
    const noteSessionReset = vi.fn();
    const notifyGoalStop = vi.fn();
    // Regression fixture: the old handler called getSession().isTurnRunning() and rejected
    // with SESSION_RUNNING instead of honoring the user's emergency stop request.
    const maker = {
      closeSession,
      getSession: vi.fn(() => ({ isTurnRunning: () => true })),
    };

    registerStopSessionBackgroundTasksHandler(harness, {
      closeSession: maker.closeSession,
      clearBackgroundActivity,
      noteSessionReset,
      notifyGoalStop,
    });

    await expect(
      harness.invoke(MAKER_INVOKE.STOP_SESSION_BACKGROUND_TASKS, 'session-running'),
    ).resolves.toEqual({ ok: true });
    expect(maker.getSession).not.toHaveBeenCalled();
    expect(noteSessionReset).toHaveBeenCalledWith('session-running');
    expect(notifyGoalStop).toHaveBeenCalledWith('session-running');
    expect(closeSession).toHaveBeenCalledWith('session-running');
    expect(clearBackgroundActivity).toHaveBeenCalledWith('session-running');
  });

  it('does not clear the visible activity state when close fails', async () => {
    const harness = new IpcHarness();
    const error = new Error('close failed');
    const closeSession = vi.fn().mockRejectedValue(error);
    const clearBackgroundActivity = vi.fn();
    const noteSessionReset = vi.fn();
    const notifyGoalStop = vi.fn();

    registerStopSessionBackgroundTasksHandler(harness, {
      closeSession,
      clearBackgroundActivity,
      noteSessionReset,
      notifyGoalStop,
    });

    await expect(
      harness.invoke(MAKER_INVOKE.STOP_SESSION_BACKGROUND_TASKS, 'session-1'),
    ).rejects.toBe(error);
    expect(noteSessionReset).toHaveBeenCalledWith('session-1');
    expect(notifyGoalStop).toHaveBeenCalledWith('session-1');
    expect(clearBackgroundActivity).not.toHaveBeenCalled();
  });

  it('still closes the session when notifyGoalStop rejects', async () => {
    const harness = new IpcHarness();
    const closeSession = vi.fn().mockResolvedValue(undefined);
    const clearBackgroundActivity = vi.fn();
    const noteSessionReset = vi.fn();
    const notifyGoalStop = vi.fn().mockRejectedValue(new Error('goal observer crashed'));

    registerStopSessionBackgroundTasksHandler(harness, {
      closeSession,
      clearBackgroundActivity,
      noteSessionReset,
      notifyGoalStop,
    });

    await expect(
      harness.invoke(MAKER_INVOKE.STOP_SESSION_BACKGROUND_TASKS, 'session-1'),
    ).resolves.toEqual({ ok: true });
    expect(closeSession).toHaveBeenCalledWith('session-1');
    expect(clearBackgroundActivity).toHaveBeenCalledWith('session-1');
  });
});
