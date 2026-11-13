import Database from 'better-sqlite3';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Maker } from '@cindy/maker-core';

const h = vi.hoisted(() => ({
  broadcastRemoteResourceChanged: vi.fn(),
  db: null as ReturnType<typeof drizzle> | null,
  tx: null as null | ((name: string, args: unknown) => Promise<unknown>),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/cindy-bot-lifecycle-test' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({ drizzle: h.db, tx: h.tx }),
}));

// The coordinator's deletion port is injected below; avoid loading the unrelated IPC graph.
vi.mock('../../localDb/ipc/sessions.js', () => ({
  deleteBotProfileAndDetachSessionsInDb: vi.fn(),
}));

vi.mock('../botRemoteResourceInvalidation.js', () => ({
  broadcastBotRemoteResourceChanged: h.broadcastRemoteResourceChanged,
}));

vi.mock('../botProfileFolder.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../botProfileFolder.js')>(),
  removeBotProfileFolder: vi.fn(),
}));

import { createBotLifecycleService } from '../botLifecycleService.js';
import * as botProjectMemory from '../botProjectMemory.js';
import { teammateWorkspaceDir } from '../botProjectMemory.js';
import * as appSessionState from '../../appSessionState.js';
import { ownerScopedUserDataPath } from '../../appSessionState.js';
import { normalizeRecentWorkdirPath } from '../../localDb/ipc/recentWorkdirsCore.js';
import { tx as runWorkerTx } from '../../localDb/worker/opHandlers/tx.js';

