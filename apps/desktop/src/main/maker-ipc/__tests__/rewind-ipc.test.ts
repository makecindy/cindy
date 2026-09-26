import { getSessionRewindGeneration } from '../sendToSessionLock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withTaskMigrationBoundary } from '../../task-migration/writeBoundary';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  assertWritable: vi.fn(),
  root: '',
  previewRewindAtMessage: vi.fn(),
  commitRewindAtMessage: vi.fn(),
  drainPersistQueue: vi.fn(),
  withSessionInputStoppedForRewind: vi.fn(),
  ownerScope: { ownerScopeKey: 'owner-1' },
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
vi.mock('../../task-migration/journal', () => ({
  assertTaskMigrationWritable: mocks.assertWritable,
  migrationScope: () => ({ root: mocks.root, assertCurrent() {} }),
}));
vi.mock('../../worktree/resourceLock', async original => {
  const actual = await original<typeof import('../../worktree/resourceLock')>();
  return { ...actual, withWorktreeResourceLocks: (ids: readonly string[], task: () => Promise<unknown>) =>
    // Deadline unit tests advance a virtual clock; admission tests below use real file locks.
    vi.isFakeTimers() ? task() : actual.withWorktreeResourceLocks(ids, task) };
});

vi.mock('../../maker-orchestration/rewind.js', () => ({
  previewRewindAtMessage: mocks.previewRewindAtMessage,
  commitRewindAtMessage: mocks.commitRewindAtMessage,
}));

vi.mock('../../messagePersistBroadcaster.js', () => ({
  drainPersistQueue: mocks.drainPersistQueue,
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
    mocks.root = mkdtempSync(join(tmpdir(), 'rewind-admission-'));
    mocks.assertWritable.mockReset();
    mocks.handlers.clear();
    mocks.drainPersistQueue.mockResolvedValue(undefined);
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
  afterEach(() => rmSync(mocks.root, { recursive: true, force: true }));

  it.each([false, true])('serializes rewind and migration through commit (migration first: %s)', async migrationFirst => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const handler = mocks.handlers.get(MAKER_INVOKE.REWIND_COMMIT)!;
    if (migrationFirst) {
      const entered = vi.fn();
      const preparing = withTaskMigrationBoundary(['session-1'], async () => {
        entered(); await gate;
        mocks.assertWritable.mockImplementation(() => { throw new Error('MIGRATION_TASK_BUSY'); });
      });
      await vi.waitFor(() => expect(entered).toHaveBeenCalled());
      const rejected = expect(handler({}, 'session-1', 'message-1')).rejects.toThrow('MIGRATION_TASK_BUSY');
      release(); await Promise.all([preparing, rejected]);
      expect(mocks.commitRewindAtMessage).not.toHaveBeenCalled();
    } else {
      mocks.commitRewindAtMessage.mockImplementationOnce(async () => { await gate; return { id: 'session-1' }; });
      const rewinding = handler({}, 'session-1', 'message-1');
      await vi.waitFor(() => expect(mocks.commitRewindAtMessage).toHaveBeenCalled());
      const snapshot = vi.fn(async () => {});
      const preparing = withTaskMigrationBoundary(['session-1'], snapshot);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(snapshot).not.toHaveBeenCalled();
      release(); await Promise.all([rewinding, preparing]);
    }
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

  it('rejects a moved task before stopping input or restoring files', async () => {
    mocks.assertWritable.mockImplementation(() => { throw new Error('MIGRATION_TASK_MOVED'); });
    const handler = mocks.handlers.get(MAKER_INVOKE.REWIND_COMMIT)!;
    await expect(handler({}, 'session-1', 'message-1', { stopIfRunning: true })).rejects.toThrow('MIGRATION_TASK_MOVED');
    expect(mocks.withSessionInputStoppedForRewind).not.toHaveBeenCalled();
    expect(mocks.commitRewindAtMessage).not.toHaveBeenCalled();
  });
  it('rechecks migration after waiting for the shared commit lock', async () => {
    const release = await acquireSendToSessionLock('session-1');
    const handler = mocks.handlers.get(MAKER_INVOKE.REWIND_COMMIT)!;
    const rewinding = handler({}, 'session-1', 'message-1');
    for (let i = 0; i < 20; i++) await Promise.resolve();
    mocks.assertWritable.mockImplementation(() => { throw new Error('MIGRATION_TASK_BUSY'); });
    const rejected = expect(rewinding).rejects.toThrow('MIGRATION_TASK_BUSY');
    release();
    await rejected;
    expect(mocks.commitRewindAtMessage).not.toHaveBeenCalled();
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
