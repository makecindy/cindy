import { getSessionRewindGeneration } from '../sendToSessionLock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  previewRewindAtMessage: vi.fn(),
  commitRewindAtMessage: vi.fn(),
  drainPersistQueue: vi.fn(),
  prepareSessionForHistoryAction: vi.fn(),
  releaseSessionAfterHistoryAction: vi.fn(),
  assertTrustedAppRendererEvent: vi.fn(),
  isDeviceLinkInvoke: vi.fn(() => false),
  withSessionInputStoppedForRewind: vi.fn(),
  ownerScope: { ownerScopeKey: 'owner-1' },
  isOwnerCurrent: vi.fn(() => true),
  broadcastSubagentRunsInvalidated: vi.fn(),
  beginSubagentRewindFence: vi.fn(),
  finishSubagentRewindFence: vi.fn(),
  primeSubagentRewindFence: vi.fn(),
  listVisibleSubagentObservationIdentities: vi.fn(),
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

vi.mock('../../messagePersistBroadcaster.desktop.js', () => ({
  drainPersistQueue: mocks.drainPersistQueue,
}));

vi.mock('../register.js', () => ({
  prepareSessionForHistoryAction: mocks.prepareSessionForHistoryAction,
  releaseSessionAfterHistoryAction: mocks.releaseSessionAfterHistoryAction,
  withSessionInputStoppedForRewind: mocks.withSessionInputStoppedForRewind,
}));

vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: mocks.assertTrustedAppRendererEvent,
}));

vi.mock('../../device-link/invoke-context.js', () => ({
  isDeviceLinkInvoke: mocks.isDeviceLinkInvoke,
}));

vi.mock('../../goal-host/index.js', () => ({
  getGoalController: () => null,
}));

vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => mocks.ownerScope,
  isDataOwnerBroadcastScopeCurrent: mocks.isOwnerCurrent,
}));

vi.mock('../../localDb/ipc/subagentRuns.js', () => ({
  broadcastSubagentRunsInvalidated: mocks.broadcastSubagentRunsInvalidated,
}));

vi.mock('../../localDb/subagentRuns.js', () => ({
  listVisibleSubagentObservationIdentities: mocks.listVisibleSubagentObservationIdentities,
}));

