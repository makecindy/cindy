import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DeferredProjectMoveIntent,
  DeferredProjectMoveScope,
} from '../deferredProjectMove.js';
import type { setDeferredHostMove } from '../moveSession.js';
import type { setProjectMoveHooks } from '../projectMoveBridge.js';

type HostMove = NonNullable<Parameters<typeof setDeferredHostMove>[0]>;
type MoveHooks = NonNullable<Parameters<typeof setProjectMoveHooks>[0]>;
const h = vi.hoisted(() => ({
  owner: 1,
  row: {
    id: 'task',
    workingDir: '/a',
    workspaceKind: 'project',
    status: 'active',
    sdkSessionId: null as string | null,
  },
  workers: [] as Array<{ sessionId: string }>,
  busy: new Set<string>(),
  records: new Map<string, DeferredProjectMoveIntent>(),
  locks: new Map<string, Promise<unknown>>(),
  move: null as HostMove | null,
  hooks: null as MoveHooks | null,
  projector: null as null | ((id: string) => { workingDir: string | null } | null),
  actualMove: vi.fn(),
  broadcast: vi.fn(),
  passive: false,
  dbReady: true,
  workersLocked: false,
  inspect: vi.fn(),
}));

vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../localDb/ipc/sessions.js', () => ({ broadcastSessionPatched: h.broadcast }));
vi.mock('../../localDb/mapper.js', () => ({
  setSessionProjectMoveProjector: (projector: typeof h.projector) => {
    h.projector = projector;
  },
}));
vi.mock('../../localDb/client/current.js', () => {
  const client = {
    drizzle: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ ...h.row }] }),
          innerJoin: () => ({ where: async () => h.workers }),
        }),
      }),
    },
  };
  return {
    getDbClient: () => {
      if (!h.dbReady) throw new Error('DB not ready');
      return client;
    },
    tryGetDbClient: () => (h.dbReady ? client : null),
  };
});
vi.mock('../../localDb/sessionRouteLock.js', () => ({
  withSessionRouteLock: async <T>(id: string, run: () => Promise<T>): Promise<T> => {
    const pending = (h.locks.get(id) ?? Promise.resolve()).then(run);
    h.locks.set(
      id,
      pending.catch(() => undefined),
    );
    return pending;
  },
}));
vi.mock('../deferredProjectMoveJournal.js', () => ({
  captureDeferredProjectMoveScope: (): DeferredProjectMoveScope => {
    const owner = h.owner;
    const assertCurrent = () => {
      if (owner !== h.owner) throw new Error('owner changed');
    };
    return {
      key: String(owner),
      assertCurrent,
      read(id) {
        assertCurrent();
        return h.records.get(id) ?? null;
      },
      list() {
        assertCurrent();
        return [...h.records.values()];
      },
      save(intent) {
        assertCurrent();
        h.records.set(intent.sessionId, intent);
      },
      remove(id, expectedId) {
        assertCurrent();
        if (h.records.get(id)?.id !== expectedId) return false;
        h.records.delete(id);
        return true;
      },
    };
  },
}));
vi.mock('../moveSession.js', () => ({
  setDeferredHostMove: (move: HostMove | null) => {
    h.move = move;
  },
  moveSessionProject: h.actualMove,
  inspectSessionProjectMove: h.inspect,
}));
vi.mock('../createProject.js', () => ({
  validateLocalProjectDirectory: (workingDir: string) => ({ ok: true, workingDir }),
  withLocalProjectContext: async (
    _id: string,
    run: (context: { assertCurrent(): void }) => Promise<unknown>,
  ) => {
    const owner = h.owner;
    try {
      return await run({
        assertCurrent: () => {
          if (owner !== h.owner) throw new Error('owner changed');
        },
      });
    } catch (error) {
      return {
        ok: false,
        errorCode: (error as { code?: string }).code ?? 'INTERNAL',
        message: String(error),
      };
    }
  },
}));
vi.mock('../projectMoveBridge.js', () => ({
  setProjectMoveHooks: (hooks: MoveHooks | null) => {
    h.hooks = hooks;
  },
}));

import { initializeProjectMoves } from '../projectMoveService.js';

