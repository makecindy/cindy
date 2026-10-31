/** Late authoritative empty finals retract only the rejected draft in real SQLite. */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { messages, sessions } from '../../schema';
import { tx } from '../../worker/opHandlers/tx';
import { createMessage, discardPersistedAssistantMessage, updateMessageContent } from '../messages';
import * as prRefsStore from '../../../git-context/prRefsStore';
import * as previewRows from '../../latestMessageText';
import { commitMessageMediaRefs } from '../../../cindy-media/chatAttachments';
import { onAssistantTextEvent, clearSessionPersistState, drainPersistQueue,
  flushAssistantBlock, noteSessionClearBoundary } from '../../../messagePersistBroadcaster';

const h = vi.hoisted(() => ({
  sqlite: null as Database.Database | null,
  client: null as {
    drizzle: ReturnType<typeof drizzle>;
    tx: (name: string, args: unknown) => Promise<unknown>;
    exec: (sql: string, params?: unknown[]) => Promise<Database.RunResult>;
    query: (sql: string, params?: unknown[]) => Promise<unknown[]>;
  } | null,
  broadcast: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: h.broadcast } }] },
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() }),
}));
vi.mock('../../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() }),
}));
vi.mock('../../../session-import/legacy', () => ({
  adoptLegacySessionBeforeOpen: vi.fn(async () => undefined),
}));
vi.mock('../../../embedders/chat-history-embedder', () => ({
  onMessageCreated: vi.fn(async () => undefined),
}));
vi.mock('../../../cindy-media/chatAttachments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../cindy-media/chatAttachments')>();
  return { ...actual, commitMessageMediaRefs: vi.fn(actual.commitMessageMediaRefs) };
});
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