vi.mock('../../subagentObservationRewindFence.js', () => ({
  beginSubagentRewindFence: mocks.beginSubagentRewindFence,
  finishSubagentRewindFence: mocks.finishSubagentRewindFence,
  primeSubagentRewindFence: mocks.primeSubagentRewindFence,
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

import { MAKER_INVOKE } from '../channels.js';
import { registerMakerRewindIpc } from '../rewind.js';
import { acquireSendToSessionLock } from '../sendToSessionLock.js';

function sessionRunningError(): Error & { code: 'SESSION_RUNNING' } {
  return Object.assign(new Error('session running'), { code: 'SESSION_RUNNING' as const });
}

describe('maker rewind IPC stop-then-rewind', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.isOwnerCurrent.mockReturnValue(true);
    mocks.drainPersistQueue.mockResolvedValue(undefined);
    mocks.prepareSessionForHistoryAction.mockReset().mockResolvedValue(undefined);
    mocks.releaseSessionAfterHistoryAction.mockReset().mockResolvedValue(undefined);
    mocks.assertTrustedAppRendererEvent.mockReset();
    mocks.isDeviceLinkInvoke.mockReset().mockReturnValue(false);
    mocks.withSessionInputStoppedForRewind.mockImplementation(
      async (_sessionId: string, action: () => Promise<unknown>) => action(),
    );
    mocks.beginSubagentRewindFence.mockReturnValue({
      sessionId: 'session-1',
      token: Symbol('rewind'),
    });
    mocks.listVisibleSubagentObservationIdentities.mockResolvedValue([]);
    registerMakerRewindIpc();
  });

  // Regression: a cold task used to fail NO_LIVE_QUERY until the user sent "ok".
  // Real IPC entry, unit tier; existing stop/fence cases only exercised live tasks.
  it.each([MAKER_INVOKE.REWIND_PREVIEW, MAKER_INVOKE.REWIND_COMMIT])(
    'restores native history before %s, without another message', async (channel) => {
      let ready = false;
      mocks.prepareSessionForHistoryAction.mockImplementation(async () => { ready = true; });
      const operation = channel === MAKER_INVOKE.REWIND_PREVIEW
        ? mocks.previewRewindAtMessage : mocks.commitRewindAtMessage;
      operation.mockImplementationOnce(async () => {
        if (!ready) throw Object.assign(new Error('cold'), { code: 'NO_LIVE_QUERY' });
        return { id: 'session-1' };
      });
      await expect(mocks.handlers.get(channel)!({}, 'session-1', 'message-1'))
        .resolves.toEqual({ id: 'session-1' });
      expect(mocks.prepareSessionForHistoryAction).toHaveBeenCalledWith('session-1', 'rewind');
    },
  );

  it.each([MAKER_INVOKE.REWIND_PREVIEW, MAKER_INVOKE.REWIND_COMMIT])(
    'rejects an untrusted page before %s can start a cold task', async (channel) => {
      mocks.assertTrustedAppRendererEvent.mockImplementationOnce(() => { throw new Error('untrusted sender'); });
      await expect(mocks.handlers.get(channel)!({}, 'session-1', 'message-1')).rejects.toThrow('untrusted sender');
      expect(mocks.prepareSessionForHistoryAction).not.toHaveBeenCalled();
    },
  );

  it('skips the page check for the separately authenticated device link', async () => {
    mocks.isDeviceLinkInvoke.mockReturnValue(true);
    mocks.previewRewindAtMessage.mockResolvedValueOnce({ id: 'session-1' });
    await mocks.handlers.get(MAKER_INVOKE.REWIND_PREVIEW)!({}, 'session-1', 'message-1');
    expect(mocks.assertTrustedAppRendererEvent).not.toHaveBeenCalled();
  });

  it.each([MAKER_INVOKE.REWIND_PREVIEW, MAKER_INVOKE.REWIND_COMMIT])(
    'releases a restored runtime after %s, even when it fails', async (channel) => {
      const operation = channel === MAKER_INVOKE.REWIND_PREVIEW
        ? mocks.previewRewindAtMessage : mocks.commitRewindAtMessage;
      operation.mockRejectedValueOnce(new Error('boom'));
      await expect(mocks.handlers.get(channel)!({}, 'session-1', 'message-1')).rejects.toThrow('boom');
      expect(mocks.releaseSessionAfterHistoryAction.mock.calls.at(-1)?.[0]).toBe('session-1');
    },
  );

  it('tells the release whether the rewind actually committed', async () => {
    mocks.commitRewindAtMessage.mockResolvedValueOnce({ id: 'session-1' });
    await mocks.handlers.get(MAKER_INVOKE.REWIND_COMMIT)!({}, 'session-1', 'message-1');
    expect(mocks.releaseSessionAfterHistoryAction).toHaveBeenLastCalledWith('session-1', { rewindCommitted: true });
  });

  it('does not rewind after account changes during restoration', async () => {
    mocks.prepareSessionForHistoryAction.mockImplementationOnce(async () => {
      mocks.isOwnerCurrent.mockReturnValue(false);
    });
    await expect(mocks.handlers.get(MAKER_INVOKE.REWIND_COMMIT)!({}, 'session-1', 'message-1'))
      .rejects.toThrow('Account changed');
    expect(mocks.commitRewindAtMessage).not.toHaveBeenCalled();
  });

  it('leaves rewind untouched when native restore fails', async () => {
    mocks.prepareSessionForHistoryAction.mockRejectedValueOnce(new Error('native history unavailable'));
    await expect(mocks.handlers.get(MAKER_INVOKE.REWIND_COMMIT)!({}, 'session-1', 'message-1'))
      .rejects.toThrow('native history unavailable');
    expect(mocks.commitRewindAtMessage).not.toHaveBeenCalled();
  });

  it('does not commit rewind while authorization owns the session send boundary', async () => {
    const release = await acquireSendToSessionLock('session-1');
    mocks.commitRewindAtMessage.mockResolvedValue({ id: 'session-1' });
    const handler = mocks.handlers.get(MAKER_INVOKE.REWIND_COMMIT)!;
    const rewinding = handler({}, 'session-1', 'message-1', { stopIfRunning: true });
    try {
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(mocks.commitRewindAtMessage).not.toHaveBeenCalled();
    } finally {
      release();
    }
    await rewinding;
    expect(mocks.commitRewindAtMessage).toHaveBeenCalledOnce();
  });

  it('runs normal rewind inside the stopped input boundary when requested', async () => {
    const session = { id: 'session-1' };
    const visibleBefore = [{ provider: 'claude-code', identities: ['before'] }];
    const visibleAfter = [{ provider: 'claude-code', identities: ['survivor'] }];
    mocks.listVisibleSubagentObservationIdentities
      .mockResolvedValueOnce(visibleBefore)
      .mockResolvedValueOnce(visibleAfter);
    mocks.commitRewindAtMessage.mockResolvedValue(session);
    const handler = mocks.handlers.get(MAKER_INVOKE.REWIND_COMMIT);
    if (!handler) throw new Error('rewind commit handler not registered');

    const generation = getSessionRewindGeneration('session-1');
    await expect(handler({}, 'session-1', 'message-1', { stopIfRunning: true })).resolves.toBe(
      session,
    );
    expect(getSessionRewindGeneration('session-1')).toBe(generation + 1);

    expect(mocks.withSessionInputStoppedForRewind).toHaveBeenCalledWith(
      'session-1',
      expect.any(Function),
    );
    expect(mocks.drainPersistQueue).toHaveBeenCalledOnce();
    expect(mocks.drainPersistQueue.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.commitRewindAtMessage.mock.invocationCallOrder[0]!,
    );
    expect(mocks.commitRewindAtMessage).toHaveBeenCalledWith('session-1', 'message-1', {
      requireLatestUser: false,
      ownerScope: mocks.ownerScope,
    });
    expect(mocks.broadcastSubagentRunsInvalidated).toHaveBeenCalledWith(
      'session-1',
      mocks.ownerScope,
    );
    expect(mocks.beginSubagentRewindFence).toHaveBeenCalledWith('session-1');
    expect(mocks.primeSubagentRewindFence).toHaveBeenCalledWith(
      expect.any(Object),
      visibleBefore,
    );
    expect(mocks.finishSubagentRewindFence).toHaveBeenCalledWith(
      expect.any(Object),
      true,
      visibleAfter,
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
      expect(mocks.drainPersistQueue).toHaveBeenCalledTimes(2);
      for (let index = 0; index < 2; index += 1) {
        expect(mocks.drainPersistQueue.mock.invocationCallOrder[index]!).toBeLessThan(
          mocks.commitRewindAtMessage.mock.invocationCallOrder[index]!,
        );
      }
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
      expect(mocks.finishSubagentRewindFence).toHaveBeenCalledWith(
        expect.any(Object),
        false,
        [],
      );
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
    expect(mocks.drainPersistQueue).toHaveBeenCalledOnce();
    expect(mocks.drainPersistQueue.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.commitRewindAtMessage.mock.invocationCallOrder[0]!,
    );
    expect(mocks.commitRewindAtMessage).toHaveBeenCalledWith('session-1', 'message-1', {
      requireLatestUser: true,
      ownerScope: mocks.ownerScope,
    });
  });

  it('rolls back the Subagent fence when the post-commit identity refresh fails', async () => {
    const session = { id: 'session-1' };
    mocks.commitRewindAtMessage.mockResolvedValue(session);
    mocks.listVisibleSubagentObservationIdentities
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('transient identity read failure'));
    const handler = mocks.handlers.get(MAKER_INVOKE.REWIND_COMMIT);
    if (!handler) throw new Error('rewind commit handler not registered');

    await expect(handler({}, 'session-1', 'message-1')).rejects.toThrow(
      'transient identity read failure',
    );
    expect(mocks.finishSubagentRewindFence).toHaveBeenCalledWith(
      expect.any(Object),
      false,
      [],
    );
    expect(mocks.broadcastSubagentRunsInvalidated).not.toHaveBeenCalled();
  });

  it('rolls back the Subagent fence when the initial identity query fails', async () => {
    mocks.listVisibleSubagentObservationIdentities.mockRejectedValueOnce(
      new Error('transient initial identity read failure'),
    );
    const handler = mocks.handlers.get(MAKER_INVOKE.REWIND_COMMIT);
    if (!handler) throw new Error('rewind commit handler not registered');

    await expect(handler({}, 'session-1', 'message-1')).rejects.toThrow(
      'transient initial identity read failure',
    );
    expect(mocks.commitRewindAtMessage).not.toHaveBeenCalled();
    expect(mocks.finishSubagentRewindFence).toHaveBeenCalledWith(
      expect.any(Object),
      false,
      [],
    );
  });

  it.each(['spawn', 'progress', 'terminal'] as const)(
    'makes an already queued %s observation durable before the rewind boundary is chosen',
    async (observationKind) => {
      const durableObservations: string[] = [];
      mocks.drainPersistQueue.mockImplementationOnce(async () => {
        durableObservations.push(observationKind);
      });
      mocks.commitRewindAtMessage.mockImplementationOnce(async () => {
        expect(durableObservations).toEqual([observationKind]);
        return { id: 'session-1' };
      });
      const handler = mocks.handlers.get(MAKER_INVOKE.REWIND_COMMIT);
      if (!handler) throw new Error('rewind commit handler not registered');

      await expect(handler({}, 'session-1', 'message-1', { stopIfRunning: true })).resolves.toEqual(
        { id: 'session-1' },
      );
    },
  );
});
