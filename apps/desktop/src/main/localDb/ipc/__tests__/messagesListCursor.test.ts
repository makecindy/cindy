import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { messages, sessions } from '../../schema';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../maker-host/codex-local-sessions', () => ({
  importExternalCodexMessagesForSession: vi.fn(async () => undefined),
}));
vi.mock('../../../maker-host/claude-local-sessions', () => ({
  importExternalClaudeCodeMessagesForSession: vi.fn(async () => undefined),
}));
vi.mock('../../../embedders/chat-history-embedder', () => ({
  onMessageCreated: vi.fn(async () => undefined),
}));
vi.mock('../../../git-context/prRefsStore', () => ({
  recomputePrRefsForSession: vi.fn(async () => undefined),
  recordPrRefsForMessage: vi.fn(async () => undefined),
}));
vi.mock('../../client/current', () => ({
  getDbClient: () => ({ drizzle: h.db }),
}));

import {
  findParkedEngineSession,
  findPendingAgentHandoff,
  getMessageDeletionTarget,
  markLatestAgentHandoffConsumed,
  readPriorUserRoundCost,
  registerMessageIpc,
} from '../messages';

function createDb(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cleared_at INTEGER
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
  h.db = drizzle(sqlite, { schema: { messages, sessions } });
  return sqlite;
}

function insertMessage(
  sqlite: Database.Database,
  input: { id: string; createdAt: number; content: string },
): void {
  sqlite
    .prepare(
      `
      INSERT INTO messages (
        id, client_id, session_id, role, content, tool_use_id, agent_meta, created_at, rewind_at
      ) VALUES (
        @id, @clientId, 's1', 'assistant', @content, NULL, NULL, @createdAt, NULL
      )
    `,
    )
    .run({
      id: input.id,
      clientId: input.id,
      content: JSON.stringify(input.content),
      createdAt: input.createdAt,
    });
}

function insertCostMessage(
  sqlite: Database.Database,
  input: {
    id: string;
    role: 'user' | 'assistant';
    createdAt: number;
    agentMeta?: Record<string, unknown>;
    rewindAt?: number | null;
  },
): void {
  sqlite
    .prepare(
      `
      INSERT INTO messages (
        id, client_id, session_id, role, content, tool_use_id, agent_meta, created_at, rewind_at
      ) VALUES (
        @id, @id, 's1', @role, '""', NULL, @agentMeta, @createdAt, @rewindAt
      )
    `,
    )
    .run({
      ...input,
      agentMeta: input.agentMeta ? JSON.stringify(input.agentMeta) : null,
      rewindAt: input.rewindAt ?? null,
    });
}

