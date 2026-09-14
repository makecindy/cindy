/**
 * importSharedCodexThread / removeSharedCodexThread:
 * 用 temp desktop codex home + 真 state sqlite 验证落位、列交集容忍、回滚清理。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const electronMock = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => electronMock.userData) },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  importSharedCodexThread,
  removeSharedCodexThread,
  reserveCodexForkCleanup,
} from '../codex-local-sessions';

const THREAD_ID = '019dcd5a-6e54-7960-95e0-aa68117a28f1';

let rootDir = '';
let codexHome = '';
let stateDbPath = '';

/** 直接查 state DB 断言 thread 行存在与否(原 hasDesktopCodexThread 已随生产调用方清零而删除)。 */
function desktopThreadExists(threadId: string): boolean {
  const db = new Database(stateDbPath, { readonly: true });
  try {
    return db.prepare('SELECT id FROM threads WHERE id = ?').get(threadId) !== undefined;
  } finally {
    db.close();
  }
}

function createStateDb(): void {
  const db = new Database(stateDbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      cwd TEXT,
      rollout_path TEXT,
      source TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE thread_dynamic_tools (thread_id TEXT, tool_name TEXT);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
  `);
  db.close();
}

describe('importSharedCodexThread', () => {
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdtshare-codex-import-'));
    electronMock.userData = rootDir;
    codexHome = path.join(rootDir, 'codex-home');
    fs.mkdirSync(codexHome, { recursive: true });
    stateDbPath = path.join(codexHome, 'state_1.sqlite');
    createStateDb();
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const stateRows = () => ({
    threads: [
      {
        id: THREAD_ID,
        cwd: '/old/machine/proj',
        rollout_path: '/old/machine/rollout.jsonl',
        source: 'desktop',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
        // 目标表没有的列:必须被列交集丢弃而不是报错
        future_column: 'ignored',
      },
    ],
    threadDynamicTools: [{ thread_id: THREAD_ID, tool_name: 'browser' }],
    threadSpawnEdges: [],
  });

  it('writes rollout + state rows with cwd/rollout_path overrides and appends session index', async () => {
    const result = await importSharedCodexThread({
      threadId: THREAD_ID,
      stateRows: stateRows(),
      rolloutBuffer: Buffer.from('{"session_meta":{}}\n'),
      rolloutFilename: `rollout-2026-01-01-${THREAD_ID}.jsonl`,
      newCwd: '/new/machine/proj',
      title: '分享的 codex 会话',
      updatedAt: Date.now(),
    });
    expect(result.stateWritten).toBe(true);
    expect(result.statePresent).toBe(true);
    expect(result.rolloutPath).toBeTruthy();
    expect(result.rolloutWritten).toBe(true);
    expect(fs.readFileSync(result.rolloutPath!, 'utf-8')).toContain('session_meta');

    const db = new Database(stateDbPath, { readonly: true });
    const row = db.prepare('SELECT * FROM threads WHERE id = ?').get(THREAD_ID) as Record<string, unknown>;
    const tools = db.prepare('SELECT * FROM thread_dynamic_tools WHERE thread_id = ?').all(THREAD_ID);
    db.close();
    expect(row.cwd).toBe('/new/machine/proj');
    expect(row.rollout_path).toBe(result.rolloutPath);
    expect(tools).toHaveLength(1);

    const indexContent = fs.readFileSync(path.join(codexHome, 'session_index.jsonl'), 'utf-8');
    expect(indexContent).toContain(THREAD_ID);

    expect(desktopThreadExists(THREAD_ID)).toBe(true);
  });

  it('skips state write when no state db exists (fresh machine), still lands rollout', async () => {
    fs.rmSync(stateDbPath);
    const result = await importSharedCodexThread({
      threadId: THREAD_ID,
      stateRows: stateRows(),
      rolloutBuffer: Buffer.from('{}\n'),
      rolloutFilename: null,
      newCwd: '/new/proj',
      title: 't',
      updatedAt: Date.now(),
    });
    expect(result.stateWritten).toBe(false);
    expect(result.statePresent).toBe(false);
    expect(result.rolloutPath).toBeTruthy();
    expect(fs.existsSync(result.rolloutPath!)).toBe(true);
  });

  it('decodes base64 blob markers back to Buffer columns', async () => {
    const db = new Database(stateDbPath);
    db.exec('ALTER TABLE threads ADD COLUMN blob_col BLOB');
    db.close();
    const rows = stateRows();
    (rows.threads[0] as Record<string, unknown>).blob_col = {
      __xdtshareBlobB64: Buffer.from('binary').toString('base64'),
    };
    await importSharedCodexThread({
      threadId: THREAD_ID,
      stateRows: rows,
      rolloutBuffer: null,
      rolloutFilename: null,
      newCwd: '/new/proj',
      title: 't',
      updatedAt: Date.now(),
    });
    const check = new Database(stateDbPath, { readonly: true });
    const row = check.prepare('SELECT blob_col FROM threads WHERE id = ?').get(THREAD_ID) as {
      blob_col: Buffer;
    };
    check.close();
    expect(Buffer.isBuffer(row.blob_col)).toBe(true);
    expect(row.blob_col.toString()).toBe('binary');
  });

  it('refuses to write rollout when fallback filename would escape sessions dir (P0 second gate)', async () => {
    const evilThreadId = '../../../../tmp/evil';
    const result = await importSharedCodexThread({
      threadId: evilThreadId,
      stateRows: { threads: [], threadDynamicTools: [], threadSpawnEdges: [] },
      rolloutBuffer: Buffer.from('{}\n'),
      rolloutFilename: null, // 触发 threadId 兜底分支
      newCwd: '/new/proj',
      title: 't',
      updatedAt: Date.now(),
    });
    expect(result.rolloutPath).toBeNull();
    expect(fs.existsSync(path.join(rootDir, '..', 'tmp', 'evil.jsonl'))).toBe(false);
  });

  it('re-import reuses existing rollout/state without overwriting; rollback restores changed state (deleted-session re-import)', async () => {
    const first = await importSharedCodexThread({
      threadId: THREAD_ID,
      stateRows: stateRows(),
      rolloutBuffer: Buffer.from('{"v":1}\n'),
      rolloutFilename: `rollout-${THREAD_ID}.jsonl`,
      newCwd: '/new/proj',
      title: 't',
      updatedAt: Date.now(),
    });
    expect(first.rolloutWritten).toBe(true);
    expect(first.stateWritten).toBe(true);

    // 同一分享包重导(Maker 会话已删但盘上残留),且用户换了 workingDir:
    // 文件不覆盖、child 表不重插,但 threads 行的 cwd / rollout_path 要刷新
    // (codex resume 读 state DB,不刷新会跑回旧目录——review bot P2)
    const second = await importSharedCodexThread({
      threadId: THREAD_ID,
      stateRows: stateRows(),
      rolloutBuffer: Buffer.from('{"v":2}\n'),
      rolloutFilename: `rollout-${THREAD_ID}.jsonl`,
      newCwd: '/new/proj-relocated',
      title: 't',
      updatedAt: Date.now(),
    });
    expect(second.rolloutPath).toBe(first.rolloutPath);
    expect(second.rolloutWritten).toBe(false);
    expect(second.stateWritten).toBe(false); // 无新插入行
    expect(second.previousState).toMatchObject({
      dbPath: stateDbPath,
      values: {
        cwd: '/new/proj',
        rollout_path: first.rolloutPath,
      },
    });
    expect(second.statePresent).toBe(true); // 行仍在,不该触发降档提示
    expect(fs.readFileSync(second.rolloutPath!, 'utf-8')).toBe('{"v":1}\n'); // 未被覆盖

    const db = new Database(stateDbPath, { readonly: true });
    const row = db.prepare('SELECT cwd, rollout_path FROM threads WHERE id = ?').get(THREAD_ID) as {
      cwd: string;
      rollout_path: string;
    };
    const toolCount = db.prepare('SELECT COUNT(*) AS n FROM thread_dynamic_tools WHERE thread_id = ?').get(THREAD_ID) as { n: number };
    db.close();
    expect(row.cwd).toBe('/new/proj-relocated'); // 可变字段已刷新
    expect(row.rollout_path).toBe(second.rolloutPath);
    expect(toolCount.n).toBe(1); // child 表未翻倍

    // 第二次导入失败回滚:不得误删第一次落下的文件/state 行，并恢复更新前的可变字段。
    await removeSharedCodexThread(THREAD_ID, second);
    expect(fs.existsSync(first.rolloutPath!)).toBe(true);
    expect(desktopThreadExists(THREAD_ID)).toBe(true);
    const restoredDb = new Database(stateDbPath, { readonly: true });
    const restoredRow = restoredDb
      .prepare('SELECT cwd, rollout_path FROM threads WHERE id = ?')
      .get(THREAD_ID) as { cwd: string; rollout_path: string };
    restoredDb.close();
    expect(restoredRow.cwd).toBe('/new/proj');
    expect(restoredRow.rollout_path).toBe(first.rolloutPath);
  });

  it('removeSharedCodexThread rolls back rollout file and state rows', async () => {
    const result = await importSharedCodexThread({
      threadId: THREAD_ID,
      stateRows: stateRows(),
      rolloutBuffer: Buffer.from('{}\n'),
      rolloutFilename: null,
      newCwd: '/new/proj',
      title: 't',
      updatedAt: Date.now(),
    });
    await removeSharedCodexThread(THREAD_ID, result);
    expect(fs.existsSync(result.rolloutPath!)).toBe(false);
    expect(desktopThreadExists(THREAD_ID)).toBe(false);
    const db = new Database(stateDbPath, { readonly: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM thread_dynamic_tools').get()).toEqual({ n: 0 });
    db.close();
  });

  it('removes only the exact reserved fork rollout and state rows', async () => {
    const sourceThreadId = '019dcd5a-6e54-7960-95e0-aa68117a28f2';
    const rolloutPath = path.join(
      codexHome,
      'sessions',
      '2026',
      '08',
      '29',
      `rollout-2026-08-29T00-00-00-${THREAD_ID}.jsonl`,
    );
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, '{"type":"session_meta"}\n');
    const db = new Database(stateDbPath);
    db.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(THREAD_ID, rolloutPath);
    db.prepare('INSERT INTO thread_dynamic_tools (thread_id, tool_name) VALUES (?, ?)')
      .run(THREAD_ID, 'browser');
    db.close();

    const reservation = reserveCodexForkCleanup(THREAD_ID, sourceThreadId);
    expect(reservation).not.toBeNull();
    await reservation!();

    expect(fs.existsSync(rolloutPath)).toBe(false);
    expect(desktopThreadExists(THREAD_ID)).toBe(false);
    expect(reserveCodexForkCleanup(sourceThreadId, sourceThreadId)).toBeNull();
  });
});
