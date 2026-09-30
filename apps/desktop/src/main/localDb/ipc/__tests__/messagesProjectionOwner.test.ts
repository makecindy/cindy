import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { messages, sessions } from '../../schema';
import type { DataOwnerBroadcastScope } from '../../../device-link/broadcast-tap';

const h = vi.hoisted(() => ({
  sqlite: null as Database.Database | null,
  client: null as {
    drizzle: ReturnType<typeof drizzle>;
    tx: (name: string, args: unknown) => Promise<unknown>;
    query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
  } | null,
  broadcast: vi.fn(),
  windowSend: vi.fn(),
  ownerScope: undefined as DataOwnerBroadcastScope | undefined,
  duringInsert: undefined as (() => void) | undefined,
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: h.windowSend } }] },
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
  commitMessageMediaRefs: vi.fn(async () => null),
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
  captureDataOwnerBroadcastScope: vi.fn(() => h.ownerScope ?? null),
  isDataOwnerBroadcastScopeCurrent: vi.fn((scope: DataOwnerBroadcastScope) => scope === h.ownerScope),
  getSafeDataOwnerPushStamp: vi.fn(() => h.ownerScope?.ownerStamp),
  tapWindowBroadcast: h.broadcast,
}));
vi.mock('../../client/current', () => ({
  getDbClient: () => h.client,
}));

import { createMessage } from '../messages';
import { tx } from '../../worker/opHandlers/tx';

function setupDb(): void {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cleared_at INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      list_preview TEXT, list_preview_role TEXT, list_message_count INTEGER
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
  const db = drizzle(sqlite, { schema: { messages, sessions } });
  h.sqlite = sqlite;
  h.client = {
    drizzle: db,
    tx: async (name: string, args: unknown) => {
      const result = tx(sqlite, { name, args });
      h.duringInsert?.();
      return result;
    },
    query: vi.fn(async (sql: string, params: unknown[] = []) => h.sqlite!.prepare(sql).all(...params)),
  };
}

describe('teammate projection owner broadcasts', () => {
  afterEach(() => h.sqlite?.close());
  beforeEach(() => {
    h.broadcast.mockClear();
    h.windowSend.mockClear();
    h.ownerScope = undefined;
    h.duringInsert = undefined;
    setupDb();
  });

  it.each([false, true])('keeps a projected reply on its original owner across message persistence (switch=%s)', async (switchOwner) => {
    const owner = { ownerScopeKey: 'original', ownerStamp: { dataOwnerId: 'original', ownerGeneration: 1 } };
    h.ownerScope = owner;
    h.duringInsert = () => {
      if (switchOwner) h.ownerScope = { ownerScopeKey: 'next', ownerStamp: { dataOwnerId: 'next', ownerGeneration: 2 } };
    };
    const message = await createMessage('s1', {
      clientId: 'reply-anchor', role: 'assistant', content: '',
      agentMeta: { botDirectMessage: { v: 1, threadId: 'thread', viewerBotId: 'local',
        peerBotId: 'old::mimi', peerBotName: 'Mimi', direction: 'received', sequence: 2, preview: 'private old reply' } },
    }, { broadcastOwnerScope: owner });
    expect(h.sqlite!.prepare('SELECT client_id FROM messages').get()).toEqual({ client_id: 'reply-anchor' });
    if (switchOwner) {
      expect(h.windowSend).not.toHaveBeenCalled();
      expect(h.broadcast).not.toHaveBeenCalled();
    } else {
      expect(h.broadcast).toHaveBeenCalledWith('local-db:messages:created', { sessionId: 's1', message }, owner.ownerStamp);
      expect(h.windowSend).toHaveBeenCalledWith('local-db:messages:created', expect.objectContaining({ message }), owner.ownerStamp);
    }
  });

});
