import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listSessionsForHistory } from '../chatHistoryReader';
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
      status TEXT DEFAULT 'active', source TEXT DEFAULT 'desktop', orca_role TEXT,
      parent_session_id TEXT, created_at INTEGER, updated_at INTEGER, user_send_at INTEGER);
    CREATE TABLE messages (id TEXT PRIMARY KEY, client_id TEXT, session_id TEXT, role TEXT,
      content TEXT, tool_use_id TEXT, agent_meta TEXT, agent_kind TEXT, created_at INTEGER, rewind_at INTEGER);
    CREATE VIRTUAL TABLE messages_fts USING fts5(message_id UNINDEXED, content);
    CREATE TABLE bot_profiles (id TEXT PRIMARY KEY, hidden_at INTEGER, status TEXT);
    CREATE TABLE bot_session_links (session_id TEXT PRIMARY KEY, bot_id TEXT);
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
        db.prepare('INSERT INTO bot_session_links VALUES (?, ?)').run(id, bot);
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
