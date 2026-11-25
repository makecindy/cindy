import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createDbClientForHandle } from '../client/createDbClientForHandle';
import * as schema from '../schema';
import { buildHandoff, prependHandoffToUserMessage } from '../../maker-ipc/agentHandoff';
vi.mock('../ipc/messages.js', async () => ({
  listMessagesForAgentHandoff: (await import('../agentHandoffHistory')).listMessagesForAgentHandoff,
}));
import {
  previewDagHistoryEdit,
  commitDagHistoryEdit,
  undoDagHistoryEdit,
  getDagHistoryEditStatus,
} from '../../maker-orchestration/dagHistoryEdit';
const guards = vi.hoisted(() => ({ owner: 'ownerA', active: '' }));
vi.mock('../../appSessionState.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../appSessionState.js')>(),
  activeOwnerScopeKey: () => guards.owner,
  getActiveAppSession: () => ({ dataOwnerId: 'dev' }),
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../maker-host/index.js', () => ({
  getMaker: () => ({
    getSession: (id: string) => (guards.active === id ? {} : null),
    getSessionMeta: async () => null,
  }),
}));
vi.mock('../../authBoundaryQuarantine.js', () => ({
  withStableOwnerBoundaryMutation: (_id: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../../maker-ipc/register.js', () => ({
  withIdleDagInputFence: (_ids: string[], fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../../maker-ipc/agentHandoffPendingSingleton.js', async () => {
  const { createAgentHandoffPending } = await import('../../maker-ipc/agentHandoffPending');
  return {
    agentHandoffPending: createAgentHandoffPending({
      markLatestAgentHandoffConsumed: async () => {},
      log: { warn: () => {} },
    }),
  };
});
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { runMigrationReplay } from '../migrationRunner';
import { clearCurrentDbClient, setCurrentDbClient } from '../client/current';
import { findPendingAgentHandoff } from '../agentHandoffPendingQueries';
import { listMessagesForAgentHandoff } from '../agentHandoffHistory';
import { dagHistoryTx } from '../worker/opHandlers/dagHistoryTx';

// Integration: 1.3.1 could only preview. Exercise the migration and operation journal in a
// disposable SQLite database and read model inputs through the real native handoff reader.
const db = createBetterSqliteDatabase(':memory:');
const root = path.resolve(__dirname, '../../../..');
beforeAll(() => {
  const extension =
    process.platform === 'win32'
      ? 'vec0.dll'
      : process.platform === 'darwin'
        ? 'vec0.dylib'
        : 'vec0.so';
  db.loadExtension(
    path.join(root, 'native', 'sqlite-vec', `${process.platform}-${process.arch}`, extension),
  );
  db.transaction(() => runMigrationReplay(db, { drizzleDir: path.join(root, 'drizzle') }))();
  setCurrentDbClient(createDbClientForHandle({ db, drizzle: drizzle(db, { schema }) }), 'dev');
});
afterAll(() => {
  clearCurrentDbClient();
  db.close();
});
function addSession(id: string, parent: string | null = null, anchor: string | null = null) {
  db.prepare(
    'INSERT INTO sessions(id,parent_session_id,forked_at_message_id,created_at,updated_at) VALUES(?,?,?,1,1)',
  ).run(id, parent, anchor);
}
function msg(s: string, id: string, role: string, text: string, t: number) {
  db.prepare(
    'INSERT INTO messages(id,client_id,session_id,role,content,created_at) VALUES(?,?,?,?,?,?)',
  ).run(`${s}:${id}`, id, s, role, JSON.stringify(text), t);
}
function boundary(s: string, text: string) {
  db.prepare(
    "INSERT INTO messages(id,client_id,session_id,role,content,created_at,rewind_at) VALUES(?,?,?,'context_rebuild',?,10,10)",
  ).run(
    `${s}:old-boundary`,
    'old-boundary',
    s,
    JSON.stringify({
      handoff: text,
      handoffCoverage: 'complete',
      consumed: false,
      reason: 'message-rewind',
    }),
  );
}
function plan(s: string) {
  const req = { id: `op-${s}`, sessionId: s, clientId: 'B', action: 'withdraw' as const };
  const x = dagHistoryTx(db, { ...req, kind: 'preview' });
  if (!x || !('fingerprint' in x)) throw Error('missing preview');
  return {
    ...req,
    fingerprint: x.fingerprint,
    markerContent: JSON.stringify({
      reason: 'message-rewind',
      consumed: false,
      handoff: 'prefix A',
      handoffCoverage: 'complete',
    }),
  };
}
it('atomically removes B and a fork after B, keeps the fork before B and restores the exact pending model input', async () => {
  addSession('r');
  msg('r', 'A', 'user', 'prefix A', 1);
  msg('r', 'a', 'assistant', 'prefix answer', 2);
  msg('r', 'B', 'user', 'withdrawn B', 3);
  msg('r', 'b', 'assistant', 'withdrawn answer', 4);
  boundary('r', 'original A + withdrawn B');
  addSession('sibling', 'r', 'B');
  addSession('child', 'r', 'b');
  for (const [i, pair] of [
    ['A', 'user'],
    ['a', 'assistant'],
    ['B', 'user'],
    ['b', 'assistant'],
  ].entries())
    msg(
      'child',
      `copy-${i}`,
      pair[1],
      ['prefix A', 'prefix answer', 'withdrawn B', 'withdrawn answer'][i],
      i + 1,
    );
  msg('child', 'C', 'user', 'child C', 5);
  boundary('child', 'child handoff');
  const before = await findPendingAgentHandoff('r');
  const operation = plan('r');
  expect(dagHistoryTx(db, { kind: 'commit', ...operation })).toMatchObject({
    removedSessionIds: ['child'],
    question: 'withdrawn B',
  });
  expect((await listMessagesForAgentHandoff('r', null)).map((m) => m.clientId)).toEqual(['A', 'a']);
  expect(await findPendingAgentHandoff('r')).toBe('prefix A');
  expect((await listMessagesForAgentHandoff('child', null)).length).toBe(0);
  expect(db.prepare("select status from sessions where id='sibling'").get()).toEqual({
    status: 'active',
  });
  expect(dagHistoryTx(db, { kind: 'status', id: operation.id })).toMatchObject({
    status: 'committed',
  });
  expect(await findPendingAgentHandoff('child')).toBeNull();
  db.prepare(
    "UPDATE sessions SET updated_at=42,last_activity_at=41,list_message_count=2,pinned_at=29 WHERE id='r'",
  ).run();
  expect(dagHistoryTx(db, { kind: 'undo', id: operation.id })).toMatchObject({ status: 'undone' });
  expect(db.prepare("SELECT pinned_at FROM sessions WHERE id='r'").get()).toEqual({
    pinned_at: 29,
  });
  expect(await findPendingAgentHandoff('r')).toBe(before);
  expect((await listMessagesForAgentHandoff('child', null)).at(-1)?.clientId).toBe('C');
});
// DB tier: promotion keeps the origin link but transfers history ownership to the side chat.
it.each(['withdraw', 'delete'] as const)('does not cross a promoted side chat when applying %s to its origin', async (action) => {
  const origin = `origin-${action}`, promoted = `promoted-${action}`, child = `child-${action}`;
  addSession(origin);
  msg(origin, 'B', 'user', 'origin question', 1);
  msg(origin, 'b', 'assistant', 'origin answer', 2);
  boundary(origin, 'origin handoff');
  addSession(promoted, origin, 'b');
  db.prepare("UPDATE sessions SET source='side-chat', side_chat_promoted=1 WHERE id=?").run(promoted);
  msg(promoted, 'B', 'user', 'independent question', 3);
  boundary(promoted, 'independent handoff');
  addSession(child, promoted, 'B');
  msg(child, 'C', 'user', 'child question', 4);

  const request = { ...plan(origin), action, markerContent: JSON.stringify({ reason: 'message-rewind', consumed: false, handoff: '' }) };
  expect(dagHistoryTx(db, { ...request, kind: 'commit' })).toMatchObject({ removedSessionIds: [] });
  expect(await listMessagesForAgentHandoff(origin, null)).toHaveLength(0);
  expect((await listMessagesForAgentHandoff(promoted, null)).map(m => m.clientId)).toEqual(['B']);
  expect((await listMessagesForAgentHandoff(child, null)).map(m => m.clientId)).toEqual(['C']);
  // Its old origin anchor is now rewound. The promoted task must still be independently editable.
  expect(plan(promoted).fingerprint).toBeTruthy();
  expect(dagHistoryTx(db, { kind: 'undo', id: request.id })).toMatchObject({ status: 'undone' });
});

it('builds the real next wire input without the removed question and restores the original at the service boundary', async () => {
  addSession('svc');
  msg('svc', 'A', 'user', 'keep-apricot', 1);
  msg('svc', 'a', 'assistant', 'keep-maple', 2);
  msg('svc', 'B', 'user', 'drop-pepper', 3);
  msg('svc', 'b', 'assistant', 'drop-clove', 4);
  const before = buildHandoff(await listMessagesForAgentHandoff('svc', null, undefined, 'replay'), {
    fromLabel: 'Claude Code',
    toLabel: 'Claude Code',
    reason: 'message-rewind',
    sessionId: 'svc',
  });
  expect(before.handoffCoverage).toBe('complete');
  boundary('svc', before.handoff);
  const { agentHandoffPending } = await import('../../maker-ipc/agentHandoffPendingSingleton.js');
  const wire = async () =>
    JSON.stringify(
      prependHandoffToUserMessage(
        { type: 'user', content: 'probe' },
        (await agentHandoffPending.peek('svc')) ?? '',
      ),
    );
  const initial = await wire();
  expect(initial).toContain('drop-pepper');
  guards.active = 'svc';
  expect((await previewDagHistoryEdit('svc', 'B', 'delete', guards.owner)).canCommit).toBe(false);
  guards.active = '';
  const preview = await previewDagHistoryEdit('svc', 'B', 'withdraw', guards.owner);
  expect(preview.canCommit).toBe(true);
  expect(preview.turnCount).toBe(1);
  expect(await commitDagHistoryEdit(preview.operationId, guards.owner)).toMatchObject({
    status: 'committed',
    question: 'drop-pepper',
  });
  const filtered = await wire();
  expect(filtered).toContain('keep-maple');
  expect(filtered).not.toMatch(/drop-pepper|drop-clove/);
  expect(await getDagHistoryEditStatus(preview.operationId, guards.owner)).toMatchObject({
    status: 'committed',
  });
  await expect(undoDagHistoryEdit(preview.operationId, 'stale-owner')).rejects.toThrow('账号');
  await undoDagHistoryEdit(preview.operationId, guards.owner);
  expect(await wire()).toBe(initial);
});
it('rolls back a failure after the message rewrite and before the receipt is durable', async () => {
  addSession('rollback');
  msg('rollback', 'B', 'user', 'must survive', 3);
  boundary('rollback', 'must survive');
  const op = {
    ...plan('rollback'),
    markerContent: JSON.stringify({ reason: 'message-rewind', consumed: false, handoff: '' }),
  };
  db.exec(
    "CREATE TEMP TRIGGER reject_receipt BEFORE INSERT ON dag_history_edits WHEN NEW.session_id='rollback' BEGIN SELECT RAISE(ABORT, 'journal unavailable'); END;",
  );
  try {
    expect(() => dagHistoryTx(db, { ...op, kind: 'commit' })).toThrow('journal unavailable');
  } finally {
    db.exec('DROP TRIGGER reject_receipt');
  }
  expect((await listMessagesForAgentHandoff('rollback', null)).map((m) => m.clientId)).toEqual([
    'B',
  ]);
  expect(await findPendingAgentHandoff('rollback')).toBe('must survive');
  expect(dagHistoryTx(db, { id: op.id, kind: 'status' })).toBeNull();
});
it('leaves queued, active-native and changed histories untouched, including edits after commit', () => {
  addSession('r2');
  msg('r2', 'B', 'user', 'question', 3);
  boundary('r2', 'question');
  const p = plan('r2');
  msg('r2', 'new', 'user', 'later', 4);
  expect(() => dagHistoryTx(db, { ...p, kind: 'commit' })).toThrow('已变化');
  const next = {
    ...plan('r2'),
    markerContent: JSON.stringify({ reason: 'message-rewind', consumed: false, handoff: '' }),
  };
  dagHistoryTx(db, { ...next, kind: 'commit' });
  msg('r2', 'newer', 'user', 'do not overwrite', 11);
  expect(() => dagHistoryTx(db, { kind: 'undo', id: next.id })).toThrow('不能覆盖');
  addSession('r3');
  msg('r3', 'B', 'user', 'third', 1);
  db.prepare("UPDATE sessions SET sdk_session_id='real-native' WHERE id='r3'").run();
  expect(() => plan('r3')).toThrow('原生');
  db.prepare("UPDATE sessions SET sdk_session_id=NULL WHERE id='r3'").run();
  db.prepare("INSERT INTO agent_input_queue_snapshots VALUES('r3','[]',1)").run();
  expect(() => plan('r3')).toThrow('排队');
});