describe('local-db:messages:list cursor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.handlers.clear();
  });

  it('continues through rows with the same timestamp using insertion order', async () => {
    const sqlite = createDb();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    insertMessage(sqlite, { id: 'row-z', createdAt: 1_000, content: 'same timestamp oldest' });
    insertMessage(sqlite, { id: 'row-a', createdAt: 1_000, content: 'same timestamp cursor' });
    insertMessage(sqlite, { id: 'row-m', createdAt: 1_000, content: 'same timestamp newest' });
    insertMessage(sqlite, { id: 'row-old', createdAt: 999, content: 'older row' });

    registerMessageIpc();
    const listHandler = h.handlers.get('local-db:messages:list');
    expect(listHandler).toBeTypeOf('function');

    const rows = await listHandler?.({}, 's1', { limit: 10, before: 'row-a' });

    expect((rows as Array<{ id: string; content: string }>).map((row) => row.id)).toEqual([
      'row-z',
      'row-old',
    ]);
    expect((rows as Array<{ id: string; rowid: number }>).map((row) => row.rowid)).toEqual([1, 4]);
  });

  it('keeps around windows stable for same timestamp rows', async () => {
    const sqlite = createDb();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    insertMessage(sqlite, { id: 'row-z', createdAt: 1_000, content: 'same timestamp oldest' });
    insertMessage(sqlite, { id: 'row-a', createdAt: 1_000, content: 'same timestamp cursor' });
    insertMessage(sqlite, { id: 'row-m', createdAt: 1_000, content: 'same timestamp newest' });

    registerMessageIpc();
    const aroundHandler = h.handlers.get('local-db:messages:around');
    expect(aroundHandler).toBeTypeOf('function');

    const rows = await aroundHandler?.({}, 's1', 'row-a', { radius: 1 });

    expect((rows as Array<{ id: string; content: string }>).map((row) => row.id)).toEqual([
      'row-z',
      'row-a',
      'row-m',
    ]);
    expect((rows as Array<{ id: string; rowid: number }>).map((row) => row.rowid)).toEqual([
      1, 2, 3,
    ]);
  });

  it('keeps around-client-id windows stable for same timestamp rows', async () => {
    const sqlite = createDb();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    insertMessage(sqlite, { id: 'row-z', createdAt: 1_000, content: 'same timestamp oldest' });
    insertMessage(sqlite, { id: 'row-a', createdAt: 1_000, content: 'same timestamp cursor' });
    insertMessage(sqlite, { id: 'row-m', createdAt: 1_000, content: 'same timestamp newest' });

    registerMessageIpc();
    const aroundClientIdHandler = h.handlers.get('local-db:messages:around-client-id');
    expect(aroundClientIdHandler).toBeTypeOf('function');

    const rows = await aroundClientIdHandler?.({}, 's1', 'row-a', { radius: 1 });

    expect((rows as Array<{ id: string; content: string }>).map((row) => row.id)).toEqual([
      'row-z',
      'row-a',
      'row-m',
    ]);
    expect((rows as Array<{ id: string; rowid: number }>).map((row) => row.rowid)).toEqual([
      1, 2, 3,
    ]);
  });

  it('caps around-client-id content before device-link relay', async () => {
    const sqlite = createDb();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    insertMessage(sqlite, { id: 'anchor', createdAt: 1_000, content: '0123456789' });

    registerMessageIpc();
    const handler = h.handlers.get('local-db:messages:around-client-id');
    const rows = (await handler?.({}, 's1', 'anchor', {
      radius: 0,
      contentCharLimit: 5,
    })) as Array<{
      id: string;
      content: string;
      agentMeta: Record<string, unknown>;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'anchor',
      content: '…6789',
      agentMeta: { remoteContentTruncated: true },
    });
  });

  it('历史消息读取时投影完整用户轮成本，但不回写原始分段', async () => {
    const sqlite = createDb();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    insertCostMessage(sqlite, { id: 'user', role: 'user', createdAt: 1_000 });
    insertCostMessage(sqlite, {
      id: 'segment-1',
      role: 'assistant',
      createdAt: 1_100,
      agentMeta: { turnCostUsd: 14.801987 },
    });
    insertCostMessage(sqlite, {
      id: 'segment-2',
      role: 'assistant',
      createdAt: 1_200,
      agentMeta: { turnCostUsd: 4.132204 },
    });
    insertCostMessage(sqlite, {
      id: 'segment-3',
      role: 'assistant',
      createdAt: 1_300,
      agentMeta: { turnCostUsd: 32.517991 },
    });
    insertCostMessage(sqlite, {
      id: 'final',
      role: 'assistant',
      createdAt: 1_400,
      agentMeta: { turnCostUsd: 0.777042 },
    });

    registerMessageIpc();
    const prepareSpy = vi.spyOn(sqlite, 'prepare');
    const listHandler = h.handlers.get('local-db:messages:list');
    const rows = (await listHandler?.({}, 's1', { limit: 10 })) as Array<{
      id: string;
      agentMeta: Record<string, unknown> | null;
    }>;
    const final = rows.find((row) => row.id === 'final');
    expect(final?.agentMeta).toMatchObject({
      turnCostUsd: 0.777042,
      userTurnCostUsd: 52.229224,
      userTurnCostIsEstimate: false,
    });
    const stored = sqlite.prepare('SELECT agent_meta FROM messages WHERE id = ?').get('final') as {
      agent_meta: string;
    };
    expect(JSON.parse(stored.agent_meta)).toEqual({
      turnCostUsd: 0.777042,
    });
    // list/session + one visibility scan (plus the direct storage assertion);
    // never one SQLite query set per SDK segment.
    expect(prepareSpy).toHaveBeenCalledTimes(5);
  });
});

