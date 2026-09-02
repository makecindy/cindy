import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DbClient } from '../client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../client/current.js';
import * as schema from '../schema.js';

const mocks = vi.hoisted(() => ({
  searchChatHistoryHybrid: vi.fn(),
}));

vi.mock('../chatHistorySearch.js', () => ({
  searchChatHistoryHybrid: mocks.searchChatHistoryHybrid,
}));

import { searchConversations } from '../conversationSearch.js';

const conversationSearchSource = readFileSync(
  resolve(__dirname, '..', 'conversationSearch.ts'),
  'utf8',
);

describe('conversationSearch source invariants', () => {
  it('includes visible AskUser cards in content search roles', () => {
    expect(conversationSearchSource).toContain(
      "const SEARCH_ROLES = ['user', 'assistant', 'ask_user', 'plan_review'] as const;",
    );
  });

  // 标题匹配必须按**界面上显示的**标题算:未起名会话行上显示的是本地化兜底文案,
  // 拿原始哨兵匹配会让「搜得到的」与「看得到的」错位,命中下标也会错位。
  // renderer 渲染同一个 conversationSearchTitle,两端逐字一致(PR #1031)。
  it('matches session titles through the shared display projection', () => {
    expect(conversationSearchSource).toContain(
      'fuzzyTitleMatch(conversationSearchTitle(row.title, request.unnamedLabel), query)',
    );
  });

  // 返回给 renderer 的 summary 仍是原始存储值:投影只发生在匹配 / 渲染那一刻,
  // 不把某次请求时的 locale 固化进返回数据(本 PR 第 8 条不变量)。
  it('keeps the raw stored title in the session summary', () => {
    expect(conversationSearchSource).toContain('title: row.title,');
  });

  it('applies grouping-normalized workingDirs so remote project search is not window-bound', () => {
    expect(conversationSearchSource).toContain('applyWorkingDirFilter');
    expect(conversationSearchSource).toContain('normalizeWorkingDirForGrouping');
  });

  it('excludes Orca workers from searchable sessions', () => {
    expect(conversationSearchSource).toContain("ne(sessions.orcaRole, 'worker')");
  });

  it('scopes content retrieval to searchable session ids including global search', () => {
    expect(conversationSearchSource).toContain('sessionIds: allowedSessionIds');
    expect(conversationSearchSource).not.toContain(
      'filters.sessionIds !== null || filters.workingDirs !== null',
    );
  });

  it('keeps FTS hits only when visible text matches, not merely because preview is non-empty', () => {
    expect(conversationSearchSource).toContain('visibleTextMatchesMessagesFtsQuery');
    expect(conversationSearchSource).toContain('preview.keywordMatchedVisibleText');
    expect(conversationSearchSource).not.toContain('preview.preview.length === 0 ? null : hit.ftsRank');
  });
});

function createSearchDb(): Database.Database {
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
      writable_dirs TEXT NOT NULL DEFAULT '[]',
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
      agent_kind TEXT,
      created_at INTEGER NOT NULL,
      rewind_at INTEGER
    );
  `);
  return db;
}

function makeSearchDbClient(db: Database.Database): DbClient {
  return {
    drizzle: drizzle(db, { schema }),
  } as unknown as DbClient;
}

function insertSearchSession(
  db: Database.Database,
  id: string,
  updatedAt: number,
  userSendAt: number | null,
): void {
  db.prepare(
    `INSERT INTO sessions (id, title, status, source, agent_kind, user_send_at, created_at, updated_at)
     VALUES (?, ?, 'active', 'desktop', 'cc', ?, ?, ?)`,
  ).run(id, `needle ${id}`, userSendAt, updatedAt, updatedAt);
}

afterEach(() => {
  clearCurrentDbClient();
  vi.useRealTimers();
  mocks.searchChatHistoryHybrid.mockReset();
});

describe('conversationSearch recent activity SQL filtering', () => {
  it('filters the SQLite session candidates before title and content matching', async () => {
    const db = createSearchDb();
    const client = makeSearchDbClient(db);
    setCurrentDbClient(client, 'test-user');
    vi.useFakeTimers();
    const now = Date.parse('2026-09-02T00:00:00.000Z');
    vi.setSystemTime(now);
    mocks.searchChatHistoryHybrid.mockResolvedValue({
      hits: [],
      sessions: {},
      vectorUsed: false,
      vectorSkipReason: null,
      nextOffset: null,
      hasMore: false,
      poolSize: 0,
      poolCapped: false,
    });

    try {
      const day = 24 * 60 * 60 * 1000;
      insertSearchSession(db, 'updated-recently', now - day, null);
      insertSearchSession(db, 'sent-recently', now - 10 * day, now - day);
      insertSearchSession(db, 'stale', now - 10 * day, now - 10 * day);

      const response = await searchConversations({
        query: 'needle',
        semanticMode: 'keyword',
        filters: { lastActivity: '3d' },
      });

      expect(response.results.map((result) => result.session.id).sort()).toEqual([
        'updated-recently',
        'sent-recently',
      ].sort());
      expect(mocks.searchChatHistoryHybrid).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionIds: ['updated-recently', 'sent-recently'],
          sessionActivityFromMs: now - 3 * day,
        }),
      );
    } finally {
      clearCurrentDbClient(client);
      db.close();
    }
  });
});
