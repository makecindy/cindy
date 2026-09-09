import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/xdt-test-user-data'),
  },
}));

vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => ['/tmp/xdt-test-user-data', ...parts].join('/'),
}));

import {
  normalizeHistoryWorkingDir,
  resolveStoredWorkingDirCandidates,
} from '../workingDirHistoryFilter';
import { listSessionsForHistory, listWorkdirsForHistory } from '../chatHistoryReader';
import { clearCurrentDbClient, setCurrentDbClient } from '../client/current';
import type { DbClient } from '../client/DbClient';
import * as schema from '../schema';

function createLocalDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Maker',
      working_dir TEXT,
      workspace_kind TEXT NOT NULL DEFAULT 'project',
      model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
      effort TEXT NOT NULL DEFAULT 'high',
      permission_mode TEXT NOT NULL DEFAULT 'ask',
      status TEXT NOT NULL DEFAULT 'active',
      orca_role TEXT,
      user_send_at INTEGER,
      agent_kind TEXT NOT NULL DEFAULT 'cc',
      parent_session_id TEXT,
      source TEXT NOT NULL DEFAULT 'desktop',
      sdk_session_id TEXT,
      total_token_usage INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      total_cost_amount REAL NOT NULL DEFAULT 0,
      total_cost_currency TEXT,
      total_cost_is_approximate INTEGER NOT NULL DEFAULT 0,
      context_tokens INTEGER NOT NULL DEFAULT 0,
      context_window INTEGER NOT NULL DEFAULT 0,
      fast_mode INTEGER NOT NULL DEFAULT 0,
      plan_mode_enabled INTEGER NOT NULL DEFAULT 0,
      cleared_at INTEGER,
      pinned_at INTEGER,
      summary TEXT,
      provider_id TEXT,
      forked_at_message_id TEXT,
      worktree_path TEXT,
      feishu_open_id TEXT,
      feishu_bot_app_id TEXT,
      im_bot_context_id TEXT,
      im_user_id TEXT,
      used_project_context INTEGER NOT NULL DEFAULT 0,
      codex_history_has_product_prompt INTEGER,
      extra_dirs TEXT NOT NULL DEFAULT '[]',
      remote_host_id TEXT,
      active_turn_started_at INTEGER,
      active_turn_pid INTEGER,
      last_turn_ended_at INTEGER,
      list_preview TEXT,
      list_preview_role TEXT,
      list_message_count INTEGER,
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
    tx: async () => {
      throw new Error('tx not supported in this test');
    },
    drizzle: drizzle(db, { schema }),
    vecAvailable: false,
    dispose: async () => undefined,
  };
}

