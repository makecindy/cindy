import Database from 'better-sqlite3';
import { Maker, type AgentSessionHandle, type BaseAgent, type SessionMeta, type SessionStorage, type StartSessionOptions } from '@cindy/maker-core';
import { createRehydrateCloseSuppression } from '../../maker-host/rehydrateCloseSuppression';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClaudeIdleReleaseWatcher, ORDINARY_CLAUDE_TASK_SQL, type IdleClaudeSession } from '../claudeIdleReleaseWatcher';

function fixture() {
  let now = 0;
  let generation = 0;
  let event = () => {};
  const unsubscribe = vi.fn();
  const session: IdleClaudeSession = {
    id: 'task', agentKind: 'claude-code', remoteHostId: null, sdkSessionId: 'native-history',
    getStatus: () => 'active', getTurnGeneration: () => generation,
    isTurnRunning: vi.fn(() => false), listBackgroundTasks: vi.fn(() => []),
    countPendingWakeContinuations: vi.fn(() => 0),
    onEvent: vi.fn((listener) => { event = () => listener({ type: 'done', data: null }); return unsubscribe; }),
    closeIfIdle: vi.fn(async () => true), close: vi.fn(async () => {}),
  };
  let live: IdleClaudeSession[] = [session];
  const deps = {
    listSessions: () => live, getSession: (id: string) => live.find(s => s.id === id),
    readMinutes: vi.fn(() => 30), isOrdinaryTask: vi.fn(async (_id: string, _nativeId: string) => true),
    hasPendingInput: vi.fn(async () => false), isHostBusy: vi.fn(() => false),
    withLock: async <T>(_id: string, fn: () => Promise<T>) => fn(),
    close: vi.fn(async (s: IdleClaudeSession) => {
      const closed = await s.closeIfIdle();
      if (closed) live = live.filter(item => item !== s);
      return closed;
    }),
    now: () => now, warn: vi.fn(),
  };
  const watcher = createClaudeIdleReleaseWatcher(deps);
  return { session, deps, watcher, unsubscribe, event: () => event(),
    advance: (minutes: number) => { now += minutes * 60_000; },
    nextTurn: () => { generation++; }, replace: (s: IdleClaudeSession) => { live = [s]; } };
}
async function aged(f: ReturnType<typeof fixture>) {
  await f.watcher.scanNow(); f.advance(30);
}
afterEach(() => vi.useRealTimers());

