import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { extractMessagePreview, finalizePlainPreview, sessionToCamel } from '../mapper';
import type { SessionRowWithCount } from '../mapper';
import {
  LATEST_VISIBLE_PREVIEW_FILTER_SQL,
  LIST_PREVIEW_EXTRACT_SQL,
  SESSION_LIST_PROJECTION_BACKFILL_SQL,
} from '../sessionListProjection.sql';

function openPreviewDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cleared_at INTEGER,
      list_preview TEXT,
      list_preview_role TEXT,
      list_message_count INTEGER
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      agent_meta TEXT,
      rewind_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_messages_session_created ON messages (session_id, created_at);
  `);
  return db;
}

const extractSql = `SELECT ${LIST_PREVIEW_EXTRACT_SQL} AS preview, m.role AS role
  FROM messages m
  JOIN sessions ON sessions.id = m.session_id
  WHERE m.session_id = ?
    AND ${LATEST_VISIBLE_PREVIEW_FILTER_SQL}
    AND (sessions.cleared_at IS NULL OR m.created_at > sessions.cleared_at)
  ORDER BY m.created_at DESC, m.rowid DESC
  LIMIT 1`;

describe('session list SQL preview extract', () => {
  it('extracts user .text and assistant JSON strings without slicing JSON', () => {
    const db = openPreviewDb();
    db.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, agent_meta, rewind_at, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
    ).run('m1', 's1', 'user', JSON.stringify({ text: 'hello from user', images: [] }), 1);
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, agent_meta, rewind_at, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
    ).run('m2', 's1', 'assistant', JSON.stringify('assistant markdown'), 2);

    const row = db.prepare(extractSql).get('s1') as { preview: string; role: string };
    expect(row.role).toBe('assistant');
    expect(row.preview).toBe('assistant markdown');
    expect(finalizePlainPreview(row.preview, row.role)).toBe('assistant markdown');
    db.close();
  });

  it('skips autoResume user rows and tool_result blobs', () => {
    const db = openPreviewDb();
    db.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, agent_meta, rewind_at, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
    ).run('m-user', 's1', 'user', JSON.stringify({ text: 'real question' }), 1);
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, agent_meta, rewind_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      'm-resume',
      's1',
      'user',
      JSON.stringify({ text: '继续' }),
      JSON.stringify({ autoResume: true }),
      3,
    );
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, agent_meta, rewind_at, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
    ).run('m-tool', 's1', 'tool_result', JSON.stringify({ text: 'x'.repeat(5000) }), 4);

    const row = db.prepare(extractSql).get('s1') as { preview: string; role: string };
    expect(row.role).toBe('user');
    expect(row.preview).toBe('real question');
    db.close();
  });

  it('fallback message count is the exact row total', () => {
    const db = openPreviewDb();
    db.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    const insert = db.prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, 's1', 'tool_result', '[]', 1)`,
    );
    const tx = db.transaction(() => {
      for (let i = 0; i < 15; i += 1) insert.run(`m${i}`);
    });
    tx();
    const count = db
      .prepare(`SELECT count(*) AS n FROM messages m WHERE m.session_id = ?`)
      .get('s1') as { n: number };
    expect(count.n).toBe(15);
    db.close();
  });
});

describe('sessionToCamel list preview cache', () => {
  it('uses listPreview as-is and does not parse it as JSON', () => {
    const session = sessionToCamel({
      id: 's-1',
      title: 't',
      workingDir: null,
      workspaceKind: 'project',
      model: 'm',
      effort: 'high',
      permissionMode: 'ask',
      providerId: null,
      status: 'active',
      sdkSessionId: null,
      totalTokenUsage: 0,
      totalCostUsd: 0,
      totalCostAmount: 0,
      totalCostCurrency: null,
      totalCostIsApproximate: false,
      contextTokens: 0,
      contextWindow: 0,
      fastMode: false,
      planModeEnabled: false,
      clearedAt: null,
      pinnedAt: null,
      userSendAt: null,
      agentKind: 'cc',
      source: 'desktop',
      orcaRole: null,
      parentSessionId: null,
      forkedAtMessageId: null,
      worktreePath: null,
      usedProjectContext: false,
      extraDirs: '[]',
      remoteHostId: null,
      activeTurnStartedAt: null,
      lastTurnEndedAt: null,
      listPreview: 'cached preview',
      listPreviewRole: 'assistant',
      listMessageCount: 4,
      summary: null,
      createdAt: 1,
      updatedAt: 1,
      messageCount: 4,
      latestMessageExtract: 'should not win',
      latestMessageContent: JSON.stringify({ text: 'should not parse' }),
      latestMessageRole: 'user',
    } as SessionRowWithCount);
    expect(session.preview).toBe('cached preview');
    expect(session._count?.messages).toBe(4);
  });

  it('sanitizes cached listPreview the same way as SQL extracts', () => {
    const session = sessionToCamel({
      id: 's-1',
      title: 't',
      workingDir: null,
      workspaceKind: 'project',
      model: 'm',
      effort: 'high',
      permissionMode: 'ask',
      providerId: null,
      status: 'active',
      sdkSessionId: null,
      totalTokenUsage: 0,
      totalCostUsd: 0,
      totalCostAmount: 0,
      totalCostCurrency: null,
      totalCostIsApproximate: false,
      contextTokens: 0,
      contextWindow: 0,
      fastMode: false,
      planModeEnabled: false,
      clearedAt: null,
      pinnedAt: null,
      userSendAt: null,
      agentKind: 'cc',
      source: 'desktop',
      orcaRole: null,
      parentSessionId: null,
      forkedAtMessageId: null,
      worktreePath: null,
      usedProjectContext: false,
      extraDirs: '[]',
      remoteHostId: null,
      activeTurnStartedAt: null,
      lastTurnEndedAt: null,
      listPreview: '[UI_ACTION_TRIGGER] continue',
      listPreviewRole: 'user',
      listMessageCount: 4,
      summary: null,
      createdAt: 1,
      updatedAt: 1,
      messageCount: 4,
    } as SessionRowWithCount);
    expect(session.preview).toBeNull();
  });

  it('finalizes SQL extracts without JSON.parse of a truncated object', () => {
    expect(extractMessagePreview(JSON.stringify({ text: 'hello world' }), 'user')).toBe(
      'hello world',
    );
    expect(finalizePlainPreview('hello world', 'user')).toBe('hello world');
  });
});

