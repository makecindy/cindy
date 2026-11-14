import path from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: null as ReturnType<typeof drizzle> | null }));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({ drizzle: h.db }),
}));

import { deriveAllowedSkillhubProjectRoots, listAllowedSkillhubProjectRoots } from '../allowedProjectRoots';

function storagePath(value: string): string {
  return path.resolve(value).replaceAll(path.sep, '/');
}

describe('deriveAllowedSkillhubProjectRoots', () => {
  it('allows both the grouped repo and real cwd of managed and conventional worktrees', () => {
    const repo = path.resolve('/repo');
    const normalizedRepo = repo.replaceAll(path.sep, '/');

    expect(deriveAllowedSkillhubProjectRoots([
      path.join(repo, '.cindy-worktrees', 'managed-task'),
      path.join(repo, '.worktrees', 'user-task'),
      repo,
      null,
    ])).toEqual([normalizedRepo, `${normalizedRepo}/.cindy-worktrees/managed-task`, `${normalizedRepo}/.worktrees/user-task`]);
  });
});

describe('listAllowedSkillhubProjectRoots', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'desktop',
      status TEXT NOT NULL DEFAULT 'active',
      workspace_kind TEXT NOT NULL DEFAULT 'project',
      project_dir TEXT,
      working_dir TEXT,
      remote_host_id TEXT
    )`);
    h.db = drizzle(db);
  });

  afterEach(() => {
    db.close();
    h.db = null;
  });

  function insertSession(input: {
    id: string;
    projectDir: string;
    workingDir?: string | null;
    source?: string;
    status?: string;
    workspaceKind?: string;
    remoteHostId?: string;
  }): void {
    db.prepare(`INSERT INTO sessions (
      id, source, status, workspace_kind, project_dir, working_dir, remote_host_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      input.id,
      input.source ?? 'desktop',
      input.status ?? 'active',
      input.workspaceKind ?? 'project',
      input.projectDir,
      input.workingDir === undefined ? input.projectDir : input.workingDir,
      input.remoteHostId ?? null,
    );
  }

  // Regression: the renderer groups by projectDir, so cwd-only grants rejected the whole scan.
  it('allows projectDir and workingDir case aliases of an active local project session', async () => {
    const projectDir = storagePath('/Users/example/AgentWork/cindy');
    const workingDir = storagePath('/Users/example/agentwork/cindy');
    insertSession({ id: 'case-alias', projectDir, workingDir });

    await expect(listAllowedSkillhubProjectRoots()).resolves.toEqual([projectDir, workingDir]);
  });

  it('allows an explicit projectDir alongside its distinct session workingDir', async () => {
    const projectDir = storagePath('/projects/explicit');
    const workingDir = storagePath('/worktrees/session-cwd');
    insertSession({ id: 'explicit-project', projectDir, workingDir });

    await expect(listAllowedSkillhubProjectRoots()).resolves.toEqual([projectDir, workingDir]);
  });

  it('keeps inactive, remote, invisible and dialogue roots rejected', async () => {
    insertSession({ id: 'archived', projectDir: storagePath('/rejected/archived'), status: 'archived' });
    insertSession({ id: 'remote', projectDir: storagePath('/rejected/remote'), remoteHostId: 'ssh-host' });
    insertSession({ id: 'bot', projectDir: storagePath('/rejected/bot'), source: 'bot' });
    insertSession({ id: 'dialogue', projectDir: storagePath('/rejected/dialogue'), workspaceKind: 'dialogue' });

    await expect(listAllowedSkillhubProjectRoots()).resolves.toEqual([]);
  });
});
