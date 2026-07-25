import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const electronMock = vi.hoisted(() => ({ userData: '' }));
const dbMock = vi.hoisted(() => ({ current: null as Database.Database | null }));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => electronMock.userData),
  },
}));

vi.mock('../localDb/index.js', () => ({
  getRawDb: vi.fn(() => {
    if (!dbMock.current) throw new Error('test db not ready');
    return dbMock.current;
  }),
}));

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

import {
  importExternalCodexSessions,
  importExternalCodexMessagesForSession,
  parseCodexRolloutMessageLine,
  scanExternalCodexSessions,
  prepareExternalCodexSessionForResume,
} from '../maker-host/codex-local-sessions';
import { clearCurrentDbClient, setCurrentDbClient } from '../localDb/client/current';
import type { DbClient } from '../localDb/client/DbClient';
import * as schema from '../localDb/schema';
import { tx as runInprocTx } from '../localDb/worker/opHandlers/tx';

const threadId = '019dcd5a-6e54-7960-95e0-aa68117a28d1';
const execThreadId = '019dcd5a-6e54-7960-95e0-aa68117a28d2';
const pngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l3ykWQAAAABJRU5ErkJggg==';

let rootDir = '';
let externalHome = '';
let targetUserData = '';
let homedirSpy: { mockRestore: () => void } | null = null;
let originalCodexHome: string | undefined;

function createLocalDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Maker',
      working_dir TEXT,
      workspace_kind TEXT NOT NULL DEFAULT 'project',
      model TEXT NOT NULL DEFAULT 'gpt-5.4-mini',
      effort TEXT NOT NULL DEFAULT 'high',
      permission_mode TEXT NOT NULL DEFAULT 'ask',
      status TEXT NOT NULL DEFAULT 'active',
      sdk_session_id TEXT,
      total_token_usage INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      total_cost_amount REAL NOT NULL DEFAULT 0,
      total_cost_currency TEXT,
      total_cost_is_approximate INTEGER NOT NULL DEFAULT 0,
      context_tokens INTEGER NOT NULL DEFAULT 0,
      context_window INTEGER NOT NULL DEFAULT 0,
      fast_mode INTEGER NOT NULL DEFAULT 0,
      cleared_at INTEGER,
      pinned_at INTEGER,
      user_send_at INTEGER,
      agent_kind TEXT NOT NULL DEFAULT 'cc',
      parent_session_id TEXT,
      forked_at_message_id TEXT,
      worktree_path TEXT,
      source TEXT NOT NULL DEFAULT 'desktop',
      feishu_open_id TEXT,
      feishu_bot_app_id TEXT,
      used_project_context INTEGER NOT NULL DEFAULT 0,
      extra_dirs TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_use_id TEXT,
      agent_meta TEXT,
      created_at INTEGER NOT NULL,
      rewind_at INTEGER
    );
    CREATE UNIQUE INDEX uniq_messages_session_client ON messages(session_id, client_id);
  `);
  return db;
}

function makeTestDbClient(db: Database.Database): DbClient {
  return {
    query: async <T = unknown>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...params) as T[],
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).get(...params) as T | undefined,
    exec: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params),
    tx: async (name: string, args: unknown) => runInprocTx(db, { name, args }) as never,
    drizzle: drizzle(db, { schema }),
    vecAvailable: true,
    dispose: async () => undefined,
  };
}

function currentTestDb(): Database.Database {
  if (!dbMock.current) throw new Error('test db is not initialized');
  return dbMock.current;
}

function insertImportedCodexSession(
  db: Database.Database,
  sessionId: string,
  sdkSessionId: string,
): void {
  db.prepare(
    `
    INSERT INTO sessions (
      id, title, working_dir, model, effort, permission_mode, status,
      sdk_session_id, total_token_usage, total_cost_usd, context_tokens,
      context_window, fast_mode, cleared_at, pinned_at, user_send_at,
      agent_kind, parent_session_id, forked_at_message_id, worktree_path,
      source, feishu_open_id, feishu_bot_app_id, used_project_context,
      extra_dirs, created_at, updated_at
    )
    VALUES (
      ?, 'Imported', '/tmp/project', 'gpt-5.5', 'high', 'ask', 'active',
      ?, 0, 0, 0, 0, 0, NULL, NULL, 1,
      'codex', NULL, NULL, NULL, 'desktop', NULL, NULL, 0, '[]', 1, 1
    )
  `,
  ).run(sessionId, sdkSessionId);
}

function createStateDb(home: string, withThreads = true): string {
  fs.mkdirSync(home, { recursive: true });
  const dbPath = path.join(home, 'state_1.sqlite');
  const db = new Database(dbPath);
  if (withThreads) {
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        approval_mode TEXT NOT NULL,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        model TEXT,
        reasoning_effort TEXT,
        thread_source TEXT
      );
    `);
  }
  db.close();
  return dbPath;
}

function insertThread(
  dbPath: string,
  id: string,
  rolloutPath: string,
  opts: {
    updatedAt: number;
    threadSource?: string;
    source?: string;
    title?: string;
    archived?: boolean;
    archivedAt?: number | null;
    cwd?: string;
  },
): void {
  const db = new Database(dbPath);
  db.prepare(
    `
    INSERT INTO threads (
      id, rollout_path, created_at, updated_at, source, cwd, title,
      approval_mode, tokens_used, archived, archived_at, model,
      reasoning_effort, thread_source
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'on-request', 0, ?, ?, 'gpt-5.5', 'high', ?)
  `,
  ).run(
    id,
    rolloutPath,
    opts.updatedAt - 10,
    opts.updatedAt,
    opts.source ?? 'cli',
    opts.cwd ?? '/tmp/project',
    opts.title ?? 'Codex Session',
    opts.archived ? 1 : 0,
    opts.archivedAt ?? null,
    opts.threadSource ?? null,
  );
  db.close();
}

function rolloutLine(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  timestamp: string,
): string {
  return JSON.stringify({
    timestamp,
    type: 'response_item',
    payload: {
      id: `${id}-${role}`,
      type: 'message',
      role,
      content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
    },
  });
}

function rolloutLineWithImage(id: string, text: string, timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: 'response_item',
    payload: {
      id: `${id}-user`,
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text },
        { type: 'input_image', image_url: `data:image/png;base64,${pngBase64}` },
      ],
    },
  });
}

