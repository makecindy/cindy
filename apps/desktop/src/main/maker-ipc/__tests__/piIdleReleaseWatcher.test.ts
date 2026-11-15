import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, eq, sql } from 'drizzle-orm';
import os from 'node:os';
import path from 'node:path';
import { Maker, type AgentSessionHandle, type BaseAgent, type SessionMeta, type SessionStorage, type StartSessionOptions } from '@cindy/maker-core';
import { createRehydrateCloseSuppression, shouldSkipOnCloseSideEffects } from '../../maker-host/rehydrateCloseSuppression';
import { sessions } from '../../localDb/schema.js';

import {
  createPiIdleReleaseWatcher,
  createPiIdleReleaseClose,
  piIdleReleaseCandidateWhere,
  piIdleReleaseIdleSince,
  type PiIdleReleaseCandidate,
  type PiIdleReleaseWatcherDeps,
} from '../piIdleReleaseWatcher';

function createCandidate(overrides: Partial<PiIdleReleaseCandidate> = {}): PiIdleReleaseCandidate {
  return {
    id: 'session-1',
    idleSinceMs: 0,
    ...overrides,
  };
}

function createDeps(overrides: Partial<PiIdleReleaseWatcherDeps> = {}) {
  const session = {
    id: 'session-1',
    isTurnRunning: vi.fn<() => boolean>(() => false),
    listBackgroundTasks: vi.fn<() => readonly unknown[]>(() => []),
    countPendingWakeContinuations: vi.fn<() => number>(() => 0),
    manageAsyncUserQuestions: vi.fn(() => ({ questions: [] })),
    closeIfIdle: vi.fn<() => Promise<boolean>>(async () => true),
  };
  const deps: PiIdleReleaseWatcherDeps = {
    readIdleReleaseMinutes: vi.fn(() => 1),
    listCandidates: vi.fn(async () => [createCandidate()]),
    getSession: vi.fn(() => session),
    withSessionLock: vi.fn(async (_sessionId, task) => task()),
    hasPendingInput: vi.fn(async () => false),
    readIdleSinceMs: vi.fn(async () => 0),
    hasScheduledAutoResume: vi.fn(() => false),
    closeSession: vi.fn((current) => current.closeIfIdle()),
    now: vi.fn(() => 120_000),
    timer: { setInterval, clearInterval },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  };
  return { deps, session, watcher: createPiIdleReleaseWatcher(deps, 25) };
}

afterEach(() => {
  vi.useRealTimers();
});

