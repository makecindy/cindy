import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MakerSessionCreateOpts } from '../sessionRequest.js';

const state = vi.hoisted(() => ({ owner: {}, shadowed: false }));
let sqlite: Database.Database;
vi.mock('../../localDb/client/current.js', () => ({
  getCurrentDbClientSnapshot: () => state.owner, getDbClient: () => ({ drizzle: drizzle(sqlite) }),
}));
vi.mock('../../appSessionState.js', () => ({ isAppSessionBoundaryPending: () => false, ownerScopedUserDataPath: () => tmpdir() }));
vi.mock('../../companion-cloud/homes.js', () => ({ isCompanionShadowed: () => state.shadowed }));
vi.mock('../../device-link/sharedTaskDispatch.js', () => ({ isSessionSharedTaskActive: () => false }));

import { botProfileDir } from '../botProfileFolder.js';
import { hydrateProjectCompanion, verifyProjectCompanion } from '../projectTaskCompanion.js';

// Unit: resolve the actual task/profile join in SQLite. A local project task must use
// the saved partner identity, with its own route and project root, after reopening.
describe('project task conversation partner', () => {
  beforeEach(() => {
    state.shadowed = false;
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE sessions(id TEXT, status TEXT, source TEXT, workspace_kind TEXT, working_dir TEXT,
        cleared_at INTEGER, agent_kind TEXT, model TEXT, provider_id TEXT, remote_host_id TEXT, agent_device_id TEXT, orca_role TEXT);
      CREATE TABLE shared_task_events(session_id TEXT, shared_task_id TEXT, terminal INTEGER);
      CREATE TABLE project_task_companions(session_id TEXT, bot_id TEXT, revision INTEGER);
      CREATE TABLE bot_profiles(id TEXT, display_name TEXT, status TEXT, current_version INTEGER, description TEXT);
      CREATE TABLE bot_profile_versions(bot_id TEXT, version INTEGER, identity_source TEXT, capabilities_json TEXT);
      INSERT INTO sessions(id, status, source, workspace_kind, working_dir) VALUES ('task','active','desktop','project','project');
      INSERT INTO project_task_companions VALUES ('task','rain',1);
      INSERT INTO bot_profiles VALUES ('rain','小雨','active',3,'助手');
      INSERT INTO bot_profile_versions VALUES ('rain',3,'我是小雨。','{"memory":true,"userContextSource":"称呼我小林"}');
    `);
  });
  afterEach(() => sqlite.close());

  it.each(['claude-code', 'codex', 'pi'] as const)('hydrates the same local task on %s', async agentKind => {
    const opts = { agentKind, id: 'task', model: 'project-model', workingDir: 'project', permissionMode: 'ask' } as MakerSessionCreateOpts;
    await hydrateProjectCompanion(opts, 'task');
    expect(opts).toMatchObject({ id: 'task', workingDir: 'project', agentKind, model: 'project-model', permissionMode: 'ask',
      botProfilePrompt: '我是小雨。', botUserProfilePrompt: expect.stringContaining('小林'),
      projectCompanion: { botId: 'rain', displayName: '小雨', revision: 1, profileVersion: 3 } });
    expect(opts.botProfileContextPrompt).toContain('project_companion_memory');
    await expect(verifyProjectCompanion('task', opts.projectCompanion!)).resolves.toMatchObject({ memory: true });
    sqlite.exec("UPDATE project_task_companions SET bot_id = NULL, revision = 2");
    await expect(verifyProjectCompanion('task', opts.projectCompanion!)).rejects.toThrow();
    const next = { agentKind, id: 'task' } as MakerSessionCreateOpts;
    await hydrateProjectCompanion(next, 'task');
    expect(next.projectCompanion).toBeUndefined();
  });

  it('uses only one memory source when the task is in the partner’s own project', async () => {
    sqlite.exec(`UPDATE bot_profile_versions SET capabilities_json = '{"projectMode":true,"memory":true}'`);
    const opts = { id: 'task', workingDir: path.join(botProfileDir(tmpdir(), 'rain'), 'workspace'),
      makerMemoryEnabled: true } as MakerSessionCreateOpts;
    await hydrateProjectCompanion(opts, 'task');
    expect(opts.botProfileContextPrompt).toContain('share this store');
    expect(opts.botProfileContextPrompt).not.toContain('project_companion_memory');
    sqlite.exec(`UPDATE bot_profile_versions SET capabilities_json = '{"memory":false}'`);
    await hydrateProjectCompanion(opts, 'task');
    expect(opts.botProfileContextPrompt).not.toContain('companion notes');
    expect((await verifyProjectCompanion('task', opts.projectCompanion!)).memory).toBe(false);
  });

  it('rejects shared, paused and moved partners before loading their identity', async () => {
    const opts = { id: 'task' } as MakerSessionCreateOpts;
    await expect(hydrateProjectCompanion({ ...opts, agentKind: 'acp' }, 'task')).rejects.toThrow(/PRECONDITION_FAILED/);
    sqlite.exec("INSERT INTO shared_task_events VALUES ('task','shared',0)");
    await expect(hydrateProjectCompanion(opts, 'task')).rejects.toThrow();
    sqlite.exec("INSERT INTO shared_task_events VALUES ('task','shared',1); UPDATE bot_profiles SET status = 'paused'");
    await expect(hydrateProjectCompanion(opts, 'task')).rejects.toThrow();
    sqlite.exec("UPDATE bot_profiles SET status = 'active'");
    state.shadowed = true;
    await expect(hydrateProjectCompanion(opts, 'task')).rejects.toThrow();
    expect(opts.projectCompanion).toBeUndefined();
  });
});
