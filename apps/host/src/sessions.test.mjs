import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableColumns, getTableName } from 'drizzle-orm';

import { listActiveSessions, listRunningSessions } from './sessions.mjs';
import { readHostSessionList, readHostSession } from './session-reads.ts';
import { createHostMessageStore, createHostMessageRecovery } from './message-store.ts';
import { createHostEventPersistence } from './agent/event-persistence.ts';
import { createInteractionBroker } from './agent/interactions.mjs';
import { OwnerSessionStorage } from '../../desktop/src/main/localDb/sessionStorageAdapter.ts';
import { setCurrentDbClient, clearCurrentDbClient, getCurrentDbClientSnapshot } from '../../desktop/src/main/localDb/client/current.ts';
import { createDbClientForHandle } from '../../desktop/src/main/localDb/client/createDbClientForHandle.ts';
import { sessions, messages, taskTags, sessionTaskTags, botSessionLinks, botProfiles, mediaRefs, sessionPrRefs, migrationMeta } from '../../desktop/src/main/localDb/schema.ts';

const row = (id, extra = {}) => ({ id, title: id, agentKind: 'claude-code', model: 'm', workDir: `/w/${id}`, updatedAt: 1, ...extra });

test('hides archived and deleted tasks but keeps active ones', async () => {
  const statuses = new Map([['a', 'active'], ['b', 'archived'], ['c', 'deleted']]);
  const storage = {
    list: async () => [row('a'), row('b'), row('c')],
    getStatus: async (id) => statuses.get(id) ?? null,
  };
  const sessions = await listActiveSessions(storage);
  assert.deepEqual(sessions.map((s) => s.id), ['a']);
  assert.deepEqual(sessions[0], { id: 'a', title: 'a', agentKind: 'claude-code', model: 'm', workDir: '/w/a', updatedAt: 1 });
});

test('a storage without status support keeps every listed task', async () => {
  const sessions = await listActiveSessions({ list: async () => [row('a')] });
  assert.deepEqual(sessions.map((s) => s.id), ['a']);
});

// PR #9246: refresh used persisted task rows, which have no live turn status.
// Unit: the actual runtime projection must preserve both running and idle sessions.
test('restores runtime state using session identities and the negotiated snapshot shape', () => {
  const maker = { listActiveSessions: () => [
    { id: 'running', agentKind: 'codex', workDir: '/w', capabilities: {}, isTurnRunning: () => true },
    { id: 'idle', agentKind: 'pi', workDir: '/w', capabilities: {}, isTurnRunning: () => false },
  ] };
  const sessions = listRunningSessions(maker);
  assert.deepEqual(sessions.map(({ sessionId, isTurnRunning }) => ({ sessionId, isTurnRunning })), [
    { sessionId: 'running', isTurnRunning: true }, { sessionId: 'idle', isTurnRunning: false },
  ]);
  assert.deepEqual(listRunningSessions(maker, { summary: true, snapshotVersion: 2 }), { format: 'active-sessions-v2', sessions });
  assert.deepEqual(listRunningSessions(null), []);
});

function sessionListDb(t) {
  const sqlite = new Database(':memory:');
  t.after(() => { if (sqlite.open) sqlite.close(); });
  for (const table of [sessions, messages, taskTags, sessionTaskTags, botSessionLinks, botProfiles]) {
    sqlite.exec(`CREATE TABLE "${getTableName(table)}" (${Object.values(getTableColumns(table))
      .map(column => `"${column.name}" ${column.getSQLType()}`).join(',')})`);
  }
  return { sqlite, db: drizzle(sqlite) };
}

