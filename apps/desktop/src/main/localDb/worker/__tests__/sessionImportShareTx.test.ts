import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tx } from '../opHandlers/tx.js';

/** 覆盖 session.importShare 用到的最小表结构(列名与真实 schema 对齐)。 */
function createTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Maker',
      working_dir TEXT,
      workspace_kind TEXT NOT NULL DEFAULT 'project',
      worktree_path TEXT,
      model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
      effort TEXT NOT NULL DEFAULT 'high',
      permission_mode TEXT NOT NULL DEFAULT 'ask',
      provider_id TEXT,
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
      agent_kind TEXT NOT NULL DEFAULT 'cc',
      source TEXT NOT NULL DEFAULT 'desktop',
      extra_dirs TEXT NOT NULL DEFAULT '[]',
      codex_history_has_product_prompt INTEGER,
      cleared_at INTEGER,
      user_send_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_use_id TEXT,
      agent_meta TEXT,
      agent_kind TEXT,
      created_at INTEGER NOT NULL,
      rewind_at INTEGER
    );
    CREATE UNIQUE INDEX uniq_messages_session_client ON messages(session_id, client_id);
  `);
}

function validArgs() {
  return {
    name: 'session.importShare',
    args: {
      session: {
        id: 'new-session-1',
        title: '分享来的会话',
        workingDir: '/Users/b/proj',
        workspaceKind: 'project',
        worktreePath: '/Users/b/proj/.xdt-worktrees/imp-1',
        model: 'claude-sonnet-4-6',
        effort: 'high',
        permissionMode: 'ask',
        providerId: 'prov-1',
        status: 'active',
        sdkSessionId: 'sdk-abc',
        totalTokenUsage: 1234,
        totalCostUsd: 0.5,
        contextTokens: 100,
        contextWindow: 200000,
        fastMode: false,
        planModeEnabled: false,
        agentKind: 'cc',
        source: 'shared',
        extraDirs: '[]',
        codexHistoryHasProductPrompt: null,
        clearedAt: 1700000000050,
        userSendAt: 1700000000000,
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
      },
      messages: [
        {
          id: 'm1',
          clientId: 'c1',
          role: 'user',
          content: '"hello"',
          toolUseId: null,
          agentMeta: null,
          agentKind: 'cc',
          createdAt: 1700000000100,
          rewindAt: null,
        },
        {
          id: 'm2',
          clientId: 'c2',
          role: 'assistant',
          content: '"world"',
          toolUseId: null,
          agentMeta: '{"sdkSessionId":"sdk-abc","uuid":"u2"}',
          agentKind: 'codex',
          createdAt: 1700000000200,
          rewindAt: null,
        },
        {
          id: 'm3',
          clientId: 'c3',
          role: 'assistant',
          content: '"rewound"',
          toolUseId: null,
          agentMeta: null,
          createdAt: 1700000000300,
          rewindAt: 1700000000400,
        },
      ],
    },
  };
}

describe('tx session.importShare', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createTables(db);
  });

  afterEach(() => {
    db.close();
  });

  it('inserts session and all messages (including rewound rows) atomically', () => {
    const result = tx(db, validArgs());
    expect(result).toEqual({ messageCount: 3 });
    const session = db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get('new-session-1') as Record<string, unknown>;
    expect(session.source).toBe('shared');
    expect(session.sdk_session_id).toBe('sdk-abc');
    expect(session.provider_id).toBe('prov-1');
    expect(session.worktree_path).toBe('/Users/b/proj/.xdt-worktrees/imp-1');
    expect(session.fast_mode).toBe(0);
    expect(session.cleared_at).toBe(1700000000050);
    const messages = db
      .prepare(
        'SELECT id, rewind_at, agent_kind FROM messages WHERE session_id = ? ORDER BY created_at',
      )
      .all('new-session-1') as Array<{
      id: string;
      rewind_at: number | null;
      agent_kind: string | null;
    }>;
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(messages.map((m) => m.agent_kind)).toEqual(['cc', 'codex', null]);
    expect(messages[2].rewind_at).toBe(1700000000400);
  });

  it('mid-batch invalid row → zero writes (transaction rollback)', () => {
    const args = validArgs();
    // 第二条消息缺 content(类型错) → 事务体校验抛错
    (args.args.messages[1] as Record<string, unknown>).content = 42;
    expect(() => tx(db, args)).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
  });

  it('duplicate message id mid-batch → zero writes', () => {
    const args = validArgs();
    args.args.messages[2].id = 'm1';
    expect(() => tx(db, args)).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
  });

  it('existing session id → ALREADY_EXISTS, nothing written', () => {
    tx(db, validArgs());
    const again = validArgs();
    again.args.messages = [];
    try {
      tx(db, again);
      expect.unreachable();
    } catch (err) {
      expect((err as { code?: string }).code).toBe('ALREADY_EXISTS');
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 3 });
  });
});
