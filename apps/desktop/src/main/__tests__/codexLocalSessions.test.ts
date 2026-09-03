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
let dateNowSpy: { mockRestore: () => void } | null = null;
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
  dateNowSpy?.mockRestore();
  dateNowSpy = null;
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

  it('revives a soft-deleted imported thread on explicit re-import (#3548)', async () => {
    // 删除把 updated_at 推到删除时刻(晚于源 rollout),仅按时间门判定会让
    // 重导入永远停留在 deleted;显式导入命中已软删同主键行必须复活。
    const dbPath = createStateDb(externalHome);
    const rolloutPath = path.join(externalHome, 'sessions', `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, '');
    insertThread(dbPath, threadId, rolloutPath, { updatedAt: 1_000, title: 'Revive Me' });

    const first = await importExternalCodexSessions([threadId]);
    expect(first).toMatchObject({ inserted: 1 });

    const before = currentTestDb()
      .prepare('SELECT title, updated_at AS updatedAt FROM sessions WHERE id = ?')
      .get(`codex-${threadId}`) as { title: string; updatedAt: number };
    currentTestDb()
      .prepare("UPDATE sessions SET status = 'deleted', title = 'stale-after-delete', updated_at = updated_at + 999999 WHERE id = ?")
      .run(`codex-${threadId}`);

    const again = await importExternalCodexSessions([threadId]);
    expect(again).toMatchObject({ inserted: 0, updated: 1 });
    const row = currentTestDb()
      .prepare('SELECT status, title, updated_at AS updatedAt FROM sessions WHERE id = ?')
      .get(`codex-${threadId}`) as { status: string; title: string; updatedAt: number };
    expect(row.status).toBe('active');
    // 复活即按新导入对待:元数据与 updated_at 收敛回源值(review 反馈)。
    expect(row.title).toBe(before.title);
    expect(row.updatedAt).toBe(before.updatedAt);
  });

  it('explicit import prefers session_index thread_name over stale state DB title (#3482)', async () => {
    // Codex 侧重命名写入 session_index.jsonl 的 thread_name;state DB 行的 title
    // 仍是旧自动标题。导入必须按 thread_name > state DB 标题取值,且索引
    // updated_at 合入有效更新时间。
    const dbPath = createStateDb(externalHome);
    const rolloutPath = path.join(externalHome, 'sessions', `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, '');
    insertThread(dbPath, threadId, rolloutPath, { updatedAt: 1_000, title: 'Auto Title' });
    fs.writeFileSync(
      path.join(externalHome, 'session_index.jsonl'),
      `${JSON.stringify({ id: threadId, thread_name: 'My Renamed Session', updated_at: 2_000 })}\n`,
    );

    const first = await importExternalCodexSessions([threadId]);
    expect(first).toMatchObject({ inserted: 1 });
    const row = currentTestDb()
      .prepare('SELECT title, updated_at AS updatedAt FROM sessions WHERE id = ?')
      .get(`codex-${threadId}`) as { title: string; updatedAt: number };
    expect(row.title).toBe('My Renamed Session');
    // timestampFromAny 把小数值按秒解释并归一为毫秒:2_000s → 2_000_000ms。
    expect(row.updatedAt).toBe(2_000_000);
  });

  it('re-import after Codex-side rename refreshes the stored title (#3482)', async () => {
    const dbPath = createStateDb(externalHome);
    const rolloutPath = path.join(externalHome, 'sessions', `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, '');
    insertThread(dbPath, threadId, rolloutPath, { updatedAt: 1_000, title: 'Auto Title' });

    const first = await importExternalCodexSessions([threadId]);
    expect(first).toMatchObject({ inserted: 1 });

    fs.writeFileSync(
      path.join(externalHome, 'session_index.jsonl'),
      `${JSON.stringify({ id: threadId, thread_name: 'Renamed Later', updated_at: 2_000 })}\n`,
    );
    const again = await importExternalCodexSessions([threadId]);
    expect(again).toMatchObject({ inserted: 0, updated: 1 });
    const row = currentTestDb()
      .prepare('SELECT title, updated_at AS updatedAt FROM sessions WHERE id = ?')
      .get(`codex-${threadId}`) as { title: string; updatedAt: number };
    expect(row.title).toBe('Renamed Later');
    expect(row.updatedAt).toBe(2_000_000);
  });

  it('batch import parses session_index.jsonl once per home while unchanged (#3673 review P2)', async () => {
    // 按 ID 导入对每个所选会话都会解析一次索引;(mtimeMs, size) 缓存把同一
    // home 未变化的索引收敛到单次读取,批量导入不再随会话数线性重复 IO。
    const dbPath = createStateDb(externalHome);
    for (const id of [threadId, execThreadId]) {
      const rolloutPath = path.join(externalHome, 'sessions', `rollout-2026-05-13-${id}.jsonl`);
      fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
      fs.writeFileSync(rolloutPath, '');
      insertThread(dbPath, id, rolloutPath, { updatedAt: 1_000, title: 'Auto Title' });
    }
    fs.writeFileSync(
      path.join(externalHome, 'session_index.jsonl'),
      `${[
        JSON.stringify({ id: threadId, thread_name: 'Named A', updated_at: 2_000 }),
        JSON.stringify({ id: execThreadId, thread_name: 'Named B', updated_at: 2_000 }),
      ].join('\n')}\n`,
    );

    const readSpy = vi.spyOn(fs, 'readFileSync');
    const result = await importExternalCodexSessions([threadId, execThreadId]);
    const indexReads = readSpy.mock.calls.filter(
      ([target]) => typeof target === 'string' && target.endsWith('session_index.jsonl'),
    );
    readSpy.mockRestore();

    expect(result).toMatchObject({ inserted: 2 });
    expect(indexReads).toHaveLength(1);
    const titles = (currentTestDb()
      .prepare('SELECT title FROM sessions ORDER BY title')
      .all() as Array<{ title: string }>).map((r) => r.title);
    expect(titles).toEqual(['Named A', 'Named B']);
  });

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

  it('restores a soft-deleted imported Codex session without creating a duplicate', async () => {
    const dbPath = createStateDb(externalHome);
    const rolloutPath = path.join(externalHome, 'sessions', `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, '');
    insertThread(dbPath, threadId, rolloutPath, { updatedAt: 2_000, title: 'Restored from Codex' });

    const localId = `codex-${threadId}`;
    insertImportedCodexSession(currentTestDb(), localId, threadId);
    currentTestDb().prepare('UPDATE sessions SET status = ? WHERE id = ?').run('deleted', localId);

    const result = await importExternalCodexSessions([threadId]);

    expect(result).toMatchObject({ scanned: 1, inserted: 0, updated: 1 });
    const sessions = currentTestDb()
      .prepare(
        `
        SELECT id, title, status, sdk_session_id AS sdkSessionId
        FROM sessions
        WHERE sdk_session_id = ?
      `,
      )
      .all(threadId);
    expect(sessions).toEqual([
      {
        id: localId,
        title: 'Restored from Codex',
        status: 'active',
        sdkSessionId: threadId,
      },
    ]);
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

  it('normalizes codex file and Web citations in imported assistant messages (#785)', async () => {
    const dbPath = createStateDb(externalHome);
    const rolloutPath = path.join(externalHome, 'sessions', `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      [
        rolloutLine('m1', 'user', 'save it', '2026-05-13T00:00:01.000Z'),
        rolloutLine(
          'm2',
          'assistant',
          '已保存::codex-file-citation{path="/tmp/报告.docx" purpose="output"},请查收。\uE200cite\uE202turn17search1\uE201',
          '2026-05-13T00:00:02.000Z',
        ),
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
      .prepare('SELECT role, content FROM messages ORDER BY id')
      .all() as Array<{ role: string; content: string }>;
    // 导入路径与流式路径同口径:入库的 assistant 正文不含内部 citation 语法。
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(JSON.parse(rows[1].content)).toBe('已保存:`/tmp/报告.docx`,请查收。');
  });

  it('strips unfinished citation tails from imported assistant messages (#785 review 反馈)', async () => {
    const dbPath = createStateDb(externalHome);
    const rolloutPath = path.join(externalHome, 'sessions', `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    // 生成中断的会话:assistant 正文停在标记中间(rollout 里就是这样存的)。
    fs.writeFileSync(
      rolloutPath,
      `${rolloutLine('m1', 'assistant', '结果在 :codex-file-citation{path="/tmp/x', '2026-05-13T00:00:01.000Z')}\n`,
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
      .prepare('SELECT role, content FROM messages ORDER BY id')
      .all() as Array<{ role: string; content: string }>;
    // 与流式 completed 同口径:确定的截断残尾从入库文本剥掉,不漏内部语法。
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content)).toBe('结果在');
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

  function markEmptyRolloutStable(filePath: string): void {
    const stat = fs.statSync(filePath);
    const latestIdentityTime = Math.max(
      stat.mtimeMs,
      stat.ctimeMs,
      Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtimeMs : 0,
    );
    dateNowSpy?.mockRestore();
    dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(latestIdentityTime + 20 * 60_000);
  }

  function materializeAfterInitialPrivateCanonicalScan(
    targetSessionsDir: string,
    materialize: () => void,
  ): { restore: () => void; didMaterialize: () => boolean } {
    const realReaddirSync = fs.readdirSync;
    let targetSessionsScanCount = 0;
    let materialized = false;
    const readdirSpy = vi.spyOn(fs, 'readdirSync').mockImplementation((function (
      directory: fs.PathLike,
      options?: unknown,
    ) {
      if (path.resolve(directory.toString()) === path.resolve(targetSessionsDir)) {
        targetSessionsScanCount += 1;
        // The first root scan enforces the grace period. The second belongs to
        // interrupted-preservation discovery immediately before the state-backed
        // rescan, which models a writer appearing in that exact preflight gap.
        if (targetSessionsScanCount === 2) {
          materialize();
          materialized = true;
        }
      }
      return Reflect.apply(realReaddirSync, fs, [directory, options]);
    }) as typeof fs.readdirSync);
    return {
      restore: () => readdirSpy.mockRestore(),
      didMaterialize: () => materialized,
    };
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
    expect(path.basename(adopted.rolloutPath)).toBe(
      `rollout-cindy-adopted-${path.basename(sourceRollout)}`,
    );
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

  it('keeps an existing external adoption hidden until a local precursor passes the state transaction', async () => {
    const sourceRollout = path.join(
      externalHome,
      'sessions',
      `rollout-2026-07-14T11-56-18-${threadId}.jsonl`,
    );
    const sourceContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/external/existing-row' },
    })}\n`;
    fs.mkdirSync(path.dirname(sourceRollout), { recursive: true });
    fs.writeFileSync(sourceRollout, sourceContents);

    const targetDbPath = createStateDb(desktopHome());
    insertThread(targetDbPath, threadId, sourceRollout, { updatedAt: 3_000 });
    const canonical = path.join(desktopHome(), 'sessions', path.basename(sourceRollout));
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.writeFileSync(canonical, '');
    markEmptyRolloutStable(canonical);
    const nativeContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/native/existing-row' },
    })}\n`;

    const realLinkSync = fs.linkSync.bind(fs);
    const realLink = fs.promises.link.bind(fs.promises);
    const realLstat = fs.lstatSync.bind(fs);
    let preservedCanonical: string | null = null;
    let publication: string | null = null;
    let preservedLstatCount = 0;
    let filled = false;
    const linkSyncSpy = vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
      const linked = realLinkSync(source, target);
      if (
        path.resolve(source.toString()) === path.resolve(canonical)
        && path.basename(target.toString()).startsWith('rollout-cindy-preserved-empty')
      ) preservedCanonical = path.resolve(target.toString());
      return linked;
    });
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (path.basename(target.toString()).startsWith('rollout-cindy-adopted')) {
        publication = path.resolve(target.toString());
      }
    });
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike) => {
      const observed = realLstat(file);
      if (
        publication
        && preservedCanonical
        && !filled
        && path.resolve(file.toString()) === preservedCanonical
      ) {
        preservedLstatCount += 1;
        // The same preserved inode is guarded once through the canonical plan
        // and once through interrupted-preservation recovery. Four probes pass
        // before UPDATE; the fifth begins the post-UPDATE transaction guard.
        if (preservedLstatCount === 5) {
          fs.writeFileSync(preservedCanonical, nativeContents);
          filled = true;
        }
      }
      return observed;
    }) as typeof fs.lstatSync);
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /external rollout pointer changed during private adoption/,
      );
    } finally {
      lstatSpy.mockRestore();
      linkSpy.mockRestore();
      linkSyncSpy.mockRestore();
    }

    expect(filled).toBe(true);
    expect(publication).toBeTruthy();
    expect(publication).not.toBe(canonical);
    expect(fs.existsSync(canonical)).toBe(false);
    let targetDb = new Database(targetDbPath, { readonly: true });
    let targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(sourceRollout);

    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(canonical);
    targetDb = new Database(targetDbPath, { readonly: true });
    targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(canonical);
    expect(fs.readFileSync(canonical, 'utf-8')).toBe(nativeContents);
    expect(fs.readFileSync(canonical, 'utf-8')).not.toBe(sourceContents);
  });

  it('rejects a different concurrent state winner beside the planned native canonical', async () => {
    const externalRollout = path.join(
      externalHome,
      'sessions',
      `rollout-2026-07-14T10-00-00-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(externalRollout), { recursive: true });
    fs.writeFileSync(externalRollout, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/external/concurrent-state-source' },
    })}\n`);
    const targetDbPath = createStateDb(desktopHome());
    insertThread(targetDbPath, threadId, externalRollout, { updatedAt: 3_000 });

    const directory = path.join(desktopHome(), 'sessions', '2026', '07', '14');
    const nativeCanonical = path.join(
      directory,
      `rollout-2026-07-14T11-00-00-${threadId}.jsonl`,
    );
    const concurrentWinner = path.join(
      directory,
      `rollout-cindy-adopted-${path.basename(nativeCanonical)}`,
    );
    const nativeContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/native/planned-canonical' },
    })}\n`;
    const concurrentContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/recovery/concurrent-state-winner' },
    })}\n`;
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(nativeCanonical, nativeContents);
    fs.writeFileSync(concurrentWinner, concurrentContents);

    const realLstat = fs.lstatSync.bind(fs);
    let stateChanged = false;
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation(((candidate: fs.PathLike) => {
      if (
        !stateChanged
        && path.resolve(candidate.toString()) === path.resolve(nativeCanonical)
      ) {
        const db = new Database(targetDbPath);
        db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?')
          .run(concurrentWinner, threadId);
        db.close();
        stateChanged = true;
      }
      return realLstat(candidate);
    }) as typeof fs.lstatSync);
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /concurrent state selected a different private winner/,
      );
    } finally {
      lstatSpy.mockRestore();
    }

    expect(stateChanged).toBe(true);
    expect(fs.readFileSync(nativeCanonical, 'utf-8')).toBe(nativeContents);
    expect(fs.readFileSync(concurrentWinner, 'utf-8')).toBe(concurrentContents);
    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(concurrentWinner);
  });

  it('fails closed when a second preserved native writer wakes before reconciliation commits', async () => {
    const externalRollout = path.join(
      externalHome,
      'sessions',
      `rollout-2026-07-14T10-00-00-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(externalRollout), { recursive: true });
    fs.writeFileSync(externalRollout, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/external/uncommitted' },
    })}\n`);
    const targetDbPath = createStateDb(desktopHome());
    insertThread(targetDbPath, threadId, externalRollout, { updatedAt: 3_000 });

    const directory = path.join(desktopHome(), 'sessions', '2026', '07', '14');
    const firstCanonical = path.join(
      directory,
      `rollout-2026-07-14T11-00-00-${threadId}.jsonl`,
    );
    const secondCanonical = path.join(
      directory,
      `rollout-2026-07-14T12-00-00-${threadId}.jsonl`,
    );
    const firstPreserved = path.join(
      directory,
      `rollout-cindy-preserved-empty-${path.basename(firstCanonical)}`,
    );
    const secondPreserved = path.join(
      directory,
      `rollout-cindy-preserved-empty-${path.basename(secondCanonical)}`,
    );
    const firstNative = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/native/first' },
    })}\n`;
    const secondNative = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/native/second' },
    })}\n`;
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(firstCanonical, firstNative);
    fs.linkSync(firstCanonical, firstPreserved);
    fs.writeFileSync(secondPreserved, '');

    const realLstat = fs.lstatSync.bind(fs);
    let secondPreservedLstatCount = 0;
    let filled = false;
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike) => {
      const observed = realLstat(file);
      if (
        !filled
        && path.resolve(file.toString()) === path.resolve(secondPreserved)
      ) {
        secondPreservedLstatCount += 1;
        // Strict planning and snapshot capture use four probes; the native CAS
        // pre-guard uses two more. The seventh starts its post-UPDATE guard.
        if (secondPreservedLstatCount === 7) {
          fs.writeFileSync(secondPreserved, secondNative);
          filled = true;
        }
      }
      return observed;
    }) as typeof fs.lstatSync);
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /state changed before native rollout reconciliation/,
      );
    } finally {
      lstatSpy.mockRestore();
    }

    expect(filled).toBe(true);
    let targetDb = new Database(targetDbPath, { readonly: true });
    let targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(externalRollout);
    expect(fs.readFileSync(firstCanonical, 'utf-8')).toBe(firstNative);
    expect(fs.existsSync(secondCanonical)).toBe(false);
    expect(fs.readFileSync(secondPreserved, 'utf-8')).toBe(secondNative);

    await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
      /multiple native private rollouts conflict before state handoff/,
    );
    targetDb = new Database(targetDbPath, { readonly: true });
    targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(externalRollout);
  });

  it('rolls back a copied-rollout inode swap before updating an existing state pointer', async () => {
    const sourceRollout = path.join(
      externalHome,
      'sessions',
      `rollout-2026-07-14-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(sourceRollout), { recursive: true });
    fs.writeFileSync(sourceRollout, 'EXTERNAL_FULL_ROLLOUT');
    const sourceDbPath = createStateDb(externalHome);
    insertThread(sourceDbPath, threadId, sourceRollout, { updatedAt: 2_000 });
    const targetDbPath = createStateDb(desktopHome());
    insertThread(targetDbPath, threadId, sourceRollout, { updatedAt: 3_000 });

    const realLink = fs.promises.link.bind(fs.promises);
    const realLstat = fs.lstatSync.bind(fs);
    let candidate: string | null = null;
    let candidateLstatCount = 0;
    let swapped = false;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (
        source.toString().includes('.migration-tmp')
        && path.resolve(target.toString()).startsWith(path.resolve(desktopHome()))
      ) candidate = path.resolve(target.toString());
    });
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike) => {
      const observed = realLstat(file);
      if (candidate && path.resolve(file.toString()) === candidate) {
        candidateLstatCount += 1;
        if (!swapped && candidateLstatCount === 9) {
          const validatedInode = `${candidate}.validated-inode`;
          fs.renameSync(candidate, validatedInode);
          fs.copyFileSync(validatedInode, candidate);
          swapped = true;
        }
      }
      return observed;
    }) as typeof fs.lstatSync);

    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /external rollout pointer changed during private adoption/,
      );
    } finally {
      lstatSpy.mockRestore();
      linkSpy.mockRestore();
    }

    expect(swapped).toBe(true);
    let targetDb = new Database(targetDbPath, { readonly: true });
    let targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(sourceRollout);

    const recovered = await prepareExternalCodexSessionForResume(threadId);
    expect(recovered).toBe(candidate);
    targetDb = new Database(targetDbPath, { readonly: true });
    targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(candidate);
    expect(fs.readFileSync(candidate!, 'utf-8')).toBe('EXTERNAL_FULL_ROLLOUT');
  });

  it('keeps a missing private pointer when its native writer wakes during external copy', async () => {
    const sourceRollout = path.join(
      externalHome,
      'sessions',
      `rollout-2026-07-14-${threadId}.jsonl`,
    );
    const sourceContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/external/project' },
    })}\n`;
    fs.mkdirSync(path.dirname(sourceRollout), { recursive: true });
    fs.writeFileSync(sourceRollout, sourceContents);
    const sourceDbPath = createStateDb(externalHome);
    insertThread(sourceDbPath, threadId, sourceRollout, { updatedAt: 2_000 });

    const targetDbPath = createStateDb(desktopHome());
    const missingPrivate = path.join(
      desktopHome(),
      'sessions',
      `rollout-2026-07-14-${threadId}.jsonl`,
    );
    insertThread(targetDbPath, threadId, missingPrivate, { updatedAt: 3_000 });
    const nativeContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/native/writer' },
    })}\n`;

    const realLink = fs.promises.link.bind(fs.promises);
    let materialized = false;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      if (
        !materialized
        && source.toString().includes('.migration-tmp')
        && path.basename(target.toString()).startsWith('rollout-cindy-adopted')
      ) {
        fs.mkdirSync(path.dirname(missingPrivate), { recursive: true });
        fs.writeFileSync(missingPrivate, nativeContents);
        materialized = true;
      }
      await realLink(source, target);
    });
    let prepared: string | undefined;
    try {
      prepared = await prepareExternalCodexSessionForResume(threadId);
    } finally {
      linkSpy.mockRestore();
    }

    expect(materialized).toBe(true);
    expect(prepared).toBe(missingPrivate);
    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(missingPrivate);
    expect(fs.readFileSync(missingPrivate, 'utf-8')).toBe(nativeContents);
    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(missingPrivate);
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

  it('adopts an explicitly configured external CODEX_HOME into a private copy (never links the source) (#789)', async () => {
    const sourceRollout = path.join(
      externalHome,
      'sessions',
      `rollout-2026-07-14-${threadId}.jsonl`,
    );
    const sourceDbPath = createStateDb(externalHome);
    fs.mkdirSync(path.dirname(sourceRollout), { recursive: true });
    fs.writeFileSync(sourceRollout, 'EXTERNAL_ROLLOUT');
    insertThread(sourceDbPath, threadId, sourceRollout, { updatedAt: 2_000 });
    const targetDbPath = createStateDb(desktopHome());

    await prepareExternalCodexSessionForResume(threadId);

    const preferredRollout = path.join(desktopHome(), 'sessions', path.basename(sourceRollout));
    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    // State-backed copies stay hidden from the canonical scanner until the
    // transaction selects them, then desktop state points at that private copy.
    expect(targetRow.rolloutPath).not.toBe(preferredRollout);
    expect(path.basename(targetRow.rolloutPath)).toBe(
      `rollout-cindy-adopted-${path.basename(sourceRollout)}`,
    );
    expect(fs.existsSync(preferredRollout)).toBe(false);
    expect(fs.readFileSync(targetRow.rolloutPath, 'utf-8')).toBe('EXTERNAL_ROLLOUT');
    // 源 rollout 原样不动——不再有任何回写通道。
    expect(fs.readFileSync(sourceRollout, 'utf-8')).toBe('EXTERNAL_ROLLOUT');
  });

  it('does not return a non-canonical rollout-only copy without a state pointer', async () => {
    const sourceRollout = path.join(
      externalHome,
      'sessions',
      `rollout-custom-${threadId}.jsonl`,
    );
    const sourceContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/tmp/project' },
    })}\n`;
    fs.mkdirSync(path.dirname(sourceRollout), { recursive: true });
    fs.writeFileSync(sourceRollout, sourceContents);
    const targetDbPath = createStateDb(desktopHome());

    await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
      /not discoverable without state/,
    );

    const privateCopy = path.join(desktopHome(), 'sessions', path.basename(sourceRollout));
    expect(fs.readFileSync(privateCopy, 'utf-8')).toBe(sourceContents);
    const targetDb = new Database(targetDbPath, { readonly: true });
    const stateCount = targetDb
      .prepare('SELECT count(*) AS count FROM threads WHERE id = ?')
      .get(threadId) as { count: number };
    targetDb.close();
    expect(stateCount.count).toBe(0);
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

  it('rolls back when a missing external rollout materializes inside the state-copy transaction', async () => {
    const missingSourceRollout = path.join(
      externalHome,
      'sessions',
      '2026',
      '07',
      '14',
      `rollout-2026-07-14-${threadId}.jsonl`,
    );
    const sourceDbPath = createStateDb(externalHome);
    insertThread(sourceDbPath, threadId, missingSourceRollout, { updatedAt: 2_000 });
    const targetDbPath = createStateDb(desktopHome());
    const sessionId = `local-missing-external-race-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'missing-external-race-c1',
      'user',
      JSON.stringify({ text: 'lossy fallback' }),
      1_000,
    );
    const nativeContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/external/native' },
    })}\n`;

    const realLink = fs.promises.link.bind(fs.promises);
    const realLstat = fs.lstatSync.bind(fs);
    let publicationReady = false;
    let sourceProbeCount = 0;
    let materialized = false;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (path.basename(target.toString()).startsWith('rollout-cindy-empty-recovery')) {
        publicationReady = true;
      }
    });
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike) => {
      if (
        publicationReady
        && !materialized
        && path.resolve(file.toString()) === path.resolve(missingSourceRollout)
      ) {
        sourceProbeCount += 1;
        if (sourceProbeCount === 2) {
          fs.mkdirSync(path.dirname(missingSourceRollout), { recursive: true });
          fs.writeFileSync(missingSourceRollout, nativeContents);
          materialized = true;
        }
      }
      return realLstat(file);
    }) as typeof fs.lstatSync);
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /missing external rollout materialized before state handoff/,
      );
    } finally {
      lstatSpy.mockRestore();
      linkSpy.mockRestore();
    }

    expect(materialized).toBe(true);
    let targetDb = new Database(targetDbPath, { readonly: true });
    const targetCount = targetDb
      .prepare('SELECT count(*) AS count FROM threads WHERE id = ?')
      .get(threadId) as { count: number };
    targetDb.close();
    expect(targetCount.count).toBe(0);

    const adopted = await prepareExternalCodexSessionForResume(threadId);
    expect(fs.readFileSync(adopted!, 'utf-8')).toBe(nativeContents);
    targetDb = new Database(targetDbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(adopted);
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

    insertLocalMessage(sessionId, 'c3', 'user', JSON.stringify({ text: 'new H2' }), 1_200);
    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(rolloutPath);
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

  it('keeps a published no-state H1 authoritative when a fuller source appears later', async () => {
    createStateDb(desktopHome());
    const firstSessionId = `local-first-source-${threadId}`;
    insertLocalCodexSession(firstSessionId, threadId, { createdAt: 1_000, updatedAt: 2_000 });
    insertLocalMessage(firstSessionId, 'first-source-c1', 'user', JSON.stringify({ text: 'H1' }), 1_000);
    await prepareExternalCodexSessionForResume(threadId);

    const firstPath = path.join(
      desktopHome(),
      'sessions',
      '1970',
      '01',
      '01',
      `rollout-1970-01-01T00-00-01-${threadId}.jsonl`,
    );
    expect(fs.readFileSync(firstPath, 'utf-8')).toContain('H1');

    const fullerSessionId = `local-fuller-source-${threadId}`;
    insertLocalCodexSession(fullerSessionId, threadId, { createdAt: 2_000, updatedAt: 3_000 });
    insertLocalMessage(fullerSessionId, 'fuller-source-c1', 'user', JSON.stringify({ text: 'H1' }), 1_000);
    insertLocalMessage(fullerSessionId, 'fuller-source-c2', 'assistant', 'H2', 2_000);

    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(firstPath);

    expect(fs.readFileSync(firstPath, 'utf-8')).not.toContain('H2');
    const secondPath = path.join(
      desktopHome(),
      'sessions',
      '1970',
      '01',
      '01',
      `rollout-1970-01-01T00-00-02-${threadId}.jsonl`,
    );
    expect(fs.existsSync(secondPath)).toBe(false);
  });

  it('converges H1 to H2 before exposing the only no-state canonical path', async () => {
    createStateDb(desktopHome());
    const sessionId = `local-no-state-h1-h2-${threadId}`;
    insertLocalCodexSession(sessionId, threadId, { createdAt: 1_000, updatedAt: 2_000 });
    insertLocalMessage(sessionId, 'no-state-h1', 'user', JSON.stringify({ text: 'no-state H1' }), 1_000);

    const firstPath = path.join(
      desktopHome(),
      'sessions',
      '1970',
      '01',
      '01',
      `rollout-1970-01-01T00-00-01-${threadId}.jsonl`,
    );
    const secondPath = path.join(
      desktopHome(),
      'sessions',
      '1970',
      '01',
      '01',
      `rollout-1970-01-01T00-00-02-${threadId}.jsonl`,
    );
    const realLink = fs.promises.link.bind(fs.promises);
    let advanced = false;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (
        !advanced
        && path.basename(target.toString()).startsWith('.cindy-state-less-recovery')
      ) {
        advanced = true;
        insertLocalMessage(sessionId, 'no-state-h2', 'assistant', 'no-state H2', 1_100);
      }
    });
    try {
      await prepareExternalCodexSessionForResume(threadId);
    } finally {
      linkSpy.mockRestore();
    }

    expect(fs.readFileSync(firstPath, 'utf-8')).toContain('no-state H2');
    expect(fs.existsSync(secondPath)).toBe(false);
    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(firstPath);
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
    expect(fs.readdirSync(path.dirname(rolloutPath)).filter((name) => name.endsWith('.jsonl')))
      .toEqual([path.basename(rolloutPath)]);
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
    const recoveredRollout = await prepareExternalCodexSessionForResume(threadId);
    expect(recoveredRollout).toBeTruthy();
    expect(recoveredRollout).not.toBe(missingRollout);
    expect(fs.existsSync(missingRollout)).toBe(false);

    const lines = fs
      .readFileSync(recoveredRollout!, 'utf-8')
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
    const targetDb = new Database(dbPath, { readonly: true });
    const state = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(state.rolloutPath).toBe(recoveredRollout);
  });

  it('blocks when a private orphan starts materializing during synthetic publication', async () => {
    const dbPath = createStateDb(desktopHome());
    const missingRollout = path.join(
      desktopHome(),
      'sessions',
      `rollout-2026-06-15-${threadId}.jsonl`,
    );
    insertThread(dbPath, threadId, missingRollout, { updatedAt: 2_000 });
    const sessionId = `local-orphan-race-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(sessionId, 'race-c1', 'user', JSON.stringify({ text: 'recover' }), 1_000);

    const realLink = fs.promises.link.bind(fs.promises);
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (
        path.basename(target.toString()).startsWith('rollout-cindy-empty-recovery')
        && !fs.existsSync(missingRollout)
      ) {
        fs.writeFileSync(missingRollout, '');
      }
    });
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /private orphan began materializing/,
      );
    } finally {
      linkSpy.mockRestore();
    }

    expect(fs.readFileSync(missingRollout, 'utf-8')).toBe('');
    const targetDb = new Database(dbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(missingRollout);
  });

  it('keeps a committed recovery when the old private writer wakes afterward', async () => {
    const dbPath = createStateDb(desktopHome());
    const missingRollout = path.join(
      desktopHome(),
      'sessions',
      `rollout-2026-06-15-${threadId}.jsonl`,
    );
    insertThread(dbPath, threadId, missingRollout, { updatedAt: 2_000 });
    const sessionId = `local-post-commit-writer-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'post-commit-c1',
      'user',
      JSON.stringify({ text: 'continue on the committed recovery' }),
      1_000,
    );

    const nativeLateContents = 'NATIVE_WRITER_WOKE_AFTER_COMMIT';
    const realLstat = fs.lstatSync.bind(fs);
    let lateWriterWoke = false;
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation(((candidate: fs.PathLike) => {
      if (
        !lateWriterWoke
        && path.resolve(candidate.toString()) === path.resolve(missingRollout)
        && !fs.existsSync(missingRollout)
      ) {
        try {
          const probe = new Database(dbPath, { readonly: true });
          const row = probe
            .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
            .get(threadId) as { rolloutPath: string };
          probe.close();
          // A separate connection sees the synthetic pointer only after the
          // handoff transaction commits, never during its post-inode check.
          if (row.rolloutPath !== missingRollout) {
            fs.writeFileSync(missingRollout, nativeLateContents);
            lateWriterWoke = true;
          }
        } catch {
          // The writer transaction may still hold the DB; retry on next lstat.
        }
      }
      return realLstat(candidate);
    }) as typeof fs.lstatSync);

    let recovered: string | undefined;
    try {
      recovered = await prepareExternalCodexSessionForResume(threadId);
    } finally {
      lstatSpy.mockRestore();
    }

    expect(lateWriterWoke).toBe(true);
    expect(recovered).toBeTruthy();
    expect(recovered).not.toBe(missingRollout);
    expect(fs.readFileSync(missingRollout, 'utf-8')).toBe(nativeLateContents);
    const targetDb = new Database(dbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(recovered);
    expect(fs.readFileSync(recovered!, 'utf-8')).toContain('continue on the committed recovery');
  });

  it('does not restore a private orphan that materializes as a symbolic link', async () => {
    const dbPath = createStateDb(desktopHome());
    const missingRollout = path.join(
      desktopHome(),
      'sessions',
      `rollout-2026-06-15-${threadId}.jsonl`,
    );
    insertThread(dbPath, threadId, missingRollout, { updatedAt: 2_000 });
    const sessionId = `local-orphan-symlink-race-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(sessionId, 'symlink-race-c1', 'user', JSON.stringify({ text: 'recover' }), 1_000);

    const realLink = fs.promises.link.bind(fs.promises);
    let lstatOverridden = false;
    let restoreLstat = (): void => undefined;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (
        !lstatOverridden
        && path.basename(target.toString()).startsWith('rollout-cindy-empty-recovery')
      ) {
        fs.writeFileSync(missingRollout, 'SIMULATED_EXTERNAL_TARGET');
        const lstatSpy = vi.spyOn(fs, 'lstatSync').mockReturnValue({
          isFile: () => false,
          isSymbolicLink: () => true,
        } as unknown as fs.Stats);
        lstatOverridden = true;
        restoreLstat = () => lstatSpy.mockRestore();
      }
    });
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /private recovery file could not be published safely/,
      );
    } finally {
      restoreLstat();
      linkSpy.mockRestore();
    }

    const targetDb = new Database(dbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(missingRollout);
  });

  it('does not treat a freshly copied empty rollout with an old mtime as stable', async () => {
    const dbPath = createStateDb(desktopHome());
    const emptyRollout = path.join(
      desktopHome(),
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(emptyRollout), { recursive: true });
    fs.writeFileSync(emptyRollout, '');
    const preservedOldMtime = new Date(Date.now() - 20 * 60_000);
    fs.utimesSync(emptyRollout, preservedOldMtime, preservedOldMtime);
    insertThread(dbPath, threadId, emptyRollout, { updatedAt: 2_000 });
    const sessionId = `local-fresh-copy-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(sessionId, 'fresh-copy-c1', 'user', JSON.stringify({ text: 'recover' }), 1_000);

    await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
      /may still be materializing/,
    );

    expect(fs.readFileSync(emptyRollout, 'utf-8')).toBe('');
    expect(fs.readdirSync(path.dirname(emptyRollout))).toEqual([path.basename(emptyRollout)]);
  });

  it('relinks an empty rollout to a recovered copy without overwriting the original (#1554)', async () => {
    const dbPath = createStateDb(desktopHome());
    const emptyRollout = path.join(
      desktopHome(),
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(emptyRollout), { recursive: true });
    fs.writeFileSync(emptyRollout, '');
    markEmptyRolloutStable(emptyRollout);
    insertThread(dbPath, threadId, emptyRollout, { updatedAt: 2_000 });

    const sessionId = `local-empty-rollout-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'c1',
      'user',
      JSON.stringify({ text: 'continue from another device', images: [], files: [] }),
      1_000,
    );
    insertLocalMessage(sessionId, 'c2', 'assistant', 'recover this task', 1_100);

    const [prepared, concurrentPrepared] = await Promise.all([
      prepareExternalCodexSessionForResume(threadId),
      prepareExternalCodexSessionForResume(threadId),
    ]);

    expect(prepared).toBeTruthy();
    expect(concurrentPrepared).toBe(prepared);
    expect(prepared).not.toBe(emptyRollout);
    expect(fs.readFileSync(emptyRollout, 'utf-8')).toBe('');
    const recovered = fs.readFileSync(prepared!, 'utf-8');
    expect(recovered).toContain('continue from another device');
    expect(recovered).toContain('recover this task');
    const stateDb = new Database(dbPath, { readonly: true });
    const state = stateDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    stateDb.close();
    expect(state.rolloutPath).toBe(prepared);

    // 后续终端继续同一任务时复用已发布的恢复文件，不生成新副本。
    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(prepared);
    expect(fs.readFileSync(prepared!, 'utf-8')).toBe(recovered);
  });

  it('rejects an exact-content sibling symlink before changing the state pointer', async () => {
    const dbPath = createStateDb(desktopHome());
    const emptyRollout = path.join(
      desktopHome(),
      'sessions',
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(emptyRollout), { recursive: true });
    fs.writeFileSync(emptyRollout, '');
    markEmptyRolloutStable(emptyRollout);
    insertThread(dbPath, threadId, emptyRollout, { updatedAt: 2_000 });

    const sessionId = `local-exact-symlink-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'exact-symlink-c1',
      'user',
      JSON.stringify({ text: 'recover without crossing the private boundary' }),
      1_000,
    );

    // Model a deterministic candidate that resolves to an external file with
    // exactly the synthetic bytes. stat/open still see those bytes, while lstat
    // exposes the path as a symlink; this stays portable on Windows CI.
    const externalTarget = path.join(rootDir, 'external-exact-synthetic.jsonl');
    const realLink = fs.promises.link.bind(fs.promises);
    const realLstat = fs.lstatSync.bind(fs);
    let syntheticCandidate: string | null = null;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (path.basename(target.toString()).startsWith('rollout-cindy-empty-recovery')) {
        syntheticCandidate = path.resolve(target.toString());
        fs.copyFileSync(syntheticCandidate, externalTarget);
      }
    });
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation(((candidate: fs.PathLike) => {
      const resolved = path.resolve(candidate.toString());
      if (syntheticCandidate && resolved === syntheticCandidate) {
        const externalStat = realLstat(externalTarget);
        return {
          ...externalStat,
          isFile: () => false,
          isSymbolicLink: () => true,
        } as fs.Stats;
      }
      return realLstat(candidate);
    }) as typeof fs.lstatSync);

    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /private recovery file could not be published safely/,
      );
    } finally {
      lstatSpy.mockRestore();
      linkSpy.mockRestore();
    }

    expect(syntheticCandidate).toBeTruthy();
    const externalContents = fs.readFileSync(externalTarget, 'utf-8');
    expect(externalContents).toContain('recover without crossing the private boundary');
    const stateDb = new Database(dbPath, { readonly: true });
    const state = stateDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    stateDb.close();
    expect(state.rolloutPath).toBe(emptyRollout);
    expect(fs.readFileSync(externalTarget, 'utf-8')).toBe(externalContents);
  });

  it('rolls back an inode swap transaction without undoing the next same-path winner', async () => {
    const dbPath = createStateDb(desktopHome());
    const emptyRollout = path.join(
      desktopHome(),
      'sessions',
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(emptyRollout), { recursive: true });
    fs.writeFileSync(emptyRollout, '');
    markEmptyRolloutStable(emptyRollout);
    insertThread(dbPath, threadId, emptyRollout, { updatedAt: 2_000 });

    const sessionId = `local-cas-swap-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'cas-swap-c1',
      'user',
      JSON.stringify({ text: 'keep state bound to the validated inode' }),
      1_000,
    );

    const realLink = fs.promises.link.bind(fs.promises);
    const realOpen = fs.openSync.bind(fs);
    const realClose = fs.closeSync.bind(fs);
    let syntheticCandidate: string | null = null;
    let candidateCloseCount = 0;
    let replaced = false;
    const candidateFds = new Set<number>();
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (path.basename(target.toString()).startsWith('rollout-cindy-empty-recovery')) {
        syntheticCandidate = path.resolve(target.toString());
      }
    });
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation(((file, flags, mode) => {
      const fd = realOpen(file, flags, mode);
      if (syntheticCandidate && path.resolve(file.toString()) === syntheticCandidate) {
        candidateFds.add(fd);
      }
      return fd;
    }) as typeof fs.openSync);
    const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      const isCandidate = candidateFds.delete(fd);
      realClose(fd);
      if (isCandidate && ++candidateCloseCount === 3 && syntheticCandidate) {
        const validatedInode = `${syntheticCandidate}.validated-inode`;
        fs.renameSync(syntheticCandidate, validatedInode);
        fs.copyFileSync(validatedInode, syntheticCandidate);
        replaced = true;
      }
    });

    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /target state changed during private orphan recovery|rollout pointer changed during recovery/,
      );
    } finally {
      closeSpy.mockRestore();
      openSpy.mockRestore();
      linkSpy.mockRestore();
    }

    expect(replaced).toBe(true);
    expect(fs.readFileSync(syntheticCandidate!, 'utf-8')).toContain(
      'keep state bound to the validated inode',
    );
    let stateDb = new Database(dbPath, { readonly: true });
    let state = stateDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    stateDb.close();
    expect(state.rolloutPath).toBe(emptyRollout);
    expect(fs.readFileSync(emptyRollout, 'utf-8')).toBe('');

    // A later recovery validates the replacement inode itself and may commit
    // the same deterministic path; the failed transaction left no stale CAS
    // that can roll this winner back to the empty file.
    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(syntheticCandidate);
    stateDb = new Database(dbPath, { readonly: true });
    state = stateDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    stateDb.close();
    expect(state.rolloutPath).toBe(syntheticCandidate);
  });

  it('does not publish through a sessions directory symlink outside Cindy storage', async () => {
    const dbPath = createStateDb(desktopHome());
    const externalEmpty = path.join(
      externalHome,
      'sessions',
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(externalEmpty), { recursive: true });
    fs.writeFileSync(externalEmpty, '');
    markEmptyRolloutStable(externalEmpty);
    insertThread(dbPath, threadId, externalEmpty, { updatedAt: 2_000 });

    const sessionId = `local-parent-symlink-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'parent-symlink-c1',
      'user',
      JSON.stringify({ text: 'keep recovery inside Cindy storage' }),
      1_000,
    );

    const outsideDirectory = path.join(rootDir, 'outside-cindy-storage');
    fs.mkdirSync(outsideDirectory, { recursive: true });
    fs.symlinkSync(
      outsideDirectory,
      path.join(desktopHome(), 'sessions'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
      /private recovery file could not be published safely/,
    );

    expect(fs.readdirSync(outsideDirectory)).toEqual([]);
    const stateDb = new Database(dbPath, { readonly: true });
    const state = stateDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    stateDb.close();
    expect(state.rolloutPath).toBe(externalEmpty);
    expect(fs.readFileSync(externalEmpty, 'utf-8')).toBe('');
  });

  it('replaces a stable canonical empty when state is lost without relying on scan order', async () => {
    const dbPath = createStateDb(desktopHome());
    const emptyRollout = path.join(
      desktopHome(),
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(emptyRollout), { recursive: true });
    fs.writeFileSync(emptyRollout, '');
    markEmptyRolloutStable(emptyRollout);
    insertThread(dbPath, threadId, emptyRollout, { updatedAt: 2_000 });
    const sessionId = `local-lost-recovery-state-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(sessionId, 'lost-state-c1', 'user', JSON.stringify({ text: 'recover' }), 1_000);

    const recovered = await prepareExternalCodexSessionForResume(threadId);
    expect(recovered).toBeTruthy();
    const canonicalMtime = fs.statSync(emptyRollout).mtimeMs;
    const newerRecoveryTime = new Date(canonicalMtime + 1_000);
    fs.utimesSync(recovered!, newerRecoveryTime, newerRecoveryTime);
    const writableDb = new Database(dbPath);
    writableDb.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
    writableDb.close();

    const recoveredWithoutState = await prepareExternalCodexSessionForResume(threadId);

    expect(recoveredWithoutState).toBe(emptyRollout);
    expect(fs.readFileSync(emptyRollout, 'utf-8')).toContain('recover');
    expect(fs.readFileSync(recovered!, 'utf-8')).toContain('recover');
    const canonicalNames = fs.readdirSync(path.dirname(emptyRollout)).filter(
      (name) => /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/.test(name)
        && name.endsWith(`${threadId}.jsonl`),
    );
    expect(canonicalNames).toEqual([path.basename(emptyRollout)]);
    const preservedEmpty = fs.readdirSync(path.dirname(emptyRollout)).find(
      (name) => name.startsWith('rollout-cindy-preserved-empty'),
    );
    expect(preservedEmpty).toBeTruthy();
    expect(fs.readFileSync(path.join(path.dirname(emptyRollout), preservedEmpty!), 'utf-8')).toBe('');
    const stateDb = new Database(dbPath, { readonly: true });
    const stateCount = stateDb
      .prepare('SELECT count(*) AS count FROM threads WHERE id = ?')
      .get(threadId) as { count: number };
    stateDb.close();
    expect(stateCount.count).toBe(0);

    // A retained native writer may append only after the synthetic handoff.
    // Its Cindy-only artifact must not shadow the already authoritative canonical.
    const canonicalContents = fs.readFileSync(emptyRollout, 'utf-8');
    const lateNative = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/late/native' },
    })}\n`;
    const preservedPath = path.join(path.dirname(emptyRollout), preservedEmpty!);
    fs.writeFileSync(preservedPath, lateNative);
    const later = new Date(Date.now() + 1_000);
    fs.utimesSync(preservedPath, later, later);

    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(emptyRollout);
    expect(fs.readFileSync(emptyRollout, 'utf-8')).toBe(canonicalContents);
    expect(fs.readFileSync(preservedPath, 'utf-8')).toBe(lateNative);
  });

  it('keeps the synthetic canonical when the retained writer fills after link commit', async () => {
    createStateDb(desktopHome());
    const sessionId = `local-post-link-writer-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'post-link-writer-c1',
      'user',
      JSON.stringify({ text: 'canonical link is the irreversible winner' }),
      1_000,
    );
    const canonical = path.join(
      desktopHome(),
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.writeFileSync(canonical, '');
    markEmptyRolloutStable(canonical);
    const nativeLateContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/late/retained-writer' },
    })}\n`;

    const realLinkSync = fs.linkSync.bind(fs);
    let filledAfterLink = false;
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
      const linked = realLinkSync(source, target);
      if (
        !filledAfterLink
        && target.toString() === canonical
        && path.basename(source.toString()).startsWith('.cindy-state-less-recovery')
      ) {
        const preserved = fs.readdirSync(path.dirname(canonical))
          .map((name) => path.join(path.dirname(canonical), name))
          .find((candidate) => path.basename(candidate).startsWith('rollout-cindy-preserved-empty'));
        expect(preserved).toBeTruthy();
        fs.writeFileSync(preserved!, nativeLateContents);
        filledAfterLink = true;
      }
      return linked;
    });

    let prepared: string | undefined;
    try {
      prepared = await prepareExternalCodexSessionForResume(threadId);
    } finally {
      linkSpy.mockRestore();
    }

    expect(filledAfterLink).toBe(true);
    expect(prepared).toBe(canonical);
    expect(fs.readFileSync(canonical, 'utf-8')).toContain(
      'canonical link is the irreversible winner',
    );
    const preserved = fs.readdirSync(path.dirname(canonical))
      .map((name) => path.join(path.dirname(canonical), name))
      .find((candidate) => path.basename(candidate).startsWith('rollout-cindy-preserved-empty'));
    expect(preserved).toBeTruthy();
    expect(fs.readFileSync(preserved!, 'utf-8')).toBe(nativeLateContents);
    expect(fs.readdirSync(path.dirname(canonical)).filter((name) => /^rollout-\d/.test(name))).toEqual([
      path.basename(canonical),
    ]);
  });

  it('keeps one existing full canonical and moves a stable empty out of scanner order', async () => {
    createStateDb(desktopHome());
    const directory = path.join(desktopHome(), 'sessions', '2026', '08', '03');
    const emptyCanonical = path.join(
      directory,
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    const fullCanonical = path.join(
      directory,
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    const fullContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/existing/full' },
    })}\n`;
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(emptyCanonical, '');
    fs.writeFileSync(fullCanonical, fullContents);
    markEmptyRolloutStable(emptyCanonical);

    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(fullCanonical);
    expect(fs.readFileSync(fullCanonical, 'utf-8')).toBe(fullContents);
    const names = fs.readdirSync(directory);
    expect(names.filter((name) => /^rollout-\d/.test(name))).toEqual([
      path.basename(fullCanonical),
    ]);
    expect(names.some((name) => name.startsWith('rollout-cindy-retired-empty'))).toBe(true);
  });

  it('keeps an existing full canonical when a retired empty inode fills during cleanup', async () => {
    createStateDb(desktopHome());
    const directory = path.join(desktopHome(), 'sessions', '2026', '08', '03');
    const emptyCanonical = path.join(
      directory,
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    const fullCanonical = path.join(
      directory,
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    const fullContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/existing/full' },
    })}\n`;
    const lateContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/retired/late-writer' },
    })}\n`;
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(emptyCanonical, '');
    fs.writeFileSync(fullCanonical, fullContents);
    markEmptyRolloutStable(emptyCanonical);

    const realLinkSync = fs.linkSync.bind(fs);
    let filled = false;
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
      const linked = realLinkSync(source, target);
      if (
        !filled
        && source.toString() === emptyCanonical
        && path.basename(target.toString()).startsWith('rollout-cindy-retired-empty')
      ) {
        filled = true;
        fs.writeFileSync(emptyCanonical, lateContents);
      }
      return linked;
    });
    let prepared: string | undefined;
    try {
      prepared = await prepareExternalCodexSessionForResume(threadId);
    } finally {
      linkSpy.mockRestore();
    }

    expect(prepared).toBe(fullCanonical);
    expect(fs.readFileSync(fullCanonical, 'utf-8')).toBe(fullContents);
    expect(fs.existsSync(emptyCanonical)).toBe(false);
    const preserved = fs.readdirSync(directory)
      .map((name) => path.join(directory, name))
      .find((candidate) => path.basename(candidate).startsWith('rollout-cindy-retired-empty'));
    expect(preserved).toBeTruthy();
    expect(fs.readFileSync(preserved!, 'utf-8')).toBe(lateContents);
    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(fullCanonical);
    expect(fs.readdirSync(directory).filter((name) => /^rollout-\d/.test(name))).toEqual([
      path.basename(fullCanonical),
    ]);
  });

  it('retries an interrupted canonical retirement after unlink fails', async () => {
    createStateDb(desktopHome());
    const directory = path.join(desktopHome(), 'sessions', '2026', '08', '03');
    const retiredCanonical = path.join(
      directory,
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    const establishedWinner = path.join(
      directory,
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    const retiredCheckpoint = path.join(
      directory,
      `rollout-cindy-retired-empty-${path.basename(retiredCanonical)}`,
    );
    const retiredContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/retired/checkpoint' },
    })}\n`;
    const winnerContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/established/winner' },
    })}\n`;
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(retiredCanonical, '');
    fs.linkSync(retiredCanonical, retiredCheckpoint);
    fs.writeFileSync(retiredCanonical, retiredContents);
    fs.writeFileSync(establishedWinner, winnerContents);

    const realUnlinkSync = fs.unlinkSync.bind(fs);
    let failed = false;
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((candidate) => {
      if (!failed && candidate.toString() === retiredCanonical) {
        failed = true;
        throw Object.assign(new Error('retirement busy'), { code: 'EPERM' });
      }
      return realUnlinkSync(candidate);
    });
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /interrupted canonical could not be retired/,
      );
    } finally {
      unlinkSpy.mockRestore();
    }

    expect(fs.existsSync(retiredCanonical)).toBe(true);
    expect(fs.readFileSync(retiredCheckpoint, 'utf-8')).toBe(retiredContents);
    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(establishedWinner);
    expect(fs.existsSync(retiredCanonical)).toBe(false);
    expect(fs.readFileSync(retiredCheckpoint, 'utf-8')).toBe(retiredContents);
    expect(fs.readFileSync(establishedWinner, 'utf-8')).toBe(winnerContents);
  });

  it('fails closed for multiple full canonicals without a retirement checkpoint', async () => {
    createStateDb(desktopHome());
    const directory = path.join(desktopHome(), 'sessions', '2026', '08', '03');
    const first = path.join(
      directory,
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    const second = path.join(
      directory,
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(first, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/first' },
    })}\n`);
    fs.writeFileSync(second, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/second' },
    })}\n`);

    await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
      /multiple private canonical rollouts conflict/,
    );
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(second)).toBe(true);
  });

  it('lets an additional stable empty become the native winner before synthetic handoff', async () => {
    createStateDb(desktopHome());
    const sessionId = `local-multiple-empty-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'multiple-empty-c1',
      'user',
      JSON.stringify({ text: 'synthetic fallback must lose' }),
      1_000,
    );
    const directory = path.join(desktopHome(), 'sessions', '2026', '08', '03');
    const primary = path.join(
      directory,
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    const additional = path.join(
      directory,
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    const nativeContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/additional/native' },
    })}\n`;
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(primary, '');
    fs.writeFileSync(additional, '');
    markEmptyRolloutStable(additional);

    const realLinkSync = fs.linkSync.bind(fs);
    let filled = false;
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
      const linked = realLinkSync(source, target);
      if (
        !filled
        && source.toString() === additional
        && path.basename(target.toString()).startsWith('rollout-cindy-preserved-empty')
      ) {
        filled = true;
        fs.writeFileSync(additional, nativeContents);
      }
      return linked;
    });
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /additional private empty canonical materialized before handoff/,
      );
    } finally {
      linkSpy.mockRestore();
    }

    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(additional);
    expect(fs.readFileSync(additional, 'utf-8')).toBe(nativeContents);
    expect(fs.readFileSync(additional, 'utf-8')).not.toContain('synthetic fallback must lose');
    expect(fs.readdirSync(directory).filter((name) => /^rollout-\d/.test(name))).toEqual([
      path.basename(additional),
    ]);
  });

  it('guards an empty interrupted preservation until the next canonical handoff', async () => {
    createStateDb(desktopHome());
    const sessionId = `local-pending-preservation-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'pending-preservation-c1',
      'user',
      JSON.stringify({ text: 'synthetic must wait for historical writer' }),
      1_000,
    );
    const directory = path.join(desktopHome(), 'sessions', '2026', '08', '03');
    const primary = path.join(
      directory,
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    const interruptedCanonical = path.join(
      directory,
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    const interruptedPreserved = path.join(
      directory,
      `rollout-cindy-preserved-empty-${path.basename(interruptedCanonical)}`,
    );
    const nativeContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/historical/late-writer' },
    })}\n`;
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(primary, '');
    fs.writeFileSync(interruptedPreserved, '');
    markEmptyRolloutStable(primary);

    const realLink = fs.promises.link.bind(fs.promises);
    let filled = false;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (!filled && path.basename(target.toString()).startsWith('.cindy-state-less-recovery')) {
        filled = true;
        fs.writeFileSync(interruptedPreserved, nativeContents);
      }
    });
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /interrupted preserved rollout changed before canonical handoff/,
      );
    } finally {
      linkSpy.mockRestore();
    }

    expect(fs.existsSync(primary)).toBe(false);
    expect(fs.existsSync(interruptedCanonical)).toBe(false);
    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(interruptedCanonical);
    expect(fs.readFileSync(interruptedCanonical, 'utf-8')).toBe(nativeContents);
    expect(fs.readFileSync(interruptedCanonical, 'utf-8'))
      .not.toContain('synthetic must wait for historical writer');
  });

  it('does not expose a state-backed external canonical before additional empties pass handoff', async () => {
    createStateDb(desktopHome());
    const directory = path.join(desktopHome(), 'sessions', '2026', '08', '03');
    const primary = path.join(
      directory,
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    const additional = path.join(
      directory,
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(primary, '');
    fs.writeFileSync(additional, '');
    markEmptyRolloutStable(additional);

    const externalRollout = path.join(
      externalHome,
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T13-00-00-${threadId}.jsonl`,
    );
    const externalContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/external/state-backed' },
    })}\n`;
    const nativeContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/additional/late-native' },
    })}\n`;
    fs.mkdirSync(path.dirname(externalRollout), { recursive: true });
    fs.writeFileSync(externalRollout, externalContents);
    const externalDbPath = createStateDb(externalHome);
    insertThread(externalDbPath, threadId, externalRollout, { updatedAt: 2_000 });

    const realLink = fs.promises.link.bind(fs.promises);
    let filled = false;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (!filled && path.basename(target.toString()).startsWith('rollout-cindy-adopted')) {
        const preserved = fs.readdirSync(directory)
          .map((name) => path.join(directory, name))
          .find((candidate) => (
            path.basename(candidate).startsWith('rollout-cindy-preserved-empty')
            && path.basename(candidate).endsWith(path.basename(additional))
          ));
        expect(preserved).toBeTruthy();
        fs.writeFileSync(preserved!, nativeContents);
        filled = true;
      }
    });
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /additional private rollout changed before canonical handoff/,
      );
    } finally {
      linkSpy.mockRestore();
    }

    const preferredExternalCanonical = path.join(
      desktopHome(),
      path.relative(externalHome, externalRollout),
    );
    expect(fs.existsSync(preferredExternalCanonical)).toBe(false);
    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(additional);
    expect(fs.readFileSync(additional, 'utf-8')).toBe(nativeContents);
    expect(fs.readFileSync(externalRollout, 'utf-8')).toBe(externalContents);
    expect(fs.readdirSync(directory).filter((name) => /^rollout-\d/.test(name))).toEqual([
      path.basename(additional),
    ]);
  });

  it('blocks an existing full canonical while another same-thread empty is recent', async () => {
    createStateDb(desktopHome());
    const directory = path.join(desktopHome(), 'sessions', '2026', '08', '03');
    const emptyCanonical = path.join(
      directory,
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    const fullCanonical = path.join(
      directory,
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(emptyCanonical, '');
    fs.writeFileSync(fullCanonical, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/existing/full' },
    })}\n`);

    await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
      /private rollout may still be materializing/,
    );
    expect(fs.existsSync(emptyCanonical)).toBe(true);
    expect(fs.existsSync(fullCanonical)).toBe(true);
  });

  it('restores one interrupted native canonical after moving another stable empty aside', async () => {
    createStateDb(desktopHome());
    const directory = path.join(desktopHome(), 'sessions', '2026', '08', '03');
    const emptyCanonical = path.join(
      directory,
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    const nativeCanonical = path.join(
      directory,
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    const preservedNative = path.join(
      directory,
      `rollout-cindy-preserved-empty-${path.basename(nativeCanonical)}`,
    );
    const nativeContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/interrupted/native' },
    })}\n`;
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(emptyCanonical, '');
    fs.writeFileSync(preservedNative, nativeContents);
    markEmptyRolloutStable(emptyCanonical);

    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(nativeCanonical);
    expect(fs.readFileSync(nativeCanonical, 'utf-8')).toBe(nativeContents);
    expect(fs.readdirSync(directory).filter((name) => /^rollout-\d/.test(name))).toEqual([
      path.basename(nativeCanonical),
    ]);
  });

  it('does not restore an interrupted native canonical beside a recent empty writer', async () => {
    createStateDb(desktopHome());
    const directory = path.join(desktopHome(), 'sessions', '2026', '08', '03');
    const recentEmpty = path.join(
      directory,
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    const nativeCanonical = path.join(
      directory,
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    const preservedNative = path.join(
      directory,
      `rollout-cindy-preserved-empty-${path.basename(nativeCanonical)}`,
    );
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(recentEmpty, '');
    fs.writeFileSync(preservedNative, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/interrupted/native' },
    })}\n`);

    await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
      /private rollout may still be materializing/,
    );
    expect(fs.existsSync(nativeCanonical)).toBe(false);
    expect(fs.existsSync(recentEmpty)).toBe(true);
  });

  it('adopts a rollout-only external source over a differently named stable canonical empty', async () => {
    createStateDb(desktopHome());
    const targetDirectory = path.join(desktopHome(), 'sessions', '2026', '08', '03');
    const emptyCanonical = path.join(
      targetDirectory,
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    fs.mkdirSync(targetDirectory, { recursive: true });
    fs.writeFileSync(emptyCanonical, '');
    markEmptyRolloutStable(emptyCanonical);

    const externalRollout = path.join(
      externalHome,
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    const externalContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/external/full' },
    })}\n${rolloutLine(
      'rollout-only-m1',
      'user',
      'preserve all external bytes',
      '2026-08-03T12:00:01.000Z',
    )}\n`;
    fs.mkdirSync(path.dirname(externalRollout), { recursive: true });
    fs.writeFileSync(externalRollout, externalContents);

    const prepared = await prepareExternalCodexSessionForResume(threadId);

    expect(prepared).toBe(emptyCanonical);
    expect(fs.readFileSync(emptyCanonical, 'utf-8')).toBe(externalContents);
    expect(fs.readFileSync(externalRollout, 'utf-8')).toBe(externalContents);
    const canonicalNames = fs.readdirSync(targetDirectory).filter(
      (name) => /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/.test(name)
        && name.endsWith(`${threadId}.jsonl`),
    );
    expect(canonicalNames).toEqual([path.basename(emptyCanonical)]);
  });

  it('rejects a same-content staging inode swap before full state-less publication', async () => {
    createStateDb(desktopHome());
    const targetDirectory = path.join(desktopHome(), 'sessions', '2026', '08', '03');
    const canonical = path.join(
      targetDirectory,
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    fs.mkdirSync(targetDirectory, { recursive: true });
    fs.writeFileSync(canonical, '');
    markEmptyRolloutStable(canonical);

    const externalRollout = path.join(
      externalHome,
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    const externalContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/external/full' },
    })}\n`;
    fs.mkdirSync(path.dirname(externalRollout), { recursive: true });
    fs.writeFileSync(externalRollout, externalContents);

    const realLinkSync = fs.linkSync.bind(fs);
    let swapped = false;
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
      if (
        !swapped
        && path.resolve(target.toString()) === path.resolve(canonical)
        && path.basename(source.toString()).startsWith('rollout-cindy-adopted')
      ) {
        const stagedPath = source.toString();
        const capturedInode = `${stagedPath}.captured-inode`;
        fs.renameSync(stagedPath, capturedInode);
        fs.copyFileSync(capturedInode, stagedPath);
        swapped = true;
      }
      return realLinkSync(source, target);
    });
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /external rollout publication changed before handoff/,
      );
    } finally {
      linkSpy.mockRestore();
    }

    expect(swapped).toBe(true);
    expect(fs.readFileSync(canonical, 'utf-8')).toBe('');
    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(canonical);
    expect(fs.readFileSync(canonical, 'utf-8')).toBe(externalContents);
  });

  it('keeps the external canonical when a retained writer fills after link commit', async () => {
    createStateDb(desktopHome());
    const directory = path.join(desktopHome(), 'sessions', '2026', '08', '03');
    const canonical = path.join(
      directory,
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(canonical, '');
    markEmptyRolloutStable(canonical);

    const externalRollout = path.join(
      externalHome,
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    const externalContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/external/full' },
    })}\n`;
    const nativeContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/retained/local-writer' },
    })}\n`;
    fs.mkdirSync(path.dirname(externalRollout), { recursive: true });
    fs.writeFileSync(externalRollout, externalContents);

    const realLinkSync = fs.linkSync.bind(fs);
    let filled = false;
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
      const linked = realLinkSync(source, target);
      if (
        !filled
        && target.toString() === canonical
        && path.basename(source.toString()).startsWith('rollout-cindy-adopted')
      ) {
        const preserved = fs.readdirSync(directory)
          .map((name) => path.join(directory, name))
          .find((candidate) => path.basename(candidate).startsWith('rollout-cindy-preserved-empty'));
        expect(preserved).toBeTruthy();
        fs.writeFileSync(preserved!, nativeContents);
        filled = true;
      }
      return linked;
    });
    let prepared: string | undefined;
    try {
      prepared = await prepareExternalCodexSessionForResume(threadId);
    } finally {
      linkSpy.mockRestore();
    }

    expect(prepared).toBe(canonical);
    expect(fs.readFileSync(canonical, 'utf-8')).toBe(externalContents);
    expect(fs.readFileSync(externalRollout, 'utf-8')).toBe(externalContents);
    const preserved = fs.readdirSync(directory)
      .map((name) => path.join(directory, name))
      .find((candidate) => path.basename(candidate).startsWith('rollout-cindy-preserved-empty'));
    expect(preserved).toBeTruthy();
    expect(fs.readFileSync(preserved!, 'utf-8')).toBe(nativeContents);
    expect(fs.readdirSync(directory).filter((name) => /^rollout-\d/.test(name))).toEqual([
      path.basename(canonical),
    ]);
  });

  it('retries when rollback leaves a same-inode preservation alias beside the canonical', async () => {
    createStateDb(desktopHome());
    const sessionId = `local-stale-preservation-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'stale-preservation-c1',
      'user',
      JSON.stringify({ text: 'recover after stale preservation alias' }),
      1_000,
    );
    const canonical = path.join(
      desktopHome(),
      'sessions',
      '1970',
      '01',
      '01',
      `rollout-1970-01-01T00-00-01-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.writeFileSync(canonical, '');
    markEmptyRolloutStable(canonical);

    const realLinkSync = fs.linkSync.bind(fs);
    const realUnlinkSync = fs.unlinkSync.bind(fs);
    let publicationFailed = false;
    let cleanupFailed = false;
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
      if (
        !publicationFailed
        && target.toString() === canonical
        && path.basename(source.toString()).startsWith('.cindy-state-less-recovery')
      ) {
        publicationFailed = true;
        throw Object.assign(new Error('publication denied'), { code: 'EPERM' });
      }
      return realLinkSync(source, target);
    });
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((candidate) => {
      if (
        publicationFailed
        && !cleanupFailed
        && fs.existsSync(canonical)
        && path.basename(candidate.toString()).startsWith('rollout-cindy-preserved-empty')
      ) {
        cleanupFailed = true;
        throw Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
      }
      return realUnlinkSync(candidate);
    });
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /state-less empty rollout recovery failed/,
      );
    } finally {
      unlinkSpy.mockRestore();
      linkSpy.mockRestore();
    }

    const preservedPath = fs.readdirSync(path.dirname(canonical))
      .map((name) => path.join(path.dirname(canonical), name))
      .find((candidate) => path.basename(candidate).startsWith('rollout-cindy-preserved-empty'));
    expect(preservedPath).toBeTruthy();
    expect(fs.statSync(preservedPath!).ino).toBe(fs.statSync(canonical).ino);
    markEmptyRolloutStable(canonical);

    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(canonical);
    expect(fs.readFileSync(canonical, 'utf-8')).toContain('recover after stale preservation alias');
  });

  it('retries from filtered artifacts when publication and canonical restoration both fail', async () => {
    createStateDb(desktopHome());
    const sessionId = `local-missing-after-rollback-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'missing-after-rollback-c1',
      'user',
      JSON.stringify({ text: 'recover after canonical stayed missing' }),
      1_000,
    );
    const canonical = path.join(
      desktopHome(),
      'sessions',
      '1970',
      '01',
      '01',
      `rollout-1970-01-01T00-00-01-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.writeFileSync(canonical, '');
    markEmptyRolloutStable(canonical);

    const realLinkSync = fs.linkSync.bind(fs);
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
      if (
        target.toString() === canonical
        && (
          path.basename(source.toString()).startsWith('.cindy-state-less-recovery')
          || path.basename(source.toString()).startsWith('rollout-cindy-preserved-empty')
        )
      ) {
        throw Object.assign(new Error('canonical link failed'), { code: 'EIO' });
      }
      return realLinkSync(source, target);
    });
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /state-less empty rollout recovery failed/,
      );
    } finally {
      linkSpy.mockRestore();
    }

    expect(fs.existsSync(canonical)).toBe(false);
    expect(fs.readdirSync(path.dirname(canonical)).some(
      (name) => name.startsWith('rollout-cindy-preserved-empty'),
    )).toBe(true);
    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(canonical);
    expect(fs.readFileSync(canonical, 'utf-8')).toContain('recover after canonical stayed missing');
  });

  it('restores a native writer that fills a preserved inode while canonical restoration is down', async () => {
    createStateDb(desktopHome());
    const sessionId = `local-native-after-crash-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'native-after-crash-c1',
      'user',
      JSON.stringify({ text: 'synthetic must not replace native' }),
      1_000,
    );
    const canonical = path.join(
      desktopHome(),
      'sessions',
      '1970',
      '01',
      '01',
      `rollout-1970-01-01T00-00-01-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.writeFileSync(canonical, '');
    markEmptyRolloutStable(canonical);

    const realLinkSync = fs.linkSync.bind(fs);
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
      if (
        target.toString() === canonical
        && (
          path.basename(source.toString()).startsWith('.cindy-state-less-recovery')
          || path.basename(source.toString()).startsWith('rollout-cindy-preserved-empty')
        )
      ) {
        throw Object.assign(new Error('canonical link failed'), { code: 'EIO' });
      }
      return realLinkSync(source, target);
    });
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /state-less empty rollout recovery failed/,
      );
    } finally {
      linkSpy.mockRestore();
    }

    const preservedPath = fs.readdirSync(path.dirname(canonical))
      .map((name) => path.join(path.dirname(canonical), name))
      .find((candidate) => path.basename(candidate).startsWith('rollout-cindy-preserved-empty'));
    expect(preservedPath).toBeTruthy();
    const nativeContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/native/writer' },
    })}\n${rolloutLine(
      'native-after-crash-m1',
      'assistant',
      'native writer won before handoff',
      '2026-08-03T12:00:00.000Z',
    )}\n`;
    fs.writeFileSync(preservedPath!, nativeContents);

    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(canonical);
    expect(fs.readFileSync(canonical, 'utf-8')).toBe(nativeContents);
  });

  it('copies a valid external rollout beside an empty private adoption target', async () => {
    const sourceRollout = path.join(
      externalHome,
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    const sourceContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/tmp/project' },
    })}\n${rolloutLine('m1', 'user', 'external history', '2026-08-03T11:56:19.000Z')}\n`;
    const sourceDbPath = createStateDb(externalHome);
    fs.mkdirSync(path.dirname(sourceRollout), { recursive: true });
    fs.writeFileSync(sourceRollout, sourceContents);
    insertThread(sourceDbPath, threadId, sourceRollout, { updatedAt: 2_000 });

    const targetDbPath = createStateDb(desktopHome());
    const interruptedTarget = path.join(
      desktopHome(),
      path.relative(externalHome, sourceRollout),
    );
    fs.mkdirSync(path.dirname(interruptedTarget), { recursive: true });
    fs.writeFileSync(interruptedTarget, '');
    markEmptyRolloutStable(interruptedTarget);

    const prepared = await prepareExternalCodexSessionForResume(threadId);

    expect(prepared).toBeTruthy();
    expect(prepared).not.toBe(interruptedTarget);
    expect(fs.readFileSync(sourceRollout, 'utf-8')).toBe(sourceContents);
    expect(fs.existsSync(interruptedTarget)).toBe(false);
    const preservedTarget = fs.readdirSync(path.dirname(interruptedTarget))
      .map((name) => path.join(path.dirname(interruptedTarget), name))
      .find((candidate) => (
        path.basename(candidate).startsWith('rollout-cindy-preserved-empty')
        && path.basename(candidate).endsWith(path.basename(interruptedTarget))
      ));
    expect(preservedTarget).toBeTruthy();
    expect(fs.readFileSync(preservedTarget!, 'utf-8')).toBe('');
    expect(fs.readFileSync(prepared!, 'utf-8')).toBe(sourceContents);
    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(prepared);
  });

  it.each(['full', 'empty', 'missing'] as const)(
    'rolls back a state-backed %s handoff when the primary native writer wakes inside the transaction',
    async (sourceKind) => {
      const sourceRollout = path.join(
        externalHome,
        'sessions',
        '2026',
        '08',
        '03',
        `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
      );
      const externalContents = `${JSON.stringify({
        type: 'session_meta',
        payload: { id: threadId, cwd: '/external/state-backed' },
      })}\n`;
      fs.mkdirSync(path.dirname(sourceRollout), { recursive: true });
      if (sourceKind === 'full') fs.writeFileSync(sourceRollout, externalContents);
      if (sourceKind === 'empty') {
        fs.writeFileSync(sourceRollout, '');
        markEmptyRolloutStable(sourceRollout);
      }
      const sourceDbPath = createStateDb(externalHome);
      insertThread(sourceDbPath, threadId, sourceRollout, { updatedAt: 2_000 });

      const targetDbPath = createStateDb(desktopHome());
      const primary = path.join(
        desktopHome(),
        'sessions',
        '2026',
        '08',
        '03',
        `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
      );
      fs.mkdirSync(path.dirname(primary), { recursive: true });
      fs.writeFileSync(primary, '');
      markEmptyRolloutStable(primary);
      const sessionId = `local-primary-${sourceKind}-${threadId}`;
      insertLocalCodexSession(sessionId, threadId);
      insertLocalMessage(
        sessionId,
        `primary-${sourceKind}-c1`,
        'user',
        JSON.stringify({ text: 'synthetic fallback must not hide the native writer' }),
        1_000,
      );
      const nativeContents = `${JSON.stringify({
        type: 'session_meta',
        payload: { id: threadId, cwd: `/native/${sourceKind}` },
      })}\n`;

      const realLinkSync = fs.linkSync.bind(fs);
      const realLink = fs.promises.link.bind(fs.promises);
      const realLstat = fs.lstatSync.bind(fs);
      let preservedPrimary: string | null = null;
      let publicationReady = false;
      let preservedLstatCount = 0;
      let filled = false;
      const linkSyncSpy = vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
        const linked = realLinkSync(source, target);
        if (
          path.resolve(source.toString()) === path.resolve(primary)
          && path.basename(target.toString()).startsWith('rollout-cindy-preserved-empty')
        ) preservedPrimary = path.resolve(target.toString());
        return linked;
      });
      const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
        await realLink(source, target);
        if (
          path.resolve(target.toString()).startsWith(path.resolve(desktopHome()))
          && path.basename(target.toString()).startsWith('rollout-cindy-')
        ) publicationReady = true;
      });
      const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike) => {
        const observed = realLstat(file);
        if (
          publicationReady
          && preservedPrimary
          && path.resolve(file.toString()) === preservedPrimary
          && !filled
        ) {
          preservedLstatCount += 1;
          if (preservedLstatCount === 3) {
            fs.writeFileSync(preservedPrimary, nativeContents);
            filled = true;
          }
        }
        return observed;
      }) as typeof fs.lstatSync);

      try {
        await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
          /primary private rollout changed before state handoff/,
        );
      } finally {
        lstatSpy.mockRestore();
        linkSpy.mockRestore();
        linkSyncSpy.mockRestore();
      }

      expect(filled).toBe(true);
      expect(fs.existsSync(primary)).toBe(false);
      expect(preservedPrimary).toBeTruthy();
      expect(fs.readFileSync(preservedPrimary!, 'utf-8')).toBe(nativeContents);
      let targetDb = new Database(targetDbPath, { readonly: true });
      const targetCount = targetDb
        .prepare('SELECT count(*) AS count FROM threads WHERE id = ?')
        .get(threadId) as { count: number };
      targetDb.close();
      expect(targetCount.count).toBe(0);

      expect(await prepareExternalCodexSessionForResume(threadId)).toBe(primary);
      expect(fs.readFileSync(primary, 'utf-8')).toBe(nativeContents);
      targetDb = new Database(targetDbPath, { readonly: true });
      const restoredCount = targetDb
        .prepare('SELECT count(*) AS count FROM threads WHERE id = ?')
        .get(threadId) as { count: number };
      targetDb.close();
      expect(restoredCount.count).toBe(0);
    },
  );

  it('keeps a state-backed publication after commit when the preserved primary writer wakes later', async () => {
    const sourceRollout = path.join(
      externalHome,
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    const sourceContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/external/state-backed' },
    })}\n`;
    fs.mkdirSync(path.dirname(sourceRollout), { recursive: true });
    fs.writeFileSync(sourceRollout, sourceContents);
    const sourceDbPath = createStateDb(externalHome);
    insertThread(sourceDbPath, threadId, sourceRollout, { updatedAt: 2_000 });

    const targetDbPath = createStateDb(desktopHome());
    const primary = path.join(
      desktopHome(),
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(primary), { recursive: true });
    fs.writeFileSync(primary, '');
    markEmptyRolloutStable(primary);
    const nativeContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/native/post-commit' },
    })}\n`;

    const realLinkSync = fs.linkSync.bind(fs);
    const realLink = fs.promises.link.bind(fs.promises);
    const realLstat = fs.lstatSync.bind(fs);
    let preservedPrimary: string | null = null;
    let publication: string | null = null;
    let filledAfterCommit = false;
    const linkSyncSpy = vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
      const linked = realLinkSync(source, target);
      if (
        path.resolve(source.toString()) === path.resolve(primary)
        && path.basename(target.toString()).startsWith('rollout-cindy-preserved-empty')
      ) preservedPrimary = path.resolve(target.toString());
      return linked;
    });
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (path.basename(target.toString()).startsWith('rollout-cindy-adopted')) {
        publication = path.resolve(target.toString());
      }
    });
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike) => {
      if (
        publication
        && preservedPrimary
        && !filledAfterCommit
        && path.resolve(file.toString()) === publication
      ) {
        let probe: Database.Database | null = null;
        try {
          probe = new Database(targetDbPath, { readonly: true });
          const row = probe
            .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
            .get(threadId) as { rolloutPath?: string } | undefined;
          if (row?.rolloutPath === publication) {
            fs.writeFileSync(preservedPrimary, nativeContents);
            filledAfterCommit = true;
          }
        } catch {
          // The IMMEDIATE transaction has not committed yet.
        } finally {
          probe?.close();
        }
      }
      return realLstat(file);
    }) as typeof fs.lstatSync);

    let prepared: string | undefined;
    try {
      prepared = await prepareExternalCodexSessionForResume(threadId);
    } finally {
      lstatSpy.mockRestore();
      linkSpy.mockRestore();
      linkSyncSpy.mockRestore();
    }

    expect(filledAfterCommit).toBe(true);
    expect(prepared).toBe(publication);
    expect(fs.existsSync(primary)).toBe(false);
    expect(fs.readFileSync(preservedPrimary!, 'utf-8')).toBe(nativeContents);
    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(publication);
    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(publication);
    expect(fs.readFileSync(publication!, 'utf-8')).toBe(sourceContents);
  });

  it('reconciles a pre-handoff native writer after a concurrent external row survives rollback', async () => {
    const sourceRollout = path.join(
      externalHome,
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    const sourceContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/external/concurrent-row' },
    })}\n`;
    fs.mkdirSync(path.dirname(sourceRollout), { recursive: true });
    fs.writeFileSync(sourceRollout, sourceContents);
    const sourceDbPath = createStateDb(externalHome);
    insertThread(sourceDbPath, threadId, sourceRollout, { updatedAt: 2_000 });

    const targetDbPath = createStateDb(desktopHome());
    const primary = path.join(
      desktopHome(),
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(primary), { recursive: true });
    fs.writeFileSync(primary, '');
    markEmptyRolloutStable(primary);
    const nativeContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/native/concurrent-row' },
    })}\n`;

    const realLinkSync = fs.linkSync.bind(fs);
    const realLink = fs.promises.link.bind(fs.promises);
    const realLstat = fs.lstatSync.bind(fs);
    let preservedPrimary: string | null = null;
    let publicationReady = false;
    let preservedLstatCount = 0;
    let filled = false;
    const linkSyncSpy = vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
      const linked = realLinkSync(source, target);
      if (
        path.resolve(source.toString()) === path.resolve(primary)
        && path.basename(target.toString()).startsWith('rollout-cindy-preserved-empty')
      ) preservedPrimary = path.resolve(target.toString());
      return linked;
    });
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (
        !publicationReady
        && path.basename(target.toString()).startsWith('rollout-cindy-adopted')
      ) {
        insertThread(targetDbPath, threadId, sourceRollout, { updatedAt: 3_000 });
        publicationReady = true;
      }
    });
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike) => {
      const observed = realLstat(file);
      if (
        publicationReady
        && preservedPrimary
        && !filled
        && path.resolve(file.toString()) === preservedPrimary
      ) {
        preservedLstatCount += 1;
        if (preservedLstatCount === 3) {
          fs.writeFileSync(preservedPrimary, nativeContents);
          filled = true;
        }
      }
      return observed;
    }) as typeof fs.lstatSync);
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /concurrent state prevented safe private adoption/,
      );
    } finally {
      lstatSpy.mockRestore();
      linkSpy.mockRestore();
      linkSyncSpy.mockRestore();
    }

    expect(filled).toBe(true);
    let targetDb = new Database(targetDbPath, { readonly: true });
    let targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(sourceRollout);
    expect(fs.existsSync(primary)).toBe(false);
    expect(fs.readFileSync(preservedPrimary!, 'utf-8')).toBe(nativeContents);

    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(primary);
    targetDb = new Database(targetDbPath, { readonly: true });
    targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(primary);
    expect(fs.readFileSync(primary, 'utf-8')).toBe(nativeContents);
    expect(fs.readFileSync(primary, 'utf-8')).not.toBe(sourceContents);
  });

  it('blocks a recent private canonical writer before considering an external rollout', async () => {
    const sourceRollout = path.join(
      externalHome,
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    const sourceContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/tmp/project' },
    })}\n`;
    fs.mkdirSync(path.dirname(sourceRollout), { recursive: true });
    fs.writeFileSync(sourceRollout, sourceContents);
    const sourceDbPath = createStateDb(externalHome);
    insertThread(sourceDbPath, threadId, sourceRollout, { updatedAt: 2_000 });
    const targetDbPath = createStateDb(desktopHome());
    const privateCanonical = path.join(desktopHome(), path.relative(externalHome, sourceRollout));
    fs.mkdirSync(path.dirname(privateCanonical), { recursive: true });
    fs.writeFileSync(privateCanonical, '');

    await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
      /private rollout may still be materializing/,
    );

    expect(fs.readFileSync(privateCanonical, 'utf-8')).toBe('');
    expect(fs.readFileSync(sourceRollout, 'utf-8')).toBe(sourceContents);
    const targetDb = new Database(targetDbPath, { readonly: true });
    const stateCount = targetDb
      .prepare('SELECT count(*) AS count FROM threads WHERE id = ?')
      .get(threadId) as { count: number };
    targetDb.close();
    expect(stateCount.count).toBe(0);
  });

  it('blocks a recent private canonical created between state-backed recovery scans', async () => {
    const sourceRollout = path.join(
      externalHome,
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    const sourceContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/external/state-backed-race' },
    })}\n`;
    fs.mkdirSync(path.dirname(sourceRollout), { recursive: true });
    fs.writeFileSync(sourceRollout, sourceContents);
    const targetDbPath = createStateDb(desktopHome());
    insertThread(targetDbPath, threadId, sourceRollout, { updatedAt: 3_000 });

    const targetSessionsDir = path.join(desktopHome(), 'sessions');
    const privateCanonical = path.join(
      targetSessionsDir,
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    fs.mkdirSync(targetSessionsDir, { recursive: true });
    const injection = materializeAfterInitialPrivateCanonicalScan(
      targetSessionsDir,
      () => fs.writeFileSync(privateCanonical, ''),
    );
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /private rollout may still be materializing/,
      );
    } finally {
      injection.restore();
    }

    expect(injection.didMaterialize()).toBe(true);
    expect(fs.readFileSync(privateCanonical, 'utf-8')).toBe('');
    expect(fs.readdirSync(targetSessionsDir)).toEqual([path.basename(privateCanonical)]);
    expect(fs.readFileSync(sourceRollout, 'utf-8')).toBe(sourceContents);
    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(sourceRollout);
  });

  it('blocks a recent private canonical before recovering a missing external pointer', async () => {
    const missingSourceRollout = path.join(
      externalHome,
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    const targetDbPath = createStateDb(desktopHome());
    insertThread(targetDbPath, threadId, missingSourceRollout, { updatedAt: 3_000 });
    const sessionId = `local-missing-external-second-scan-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'missing-external-second-scan-c1',
      'user',
      JSON.stringify({ text: 'synthetic recovery must wait' }),
      1_000,
    );

    const targetSessionsDir = path.join(desktopHome(), 'sessions');
    const privateCanonical = path.join(
      targetSessionsDir,
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    fs.mkdirSync(targetSessionsDir, { recursive: true });
    const injection = materializeAfterInitialPrivateCanonicalScan(
      targetSessionsDir,
      () => fs.writeFileSync(privateCanonical, ''),
    );
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /private rollout may still be materializing/,
      );
    } finally {
      injection.restore();
    }

    expect(injection.didMaterialize()).toBe(true);
    expect(fs.readFileSync(privateCanonical, 'utf-8')).toBe('');
    expect(fs.readdirSync(targetSessionsDir)).toEqual([path.basename(privateCanonical)]);
    expect(fs.existsSync(missingSourceRollout)).toBe(false);
    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(missingSourceRollout);
  });

  it('retries a full private canonical created between state-backed recovery scans', async () => {
    const sourceRollout = path.join(
      externalHome,
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(sourceRollout), { recursive: true });
    fs.writeFileSync(sourceRollout, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/external/state-backed-race' },
    })}\n`);
    const targetDbPath = createStateDb(desktopHome());
    insertThread(targetDbPath, threadId, sourceRollout, { updatedAt: 3_000 });

    const targetSessionsDir = path.join(desktopHome(), 'sessions');
    const privateCanonical = path.join(
      targetSessionsDir,
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    const nativeContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/native/second-scan-winner' },
    })}\n`;
    fs.mkdirSync(targetSessionsDir, { recursive: true });
    const injection = materializeAfterInitialPrivateCanonicalScan(
      targetSessionsDir,
      () => fs.writeFileSync(privateCanonical, nativeContents),
    );
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /private canonical rollout materialized during recovery planning/,
      );
    } finally {
      injection.restore();
    }

    expect(injection.didMaterialize()).toBe(true);
    expect(fs.readFileSync(privateCanonical, 'utf-8')).toBe(nativeContents);
    let targetDb = new Database(targetDbPath, { readonly: true });
    let targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(sourceRollout);

    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(privateCanonical);
    targetDb = new Database(targetDbPath, { readonly: true });
    targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(privateCanonical);
    expect(fs.readFileSync(privateCanonical, 'utf-8')).toBe(nativeContents);
  });

  it('blocks a recent different canonical created during hidden external adoption', async () => {
    const sourceRollout = path.join(
      externalHome,
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    const sourceContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/external/hidden-adoption' },
    })}\n`;
    fs.mkdirSync(path.dirname(sourceRollout), { recursive: true });
    fs.writeFileSync(sourceRollout, sourceContents);
    const targetDbPath = createStateDb(desktopHome());
    insertThread(targetDbPath, threadId, sourceRollout, { updatedAt: 3_000 });

    const privateCanonical = path.join(
      desktopHome(),
      'sessions',
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    const preferredAdoption = path.join(desktopHome(), path.relative(externalHome, sourceRollout));
    const realLink = fs.promises.link.bind(fs.promises);
    let materialized = false;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (
        !materialized
        && path.basename(target.toString()).startsWith('rollout-cindy-adopted')
      ) {
        fs.mkdirSync(path.dirname(privateCanonical), { recursive: true });
        fs.writeFileSync(privateCanonical, '');
        materialized = true;
      }
    });
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /external rollout pointer changed during private adoption/,
      );
    } finally {
      linkSpy.mockRestore();
    }

    expect(materialized).toBe(true);
    expect(fs.readFileSync(privateCanonical, 'utf-8')).toBe('');
    expect(fs.existsSync(preferredAdoption)).toBe(false);
    expect(fs.readFileSync(sourceRollout, 'utf-8')).toBe(sourceContents);
    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(sourceRollout);
  });

  it('rolls back when a different canonical appears after the state update', async () => {
    const sourceRollout = path.join(
      externalHome,
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(sourceRollout), { recursive: true });
    fs.writeFileSync(sourceRollout, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/external/post-update-race' },
    })}\n`);
    const targetDbPath = createStateDb(desktopHome());
    insertThread(targetDbPath, threadId, sourceRollout, { updatedAt: 3_000 });

    const targetSessionsDir = path.join(desktopHome(), 'sessions');
    const privateCanonical = path.join(
      targetSessionsDir,
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    const nativeContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/native/post-update-winner' },
    })}\n`;
    const realLink = fs.promises.link.bind(fs.promises);
    const realReaddirSync = fs.readdirSync;
    let publicationReady = false;
    let namespaceScanCount = 0;
    let materialized = false;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (path.basename(target.toString()).startsWith('rollout-cindy-adopted')) {
        publicationReady = true;
      }
    });
    const readdirSpy = vi.spyOn(fs, 'readdirSync').mockImplementation((function (
      directory: fs.PathLike,
      options?: unknown,
    ) {
      if (
        publicationReady
        && path.resolve(directory.toString()) === path.resolve(targetSessionsDir)
      ) {
        namespaceScanCount += 1;
        // The first scan is the pre-UPDATE guard; inject into the second so
        // throwing from the post-UPDATE guard must roll the transaction back.
        if (namespaceScanCount === 2) {
          fs.writeFileSync(privateCanonical, nativeContents);
          materialized = true;
        }
      }
      return Reflect.apply(realReaddirSync, fs, [directory, options]);
    }) as typeof fs.readdirSync);
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /external rollout pointer changed during private adoption/,
      );
    } finally {
      readdirSpy.mockRestore();
      linkSpy.mockRestore();
    }

    expect(materialized).toBe(true);
    expect(namespaceScanCount).toBeGreaterThanOrEqual(2);
    expect(fs.readFileSync(privateCanonical, 'utf-8')).toBe(nativeContents);
    let targetDb = new Database(targetDbPath, { readonly: true });
    let targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(sourceRollout);

    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(privateCanonical);
    targetDb = new Database(targetDbPath, { readonly: true });
    targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(privateCanonical);
  });

  it('keeps a missing private pointer when another canonical appears during fallback copy', async () => {
    const sourceRollout = path.join(
      externalHome,
      'sessions',
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(sourceRollout), { recursive: true });
    fs.writeFileSync(sourceRollout, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/external/private-missing-race' },
    })}\n`);
    const sourceDbPath = createStateDb(externalHome);
    insertThread(sourceDbPath, threadId, sourceRollout, { updatedAt: 2_000 });

    const targetDbPath = createStateDb(desktopHome());
    const missingPrivate = path.join(
      desktopHome(),
      'sessions',
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    const privateCanonical = path.join(
      desktopHome(),
      'sessions',
      `rollout-2026-08-03T13-00-00-${threadId}.jsonl`,
    );
    const nativeContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/native/private-missing-winner' },
    })}\n`;
    insertThread(targetDbPath, threadId, missingPrivate, { updatedAt: 3_000 });

    const realLink = fs.promises.link.bind(fs.promises);
    let materialized = false;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (
        !materialized
        && path.basename(target.toString()).startsWith('rollout-cindy-adopted')
      ) {
        fs.writeFileSync(privateCanonical, nativeContents);
        materialized = true;
      }
    });
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /private orphan pointer changed during adoption/,
      );
    } finally {
      linkSpy.mockRestore();
    }

    expect(materialized).toBe(true);
    expect(fs.existsSync(missingPrivate)).toBe(false);
    expect(fs.readFileSync(privateCanonical, 'utf-8')).toBe(nativeContents);
    let targetDb = new Database(targetDbPath, { readonly: true });
    let targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(missingPrivate);

    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(privateCanonical);
    targetDb = new Database(targetDbPath, { readonly: true });
    targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(privateCanonical);
  });

  it('rejects a second canonical before returning a state-pointed native winner', async () => {
    const targetDbPath = createStateDb(desktopHome());
    const targetDirectory = path.join(desktopHome(), 'sessions', '2026', '08', '03');
    const primaryCanonical = path.join(
      targetDirectory,
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    const secondCanonical = path.join(
      targetDirectory,
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    const primaryContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/native/state-primary' },
    })}\n`;
    const secondContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/native/state-second' },
    })}\n`;
    fs.mkdirSync(targetDirectory, { recursive: true });
    fs.writeFileSync(primaryCanonical, '');
    markEmptyRolloutStable(primaryCanonical);
    insertThread(targetDbPath, threadId, primaryCanonical, { updatedAt: 3_000 });
    const sessionId = `local-state-native-return-race-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'state-native-return-race-c1',
      'user',
      JSON.stringify({ text: 'do not return into a split canonical namespace' }),
      1_000,
    );

    const realLink = fs.promises.link.bind(fs.promises);
    let materialized = false;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (
        !materialized
        && path.basename(target.toString()).startsWith('rollout-cindy-empty-recovery')
      ) {
        fs.writeFileSync(primaryCanonical, primaryContents);
        fs.writeFileSync(secondCanonical, secondContents);
        materialized = true;
      }
    });
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /canonical rollout namespace changed during recovery handoff/,
      );
    } finally {
      linkSpy.mockRestore();
    }

    expect(materialized).toBe(true);
    expect(fs.readFileSync(primaryCanonical, 'utf-8')).toBe(primaryContents);
    expect(fs.readFileSync(secondCanonical, 'utf-8')).toBe(secondContents);
    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(primaryCanonical);
  });

  it('rejects a late canonical before returning a committed state-backed copy', async () => {
    const sourceRollout = path.join(
      externalHome,
      'sessions',
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    const sourceContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/external/state-return-race' },
    })}\n`;
    fs.mkdirSync(path.dirname(sourceRollout), { recursive: true });
    fs.writeFileSync(sourceRollout, sourceContents);
    const targetDbPath = createStateDb(desktopHome());
    insertThread(targetDbPath, threadId, sourceRollout, { updatedAt: 3_000 });

    const targetDirectory = path.join(desktopHome(), 'sessions', '2026', '08', '03');
    const lateCanonical = path.join(
      targetDirectory,
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    const lateContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/native/state-return-winner' },
    })}\n`;
    const realLink = fs.promises.link.bind(fs.promises);
    const realLstat = fs.lstatSync.bind(fs);
    let adoptedPath: string | null = null;
    let materialized = false;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (path.basename(target.toString()).startsWith('rollout-cindy-adopted')) {
        adoptedPath = path.resolve(target.toString());
      }
    });
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation(((candidate: fs.PathLike) => {
      if (
        adoptedPath
        && !materialized
        && path.resolve(candidate.toString()) === adoptedPath
      ) {
        let probe: Database.Database | null = null;
        try {
          probe = new Database(targetDbPath, { readonly: true });
          const state = probe
            .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
            .get(threadId) as { rolloutPath: string };
          if (path.resolve(state.rolloutPath) === adoptedPath) {
            fs.mkdirSync(targetDirectory, { recursive: true });
            fs.writeFileSync(lateCanonical, lateContents);
            materialized = true;
          }
        } catch {
          // The state handoff transaction may not have committed yet.
        } finally {
          probe?.close();
        }
      }
      return realLstat(candidate);
    }) as typeof fs.lstatSync);
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /canonical rollout namespace changed during recovery handoff/,
      );
    } finally {
      lstatSpy.mockRestore();
      linkSpy.mockRestore();
    }

    expect(materialized).toBe(true);
    expect(adoptedPath).toBeTruthy();
    expect(fs.readFileSync(adoptedPath!, 'utf-8')).toBe(sourceContents);
    expect(fs.readFileSync(lateCanonical, 'utf-8')).toBe(lateContents);
    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(path.resolve(targetRow.rolloutPath)).toBe(adoptedPath);
    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(adoptedPath);
  });

  it('keeps a state-less external adoption from publishing beside a new native canonical', async () => {
    const sourceRollout = path.join(
      externalHome,
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(sourceRollout), { recursive: true });
    fs.writeFileSync(sourceRollout, `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/external/rollout-only-race' },
    })}\n`);
    const targetDbPath = createStateDb(desktopHome());
    const preferred = path.join(desktopHome(), path.relative(externalHome, sourceRollout));
    const privateCanonical = path.join(
      desktopHome(),
      'sessions',
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    const nativeContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/native/rollout-only-winner' },
    })}\n`;

    const realLink = fs.promises.link.bind(fs.promises);
    let materialized = false;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (
        !materialized
        && path.basename(target.toString()).startsWith('rollout-cindy-adopted')
      ) {
        fs.mkdirSync(path.dirname(privateCanonical), { recursive: true });
        fs.writeFileSync(privateCanonical, nativeContents);
        materialized = true;
      }
    });
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /canonical rollout namespace changed during recovery handoff/,
      );
    } finally {
      linkSpy.mockRestore();
    }

    expect(materialized).toBe(true);
    expect(fs.existsSync(preferred)).toBe(false);
    expect(fs.readFileSync(privateCanonical, 'utf-8')).toBe(nativeContents);
    const targetDb = new Database(targetDbPath, { readonly: true });
    const stateCount = targetDb
      .prepare('SELECT count(*) AS count FROM threads WHERE id = ?')
      .get(threadId) as { count: number };
    targetDb.close();
    expect(stateCount.count).toBe(0);
    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(privateCanonical);
  });

  it('never publishes a rollout-only snapshot directly when the stable canonical disappears', async () => {
    createStateDb(desktopHome());
    const targetDirectory = path.join(desktopHome(), 'sessions', '2026', '08', '03');
    const originalCanonical = path.join(
      targetDirectory,
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    const preservedOriginal = path.join(
      targetDirectory,
      `rollout-cindy-preserved-empty-${path.basename(originalCanonical)}`,
    );
    const nativeCanonical = path.join(
      targetDirectory,
      `rollout-2026-08-03T13-00-00-${threadId}.jsonl`,
    );
    const nativeContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/native/staging-gap-winner' },
    })}\n`;
    fs.mkdirSync(targetDirectory, { recursive: true });
    fs.writeFileSync(originalCanonical, '');
    markEmptyRolloutStable(originalCanonical);

    const sourceRollout = path.join(
      externalHome,
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    const sourceContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/external/staging-gap' },
    })}\n`;
    fs.mkdirSync(path.dirname(sourceRollout), { recursive: true });
    fs.writeFileSync(sourceRollout, sourceContents);

    const realExistsSync = fs.existsSync.bind(fs);
    let materialized = false;
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation((candidate) => {
      const candidatePath = candidate.toString();
      const isPublicationProbe = path.resolve(candidatePath) === path.resolve(originalCanonical)
        || path.basename(candidatePath).startsWith('rollout-cindy-adopted');
      if (!materialized && isPublicationProbe) {
        fs.renameSync(originalCanonical, preservedOriginal);
        fs.writeFileSync(nativeCanonical, nativeContents);
        materialized = true;
      }
      return realExistsSync(candidate);
    });
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /stable empty canonical changed before preservation/,
      );
    } finally {
      existsSpy.mockRestore();
    }

    expect(materialized).toBe(true);
    expect(fs.existsSync(originalCanonical)).toBe(false);
    expect(fs.readFileSync(preservedOriginal, 'utf-8')).toBe('');
    expect(fs.readFileSync(nativeCanonical, 'utf-8')).toBe(nativeContents);
    expect(fs.readFileSync(sourceRollout, 'utf-8')).toBe(sourceContents);
    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(nativeCanonical);
  });

  it('keeps a state-less synthetic handoff from publishing beside a new native canonical', async () => {
    const targetDbPath = createStateDb(desktopHome());
    const sessionId = `local-state-less-namespace-race-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'state-less-namespace-race-c1',
      'user',
      JSON.stringify({ text: 'synthetic must not fork the native history' }),
      1_000,
    );
    const preferred = path.join(
      desktopHome(),
      'sessions',
      '1970',
      '01',
      '01',
      `rollout-1970-01-01T00-00-01-${threadId}.jsonl`,
    );
    const privateCanonical = path.join(
      desktopHome(),
      'sessions',
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    const nativeContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/native/state-less-synthetic-winner' },
    })}\n`;

    const realLink = fs.promises.link.bind(fs.promises);
    let materialized = false;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (
        !materialized
        && path.basename(target.toString()).startsWith('.cindy-state-less-recovery')
      ) {
        fs.mkdirSync(path.dirname(privateCanonical), { recursive: true });
        fs.writeFileSync(privateCanonical, nativeContents);
        materialized = true;
      }
    });
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /canonical rollout namespace changed during recovery handoff/,
      );
    } finally {
      linkSpy.mockRestore();
    }

    expect(materialized).toBe(true);
    expect(fs.existsSync(preferred)).toBe(false);
    expect(fs.readFileSync(privateCanonical, 'utf-8')).toBe(nativeContents);
    const targetDb = new Database(targetDbPath, { readonly: true });
    const stateCount = targetDb
      .prepare('SELECT count(*) AS count FROM threads WHERE id = ?')
      .get(threadId) as { count: number };
    targetDb.close();
    expect(stateCount.count).toBe(0);
    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(privateCanonical);
  });

  it('rejects a second canonical when the primary writer wakes before preservation', async () => {
    createStateDb(desktopHome());
    const sessionId = `local-native-winner-namespace-race-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'native-winner-namespace-race-c1',
      'user',
      JSON.stringify({ text: 'do not accept two native histories' }),
      1_000,
    );
    const targetDirectory = path.join(desktopHome(), 'sessions', '2026', '08', '03');
    const primaryCanonical = path.join(
      targetDirectory,
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    const secondCanonical = path.join(
      targetDirectory,
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    const primaryContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/native/primary-writer' },
    })}\n`;
    const secondContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/native/second-writer' },
    })}\n`;
    fs.mkdirSync(targetDirectory, { recursive: true });
    fs.writeFileSync(primaryCanonical, '');
    markEmptyRolloutStable(primaryCanonical);

    const realLink = fs.promises.link.bind(fs.promises);
    let materialized = false;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (
        !materialized
        && path.basename(target.toString()).startsWith('.cindy-state-less-recovery')
      ) {
        fs.writeFileSync(primaryCanonical, primaryContents);
        fs.writeFileSync(secondCanonical, secondContents);
        materialized = true;
      }
    });
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /namespace changed before completing the handoff/,
      );
    } finally {
      linkSpy.mockRestore();
    }

    expect(materialized).toBe(true);
    expect(fs.readFileSync(primaryCanonical, 'utf-8')).toBe(primaryContents);
    expect(fs.readFileSync(secondCanonical, 'utf-8')).toBe(secondContents);
    await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
      /multiple private canonical rollouts conflict/,
    );
  });

  it('keeps the primary preserved when another canonical appears before the handoff guard', async () => {
    createStateDb(desktopHome());
    const sessionId = `local-preserved-rollback-namespace-race-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'preserved-rollback-namespace-race-c1',
      'user',
      JSON.stringify({ text: 'do not restore beside another canonical' }),
      1_000,
    );
    const targetDirectory = path.join(desktopHome(), 'sessions', '2026', '08', '03');
    const primaryCanonical = path.join(
      targetDirectory,
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    const preservedPrimary = path.join(
      targetDirectory,
      `rollout-cindy-preserved-empty-${path.basename(primaryCanonical)}`,
    );
    const nativeCanonical = path.join(
      targetDirectory,
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    const nativeContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/native/post-preservation-winner' },
    })}\n`;
    fs.mkdirSync(targetDirectory, { recursive: true });
    fs.writeFileSync(primaryCanonical, '');
    markEmptyRolloutStable(primaryCanonical);

    const realUnlinkSync = fs.unlinkSync.bind(fs);
    let materialized = false;
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((candidate) => {
      const result = realUnlinkSync(candidate);
      if (
        !materialized
        && path.resolve(candidate.toString()) === path.resolve(primaryCanonical)
        && fs.existsSync(preservedPrimary)
      ) {
        fs.writeFileSync(nativeCanonical, nativeContents);
        materialized = true;
      }
      return result;
    });
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /canonical rollout namespace changed during recovery handoff/,
      );
    } finally {
      unlinkSpy.mockRestore();
    }

    expect(materialized).toBe(true);
    expect(fs.existsSync(primaryCanonical)).toBe(false);
    expect(fs.readFileSync(preservedPrimary, 'utf-8')).toBe('');
    expect(fs.readFileSync(nativeCanonical, 'utf-8')).toBe(nativeContents);
    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(nativeCanonical);
  });

  it('fails closed when another canonical appears after the external canonical link commits', async () => {
    createStateDb(desktopHome());
    const targetDirectory = path.join(desktopHome(), 'sessions', '2026', '08', '03');
    const primaryCanonical = path.join(
      targetDirectory,
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    const preservedPrimary = path.join(
      targetDirectory,
      `rollout-cindy-preserved-empty-${path.basename(primaryCanonical)}`,
    );
    const nativeCanonical = path.join(
      targetDirectory,
      `rollout-2026-08-03T13-00-00-${threadId}.jsonl`,
    );
    const nativeContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/native/post-external-link' },
    })}\n`;
    fs.mkdirSync(targetDirectory, { recursive: true });
    fs.writeFileSync(primaryCanonical, '');
    markEmptyRolloutStable(primaryCanonical);

    const sourceRollout = path.join(
      externalHome,
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    const sourceContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/external/post-link' },
    })}\n`;
    fs.mkdirSync(path.dirname(sourceRollout), { recursive: true });
    fs.writeFileSync(sourceRollout, sourceContents);

    const realLinkSync = fs.linkSync.bind(fs);
    let materialized = false;
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
      const result = realLinkSync(source, target);
      if (
        !materialized
        && path.resolve(target.toString()) === path.resolve(primaryCanonical)
        && path.basename(source.toString()).startsWith('rollout-cindy-adopted')
      ) {
        fs.writeFileSync(nativeCanonical, nativeContents);
        materialized = true;
      }
      return result;
    });
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /namespace changed before completing the handoff/,
      );
    } finally {
      linkSpy.mockRestore();
    }

    expect(materialized).toBe(true);
    expect(fs.readFileSync(primaryCanonical, 'utf-8')).toBe(sourceContents);
    expect(fs.readFileSync(nativeCanonical, 'utf-8')).toBe(nativeContents);
    expect(fs.readFileSync(preservedPrimary, 'utf-8')).toBe('');
    expect(fs.readFileSync(sourceRollout, 'utf-8')).toBe(sourceContents);
    await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
      /multiple private canonical rollouts conflict/,
    );
  });

  it('fails closed when another canonical appears after the synthetic canonical link commits', async () => {
    createStateDb(desktopHome());
    const sessionId = `local-post-synthetic-link-race-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'post-synthetic-link-race-c1',
      'user',
      JSON.stringify({ text: 'retain both histories and stop' }),
      1_000,
    );
    const targetDirectory = path.join(desktopHome(), 'sessions', '2026', '08', '03');
    const primaryCanonical = path.join(
      targetDirectory,
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    const preservedPrimary = path.join(
      targetDirectory,
      `rollout-cindy-preserved-empty-${path.basename(primaryCanonical)}`,
    );
    const nativeCanonical = path.join(
      targetDirectory,
      `rollout-2026-08-03T12-00-00-${threadId}.jsonl`,
    );
    const nativeContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/native/post-synthetic-link' },
    })}\n`;
    fs.mkdirSync(targetDirectory, { recursive: true });
    fs.writeFileSync(primaryCanonical, '');
    markEmptyRolloutStable(primaryCanonical);

    const realLinkSync = fs.linkSync.bind(fs);
    let materialized = false;
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
      const result = realLinkSync(source, target);
      if (
        !materialized
        && path.resolve(target.toString()) === path.resolve(primaryCanonical)
        && path.basename(source.toString()).startsWith('.cindy-state-less-recovery')
      ) {
        fs.writeFileSync(nativeCanonical, nativeContents);
        materialized = true;
      }
      return result;
    });
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /namespace changed before completing the handoff/,
      );
    } finally {
      linkSpy.mockRestore();
    }

    expect(materialized).toBe(true);
    expect(fs.readFileSync(primaryCanonical, 'utf-8')).toContain(
      'retain both histories and stop',
    );
    expect(fs.readFileSync(nativeCanonical, 'utf-8')).toBe(nativeContents);
    expect(fs.readFileSync(preservedPrimary, 'utf-8')).toBe('');
    await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
      /multiple private canonical rollouts conflict/,
    );
  });

  it('retries external adoption without publishing a snapshot from an active copy', async () => {
    const sourceRollout = path.join(
      externalHome,
      'sessions',
      `rollout-2026-08-03-${threadId}.jsonl`,
    );
    const firstLine = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/tmp/project' },
    })}\n`;
    const lateLine = `${rolloutLine('late', 'assistant', 'late external tail', '2026-08-03T12:00:00.000Z')}\n`;
    fs.mkdirSync(path.dirname(sourceRollout), { recursive: true });
    fs.writeFileSync(sourceRollout, firstLine);
    const sourceDbPath = createStateDb(externalHome);
    insertThread(sourceDbPath, threadId, sourceRollout, { updatedAt: 2_000 });
    const targetDbPath = createStateDb(desktopHome());
    const preferred = path.join(desktopHome(), 'sessions', path.basename(sourceRollout));

    const realCopy = fs.promises.copyFile.bind(fs.promises);
    let appended = false;
    const copySpy = vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (...args) => {
      await realCopy(...args);
      if (!appended) {
        appended = true;
        fs.appendFileSync(sourceRollout, lateLine);
      }
    });
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /changed during private adoption/,
      );
    } finally {
      copySpy.mockRestore();
    }

    expect(fs.existsSync(preferred)).toBe(false);
    const recovered = await prepareExternalCodexSessionForResume(threadId);
    expect(recovered).toBeTruthy();
    expect(recovered).not.toBe(preferred);
    expect(path.basename(recovered!)).toBe(
      `rollout-cindy-adopted-${path.basename(sourceRollout)}`,
    );
    expect(fs.readFileSync(recovered!, 'utf-8')).toBe(firstLine + lateLine);
    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(recovered);
  });

  it('leaves an empty rollout pointer unchanged when no readable history can recover it', async () => {
    const dbPath = createStateDb(desktopHome());
    const emptyRollout = path.join(
      desktopHome(),
      'sessions',
      `rollout-2026-08-03-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(emptyRollout), { recursive: true });
    fs.writeFileSync(emptyRollout, '');
    markEmptyRolloutStable(emptyRollout);
    insertThread(dbPath, threadId, emptyRollout, { updatedAt: 2_000 });

    await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
      /not safe to resume yet/,
    );
    expect(fs.readFileSync(emptyRollout, 'utf-8')).toBe('');
    const stateDb = new Database(dbPath, { readonly: true });
    const state = stateDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    stateDb.close();
    expect(state.rolloutPath).toBe(emptyRollout);
  });

  it('recovers the reported external empty rollout into Cindy private storage (#1554)', async () => {
    const externalRollout = path.join(
      externalHome,
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(externalRollout), { recursive: true });
    fs.writeFileSync(externalRollout, '');
    markEmptyRolloutStable(externalRollout);
    const externalDbPath = createStateDb(externalHome);
    insertThread(externalDbPath, threadId, externalRollout, { updatedAt: 2_000 });

    const targetDbPath = createStateDb(desktopHome());
    insertThread(targetDbPath, threadId, externalRollout, {
      updatedAt: 3_000,
      title: 'Current Cindy title',
    });
    const sessionId = `local-external-empty-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'external-c1',
      'user',
      JSON.stringify({ text: 'continue from the phone' }),
      1_000,
    );
    insertLocalMessage(sessionId, 'external-c2', 'assistant', 'private recovery', 1_100);

    const prepared = await prepareExternalCodexSessionForResume(threadId);

    expect(prepared).toBeTruthy();
    expect(prepared).not.toBe(externalRollout);
    expect(prepared!.startsWith(desktopHome())).toBe(true);
    expect(fs.readFileSync(externalRollout, 'utf-8')).toBe('');
    expect(fs.readFileSync(prepared!, 'utf-8')).toContain('continue from the phone');
    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath, title FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string; title: string };
    targetDb.close();
    expect(targetRow).toEqual({ rolloutPath: prepared, title: 'Current Cindy title' });
  });

  it('converges external H1 to H2 before publishing the state handoff', async () => {
    const externalRollout = path.join(
      externalHome,
      'sessions',
      `rollout-2026-08-03-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(externalRollout), { recursive: true });
    fs.writeFileSync(externalRollout, '');
    markEmptyRolloutStable(externalRollout);
    const externalDbPath = createStateDb(externalHome);
    insertThread(externalDbPath, threadId, externalRollout, { updatedAt: 2_000 });
    const targetDbPath = createStateDb(desktopHome());
    insertThread(targetDbPath, threadId, externalRollout, { updatedAt: 3_000 });
    const sessionId = `local-external-h1-h2-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(sessionId, 'external-h1', 'user', JSON.stringify({ text: 'external H1' }), 1_000);

    const realLink = fs.promises.link.bind(fs.promises);
    let advanced = false;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (
        !advanced
        && path.basename(target.toString()).startsWith('rollout-cindy-empty-recovery')
      ) {
        advanced = true;
        insertLocalMessage(sessionId, 'external-h2', 'assistant', 'external H2', 1_100);
      }
    });
    let prepared: string | undefined;
    try {
      prepared = await prepareExternalCodexSessionForResume(threadId);
    } finally {
      linkSpy.mockRestore();
    }

    expect(prepared).toBeTruthy();
    expect(path.basename(prepared!)).toBe(
      `rollout-cindy-empty-recovery-2-${path.basename(externalRollout)}`,
    );
    expect(fs.readFileSync(prepared!, 'utf-8')).toContain('external H2');
    expect(fs.readFileSync(externalRollout, 'utf-8')).toBe('');
    const stateDb = new Database(targetDbPath, { readonly: true });
    const state = stateDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    stateDb.close();
    expect(state.rolloutPath).toBe(prepared);
  });

  it('lets an external writer win before handoff and adopts it privately on retry', async () => {
    const externalRollout = path.join(
      externalHome,
      'sessions',
      `rollout-2026-08-03-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(externalRollout), { recursive: true });
    fs.writeFileSync(externalRollout, '');
    markEmptyRolloutStable(externalRollout);
    const targetDbPath = createStateDb(desktopHome());
    insertThread(targetDbPath, threadId, externalRollout, { updatedAt: 3_000 });
    const sessionId = `local-external-late-writer-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'external-late-c1',
      'user',
      JSON.stringify({ text: 'Cindy visible history' }),
      1_000,
    );
    const externalAuthoritative = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/external/project' },
    })}\n`;

    const realLink = fs.promises.link.bind(fs.promises);
    let filled = false;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (!filled && target.toString().startsWith(desktopHome())) {
        filled = true;
        fs.writeFileSync(externalRollout, externalAuthoritative);
      }
    });
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /rollout pointer changed during recovery/,
      );
    } finally {
      linkSpy.mockRestore();
    }

    expect(filled).toBe(true);
    expect(fs.readFileSync(externalRollout, 'utf-8')).toBe(externalAuthoritative);
    let targetDb = new Database(targetDbPath, { readonly: true });
    let targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(externalRollout);

    const prepared = await prepareExternalCodexSessionForResume(threadId);
    expect(prepared).toBeTruthy();
    expect(prepared).not.toBe(externalRollout);
    expect(prepared!.startsWith(desktopHome())).toBe(true);
    expect(fs.readFileSync(prepared!, 'utf-8')).toBe(externalAuthoritative);
    targetDb = new Database(targetDbPath, { readonly: true });
    targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(prepared);
  });

  it('keeps an external empty pointer when no private recovery can be published', async () => {
    const externalRollout = path.join(
      externalHome,
      'sessions',
      `rollout-2026-08-03-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(externalRollout), { recursive: true });
    fs.writeFileSync(externalRollout, '');
    markEmptyRolloutStable(externalRollout);
    const externalDbPath = createStateDb(externalHome);
    insertThread(externalDbPath, threadId, externalRollout, { updatedAt: 2_000 });
    const targetDbPath = createStateDb(desktopHome());
    insertThread(targetDbPath, threadId, externalRollout, { updatedAt: 3_000 });

    await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
      /not safe to resume yet/,
    );

    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(externalRollout);
    expect(fs.readFileSync(externalRollout, 'utf-8')).toBe('');
    expect(fs.existsSync(path.join(desktopHome(), 'sessions'))).toBe(false);
  });

  it('waits for a recent empty rollout instead of forking a live writer', async () => {
    const dbPath = createStateDb(desktopHome());
    const materializingRollout = path.join(
      desktopHome(),
      'sessions',
      `rollout-2026-08-03-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(materializingRollout), { recursive: true });
    fs.writeFileSync(materializingRollout, '');
    insertThread(dbPath, threadId, materializingRollout, { updatedAt: 2_000 });
    const sessionId = `local-materializing-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(sessionId, 'live-c1', 'user', JSON.stringify({ text: 'queued' }), 1_000);

    await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
      /may still be materializing/,
    );
    expect(fs.readdirSync(path.dirname(materializingRollout))).toEqual([
      path.basename(materializingRollout),
    ]);

    const authoritative = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/tmp/project' },
    })}\n`;
    fs.writeFileSync(materializingRollout, authoritative);
    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(materializingRollout);
    const stateDb = new Database(dbPath, { readonly: true });
    const state = stateDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    stateDb.close();
    expect(state.rolloutPath).toBe(materializingRollout);
  });

  it('blocks a recent external rollout before target state has been imported', async () => {
    const externalRollout = path.join(
      externalHome,
      'sessions',
      `rollout-2026-08-03-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(externalRollout), { recursive: true });
    fs.writeFileSync(externalRollout, '');
    const externalDbPath = createStateDb(externalHome);
    insertThread(externalDbPath, threadId, externalRollout, { updatedAt: 2_000 });
    const targetDbPath = createStateDb(desktopHome());

    await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
      /external rollout may still be materializing/,
    );

    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetCount = targetDb
      .prepare('SELECT count(*) AS count FROM threads WHERE id = ?')
      .get(threadId) as { count: number };
    targetDb.close();
    expect(targetCount.count).toBe(0);
    expect(fs.existsSync(path.join(desktopHome(), 'sessions'))).toBe(false);
  });

  it('recovers a stable external empty rollout before target state has been imported', async () => {
    const externalRollout = path.join(
      externalHome,
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(externalRollout), { recursive: true });
    fs.writeFileSync(externalRollout, '');
    markEmptyRolloutStable(externalRollout);
    const externalDbPath = createStateDb(externalHome);
    insertThread(externalDbPath, threadId, externalRollout, {
      updatedAt: 2_000,
      title: 'External stable empty',
    });
    const targetDbPath = createStateDb(desktopHome());
    const sessionId = `local-external-empty-no-target-state-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'external-no-state-c1',
      'user',
      JSON.stringify({ text: 'recover from Cindy history' }),
      1_000,
    );

    const prepared = await prepareExternalCodexSessionForResume(threadId);

    expect(prepared).toBeTruthy();
    expect(prepared).not.toBe(externalRollout);
    expect(prepared!.startsWith(desktopHome())).toBe(true);
    expect(fs.readFileSync(externalRollout, 'utf-8')).toBe('');
    expect(fs.readFileSync(prepared!, 'utf-8')).toContain('recover from Cindy history');
    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath, title FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string; title: string };
    targetDb.close();
    expect(targetRow).toEqual({ rolloutPath: prepared, title: 'External stable empty' });
  });

  it('retains a committed no-row handoff when its path temporarily disappears afterward', async () => {
    const externalRollout = path.join(
      externalHome,
      'sessions',
      `rollout-2026-08-03-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(externalRollout), { recursive: true });
    fs.writeFileSync(externalRollout, '');
    markEmptyRolloutStable(externalRollout);
    const externalDbPath = createStateDb(externalHome);
    insertThread(externalDbPath, threadId, externalRollout, { updatedAt: 2_000 });
    const targetDbPath = createStateDb(desktopHome());
    const sessionId = `local-no-row-post-commit-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'no-row-post-commit-c1',
      'user',
      JSON.stringify({ text: 'retain the committed no-row state' }),
      1_000,
    );

    const realLink = fs.promises.link.bind(fs.promises);
    const realLstat = fs.lstatSync.bind(fs);
    let candidate: string | null = null;
    let backup: string | null = null;
    let disappearedAfterCommit = false;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (path.basename(target.toString()).startsWith('rollout-cindy-empty-recovery')) {
        candidate = path.resolve(target.toString());
      }
    });
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike) => {
      if (
        candidate
        && !disappearedAfterCommit
        && path.resolve(file.toString()) === candidate
        && fs.existsSync(candidate)
      ) {
        try {
          const probe = new Database(targetDbPath, { readonly: true });
          const row = probe
            .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
            .get(threadId) as { rolloutPath?: string } | undefined;
          probe.close();
          if (row?.rolloutPath === candidate) {
            backup = `${candidate}.committed-inode`;
            fs.renameSync(candidate, backup);
            disappearedAfterCommit = true;
          }
        } catch {
          // The IMMEDIATE copy transaction is still uncommitted; retry later.
        }
      }
      return realLstat(file);
    }) as typeof fs.lstatSync);

    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /external state could not be copied after recovery/,
      );
    } finally {
      lstatSpy.mockRestore();
      linkSpy.mockRestore();
    }

    expect(disappearedAfterCommit).toBe(true);
    expect(candidate).toBeTruthy();
    expect(backup).toBeTruthy();
    let targetDb = new Database(targetDbPath, { readonly: true });
    let targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(candidate);

    fs.renameSync(backup!, candidate!);
    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(candidate);
    targetDb = new Database(targetDbPath, { readonly: true });
    targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(candidate);
    expect(fs.readFileSync(candidate!, 'utf-8')).toContain('retain the committed no-row state');
  });

  it('blocks when a state-less external empty fills before handoff, then adopts it on retry', async () => {
    const externalRollout = path.join(
      externalHome,
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(externalRollout), { recursive: true });
    fs.writeFileSync(externalRollout, '');
    markEmptyRolloutStable(externalRollout);
    const externalDbPath = createStateDb(externalHome);
    insertThread(externalDbPath, threadId, externalRollout, { updatedAt: 2_000 });
    const targetDbPath = createStateDb(desktopHome());
    const sessionId = `local-external-handoff-race-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(sessionId, 'handoff-c1', 'user', JSON.stringify({ text: 'fallback H1' }), 1_000);
    const authoritative = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/external/project' },
    })}\n`;

    const realLink = fs.promises.link.bind(fs.promises);
    let filled = false;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (!filled && path.basename(target.toString()).startsWith('rollout-cindy-empty-recovery')) {
        filled = true;
        fs.writeFileSync(externalRollout, authoritative);
      }
    });
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /changed before private state handoff/,
      );
    } finally {
      linkSpy.mockRestore();
    }

    const emptyTargetDb = new Database(targetDbPath, { readonly: true });
    const targetCount = emptyTargetDb
      .prepare('SELECT count(*) AS count FROM threads WHERE id = ?')
      .get(threadId) as { count: number };
    emptyTargetDb.close();
    expect(targetCount.count).toBe(0);

    const adopted = await prepareExternalCodexSessionForResume(threadId);
    expect(fs.readFileSync(adopted!, 'utf-8')).toBe(authoritative);
    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(adopted);
  });

  it('blocks a recent unindexed external empty, then recovers privately once stable', async () => {
    const externalRollout = path.join(
      externalHome,
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(externalRollout), { recursive: true });
    fs.writeFileSync(externalRollout, '');
    const targetDbPath = createStateDb(desktopHome());
    const sessionId = `local-unindexed-external-empty-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'unindexed-external-c1',
      'user',
      JSON.stringify({ text: 'recover from Cindy history' }),
      1_000,
    );

    await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
      /external rollout may still be materializing/,
    );
    markEmptyRolloutStable(externalRollout);

    const prepared = await prepareExternalCodexSessionForResume(threadId);

    expect(fs.readFileSync(externalRollout, 'utf-8')).toBe('');
    expect(prepared).toBeTruthy();
    expect(prepared).not.toBe(externalRollout);
    expect(prepared!.startsWith(desktopHome())).toBe(true);
    expect(fs.readFileSync(prepared!, 'utf-8')).toContain('recover from Cindy history');
    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetCount = targetDb
      .prepare('SELECT count(*) AS count FROM threads WHERE id = ?')
      .get(threadId) as { count: number };
    targetDb.close();
    expect(targetCount.count).toBe(0);
  });

  it('blocks when a stable unindexed external empty fills at handoff, then adopts it exactly', async () => {
    const externalRollout = path.join(
      externalHome,
      'sessions',
      '2026',
      '08',
      '03',
      `rollout-2026-08-03T11-56-18-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(externalRollout), { recursive: true });
    fs.writeFileSync(externalRollout, '');
    markEmptyRolloutStable(externalRollout);
    const targetDbPath = createStateDb(desktopHome());
    const sessionId = `local-unindexed-external-race-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'unindexed-race-c1',
      'user',
      JSON.stringify({ text: 'local fallback must not win this race' }),
      1_000,
    );
    const authoritative = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/external/authoritative' },
    })}\n${rolloutLine(
      'external-race-m1',
      'user',
      'full fidelity external history',
      '2026-08-03T11:56:19.000Z',
    )}\n`;

    const realLink = fs.promises.link.bind(fs.promises);
    let filled = false;
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (!filled && path.basename(target.toString()).startsWith('.cindy-state-less-recovery')) {
        filled = true;
        fs.writeFileSync(externalRollout, authoritative);
      }
    });
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /external rollout changed before private recovery handoff/,
      );
    } finally {
      linkSpy.mockRestore();
    }

    const canonical = path.join(
      desktopHome(),
      path.relative(externalHome, externalRollout),
    );
    expect(fs.existsSync(canonical)).toBe(false);
    const adopted = await prepareExternalCodexSessionForResume(threadId);
    expect(adopted).toBe(canonical);
    expect(fs.readFileSync(adopted!, 'utf-8')).toBe(authoritative);
    expect(fs.readFileSync(externalRollout, 'utf-8')).toBe(authoritative);
    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetCount = targetDb
      .prepare('SELECT count(*) AS count FROM threads WHERE id = ?')
      .get(threadId) as { count: number };
    targetDb.close();
    expect(targetCount.count).toBe(0);
  });

  it('prefers an authoritative writer that fills the original during recovery publication', async () => {
    const dbPath = createStateDb(desktopHome());
    const emptyRollout = path.join(
      desktopHome(),
      'sessions',
      `rollout-2026-08-03-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(emptyRollout), { recursive: true });
    fs.writeFileSync(emptyRollout, '');
    markEmptyRolloutStable(emptyRollout);
    insertThread(dbPath, threadId, emptyRollout, { updatedAt: 2_000 });
    const sessionId = `local-late-writer-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(sessionId, 'late-c1', 'user', JSON.stringify({ text: 'local copy' }), 1_000);
    const authoritative = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/tmp/project' },
    })}\n`;

    const realLink = fs.promises.link.bind(fs.promises);
    const linkSpy = vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await realLink(source, target);
      if (path.basename(target.toString()).startsWith('rollout-cindy-empty-recovery')) {
        fs.writeFileSync(emptyRollout, authoritative);
      }
    });
    try {
      expect(await prepareExternalCodexSessionForResume(threadId)).toBe(emptyRollout);
    } finally {
      linkSpy.mockRestore();
    }

    const stateDb = new Database(dbPath, { readonly: true });
    const state = stateDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    stateDb.close();
    expect(state.rolloutPath).toBe(emptyRollout);
    expect(fs.readFileSync(emptyRollout, 'utf-8')).toBe(authoritative);
  });

  it('keeps the published recovery authoritative when the original writes on a later preflight', async () => {
    const dbPath = createStateDb(desktopHome());
    const emptyRollout = path.join(
      desktopHome(),
      'sessions',
      `rollout-2026-08-03-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(emptyRollout), { recursive: true });
    fs.writeFileSync(emptyRollout, '');
    markEmptyRolloutStable(emptyRollout);
    insertThread(dbPath, threadId, emptyRollout, { updatedAt: 2_000 });
    const sessionId = `local-reconcile-writer-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(sessionId, 'reconcile-c1', 'user', JSON.stringify({ text: 'fallback' }), 1_000);

    const recovered = await prepareExternalCodexSessionForResume(threadId);
    const authoritative = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/tmp/project' },
    })}\n`;
    fs.writeFileSync(emptyRollout, authoritative);
    const future = new Date(Date.now() + 1_000);
    fs.utimesSync(emptyRollout, future, future);

    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(recovered);
    expect(fs.readFileSync(recovered!, 'utf-8')).toContain('fallback');
    expect(fs.readFileSync(emptyRollout, 'utf-8')).toBe(authoritative);
    const stateDb = new Database(dbPath, { readonly: true });
    const state = stateDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    stateDb.close();
    expect(state.rolloutPath).toBe(recovered);
  });

  it('does not reuse a published recovery after local history advances', async () => {
    const dbPath = createStateDb(desktopHome());
    const emptyRollout = path.join(
      desktopHome(),
      'sessions',
      `rollout-2026-08-03-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(emptyRollout), { recursive: true });
    fs.writeFileSync(emptyRollout, '');
    markEmptyRolloutStable(emptyRollout);
    insertThread(dbPath, threadId, emptyRollout, { updatedAt: 2_000 });
    const sessionId = `local-second-recovery-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(sessionId, 'second-c1', 'user', JSON.stringify({ text: 'history H1' }), 1_000);

    const firstRecovery = await prepareExternalCodexSessionForResume(threadId);
    const firstContents = fs.readFileSync(firstRecovery!, 'utf-8');
    const writableDb = new Database(dbPath);
    writableDb
      .prepare('UPDATE threads SET rollout_path = ? WHERE id = ?')
      .run(emptyRollout, threadId);
    writableDb.close();
    insertLocalMessage(sessionId, 'second-c2', 'assistant', 'history H2', 1_100);

    const prepared = await prepareExternalCodexSessionForResume(threadId);

    expect(path.basename(prepared!)).toBe(
      `rollout-cindy-empty-recovery-2-${path.basename(emptyRollout)}`,
    );
    expect(fs.readFileSync(emptyRollout, 'utf-8')).toBe('');
    expect(fs.readFileSync(firstRecovery!, 'utf-8')).toBe(firstContents);
    expect(fs.readFileSync(prepared!, 'utf-8')).toContain('history H2');
  });

  it('keeps a pointed recovery authoritative when local history advances after handoff', async () => {
    const dbPath = createStateDb(desktopHome());
    const emptyRollout = path.join(
      desktopHome(),
      'sessions',
      `rollout-2026-08-03-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(emptyRollout), { recursive: true });
    fs.writeFileSync(emptyRollout, '');
    markEmptyRolloutStable(emptyRollout);
    insertThread(dbPath, threadId, emptyRollout, { updatedAt: 2_000 });
    const sessionId = `local-pointed-refresh-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(sessionId, 'pointed-c1', 'user', JSON.stringify({ text: 'pointed H1' }), 1_000);

    const firstRecovery = await prepareExternalCodexSessionForResume(threadId);
    insertLocalMessage(sessionId, 'pointed-c2', 'assistant', 'pointed H2', 1_100);
    const prepared = await prepareExternalCodexSessionForResume(threadId);

    expect(prepared).toBe(firstRecovery);
    expect(fs.readFileSync(firstRecovery!, 'utf-8')).not.toContain('pointed H2');
    expect(fs.readdirSync(path.dirname(firstRecovery!)).filter((name) => (
      name.startsWith('rollout-cindy-empty-recovery')
    ))).toEqual([path.basename(firstRecovery!)]);
    const stateDb = new Database(dbPath, { readonly: true });
    const state = stateDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    stateDb.close();
    expect(state.rolloutPath).toBe(firstRecovery);
  });

  it('preserves a recovery after Codex has appended native records', async () => {
    const dbPath = createStateDb(desktopHome());
    const emptyRollout = path.join(
      desktopHome(),
      'sessions',
      `rollout-2026-08-03-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(emptyRollout), { recursive: true });
    fs.writeFileSync(emptyRollout, '');
    markEmptyRolloutStable(emptyRollout);
    insertThread(dbPath, threadId, emptyRollout, { updatedAt: 2_000 });
    const sessionId = `local-native-append-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(sessionId, 'native-c1', 'user', JSON.stringify({ text: 'native H1' }), 1_000);

    const recovered = await prepareExternalCodexSessionForResume(threadId);
    const nativeLine = `${JSON.stringify({
      timestamp: '2026-08-03T12:00:00.000Z',
      type: 'turn_context',
      payload: { turn_id: 'native-turn' },
    })}\n`;
    fs.appendFileSync(recovered!, nativeLine);
    const authoritativeContents = fs.readFileSync(recovered!, 'utf-8');
    insertLocalMessage(sessionId, 'native-c2', 'assistant', 'local H2', 1_100);

    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(recovered);
    expect(fs.readFileSync(recovered!, 'utf-8')).toBe(authoritativeContents);
    expect(fs.readdirSync(path.dirname(recovered!)).filter((name) => (
      name.startsWith('rollout-cindy-empty-recovery')
    ))).toEqual([path.basename(recovered!)]);
  });

  it('keeps a native-appended recovery authoritative when the original writes later', async () => {
    const dbPath = createStateDb(desktopHome());
    const emptyRollout = path.join(
      desktopHome(),
      'sessions',
      `rollout-2026-08-03-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(emptyRollout), { recursive: true });
    fs.writeFileSync(emptyRollout, '');
    markEmptyRolloutStable(emptyRollout);
    insertThread(dbPath, threadId, emptyRollout, { updatedAt: 2_000 });
    const sessionId = `local-native-late-original-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(sessionId, 'native-late-c1', 'user', JSON.stringify({ text: 'fallback H1' }), 1_000);

    const recovered = await prepareExternalCodexSessionForResume(threadId);
    const nativeLine = `${JSON.stringify({
      timestamp: '2026-08-03T12:00:00.000Z',
      type: 'turn_context',
      payload: { turn_id: 'native-after-recovery' },
    })}\n`;
    fs.appendFileSync(recovered!, nativeLine);
    const recoveredContents = fs.readFileSync(recovered!, 'utf-8');

    const lateOriginal = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/late/original' },
    })}\n`;
    fs.writeFileSync(emptyRollout, lateOriginal);
    const later = new Date(Date.now() + 1_000);
    fs.utimesSync(emptyRollout, later, later);
    expect(fs.statSync(emptyRollout).mtimeMs).toBeGreaterThan(fs.statSync(recovered!).mtimeMs);

    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(recovered);
    expect(fs.readFileSync(recovered!, 'utf-8')).toBe(recoveredContents);
    expect(fs.readFileSync(emptyRollout, 'utf-8')).toBe(lateOriginal);
    const stateDb = new Database(dbPath, { readonly: true });
    const state = stateDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    stateDb.close();
    expect(state.rolloutPath).toBe(recovered);
  });

  it('adopts a non-legacy external pointer already stored in target state', async () => {
    const externalRollout = path.join(
      externalHome,
      'sessions',
      `rollout-2026-08-03-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(externalRollout), { recursive: true });
    fs.writeFileSync(externalRollout, 'EXTERNAL_CURRENT');
    const externalDbPath = createStateDb(externalHome);
    insertThread(externalDbPath, threadId, externalRollout, { updatedAt: 2_000 });
    const targetDbPath = createStateDb(desktopHome());
    insertThread(targetDbPath, threadId, externalRollout, {
      updatedAt: 3_000,
      title: 'Keep target metadata',
    });

    const prepared = await prepareExternalCodexSessionForResume(threadId);

    expect(prepared).toBeTruthy();
    expect(prepared).not.toBe(externalRollout);
    expect(prepared!.startsWith(desktopHome())).toBe(true);
    expect(fs.readFileSync(prepared!, 'utf-8')).toBe('EXTERNAL_CURRENT');
    expect(fs.readFileSync(externalRollout, 'utf-8')).toBe('EXTERNAL_CURRENT');
    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath, title FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string; title: string };
    targetDb.close();
    expect(targetRow).toEqual({ rolloutPath: prepared, title: 'Keep target metadata' });
  });

  it('rejects a symlink-shaped external state pointer before copying it', async () => {
    const externalRollout = path.join(
      externalHome,
      'sessions',
      `rollout-2026-08-03-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(externalRollout), { recursive: true });
    fs.writeFileSync(externalRollout, 'EXTERNAL_CURRENT');
    const targetDbPath = createStateDb(desktopHome());
    insertThread(targetDbPath, threadId, externalRollout, {
      updatedAt: 3_000,
      title: 'Keep target metadata',
    });

    // Model a final symlink without requiring Windows symlink privileges. The
    // real file keeps statSync-compatible contents, while lstatSync exposes the
    // no-follow shape that resume preparation must reject.
    const realLstat = fs.lstatSync.bind(fs);
    const copySpy = vi.spyOn(fs.promises, 'copyFile');
    let copyCalls = 0;
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation(((candidate: fs.PathLike) => {
      const observed = realLstat(candidate);
      if (path.resolve(candidate.toString()) !== path.resolve(externalRollout)) return observed;
      return new Proxy(observed, {
        get(target, property, receiver) {
          if (property === 'isFile') return () => false;
          if (property === 'isSymbolicLink') return () => true;
          return Reflect.get(target, property, receiver);
        },
      });
    }) as typeof fs.lstatSync);
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /rollout path is not a stable regular file/,
      );
    } finally {
      copyCalls = copySpy.mock.calls.length;
      lstatSpy.mockRestore();
      copySpy.mockRestore();
    }

    expect(copyCalls).toBe(0);
    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath, title FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string; title: string };
    targetDb.close();
    expect(targetRow).toEqual({
      rolloutPath: externalRollout,
      title: 'Keep target metadata',
    });
    const privateSessions = path.join(desktopHome(), 'sessions');
    expect(fs.existsSync(privateSessions) ? fs.readdirSync(privateSessions) : []).toEqual([]);
  });

  it('fails closed when private adoption hits a filesystem error', async () => {
    const externalRollout = path.join(
      externalHome,
      'sessions',
      `rollout-2026-08-03-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(externalRollout), { recursive: true });
    fs.writeFileSync(externalRollout, 'EXTERNAL_CURRENT');
    const targetDbPath = createStateDb(desktopHome());
    insertThread(targetDbPath, threadId, externalRollout, { updatedAt: 3_000 });
    const copyError = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    const copySpy = vi.spyOn(fs.promises, 'copyFile').mockRejectedValue(copyError);

    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /external rollout adoption failed/,
      );
    } finally {
      copySpy.mockRestore();
    }

    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(externalRollout);
    expect(fs.readFileSync(externalRollout, 'utf-8')).toBe('EXTERNAL_CURRENT');
  });

  it('preserves a stable empty and publishes one discoverable canonical when state is missing', async () => {
    const dbPath = createStateDb(desktopHome());
    const sessionId = `local-missing-state-empty-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(sessionId, 'missing-empty-c1', 'user', JSON.stringify({ text: 'recover' }), 1_000);
    const canonical = path.join(
      desktopHome(),
      'sessions',
      '1970',
      '01',
      '01',
      `rollout-1970-01-01T00-00-01-${threadId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.writeFileSync(canonical, '');
    markEmptyRolloutStable(canonical);

    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(canonical);
    expect(fs.readFileSync(canonical, 'utf-8')).toContain('recover');
    const names = fs.readdirSync(path.dirname(canonical));
    expect(names.filter((name) => /^rollout-\d/.test(name))).toEqual([path.basename(canonical)]);
    const preservedEmpty = names.find((name) => name.startsWith('rollout-cindy-preserved-empty'));
    expect(preservedEmpty).toBeTruthy();
    expect(fs.readFileSync(path.join(path.dirname(canonical), preservedEmpty!), 'utf-8')).toBe('');
    const stateDb = new Database(dbPath, { readonly: true });
    const stateCount = stateDb
      .prepare('SELECT count(*) AS count FROM threads WHERE id = ?')
      .get(threadId) as { count: number };
    stateDb.close();
    expect(stateCount.count).toBe(0);
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

  it('does not return a late external state row after a failed state-less synthesis', async () => {
    const targetDbPath = createStateDb(desktopHome());
    const sessionId = `local-late-external-state-${threadId}`;
    insertLocalCodexSession(sessionId, threadId);
    insertLocalMessage(
      sessionId,
      'late-external-state-c1',
      'user',
      JSON.stringify({ text: 'attempt state-less recovery first' }),
      1_000,
    );
    const lateExternal = path.join(
      externalHome,
      'sessions',
      `rollout-late-${threadId}.jsonl`,
    );
    const lateContents = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: threadId, cwd: '/external/late-state' },
    })}\n`;

    const realLinkSync = fs.linkSync.bind(fs);
    let stateInserted = false;
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((source, target) => {
      if (
        !stateInserted
        && path.basename(source.toString()).startsWith('.cindy-state-less-recovery')
        && path.basename(target.toString()).startsWith('rollout-')
      ) {
        fs.mkdirSync(path.dirname(lateExternal), { recursive: true });
        fs.writeFileSync(lateExternal, lateContents);
        insertThread(targetDbPath, threadId, lateExternal, { updatedAt: 3_000 });
        stateInserted = true;
        throw Object.assign(new Error('synthetic publication interrupted'), { code: 'EIO' });
      }
      return realLinkSync(source, target);
    });
    try {
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow(
        /late Codex state appeared outside a readable private recovery boundary/,
      );
    } finally {
      linkSpy.mockRestore();
    }

    expect(stateInserted).toBe(true);
    expect(fs.readFileSync(lateExternal, 'utf-8')).toBe(lateContents);
    const targetDb = new Database(targetDbPath, { readonly: true });
    const targetRow = targetDb
      .prepare('SELECT rollout_path AS rolloutPath FROM threads WHERE id = ?')
      .get(threadId) as { rolloutPath: string };
    targetDb.close();
    expect(targetRow.rolloutPath).toBe(lateExternal);
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
