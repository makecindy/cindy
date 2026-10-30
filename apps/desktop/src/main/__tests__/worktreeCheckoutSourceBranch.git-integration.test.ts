// 未勾选 worktree 时按所选分支工作：新 worktree 直接检出用户已有分支(不新建 cindy/<name>，
// 不切换用户主目录)。回归：远程电脑上未勾选 worktree 选了分支，任务却落在默认分支。
// 用真实 Git 验证三件只有 Git 本身能证明的事：HEAD 指向该分支本身、回收只删目录不删分支、
// 同一分支已在别处检出或不是本地分支时明确拒绝。
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { WorktreeMeta } from '../worktree/types';

const state = vi.hoisted(() => ({ root: '', registry: new Map<string, WorktreeMeta>() }));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../localDb/client/current', () => ({ getDbClient: () => ({ readLocalWorktreeReferences: async () => [] }) }));
vi.mock('../worktree/piSubagentReferences', () => ({ readPiSubagentWorktreeReferences: async () => new Map() }));
vi.mock('../worktree/worktreeStore', () => ({
  get: (id: string) => state.registry.get(id) ?? null,
  getAll: () => [...state.registry.values()],
  getAllPaths: () => [...state.registry.values()].map((meta) => meta.path),
  set: async (id: string, meta: WorktreeMeta) => { state.registry.set(id, meta); },
  del: async (id: string) => { state.registry.delete(id); },
}));

import { awaitBackgroundCheckout, createWorktree, discardPrecreatedWorktree } from '../worktree/WorktreeManager';

const exec = promisify(execFile);
let repo: string;
const git = async (cwd: string, ...args: string[]) =>
  (await exec('git', args, { cwd, windowsHide: true })).stdout.trim();

beforeEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_')) vi.stubEnv(key, undefined);
  }
  vi.stubEnv('GIT_CONFIG_GLOBAL', process.platform === 'win32' ? 'NUL' : os.devNull);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-checkout-source-'));
  state.registry.clear();
  // Live-reference scanning reads sibling dev profiles; a missing root fails closed (preserve).
  await fs.mkdir(path.join(state.root, '.dev-instances'));
  repo = path.join(state.root, 'repo');
  await fs.mkdir(repo);
  await git(repo, 'init', '--initial-branch=main');
  await git(repo, 'config', 'user.name', 'Cindy Test');
  await git(repo, 'config', 'user.email', 'cindy-test@example.invalid');
  await fs.writeFile(path.join(repo, 'README.md'), 'main\n');
  await git(repo, 'add', 'README.md');
  await git(repo, 'commit', '-m', 'main');
  await git(repo, 'branch', 'feature');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(state.root, { recursive: true, force: true });
});

const create = async (sessionId: string, sourceBranch: string) => {
  const resp = await createWorktree(
    { sessionId, baseRepo: repo, name: '', sourceBranch, checkoutSourceBranch: true },
    { trackBackgroundCheckout: true },
  );
  await awaitBackgroundCheckout(sessionId);
  return resp;
};

it('checks out the chosen branch itself and discards only the directory', async () => {
  const resp = await create('s1', 'feature');
  if (!resp.ok) throw new Error(resp.error.message);
  expect(resp.meta).toMatchObject({ branch: 'feature', sourceBranch: 'feature', checksOutSourceBranch: true });
  expect(await git(resp.meta.path, 'symbolic-ref', 'HEAD')).toBe('refs/heads/feature');
  // 用户主目录的分支不动；worktree 里的提交直接落在 feature 上。
  expect(await git(repo, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
  await fs.writeFile(path.join(resp.meta.path, 'work.txt'), 'done\n');
  await git(resp.meta.path, 'add', 'work.txt');
  await git(resp.meta.path, 'commit', '-m', 'work on feature');
  const featureTip = await git(repo, 'rev-parse', 'refs/heads/feature');

  // 远程两步创建失败时的回收：目录移除，用户分支及其提交保留。
  expect(await discardPrecreatedWorktree('s1', resp.meta.path)).toEqual({ status: 'discarded', branchDeleted: false });
  await expect(fs.stat(resp.meta.path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await git(repo, 'rev-parse', 'refs/heads/feature')).toBe(featureTip);
  // 目录回收后分支不再被占用，用户可以在主目录检出它。
  await git(repo, 'checkout', 'feature');
});

it('refuses a branch checked out elsewhere or one that is not a local branch', async () => {
  const occupied = await create('s2', 'main');
  expect(occupied.ok).toBe(false);
  if (!occupied.ok) expect(occupied.error.message).toContain('main');

  await git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const remoteRef = await create('s3', 'refs/remotes/origin/main');
  expect(remoteRef.ok).toBe(false);
  expect(state.registry.size).toBe(0);
});
