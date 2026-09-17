import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
  borrowers: [] as Array<{ id: string; status: string }>,
  current: true,
  dbReady: true,
  content: '',
  profile: '',
  alive: false,
  running: false,
  clean: vi.fn(),
  persist: vi.fn(),
  forget: vi.fn(),
  patch: vi.fn(),
  recycle: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: () => h.profile } }));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => {
    if (!h.dbReady) throw new Error('DbClient not ready');
    return client;
  },
}));
vi.mock('../../localDb/ipc/messages.js', () => ({ updateMessageContent: h.persist }));
vi.mock('../../localDb/sessionRouteLock.js', () => ({
  withSessionRouteLock: async (_id: string, fn: () => unknown) => fn(),
}));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({}),
  isDataOwnerBroadcastScopeCurrent: () => h.current,
}));
vi.mock('../toolchainEnvironment.js', () => ({
  createMakeToolchainEnvironment: async () => ({}),
  resolveMakeToolEnvironment: async () => ({}),
}));
vi.mock('../manager.js', async (original) => ({
  ...(await original<typeof import('../manager.js')>()),
  cindyMakeManager: {
    withProject: async (_root: string, fn: () => unknown) => fn(),
    isTaskPreparing: () => false,
    forgetTask: h.forget,
    runTaskAction: (...args: Parameters<CindyMakeManager['runTaskAction']>) =>
      actionManager.runTaskAction(...args),
  },
}));
import { CindyMakeManager } from '../manager.js';
let actionManager: CindyMakeManager;
vi.mock('../taskCleanup.js', async (original) => ({
  ...(await original<typeof import('../taskCleanup.js')>()),
  manageCindyMakeWorkspace: h.clean,
}));
import {
  configureCindyMakeTaskManagement,
  manageCindyMakeTask,
  recycleCindyMakeTask,
} from '../taskManagement.js';
import { makeTaskWorktreePath } from '../sourcePaths.js';