describe('ordinary Claude idle runtime release', () => {
  it('closes once only after the threshold, and observes a replacement for a fresh full period', async () => {
    const f = fixture(); await f.watcher.scanNow(); f.advance(29);
    await f.watcher.scanNow(); expect(f.deps.close).not.toHaveBeenCalled();
    f.advance(1); await f.watcher.scanNow(); await f.watcher.scanNow();
    expect(f.deps.close).toHaveBeenCalledOnce(); expect(f.unsubscribe).toHaveBeenCalledOnce();
    f.replace({ ...f.session }); await f.watcher.scanNow();
    expect(f.deps.close).toHaveBeenCalledOnce();
    f.advance(30); await f.watcher.scanNow(); expect(f.deps.close).toHaveBeenCalledTimes(2);
    f.watcher.stop();
  });
  it.each(['turn', 'background', 'background-unavailable', 'wake', 'host', 'queue', 'scope', 'unknown'] as const)(
    'preserves a runtime blocked by %s', async (kind) => {
      const f = fixture(); await aged(f);
      if (kind === 'turn') vi.mocked(f.session.isTurnRunning).mockReturnValue(true);
      if (kind === 'background') vi.mocked(f.session.listBackgroundTasks).mockReturnValue([{ taskId: 'still-working' }]);
      if (kind === 'background-unavailable') vi.mocked(f.session.listBackgroundTasks).mockImplementation(() => { throw Error('unavailable'); });
      if (kind === 'wake') vi.mocked(f.session.countPendingWakeContinuations).mockReturnValue(1);
      if (kind === 'host') f.deps.isHostBusy.mockReturnValue(true);
      if (kind === 'queue') f.deps.hasPendingInput.mockResolvedValue(true);
      if (kind === 'scope') f.deps.isOrdinaryTask.mockResolvedValue(false);
      if (kind === 'unknown') f.deps.isOrdinaryTask.mockRejectedValue(Error('database unavailable'));
      await f.watcher.scanNow(); expect(f.deps.close).not.toHaveBeenCalled(); f.watcher.stop();
    });
  it('lets a send that wins the lock keep its runtime', async () => {
    const f = fixture(); await aged(f);
    let unlock!: () => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    f.deps.withLock = async (_id, fn) => { await gate; return fn(); };
    const scan = f.watcher.scanNow();
    vi.mocked(f.session.isTurnRunning).mockReturnValue(true);
    unlock(); await scan;
    expect(f.deps.isOrdinaryTask).not.toHaveBeenCalled();
    expect(f.deps.close).not.toHaveBeenCalled(); f.watcher.stop();
  });
  it.each(['', '<pending>'])('keeps a runtime with native identity %j', async (sdkSessionId) => {
    const f = fixture(); Object.defineProperty(f.session, 'sdkSessionId', { value: sdkSessionId });
    await aged(f); await f.watcher.scanNow();
    expect(f.deps.close).not.toHaveBeenCalled(); f.watcher.stop();
  });
  it('does not close an unrelated error runtime', async () => {
    const f = fixture(); f.session.getStatus = () => 'error';
    await aged(f); await f.watcher.scanNow();
    expect(f.deps.close).not.toHaveBeenCalled(); f.watcher.stop();
  });
  it('resets for events and for short turns completed between scans', async () => {
    const f = fixture(); await aged(f); f.event();
    await f.watcher.scanNow(); expect(f.deps.close).not.toHaveBeenCalled();
    f.advance(30); f.nextTurn(); await f.watcher.scanNow();
    expect(f.deps.close).not.toHaveBeenCalled(); f.advance(30);
    await f.watcher.scanNow(); expect(f.deps.close).toHaveBeenCalledOnce();
  });
  it.each(['stop', 'replace', 'turn', 'event', 'disable', 'queue', 'identity'] as const)(
    'rechecks %s after asynchronous task lookup', async (change) => {
      const f = fixture(); await aged(f);
      f.deps.isOrdinaryTask.mockImplementation(async () => {
        if (change === 'identity') Object.defineProperty(f.session, 'sdkSessionId', { value: 'new-history' });
        if (change === 'stop') f.watcher.stop();
        if (change === 'replace') f.replace({ ...f.session });
        if (change === 'turn') f.nextTurn();
        if (change === 'event') f.event();
        if (change === 'disable') f.deps.readMinutes.mockReturnValue(0);
        if (change === 'queue') f.deps.isHostBusy.mockReturnValue(true);
        return true;
      });
      await f.watcher.scanNow(); expect(f.deps.close).not.toHaveBeenCalled(); f.watcher.stop();
    });
  it('retries failed teardown without overlapping scans', async () => {
    const f = fixture(); await aged(f);
    let release!: () => void;
    f.deps.isOrdinaryTask.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = () => resolve(true); }));
    const scan = f.watcher.scanNow(); await Promise.resolve();
    await f.watcher.scanNow(); expect(f.deps.isOrdinaryTask).toHaveBeenCalledOnce();
    f.deps.close.mockRejectedValueOnce(Error('close failed')); release(); await scan;
    expect(f.unsubscribe).not.toHaveBeenCalled(); f.advance(30); await f.watcher.scanNow();
    expect(f.deps.close).toHaveBeenCalledTimes(2); f.watcher.stop();
  });
  it('excludes remote Claude and other engines; disable and stop remove observers', async () => {
    const f = fixture(); f.replace({ ...f.session, remoteHostId: 'ssh' });
    await aged(f); expect(f.session.onEvent).not.toHaveBeenCalled();
    f.replace({ ...f.session, agentKind: 'codex' }); await f.watcher.scanNow();
    expect(f.session.onEvent).not.toHaveBeenCalled(); f.replace(f.session);
    await f.watcher.scanNow(); f.deps.readMinutes.mockReturnValue(0); await f.watcher.scanNow();
    expect(f.unsubscribe).toHaveBeenCalledOnce(); f.watcher.stop();
  });
  it('does not release when Session rejects atomic close, and stops interval scans', async () => {
    vi.useFakeTimers(); const f = fixture(); await aged(f);
    vi.mocked(f.session.closeIfIdle).mockResolvedValueOnce(false);
    await f.watcher.scanNow(); expect(f.unsubscribe).not.toHaveBeenCalled();
    f.watcher.start(); f.watcher.start(); expect(vi.getTimerCount()).toBe(1);
    f.watcher.stop(); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000); expect(f.deps.close).toHaveBeenCalledOnce();
  });
});


