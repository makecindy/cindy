import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../../localDb/client/current.js';
import { PluginTargetSlot, type PluginTargetAdapter } from '../../cindy-brain/pluginTargetSlot.js';

const fixtures = vi.hoisted(() => ({
  workdirs: [] as Array<{ path: string; exists: boolean }>,
  aliases: [] as Array<{ projectKey: string; alias: string }>,
  aliasError: null as Error | null,
}));
vi.mock('../../localDb/ipc/recentWorkdirs.js', () => ({ listRecentWorkdirs: async () => fixtures.workdirs }));
vi.mock('../../localDb/ipc/projectAliases.js', () => ({
  listProjectAliases: async () => {
    if (fixtures.aliasError) throw fixtures.aliasError;
    return fixtures.aliases;
  },
}));
import { listPluginTargetCandidates, resolvePluginSessionTarget, resolvePluginTargetSession } from '../pluginTargetCandidates.js';

// Unit: resolve({session}) must classify actual SQL registrations and apply the
// existing candidate filters. Slot tests fake the adapter and cannot detect a
// side conversation becoming a task or a stale canonical link becoming a bot.
// Kept separate for its real in-memory DB lifecycle; no Electron/production callback fixture.
let db: Database.Database;
const slot = new PluginTargetSlot();
beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, working_dir TEXT,
      status TEXT NOT NULL DEFAULT 'active', source TEXT NOT NULL DEFAULT 'desktop',
      orca_role TEXT, remote_host_id TEXT, agent_device_id TEXT, hidden_at INTEGER,
      user_send_at INTEGER, updated_at INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE bot_profiles (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active', hidden_at INTEGER
    );
    CREATE TABLE bot_session_links (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, session_id TEXT NOT NULL,
      role TEXT NOT NULL, archived_at INTEGER
    );
  `);
  slot.adapter = {
    candidates: listPluginTargetCandidates,
    targetForSession: resolvePluginSessionTarget,
    session: resolvePluginTargetSession,
  } as PluginTargetAdapter;
});
beforeEach(() => {
  db.exec('DELETE FROM bot_session_links; DELETE FROM bot_profiles; DELETE FROM sessions;');
  fixtures.workdirs = [];
  fixtures.aliases = [];
  fixtures.aliasError = null;
  setCurrentDbClient({ drizzle: drizzle(db) } as unknown as DbClient, 'test-owner');
});
afterAll(() => { clearCurrentDbClient(); db.close(); });
const resolve = (session: string) => slot.handle('plugin', { kind: 'resolve', session }, () => {});
const session = (id: string) => db.prepare('INSERT INTO sessions (id, title) VALUES (?, ?)').run(id, `Title ${id}`);
const bot = () => {
  session('main');
  db.exec(`INSERT INTO bot_profiles (id, display_name, description) VALUES ('bot', 'Partner', 'Description');
    UPDATE sessions SET source = 'bot' WHERE id = 'main';
    INSERT INTO bot_session_links VALUES ('main-link', 'bot', 'main', 'canonical', NULL);`);
};

it('returns current task metadata or the canonical companion ID rather than its session ID', async () => {
  session('ordinary');
  bot();
  expect(await resolve('ordinary')).toEqual({ kind: 'task', id: 'ordinary', label: 'Title ordinary', detail: '' });
  expect(await resolve('main')).toEqual({ kind: 'bot', id: 'bot', label: 'Partner', detail: 'Description' });
});

it.each(['history', 'delegation', 'group', 'channel', 'thread', 'routine'])('rejects a companion %s session', async role => {
  bot();
  session('side');
  db.prepare('INSERT INTO bot_session_links VALUES (?, ?, ?, ?, NULL)').run('side-link', 'bot', 'side', role);
  await expect(resolve('side')).rejects.toThrow('TARGET_UNAVAILABLE');
});

it.each([
  "UPDATE bot_session_links SET archived_at = 1",
  "UPDATE bot_profiles SET status = 'archived'",
  'UPDATE bot_profiles SET hidden_at = 1',
  "UPDATE sessions SET status = 'archived'",
  "UPDATE sessions SET remote_host_id = 'ssh'",
  "UPDATE sessions SET agent_device_id = 'other'",
  "INSERT INTO bot_session_links VALUES ('conflict', 'bot', 'missing', 'canonical', NULL)",
])('rejects unavailable or conflicting companion registrations: %s', async change => {
  bot();
  db.exec(change);
  await expect(resolve('main')).rejects.toThrow('TARGET_UNAVAILABLE');
});

it.each([
  "DELETE FROM sessions",
  "UPDATE sessions SET status = 'archived'",
  'UPDATE sessions SET hidden_at = 1',
  "UPDATE sessions SET remote_host_id = 'ssh'",
  "UPDATE sessions SET agent_device_id = 'other'",
  "UPDATE sessions SET orca_role = 'worker'",
  "UPDATE sessions SET source = 'review'",
  "UPDATE sessions SET source = 'bot'",
])('keeps the existing task availability boundary: %s', async change => {
  session('ordinary');
  db.exec(change);
  await expect(resolve('ordinary')).rejects.toThrow('TARGET_UNAVAILABLE');
});

// The sidebar names a project with the user's alias; a plugin must show the same name.
it('names a project the way the sidebar does and keeps the alias for plugins', async () => {
  fixtures.workdirs = [{ path: '/work/repo', exists: true }, { path: '/work/plain', exists: true }];
  fixtures.aliases = [
    { projectKey: 'local:/work/repo', alias: 'My Project' },
    { projectKey: 'local:/work/other', alias: 'Other Project' },
  ];
  const result = await slot.handle('plugin', { kind: 'list', targetKind: 'project' }, () => {});
  expect(result).toEqual({ targets: [
    { kind: 'project', id: '/work/repo', label: 'My Project', detail: '/work/repo', alias: 'My Project' },
    { kind: 'project', id: '/work/plain', label: 'plain', detail: '/work/plain' },
  ] });
});

// Losing the names must never lose the projects: an unreadable alias table degrades
// to directory names instead of failing the whole candidate list.
it('falls back to the directory name when project aliases cannot be read', async () => {
  fixtures.workdirs = [{ path: '/work/repo', exists: true }];
  fixtures.aliasError = new Error('project aliases unavailable');
  expect(await listPluginTargetCandidates('project')).toEqual([
    { id: '/work/repo', label: 'repo', detail: '/work/repo' },
  ]);
});
