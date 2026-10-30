import Database from 'better-sqlite3';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('../localDb/client/current.js', () => ({ getDbClient: vi.fn() }));
import { readTaskResultsForReply } from '../botTaskReplyResults';
import type { DbClient } from '../localDb/client/DbClient';
import { BOT_DELEGATION_CLIENT_ID as ids, type BotCollaborationMeta } from '../../shared/botCollaboration';
let sqlite: Database.Database;
let createdAt: number;
let db: Pick<DbClient, 'queryOne' | 'query'>;
const card = (id = 'job', runSequence = 1): BotCollaborationMeta => ({ v: 1, role: 'delegation-result',
  delegationId: id, fromBotId: 'bot', fromBotName: 'Cindy', toBotId: null, toBotName: '',
  parentSessionId: 'chat', childSessionId: 'child', objective: 'Prepare report',
  result: { title: 'Report', runSequence, status: 'completed', text: 'Frozen result', artifacts: [] } });
function row(id: string, role: string, content: string, meta: object = {}, session = 'chat') {
  sqlite.prepare('INSERT INTO messages (session_id,client_id,role,content,agent_meta,created_at) VALUES (?,?,?,?,?,?)')
    .run(session, id, role, JSON.stringify(content), JSON.stringify(meta), ++createdAt);
}
function receipt(id = 'job', run = 1) {
  row(ids.resultRun(id, run), 'assistant', 'Frozen result', { botCollaboration: card(id, run) });
  row(ids.completionRun(id, run), 'user', 'Completion input');
}
const bind = (inputs = [ids.completionRun('job', 1)]) => readTaskResultsForReply('chat', 'final', inputs, db);
beforeEach(() => {
  createdAt = 1000;
  sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE sessions(id TEXT,source TEXT); CREATE TABLE bot_session_links(session_id TEXT,bot_id TEXT,role TEXT);
    CREATE TABLE messages(session_id TEXT,client_id TEXT,role TEXT,content TEXT,agent_meta TEXT,created_at INTEGER,rewind_at INTEGER);
    INSERT INTO sessions VALUES ('chat','bot'); INSERT INTO bot_session_links VALUES ('chat','bot','canonical');`);
  db = { queryOne: async <T,>(sql: string, args: unknown[] = []) => sqlite.prepare(sql).get(...args) as T | undefined,
    query: async <T,>(sql: string, args: unknown[] = []) => sqlite.prepare(sql).all(...args) as T[] };
});
afterEach(() => sqlite.close());
it('binds multiple exact executions to one reply, independent of receipt order and human interjections', async () => {
  receipt('b'); receipt('a', 2); receipt('queued');
  row('commentary', 'assistant', 'Checking', { assistantPhase: 'commentary' });
  row('human-steer', 'user', 'Also include priorities');
  row('final', 'assistant', 'Both reports are ready', { assistantPhase: 'final' });
  expect(await bind([ids.completionRun('a', 2), ids.completionRun('b', 1), ids.completionRun('a', 2)]))
    .toEqual([card('a', 2), card('b')]);
  expect(sqlite.prepare('SELECT count(*) n FROM messages').get()).toEqual({ n: 9 });
});
it('does not adopt receipts from queued/unrelated inputs, a different run or another conversation', async () => {
  receipt(); row('final', 'assistant', 'Unrelated answer');
  expect(await bind(['human'])).toEqual([]);
  expect(await bind([ids.completionRun('job', 2)])).toEqual([]);
  sqlite.prepare('UPDATE messages SET session_id=? WHERE client_id=?').run('elsewhere', ids.resultRun('job', 1));
  expect(await bind()).toEqual([]);
});
it.each([{ assistantPhase: 'commentary' }, { parentUuid: 'subagent' }, { botPrivateReply: true }])('does not attach to non-public/final prose %j', async meta => {
  receipt(); row('final', 'assistant', 'Progress', meta); expect(await bind()).toEqual([]);
});
it('leaves the receipt accessible when no final prose exists or a tool follows the last preamble', async () => {
  receipt(); expect(await bind()).toEqual([]);
  row('final', 'assistant', ''); expect(await bind()).toEqual([]);
  sqlite.prepare('UPDATE messages SET content=? WHERE client_id=?').run(JSON.stringify('I will check'), 'final');
  row('tool', 'tool_use', 'Read'); expect(await bind()).toEqual([]);
});
it.each(['task', 'scheduler'])('does not touch ordinary %s sessions', async source => {
  receipt(); row('final', 'assistant', 'Answer'); sqlite.prepare('UPDATE sessions SET source=?').run(source);
  expect(await bind()).toEqual([]);
});
it('preserves durable ownership after restart/repeated delivery and permits a separate continuation run', async () => {
  receipt(); row('old-final', 'assistant', 'First answer', { turnCompleted: true, botTaskResults: [card()] });
  row('final', 'assistant', 'Repeated wake'); expect(await bind()).toEqual([]);
  receipt('job', 2);
  row('continuation-final', 'assistant', 'Second run ready');
  const bindContinuation = () => readTaskResultsForReply('chat', 'continuation-final', [ids.completionRun('job', 2)], db);
  expect(await bindContinuation()).toEqual([card('job', 2)]);
  sqlite.prepare('UPDATE messages SET agent_meta=? WHERE client_id=?').run(JSON.stringify({ turnCompleted: true, botTaskResults: [card('job', 2)] }), 'continuation-final');
  expect(await bindContinuation()).toEqual([card('job', 2)]);
});
it('requires matching teammate ownership and retains malformed/rewound rows as unbound', async () => {
  receipt(); row('final', 'assistant', 'Answer');
  sqlite.prepare('UPDATE bot_session_links SET bot_id=?').run('another'); expect(await bind()).toEqual([]);
  sqlite.prepare('UPDATE bot_session_links SET bot_id=?').run('bot');
  sqlite.prepare('UPDATE messages SET rewind_at=1 WHERE client_id=?').run('final'); expect(await bind()).toEqual([]);
});

it('does not lose earlier attachments when a repeated seal sees only part of the input batch', async () => {
  receipt('a'); receipt('b');
  row('final', 'assistant', 'Both ready', { turnCompleted: true, botTaskResults: [card('a'), card('b')] });
  expect(await bind([ids.completionRun('b', 1)])).toEqual([card('a'), card('b')]);
});

it('ignores corrupt historic metadata without losing new results or valid duplicate ownership', async () => {
  row('corrupt', 'assistant', 'Old reply');
  sqlite.prepare('UPDATE messages SET agent_meta=? WHERE client_id=?').run('{truncated', 'corrupt');
  row('old-shape', 'assistant', 'Old reply', { turnCompleted: true, botTaskResults: ['legacy', null, 7] });
  receipt(); row('final', 'assistant', 'Ready');
  expect(await bind()).toEqual([card()]);
  row('valid-owner', 'assistant', 'Already delivered', { turnCompleted: true, botTaskResults: [card()] });
  expect(await bind()).toEqual([]);
  expect(sqlite.prepare('SELECT agent_meta FROM messages WHERE client_id=?').get('corrupt'))
    .toEqual({ agent_meta: '{truncated' });
});

it('keeps a late completion standalone when done reuses text from before that input', async () => {
  receipt('early');
  row('final', 'assistant', 'Answer to the earlier result');
  receipt('late');
  expect(await bind([ids.completionRun('early', 1), ids.completionRun('late', 1)]))
    .toEqual([card('early')]);
  row('post-input-final', 'assistant', 'Both results are now ready');
  expect(await readTaskResultsForReply('chat', 'post-input-final', [ids.completionRun('late', 1)], db))
    .toEqual([card('late')]);
});

it.each([-1, 0])('does not mistake a delayed flush for post-input text (time offset %s)', async offset => {
  receipt();
  const inputTime = createdAt;
  row('final', 'assistant', 'Buffered pre-steer answer');
  sqlite.prepare('UPDATE messages SET created_at=? WHERE client_id=?').run(inputTime + offset, 'final');
  expect(await bind()).toEqual([]);
});

it('requires the exact visible input boundary and leaves missing or rewound input unbound', async () => {
  receipt(); row('final', 'assistant', 'Ready');
  sqlite.prepare('UPDATE messages SET rewind_at=1 WHERE client_id=?').run(ids.completionRun('job', 1));
  expect(await bind()).toEqual([]);
  sqlite.prepare('DELETE FROM messages WHERE client_id=?').run(ids.completionRun('job', 1));
  expect(await bind()).toEqual([]);
});