// #10424, unit: use real Maker/Session teardown and resume. Mock-only watcher
// tests cannot catch close facts that accidentally clean task resources or IDs.
it('retires only the Pi runtime and resumes the same native identity', async () => {
  const rows = new Map<string, SessionMeta>();
  const storage: SessionStorage = {
    create: async meta => { const row = { ...meta, createdAt: 1, updatedAt: 1 }; rows.set(meta.id, row); return row; },
    get: async id => rows.get(id) ?? null,
    list: async () => [...rows.values()],
    update: async (id, patch) => { const row = { ...rows.get(id)!, ...patch }; rows.set(id, row); return row; },
    delete: vi.fn(async id => { rows.delete(id); }),
    compareAndClearSdkSessionId: vi.fn(async () => false),
  };
  const log = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
  const suppression = createRehydrateCloseSuppression(log);
  const removeTaskResources = vi.fn(async () => {});
  const handles: AgentSessionHandle[] = [];
  const startSession = vi.fn(async (opts: StartSessionOptions) => {
    let finish!: () => void;
    const ended = new Promise<void>(resolve => { finish = resolve; });
    const handle: AgentSessionHandle = {
      id: opts.resumeSessionId ?? 'pi-native-history', agentKind: 'pi', model: 'model',
      send: vi.fn(async () => {}), steer: async () => {}, abort: async () => {},
      getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
      close: vi.fn(async () => { finish(); }),
      async *events() { await ended; },
      isTurnRunning: () => false, setInteractionResolver() {},
    };
    handles.push(handle);
    return handle;
  });
  const agent = { kind: 'pi', capabilities: { sameTurnSteer: { supported: true } }, startSession,
    filterActiveSkillCommands: (result: unknown) => result, dispose: async () => {} } as unknown as BaseAgent;
  const maker = new Maker({ agents: { pi: agent }, storage, logger: log,
    lifecycleHooks: {
      isTransientCloseRequest: id => suppression.isSuppressed(id),
      onClose: (id, _options, close) => suppression.runOnCloseSideEffects(id, removeTaskResources,
        { skip: shouldSkipOnCloseSideEffects(close, suppression.isSuppressed(id)) }),
    },
  });
  const opts = { id: 'session-1', agentKind: 'pi' as const,
    workingDir: path.join(os.tmpdir(), 'pi-idle-fixture'), model: 'model' };
  const first = await maker.createSession(opts);
  const stored = { ...rows.get(first.id)! };
  const { watcher } = createDeps({
    getSession: id => maker.getSession(id) ?? null,
    closeSession: createPiIdleReleaseClose(maker, suppression.withSuppressed),
  });
  try {
    // Async cards survive turn completion, unlike synchronous interactions.
    first.setInteractionListener(() => new Promise(() => {}));
    const question = first.askUserQuestionAsync([{ question: 'Continue?' }]);
    await watcher.scanNow();
    expect(handles[0].close).not.toHaveBeenCalled();
    expect(first.manageAsyncUserQuestions({ action: 'list' }).questions).toHaveLength(1);
    first.manageAsyncUserQuestions({ action: 'withdraw', request_ids: [question.request_id], reason: 'Answered in test' });
    // An exclusive native operation is visible only to Session's atomic gate.
    handles[0].hasPendingHostOperation = () => true;
    await watcher.scanNow();
    expect(handles[0].close).not.toHaveBeenCalled();
    expect(maker.getSessionCloseReason(first)).toBe('unexpected');
    handles[0].hasPendingHostOperation = () => false;
    await watcher.scanNow();
    expect(handles[0].close).toHaveBeenCalledOnce();
    expect(maker.getSession(first.id)).toBeUndefined();
    expect(maker.getSessionCloseReason(first)).toBe('runtime-refresh');
    expect(rows.get(first.id)).toEqual(stored);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(storage.compareAndClearSdkSessionId).not.toHaveBeenCalled();
    expect(removeTaskResources).not.toHaveBeenCalled();
    expect(suppression.isSuppressed(first.id)).toBe(false);
    const persisted = (await maker.getSessionMeta(first.id))!;
    const resumed = await maker.createSession({ ...opts, resumeSessionId: persisted.sdkSessionId });
    expect(resumed).not.toBe(first);
    expect(resumed.id).toBe(first.id);
    expect(startSession.mock.calls[1][0].resumeSessionId).toBe('pi-native-history');
    await resumed.send('continue');
    expect(handles[1].send).toHaveBeenCalledOnce();
    expect(handles[0].send).not.toHaveBeenCalled();
    expect(rows.get(first.id)?.sdkSessionId).toBe('pi-native-history');
  } finally {
    watcher.stop();
    await maker.shutdown();
    suppression.resetForTest();
  }
});