describe('findPendingAgentHandoff 持久消费位', () => {
  function insertBoundary(
    sqlite: Database.Database,
    content: Record<string, unknown>,
    createdAt = 1_000,
  ): void {
    sqlite
      .prepare(
        `
      INSERT INTO messages (
        id, client_id, session_id, role, content, tool_use_id, agent_meta,
        agent_kind, created_at, rewind_at
      ) VALUES ('sw', 'sw', 's1', 'agent_switch', ?, NULL, NULL, 'cc', ?, NULL)
    `,
      )
      .run(JSON.stringify(content), createdAt);
  }

  function insertUser(sqlite: Database.Database, createdAt = 2_000): void {
    sqlite
      .prepare(
        `
      INSERT INTO messages (
        id, client_id, session_id, role, content, tool_use_id, agent_meta,
        agent_kind, created_at, rewind_at
      ) VALUES ('user-after', 'user-after', 's1', 'user', '"失败首发"', NULL, NULL, 'codex', ?, NULL)
    `,
      )
      .run(createdAt);
  }

  it('失败首发已落 user 行但 consumed=false,重启重建仍返回 handoff', async () => {
    const sqlite = createDb();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    insertBoundary(sqlite, { handoff: 'HANDOFF', consumed: false });
    insertUser(sqlite);
    await expect(findPendingAgentHandoff('s1')).resolves.toBe('HANDOFF');
  });

  it('consumed=true 即使没有 user 行也不再恢复', async () => {
    const sqlite = createDb();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    insertBoundary(sqlite, { handoff: 'HANDOFF', consumed: true });
    await expect(findPendingAgentHandoff('s1')).resolves.toBeNull();
  });

  it('v1 老边界缺 consumed 时保留 user 行启发式', async () => {
    const sqlite = createDb();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    insertBoundary(sqlite, { handoff: 'HANDOFF' });
    insertUser(sqlite);
    await expect(findPendingAgentHandoff('s1')).resolves.toBeNull();
  });

  it('restores a hidden context rebuild marker after app restart', async () => {
    const sqlite = createDb();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    sqlite
      .prepare(
        `
      INSERT INTO messages (
        id, client_id, session_id, role, content, tool_use_id, agent_meta,
        agent_kind, created_at, rewind_at
      ) VALUES ('ctx', 'ctx', 's1', 'context_rebuild', ?, NULL, NULL, 'cc', 3000, 3000)
    `,
      )
      .run(JSON.stringify({ handoff: 'FILTERED-HISTORY', consumed: false }));
    await expect(findPendingAgentHandoff('s1')).resolves.toBe('FILTERED-HISTORY');
    await markLatestAgentHandoffConsumed('s1');
    await expect(findPendingAgentHandoff('s1')).resolves.toBeNull();
    const stored = sqlite
      .prepare('SELECT content, rewind_at FROM messages WHERE id = ?')
      .get('ctx') as {
      content: string;
      rewind_at: number;
    };
    expect(JSON.parse(stored.content)).toMatchObject({
      handoff: 'FILTERED-HISTORY',
      consumed: true,
    });
    expect(stored.rewind_at).toBe(3000);
  });
});

describe('findParkedEngineSession context rebuild boundary', () => {
  it('does not resume a parked native session from before message deletion', async () => {
    const sqlite = createDb();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    sqlite
      .prepare(
        `
      INSERT INTO messages (
        id, client_id, session_id, role, content, tool_use_id, agent_meta,
        agent_kind, created_at, rewind_at
      ) VALUES
        ('sw', 'sw', 's1', 'agent_switch', ?, NULL, NULL, 'codex', 1000, NULL),
        ('ctx', 'ctx', 's1', 'context_rebuild', ?, NULL, NULL, NULL, 2000, 2000)
    `,
      )
      .run(
        JSON.stringify({ fromAgentKind: 'codex', fromSdkSessionId: 'parked-codex' }),
        JSON.stringify({ handoff: 'filtered', consumed: true }),
      );

    await expect(findParkedEngineSession('s1', 'codex')).resolves.toBeNull();
  });
});

