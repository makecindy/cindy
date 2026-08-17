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
      name TEXT NOT NULL
    );
    CREATE TABLE schedule_runs (
      id TEXT PRIMARY KEY,
      schedule_id TEXT NOT NULL,
      session_id TEXT
    );
  `);
  const client = { drizzle: drizzle(sqlite, { schema }) } as unknown as DbClient;
  setCurrentDbClient(client, 'test-user');
  activeHarness = { sqlite, client };
  return activeHarness;
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
    sqlite
      .prepare('INSERT INTO schedules (id, name) VALUES (?, ?)')
      .run('schedule-nightly-deploy', 'Nightly deployment');
    sqlite
      .prepare('INSERT INTO schedule_runs (id, schedule_id, session_id) VALUES (?, ?, ?)')
      .run('run-template', 'schedule-nightly-deploy', 'session-template');

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
});
