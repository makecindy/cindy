import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { botProfileDir } from '../botProfileFolder.js';
import { scanAtBuddyFiles } from '../atBuddyFiles.js';

const fixture = vi.hoisted(() => ({
  root: '', owner: 'owner-a', pending: false,
  db: null as { client: { drizzle: ReturnType<typeof drizzle> } } | null,
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => fixture.owner,
  getActiveAppSession: () => ({ dataOwnerId: fixture.owner }),
  isAppSessionBoundaryPending: () => fixture.pending,
  ownerScopedUserDataPath: (...parts: string[]) => path.join(fixture.root, 'owners', fixture.owner, ...parts),
}));
vi.mock('../../localDb/client/current.js', () => ({
  getCurrentDbClientSnapshot: () => fixture.db,
  getDbClient: () => fixture.db?.client,
}));

// #11110: exercise the production Main search with actual linked/referenced disk roots
// and current-owner SQLite rows. Previous scan only saw the buddy workspace, and a renderer
// test cannot prove that remote or unlinked folders remain outside the query. Tier: unit.
describe('scanAtBuddyFiles', () => {
  let sqlite: Database.Database;
  let workspace: string;
  beforeEach(async () => {
    fixture.owner = 'owner-a';
    fixture.pending = false;
    fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-buddy-at-'));
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, working_dir TEXT, source TEXT, status TEXT, remote_host_id TEXT, agent_device_id TEXT, extra_dirs TEXT);
      CREATE TABLE bot_profiles (id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE bot_session_links (bot_id TEXT, session_id TEXT, role TEXT, archived_at INTEGER);
      INSERT INTO bot_profiles VALUES ('buddy-a', 'active');
      INSERT INTO bot_session_links VALUES ('buddy-a', 'local-buddy', 'canonical', NULL);
    `);
    fixture.db = { client: { drizzle: drizzle(sqlite) } };
    workspace = path.join(botProfileDir(path.join(fixture.root, 'owners', fixture.owner), 'buddy-a'), 'workspace');
    await fs.mkdir(workspace, { recursive: true });
  });
  afterEach(async () => {
    fixture.db = null;
    sqlite.close();
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  function session(extraDirs: string[] = []) {
    sqlite.prepare(`INSERT INTO sessions VALUES (?, ?, 'bot', 'active', NULL, NULL, ?)`).run('local-buddy', workspace, JSON.stringify(extraDirs));
  }

  function search(workingDir = workspace, sessionId = 'local-buddy') {
    return scanAtBuddyFiles({ sessionId, workingDir, query: 'report' }, new AbortController().signal);
  }

  it('returns the current reports from saved local roots and excludes other devices, symlinks and the workspace', async () => {
    const linked = path.join(fixture.root, 'linked');
    const reference = path.join(fixture.root, 'reference');
    const remote = path.join(fixture.root, 'remote');
    const sensitive = path.join(fixture.root, '.ssh');
    const otherOwner = path.join(fixture.root, 'owners', 'owner-b');
    for (const dir of [linked, reference, remote, sensitive, otherOwner]) {
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, 'report.md'), dir);
    }
    await fs.writeFile(path.join(workspace, 'report.md'), 'old backup');
    const alias = path.join(fixture.root, 'alias');
    await fs.symlink(sensitive, alias, 'junction');
    session([reference, otherOwner]);
    const workbench = path.join(path.dirname(workspace), 'workbench.json');
    await fs.writeFile(workbench, JSON.stringify({ directories: [
      { path: linked }, { path: remote, deviceId: 'other-device' }, { path: alias }, { path: workspace },
    ] }));
    const result = await search();
    expect(result.items.map(({ relPath, sourceLabel, sourceRelativePath }) => ({ relPath, sourceLabel, sourceRelativePath }))).toEqual([
      { relPath: path.join(linked, 'report.md'), sourceLabel: 'linked', sourceRelativePath: 'report.md' },
      { relPath: path.join(reference, 'report.md'), sourceLabel: 'reference', sourceRelativePath: 'report.md' },
    ]);
    await fs.writeFile(workbench, JSON.stringify({ directories: [] }));
    expect((await search()).items.map(item => item.relPath)).toEqual([path.join(reference, 'report.md')]);
  });

  it('requires the persisted local buddy binding and stops at an account boundary', async () => {
    const reference = path.join(fixture.root, 'reference');
    await fs.mkdir(reference);
    await fs.writeFile(path.join(reference, 'report.md'), 'current');
    session([reference]);
    expect(await search(reference)).toEqual({ items: [], truncated: false });
    expect(await search(workspace, 'other-session')).toEqual({ items: [], truncated: false });
    sqlite.exec(`UPDATE sessions SET agent_device_id = 'other-device'`);
    expect(await search()).toEqual({ items: [], truncated: false });
    sqlite.exec(`UPDATE sessions SET agent_device_id = NULL`);
    fixture.pending = true;
    expect(await search()).toEqual({ items: [], truncated: false });
  });
});