// Unit, real in-memory SQL: the Host list used to drop older pinned tasks even
// when the renderer requested includePinned. Existing tests only cover the
// maker-core active-list projection, not the sidebar's status/source filters.
// Minimal regression: limit=1, one recent task and one older pinned task.
test('Host lists older pins without duplicating recent pins or exposing hidden tasks', async (t) => {
  const { sqlite, db } = sessionListDb(t);
  const insert = sqlite.prepare(`INSERT INTO sessions
    (id,source,status,created_at,updated_at,pinned_at,hidden_at,list_preview,list_message_count)
    VALUES (?, ?, ?, 0, ?, ?, ?, '', 0)`);
  insert.run('recent', 'desktop', 'active', 30, 1, null);
  insert.run('older-pin', 'desktop', 'active', 10, 1, null);
  insert.run('archived-pin', 'desktop', 'archived', 20, 1, null);
  insert.run('deleted-pin', 'desktop', 'deleted', 50, 1, null);
  insert.run('hidden-pin', 'desktop', 'active', 60, 1, 1);
  insert.run('review-pin', 'review', 'active', 70, 1, null);
  const listed = await readHostSessionList(db, { limit: 1, status: 'active', options: { includePinned: true } });
  assert.deepEqual(listed.map(row => row.id), ['recent', 'older-pin']);
  assert.equal(listed[1].pinnedAt, '1970-01-01T00:00:00.001Z');
  assert.deepEqual(listed[1]._count, { messages: 0 });
  assert.deepEqual((await readHostSessionList(db, { limit: 1, status: 'active' })).map(row => row.id), ['recent']);
  assert.deepEqual((await readHostSessionList(db, { status: 'archived', options: { includePinned: true } })).map(row => row.id), ['archived-pin']);
  assert.deepEqual((await readHostSessionList(db)).map(row => row.id), ['recent', 'archived-pin', 'older-pin']);
});

// Unit: an unavailable owner database must surface an error, not an apparently
// successful active-only list that overwrites the user's archived view.
test('Host list propagates a database failure instead of returning an empty list', async (t) => {
  const { sqlite, db } = sessionListDb(t);
  sqlite.close();
  await assert.rejects(readHostSessionList(db, { status: 'archived' }));
});

// Unit: get used to report zero messages and lose task attribution/tags while
// list returned the actual projection. Two persisted messages expose the mismatch
// without a model, account profile or full history import.
test('Host detail preserves the task-list projection and rejects missing/deleted tasks', async (t) => {
  const { sqlite, db } = sessionListDb(t);
  sqlite.exec(`INSERT INTO sessions(id,source,status,created_at,updated_at,list_preview)
    VALUES ('task','desktop','active',0,1,'cached preview');
    INSERT INTO messages(id,session_id,role,content,created_at)
    VALUES ('m1','task','user','"hello"',0),('m2','task','assistant','"reply"',1);`);
  const [listed] = await readHostSessionList(db);
  const detail = await readHostSession(db, 'task');
  assert.deepEqual(detail._count, { messages: 2 });
  assert.deepEqual(detail, listed);
  await assert.rejects(readHostSession(db, 'missing'), /session not found/);
  sqlite.exec("UPDATE sessions SET status='deleted' WHERE id='task'");
  await assert.rejects(readHostSession(db, 'task'), /session not found/);
});

// Real SQL regression: direct Host inserts bypassed message.insert and left
// the sidebar's materialized count/preview pointing to the previous conversation.
test('Host message writes invalidate the shared list cache and retain clear/idempotency guards', async (t) => {
  const { sqlite, db } = sessionListDb(t);
  sqlite.exec(`CREATE UNIQUE INDEX message_delivery ON messages(session_id,client_id);
    INSERT INTO sessions(id,source,status,created_at,updated_at,list_preview,list_message_count)
    VALUES ('task','desktop','active',0,1,'stale preview',0)`);
  const owner = { client: createDbClientForHandle({ db: sqlite, drizzle: db }), userId: 'isolated', clientEpoch: 1 };
  const events = [];
  const write = createHostMessageStore({ getOwner: () => owner, publish: event => events.push(event) });
  const message = { clientId: 'user-a', role: 'user', content: 'new input' };
  const first = await write('task', message);
  assert.equal((await readHostSession(db, 'task'))._count.messages, 1);
  assert.equal((await readHostSessionList(db))[0].preview, 'new input');
  assert.equal((await write('task', message)).id, first.id);
  assert.equal(events.filter(event => event.type === 'message_created').length, 1);
  sqlite.exec("UPDATE sessions SET cleared_at=100 WHERE id='task'");
  await assert.rejects(write('task', { ...message, clientId: 'stale' }, { expectedClearBoundaryMs: null }), /REMOTE_OPTIMISTIC_INPUT_CLEARED/);
  const current = await write('task', { ...message, clientId: 'after-clear' }, { expectedClearBoundaryMs: 100 });
  assert.equal(current.clientId, 'after-clear');
});

