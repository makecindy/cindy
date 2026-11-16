import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sqlite: null as import('better-sqlite3').Database | null }));

vi.mock('electron', () => ({ app: { getPath: () => '/legacy-user-data' } }));
vi.mock('../../appSessionState.js', () => ({ ownerScopedUserDataPath: () => '/owner-root' }));
vi.mock('../../localDb/client/current.js', async () => {
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  return { getDbClient: () => ({ drizzle: drizzle(h.sqlite!) }) };
});

import { BotPlanWorkDirUnavailableError, prepareBotWorkspaceRuntime } from '../botWorkspaceRuntime.js';
import type { MakerSessionCreateOpts } from '../sessionRequest.js';

function opts(id: string): MakerSessionCreateOpts {
  return { id, workingDir: '/somewhere/else', workspaceKind: 'project', remoteHostId: 'remote-1' } as MakerSessionCreateOpts;
}

describe('prepareBotWorkspaceRuntime for 分工 Sessions', () => {
  const ensureWorkspaceDir = vi.fn(async () => '/owner-root/bots/mimi/workspace');
  const directories = new Set(['/work/site-wt']);
  const deps = { ensureWorkspaceDir, isDirectory: async (dir: string) => directories.has(dir) };

  beforeEach(() => {
    ensureWorkspaceDir.mockClear();
    h.sqlite = new Database(':memory:');
    h.sqlite.exec(`
      CREATE TABLE bot_session_links (
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, session_id TEXT NOT NULL, profile_version INTEGER,
        role TEXT NOT NULL, route_key TEXT, created_at INTEGER, archived_at INTEGER
      );
      CREATE TABLE bot_group_plans (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL, status TEXT NOT NULL, request_text TEXT NOT NULL,
        organizer_bot_id TEXT NOT NULL, organizer_name TEXT NOT NULL, current_step INTEGER,
        work_dir TEXT, branch TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO bot_group_plans VALUES
        ('p1', 'g1', 'running', 'x', 'mimi', '咪咪', 0, '/work/site-wt', 'cindy/a', 1, 1),
        ('p2', 'g1', 'running', 'x', 'mimi', '咪咪', 0, '/work/gone', NULL, 1, 1),
        ('p3', 'g1', 'proposed', 'x', 'mimi', '咪咪', NULL, NULL, NULL, 1, 1);
      INSERT INTO bot_session_links (id, bot_id, session_id, role, route_key) VALUES
        ('a', 'mimi', 'canonical', 'canonical', NULL),
        ('b', 'mimi', 'lane', 'group', 'group:g1'),
        ('c', 'mimi', 'step', 'group', 'group:g1:plan:p1'),
        ('d', 'mimi', 'step-gone', 'group', 'group:g1:plan:p2'),
        ('e', 'mimi', 'step-unstarted', 'group', 'group:g1:plan:p3'),
        ('f', 'mimi', 'step-wrong-group', 'group', 'group:g2:plan:p1'),
        ('g', 'v2', 'v2-main', 'canonical', NULL);
      CREATE TABLE bot_profiles (id TEXT PRIMARY KEY, current_version INTEGER NOT NULL);
      CREATE TABLE bot_profile_versions (bot_id TEXT NOT NULL, version INTEGER NOT NULL, capabilities_json TEXT NOT NULL);
      INSERT INTO bot_profiles VALUES ('mimi', 1), ('v2', 2);
      INSERT INTO bot_profile_versions VALUES ('mimi', 1, '{}'), ('v2', 1, '{}'), ('v2', 2, '{"projectMode":true}');
      CREATE TABLE sessions (id TEXT PRIMARY KEY, working_dir TEXT, workspace_kind TEXT, project_dir TEXT);
      INSERT INTO sessions VALUES ('v2-main', '/owner-root/bots/v2/workspace', 'dialogue', NULL);
    `);
  });

  afterEach(() => h.sqlite?.close());

  it('keeps Bot main Sessions and group lanes in the Home workspace', async () => {
    for (const id of ['canonical', 'lane']) {
      const o = opts(id);
      await prepareBotWorkspaceRuntime(o, deps);
      expect(o).toMatchObject({ workingDir: '/owner-root/bots/mimi/workspace', workspaceKind: 'dialogue', remoteHostId: undefined });
    }
  });

  it('runs a V2 teammate\'s chats as project sessions so the tasks they open stay in its project', async () => {
    const o = opts('v2-main');
    await prepareBotWorkspaceRuntime(o, deps);
    expect(o).toMatchObject({ workingDir: '/owner-root/bots/mimi/workspace', workspaceKind: 'project', projectDir: '/owner-root/bots/mimi/workspace' });
    expect(h.sqlite!.prepare('SELECT workspace_kind, project_dir FROM sessions WHERE id = ?').get('v2-main'))
      .toEqual({ workspace_kind: 'project', project_dir: '/owner-root/bots/mimi/workspace' });
  });

  it("runs a 分工 Session in its plan's recorded directory", async () => {
    const o = opts('step');
    await prepareBotWorkspaceRuntime(o, deps);
    expect(o).toMatchObject({ workingDir: '/work/site-wt', workspaceKind: 'project', remoteHostId: undefined });
    expect(ensureWorkspaceDir).not.toHaveBeenCalled();
  });

  it('fails instead of falling back to Home when the plan directory is unusable', async () => {
    for (const id of ['step-gone', 'step-unstarted', 'step-wrong-group']) {
      const o = opts(id);
      await expect(prepareBotWorkspaceRuntime(o, deps)).rejects.toBeInstanceOf(BotPlanWorkDirUnavailableError);
      expect(o.workingDir).toBe('/somewhere/else');
    }
  });

  it('leaves Sessions without a Bot link untouched', async () => {
    const o = opts('plain');
    await prepareBotWorkspaceRuntime(o, deps);
    expect(o).toMatchObject({ workingDir: '/somewhere/else', workspaceKind: 'project', remoteHostId: 'remote-1' });
  });
});