describe('project move service wiring', () => {
  let dispose: (() => void) | undefined;
  const deps = {
    isBusy: (id: string) => h.busy.has(id),
    canApply: () => !h.passive,
    drainPersist: vi.fn(async () => undefined),
    onSettled: vi.fn(),
    withWorkerLocks: async <T>(_ids: readonly string[], run: () => Promise<T>) =>
      h.workersLocked
        ? { acquired: false as const }
        : { acquired: true as const, value: await run() },
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    h.owner = 1;
    h.row = {
      id: 'task',
      workingDir: '/a',
      workspaceKind: 'project',
      status: 'active',
      sdkSessionId: null,
    };
    h.workers = [];
    h.busy = new Set();
    h.records = new Map();
    h.locks = new Map();
    h.passive = false;
    h.dbReady = true;
    h.workersLocked = false;
    h.inspect.mockImplementation(async () => ({ target: { ...h.row } }));
    h.actualMove.mockImplementation(
      async (_busy, _contextId, sessionId, directory, assertCurrent, options) => {
        assertCurrent();
        expect(options).toEqual({ routeLockHeld: true, strictTranscriptRelocation: true });
        h.row = {
          ...h.row,
          ...(directory ? { workingDir: directory } : {}),
          workspaceKind: directory === null ? 'dialogue' : 'project',
        };
        return {
          ok: true,
          sessionId,
          workingDir: h.row.workingDir,
          workspaceKind: h.row.workspaceKind,
        };
      },
    );
    dispose = initializeProjectMoves(deps);
    // Let startup recovery complete before simulating a host request.
    await Promise.resolve();
    await Promise.resolve();
  });
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it('accepts a running task immediately, then migrates only once it becomes idle', async () => {
    h.busy.add('task');
    expect(await h.move!('task', '/b', () => {})).toMatchObject({ ok: true, workingDir: '/b' });
    expect(h.row.workingDir).toBe('/a');
    expect(h.projector!('task')).toEqual({ workingDir: '/b' });
    expect(h.actualMove).not.toHaveBeenCalled();
    expect(h.hooks!.hasPending('task')).toBe(true);
    h.busy.clear();
    h.hooks!.onIdle();
    await vi.waitFor(() => expect(h.row.workingDir).toBe('/b'));
    expect(h.actualMove).toHaveBeenCalledTimes(1);
    expect(deps.drainPersist).toHaveBeenCalledTimes(1);
    expect(h.projector!('task')).toBeNull();
    expect(h.records.size).toBe(0);
    expect(h.hooks!.hasPending('task')).toBe(false);
    expect(deps.onSettled).toHaveBeenCalledWith('task');
  });

  it('rejects an unsupported running task before staging or publishing its destination', async () => {
    h.busy.add('task');
    h.inspect.mockRejectedValueOnce(
      Object.assign(new Error('Managed workspace cannot move'), {
        code: 'UNSUPPORTED_CAPABILITY',
      }),
    );
    expect(await h.move!('task', '/b', () => {})).toMatchObject({
      ok: false,
      errorCode: 'UNSUPPORTED_CAPABILITY',
    });
    expect(h.row.workingDir).toBe('/a');
    expect(h.records.size).toBe(0);
    expect(h.projector!('task')).toBeNull();
    expect(h.hooks!.hasPending('task')).toBe(false);
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.actualMove).not.toHaveBeenCalled();
  });

  it('keeps recovered intents until the owner database becomes ready after startup', async () => {
    dispose!();
    h.records.set('task', {
      id: 'saved-move',
      sessionId: 'task',
      source: { workingDir: '/a', workspaceKind: 'project' },
      target: { workingDir: '/b', workspaceKind: 'project' },
    });
    h.dbReady = false;
    dispose = initializeProjectMoves(deps);
    await Promise.resolve();
    await Promise.resolve();

    expect(h.records.get('task')?.id).toBe('saved-move');
    expect(h.actualMove).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
    await expect(h.hooks!.beforeSend('task')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(h.records.size).toBe(1);

    h.dbReady = true;
    h.hooks!.onIdle();
    await vi.waitFor(() => expect(h.row.workingDir).toBe('/b'));
    expect(h.records.size).toBe(0);
    expect(h.actualMove).toHaveBeenCalledOnce();
  });

  it('keeps the lead workspace unchanged while any worker is still running', async () => {
    h.workers = [{ sessionId: 'worker' }];
    h.busy.add('worker');
    await h.move!('task', '/b', () => {});
    await expect(h.hooks!.beforeSend('task')).rejects.toMatchObject({ code: 'SESSION_RUNNING' });
    expect(h.row.workingDir).toBe('/a');
    expect(h.actualMove).not.toHaveBeenCalled();
    expect(h.records.size).toBe(1);
    h.busy.clear();
    await h.hooks!.beforeSend('task');
    expect(h.row.workingDir).toBe('/b');
    expect(h.records.size).toBe(0);
  });

  it('does not wait under the lead lock for a busy worker lock', async () => {
    h.workersLocked = true;
    await h.move!('task', '/b', () => {});
    await expect(h.hooks!.beforeSend('task')).rejects.toMatchObject({ code: 'SESSION_RUNNING' });
    expect(h.actualMove).not.toHaveBeenCalled();
    expect(h.projector!('task')).toEqual({ workingDir: '/b' });
  });

  it('returns failure and restores the displayed group if an idle move cannot be applied', async () => {
    h.actualMove.mockResolvedValue({ ok: false, errorCode: 'NOT_FOUND' });
    expect(await h.move!('task', '/b', () => {})).toMatchObject({ ok: false });
    expect(h.row.workingDir).toBe('/a');
    expect(h.projector!('task')).toBeNull();
    expect(h.records.size).toBe(0);
    expect(h.broadcast).toHaveBeenLastCalledWith('task', {
      projectMoveTarget: null,
      projectMoveFailureId: null,
    });
    expect(
      h.broadcast.mock.calls.some(([, patch]) => typeof patch.projectMoveFailureId === 'string'),
    ).toBe(false);
  });

  it('pushes one background failure and retains the latest safe resume ID', async () => {
    h.busy.add('task');
    await h.move!('task', '/b', () => {});
    h.actualMove.mockImplementation(async () => {
      h.row.sdkSessionId = 'current-live-fork';
      return { ok: false, errorCode: 'INTERNAL' };
    });
    h.busy.clear();
    await h.hooks!.beforeSend('task');
    expect(h.row.workingDir).toBe('/a');
    expect(h.projector!('task')).toBeNull();
    expect(h.records.size).toBe(0);
    expect(h.broadcast).toHaveBeenCalledWith('task', { sdkSessionId: 'current-live-fork' });
    expect(
      h.broadcast.mock.calls.filter(([, patch]) => typeof patch.projectMoveFailureId === 'string'),
    ).toHaveLength(1);
    expect(deps.onSettled).toHaveBeenCalledWith('task');
  });

  it('preserves the latest of several choices during one running turn', async () => {
    h.busy.add('task');
    await h.move!('task', '/b', () => {});
    await h.move!('task', '/c', () => {});
    expect(h.projector!('task')).toEqual({ workingDir: '/c' });
    h.busy.clear();
    await h.hooks!.beforeSend('task');
    expect(h.row.workingDir).toBe('/c');
    expect(h.actualMove).toHaveBeenCalledTimes(1);
  });

  it('keeps dialogue regrouping from changing the actual directory during the turn', async () => {
    h.busy.add('task');
    await h.move!('task', null, () => {});
    expect(h.projector!('task')).toEqual({ workingDir: null });
    expect(h.row).toMatchObject({ workingDir: '/a', workspaceKind: 'project' });
    h.busy.clear();
    await h.hooks!.beforeSend('task');
    expect(h.row).toMatchObject({ workingDir: '/a', workspaceKind: 'dialogue' });
  });

  it('does not let a passive shared-profile instance stage or execute workspace changes', async () => {
    h.passive = true;
    expect(await h.move!('task', '/b', () => {})).toMatchObject({ ok: false });
    expect(h.records.size).toBe(0);
    expect(h.actualMove).not.toHaveBeenCalled();
    // A request left by the primary must remain durable when a passive reader
    // happens to run its own periodic recovery loop.
    h.records.set('task', {
      id: 'primary-request',
      sessionId: 'task',
      source: { workingDir: '/a', workspaceKind: 'project' },
      target: { workingDir: '/b', workspaceKind: 'project' },
    });
    await expect(h.hooks!.beforeSend('task')).rejects.toMatchObject({ code: 'SESSION_RUNNING' });
    expect(h.records.size).toBe(1);
    expect(h.row.workingDir).toBe('/a');
  });

  it('revalidates the host authority after waiting for the route lock', async () => {
    const assertAuthority = vi.fn(() => {
      throw new Error('controller revoked');
    });
    expect(await h.move!('task', '/b', assertAuthority)).toMatchObject({ ok: false });
    expect(h.actualMove).not.toHaveBeenCalled();
    expect(h.records.size).toBe(0);
  });

  it('cleans up its polling and hooks when the owning service is disposed', () => {
    dispose!();
    dispose = undefined;
    expect(h.move).toBeNull();
    expect(h.hooks).toBeNull();
    expect(h.projector).toBeNull();
  });
});
