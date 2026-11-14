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
vi.mock('../../../session-import/legacy', () => ({
  adoptLegacySessionBeforeOpen: vi.fn(async () => undefined),
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

import { commitContextRebuild, createMessage, patchMessageAgentMetaWithResult } from '../messages';
import { setTaskChangeListener } from '../../taskEvents';
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
  afterEach(() => { setTaskChangeListener(undefined); h.sqlite?.close(); });
  beforeEach(() => {
    h.broadcast.mockClear();
    h.windowSend.mockClear();
    h.ownerScope = undefined;
    h.duringInsert = undefined;
    setupDb();
  });

  it('keeps a sampling metadata retry on its original database across an account switch', async () => {
    h.sqlite!.prepare(`INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, created_at)
      VALUES ('reply', 'reply', 's1', 'assistant', 'accepted', '{"samplingAttemptPending":true}', 1)`).run();
    const pending = patchMessageAgentMetaWithResult('s1', 'reply', { samplingAttemptPending: false });
    const nextOwnerUpdate = vi.fn(() => { throw new Error('must not write to the next owner'); });
    h.client = { ...h.client!, drizzle: { update: nextOwnerUpdate } as unknown as ReturnType<typeof drizzle> };
    await expect(pending).resolves.toMatchObject({ next: { samplingAttemptPending: false } });
    expect(nextOwnerUpdate).not.toHaveBeenCalled();
    expect(h.sqlite!.prepare('SELECT agent_meta FROM messages WHERE id = ?').get('reply')).toEqual({
      agent_meta: '{"samplingAttemptPending":false}',
    });
  });

  it.each([false, true])('keeps a projected reply on its original owner across message persistence (switch=%s)', async (switchOwner) => {
    const owner = { ownerScopeKey: 'original', ownerStamp: { dataOwnerId: 'original', ownerGeneration: 1 } };
    h.ownerScope = owner;
    const events: unknown[] = [];
    setTaskChangeListener((event, stamp) => events.push({ event, stamp }));
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
      expect(events).toEqual([]);
      expect(h.windowSend).not.toHaveBeenCalled();
      expect(h.broadcast).not.toHaveBeenCalled();
    } else {
      expect(events).toEqual([{ event: { kind: 'message', sessionId: 's1', message }, stamp: owner.ownerStamp }]);
      expect(h.broadcast).toHaveBeenCalledWith('local-db:messages:created', { sessionId: 's1', message }, owner.ownerStamp);
      expect(h.windowSend).toHaveBeenCalledWith('local-db:messages:created', expect.objectContaining({ message }), owner.ownerStamp);
    }
  });

});


// Persistence contract: the real Desktop wrapper must construct one atomic
// rebuild marker with null/undefined distinctions intact; tx tests cover the
// transaction itself but not this wrapper's metadata and timestamp choices.
describe('context rebuild marker assembly', () => {
  it('uses one timestamp and preserves the rejected SDK and explicit null route fields', async () => {
    const transaction = vi.fn(async () => undefined);
    h.client = { tx: transaction } as unknown as NonNullable<typeof h.client>;
    const result = await commitContextRebuild('s', 'handoff', {
      reason: 'native-session-recovery', sourceUserClientId: 'u', sourceAgentKind: 'codex',
      sourceModel: null, sourceProviderId: null, expectedSdkSessionId: 'rejected',
      replacementRoute: { model: 'new', providerId: 'p',
        effort: 'high', fastMode: false, expectedSdkSessionId: 'route-original' },
    });
    expect(transaction).toHaveBeenCalledWith('context.rebuild', expect.objectContaining({
      sessionId: 's', markerId: expect.any(String), markerClientId: expect.stringMatching(/^context-rebuild:/),
      markerCreatedAt: result.updatedAt, updatedAt: result.updatedAt, expectedClearedAt: null,
      expectedSdkSessionId: 'rejected',
    }));
    const args = transaction.mock.calls[0] as unknown as [string, { markerContent: string }];
    expect(JSON.parse(args[1].markerContent)).toEqual({ handoff: 'handoff', consumed: false,
      reason: 'native-session-recovery', sourceUserClientId: 'u', sourceAgentKind: 'codex',
      sourceModel: null, sourceProviderId: null, sourceSdkSessionId: 'route-original' });
  });
});