describe('session list projection backfill SQL', () => {
  it('recomputes NULL columns from messages and ignores stale payload values', () => {
    const db = openPreviewDb();
    db.prepare(
      `INSERT INTO sessions (id, cleared_at, list_preview, list_preview_role, list_message_count)
       VALUES (?, NULL, NULL, NULL, NULL), (?, NULL, 'keep me', 'user', NULL), (?, NULL, NULL, NULL, 7)`,
    ).run('s1', 's2', 's3');
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at)
       VALUES (?, 's1', 'assistant', ?, 2), (?, 's1', 'user', ?, 1), (?, 's2', 'assistant', ?, 1)`,
    ).run('m1', JSON.stringify('hello'), 'm0', JSON.stringify({ text: 'older' }), 'm2', JSON.stringify('stale'));

    db.prepare(SESSION_LIST_PROJECTION_BACKFILL_SQL).run(
      JSON.stringify([
        { id: 's1', preview: 'stale payload', role: 'user', count: 99, hasPreview: 1, hasCount: 1 },
        { id: 's2', preview: 'overwrite?', role: 'assistant', count: 9, hasPreview: 1, hasCount: 1 },
        { id: 's3', preview: 'new preview', role: 'user', count: 99, hasPreview: 1, hasCount: 1 },
      ]),
    );

    expect(
      db
        .prepare(
          'SELECT id, list_preview, list_preview_role, list_message_count FROM sessions ORDER BY id',
        )
        .all(),
    ).toEqual([
      { id: 's1', list_preview: 'hello', list_preview_role: 'assistant', list_message_count: 2 },
      { id: 's2', list_preview: 'keep me', list_preview_role: 'user', list_message_count: 1 },
      { id: 's3', list_preview: null, list_preview_role: null, list_message_count: 7 },
    ]);
    db.close();
  });

  it('does not write a pre-clear preview when cleared_at moved after list computed', () => {
    const db = openPreviewDb();
    db.prepare(
      `INSERT INTO sessions (id, cleared_at, list_preview, list_preview_role, list_message_count)
       VALUES (?, 50, NULL, NULL, NULL)`,
    ).run('s1');
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at)
       VALUES (?, 's1', 'assistant', ?, 10), (?, 's1', 'user', ?, 80)`,
    ).run('old', JSON.stringify('hidden'), 'fresh', JSON.stringify({ text: 'after clear' }));

    db.prepare(SESSION_LIST_PROJECTION_BACKFILL_SQL).run(
      JSON.stringify([{ id: 's1', preview: 'hidden', role: 'assistant', count: 2 }]),
    );
    expect(
      db
        .prepare(
          'SELECT list_preview, list_preview_role, list_message_count FROM sessions WHERE id = ?',
        )
        .get('s1'),
    ).toEqual({
      list_preview: 'after clear',
      list_preview_role: 'user',
      list_message_count: 2,
    });
    db.close();
  });

  it('uses cached list_message_count instead of recounting', () => {
    const db = openPreviewDb();
    db.prepare(
      'INSERT INTO sessions (id, list_preview, list_preview_role, list_message_count) VALUES (?, NULL, NULL, 2)',
    ).run('s1');
    const insert = db.prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, 's1', 'user', '"hi"', 1)`,
    );
    for (let i = 0; i < 5; i += 1) insert.run(`m${i}`);
    const row = db
      .prepare(
        `SELECT CASE
           WHEN list_message_count IS NOT NULL THEN list_message_count
           ELSE (
             SELECT count(*) FROM messages m WHERE m.session_id = sessions.id
           )
         END AS n FROM sessions WHERE id = ?`,
      )
      .get('s1') as { n: number };
    expect(row.n).toBe(2);
    db.close();
  });
});
