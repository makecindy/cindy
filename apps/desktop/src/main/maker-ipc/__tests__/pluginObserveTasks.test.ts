import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { DbClient } from '../../localDb/client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../../localDb/client/current.js';
import type { DbTransport } from '../../localDb/client/DbTransport.js';
import { createDrizzleProxy } from '../../localDb/client/drizzleProxy.js';

const mocks = vi.hoisted(() => ({
  workdirs: vi.fn<() => Promise<Array<{ path: string; exists: boolean }>>>(),
  phases: new Map<string, { phase: string; attention: boolean }>(),
  snapshots: vi.fn<() => Map<string, { phase: string; attention: boolean }>>(),
}));
vi.mock('../../localDb/ipc/recentWorkdirsCore.js', () => ({ listRecentWorkdirs: mocks.workdirs }));
vi.mock('../../agent-island/current.js', () => ({
  getAgentIslandService: () => ({ getSessionActivityFlags: mocks.snapshots }),
}));

import { assertPluginObservableTask, listPluginObserveTasks, listPluginSessionStatuses } from '../pluginObserveTasks.js';

let db: Database.Database;
let client: DbClient;
const readDb = vi.fn(({ sql, params }: { sql: string; params: unknown[] }) => db.prepare(sql).raw().all(...params));

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New Maker', working_dir TEXT,
      workspace_kind TEXT NOT NULL DEFAULT 'project', status TEXT NOT NULL DEFAULT 'active',
      agent_kind TEXT NOT NULL DEFAULT 'cc', source TEXT NOT NULL DEFAULT 'desktop', orca_role TEXT,
      remote_host_id TEXT, agent_device_id TEXT, hidden_at INTEGER, side_chat_promoted INTEGER NOT NULL DEFAULT 0,
      active_turn_started_at INTEGER, last_turn_ended_at INTEGER, cleared_at INTEGER,
      last_activity_at INTEGER, user_send_at INTEGER, updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, rewind_at INTEGER);
    CREATE INDEX idx_messages_session_created ON messages(session_id, created_at);
    CREATE INDEX idx_messages_rewind_at ON messages(rewind_at);
    CREATE INDEX idx_messages_active_error_tail ON messages(session_id, created_at) WHERE role = 'error' AND rewind_at IS NULL;
    CREATE TABLE bot_session_links (id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE);
    CREATE TABLE schedules (id TEXT PRIMARY KEY, source TEXT NOT NULL);
    CREATE TABLE schedule_runs (id TEXT PRIMARY KEY, schedule_id TEXT, session_id TEXT, fired_at INTEGER,
      status TEXT, read_at INTEGER, pre_run_hook_result TEXT, error_msg TEXT);
    CREATE TABLE schedule_session_latest_runs (session_id TEXT PRIMARY KEY, run_id TEXT NOT NULL);
    CREATE INDEX idx_schedule_runs_session_latest ON schedule_runs(session_id, fired_at DESC, id DESC) WHERE session_id IS NOT NULL;
    CREATE TABLE orca_teams (id TEXT PRIMARY KEY, lead_session_id TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE orca_workers (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, session_id TEXT NOT NULL, execution_device_id TEXT);
  `);
  readDb.mockClear();
  const transport: DbTransport = {
    async send<R>(op: string, args: unknown) {
      if (op !== 'rawAll') throw new Error(`Unexpected DB operation ${op}`);
      return readDb(args as Parameters<typeof readDb>[0]) as R;
    },
    on() {},
    onTerminated() {},
    async close() {},
  };
  const unexpected = (): never => { throw new Error('Expected a Drizzle read'); };
  client = {
    drizzle: createDrizzleProxy(transport),
    query: unexpected, queryOne: unexpected, exec: unexpected, tx: unexpected,
    vecAvailable: false, async dispose() {},
  };
  setCurrentDbClient(client, 'test-user');
  mocks.workdirs.mockReset().mockResolvedValue([{ path: '/repo', exists: true }, { path: '/gone', exists: false }]);
  mocks.phases.clear();
  mocks.snapshots.mockReset().mockImplementation(() => mocks.phases);
});
afterEach(() => {
  clearCurrentDbClient();
  db.close();
});

function insert(id: string, workingDir: string | null, updatedAt: number, extra = '') {
  db.prepare('INSERT INTO sessions (id, title, working_dir, updated_at) VALUES (?, ?, ?, ?)').run(id, `title ${id}`, workingDir, updatedAt);
  if (extra) db.prepare(`UPDATE sessions SET ${extra} WHERE id = ?`).run(id);
}

// SQLite: project lists include local records using another Agent device or shared provider.
// A known dialogue or SSH task is also readable by ID independently of the project registry.
it('lists registered project metadata and looks up known ordinary session IDs across workspaces', async () => {
  insert('recent', '/repo', 30);
  insert('worktree', '/repo/.cindy-worktrees/branch', 10, 'last_activity_at = 50');
  insert('archived', '/repo', 20, "status = 'archived'");
  insert('other-project', '/elsewhere', 99);
  insert('deleted', '/repo', 99, "status = 'deleted'");
  insert('dialogue', null, 99, "workspace_kind = 'dialogue'");
  insert('hidden', '/repo', 99, 'hidden_at = 1');
  insert('worker', '/repo', 99, "orca_role = 'worker'");
  insert('review', '/repo', 99, "source = 'review'");
  insert('remote', '/repo', 99, "remote_host_id = 'ssh-host'");
  insert('device', '/repo', 99, "agent_device_id = 'other'");
  insert('shared-agent', '/repo', 40, "agent_device_id = 'share:s1'");
  insert('bot', '/repo', 99);
  insert('bot-source', null, 99, "source = 'bot'");
  db.exec("INSERT INTO bot_session_links VALUES ('link', 'bot')");
  mocks.phases.set('recent', { phase: 'running', attention: false });
  mocks.phases.set('missing', { phase: 'running', attention: false });
  mocks.phases.set('worktree', { phase: 'needs-interaction', attention: true });

  const tasks = await listPluginObserveTasks('/repo');

  expect(tasks).toEqual([
    { id: 'device', title: 'title device', agentKind: 'cc', archived: false, status: 'idle', lastActivityAt: 99 },
    { id: 'worktree', title: 'title worktree', agentKind: 'cc', archived: false, status: 'awaiting', lastActivityAt: 50 },
    { id: 'shared-agent', title: 'title shared-agent', agentKind: 'cc', archived: false, status: 'idle', lastActivityAt: 40 },
    { id: 'recent', title: 'title recent', agentKind: 'cc', archived: false, status: 'running', lastActivityAt: 30 },
    { id: 'archived', title: 'title archived', agentKind: 'cc', archived: true, status: 'idle', lastActivityAt: 20 },
  ]);

  insert('private-side-chat', '/repo', 99, "source = 'side-chat'");
  insert('promoted', '/repo', 99, "source = 'side-chat', side_chat_promoted = 1");
  mocks.workdirs.mockClear();
  readDb.mockClear();
  const statuses = await listPluginSessionStatuses([
    'dialogue', 'missing', 'recent', 'other-project', 'remote', 'device', 'shared-agent', 'archived',
    'deleted', 'hidden', 'worker', 'review', 'bot', 'bot-source', 'private-side-chat', 'promoted',
  ]);
  expect(statuses).toEqual([
    { id: 'dialogue', status: 'idle' }, { id: 'recent', status: 'running' },
    { id: 'other-project', status: 'idle' }, { id: 'remote', status: 'idle' },
    { id: 'device', status: 'idle' }, { id: 'shared-agent', status: 'idle' },
    { id: 'archived', status: 'idle' }, { id: 'promoted', status: 'idle' },
  ]);
  expect(mocks.workdirs).not.toHaveBeenCalled();
  expect(JSON.stringify(readDb.mock.results)).not.toContain('worktree');
  const plans = readDb.mock.calls.flatMap(([{ sql, params }]) =>
    db.prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(row => row.detail));
  expect(plans).toEqual(expect.arrayContaining([
    expect.stringMatching(/SEARCH sessions USING .*INDEX .*\(id=\?\)/),
    expect.stringContaining('SEARCH tail USING INDEX idx_messages_session_created'),
    expect.stringContaining('SEARCH messages USING INTEGER PRIMARY KEY'),
  ]));
});

// unit: sidebar parity for Orca leads (orcaLeadWorkerAttention.ts) — a lead must not look idle while its worker waits or failed.
it('lifts local worker error and awaiting onto the lead with one batched activity read', async () => {
  for (const id of ['lead-wait', 'lead-error', 'lead-remote', 'lead-done']) insert(id, '/repo', 1, "orca_role = 'lead'");
  for (const id of ['w-wait', 'w-error', 'w-remote', 'w-old']) insert(id, '/repo', 1, "orca_role = 'worker'");
  db.exec(`
    INSERT INTO orca_teams VALUES ('t1', 'lead-wait', 'active'), ('t2', 'lead-error', 'active'), ('t3', 'lead-remote', 'active'), ('t4', 'lead-done', 'completed');
    INSERT INTO orca_workers VALUES ('1', 't1', 'w-wait', NULL), ('2', 't2', 'w-error', NULL), ('3', 't3', 'w-remote', 'other-pc'), ('4', 't4', 'w-old', NULL);
  `);
  mocks.phases.set('lead-error', { phase: 'running', attention: false });
  for (const id of ['w-wait', 'w-remote', 'w-old']) mocks.phases.set(id, { phase: 'needs-interaction', attention: true });
  mocks.phases.set('w-error', { phase: 'error', attention: true });

  const status = new Map((await listPluginObserveTasks('/repo')).map((task) => [task.id, task.status]));

  expect(Object.fromEntries(status)).toEqual({ 'lead-wait': 'awaiting', 'lead-error': 'error', 'lead-remote': 'idle', 'lead-done': 'idle' });
  expect(mocks.snapshots).toHaveBeenCalledTimes(1);
  const ids = ['lead-remote', 'lead-error', 'lead-done', 'lead-wait'];
  await expect(listPluginSessionStatuses([...ids, 'w-error'])).resolves.toEqual(ids.map(id => ({ id, status: status.get(id) })));
  expect(mocks.snapshots).toHaveBeenCalledTimes(2);
});

it('rejects unregistered or missing projects and opens only listable tasks', async () => {
  insert('task', '/repo', 1);
  insert('shared-agent', '/repo', 1, "agent_device_id = 'share:s1'");
  insert('ssh', '/repo', 1, "remote_host_id = 'ssh-host'");
  insert('worker', '/repo', 1, "orca_role = 'worker'");
  insert('unregistered', '/elsewhere', 1);
  await expect(listPluginObserveTasks('/elsewhere')).rejects.toThrow('TARGET_UNAVAILABLE');
  await expect(listPluginObserveTasks('/gone')).rejects.toThrow('TARGET_UNAVAILABLE');
  await expect(assertPluginObservableTask('task')).resolves.toBeUndefined();
  await expect(assertPluginObservableTask('shared-agent')).resolves.toBeUndefined();
  await expect(assertPluginObservableTask('ssh')).rejects.toThrow('TARGET_UNAVAILABLE');
  await expect(assertPluginObservableTask('worker')).rejects.toThrow('TARGET_UNAVAILABLE');
  await expect(assertPluginObservableTask('unregistered')).rejects.toThrow('TARGET_UNAVAILABLE');
  await expect(assertPluginObservableTask('missing')).rejects.toThrow('TARGET_UNAVAILABLE');
});

// Unit coverage for the status-only contract. The old projection mock could hide a body in the DB worker reply.
it('batches visible terminal hints and preserves native completion, interruption, clear and rewind semantics', async () => {
  const errors = [
    ['malformed', 'private-error-body', 'error'],
    ['dismissed', '{"dismissed":true}', 'idle'],
    ['number', '{"dismissed":1}', 'idle'],
    ['string', '{"dismissed":"true"}', 'error'],
    ['last-dismissal', '{"dismissed":false,"dismissed":true}', 'error'],
    ['last-reopened', '{"dismissed":true,"dismissed":false}', 'idle'],
    ['non-text', Buffer.from('{"dismissed":true}'), 'idle'],
  ] as const;
  const message = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?)');
  for (const [id, content] of errors) {
    insert(id, '/repo', 1);
    message.run(id, 'error', content, 15, null);
  }
  insert('completed', null, 1, "workspace_kind = 'dialogue', active_turn_started_at = 10, last_turn_ended_at = 20");
  message.run('completed', 'error', 'private-error-body', 20, null);
  message.run('completed', 'assistant', 'private-assistant-body', 20, null);
  message.run('completed', 'error', 'private-error-body', 21, 22);
  insert('cleared', '/repo', 1, 'active_turn_started_at = 10, cleared_at = 20');
  message.run('cleared', 'error', 'private-error-body', 20, null);
  insert('interrupted', '/repo', 1, 'active_turn_started_at = 21, last_turn_ended_at = 19, cleared_at = 20');
  insert('unread', '/repo', 1);
  message.run('unread', 'error', 'private-error-body', 20, null);
  mocks.phases.set('unread', { phase: 'completed', attention: true });

  // SQLite evaluates this view column only when a query actually touches the body.
  db.function('error_content', (role, content) => {
    if (role !== 'error') throw new Error('Ordinary message body read');
    return content;
  });
  db.exec(`ALTER TABLE messages RENAME TO stored_messages;
    CREATE VIEW messages AS SELECT rowid, session_id, role, error_content(role, content) AS content,
      created_at, rewind_at FROM stored_messages;`);
  const statuses = await listPluginSessionStatuses([...errors.map(([id]) => id), 'completed', 'cleared', 'interrupted', 'unread']);
  expect(statuses).toEqual([
    ...errors.map(([id, , status]) => ({ id, status })),
    { id: 'completed', status: 'idle' }, { id: 'cleared', status: 'idle' },
    { id: 'interrupted', status: 'error' }, { id: 'unread', status: 'done' },
  ]);
  expect(readDb.mock.calls.length).toBeLessThanOrEqual(2);
  expect(JSON.stringify(readDb.mock.results)).not.toContain('private-');
});

it('combines unread schedule results with live waiting and running states', async () => {
  const run = db.prepare('INSERT INTO schedule_runs (id, schedule_id, session_id, fired_at, status) VALUES (?, ?, ?, 1, ?)');
  for (const [id, result] of [['completed', 'success'], ['running', 'success'], ['waiting', 'success'], ['failure', 'failed']] as const) {
    insert(id, null, 1, "workspace_kind = 'dialogue'");
    db.prepare("INSERT INTO schedules VALUES (?, 'user')").run(id);
    run.run(id, id, id, result);
    db.prepare('INSERT INTO schedule_session_latest_runs VALUES (?, ?)').run(id, id);
  }
  mocks.phases.set('running', { phase: 'running', attention: false });
  mocks.phases.set('waiting', { phase: 'needs-interaction', attention: false });
  mocks.phases.set('failure', { phase: 'running', attention: false });
  await expect(listPluginSessionStatuses(['completed', 'running', 'waiting', 'failure'])).resolves.toEqual([
    { id: 'completed', status: 'done' }, { id: 'running', status: 'running' },
    { id: 'waiting', status: 'awaiting' }, { id: 'failure', status: 'error' },
  ]);
});

it.each([
  ['project tasks', () => listPluginObserveTasks('/repo')],
  ['session statuses', () => listPluginSessionStatuses(['task'])],
] as const)('rejects %s if the account changes while projecting the result', async (_name, read) => {
  insert('task', '/repo', 1);
  mocks.snapshots.mockImplementationOnce(() => {
    setCurrentDbClient({ ...client, get drizzle(): DbClient['drizzle'] { throw new Error('Read from another account'); } }, 'other-user');
    return new Map();
  });
  await expect(read()).rejects.toThrow('PERMISSION_DENIED');
});