describe('getMessageDeletionTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('selects the whole AI round across hidden auto-resume rows', async () => {
    const sqlite = createDb();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    const insert = sqlite.prepare(`
      INSERT INTO messages (
        id, client_id, session_id, role, content, tool_use_id, agent_meta, created_at, rewind_at
      ) VALUES (
        @id, @id, 's1', @role, @content, NULL, @agentMeta, @createdAt, NULL
      )
    `);
    for (const row of [
      { id: 'user', role: 'user', content: '"diagnose"', agentMeta: null, createdAt: 1_000 },
      {
        id: 'progress',
        role: 'assistant',
        content: '"checking"',
        agentMeta: null,
        createdAt: 1_100,
      },
      {
        id: 'thinking',
        role: 'thinking',
        content: '"analysis"',
        agentMeta: null,
        createdAt: 1_200,
      },
      {
        id: 'auto-resume',
        role: 'user',
        content: '"continue"',
        agentMeta: '{"autoResume":true}',
        createdAt: 1_300,
      },
      { id: 'tool', role: 'tool_result', content: '"result"', agentMeta: null, createdAt: 1_400 },
      { id: 'final', role: 'assistant', content: '"fixed"', agentMeta: null, createdAt: 1_500 },
      { id: 'error', role: 'error', content: '"late error"', agentMeta: null, createdAt: 1_600 },
      { id: 'switch', role: 'agent_switch', content: '{}', agentMeta: null, createdAt: 1_700 },
      { id: 'next-user', role: 'user', content: '"thanks"', agentMeta: null, createdAt: 1_800 },
      {
        id: 'next-answer',
        role: 'assistant',
        content: '"welcome"',
        agentMeta: null,
        createdAt: 1_900,
      },
    ]) {
      insert.run(row);
    }

    await expect(getMessageDeletionTarget('s1', 'progress')).resolves.toEqual({
      id: 'progress',
      role: 'assistant',
      deletedClientIds: ['progress', 'thinking', 'auto-resume', 'tool', 'final', 'error'],
    });
  });

  it('treats every persisted UI action trigger format as a hidden continuation row', async () => {
    const sqlite = createDb();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    const insert = sqlite.prepare(`
      INSERT INTO messages (
        id, client_id, session_id, role, content, tool_use_id, agent_meta, created_at, rewind_at
      ) VALUES (
        @id, @id, 's1', @role, @content, NULL, NULL, @createdAt, NULL
      )
    `);
    for (const row of [
      { id: 'user', role: 'user', content: '"diagnose"', createdAt: 1_000 },
      { id: 'progress', role: 'assistant', content: '"checking"', createdAt: 1_100 },
      {
        id: 'trigger-json-string',
        role: 'user',
        content: '"[UI_ACTION_TRIGGER] continue one"',
        createdAt: 1_200,
      },
      { id: 'middle', role: 'assistant', content: '"still checking"', createdAt: 1_300 },
      {
        id: 'trigger-json-object',
        role: 'user',
        content: '{"text":"[UI_ACTION_TRIGGER] continue two"}',
        createdAt: 1_400,
      },
      { id: 'almost-done', role: 'assistant', content: '"almost done"', createdAt: 1_500 },
      {
        id: 'trigger-legacy-raw',
        role: 'user',
        content: '[UI_ACTION_TRIGGER] continue three',
        createdAt: 1_600,
      },
      { id: 'final', role: 'assistant', content: '"fixed"', createdAt: 1_700 },
      { id: 'next-user', role: 'user', content: '"thanks"', createdAt: 1_800 },
    ]) {
      insert.run(row);
    }

    await expect(getMessageDeletionTarget('s1', 'middle')).resolves.toEqual({
      id: 'middle',
      role: 'assistant',
      deletedClientIds: [
        'progress',
        'trigger-json-string',
        'middle',
        'trigger-json-object',
        'almost-done',
        'trigger-legacy-raw',
        'final',
      ],
    });
  });

  it('pages past more than one boundary chunk of hidden continuation rows', async () => {
    const sqlite = createDb();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    const insert = sqlite.prepare(`
      INSERT INTO messages (
        id, client_id, session_id, role, content, tool_use_id, agent_meta, created_at, rewind_at
      ) VALUES (
        @id, @id, 's1', @role, @content, NULL, NULL, @createdAt, NULL
      )
    `);
    insert.run({
      id: 'prior-user',
      role: 'user',
      content: '"question"',
      agentMeta: null,
      createdAt: 1_000,
    });
    for (let index = 0; index < 40; index += 1) {
      insert.run({
        id: `prior-trigger-${index}`,
        role: 'user',
        content: `"[UI_ACTION_TRIGGER] prior ${index}"`,
        agentMeta: null,
        createdAt: 1_100 + index,
      });
    }
    insert.run({
      id: 'target',
      role: 'assistant',
      content: '"answer"',
      agentMeta: null,
      createdAt: 2_000,
    });
    for (let index = 0; index < 40; index += 1) {
      insert.run({
        id: `next-trigger-${index}`,
        role: 'user',
        content: `"[UI_ACTION_TRIGGER] next ${index}"`,
        agentMeta: null,
        createdAt: 2_100 + index,
      });
    }
    insert.run({
      id: 'next-user',
      role: 'user',
      content: '"next question"',
      agentMeta: null,
      createdAt: 3_000,
    });

    const target = await getMessageDeletionTarget('s1', 'target');
    expect(target?.deletedClientIds).toEqual([
      ...Array.from({ length: 40 }, (_, index) => `prior-trigger-${index}`),
      'target',
      ...Array.from({ length: 40 }, (_, index) => `next-trigger-${index}`),
    ]);
  });

  it('keeps a blank real user message as a deletion boundary', async () => {
    const sqlite = createDb();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    sqlite
      .prepare(
        `
      INSERT INTO messages (
        id, client_id, session_id, role, content, tool_use_id, agent_meta, created_at, rewind_at
      ) VALUES
        ('user', 'user', 's1', 'user', '"question"', NULL, NULL, 1000, NULL),
        ('before', 'before', 's1', 'assistant', '"before"', NULL, NULL, 1100, NULL),
        ('blank-user', 'blank-user', 's1', 'user', '""', NULL, NULL, 1200, NULL),
        ('target', 'target', 's1', 'assistant', '"target"', NULL, NULL, 1300, NULL)
    `,
      )
      .run();

    await expect(getMessageDeletionTarget('s1', 'target')).resolves.toEqual({
      id: 'target',
      role: 'assistant',
      deletedClientIds: ['target'],
    });
  });

  it('keeps user-message deletion scoped to the selected row', async () => {
    const sqlite = createDb();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    sqlite
      .prepare(
        `
      INSERT INTO messages (
        id, client_id, session_id, role, content, tool_use_id, agent_meta, created_at, rewind_at
      ) VALUES
        ('user', 'user', 's1', 'user', '"question"', NULL, NULL, 1000, NULL),
        ('answer', 'answer', 's1', 'assistant', '"answer"', NULL, NULL, 1100, NULL)
    `,
      )
      .run();

    await expect(getMessageDeletionTarget('s1', 'user')).resolves.toEqual({
      id: 'user',
      role: 'user',
      deletedClientIds: ['user'],
    });
  });
});

