import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Windows 全量并发时，初始化临时 Git 仓库可能超过 Vitest 默认的 5 秒预算。
vi.setConfig({ testTimeout: 30_000 });

import {
  ensureProjectGitInitialized,
  shouldBootstrapProjectGit,
} from '../git-snapshot/projectGitBootstrap';
import { parseSnapshotCommit } from '../git-snapshot/snapshotTrailers';
import { gitExec } from '../worktree/gitExec';

// Full-suite concurrency makes Windows Git process startup substantially slower.
vi.setConfig({ testTimeout: process.platform === 'win32' ? 30_000 : 5_000 });

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'xdt-project-git-bootstrap-')),
  );
  tempDirs.push(dir);
  return dir;
}

/** Replaces host-level Git configuration with empty test-local files. */
async function stubIsolatedGitConfig(): Promise<void> {
  const configDir = await makeTempDir();
  const globalConfig = path.join(configDir, 'global.gitconfig');
  const systemConfig = path.join(configDir, 'system.gitconfig');
  await Promise.all([fs.writeFile(globalConfig, ''), fs.writeFile(systemConfig, '')]);

  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
  vi.stubEnv('GIT_CONFIG_SYSTEM', systemConfig);
  vi.stubEnv('GIT_CONFIG_COUNT', '0');
}

async function isGitRepo(dir: string): Promise<boolean> {
  return gitExec(['rev-parse', '--is-inside-work-tree'], dir).then(
    (result) => result.stdout.trim() === 'true',
    () => false,
  );
}

async function headMessage(dir: string): Promise<string> {
  return (await gitExec(['log', '-1', '--format=%B'], dir)).stdout;
}

async function headChangedFiles(dir: string): Promise<string[]> {
  return (await gitExec(['show', '--name-only', '--format=', 'HEAD'], dir)).stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

beforeEach(async () => {
  await stubIsolatedGitConfig();
  vi.stubEnv('GIT_AUTHOR_NAME', 'XDT Test');
  vi.stubEnv('GIT_AUTHOR_EMAIL', 'test@xdt.local');
  vi.stubEnv('GIT_COMMITTER_NAME', 'XDT Test');
  vi.stubEnv('GIT_COMMITTER_EMAIL', 'test@xdt.local');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('projectGitBootstrap', () => {
  it('only considers local project workspaces bootstrap candidates', () => {
    const workingDir = path.resolve('project');
    expect(
      shouldBootstrapProjectGit({
        workingDir,
        workspaceKind: 'local',
        autoSnapshotEnabled: true,
      }),
    ).toBe(true);
    expect(shouldBootstrapProjectGit({ workingDir, workspaceKind: 'local' })).toBe(false);
    expect(
      shouldBootstrapProjectGit({
        workingDir,
        workspaceKind: 'dialogue',
        autoSnapshotEnabled: true,
      }),
    ).toBe(false);
    expect(
      shouldBootstrapProjectGit({
        workingDir,
        remoteHostId: 'remote-1',
        autoSnapshotEnabled: true,
      }),
    ).toBe(false);
    expect(
      shouldBootstrapProjectGit({
        workingDir: '   ',
        autoSnapshotEnabled: true,
      }),
    ).toBe(false);
  });

  it('does not initialize projects until Git safety snapshots are enabled', async () => {
    const dir = await makeTempDir();

    const result = await ensureProjectGitInitialized({
      workingDir: dir,
      workspaceKind: 'local',
      autoSnapshotEnabled: false,
    });

    expect(result).toMatchObject({ status: 'skipped', reason: 'git-safety-disabled' });
    expect(await isGitRepo(dir)).toBe(false);
  });

  it('initializes an empty local project and creates an empty XDT savepoint commit', async () => {
    const dir = await makeTempDir();

    const result = await ensureProjectGitInitialized({
      workingDir: dir,
      workspaceKind: 'local',
      sessionId: 'session-1',
      autoSnapshotEnabled: true,
      source: 'test',
    });

    expect(result.status).toBe('initialized');
    expect(result.repoRoot).toBe(path.resolve(dir));
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(await isGitRepo(dir)).toBe(true);
    expect(parseSnapshotCommit(await headMessage(dir))).toMatchObject({
      label: 'Initialize project snapshot',
      sessionId: 'session-1',
      kind: 'manual',
    });
    expect(await headChangedFiles(dir)).toEqual([]);
  });

  it('treats OS metadata files as still empty enough for automatic initialization', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, '.DS_Store'), '');

    const result = await ensureProjectGitInitialized({
      workingDir: dir,
      workspaceKind: 'local',
      autoSnapshotEnabled: true,
    });

    expect(result.status).toBe('initialized');
    expect(await isGitRepo(dir)).toBe(true);
    expect(await headChangedFiles(dir)).toEqual([]);
    expect(result.includedFiles).toEqual([]);
    expect(result.skippedFiles).toEqual([
      expect.objectContaining({ path: '.DS_Store', reason: 'ignored-os-metadata' }),
    ]);
  });

  it('treats empty nested folders as still empty enough for automatic initialization', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, 'src', 'components'), { recursive: true });

    const result = await ensureProjectGitInitialized({
      workingDir: dir,
      workspaceKind: 'local',
      autoSnapshotEnabled: true,
    });

    expect(result.status).toBe('initialized');
    expect(await isGitRepo(dir)).toBe(true);
    expect(await headChangedFiles(dir)).toEqual([]);
  });

  it('leaves nested trackable files untouched in non-Git project folders', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(dir, 'src', 'index.ts'), 'export {};\n');

    const result = await ensureProjectGitInitialized({
      workingDir: dir,
      workspaceKind: 'local',
      autoSnapshotEnabled: true,
    });

    expect(result).toMatchObject({ status: 'skipped', reason: 'non-empty-project' });
    expect(await isGitRepo(dir)).toBe(false);
  });

  it('leaves non-empty non-Git project folders untouched', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'README.md'), '# Project\n');

    const result = await ensureProjectGitInitialized({
      workingDir: dir,
      workspaceKind: 'local',
      autoSnapshotEnabled: true,
    });

    expect(result).toMatchObject({ status: 'skipped', reason: 'non-empty-project' });
    expect(await isGitRepo(dir)).toBe(false);
  });

  it('does not reinitialize folders that are already Git repositories', async () => {
    const dir = await makeTempDir();
    await gitExec(['init'], dir);

    const result = await ensureProjectGitInitialized({
      workingDir: dir,
      workspaceKind: 'local',
      autoSnapshotEnabled: true,
    });

    expect(result.status).toBe('already-git');
    expect(path.resolve(result.repoRoot ?? '')).toBe(path.resolve(dir));
  });
});