beforeEach(() => {
  originalCodexHome = process.env.CODEX_HOME;
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-local-sessions-'));
  externalHome = path.join(rootDir, 'external-codex-home');
  targetUserData = path.join(rootDir, 'xdt-user-data');
  const fakeHome = path.join(rootDir, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  fs.mkdirSync(targetUserData, { recursive: true });
  electronMock.userData = targetUserData;
  process.env.CODEX_HOME = externalHome;
  dbMock.current = createLocalDb();
  setCurrentDbClient(makeTestDbClient(dbMock.current), 'test-user');
});

afterEach(() => {
  homedirSpy?.mockRestore();
  homedirSpy = null;
  dbMock.current?.close();
  dbMock.current = null;
  clearCurrentDbClient();
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = originalCodexHome;
  }
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('Codex local session import', () => {
  it('defensively removes complete IDE context from Codex user messages', () => {
    const ideContext = '<ide_opened_file>The user opened /tmp/a.ts in the IDE.</ide_opened_file>';
    const cleaned = parseCodexRolloutMessageLine(
      rolloutLine('m1', 'user', `${ideContext}\nPlease fix the parser`, '2026-05-13T00:00:01.000Z'),
      1,
    );
    const ideOnly = parseCodexRolloutMessageLine(
      rolloutLine('m2', 'user', ideContext, '2026-05-13T00:00:02.000Z'),
      2,
    );
    const malformed = parseCodexRolloutMessageLine(
      rolloutLine(
        'm3',
        'user',
        'Keep <ide_opened_file>unfinished context',
        '2026-05-13T00:00:03.000Z',
      ),
      3,
    );

    expect(cleaned).toMatchObject({
      role: 'user',
      text: 'Please fix the parser',
      content: 'Please fix the parser',
    });
    expect(ideOnly).toBeNull();
    expect(malformed).toMatchObject({ text: 'Keep <ide_opened_file>unfinished context' });
  });

  it('applies the import cap after filtering subagent threads', async () => {
    const dbPath = createStateDb(externalHome);
    const rolloutPath = path.join(externalHome, 'sessions', `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, '');

    for (let i = 0; i < 1000; i += 1) {
      insertThread(dbPath, `019dcd5a-6e54-7960-95e0-${String(i).padStart(12, '0')}`, rolloutPath, {
        updatedAt: 10_000 + i,
        threadSource: 'subagent',
      });
    }
    insertThread(dbPath, threadId, rolloutPath, {
      updatedAt: 1_000,
      title: 'Top Level Codex Session',
    });

    const scan = await scanExternalCodexSessions();

    expect(scan.candidates.map((item) => item.id)).toEqual([threadId]);
    const result = await importExternalCodexSessions([threadId]);
    expect(result).toMatchObject({ scanned: 1, inserted: 1, updated: 0 });
    const rows = currentTestDb().prepare('SELECT id, title FROM sessions').all() as Array<{
      id: string;
      title: string;
    }>;
    expect(rows).toEqual([{ id: `codex-${threadId}`, title: 'Top Level Codex Session' }]);
  }, 15_000);

  it('filters Codex source JSON subagent rows even when thread_source is missing', async () => {
    const dbPath = createStateDb(externalHome);
    const rolloutPath = path.join(externalHome, 'sessions', `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, '');
    insertThread(dbPath, threadId, rolloutPath, {
      updatedAt: 1_000,
      source: JSON.stringify({ subagent: 'review' }),
      title: 'Review current code changes',
    });

    const scan = await scanExternalCodexSessions();

    expect(scan.candidates).toEqual([]);
    const count = currentTestDb().prepare('SELECT COUNT(*) AS count FROM sessions').get() as {
      count: number;
    };
    expect(count.count).toBe(0);
  });

  it('scans without writing and imports only explicitly selected Codex sessions', async () => {
    const dbPath = createStateDb(externalHome);
    const firstRolloutPath = path.join(
      externalHome,
      'sessions',
      `rollout-2026-05-13-${threadId}.jsonl`,
    );
    const secondRolloutPath = path.join(
      externalHome,
      'sessions',
      `rollout-2026-05-13-${execThreadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(firstRolloutPath), { recursive: true });
    fs.writeFileSync(firstRolloutPath, '');
    fs.writeFileSync(secondRolloutPath, '');
    insertThread(dbPath, threadId, firstRolloutPath, { updatedAt: 2_000, title: 'Import Me' });
    insertThread(dbPath, execThreadId, secondRolloutPath, { updatedAt: 1_000, title: 'Leave Me' });

    const scan = await scanExternalCodexSessions();

    expect(scan.candidates.map((item) => item.id).sort()).toEqual([execThreadId, threadId].sort());
    const countBefore = currentTestDb().prepare('SELECT COUNT(*) AS count FROM sessions').get() as {
      count: number;
    };
    expect(countBefore.count).toBe(0);

    const result = await importExternalCodexSessions([threadId]);

    expect(result).toMatchObject({ scanned: 1, inserted: 1, updated: 0 });
    const rows = currentTestDb().prepare('SELECT id, title FROM sessions ORDER BY id').all();
    expect(rows).toEqual([{ id: `codex-${threadId}`, title: 'Import Me' }]);
  });

  it('normalizes Windows backslash cwd to storage form on import (#537)', async () => {
    const dbPath = createStateDb(externalHome);
    const rolloutPath = path.join(externalHome, 'sessions', `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, '');
    insertThread(dbPath, threadId, rolloutPath, {
      updatedAt: 2_000,
      title: 'Windows Thread',
      cwd: 'D:\\Project-001\\',
    });

    const result = await importExternalCodexSessions([threadId]);

    expect(result).toMatchObject({ scanned: 1, inserted: 1, updated: 0 });
    const rows = currentTestDb()
      .prepare('SELECT id, working_dir AS workingDir FROM sessions')
      .all();
    expect(rows).toEqual([{ id: `codex-${threadId}`, workingDir: 'D:/Project-001' }]);
  });

  it('imports the same latest Codex thread version shown by scan when defaults contain duplicates', async () => {
    const olderDbPath = createStateDb(externalHome);
    const olderRolloutPath = path.join(
      externalHome,
      'sessions',
      `rollout-2026-05-13-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(olderRolloutPath), { recursive: true });
    fs.writeFileSync(olderRolloutPath, '');
    insertThread(olderDbPath, threadId, olderRolloutPath, {
      updatedAt: 1_000,
      title: 'Older Copy',
    });

    const defaultHome = path.join(rootDir, 'home', '.codex');
    const newerDbPath = createStateDb(defaultHome);
    const newerRolloutPath = path.join(
      defaultHome,
      'sessions',
      `rollout-2026-05-15-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(newerRolloutPath), { recursive: true });
    fs.writeFileSync(newerRolloutPath, '');
    insertThread(newerDbPath, threadId, newerRolloutPath, {
      updatedAt: 3_000,
      title: 'Newest Copy',
    });

    const scan = await scanExternalCodexSessions();

    expect(scan.candidates).toMatchObject([{ id: threadId, title: 'Newest Copy' }]);
    const result = await importExternalCodexSessions([threadId]);

    expect(result).toMatchObject({ scanned: 1, inserted: 1, updated: 0 });
    const rows = currentTestDb().prepare('SELECT id, title FROM sessions ORDER BY id').all();
    expect(rows).toEqual([{ id: `codex-${threadId}`, title: 'Newest Copy' }]);
  });

  it('falls back to rollout files when a state DB is present but unreadable for threads', async () => {
    createStateDb(externalHome, false);
    const rolloutPath = path.join(externalHome, 'sessions', `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      `${JSON.stringify({
        timestamp: '2026-05-13T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: threadId,
          timestamp: '2026-05-13T00:00:00.000Z',
          cwd: '/tmp/project',
          source: 'cli',
          model: 'gpt-5.5',
          reasoning_effort: 'high',
          approval_mode: 'on-request',
        },
      })}\n`,
    );

    const scan = await scanExternalCodexSessions();

    expect(scan.candidates.map((item) => item.id)).toEqual([threadId]);
    const result = await importExternalCodexSessions([threadId]);
    expect(result).toMatchObject({ scanned: 1, inserted: 1, updated: 0 });
    const row = currentTestDb()
      .prepare('SELECT id, working_dir AS workingDir FROM sessions LIMIT 1')
      .get() as { id: string; workingDir: string } | undefined;
    expect(row).toEqual({ id: `codex-${threadId}`, workingDir: '/tmp/project' });
  });

  it('marks Codex projectless threads as dialogue workspaces while preserving cwd', async () => {
    const dbPath = createStateDb(externalHome);
    const rolloutPath = path.join(externalHome, 'sessions', `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, '');
    fs.writeFileSync(
      path.join(externalHome, '.codex-global-state.json'),
      JSON.stringify({
        'projectless-thread-ids': [threadId],
      }),
    );
    insertThread(dbPath, threadId, rolloutPath, { updatedAt: 1_000, title: 'Standalone Dialogue' });

    const scan = await scanExternalCodexSessions();

    expect(scan.candidates).toMatchObject([
      { id: threadId, workspaceKind: 'dialogue', cwd: '/tmp/project' },
    ]);
    const result = await importExternalCodexSessions([threadId]);
    expect(result).toMatchObject({ scanned: 1, inserted: 1, updated: 0 });
    const row = currentTestDb()
      .prepare(
        `
      SELECT id, working_dir AS workingDir, workspace_kind AS workspaceKind
      FROM sessions
      LIMIT 1
    `,
      )
      .get() as { id: string; workingDir: string; workspaceKind: string } | undefined;
    expect(row).toEqual({
      id: `codex-${threadId}`,
      workingDir: '/tmp/project',
      workspaceKind: 'dialogue',
    });
  });

  it('reclassifies an older imported Codex row when Codex marks it projectless', async () => {
    const dbPath = createStateDb(externalHome);
    const rolloutPath = path.join(externalHome, 'sessions', `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, '');
    fs.writeFileSync(
      path.join(externalHome, '.codex-global-state.json'),
      JSON.stringify({
        'projectless-thread-ids': [threadId],
      }),
    );
    insertThread(dbPath, threadId, rolloutPath, { updatedAt: 1_000, title: 'External Dialogue' });

    currentTestDb()
      .prepare(
        `
      INSERT INTO sessions (
        id, title, working_dir, workspace_kind, model, effort, permission_mode, status,
        sdk_session_id, total_token_usage, total_cost_usd, context_tokens,
        context_window, fast_mode, cleared_at, pinned_at, user_send_at,
        agent_kind, parent_session_id, forked_at_message_id, worktree_path,
        source, feishu_open_id, feishu_bot_app_id, used_project_context,
        extra_dirs, created_at, updated_at
      )
      VALUES (
        ?, 'Local Rename', '/tmp/project', 'project', 'gpt-5.5', 'high', 'ask', 'active',
        ?, 0, 0, 0, 0, 0, NULL, NULL, 2000000,
        'codex', NULL, NULL, NULL, 'desktop', NULL, NULL, 0, '[]', 2000000, 2000000
      )
    `,
      )
      .run(`codex-${threadId}`, threadId);

    const result = await importExternalCodexSessions([threadId]);

    expect(result).toMatchObject({ scanned: 1, inserted: 0, updated: 1 });
    const row = currentTestDb()
      .prepare(
        `
      SELECT title, workspace_kind AS workspaceKind, updated_at AS updatedAt
      FROM sessions
      WHERE id = ?
    `,
      )
      .get(`codex-${threadId}`) as
      { title: string; workspaceKind: string; updatedAt: number } | undefined;
    expect(row).toEqual({
      title: 'Local Rename',
      workspaceKind: 'dialogue',
      updatedAt: 2000000,
    });
  });

  it('maps external Codex archived state while preserving the project working dir', async () => {
    const dbPath = createStateDb(externalHome);
    const rolloutPath = path.join(
      externalHome,
      'archived_sessions',
      `rollout-2026-05-13-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, '');
    insertThread(dbPath, threadId, rolloutPath, {
      updatedAt: 1_000,
      archived: true,
      archivedAt: 2_000,
    });

    const scan = await scanExternalCodexSessions();

    expect(scan.candidates.map((item) => item.id)).toEqual([threadId]);
    const result = await importExternalCodexSessions([threadId]);
    expect(result).toMatchObject({ scanned: 1, inserted: 1, updated: 0 });
    const row = currentTestDb()
      .prepare(
        `
      SELECT id, status, working_dir AS workingDir, user_send_at AS userSendAt
      FROM sessions
      LIMIT 1
    `,
      )
      .get() as { id: string; status: string; workingDir: string; userSendAt: number } | undefined;
    expect(row).toEqual({
      id: `codex-${threadId}`,
      status: 'archived',
      workingDir: '/tmp/project',
      userSendAt: 2_000_000,
    });
  });

  it('does not upsert an imported row when a native Codex session already owns the sdk session id', async () => {
    const dbPath = createStateDb(externalHome);
    const rolloutPath = path.join(externalHome, 'sessions', `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, '');
    insertThread(dbPath, threadId, rolloutPath, { updatedAt: 1_000, title: 'External Duplicate' });

    currentTestDb()
      .prepare(
        `
      INSERT INTO sessions (
        id, title, working_dir, model, effort, permission_mode, status,
        sdk_session_id, total_token_usage, total_cost_usd, context_tokens,
        context_window, fast_mode, cleared_at, pinned_at, user_send_at,
        agent_kind, parent_session_id, forked_at_message_id, worktree_path,
        source, feishu_open_id, feishu_bot_app_id, used_project_context,
        extra_dirs, created_at, updated_at
      )
      VALUES (
        'native-codex-session', 'Native', '/tmp/project', 'gpt-5.5', 'high', 'ask', 'active',
        ?, 0, 0, 0, 0, 0, NULL, NULL, 1,
        'codex', NULL, NULL, NULL, 'desktop', NULL, NULL, 0, '[]', 1, 1
      )
    `,
      )
      .run(threadId);

    const result = await importExternalCodexSessions([threadId]);

    expect(result).toMatchObject({ scanned: 1, inserted: 0, updated: 0 });
    const rows = currentTestDb().prepare('SELECT id, title FROM sessions ORDER BY id').all();
    expect(rows).toEqual([{ id: 'native-codex-session', title: 'Native' }]);
  });

  it('filters Codex exec sessions from scan and explicit import', async () => {
    const dbPath = createStateDb(externalHome);
    const normalRolloutPath = path.join(
      externalHome,
      'sessions',
      `rollout-2026-05-13-${threadId}.jsonl`,
    );
    const execRolloutPath = path.join(
      externalHome,
      'sessions',
      `rollout-2026-05-13-${execThreadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(normalRolloutPath), { recursive: true });
    fs.writeFileSync(normalRolloutPath, '');
    fs.writeFileSync(execRolloutPath, '');
    insertThread(dbPath, threadId, normalRolloutPath, {
      updatedAt: 2_000,
      title: 'Top Level Codex Session',
    });
    insertThread(dbPath, execThreadId, execRolloutPath, {
      updatedAt: 1_000,
      source: 'exec',
      title: 'Reply with exactly OK',
    });

    const scan = await scanExternalCodexSessions();

    expect(scan.candidates.map((item) => item.id)).toEqual([threadId]);
    const rejected = await importExternalCodexSessions([execThreadId]);
    expect(rejected).toMatchObject({ scanned: 1, inserted: 0, updated: 0 });
    const result = await importExternalCodexSessions([threadId]);
    expect(result).toMatchObject({ scanned: 1, inserted: 1, updated: 0 });
    const sessions = currentTestDb().prepare('SELECT id, title FROM sessions ORDER BY id').all();
    expect(sessions).toEqual([{ id: `codex-${threadId}`, title: 'Top Level Codex Session' }]);
  });

  it('discovers Codex home under %APPDATA% when platform is win32', async () => {
    const originalPlatform = process.platform;
    const originalAppData = process.env.APPDATA;
    delete process.env.CODEX_HOME;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const appData = path.join(rootDir, 'AppData', 'Roaming');
    process.env.APPDATA = appData;
    const winCodexHome = path.join(appData, 'Codex', 'codex-home');
    const dbPath = createStateDb(winCodexHome);
    const rolloutPath = path.join(winCodexHome, 'sessions', `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, '');
    insertThread(dbPath, threadId, rolloutPath, { updatedAt: 1_000, title: 'Win Codex Session' });

    try {
      const scan = await scanExternalCodexSessions();
      expect(scan.homes.some((h) => h.includes(path.join('Codex', 'codex-home')))).toBe(true);
      expect(scan.candidates.map((item) => item.id)).toEqual([threadId]);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      if (originalAppData == null) delete process.env.APPDATA;
      else process.env.APPDATA = originalAppData;
    }
  });

  it('keeps archived flag sticky when same thread appears in both sessions/ and archived_sessions/', async () => {
    // 仅依赖 rollout（DB 缺失）的发现路径：
    // archived_sessions/ 拷贝 mtime 更老，sessions/ 拷贝 mtime 更新 →
    // 期望合并时 archived=true（archived 标志 sticky，不会被较新的 sessions/ 拷贝覆盖）。
    createStateDb(externalHome, false);
    const archivedRollout = path.join(
      externalHome,
      'archived_sessions',
      `rollout-2026-05-12-${threadId}.jsonl`,
    );
    const activeRollout = path.join(
      externalHome,
      'sessions',
      `rollout-2026-05-13-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(archivedRollout), { recursive: true });
    fs.mkdirSync(path.dirname(activeRollout), { recursive: true });
    const meta = (timestamp: string) =>
      `${JSON.stringify({
        timestamp,
        type: 'session_meta',
        payload: {
          id: threadId,
          timestamp,
          cwd: '/tmp/project',
          source: 'cli',
          model: 'gpt-5.5',
          reasoning_effort: 'high',
          approval_mode: 'on-request',
        },
      })}\n`;
    fs.writeFileSync(archivedRollout, meta('2026-05-12T00:00:00.000Z'));
    fs.writeFileSync(activeRollout, meta('2026-05-13T00:00:00.000Z'));
    fs.utimesSync(archivedRollout, new Date(1_000), new Date(1_000));
    fs.utimesSync(activeRollout, new Date(5_000), new Date(5_000));

    const scan = await scanExternalCodexSessions();

    expect(scan.candidates).toHaveLength(1);
    expect(scan.candidates[0]).toMatchObject({ id: threadId, archived: true });
  });

  it('caps to newest MAX_THREADS_PER_HOME top-level threads when more than 1000 exist', async () => {
    // 写 1001 个有效 thread（updatedAt 递增），cap=1000 时应该保留 updatedAt 最新的 1000 个。
    // 被剔除的应该是 updatedAt 最小那个（id=...000000000000）。
    const dbPath = createStateDb(externalHome);
    const rolloutPath = path.join(externalHome, 'sessions', `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, '');
    const oldestId = `019dcd5a-6e54-7960-95e0-${'0'.padStart(12, '0')}`;
    for (let i = 0; i < 1001; i += 1) {
      const id = `019dcd5a-6e54-7960-95e0-${String(i).padStart(12, '0')}`;
      insertThread(dbPath, id, rolloutPath, { updatedAt: 10_000 + i });
    }

    const scan = await scanExternalCodexSessions();

    expect(scan.candidates).toHaveLength(1000);
    const ids = scan.candidates.map((c) => c.id);
    expect(ids).not.toContain(oldestId);
    // 抽样：最新一条（updatedAt=11000）应当在结果里
    expect(ids).toContain(`019dcd5a-6e54-7960-95e0-${String(1000).padStart(12, '0')}`);
  }, 15_000);

  it('does not implicitly remove imported Codex rows during read-only scan', async () => {
    const dbPath = createStateDb(externalHome);
    const rolloutPath = path.join(externalHome, 'sessions', `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, '');
    insertThread(dbPath, threadId, rolloutPath, { updatedAt: 1_000, title: 'Still Present' });

    const staleThreadId = '019dcd5a-6e54-7960-95e0-aa68117a28ff';
    currentTestDb()
      .prepare(
        `
      INSERT INTO sessions (
        id, title, working_dir, model, effort, permission_mode, status,
        sdk_session_id, total_token_usage, total_cost_usd, context_tokens,
        context_window, fast_mode, cleared_at, pinned_at, user_send_at,
        agent_kind, parent_session_id, forked_at_message_id, worktree_path,
        source, feishu_open_id, feishu_bot_app_id, used_project_context,
        extra_dirs, created_at, updated_at
      )
      VALUES (
        ?, 'Stale Imported Codex Session', '/tmp/project', 'gpt-5.5', 'high', 'ask', 'active',
        ?, 0, 0, 0, 0, 0, NULL, NULL, 1,
        'codex', NULL, NULL, NULL, 'desktop', NULL, NULL, 0, '[]', 1, 1
      )
    `,
      )
      .run(`codex-${staleThreadId}`, staleThreadId);

    const scan = await scanExternalCodexSessions();

    expect(scan.candidates.map((item) => item.id)).toEqual([threadId]);
    const rows = currentTestDb().prepare('SELECT id, title FROM sessions ORDER BY id').all();
    expect(rows).toEqual([{ id: `codex-${staleThreadId}`, title: 'Stale Imported Codex Session' }]);
  });
});

describe('importExternalCodexMessagesForSession', () => {
  it('skips unchanged rollout files after importing them once', async () => {
    const dbPath = createStateDb(externalHome);
    const rolloutPath = path.join(externalHome, 'sessions', `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      `${rolloutLine('m1', 'user', 'hello', '2026-05-13T00:00:01.000Z')}\n`,
    );
    insertThread(dbPath, threadId, rolloutPath, { updatedAt: 1_000 });

    const db = currentTestDb();
    insertImportedCodexSession(db, `codex-${threadId}`, threadId);

    const tx = vi.fn(
      async (name: string, args: unknown) => runInprocTx(db, { name, args }) as never,
    );
    setCurrentDbClient({ ...makeTestDbClient(db), tx }, 'test-user');

    await importExternalCodexMessagesForSession(`codex-${threadId}`);
    await importExternalCodexMessagesForSession(`codex-${threadId}`);

    expect(tx).toHaveBeenCalledTimes(1);
    const count = db.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number };
    expect(count.count).toBe(1);
  });

  it('does not reuse unchanged rollout cache across current DB users', async () => {
    const dbPath = createStateDb(externalHome);
    const rolloutPath = path.join(externalHome, 'sessions', `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      `${rolloutLine('m1', 'user', 'hello', '2026-05-13T00:00:01.000Z')}\n`,
    );
    insertThread(dbPath, threadId, rolloutPath, { updatedAt: 1_000 });

    const dbA = currentTestDb();
    insertImportedCodexSession(dbA, `codex-${threadId}`, threadId);
    const txA = vi.fn(
      async (name: string, args: unknown) => runInprocTx(dbA, { name, args }) as never,
    );
    setCurrentDbClient({ ...makeTestDbClient(dbA), tx: txA }, 'user-a');
    await importExternalCodexMessagesForSession(`codex-${threadId}`);
    expect(txA).toHaveBeenCalledTimes(1);

    const dbB = createLocalDb();
    try {
      dbMock.current = dbB;
      insertImportedCodexSession(dbB, `codex-${threadId}`, threadId);
      const txB = vi.fn(
        async (name: string, args: unknown) => runInprocTx(dbB, { name, args }) as never,
      );
      setCurrentDbClient({ ...makeTestDbClient(dbB), tx: txB }, 'user-b');

      await importExternalCodexMessagesForSession(`codex-${threadId}`);

      expect(txB).toHaveBeenCalledTimes(1);
      const count = dbB.prepare('SELECT COUNT(*) AS count FROM messages').get() as {
        count: number;
      };
      expect(count.count).toBe(1);
    } finally {
      dbA.close();
    }
  });

  it('imports newly appended rollout messages while the session only has imported history', async () => {
    const dbPath = createStateDb(externalHome);
    const rolloutPath = path.join(externalHome, 'sessions', `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      `${rolloutLine('m1', 'user', 'hello', '2026-05-13T00:00:01.000Z')}\n`,
    );
    insertThread(dbPath, threadId, rolloutPath, { updatedAt: 1_000 });

    currentTestDb()
      .prepare(
        `
      INSERT INTO sessions (
        id, title, working_dir, model, effort, permission_mode, status,
        sdk_session_id, total_token_usage, total_cost_usd, context_tokens,
        context_window, fast_mode, cleared_at, pinned_at, user_send_at,
        agent_kind, parent_session_id, forked_at_message_id, worktree_path,
        source, feishu_open_id, feishu_bot_app_id, used_project_context,
        extra_dirs, created_at, updated_at
      )
      VALUES (
        ?, 'Imported', '/tmp/project', 'gpt-5.5', 'high', 'ask', 'active',
        ?, 0, 0, 0, 0, 0, NULL, NULL, 1,
        'codex', NULL, NULL, NULL, 'desktop', NULL, NULL, 0, '[]', 1, 1
      )
    `,
      )
      .run(`codex-${threadId}`, threadId);

    await importExternalCodexMessagesForSession(`codex-${threadId}`);
    fs.appendFileSync(
      rolloutPath,
      `${rolloutLine('m2', 'assistant', 'world', '2026-05-13T00:00:02.000Z')}\n`,
    );
    await importExternalCodexMessagesForSession(`codex-${threadId}`);

    const count = currentTestDb().prepare('SELECT COUNT(*) AS count FROM messages').get() as {
      count: number;
    };
    expect(count.count).toBe(2);
  });

  it('updates existing imported Codex user rows when screenshots become available', async () => {
    const dbPath = createStateDb(externalHome);
    const rolloutPath = path.join(externalHome, 'sessions', `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      `${rolloutLineWithImage('m1', 'look at this', '2026-05-13T00:00:01.000Z')}\n`,
    );
    insertThread(dbPath, threadId, rolloutPath, { updatedAt: 1_000 });

    const sessionId = `codex-${threadId}`;
    currentTestDb()
      .prepare(
        `
      INSERT INTO sessions (
        id, title, working_dir, model, effort, permission_mode, status,
        sdk_session_id, total_token_usage, total_cost_usd, context_tokens,
        context_window, fast_mode, cleared_at, pinned_at, user_send_at,
        agent_kind, parent_session_id, forked_at_message_id, worktree_path,
        source, feishu_open_id, feishu_bot_app_id, used_project_context,
        extra_dirs, created_at, updated_at
      )
      VALUES (
        ?, 'Imported', '/tmp/project', 'gpt-5.5', 'high', 'ask', 'active',
        ?, 0, 0, 0, 0, 0, NULL, NULL, 1,
        'codex', NULL, NULL, NULL, 'desktop', NULL, NULL, 0, '[]', 1, 1
      )
    `,
      )
      .run(sessionId, threadId);
    currentTestDb()
      .prepare(
        `
      INSERT INTO messages (
        id, client_id, session_id, role, content, tool_use_id, agent_meta, created_at, rewind_at
      )
      VALUES (
        'old-imported-user', ?, ?, 'user', ?, NULL, NULL, 1, NULL
      )
    `,
      )
      .run(`codex-import:${threadId}:1`, sessionId, JSON.stringify('look at this'));

    await importExternalCodexMessagesForSession(sessionId);

    const row = currentTestDb()
      .prepare('SELECT content FROM messages WHERE client_id = ?')
      .get(`codex-import:${threadId}:1`) as { content: string } | undefined;
    const parsed = JSON.parse(row?.content ?? 'null') as {
      text: string;
      images: Array<{ url: string; mimeType: string; originalName: string }>;
      files: unknown[];
    };
    expect(parsed.text).toBe('look at this');
    expect(parsed.files).toEqual([]);
    expect(parsed.images).toHaveLength(1);
    expect(parsed.images[0]).toMatchObject({
      mimeType: 'image/png',
      originalName: 'codex-import-1-0-0.png',
    });
    const filename = decodeURIComponent(new URL(parsed.images[0].url).pathname.slice(1));
    expect(
      fs.existsSync(path.join(targetUserData, 'cc-agent', 'images', sessionId, filename)),
    ).toBe(true);
  });

  it('skips a truncated jsonl line in the middle without failing the whole import', async () => {
    const dbPath = createStateDb(externalHome);
    const rolloutPath = path.join(externalHome, 'sessions', `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      [
        rolloutLine('m1', 'user', 'first', '2026-05-13T00:00:01.000Z'),
        '{"timestamp":"2026-05-13T00:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","te', // truncated middle line
        rolloutLine('m3', 'assistant', 'third', '2026-05-13T00:00:03.000Z'),
        '',
      ].join('\n'),
    );
    insertThread(dbPath, threadId, rolloutPath, { updatedAt: 1_000 });

    currentTestDb()
      .prepare(
        `
      INSERT INTO sessions (
        id, title, working_dir, model, effort, permission_mode, status,
        sdk_session_id, total_token_usage, total_cost_usd, context_tokens,
        context_window, fast_mode, cleared_at, pinned_at, user_send_at,
        agent_kind, parent_session_id, forked_at_message_id, worktree_path,
        source, feishu_open_id, feishu_bot_app_id, used_project_context,
        extra_dirs, created_at, updated_at
      )
      VALUES (
        ?, 'Imported', '/tmp/project', 'gpt-5.5', 'high', 'ask', 'active',
        ?, 0, 0, 0, 0, 0, NULL, NULL, 1,
        'codex', NULL, NULL, NULL, 'desktop', NULL, NULL, 0, '[]', 1, 1
      )
    `,
      )
      .run(`codex-${threadId}`, threadId);

    await importExternalCodexMessagesForSession(`codex-${threadId}`);

    const rows = currentTestDb()
      .prepare(
        `
      SELECT role, content FROM messages ORDER BY id
    `,
      )
      .all() as Array<{ role: string; content: string }>;
    // 损坏的中间行被跳过，前后两条有效行仍应入库。
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(rows.map((r) => JSON.parse(r.content))).toEqual(['first', 'third']);
  });

  it('keeps importing linked Codex rollout messages after local app messages without duplicating them', async () => {
    const dbPath = createStateDb(externalHome);
    const rolloutPath = path.join(externalHome, 'sessions', `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      `${rolloutLine('m1', 'user', 'hello', '2026-05-13T00:00:01.000Z')}\n`,
    );
    insertThread(dbPath, threadId, rolloutPath, { updatedAt: 1_000 });

    currentTestDb()
      .prepare(
        `
      INSERT INTO sessions (
        id, title, working_dir, model, effort, permission_mode, status,
        sdk_session_id, total_token_usage, total_cost_usd, context_tokens,
        context_window, fast_mode, cleared_at, pinned_at, user_send_at,
        agent_kind, parent_session_id, forked_at_message_id, worktree_path,
        source, feishu_open_id, feishu_bot_app_id, used_project_context,
        extra_dirs, created_at, updated_at
      )
      VALUES (
        ?, 'Linked', '/tmp/project', 'gpt-5.5', 'high', 'ask', 'active',
        ?, 0, 0, 0, 0, 0, NULL, NULL, 1,
        'codex', NULL, NULL, NULL, 'desktop', NULL, NULL, 0, '[]', 1, 1
      )
    `,
      )
      .run(`codex-${threadId}`, threadId);

    await importExternalCodexMessagesForSession(`codex-${threadId}`);

    currentTestDb()
      .prepare(
        `
      INSERT INTO messages (
        id, client_id, session_id, role, content, tool_use_id, agent_meta, created_at, rewind_at
      )
      VALUES (
        'local-user', 'local-user-client', ?, 'user', 'continue', NULL, NULL, ?, NULL
      )
    `,
      )
      .run(`codex-${threadId}`, Date.parse('2026-05-13T00:00:02.000Z') + 2);

    fs.appendFileSync(
      rolloutPath,
      `${rolloutLine('m2', 'user', 'continue', '2026-05-13T00:00:02.000Z')}\n`,
    );
    fs.appendFileSync(
      rolloutPath,
      `${rolloutLine('m3', 'assistant', 'external update', '2026-05-13T00:00:03.000Z')}\n`,
    );

    await importExternalCodexMessagesForSession(`codex-${threadId}`);

    const rows = currentTestDb()
      .prepare(
        `
      SELECT client_id AS clientId, role, content
      FROM messages
      ORDER BY created_at
    `,
      )
      .all() as Array<{ clientId: string; role: string; content: string }>;
    expect(rows).toEqual([
      { clientId: `codex-import:${threadId}:1`, role: 'user', content: JSON.stringify('hello') },
      { clientId: 'local-user-client', role: 'user', content: 'continue' },
      {
        clientId: `codex-import:${threadId}:3`,
        role: 'assistant',
        content: JSON.stringify('external update'),
      },
    ]);
  });
});

describe('prepareExternalCodexSessionForResume orphan rollout synthesis', () => {
  // 桌面端 codex-home = app.getPath('userData')/codex-home(见 getDesktopCodexHome)。
  const desktopHome = () => path.join(targetUserData, 'codex-home');

  /** 在桌面端 localDb 插一条 codex 会话(sdk_session_id=threadId)。 */
  function insertLocalCodexSession(
    sessionId: string,
    sdkSessionId: string,
    opts: { createdAt?: number; updatedAt?: number } = {},
  ): void {
    currentTestDb()
      .prepare(
        `
      INSERT INTO sessions (
        id, title, working_dir, model, effort, permission_mode, status,
        sdk_session_id, total_token_usage, total_cost_usd, context_tokens,
        context_window, fast_mode, cleared_at, pinned_at, user_send_at,
        agent_kind, parent_session_id, forked_at_message_id, worktree_path,
        source, feishu_open_id, feishu_bot_app_id, used_project_context,
        extra_dirs, created_at, updated_at
      )
      VALUES (
        ?, 'Orphan', '/tmp/project', 'gpt-5.5', 'high', 'ask', 'active',
        ?, 0, 0, 0, 0, 0, NULL, NULL, 1,
        'codex', NULL, NULL, NULL, 'desktop', NULL, NULL, 0, '[]', ?, ?
      )
    `,
      )
      .run(sessionId, sdkSessionId, opts.createdAt ?? 1_000, opts.updatedAt ?? 2_000);
  }

  function insertLocalMessage(
    sessionId: string,
    clientId: string,
    role: string,
    content: string,
    createdAt: number,
  ): void {
    currentTestDb()
      .prepare(
        `
      INSERT INTO messages (id, client_id, session_id, role, content, tool_use_id, agent_meta, created_at, rewind_at)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL)
    `,
      )
      .run(`${clientId}-id`, clientId, sessionId, role, content, createdAt);
  }

  it('adopts a legacy branded Codex HOME and remains resumable after the old directory is removed', async () => {
    const legacyUserData = path.join(path.dirname(targetUserData), 'xdt-maker');
    const legacyHome = path.join(legacyUserData, 'codex-home');
    const sourceRollout = path.join(
      legacyHome,
      'sessions',
      '2026',
      '07',
      '14',
      `rollout-2026-07-14-${threadId}.jsonl`,
    );
    const sourceContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/tmp/project' },
    })}\n${rolloutLine('m1', 'user', 'legacy history', '2026-07-14T00:00:01.000Z')}\n`;
    const sourceDbPath = createStateDb(legacyHome);
    fs.mkdirSync(path.dirname(sourceRollout), { recursive: true });
    fs.writeFileSync(sourceRollout, sourceContents);
    insertThread(sourceDbPath, threadId, sourceRollout, {
      updatedAt: 2_000,
      title: 'Legacy branded session',
    });
    const targetDbPath = createStateDb(desktopHome());

    // CODEX_HOME 候选故意不存在,证明命中来自品牌身份表里的 legacy userData。
    process.env.CODEX_HOME = path.join(rootDir, 'missing-external-home');
    await prepareExternalCodexSessionForResume(threadId);

    const targetRow = new Database(targetDbPath, { readonly: true });
    const adopted = targetRow
      .prepare('SELECT rollout_path AS rolloutPath, title FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string; title: string };
    targetRow.close();
    expect(adopted.title).toBe('Legacy branded session');
    expect(adopted.rolloutPath.startsWith(path.join(desktopHome(), 'sessions'))).toBe(true);
    expect(path.basename(adopted.rolloutPath)).toBe(path.basename(sourceRollout));
    expect(fs.readFileSync(adopted.rolloutPath, 'utf-8')).toBe(sourceContents);

    // 接管后不再依赖老目录;重复 prepare 走当前 HOME 热路径且不改写 rollout。
    fs.rmSync(legacyUserData, { recursive: true, force: true });
    await prepareExternalCodexSessionForResume(threadId);
    expect(fs.readFileSync(adopted.rolloutPath, 'utf-8')).toBe(sourceContents);
  });

  it('repairs a pre-existing external rollout pointer without overwriting current thread metadata', async () => {
    const legacyHome = path.join(path.dirname(targetUserData), 'xdt-maker', 'codex-home');
    const sourceRollout = path.join(legacyHome, 'sessions', `rollout-2026-07-14-${threadId}.jsonl`);
    const sourceDbPath = createStateDb(legacyHome);
    fs.mkdirSync(path.dirname(sourceRollout), { recursive: true });
    fs.writeFileSync(sourceRollout, 'LEGACY_ROLLOUT');
    insertThread(sourceDbPath, threadId, sourceRollout, {
      updatedAt: 2_000,
      title: 'Older legacy title',
    });
    const targetDbPath = createStateDb(desktopHome());
    insertThread(targetDbPath, threadId, sourceRollout, {
      updatedAt: 3_000,
      title: 'Current Cindy title',
    });
    process.env.CODEX_HOME = path.join(rootDir, 'missing-external-home');

    await prepareExternalCodexSessionForResume(threadId);

    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath, title FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string; title: string };
    targetDb.close();
    expect(targetRow.title).toBe('Current Cindy title');
    expect(targetRow.rolloutPath.startsWith(path.join(desktopHome(), 'sessions'))).toBe(true);
    expect(fs.readFileSync(targetRow.rolloutPath, 'utf-8')).toBe('LEGACY_ROLLOUT');
  });

  it('prioritizes the legacy rollout already referenced by target state over a newer linked external copy', async () => {
    const legacyHome = path.join(path.dirname(targetUserData), 'xdt-maker', 'codex-home');
    const legacyRollout = path.join(legacyHome, 'sessions', `rollout-2026-07-14-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(legacyRollout), { recursive: true });
    fs.writeFileSync(legacyRollout, 'LEGACY_ROLLOUT');
    const legacyDbPath = createStateDb(legacyHome);
    insertThread(legacyDbPath, threadId, legacyRollout, {
      updatedAt: 2_000,
      title: 'Legacy source title',
    });

    const linkedRollout = path.join(
      externalHome,
      'sessions',
      `rollout-2026-07-15-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(linkedRollout), { recursive: true });
    fs.writeFileSync(linkedRollout, 'NEWER_LINKED_ROLLOUT');
    const linkedDbPath = createStateDb(externalHome);
    insertThread(linkedDbPath, threadId, linkedRollout, {
      updatedAt: 4_000,
      title: 'Newer linked title',
    });

    const targetDbPath = createStateDb(desktopHome());
    insertThread(targetDbPath, threadId, legacyRollout, {
      updatedAt: 3_000,
      title: 'Current Cindy title',
    });

    await prepareExternalCodexSessionForResume(threadId);

    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath, title FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string; title: string };
    targetDb.close();
    expect(targetRow.title).toBe('Current Cindy title');
    expect(targetRow.rolloutPath.startsWith(path.join(desktopHome(), 'sessions'))).toBe(true);
    expect(fs.readFileSync(targetRow.rolloutPath, 'utf-8')).toBe('LEGACY_ROLLOUT');
  });

  it('keeps an explicitly configured external CODEX_HOME linked instead of adopting it', async () => {
    const sourceRollout = path.join(
      externalHome,
      'sessions',
      `rollout-2026-07-14-${threadId}.jsonl`,
    );
    const sourceDbPath = createStateDb(externalHome);
    fs.mkdirSync(path.dirname(sourceRollout), { recursive: true });
    fs.writeFileSync(sourceRollout, 'LINKED_EXTERNAL_ROLLOUT');
    insertThread(sourceDbPath, threadId, sourceRollout, { updatedAt: 2_000 });
    const targetDbPath = createStateDb(desktopHome());

    await prepareExternalCodexSessionForResume(threadId);

    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(sourceRollout);
    expect(fs.existsSync(path.join(desktopHome(), 'sessions', path.basename(sourceRollout)))).toBe(
      false,
    );
  });

  it('synthesizes into the current HOME when legacy state survives but its rollout is missing', async () => {
    const legacyHome = path.join(path.dirname(targetUserData), 'xdt-maker', 'codex-home');
    const missingSourceRollout = path.join(
      legacyHome,
      'sessions',
      '2026',
      '07',
      '14',
      `rollout-2026-07-14-${threadId}.jsonl`,
    );
    const sourceDbPath = createStateDb(legacyHome);
    insertThread(sourceDbPath, threadId, missingSourceRollout, { updatedAt: 2_000 });
    const targetDbPath = createStateDb(desktopHome());
    const sessionId = `local-legacy-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(sessionId, 'c1', 'user', JSON.stringify({ text: 'recover me' }), 1_000);
    insertLocalMessage(sessionId, 'c2', 'assistant', 'recovered', 1_100);
    process.env.CODEX_HOME = path.join(rootDir, 'missing-external-home');

    await prepareExternalCodexSessionForResume(threadId);

    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath.startsWith(desktopHome())).toBe(true);
    expect(fs.existsSync(targetRow.rolloutPath)).toBe(true);
    expect(fs.existsSync(missingSourceRollout)).toBe(false);
    expect(fs.readFileSync(targetRow.rolloutPath, 'utf-8')).toContain('recover me');
  });

  it('synthesizes a standard rollout when both the Codex state row and file are missing', async () => {
    const dbPath = createStateDb(desktopHome());
    const sessionId = `local-missing-state-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'c1',
      'user',
      JSON.stringify({ text: 'recover without state' }),
      1_000,
    );
    insertLocalMessage(sessionId, 'c2', 'assistant', 'state will hydrate on resume', 1_100);

    await prepareExternalCodexSessionForResume(threadId);

    const rolloutPath = path.join(
      desktopHome(),
      'sessions',
      '1970',
      '01',
      '01',
      `rollout-1970-01-01T00-00-01-${threadId}.jsonl`,
    );
    expect(fs.existsSync(rolloutPath)).toBe(true);
    const lines = fs
      .readFileSync(rolloutPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({
      type: 'session_meta',
      payload: {
        session_id: threadId,
        id: threadId,
        cwd: '/tmp/project',
        cli_version: '0.0.0',
        source: 'cli',
        model_provider: null,
        base_instructions: null,
        model: 'gpt-5.5',
      },
    });
    expect(lines.slice(1).map((line) => line.payload.content[0].text)).toEqual([
      'recover without state',
      'state will hydrate on resume',
    ]);

    // Cindy 不伪造版本敏感的 threads 行;它由随后的 app-server thread/resume hydrate。
    const stateDb = new Database(dbPath, { readonly: true });
    const stateCount = stateDb
      .prepare('SELECT count(*) AS count FROM threads WHERE id = ?')
      .get(threadId) as { count: number };
    stateDb.close();
    expect(stateCount.count).toBe(0);

    // state 仍缺失时重复 prepare 会发现当前 HOME 已有 rollout,不覆盖恢复文件。
    const originalContents = fs.readFileSync(rolloutPath, 'utf-8');
    await prepareExternalCodexSessionForResume(threadId);
    expect(fs.readFileSync(rolloutPath, 'utf-8')).toBe(originalContents);
  });

  it('prefers the fullest readable history when duplicate Cindy sessions share a Codex thread', async () => {
    createStateDb(desktopHome());
    const fullerSessionId = `local-fuller-${threadId}`;
    const partialSessionId = `local-partial-${threadId}`;
    insertLocalCodexSession(fullerSessionId, threadId, { createdAt: 1_000, updatedAt: 2_000 });
    insertLocalCodexSession(partialSessionId, threadId, { createdAt: 1_500, updatedAt: 3_000 });
    insertLocalMessage(
      fullerSessionId,
      'full-1',
      'user',
      JSON.stringify({ text: 'full start' }),
      1_000,
    );
    insertLocalMessage(fullerSessionId, 'full-2', 'assistant', 'full answer', 1_100);
    insertLocalMessage(
      fullerSessionId,
      'full-3',
      'user',
      JSON.stringify({ text: 'full continuation' }),
      1_200,
    );
    insertLocalMessage(
      partialSessionId,
      'partial-1',
      'user',
      JSON.stringify({ text: 'partial only' }),
      1_500,
    );

    await prepareExternalCodexSessionForResume(threadId);

    const rolloutPath = path.join(
      desktopHome(),
      'sessions',
      '1970',
      '01',
      '01',
      `rollout-1970-01-01T00-00-01-${threadId}.jsonl`,
    );
    const lines = fs
      .readFileSync(rolloutPath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines.slice(1).map((line) => line.payload.content[0].text)).toEqual([
      'full start',
      'full answer',
      'full continuation',
    ]);
  });

  it('uses the first positive message timestamp for concurrent recovery when session created_at is invalid', async () => {
    createStateDb(desktopHome());
    const sessionId = `local-zero-created-${threadId}`;
    insertLocalCodexSession(sessionId, threadId, { createdAt: 0, updatedAt: 2_000 });
    insertLocalMessage(sessionId, 'c0', 'user', JSON.stringify({ text: 'zero timestamp' }), 0);
    insertLocalMessage(sessionId, 'c1', 'assistant', 'stable timestamp', 5_000);

    await Promise.all([
      prepareExternalCodexSessionForResume(threadId),
      prepareExternalCodexSessionForResume(threadId),
    ]);

    const rolloutPath = path.join(
      desktopHome(),
      'sessions',
      '1970',
      '01',
      '01',
      `rollout-1970-01-01T00-00-05-${threadId}.jsonl`,
    );
    expect(fs.existsSync(rolloutPath)).toBe(true);
    expect(fs.readdirSync(path.dirname(rolloutPath))).toEqual([path.basename(rolloutPath)]);
    const meta = JSON.parse(fs.readFileSync(rolloutPath, 'utf-8').split('\n')[0]);
    expect(meta.timestamp).toBe('1970-01-01T00:00:05.000Z');
    expect(meta.payload.timestamp).toBe('1970-01-01T00:00:05.000Z');
  });

  it('does not synthesize missing Codex state for a deleted local session', async () => {
    createStateDb(desktopHome());
    const sessionId = `local-deleted-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    currentTestDb()
      .prepare('UPDATE sessions SET status = ? WHERE id = ?')
      .run('deleted', sessionId);
    insertLocalMessage(
      sessionId,
      'c1',
      'user',
      JSON.stringify({ text: 'do not resurrect' }),
      1_000,
    );

    await prepareExternalCodexSessionForResume(threadId);

    expect(fs.existsSync(path.join(desktopHome(), 'sessions'))).toBe(false);
  });

  it('synthesizes a rollout from localDb when the DB row exists but the file is missing', async () => {
    const dbPath = createStateDb(desktopHome());
    const missingRollout = path.join(
      desktopHome(),
      'sessions',
      '2026',
      '06',
      '15',
      `rollout-2026-06-15-${threadId}.jsonl`,
    );
    // threads 行存在、但 rollout 文件不写(孤儿)。
    insertThread(dbPath, threadId, missingRollout, { updatedAt: 2_000 });

    const sessionId = `local-orphan-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'c1',
      'user',
      JSON.stringify({ text: '123312', images: [], files: [] }),
      1000,
    );
    insertLocalMessage(
      sessionId,
      'c2',
      'thinking',
      JSON.stringify({ kind: 'thinking', text: 'internal' }),
      1500,
    );
    insertLocalMessage(sessionId, 'c3', 'assistant', '我没看懂你的意思。', 1600);
    insertLocalMessage(
      sessionId,
      'c4',
      'user',
      JSON.stringify({ text: '444', images: [], files: [] }),
      1700,
    );
    const newerPartialSessionId = `local-orphan-partial-${threadId}`;
    insertLocalCodexSession(newerPartialSessionId, threadId, {
      createdAt: 1_500,
      updatedAt: 3_000,
    });
    insertLocalMessage(
      newerPartialSessionId,
      'partial-1',
      'user',
      JSON.stringify({ text: 'newer partial history' }),
      1_800,
    );

    expect(fs.existsSync(missingRollout)).toBe(false);
    await prepareExternalCodexSessionForResume(threadId);
    expect(fs.existsSync(missingRollout)).toBe(true);

    const lines = fs
      .readFileSync(missingRollout, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    // 第一行 session_meta,id 正确。
    expect(lines[0]).toMatchObject({ type: 'session_meta', payload: { id: threadId } });
    // 后续仅 user/assistant 的 response_item(thinking 被跳过)。
    const items = lines.slice(1);
    expect(items.every((l) => l.type === 'response_item' && l.payload.type === 'message')).toBe(
      true,
    );
    expect(items.map((l) => l.payload.role)).toEqual(['user', 'assistant', 'user']);
    expect(items.map((l) => l.payload.content[0].text)).toEqual([
      '123312',
      '我没看懂你的意思。',
      '444',
    ]);
    // user 用 input_text、assistant 用 output_text。
    expect(items[0].payload.content[0].type).toBe('input_text');
    expect(items[1].payload.content[0].type).toBe('output_text');
  });

  it('does not overwrite an existing rollout file (happy path short-circuit)', async () => {
    const dbPath = createStateDb(desktopHome());
    const rolloutPath = path.join(
      desktopHome(),
      'sessions',
      `rollout-2026-06-15-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, 'ORIGINAL_CONTENT');
    insertThread(dbPath, threadId, rolloutPath, { updatedAt: 2_000 });

    const sessionId = `local-orphan-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'c1',
      'user',
      JSON.stringify({ text: 'hi', images: [], files: [] }),
      1000,
    );

    await prepareExternalCodexSessionForResume(threadId);

    expect(fs.readFileSync(rolloutPath, 'utf-8')).toBe('ORIGINAL_CONTENT');
  });

  it('does not synthesize when there is no readable localDb history', async () => {
    const dbPath = createStateDb(desktopHome());
    const missingRollout = path.join(
      desktopHome(),
      'sessions',
      `rollout-2026-06-15-${threadId}.jsonl`,
    );
    insertThread(dbPath, threadId, missingRollout, { updatedAt: 2_000 });
    // 有 threads 行,但 localDb 里没有对应会话/消息。

    await prepareExternalCodexSessionForResume(threadId);

    expect(fs.existsSync(missingRollout)).toBe(false);
  });
});
