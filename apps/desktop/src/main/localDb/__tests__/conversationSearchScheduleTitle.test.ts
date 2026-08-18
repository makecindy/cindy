import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

const h = vi.hoisted(() => ({
  searchChatHistoryHybrid: vi.fn(),
}));

vi.mock('../chatHistorySearch.js', () => ({
  searchChatHistoryHybrid: h.searchChatHistoryHybrid,
}));

import type { DbClient } from '../client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../client/current.js';
import { searchConversations } from '../conversationSearch.js';
import * as schema from '../schema.js';

interface Harness {
  sqlite: Database.Database;
  client: DbClient;
}

let activeHarness: Harness | null = null;

function createHarness(): Harness {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Maker',
      working_dir TEXT,
      workspace_kind TEXT NOT NULL DEFAULT 'project',
      model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
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
      plan_mode_enabled INTEGER NOT NULL DEFAULT 0,
      cleared_at INTEGER,
      pinned_at INTEGER,
      summary TEXT,
      provider_id TEXT,
      user_send_at INTEGER,
      agent_kind TEXT NOT NULL DEFAULT 'cc',
      orca_role TEXT,
      parent_session_id TEXT,
      forked_at_message_id TEXT,
      worktree_path TEXT,
      source TEXT NOT NULL DEFAULT 'desktop',
      feishu_open_id TEXT,
      feishu_bot_app_id TEXT,
      im_bot_context_id TEXT,
      im_user_id TEXT,
      used_project_context INTEGER NOT NULL DEFAULT 0,
      codex_history_has_product_prompt INTEGER,
      codex_plan_json TEXT,
      extra_dirs TEXT NOT NULL DEFAULT '[]',
      remote_host_id TEXT,
      active_turn_started_at INTEGER,
      active_turn_pid INTEGER,
      last_turn_ended_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      rewind_at INTEGER
    );
    CREATE TABLE schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      target_session_id TEXT,
      legacy_session_fallback INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE schedule_runs (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      session_id TEXT,
      fired_at INTEGER NOT NULL
    );
    CREATE TABLE schedule_session_bindings (
      schedule_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      last_run_at INTEGER NOT NULL,
      PRIMARY KEY (schedule_id, session_id)
    );
    CREATE TRIGGER schedule_runs_bind_session_after_insert
    AFTER INSERT ON schedule_runs
    WHEN NEW.session_id IS NOT NULL
    BEGIN
      INSERT INTO schedule_session_bindings (schedule_id, session_id, last_run_at)
      VALUES (NEW.schedule_id, NEW.session_id, NEW.fired_at)
      ON CONFLICT(schedule_id, session_id) DO UPDATE SET
        last_run_at = MAX(schedule_session_bindings.last_run_at, excluded.last_run_at);
    END;
    CREATE TRIGGER schedule_runs_bind_session_after_update
    AFTER UPDATE OF schedule_id, session_id, fired_at ON schedule_runs
    WHEN NEW.session_id IS NOT NULL
    BEGIN
      INSERT INTO schedule_session_bindings (schedule_id, session_id, last_run_at)
      VALUES (NEW.schedule_id, NEW.session_id, NEW.fired_at)
      ON CONFLICT(schedule_id, session_id) DO UPDATE SET
        last_run_at = MAX(schedule_session_bindings.last_run_at, excluded.last_run_at);
    END;
  `);
  const client = { drizzle: drizzle(sqlite, { schema }) } as unknown as DbClient;
  setCurrentDbClient(client, 'test-user');
  activeHarness = { sqlite, client };
  return activeHarness;
}

function insertSchedule(
  sqlite: Database.Database,
  id: string,
  name: string,
  targetSessionId: string | null = null,
  legacySessionFallback = false,
): void {
  sqlite
    .prepare(
      `INSERT INTO schedules
        (id, name, target_session_id, legacy_session_fallback)
       VALUES (?, ?, ?, ?)`,
    )
    .run(id, name, targetSessionId, legacySessionFallback ? 1 : 0);
}

function insertRun(
  sqlite: Database.Database,
  id: string,
  scheduleId: string,
  sessionId: string,
  firedAt = 100,
): void {
  sqlite
    .prepare(
      'INSERT INTO schedule_runs (id, schedule_id, session_id, fired_at) VALUES (?, ?, ?, ?)',
    )
    .run(id, scheduleId, sessionId, firedAt);
}

async function searchResultSessionIds(query: string): Promise<string[]> {
  const result = await searchConversations({ query, semanticMode: 'keyword' });
  return result.results.map((item) => item.session.id).sort();
}

function insertSession(
  sqlite: Database.Database,
  id: string,
  title: string,
  source: 'desktop' | 'scheduler' = 'desktop',
): void {
  const now = Date.parse('2026-08-10T00:00:00.000Z');
  sqlite
    .prepare(
      `
    INSERT INTO sessions (id, title, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `,
    )
    .run(id, title, source, now, now);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.searchChatHistoryHybrid.mockResolvedValue({
    hits: [],
    vectorUsed: false,
    vectorSkipReason: 'keyword search requested',
    poolCapped: false,
    nextOffset: null,
  });
});

afterEach(() => {
  if (!activeHarness) return;
  clearCurrentDbClient(activeHarness.client);
  activeHarness.sqlite.close();
  activeHarness = null;
});

describe('conversation search schedule title association', () => {
  it('finds a generated instance title and its linked automation name', async () => {
    const { sqlite } = createHarness();
    const instanceTitle = '2026-08-10 deploy a1b2c3d4';
    insertSession(sqlite, 'session-template', instanceTitle, 'scheduler');
    insertSession(sqlite, 'unlinked-session', 'Manual deployment', 'scheduler');
    insertSchedule(sqlite, 'schedule-nightly-deploy', 'Nightly deployment');
    insertRun(sqlite, 'run-template', 'schedule-nightly-deploy', 'session-template');

    const byInstanceTitle = await searchConversations({
      query: 'a1b2c3d4',
      semanticMode: 'keyword',
    });
    expect(byInstanceTitle.results).toHaveLength(1);
    expect(byInstanceTitle.results[0]).toMatchObject({
      matchKind: 'title',
      session: { id: 'session-template', title: instanceTitle },
    });
    expect(byInstanceTitle.results[0]?.titleMatchIndices).toHaveLength('a1b2c3d4'.length);

    const byAutomationName = await searchConversations({
      query: 'nightly deployment',
      semanticMode: 'keyword',
    });
    expect(byAutomationName.results).toHaveLength(1);
    expect(byAutomationName.results[0]).toMatchObject({
      matchKind: 'title',
      session: { id: 'session-template', title: instanceTitle },
      // 命中的是未显示的 schedule 名称，不能把高亮位置投影到实例标题上。
      titleMatchIndices: [],
    });
  });

  it('keeps automation-name search after the visible run history is deleted', async () => {
    const { sqlite } = createHarness();
    insertSession(sqlite, 'session-retained-binding', '2026-08-10 a1b2c3d4', 'scheduler');
    insertSchedule(sqlite, 'schedule-retained-binding', 'Retained automation');
    insertRun(sqlite, 'run-to-delete', 'schedule-retained-binding', 'session-retained-binding');
    sqlite.prepare('DELETE FROM schedule_runs WHERE id = ?').run('run-to-delete');
    // Search reads only the authoritative binding table. Dropping the run-history
    // table makes an accidental fallback query fail loudly instead of hiding in data setup.
    sqlite.exec('DROP TABLE schedule_runs');

    const result = await searchConversations({
      query: 'retained automation',
      semanticMode: 'keyword',
    });

    expect(result.results).toEqual([
      expect.objectContaining({
        matchKind: 'title',
        session: expect.objectContaining({
          id: 'session-retained-binding',
          title: '2026-08-10 a1b2c3d4',
        }),
        titleMatchIndices: [],
      }),
    ]);
  });

  it('excludes a stale ordinary binding after the target session changes', async () => {
    const { sqlite } = createHarness();
    insertSession(sqlite, 'ordinary-a', 'Former manual target');
    insertSession(sqlite, 'ordinary-b', 'Current manual target');
    insertSchedule(sqlite, 'schedule-rebound', 'Rebound ordinary automation', 'ordinary-a');
    insertRun(sqlite, 'run-ordinary-a', 'schedule-rebound', 'ordinary-a', 100);
    sqlite
      .prepare('UPDATE schedules SET target_session_id = ? WHERE id = ?')
      .run('ordinary-b', 'schedule-rebound');
    insertRun(sqlite, 'run-ordinary-b', 'schedule-rebound', 'ordinary-b', 200);

    expect(await searchResultSessionIds('rebound ordinary automation')).toEqual(['ordinary-b']);
  });

  it('keeps a scheduler-generated historical binding after the target changes', async () => {
    const { sqlite } = createHarness();
    insertSession(sqlite, 'generated-a', 'Historical generated instance', 'scheduler');
    insertSession(sqlite, 'generated-current-b', 'Current manual instance');
    insertSchedule(sqlite, 'schedule-generated-history', 'Generated history automation', 'generated-a');
    insertRun(sqlite, 'run-generated-a', 'schedule-generated-history', 'generated-a', 100);
    sqlite
      .prepare('UPDATE schedules SET target_session_id = ? WHERE id = ?')
      .run('generated-current-b', 'schedule-generated-history');
    insertRun(
      sqlite,
      'run-generated-current-b',
      'schedule-generated-history',
      'generated-current-b',
      200,
    );

    expect(await searchResultSessionIds('generated history automation')).toEqual([
      'generated-a',
      'generated-current-b',
    ]);
  });

  it('keeps strict legacy generated history when the schedule allows legacy fallback', async () => {
    const { sqlite } = createHarness();
    insertSession(sqlite, 'legacy-a', '[Schedule] historical generated key');
    insertSession(sqlite, 'legacy-current-b', 'Current legacy target');
    insertSchedule(
      sqlite,
      'schedule-legacy-history',
      'Strict legacy automation',
      'legacy-a',
      true,
    );
    insertRun(sqlite, 'run-legacy-a', 'schedule-legacy-history', 'legacy-a', 100);
    sqlite
      .prepare('UPDATE schedules SET target_session_id = ? WHERE id = ?')
      .run('legacy-current-b', 'schedule-legacy-history');
    insertRun(
      sqlite,
      'run-legacy-current-b',
      'schedule-legacy-history',
      'legacy-current-b',
      200,
    );

    expect(await searchResultSessionIds('strict legacy automation')).toEqual([
      'legacy-a',
      'legacy-current-b',
    ]);
  });

  it('excludes a legacy-looking stale binding when fallback is disabled', async () => {
    const { sqlite } = createHarness();
    insertSession(sqlite, 'prefix-only-a', '[Schedule] historical generated key');
    insertSession(sqlite, 'prefix-current-b', 'Current prefix target');
    insertSchedule(
      sqlite,
      'schedule-prefix-disabled',
      'Disabled prefix automation',
      'prefix-only-a',
      false,
    );
    insertRun(sqlite, 'run-prefix-only-a', 'schedule-prefix-disabled', 'prefix-only-a', 100);
    sqlite
      .prepare('UPDATE schedules SET target_session_id = ? WHERE id = ?')
      .run('prefix-current-b', 'schedule-prefix-disabled');
    insertRun(
      sqlite,
      'run-prefix-current-b',
      'schedule-prefix-disabled',
      'prefix-current-b',
      200,
    );

    expect(await searchResultSessionIds('disabled prefix automation')).toEqual([
      'prefix-current-b',
    ]);
  });
});