describe('readPriorUserRoundCost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('跨多个 SDK done 累计真实用户轮，跳过 autoResume，并以 rowid 处理同毫秒消息', async () => {
    const sqlite = createDb();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, NULL)').run('s1');
    insertCostMessage(sqlite, { id: 'user', role: 'user', createdAt: 1_000 });
    insertCostMessage(sqlite, {
      id: 'segment-1',
      role: 'assistant',
      createdAt: 1_100,
      agentMeta: { turnCostUsd: 14.801987 },
    });
    insertCostMessage(sqlite, {
      id: 'auto-resume',
      role: 'user',
      createdAt: 1_200,
      agentMeta: { autoResume: true },
    });
    insertCostMessage(sqlite, {
      id: 'segment-2',
      role: 'assistant',
      createdAt: 1_300,
      agentMeta: { turnCostUsd: 4.132204, turnCostIsEstimate: true },
    });
    // target 与上一个分段同毫秒，必须靠 rowid 排除 target 本身。
    insertCostMessage(sqlite, { id: 'target', role: 'assistant', createdAt: 1_300 });

    await expect(readPriorUserRoundCost('s1', 'target')).resolves.toEqual({
      money: {
        amount: expect.closeTo(18.934191 * 6.7, 10),
        currency: 'CNY',
        approximate: true,
        kind: 'actual-cost',
        estimateReasons: ['fixed-fx', 'legacy-usd', 'subscription-value'],
      },
      costUsd: 0,
      hasEstimatedValue: true,
    });
  });

  it('忽略 /clear 前和 rewind 的分段', async () => {
    const sqlite = createDb();
    sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, ?)').run('s1', 1_000);
    insertCostMessage(sqlite, { id: 'old-user', role: 'user', createdAt: 900 });
    insertCostMessage(sqlite, {
      id: 'old-segment',
      role: 'assistant',
      createdAt: 950,
      agentMeta: { turnCostUsd: 99 },
    });
    insertCostMessage(sqlite, { id: 'user', role: 'user', createdAt: 1_100 });
    insertCostMessage(sqlite, {
      id: 'visible-segment',
      role: 'assistant',
      createdAt: 1_200,
      agentMeta: { turnCostUsd: 0.5 },
    });
    insertCostMessage(sqlite, {
      id: 'rewound-segment',
      role: 'assistant',
      createdAt: 1_300,
      agentMeta: { turnCostUsd: 10 },
      rewindAt: 1_400,
    });
    insertCostMessage(sqlite, { id: 'target', role: 'assistant', createdAt: 1_500 });

    await expect(readPriorUserRoundCost('s1', 'target')).resolves.toEqual({
      money: {
        amount: 3.35,
        currency: 'CNY',
        approximate: true,
        kind: 'actual-cost',
        estimateReasons: ['fixed-fx', 'legacy-usd'],
      },
      costUsd: 0,
      hasEstimatedValue: false,
    });
  });
});
