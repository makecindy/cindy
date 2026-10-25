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
).replace(/\r\n?/g, '\n');

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
      context_window_runtime INTEGER,
      fast_mode INTEGER NOT NULL DEFAULT 0,
      plan_mode_enabled INTEGER NOT NULL DEFAULT 0,
      cleared_at INTEGER,
      pinned_at INTEGER,
      hidden_at INTEGER,
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
      im_default_route TEXT,
      used_project_context INTEGER NOT NULL DEFAULT 0,
      codex_history_has_product_prompt INTEGER,
      codex_plan_json TEXT,
      extra_dirs TEXT NOT NULL DEFAULT '[]',
      writable_dirs TEXT NOT NULL DEFAULT '[]',
      remote_host_id TEXT,
      agent_device_id TEXT,
      orca_remote_lead TEXT,
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
    CREATE TABLE bot_profiles (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, status TEXT NOT NULL, hidden_at INTEGER
    );
    CREATE TABLE bot_session_links (
      session_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, role TEXT NOT NULL
    );
    CREATE TABLE project_aliases (
      project_key TEXT PRIMARY KEY, alias TEXT NOT NULL, updated_at INTEGER NOT NULL
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

// #7026 / #6916: the mobile cache only contains the first 200 tasks. The existing
// mobile test supplied the matching task in that cache, so it missed this case.
// Unit tier: exercise production search against in-memory SQLite with an alias-only hit
// behind 200 unrelated tasks; no mobile cache or copied matching implementation.
describe('conversationSearch remote project aliases', () => {
  it.each(['/repo', 'C:/Repo'])('finds uncached alias hits in %s before limiting results', async (root) => {
    const db = createSearchDb();
    const client = makeSearchDbClient(db);
    setCurrentDbClient(client, 'test-user');
    mocks.searchChatHistoryHybrid.mockResolvedValue({
      hits: [], sessions: {}, vectorUsed: false, vectorSkipReason: null,
      nextOffset: null, hasMore: false, poolSize: 0, poolCapped: false,
    });
    try {
      for (let i = 0; i < 200; i += 1) insertSearchSession(db, `recent-${i}`, 1000 + i, null);
      const worktree = `${root}/.cindy-worktrees/branch`;
      for (const id of ['older', 'worktree', 'archived', 'hidden', 'worker', 'dialogue', 'ssh']) {
        insertSearchSession(db, id, 10, null);
        db.prepare('UPDATE sessions SET working_dir = ? WHERE id = ?').run(root, id);
      }
      db.prepare('UPDATE sessions SET working_dir = ? WHERE id = ?').run(worktree, 'worktree');
      db.exec("UPDATE sessions SET status = 'archived' WHERE id = 'archived'");
      db.exec("UPDATE sessions SET hidden_at = 1 WHERE id = 'hidden'");
      db.exec("UPDATE sessions SET orca_role = 'worker' WHERE id = 'worker'");
      db.exec("UPDATE sessions SET workspace_kind = 'dialogue' WHERE id = 'dialogue'");
      db.exec("UPDATE sessions SET remote_host_id = 'ssh-host' WHERE id = 'ssh'");
      db.prepare('INSERT INTO project_aliases VALUES (?, ?, ?)').run(`local:${root.toLowerCase()}`, 'Customer Portal', 10);
      const request = { query: 'CUSTOMER', limit: 2, semanticMode: 'keyword' as const, filters: { status: 'active' as const } };
      const result = await searchConversations(request, { remoteVisibleOnly: true });
      expect(result.results.map(item => item.session.id).sort()).toEqual(['older', 'worktree']);
      expect(result.results.every(item => item.titleMatchIndices.length === 0)).toBe(true);
      expect(result.results.every(item => item.session.title.startsWith('needle '))).toBe(true);
      expect((await searchConversations(request)).results).toEqual([]);
      expect((await searchConversations({ ...request, filters: { workingDirs: ['/elsewhere'] } }, { remoteVisibleOnly: true })).results).toEqual([]);
      expect((await searchConversations({ ...request, filters: { agentKind: 'pi' } }, { remoteVisibleOnly: true })).results).toEqual([]);
      expect((await searchConversations({ ...request, filters: { status: 'archived' } }, { remoteVisibleOnly: true })).results.map(item => item.session.id)).toEqual(['archived']);
      db.exec('DELETE FROM project_aliases');
      db.prepare('INSERT INTO project_aliases VALUES (?, ?, ?)').run(`remote:ssh-host:${root}`, 'Customer Portal', 10);
      db.prepare('INSERT INTO project_aliases VALUES (?, ?, ?)').run(`device:other:${root}`, 'Customer Portal', 10);
      expect((await searchConversations(request, { remoteVisibleOnly: true })).results).toEqual([]);
    } finally {
      clearCurrentDbClient(client);
      db.close();
    }
  });
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

describe('conversationSearch plugin background tasks', () => {
  it('includes hidden tasks in title and content candidates', async () => {
    const db = createSearchDb();
    const client = makeSearchDbClient(db);
    setCurrentDbClient(client, 'test-user');
    mocks.searchChatHistoryHybrid.mockResolvedValue({
      hits: [], sessions: {}, vectorUsed: false, vectorSkipReason: null,
      nextOffset: null, hasMore: false, poolSize: 0, poolCapped: false,
    });
    try {
      insertSearchSession(db, 'shown', 10, null);
      insertSearchSession(db, 'background', 20, null);
      db.prepare('UPDATE sessions SET hidden_at = 5 WHERE id = ?').run('background');
      const response = await searchConversations({ query: 'needle', semanticMode: 'keyword' });
      expect(response.results.map((result) => result.session.id).sort()).toEqual(['background', 'shown']);
      expect(mocks.searchChatHistoryHybrid).toHaveBeenCalledWith(
        expect.objectContaining({ sessionIds: expect.arrayContaining(['background', 'shown']) }),
      );
    } finally {
      clearCurrentDbClient(client);
      db.close();
    }
  });
});

// Production search entry + real SQLite. The prior source-only test could not
// catch missing companion transcripts. Owner search now covers all sources. DB tier.
describe('conversationSearch personal companion chats', () => {
  // 测试价值: searchConversations 必须返回本机渠道记录并标成只读, 旧覆盖只验证渠道被排除。
  // 最小输入: 渠道、群专线、后台任务及同词消息; 主人跨电脑可读，删除记录仍排除。DB tier。
  it('finds every owner task locally and remotely while retaining deletion boundaries', async () => {
    const db = createSearchDb();
    const client = makeSearchDbClient(db);
    setCurrentDbClient(client, 'test-user');
    mocks.searchChatHistoryHybrid.mockResolvedValue({
      hits: [], sessions: {}, vectorUsed: false, vectorSkipReason: null,
      nextOffset: null, hasMore: false, poolSize: 0, poolCapped: false,
    });
    try {
      db.exec("INSERT INTO bot_profiles VALUES ('bot', 'Melody', 'active', 5)");
      for (const [id, source, role, status] of [
        ['main', 'bot', 'canonical', 'active'],
        ['old', 'bot', 'history', 'archived'],
        ['imported', 'feishu', 'history', 'archived'],
        ['group', 'bot', 'group', 'active'],
        ['channel', 'desktop', 'channel', 'active'],
        ['feishu-channel', 'bot', 'channel', 'active'],
        ['old-channel', 'feishu', 'channel', 'archived'],
        ['deleted-channel', 'bot', 'channel', 'deleted'],
        ['deleted', 'bot', 'history', 'deleted'],
        ['task', 'desktop', 'delegation', 'active'],
        ['review', 'review', null, 'active'],
      ]) {
        insertSearchSession(db, id!, 10, null);
        db.prepare('UPDATE sessions SET source = ?, status = ? WHERE id = ?').run(source, status, id);
        if (role) db.prepare('INSERT INTO bot_session_links VALUES (?, ?, ?)').run(id, 'bot', role);
      }
      const result = await searchConversations({ query: 'needle', semanticMode: 'keyword' });
      const localIds = ['channel', 'feishu-channel', 'group', 'imported', 'main', 'old', 'old-channel', 'review', 'task'];
      expect(result.results.map(item => item.session.id).sort()).toEqual(localIds);
      expect(result.results.find(item => item.session.id === 'old')?.session.companion).toEqual({
        id: 'bot', name: 'Melody', role: 'history', readOnly: true,
      });
      expect(result.results.find(item => item.session.id === 'main')?.session.companion?.readOnly).toBe(false);
      expect(result.results.find(item => item.session.id === 'feishu-channel')?.session.companion).toEqual({
        id: 'bot', name: 'Melody', role: 'channel', readOnly: true,
      });
      expect(result.results.find(item => item.session.id === 'task')?.session.companion).toBeUndefined();
      expect(mocks.searchChatHistoryHybrid.mock.calls[0][0].sessionIds.sort()).toEqual(localIds);
      expect(mocks.searchChatHistoryHybrid.mock.calls[0][0].sessionSources).toBeNull();
      const archived = await searchConversations({ query: 'needle', filters: { status: 'archived' } });
      expect(archived.results.map(item => item.session.id).sort()).toEqual(['imported', 'old', 'old-channel']);
      const remote = await searchConversations({ query: 'needle' }, { remoteVisibleOnly: true });
      expect(remote.results.map(item => item.session.id).sort()).toEqual(localIds);
      db.exec("UPDATE bot_profiles SET hidden_at = NULL");
      const visibleRemote = await searchConversations({ query: 'needle', filters: { status: 'archived' } }, { remoteVisibleOnly: true });
      expect(visibleRemote.results.map(item => item.session.id).sort()).toEqual(['imported', 'old', 'old-channel']);

      // A content-only hit must retain its client id and read-only owner so the
      // existing result handler can open history at the exact message.
      db.prepare('INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('channel-message', 'channel-client', 'feishu-channel', 'assistant', 'contentneedle', 10);
      mocks.searchChatHistoryHybrid.mockResolvedValue({
        hits: [{ messageId: 'channel-message', sessionId: 'feishu-channel', role: 'assistant',
          createdAt: 10, score: 1, ftsRank: 1, vectorRank: null,
          context: [{ isHit: true, content: 'contentneedle' }] }],
        sessions: {}, vectorUsed: false, vectorSkipReason: null,
        nextOffset: null, hasMore: false, poolSize: 1, poolCapped: false,
      });
      const content = await searchConversations({ query: 'contentneedle', semanticMode: 'keyword' });
      expect(content.results).toHaveLength(1);
      expect(content.results[0]).toMatchObject({
        matchKind: 'content',
        session: { id: 'feishu-channel', companion: { role: 'channel', readOnly: true } },
        contentHit: { messageId: 'channel-message', messageClientId: 'channel-client' },
      });
      const remoteContent = await searchConversations({ query: 'contentneedle' }, { remoteVisibleOnly: true });
      expect(remoteContent.results).toEqual(content.results);
      db.exec("UPDATE bot_profiles SET status = 'deleting'");
      const deleting = await searchConversations({ query: 'needle' });
      expect(deleting.results.some(item => ['channel', 'feishu-channel', 'old-channel'].includes(item.session.id))).toBe(false);
    } finally {
      clearCurrentDbClient(client);
      db.close();
    }
  });
});

// Unit: search result rendering leaked JSON escapes after opening the same hit showed paragraphs.
// Exercise the production search entry + SQLite metadata lookup; retrieval/FTS content stays raw.
it('projects forwarded search hits only with their persisted session origin', async () => {
  const db = createSearchDb();
  const client = makeSearchDbClient(db);
  setCurrentDbClient(client, 'test-user');
  const content = '[来源] 用户原话由宿主从已接收的输入原样保留。\n用户原话："只检查"\nagent补充："第一段\\n\\n第二段 needle，保留 `\\\\n`"';
  const ids = ['forwarded', 'human', 'malformed-meta'];
  try {
    for (const id of ids) {
      insertSearchSession(db, id, 10, null);
      db.prepare('INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, id, id, 'user', content, id === 'forwarded' ? JSON.stringify({ origin: { kind: 'session' } }) : id === 'human' ? null : '{invalid', 10);
    }
    mocks.searchChatHistoryHybrid.mockResolvedValue({
      hits: ids.map(id => ({ messageId: id, sessionId: id, role: 'user', createdAt: 10,
        score: 1, ftsRank: 1, vectorRank: null, context: [{ isHit: true, content }] })),
      sessions: {}, vectorUsed: false, vectorSkipReason: null, nextOffset: null,
      hasMore: false, poolSize: 3, poolCapped: false,
    });
    const result = await searchConversations({ query: 'needle', semanticMode: 'keyword' });
    const forwarded = result.results.find(item => item.session.id === 'forwarded')!.contentHit!;
    expect(forwarded.preview).toContain('第一段 第二段 needle，保留 `\\n`');
    expect(forwarded.snippet).toBe(forwarded.preview);
    expect(forwarded.ftsRank).toBe(1);
    for (const id of ['human', 'malformed-meta']) {
      expect(result.results.find(item => item.session.id === id)!.contentHit!.preview)
        .toBe(content.replace(/\s+/g, ' '));
    }
    expect(db.prepare('SELECT content FROM messages WHERE id = ?').get('forwarded')).toEqual({ content });
    expect(mocks.searchChatHistoryHybrid.mock.calls[0][0].query).toBe('needle');
  } finally {
    clearCurrentDbClient(client);
    db.close();
  }
});
