import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { WorktreeMeta } from '../worktree/types';
import type { LocalWorktreeReference } from '../localDb/worker/worktreeReferences';

const state = vi.hoisted(() => ({ root: '', refs: [] as LocalWorktreeReference[], runtimes: new Set<string>(), registry: new Map<string, WorktreeMeta>() }));
const snapshot = vi.hoisted(() => vi.fn());
const baselineMatches = vi.hoisted(() => vi.fn());
const archive = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());
const git = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../worktree/worktreeStore', () => ({
  get: (id: string) => state.registry.get(id) ?? null,
  getAll: () => [...state.registry.values()], getAllPaths: () => [...state.registry.values()].map((m) => m.path),
  set: async (id: string, meta: WorktreeMeta) => { state.registry.set(id, meta); },
  del: async (id: string) => { state.registry.delete(id); },
}));
vi.mock('../localDb/client/current', () => ({ getDbClient: () => ({ readLocalWorktreeReferences: query }) }));
vi.mock('../worktree/runtimeLeases', () => ({ readWorktreeRuntimePaths: async () => state.runtimes }));
vi.mock('../worktree/contentSnapshot', () => ({ captureWorktreeContent: snapshot, worktreeContentBaselineMatches: baselineMatches }));
vi.mock('../worktree/gitExec', () => ({ gitExec: git }));
vi.mock('../worktree/recoveryArchive', async (original) => ({
  ...await original<typeof import('../worktree/recoveryArchive')>(),
  createRecoveryArchive: archive, verifyRecoveryArchive: async () => {},
}));

import { recycleManagedWorktree, requestWorktreeRecycle } from '../worktree/managedRecycle';
import { readRecycleRecord } from '../worktree/recycleJournal';
import { inventoryWorktree } from '../worktree/recoveryArchive';
import { physicalWorktreeKey } from '../worktree/resourceLock';

