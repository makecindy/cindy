import { describe, expect, it, vi } from 'vitest';
import {
  createDeferredProjectMoveController,
  type DeferredProjectMoveDeps,
  type DeferredProjectMoveIntent,
  type DeferredProjectMoveScope,
  type DeferredProjectMoveTarget,
} from '../deferredProjectMove.js';

const project = (name: string): DeferredProjectMoveTarget => ({
  workingDir: `/${name}`,
  workspaceKind: 'project',
});
const A = project('a'),
  B = project('b'),
  C = project('c');
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Test the durable protocol independently from Electron, SQLite and runtimes. */
function harness() {
  const records = new Map<string, DeferredProjectMoveIntent>();
  const targets = new Map<string, DeferredProjectMoveTarget>([['task', A]]);
  let owner = 1;
  let busy = false;
  const locks = new Map<string, Promise<unknown>>();
  const scope = (): DeferredProjectMoveScope => {
    const captured = owner;
    const assertCurrent = () => {
      if (owner !== captured) throw new Error('owner changed');
    };
    return {
      key: String(captured),
      assertCurrent,
      read(id) {
        assertCurrent();
        return records.get(id) ?? null;
      },
      list() {
        assertCurrent();
        return [...records.values()];
      },
      save(intent) {
        assertCurrent();
        records.set(intent.sessionId, structuredClone(intent));
      },
      remove(id, expected) {
        assertCurrent();
        if (records.get(id)?.id !== expected) return false;
        records.delete(id);
        return true;
      },
    };
  };
  const deps: DeferredProjectMoveDeps = {
    captureScope: scope,
    withSessionLock: async <T>(id: string, run: () => Promise<T>): Promise<T> => {
      const pending = (locks.get(id) ?? Promise.resolve()).then(run);
      locks.set(
        id,
        pending.catch(() => undefined),
      );
      return pending;
    },
    readCurrentTarget: vi.fn(async (id) => targets.get(id) ?? null),
    isBusy: vi.fn(() => busy),
    applyMove: vi.fn(async (intent, { assertCurrent }) => {
      assertCurrent();
      targets.set(intent.sessionId, { ...intent.target });
    }),
    publish: vi.fn(),
    onFailure: vi.fn(),
  };
  const controller = createDeferredProjectMoveController(deps);
  return {
    deps,
    controller,
    targets,
    records,
    setBusy: (value: boolean) => {
      busy = value;
    },
    changeOwner: () => {
      owner += 1;
    },
  };
}

