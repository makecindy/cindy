import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  controllerAvailable: true,
  setGoal: vi.fn(),
  getStatus: vi.fn(),
  resumeOnOpen: vi.fn(),
  resumeGoal: vi.fn(),
  updateGoal: vi.fn(),
  clearGoal: vi.fn(),
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
        clearGoal: mocks.clearGoal,
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
import { registerGoalHandlers, type GoalHandlerLifecycleDeps } from '../goal.js';

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

describe('goal remote lifecycle fence', () => {
  type SessionLock = <T>(sessionId: string, task: () => Promise<T>) => Promise<T>;
  const isDeviceLinkInvoke = vi.fn(() => true);
  const withSessionLock = vi.fn<SessionLock>(
    async (_sessionId, task) => task(),
  );
  const assertSessionActive = vi.fn(async (_sessionId: string) => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.controllerAvailable = true;
    isDeviceLinkInvoke.mockReturnValue(true);
    registerGoalHandlers({
      isDeviceLinkInvoke,
      withSessionLock: withSessionLock as unknown as GoalHandlerLifecycleDeps['withSessionLock'],
      assertSessionActive,
    });
  });

  it('fences a device-link GOAL_SET only when requireActiveSession is explicitly requested', async () => {
    const setHandler = mocks.handlers.get(MAKER_INVOKE.GOAL_SET)!;
    await setHandler({}, { sessionId: 'rs', objective: '目标', requireActiveSession: true });

    expect(withSessionLock).toHaveBeenCalledWith('rs', expect.any(Function));
    expect(assertSessionActive).toHaveBeenCalledWith('rs');
    expect(mocks.setGoal).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'rs', objective: '目标', sessionRouteLockHeld: true }),
    );
  });

  it('does not fence a primary remote GOAL_SET without requireActiveSession', async () => {
    const setHandler = mocks.handlers.get(MAKER_INVOKE.GOAL_SET)!;
    await setHandler({}, { sessionId: 'rs', objective: '目标' });

    expect(withSessionLock).not.toHaveBeenCalled();
    expect(assertSessionActive).not.toHaveBeenCalled();
    expect(mocks.setGoal).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'rs', objective: '目标' }),
    );
    expect(mocks.setGoal).not.toHaveBeenCalledWith(
      expect.objectContaining({ sessionRouteLockHeld: true }),
    );
  });

  it('does not fence GOAL_CLEAR for a bare sessionId string (old wire shape, primary remote)', async () => {
    const clearHandler = mocks.handlers.get(MAKER_INVOKE.GOAL_CLEAR)!;
    await clearHandler({}, 'rs');

    expect(withSessionLock).not.toHaveBeenCalled();
    expect(assertSessionActive).not.toHaveBeenCalled();
    expect(mocks.clearGoal).toHaveBeenCalledWith('rs');
  });

  it('fences GOAL_CLEAR only when the trailing fenceOpts.requireActiveSession is true', async () => {
    const clearHandler = mocks.handlers.get(MAKER_INVOKE.GOAL_CLEAR)!;
    await clearHandler({}, 'rs', { requireActiveSession: true });

    expect(withSessionLock).toHaveBeenCalledWith('rs', expect.any(Function));
    expect(assertSessionActive).toHaveBeenCalledWith('rs');
    expect(mocks.clearGoal).toHaveBeenCalledWith('rs');
  });

  it('does not fence GOAL_RESUME for a bare sessionId string (old wire shape, primary remote)', async () => {
    const resumeHandler = mocks.handlers.get(MAKER_INVOKE.GOAL_RESUME)!;
    await resumeHandler({}, 'rs');

    expect(withSessionLock).not.toHaveBeenCalled();
    expect(assertSessionActive).not.toHaveBeenCalled();
    expect(mocks.resumeGoal).toHaveBeenCalledWith('rs');
  });

  it('fences GOAL_RESUME only when the trailing fenceOpts.requireActiveSession is true', async () => {
    const resumeHandler = mocks.handlers.get(MAKER_INVOKE.GOAL_RESUME)!;
    await resumeHandler({}, 'rs', { requireActiveSession: true });

    expect(withSessionLock).toHaveBeenCalledWith('rs', expect.any(Function));
    expect(assertSessionActive).toHaveBeenCalledWith('rs');
    // fence 已持有 route lock:透传 sessionRouteLockHeld,避免 resumeGoal→fireTurn 二次加锁。
    expect(mocks.resumeGoal).toHaveBeenCalledWith('rs', { sessionRouteLockHeld: true });
  });

  it('fences a device-link GOAL_UPDATE only when requireActiveSession is explicitly requested', async () => {
    mocks.updateGoal.mockResolvedValueOnce({ sessionId: 'rs' });
    const updateHandler = mocks.handlers.get(MAKER_INVOKE.GOAL_UPDATE)!;
    await updateHandler({}, {
      sessionId: 'rs',
      patch: { objective: 'updated objective' },
      requireActiveSession: true,
    });

    expect(withSessionLock).toHaveBeenCalledWith('rs', expect.any(Function));
    expect(assertSessionActive).toHaveBeenCalledWith('rs');
    expect(mocks.updateGoal).toHaveBeenCalledWith('rs', { objective: 'updated objective' }, { sessionRouteLockHeld: true });
  });

  it('does not fence a primary remote GOAL_UPDATE without requireActiveSession', async () => {
    mocks.updateGoal.mockResolvedValueOnce({ sessionId: 'rs' });
    const updateHandler = mocks.handlers.get(MAKER_INVOKE.GOAL_UPDATE)!;
    await updateHandler({}, {
      sessionId: 'rs',
      patch: { objective: 'updated objective' },
    });

    expect(withSessionLock).not.toHaveBeenCalled();
    expect(assertSessionActive).not.toHaveBeenCalled();
    expect(mocks.updateGoal).toHaveBeenCalledWith('rs', { objective: 'updated objective' });
  });

  it('blocks GOAL_RESUME for an archived session when the active-session assertion rejects', async () => {
    assertSessionActive.mockRejectedValueOnce(new Error('session is archived'));
    const resumeHandler = mocks.handlers.get(MAKER_INVOKE.GOAL_RESUME)!;

    await expect(resumeHandler({}, 'rs', { requireActiveSession: true })).rejects.toThrow(
      'session is archived',
    );
    expect(withSessionLock).toHaveBeenCalledWith('rs', expect.any(Function));
    expect(mocks.resumeGoal).not.toHaveBeenCalled();
  });

  it('fences the side-effecting resumeOnOpen inside GET_STATUS when requireActiveSession is set', async () => {
    mocks.getStatus.mockResolvedValue({ sessionId: 'rs', status: 'active' });
    const getStatusHandler = mocks.handlers.get(MAKER_INVOKE.GOAL_GET_STATUS)!;
    await getStatusHandler({}, 'rs', { requireActiveSession: true });

    expect(withSessionLock).toHaveBeenCalledWith('rs', expect.any(Function));
    expect(assertSessionActive).toHaveBeenCalledWith('rs');
    expect(mocks.resumeOnOpen).toHaveBeenCalledWith('rs', {
      waitForDispatch: false,
      sessionRouteLockHeld: true,
    });
  });

  it('does not fence GET_STATUS resumeOnOpen for a primary remote without the marker', async () => {
    mocks.getStatus
      .mockResolvedValueOnce({ sessionId: 'rs', status: 'active' })
      .mockResolvedValueOnce({ sessionId: 'rs', status: 'active' });
    const getStatusHandler = mocks.handlers.get(MAKER_INVOKE.GOAL_GET_STATUS)!;
    await getStatusHandler({}, 'rs');

    expect(withSessionLock).not.toHaveBeenCalled();
    expect(assertSessionActive).not.toHaveBeenCalled();
    expect(mocks.resumeOnOpen).toHaveBeenCalledWith('rs', { waitForDispatch: false });
  });

  it('skips resumeOnOpen for GET_STATUS when the fence reports the session archived', async () => {
    mocks.getStatus.mockResolvedValue({ sessionId: 'rs', status: 'active' });
    // 真实 assertSessionActiveForManualDispatch 用 throwIpcError 抛 PRECONDITION_FAILED +
    // SESSION_NOT_ACTIVE 标记;GET_STATUS 据此降级为不 resumeOnOpen、返回恢复前快照。
    const archived = new Error('SESSION_NOT_ACTIVE: Session rs is no longer active') as Error & {
      code: string;
    };
    archived.code = 'PRECONDITION_FAILED';
    assertSessionActive.mockRejectedValueOnce(archived);
    const getStatusHandler = mocks.handlers.get(MAKER_INVOKE.GOAL_GET_STATUS)!;
    const result = await getStatusHandler({}, 'rs', { requireActiveSession: true });

    expect(withSessionLock).toHaveBeenCalledWith('rs', expect.any(Function));
    expect(mocks.resumeOnOpen).not.toHaveBeenCalled();
    // 降级返回恢复前的 active 快照,不把读取变成报错。
    expect(result).toEqual({ sessionId: 'rs', status: 'active' });
  });

  it('blocks GOAL_UPDATE for an archived session when the active-session assertion rejects', async () => {
    assertSessionActive.mockRejectedValueOnce(new Error('session is archived'));
    mocks.updateGoal.mockResolvedValueOnce({ sessionId: 'rs' });
    const updateHandler = mocks.handlers.get(MAKER_INVOKE.GOAL_UPDATE)!;

    await expect(
      updateHandler({}, {
        sessionId: 'rs',
        patch: { objective: 'updated objective' },
        requireActiveSession: true,
      }),
    ).rejects.toThrow('session is archived');
    expect(withSessionLock).toHaveBeenCalledWith('rs', expect.any(Function));
    expect(mocks.updateGoal).not.toHaveBeenCalled();
  });
});

