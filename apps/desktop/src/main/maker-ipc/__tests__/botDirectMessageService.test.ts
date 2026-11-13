import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  createMessage: vi.fn(async (..._args: Parameters<typeof import('../../localDb/ipc/messages.js').createMessage>) => ({ id: 'anchor' })),
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({ drizzle: h.db }),
}));

vi.mock('../../localDb/ipc/messages.js', () => ({
  createMessage: h.createMessage,
}));

import { createBotDirectMessageService } from '../botDirectMessageService.js';
import { registerGroupToolAuthority } from '../botGroupToolAuthorization.js';

function createDatabase(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE bot_profiles (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      updated_at INTEGER NOT NULL,
      hidden_at INTEGER
    );
    CREATE TABLE bot_session_links (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      archived_at INTEGER
    );
    CREATE TABLE bot_direct_message_threads (
      id TEXT PRIMARY KEY,
      bot_a_id TEXT NOT NULL,
      bot_b_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      close_reason TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      max_messages INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      blocked_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER
    );
    CREATE TABLE bot_direct_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      sender_bot_id TEXT NOT NULL,
      recipient_bot_id TEXT NOT NULL,
      sender_session_id TEXT,
      recipient_session_id TEXT,
      delivery_status TEXT NOT NULL DEFAULT 'pending',
      sender_name TEXT,
      recipient_name TEXT,
      bridge_session_id TEXT,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(thread_id, sequence)
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      client_id TEXT,
      content TEXT,
      rewind_at INTEGER
    );
    INSERT INTO bot_profiles (id, display_name, status, updated_at) VALUES
      ('bot-a', '总控', 'active', 3),
      ('bot-b', 'Dash Bot', 'active', 2),
      ('bot-paused', '暂停伙伴', 'paused', 1),
      ('bot-missing', '缺主任务伙伴', 'active', 1);
    INSERT INTO sessions VALUES
      ('a-main', 'bot', 'active'),
      ('a-routine', 'bot', 'active'),
      ('a-route', 'bot', 'active'),
      ('a-history', 'bot', 'active'),
      ('a-archived', 'bot', 'archived'),
      ('b-main', 'bot', 'active'),
      ('paused-main', 'bot', 'active'),
      ('ordinary', 'desktop', 'active');
    INSERT INTO bot_session_links VALUES
      ('a-main-link', 'bot-a', 'a-main', 'canonical', NULL),
      ('a-routine-link', 'bot-a', 'a-routine', 'routine', NULL),
      ('a-route-link', 'bot-a', 'a-route', 'route', NULL),
      ('a-history-link', 'bot-a', 'a-history', 'history', 1),
      ('a-archived-link', 'bot-a', 'a-archived', 'history', 1),
      ('b-main-link', 'bot-b', 'b-main', 'canonical', NULL),
      ('paused-main-link', 'bot-paused', 'paused-main', 'canonical', NULL);
  `);
  return sqlite;
}

describe('botDirectMessageService', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = createDatabase();
    h.db = drizzle(sqlite);
    h.createMessage.mockReset().mockResolvedValue({ id: 'anchor' });
  });
  afterEach(() => sqlite.close());

  // V2 retired send_to_agent: teammates talk through send_to_session, so discovery must hand
  // back each main chat. Unit/persistence: a routine lane still speaks as its companion (#7256),
  // a teammate without a main chat has no address, and a remote one is deviceId::sessionId.
  it('lists each teammate with the main-chat address send_to_session takes', async () => {
    const list = vi.fn(async () => ({
      agents: [
        { id: 'studio::bot-c', name: 'Mimi', deviceId: 'studio', deviceName: 'Studio', sessionId: 'c-main' },
        { id: 'studio::bot-d', name: 'New', deviceId: 'studio', deviceName: 'Studio' },
      ],
      unavailableDevices: [],
    }));
    const service = createBotDirectMessageService({ directory: { list } });
    const result = await service.listAgents('a-routine');
    expect(result).toEqual({ ok: true, unavailableDevices: [], agents: [
      { id: 'bot-b', name: 'Dash Bot', local: true, session_id: 'b-main' },
      { id: 'bot-missing', name: '缺主任务伙伴', local: true },
      { id: 'studio::bot-c', name: 'Mimi', deviceId: 'studio', deviceName: 'Studio', local: false, session_id: 'studio::c-main' },
      { id: 'studio::bot-d', name: 'New', deviceId: 'studio', deviceName: 'Studio', local: false },
    ] });
    expect(await service.listAgents('ordinary')).toMatchObject({ ok: true, agents: expect.arrayContaining([
      { id: 'bot-a', name: expect.any(String), local: true, session_id: 'a-main' },
      { id: 'bot-b', name: 'Dash Bot', local: true, session_id: 'b-main' },
    ]) });
    expect(await service.listAgents('missing')).toMatchObject({ ok: false });
  });

  it('sends a group owner a real assistant message in their private chat, with stable retry receipts', async () => {
    sqlite.exec("INSERT INTO sessions VALUES ('a-group','bot','active'); INSERT INTO bot_session_links VALUES ('a-group-link','bot-a','a-group','group',NULL)");
    const release = registerGroupToolAuthority('a-group', { botId: 'bot-a', sourceGroup: { groupId: 'group-1', name: 'Design' }, mode: 'owner', isCurrent: () => true, validate: async () => {} });
    h.createMessage.mockImplementationOnce(async (sessionId, body) => {
      sqlite.prepare('INSERT INTO messages (id,session_id,client_id,content) VALUES (?,?,?,?)').run('private-message', sessionId, body.clientId, body.content);
      return { id: 'private-message' };
    });
    const service = createBotDirectMessageService({});
    try {
      const input = { callerSessionId: 'a-group', message: 'Private reply for the owner', idempotencyKey: 'reply-request-1' };
      expect(await service.sendToUser(input)).toMatchObject({ ok: true, targetSessionId: 'a-main', messageId: 'private-message', delivered: true });
      expect(h.createMessage).toHaveBeenCalledWith('a-main', expect.objectContaining({ role: 'assistant', content: input.message,
        agentMeta: { sourceGroup: { groupId: 'group-1', name: 'Design' }, origin: { kind: 'session', senderSessionId: 'a-group', senderBotId: 'bot-a', senderBotName: '总控' } } }), expect.anything());
      expect(await service.sendToUser(input)).toMatchObject({ ok: true, messageId: 'private-message' });
      expect(await service.sendToUser({ ...input, message: 'Different message' })).toMatchObject({ ok: false, errorCode: 'IDEMPOTENCY_CONFLICT' });
      expect(h.createMessage).toHaveBeenCalledOnce();
    } finally { release(); }
  });

  it.each(['deleted', 'archived'])('keeps the original private receipt after canonical recovery from %s', async status => {
    sqlite.exec("INSERT INTO sessions VALUES ('a-group','bot','active'); INSERT INTO bot_session_links VALUES ('a-group-link','bot-a','a-group','group',NULL)");
    const release = registerGroupToolAuthority('a-group', { botId: 'bot-a', sourceGroup: { groupId: 'group-1' },
      mode: 'owner', isCurrent: () => true, validate: async () => {} });
    const input = { callerSessionId: 'a-group', message: 'Private reply', idempotencyKey: 'stable-recovery-key' };
    const clientId = `bot-group-private:a-group:${input.idempotencyKey}`;
    // A matching key in another teammate's private history cannot claim this receipt.
    sqlite.prepare('INSERT INTO messages(id,session_id,client_id,content) VALUES(?,?,?,?)')
      .run('other-receipt', 'b-main', clientId, 'Different private content');
    h.createMessage.mockImplementationOnce(async (sessionId, body) => {
      sqlite.prepare('INSERT INTO messages(id,session_id,client_id,content) VALUES(?,?,?,?)')
        .run('original-receipt', sessionId, body.clientId, body.content);
      return { id: 'original-receipt' };
    });
    let recover = false;
    const ensureCanonicalSession = vi.fn(async (_botId: string, beforeRecovery?: () => Promise<void>) => {
      if (recover) {
        await beforeRecovery?.();
        sqlite.exec("UPDATE bot_session_links SET role='history', archived_at=1 WHERE session_id='a-main'; INSERT INTO sessions VALUES('a-restored','bot','active'); INSERT INTO bot_session_links VALUES('a-restored-link','bot-a','a-restored','canonical',NULL)");
        recover = false;
      }
      const target = sqlite.prepare("SELECT session_id AS sessionId FROM bot_session_links WHERE bot_id='bot-a' AND role='canonical'").get() as { sessionId: string };
      return { ok: true as const, sessionId: target.sessionId };
    });
    const service = createBotDirectMessageService({ ensureCanonicalSession });
    try {
      const receipt = { ok: true, messageId: 'original-receipt', targetSessionId: 'a-main', delivered: true };
      expect(await service.sendToUser(input)).toEqual(receipt);
      sqlite.prepare('UPDATE sessions SET status=? WHERE id=?').run(status, 'a-main');
      recover = true;
      expect(await service.sendToUser(input)).toEqual(receipt);
      expect(await service.sendToUser({ ...input, message: 'Changed body' }))
        .toMatchObject({ ok: false, errorCode: 'IDEMPOTENCY_CONFLICT' });
      expect(h.createMessage).toHaveBeenCalledOnce();
      expect(sqlite.prepare("SELECT count(*) AS n FROM messages WHERE session_id='a-restored'").get()).toEqual({ n: 0 });
    } finally { release(); }
  });

  it.each(['unregistered', 'tools', 'chat', 'revoked', 'other-bot', 'account'])(
    'refuses a group private send with %s authority without changing messages', async condition => {
      sqlite.exec("INSERT INTO sessions VALUES ('a-group','bot','active'); INSERT INTO bot_session_links VALUES ('a-group-link','bot-a','a-group','group',NULL)");
      const release = condition === 'unregistered' ? () => {} : registerGroupToolAuthority('a-group', {
        botId: condition === 'other-bot' ? 'bot-b' : 'bot-a', mode: condition === 'tools' || condition === 'chat' ? condition : 'owner',
        isCurrent: () => condition !== 'revoked', validate: async () => {},
      });
      const service = createBotDirectMessageService({
        captureOwnerScope: () => ({ ownerScopeKey: 'owner-a' }), isOwnerScopeCurrent: () => condition !== 'account' });
      try {
        expect(await service.sendToUser({ callerSessionId: 'a-group', message: 'Do not send', idempotencyKey: 'request-123' })).toMatchObject({ ok: false });
        expect(h.createMessage).not.toHaveBeenCalled();
      } finally { release(); }
    });

  it('coalesces concurrent roster discovery across sessions and clears failed flights', async () => {
    let settle!: (value: { agents: []; unavailableDevices: [] }) => void;
    let fail!: (error: Error) => void;
    let started!: () => void;
    let start = new Promise<void>(resolve => { started = resolve; });
    const list = vi.fn(() => new Promise<{ agents: []; unavailableDevices: [] }>((resolve, reject) => {
      settle = resolve; fail = reject; started();
    }));
    const service = createBotDirectMessageService({ directory: { list } });
    const calls = [service.listAgents('a-main'), service.listAgents('b-main')];
    await start;
    // Drain the other caller's local roster reads before settling the shared flight.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(list).toHaveBeenCalledOnce();
    fail(new Error('offline'));
    expect((await Promise.all(calls)).every(result => result.ok && result.discoveryError === 'REMOTE_DIRECTORY_UNAVAILABLE')).toBe(true);
    start = new Promise<void>(resolve => { started = resolve; });
    const retry = service.listAgents('a-main');
    await start;
    settle({ agents: [], unavailableDevices: [] });
    expect(await retry).toMatchObject({ ok: true, unavailableDevices: [] });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('does not share or clear a new owner roster flight when an old account settles', async () => {
    let owner = { ownerScopeKey: 'owner-1' };
    const resolvers: Array<(value: { agents: []; unavailableDevices: [] }) => void> = [];
    const list = vi.fn(() => new Promise<{ agents: []; unavailableDevices: [] }>(resolve => resolvers.push(resolve)));
    const service = createBotDirectMessageService({ captureOwnerScope: () => owner,
      isOwnerScopeCurrent: captured => captured === owner, directory: { list } });
    const old = service.listAgents('a-main');
    await new Promise<void>(resolve => setImmediate(resolve));
    owner = { ownerScopeKey: 'owner-2' };
    const current = service.listAgents('b-main');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(list).toHaveBeenCalledTimes(2);
    resolvers[0]({ agents: [], unavailableDevices: [] });
    expect(await old).toMatchObject({ ok: false, errorCode: 'OWNER_CHANGED' });
    const joined = service.listAgents('a-main');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(list).toHaveBeenCalledTimes(2);
    resolvers[1]({ agents: [], unavailableDevices: [] });
    expect((await Promise.all([current, joined])).every(result => result.ok)).toBe(true);
  });

  it('keeps a V1 thread readable and projects its idle expiry', async () => {
    sqlite.exec(`
      INSERT INTO bot_direct_message_threads (id, bot_a_id, bot_b_id, status, message_count, max_messages, expires_at, created_at, updated_at)
        VALUES ('thread-1', 'bot-a', 'bot-b', 'active', 2, 12, 2000, 1000, 1000);
      INSERT INTO bot_direct_messages (id, thread_id, sequence, sender_bot_id, recipient_bot_id, delivery_status, content, created_at) VALUES
        ('m1', 'thread-1', 1, 'bot-a', 'bot-b', 'delivered', 'hello', 1000),
        ('m2', 'thread-1', 2, 'bot-b', 'bot-a', 'pending', 'never accepted', 1001);
    `);
    const service = createBotDirectMessageService({ now: () => 2001 });
    expect(await service.getThread('thread-1', 'bot-a')).toMatchObject({ ok: true, thread: {
      status: 'closed', closeReason: 'idle-timeout', closedAt: 2000, messageCount: 1,
      messages: [{ id: 'm1', senderBotName: '总控', recipientBotName: 'Dash Bot', content: 'hello' }],
    } });
    expect(await service.getThread('thread-1', 'bot-missing')).toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
  });
});