describe('deferred project move', () => {
  it('shows the destination while leaving a busy runtime workspace untouched', async () => {
    const h = harness();
    h.setBusy(true);
    h.controller.stage('task', A, B);
    expect(h.controller.project('task')).toEqual({ workingDir: '/b' });
    expect(await h.controller.settle('task')).toBe('busy');
    expect(h.targets.get('task')).toEqual(A);
    expect(h.deps.applyMove).not.toHaveBeenCalled();
    expect(h.records.size).toBe(1);
    h.setBusy(false);
    expect(await h.controller.settle('task')).toBe('applied');
    expect(h.targets.get('task')).toEqual(B);
    expect(h.controller.project('task')).toBeNull();
    expect(h.records.size).toBe(0);
    expect(h.deps.onFailure).not.toHaveBeenCalled();
  });

  it('replaces an earlier destination and can cancel by returning to the current project', async () => {
    const h = harness();
    const first = h.controller.stage('task', A, B)!;
    const second = h.controller.stage('task', A, C)!;
    expect(first.id).not.toBe(second.id);
    await h.controller.settle('task');
    expect(h.targets.get('task')).toEqual(C);
    expect(h.deps.applyMove).toHaveBeenCalledTimes(1);
    h.controller.stage('task', C, B);
    expect(h.controller.stage('task', C, C)).toBeNull();
    expect(h.records.size).toBe(0);
    expect(h.controller.project('task')).toBeNull();
  });

  it('projects dialogue membership without changing the actual directory', async () => {
    const h = harness();
    h.controller.stage('task', A, { workingDir: '/a', workspaceKind: 'dialogue' });
    expect(h.controller.project('task')).toEqual({ workingDir: null });
    expect(h.targets.get('task')).toEqual(A);
    await h.controller.settle('task');
    expect(h.targets.get('task')).toEqual({ workingDir: '/a', workspaceKind: 'dialogue' });
  });

  it('recovers pending choices in a fresh controller and drains them', async () => {
    const h = harness();
    h.controller.stage('task', A, B);
    const restarted = createDeferredProjectMoveController(h.deps);
    expect(restarted.project('task')).toEqual({ workingDir: '/b' });
    await restarted.drain();
    expect(h.targets.get('task')).toEqual(B);
    expect(restarted.project('task')).toBeNull();
  });

  it('does not repeat a move already committed before a crash', async () => {
    const h = harness();
    h.controller.stage('task', A, B);
    h.targets.set('task', B);
    expect(await h.controller.settle('task')).toBe('applied');
    expect(h.deps.applyMove).not.toHaveBeenCalled();
    expect(h.records.size).toBe(0);
  });

  it('does not overwrite a workspace changed by another operation', async () => {
    const h = harness();
    h.controller.stage('task', A, B);
    h.targets.set('task', C);
    expect(await h.controller.settle('task')).toBe('cancelled');
    expect(h.targets.get('task')).toEqual(C);
    expect(h.deps.applyMove).not.toHaveBeenCalled();
    expect(h.deps.onFailure).toHaveBeenCalledWith(
      'task',
      expect.objectContaining({ message: 'PROJECT_MOVE_SOURCE_CHANGED' }),
    );
    expect(h.controller.project('task')).toBeNull();
  });

  it('clears a failed choice once, keeping the actual workspace and surfacing failure', async () => {
    const h = harness();
    const failure = new Error('destination disappeared');
    vi.mocked(h.deps.applyMove).mockRejectedValue(failure);
    h.controller.stage('task', A, B);
    expect(await h.controller.settle('task')).toBe('cancelled');
    expect(await h.controller.settle('task')).toBe('none');
    expect(h.targets.get('task')).toEqual(A);
    expect(h.deps.onFailure).toHaveBeenCalledExactlyOnceWith('task', failure);
    expect(h.deps.publish).toHaveBeenLastCalledWith('task', null);
  });

  it('retains a move when a worker lock cannot be acquired without waiting', async () => {
    const h = harness();
    vi.mocked(h.deps.applyMove).mockResolvedValue('busy');
    h.controller.stage('task', A, B);
    expect(await h.controller.settle('task', { beforeSend: true })).toBe('busy');
    expect(h.controller.project('task')).toEqual({ workingDir: '/b' });
    expect(h.deps.onFailure).not.toHaveBeenCalled();
  });

  it('fences an account change during a busy-state read without cancelling the old intent', async () => {
    const h = harness();
    const check = deferred<boolean>();
    vi.mocked(h.deps.isBusy).mockReturnValue(check.promise);
    h.controller.stage('task', A, B);
    const settling = h.controller.settle('task', { lockHeld: true });
    await vi.waitFor(() => expect(h.deps.isBusy).toHaveBeenCalled());
    h.changeOwner();
    check.resolve(false);
    expect(await settling).toBe('superseded');
    expect(h.records.size).toBe(1);
    expect(h.deps.applyMove).not.toHaveBeenCalled();
    expect(h.deps.onFailure).not.toHaveBeenCalled();
    expect(h.deps.publish).toHaveBeenCalledTimes(1);
  });

  it('does not remove a newer intent when an older apply is superseded', async () => {
    const h = harness();
    const wait = deferred<void>();
    vi.mocked(h.deps.applyMove).mockImplementation(async (_intent, options) => {
      await wait.promise;
      options.assertCurrent();
    });
    h.controller.stage('task', A, B);
    const settling = h.controller.settle('task', { lockHeld: true });
    await vi.waitFor(() => expect(h.deps.applyMove).toHaveBeenCalled());
    h.controller.stage('task', A, C);
    wait.resolve();
    expect(await settling).toBe('superseded');
    expect(h.controller.project('task')).toEqual({ workingDir: '/c' });
    expect(h.deps.onFailure).not.toHaveBeenCalled();
  });

  it('does not self-deadlock when a send settles while an idle caller waits for its lock', async () => {
    const h = harness();
    h.controller.stage('task', A, B);
    const acquired = deferred<void>(),
      release = deferred<void>();
    const send = h.deps.withSessionLock('task', async () => {
      acquired.resolve();
      await release.promise;
      return h.controller.settle('task', { lockHeld: true, beforeSend: true });
    });
    await acquired.promise;
    const idle = h.controller.settle('task');
    release.resolve();
    expect(await send).toBe('applied');
    expect(await idle).toBe('none');
    expect(h.deps.applyMove).toHaveBeenCalledTimes(1);
    expect(h.deps.isBusy).toHaveBeenCalledWith('task', { lockHeld: true, beforeSend: true });
  });

  it('removes intents for deleted tasks without an unrelated failure notification', async () => {
    const h = harness();
    h.controller.stage('task', A, B);
    h.targets.delete('task');
    expect(await h.controller.settle('task')).toBe('cancelled');
    expect(h.deps.onFailure).not.toHaveBeenCalled();
    expect(h.records.size).toBe(0);
  });

  it('recognizes committed moves even when their post-commit notification failed', async () => {
    const h = harness();
    vi.mocked(h.deps.applyMove).mockImplementation(async (intent) => {
      h.targets.set('task', intent.target);
      throw new Error('post-commit notification failed');
    });
    h.controller.stage('task', A, B);
    expect(await h.controller.settle('task')).toBe('applied');
    expect(h.targets.get('task')).toEqual(B);
    expect(h.deps.onFailure).not.toHaveBeenCalled();
    expect(h.records.size).toBe(0);
  });

  it('keeps ordinary session reads available when the owner or journal cannot be read', () => {
    const h = harness();
    h.deps.captureScope = () => {
      throw new Error('owner not ready');
    };
    expect(h.controller.project('task')).toBeNull();
    expect(() => h.controller.stage('task', A, B)).toThrow('owner not ready');
  });

  it('refreshes projected choices made and cleared by another instance during recovery', async () => {
    const h = harness();
    h.setBusy(true);
    expect(h.controller.project('task')).toBeNull();
    const other = createDeferredProjectMoveController(h.deps);
    other.stage('task', A, B);
    await h.controller.drain();
    expect(h.controller.project('task')).toEqual({ workingDir: '/b' });
    other.stage('task', A, A);
    await h.controller.drain();
    expect(h.controller.project('task')).toBeNull();
    expect(h.deps.publish).toHaveBeenLastCalledWith('task', null);
  });

  it('settles newly requested tasks while an earlier recovery still waits for another route lock', async () => {
    const h = harness();
    h.targets.set('another-task', A);
    h.controller.stage('task', A, B);
    const acquired = deferred<void>(),
      release = deferred<void>();
    const blocker = h.deps.withSessionLock('task', async () => {
      acquired.resolve();
      await release.promise;
    });
    await acquired.promise;
    const draining = h.controller.drain();
    h.controller.stage('another-task', A, C);
    await h.controller.drain();
    expect(h.targets.get('another-task')).toEqual(C);
    expect(h.targets.get('task')).toEqual(A);
    release.resolve();
    await blocker;
    await draining;
    expect(h.targets.get('task')).toEqual(B);
    expect(h.records.size).toBe(0);
  });
});
