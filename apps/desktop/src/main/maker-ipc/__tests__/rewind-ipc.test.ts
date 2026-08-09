import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  previewRewindAtMessage: vi.fn(),
  commitRewindAtMessage: vi.fn(),
  withSessionInputStoppedForRewind: vi.fn(),
  ownerScope: { ownerScopeKey: 'owner-1' },
  broadcastSubagentRunsInvalidated: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    },
  },
}));

vi.mock('../../maker-orchestration/rewind.js', () => ({
  previewRewindAtMessage: mocks.previewRewindAtMessage,
  commitRewindAtMessage: mocks.commitRewindAtMessage,
}));

vi.mock('../register.js', () => ({
  withSessionInputStoppedForRewind: mocks.withSessionInputStoppedForRewind,
}));

vi.mock('../../goal-host/index.js', () => ({
  getGoalController: () => null,
}));

vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => mocks.ownerScope,
}));

vi.mock('../../localDb/ipc/subagentRuns.js', () => ({
  broadcastSubagentRunsInvalidated: mocks.broadcastSubagentRunsInvalidated,
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

import { MAKER_INVOKE } from '../channels.js';
import { registerMakerRewindIpc } from '../rewind.js';

function sessionRunningError(): Error & { code: 'SESSION_RUNNING' } {
  return Object.assign(new Error('session running'), { code: 'SESSION_RUNNING' as const });
}

describe('maker rewind IPC stop-then-rewind', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.withSessionInputStoppedForRewind.mockImplementation(
      async (_sessionId: string, action: () => Promise<unknown>) => action(),
    );
    registerMakerRewindIpc();
  });

  it('runs normal rewind inside the stopped input boundary when requested', async () => {
    const session = { id: 'session-1' };
    mocks.commitRewindAtMessage.mockResolvedValue(session);
    const handler = mocks.handlers.get(MAKER_INVOKE.REWIND_COMMIT);
    if (!handler) throw new Error('rewind commit handler not registered');

    await expect(handler({}, 'session-1', 'message-1', { stopIfRunning: true })).resolves.toBe(
      session,
    );

    expect(mocks.withSessionInputStoppedForRewind).toHaveBeenCalledWith(
      'session-1',
      expect.any(Function),
    );
    expect(mocks.commitRewindAtMessage).toHaveBeenCalledWith('session-1', 'message-1', {
      requireLatestUser: false,
    });
    expect(mocks.broadcastSubagentRunsInvalidated).toHaveBeenCalledWith(
      'session-1',
      mocks.ownerScope,
    );
  });

  it('waits through the post-Stop SESSION_RUNNING race before committing', async () => {
    vi.useFakeTimers();
    try {
      const session = { id: 'session-1' };
      mocks.commitRewindAtMessage
        .mockRejectedValueOnce(sessionRunningError())
        .mockResolvedValueOnce(session);
      const handler = mocks.handlers.get(MAKER_INVOKE.REWIND_COMMIT);
      if (!handler) throw new Error('rewind commit handler not registered');

      const result = handler({}, 'session-1', 'message-1', { stopIfRunning: true });
      await vi.advanceTimersByTimeAsync(100);

      await expect(result).resolves.toBe(session);
      expect(mocks.commitRewindAtMessage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops waiting when the post-Stop idle deadline expires', async () => {
    vi.useFakeTimers();
    try {
      mocks.commitRewindAtMessage.mockRejectedValue(sessionRunningError());
      const handler = mocks.handlers.get(MAKER_INVOKE.REWIND_COMMIT);
      if (!handler) throw new Error('rewind commit handler not registered');

      const result = handler({}, 'session-1', 'message-1', { stopIfRunning: true });
      const rejection = expect(result).rejects.toThrow('session running');
      await vi.advanceTimersByTimeAsync(15_000);

      await rejection;
      expect(mocks.commitRewindAtMessage.mock.calls.length).toBeGreaterThan(1);
      expect(mocks.commitRewindAtMessage.mock.calls.length).toBeLessThanOrEqual(152);
      expect(mocks.broadcastSubagentRunsInvalidated).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps edit-last-message on its existing direct commit path', async () => {
    const session = { id: 'session-1' };
    mocks.commitRewindAtMessage.mockResolvedValue(session);
    const handler = mocks.handlers.get(MAKER_INVOKE.REWIND_COMMIT);
    if (!handler) throw new Error('rewind commit handler not registered');

    await expect(handler({}, 'session-1', 'message-1', { requireLatestUser: true })).resolves.toBe(
      session,
    );

    expect(mocks.withSessionInputStoppedForRewind).not.toHaveBeenCalled();
    expect(mocks.commitRewindAtMessage).toHaveBeenCalledWith('session-1', 'message-1', {
      requireLatestUser: true,
    });
  });
});