describe('shared worktree recycling', () => {
  let meta: WorktreeMeta;
  let removable: boolean;
  beforeEach(async () => {
    state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-recycle-test-'));
    meta = { sessionId: 'owner', generation: 'generation-one', name: 'one', path: path.join(state.root, 'repo', '.cindy-worktrees', 'one'), baseRepo: path.join(state.root, 'repo'), branch: 'cindy/one', sourceBranch: 'main', createdAt: '2026-09-08T00:00:00Z' };
    await fs.mkdir(meta.path, { recursive: true });
    await fs.writeFile(path.join(meta.path, '.git'), 'gitdir: unused-test-link');
    await fs.writeFile(path.join(meta.path, 'draft.txt'), 'uncommitted contents');
    state.registry.clear(); state.registry.set(meta.sessionId, meta);
    state.runtimes.clear();
    state.refs = [{ id: meta.sessionId, status: 'archived', source: 'desktop', workingDir: meta.path, worktreePath: meta.path, currentDatabase: true }];
    removable = true;
    query.mockReset().mockImplementation(async () => state.refs);
    snapshot.mockReset().mockResolvedValue({ head: 'actual-head', tree: 'file-tree', indexTree: 'index-tree', commit: 'saved-commit', ref: 'saved-ref' });
    baselineMatches.mockReset().mockResolvedValue(true);
    archive.mockReset().mockImplementation(async () => ({ file: 'archive.tar.gz.enc', files: await inventoryWorktree(meta.path) }));
    git.mockReset().mockImplementation(async (args: string[]) => {
      if (args.includes('--show-toplevel')) return { stdout: meta.path };
      if (args.includes('--git-common-dir')) return { stdout: path.join(meta.baseRepo, '.git') };
      if (args.includes('--git-dir')) return { stdout: path.join(meta.baseRepo, '.git', 'worktrees', 'one') };
      if (args.includes('remove')) await fs.rm(meta.path, { recursive: true });
      return { stdout: '' };
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(state.root, { recursive: true, force: true });
  });
  const recycle = () => recycleManagedWorktree(meta, { canRemove: async () => removable });

  it('limits simultaneous recycling of distinct resources to one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let peak = 0;
    let checked = 0;
    const jobs = Array.from({ length: 12 }, (_, index) => {
      const candidate = { ...meta, sessionId: `batch-${index}`, path: path.join(path.dirname(meta.path), `batch-${index}`) };
      state.registry.set(candidate.sessionId, candidate);
      return recycleManagedWorktree(candidate, { canRemove: async () => {
        active++; peak = Math.max(peak, active); checked++;
        try { await gate; return false; } finally { active--; }
      } });
    });
    try {
      await vi.waitFor(() => expect(active).toBe(1));
      expect(checked).toBe(1);
    } finally { release(); }
    expect(await Promise.all(jobs)).toEqual(Array(12).fill(false));
    expect(checked).toBe(12); expect(peak).toBe(1);
  });

  it('keeps content recoverable and drops registration only after the directory is gone', async () => {
    const order: string[] = [];
    archive.mockImplementation(async () => { order.push('archive'); return { files: await inventoryWorktree(meta.path) }; });
    snapshot.mockImplementation(async () => { order.push('snapshot'); return { head: 'head', tree: 'tree', indexTree: 'index', commit: 'commit', ref: 'ref' }; });
    expect(await recycle()).toBe(true);
    expect(order).toEqual(['archive', 'snapshot']);
    expect(state.registry.has(meta.sessionId)).toBe(false);
    expect((await readRecycleRecord(meta.path))?.phase).toBe('removed');
  });
  it.each(['active', null, 'unknown'])('protects a %s reference in another local database', async (status) => {
    state.refs.push({ ...state.refs[0], id: 'borrower', status, currentDatabase: false });
    expect(await recycle()).toBe(false);
    expect(snapshot).not.toHaveBeenCalled();
    expect(state.registry.has(meta.sessionId)).toBe(true);
  });
  it('does not exclude an identical task id in another database', async () => {
    state.refs.push({ ...state.refs[0], status: 'active', currentDatabase: false });
    expect(await recycle()).toBe(false);
  });
  it('terminal references release the shared resource once all runtimes have stopped', async () => {
    state.refs.push({ ...state.refs[0], id: 'borrower', currentDatabase: false });
    expect(await recycle()).toBe(true);
  });
  it('protects a terminal task with an active runtime lease', async () => {
    state.runtimes.add(await physicalWorktreeKey(meta.path));
    expect(await recycle()).toBe(false);
    expect(archive).not.toHaveBeenCalled();
  });
  it('protects a borrower running in a subdirectory', async () => {
    state.refs.push({ ...state.refs[0], id: 'borrower', status: 'active', workingDir: path.join(meta.path, 'src'), worktreePath: null });
    expect(await recycle()).toBe(false);
  });
  it('preserves when any local reference source is unreadable', async () => {
    query.mockRejectedValue(new Error('database locked'));
    expect(await recycle()).toBe(false);
    expect(archive).not.toHaveBeenCalled();
  });
  it('keeps the sentinel outside the snapshot/removal flow', async () => {
    await fs.writeFile(path.join(meta.path, '.worktree-keep'), '');
    expect(await recycle()).toBe(false);
    expect(archive).not.toHaveBeenCalled();
  });
  it('never snapshots the parent repository when .git is missing', async () => {
    await fs.rm(path.join(meta.path, '.git'));
    expect(await recycle()).toBe(false);
    expect(snapshot).not.toHaveBeenCalled();
  });
  it('keeps files and registration when the archive cannot be encrypted', async () => {
    archive.mockRejectedValue(new Error('key store unavailable'));
    expect(await recycle()).toBe(false);
    expect(await fs.readFile(path.join(meta.path, 'draft.txt'), 'utf8')).toBe('uncommitted contents');
    expect(state.registry.has(meta.sessionId)).toBe(true);
  });
  it('keeps the live index/files when Git snapshot creation fails', async () => {
    snapshot.mockRejectedValue(new Error('unmerged index'));
    expect(await recycle()).toBe(false);
    expect(await fs.readFile(path.join(meta.path, 'draft.txt'), 'utf8')).toBe('uncommitted contents');
  });
  it('cancels without reapplying a stash when the task becomes active during snapshotting', async () => {
    snapshot.mockImplementation(async () => { removable = false; return { head: 'head' }; });
    expect(await recycle()).toBe(false);
    expect(await fs.readFile(path.join(meta.path, 'draft.txt'), 'utf8')).toBe('uncommitted contents');
    expect(git.mock.calls.some(([args]) => args.includes('stash'))).toBe(false);
  });
  it('rechecks a newly active borrower after the snapshot', async () => {
    snapshot.mockImplementation(async () => { state.refs.push({ ...state.refs[0], id: 'new', status: 'active' }); return { head: 'head' }; });
    expect(await recycle()).toBe(false);
  });
  it('preserves edits made during snapshot creation', async () => {
    snapshot.mockImplementation(async () => { await fs.writeFile(path.join(meta.path, 'new.txt'), 'new work'); return { head: 'head' }; });
    expect(await recycle()).toBe(false);
    expect((await readRecycleRecord(meta.path))?.reason).toBe('files-changed');
  });
  it('supports a changed branch or detached HEAD by recording the actual content baseline', async () => {
    meta.branch = 'cindy/old-name';
    expect(await recycle()).toBe(true);
    expect((await readRecycleRecord(meta.path))?.snapshot?.head).toBe('actual-head');
  });
  it('records the request before removal and survives re-reading the journal', async () => {
    await requestWorktreeRecycle(meta.sessionId);
    expect((await readRecycleRecord(meta.path))?.phase).toBe('pending');
    expect(await fs.readFile(path.join(meta.path, 'draft.txt'), 'utf8')).toBe('uncommitted contents');
  });
  it('old requests cannot replace a newer generation journal', async () => {
    const old = meta;
    meta = { ...meta, generation: 'successor' }; state.registry.set(meta.sessionId, meta);
    await requestWorktreeRecycle(meta.sessionId);
    expect(await recycleManagedWorktree(old, { canRemove: async () => true })).toBe(false);
    expect((await readRecycleRecord(meta.path))?.generation).toBe('successor');
  });
  it('a recreated directory at the same path does not satisfy an old request', async () => {
    await requestWorktreeRecycle(meta.sessionId);
    await fs.rename(meta.path, `${meta.path}-old`);
    await fs.mkdir(meta.path);
    await fs.writeFile(path.join(meta.path, 'replacement.txt'), 'keep');
    expect(await recycle()).toBe(false);
    expect((await readRecycleRecord(meta.path))?.reason).toBe('directory-replaced');
  });
  it('partial EBUSY deletion retains evidence and retries only unchanged surviving bytes', async () => {
    const rm = fs.rm;
    const fail = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (String(target) === meta.path) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
      return rm(target, options);
    });
    git.mockImplementation(async (args: string[]) => {
      if (args.includes('--show-toplevel')) return { stdout: meta.path };
      if (args.includes('--git-common-dir')) return { stdout: path.join(meta.baseRepo, '.git') };
      if (args.includes('--git-dir')) return { stdout: path.join(meta.baseRepo, '.git', 'worktrees', 'one') };
      if (args.includes('remove')) { await rm(path.join(meta.path, '.git'), { force: true }); throw new Error('EBUSY'); }
      return { stdout: '' };
    });
    expect(await recycle()).toBe(false);
    expect((await readRecycleRecord(meta.path))?.phase).toBe('removing');
    expect(state.registry.has(meta.sessionId)).toBe(true);
    fail.mockRestore();
    expect(await recycle()).toBe(true);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });
  it('does not report success when Git returns success but the directory remains', async () => {
    const originalGit = git.getMockImplementation()!;
    git.mockImplementation(async (args: string[]) => args.includes('remove') ? { stdout: '' } : originalGit(args));
    expect(await recycle()).toBe(false);
    expect(state.registry.has(meta.sessionId)).toBe(true);
    expect((await readRecycleRecord(meta.path))?.reason).toBe('directory-still-present');
  });
  it('retains a new HEAD or staged change arriving after snapshotting', async () => {
    baselineMatches.mockResolvedValue(false);
    expect(await recycle()).toBe(false);
    expect((await readRecycleRecord(meta.path))?.reason).toBe('git-baseline-changed');
    expect(git.mock.calls.some(([args]) => args.includes('remove'))).toBe(false);
  });
  it('rechecks files after marking removal and preserves a late editor write', async () => {
    baselineMatches.mockImplementationOnce(async () => {
      await fs.writeFile(path.join(meta.path, 'late-editor-write.txt'), 'keep me');
      return true;
    });
    expect(await recycle()).toBe(false);
    expect((await readRecycleRecord(meta.path))?.reason).toBe('files-changed-before-removal');
    expect(git.mock.calls.some(([args]) => args.includes('remove'))).toBe(false);
    expect(await fs.readFile(path.join(meta.path, 'late-editor-write.txt'), 'utf8')).toBe('keep me');
    expect(state.registry.has(meta.sessionId)).toBe(true);
  });
  it('persists a shared owner request before the last borrower status write', async () => {
    await requestWorktreeRecycle('borrower', [meta.path]);
    expect((await readRecycleRecord(meta.path))?.meta.sessionId).toBe(meta.sessionId);
  });
  it('protects an unknown registration sharing the physical directory', async () => {
    state.registry.set('unknown', { ...meta, sessionId: 'unknown' });
    expect(await recycle()).toBe(false);
    expect(archive).not.toHaveBeenCalled();
  });
  it('preserves an externally locked Git worktree', async () => {
    const gitDir = path.join(meta.baseRepo, '.git', 'worktrees', 'one');
    await fs.mkdir(gitDir, { recursive: true });
    await fs.writeFile(path.join(gitDir, 'locked'), 'external use');
    expect(await recycle()).toBe(false);
    expect(archive).not.toHaveBeenCalled();
  });
  it('preserves indexed submodules before creating incomplete recovery evidence', async () => {
    const originalGit = git.getMockImplementation()!;
    git.mockImplementation(async (args: string[]) => args.includes('--stage')
      ? { stdout: `160000 ${'a'.repeat(40)} 0\tchild\0` } : originalGit(args));
    expect(await recycle()).toBe(false);
    expect(archive).not.toHaveBeenCalled();
    expect(state.registry.has(meta.sessionId)).toBe(true);
  });
  it('preserves submodule metadata even after its gitlink was removed from the index', async () => {
    await fs.mkdir(path.join(meta.baseRepo, '.git', 'worktrees', 'one', 'modules', 'child'), { recursive: true });
    expect(await recycle()).toBe(false);
    expect(archive).not.toHaveBeenCalled();
    expect(state.registry.has(meta.sessionId)).toBe(true);
  });
  it('rejects a Git link pointing at another repository', async () => {
    const originalGit = git.getMockImplementation()!;
    git.mockImplementation(async (args: string[], cwd: string) => args.includes('--git-common-dir') && cwd === meta.path
      ? { stdout: path.join(state.root, 'different-repo', '.git') } : originalGit(args, cwd));
    expect(await recycle()).toBe(false);
    expect(archive).not.toHaveBeenCalled();
  });
});