// A byte/ledger failure can follow a committed message insert. Retrying that
// insert must publish its original receipt once, without creating a new row.
test('retry after media bookkeeping failure preserves one row and its publication', async t => {
  const { sqlite, db } = sessionListDb(t);
  sqlite.exec(`CREATE UNIQUE INDEX message_delivery ON messages(session_id,client_id);
    INSERT INTO sessions(id,source,status,created_at,updated_at) VALUES ('task','desktop','active',0,1)`);
  const owner = { client: createDbClientForHandle({ db: sqlite, drizzle: db }), userId: 'isolated', clientEpoch: 1 };
  const events = [];
  let failure = true;
  const write = createHostMessageStore({ getOwner: () => owner, publish: event => events.push(event),
    commitMediaRefs: async () => { if (failure) throw new Error('disk full'); } });
  const body = { clientId: 'one', role: 'assistant', content: 'reply' };
  await assert.rejects(write('task', body), /disk full/);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM messages').get().n, 1);
  assert.deepEqual(events, []);
  failure = false;
  const first = await write('task', body);
  assert.equal((await write('task', body)).id, first.id);
  assert.equal(events.length, 1);
});

// Real storage, shared production event reducer: full tool output must update
// one row and one notification; an authoritative empty assistant retracts it.
// The old Host persisted neither tool history nor final-message corrections.
test('Host event history updates and retracts the original rows without duplicate notifications', async t => {
  const { sqlite, db } = sessionListDb(t);
  sqlite.exec(`CREATE UNIQUE INDEX message_delivery ON messages(session_id,client_id);
    INSERT INTO sessions(id,source,status,created_at,updated_at)
    VALUES ('task','desktop','active',0,1)`);
  const client = createDbClientForHandle({ db: sqlite, drizzle: db });
  setCurrentDbClient(client, 'isolated');
  t.after(() => clearCurrentDbClient(client));
  const owner = getCurrentDbClientSnapshot();
  const events = [];
  const publish = event => events.push(event);
  const history = createHostEventPersistence({ getOwner: getCurrentDbClientSnapshot,
    isCurrent: () => getCurrentDbClientSnapshot() === owner,
    persistMessage: createHostMessageStore({ getOwner: getCurrentDbClientSnapshot, publish }),
    publish, onPersistenceError: error => { throw error; } });
  history.noteSessionAgentKind('task', 'cc');
  history.noteTurnStarted('task');
  const session = { id: 'task', workDir: '/tmp', remoteHostId: null };
  const emit = (type, data) => history.event(session, { type, data });
  const draft = emit('text', { text: 'draft', agentMessageId: 'draft-1' }).persistId;
  emit('tool_use', { toolUseId: 'read-1', toolName: 'Read', input: { path: 'file.txt' } });
  const result = emit('tool_result', { toolUseIds: ['read-1'], summary: 'summary' }).persistId;
  await history.drain();
  events.length = 0;
  assert.deepEqual(emit('tool_result_full', { toolUseId: 'read-1', fullText: 'complete contents' }),
    { persistId: result, resolvedContent: 'complete contents' });
  emit('text', { text: 'corrected draft', isFinal: true, isFullText: true, agentMessageId: 'draft-1' });
  await history.drain();
  assert.equal(events.filter(event => event.type === 'message_created' && event.message.clientId === draft).length, 1);
  emit('text', { text: '', isFinal: true, isFullText: true, agentMessageId: 'draft-1' });
  await history.drain();
  assert.equal(history.hasFailedWrites(), false);
  const rows = sqlite.prepare('SELECT client_id,role,content FROM messages ORDER BY rowid').all();
  assert.equal(rows.some(row => row.client_id === draft), false);
  assert.deepEqual(rows.map(row => row.role), ['tool_use', 'tool_result']);
  assert.equal(rows.find(row => row.client_id === result).content, 'complete contents');
  assert.deepEqual(events.filter(event => event.type === 'message_deleted').map(event => event.clientId), [draft]);
  assert.equal((await readHostSession(db, 'task'))._count.messages, 2);

  const broker = createInteractionBroker({ hub: { publish } });
  t.after(() => broker.dispose());
  const interactive = { ...session, setInteractionListener(listener) { this.listener = listener; } };
  broker.attach(interactive, 'task', { history, isCurrent: () => getCurrentDbClientSnapshot() === owner });
  for (const request of [
    { requestId: 'question', kind: 'ask_user_question', questions: [{ question: 'Where?' }] },
    { requestId: 'plan', kind: 'plan_review', plan: 'Write the file' },
  ]) {
    const answer = interactive.listener(request);
    await history.drain();
    const pending = broker.pending('task')[0];
    assert.ok(pending.request.persistId);
    const decision = request.kind === 'ask_user_question'
      ? { kind: request.kind, answers: { Where: 'here' } } : { kind: request.kind, behavior: 'allow' };
    assert.equal(broker.respond('task', request.requestId, decision), true);
    assert.equal(broker.respond('task', request.requestId, decision), false);
    await answer;
    await history.drain();
    const saved = sqlite.prepare('SELECT content FROM messages WHERE client_id=?').get(pending.request.persistId);
    assert.equal(JSON.parse(saved.content).status, request.kind === 'ask_user_question' ? 'answered' : 'approved');
    assert.equal(broker.pending('task').length, 0);
  }

  // A queued old-owner write cannot land after a switch, even if both databases
  // contain the same task id. No external account or profile is involved.
  emit('text', { text: 'old owner reply', isFinal: true });
  clearCurrentDbClient(client);
  await history.drain();
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM messages').get().n, 4);
});