function insertSession(
  db: Database.Database,
  id: string,
  workingDir: string | null,
  createdAt: number,
): void {
  db.prepare(
    `INSERT INTO sessions (id, working_dir, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run(id, workingDir, createdAt, createdAt);
}

let openDb: Database.Database | null = null;

function useDb(): Database.Database {
  const db = createLocalDb();
  openDb = db;
  setCurrentDbClient(makeTestDbClient(db), 'test-user');
  return db;
}

afterEach(() => {
  clearCurrentDbClient();
  openDb?.close();
  openDb = null;
});

describe('normalizeHistoryWorkingDir', () => {
  it('normalizes legacy Windows drive and UNC spellings', () => {
    expect(normalizeHistoryWorkingDir('D:\\repo\\project')).toBe('D:/repo/project');
    expect(normalizeHistoryWorkingDir('\\\\?\\UNC\\server\\share\\repo')).toBe(
      '//server/share/repo',
    );
  });
});

describe('resolveStoredWorkingDirCandidates', () => {
  it('returns every stored spelling of the same physical directory, including trailing slashes', async () => {
    const db = useDb();
    insertSession(db, 's1', 'D:/Project-001', 1_000);
    insertSession(db, 's2', 'D:\\Project-001', 2_000);
    insertSession(db, 's3', 'D:\\Project-001\\', 3_000);
    insertSession(db, 's4', '\\\\?\\D:\\Project-001', 4_000);
    insertSession(db, 's5', 'D:/Project-002', 5_000);

    const candidates = await resolveStoredWorkingDirCandidates('D:\\Project-001');

    expect(candidates.sort()).toEqual(
      ['D:/Project-001', 'D:\\Project-001', 'D:\\Project-001\\', '\\\\?\\D:\\Project-001'].sort(),
    );
  });

  it('returns empty for blank input or directories absent from the DB', async () => {
    const db = useDb();
    insertSession(db, 's1', 'D:/Project-001', 1_000);

    expect(await resolveStoredWorkingDirCandidates('   ')).toEqual([]);
    expect(await resolveStoredWorkingDirCandidates(null)).toEqual([]);
    expect(await resolveStoredWorkingDirCandidates('E:/absent')).toEqual([]);
  });

  it('resolves managed dialogue cwds via the equality fast path', async () => {
    const db = useDb();
    const dialogueDir = '/tmp/xdt-test-user-data/dialogues/2026-07-04/d1';
    insertSession(db, 'd1', dialogueDir, 1_000);
    insertSession(db, 'p1', '/repo/project', 2_000);

    expect(await resolveStoredWorkingDirCandidates(dialogueDir)).toEqual([dialogueDir]);
    expect(
      await resolveStoredWorkingDirCandidates(
        '/tmp/xdt-test-user-data/dialogues/2026-07-04/absent',
      ),
    ).toEqual([]);
  });

  it('still resolves project dirs when the DB is dominated by managed dialogue rows', async () => {
    const db = useDb();
    for (let i = 0; i < 50; i += 1) {
      insertSession(db, `d${i}`, `/tmp/xdt-test-user-data/dialogues/2026-07-04/d${i}`, i);
    }
    insertSession(db, 'p1', 'D:/Project-001', 60);
    insertSession(db, 'p2', 'D:\\Project-001\\', 61);

    expect((await resolveStoredWorkingDirCandidates('D:/Project-001')).sort()).toEqual(
      ['D:/Project-001', 'D:\\Project-001\\'].sort(),
    );
  });
});

describe('listSessionsForHistory workdir filter', () => {
  it('matches trailing-slash legacy rows so counts agree with the workdir listing', async () => {
    const db = useDb();
    insertSession(db, 's1', 'D:/Project-001', 1_000);
    insertSession(db, 's2', 'D:\\Project-001\\', 2_000);

    const page = await listSessionsForHistory({
      workdir: 'D:/Project-001',
      fromMs: null,
      toMs: null,
      agentKind: null,
      includeDeleted: false,
      limit: 10,
      cursor: null,
      order: 'desc',
    });

    expect(page.items.map((s) => s.id).sort()).toEqual(['s1', 's2']);
  });
});

describe('listWorkdirsForHistory managed dialogue exclusion', () => {
  it('excludes app-managed dialogue workdirs from materialization but keeps explicit dirs', async () => {
    const db = useDb();
    insertSession(db, 'p1', '/repo/project', 1_000);
    // app-managed dialogue 目录(mock userData=/tmp/xdt-test-user-data):无界增长源,必须被 SQL 侧排除
    insertSession(db, 'd1', '/tmp/xdt-test-user-data/dialogues/2026-07-04/d1', 2_000);
    insertSession(db, 'd2', '/tmp/xdt-test-user-data/dialogues/2026-07-04/d2', 3_000);
    // dialogue 显式指定的真实目录不在 managed root 下,保留
    insertSession(db, 'd3', '/repo/dialogue-target', 4_000);
    // 与 managed root 同前缀的相邻真实目录不能被误排(greptile P1)
    insertSession(db, 'p2', '/tmp/xdt-test-user-data/dialogues-project', 5_000);

    const page = await listWorkdirsForHistory({ limit: 10, cursor: null, order: 'desc' });

    expect(page.items.map((w) => w.workingDir).sort()).toEqual(
      [
        '/repo/dialogue-target',
        '/repo/project',
        '/tmp/xdt-test-user-data/dialogues-project',
      ].sort(),
    );
  });
});

describe('listWorkdirsForHistory cursor pagination', () => {
  it('pages without gaps or duplicates when lastSessionAt ties across mixed-case dirs', async () => {
    const db = useDb();
    // 码元序: '/repo/B' < '/repo/C' < '/repo/a';localeCompare 会给出 a < B < C,
    // 排序与游标过滤混用两种比较时 /repo/B 会在翻页时被跳过(greptile P1 repro)。
    const now = 5_000;
    insertSession(db, 's1', '/repo/a', now);
    insertSession(db, 's2', '/repo/B', now);
    insertSession(db, 's3', '/repo/C', now);

    for (const order of ['asc', 'desc'] as const) {
      const seen: string[] = [];
      let cursor = null as { createdAt: number; id: string } | null;
      for (let i = 0; i < 5; i += 1) {
        const page = await listWorkdirsForHistory({ limit: 1, cursor, order });
        seen.push(...page.items.map((w) => w.workingDir));
        if (!page.hasMore) break;
        cursor = page.nextCursor;
      }
      expect(seen.sort()).toEqual(['/repo/B', '/repo/C', '/repo/a'].sort());
      expect(new Set(seen).size).toBe(3);
    }
  });
});
