import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const electronMock = vi.hoisted(() => ({ userData: '', region: 'global' as 'global' | 'cn' }));
const dbMock = vi.hoisted(() => ({ current: null as Database.Database | null }));

vi.mock('../../shared/brandRegion.js', () => ({
  get CURRENT_CINDY_REGION() { return electronMock.region; },
}));

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
  prepareExternalCodexSessionForResume,
  readCodexThreadStorageForArchive,
  dumpCodexThreadStateRows,
  classifyCodexHistoryOversized,
  repairCodexRolloutPath,
  prepareCodexRolloutForResume,
  normalizeCodexWindowsPath,
} from '../maker-host/codex-local-sessions';
import { CodexThreadLocations } from '../maker-host/codex-thread-locations';
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
let originalAppData: string | undefined;

function createLocalDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Maker',
      working_dir TEXT,
      workspace_kind TEXT NOT NULL DEFAULT 'project',
      model TEXT NOT NULL DEFAULT 'gpt-5.4-mini',
      scheduled_model_baseline TEXT,
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
      list_preview TEXT,
      list_preview_role TEXT,
      list_message_count INTEGER,
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
      writable_dirs TEXT NOT NULL DEFAULT '[]',
      remote_host_id TEXT,
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
        thread_source TEXT,
        originator TEXT
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
  electronMock.region = 'global';
  originalCodexHome = process.env.CODEX_HOME;
  originalAppData = process.env.APPDATA;
  // macOS may spell tmpdir as /var while discovery resolves it to /private/var.
  // Keep fixtures canonical; individual alias cases opt into differing spellings.
  rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-local-sessions-')));
  externalHome = path.join(rootDir, 'external-codex-home');
  targetUserData = path.join(rootDir, 'xdt-user-data');
  const fakeHome = path.join(rootDir, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  fs.mkdirSync(targetUserData, { recursive: true });
  electronMock.userData = targetUserData;
  process.env.CODEX_HOME = externalHome;
  process.env.APPDATA = path.join(rootDir, 'appdata');
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
  if (originalAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = originalAppData;
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('Codex local session import', () => {
  it('locates archive storage in the known state DB after sqlite_home changes', () => {
    const dbPath = createStateDb(externalHome);
    const newHome = path.join(rootDir, 'new-state');
    const newDbPath = createStateDb(newHome);
    const rolloutPath = path.join(externalHome, 'sessions', `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, '');
    insertThread(dbPath, threadId, rolloutPath, { updatedAt: 1_000 });
    const config = `sqlite_home = ${JSON.stringify(newHome)}\n`;
    fs.writeFileSync(path.join(externalHome, 'config.toml'), config);
    const before = [fs.readFileSync(dbPath), fs.readFileSync(newDbPath)];

    expect(readCodexThreadStorageForArchive(threadId)).toEqual({
      historyHome: externalHome, sqliteHome: fs.realpathSync(externalHome), rolloutPath,
    });
    expect([fs.readFileSync(dbPath), fs.readFileSync(newDbPath)]).toEqual(before);
    expect(fs.readFileSync(path.join(externalHome, 'config.toml'), 'utf8')).toBe(config);
  });

  it.each(['absolute', 'relative'])('locates archive storage with a separate %s sqlite_home', kind => {
    const sqliteHome = path.join(rootDir, 'separate-state');
    const dbPath = createStateDb(sqliteHome);
    const rolloutPath = path.join(externalHome, 'sessions', `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    const content = JSON.stringify({ type: 'session_meta', timestamp: '2026-05-13T00:00:00.000Z',
      payload: { id: threadId, timestamp: '2026-05-13T00:00:00.000Z', cwd: '/project', source: 'cli' } }) + '\n';
    fs.writeFileSync(rolloutPath, content);
    insertThread(dbPath, threadId, rolloutPath, { updatedAt: 1_000 });
    const config = `sqlite_home = ${JSON.stringify(kind === 'absolute' ? sqliteHome : '../separate-state')}\n`;
    fs.writeFileSync(path.join(externalHome, 'config.toml'), config);
    const before = fs.readFileSync(dbPath);

    const storage = readCodexThreadStorageForArchive(threadId)!;
    expect(fs.realpathSync(storage.historyHome)).toBe(fs.realpathSync(externalHome));
    expect(fs.realpathSync(storage.sqliteHome)).toBe(fs.realpathSync(sqliteHome));
    expect(fs.readFileSync(storage.rolloutPath, 'utf8')).toBe(content);
    expect(fs.readFileSync(dbPath)).toEqual(before);
    expect(fs.readFileSync(path.join(externalHome, 'config.toml'), 'utf8')).toBe(config);
    expect(currentTestDb().prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it.each(['sessions', 'archived_sessions'])('locates current-home archive storage in %s without a location record', directory => {
    const home = path.join(targetUserData, 'codex-home');
    const dbPath = createStateDb(home);
    const rolloutPath = path.join(home, directory, `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, '');
    insertThread(dbPath, threadId, rolloutPath, { updatedAt: 1_000 });
    const before = fs.readFileSync(dbPath);

    expect(readCodexThreadStorageForArchive(threadId)).toEqual({
      historyHome: home, sqliteHome: home, rolloutPath,
    });
    expect(fs.readFileSync(dbPath)).toEqual(before);
    expect(currentTestDb().prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    expect(fs.readFileSync(rolloutPath, 'utf8')).toBe('');
  });

  it('locates archive storage without importing or copying history', () => {
    const dbPath = createStateDb(externalHome);
    const rolloutPath = path.join(externalHome, 'sessions', `rollout-2026-05-13-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, '');
    insertThread(dbPath, threadId, rolloutPath, { updatedAt: 1_000 });
    const before = fs.readFileSync(dbPath);

    expect(readCodexThreadStorageForArchive(threadId)).toEqual({
      historyHome: externalHome, sqliteHome: fs.realpathSync(externalHome), rolloutPath,
    });
    expect(fs.readFileSync(dbPath)).toEqual(before);
    expect(currentTestDb().prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    expect(fs.readFileSync(rolloutPath, 'utf8')).toBe('');
  });

  it('dumps multi-account thread state only from its indexed storage', async () => {
    // 多账号线程存放在 codex-accounts/<owner>/<账号>/,desktop 与外部 HOME 都找不到它。
    const accountHome = path.join(targetUserData, 'codex-accounts', 'owner', 'openai-a');
    const dbPath = createStateDb(accountHome);
    const rolloutPath = path.join(accountHome, 'sessions', `rollout-2026-09-16-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, '{"type":"session_meta"}\n');
    insertThread(dbPath, threadId, rolloutPath, { updatedAt: 1_000 });

    const legacy = await dumpCodexThreadStateRows(threadId);
    expect(legacy.threads).toEqual([]);
    expect(legacy.rolloutPath).toBeNull();

    const indexed = await dumpCodexThreadStateRows(threadId, { sqliteHome: accountHome, rolloutPath });
    expect(indexed.threads.map((row) => row.id)).toEqual([threadId]);
    expect(indexed.rolloutPath).toBe(rolloutPath);

    fs.rmSync(rolloutPath);
    const missing = await dumpCodexThreadStateRows(threadId, { sqliteHome: accountHome, rolloutPath });
    expect(missing.rolloutPath).toBeNull();
  });

  it('treats an unreadable indexed state DB as incomplete, but a rollout-only home as valid', async () => {
    const accountHome = path.join(targetUserData, 'codex-accounts', 'owner', 'openai-b');
    const rolloutPath = path.join(accountHome, 'sessions', `rollout-2026-09-16-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, '{"type":"session_meta"}\n');

    // 纯 rollout 的存储(没有状态库)是合法的空 state。
    const rolloutOnly = await dumpCodexThreadStateRows(threadId, { sqliteHome: accountHome, rolloutPath });
    expect(rolloutOnly.threads).toEqual([]);
    expect(rolloutOnly.rolloutPath).toBe(rolloutPath);

    // 状态库损坏:不能当成空 state 带着 rollout 判完整。
    fs.writeFileSync(path.join(accountHome, 'state_5.sqlite'), 'not a sqlite database');
    const corrupt = await dumpCodexThreadStateRows(threadId, { sqliteHome: accountHome, rolloutPath });
    expect(corrupt.rolloutPath).toBeNull();

    // 记录的状态目录不存在同样按读不出处理。
    const missingHome = await dumpCodexThreadStateRows(threadId, {
      sqliteHome: path.join(accountHome, 'gone'),
      rolloutPath,
    });
    expect(missingHome.rolloutPath).toBeNull();
  });

  it('classifies multi-account history size only from its indexed rollout', async () => {
    const accountHome = path.join(targetUserData, 'codex-accounts', 'owner', 'openai-a');
    const rolloutPath = path.join(accountHome, 'sessions', `rollout-2026-09-16-${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, `${rolloutLine(threadId, 'user', 'hi', '2026-09-16T00:00:00.000Z')}\n`);

    expect(await classifyCodexHistoryOversized(threadId)).toBe('unknown');
    expect(await classifyCodexHistoryOversized(threadId, { rolloutPath })).toBe('healthy');
    fs.rmSync(rolloutPath);
    expect(await classifyCodexHistoryOversized(threadId, { rolloutPath })).toBe('unknown');
  });

});

describe('paginated Codex rollout adoption (#7436)', () => {
  it.each([
    ['\\\\?\\C:\\Users\\Example\\.codex', 'C:\\Users\\Example\\.codex'],
    ['\\\\?\\UNC\\server\\share\\sessions', '\\\\server\\share\\sessions'],
    ['/home/example/.codex', '/home/example/.codex'],
  ])('normalizes filesystem aliases without changing their destination: %s', (source, expected) => {
    expect(normalizeCodexWindowsPath(source)).toBe(expected);
  });

  function brokenHistory(reverted = false, archived = false) {
    const home = path.join(targetUserData, 'account-history');
    const sqliteHome = path.join(targetUserData, 'account-state');
    const filename = `rollout-2026-10-14T10-13-41-${threadId}${reverted ? `_${execThreadId}` : ''}.jsonl`;
    const canonical = path.join(home, archived ? 'archived_sessions' : 'sessions', '2026', '10', '14', filename);
    const broken = path.join(path.dirname(canonical), `rollout-cindy-adopted-2-${filename}`);
    const contents = `${JSON.stringify({ type: 'session_meta', payload: {
      id: threadId, history_mode: 'paginated', timestamp: '2026-10-14T10:13:41Z',
    } })}\n`;
    fs.mkdirSync(path.dirname(broken), { recursive: true });
    fs.writeFileSync(broken, contents);
    const dbPath = createStateDb(sqliteHome);
    insertThread(dbPath, threadId, broken, { updatedAt: 2000, title: 'Keep my metadata' });
    const locations = new CodexThreadLocations(path.join(targetUserData, 'locations'), prepareCodexRolloutForResume);
    const readState = () => {
      const db = new Database(dbPath, { readonly: true });
      try { return db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId) as Record<string, unknown>; }
      finally { db.close(); }
    };
    return { home, sqliteHome, canonical, broken, contents, dbPath, locations, readState };
  }

  // #7436 review: root-only native fixtures missed history_base dependencies.
  // Unit tier drives the same preparation used by indexed resume, observing
  // files and pointers on invalid lineage, interrupted publication and retries.
  function ancestorHistory() {
    const f = brokenHistory();
    const filename = `rollout-2026-10-13T10-13-41-${execThreadId}.jsonl`;
    const relative = path.join('archived_sessions', filename);
    const parent = path.join(externalHome, relative);
    const localParent = path.join(f.home, relative);
    const parentContents = `${JSON.stringify({ ordinal: 0, type: 'session_meta', payload: {
      id: execThreadId, history_mode: 'paginated',
    } })}\n${JSON.stringify({ ordinal: 1, type: 'response_item', payload: { text: 'parent history' } })}\n`;
    fs.mkdirSync(path.dirname(parent), { recursive: true });
    fs.writeFileSync(parent, parentContents);
    const rootRecord = JSON.parse(f.contents);
    rootRecord.payload.history_base = {
      thread_id: execThreadId, end_ordinal_exclusive: 2, end_byte_offset: Buffer.byteLength(parentContents),
    };
    const childContents = `${JSON.stringify(rootRecord)}\n`;
    fs.writeFileSync(f.broken, childContents);
    const sourceChild = path.join(externalHome, 'sessions', path.basename(f.canonical));
    fs.mkdirSync(path.dirname(sourceChild), { recursive: true });
    fs.writeFileSync(sourceChild, childContents);
    return { ...f, parent, localParent, parentContents, childContents, sourceChild };
  }

  // #7458 review, unit: an existing SQLite pointer can select a custom source
  // outside discovery. Previously copying the child lost that source on retry.
  it.each([false, true])('imports ancestry from a custom state-pointed root (interrupted: %s)', async interrupted => {
    const f = ancestorHistory();
    const customHome = path.join(rootDir, 'custom-history');
    fs.renameSync(externalHome, customHome);
    const sourceChild = path.join(customHome, path.relative(externalHome, f.sourceChild));
    const parent = path.join(customHome, path.relative(externalHome, f.parent));
    const targetHome = path.join(targetUserData, 'codex-home');
    const dbPath = createStateDb(targetHome);
    insertThread(dbPath, threadId, sourceChild, { updatedAt: 2000 });
    if (interrupted) {
      fs.unlinkSync(parent);
      await expect(prepareExternalCodexSessionForResume(threadId)).rejects.toThrow('missing paginated');
      const db = new Database(dbPath, { readonly: true });
      try { expect((db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(threadId) as { rollout_path: string }).rollout_path).not.toBe(sourceChild); }
      finally { db.close(); }
      fs.writeFileSync(parent, f.parentContents);
    }
    const prepared = await prepareExternalCodexSessionForResume(threadId);
    expect(path.basename(prepared!)).toBe(path.basename(f.canonical));
    expect(fs.readFileSync(prepared!, 'utf8')).toBe(f.childContents);
    expect(fs.readFileSync(path.join(targetHome, path.relative(customHome, parent)), 'utf8')).toBe(f.parentContents);
    fs.appendFileSync(prepared!, 'new local turn\n');
    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(prepared);
    expect(fs.readFileSync(sourceChild, 'utf8')).toBe(f.childContents);
    expect(fs.readFileSync(parent, 'utf8')).toBe(f.parentContents);
    expect(fs.readFileSync(prepared!, 'utf8')).toContain('new local turn');
  });

  it.each(['missing', 'truncated', 'cycle', 'conflict'] as const)(
    'blocks %s ancestry without replacing the selected history or index', async fault => {
      const f = ancestorHistory();
      await f.locations.record(threadId, f.broken, f.sqliteHome);
      if (fault === 'missing') fs.unlinkSync(f.parent);
      if (fault === 'truncated') fs.writeFileSync(f.parent, '{}\n');
      if (fault === 'cycle') {
        fs.writeFileSync(f.parent, `${JSON.stringify({ type: 'session_meta', payload: {
          id: execThreadId, history_mode: 'paginated', history_base: {
            thread_id: threadId, end_ordinal_exclusive: 3, end_byte_offset: Buffer.byteLength(f.childContents),
          },
        } })}\n`);
      }
      if (fault === 'conflict') {
        fs.mkdirSync(path.dirname(f.localParent), { recursive: true });
        fs.writeFileSync(f.localParent, f.parentContents.replace('parent history', 'other! history'));
      }
      const before = f.readState();
      await expect(prepareCodexRolloutForResume(threadId, f.broken, f.sqliteHome, true)).rejects.toThrow(
        fault === 'missing' ? 'missing paginated' : fault === 'truncated' ? 'shorter' : fault === 'cycle' ? 'cyclic' : 'conflicts',
      );
      expect(f.readState()).toEqual(before);
      expect(await f.locations.read(threadId)).toBe(f.broken);
      expect(fs.readFileSync(f.broken, 'utf8')).toBe(f.childContents);
      expect(fs.existsSync(f.canonical)).toBe(false);
      if (fault === 'conflict') expect(fs.readFileSync(f.localParent, 'utf8')).toContain('other! history');
      else expect(fs.existsSync(f.localParent)).toBe(false);
    },
  );

  it('retries a partially published ancestor and later resumes without the external home', async () => {
    const f = ancestorHistory();
    await f.locations.record(threadId, f.broken, f.sqliteHome);
    const link = fs.promises.link;
    const spy = vi.spyOn(fs.promises, 'link').mockImplementationOnce(async (source, destination) => {
      await link(source, destination);
      throw Object.assign(new Error('interrupted after publication'), { code: 'EIO' });
    });
    try { await expect(f.locations.prepareResume(threadId, async () => undefined)).rejects.toThrow('interrupted'); }
    finally { spy.mockRestore(); }
    expect(await f.locations.read(threadId)).toBe(f.broken);
    expect(f.readState().rollout_path).toBe(f.broken);
    expect(fs.readFileSync(f.localParent, 'utf8')).toBe(f.parentContents);
    const inode = fs.statSync(f.localParent).ino;
    expect(await f.locations.prepareResume(threadId, async () => undefined)).toBe(f.canonical);
    expect(fs.statSync(f.localParent).ino).toBe(inode);
    fs.appendFileSync(f.localParent, 'later local history\n');
    // Ancestors can already have additional local turns: compare only the
    // immutable range referenced by the child, never overwrite that live tail.
    expect(await prepareCodexRolloutForResume(threadId, f.canonical, f.sqliteHome, true)).toBe(f.canonical);
    fs.rmSync(externalHome, { recursive: true, force: true });
    expect(await f.locations.prepareResume(threadId, async () => undefined)).toBe(f.canonical);
    expect(fs.readFileSync(f.localParent, 'utf8')).toBe(`${f.parentContents}later local history\n`);
  });

  it('reuses an already-imported ancestor inode so both child and parent can resume', async () => {
    const f = ancestorHistory();
    const oldParent = path.join(path.dirname(f.localParent), `rollout-cindy-adopted-${path.basename(f.localParent)}`);
    fs.mkdirSync(path.dirname(oldParent), { recursive: true });
    fs.writeFileSync(oldParent, f.parentContents);
    insertThread(f.dbPath, execThreadId, oldParent, { updatedAt: 2000 });
    await f.locations.record(threadId, f.broken, f.sqliteHome);
    await f.locations.record(execThreadId, oldParent, f.sqliteHome);
    expect(await f.locations.prepareResume(threadId, async () => undefined)).toBe(f.canonical);
    expect(fs.statSync(f.localParent).ino).toBe(fs.statSync(oldParent).ino);
    fs.appendFileSync(oldParent, 'parent native writer progress\n');
    expect(await f.locations.prepareResume(execThreadId, async () => undefined)).toBe(f.localParent);
    expect(fs.readFileSync(f.localParent, 'utf8')).toBe(`${f.parentContents}parent native writer progress\n`);
  });

  it('preserves a concurrent SQLite winner while importing an ancestor', async () => {
    const f = ancestorHistory();
    const winner = path.join(path.dirname(f.broken), 'winner.jsonl');
    fs.writeFileSync(winner, 'new native history');
    await f.locations.record(threadId, f.broken, f.sqliteHome);
    const link = fs.promises.link;
    const spy = vi.spyOn(fs.promises, 'link').mockImplementationOnce(async (source, destination) => {
      await link(source, destination);
      const db = new Database(f.dbPath);
      try { db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(winner, threadId); }
      finally { db.close(); }
    });
    try { await expect(f.locations.prepareResume(threadId, async () => undefined)).rejects.toThrow('state changed'); }
    finally { spy.mockRestore(); }
    expect(f.readState().rollout_path).toBe(winner);
    expect(await f.locations.read(threadId)).toBe(f.broken);
    expect(fs.existsSync(f.canonical)).toBe(false);
    expect(fs.readFileSync(winner, 'utf8')).toBe('new native history');
  });

  it('does not publish an ancestor replaced after lineage planning', async () => {
    const f = ancestorHistory();
    await f.locations.record(threadId, f.broken, f.sqliteHome);
    const copy = fs.promises.copyFile;
    const spy = vi.spyOn(fs.promises, 'copyFile').mockImplementationOnce(async (source, destination, mode) => {
      fs.unlinkSync(f.parent);
      fs.writeFileSync(f.parent, f.parentContents.replace('parent history', 'other! history'));
      await copy(source, destination, mode);
    });
    try { await expect(f.locations.prepareResume(threadId, async () => undefined)).rejects.toThrow('changed'); }
    finally { spy.mockRestore(); }
    expect(fs.existsSync(f.localParent)).toBe(false);
    expect(fs.existsSync(f.canonical)).toBe(false);
    expect(f.readState().rollout_path).toBe(f.broken);
    expect(await f.locations.read(threadId)).toBe(f.broken);
  });

  // Indexed resume used to bypass preparation completely. Cover both the host
  // storage lookup and direct resume, with separate SQLite ownership and revert IDs.
  it.each(['storage', 'resume'] as const)('repairs indexed reverted history through %s without adopting another home', async entry => {
    const f = brokenHistory(true, entry === 'storage');
    const before = f.readState();
    await f.locations.record(threadId, f.broken, f.sqliteHome);
    expect(await f.locations.readStorage(threadId)).toEqual({ historyHome: f.home, sqliteHome: f.sqliteHome, rolloutPath: f.broken });
    expect(fs.existsSync(f.canonical)).toBe(false); // archive/export remains read-only
    const legacy = vi.fn(async () => { throw new Error('must not rediscover history'); });
    if (entry === 'storage') {
      expect(await f.locations.readStorage(threadId, { home: externalHome, prepare: legacy })).toEqual({
        historyHome: f.home, sqliteHome: f.sqliteHome, rolloutPath: f.canonical,
      });
    } else {
      expect(await f.locations.prepareResume(threadId, legacy)).toBe(f.canonical);
    }
    expect(legacy).not.toHaveBeenCalled();
    expect(await f.locations.read(threadId)).toBe(f.broken);
    expect(f.readState()).toEqual({ ...before, rollout_path: f.canonical });
    expect(fs.readFileSync(f.canonical, 'utf8')).toBe(f.contents);
    expect(fs.readFileSync(f.broken, 'utf8')).toBe(f.contents);
  });

  it('retries after SQLite promotion but before index publication without losing appended history', async () => {
    const f = brokenHistory();
    await f.locations.record(threadId, f.broken, f.sqliteHome);
    expect(repairCodexRolloutPath(threadId, f.broken, f.sqliteHome)).toBe(f.canonical);
    fs.appendFileSync(f.broken, 'native writer progress\n');
    expect(await f.locations.prepareResume(threadId, async () => undefined)).toBe(f.canonical);
    expect(fs.readFileSync(f.canonical, 'utf8')).toBe(`${f.contents}native writer progress\n`);
    expect(fs.statSync(f.canonical).ino).toBe(fs.statSync(f.broken).ino);
    expect(await f.locations.prepareResume(threadId, async () => undefined)).toBe(f.canonical);
  });

  it('preserves a conflicting canonical file and both original pointers', async () => {
    const f = brokenHistory();
    await f.locations.record(threadId, f.broken, f.sqliteHome);
    fs.writeFileSync(f.canonical, 'another authoritative history');
    await expect(f.locations.prepareResume(threadId, async () => undefined)).rejects.toThrow('conflicts');
    expect(f.readState().rollout_path).toBe(f.broken);
    expect(await f.locations.read(threadId)).toBe(f.broken);
    expect(fs.readFileSync(f.broken, 'utf8')).toBe(f.contents);
    expect(fs.readFileSync(f.canonical, 'utf8')).toBe('another authoritative history');
  });

  it('does not overwrite a concurrent SQLite winner during canonical publication', () => {
    const f = brokenHistory();
    const winner = path.join(path.dirname(f.broken), 'concurrent.jsonl');
    fs.writeFileSync(winner, 'new history');
    const link = fs.linkSync;
    const spy = vi.spyOn(fs, 'linkSync').mockImplementation((source, destination) => {
      link(source, destination);
      const db = new Database(f.dbPath);
      try { db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(winner, threadId); }
      finally { db.close(); }
    });
    try { expect(() => repairCodexRolloutPath(threadId, f.broken, f.sqliteHome)).toThrow('state changed'); }
    finally { spy.mockRestore(); }
    expect(f.readState().rollout_path).toBe(winner);
    expect(fs.readFileSync(winner, 'utf8')).toBe('new history');
  });

  // #7458 review, unit: exercise the public importer with a directory alias,
  // which the Windows namespace cases did not cover. A differing source spelling
  // takes the existing flat-path fallback but must still preserve native identity,
  // SQLite ownership, original bytes and repeatable resume.
  it.each(['canonical', 'windows namespace', 'directory alias'] as const)('publishes a native filename and preserves history (%s)', async spelling => {
    const filename = `rollout-2026-10-14T10-13-41-${threadId}.jsonl`;
    const sourcePath = path.join(externalHome, 'sessions', '2026', '10', '14', filename);
    const contents = `${JSON.stringify({ type: 'session_meta', payload: {
      id: threadId, history_mode: 'paginated', timestamp: '2026-10-14T10:13:41Z',
    } })}\n`;
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, contents);
    let recordedPath = sourcePath;
    if (spelling === 'windows namespace') recordedPath = path.toNamespacedPath(sourcePath);
    if (spelling === 'directory alias') {
      const alias = path.join(rootDir, 'external-home-alias');
      fs.symlinkSync(externalHome, alias, process.platform === 'win32' ? 'junction' : 'dir');
      recordedPath = path.join(alias, path.relative(externalHome, sourcePath));
    }
    const sourceDb = createStateDb(externalHome);
    insertThread(sourceDb, threadId, recordedPath, { updatedAt: 2000 });
    const targetDb = createStateDb(path.join(targetUserData, 'codex-home'));

    const prepared = await prepareExternalCodexSessionForResume(threadId);
    expect(path.basename(prepared!)).toBe(filename);
    expect(path.relative(path.join(targetUserData, 'codex-home'), prepared!)).toBe(
      spelling === 'directory alias' ? path.join('sessions', filename) : path.join('sessions', '2026', '10', '14', filename),
    );
    const db = new Database(targetDb, { readonly: true });
    try {
      expect(db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(threadId)).toEqual({ rollout_path: prepared });
    } finally { db.close(); }
    expect(fs.readFileSync(prepared!, 'utf8')).toBe(contents);
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(contents);
    expect(await prepareExternalCodexSessionForResume(threadId)).toBe(prepared);
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
    electronMock.region = 'cn';
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

  it('does not implicitly adopt China-edition legacy state in the Global edition', async () => {
    const legacyHome = path.join(path.dirname(targetUserData), 'xdt-maker', 'codex-home');
    const sourceRollout = path.join(legacyHome, 'sessions', 'legacy.jsonl');
    fs.mkdirSync(path.dirname(sourceRollout), { recursive: true });
    fs.writeFileSync(sourceRollout, 'LEGACY_ROLLOUT');
    insertThread(createStateDb(legacyHome), threadId, sourceRollout, { updatedAt: 2_000 });
    const targetDbPath = createStateDb(desktopHome());
    process.env.CODEX_HOME = path.join(rootDir, 'missing-external-home');

    await prepareExternalCodexSessionForResume(threadId);

    const targetDb = new Database(targetDbPath, { readonly: true });
    try {
      expect(targetDb.prepare('SELECT id FROM threads WHERE id = ?').get(threadId)).toBeUndefined();
    } finally {
      targetDb.close();
    }
    expect(fs.readFileSync(sourceRollout, 'utf8')).toBe('LEGACY_ROLLOUT');
  });

  it('repairs a pre-existing external rollout pointer without overwriting current thread metadata', async () => {
    electronMock.region = 'cn';
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
    electronMock.region = 'cn';
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
    electronMock.region = 'cn';
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
    const recoveredMeta = JSON.parse(recovered.split('\n')[0]!) as {
      payload?: { originator?: string };
    };
    expect(recoveredMeta.payload?.originator).toBe('cindy');
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
    const externalDb = new Database(externalDbPath);
    externalDb.prepare('UPDATE threads SET originator = ? WHERE id = ?')
      .run('codex_cli_rs', threadId);
    externalDb.close();
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
    const recovered = fs.readFileSync(prepared!, 'utf-8');
    expect(recovered).toContain('recover from Cindy history');
    const recoveredMeta = JSON.parse(recovered.split('\n')[0]!) as {
      payload?: { originator?: string };
    };
    expect(recoveredMeta.payload?.originator).toBe('codex_cli_rs');
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
    const recovered = fs.readFileSync(prepared!, 'utf-8');
    expect(recovered).toContain('recover from Cindy history');
    const recoveredMeta = JSON.parse(recovered.split('\n')[0]!) as {
      payload?: { originator?: string };
    };
    expect(recoveredMeta.payload?.originator).toBe('cindy');
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