// Real SQL, same task id under two owners: a write's asynchronous readback
// must never fetch the newly selected account's row (unit).
test('session storage readback stays with the owner that accepted the write', async t => {
  const old = sessionListDb(t), next = sessionListDb(t);
  for (const [database, title] of [[old, 'old'], [next, 'new']]) {
    database.sqlite.prepare('INSERT INTO sessions (id,title,agent_kind,status,created_at,updated_at) VALUES (?, ?, ?, ?, 0, 0)')
      .run('same-task', title, 'cc', 'active');
  }
  let reads = 0;
  const storage = new OwnerSessionStorage({ db: () => ({ drizzle: reads++ === 0 ? old.db : next.db }) });
  assert.equal((await storage.update('same-task', { title: 'old updated' })).title, 'old updated');
  assert.equal(next.sqlite.prepare('SELECT title FROM sessions').get().title, 'new');
});


// Unit with real in-memory SQL: Host previously left the shared recovery ports
// disconnected. A persisted user row crossing clear must disappear once, retain
// retry identity, and release only its own media refs (or discard a schedule row).
for (const discard of [false, true]) {
  test(`Host clear recovery cleans user history and media (discard=${discard})`, async t => {
    const { sqlite, db } = sessionListDb(t);
    for (const table of [mediaRefs, sessionPrRefs, migrationMeta]) {
      sqlite.exec(`CREATE TABLE "${getTableName(table)}" (${Object.values(getTableColumns(table))
        .map(column => `"${column.name}" ${column.getSQLType()}`).join(',')})`);
    }
    const hash = 'a'.repeat(64);
    sqlite.exec("INSERT INTO sessions(id,status,created_at,updated_at,list_preview,list_message_count) VALUES ('task','active',0,1,'stale',2)");
    const insert = sqlite.prepare("INSERT INTO messages(id,session_id,client_id,role,content,created_at) VALUES (?, 'task', ?, 'user', ?, 100)");
    insert.run('row-a', 'user-a', `cindy-media://blobs/${hash}.png`);
    insert.run('row-b', 'user-b', 'unrelated');
    const ref = sqlite.prepare('INSERT INTO media_refs(id,hash,ref_kind,ref_id) VALUES (?,?,?,?)');
    ref.run('ref-row', hash, 'message', 'row-a');
    ref.run('ref-client', hash, 'message', 'user-a');
    ref.run('ref-task', hash, 'session-attachment', 'task');
    ref.run('ref-unrelated', hash, 'message', 'row-b');
    const owner = { client: createDbClientForHandle({ db: sqlite, drizzle: db }), userId: 'isolated', clientEpoch: 1 };
    const events = [];
    const recovery = createHostMessageRecovery({ getOwner: () => owner, publish: event => events.push(event) });
    await recovery.rewindPersistedUserMessageAfterClear('task', 'user-a', { discard });
    const recovered = sqlite.prepare("SELECT rewind_at FROM messages WHERE client_id='user-a'").get();
    if (discard) assert.equal(recovered, undefined);
    else assert.equal(typeof recovered.rewind_at, 'number');
    assert.deepEqual(sqlite.prepare('SELECT id FROM media_refs').all(), [{ id: 'ref-unrelated' }]);
    assert.equal(sqlite.prepare("SELECT rewind_at FROM messages WHERE client_id='user-b'").get().rewind_at, null);
    assert.equal(sqlite.prepare("SELECT list_preview FROM sessions WHERE id='task'").get().list_preview, null);
    assert.deepEqual(events, [{ type: 'message_deleted', sessionId: 'task', clientId: 'user-a', clientIds: ['user-a'] }]);
    await recovery.rewindPersistedUserMessageAfterClear('task', 'user-a', { discard });
    assert.equal(events.length, 1);
  });
}