describe('createPiIdleReleaseWatcher', () => {
  // #10424: scan/recheck SQL excluded bot and scheduler processes indefinitely.
  // Unit tier: an idle source row in real in-memory SQLite must reach release;
  // preselected candidate mocks cannot detect a missing source in the predicate.
  it.each(['active', 'archived'])('releases idle %s host-owned runtimes through the database filter', async (status) => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`CREATE TABLE sessions (
        id TEXT PRIMARY KEY, agent_kind TEXT, status TEXT, source TEXT, orca_role TEXT,
        hidden_at INTEGER, remote_host_id TEXT, agent_device_id TEXT,
        updated_at INTEGER, last_turn_ended_at INTEGER, user_send_at INTEGER
      )`);
      const insert = sqlite.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      insert.run('plugin', 'pi', status, 'plugin', null, 1, null, null, 0, 0, 0);
      insert.run('desktop', 'pi', status, 'desktop', null, null, null, null, 0, 0, 0);
      insert.run('hidden-desktop', 'pi', status, 'desktop', null, 1, null, null, 0, 0, 0);
      insert.run('worker', 'pi', status, 'plugin', 'worker', 1, null, null, 0, 0, 0);
      insert.run('ssh', 'pi', status, 'plugin', null, 1, 'ssh', null, 0, 0, 0);
      insert.run('device', 'pi', status, 'plugin', null, 1, null, 'device', 0, 0, 0);
      insert.run('bot', 'pi', status, 'bot', null, null, null, null, 0, 0, 0);
      insert.run('hidden-bot', 'pi', status, 'bot', null, 1, null, null, 0, 0, 0);
      insert.run('scheduler', 'pi', status, 'scheduler', null, null, null, null, 0, 0, 0);
      insert.run('hidden-scheduler', 'pi', status, 'scheduler', null, 1, null, null, 0, 0, 0);
      for (const source of ['bot', 'scheduler']) {
        insert.run(`${source}-worker`, 'pi', status, source, 'worker', null, null, null, 0, 0, 0);
        insert.run(`${source}-lead`, 'pi', status, source, 'lead', null, null, null, 0, 0, 0);
        insert.run(`${source}-ssh`, 'pi', status, source, null, null, 'ssh', null, 0, 0, 0);
        insert.run(`${source}-device`, 'pi', status, source, null, null, null, 'device', 0, 0, 0);
        insert.run(`${source}-deleted`, 'pi', 'deleted', source, null, null, null, null, 0, 0, 0);
        insert.run(`${source}-recent`, 'pi', status, source, null, null, null, null, 0, 0, 90_000);
      }
      insert.run('hidden-other', 'pi', status, 'im', null, 1, null, null, 0, 0, 0);
      insert.run('codex', 'codex', status, 'plugin', null, 1, null, null, 0, 0, 0);
      insert.run('deleted', 'pi', 'deleted', 'plugin', null, 1, null, null, 0, 0, 0);
      insert.run('recent', 'pi', status, 'plugin', null, 1, null, null, 0, 90_000, 0);
      const db = drizzle(sqlite);
      const idleSince = piIdleReleaseIdleSince();
      const { deps, session, watcher } = createDeps({
        listCandidates: async before => db.select({ id: sessions.id, idleSinceMs: idleSince }).from(sessions)
          .where(and(piIdleReleaseCandidateWhere(), sql`${idleSince} < ${before}`)).all(),
        readIdleSinceMs: async id => db.select({ idleSinceMs: idleSince }).from(sessions)
          .where(and(eq(sessions.id, id), piIdleReleaseCandidateWhere())).get()?.idleSinceMs ?? null,
      });
      await watcher.scanNow();
      expect(vi.mocked(deps.getSession).mock.calls.map(([id]) => id).sort()).toEqual([
        'bot', 'desktop', 'hidden-bot', 'hidden-scheduler', 'plugin', 'scheduler',
      ]);
      expect(session.closeIfIdle).toHaveBeenCalledTimes(6);
      // Each existing busy gate must also protect the newly eligible SQL rows.
      for (const [mock, busy, idle] of [
        [session.isTurnRunning, true, false],
        [session.listBackgroundTasks, [{ taskId: 'background' }], []],
        [session.countPendingWakeContinuations, 1, 0],
        [vi.mocked(deps.hasScheduledAutoResume), true, false],
        [vi.mocked(deps.hasPendingInput), true, false],
      ] as const) {
        session.closeIfIdle.mockClear();
        // The tuple covers synchronous and asynchronous runtime capabilities.
        (mock as ReturnType<typeof vi.fn>).mockImplementation(() => busy);
        await watcher.scanNow();
        expect(session.closeIfIdle).not.toHaveBeenCalled();
        (mock as ReturnType<typeof vi.fn>).mockImplementation(() => idle);
      }
      // Recheck newly admitted sources too: both activity and ownership can change.
      vi.mocked(deps.withSessionLock).mockImplementation(async (id, task) => {
        if (['plugin', 'bot', 'scheduler'].includes(id)) {
          sqlite.prepare('UPDATE sessions SET user_send_at = 100000 WHERE id = ?').run(id);
        }
        if (id === 'hidden-bot') sqlite.prepare('UPDATE sessions SET agent_device_id = ? WHERE id = ?').run('device', id);
        if (id === 'hidden-scheduler') sqlite.prepare('UPDATE sessions SET orca_role = ? WHERE id = ?').run('worker', id);
        return task();
      });
      session.closeIfIdle.mockClear();
      await watcher.scanNow();
      expect(session.closeIfIdle).toHaveBeenCalledOnce();
    } finally {
      sqlite.close();
    }
  });

  it('does not scan when idle release is disabled', async () => {
    const { deps, watcher } = createDeps({
      readIdleReleaseMinutes: vi.fn(() => 0),
    });

    await watcher.scanNow();

    expect(deps.listCandidates).not.toHaveBeenCalled();
    expect(deps.getSession).not.toHaveBeenCalled();
  });

  it('releases an idle session and reports the idle duration', async () => {
    const { deps, session, watcher } = createDeps();

    await watcher.scanNow();

    expect(deps.listCandidates).toHaveBeenCalledWith(60_000);
    expect(deps.withSessionLock).toHaveBeenCalledWith('session-1', expect.any(Function));
    expect(session.closeIfIdle).toHaveBeenCalledOnce();
    expect(deps.log.info).toHaveBeenCalledWith(
      'piIdleWatcher: released idle session',
      expect.objectContaining({ sessionId: 'session-1', idleMs: 120_000, idleThresholdMin: 1 }),
    );
  });

  it('keeps a session with a live turn', async () => {
    const { session, watcher } = createDeps();
    session.isTurnRunning.mockReturnValue(true);

    await watcher.scanNow();

    expect(session.closeIfIdle).not.toHaveBeenCalled();
  });

  it('keeps a session with background tasks', async () => {
    const { session, watcher } = createDeps();
    session.listBackgroundTasks.mockReturnValue([{ taskId: 'task-1' }]);

    await watcher.scanNow();

    expect(session.closeIfIdle).not.toHaveBeenCalled();
  });

  it('keeps a session with a pending wake continuation', async () => {
    const { session, watcher } = createDeps();
    session.countPendingWakeContinuations.mockReturnValue(1);

    await watcher.scanNow();

    expect(session.closeIfIdle).not.toHaveBeenCalled();
  });

  it('keeps a session with a scheduled automatic resume', async () => {
    const { session, watcher } = createDeps({
      hasScheduledAutoResume: vi.fn(() => true),
    });

    await watcher.scanNow();

    expect(session.closeIfIdle).not.toHaveBeenCalled();
  });

  it('keeps a session with queued input', async () => {
    const { deps, session, watcher } = createDeps({
      hasPendingInput: vi.fn(async () => true),
    });

    await watcher.scanNow();

    expect(session.closeIfIdle).not.toHaveBeenCalled();
    expect(deps.log.info).not.toHaveBeenCalled();
  });

  it('rechecks the idle clock after waiting for the session lock', async () => {
    // now=120_000、TTL=1min：候选快照已过期，锁内复核发现 30s 前刚有活动。
    const { deps, session, watcher } = createDeps({
      readIdleSinceMs: vi.fn(async () => 90_000),
    });

    await watcher.scanNow();

    expect(session.closeIfIdle).not.toHaveBeenCalled();
    expect(deps.log.info).not.toHaveBeenCalled();
  });

  it('skips a session that no longer matches the candidate filter', async () => {
    const { session, watcher } = createDeps({
      readIdleSinceMs: vi.fn(async () => null),
    });

    await watcher.scanNow();

    expect(session.closeIfIdle).not.toHaveBeenCalled();
  });

  it('leaves a session untouched when this process does not own its runtime', async () => {
    const { deps, watcher } = createDeps({
      getSession: vi.fn(() => null),
    });

    await watcher.scanNow();

    expect(deps.withSessionLock).toHaveBeenCalledWith('session-1', expect.any(Function));
    expect(deps.log.info).not.toHaveBeenCalled();
  });

  it('rechecks live state after waiting for the session lock', async () => {
    const { deps, session, watcher } = createDeps();
    deps.withSessionLock = vi.fn(async (_sessionId, task) => {
      session.isTurnRunning.mockReturnValue(true);
      return task();
    });

    await watcher.scanNow();

    expect(session.closeIfIdle).not.toHaveBeenCalled();
    expect(deps.log.info).not.toHaveBeenCalled();
  });

  it('does not report a release when the session refused to close', async () => {
    const { deps, session, watcher } = createDeps();
    session.closeIfIdle.mockResolvedValue(false);

    await watcher.scanNow();

    expect(session.closeIfIdle).toHaveBeenCalledOnce();
    expect(deps.log.info).not.toHaveBeenCalled();
  });

  it('keeps scanning after one candidate fails', async () => {
    const failing = createCandidate({ id: 'session-fail' });
    const { deps, session, watcher } = createDeps({
      listCandidates: vi.fn(async () => [failing, createCandidate()]),
    });
    session.closeIfIdle.mockRejectedValueOnce(new Error('close failed'));

    await watcher.scanNow();

    expect(deps.log.warn).toHaveBeenCalledWith(
      'piIdleWatcher: release session failed',
      expect.objectContaining({ sessionId: 'session-fail', err: 'close failed' }),
    );
    expect(session.closeIfIdle).toHaveBeenCalledTimes(2);
    expect(deps.log.info).toHaveBeenCalledWith(
      'piIdleWatcher: released idle session',
      expect.objectContaining({ sessionId: 'session-1' }),
    );
  });

  it('runs one scan at a time', async () => {
    let releaseScan!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const listCandidates = vi.fn(async () => {
      await gate;
      return [];
    });
    const { watcher } = createDeps({ listCandidates });

    const first = watcher.scanNow();
    const second = watcher.scanNow();
    releaseScan();
    await Promise.all([first, second]);

    expect(listCandidates).toHaveBeenCalledOnce();
  });

  it('uses the injected interval and stops future scans', async () => {
    vi.useFakeTimers();
    const listCandidates = vi.fn(async () => []);
    const { watcher } = createDeps({ listCandidates });

    watcher.start();
    await vi.advanceTimersByTimeAsync(25);
    expect(listCandidates).toHaveBeenCalledOnce();

    watcher.stop();
    await vi.advanceTimersByTimeAsync(50);
    expect(listCandidates).toHaveBeenCalledOnce();
  });
});
