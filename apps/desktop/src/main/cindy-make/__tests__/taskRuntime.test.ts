import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

const harness = vi.hoisted(() => ({
  select: vi.fn(),
  readBoundary: vi.fn(),
  insert: vi.fn(),
  values: vi.fn(),
  reads: [] as Array<unknown[] | (() => unknown[])>,
  updateMessage: vi.fn(),
  createMessage: vi.fn(),
  emit: vi.fn(),
  prepare: vi.fn(),
  environment: vi.fn(),
  source: vi.fn(),
  prepareSource: vi.fn(),
  workspace: vi.fn(),
  install: vi.fn(),
  send: vi.fn(),
  current: true,
  clearBoundary: null as number | null,
  dbClearBoundary: null as number | null,
  firstMessages: [] as Array<{ id: string }>,
  effective: undefined as Record<string, unknown> | undefined,
  rows: [] as Array<Record<string, unknown>>,
  cards: new Map<string, unknown>(),
  userData: '',
}));
vi.mock('electron', () => ({
  app: { getPath: () => harness.userData, getVersion: () => '1.0.0', isPackaged: false },
}));
vi.mock('../toolchainEnvironment.js', () => ({
  createMakeToolchainEnvironment: harness.environment,
  resolveMakeToolEnvironment: vi.fn(async () => ({ PATH: '/managed' })),
}));
vi.mock('../prepare.js', () => ({ prepareCindyMakeEnvironment: harness.prepare }));
vi.mock('../sourcePreparation.js', () => ({
  prepareCindySource: harness.prepareSource,
  readCurrentCindySourceStatus: harness.source,
}));
vi.mock('../taskWorkspace.js', () => ({
  createCindyMakeWorktree: harness.workspace,
  installCindyMakeWorktree: harness.install,
}));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => client }));
vi.mock('../../localDb/ipc/messages.js', () => ({
  createMessage: harness.createMessage,
  updateMessageContent: harness.updateMessage,
}));
vi.mock('../../localDb/ipc/sessionCreatedBroadcast.js', () => ({
  emitSessionCreated: harness.emit,
}));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({}),
  isDataOwnerBroadcastScopeCurrent: () => harness.current,
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../../i18n.js', () => ({ t: (key: string) => key }));
vi.mock('../../maker-ipc/sessionRuntimeControl.js', () => ({
  getSessionRuntimeControlSnapshot: () => ({ effectiveOverride: harness.effective }),
}));

import { cindyMakeManager } from '../manager.js';
import {
  assertCindyMakeTaskReady,
  CINDY_MAKE_TASK_DISPATCH,
  configureCindyMakeTaskSender,
  restoreCindyMakeTaskState,
  startCindyMakeTask,
  validateCindyMakeTaskStart,
} from '../taskRuntime.js';
import { MAKE_DOCTOR_CHECK_IDS } from '../../../shared/cindyMakeDoctor.js';
import { sessionCreateToRow } from '../../localDb/mapper.js';
import { normalizeWorkingDirForStorage } from '../../../shared/workingDir.js';
import * as sourcePaths from '../sourcePaths.js';