describe('ordinary Claude task eligibility in SQLite', () => {
  function database() {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT, source TEXT,
        agent_kind TEXT, remote_host_id TEXT, orca_role TEXT, sdk_session_id TEXT);
      CREATE TABLE bot_session_links (session_id TEXT);
      CREATE TABLE orca_workers (session_id TEXT);
      CREATE TABLE orca_teams (lead_session_id TEXT, status TEXT);
      CREATE TABLE session_goals (session_id TEXT, status TEXT);
      INSERT INTO sessions VALUES ('task', 'active', 'desktop', 'claude-code', NULL, NULL, 'native-history');
    `);
    return db;
  }
  it.each([
    "UPDATE sessions SET status = 'archived'",
    "UPDATE sessions SET status = 'deleted'",
    "UPDATE sessions SET source = 'scheduler'",
    "UPDATE sessions SET agent_kind = 'codex'",
    "UPDATE sessions SET remote_host_id = 'ssh-host'",
    "UPDATE sessions SET orca_role = 'worker'",
    "UPDATE sessions SET sdk_session_id = NULL",
    "UPDATE sessions SET sdk_session_id = 'stale-history'",
    "INSERT INTO bot_session_links VALUES ('task')",
    "INSERT INTO orca_workers VALUES ('task')",
    "INSERT INTO orca_teams VALUES ('task', 'active')",
    ...['active', 'paused', 'blocked', 'budgetLimited', 'usageLimited'].map(
      status => `INSERT INTO session_goals VALUES ('task', '${status}')`,
    ),
  ])('does not reclaim after %s', (change) => {
    const db = database();
    try {
      const eligible = db.prepare(ORDINARY_CLAUDE_TASK_SQL);
      expect(eligible.get('task', 'native-history')).toEqual({ id: 'task' });
      db.exec(change);
      expect(eligible.get('task', 'native-history')).toBeUndefined();
    } finally { db.close(); }
  });
  it.each([
    "INSERT INTO session_goals VALUES ('task', 'active')",
    "INSERT INTO orca_teams VALUES ('task', 'active')",
  ])('rechecks ownership changed during queue restoration: %s', async change => {
    const db = database();
    const f = fixture();
    try {
      const eligible = db.prepare(ORDINARY_CLAUDE_TASK_SQL);
      f.deps.isOrdinaryTask.mockImplementation(async (id, nativeId) => Boolean(eligible.get(id, nativeId)));
      f.deps.hasPendingInput.mockImplementation(async () => { db.exec(change); return false; });
      await aged(f); await f.watcher.scanNow();
      expect(f.deps.hasPendingInput).toHaveBeenCalledOnce();
      expect(f.deps.close).not.toHaveBeenCalled();
    } finally { f.watcher.stop(); db.close(); }
  });
  it('retains completed goals and other tasks while releasing only a resumable ordinary task', () => {
    const db = database();
    try {
      db.exec("INSERT INTO session_goals VALUES ('task', 'complete'); INSERT INTO bot_session_links VALUES ('other')");
      const before = db.prepare('SELECT * FROM sessions').all();
      const eligible = db.prepare(ORDINARY_CLAUDE_TASK_SQL);
      expect(eligible.get('task', 'native-history')).toEqual({ id: 'task' });
      expect(eligible.get('missing', 'native-history')).toBeUndefined();
      expect(db.prepare('SELECT * FROM sessions').all()).toEqual(before);
      db.exec("UPDATE sessions SET sdk_session_id = '<pending>'");
      expect(eligible.get('task', '<pending>')).toBeUndefined();
    } finally { db.close(); }
  });
});


it.each([false, true])('preserves task data and resumes native identity after real Maker release (teardown retry: %s)', async (failFirstClose) => {
  const rows = new Map<string, SessionMeta>();
  const storage: SessionStorage = {
    create: async meta => { const row = { ...meta, createdAt: 1, updatedAt: 1 }; rows.set(meta.id, row); return row; },
    get: async id => rows.get(id) ?? null,
    list: async () => [...rows.values()],
    update: async (id, patch) => { const row = { ...rows.get(id)!, ...patch }; rows.set(id, row); return row; },
    delete: vi.fn(async id => { rows.delete(id); }),
    compareAndClearSdkSessionId: async () => false,
  };
  const log = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
  const suppression = createRehydrateCloseSuppression(log);
  const removeAttachmentsAndWorkspace = vi.fn(async () => {});
  const handles: AgentSessionHandle[] = [];
  const startSession = vi.fn(async (opts: StartSessionOptions) => {
    let finish!: () => void;
    const ended = new Promise<void>(resolve => { finish = resolve; });
    const handle: AgentSessionHandle = {
      id: opts.resumeSessionId ?? 'native-history', agentKind: 'claude-code', model: 'model',
      send: vi.fn(async () => {}), steer: async () => {}, abort: async () => {},
      getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
      close: vi.fn(async () => { finish(); }),
      async *events() { await ended; },
      isTurnRunning: () => false, setInteractionResolver() {},
    };
    handles.push(handle);
    return handle;
  });
  const agent = { kind: 'claude-code', capabilities: {}, startSession,
    filterActiveSkillCommands: (result: unknown) => result, dispose: async () => {} } as unknown as BaseAgent;
  const maker = new Maker({ agents: { 'claude-code': agent }, storage, logger: log,
    lifecycleHooks: { onClose: id => suppression.runOnCloseSideEffects(id, removeAttachmentsAndWorkspace) } });
  const opts = { id: 'task', agentKind: 'claude-code' as const, workingDir: '/fixture', model: 'model' };
  const first = await maker.createSession(opts);
  if (failFirstClose) vi.mocked(handles[0].close).mockRejectedValueOnce(Error('process still alive'));
  const stored = { ...rows.get('task')! };
  let now = 0;
  const watcher = createClaudeIdleReleaseWatcher({
    listSessions: () => maker.listActiveSessions(), getSession: id => maker.getSession(id),
    readMinutes: () => 30,
    isOrdinaryTask: async (id, nativeId) => (await storage.get(id))?.sdkSessionId === nativeId,
    hasPendingInput: async () => false, isHostBusy: () => false,
    withLock: async (_id, fn) => fn(),
    close: (session, retryFailedClose) => suppression.withSuppressed(session.id, () =>
      retryFailedClose && session.getStatus() === 'error' ? session.close().then(() => true) : session.closeIfIdle()),
    now: () => now, warn: log.warn,
  });
  try {
    await watcher.scanNow(); now = 30 * 60_000; await watcher.scanNow();
    if (failFirstClose) {
      expect(first.getStatus()).toBe('error');
      expect(maker.getSession('task')).toBe(first);
      expect(removeAttachmentsAndWorkspace).not.toHaveBeenCalled();
      now += 29 * 60_000; await watcher.scanNow();
      expect(handles[0].close).toHaveBeenCalledOnce();
      now += 60_000; await watcher.scanNow();
    }
    expect(handles[0].close).toHaveBeenCalledTimes(failFirstClose ? 2 : 1);
    expect(maker.getSession('task')).toBeUndefined();
    expect(rows.get('task')).toEqual(stored);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(removeAttachmentsAndWorkspace).not.toHaveBeenCalled();
    // The host lazy-send path reads persisted metadata before invoking Maker.createSession.
    const persisted = (await maker.getSessionMeta('task'))!;
    const resumed = await maker.createSession({ ...opts, resumeSessionId: persisted.sdkSessionId });
    expect(resumed).not.toBe(first);
    expect(startSession.mock.calls[1][0].resumeSessionId).toBe('native-history');
    await resumed.send('continue');
    expect(handles[1].send).toHaveBeenCalledOnce();
    expect(handles[0].send).not.toHaveBeenCalled();
    expect(rows.get('task')?.sdkSessionId).toBe('native-history');
  } finally {
    watcher.stop();
    await maker.shutdown();
    suppression.resetForTest();
  }
});
