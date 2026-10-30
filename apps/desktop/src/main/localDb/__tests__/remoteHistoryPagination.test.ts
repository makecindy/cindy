import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listSessionsForHistory, getMessagesForHistory } from '../chatHistoryReader';
import { pendingBotTaskOriginHandoff } from '../botTaskOrigin';
import { XdtHelperToolRegistry, registerGetChatHistoryTool, registerSearchChatHistoryTool, historyPayload } from '@cindy/mcps';
import { searchChatHistoryHybrid } from '../chatHistorySearch';
import { readRemoteBotSessionAccessBatch } from '../ipc/botRemoteSessionAccess';
import { setChatEmbeddingEnabled } from '../../embedders/chat-history-embedder';
import { registerHistoryQueryIpc } from '../ipc/historyQuery';
import { runDeviceLinkInvokeContext } from '../../device-link/invoke-context';
import {
  assertRemoteBotInvocationAllowed,
  projectRemoteSessionResult,
  setRemoteBotSessionLookup,
} from '../../device-link/remoteBotSessionBoundary';

const state = vi.hoisted(() => ({ client: null as any }));
const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock('../client/current', () => ({ getDbClient: () => state.client }));
vi.mock('../../embedding-host', () => ({
  getEmbeddingService: () => ({ embedSync: async () => ({ embeddings: [[1]] }) }),
}));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => 1,
  isDataOwnerBroadcastScopeCurrent: () => true,
}));
vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: {
    handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
  },
}));
vi.mock('../../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));

// Linux has no bundled sqlite-vec; keep the SQL fixture on every platform.
const modes = [
  'sql-fixture',
  ...(['darwin', 'win32'].includes(process.platform) ? ['native-vec'] : []),
];
describe.each(modes)('%s remote history visibility', (mode) => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT DEFAULT '', working_dir TEXT,
      agent_kind TEXT DEFAULT 'codex', workspace_kind TEXT DEFAULT 'project', model TEXT DEFAULT '',
      status TEXT DEFAULT 'active', source TEXT DEFAULT 'desktop', orca_role TEXT, orca_remote_lead TEXT,
      parent_session_id TEXT, created_at INTEGER, updated_at INTEGER, user_send_at INTEGER, hidden_at INTEGER, cleared_at INTEGER);
    CREATE TABLE messages (id TEXT PRIMARY KEY, client_id TEXT, session_id TEXT, role TEXT,
      content TEXT, tool_use_id TEXT, agent_meta TEXT, agent_kind TEXT, created_at INTEGER, rewind_at INTEGER);
    CREATE VIRTUAL TABLE messages_fts USING fts5(message_id UNINDEXED, content);
    CREATE TABLE bot_profiles (id TEXT PRIMARY KEY, hidden_at INTEGER, status TEXT);
    CREATE TABLE bot_session_links (session_id TEXT PRIMARY KEY, bot_id TEXT, role TEXT DEFAULT 'canonical', route_key TEXT);
    CREATE TABLE bot_task_origins (bot_id TEXT, source_session_id TEXT, created_at INTEGER, handoff_consumed_at INTEGER);
    CREATE TABLE bot_task_origin_messages (bot_id TEXT, message_id TEXT);
    CREATE TABLE embedding_jobs (source_id TEXT);
    CREATE TABLE chat_messages_vec_v1 (distance REAL);
    INSERT INTO bot_profiles VALUES ('visible', NULL, 'active'), ('zero', 0, 'active'),
      ('hidden', 1, 'active'), ('archived', NULL, 'archived');
  `);
    // Hidden matches exceed both the FTS limit (50) and KNN over-fetch limit (250).
    const ids = [
      ...Array.from({ length: 300 }, (_, i) => `hidden-${i}`),
      'archived',
      'orphan',
      'ordinary',
      'visible',
      'zero',
    ];
    for (const [i, id] of ids.entries()) {
      const bot = id.startsWith('hidden-') ? 'hidden' : id;
      db.prepare(
        'INSERT INTO sessions (id, source, created_at, updated_at) VALUES (?, ?, ?, ?)',
      ).run(id, id === 'ordinary' ? 'desktop' : 'bot', i + 1, i + 1);
      if (id !== 'orphan' && id !== 'ordinary')
        db.prepare('INSERT INTO bot_session_links (session_id, bot_id) VALUES (?, ?)').run(id, bot);
      db.prepare(
        "INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, 'user', ?, ?)",
      ).run(id, id, id, JSON.stringify('needle'), i + 1);
      db.prepare('INSERT INTO messages_fts VALUES (?, ?)').run(id, 'needle');
      db.prepare('INSERT INTO embedding_jobs VALUES (?)').run(id);
      db.prepare('INSERT INTO chat_messages_vec_v1 VALUES (?)').run(i + 1);
    }
    if (mode === 'native-vec') {
      db.loadExtension(
        path.resolve(
          __dirname,
          '../../../../native/sqlite-vec',
          `${process.platform}-${process.arch}`,
          process.platform === 'win32' ? 'vec0.dll' : 'vec0.dylib',
        ),
      );
      db.exec(
        'DROP TABLE chat_messages_vec_v1; CREATE VIRTUAL TABLE chat_messages_vec_v1 USING vec0(embedding float[1])',
      );
      for (const [i] of ids.entries()) {
        db.prepare('INSERT INTO chat_messages_vec_v1(rowid, embedding) VALUES (?, ?)').run(
          BigInt(i + 1),
          JSON.stringify([i + 2]),
        );
      }
    }
    state.client = {
      drizzle: drizzle(db),
      vecAvailable: true,
      // Deterministic KNN fixture; all production joins, visibility filters and limits execute in SQLite.
      query: async (sql: string, params: unknown[] = []) =>
        db
          .prepare(mode === 'native-vec' ? sql : sql.replace('embedding MATCH ?', '? IS NOT NULL'))
          .all(...params),
      queryOne: async (sql: string, params: unknown[] = []) => db.prepare(sql).get(...params),
    };
    setChatEmbeddingEnabled(true);
    setRemoteBotSessionLookup(async (id, kind) =>
      (await readRemoteBotSessionAccessBatch([id], kind)).get(id) ?? 'hidden',
      readRemoteBotSessionAccessBatch,
    );
    registerHistoryQueryIpc();
  });
  afterEach(() => {
    setRemoteBotSessionLookup(null);
    handlers.clear();
    db.close();
    state.client = null;
  });

  const listArgs = {
    workdir: null,
    fromMs: null,
    toMs: null,
    agentKind: null,
    includeDeleted: false,
    limit: 1,
    cursor: null,
    order: 'asc' as const,
    remoteVisibleOnly: true,
  };
  const searchArgs = {
    query: 'needle',
    sessionIds: null,
    workdir: null,
    fromMs: null,
    toMs: null,
    agentKind: null,
    roles: null,
    contextRadius: 0,
    limit: 1,
    offset: 0,
    remoteVisibleOnly: true,
  };

  const invokeHistory = async (tool: string, args: Record<string, unknown>) => {
    const channel = 'local-db:history:query';
    const request = { tool, args };
    await assertRemoteBotInvocationAllowed([request], channel);
    const result = await runDeviceLinkInvokeContext(
      { controllerDeviceId: 'owner', channel },
      () => handlers.get(channel)!({}, request),
    );
    await assertRemoteBotInvocationAllowed([request], channel);
    return projectRemoteSessionResult(channel, result);
  };

  // Real SQLite + public tool cursor: byte budgeting must not skip same-ms
  // records or truncate a large individual message. Unit, no artificial waits.
  it.each(['asc', 'desc'] as const)('pages complete UTF-8 messages without losing rowid ties (%s)', async (order) => {
    const ids = ['budget-z', 'budget-a', 'budget-m', 'budget-b'];
    const texts = ['中'.repeat(18000), '文'.repeat(18000), '大'.repeat(30000), 'last'];
    for (let i = 0; i < ids.length; i++) {
      db.prepare("INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, 'ordinary', 'user', ?, 1000)")
        .run(ids[i], JSON.stringify(texts[i]));
    }
    const registry = new XdtHelperToolRegistry();
    registerGetChatHistoryTool(registry, { history: {
      listWorkdirs: vi.fn(), listSessions: vi.fn(), searchChatHistory: vi.fn(),
      getMessages: async args => ({ ok: true, page: await getMessagesForHistory(args) }),
    } });
    const collected: Array<{ id: string; content: unknown }> = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = historyPayload(await registry.call('get_chat_history', {
        session_ids: ['ordinary'], from: '1970-01-01T00:00:01.000Z', limit: 100, order, ...(cursor ? { cursor } : {}),
      })) as any;
      expect(page.messages.length).toBeGreaterThan(0);
      if (Buffer.byteLength(JSON.stringify(page.messages), 'utf8') > 64 * 1024) {
        expect(page.messages).toHaveLength(1);
      }
      collected.push(...page.messages);
      if (!page.hasMore) { expect(page.nextCursor).toBeNull(); break; }
      expect(page.nextCursor).not.toBe(cursor);
      cursor = page.nextCursor;
    }
    const expected = ids.map((id, i) => ({ id, content: texts[i] }));
    if (order === 'desc') expected.reverse();
    expect(collected.map(({ id, content }) => ({ id, content }))).toEqual(expected);
  });

  it('advances the activity cursor at the last byte-bounded session through the remote tool entry', async () => {
    db.prepare("UPDATE sessions SET title=?, updated_at=1000 WHERE id IN ('ordinary', 'visible', 'zero')")
      .run('标题'.repeat(6000));
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 3; i++) {
      const page = await invokeHistory('list_sessions', { limit: 100, time_field: 'activity', order: 'asc',
        ...(cursor ? { cursor } : {}) }) as any;
      expect(page.sessions).toHaveLength(1);
      ids.push(page.sessions[0].id);
      expect(page.sessions[0].title).toBe('标题'.repeat(6000));
      cursor = page.nextCursor;
      expect(page.hasMore).toBe(i < 2);
    }
    expect(ids).toEqual(['ordinary', 'visible', 'zero']);
  });

  // r4411387401/r4411387386: real MCP entry must budget while reading, whereas
  // fixed-page internal consumers keep their original complete hit count (unit/SQLite).
  it.each([0, 2])('continues tool search at the consumed candidate without hydrating the remaining page (radius=%s)', async (radius) => {
    setChatEmbeddingEnabled(false);
    const text = 'budgetneedle ' + '文'.repeat(18000);
    const ids = ['budget-z', 'budget-a', 'budget-m'];
    for (const id of ids) {
      db.prepare("INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, 'ordinary', 'user', ?, 1000)")
        .run(id, JSON.stringify(text));
      db.prepare('INSERT INTO messages_fts VALUES (?, ?)').run(id, 'budgetneedle');
    }
    const found: string[] = [];
    const registry = new XdtHelperToolRegistry();
    registerSearchChatHistoryTool(registry, { history: {
      listWorkdirs: vi.fn(), listSessions: vi.fn(), getMessages: vi.fn(),
      searchChatHistory: async args => ({ ok: true, result: await searchChatHistoryHybrid(args) }),
    } });
    let cursor: string | undefined;
    for (let i = 0; i < 3; i++) {
      const queries = vi.spyOn(state.client, 'query');
      const page = historyPayload(await registry.call('search_chat_history', {
        query: 'budgetneedle', limit: 10, context_radius: radius, ...(cursor ? { cursor } : {}),
      })) as any;
      const contextQueries = queries.mock.calls.filter(([sql]) => String(sql).includes('_anchorOrder'));
      queries.mockRestore();
      expect(page.hits).toHaveLength(1);
      expect(page.hits[0].context.find((row: any) => row.isHit).content).toBe(text);
      if (radius === 2) {
        expect(contextQueries).toHaveLength(1);
        const contextParams = (contextQueries[0][1] ?? []) as unknown[];
        expect(new Set(contextParams.filter((value): value is string =>
          typeof value === 'string' && ids.includes(value),
        )).size).toBe(1);
      }
      found.push(page.hits[0].messageId);
      expect(page.hasMore).toBe(i < 2);
      if (page.nextCursor !== null) { expect(page.nextCursor).not.toBe(cursor); cursor = page.nextCursor; }
    }
    expect(found.sort()).toEqual(ids.sort());
    const internal = await searchChatHistoryHybrid({ ...searchArgs, query: 'budgetneedle', limit: 10, contextRadius: radius });
    expect(internal.hits.map(hit => hit.messageId).sort()).toEqual(ids.sort());
    expect(internal.hasMore).toBe(false);
  });

  // Regression: old-created, recently active chats were lost by workdir/creation
  // filters; known ownership must include archived channels/topics without claiming
  // unrelated legacy Telegram records. Unit: real readers + MCP/remote handler + SQLite.
  it('finds old active teammate conversations and keeps legacy source separate', async () => {
    db.exec(`
      UPDATE sessions SET created_at=1, updated_at=1000, status='archived' WHERE id='visible';
      UPDATE bot_session_links SET role='channel', route_key='im:telegram:123:g:456:t:789' WHERE session_id='visible';
      UPDATE sessions SET source='telegram', created_at=1, updated_at=1000 WHERE id='ordinary';
    `);
    const created = await invokeHistory('list_sessions', { teammate_id: 'visible', from: '1970-01-01T00:00:00.900Z' });
    expect(created).toMatchObject({ ok: true, sessions: [] });
    const active = await invokeHistory('list_sessions', {
      teammate_id: 'visible', time_field: 'activity', from: '1970-01-01T00:00:00.900Z', limit: 1,
    });
    expect(active).toMatchObject({ ok: true, sessions: [{ id: 'visible', status: 'archived',
      companion: { id: 'visible', role: 'channel', channel: 'telegram' } }] });
    const own = await invokeHistory('search_chat_history', { query: 'needle', teammate_id: 'visible' });
    expect(own).toMatchObject({ ok: true, hits: [{ sessionId: 'visible', context: [{ content: 'needle' }] }] });
    expect((own as any).hits).toHaveLength(1);
    const legacy = await invokeHistory('search_chat_history', { query: 'needle', source: 'telegram' });
    expect(legacy).toMatchObject({ ok: true, sessions: { ordinary: { source: 'telegram', companion: null } } });
    expect((legacy as any).hits.map((hit: any) => hit.sessionId)).toEqual(['ordinary']);
  });

  // Design task-to-companion §6: snapshot search/read/context must agree; an owner can
  // still read the ordinary source independently. Existing fixtures had no source associations.
  // Merge regression: both internal and byte-budgeted tool pages must constrain batched neighbors.
  it.each([false, true])('reads source snapshot messages and excludes later, withdrawn and cleared content (tool budget: %s)', async (historyToolPageBudget) => {
    db.exec(`INSERT INTO bot_task_origins VALUES ('visible','ordinary',1000,NULL);
      INSERT INTO bot_task_origin_messages VALUES ('visible','ordinary');
      INSERT INTO messages (id,client_id,session_id,role,content,created_at)
        VALUES ('later','later','ordinary','assistant','"needle later"',1);
      INSERT INTO messages_fts VALUES ('later','needle later');`);
    const search = await searchChatHistoryHybrid({ ...searchArgs, historyToolPageBudget, teammateId: 'visible', sessionIds: ['ordinary'], contextRadius: 3, skipVector: true });
    expect(search.hits.map(hit => hit.messageId)).toEqual(['ordinary']);
    expect(search.hits[0]!.context.map(message => message.id)).toEqual(['ordinary']);
    const args = { sessionIds: ['ordinary'], teammateId: 'visible', workdir: null, fromMs: null, toMs: null,
      agentKind: null, roles: null, includeRewound: true, limit: 100, cursor: null, order: 'asc' as const };
    expect((await getMessagesForHistory(args)).items.map(row => row.id)).toEqual(['ordinary']);
    expect(await pendingBotTaskOriginHandoff('visible')).toContain('needle');
    expect(await pendingBotTaskOriginHandoff('visible')).not.toContain('needle later');
    db.exec("UPDATE messages SET rewind_at=2000 WHERE id='ordinary'");
    expect((await getMessagesForHistory(args)).items).toEqual([]);
    db.exec("UPDATE messages SET rewind_at=NULL WHERE id='ordinary'; UPDATE sessions SET cleared_at=2000 WHERE id='ordinary'");
    expect((await searchChatHistoryHybrid({ ...searchArgs, historyToolPageBudget, teammateId: 'visible', sessionIds: ['ordinary'], skipVector: true })).hits).toEqual([]);
    expect((await getMessagesForHistory(args)).items).toEqual([]);
    db.exec(`INSERT INTO messages (id,client_id,session_id,role,content,created_at)
      VALUES ('surviving','surviving','ordinary','assistant','"needle surviving"',2500);
      INSERT INTO messages_fts VALUES ('surviving','needle surviving');
      INSERT INTO bot_task_origin_messages VALUES ('visible','surviving');`);
    const surviving = await searchChatHistoryHybrid({ ...searchArgs, historyToolPageBudget, teammateId: 'visible', sessionIds: ['ordinary'], contextRadius: 3, skipVector: true });
    expect(surviving.hits[0]!.context.map(message => message.id)).toEqual(['surviving']);
  });

  // #6779: local semantic-only hits were starved by 300 closer vectors from other
  // teammates before the 250-candidate KNN limit. Exercise the production engine
  // with both real SQLite joins and native vec0; no FTS hit can mask the failure.
  it.each([{ teammateId: 'visible' }, { source: 'telegram' }])(
    'filters local vector candidates before limiting: %j', async (filter) => {
      db.prepare("UPDATE sessions SET source='telegram' WHERE id='visible'").run();
      const result = await searchChatHistoryHybrid({
        ...searchArgs, remoteVisibleOnly: false, query: 'semantic-only', ...filter,
      });
      expect(result.vectorUsed).toBe(true);
      expect(result.hits.map(hit => hit.sessionId)).toEqual(['visible']);
      expect(result.hits[0]).toMatchObject({ vectorRank: 1, context: [{ content: 'needle' }] });
      expect(result.hits[0].ftsRank).toBeNull();
    },
  );

  // Activity cursor must use the same clock as ordering, including userSendAt and ties.
  it('paginates activity ties and preserves the existing scope intersection', async () => {
    db.exec(`
      UPDATE sessions SET created_at=1, updated_at=2, user_send_at=1000 WHERE id IN ('visible', 'zero');
      UPDATE bot_session_links SET bot_id='visible', role='thread' WHERE session_id='zero';
    `);
    const args = { teammate_id: 'visible', time_field: 'activity', limit: 1 };
    const first = await invokeHistory('list_sessions', args) as any;
    const second = await invokeHistory('list_sessions', { ...args, cursor: first.nextCursor }) as any;
    expect([first.sessions[0].id, second.sessions[0].id]).toEqual(['zero', 'visible']);
    expect(second.hasMore).toBe(false);
    expect(first.sessions[0]).toMatchObject({ lastActivityAt: '1970-01-01T00:00:01.000Z', companion: { role: 'thread' } });
    const restricted = await listSessionsForHistory({ ...listArgs, teammateId: 'visible', sessionIds: ['ordinary'] });
    expect(restricted.items).toEqual([]);
    const search = await searchChatHistoryHybrid({ ...searchArgs, teammateId: 'visible', sessionIds: ['ordinary'] });
    expect(search.hits).toEqual([]);
  });

  it('paginates the visible list without hidden rows consuming slots or cursors', async () => {
    const first = await listSessionsForHistory(listArgs);
    const second = await listSessionsForHistory({ ...listArgs, cursor: first.nextCursor });
    const last = await listSessionsForHistory({ ...listArgs, cursor: second.nextCursor });
    expect([first, second, last].map((page) => page.items.map((row) => row.id))).toEqual([
      ['ordinary'],
      ['visible'],
      ['zero'],
    ]);
    expect(first.nextCursor?.id).toBe('ordinary');
    expect(last).toMatchObject({ hasMore: false, nextCursor: null });
    expect(
      (await listSessionsForHistory({ ...listArgs, remoteVisibleOnly: false })).items[0].id,
    ).toBe('hidden-0');
    expect(
      Object.fromEntries(
        await readRemoteBotSessionAccessBatch([
          'ordinary',
          'visible',
          'zero',
          'hidden-0',
          'archived',
          'orphan',
        ]),
      ),
    ).toEqual({
      ordinary: 'ordinary',
      visible: 'visible',
      zero: 'visible',
      'hidden-0': 'hidden',
      archived: 'hidden',
      orphan: 'hidden',
    });
  });

  it.each([true, false])(
    'filters both retrieval arms before ranks, pool metadata and pagination (FTS only=%s)',
    async (skipVector) => {
      const pages = await Promise.all(
        [0, 1, 2].map((offset) => searchChatHistoryHybrid({ ...searchArgs, skipVector, offset })),
      );
      expect(pages.map((page) => page.hits.map((hit) => hit.sessionId))).toEqual([
        ['ordinary'],
        ['visible'],
        ['zero'],
      ]);
      expect(pages.map((page) => page.nextOffset)).toEqual([1, 2, null]);
      expect(pages.map((page) => page.hasMore)).toEqual([true, true, false]);
      expect(pages.every((page) => page.poolSize === 3 && !page.poolCapped)).toBe(true);
      expect(pages[0].hits[0]).toMatchObject({ ftsRank: 1, vectorRank: skipVector ? null : 1 });
      expect(pages[0].vectorUsed).toBe(!skipVector);
      // Removing inaccessible data leaves visible ranking and pagination unchanged.
      db.exec("DELETE FROM messages_fts WHERE message_id NOT IN ('ordinary', 'visible', 'zero')");
      const withoutHidden = await searchChatHistoryHybrid({ ...searchArgs, skipVector });
      expect(withoutHidden).toEqual(pages[0]);
    },
  );

  it('returns a terminal empty page for an all-hidden scope', async () => {
    const page = await listSessionsForHistory({
      ...listArgs,
      sessionIds: ['hidden-0', 'archived', 'orphan'],
    });
    expect(page).toEqual({ items: [], nextCursor: null, hasMore: false });
    const result = await searchChatHistoryHybrid({
      ...searchArgs,
      sessionIds: ['hidden-0', 'archived', 'orphan'],
    });
    expect(result).toMatchObject({
      hits: [],
      sessions: {},
      nextOffset: null,
      hasMore: false,
      poolSize: 0,
      poolCapped: false,
      vectorUsed: false,
    });
  });

  it('retrieves semantic-only visible hits beyond 250 closer hidden vectors', async () => {
    db.exec('DELETE FROM messages_fts');
    const result = await searchChatHistoryHybrid({ ...searchArgs, limit: 10 });
    expect(result.vectorUsed).toBe(true);
    expect(result.hits.map((hit) => hit.sessionId)).toEqual(['ordinary', 'visible', 'zero']);
    expect(result.hits.every((hit) => hit.ftsRank === null)).toBe(true);
    expect(result).toMatchObject({
      poolSize: 3,
      poolCapped: false,
      hasMore: false,
      nextOffset: null,
    });
    const scoped = await searchChatHistoryHybrid({
      ...searchArgs,
      sessionIds: ['visible'],
      roles: ['user'],
      fromMs: 0,
    });
    expect(scoped.vectorUsed).toBe(true);
    expect(scoped.hits.map((hit) => hit.sessionId)).toEqual(['visible']);
  });

  it.each([true, false])('does not distinguish inaccessible IDs from missing IDs across the remote query (FTS only=%s)', async (ftsOnly) => {
    setChatEmbeddingEnabled(!ftsOnly);
    const invoke = (session_ids: string[]) => invokeHistory('search_chat_history', { query: 'needle', session_ids, limit: 1 });
    for (const ids of [['hidden-0'], ['archived'], ['orphan'], ['hidden-0', 'archived', 'orphan', 'missing']]) {
      const empty = await invoke(ids);
      expect(empty).toMatchObject({ ok: true, hits: [], sessions: {}, hasMore: false, nextCursor: null });
      const mixedIds = ['ordinary', 'visible', ...ids];
      const visible = await invoke(mixedIds);
      expect(visible).toMatchObject({ ok: true, hits: [{ sessionId: 'ordinary' }], hasMore: true });
      // Use identical requests before/after deletion, including the echoed scope.
      // No response field may reveal whether inaccessible targets still exist.
      db.exec('SAVEPOINT inaccessible');
      try {
        for (const id of ids) db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
        expect(await invoke(ids)).toEqual(empty);
        expect(await invoke(mixedIds)).toEqual(visible);
      } finally {
        db.exec('ROLLBACK TO inaccessible; RELEASE inaccessible');
      }
    }
  });

  it('projects parent references using current source visibility without changing local history', async () => {
    for (const parent of ['visible', 'zero', 'hidden-0', 'archived', 'orphan', 'missing']) {
      db.prepare("UPDATE sessions SET parent_session_id = ? WHERE id = 'ordinary'").run(parent);
      const result = await invokeHistory('list_sessions', { order: 'asc', limit: 1 });
      expect(result).toMatchObject({
        ok: true,
        sessions: [{ id: 'ordinary' }],
        hasMore: true,
      });
      if (['visible', 'zero'].includes(parent)) {
        expect(result).toHaveProperty('sessions.0.parentSessionId', parent);
      } else {
        expect(result).not.toHaveProperty('sessions.0.parentSessionId');
      }
      const local = await listSessionsForHistory({ ...listArgs, sessionIds: ['ordinary'], remoteVisibleOnly: false });
      expect(local.items[0].parentSessionId).toBe(parent);
    }
  });

  it('keeps all diagnostics identical with hidden-only vectors and no vectors', async () => {
    db.exec(`DELETE FROM chat_messages_vec_v1 WHERE rowid IN (
      SELECT rowid FROM embedding_jobs WHERE source_id IN ('ordinary', 'visible', 'zero'))`);
    const before = await invokeHistory('search_chat_history', { query: 'needle' });
    expect(before).toMatchObject({ ok: true, vector_used: false });
    db.exec('DELETE FROM chat_messages_vec_v1');
    expect(await invokeHistory('search_chat_history', { query: 'needle' })).toEqual(before);
  });

  it('does not expose an invisible-only workdir through empty-scope diagnostics', async () => {
    // Host filesystem paths use the platform path implementation.
    const workdir = path.resolve('hidden-workdir');
    db.prepare("UPDATE sessions SET working_dir = ? WHERE id = 'hidden-0'").run(workdir);
    const before = await invokeHistory('search_chat_history', { query: 'needle', workdir });
    expect(before).toMatchObject({ ok: true, hits: [], vector_used: false });
    db.exec("DELETE FROM sessions WHERE id = 'hidden-0'");
    expect(await invokeHistory('search_chat_history', { query: 'needle', workdir })).toEqual(before);
  });
});