const client = {
  drizzle: {
    select: (selection?: Record<string, unknown>) => {
      const read = () =>
        selection && 'content' in selection
          ? [{ content: h.content, clientId: 'cindy-make-preparation-run' }]
          : selection
            ? h.borrowers
            : h.row
              ? [h.row]
              : [];
      const query = {
        from: () => query,
        where: () => query,
        limit: async () => read(),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(read()).then(resolve),
      };
      return query;
    },
  },
};
const db = client.drizzle as unknown as Parameters<typeof recycleCindyMakeTask>[1];
beforeEach(() => {
  actionManager = new CindyMakeManager();
  vi.clearAllMocks();
  h.current = true;
  h.dbReady = true;
  h.alive = false;
  h.running = false;
  h.borrowers = [];
  h.profile = path.join(os.tmpdir(), 'make-management-unit');
  h.row = {
    id: 'session',
    source: 'cindy-make',
    status: 'archived',
    workingDir: makeTaskWorktreePath(h.profile, 'run'),
    remoteHostId: null,
  };
  h.content = JSON.stringify({
    __cindyMakeCard: {
      data: {
        report: {
          runId: 'run',
          status: 'completed',
          task: { sessionId: 'session' },
          source: { baseCommit: 'base', path: h.row!.workingDir, branch: 'cindy-make/run' },
        },
      },
    },
  });
  h.clean.mockResolvedValue(true);
  h.persist.mockResolvedValue({});
  h.patch.mockImplementation(async (_id, patch) => Object.assign(h.row!, patch));
  h.recycle.mockResolvedValue(undefined);
  configureCindyMakeTaskManagement({
    isAlive: () => h.alive,
    isRunning: () => h.running,
    setStatus: h.patch,
    recycle: h.recycle,
  });
});
describe('Cindy Make task management', () => {
  it('uses canonical deletion and waits for runtime recycling before removing artifacts', async () => {
    h.row!.status = 'active';
    let settle!: () => void;
    h.recycle.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          settle = done;
        }),
    );
    const operation = manageCindyMakeTask('session', 'delete');
    await vi.waitFor(() => expect(h.recycle).toHaveBeenCalled());
    expect(actionManager.getState().taskActions?.session).toEqual({
      action: 'delete',
      status: 'running',
    });
    const duplicate = manageCindyMakeTask('session', 'delete');
    expect(h.clean).not.toHaveBeenCalled();
    settle();
    await operation;
    await duplicate;
    expect(h.patch).toHaveBeenCalledTimes(1);
    expect(actionManager.getState().taskActions?.session).toBeUndefined();
    expect(h.patch).toHaveBeenCalledWith('session', { status: 'deleted', pinnedAt: null });
    expect(h.persist.mock.calls[0][2].__cindyMakeCard.data.report.task.finished).toBe(true);
    expect(h.forget).toHaveBeenCalledWith('run');
    expect(h.clean.mock.calls[0][5].preparedWorkspace).toEqual({
      path: h.row!.workingDir,
      branch: 'cindy-make/run',
    });
  });
  it('retains a durable unfinished record when cleanup fails', async () => {
    h.clean.mockRejectedValue(new Error('locked directory'));
    await expect(manageCindyMakeTask('session', 'delete')).rejects.toThrow('cleanupFailed');
    expect(h.row!.status).toBe('deleted');
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.forget).not.toHaveBeenCalled();
    h.clean.mockResolvedValue(true);
    await expect(manageCindyMakeTask('session', 'delete')).resolves.toBeUndefined();
    expect(h.forget).toHaveBeenCalledWith('run');
  });
  it('keeps global snapshots readable when the database closes during cleanup', async () => {
    let settle!: () => void;
    h.recycle.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          settle = done;
        }),
    );
    const operation = manageCindyMakeTask('session', 'delete');
    await vi.waitFor(() => expect(h.recycle).toHaveBeenCalled());
    h.dbReady = false;
    expect(actionManager.getState().taskActions?.session).toBeUndefined();
    settle();
    await expect(operation).rejects.toThrow('unavailable');
    expect(h.clean).not.toHaveBeenCalled();
    expect(actionManager.getState().taskActions?.session).toBeUndefined();
  });
  it('does not hide an unmerged archived task', async () => {
    h.clean.mockResolvedValue(false);
    await recycleCindyMakeTask('session', db, () => h.current);
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.forget).not.toHaveBeenCalled();
  });
  it('does not authorize residual deletion from another preparation record', async () => {
    const content = JSON.parse(h.content);
    content.__cindyMakeCard.data.report.task.sessionId = 'someone-else';
    h.content = JSON.stringify(content);
    await manageCindyMakeTask('session', 'delete');
    expect(h.clean.mock.calls[0][5].preparedWorkspace).toBeUndefined();
  });
  it('passes file-in-use failures through to the cleanup action', async () => {
    h.clean.mockRejectedValue(Object.assign(new Error('locked'), { code: 'directoryBusy' }));
    await expect(manageCindyMakeTask('session', 'delete')).rejects.toThrow('directoryBusy');
    expect(actionManager.getState().taskActions?.session).toEqual({
      action: 'delete',
      status: 'failed',
      error: 'directoryBusy',
    });
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.forget).not.toHaveBeenCalled();
  });
  it('can delete a managed workspace even when its preparation card is damaged', async () => {
    h.content = '{invalid';
    await expect(manageCindyMakeTask('session', 'delete')).resolves.toBeUndefined();
    expect(h.clean).toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.forget).toHaveBeenCalledWith('run');
  });
  it('refuses finish while running and refuses cleanup when shutdown did not succeed', async () => {
    h.running = true;
    await expect(manageCindyMakeTask('session', 'finish')).rejects.toThrow('busy');
    expect(h.patch).not.toHaveBeenCalled();
    h.alive = true;
    await expect(recycleCindyMakeTask('session', db, () => true)).rejects.toMatchObject({
      code: 'busy',
    });
    expect(h.clean).not.toHaveBeenCalled();
  });
  it('protects other active references and changed ownership', async () => {
    h.borrowers = [{ id: 'another-session', status: 'active' }];
    await expect(recycleCindyMakeTask('session', db, () => true)).rejects.toMatchObject({
      code: 'busy',
    });
    h.current = false;
    await expect(manageCindyMakeTask('session', 'delete')).rejects.toThrow();
    expect(h.clean).not.toHaveBeenCalled();
  });
  it('does not report success when a task was restored during cleanup', async () => {
    h.row!.status = 'active';
    await expect(recycleCindyMakeTask('session', db, () => true, 'finish')).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(h.clean).not.toHaveBeenCalled();
  });
  it('ignores unrelated sessions and refuses managed actions on them', async () => {
    h.row!.source = 'desktop';
    await recycleCindyMakeTask('session', db, () => true);
    await expect(manageCindyMakeTask('session', 'delete')).rejects.toThrow();
    expect(h.clean).not.toHaveBeenCalled();
  });
});