// Unit: a clear rollback may finish after an account switch. Both accounts use
// the same task/input identifiers; cleanup must not touch or notify the new one.
test('Host clear recovery stops cleanup when the owner changes during the tombstone write', async t => {
  const old = sessionListDb(t), next = sessionListDb(t);
  for (const database of [old, next]) {
    database.sqlite.exec(`CREATE TABLE media_refs (${Object.values(getTableColumns(mediaRefs))
      .map(column => `"${column.name}" ${column.getSQLType()}`).join(',')})`);
    database.sqlite.exec("INSERT INTO sessions(id,status,list_preview) VALUES ('task','active','preview')");
    database.sqlite.exec("INSERT INTO messages(id,session_id,client_id,role,content,created_at) VALUES ('row','task','input','user','hello',100)");
    database.sqlite.prepare('INSERT INTO media_refs(id,hash,ref_kind,ref_id) VALUES (?,?,?,?)')
      .run('ref', 'b'.repeat(64), 'message', 'row');
  }
  const oldClient = createDbClientForHandle({ db: old.sqlite, drizzle: old.db });
  const nextOwner = { client: createDbClientForHandle({ db: next.sqlite, drizzle: next.db }), userId: 'next', clientEpoch: 2 };
  let owner = { client: oldClient, userId: 'old', clientEpoch: 1 };
  const tx = oldClient.tx;
  oldClient.tx = async (...args) => {
    const result = await tx(...args);
    owner = nextOwner;
    return result;
  };
  const events = [];
  const recovery = createHostMessageRecovery({ getOwner: () => owner, publish: event => events.push(event) });
  await recovery.rewindPersistedUserMessageAfterClear('task', 'input');
  assert.equal(typeof old.sqlite.prepare('SELECT rewind_at FROM messages').get().rewind_at, 'number');
  assert.equal(next.sqlite.prepare('SELECT rewind_at FROM messages').get().rewind_at, null);
  assert.equal(next.sqlite.prepare('SELECT list_preview FROM sessions').get().list_preview, 'preview');
  for (const database of [old, next]) assert.deepEqual(database.sqlite.prepare('SELECT id FROM media_refs').all(), [{ id: 'ref' }]);
  assert.deepEqual(events, []);
});

// Pi retry must reuse a native entry only while its Cindy row remains visible.
// The old Host had neither linking nor lookup; same text cannot be a retry key.
test('Host Pi recovery preserves message metadata and excludes cleared or rewound entries', async t => {
  const { sqlite, db } = sessionListDb(t);
  sqlite.exec("INSERT INTO sessions(id,status) VALUES ('task','active')");
  sqlite.prepare("INSERT INTO messages(id,session_id,client_id,role,content,created_at,agent_meta) VALUES ('row','task','input','user','hello',100,?)")
    .run(JSON.stringify({ uuid: 'native-message', delivery: 'turn', autoReviewUserText: 'hello' }));
  const owner = { client: createDbClientForHandle({ db: sqlite, drizzle: db }), userId: 'isolated', clientEpoch: 1 };
  const recovery = createHostMessageRecovery({ getOwner: () => owner, publish() {} });
  assert.equal(await recovery.readPiUserEntry('task', 'input'), undefined);
  assert.equal(await recovery.linkPiUserEntry('task', 'input', 'pi-entry'), true);
  assert.equal(await recovery.readPiUserEntry('task', 'input'), 'pi-entry');
  assert.deepEqual(JSON.parse(sqlite.prepare("SELECT agent_meta FROM messages WHERE id='row'").get().agent_meta),
    { uuid: 'native-message', delivery: 'turn', autoReviewUserText: 'hello', piEntryId: 'pi-entry' });
  sqlite.exec("UPDATE sessions SET cleared_at=100 WHERE id='task'");
  assert.equal(await recovery.readPiUserEntry('task', 'input'), undefined);
  sqlite.exec("UPDATE sessions SET cleared_at=NULL WHERE id='task'; UPDATE messages SET rewind_at=200 WHERE id='row'");
  assert.equal(await recovery.readPiUserEntry('task', 'input'), undefined);
  assert.equal(await recovery.linkPiUserEntry('task', 'missing', 'pi-entry'), false);
});