function setupDb(): void {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cleared_at INTEGER,
      list_preview TEXT,
      list_preview_role TEXT,
      list_message_count INTEGER,
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
    CREATE TABLE media_blobs (
      hash TEXT PRIMARY KEY, ext TEXT NOT NULL, mime_type TEXT NOT NULL,
      bytes INTEGER NOT NULL, is_cache INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, last_access_at INTEGER NOT NULL
    );
    CREATE TABLE media_refs (
      id TEXT PRIMARY KEY, hash TEXT NOT NULL REFERENCES media_blobs(hash),
      ref_kind TEXT NOT NULL, ref_id TEXT NOT NULL, origin_session_id TEXT,
      origin_kind TEXT, origin_id TEXT, label TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE session_pr_refs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, owner TEXT NOT NULL,
      repo TEXT NOT NULL, pr_number INTEGER NOT NULL, url TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      UNIQUE(session_id, owner, repo, pr_number)
    );
  `);
  sqlite.prepare("INSERT INTO sessions (id, cleared_at, status) VALUES ('s1', NULL, 'active')").run();
  const db = drizzle(sqlite, {
    schema: { messages, sessions },
  });
  h.sqlite = sqlite;
  h.client = {
    drizzle: db,
    tx: async (name: string, args: unknown) => tx(sqlite, { name, args }),
    exec: vi.fn(async (sql: string, params: unknown[] = []) => h.sqlite!.prepare(sql).run(...params)),
    query: vi.fn(async (sql: string, params: unknown[] = []) => h.sqlite!.prepare(sql).all(...params)),
  };
}


beforeEach(() => { vi.clearAllMocks(); clearSessionPersistState('s1'); setupDb(); });
afterEach(async () => { await drainPersistQueue(); clearSessionPersistState('s1'); h.sqlite?.close(); });

it('removes a flushed draft from history and broadcasts deletion while preserving the newer item', async () => {
  const first = onAssistantTextEvent('s1', { text: 'Withdrawn draft', agentMessageId: 'a' }, null);
  flushAssistantBlock('s1');
  await drainPersistQueue();
  expect(h.sqlite!.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 1 });
  h.sqlite!.prepare("UPDATE sessions SET list_preview = 'Withdrawn draft', list_message_count = 1").run();
  const newer = onAssistantTextEvent('s1', { text: 'Next step', agentMessageId: 'b' }, null);
  onAssistantTextEvent('s1', { text: '', agentMessageId: 'a', isFinal: true, isFullText: true }, null);
  await drainPersistQueue();
  expect(h.sqlite!.prepare('SELECT count(*) AS n FROM messages WHERE client_id = ?').get(first)).toEqual({ n: 0 });
  expect(h.broadcast).toHaveBeenCalledWith('local-db:messages:deleted', {
    sessionId: 's1', clientId: first, clientIds: [first],
  });
  expect(h.sqlite!.prepare('SELECT list_preview, list_message_count FROM sessions').get())
    .toEqual({ list_preview: null, list_message_count: null });
  // Repeated final events must not recreate the rejected draft.
  onAssistantTextEvent('s1', { text: '', agentMessageId: 'a', isFinal: true, isFullText: true }, null);
  flushAssistantBlock('s1');
  await drainPersistQueue();
  expect(h.sqlite!.prepare('SELECT client_id, content FROM messages').all())
    .toEqual([{ client_id: newer, content: 'Next step' }]);
});

it('does not retract a different role, session, hidden row or stale boundary', async () => {
  const insert = h.sqlite!.prepare('INSERT INTO messages (id, client_id, session_id, role, content, created_at, rewind_at) VALUES (?, ?, ?, ?, ?, 1, ?)');
  insert.run('user', 'user', 's1', 'user', '"hello"', null);
  insert.run('other', 'other', 's2', 'assistant', '"hello"', null);
  insert.run('hidden', 'hidden', 's1', 'assistant', '"hello"', 2);
  insert.run('stale', 'stale', 's1', 'assistant', '"hello"', null);
  for (const id of ['user', 'other', 'hidden', 'missing']) {
    expect(await discardPersistedAssistantMessage('s1', id, () => true)).toBe(false);
  }
  let checks = 0;
  expect(await discardPersistedAssistantMessage('s1', 'stale', () => ++checks === 1)).toBe(false);
  expect(h.sqlite!.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 4 });
});

it('keeps a row changed while the exact-row rollback was being queued', async () => {
  h.sqlite!.prepare("INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES ('a', 'a', 's1', 'assistant', ?, 1)").run(JSON.stringify('draft'));
  const original = h.client!.tx;
  h.client!.tx = async (name, args) => {
    h.sqlite!.prepare("UPDATE messages SET content = ? WHERE client_id = 'a'").run(JSON.stringify('edited'));
    return original(name, args);
  };
  expect(await discardPersistedAssistantMessage('s1', 'a', () => true)).toBe(false);
  expect(h.sqlite!.prepare('SELECT content FROM messages').get()).toEqual({ content: '"edited"' });
});


it('removes the withdrawn draft PR reference but retains a surviving message reference', async () => {
  onAssistantTextEvent('s1', { text: 'https://github.com/o/r/pull/1', agentMessageId: 'keep' }, null);
  flushAssistantBlock('s1');
  onAssistantTextEvent('s1', { text: 'https://github.com/o/r/pull/2', agentMessageId: 'withdraw' }, null);
  flushAssistantBlock('s1');
  await drainPersistQueue();
  expect((await prRefsStore.listPrRefs('s1')).map((ref) => ref.prNumber).sort()).toEqual([1, 2]);
  onAssistantTextEvent('s1', { text: '', agentMessageId: 'withdraw', isFinal: true, isFullText: true }, null);
  await drainPersistQueue();
  expect((await prRefsStore.listPrRefs('s1')).map((ref) => ref.prNumber)).toEqual([1]);
});

it('orders retraction cleanup after the original asynchronous PR publication hook', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const original = prRefsStore.recordPrRefsForMessage;
  const hook = vi.spyOn(prRefsStore, 'recordPrRefsForMessage').mockImplementationOnce(async (msg) => {
    await pending;
    await original(msg);
  });
  let retracted!: () => void;
  const rollback = new Promise<void>((resolve) => { retracted = resolve; });
  const originalTx = h.client!.tx;
  h.client!.tx = async (name, args) => {
    const result = await originalTx(name, args);
    if ((args as { publication?: string }).publication === 'rollback') retracted();
    return result;
  };
  try {
    onAssistantTextEvent('s1', { text: 'https://github.com/o/r/pull/2', agentMessageId: 'withdraw' }, null);
    flushAssistantBlock('s1');
    await drainPersistQueue();
    expect(hook).toHaveBeenCalledTimes(1);
    onAssistantTextEvent('s1', { text: '', agentMessageId: 'withdraw', isFinal: true, isFullText: true }, null);
    await rollback;
    release();
    await drainPersistQueue();
    await pending;
    // Await the hook itself too, so a late stale write cannot hide behind the assertion.
    await hook.mock.results[0].value;
    expect(await prRefsStore.listPrRefs('s1')).toHaveLength(0);
  } finally { release(); hook.mockRestore(); }
});


it('does not restore pre-clear PR references when retraction cleanup resumes after clear', async () => {
  onAssistantTextEvent('s1', { text: 'https://github.com/o/r/pull/1', agentMessageId: 'keep' }, null);
  flushAssistantBlock('s1');
  onAssistantTextEvent('s1', { text: 'https://github.com/o/r/pull/2', agentMessageId: 'withdraw' }, null);
  flushAssistantBlock('s1');
  await drainPersistQueue();
  let release!: () => void;
  const resume = new Promise<void>((resolve) => { release = resolve; });
  let captured!: () => void;
  const snapshotTaken = new Promise<void>((resolve) => { captured = resolve; });
  const db = h.client!.drizzle;
  const select = db.select.bind(db);
  let paused = false;
  const spy = vi.spyOn(db, 'select').mockImplementation((fields) => {
    const query = select(fields);
    const from = query.from.bind(query);
    vi.spyOn(query, 'from').mockImplementation((table) => {
      const builder = from(table);
      if (table === messages && !paused) {
        const orderBy = builder.orderBy.bind(builder);
        vi.spyOn(builder, 'orderBy').mockImplementationOnce((...columns) => {
          paused = true;
          const snapshot = orderBy(...columns).all();
          captured();
          return resume.then(() => snapshot) as unknown as ReturnType<typeof orderBy>;
        });
      }
      return builder;
    });
    return query;
  });
  try {
    onAssistantTextEvent('s1', { text: '', agentMessageId: 'withdraw', isFinal: true, isFullText: true }, null);
    await snapshotTaken;
    const boundary = Date.now() + 1000;
    h.sqlite!.prepare('UPDATE sessions SET cleared_at = ? WHERE id = ?').run(boundary, 's1');
    noteSessionClearBoundary('s1', boundary);
    const clearedRefs = prRefsStore.recomputePrRefsForSession('s1');
    release();
    await clearedRefs;
    expect(await prRefsStore.listPrRefs('s1')).toHaveLength(0);
    await drainPersistQueue();
    expect(await prRefsStore.listPrRefs('s1')).toHaveLength(0);
  } finally { release(); spy.mockRestore(); }
});


it.each(['none', 'previous', 'newer'] as const)(
  'broadcasts the surviving canonical list preview after retracting the draft (%s)', async (survivor) => {
    if (survivor === 'previous') {
      h.sqlite!.prepare("INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES ('u', 'u', 's1', 'user', ?, 1)").run('Previous question');
    }
    onAssistantTextEvent('s1', { text: 'Rejected draft', agentMessageId: 'a' }, null);
    flushAssistantBlock('s1');
    await drainPersistQueue();
    if (survivor === 'newer') {
      onAssistantTextEvent('s1', { text: 'Newer answer', agentMessageId: 'b' }, null);
      flushAssistantBlock('s1');
      await drainPersistQueue();
    }
    h.broadcast.mockClear();
    onAssistantTextEvent('s1', { text: '', agentMessageId: 'a', isFinal: true, isFullText: true }, null);
    await drainPersistQueue();
    const patches = h.broadcast.mock.calls.filter(([channel]) => channel === 'local-db:sessions:patched');
    expect(patches.at(-1)?.[1]).toEqual({ sessionId: 's1', patch: {
      preview: survivor === 'none' ? null : survivor === 'previous' ? 'Previous question' : 'Newer answer',
    } });
  },
);

it.each(['Corrected without a link', 'https://github.com/o/r/pull/3'])(
  'reconciles PR references after nonempty final correction and a delayed original hook (%s)', async (text) => {
    onAssistantTextEvent('s1', { text: 'https://github.com/o/r/pull/1', agentMessageId: 'keep' }, null);
    flushAssistantBlock('s1');
    await drainPersistQueue();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const original = prRefsStore.recordPrRefsForMessage;
    const hook = vi.spyOn(prRefsStore, 'recordPrRefsForMessage').mockImplementationOnce(async (msg) => {
      await pending;
      await original(msg);
    });
    let corrected!: () => void;
    const written = new Promise<void>((resolve) => { corrected = resolve; });
    const originalTx = h.client!.tx;
    h.client!.tx = async (name, args) => {
      const result = await originalTx(name, args);
      if (name === 'message.updateContent') corrected();
      return result;
    };
    try {
      onAssistantTextEvent('s1', { text: 'https://github.com/o/r/pull/2', agentMessageId: 'correct' }, null);
      flushAssistantBlock('s1');
      await drainPersistQueue();
      onAssistantTextEvent('s1', { text, agentMessageId: 'correct', isFinal: true, isFullText: true }, null);
      await written;
      release();
      await drainPersistQueue();
      await hook.mock.results[0].value;
      expect((await prRefsStore.listPrRefs('s1')).map((ref) => ref.prNumber).sort())
        .toEqual(text.includes('/pull/') ? [1, 3] : [1]);
    } finally { release(); hook.mockRestore(); }
  },
);

it.each([{ shared: false, clear: false }, { shared: true, clear: false }, { shared: false, clear: true }]
  .flatMap(options => ['retraction', 'correction'].map(mode => ({ ...options, mode }))))(
  'settles media cleanup without blocking another task (%j)', async ({ shared, clear, mode }) => {
  const hash = 'a'.repeat(64);
  const url = `cindy-media://blobs/${hash}.png`;
  h.sqlite!.prepare("INSERT INTO media_blobs VALUES (?, '.png', 'image/png', 8, 0, 1, 1)").run(hash);
  if (shared) {
    h.sqlite!.prepare("INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES ('keep-media', 'keep-media', 's1', 'user', ?, 1)").run(url);
  }
  const actual = await vi.importActual<typeof import('../../../cindy-media/chatAttachments')>('../../../cindy-media/chatAttachments');
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  vi.mocked(commitMessageMediaRefs).mockImplementationOnce(async (params, db) => {
    await pending;
    return actual.commitMessageMediaRefs(params, db);
  });
  let deleted!: () => void;
  const rollback = new Promise<void>((resolve) => { deleted = resolve; });
  const originalTx = h.client!.tx;
  h.client!.tx = async (name, args) => {
    const result = await originalTx(name, args);
    if ((args as { publication?: string }).publication === 'rollback' || name === 'message.updateContent') deleted();
    return result;
  };
  try {
    onAssistantTextEvent('s1', { text: url, agentMessageId: 'withdraw-media' }, null);
    flushAssistantBlock('s1');
    await drainPersistQueue();
    onAssistantTextEvent('s1', { text: mode === 'retraction' ? '' : 'Corrected without media', agentMessageId: 'withdraw-media', isFinal: true, isFullText: true }, null);
    await rollback;
    if (clear) {
      const boundary = Date.now() + 1000;
      h.sqlite!.prepare('UPDATE sessions SET cleared_at = ? WHERE id = ?').run(boundary, 's1');
      noteSessionClearBoundary('s1', boundary);
    }
    onAssistantTextEvent('s2', { text: 'Unrelated task', agentMessageId: 'other-b', isFinal: true, isFullText: true }, null);
    await vi.waitFor(() => {
      expect(h.sqlite!.prepare("SELECT count(*) AS n FROM messages WHERE session_id='s2'").get()).toEqual({ n: 1 });
    });
    release();
    await drainPersistQueue();
    await vi.mocked(commitMessageMediaRefs).mock.results[0].value;
    await vi.waitFor(() => {
      expect(h.sqlite!.prepare("SELECT count(*) AS n FROM media_refs WHERE ref_kind = 'session-attachment'").get())
        .toEqual({ n: shared ? 1 : 0 });
    });
    expect(h.sqlite!.prepare('SELECT count(*) AS n FROM media_blobs').get()).toEqual({ n: 1 });
  } finally { release(); await drainPersistQueue(); clearSessionPersistState('s2'); }
});


