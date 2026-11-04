import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, eq, sql } from 'drizzle-orm';
import { sessions } from '../../localDb/schema.js';

import {
  createPiIdleReleaseWatcher,
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
    isTurnRunning: vi.fn<() => boolean>(() => false),
    listBackgroundTasks: vi.fn<() => readonly unknown[]>(() => []),
    countPendingWakeContinuations: vi.fn<() => number>(() => 0),
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

describe('createPiIdleReleaseWatcher', () => {
  // Unit regression: the real scan/recheck SQL excluded hidden plugin tasks.
  // Existing tests injected preselected candidates and could not catch that leak.
  // Minimal input: one idle hidden Pi plugin task; use in-memory SQLite, no user DB.
  it.each(['active', 'archived'])('releases idle %s plugin runtimes through the database filter', async (status) => {
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
      expect(vi.mocked(deps.getSession).mock.calls.map(([id]) => id).sort()).toEqual(['desktop', 'plugin']);
      expect(session.closeIfIdle).toHaveBeenCalledTimes(2);
      // The lock recheck must also see plugin activity that arrived after selection.
      vi.mocked(deps.withSessionLock).mockImplementation(async (id, task) => {
        if (id === 'plugin') sqlite.prepare('UPDATE sessions SET user_send_at = 100000 WHERE id = ?').run(id);
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
