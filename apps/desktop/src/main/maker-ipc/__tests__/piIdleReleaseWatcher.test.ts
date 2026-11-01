import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, sql } from 'drizzle-orm';
import { sessions } from '../../localDb/schema';

import {
  createPiIdleReleaseWatcher,
  piIdleReleaseCandidateWhere,
  piIdleReleaseIdleSince,
  type PiIdleReleaseCandidate,
  type PiIdleReleaseWatcherDeps,
} from '../piIdleReleaseWatcher';

// SQLite integration: the existing fake-candidate tests cannot verify the production
// source/visibility filter or the latest-activity clock used by scan and locked recheck.
it('selects only local ordinary and plugin Pi tasks using their latest activity', () => {
  const raw = new Database(':memory:');
  try {
    raw.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, agent_kind TEXT DEFAULT 'pi', status TEXT DEFAULT 'active',
      source TEXT DEFAULT 'desktop', hidden_at INTEGER, orca_role TEXT,
      remote_host_id TEXT, agent_device_id TEXT, updated_at INTEGER DEFAULT 10,
      last_turn_ended_at INTEGER, user_send_at INTEGER
    );
    INSERT INTO sessions(id) VALUES ('ordinary');
    INSERT INTO sessions(id, source, hidden_at, status) VALUES ('plugin', 'plugin', 1, 'archived');
    INSERT INTO sessions(id, hidden_at) VALUES ('hidden', 1);
    INSERT INTO sessions(id, source) VALUES ('bot', 'bot'), ('im', 'telegram');
    INSERT INTO sessions(id, agent_kind) VALUES ('codex', 'codex');
    INSERT INTO sessions(id, status) VALUES ('deleted', 'deleted');
    INSERT INTO sessions(id, orca_role) VALUES ('worker', 'worker');
    INSERT INTO sessions(id, remote_host_id) VALUES ('ssh', 'remote');
    INSERT INTO sessions(id, agent_device_id) VALUES ('device', 'remote');
    INSERT INTO sessions(id, updated_at, last_turn_ended_at, user_send_at)
      VALUES ('recent-update', 100, 10, 10), ('recent-turn', 10, 100, 10), ('recent-send', 10, 10, 100);
    `);
    const db = drizzle(raw);
    const read = () => db.select({ id: sessions.id }).from(sessions)
      .where(and(piIdleReleaseCandidateWhere(), sql`${piIdleReleaseIdleSince()} < 50`)).all()
      .map(row => row.id).sort();
    expect(read()).toEqual(['ordinary', 'plugin']);
    raw.exec("UPDATE sessions SET user_send_at = 100 WHERE id = 'plugin'");
    expect(read()).toEqual(['ordinary']);
  } finally {
    raw.close();
  }
});

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
