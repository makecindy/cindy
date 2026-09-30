import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createSessionArchiveSync, prepareArchiveSessions, type ArchiveSessionRow } from '../session-archive-sync.js';
import { projectNativeSessionMetadata } from '../native-session-metadata.js';
import { setCurrentDbClient, clearCurrentDbClient } from '../../localDb/client/current.js';
import type { DbClient } from '../../localDb/client/DbClient.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); clearCurrentDbClient(); vi.useRealTimers(); });

function fixture() {
  const db = new Database(':memory:');
  cleanups.push(() => db.close());
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_kind TEXT, sdk_session_id TEXT,
    status TEXT, remote_host_id TEXT, working_dir TEXT DEFAULT '/project', workspace_kind TEXT DEFAULT 'project',
    extra_dirs TEXT DEFAULT '["/reference"]', writable_dirs TEXT DEFAULT '["/output"]', updated_at INTEGER DEFAULT 1)`);
  const client = { query: async <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[] };
  setCurrentDbClient(client as DbClient, 'owner');
  const sync = vi.fn(async (_input: { threadId: string; archived: boolean; remoteHostId?: string; assertCurrent(): void }) => {});
  const prepare = vi.fn(async (_rows: ArchiveSessionRow[]) => true);
  const warn = vi.fn();
  const assertCurrent = vi.fn();
  const canUseRemote = vi.fn(() => true);
  const coordinator = createSessionArchiveSync({
    capture: () => ({ client, assertCurrent }), prepare, sync, warn, canUseRemote, release: vi.fn(async () => {}),
  });
  cleanups.push(() => coordinator.stop());
  const insert = (id: string, kind = 'codex', status = 'archived', sdk = id, remote: string | null = null) => {
    db.prepare('INSERT INTO sessions(id,agent_kind,status,sdk_session_id,remote_host_id) VALUES(?,?,?,?,?)').run(id, kind, status, sdk, remote);
  };
  return { db, client, sync, prepare, warn, assertCurrent, canUseRemote, coordinator, insert };
}

describe('task archive projection', () => {
  it('rechecks an idle active handle without closing it', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.insert('task', 'codex', 'active');
    const live = { getStatus: () => 'active', isTurnRunning: () => false, closeIfIdle: vi.fn(async () => true) };
    f.prepare.mockImplementation(rows => prepareArchiveSessions(rows, () => live));
    await f.coordinator.request();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(f.sync).toHaveBeenCalledTimes(2);
    expect(f.sync).toHaveBeenLastCalledWith(expect.objectContaining({ archived: false }));
    expect(live.closeIfIdle).not.toHaveBeenCalled();
  });

  it('defers running handles and closes idle archived handles before syncing', async () => {
    const f = fixture();
    f.insert('task');
    const live = { getStatus: () => 'active', isTurnRunning: vi.fn(() => true), closeIfIdle: vi.fn(async () => true) };
    f.prepare.mockImplementation(rows => prepareArchiveSessions(rows, () => live));
    await f.coordinator.request();
    expect(f.sync).not.toHaveBeenCalled();
    expect(live.closeIfIdle).not.toHaveBeenCalled();
    live.isTurnRunning.mockReturnValue(false);
    await f.coordinator.request();
    expect(live.closeIfIdle).toHaveBeenCalledTimes(1);
    expect(f.sync).toHaveBeenCalledTimes(1);
  });

  it.each(['active', 'archived'])('periodically repairs native drift while Cindy stays %s', async status => {
    vi.useFakeTimers();
    const f = fixture();
    f.insert('task', 'codex', status);
    let nativeArchived = status !== 'archived';
    f.sync.mockImplementation(async input => { nativeArchived = input.archived; });
    await f.coordinator.request();
    expect(nativeArchived).toBe(status === 'archived');

    // Another native client changes the thread; Cindy's row is unchanged.
    nativeArchived = !nativeArchived;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(f.sync).toHaveBeenCalledTimes(2);
    expect(nativeArchived).toBe(status === 'archived');
    expect(f.db.prepare('SELECT status FROM sessions').get()).toEqual({ status });
  });

  it('backfills Codex, restores it, and preserves all three harnesses and directory scopes', async () => {
    const f = fixture();
    for (const kind of ['cc', 'codex', 'pi']) f.insert(kind, kind);
    const before = f.db.prepare('SELECT * FROM sessions ORDER BY id').all();
    await f.coordinator.request();
    expect(f.sync).toHaveBeenCalledTimes(1);
    expect(f.sync).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: 'codex', archived: true }));
    expect(f.db.prepare('SELECT * FROM sessions ORDER BY id').all()).toEqual(before);
    await f.coordinator.request();
    expect(f.sync).toHaveBeenCalledTimes(1);
    f.db.prepare("UPDATE sessions SET status='active' WHERE id='codex'").run();
    await f.coordinator.request();
    expect(f.sync).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: 'codex', archived: false }));
    expect(f.db.prepare('SELECT working_dir,extra_dirs,writable_dirs FROM sessions WHERE id=?').get('codex'))
      .toEqual({ working_dir: '/project', extra_dirs: '["/reference"]', writable_dirs: '["/output"]' });
  });

  it('retries busy and failed records without repeating successful work', async () => {
    const f = fixture();
    f.insert('a'); f.insert('b');
    f.prepare.mockResolvedValueOnce(false);
    f.sync.mockRejectedValueOnce(new Error('offline'));
    await f.coordinator.request();
    expect(f.warn).toHaveBeenCalledWith(1);
    await f.coordinator.request();
    expect(f.sync).toHaveBeenCalledTimes(3);
    await f.coordinator.request();
    expect(f.sync).toHaveBeenCalledTimes(3);
  });

  it('protects active references sharing a thread, and keeps SSH identities separate', async () => {
    const f = fixture();
    f.insert('a', 'codex', 'archived', 'thread');
    f.insert('b', 'codex', 'active', 'thread');
    f.insert('c', 'codex', 'archived', 'thread', 'remote');
    f.insert('d', 'codex', 'deleted');
    f.canUseRemote.mockReturnValue(false);
    await f.coordinator.request();
    expect(f.sync).toHaveBeenCalledTimes(1);
    expect(f.sync).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'thread', archived: false }));
    f.canUseRemote.mockReturnValue(true);
    await f.coordinator.request();
    expect(f.sync).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: 'thread', archived: true, remoteHostId: 'remote' }));
  });

  it('stops a backfill when the owner changes', async () => {
    const f = fixture(); f.insert('a'); f.insert('b');
    f.sync.mockImplementationOnce(async () => { f.assertCurrent.mockImplementation(() => { throw new Error('changed'); }); });
    await f.coordinator.request();
    expect(f.sync).toHaveBeenCalledTimes(1);
  });

  it.each(['cc', 'codex'] as const)('overlays %s archive and project scope onto CLI scan results', async kind => {
    const f = fixture(); f.insert('task', kind, 'archived', 'native');
    const candidate = { id: 'native', cwd: '/old-project', archived: false };
    expect(await projectNativeSessionMetadata(kind, [candidate])).toEqual([
      { ...candidate, archived: true, cwd: '/project', workspaceKind: 'project', extraDirs: ['/reference'], writableDirs: ['/output'] },
    ]);
    f.db.prepare("UPDATE sessions SET status='active'").run();
    expect(await projectNativeSessionMetadata(kind, [{ ...candidate, archived: true }])).toEqual([
      expect.objectContaining({ archived: false }),
    ]);
    f.db.prepare("UPDATE sessions SET status='deleted'").run();
    expect(await projectNativeSessionMetadata(kind, [candidate])).toEqual([candidate]);
  });

  it('does not overlay another harness or SSH task with an identical native ID', async () => {
    const f = fixture(); f.insert('cc', 'cc', 'archived', 'same'); f.insert('remote', 'codex', 'archived', 'same', 'ssh');
    const candidate = { id: 'same', cwd: '/cli', archived: false };
    expect(await projectNativeSessionMetadata('codex', [candidate])).toEqual([candidate]);
  });
});
