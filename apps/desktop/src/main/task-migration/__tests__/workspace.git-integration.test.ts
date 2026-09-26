import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

vi.mock('../../worktree/recoveryArchiveWorkerClient', async () => ({
  runRecoveryArchiveTask: (await import('../../worktree/recoveryArchiveTask'))
    .executeRecoveryArchiveTask,
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));
const state = vi.hoisted(() => ({ root: '' }));
vi.mock('../../worktree/gitExec', async (original) => {
  const actual = await original<typeof import('../../worktree/gitExec')>();
  return {
    ...actual,
    gitExec: (
      args: string[],
      cwd: string,
      options?: import('../../worktree/gitExec').GitExecOpts,
    ) =>
      actual.gitExec(args, cwd, {
        ...options,
        extraEnv: {
          ...options?.extraEnv,
          GIT_CONFIG_GLOBAL: path.join(state.root, 'git-global'),
          GIT_CONFIG_NOSYSTEM: '1',
        },
      }),
  };
});
import { snapshotWorkspace, restoreWorkspace, validateWorkspaceEntries } from '../workspace';
import { inventoryWorktree } from '../../worktree/recoveryArchiveIO';

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (
    await exec('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: path.join(state.root, 'git-global'),
        GIT_CONFIG_NOSYSTEM: '1',
      },
    })
  ).stdout;
describe('cross-machine project snapshots', () => {
  let source: string, target: string, artifacts: string;
  beforeEach(async () => {
    state.root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-migration-test-')),
    );
    source = path.join(state.root, 'source');
    target = path.join(state.root, 'target');
    artifacts = path.join(state.root, 'artifacts');
    await Promise.all([source, target, artifacts].map((p) => fs.mkdir(p)));
  });
  afterEach(async () => {
    await fs.rm(state.root, { recursive: true, force: true });
  });

  it('copies ordinary directory bytes without consuming the shared source', async () => {
    await fs.mkdir(path.join(source, 'ignored'));
    await fs.writeFile(path.join(source, 'ignored', 'local.env'), 'not tracked\n');
    await fs.writeFile(path.join(source, 'draft'), 'uncommitted\n');
    const before = await inventoryWorktree(source);
    const snapshot = await snapshotWorkspace(source, artifacts, randomUUID());
    await restoreWorkspace(snapshot, artifacts, target);
    expect(await inventoryWorktree(target)).toEqual(before);
    expect(await inventoryWorktree(source)).toEqual(before);
    await fs.writeFile(path.join(target, 'draft'), 'new machine edit');
    expect(await fs.readFile(path.join(source, 'draft'), 'utf8')).toBe('uncommitted\n');
  });
  it('restores linked worktrees with HEAD, staged changes, unstaged changes and ignored files intact', async () => {
    await git(source, 'init', '-b', 'main');
    await git(source, 'config', 'user.name', 'Migration test');
    await git(source, 'config', 'user.email', 'migration@localhost');
    await fs.writeFile(path.join(source, 'tracked'), 'base\n');
    await fs.writeFile(path.join(source, '.gitignore'), 'ignored\n');
    await git(source, 'add', '.');
    await git(source, 'commit', '-m', 'fixture');
    const linked = path.join(state.root, 'fork');
    await git(source, 'worktree', 'add', '-b', 'fork', linked);
    await fs.writeFile(path.join(linked, 'tracked'), 'staged\n');
    await git(linked, 'add', 'tracked');
    await fs.writeFile(path.join(linked, 'tracked'), 'unstaged\n');
    await fs.writeFile(path.join(linked, 'ignored'), 'local file\n');
    await fs.writeFile(path.join(linked, 'untracked'), 'draft\n');
    const before = await inventoryWorktree(linked);
    const staged = await git(linked, 'diff', '--cached');
    const unstaged = await git(linked, 'diff');
    const head = await git(linked, 'rev-parse', 'HEAD');
    const snapshot = await snapshotWorkspace(linked, artifacts, randomUUID());
    await restoreWorkspace(snapshot, artifacts, target);
    expect(await git(target, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(target, 'symbolic-ref', 'HEAD')).toBe('refs/heads/fork\n');
    expect(await git(target, 'diff', '--cached')).toBe(staged);
    expect(await git(target, 'diff')).toBe(unstaged);
    expect((await fs.stat(path.join(target, '.git'))).isDirectory()).toBe(true);
    expect(await inventoryWorktree(target)).toEqual(before);
    expect(await inventoryWorktree(linked)).toEqual(before);
    expect(await git(linked, 'diff', '--cached')).toBe(staged);
    expect(await fs.readFile(path.join(source, 'tracked'), 'utf8')).toBe('base\n');
  }, 30_000);
  it('refuses to overwrite a destination directory', async () => {
    await fs.writeFile(path.join(source, 'source'), 'copy');
    const snapshot = await snapshotWorkspace(source, artifacts, randomUUID());
    await fs.writeFile(path.join(target, 'existing'), 'keep');
    await expect(restoreWorkspace(snapshot, artifacts, target)).rejects.toThrow(
      'MIGRATION_TARGET_NOT_EMPTY',
    );
    expect(await fs.readFile(path.join(target, 'existing'), 'utf8')).toBe('keep');
    expect(await fs.readFile(path.join(source, 'source'), 'utf8')).toBe('copy');
  });
  it('rejects corrupted archives before writing destination files', async () => {
    await fs.writeFile(path.join(source, 'source'), 'copy');
    const snapshot = await snapshotWorkspace(source, artifacts, randomUUID());
    const archivePath = path.join(artifacts, snapshot.archive.file);
    const bytes = await fs.readFile(archivePath);
    bytes[0] ^= 1;
    await fs.writeFile(archivePath, bytes);
    await expect(restoreWorkspace(snapshot, artifacts, target)).rejects.toThrow();
    expect(await fs.readdir(target)).toEqual([]);
    expect(await fs.readFile(path.join(source, 'source'), 'utf8')).toBe('copy');
  });
  it('handles empty project directories', async () => {
    const snapshot = await snapshotWorkspace(source, artifacts, randomUUID());
    await restoreWorkspace(snapshot, artifacts, target);
    expect(await fs.readdir(target)).toEqual([]);
  });
  it('rejects traversal, colliding names and external symlinks', () => {
    const file = { kind: 'file' as const, mode: 0o644, hash: 'a'.repeat(64) };
    for (const name of ['../escape', '/absolute', 'a/.git/config', 'a\\b', 'CON'])
      expect(() => validateWorkspaceEntries({ [name]: file })).toThrow();
    expect(() => validateWorkspaceEntries({ A: file, a: file })).toThrow(
      'MIGRATION_PATH_COLLISION',
    );
    expect(() =>
      validateWorkspaceEntries({ link: { kind: 'link', mode: 0o777, hash: '../outside' } }),
    ).toThrow('MIGRATION_EXTERNAL_LINK');
  });
});
