/**
 * findLatestAssistantTranscriptUuid：会话关闭（如远程电脑断线）后，内存里的「最后一条
 * assistant uuid」被清掉；重发的第一条用户消息靠这个查询从库里补回 transcriptParentUuid。
 * 口径与内存值一致：顶层 assistant（有 uuid、没有 parentUuid），跳过已回退行与清空边界之前的行。
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { messages, sessions } from '../../localDb/schema';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
}));

vi.mock('../../localDb/client/current', () => ({
  getDbClient: () => ({ drizzle: h.db }),
}));

import { findLatestAssistantTranscriptUuid } from '../latestAssistantTranscriptUuid';

const SESSION = 'session-1';

function createDb(clearedAt: number | null = null): Database.Database {
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
  sqlite.prepare('INSERT INTO sessions (id, cleared_at) VALUES (?, ?)').run(SESSION, clearedAt);
  h.db = drizzle(sqlite, { schema: { messages, sessions } });
  return sqlite;
}

function insertRow(
  sqlite: Database.Database,
  input: {
    clientId: string;
    role: string;
    createdAt: number;
    agentMeta?: Record<string, unknown> | null;
    rewindAt?: number | null;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, created_at, rewind_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `id-${input.clientId}`,
      input.clientId,
      SESSION,
      input.role,
      JSON.stringify({ text: input.clientId }),
      input.agentMeta ? JSON.stringify(input.agentMeta) : null,
      input.createdAt,
      input.rewindAt ?? null,
    );
}

describe('findLatestAssistantTranscriptUuid', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = createDb();
  });

  it('returns the uuid of the newest top-level assistant row', async () => {
    insertRow(sqlite, { clientId: 'a-1', role: 'assistant', createdAt: 100, agentMeta: { uuid: 'uuid-old' } });
    insertRow(sqlite, { clientId: 'u-2', role: 'user', createdAt: 150, agentMeta: { uuid: 'user-uuid' } });
    insertRow(sqlite, { clientId: 'a-2', role: 'assistant', createdAt: 200, agentMeta: { uuid: 'uuid-last' } });

    await expect(findLatestAssistantTranscriptUuid(SESSION)).resolves.toBe('uuid-last');
  });

  it('skips sub-agent rows, rewound rows and rows without a uuid', async () => {
    insertRow(sqlite, { clientId: 'a-1', role: 'assistant', createdAt: 100, agentMeta: { uuid: 'uuid-top' } });
    insertRow(sqlite, {
      clientId: 'a-sub', role: 'assistant', createdAt: 200, agentMeta: { uuid: 'uuid-sub', parentUuid: 'tool-1' },
    });
    insertRow(sqlite, {
      clientId: 'a-rewound', role: 'assistant', createdAt: 300, agentMeta: { uuid: 'uuid-rewound' }, rewindAt: 400,
    });
    insertRow(sqlite, { clientId: 'a-bare', role: 'assistant', createdAt: 350, agentMeta: null });

    await expect(findLatestAssistantTranscriptUuid(SESSION)).resolves.toBe('uuid-top');
  });

  it('keeps looking past a long run of sub-agent rows', async () => {
    insertRow(sqlite, { clientId: 'a-top', role: 'assistant', createdAt: 100, agentMeta: { uuid: 'uuid-top' } });
    for (let i = 0; i < 120; i += 1) {
      insertRow(sqlite, {
        clientId: `a-sub-${i}`, role: 'assistant', createdAt: 200 + i, agentMeta: { uuid: `uuid-sub-${i}`, parentUuid: 'tool-1' },
      });
    }

    await expect(findLatestAssistantTranscriptUuid(SESSION)).resolves.toBe('uuid-top');
  });

  it('ignores assistant rows from before the clear boundary', async () => {
    sqlite = createDb(250);
    insertRow(sqlite, { clientId: 'a-before', role: 'assistant', createdAt: 200, agentMeta: { uuid: 'uuid-before' } });

    await expect(findLatestAssistantTranscriptUuid(SESSION)).resolves.toBeUndefined();
  });

  it('returns undefined for a conversation without assistant replies', async () => {
    insertRow(sqlite, { clientId: 'u-1', role: 'user', createdAt: 100, agentMeta: { uuid: 'user-uuid' } });

    await expect(findLatestAssistantTranscriptUuid(SESSION)).resolves.toBeUndefined();
  });
});