it.each([false, true])('reconciles replaced media without releasing another live message reference (shared=%s)', async (shared) => {
  const oldHash = 'a'.repeat(64);
  const newHash = 'b'.repeat(64);
  const oldUrl = `cindy-media://blobs/${oldHash}.png`;
  const newUrl = `cindy-media://blobs/${newHash}.png`;
  for (const hash of [oldHash, newHash]) {
    h.sqlite!.prepare("INSERT INTO media_blobs VALUES (?, '.png', 'image/png', 8, 0, 1, 1)").run(hash);
  }
  if (shared) {
    h.sqlite!.prepare("INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES ('keep-media', 'keep-media', 's1', 'user', ?, 1)").run(oldUrl);
  }
  onAssistantTextEvent('s1', { text: oldUrl, agentMessageId: 'replace-media' }, null);
  flushAssistantBlock('s1');
  await drainPersistQueue();
  onAssistantTextEvent('s1', { text: newUrl, agentMessageId: 'replace-media', isFinal: true, isFullText: true }, null);
  await drainPersistQueue();
  expect(h.sqlite!.prepare("SELECT hash FROM media_refs WHERE ref_kind = 'session-attachment' ORDER BY hash").all())
    .toEqual((shared ? [oldHash, newHash] : [newHash]).map((hash) => ({ hash })));
  expect(h.sqlite!.prepare('SELECT count(*) AS n FROM media_blobs').get()).toEqual({ n: 2 });
});


