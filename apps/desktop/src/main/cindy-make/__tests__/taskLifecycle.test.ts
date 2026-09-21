import { describe, expect, it, vi } from 'vitest';
import { CindyMakeManager, type CindyMakeTaskLifecycle } from '../manager.js';
import type { CindyMakeTaskStart, MakeDoctorReport } from '../../../shared/cindyMakeDoctor.js';
import type { SourcePreparationProgress, SourcePreparationResult } from '../sourcePreparation.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(runId = 'task-run') {
  const input: CindyMakeTaskStart = {
    originSessionId: 'origin',
    runId,
    request: 'fix scrolling',
    title: 'Cindy Make: fix scrolling',
  };
  const report: MakeDoctorReport = {
    runId,
    platform: 'win32',
    arch: 'x64',
    checks: [],
    status: 'running',
    task: { sessionId: runId + '-session', originSessionId: 'origin', phase: 'waiting' },
  };
  const gate = deferred();
  const lifecycle: CindyMakeTaskLifecycle = {
    create: vi.fn(async () => structuredClone(report)),
    prepare: vi.fn(async (signal, publish) => {
      publish({ ...report, task: { ...report.task!, phase: 'dependencies' } });
      await gate.promise;
      signal.throwIfAborted();
    }),
    persist: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    isCurrent: vi.fn(() => true),
    onError: vi.fn(),
  };
  return { input, report, gate, lifecycle };
}

function sourceFixture() {
  const cancelled = (): SourcePreparationResult => ({
    status: 'cancelled',
    path: 'project/source',
    target: { channel: 'dev', version: '0.0.0', ref: 'main', candidates: ['main'] },
  });
  return {
    root: 'project',
    clearOnly: true,
    signal: new AbortController().signal,
    cancelled,
    onProgress: vi.fn(),
    toStatus: (progress: SourcePreparationProgress) => ({
      status: progress.status,
      path: progress.path,
      phase: progress.phase,
    }),
    run: vi.fn(async (): Promise<SourcePreparationResult> => ({ ...cancelled(), status: 'ready' })),
  };
}