function createDatabase(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      working_dir TEXT,
      project_dir TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      content TEXT NOT NULL
    );
    CREATE TABLE mcp_app_view_states (
      message_id TEXT PRIMARY KEY NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      server_id TEXT NOT NULL, server_revision TEXT NOT NULL, plugin_instance TEXT,
      state_json TEXT NOT NULL, byte_length INTEGER NOT NULL
    );
    -- Same columns as the real table: the Windows removal reads last_used_at.
    CREATE TABLE recent_workdirs (path TEXT PRIMARY KEY, last_used_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE bot_profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      avatar TEXT NOT NULL DEFAULT '🤖',
      avatar_color TEXT NOT NULL DEFAULT 'violet',
      status TEXT NOT NULL DEFAULT 'active',
      hidden_at INTEGER,
      pinned_at INTEGER,
      attention_reason TEXT,
      attention_at INTEGER,
      current_version INTEGER NOT NULL DEFAULT 1,
      canonical_session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE bot_session_links (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      profile_version INTEGER NOT NULL DEFAULT 1,
      role TEXT NOT NULL,
      route_key TEXT,
      created_at INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE TABLE bot_lifecycle_events (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      session_id TEXT,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE bot_delegations (id TEXT PRIMARY KEY, requesting_bot_id TEXT, target_bot_id TEXT);
    CREATE TABLE bot_direct_message_threads (id TEXT PRIMARY KEY, bot_a_id TEXT, bot_b_id TEXT);
    CREATE TABLE bot_direct_messages (id TEXT PRIMARY KEY, sender_bot_id TEXT, recipient_bot_id TEXT);
    INSERT INTO bot_profiles (
      id, display_name, description, avatar, avatar_color, status,
      current_version, canonical_session_id, created_at, updated_at
    ) VALUES (
      'bot-1', 'Helper', '', '🤖', 'violet', 'active', 1, 'canonical', 1, 1
    );
    INSERT INTO bot_session_links VALUES
      ('link-canonical', 'bot-1', 'canonical', 1, 'canonical', NULL, 1, NULL),
      ('link-delegation', 'bot-1', 'delegation-session', 1, 'delegation', 'delegation:d-1', 1, NULL);
    INSERT INTO sessions (id, source, status, updated_at) VALUES
      ('canonical', 'bot', 'active', 1),
      ('delegation-session', 'bot', 'active', 1);
  `);
  return sqlite;
}

function row(sqlite: Database.Database, table: string, id: string) {
  return sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown>;
}

describe('Bot lifecycle coordinator', () => {
  let sqlite: Database.Database;
  let closeSession: ReturnType<typeof vi.fn>;
  let deleteProfileAndDetachSessions: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    h.broadcastRemoteResourceChanged.mockReset();
    sqlite = createDatabase();
    const db = drizzle(sqlite);
    h.db = db;
    h.tx = async (name, args) => runWorkerTx(sqlite, { name: name as never, args } as never);
    closeSession = vi.fn(async () => undefined);
    deleteProfileAndDetachSessions = vi.fn(async (
      botId: string,
      sessionIds: string[],
      keepTaskHistory: boolean,
    ) => {
      const status = keepTaskHistory ? 'archived' : 'deleted';
      for (const sessionId of sessionIds) {
        sqlite.prepare('UPDATE sessions SET source = ?, status = ? WHERE id = ?')
          .run('desktop', status, sessionId);
      }
      sqlite.prepare('DELETE FROM bot_profiles WHERE id = ?').run(botId);
    });
  });

  afterEach(() => {
    sqlite.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function service(hooks: Partial<import('../botLifecycleService.js').BotLifecycleServiceDeps> = {}) {
    return createBotLifecycleService({
      maker: { closeSession } as unknown as Maker,
      deleteProfileAndDetachSessions,
      now: () => 10,
      ...hooks,
    });
  }

  it('restarts only the canonical runtime and preserves ownership, history and delegated work', async () => {
    const restartRuntime = vi.fn(async (_id: string, assertCurrent: () => void) => assertCurrent());
    const lifecycle = service({ restartRuntime });
    const beforeLinks = sqlite.prepare('SELECT * FROM bot_session_links').all();
    const result = await lifecycle.run({ botId: 'bot-1', action: 'restart' });
    expect(restartRuntime).toHaveBeenCalledWith('canonical', expect.any(Function));
    expect(result).toMatchObject({ action: 'restart', status: 'active', affected: { sessions: 1 } });
    expect(sqlite.prepare('SELECT * FROM bot_session_links').all()).toEqual(beforeLinks);
    expect(row(sqlite, 'sessions', 'canonical').status).toBe('active');
    expect(row(sqlite, 'bot_profiles', 'bot-1').canonical_session_id).toBe('canonical');
    expect(closeSession).not.toHaveBeenCalled();
    expect(deleteProfileAndDetachSessions).not.toHaveBeenCalled();
  });

  it('coalesces duplicate restart clicks and permits retry after a failed close', async () => {
    let reject!: (error: Error) => void;
    const restartRuntime = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    const lifecycle = service({ restartRuntime });
    const first = lifecycle.run({ botId: 'bot-1', action: 'restart' });
    const second = lifecycle.run({ botId: 'bot-1', action: 'restart' });
    expect(second).toBe(first);
    const failed = expect(first).rejects.toThrow('Bot restart failed');
    await vi.waitFor(() => expect(restartRuntime).toHaveBeenCalledOnce());
    reject(new Error('close failed'));
    await failed;
    expect(row(sqlite, 'bot_profiles', 'bot-1').status).toBe('active');
    restartRuntime.mockImplementation(async () => undefined);
    await lifecycle.run({ botId: 'bot-1', action: 'restart' });
    expect(restartRuntime).toHaveBeenCalledTimes(2);
  });

  it.each(['paused', 'archived', 'deleting'])('does not restart a %s teammate', async (status) => {
    sqlite.prepare('UPDATE bot_profiles SET status = ? WHERE id = ?').run(status, 'bot-1');
    const restartRuntime = vi.fn();
    await expect(service({ restartRuntime }).run({ botId: 'bot-1', action: 'restart' }))
      .rejects.toThrow('Bot must be active');
    expect(restartRuntime).not.toHaveBeenCalled();
  });

  it('awaits pause/resume hooks and keeps permanent deletion retryable until cleanup succeeds', async () => {
    const onPaused = vi.fn(async () => {
      expect(row(sqlite, 'bot_profiles', 'bot-1').status).toBe('paused');
    });
    const onResumed = vi.fn(async () => {
      expect(row(sqlite, 'bot_profiles', 'bot-1').status).toBe('active');
    });
    const onBeforeDelete = vi.fn<() => Promise<void>>(async () => {
      expect(row(sqlite, 'bot_profiles', 'bot-1')).toBeDefined();
      throw new Error('cleanup failed');
    });
    const lifecycle = service({ onPaused, onResumed, onBeforeDelete });
    await lifecycle.run({ botId: 'bot-1', action: 'pause' });
    await lifecycle.run({ botId: 'bot-1', action: 'resume' });
    expect(onPaused).toHaveBeenCalledOnce();
    expect(onResumed).toHaveBeenCalledOnce();
    const request = { botId: 'bot-1', action: 'delete' as const, confirmName: 'Helper' };
    await expect(lifecycle.run(request)).rejects.toThrow('cleanup failed');
    expect(deleteProfileAndDetachSessions).not.toHaveBeenCalled();
    expect(row(sqlite, 'bot_profiles', 'bot-1').status).toBe('archived');
    onBeforeDelete.mockResolvedValue(undefined);
    await lifecycle.run(request);
    expect(deleteProfileAndDetachSessions).toHaveBeenCalledOnce();
    expect(onBeforeDelete.mock.invocationCallOrder.at(-1)).toBeLessThan(deleteProfileAndDetachSessions.mock.invocationCallOrder[0]);
  });

  it('pauses the Bot and closes its linked sessions', async () => {
    const result = await service().run({ botId: 'bot-1', action: 'pause' });

    expect(row(sqlite, 'bot_profiles', 'bot-1').status).toBe('paused');
    expect(
      sqlite.prepare(
        "SELECT session_id FROM bot_lifecycle_events WHERE event_type = 'pause-requested'",
      ).get(),
    ).toEqual({ session_id: 'canonical' });
    expect(closeSession).toHaveBeenCalledTimes(2);
    expect(closeSession).toHaveBeenCalledWith('canonical');
    expect(closeSession).toHaveBeenCalledWith('delegation-session');
    expect(result).toMatchObject({ status: 'paused', affected: { sessions: 2, delegations: 0 } });
    expect(h.broadcastRemoteResourceChanged).toHaveBeenCalledWith('bot-1');
  });

  it('reports committed deletion truthfully when post-commit secret cleanup needs retry', async () => {
    const onDeleted = vi.fn(async () => { throw new Error('fixture vault unavailable'); });
    const result = await service({ onDeleted }).run({ botId: 'bot-1', action: 'delete', confirmName: 'Helper' });
    expect(row(sqlite, 'bot_profiles', 'bot-1')).toBeUndefined();
    expect(result).toMatchObject({ status: 'deleted', warnings: ['IMPORTED_ENVIRONMENT_CLEANUP_PENDING'] });
  });

  it('uses the canonical registry even when the compatibility mirror disagrees', async () => {
    sqlite.prepare(
      "UPDATE bot_profiles SET canonical_session_id = 'stale-mirror' WHERE id = 'bot-1'",
    ).run();

    await service().run({ botId: 'bot-1', action: 'pause' });

    expect(
      sqlite.prepare(
        "SELECT session_id FROM bot_lifecycle_events WHERE event_type = 'pause-requested'",
      ).get(),
    ).toEqual({ session_id: 'canonical' });
    expect(closeSession).toHaveBeenCalledWith('canonical');
    expect(closeSession).not.toHaveBeenCalledWith('stale-mirror');
  });

  it('does not reclaim a mirror-only Session when the canonical registry is missing', async () => {
    sqlite.prepare(
      "DELETE FROM bot_session_links WHERE bot_id = 'bot-1' AND role = 'canonical'",
    ).run();

    await service().run({ botId: 'bot-1', action: 'pause' });

    expect(
      sqlite.prepare(
        "SELECT session_id FROM bot_lifecycle_events WHERE event_type = 'pause-requested'",
      ).get(),
    ).toEqual({ session_id: null });
    expect(closeSession).not.toHaveBeenCalledWith('canonical');
  });

  it('resumes a paused Bot back to active', async () => {
    const lifecycle = service();
    await lifecycle.run({ botId: 'bot-1', action: 'pause' });
    const result = await lifecycle.run({ botId: 'bot-1', action: 'resume' });

    expect(row(sqlite, 'bot_profiles', 'bot-1').status).toBe('active');
    expect(
      sqlite.prepare(
        "SELECT session_id FROM bot_lifecycle_events WHERE event_type = 'resumed'",
      ).get(),
    ).toEqual({ session_id: 'canonical' });
    expect(result.status).toBe('active');
    expect(h.broadcastRemoteResourceChanged).toHaveBeenLastCalledWith('bot-1');
  });

  it('refuses to resume or pause an archived Bot', async () => {
    sqlite.prepare("UPDATE bot_profiles SET status = 'archived' WHERE id = 'bot-1'").run();
    const lifecycle = service();

    await expect(lifecycle.run({ botId: 'bot-1', action: 'resume' })).rejects.toThrow('当前状态');
    await expect(lifecycle.run({ botId: 'bot-1', action: 'pause' })).rejects.toThrow('当前状态');
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('fails closed before touching sessions when the pause transaction loses a concurrent race', async () => {
    const realTx = h.tx!;
    h.tx = vi.fn(async (name, args) => {
      if (name === 'bots.pauseLifecycle') {
        throw Object.assign(new Error('Bot 生命周期已被另一处操作更新'), { code: 'PRECONDITION_FAILED' });
      }
      return realTx(name, args);
    });
    const lifecycle = service();

    await expect(lifecycle.run({ botId: 'bot-1', action: 'pause' })).rejects.toThrow('已被另一处操作更新');
    expect(row(sqlite, 'bot_profiles', 'bot-1').status).toBe('active');
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('coalesces simultaneous lifecycle actions for one Bot', async () => {
    let release!: () => void;
    closeSession.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const lifecycle = service();
    const first = lifecycle.run({ botId: 'bot-1', action: 'pause' });
    const second = lifecycle.run({ botId: 'bot-1', action: 'pause' });
    await vi.waitFor(() => expect(closeSession).toHaveBeenCalled());
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
  });

  it('queues a different lifecycle action instead of losing it behind pause', async () => {
    let release!: () => void;
    closeSession.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const lifecycle = service();
    const pausing = lifecycle.run({ botId: 'bot-1', action: 'pause' });
    const resuming = lifecycle.run({ botId: 'bot-1', action: 'resume' });
    await vi.waitFor(() => expect(closeSession).toHaveBeenCalled());
    expect(row(sqlite, 'bot_profiles', 'bot-1').status).toBe('paused');
    release();
    await pausing;
    await resuming;
    expect(row(sqlite, 'bot_profiles', 'bot-1').status).toBe('active');
  });

  it('requires an exact Bot name before permanent deletion', async () => {
    await expect(service().run({
      botId: 'bot-1',
      action: 'delete',
      confirmName: 'helper',
    })).rejects.toThrow('完整 Bot 名称');
    expect(row(sqlite, 'bot_profiles', 'bot-1').status).toBe('active');
    expect(deleteProfileAndDetachSessions).not.toHaveBeenCalled();
  });

  it.each([
    "INSERT INTO bot_delegations VALUES ('shared', 'other-bot', 'bot-1')",
    "INSERT INTO bot_delegations VALUES ('shared', 'bot-1', 'other-bot')",
    "INSERT INTO bot_direct_message_threads VALUES ('shared', 'bot-1', 'other-bot')",
    "INSERT INTO bot_direct_messages VALUES ('shared', 'other-bot', 'bot-1')",
  ])('deletes the Bot without clearing existing shared-history rows: %s', async (insert) => {
    sqlite.exec(insert);
    const sharedRows = sqlite.prepare('SELECT * FROM bot_delegations').all().length
      + sqlite.prepare('SELECT * FROM bot_direct_message_threads').all().length
      + sqlite.prepare('SELECT * FROM bot_direct_messages').all().length;
    await expect(service().run({
      botId: 'bot-1', action: 'delete', confirmName: 'Helper', keepTaskHistory: true,
    })).resolves.toMatchObject({ status: 'deleted' });
    expect(sqlite.prepare("SELECT id FROM bot_profiles WHERE id = 'bot-1'").get()).toBeUndefined();
    expect(sqlite.prepare('SELECT * FROM bot_delegations').all().length
      + sqlite.prepare('SELECT * FROM bot_direct_message_threads').all().length
      + sqlite.prepare('SELECT * FROM bot_direct_messages').all().length).toBe(sharedRows);
    expect(deleteProfileAndDetachSessions).toHaveBeenCalled();
  });

  it('pauses, archives and detaches sessions when permanently deleting a Bot', async () => {
    const result = await service().run({
      botId: 'bot-1',
      action: 'delete',
      confirmName: 'Helper',
      keepTaskHistory: true,
    });

    expect(sqlite.prepare("SELECT id FROM bot_profiles WHERE id = 'bot-1'").get()).toBeUndefined();
    expect(row(sqlite, 'bot_session_links', 'link-canonical').role).toBe('history');
    expect(row(sqlite, 'bot_session_links', 'link-delegation').role).toBe('history');
    expect(deleteProfileAndDetachSessions).toHaveBeenCalledWith(
      'bot-1',
      expect.arrayContaining(['canonical', 'delegation-session']),
      true,
      [],
    );
    expect(row(sqlite, 'sessions', 'canonical')).toMatchObject({
      source: 'desktop',
      status: 'archived',
    });
    expect(result).toMatchObject({ action: 'delete', status: 'deleted', affected: { sessions: 2 } });
  });

  it('keeps transcripts as ordinary deleted tasks when discarding history', async () => {
    const result = await service().run({
      botId: 'bot-1',
      action: 'delete',
      confirmName: 'Helper',
      keepTaskHistory: false,
    });

    expect(deleteProfileAndDetachSessions).toHaveBeenCalledWith(
      'bot-1',
      expect.arrayContaining(['canonical', 'delegation-session']),
      false,
      [],
    );
    expect(result).toMatchObject({ action: 'delete', status: 'deleted' });
  });

  // Tier: behavior. Deleting a teammate left its project in the project list and the tasks in it
  // (automation runs, tasks it opened there) in the task list (2026-11-10).
  it('takes the teammate project and the tasks in it along when deleting', async () => {
    // PR #10188 CI: the mocked callback hid a missing table in this in-memory
    // fixture. Exercise the real transaction before checking persisted statuses.
    deleteProfileAndDetachSessions.mockImplementation(async (botId, sessionIds, keepTaskHistory, projectSessionIds) => {
      await runWorkerTx(sqlite, { name: 'bots.deleteProfile', args: {
        botId, sessionIds, keepTaskHistory, projectSessionIds, at: 10,
      } });
    });
    const project = teammateWorkspaceDir(ownerScopedUserDataPath(), 'bot-1');
    sqlite.prepare('INSERT INTO sessions (id, source, status, updated_at, working_dir, project_dir) VALUES (?, ?, ?, 1, ?, ?)')
      .run('automation-run', 'scheduler', 'active', project, null);
    sqlite.prepare('INSERT INTO sessions (id, source, status, updated_at, working_dir, project_dir) VALUES (?, ?, ?, 1, ?, ?)')
      .run('opened-task', 'desktop', 'active', `${project}/notes`, project);
    sqlite.prepare('INSERT INTO sessions (id, source, status, updated_at, working_dir, project_dir) VALUES (?, ?, ?, 1, ?, ?)')
      .run('neighbour', 'desktop', 'active', `${project}-other`, `${project}-other`);
    // Stored the way the project list stores them (forward slashes on Windows too).
    const listed = [project, `${project}-other`].map(dir => normalizeRecentWorkdirPath(dir)!);
    sqlite.prepare('INSERT INTO recent_workdirs (path) VALUES (?), (?)').run(...listed);

    const result = await service().run({ botId: 'bot-1', action: 'delete', confirmName: 'Helper', keepTaskHistory: false });

    expect(deleteProfileAndDetachSessions).toHaveBeenCalledWith('bot-1', expect.arrayContaining(['canonical']), false,
      ['automation-run', 'opened-task']);
    expect(closeSession).toHaveBeenCalledWith('automation-run');
    expect(closeSession).not.toHaveBeenCalledWith('neighbour');
    expect(row(sqlite, 'sessions', 'automation-run').status).toBe('deleted');
    expect(row(sqlite, 'sessions', 'opened-task').status).toBe('deleted');
    expect(row(sqlite, 'sessions', 'neighbour').status).toBe('active');
    expect(sqlite.prepare('SELECT path FROM recent_workdirs').pluck().all()).toEqual([listed[1]]);
    expect(result).toMatchObject({ status: 'deleted', affected: { sessions: 4 } });
  });

  // #10098: run the coordinator's SQL selection and the real deletion transaction together.
  // Existing coverage stored native paths and only inspected a mocked deletion callback.
  // Minimum regression: a native Windows root with one slash-normalized project_dir.
  // Tier: unit (in-memory SQLite; file cleanup is stubbed, no user data or real filesystem writes).
  describe.each([
    { name: 'Windows drive', platform: 'win32', owner: String.raw`C:\Users\Fixture_é%！!\owners\owner` },
    { name: 'Windows UNC', platform: 'win32', owner: String.raw`\\server\share\Fixture\owners\owner` },
    { name: 'Windows long drive', platform: 'win32', owner: String.raw`\\?\C:\Users\Fixture\owners\owner` },
    { name: 'Windows long UNC', platform: 'win32', owner: String.raw`\\?\UNC\server\share\Fixture\owners\owner` },
    { name: 'POSIX case and literal backslash', platform: 'linux', owner: String.raw`/Owners/Fixture_%!\literal/owner` },
  ])('$name project deletion', ({ platform, owner }) => {
    it.each([true, false])('keeps only matching tasks in the deletion transaction (history=%s)', async (keepTaskHistory) => {
      const pathApi = platform === 'win32' ? path.win32 : path.posix;
      const project = pathApi.join(owner, 'bots', 'bot-1', 'workspace');
      // Exercise a target platform explicitly: never combine a platform stub with host path.join.
      vi.stubGlobal('process', { ...process, platform });
      vi.spyOn(appSessionState, 'ownerScopedUserDataPath').mockReturnValue(owner);
      vi.spyOn(botProjectMemory, 'teammateWorkspaceDir').mockReturnValue(project);
      // This is the DB storage spelling, deliberately independent of the production normalizer.
      const stored = platform === 'win32'
        ? project.replace(/^\\\\\?\\UNC\\/, '//').replace(/^\\\\\?\\/, '').replace(/\\/g, '/')
        : project;
      const insert = sqlite.prepare('INSERT INTO sessions (id, source, status, updated_at, working_dir, project_dir) VALUES (?, ?, ?, 1, ?, ?)');
      insert.run('project-only', 'desktop', 'active', '/unrelated/worktree', stored);
      insert.run('working-only', 'scheduler', 'active', stored, null);
      insert.run('nested', 'desktop', 'active', `${stored}/notes/subdir`, null);
      insert.run('case-variant', 'desktop', 'active', null, stored.toUpperCase());
      insert.run('nested-case', 'desktop', 'active', `${stored.toUpperCase()}/notes`, null);
      insert.run('native', 'desktop', 'active', pathApi.join(project, 'native'), null);
      insert.run('neighbour', 'desktop', 'active', `${stored}-other/notes`, `${stored}-other`);
      insert.run('other-owner', 'desktop', 'active', stored.replace('Fixture', 'Other'), null);
      insert.run('other-project', 'desktop', 'active', '/unrelated/worktree', '/unrelated');
      insert.run('deleted', 'desktop', 'deleted', stored, stored);
      if (platform !== 'win32') {
        insert.run('backslash-is-not-separator', 'desktop', 'active', `${stored}\\notes`, null);
        insert.run('different-literal', 'desktop', 'active', stored.replace('\\literal', '/literal'), null);
      }
      // The real deletion transaction also clears saved MCP app state only for
      // deleted tasks. Keep real rows so this checks cleanup, not just table presence.
      for (const sessionId of ['canonical', 'project-only', 'neighbour']) {
        sqlite.prepare('INSERT INTO messages (id, session_id, content) VALUES (?, ?, ?)')
          .run(`message-${sessionId}`, sessionId, '{}');
        sqlite.prepare('INSERT INTO mcp_app_view_states VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(`message-${sessionId}`, sessionId, 'fixture-server', 'revision', null, '{}', 2);
      }
      const deletion = vi.fn(async (botId: string, sessionIds: string[], keep: boolean, projectSessionIds?: string[]) => {
        await runWorkerTx(sqlite, { name: 'bots.deleteProfile', args: {
          botId, sessionIds, keepTaskHistory: keep, projectSessionIds, at: 10,
        } });
      });

      const result = await service({ deleteProfileAndDetachSessions: deletion }).run({
        botId: 'bot-1', action: 'delete', confirmName: 'Helper', keepTaskHistory,
      });

      const matched = ['project-only', 'working-only', 'nested', 'native'];
      const untouched = ['neighbour', 'other-owner', 'other-project'];
      (platform === 'win32' ? matched : untouched).push('case-variant', 'nested-case');
      if (platform !== 'win32') untouched.push('backslash-is-not-separator', 'different-literal');
      const expectedStatus = keepTaskHistory ? 'archived' : 'deleted';
      for (const id of matched) {
        expect(row(sqlite, 'sessions', id), id).toMatchObject({ status: expectedStatus, updated_at: 10 });
        expect(closeSession).toHaveBeenCalledWith(id);
      }
      for (const id of untouched) {
        expect(row(sqlite, 'sessions', id), id).toMatchObject({ status: 'active', updated_at: 1 });
        expect(closeSession).not.toHaveBeenCalledWith(id);
      }
      expect(row(sqlite, 'sessions', 'deleted')).toMatchObject({ status: 'deleted', updated_at: 1 });
      expect(closeSession).not.toHaveBeenCalledWith('deleted');
      expect(deletion.mock.calls[0][3]?.sort()).toEqual(matched.sort());
      expect(row(sqlite, 'sessions', 'canonical').status).toBe(expectedStatus);
      expect(row(sqlite, 'bot_profiles', 'bot-1')).toBeUndefined();
      expect(result).toMatchObject({ status: 'deleted', affected: { sessions: matched.length + 2 } });
      expect(sqlite.prepare('SELECT session_id FROM mcp_app_view_states ORDER BY session_id').pluck().all())
        .toEqual(keepTaskHistory ? ['canonical', 'neighbour', 'project-only'] : ['neighbour']);
      expect(sqlite.prepare('SELECT COUNT(*) FROM messages').pluck().get()).toBe(3);
    });
  });
});