// Reviewer P2 (PRRT_kwDOTgdRUs6b0AHd):本地副窗口 GoalIndicator 的 resume/update/clear
// 走真实 event.sender,此前因既非 device-link、renderer 也不带 requireActiveSession 标记而
// 绕过 active-session 门禁。这里钉住"按真实 sender 识别本地副窗口 → 一律 fence"。
describe('goal local secondary-window lifecycle fence', () => {
  type SessionLock = <T>(sessionId: string, task: () => Promise<T>) => Promise<T>;
  const isDeviceLinkInvoke = vi.fn(() => false);
  const withSessionLock = vi.fn<SessionLock>(
    async (_sessionId, task) => task(),
  );
  const assertSessionActive = vi.fn(async (_sessionId: string) => undefined);
  const isSecondaryWindowEvent = vi.fn((event: unknown) => event === SECONDARY_EVENT);

  // 主窗口事件(sender 不是副窗口);副窗口事件(sender 命中 secondaryWindows)。
  const MAIN_EVENT = { sender: { id: 1 } };
  const SECONDARY_EVENT = { sender: { id: 2 } };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.controllerAvailable = true;
    isDeviceLinkInvoke.mockReturnValue(false);
    isSecondaryWindowEvent.mockImplementation((event: unknown) => event === SECONDARY_EVENT);
    registerGoalHandlers({
      isDeviceLinkInvoke,
      withSessionLock: withSessionLock as unknown as GoalHandlerLifecycleDeps['withSessionLock'],
      assertSessionActive,
      isSecondaryWindowEvent,
    });
  });

  it('fences a local secondary-window GOAL_RESUME even with a bare sessionId (no marker)', async () => {
    const resumeHandler = mocks.handlers.get(MAKER_INVOKE.GOAL_RESUME)!;
    await resumeHandler(SECONDARY_EVENT, 's1');

    expect(isSecondaryWindowEvent).toHaveBeenCalledWith(SECONDARY_EVENT);
    expect(withSessionLock).toHaveBeenCalledWith('s1', expect.any(Function));
    expect(assertSessionActive).toHaveBeenCalledWith('s1');
    expect(mocks.resumeGoal).toHaveBeenCalledWith('s1', { sessionRouteLockHeld: true });
  });

  it('fences a local secondary-window GOAL_UPDATE without requireActiveSession', async () => {
    mocks.updateGoal.mockResolvedValueOnce({ sessionId: 's1' });
    const updateHandler = mocks.handlers.get(MAKER_INVOKE.GOAL_UPDATE)!;
    await updateHandler(SECONDARY_EVENT, {
      sessionId: 's1',
      patch: { objective: 'edited in secondary window' },
    });

    expect(withSessionLock).toHaveBeenCalledWith('s1', expect.any(Function));
    expect(assertSessionActive).toHaveBeenCalledWith('s1');
    expect(mocks.updateGoal).toHaveBeenCalledWith('s1', {
      objective: 'edited in secondary window',
    }, { sessionRouteLockHeld: true });
  });

  it('fences a local secondary-window GOAL_CLEAR even with a bare sessionId', async () => {
    const clearHandler = mocks.handlers.get(MAKER_INVOKE.GOAL_CLEAR)!;
    await clearHandler(SECONDARY_EVENT, 's1');

    expect(withSessionLock).toHaveBeenCalledWith('s1', expect.any(Function));
    expect(assertSessionActive).toHaveBeenCalledWith('s1');
    expect(mocks.clearGoal).toHaveBeenCalledWith('s1');
  });

  it('fences a local secondary-window GOAL_SET and marks the route lock held', async () => {
    const setHandler = mocks.handlers.get(MAKER_INVOKE.GOAL_SET)!;
    await setHandler(SECONDARY_EVENT, { sessionId: 's1', objective: '目标' });

    expect(withSessionLock).toHaveBeenCalledWith('s1', expect.any(Function));
    expect(assertSessionActive).toHaveBeenCalledWith('s1');
    expect(mocks.setGoal).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 's1', objective: '目标', sessionRouteLockHeld: true }),
    );
  });

  it('blocks a secondary-window GOAL_RESUME for an archived session', async () => {
    assertSessionActive.mockRejectedValueOnce(new Error('session is archived'));
    const resumeHandler = mocks.handlers.get(MAKER_INVOKE.GOAL_RESUME)!;

    await expect(resumeHandler(SECONDARY_EVENT, 's1')).rejects.toThrow('session is archived');
    expect(withSessionLock).toHaveBeenCalledWith('s1', expect.any(Function));
    expect(mocks.resumeGoal).not.toHaveBeenCalled();
  });

  it('does not fence a primary local main-window GOAL_RESUME (historical resume semantics)', async () => {
    const resumeHandler = mocks.handlers.get(MAKER_INVOKE.GOAL_RESUME)!;
    await resumeHandler(MAIN_EVENT, 's1');

    expect(isSecondaryWindowEvent).toHaveBeenCalledWith(MAIN_EVENT);
    expect(withSessionLock).not.toHaveBeenCalled();
    expect(assertSessionActive).not.toHaveBeenCalled();
    expect(mocks.resumeGoal).toHaveBeenCalledWith('s1');
  });

  it('does not fence a primary local main-window GOAL_UPDATE', async () => {
    mocks.updateGoal.mockResolvedValueOnce({ sessionId: 's1' });
    const updateHandler = mocks.handlers.get(MAKER_INVOKE.GOAL_UPDATE)!;
    await updateHandler(MAIN_EVENT, {
      sessionId: 's1',
      patch: { objective: 'edited in main window' },
    });

    expect(withSessionLock).not.toHaveBeenCalled();
    expect(assertSessionActive).not.toHaveBeenCalled();
    expect(mocks.updateGoal).toHaveBeenCalledWith('s1', { objective: 'edited in main window' });
  });

  it('fences the resumeOnOpen inside a local secondary-window GET_STATUS (no marker needed)', async () => {
    mocks.getStatus.mockResolvedValue({ sessionId: 's1', status: 'active' });
    const getStatusHandler = mocks.handlers.get(MAKER_INVOKE.GOAL_GET_STATUS)!;
    // 裸 sessionId,无 requireActiveSession —— 本地副窗口靠真实 sender 自动 fence。
    await getStatusHandler(SECONDARY_EVENT, 's1');

    expect(isSecondaryWindowEvent).toHaveBeenCalledWith(SECONDARY_EVENT);
    expect(withSessionLock).toHaveBeenCalledWith('s1', expect.any(Function));
    expect(assertSessionActive).toHaveBeenCalledWith('s1');
    expect(mocks.resumeOnOpen).toHaveBeenCalledWith('s1', {
      waitForDispatch: false,
      sessionRouteLockHeld: true,
    });
  });

  it('does not fence a primary local main-window GET_STATUS resumeOnOpen', async () => {
    mocks.getStatus
      .mockResolvedValueOnce({ sessionId: 's1', status: 'active' })
      .mockResolvedValueOnce({ sessionId: 's1', status: 'active' });
    const getStatusHandler = mocks.handlers.get(MAKER_INVOKE.GOAL_GET_STATUS)!;
    await getStatusHandler(MAIN_EVENT, 's1');

    expect(isSecondaryWindowEvent).toHaveBeenCalledWith(MAIN_EVENT);
    expect(withSessionLock).not.toHaveBeenCalled();
    expect(assertSessionActive).not.toHaveBeenCalled();
    expect(mocks.resumeOnOpen).toHaveBeenCalledWith('s1', { waitForDispatch: false });
  });
});