const client = { drizzle: { select: harness.select, insert: harness.insert } };
let sequence = 0;
const origin = {
  id: 'origin',
  status: 'active',
  agentKind: 'codex' as const,
  model: 'origin-model',
  effort: 'high',
  providerId: 'origin-provider',
  fastMode: true,
  planModeEnabled: true,
  permissionMode: 'ask',
  remoteHostId: null,
};
function input() {
  return {
    originSessionId: origin.id,
    runId: 'runtime-' + ++sequence,
    request: '  修复滚动，保留原文  ',
    title: 'Cindy Make: 修复滚动',
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function initialReads() {
  harness.reads.push([origin], [], () => [harness.rows.at(-1)!]);
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  harness.current = true;
  harness.clearBoundary = null;
  harness.dbClearBoundary = null;
  harness.firstMessages = [];
  harness.effective = undefined;
  harness.rows = [];
  harness.reads = [];
  harness.cards.clear();
  harness.userData = path.join(os.tmpdir(), 'cindy-make-runtime-unit');
  harness.readBoundary.mockImplementation(async () => [{ clearedAt: harness.dbClearBoundary }]);
  harness.select.mockImplementation((selection) => {
    const builder: Record<string, unknown> = {};
    for (const key of ['from', 'innerJoin', 'where', 'orderBy']) builder[key] = () => builder;
    const read = async () => {
      if (selection && Object.keys(selection).length === 1) {
        if ('clearedAt' in selection) return harness.readBoundary();
        if ('id' in selection) return harness.firstMessages;
      }
      const rows = harness.reads.shift();
      return typeof rows === 'function' ? rows() : (rows ?? []);
    };
    builder.limit = read;
    builder.then = (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
      read().then(resolve, reject);
    return builder;
  });
  harness.insert.mockReturnValue({ values: harness.values });
  harness.values.mockImplementation(async (row) => {
    harness.rows.push(row);
  });
  harness.updateMessage.mockImplementation(async (_id, key, content) => {
    harness.cards.set(key, content);
    return { id: key };
  });
  harness.createMessage.mockImplementation(async (_id, body, options) => {
    if (options.expectedClearBoundaryMs !== harness.dbClearBoundary)
      throw new Error('Task preparation was cleared');
    harness.cards.set(body.clientId, body.content);
    return { id: body.clientId };
  });
  harness.environment.mockResolvedValue({ processEnvironment: () => ({ PATH: '/managed' }) });
  harness.prepare.mockImplementation(async (runId, _env, _root, _signal, publish) => {
    const report = {
      runId,
      status: 'completed',
      checks: MAKE_DOCTOR_CHECK_IDS.map((id) => ({ id, status: 'passed' })),
      platform: 'win32',
      arch: 'x64',
    };
    publish(report);
    return report;
  });
  harness.source.mockResolvedValue({ status: 'ready', path: '/source', branch: 'cindy-personal' });
  harness.workspace.mockImplementation(async (userData, runId) => ({
    path: sourcePaths.makeTaskWorktreePath(userData, runId),
    branch: 'cindy-make/' + runId,
    baseCommit: 'base',
  }));
  harness.install.mockResolvedValue(undefined);
  harness.send.mockResolvedValue({ accepted: true });
  configureCindyMakeTaskSender(harness.send, () => harness.clearBoundary);
});

describe('Cindy Make task runtime', () => {
  it('creates exactly one task from home preferences and exposes it before dependencies finish', async () => {
    const start = {
      ...input(),
      originSessionId: undefined,
      createOptions: {
        agentKind: 'pi' as const,
        model: 'home-model',
        effort: 'high',
        providerId: 'home-provider',
        permissionMode: 'acceptEdits',
        planModeEnabled: true,
        fastMode: true,
      },
    };
    harness.reads.push([], () => [harness.rows.at(-1)!]);
    const gate = deferred();
    harness.install.mockImplementation(
      async (_userData, _workspace, _signal, _deps, _phase, publish) => {
        publish({ resolved: 10, reused: 6, downloaded: 4, added: 8 });
        await gate.promise;
      },
    );
    const sessionId = await startCindyMakeTask(start, 1);
    await vi.waitFor(() => expect(harness.install).toHaveBeenCalledOnce());
    expect(harness.rows).toHaveLength(1);
    expect(harness.rows[0]).toMatchObject({
      ...start.createOptions,
      id: sessionId,
      source: 'cindy-make',
    });
    expect(harness.emit).toHaveBeenCalledWith(sessionId);
    expect(harness.send).not.toHaveBeenCalled();
    expect(cindyMakeManager.taskReport(start.runId)?.task).toMatchObject({
      phase: 'dependencies',
      dependencies: { downloaded: 4 },
    });
    gate.resolve();
    await cindyMakeManager.waitForTask(start.runId);
    expect(harness.send).toHaveBeenCalledOnce();
  });

  it.each([
    { agentKind: ['cc'] },
    { fastMode: 'true' },
    { workingDir: '/untrusted' },
    { model: 'x'.repeat(501) },
  ])('rejects malformed home preferences before creating a task: %j', (createOptions) => {
    expect(() =>
      validateCindyMakeTaskStart({ ...input(), originSessionId: undefined, createOptions }),
    ).toThrow('Invalid Cindy Make preferences');
  });
  it.each([false, true])(
    'dispatches with the real mapper and Windows paths after initial persistence failure=%s',
    async (failInitialPersistence) => {
      const start = input();
      harness.userData = path.win32.resolve('C:/', 'cindy-make-runtime-unit');
      vi.spyOn(sourcePaths, 'makeTaskWorktreePath').mockImplementation((userData, runId) =>
        path.win32.resolve(userData, 'cindy-make', 'worktrees', runId),
      );
      if (failInitialPersistence) {
        harness.reads.push([origin], []);
        harness.updateMessage.mockRejectedValueOnce(new Error('disk full'));
        await expect(startCindyMakeTask(start, 1)).rejects.toThrow('disk full');
        harness.reads.push(
          [origin],
          [],
          () => [harness.rows[0]],
          () => [harness.rows[0]],
        );
      } else initialReads();
      const sessionId = await startCindyMakeTask(start, 1);
      await cindyMakeManager.waitForTask(start.runId);
      const workspacePath = sourcePaths.makeTaskWorktreePath(harness.userData, start.runId);
      expect(harness.rows).toHaveLength(1);
      expect(harness.rows[0].workingDir).not.toBe(workspacePath);
      expect(harness.rows[0].workingDir).toBe(normalizeWorkingDirForStorage(workspacePath));
      expect(harness.send).toHaveBeenCalledOnce();
      expect(harness.send).toHaveBeenCalledWith(
        sessionId,
        start.request,
        expect.objectContaining({ workingDir: workspacePath }),
        expect.anything(),
      );
      expect(cindyMakeManager.taskReport(start.runId)?.status).toBe('completed');
    },
  );

  it.each(['before-db-write', 'persisted'] as const)(
    'does not dispatch or recreate preparation messages after clear is %s',
    async (clearStage) => {
      const start = input();
      initialReads();
      const gate = deferred();
      harness.install.mockImplementation(async () => gate.promise);
      await startCindyMakeTask(start, 1);
      await vi.waitFor(() => expect(harness.install).toHaveBeenCalledOnce());
      const previousWrites = harness.updateMessage.mock.calls.length;
      harness.clearBoundary = Date.now();
      if (clearStage === 'persisted') {
        harness.dbClearBoundary = harness.clearBoundary;
        harness.rows[0].clearedAt = harness.clearBoundary;
      }
      gate.resolve();
      await cindyMakeManager.waitForTask(start.runId);
      expect(harness.send).not.toHaveBeenCalled();
      expect(harness.updateMessage).toHaveBeenCalledTimes(previousWrites);
      expect(harness.createMessage).not.toHaveBeenCalled();
      expect(cindyMakeManager.getState().tasks?.[start.runId]).toBeUndefined();
    },
  );

  it('does not recreate a missing preparation message when clear wins the update await', async () => {
    const start = input();
    harness.reads.push([origin], []);
    harness.updateMessage.mockImplementationOnce(async () => {
      harness.clearBoundary = Date.now();
      return null;
    });
    await expect(startCindyMakeTask(start, 1)).rejects.toThrow('Task preparation was cleared');
    expect(harness.createMessage).not.toHaveBeenCalled();
    expect(harness.prepare).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('passes clear cancellation to the sender while first dispatch is preparing', async () => {
    const start = input();
    initialReads();
    const gate = deferred();
    const providerStart = vi.fn();
    harness.send.mockImplementation(async (_sessionId, _message, _createOpts, sendOpts) => {
      await gate.promise;
      if (sendOpts.signal.aborted) return { accepted: false, reason: 'cancelled-before-dispatch' };
      providerStart();
      return { accepted: true };
    });
    const sessionId = await startCindyMakeTask(start, 1);
    await vi.waitFor(() => expect(harness.send).toHaveBeenCalledOnce());
    expect(cindyMakeManager.taskReport(start.runId)?.task?.phase).toBe('starting');
    harness.clearBoundary = Date.now();
    cindyMakeManager.cancelTasksForSession(sessionId);
    gate.resolve();
    await cindyMakeManager.waitForTask(start.runId);
    expect(providerStart).not.toHaveBeenCalled();
    expect(cindyMakeManager.getState().tasks?.[start.runId]).toBeUndefined();
  });

  it('guards a new preparation message insert against a durable clear race', async () => {
    const start = input();
    harness.reads.push([origin], []);
    harness.updateMessage.mockImplementationOnce(async () => {
      harness.dbClearBoundary = Date.now();
      return null;
    });
    await expect(startCindyMakeTask(start, 1)).rejects.toThrow('Task preparation was cleared');
    expect(harness.createMessage).toHaveBeenCalledWith(
      harness.rows[0].id,
      expect.objectContaining({ clientId: 'cindy-make-preparation-' + start.runId }),
      expect.objectContaining({
        expectedClearBoundaryMs: null,
        shouldBroadcast: expect.any(Function),
      }),
    );
    expect(harness.cards.size).toBe(0);
    expect(harness.prepare).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('ignores restoration results from before an in-memory clear boundary', async () => {
    const start = input();
    harness.clearBoundary = Date.now();
    harness.reads.push([
      {
        sessionId: 'cleared-task',
        clientId: 'cindy-make-preparation-' + start.runId,
        clearedAt: null,
        content: JSON.stringify({
          __cindyMakeCard: {
            data: {
              report: {
                runId: start.runId,
                checks: [],
                status: 'running',
                task: { sessionId: 'cleared-task', phase: 'dependencies' },
              },
            },
          },
        }),
      },
    ]);
    await restoreCindyMakeTaskState();
    expect(cindyMakeManager.taskReport(start.runId)).toBeUndefined();
    expect(harness.updateMessage).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it.each(['dependencies', 'starting'] as const)(
    'restores persisted %s state in Main without replaying a request',
    async (phase) => {
      const start = input();
      const sessionId = 'restored-' + start.runId;
      const report = {
        runId: start.runId,
        status: 'running',
        checks: [],
        task: { phase, sessionId, originSessionId: origin.id, request: start.request },
      };
      harness.reads.push([
        {
          sessionId,
          clientId: 'cindy-make-preparation-' + start.runId,
          clearedAt: null,
          content: JSON.stringify({
            __cindyMakeCard: { data: { request: start.request, report } },
          }),
        },
      ]);
      harness.firstMessages = [{ id: 'persisted-before-provider-dispatch' }];
      await restoreCindyMakeTaskState();
      expect(cindyMakeManager.getState().tasks?.[start.runId]?.status).toBe('cancelled');
      expect(harness.updateMessage).toHaveBeenCalledOnce();
      expect(harness.send).not.toHaveBeenCalled();
    },
  );

  it.each(['archived', 'deleted'] as const)(
    'restores unfinished %s tasks for reopening or cleanup retry',
    async (sessionStatus) => {
      const start = input();
      const sessionId = 'restored-' + start.runId;
      const report = {
        runId: start.runId,
        status: 'completed',
        checks: [],
        task: { phase: 'completed', sessionId, request: start.request },
      };
      const row = {
        sessionId,
        sessionStatus,
        clearedAt: null,
        clientId: 'cindy-make-preparation-' + start.runId,
        content: JSON.stringify({ __cindyMakeCard: { data: { report } } }),
      };
      harness.reads.push([row]);
      await restoreCindyMakeTaskState();
      expect(cindyMakeManager.getState().tasks?.[start.runId]?.task?.sessionStatus).toBe(
        sessionStatus,
      );
      expect(harness.send).not.toHaveBeenCalled();
      harness.reads.push([
        {
          ...row,
          content: JSON.stringify({
            __cindyMakeCard: {
              data: {
                report: { ...report, task: { ...report.task, finished: true } },
              },
            },
          }),
        },
      ]);
      await restoreCindyMakeTaskState();
      expect(cindyMakeManager.getState().tasks?.[start.runId]).toBeUndefined();
      expect(harness.send).not.toHaveBeenCalled();
      expect(harness.updateMessage).not.toHaveBeenCalled();
    },
  );

  it.each(['running', 'failed', 'cancelled'])(
    'blocks ordinary sends for a persisted %s preparation',
    async (status) => {
      harness.reads.push([
        { content: JSON.stringify({ __cindyMakeCard: { data: { report: { status } } } }) },
      ]);
      await expect(assertCindyMakeTaskReady('created')).rejects.toThrow(
        'Retry Cindy Make preparation',
      );
    },
  );

  it('allows completed preparations and legacy tasks without a preparation card', async () => {
    harness.reads.push(
      [
        {
          content: JSON.stringify({
            __cindyMakeCard: { data: { report: { status: 'completed' } } },
          }),
        },
      ],
      [],
    );
    await expect(assertCindyMakeTaskReady('created')).resolves.toBeUndefined();
    await expect(assertCindyMakeTaskReady('legacy')).resolves.toBeUndefined();
  });

  it('only blocks on the newest preparation visible after clear and rewind', async () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY, cleared_at INTEGER);
        CREATE TABLE messages (
          session_id TEXT, client_id TEXT, content TEXT, created_at INTEGER, rewind_at INTEGER
        );
        INSERT INTO sessions VALUES ('created', 100), ('other', NULL);
      `);
      const db = drizzle(sqlite);
      harness.select.mockImplementation(db.select.bind(db));
      const add = (
        id: string,
        status: string,
        createdAt: number,
        rewindAt: number | null = null,
        sid = 'created',
      ) =>
        sqlite
          .prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)')
          .run(
            sid,
            'cindy-make-preparation-' + id,
            JSON.stringify({ __cindyMakeCard: { data: { report: { status } } } }),
            createdAt,
            rewindAt,
          );
      add('before-clear', 'failed', 99);
      add('at-clear', 'cancelled', 100);
      add('rewound', 'running', 101, 102);
      add('other-task', 'failed', 103, null, 'other');
      await expect(assertCindyMakeTaskReady('created')).resolves.toBeUndefined();
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 4 });

      add('visible', 'failed', 110);
      await expect(assertCindyMakeTaskReady('created')).rejects.toThrow(
        'Retry Cindy Make preparation',
      );
      sqlite.prepare('UPDATE messages SET rewind_at = 111 WHERE created_at = 110').run();
      await expect(assertCindyMakeTaskReady('created')).resolves.toBeUndefined();

      add('completed', 'completed', 120);
      await expect(assertCindyMakeTaskReady('created')).resolves.toBeUndefined();
      add('latest', 'cancelled', 121);
      await expect(assertCindyMakeTaskReady('created')).rejects.toThrow(
        'Retry Cindy Make preparation',
      );
    } finally {
      sqlite.close();
    }
  });

  it.each(['active', 'archived', 'deleted', 'missing'])(
    'reuses a task after initial message persistence fails when its origin is %s',
    async (originStatus) => {
      const start = input();
      harness.reads.push([origin], []);
      harness.updateMessage.mockRejectedValueOnce(new Error('disk full'));
      await expect(startCindyMakeTask(start, 1)).rejects.toThrow('disk full');
      expect(harness.rows).toHaveLength(1);
      harness.reads.push(
        originStatus === 'missing' ? [] : [{ ...origin, status: originStatus }],
        [],
        () => [harness.rows[0]],
        () => [harness.rows[0]],
      );
      expect(await startCindyMakeTask(start, 1)).toBe(harness.rows[0].id);
      await cindyMakeManager.waitForTask(start.runId);
      expect(harness.rows).toHaveLength(1);
      expect(harness.send).toHaveBeenCalledOnce();
    },
  );

  it('publishes a titled task before installation and automatically sends the original request after it completes', async () => {
    const start = input();
    initialReads();
    const gate = deferred();
    harness.install.mockImplementation(
      async (_root, _workspace, signal, _deps, _phase, progress) => {
        progress({ resolved: 10, reused: 4, downloaded: 6, added: 10 });
        await gate.promise;
        signal.throwIfAborted();
      },
    );
    const sessionId = await startCindyMakeTask(start, 1);
    expect(harness.emit).toHaveBeenCalledWith(sessionId);
    await vi.waitFor(() => expect(harness.install).toHaveBeenCalledOnce());
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.rows[0]).toMatchObject({
      title: start.title,
      source: 'cindy-make',
      workingDir: normalizeWorkingDirForStorage(
        sourcePaths.makeTaskWorktreePath(harness.userData, start.runId),
      ),
    });
    expect(cindyMakeManager.taskReport(start.runId)).toMatchObject({
      status: 'running',
      task: { phase: 'dependencies', dependencies: { downloaded: 6 } },
    });
    gate.resolve();
    await cindyMakeManager.waitForTask(start.runId);
    expect(harness.send).toHaveBeenCalledOnce();
    expect(harness.send).toHaveBeenCalledWith(
      sessionId,
      start.request,
      expect.objectContaining({
        model: origin.model,
        effort: origin.effort,
        providerId: origin.providerId,
        permissionMode: 'ask',
        planMode: true,
        fastMode: true,
      }),
      expect.objectContaining({
        [CINDY_MAKE_TASK_DISPATCH]: true,
        signal: expect.any(AbortSignal),
        expectedClearBoundaryMs: null,
        persistUserMessage: expect.objectContaining({
          clientId: 'cindy-make-first-' + start.runId,
          content: start.request,
          expectedClearBoundaryMs: null,
        }),
      }),
    );
    expect(cindyMakeManager.taskReport(start.runId)?.status).toBe('completed');
  });

  it.each(['cc', 'codex', 'pi'])(
    'inherits the effective %s runtime, including cleared provider and effort',
    async (agentKind) => {
      const start = input();
      harness.effective = {
        agentKind: agentKind === 'cc' ? 'claude-code' : agentKind,
        model: 'effective-model',
        effort: undefined,
        providerId: null,
        fastMode: false,
      };
      initialReads();
      await startCindyMakeTask(start, 1);
      await cindyMakeManager.waitForTask(start.runId);
      expect(harness.rows[0]).toMatchObject({
        agentKind,
        model: 'effective-model',
        effort: '',
        providerId: null,
        fastMode: false,
        permissionMode: 'ask',
        planModeEnabled: true,
      });
      expect(harness.send).toHaveBeenCalledOnce();
    },
  );

  it.each(['cancel', 'owner', 'archive', 'directory'] as const)(
    'does not dispatch after %s changes during preparation',
    async (change) => {
      const start = input();
      initialReads();
      const gate = deferred();
      harness.install.mockImplementation(async (_root, _workspace, signal) => {
        await gate.promise;
        signal.throwIfAborted();
      });
      await startCindyMakeTask(start, 1);
      await vi.waitFor(() => expect(harness.install).toHaveBeenCalledOnce());
      if (change === 'cancel') cindyMakeManager.cancel(start.runId, 1);
      if (change === 'owner') harness.current = false;
      if (change === 'archive') harness.rows[0].status = 'archived';
      if (change === 'directory') harness.rows[0].workingDir = '/different';
      gate.resolve();
      await cindyMakeManager.waitForTask(start.runId);
      expect(harness.send).not.toHaveBeenCalled();
    },
  );

  it.each(['active', 'archived', 'deleted', 'missing'])(
    'retries a rejected first dispatch in the existing task when its origin is %s',
    async (originStatus) => {
      const start = input();
      initialReads();
      harness.send.mockResolvedValueOnce({ accepted: false, reason: 'unavailable' });
      const sessionId = await startCindyMakeTask(start, 1);
      await cindyMakeManager.waitForTask(start.runId);
      expect(cindyMakeManager.taskReport(start.runId)?.status).toBe('failed');
      const content = harness.cards.get('cindy-make-preparation-' + start.runId);
      harness.reads.push(
        originStatus === 'missing' ? [] : [{ ...origin, status: originStatus }],
        [
          {
            sessionId,
            status: 'active',
            content: JSON.stringify(content),
            clearedAt: null,
            createdAt: Date.now(),
          },
        ],
        () => [harness.rows[0]],
      );
      harness.firstMessages = [{ id: 'accepted-but-not-dispatched-user-row' }];
      expect(await startCindyMakeTask(start, 1)).toBe(sessionId);
      await cindyMakeManager.waitForTask(start.runId);
      expect(harness.rows).toHaveLength(1);
      expect(harness.send).toHaveBeenCalledTimes(2);
      expect(cindyMakeManager.taskReport(start.runId)?.status).toBe('completed');
    },
  );

  it.each(['running', 'cancelled'] as const)(
    'explicitly retries an interrupted %s preparation even with a persisted first user message',
    async (status) => {
      const start = input();
      const sessionId = 'retry-' + start.runId;
      const createdAt = Date.now();
      harness.clearBoundary = createdAt - 1000;
      harness.dbClearBoundary = harness.clearBoundary;
      const row = {
        ...sessionCreateToRow(
          sessionId,
          {
            ...origin,
            workingDir: sourcePaths.makeTaskWorktreePath(harness.userData, start.runId),
            source: 'cindy-make',
          },
          createdAt,
        ),
        clearedAt: harness.clearBoundary,
      };
      harness.rows.push(row);
      harness.firstMessages = [{ id: 'user-row-without-provider-acceptance' }];
      harness.reads.push(
        [origin],
        [
          {
            sessionId,
            status: 'active',
            createdAt,
            clearedAt: harness.clearBoundary,
            content: JSON.stringify({
              __cindyMakeCard: {
                data: {
                  request: start.request,
                  report: {
                    runId: start.runId,
                    status,
                    checks: [],
                    task: {
                      sessionId,
                      originSessionId: origin.id,
                      phase: 'starting',
                      request: start.request,
                      title: start.title,
                    },
                  },
                },
              },
            }),
          },
        ],
        [row],
      );
      expect(await startCindyMakeTask(start, 1)).toBe(sessionId);
      await cindyMakeManager.waitForTask(start.runId);
      expect(harness.values).not.toHaveBeenCalled();
      expect(harness.send).toHaveBeenCalledOnce();
      expect(harness.send).toHaveBeenCalledWith(
        sessionId,
        start.request,
        expect.anything(),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          expectedClearBoundaryMs: harness.clearBoundary,
          persistUserMessage: expect.objectContaining({
            clientId: 'cindy-make-first-' + start.runId,
            content: start.request,
            expectedClearBoundaryMs: harness.clearBoundary,
          }),
        }),
      );
      const sendOpts = harness.send.mock.calls[0][3];
      expect(sendOpts.persistUserMessage.shouldBroadcast()).toBe(true);
      harness.clearBoundary = createdAt + 1;
      expect(sendOpts.persistUserMessage.shouldBroadcast()).toBe(false);
      expect(cindyMakeManager.getState().tasks?.[start.runId]).toBeUndefined();
    },
  );

  it('rejects a stale retry card whose task was cleared', async () => {
    const start = input();
    harness.reads.push(
      [origin],
      [
        {
          sessionId: 'cleared-task',
          status: 'active',
          createdAt: 100,
          clearedAt: 200,
          content: JSON.stringify({
            __cindyMakeCard: {
              data: {
                request: start.request,
                report: {
                  runId: start.runId,
                  status: 'cancelled',
                  checks: [],
                  task: {
                    sessionId: 'cleared-task',
                    originSessionId: origin.id,
                    phase: 'dependencies',
                  },
                },
              },
            },
          }),
        },
      ],
    );
    await expect(startCindyMakeTask(start, 1)).rejects.toThrow('Task preparation was cleared');
    expect(harness.updateMessage).not.toHaveBeenCalled();
    expect(harness.createMessage).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('does not replay a preparation durably marked completed after a Main restart', async () => {
    const start = input();
    const sessionId = 'persisted-task';
    harness.reads.push(
      [origin],
      [
        {
          sessionId,
          status: 'active',
          clearedAt: null,
          createdAt: Date.now(),
          content: JSON.stringify({
            __cindyMakeCard: {
              data: {
                request: start.request,
                report: {
                  runId: start.runId,
                  status: 'completed',
                  checks: [],
                  task: { sessionId, originSessionId: origin.id, phase: 'completed' },
                },
              },
            },
          }),
        },
      ],
    );
    expect(await startCindyMakeTask(start, 1)).toBe(sessionId);
    await cindyMakeManager.waitForTask(start.runId);
    expect(harness.prepare).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.rows).toHaveLength(0);
  });

  it('prepares missing source only after the task is visible', async () => {
    const start = input();
    initialReads();
    harness.source.mockResolvedValueOnce({ status: 'missing', path: '/source' });
    harness.prepareSource.mockImplementation(async (_env, _root, _identity, _signal, progress) => {
      expect(harness.emit).toHaveBeenCalledOnce();
      progress({ status: 'preparing', path: '/source', target: { ref: 'main' }, phase: 'cloning' });
      return { status: 'ready', path: '/source' };
    });
    await startCindyMakeTask(start, 1);
    await cindyMakeManager.waitForTask(start.runId);
    expect(harness.prepareSource).toHaveBeenCalledOnce();
    expect(harness.send).toHaveBeenCalledOnce();
  });

  it.each(['environment', 'source', 'dependencies'])(
    'keeps the request without sending when %s fails',
    async (phase) => {
      const start = input();
      initialReads();
      if (phase === 'environment')
        harness.prepare.mockRejectedValueOnce(new Error('environment failed'));
      if (phase === 'source') {
        harness.source.mockResolvedValueOnce({ status: 'missing' });
        harness.prepareSource.mockResolvedValueOnce({ status: 'failed', error: 'gitFailed' });
      }
      if (phase === 'dependencies')
        harness.install.mockRejectedValueOnce(new Error('install failed'));
      await startCindyMakeTask(start, 1);
      await cindyMakeManager.waitForTask(start.runId);
      expect(cindyMakeManager.taskReport(start.runId)).toMatchObject({
        status: 'failed',
        task: { request: start.request },
      });
      expect(harness.send).not.toHaveBeenCalled();
    },
  );

  it.each(['archived', 'deleted', 'missing'])(
    'rejects a new preparation when its origin is %s',
    async (originStatus) => {
      harness.reads.push(
        originStatus === 'missing' ? [] : [{ ...origin, status: originStatus }],
        [],
      );
      await expect(startCindyMakeTask(input(), 1)).rejects.toThrow('Origin task is unavailable');
      expect(harness.values).not.toHaveBeenCalled();
      expect(harness.prepare).not.toHaveBeenCalled();
      expect(harness.send).not.toHaveBeenCalled();
    },
  );

  it('rejects remote origins and invalid run ids before creating a task', async () => {
    const start = input();
    expect(() => validateCindyMakeTaskStart({ ...start, runId: '../escape' })).toThrow();
    expect(() => validateCindyMakeTaskStart({ ...start, request: ' ' })).toThrow();
    harness.reads.push([{ ...origin, remoteHostId: 'remote-host' }]);
    await expect(startCindyMakeTask(start, 1)).rejects.toThrow('local task');
    expect(harness.rows).toHaveLength(0);
    expect(harness.send).not.toHaveBeenCalled();
  });
});
vi.mock('../historyCapture.js', () => ({ captureMakeHistoryReport: vi.fn() }));
