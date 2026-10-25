// These suites exercise real archive I/O in Node; Electron worker isolation is covered separately.
vi.mock('../worktree/recoveryArchiveWorkerClient', async () => {
  const { executeRecoveryArchiveTask } = await import('../worktree/recoveryArchiveTask');
  return { runRecoveryArchiveTask: executeRecoveryArchiveTask };
});
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorktreeMeta } from '../worktree/types';

const state = vi.hoisted(() => ({ root: '', refs: [] as unknown[], registry: new Map<string, WorktreeMeta>() }));
const managerMocks = vi.hoisted(() => ({ copy: vi.fn(), create: vi.fn() }));
vi.mock('../worktree/WorktreeManager', () => ({
  copyClaudeSiviDirs: managerMocks.copy,
  createWorktree: managerMocks.create,
  resolveAvailableWorktreeName: async (_repo: string, name: string) => name,
}));
vi.mock('electron', () => ({
  app: { getPath: () => state.root },
  safeStorage: { encryptString: (text: string) => Buffer.from(text), decryptString: (bytes: Buffer) => bytes.toString() },
}));
vi.mock('../worktree/worktreeStore', () => ({
  get: (id: string) => state.registry.get(id) ?? null,
  getAll: () => [...state.registry.values()], getAllPaths: () => [...state.registry.values()].map((m) => m.path),
  set: async (id: string, meta: WorktreeMeta) => { state.registry.set(id, meta); },
  del: async (id: string) => { state.registry.delete(id); },
}));
vi.mock('../localDb/client/current', () => ({ getDbClient: () => ({ readLocalWorktreeReferences: async () => state.refs }) }));
vi.mock('../worktree/runtimeLeases', async (original) => ({
  ...await original<typeof import('../worktree/runtimeLeases')>(),
  // Model an old owner profile that cannot see the borrower's shared leases.
  readWorktreeRuntimePaths: async () => new Set(),
}));
vi.mock('../worktree/gitExec', async (original) => {
  const actual = await original<typeof import('../worktree/gitExec')>();
  return { ...actual, gitExec: vi.fn<typeof actual.gitExec>((args, cwd, options) => actual.gitExec(args, cwd, {
    ...options, extraEnv: { ...options?.extraEnv, GIT_CONFIG_GLOBAL: path.join(state.root, 'git-global'), GIT_CONFIG_NOSYSTEM: '1' },
  })) };
});

import { checkpointWorktreeForReuse, recycleManagedWorktree } from '../worktree/managedRecycle';
import { restoreRecordedWorktree } from '../worktree/restoreRecovery';
import { newRecycleRecord, readRecycleRecord, writeRecycleRecord } from '../worktree/recycleJournal';
import { releaseObsoleteRecoverySnapshots } from '../worktree/recycleMaintenance';
import { captureWorktreeContent, worktreeContentMatches } from '../worktree/contentSnapshot';
import { GitExecError, gitExec } from '../worktree/gitExec';
import { acquireWorktree, releaseWorktree, parkAll } from '../worktree/WorktreePool';
import { createRecoveryArchive } from '../worktree/recoveryArchive';
import { physicalWorktreeKey, worktreeResourceId } from '../worktree/resourceLock';
import { releaseWorktreeRuntimeLease } from '../worktree/runtimeLeases';
import { seedLegacySharedRuntimeLease } from './fixtures/legacySharedRuntimeLease';