it.each(['after-update', 'during-preview', 'row-deleted'] as const)(
  'settles replaced media publication when clear interrupts a committed final (%s)', async (phase) => {
    const hash = 'a'.repeat(64);
    const url = `cindy-media://blobs/${hash}.png`;
    h.sqlite!.prepare("INSERT INTO media_blobs VALUES (?, '.png', 'image/png', 8, 0, 1, 1)").run(hash);
    const actual = await vi.importActual<typeof import('../../../cindy-media/chatAttachments')>('../../../cindy-media/chatAttachments');
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(commitMessageMediaRefs).mockImplementationOnce(async (params, db) => {
      await pending;
      return actual.commitMessageMediaRefs(params, db);
    });
    onAssistantTextEvent('s1', { text: url, agentMessageId: 'correct-clear-media' }, null);
    flushAssistantBlock('s1');
    await drainPersistQueue();
    const clear = () => {
      const boundary = Date.now() + 1000;
      h.sqlite!.prepare('UPDATE sessions SET cleared_at = ? WHERE id = ?').run(boundary, 's1');
      noteSessionClearBoundary('s1', boundary);
      release();
    };
    const originalTx = h.client!.tx;
    h.client!.tx = async (name, args) => {
      const result = await originalTx(name, args);
      if (name === 'message.updateContent') {
        if (phase === 'after-update') clear();
        if (phase === 'row-deleted') {
          h.sqlite!.prepare("DELETE FROM messages WHERE session_id = 's1'").run();
          release();
        }
      }
      return result;
    };
    const latest = previewRows.latestVisiblePreviewRow;
    const preview = vi.spyOn(previewRows, 'latestVisiblePreviewRow').mockImplementationOnce(async (sessionId) => {
      const row = await latest(sessionId);
      if (phase === 'during-preview') clear();
      return row;
    });
    h.broadcast.mockClear();
    try {
      onAssistantTextEvent('s1', { text: 'Corrected without media', agentMessageId: 'correct-clear-media', isFinal: true, isFullText: true }, null);
      await drainPersistQueue();
      await vi.mocked(commitMessageMediaRefs).mock.results[0].value;
      await vi.waitFor(() => {
        expect(h.sqlite!.prepare("SELECT count(*) AS n FROM media_refs WHERE ref_kind = 'session-attachment'").get()).toEqual({ n: 0 });
      });
      expect(h.sqlite!.prepare('SELECT count(*) AS n FROM media_blobs').get()).toEqual({ n: 1 });
      expect(h.broadcast.mock.calls.filter(([channel]) => channel === 'local-db:sessions:patched')).toHaveLength(0);
    } finally { release(); preview.mockRestore(); }
  },
);


