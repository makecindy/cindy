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
      orca_role TEXT,
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
    CREATE TABLE orca_teams (
      id TEXT PRIMARY KEY,
      lead_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'active',
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE orca_workers (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES orca_teams(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'idle',
      label TEXT,
      worktree_branch TEXT,
      role TEXT NOT NULL DEFAULT 'developer',
      focused INTEGER NOT NULL DEFAULT 0,
      idle_since INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX uniq_orca_workers_session_id ON orca_workers(session_id);
    CREATE UNIQUE INDEX uniq_orca_workers_focused_per_team ON orca_workers(team_id) WHERE focused = 1;
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

  function orcaArgs() {
    const base = validArgs();
    const workerSession = {
      ...base.args.session,
      id: 'new-worker-1',
      title: 'Worker 会话',
      permissionMode: 'auto',
      orcaRole: 'worker',
      agentKind: 'codex',
      sdkSessionId: 'thread-w1',
    };
    return {
      name: 'session.importShare',
      args: {
        session: { ...base.args.session, orcaRole: 'lead' },
        messages: base.args.messages,
        orca: {
          team: {
            id: 'team-1',
            leadSessionId: base.args.session.id,
            status: 'active',
            completedAt: null,
            createdAt: 1700000002000,
            updatedAt: 1700000002000,
          },
          workers: [
            {
              record: {
                id: 'worker-rec-1',
                teamId: 'team-1',
                sessionId: 'new-worker-1',
                status: 'done',
                label: 'dev-1',
                role: 'developer',
                focused: true,
                createdAt: 1700000002000,
                updatedAt: 1700000002000,
              },
              session: workerSession,
              messages: [
                {
                  id: 'wm1',
                  clientId: 'wc1',
                  role: 'user',
                  content: '"task"',
                  toolUseId: null,
                  agentMeta: null,
                  agentKind: 'codex',
                  createdAt: 1700000002100,
                  rewindAt: null,
                },
              ],
            },
          ],
        },
      },
    };
  }

  it('orca bundle: lead + worker sessions + team + worker link land in one tx', () => {
    const result = tx(db, orcaArgs());
    expect(result).toEqual({ messageCount: 4 });
    const lead = db
      .prepare('SELECT orca_role FROM sessions WHERE id = ?')
      .get('new-session-1') as Record<string, unknown>;
    expect(lead.orca_role).toBe('lead');
    const worker = db
      .prepare('SELECT orca_role, permission_mode, agent_kind FROM sessions WHERE id = ?')
      .get('new-worker-1') as Record<string, unknown>;
    expect(worker.orca_role).toBe('worker');
    expect(worker.agent_kind).toBe('codex');
    const team = db.prepare('SELECT * FROM orca_teams WHERE id = ?').get('team-1') as Record<
      string,
      unknown
    >;
    expect(team.lead_session_id).toBe('new-session-1');
    expect(team.status).toBe('active');
    const link = db
      .prepare('SELECT * FROM orca_workers WHERE id = ?')
      .get('worker-rec-1') as Record<string, unknown>;
    expect(link.session_id).toBe('new-worker-1');
    expect(link.status).toBe('done');
    expect(link.focused).toBe(1);
    expect(link.idle_since).toBeNull();
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get('new-worker-1'),
    ).toEqual({ n: 1 });
  });

  it('orca bundle: worker session failure rolls back lead + team (zero writes)', () => {
    const args = orcaArgs();
    (args.args.orca.workers[0].session as Record<string, unknown>).title = 42;
    expect(() => tx(db, args)).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM orca_teams').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM orca_workers').get()).toEqual({ n: 0 });
  });

  it('overwrite replacement is atomic with the imported graph', () => {
    const existing = validArgs().args.session;
    db.prepare(
      `INSERT INTO sessions (
        id, title, working_dir, workspace_kind, worktree_path, model, effort, permission_mode,
        provider_id, status, sdk_session_id, total_token_usage, total_cost_usd, context_tokens,
        context_window, fast_mode, plan_mode_enabled, agent_kind, orca_role, source, extra_dirs,
        codex_history_has_product_prompt, cleared_at, user_send_at, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'existing-session',
      '旧会话',
      existing.workingDir,
      existing.workspaceKind,
      null,
      existing.model,
      existing.effort,
      existing.permissionMode,
      null,
      'active',
      'old-sdk',
      0,
      0,
      0,
      0,
      0,
      0,
      'cc',
      null,
      'desktop',
      '[]',
      null,
      null,
      null,
      1,
      1,
    );
    const args = orcaArgs();
    (args.args as typeof args.args & {
      replaceSessions?: Array<{ id: string; status: 'active' | 'archived' }>;
    }).replaceSessions = [{ id: 'existing-session', status: 'active' }];

    tx(db, args);

    expect(
      db.prepare('SELECT status FROM sessions WHERE id = ?').get('existing-session'),
    ).toEqual({ status: 'deleted' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 3 });
  });

  it('overwrite replacement rolls back when the imported graph fails', () => {
    const existing = validArgs().args.session;
    db.prepare(
      `INSERT INTO sessions (
        id, title, working_dir, workspace_kind, worktree_path, model, effort, permission_mode,
        provider_id, status, sdk_session_id, total_token_usage, total_cost_usd, context_tokens,
        context_window, fast_mode, plan_mode_enabled, agent_kind, orca_role, source, extra_dirs,
        codex_history_has_product_prompt, cleared_at, user_send_at, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'existing-session',
      '旧会话',
      existing.workingDir,
      existing.workspaceKind,
      null,
      existing.model,
      existing.effort,
      existing.permissionMode,
      null,
      'archived',
      'old-sdk',
      0,
      0,
      0,
      0,
      0,
      0,
      'cc',
      null,
      'desktop',
      '[]',
      null,
      null,
      null,
      1,
      1,
    );
    const args = orcaArgs();
    (args.args as typeof args.args & {
      replaceSessions?: Array<{ id: string; status: 'active' | 'archived' }>;
    }).replaceSessions = [{ id: 'existing-session', status: 'active' }];
    (args.args.orca.workers[0].session as Record<string, unknown>).title = 42;

    expect(() => tx(db, args)).toThrow();

    expect(
      db.prepare('SELECT status FROM sessions WHERE id = ?').get('existing-session'),
    ).toEqual({ status: 'archived' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM orca_teams').get()).toEqual({ n: 0 });
  });

  it('regular bundle without orca leaves orca_role NULL and no team rows', () => {
    tx(db, validArgs());
    const lead = db
      .prepare('SELECT orca_role FROM sessions WHERE id = ?')
      .get('new-session-1') as Record<string, unknown>;
    expect(lead.orca_role).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM orca_teams').get()).toEqual({ n: 0 });
  });
});
