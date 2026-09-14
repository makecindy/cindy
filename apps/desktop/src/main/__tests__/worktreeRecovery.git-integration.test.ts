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
vi.mock('../worktree/runtimeLeases', () => ({ readWorktreeRuntimePaths: async () => new Set() }));
vi.mock('../worktree/gitExec', async (original) => {
  const actual = await original<typeof import('../worktree/gitExec')>();
  return { ...actual, gitExec: vi.fn<typeof actual.gitExec>((args, cwd, options) => actual.gitExec(args, cwd, {
    ...options, extraEnv: { ...options?.extraEnv, GIT_CONFIG_GLOBAL: path.join(state.root, 'git-global'), GIT_CONFIG_NOSYSTEM: '1' },
  })) };
});

import { recycleManagedWorktree } from '../worktree/managedRecycle';
import { restoreRecordedWorktree } from '../worktree/restoreRecovery';
import { readRecycleRecord, writeRecycleRecord } from '../worktree/recycleJournal';
import { captureWorktreeContent } from '../worktree/contentSnapshot';
import { GitExecError, gitExec } from '../worktree/gitExec';
import { acquireWorktree, releaseWorktree, parkAll } from '../worktree/WorktreePool';
import { extractRecoveryArchive } from '../worktree/recoveryArchive';

const exec = promisify(execFile);
describe('worktree recovery with real Git and encrypted archives', () => {
  let repo: string;
  const git = async (cwd: string, ...args: string[]) => (await exec('git', args, {
    cwd, windowsHide: true, env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(state.root, 'git-global'), GIT_CONFIG_NOSYSTEM: '1' },
  })).stdout.trim();
  beforeAll(async () => {
    state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-recovery-git-'));
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

  it('restores detached HEAD, staged-only bytes, unstaged files, ignored files and untracked files', async () => {
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
    const archivedTree = await git(repo, 'ls-tree', '-r', '--name-only', record!.snapshot!.commit);
    expect(archivedTree).not.toContain('.env');
    expect(archivedTree).not.toContain('untracked.txt');
    expect(await restoreRecordedWorktree(meta.sessionId, worktree)).toBe(true);
    expect(await git(worktree, 'rev-parse', 'HEAD')).toBe(head);
    await expect(git(worktree, 'symbolic-ref', '--quiet', 'HEAD')).rejects.toThrow();
    expect(await git(worktree, 'show', ':tracked.txt')).toBe('staged');
    expect(await fs.readFile(path.join(worktree, 'tracked.txt'), 'utf8')).toBe('unstaged\n');
    expect(await fs.readFile(path.join(worktree, '.env'), 'utf8')).toBe('INVALID_TEST_SECRET=keep-me\n');
    expect(await fs.readFile(path.join(worktree, 'untracked.txt'), 'utf8')).toBe('untracked content\n');
    expect(await fs.readFile(path.join(worktree, 'ignored', 'data.bin'))).toEqual(Buffer.from([0, 255, 10, 48]));
    expect(await git(worktree, 'status', '--porcelain')).toContain('MM tracked.txt');
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

  it('rejects a corrupt encrypted archive before creating recovery files', async () => {
    const meta = await createFixture('corrupt');
    expect(await recycleManagedWorktree(meta, { canRemove: async () => true })).toBe(true);
    const record = (await readRecycleRecord(meta.path))!;
    const archive = path.join(state.root, 'worktree-recycle', record.archive!.file);
    const bytes = await fs.readFile(archive);
    bytes[0] ^= 1;
    await fs.writeFile(archive, bytes);
    await expect(restoreRecordedWorktree(meta.sessionId, meta.path)).rejects.toThrow();
    await expect(fs.stat(meta.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readRecycleRecord(meta.path))?.phase).toBe('removed');
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
      const saved = path.join(state.root, 'copy-conflict-saved');
      await fs.mkdir(saved);
      await extractRecoveryArchive(record.archive!, saved);
      expect(await fs.readFile(path.join(saved, '.claude', 'config.txt'), 'utf8')).toBe('original tracked config\n');
      expect(await fs.readFile(path.join(saved, '.env'), 'utf8')).toBe('original ignored bytes\n');
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
