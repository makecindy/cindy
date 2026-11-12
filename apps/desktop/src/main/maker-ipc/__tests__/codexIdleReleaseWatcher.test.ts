import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, eq, sql } from 'drizzle-orm';
import { sessions } from '../../localDb/schema.js';

import {
  createCodexIdleReleaseWatcher,
  codexIdleReleaseCandidateWhere,
  codexIdleReleaseIdleSince,
  type CodexIdleReleaseCandidate,
  type CodexIdleReleaseWatcherDeps,
} from '../codexIdleReleaseWatcher';

/**
 * 测试价值
 * - 生产入口与可观察结果：createCodexIdleReleaseWatcher().scanNow() 走与生产相同的
 *   候选 SQL + 锁内复核 + closeIfIdle 预约；用户可观察结果是「闲置 codex 会话的
 *   thread 运行时被释放、下一次发送 lazy 重建」与「在跑/排队/切换中的会话绝不被关」。
 * - Bug／规则依据：upstream #5830（本机 codex 会话无 Idle TTL，进程与 thread 运行时
 *   随运行时长累积）；候选过滤回归类同 piIdleReleaseWatcher 的 hidden plugin 泄漏。
 * - 现有覆盖缺口：pi / claude watcher 各自只覆盖自己的 agentKind；codex watcher 是
 *   第三个独立模块（agentKind='codex' + 凭证切换/软重启闸门），此前无任何用例。
 * - 最小失败输入：一条闲置的普通 desktop codex 会话应被 closeIfIdle；把候选 SQL 的
 *   agentKind 换成 'pi'（或去掉 isCodexHostBusy 闸门）对应用例立刻转红。
 * - tier：unit（内存 SQLite + 依赖注入，无真实进程/网络/用户库）。
 */

function createSession() {
  return {
    isTurnRunning: vi.fn<() => boolean>(() => false),
    listBackgroundTasks: vi.fn<() => readonly unknown[]>(() => []),
    countPendingWakeContinuations: vi.fn<() => number>(() => 0),
    closeIfIdle: vi.fn<() => Promise<boolean>>(async () => true),
  };
}

function createCandidate(overrides: Partial<CodexIdleReleaseCandidate> = {}): CodexIdleReleaseCandidate {
  return {
    id: 'session-1',
    idleSinceMs: 0,
    ...overrides,
  };
}

function createDeps(overrides: Partial<CodexIdleReleaseWatcherDeps> = {}) {
  const session = createSession();
  const deps: CodexIdleReleaseWatcherDeps = {
    readIdleReleaseMinutes: vi.fn(() => 1),
    listCandidates: vi.fn(async () => [createCandidate()]),
    getSession: vi.fn(() => session),
    withSessionLock: vi.fn(async (_sessionId, task) => task()),
    hasPendingInput: vi.fn(async () => false),
    readIdleSinceMs: vi.fn(async () => 0),
    hasScheduledAutoResume: vi.fn(() => false),
    isCodexHostBusy: vi.fn(() => false),
    now: vi.fn(() => 120_000),
    timer: { setInterval, clearInterval },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  };
  return { deps, session, watcher: createCodexIdleReleaseWatcher(deps, 25) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createCodexIdleReleaseWatcher', () => {
  // Unit regression: the real scan/recheck SQL must select only ordinary local
  // codex tasks. Existing pi/claude tests inject their own agentKind and cannot
  // catch this filter leaking across agents or lifecycle owners.
  // Minimal input: one idle ordinary desktop codex task + one of each exclusion;
  // in-memory SQLite, no user DB.
  it.each(['active', 'archived'])('releases idle %s codex runtimes through the database filter', async (status) => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`CREATE TABLE sessions (
        id TEXT PRIMARY KEY, agent_kind TEXT, status TEXT, source TEXT, orca_role TEXT,
        hidden_at INTEGER, remote_host_id TEXT, agent_device_id TEXT,
        updated_at INTEGER, last_turn_ended_at INTEGER, user_send_at INTEGER
      )`);
      const insert = sqlite.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      insert.run('desktop', 'codex', status, 'desktop', null, null, null, null, 0, 0, 0);
      insert.run('plugin', 'codex', status, 'plugin', null, 1, null, null, 0, 0, 0);
      insert.run('hidden-desktop', 'codex', status, 'desktop', null, 1, null, null, 0, 0, 0);
      insert.run('worker', 'codex', status, 'plugin', 'worker', 1, null, null, 0, 0, 0);
      insert.run('ssh', 'codex', status, 'plugin', null, 1, 'ssh', null, 0, 0, 0);
      insert.run('device', 'codex', status, 'plugin', null, 1, null, 'device', 0, 0, 0);
      insert.run('bot', 'codex', status, 'bot', null, null, null, null, 0, 0, 0);
      insert.run('pi', 'pi', status, 'plugin', null, 1, null, null, 0, 0, 0);
      insert.run('claude', 'claude-code', status, 'plugin', null, 1, null, null, 0, 0, 0);
      insert.run('deleted', 'codex', 'deleted', 'plugin', null, 1, null, null, 0, 0, 0);
      insert.run('recent', 'codex', status, 'plugin', null, 1, null, null, 0, 90_000, 0);
      const db = drizzle(sqlite);
      const idleSince = codexIdleReleaseIdleSince();
      const { deps, session, watcher } = createDeps({
        listCandidates: async before => db.select({ id: sessions.id, idleSinceMs: idleSince }).from(sessions)
          .where(and(codexIdleReleaseCandidateWhere(), sql`${idleSince} < ${before}`)).all(),
        readIdleSinceMs: async id => db.select({ idleSinceMs: idleSince }).from(sessions)
          .where(and(eq(sessions.id, id), codexIdleReleaseCandidateWhere())).get()?.idleSinceMs ?? null,
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
      'codexIdleWatcher: released idle session',
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

  // codex-specific: a credential switch or deferred/gateway soft restart in
  // flight owns the session; releasing it mid-window would race the restart.
  it('keeps a session while a codex credential switch or restart holds it', async () => {
    const { deps, session, watcher } = createDeps({
      isCodexHostBusy: vi.fn(() => true),
    });

    await watcher.scanNow();

    expect(session.closeIfIdle).not.toHaveBeenCalled();
    expect(deps.log.info).not.toHaveBeenCalled();
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
      'codexIdleWatcher: release session failed',
      expect.objectContaining({ sessionId: 'session-fail', err: 'close failed' }),
    );
    expect(session.closeIfIdle).toHaveBeenCalledTimes(2);
    expect(deps.log.info).toHaveBeenCalledWith(
      'codexIdleWatcher: released idle session',
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
    await watcher.scanNow();
    expect(listCandidates).toHaveBeenCalledTimes(1);
    releaseScan();
    await first;
    await watcher.scanNow();
    expect(listCandidates).toHaveBeenCalledTimes(2);
  });
});
