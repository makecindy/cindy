import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { DbClient } from '../../localDb/client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../../localDb/client/current.js';
import * as schema from '../../localDb/schema.js';

const mocks = vi.hoisted(() => ({
  workdirs: [] as Array<{ path: string; exists: boolean }>,
  phases: new Map<string, { phase: string; attention: boolean }>(),
  onRead: null as null | (() => void),
  batchReaders: [] as string[][],
}));
vi.mock('../../localDb/ipc/recentWorkdirs.js', () => ({ listRecentWorkdirs: async () => mocks.workdirs }));
vi.mock('../sessionActivityProjection.js', () => ({
  createCanonicalSessionActivityBatchReader: (persisted: Map<string, unknown>) => {
    mocks.batchReaders.push([...persisted.keys()].sort());
    return async (id: string) => {
      mocks.onRead?.();
      return mocks.phases.get(id) ?? { phase: 'idle', attention: false };
    };
  },
}));

import { assertPluginObservableTask, listPluginObserveTasks } from '../pluginObserveTasks.js';

let db: Database.Database;
let client: DbClient;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New Maker', working_dir TEXT,
      workspace_kind TEXT NOT NULL DEFAULT 'project', status TEXT NOT NULL DEFAULT 'active',
      agent_kind TEXT NOT NULL DEFAULT 'cc', source TEXT NOT NULL DEFAULT 'desktop', orca_role TEXT,
      remote_host_id TEXT, agent_device_id TEXT, hidden_at INTEGER,
      active_turn_started_at INTEGER, last_turn_ended_at INTEGER, cleared_at INTEGER,
      last_activity_at INTEGER, user_send_at INTEGER, updated_at INTEGER NOT NULL
    );
    CREATE TABLE bot_session_links (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
    CREATE TABLE orca_teams (id TEXT PRIMARY KEY, lead_session_id TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE orca_workers (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, session_id TEXT NOT NULL, execution_device_id TEXT);
  `);
  client = { drizzle: drizzle(db, { schema }) } as unknown as DbClient;
  setCurrentDbClient(client, 'test-user');
  mocks.workdirs = [{ path: '/repo', exists: true }, { path: '/gone', exists: false }];
  mocks.phases.clear();
  mocks.onRead = null;
  mocks.batchReaders = [];
});
afterEach(() => {
  clearCurrentDbClient();
  db.close();
});

const insert = (id: string, workingDir: string, updatedAt: number, extra = '') =>
  db.prepare(`INSERT INTO sessions (id, title, working_dir, updated_at) VALUES (?, ?, ?, ?)`).run(id, `title ${id}`, workingDir, updatedAt) &&
  (extra ? db.exec(`UPDATE sessions SET ${extra} WHERE id = '${id}'`) : undefined);

// unit: real SQL filters against in-memory SQLite; only the activity reader and workdir registry are stubbed.
it('lists only visible local tasks of the registered project, as metadata in activity order', async () => {
  insert('recent', '/repo', 30);
  insert('worktree', '/repo/.cindy-worktrees/branch', 10, 'last_activity_at = 50');
  insert('archived', '/repo', 20, "status = 'archived'");
  insert('other-project', '/elsewhere', 99);
  insert('deleted', '/repo', 99, "status = 'deleted'");
  insert('dialogue', '/repo', 99, "workspace_kind = 'dialogue'");
  insert('hidden', '/repo', 99, 'hidden_at = 1');
  insert('worker', '/repo', 99, "orca_role = 'worker'");
  insert('review', '/repo', 99, "source = 'review'");
  insert('remote', '/repo', 99, "remote_host_id = 'ssh-host'");
  insert('device', '/repo', 99, "agent_device_id = 'other'");
  insert('bot', '/repo', 99);
  db.exec("INSERT INTO bot_session_links VALUES ('link', 'bot')");
  mocks.phases.set('recent', { phase: 'running', attention: false });
  mocks.phases.set('worktree', { phase: 'needs-interaction', attention: true });

  const tasks = await listPluginObserveTasks('/repo');

  expect(tasks).toEqual([
    { id: 'worktree', title: 'title worktree', agentKind: 'cc', archived: false, status: 'awaiting', lastActivityAt: 50 },
    { id: 'recent', title: 'title recent', agentKind: 'cc', archived: false, status: 'running', lastActivityAt: 30 },
    { id: 'archived', title: 'title archived', agentKind: 'cc', archived: true, status: 'idle', lastActivityAt: 20 },
  ]);
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
  expect(mocks.batchReaders).toEqual([['lead-done', 'lead-error', 'lead-remote', 'lead-wait', 'w-error', 'w-wait']]);
});

it('rejects unregistered or missing projects and opens only listable tasks', async () => {
  insert('task', '/repo', 1);
  insert('worker', '/repo', 1, "orca_role = 'worker'");
  insert('unregistered', '/elsewhere', 1);
  await expect(listPluginObserveTasks('/elsewhere')).rejects.toThrow('TARGET_UNAVAILABLE');
  await expect(listPluginObserveTasks('/gone')).rejects.toThrow('TARGET_UNAVAILABLE');
  await expect(assertPluginObservableTask('task')).resolves.toBeUndefined();
  await expect(assertPluginObservableTask('worker')).rejects.toThrow('TARGET_UNAVAILABLE');
  await expect(assertPluginObservableTask('unregistered')).rejects.toThrow('TARGET_UNAVAILABLE');
  await expect(assertPluginObservableTask('missing')).rejects.toThrow('TARGET_UNAVAILABLE');
});

it('fails closed when the account database changes during the read', async () => {
  insert('task', '/repo', 1);
  mocks.onRead = () => setCurrentDbClient({} as DbClient, 'other-user');
  await expect(listPluginObserveTasks('/repo')).rejects.toThrow('PERMISSION_DENIED');
});