// Replaces sessionTaskSummary's source-spelling assertion (CI #6532): invoke
// the production update with real SQLite and inspect the saved body/cache/push.
// Unit tier; existing retraction cases did not cover ordinary nonempty updates.
it.each([
  { authoritative: false, newer: false },
  { authoritative: false, newer: true },
  { authoritative: true, newer: false },
  { authoritative: true, newer: true },
])('refreshes only the latest visible preview after a message rewrite (%j)', async ({ authoritative, newer }) => {
  h.sqlite!.prepare("UPDATE sessions SET cleared_at = 5, list_preview = 'Stale draft', list_message_count = 9 WHERE id = 's1'").run();
  const insert = h.sqlite!.prepare('INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, created_at, rewind_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run('target', 'target', 's1', 'assistant', 'Stale draft', null, 10, null);
  if (newer) insert.run('newer', 'newer', 's1', 'assistant', 'Newer answer', null, 10, null);
  insert.run('pre-clear', 'pre-clear', 's1', 'assistant', 'Cleared answer', null, 4, null);
  insert.run('rewound', 'rewound', 's1', 'assistant', 'Hidden answer', null, 30, 31);
  insert.run('resume', 'resume', 's1', 'user', 'Internal resume', JSON.stringify({ autoResume: true }), 40, null);
  await updateMessageContent('s1', 'target', 'Corrected answer', undefined,
    authoritative ? { isCurrent: () => true } : undefined);
  expect(h.sqlite!.prepare("SELECT content FROM messages WHERE client_id = 'target'").get())
    .toEqual({ content: 'Corrected answer' });
  expect(h.sqlite!.prepare("SELECT list_preview FROM sessions WHERE id = 's1'").get())
    .toEqual({ list_preview: null });
  const patches = h.broadcast.mock.calls.filter(([channel]) => channel === 'local-db:sessions:patched');
  expect(patches.map(([, payload]) => payload)).toEqual(newer ? [] : [
    { sessionId: 's1', patch: { preview: 'Corrected answer' } },
  ]);
});

it('publishes a null preview when an ordinary latest-message rewrite has an empty body', async () => {
  h.sqlite!.prepare("INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES ('target', 'target', 's1', 'assistant', 'Old body', 1)").run();
  await updateMessageContent('s1', 'target', '');
  expect(h.broadcast).toHaveBeenCalledWith('local-db:sessions:patched', {
    sessionId: 's1', patch: { preview: null },
  });
});


it('does not republish a rewritten message at the session clear boundary', async () => {
  h.sqlite!.prepare("INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES ('target', 'target', 's1', 'assistant', 'Old body', 10)").run();
  h.sqlite!.prepare("UPDATE sessions SET cleared_at = 10 WHERE id = 's1'").run();
  await updateMessageContent('s1', 'target', 'Rewritten hidden body');
  expect(h.sqlite!.prepare("SELECT content FROM messages WHERE client_id = 'target'").get())
    .toEqual({ content: 'Rewritten hidden body' });
  expect(h.broadcast.mock.calls.filter(([channel]) => channel === 'local-db:sessions:patched'))
    .toHaveLength(0);
});

it.each(['correction', 'retraction'])('preserves concurrent new-message PR refs during final %s', async (mode) => {
  onAssistantTextEvent('s1', { text: 'https://github.com/o/r/pull/1', agentMessageId: 'a' }, null);
  flushAssistantBlock('s1'); await drainPersistQueue();
  let release!: () => void, captured!: () => void;
  const resume = new Promise<void>(resolve => { release = resolve; });
  const snapshotTaken = new Promise<void>(resolve => { captured = resolve; });
  const db = h.client!.drizzle, select = db.select.bind(db);
  let paused = false;
  const spy = vi.spyOn(db, 'select').mockImplementation((fields) => {
    const query = select(fields);
    if (!fields || Object.keys(fields).sort().join(',') !== 'content,createdAt') return query;
    const from = query.from.bind(query);
    vi.spyOn(query, 'from').mockImplementation((table) => {
      const builder = from(table);
      if (table === messages && !paused) {
        const orderBy = builder.orderBy.bind(builder);
        vi.spyOn(builder, 'orderBy').mockImplementationOnce((...columns) => {
          paused = true; const snapshot = orderBy(...columns).all(); captured();
          return resume.then(() => snapshot) as unknown as ReturnType<typeof orderBy>;
        });
      }
      return builder;
    }); return query;
  });
  const hook = vi.spyOn(prRefsStore, 'recordPrRefsForMessage');
  try {
    onAssistantTextEvent('s1', { text: mode === 'retraction' ? '' : 'Corrected final without a link', agentMessageId: 'a', isFinal: true, isFullText: true }, null);
    await snapshotTaken;
    await createMessage('s1', { clientId: 'new-user', role: 'user', content: 'https://github.com/o/r/pull/2' });
    const newMessagePrWrite = hook.mock.results.at(-1)!.value;
    // A blocked recompute in s1 must not block another task's publication.
    await prRefsStore.recordPrRefsForMessage({ sessionId: 's2', role: 'user',
      content: 'https://github.com/o/r/pull/3', createdAt: Date.now() });
    expect((await prRefsStore.listPrRefs('s2')).map(ref => ref.prNumber)).toEqual([3]);
    // Let a non-serialized publication finish; a correctly queued hook waits
    // for the recompute. Do not await that hook while holding its predecessor.
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await newMessagePrWrite;
    await drainPersistQueue();
    expect(h.sqlite!.prepare("SELECT client_id FROM messages WHERE client_id='new-user'").get()).toBeTruthy();
    expect((await prRefsStore.listPrRefs('s1')).map(ref => ref.prNumber)).toContain(2);
  } finally { release(); spy.mockRestore(); hook.mockRestore(); }
});

it('releases the PR write queue after a failed publication', async () => {
  const insert = vi.spyOn(h.client!.drizzle, 'insert').mockImplementationOnce(() => {
    throw new Error('simulated PR write failure');
  });
  try {
    await prRefsStore.recordPrRefsForMessage({ sessionId: 's1', role: 'user',
      content: 'https://github.com/o/r/pull/1', createdAt: Date.now() });
    await prRefsStore.recordPrRefsForMessage({ sessionId: 's1', role: 'user',
      content: 'https://github.com/o/r/pull/2', createdAt: Date.now() });
    expect((await prRefsStore.listPrRefs('s1')).map(ref => ref.prNumber)).toEqual([2]);
  } finally { insert.mockRestore(); }
});
