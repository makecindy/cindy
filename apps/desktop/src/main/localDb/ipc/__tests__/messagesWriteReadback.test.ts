/**
 * messagesWriteReadback.test.ts
 * ---------------------------------------------------------------------------
 * 写路径去大字段回读(perf):createMessage happy path 与 updateMessageContent
 * 不再把整行 content 从 DB worker 读回主进程。这里守住两条不变量:
 *   1. 返回值语义与"整行回读 + messageToCamel"完全一致(JSON.parse 失败回退
 *      裸串、字符串 '123' 解析成数字、assistant 引文剥离);
 *   2. 写后的 SELECT 不再包含 content 列(updateMessageContent 窄回读),
 *      createMessage happy path 在 INSERT 之后没有任何 SELECT。
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { messages, sessions } from '../../schema';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  sqlite: null as Database.Database | null,
  client: null as any,
  queries: [] as string[],
  mediaRefCalls: [] as Array<{ sessionId: string; role: string; content: unknown }>,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
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
vi.mock('../../../cindy-media/chatAttachments', () => ({
  commitMessageMediaRefs: vi.fn(async (params: { sessionId: string; role: string; content: unknown }) => {
    h.mediaRefCalls.push(params);
    return null;
  }),
  collectCindyMediaHashes: vi.fn(() => []),
}));
vi.mock('../../../cindy-media/ledger', () => ({
  removeRefs: vi.fn(async () => undefined),
  removeSessionAttachmentRefIfUnreferencedByLiveMessage: vi.fn(async () => undefined),
}));
vi.mock('../../../device-link/invoke-context', () => ({
  isDeviceLinkInvoke: vi.fn(() => false),
}));
vi.mock('../../../device-link/broadcast-tap', () => ({
  captureDataOwnerBroadcastScope: vi.fn(() => null),
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: vi.fn(),
}));
vi.mock('../../client/current', () => ({
  getDbClient: () => h.client,
}));

import { createMessage, updateMessageContent } from '../messages';

function setupDb(): void {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cleared_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active'
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
    CREATE UNIQUE INDEX uniq_messages_session_client ON messages(session_id, client_id);
  `);
  sqlite.prepare("INSERT INTO sessions (id, cleared_at, status) VALUES ('s1', NULL, 'active')").run();
  const db = drizzle(sqlite, {
    schema: { messages, sessions },
    logger: {
      logQuery: (query: string) => {
        h.queries.push(query);
      },
    },
  });
  h.sqlite = sqlite;
  h.db = db;
  h.client = {
    drizzle: db,
    exec: vi.fn(async (sql: string, params: unknown[] = []) => h.sqlite!.prepare(sql).run(...params)),
    query: vi.fn(async (sql: string, params: unknown[] = []) => h.sqlite!.prepare(sql).all(...params)),
  };
}

describe('message write paths avoid large-content readback', () => {
  beforeEach(() => {
    h.queries.length = 0;
    h.mediaRefCalls.length = 0;
    setupDb();
  });

  describe('createMessage happy path', () => {
    it('issues no SELECT after the INSERT and returns the inserted row', async () => {
      const msg = await createMessage('s1', {
        clientId: 'c1',
        role: 'tool_result',
        content: 'big tool output',
        toolUseId: 'tu1',
        createdAt: 1000,
      });

      const insertIdx = h.queries.findIndex((q) => q.startsWith('insert into "messages"'));
      expect(insertIdx).toBeGreaterThanOrEqual(0);
      expect(
        h.queries.slice(insertIdx + 1).filter((q) => q.includes('from "messages"')),
      ).toEqual([]);

      expect(msg.clientId).toBe('c1');
      expect(msg.content).toBe('big tool output');
      expect(msg.toolUseId).toBe('tu1');
      expect(msg.createdAt).toBe(new Date(1000).toISOString());
      const stored = h.sqlite!
        .prepare('SELECT content, rewind_at FROM messages WHERE client_id = ?')
        .get('c1') as { content: string; rewind_at: number | null };
      expect(stored).toEqual({ content: 'big tool output', rewind_at: null });
    });

    it('keeps messageToCamel parse semantics on the constructed return value', async () => {
      const numericLike = await createMessage('s1', {
        clientId: 'c-num',
        role: 'user',
        content: '123',
      });
      expect(numericLike.content).toBe(123);

      const objectContent = await createMessage('s1', {
        clientId: 'c-obj',
        role: 'user',
        content: { text: 'hi', files: [] },
      });
      expect(objectContent.content).toEqual({ text: 'hi', files: [] });

      const cited = await createMessage('s1', {
        clientId: 'c-cite',
        role: 'assistant',
        content: 'answerciteopaque tail',
      });
      expect(cited.content).toBe('answer tail');
    });

    it('still returns the existing row on idempotent duplicate create', async () => {
      await createMessage('s1', { clientId: 'dup', role: 'user', content: 'first' });
      const again = await createMessage('s1', { clientId: 'dup', role: 'user', content: 'second' });
      expect(again.content).toBe('first');
    });
  });

  describe('updateMessageContent narrow readback', () => {
    it('re-reads the row without the content column and backfills from the input', async () => {
      await createMessage('s1', {
        clientId: 'u1',
        role: 'tool_result',
        content: 'summary',
        toolUseId: 'tu1',
      });
      h.queries.length = 0;

      const updated = await updateMessageContent('s1', 'u1', 'full text output');
      expect(updated?.content).toBe('full text output');
      expect(updated?.role).toBe('tool_result');

      const postUpdateSelects = h.queries.filter(
        (q) => q.startsWith('select') && q.includes('from "messages"'),
      );
      expect(postUpdateSelects.length).toBeGreaterThan(0);
      for (const q of postUpdateSelects) {
        expect(q).not.toMatch(/select[^]*"content"[^]*from "messages"/);
      }

      const stored = h.sqlite!
        .prepare('SELECT content FROM messages WHERE client_id = ?')
        .get('u1') as { content: string };
      expect(stored.content).toBe('full text output');
    });

    it('feeds the media-ref hook with the DB role and the just-written content', async () => {
      await createMessage('s1', { clientId: 'u2', role: 'tool_result', content: 'summary' });
      h.mediaRefCalls.length = 0;

      await updateMessageContent('s1', 'u2', 'full text with cindy-media url');
      expect(h.mediaRefCalls).toEqual([
        { sessionId: 's1', role: 'tool_result', content: 'full text with cindy-media url' },
      ]);
    });

    it('returns null when the row does not exist', async () => {
      const updated = await updateMessageContent('s1', 'missing', 'anything');
      expect(updated).toBeNull();
      expect(h.mediaRefCalls).toEqual([]);
    });

    it('keeps object-content serialization identical to a full readback', async () => {
      await createMessage('s1', { clientId: 'u3', role: 'ask_user', content: { status: 'pending' } });
      const updated = await updateMessageContent('s1', 'u3', { status: 'answered', answers: { q: 'a' } });
      expect(updated?.content).toEqual({ status: 'answered', answers: { q: 'a' } });
      const stored = h.sqlite!
        .prepare('SELECT content FROM messages WHERE client_id = ?')
        .get('u3') as { content: string };
      expect(JSON.parse(stored.content)).toEqual({ status: 'answered', answers: { q: 'a' } });
    });
  });
});