describe('Main-owned Cindy Make task lifecycle', () => {
  it('reserves one build across entry points and ignores an old release after retry', () => {
    const manager = new CindyMakeManager();
    const release = manager.claimPersonalBuild();
    expect(manager.hasActiveWork()).toBe(true);
    expect(() => manager.claimPersonalBuild()).toThrow('personal build is running');
    release();
    const releaseRetry = manager.claimPersonalBuild();
    release();
    expect(manager.hasActiveWork()).toBe(true);
    releaseRetry();
    expect(manager.hasActiveWork()).toBe(false);
  });
  it('publishes only the current build owners and clears them when the lease settles', () => {
    const manager = new CindyMakeManager();
    const changed = vi.fn();
    manager.subscribe(changed);
    let current = true;
    const release = manager.claimPersonalBuild(['first', 'second', 'first'], () => current);
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ personalBuildSessionIds: ['first', 'second'] }),
    );
    current = false;
    expect(manager.getState().personalBuildSessionIds).toBeUndefined();
    // An old account still owns cleanup, but never appears in the new account's tasks.
    expect(manager.hasActiveWork()).toBe(true);
    release();
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ personalBuildSessionIds: undefined }),
    );
    const releaseRetry = manager.claimPersonalBuild(['retry']);
    release();
    expect(manager.getState().personalBuildSessionIds).toEqual(['retry']);
    releaseRetry();
    expect(manager.getState().personalBuildSessionIds).toBeUndefined();
    expect(new CindyMakeManager().getState().personalBuildSessionIds).toBeUndefined();
  });
  it.each(['completed', 'failed', 'cancelled'] as const)(
    'keeps the lock through final persistence, then retains %s history without staying busy',
    async (status) => {
      const manager = new CindyMakeManager();
      const f = fixture();
      const persisted = deferred();
      f.lifecycle.persist = vi.fn(async (report) => {
        if (report.status !== 'running') await persisted.promise;
      });
      if (status === 'failed')
        f.lifecycle.start = async () => {
          throw new Error('dispatch failed');
        };
      const created = manager.startTask(f.input, f.lifecycle);
      expect(manager.hasActiveWork()).toBe(true);
      await created;
      if (status === 'cancelled') manager.cancel(f.input.runId, 1);
      f.gate.resolve();
      await vi.waitFor(() => expect(manager.taskReport(f.input.runId)?.status).toBe(status));
      expect(manager.hasActiveWork()).toBe(true);
      persisted.resolve();
      await manager.waitForTask(f.input.runId);
      expect(manager.hasActiveWork()).toBe(false);
      expect(manager.getState().tasks?.[f.input.runId]?.status).toBe(status);
      vi.mocked(f.lifecycle.isCurrent).mockReturnValue(false);
      expect(manager.hasActiveWork()).toBe(false);
    },
  );
  it('keeps cancelled old-owner work busy until its actual cleanup settles', async () => {
    const manager = new CindyMakeManager();
    const f = fixture();
    await manager.startTask(f.input, f.lifecycle);
    vi.mocked(f.lifecycle.isCurrent).mockReturnValue(false);
    expect(manager.hasActiveWork()).toBe(true);
    f.gate.resolve();
    await manager.waitForTask(f.input.runId);
    expect(manager.hasActiveWork()).toBe(false);
  });
  it('keeps one cleanup running without renderer subscribers and shares duplicate requests', async () => {
    const manager = new CindyMakeManager();
    const gate = deferred();
    const run = vi.fn(() => gate.promise);
    const unsubscribe = manager.subscribe(() => {});
    const first = manager.runTaskAction('session', 'delete', () => true, run);
    unsubscribe();
    const second = manager.runTaskAction('session', 'delete', () => true, run);
    expect(second).toBe(first);
    expect(manager.getState().taskActions?.session).toEqual({
      action: 'delete',
      status: 'running',
    });
    const reopened = vi.fn();
    manager.subscribe(reopened);
    expect(reopened).toHaveBeenCalledWith(
      expect.objectContaining({
        taskActions: { session: { action: 'delete', status: 'running' } },
      }),
    );
    await expect(manager.runTaskAction('session', 'finish', () => true, run)).rejects.toMatchObject(
      { code: 'busy' },
    );
    gate.resolve();
    await first;
    expect(run).toHaveBeenCalledTimes(1);
    expect(manager.getState().taskActions?.session).toBeUndefined();
  });
  it('preserves cleanup failures across view lifetimes and clears them when retrying', async () => {
    const manager = new CindyMakeManager();
    await expect(
      manager.runTaskAction(
        'session',
        'delete',
        () => true,
        async () => {
          throw Object.assign(new Error('locked'), { code: 'directoryBusy' });
        },
      ),
    ).rejects.toThrow('locked');
    expect(manager.getState().taskActions?.session).toEqual({
      action: 'delete',
      status: 'failed',
      error: 'directoryBusy',
    });
    expect(manager.hasActiveWork()).toBe(false);
    const gate = deferred();
    const retry = manager.runTaskAction(
      'session',
      'delete',
      () => true,
      () => gate.promise,
    );
    expect(manager.getState().taskActions?.session).toEqual({
      action: 'delete',
      status: 'running',
    });
    gate.resolve();
    await retry;
    expect(manager.getState().taskActions?.session).toBeUndefined();
  });
  it('tracks the canonical recycle inside an action without waiting on itself', async () => {
    const manager = new CindyMakeManager();
    const recycle = vi.fn(async () => {});
    await manager.runTaskAction(
      'session',
      'finish',
      () => true,
      () => manager.runTaskAction('session', 'finish', () => true, recycle, true),
    );
    expect(recycle).toHaveBeenCalledOnce();
    expect(manager.getState().taskActions?.session).toBeUndefined();
  });
  it('does not leak old-owner cleanup or let its completion erase a newer job', async () => {
    const manager = new CindyMakeManager();
    const oldGate = deferred();
    const newGate = deferred();
    let current = true;
    const old = manager.runTaskAction(
      'session',
      'delete',
      () => current,
      () => oldGate.promise,
    );
    await Promise.resolve();
    current = false;
    expect(manager.getState().taskActions?.session).toBeUndefined();
    const newer = manager.runTaskAction(
      'session',
      'delete',
      () => true,
      () => newGate.promise,
    );
    oldGate.resolve();
    await old;
    expect(manager.getState().taskActions?.session?.status).toBe('running');
    newGate.resolve();
    await newer;
  });
  it('does not mistake a plain archive recycle for the explicitly requested Finish', async () => {
    const manager = new CindyMakeManager();
    const gate = deferred();
    const background = manager.runTaskAction(
      'session',
      'finish',
      () => true,
      () => gate.promise,
      true,
    );
    const merge = vi.fn(async () => {});
    const explicit = manager.runTaskAction('session', 'finish', () => true, merge);
    expect(merge).not.toHaveBeenCalled();
    gate.resolve();
    await background;
    await explicit;
    expect(merge).toHaveBeenCalledOnce();
  });
  it('does not replace live source progress with a slow directory read', async () => {
    const manager = new CindyMakeManager();
    const gate = deferred();
    const read = manager.refreshSourceStatus(async () => {
      await gate.promise;
      return { status: 'missing', path: '/source' };
    });
    manager.setSourceStatus({ status: 'preparing', path: '/source', phase: 'installing' });
    gate.resolve();
    await expect(read).resolves.toMatchObject({ status: 'preparing', phase: 'installing' });
    expect(manager.getState().source?.status).toBe('preparing');
  });

  it('retains complete owner-scoped reports independently of renderer subscriptions', () => {
    const manager = new CindyMakeManager();
    const { report } = fixture();
    let current = true;
    manager.setReport(report, () => current);
    report.status = 'failed';
    expect(manager.getState().reports?.[report.runId]?.status).toBe('running');
    const snapshot = manager.getState();
    snapshot.reports![report.runId].status = 'failed';
    expect(manager.getState().reports?.[report.runId]?.status).toBe('running');
    current = false;
    expect(manager.getState().reports?.[report.runId]).toBeUndefined();
  });

  it('prevents clear during send admission and the subsequent running turn', async () => {
    const manager = new CindyMakeManager();
    const gate = deferred();
    const source = sourceFixture();
    let turnRunning = false;
    manager.setProjectBusyProbe(() => turnRunning);
    const send = manager.withProjectUse('project', async () => {
      await gate.promise;
      turnRunning = true;
    });
    await expect(manager.prepareSource(source)).rejects.toMatchObject({ code: 'busy' });
    gate.resolve();
    await send;
    await expect(manager.prepareSource(source)).rejects.toMatchObject({ code: 'busy' });
    expect(source.run).not.toHaveBeenCalled();
    turnRunning = false;
    await expect(manager.prepareSource(source)).resolves.toMatchObject({ status: 'ready' });
  });

  it('rejects new sends while clear is awaiting filesystem work', async () => {
    const manager = new CindyMakeManager();
    const source = sourceFixture();
    const gate = deferred();
    source.run.mockImplementation(async () => {
      await gate.promise;
      return { ...source.cancelled(), status: 'ready' };
    });
    const clearing = manager.prepareSource(source);
    await vi.waitFor(() => expect(source.run).toHaveBeenCalledOnce());
    const send = vi.fn(async () => undefined);
    await expect(manager.withProjectUse('project', send)).rejects.toMatchObject({ code: 'busy' });
    expect(send).not.toHaveBeenCalled();
    gate.resolve();
    await clearing;
    await manager.withProjectUse('project', send);
    expect(send).toHaveBeenCalledOnce();
  });

  it('releases project use when send preflight fails', async () => {
    const manager = new CindyMakeManager();
    await expect(
      manager.withProjectUse('project', async () => {
        throw new Error('missing worktree');
      }),
    ).rejects.toThrow('missing worktree');
    await expect(manager.prepareSource(sourceFixture())).resolves.toMatchObject({
      status: 'ready',
    });
  });

  it('shows queued source work to both the global state and callers joining before it starts', async () => {
    const manager = new CindyMakeManager();
    const source = { ...sourceFixture(), clearOnly: false };
    const blocked = deferred();
    const preceding = manager.withProject(source.root, () => blocked.promise);
    const first = manager.prepareSource(source);
    const lateProgress = vi.fn();
    const second = manager.prepareSource({ ...source, onProgress: lateProgress });
    try {
      expect(source.run).not.toHaveBeenCalled();
      expect(manager.getState().source).toMatchObject({ status: 'preparing', phase: 'waiting' });
      expect(source.onProgress).toHaveBeenLastCalledWith(
        expect.objectContaining({ phase: 'waiting' }),
      );
      expect(lateProgress).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'waiting' }));
    } finally {
      blocked.resolve();
      await Promise.all([preceding, first, second]);
    }
    expect(source.run).toHaveBeenCalledOnce();
  });

  it('persists queued cancellation inside the project lock before later writers', async () => {
    const manager = new CindyMakeManager();
    const source = sourceFixture();
    const blocked = deferred();
    const persisted = deferred();
    const controller = new AbortController();
    const events: string[] = [];
    const preceding = manager.withProject('project', () => blocked.promise);
    const cancelled = manager.prepareSource({
      ...source,
      signal: controller.signal,
      onCancelledBeforeStart: async () => {
        events.push('cancel-write');
        await persisted.promise;
      },
    });
    controller.abort();
    const next = manager.withProject('project', async () => {
      events.push('retry-write');
    });
    blocked.resolve();
    await preceding;
    await vi.waitFor(() => expect(events).toEqual(['cancel-write']));
    persisted.resolve();
    await Promise.all([cancelled, next]);
    expect(events).toEqual(['cancel-write', 'retry-write']);
    expect(source.run).not.toHaveBeenCalled();
  });

  it('revokes first dispatch synchronously when the task is cleared', async () => {
    const manager = new CindyMakeManager();
    const { input, lifecycle, gate, report } = fixture();
    await manager.startTask(input, lifecycle);
    manager.cancelTasksForSession(report.task!.sessionId);
    gate.resolve();
    await manager.waitForTask(input.runId);
    expect(lifecycle.start).not.toHaveBeenCalled();
    expect(manager.taskReport(input.runId)?.status).toBe('cancelled');
  });

  it('creates and persists a visible task before dependency installation, then starts exactly once without subscribers', async () => {
    const manager = new CindyMakeManager();
    const { input, lifecycle, gate, report } = fixture();
    const unsubscribe = manager.subscribe(vi.fn());
    expect(await manager.startTask(input, lifecycle)).toBe(report.task!.sessionId);
    expect(lifecycle.persist).toHaveBeenCalledWith(report);
    expect(manager.taskReport(input.runId)?.task?.phase).toBe('dependencies');
    expect(lifecycle.start).not.toHaveBeenCalled();
    unsubscribe();
    expect(await manager.startTask(input, lifecycle)).toBe(report.task!.sessionId);
    expect(lifecycle.create).toHaveBeenCalledTimes(1);
    gate.resolve();
    await manager.waitForTask(input.runId);
    expect(lifecycle.start).toHaveBeenCalledTimes(1);
    expect(manager.taskReport(input.runId)).toMatchObject({
      status: 'completed',
      task: { phase: 'completed' },
    });
    await manager.startTask(input, lifecycle);
    expect(lifecycle.start).toHaveBeenCalledTimes(1);
  });

  it('coalesces clicks while task creation itself is pending', async () => {
    const manager = new CindyMakeManager();
    const { input, lifecycle, report, gate } = fixture();
    const creation = deferred();
    vi.mocked(lifecycle.create).mockImplementation(async () => {
      await creation.promise;
      return report;
    });
    const first = manager.startTask(input, lifecycle);
    const second = manager.startTask(input, lifecycle);
    expect(first).toBe(second);
    creation.resolve();
    await first;
    gate.resolve();
    await manager.waitForTask(input.runId);
    expect(lifecycle.create).toHaveBeenCalledOnce();
    expect(lifecycle.start).toHaveBeenCalledOnce();
  });

  it.each(['cancel', 'failed'] as const)(
    'does not send on %s and retries the same task',
    async (reason) => {
      const manager = new CindyMakeManager();
      const { input, lifecycle, gate, report } = fixture();
      if (reason === 'failed')
        vi.mocked(lifecycle.prepare).mockRejectedValueOnce(new Error('install failed'));
      await manager.startTask(input, lifecycle);
      if (reason === 'cancel') expect(manager.cancel(input.runId, 99)).toBe('cancelled');
      gate.resolve();
      await manager.waitForTask(input.runId);
      expect(manager.taskReport(input.runId)?.status).toBe(
        reason === 'cancel' ? 'cancelled' : 'failed',
      );
      expect(lifecycle.start).not.toHaveBeenCalled();
      expect(await manager.startTask(input, lifecycle)).toBe(report.task!.sessionId);
      await manager.waitForTask(input.runId);
      expect(lifecycle.start).toHaveBeenCalledOnce();
    },
  );

  it('retains a failed dispatch for explicit retry rather than treating it as accepted', async () => {
    const manager = new CindyMakeManager();
    const { input, lifecycle, gate } = fixture();
    vi.mocked(lifecycle.start).mockRejectedValueOnce(new Error('not accepted'));
    gate.resolve();
    await manager.startTask(input, lifecycle);
    await manager.waitForTask(input.runId);
    expect(manager.taskReport(input.runId)?.status).toBe('failed');
    await manager.startTask(input, lifecycle);
    await manager.waitForTask(input.runId);
    expect(lifecycle.start).toHaveBeenCalledTimes(2);
    expect(manager.taskReport(input.runId)?.status).toBe('completed');
  });

  it('does not persist or dispatch into a different account', async () => {
    const manager = new CindyMakeManager();
    const { input, lifecycle, gate } = fixture();
    await manager.startTask(input, lifecycle);
    await Promise.resolve();
    vi.mocked(lifecycle.isCurrent).mockReturnValue(false);
    vi.mocked(lifecycle.persist).mockClear();
    gate.resolve();
    await manager.waitForTask(input.runId);
    expect(lifecycle.start).not.toHaveBeenCalled();
    expect(lifecycle.persist).not.toHaveBeenCalled();
    expect(manager.getState().tasks).toBeUndefined();
  });

  it('keeps simultaneous task snapshots separate and immutable', async () => {
    const manager = new CindyMakeManager();
    const first = fixture('one');
    const second = fixture('two');
    await manager.startTask(first.input, first.lifecycle);
    await manager.startTask(second.input, second.lifecycle);
    const snapshot = manager.getState();
    snapshot.tasks!.one.status = 'failed';
    expect(manager.taskReport('one')?.status).toBe('running');
    first.gate.resolve();
    await manager.waitForTask('one');
    expect(manager.taskReport('two')?.status).toBe('running');
    second.gate.resolve();
    await manager.waitForTask('two');
  });

  it('serializes project preparation, branch changes and completion writes', async () => {
    const manager = new CindyMakeManager();
    const gate = deferred();
    const events: string[] = [];
    const first = manager.withProject('project', async () => {
      events.push('install');
      await gate.promise;
      events.push('installed');
    });
    const second = manager.withProject('project', async () => {
      events.push('commit');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['install']);
    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['install', 'installed', 'commit']);
  });

  it('blocks dispatch when progress cannot be persisted', async () => {
    const manager = new CindyMakeManager();
    const { input, lifecycle, gate } = fixture();
    vi.mocked(lifecycle.persist)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('disk full'));
    await manager.startTask(input, lifecycle);
    gate.resolve();
    await manager.waitForTask(input.runId);
    expect(lifecycle.start).not.toHaveBeenCalled();
    expect(manager.taskReport(input.runId)?.status).toBe('failed');
  });

  it('does not restart a persisted accepted task and rejects a mismatched run id', async () => {
    const manager = new CindyMakeManager();
    const { input, lifecycle, report } = fixture();
    vi.mocked(lifecycle.create).mockResolvedValue({ ...report, status: 'completed' });
    await manager.startTask(input, lifecycle);
    await manager.waitForTask(input.runId);
    expect(lifecycle.prepare).not.toHaveBeenCalled();
    expect(lifecycle.start).not.toHaveBeenCalled();
    await expect(
      manager.startTask({ ...input, request: 'other' }, lifecycle),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});