const exec = promisify(execFile);
describe('worktree recovery with real Git', () => {
  let repo: string;
  const git = async (cwd: string, ...args: string[]) => (await exec('git', args, {
    cwd, windowsHide: true, env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(state.root, 'git-global'), GIT_CONFIG_NOSYSTEM: '1' },
  })).stdout.trim();
  beforeAll(async () => {
    state.root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-recovery-git-')));
    repo = path.join(state.root, 'repo');
    await fs.mkdir(repo);
    await git(repo, 'init', '-b', 'main');
    await git(repo, 'config', 'user.name', 'Recovery Test');
    await git(repo, 'config', 'user.email', 'recovery-test@localhost');
    await git(repo, 'config', 'core.autocrlf', 'false');
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'base\n');
    await fs.writeFile(path.join(repo, '.gitignore'), '.env\nignored/\n');
    await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'fixture');
  });
  afterAll(async () => { await fs.rm(state.root, { recursive: true, force: true }); });

  const createFixture = async (name: string) => {
    const worktree = path.join(repo, '.cindy-worktrees', name);
    await git(repo, 'worktree', 'add', '-b', `cindy/${name}`, worktree, 'main');
    await fs.writeFile(path.join(worktree, 'draft.txt'), `${name} contents\n`);
    const meta: WorktreeMeta = { sessionId: name, generation: `${name}-generation`, name, path: worktree, baseRepo: repo, branch: `cindy/${name}`, sourceBranch: 'main', createdAt: '2026-09-08T00:00:00Z' };
    state.registry.set(name, meta);
    state.refs.push({ id: name, status: 'archived', source: 'desktop', currentDatabase: true, workingDir: worktree, worktreePath: worktree });
    return meta;
  };

  it('preserves a legacy borrowed source after build scripts clean the worktree', async () => {
    const meta = await createFixture('borrowed-clean');
    const gitDir = await git(meta.path, 'rev-parse', '--absolute-git-dir');
    const lease = await seedLegacySharedRuntimeLease(state.root, meta.path, path.join(gitDir, 'locked'));
    try {
      await git(meta.path, 'clean', '-fdx');
      await expect(fs.stat(path.join(meta.path, 'draft.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      // Old pool reuse and deletion must both stop before changing source.
      await expect(checkpointWorktreeForReuse(meta)).rejects.toThrow('worktree is locked');
      expect(await recycleManagedWorktree(meta, { canRemove: async () => true })).toBe(false);
      await expect(git(repo, 'worktree', 'remove', '--force', meta.path)).rejects.toThrow();
      expect(await fs.readFile(path.join(meta.path, 'tracked.txt'), 'utf8')).toBe('base\n');
      await releaseWorktreeRuntimeLease(lease);
      expect(await recycleManagedWorktree(meta, { canRemove: async () => true })).toBe(true);
    } finally { await releaseWorktreeRuntimeLease(lease); }
  }, 30_000);

  it('restores detached HEAD, staged-only bytes, unstaged and untracked files without keeping ignored files', async () => {
    const worktree = path.join(repo, '.cindy-worktrees', 'recover');
    await git(repo, 'worktree', 'add', '-b', 'cindy/recover', worktree, 'main');
    await git(worktree, 'checkout', '--detach');
    const head = await git(worktree, 'rev-parse', 'HEAD');
    await fs.writeFile(path.join(worktree, 'tracked.txt'), 'staged\n');
    await git(worktree, 'add', 'tracked.txt');
    await fs.writeFile(path.join(worktree, 'tracked.txt'), 'unstaged\n');
    await fs.writeFile(path.join(worktree, '.env'), 'INVALID_TEST_SECRET=keep-me\n');
    await fs.writeFile(path.join(worktree, 'untracked.txt'), 'untracked content\n');
    await fs.mkdir(path.join(worktree, 'ignored'));
    await fs.writeFile(path.join(worktree, 'ignored', 'data.bin'), Buffer.from([0, 255, 10, 48]));
    const meta: WorktreeMeta = { sessionId: 'recover', generation: 'generation-one', name: 'recover', path: worktree, baseRepo: repo, branch: 'cindy/recover', sourceBranch: 'main', createdAt: '2026-09-08T00:00:00Z' };
    state.registry.set(meta.sessionId, meta);
    state.refs = [{ id: meta.sessionId, status: 'archived', source: 'desktop', currentDatabase: true, workingDir: worktree, worktreePath: worktree }];
    const recycled = await recycleManagedWorktree(meta, { canRemove: async () => true });
    expect(recycled, JSON.stringify(await readRecycleRecord(worktree))).toBe(true);
    await expect(fs.stat(worktree)).rejects.toMatchObject({ code: 'ENOENT' });
    const record = await readRecycleRecord(worktree);
    expect(record?.snapshot?.head).toBe(head);
    expect(record?.archive).toBeUndefined();
    expect((await fs.readdir(path.join(state.root, 'worktree-recycle'))).filter((name) => name.endsWith('.enc'))).toEqual([]);
    const savedTree = await git(repo, 'ls-tree', '-r', '--name-only', record!.snapshot!.commit);
    expect(savedTree).not.toContain('.env');
    expect(savedTree).not.toContain('ignored/');
    expect(savedTree).toContain('untracked.txt');
    expect(await restoreRecordedWorktree(meta.sessionId, worktree)).toBe(true);
    expect(await git(worktree, 'rev-parse', 'HEAD')).toBe(head);
    await expect(git(worktree, 'symbolic-ref', '--quiet', 'HEAD')).rejects.toThrow();
    expect(await git(worktree, 'show', ':tracked.txt')).toBe('staged');
    expect(await fs.readFile(path.join(worktree, 'tracked.txt'), 'utf8')).toBe('unstaged\n');
    expect(await fs.readFile(path.join(worktree, 'untracked.txt'), 'utf8')).toBe('untracked content\n');
    // Ignored files are regenerable (dependencies, build output) and are not kept.
    await expect(fs.stat(path.join(worktree, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(worktree, 'ignored'))).rejects.toMatchObject({ code: 'ENOENT' });
    const status = await git(worktree, 'status', '--porcelain');
    expect(status).toContain('MM tracked.txt');
    expect(status).toContain('?? untracked.txt');
    expect((await readRecycleRecord(worktree))?.phase).toBe('restored');
  }, 60_000);

  it('restores an attached branch and advances it with subsequent commits', async () => {
    const meta = await createFixture('attached');
    expect(await recycleManagedWorktree(meta, { canRemove: async () => true })).toBe(true);
    expect((await readRecycleRecord(meta.path))?.snapshot?.headRef).toBe('refs/heads/cindy/attached');
    expect(await restoreRecordedWorktree(meta.sessionId, meta.path)).toBe(true);
    expect(await git(meta.path, 'symbolic-ref', 'HEAD')).toBe('refs/heads/cindy/attached');
    await git(meta.path, 'add', 'draft.txt');
    await git(meta.path, 'commit', '-m', 'continue restored work');
    expect(await git(repo, 'rev-parse', 'cindy/attached')).toBe(await git(meta.path, 'rev-parse', 'HEAD'));
  }, 30_000);

  it('deletes nested repositories instead of waiting on them and restores only saved files', async () => {
    const meta = await createFixture('nested');
    const cloned = path.join(meta.path, 'vendor', 'cloned');
    await fs.mkdir(cloned, { recursive: true });
    await git(cloned, 'init', '-b', 'main');
    await fs.writeFile(path.join(cloned, 'lib.txt'), 'nested\n');
    await git(cloned, 'add', 'lib.txt');
    await git(cloned, '-c', 'user.name=Nested', '-c', 'user.email=nested@localhost', 'commit', '-m', 'nested');
    // A plain file beside the nested repository is ordinary new content and must be saved.
    await fs.writeFile(path.join(meta.path, 'vendor', 'notes.txt'), 'beside the clone\n');
    // A repository without a commit makes a plain `git add --all` fail outright.
    const scaffold = path.join(meta.path, 'scaffold');
    await fs.mkdir(scaffold);
    await git(scaffold, 'init');
    await fs.writeFile(path.join(scaffold, 'app.txt'), 'generated\n');
    expect(await recycleManagedWorktree(meta, { canRemove: async () => true })).toBe(true);
    await expect(fs.stat(meta.path)).rejects.toMatchObject({ code: 'ENOENT' });
    const record = (await readRecycleRecord(meta.path))!;
    const savedTree = await git(repo, 'ls-tree', '-r', '--name-only', record.snapshot!.commit);
    expect(savedTree.split('\n')).toEqual(expect.arrayContaining(['draft.txt', 'vendor/notes.txt']));
    expect(savedTree).not.toContain('vendor/cloned');
    expect(savedTree).not.toContain('scaffold');
    expect(await restoreRecordedWorktree(meta.sessionId, meta.path)).toBe(true);
    expect(await fs.readFile(path.join(meta.path, 'draft.txt'), 'utf8')).toBe('nested contents\n');
    expect(await fs.readFile(path.join(meta.path, 'vendor', 'notes.txt'), 'utf8')).toBe('beside the clone\n');
    await expect(fs.stat(cloned)).rejects.toMatchObject({ code: 'ENOENT' });
    // A restored snapshot is consumed: its ref no longer keeps the objects alive.
    expect(await git(repo, 'for-each-ref', record.snapshot!.ref)).toBe('');
  }, 30_000);

  it('saves tracked edits hidden by assume-unchanged without touching the live index flag', async () => {
    const meta = await createFixture('hidden-edit');
    await git(meta.path, 'update-index', '--assume-unchanged', 'tracked.txt');
    await fs.writeFile(path.join(meta.path, 'tracked.txt'), 'local only\n');
    const probe = await captureWorktreeContent(meta.path, 'refs/cindy/worktree-recovery/probe/hidden', { includeUntracked: true });
    expect(await git(repo, 'show', `${probe.tree}:tracked.txt`)).toBe('local only');
    expect(await git(meta.path, 'ls-files', '-v', 'tracked.txt')).toBe('h tracked.txt');
    await git(repo, 'update-ref', '-d', probe.ref);

    expect(await recycleManagedWorktree(meta, { canRemove: async () => true })).toBe(true);
    expect(await restoreRecordedWorktree(meta.sessionId, meta.path)).toBe(true);
    expect(await fs.readFile(path.join(meta.path, 'tracked.txt'), 'utf8')).toBe('local only\n');
  }, 30_000);

  it('resumes a partial removal from the original snapshot and stops at a file written since', async () => {
    const meta = await createFixture('resumed');
    const record = await newRecycleRecord(meta);
    record.snapshot = await captureWorktreeContent(meta.path, `refs/cindy/worktree-recovery/${record.id}/resumed`, { includeUntracked: true });
    // Removal began after every existing file was written, then Windows stopped at a locked
    // file: draft.txt is gone while .git survives.
    record.phase = 'removing';
    record.removingSince = Date.now();
    record.removalDiscardable = [];
    await writeRecycleRecord(record);
    await fs.rm(path.join(meta.path, 'draft.txt'));
    const late = path.join(meta.path, 'late.txt');
    await fs.writeFile(late, 'written after removal began\n');
    const later = new Date(record.removingSince + 60_000);
    await fs.utimes(late, later, later);

    expect(await recycleManagedWorktree(meta, { canRemove: async () => true })).toBe(false);
    const waiting = (await readRecycleRecord(meta.path))!;
    expect(waiting.reason).toBe('residual-files-changed');
    expect(waiting.snapshot!.commit).toBe(record.snapshot.commit);
    expect(await fs.readFile(late, 'utf8')).toBe('written after removal began\n');
    await fs.rm(late);

    // Moved or copied in with its old timestamps: only the path shows it was never saved.
    const moved = path.join(meta.path, 'moved-in.txt');
    await fs.writeFile(moved, 'kept its original timestamps\n');
    waiting.removingSince = Date.now() + 60_000;
    await writeRecycleRecord(waiting);
    expect(await recycleManagedWorktree(meta, { canRemove: async () => true })).toBe(false);
    expect((await readRecycleRecord(meta.path))?.reason).toBe('residual-files-changed');
    expect(await fs.readFile(moved, 'utf8')).toBe('kept its original timestamps\n');

    await fs.rm(moved);
    expect(await recycleManagedWorktree(meta, { canRemove: async () => true })).toBe(true);
    await expect(fs.stat(meta.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await restoreRecordedWorktree(meta.sessionId, meta.path)).toBe(true);
    expect(await fs.readFile(path.join(meta.path, 'draft.txt'), 'utf8')).toBe('resumed contents\n');
  }, 30_000);

  it('drops a superseded snapshot at once and a deleted task\'s snapshot only in the startup sweep', async () => {
    const meta = await createFixture('retention');
    const record = await newRecycleRecord(meta);
    record.snapshot = await captureWorktreeContent(meta.path, `refs/cindy/worktree-recovery/${record.id}/older`, { includeUntracked: true });
    record.phase = 'snapshotted';
    await writeRecycleRecord(record);
    await fs.writeFile(path.join(meta.path, 'draft.txt'), 'edited after the first snapshot\n');
    expect(await recycleManagedWorktree(meta, { canRemove: async () => true })).toBe(true);
    const removed = (await readRecycleRecord(meta.path))!;
    expect(removed.snapshot!.ref).not.toBe(record.snapshot.ref);
    expect(await git(repo, 'for-each-ref', record.snapshot.ref)).toBe('');

    const owner = (status: string) => async () => [
      { id: meta.sessionId, status, source: 'desktop', currentDatabase: true, workingDir: meta.path, worktreePath: meta.path },
    ];
    // An archived task can still be unarchived; only a deleted one gives up its snapshot.
    await releaseObsoleteRecoverySnapshots(owner('archived'));
    expect(await git(repo, 'for-each-ref', removed.snapshot!.ref)).not.toBe('');
    await releaseObsoleteRecoverySnapshots(owner('deleted'));
    expect(await git(repo, 'for-each-ref', removed.snapshot!.ref)).toBe('');
  }, 30_000);

  it('keeps an advanced branch and its missing worktree untouched', async () => {
    const meta = await createFixture('advanced');
    expect(await recycleManagedWorktree(meta, { canRemove: async () => true })).toBe(true);
    const { stdout } = await exec('git', ['commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'external advance'], {
      cwd: repo, windowsHide: true, env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(state.root, 'git-global'), GIT_CONFIG_NOSYSTEM: '1' },
    });
    const advanced = stdout.trim();
    await git(repo, 'update-ref', 'refs/heads/cindy/advanced', advanced);
    expect(await restoreRecordedWorktree(meta.sessionId, meta.path)).toBe(false);
    expect(await git(repo, 'rev-parse', 'cindy/advanced')).toBe(advanced);
    await expect(fs.stat(meta.path)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('recreates a deleted saved branch at its original HEAD before restoring files', async () => {
    const meta = await createFixture('deleted-branch');
    await git(meta.path, 'commit', '--allow-empty', '-m', 'saved branch head');
    const head = await git(meta.path, 'rev-parse', 'HEAD');
    expect(await recycleManagedWorktree(meta, { canRemove: async () => true })).toBe(true);
    await git(repo, 'branch', '-D', meta.branch);

    expect(await restoreRecordedWorktree(meta.sessionId, meta.path)).toBe(true);
    expect(await git(meta.path, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${meta.branch}`);
    expect(await git(meta.path, 'rev-parse', 'HEAD')).toBe(head);
    expect(await fs.readFile(path.join(meta.path, 'draft.txt'), 'utf8')).toBe('deleted-branch contents\n');
  }, 30_000);

  it('does not overwrite a branch created concurrently with missing-branch recovery', async () => {
    const meta = await createFixture('branch-race');
    expect(await recycleManagedWorktree(meta, { canRemove: async () => true })).toBe(true);
    await git(repo, 'branch', '-D', meta.branch);
    const advanced = await git(repo, 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'concurrent branch');
    const headRef = `refs/heads/${meta.branch}`;
    const originalGit = vi.mocked(gitExec).getMockImplementation()!;
    let raced = false;
    vi.mocked(gitExec).mockImplementation(async (args, cwd, options) => {
      if (args[0] === 'update-ref' && args.includes(headRef)) {
        raced = true;
        await git(repo, 'update-ref', headRef, advanced);
      }
      return originalGit(args, cwd, options);
    });
    try {
      await expect(restoreRecordedWorktree(meta.sessionId, meta.path)).rejects.toThrow();
      expect(raced).toBe(true);
      expect(await git(repo, 'rev-parse', headRef)).toBe(advanced);
      await expect(fs.stat(meta.path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readRecycleRecord(meta.path))?.phase).toBe('removed');
    } finally {
      vi.mocked(gitExec).mockImplementation(originalGit);
    }
  }, 30_000);

  it('does not treat a failed branch lookup as evidence that the branch is missing', async () => {
    const meta = await createFixture('branch-read-error');
    expect(await recycleManagedWorktree(meta, { canRemove: async () => true })).toBe(true);
    await git(repo, 'branch', '-D', meta.branch);
    const headRef = `refs/heads/${meta.branch}`;
    const originalGit = vi.mocked(gitExec).getMockImplementation()!;
    vi.mocked(gitExec).mockImplementation(async (args, cwd, options) => {
      if (args[0] === 'show-ref' && args.includes(headRef)) {
        throw new GitExecError({ args, exitCode: 128, stdout: '', stderr: 'cannot read refs' });
      }
      return originalGit(args, cwd, options);
    });
    try {
      await expect(restoreRecordedWorktree(meta.sessionId, meta.path)).rejects.toThrow('cannot read refs');
      await expect(git(repo, 'show-ref', '--verify', '--quiet', headRef)).rejects.toThrow();
      await expect(fs.stat(meta.path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      vi.mocked(gitExec).mockImplementation(originalGit);
    }
  }, 30_000);

  it('does not take a saved branch from another worktree', async () => {
    const meta = await createFixture('occupied');
    expect(await recycleManagedWorktree(meta, { canRemove: async () => true })).toBe(true);
    const elsewhere = path.join(state.root, 'branch-occupant');
    await git(repo, 'worktree', 'add', elsewhere, 'cindy/occupied');
    await fs.writeFile(path.join(elsewhere, 'user-edit.txt'), 'keep occupant\n');
    await expect(restoreRecordedWorktree(meta.sessionId, meta.path)).rejects.toThrow();
    expect(await git(elsewhere, 'symbolic-ref', 'HEAD')).toBe('refs/heads/cindy/occupied');
    expect(await fs.readFile(path.join(elsewhere, 'user-edit.txt'), 'utf8')).toBe('keep occupant\n');
    expect(state.registry.has(meta.sessionId)).toBe(false);
  }, 30_000);

  it('taking a snapshot never modifies the original index or working files', async () => {
    const worktree = path.join(repo, '.cindy-worktrees', 'snapshot');
    await git(repo, 'worktree', 'add', '-b', 'cindy/snapshot', worktree, 'main');
    await fs.writeFile(path.join(worktree, 'tracked.txt'), 'staged\n');
    await git(worktree, 'add', 'tracked.txt');
    await fs.writeFile(path.join(worktree, 'tracked.txt'), 'current\n');
    const index = await git(worktree, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
    const before = await fs.readFile(index);
    await captureWorktreeContent(worktree, 'refs/cindy/worktree-recovery/test');
    expect(await fs.readFile(index)).toEqual(before);
    expect(await fs.readFile(path.join(worktree, 'tracked.txt'), 'utf8')).toBe('current\n');
  }, 30_000);

  it('repairs an interrupted removal without deleting surviving files or duplicating Git registration', async () => {
    const meta = await createFixture('partial');
    const originalGit = vi.mocked(gitExec).getMockImplementation()!;
    const originalRm = fs.rm;
    const blockedRm = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (String(target) === meta.path) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
      return originalRm(target, options);
    });
    vi.mocked(gitExec).mockImplementation(async (args, cwd, options) => {
      if (args.includes('remove') && args.includes(meta.path)) {
        await originalRm(path.join(meta.path, '.git'));
        await originalRm(path.join(meta.path, 'tracked.txt'));
        throw new Error('EBUSY');
      }
      return originalGit(args, cwd, options);
    });
    try {
      expect(await recycleManagedWorktree(meta, { canRemove: async () => true })).toBe(false);
      expect((await readRecycleRecord(meta.path))?.phase).toBe('removing');
    } finally {
      blockedRm.mockRestore();
      vi.mocked(gitExec).mockImplementation(originalGit);
    }
    await fs.writeFile(path.join(meta.path, 'new-edit.txt'), 'late edit');
    expect(await restoreRecordedWorktree(meta.sessionId, meta.path)).toBe(false);
    expect(await fs.readFile(path.join(meta.path, 'new-edit.txt'), 'utf8')).toBe('late edit');
    await fs.unlink(path.join(meta.path, 'new-edit.txt'));
    expect(await restoreRecordedWorktree(meta.sessionId, meta.path)).toBe(true);
    expect(await fs.readFile(path.join(meta.path, 'draft.txt'), 'utf8')).toBe('partial contents\n');
    expect(await fs.readFile(path.join(meta.path, 'tracked.txt'), 'utf8')).toBe('base\n');
    const registered = (await git(repo, 'worktree', 'list', '--porcelain')).split('\n')
      .filter((line) => line.startsWith('worktree ') && path.resolve(line.slice(9)) === path.resolve(meta.path));
    expect(registered).toHaveLength(1);
  }, 30_000);

  it('rejects a corrupt encrypted archive from an older client before creating recovery files', async () => {
    const meta = await createFixture('corrupt');
    const legacyArchive = await createRecoveryArchive(meta.path, worktreeResourceId(await physicalWorktreeKey(meta.path)));
    expect(await recycleManagedWorktree(meta, { canRemove: async () => true })).toBe(true);
    const record = (await readRecycleRecord(meta.path))!;
    // Model the record shape older clients wrote: snapshot without untracked files, plus an archive.
    delete record.snapshot!.untracked;
    record.archive = legacyArchive;
    await writeRecycleRecord(record);
    const archive = path.join(state.root, 'worktree-recycle', record.archive.file);
    const bytes = await fs.readFile(archive);
    bytes[0] ^= 1;
    await fs.writeFile(archive, bytes);
    await expect(restoreRecordedWorktree(meta.sessionId, meta.path)).rejects.toThrow();
    await expect(fs.stat(meta.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readRecycleRecord(meta.path))?.phase).toBe('removed');
  }, 30_000);

  it('repairs a partial removal whose .git file points at deleted worktree metadata', async () => {
    const meta = await createFixture('dangling-link');
    const record = await newRecycleRecord(meta);
    record.snapshot = await captureWorktreeContent(meta.path, `refs/cindy/worktree-recovery/${record.id}/dangling`, { includeUntracked: true });
    const directory = await fs.lstat(meta.path);
    record.directoryIdentity = `${directory.dev}:${directory.ino}:${directory.birthtimeMs}`;
    record.phase = 'removing';
    record.removingSince = Date.now();
    await writeRecycleRecord(record);
    // Git deleted the metadata and one file, then stopped before the directory's own .git file.
    await fs.rm(await git(meta.path, 'rev-parse', '--absolute-git-dir'), { recursive: true, force: true });
    await fs.rm(path.join(meta.path, 'draft.txt'));
    state.registry.delete(meta.sessionId);

    expect(await restoreRecordedWorktree(meta.sessionId, meta.path)).toBe(true);
    expect(await fs.readFile(path.join(meta.path, 'draft.txt'), 'utf8')).toBe('dangling-link contents\n');
    expect(await git(meta.path, 'rev-parse', 'HEAD')).toBe(record.snapshot.head);
  }, 30_000);

  it('drops its own snapshot ref when HEAD or the index moves during capture', async () => {
    const meta = await createFixture('moving-index');
    const mocked = vi.mocked(gitExec);
    const real = mocked.getMockImplementation()!;
    mocked.mockImplementation(async (args, cwd, options) => {
      const result = await real(args, cwd, options);
      if (args[0] === 'update-ref' && args[1]?.startsWith('refs/cindy/')) await git(meta.path, 'add', 'draft.txt');
      return result;
    });
    try {
      await expect(captureWorktreeContent(meta.path, 'refs/cindy/worktree-recovery/moving/index', { includeUntracked: true }))
        .rejects.toThrow('changed during snapshot');
    } finally {
      mocked.mockImplementation(real);
    }
    expect(await git(repo, 'for-each-ref', 'refs/cindy/worktree-recovery/moving/')).toBe('');
  }, 30_000);

  // PR #6898 r4357569426: previous capture-abort coverage stops before capture returns.
  // Exercise checkpointWorktreeForReuse with an edit just after ref creation: rejecting reuse
  // must leave the edit intact and no orphan ref. Real refs require the git-integration tier.
  it('drops the pool checkpoint ref when the checkout changes before reuse', async () => {
    const meta = await createFixture('pool-checkpoint');
    const refsBefore = await git(repo, 'for-each-ref', 'refs/cindy/worktree-recovery/');
    const mocked = vi.mocked(gitExec);
    const real = mocked.getMockImplementation()!;
    mocked.mockImplementation(async (args, cwd, options) => {
      const result = await real(args, cwd, options);
      if (args[0] === 'update-ref' && args[1]?.startsWith('refs/cindy/')) {
        await fs.writeFile(path.join(meta.path, 'draft.txt'), 'edited after capture\n');
      }
      return result;
    });
    try {
      await expect(checkpointWorktreeForReuse(meta)).rejects.toThrow('pooled worktree changed before reuse');
    } finally {
      mocked.mockImplementation(real);
    }
    expect(await git(repo, 'for-each-ref', 'refs/cindy/worktree-recovery/')).toBe(refsBefore);
    expect(await fs.readFile(path.join(meta.path, 'draft.txt'), 'utf8')).toBe('edited after capture\n');
  }, 30_000);

  it('notices staging that happens while the full tree is compared', async () => {
    const meta = await createFixture('staged-meanwhile');
    const snapshot = await captureWorktreeContent(meta.path, 'refs/cindy/worktree-recovery/meanwhile/tree', { includeUntracked: true });
    expect(await worktreeContentMatches(meta.path, snapshot)).toBe(true);
    const mocked = vi.mocked(gitExec);
    const real = mocked.getMockImplementation()!;
    // Staging folds into the same full tree, so only a second staged check can see it.
    mocked.mockImplementation(async (args, cwd, options) => {
      if (args[0] === 'add' && args[1] === '--all') await git(meta.path, 'add', 'draft.txt');
      return real(args, cwd, options);
    });
    try {
      expect(await worktreeContentMatches(meta.path, snapshot)).toBe(false);
    } finally {
      mocked.mockImplementation(real);
    }
  }, 30_000);

  it('keeps a partially removed directory when an older client\'s archive no longer verifies', async () => {
    const meta = await createFixture('legacy-removing');
    const record = await newRecycleRecord(meta);
    record.snapshot = await captureWorktreeContent(meta.path, `refs/cindy/worktree-recovery/${record.id}/legacy`);
    record.archive = await createRecoveryArchive(meta.path, record.id);
    record.phase = 'removing';
    await writeRecycleRecord(record);
    await fs.rm(path.join(meta.path, 'draft.txt'));
    const archive = path.join(state.root, 'worktree-recycle', record.archive.file);
    const bytes = await fs.readFile(archive);
    bytes[0] ^= 1;
    await fs.writeFile(archive, bytes);

    expect(await recycleManagedWorktree(meta, { canRemove: async () => true })).toBe(false);
    // Decryption fails, so the request keeps waiting and the surviving bytes stay on disk.
    expect((await readRecycleRecord(meta.path))?.phase).toBe('removing');
    expect(await fs.readFile(path.join(meta.path, 'tracked.txt'), 'utf8')).toBe('base\n');
  }, 30_000);

  it('preserves earlier recovery history across reuse and never overwrites a newer occupant', async () => {
    const previous = await createFixture('history');
    expect(await recycleManagedWorktree(previous, { canRemove: async () => true })).toBe(true);
    await git(repo, 'worktree', 'add', '-b', 'cindy/successor', previous.path, 'main');
    await fs.writeFile(path.join(previous.path, 'draft.txt'), 'successor contents\n');
    const next = { ...previous, sessionId: 'successor', generation: 'successor-generation', branch: 'cindy/successor' };
    state.registry.set(next.sessionId, next);
    state.refs.push({ id: next.sessionId, status: 'archived', source: 'desktop', currentDatabase: true, workingDir: next.path, worktreePath: next.path });
    expect(await restoreRecordedWorktree(previous.sessionId, previous.path)).toBe(false);
    expect(await fs.readFile(path.join(next.path, 'draft.txt'), 'utf8')).toBe('successor contents\n');
    expect(await recycleManagedWorktree(next, { canRemove: async () => true })).toBe(true);
    expect((await readRecycleRecord(previous.path, previous.sessionId))?.generation).toBe(previous.generation);
    expect(await restoreRecordedWorktree(previous.sessionId, previous.path)).toBe(true);
    expect(await fs.readFile(path.join(previous.path, 'draft.txt'), 'utf8')).toBe('history contents\n');
  }, 30_000);

  it('resumes after a crash between recovery mkdir and directory identity journal', async () => {
    const meta = await createFixture('mkdir-crash');
    expect(await recycleManagedWorktree(meta, { canRemove: async () => true })).toBe(true);
    const record = (await readRecycleRecord(meta.path))!;
    record.phase = 'restoring';
    record.directoryIdentity = null;
    record.restoredGeneration = 'resume-generation';
    await writeRecycleRecord(record);
    await fs.mkdir(meta.path);
    expect(await restoreRecordedWorktree(meta.sessionId, meta.path)).toBe(true);
    expect((await readRecycleRecord(meta.path))?.phase).toBe('restored');
  }, 30_000);

  it('preserves conflicting copy artifacts and user edits when failed pool reuse cannot roll back', async () => {
    const meta = await createFixture('copy-conflict');
    meta.ephemeral = true;
    await fs.mkdir(path.join(meta.path, '.claude'));
    const conflictPath = path.join(meta.path, '.claude', 'config.txt');
    await fs.writeFile(conflictPath, 'original tracked config\n');
    await git(meta.path, 'add', '.');
    await git(meta.path, 'commit', '-m', 'old pool contents');
    const oldHead = await git(meta.path, 'rev-parse', 'HEAD');
    await fs.writeFile(path.join(meta.path, '.env'), 'original ignored bytes\n');
    const fallback = { ok: false, error: { kind: 'unknown', message: 'fresh creation unavailable' } };
    managerMocks.create.mockResolvedValueOnce(fallback);
    managerMocks.copy.mockImplementationOnce(async (_repo: string, worktree: string) => {
      await fs.mkdir(path.join(worktree, '.claude'));
      await fs.writeFile(path.join(worktree, '.claude', 'config.txt'), 'partial copy\n');
      await fs.writeFile(path.join(worktree, 'late-user-edit.txt'), 'new user bytes\n');
      throw new Error('copy interrupted');
    });
    const req = { sessionId: 'copy-next', name: 'copy-next', baseRepo: repo, sourceBranch: 'main', ephemeral: true };
    try {
      expect(await releaseWorktree(meta.sessionId)).toBe('pooled');
      expect(await acquireWorktree(req)).toEqual(fallback);
      expect(managerMocks.copy).toHaveBeenCalledWith(repo, meta.path);
      expect(managerMocks.create).toHaveBeenCalledWith(req);
      expect(await git(meta.path, 'symbolic-ref', 'HEAD')).toBe('refs/heads/cindy/copy-next');
      expect(await git(repo, 'rev-parse', meta.branch)).toBe(oldHead);
      expect(state.registry.get(meta.sessionId)).toEqual(meta);
      expect(state.registry.has(req.sessionId)).toBe(false);
      const record = (await readRecycleRecord(meta.path, meta.sessionId))!;
      expect(record.phase).toBe('removed');
      expect(record.generation).toBe(meta.generation);
      expect(await git(repo, 'rev-parse', record.snapshot!.ref)).toBe(record.snapshot!.commit);
      expect(record.archive).toBeUndefined();
      expect(await git(repo, 'show', `${record.snapshot!.commit}:.claude/config.txt`)).toBe('original tracked config');
      expect(await restoreRecordedWorktree(meta.sessionId, meta.path)).toBe(false);
      expect(await fs.readFile(conflictPath, 'utf8')).toBe('partial copy\n');
      expect(await fs.readFile(path.join(meta.path, 'late-user-edit.txt'), 'utf8')).toBe('new user bytes\n');
    } finally {
      parkAll();
      managerMocks.copy.mockReset();
      managerMocks.create.mockReset();
    }
  }, 30_000);

  it('preserves submodule-only commits whose Git objects lie outside the archived directory', async () => {
    const origin = path.join(state.root, 'child-origin');
    await fs.mkdir(origin);
    await git(origin, 'init', '-b', 'main');
    await git(origin, 'config', 'user.name', 'Recovery Test');
    await git(origin, 'config', 'user.email', 'recovery-test@localhost');
    await fs.writeFile(path.join(origin, 'child.txt'), 'base\n');
    await git(origin, 'add', '.'); await git(origin, 'commit', '-m', 'child fixture');
    const meta = await createFixture('submodule');
    await git(meta.path, '-c', 'protocol.file.allow=always', 'submodule', 'add', origin, 'child');
    await git(meta.path, 'commit', '-am', 'add child');
    const child = path.join(meta.path, 'child');
    await git(child, 'config', 'user.name', 'Recovery Test');
    await git(child, 'config', 'user.email', 'recovery-test@localhost');
    await fs.writeFile(path.join(child, 'child.txt'), 'child-only work\n');
    await git(child, 'commit', '-am', 'child-only commit');
    const childHead = await git(child, 'rev-parse', 'HEAD');
    expect(await recycleManagedWorktree(meta, { canRemove: async () => true })).toBe(false);
    expect(state.registry.has(meta.sessionId)).toBe(true);
    expect(await git(child, 'rev-parse', 'HEAD')).toBe(childHead);
    expect(await fs.readFile(path.join(child, 'child.txt'), 'utf8')).toBe('child-only work\n');
    expect((await readRecycleRecord(meta.path))?.archive).toBeUndefined();
  }, 30_000);
});
