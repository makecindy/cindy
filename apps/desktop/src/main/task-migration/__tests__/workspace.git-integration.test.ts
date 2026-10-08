import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

vi.mock('../../worktree/recoveryArchiveWorkerClient', async () => {
  const { executeRecoveryArchiveTask } = await import('../../worktree/recoveryArchiveTask');
  return {
    runRecoveryArchiveTask: async (...args: Parameters<typeof executeRecoveryArchiveTask>) => {
      // Other tasks keep working in the source while its files are archived.
      if (args[0].operation === 'create') await state.duringArchive?.();
      return executeRecoveryArchiveTask(...args);
    },
  };
});
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));
const state = vi.hoisted(() => ({
  root: '',
  duringArchive: undefined as (() => Promise<void>) | undefined,
  /** Runs right after the capture publishes its snapshot ref, before its consistency check. */
  duringCapture: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('../../worktree/gitExec', async (original) => {
  const actual = await original<typeof import('../../worktree/gitExec')>();
  return {
    ...actual,
    gitExec: async (
      args: string[],
      cwd: string,
      options?: import('../../worktree/gitExec').GitExecOpts,
    ) => {
      const result = await actual.gitExec(args, cwd, {
        ...options,
        extraEnv: {
          ...options?.extraEnv,
          GIT_CONFIG_GLOBAL: path.join(state.root, 'git-global'),
          GIT_CONFIG_NOSYSTEM: '1',
        },
      });
      if (args[0] === 'update-ref' && args[1] !== '-d') await state.duringCapture?.();
      return result;
    },
  };
});
import {
  estimateWorkspace,
  snapshotWorkspace,
  restoreWorkspace,
  validateWorkspaceEntries,
  MigrationPathError,
} from '../workspace';
import { inventoryWorktree } from '../../worktree/recoveryArchiveIO';
import {
  captureWorktreeContent,
  WorktreeChangedDuringSnapshotError,
} from '../../worktree/contentSnapshot';

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
    state.duringArchive = undefined;
    state.duringCapture = undefined;
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
  it('copies link chains, dangling links and modes, leaving external links behind', async () => {
    // The CocoaPods / framework layout that used to block the whole copy.
    await fs.mkdir(path.join(source, 'Fw', 'Versions', 'A', 'Headers'), { recursive: true });
    await fs.writeFile(path.join(source, 'Fw', 'Versions', 'A', 'Headers', 'x.h'), 'x');
    await fs.symlink('A', path.join(source, 'Fw', 'Versions', 'Current'), 'dir');
    await fs.symlink('Versions/Current/Headers', path.join(source, 'Fw', 'Headers'), 'dir');
    await fs.mkdir(path.join(source, 'Pods'));
    await fs.symlink('../build/generated/gen.h', path.join(source, 'Pods', 'gen.h'));
    // Archived after the link it passes through, which tar alone refuses to extract.
    await fs.symlink('Fw/Versions', path.join(source, 'alias'), 'dir');
    await fs.symlink('alias/Current/Headers/x.h', path.join(source, 'via'));
    // Xcode leaves world-writable folders; the restore must not narrow them by the local umask.
    await fs.mkdir(path.join(source, 'shared'));
    await fs.writeFile(path.join(source, 'shared', 'open'), 'x');
    await fs.chmod(path.join(source, 'shared'), 0o777);
    await fs.chmod(path.join(source, 'shared', 'open'), 0o666);
    await fs.symlink('../outside', path.join(source, 'out'));
    const before = await inventoryWorktree(source);

    const snapshot = await snapshotWorkspace(source, artifacts, randomUUID());
    expect(snapshot.skipped).toEqual([{ path: 'out', code: 'MIGRATION_EXTERNAL_LINK' }]);
    await restoreWorkspace(snapshot, artifacts, target);

    const expected = { ...before };
    delete expected.out;
    expect({ ...(await inventoryWorktree(target)) }).toEqual(expected);
    expect(await fs.readFile(path.join(target, 'Fw', 'Headers', 'x.h'), 'utf8')).toBe('x');
    expect(await fs.readFile(path.join(target, 'via'), 'utf8')).toBe('x');
    expect(await fs.readlink(path.join(target, 'Pods', 'gen.h'))).toBe('../build/generated/gen.h');
  });
  // symlink-platform-skip: Windows cannot create a FIFO or a directory name ending in a space.
  it.skipIf(process.platform === 'win32')(
    'leaves special files and unportable names behind and reports them',
    async () => {
      await fs.writeFile(path.join(source, 'kept'), 'x');
      await fs.mkdir(path.join(source, 'trailing '));
      await fs.writeFile(path.join(source, 'trailing ', 'inner'), 'x');
      await fs.symlink('trailing /inner', path.join(source, 'into-skipped'));
      await exec('mkfifo', [path.join(source, 'pipe')]);

      const snapshot = await snapshotWorkspace(source, artifacts, randomUUID());
      expect([...snapshot.skipped].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
        { path: 'pipe', code: 'MIGRATION_UNSUPPORTED_ENTRY' },
        { path: 'trailing ', code: 'MIGRATION_NONPORTABLE_PATH' },
      ]);
      await restoreWorkspace(snapshot, artifacts, target);
      expect((await fs.readdir(target)).sort()).toEqual(['into-skipped', 'kept']);
    },
  );
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
    expect(await git(linked, 'for-each-ref', 'refs/cindy/migration')).toBe('');
    await restoreWorkspace(snapshot, artifacts, target);
    expect(await git(target, 'for-each-ref', 'refs/cindy/migration')).toBe('');
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
  it("leaves other tasks' registered worktrees behind but keeps user files beside them", async () => {
    await git(source, 'init', '-b', 'main');
    await git(source, 'config', 'user.name', 'Migration test');
    await git(source, 'config', 'user.email', 'migration@localhost');
    await fs.writeFile(path.join(source, 'draft'), 'mine\n');
    await git(source, 'add', 'draft');
    await git(source, 'commit', '-m', 'fixture');
    await git(
      source,
      'worktree',
      'add',
      '-b',
      'other',
      path.join('.cindy-worktrees', 'other-task'),
    );
    await fs.writeFile(path.join(source, '.cindy-worktrees', 'other-task', 'file'), 'not mine\n');
    await fs.mkdir(path.join(source, '.cindy-worktrees', 'notes'));
    await fs.writeFile(path.join(source, '.cindy-worktrees', 'notes', 'n'), 'mine too\n');
    const snapshot = await snapshotWorkspace(source, artifacts, randomUUID());
    expect(Object.keys(snapshot.archive.files).sort()).toEqual([
      '.cindy-worktrees',
      '.cindy-worktrees/notes',
      '.cindy-worktrees/notes/n',
      'draft',
    ]);
    await restoreWorkspace(snapshot, artifacts, target);
    expect(await fs.readFile(path.join(target, '.cindy-worktrees', 'notes', 'n'), 'utf8')).toBe(
      'mine too\n',
    );
    await expect(fs.stat(path.join(target, '.cindy-worktrees', 'other-task'))).rejects.toThrow();
    expect(
      await fs.readFile(path.join(source, '.cindy-worktrees', 'other-task', 'file'), 'utf8'),
    ).toBe('not mine\n');
  });
  it("counts only project content, not other tasks' registered worktrees", async () => {
    await fs.writeFile(path.join(source, 'a'), 'a');
    await fs.mkdir(path.join(source, '.cindy-worktrees', 'notes'), { recursive: true });
    await fs.writeFile(path.join(source, '.cindy-worktrees', 'notes', 'n'), 'xy');
    await fs.mkdir(path.join(source, '.xdt-worktrees', 'stale'), { recursive: true });
    await fs.writeFile(path.join(source, '.xdt-worktrees', 'stale', 'old'), 'zzz');
    // A plain directory excludes nothing, even with stray `.git` metadata at its root.
    await fs.mkdir(path.join(source, '.git'));
    expect(await estimateWorkspace(source, () => {})).toEqual({ fileCount: 3, bytes: 6 });
    await fs.rm(path.join(source, '.git'), { recursive: true });
    await git(source, 'init', '-b', 'main');
    await git(source, 'config', 'user.name', 'Migration test');
    await git(source, 'config', 'user.email', 'migration@localhost');
    await git(source, 'add', 'a');
    await git(source, 'commit', '-m', 'fixture');
    await git(
      source,
      'worktree',
      'add',
      '-b',
      'other',
      path.join('.cindy-worktrees', 'other-task'),
    );
    // Only the registered worktree is skipped; user folders beside it and an unregistered
    // folder in a managed container are still project content.
    expect(await estimateWorkspace(source, () => {})).toEqual({ fileCount: 3, bytes: 6 });
    // Deleted outside Git and its path reused for ordinary files: the stale (prunable)
    // registration must not hide them.
    const reused = path.join(source, '.cindy-worktrees', 'other-task');
    await fs.rm(reused, { recursive: true });
    await fs.mkdir(reused);
    await fs.writeFile(path.join(reused, 'r'), 'four');
    expect(await git(source, 'worktree', 'list', '--porcelain')).toContain('prunable');
    expect(await estimateWorkspace(source, () => {})).toEqual({ fileCount: 4, bytes: 10 });
  });
  it('keeps same-named folders of a plain directory', async () => {
    await fs.mkdir(path.join(source, '.cindy-worktrees'));
    await fs.writeFile(path.join(source, '.cindy-worktrees', 'notes'), 'user file\n');
    const before = await inventoryWorktree(source);
    const snapshot = await snapshotWorkspace(source, artifacts, randomUUID());
    await restoreWorkspace(snapshot, artifacts, target);
    expect(await inventoryWorktree(target)).toEqual(before);
    expect(Object.keys(before)).toContain(path.join('.cindy-worktrees', 'notes'));
  });
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
  it('tolerates an index rewrite that keeps staged content, but not a staging change', async () => {
    await git(source, 'init', '-b', 'main');
    await git(source, 'config', 'user.name', 'Migration test');
    await git(source, 'config', 'user.email', 'migration@localhost');
    await fs.writeFile(path.join(source, 'tracked'), 'base\n');
    await git(source, 'add', '.');
    await git(source, 'commit', '-m', 'fixture');
    const index = path.join(source, '.git', 'index');
    state.duringArchive = async () => {
      // A `git status` from another task refreshes stat data and rewrites the index bytes.
      const before = await fs.readFile(index);
      const later = new Date(Date.now() + 60_000);
      await fs.utimes(path.join(source, 'tracked'), later, later);
      await git(source, 'status', '--porcelain');
      expect((await fs.readFile(index)).equals(before)).toBe(false);
    };
    const snapshot = await snapshotWorkspace(source, artifacts, randomUUID());
    await restoreWorkspace(snapshot, artifacts, target);
    expect(await fs.readFile(path.join(target, 'tracked'), 'utf8')).toBe('base\n');

    await fs.rm(artifacts, { recursive: true });
    await fs.writeFile(path.join(source, 'tracked'), 'staged mid-copy\n');
    state.duringArchive = () => git(source, 'add', 'tracked').then(() => undefined);
    await expect(snapshotWorkspace(source, artifacts, randomUUID())).rejects.toThrow(
      'MIGRATION_WORKSPACE_CHANGED',
    );
    expect(await git(source, 'for-each-ref', 'refs/cindy/migration')).toBe('');
  }, 30_000);
  it('applies the same content rule while capturing, and keeps recycling byte-strict', async () => {
    await git(source, 'init', '-b', 'main');
    await git(source, 'config', 'user.name', 'Migration test');
    await git(source, 'config', 'user.email', 'migration@localhost');
    await fs.writeFile(path.join(source, 'tracked'), 'base\n');
    await git(source, 'add', '.');
    await git(source, 'commit', '-m', 'fixture');
    let later = Date.now();
    const refreshIndex = async () => {
      // `git status` from another task rewrites the index bytes without changing its content.
      later += 60_000;
      await fs.utimes(path.join(source, 'tracked'), new Date(later), new Date(later));
      await git(source, 'status', '--porcelain');
    };

    state.duringCapture = refreshIndex;
    await snapshotWorkspace(source, artifacts, randomUUID());
    // Recycling deletes worktrees, so its default capture stays conservative.
    await expect(
      captureWorktreeContent(source, 'refs/cindy/worktree-recovery/test'),
    ).rejects.toBeInstanceOf(WorktreeChangedDuringSnapshotError);
    await git(source, 'update-ref', '-d', 'refs/cindy/worktree-recovery/test');

    await fs.rm(artifacts, { recursive: true });
    await fs.writeFile(path.join(source, 'tracked'), 'staged mid-capture\n');
    state.duringCapture = () => git(source, 'add', 'tracked').then(() => undefined);
    await expect(snapshotWorkspace(source, artifacts, randomUUID())).rejects.toThrow(
      'MIGRATION_WORKSPACE_CHANGED',
    );
    expect(await git(source, 'for-each-ref', 'refs/cindy')).toBe('');
  }, 30_000);
  it('releases the source snapshot ref when bundle creation fails', async () => {
    await git(source, 'init', '-b', 'main');
    await git(source, 'config', 'user.name', 'Migration test');
    await git(source, 'config', 'user.email', 'migration@localhost');
    await fs.writeFile(path.join(source, 'tracked'), 'keep');
    await git(source, 'add', '.');
    await git(source, 'commit', '-m', 'fixture');
    await fs.mkdir(path.join(artifacts, 'repository.bundle'));
    await expect(snapshotWorkspace(source, artifacts, randomUUID())).rejects.toThrow();
    expect(await git(source, 'for-each-ref', 'refs/cindy/migration')).toBe('');
    expect(await fs.readFile(path.join(source, 'tracked'), 'utf8')).toBe('keep');
    expect(await git(source, 'status', '--porcelain')).toBe('');
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
  it('names the entry that blocks the copy', () => {
    const dir = { kind: 'directory' as const, mode: 0o755, hash: '' };
    const blamed = (files: Parameters<typeof validateWorkspaceEntries>[0]) => {
      try {
        validateWorkspaceEntries(files);
      } catch (error) {
        return error instanceof MigrationPathError ? [error.code, error.relPath] : error;
      }
    };
    // A Windows-style path once created as a relative folder by a macOS test run.
    expect(blamed({ apps: dir, 'apps/C:': dir })).toEqual([
      'MIGRATION_NONPORTABLE_PATH',
      'apps/C:',
    ]);
    expect(blamed({ A: dir, a: dir })).toEqual(['MIGRATION_PATH_COLLISION', 'a']);
    expect(blamed({ link: { kind: 'link', mode: 0o777, hash: '../outside' } })).toEqual([
      'MIGRATION_EXTERNAL_LINK',
      'link',
    ]);
  });
});
