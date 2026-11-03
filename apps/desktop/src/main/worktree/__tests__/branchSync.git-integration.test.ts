/** Test value: real branchSync entry points must fetch one ref and only fast-forward.
 * No previous suite covers this manual action. Minimal inputs: one bare remote,
 * two diverging commits / an overlapping dirty file / a branch in another checkout.
 * Tier: git-integration (real Git ref/index/worktree semantics, no network).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { readBranchSyncStatus, readOriginDefaultBranch, syncBranch } from '../branchSync';
import * as gitModule from '../gitExec';
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
let root: string;
let remote: string;
let seed: string;
let sequence = 0;
function git(cwd: string, ...args: string[]) {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Cindy Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' },
    },
  ).trim();
}
function commit(cwd: string, file: string, content: string) {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', '--', file);
  git(cwd, 'commit', '-m', file);
  return git(cwd, 'rev-parse', 'HEAD');
}
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-branch-sync-'));
  // Git for Windows does not accept Node's \\.\nul as a config file. An empty
  // fixture also isolates production syncBranch calls from the user's config.
  fs.writeFileSync(path.join(root, 'gitconfig'), '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'gitconfig'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  seed = path.join(root, 'seed');
  remote = path.join(root, 'remote.git');
  fs.mkdirSync(seed);
  git(seed, 'init', '-b', 'main');
  commit(seed, 'base', 'base');
  git(root, 'clone', '--bare', seed, remote);
  git(seed, 'remote', 'add', 'origin', remote);
});
afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const branch = `case-${++sequence}`;
  const repo = path.join(root, branch);
  git(root, 'clone', remote, repo);
  git(repo, 'checkout', '-b', branch);
  git(repo, 'push', '-u', 'origin', branch);
  git(seed, 'checkout', '-B', branch, 'main');
  return {
    repo,
    branch,
    req: { baseRepo: repo, branch },
    advance: (file = 'base') => {
      const sha = commit(seed, file, `remote-${branch}`);
      git(seed, 'push', 'origin', branch);
      return sha;
    },
  };
}
it('fetches and fast-forwards the checked-out branch while preserving unrelated dirty files', async () => {
  const f = fixture();
  const sha = f.advance();
  fs.writeFileSync(path.join(f.repo, 'keep'), 'uncommitted');
  const result = await syncBranch(f.req);
  expect(result.updated).toBe(1);
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(sha);
  expect(fs.readFileSync(path.join(f.repo, 'base'), 'utf8')).toBe(`remote-${f.branch}`);
  expect(fs.readFileSync(path.join(f.repo, 'keep'), 'utf8')).toBe('uncommitted');
  expect(result.status.dirtyFiles).toBe(1);
});
// Regression: unpack-objects is silent while receiving a single large blob.
// The real sync entry must select a receiver that emits byte progress even for
// fewer than 100 objects; fake progress tests cannot detect the wrong Git mode.
it('reports receiving progress for a small object count instead of silently unpacking it', async () => {
  const f = fixture();
  f.advance();
  const original = gitModule.gitExec;
  const progress: string[] = [];
  const spy = vi.spyOn(gitModule, 'gitExec').mockImplementation(async (...args) => {
    const result = await original(...args);
    if (args[0].includes('--progress')) progress.push(result.stderr);
    return result;
  });
  try {
    expect((await syncBranch(f.req)).updated).toBe(1);
    expect(progress.join('')).toMatch(/Receiving objects:.*100%/);
  } finally {
    spy.mockRestore();
  }
});
it('updates an unchecked local ref without changing the current checkout', async () => {
  const f = fixture();
  const sha = f.advance();
  git(f.repo, 'checkout', 'main');
  const before = git(f.repo, 'rev-parse', 'HEAD');
  expect((await syncBranch(f.req)).updated).toBe(1);
  expect(git(f.repo, 'rev-parse', f.branch)).toBe(sha);
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(before);
});
it('fast-forwards the directory where the selected branch is checked out, including linked worktrees', async () => {
  const f = fixture();
  git(f.repo, 'checkout', 'main');
  const checkout = path.join(root, 'linked');
  git(f.repo, 'worktree', 'add', checkout, f.branch);
  const sha = f.advance();
  const result = await syncBranch(f.req);
  expect(result.status.checkoutPath).toBe(fs.realpathSync(checkout).replaceAll('\\', '/'));
  expect(git(checkout, 'rev-parse', 'HEAD')).toBe(sha);
  expect(fs.readFileSync(path.join(checkout, 'base'), 'utf8')).toBe(`remote-${f.branch}`);
});
it('leaves divergent branches unchanged', async () => {
  const f = fixture();
  const local = commit(f.repo, 'local', 'local');
  f.advance();
  const result = await syncBranch(f.req);
  expect(result.status).toMatchObject({ blocked: 'diverged', ahead: 1, behind: 1 });
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(local);
});
it.each(['tracked', 'untracked'])(
  'blocks overlapping %s changes and keeps their bytes',
  async (kind) => {
    const f = fixture();
    const file = kind === 'tracked' ? 'base' : 'new-file';
    f.advance(file);
    fs.writeFileSync(path.join(f.repo, file), 'user changes');
    const before = git(f.repo, 'rev-parse', 'HEAD');
    expect((await syncBranch(f.req)).status.blocked).toBe('conflict');
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(fs.readFileSync(path.join(f.repo, file), 'utf8')).toBe('user changes');
  },
);
it('retains unpushed local commits and reports already-current on the next fetch', async () => {
  const f = fixture();
  const local = commit(f.repo, 'local', 'local');
  expect(await syncBranch(f.req)).toMatchObject({ updated: 0, status: { ahead: 1, behind: 0 } });
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(local);
  git(f.repo, 'push');
  expect(await syncBranch(f.req)).toMatchObject({ updated: 0, status: { ahead: 0, behind: 0 } });
});
it('fetches a remote-only source without touching a same-named local branch', async () => {
  const f = fixture();
  const before = git(f.repo, 'rev-parse', 'HEAD');
  git(f.repo, 'branch', `origin/${f.branch}`);
  const sha = f.advance();
  const result = await syncBranch({ baseRepo: f.repo, branch: `refs/remotes/origin/${f.branch}` });
  expect(result.updated).toBe(1);
  expect(git(f.repo, 'rev-parse', `refs/remotes/origin/${f.branch}`)).toBe(sha);
  expect(git(f.repo, 'rev-parse', `refs/heads/origin/${f.branch}`)).toBe(before);
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(before);
});
it('honors a configured tracking remote and branch rather than origin/same-name', async () => {
  const f = fixture();
  const sha = f.advance();
  git(f.repo, 'remote', 'rename', 'origin', 'upstream');
  git(f.repo, 'branch', '-m', 'renamed');
  const result = await syncBranch({ baseRepo: f.repo, branch: 'renamed' });
  expect(result.status).toMatchObject({ remote: 'upstream', remoteBranch: f.branch });
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(sha);
});
it('falls back to origin/same-name without upstream configuration; disables missing refs and remotes', async () => {
  const f = fixture();
  git(f.repo, 'branch', '--unset-upstream');
  expect(await readBranchSyncStatus(f.req)).toMatchObject({
    remote: 'origin',
    remoteBranch: f.branch,
  });
  git(f.repo, 'update-ref', '-d', `refs/remotes/origin/${f.branch}`);
  expect((await readBranchSyncStatus(f.req)).blocked).toBeUndefined();
  expect((await syncBranch(f.req)).status.blocked).toBeUndefined();
  git(f.repo, 'push', 'origin', '--delete', f.branch);
  expect((await syncBranch(f.req)).status.blocked).toBe('missing-remote');
  git(f.repo, 'remote', 'remove', 'origin');
  fs.writeFileSync(path.join(f.repo, 'dirty-without-remote'), 'user changes');
  expect((await syncBranch(f.req)).status).toMatchObject({ blocked: 'no-remote', dirtyFiles: 1 });
});
it('uses a valid origin/HEAD, otherwise main then master, and never upstream', async () => {
  const f = fixture();
  git(f.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${f.branch}`);
  expect(await readOriginDefaultBranch(f.repo)).toBe(`refs/remotes/origin/${f.branch}`);
  git(f.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/missing');
  expect(await readOriginDefaultBranch(f.repo)).toBe('refs/remotes/origin/main');
  git(f.repo, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  expect(await readOriginDefaultBranch(f.repo)).toBe('refs/remotes/origin/main');
  git(f.repo, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
  git(f.repo, 'update-ref', '-d', 'refs/remotes/origin/main');
  expect(await readOriginDefaultBranch(f.repo)).toBe('refs/remotes/origin/master');
  git(f.repo, 'update-ref', '-d', 'refs/remotes/origin/master');
  git(f.repo, 'update-ref', 'refs/remotes/upstream/main', 'HEAD');
  expect(await readOriginDefaultBranch(f.repo)).toBeUndefined();
});

it('keeps HEAD, staged content and dirty bytes when Git discovers an overlap after the preflight', async () => {
  const f = fixture();
  f.advance();
  const before = git(f.repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(f.repo, 'staged'), 'staged change');
  git(f.repo, 'add', 'staged');
  git(f.repo, 'config', 'merge.autostash', 'true');
  const index = git(f.repo, 'ls-files', '--stage');
  const realGit = gitModule.gitExec;
  const spy = vi.spyOn(gitModule, 'gitExec').mockImplementation(async (args, cwd, opts) => {
    if (args[0] === 'merge') fs.writeFileSync(path.join(f.repo, 'base'), 'arrived during fetch');
    return realGit(args, cwd, opts);
  });
  try {
    expect((await syncBranch(f.req)).status.blocked).toBe('conflict');
    expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(f.repo, 'ls-files', '--stage')).toBe(index);
    expect(fs.readFileSync(path.join(f.repo, 'base'), 'utf8')).toBe('arrived during fetch');
    expect(fs.readFileSync(path.join(f.repo, 'staged'), 'utf8')).toBe('staged change');
    expect(git(f.repo, 'stash', 'list')).toBe('');
  } finally {
    spy.mockRestore();
  }
});
it('disables a branch with no upstream when only a non-origin remote is configured', async () => {
  const f = fixture();
  git(f.repo, 'branch', '--unset-upstream');
  git(f.repo, 'remote', 'rename', 'origin', 'upstream');
  expect((await readBranchSyncStatus(f.req)).blocked).toBe('no-remote');
});

// PR #7059 regressions, git-integration tier: preflight checks alone cannot
// protect duplicate checkouts, ignored local files, or a checkout before writing.
// Existing clean/dirty fast-forward cases do not exercise these Git behaviors.
it('refuses a branch forced into multiple worktrees without changing either checkout', async () => {
  const f = fixture();
  const checkout = path.join(root, 'duplicate-checkout');
  git(f.repo, 'worktree', 'add', '--force', checkout, f.branch);
  f.advance();
  const snapshot = (cwd: string) => ({
    head: git(cwd, 'rev-parse', 'HEAD'),
    index: git(cwd, 'ls-files', '--stage'),
    bytes: fs.readFileSync(path.join(cwd, 'base'), 'utf8'),
  });
  const before = [snapshot(f.repo), snapshot(checkout)];
  expect((await readBranchSyncStatus(f.req)).blocked).toBe('multiple-checkouts');
  expect(await syncBranch(f.req)).toMatchObject({
    updated: 0,
    status: { blocked: 'multiple-checkouts' },
  });
  expect([snapshot(f.repo), snapshot(checkout)]).toEqual(before);
  expect(git(f.repo, 'rev-parse', f.branch)).toBe(before[0].head);
});

it('refuses to overwrite an ignored file with a remotely tracked file', async () => {
  const f = fixture();
  f.advance('config.json');
  fs.appendFileSync(
    path.resolve(f.repo, git(f.repo, 'rev-parse', '--git-path', 'info/exclude')),
    '\nconfig.json\n',
  );
  fs.writeFileSync(path.join(f.repo, 'config.json'), 'local ignored configuration');
  const before = git(f.repo, 'rev-parse', 'HEAD');
  const index = git(f.repo, 'ls-files', '--stage');
  expect(git(f.repo, 'status', '--porcelain')).toBe('');
  expect(await syncBranch(f.req)).toMatchObject({ updated: 0, status: { blocked: 'conflict' } });
  expect(git(f.repo, 'rev-parse', 'HEAD')).toBe(before);
  expect(git(f.repo, 'ls-files', '--stage')).toBe(index);
  expect(fs.readFileSync(path.join(f.repo, 'config.json'), 'utf8')).toBe(
    'local ignored configuration',
  );
});

it('refuses an unchecked-branch write if another worktree checks it out after preflight', async () => {
  const f = fixture();
  f.advance();
  const before = git(f.repo, 'rev-parse', f.branch);
  git(f.repo, 'checkout', 'main');
  const checkout = path.join(root, 'late-checkout');
  let index: string | undefined;
  const realGit = gitModule.gitExec;
  const spy = vi.spyOn(gitModule, 'gitExec').mockImplementation(async (args, cwd, opts) => {
    if (args[0] === 'fetch' && args.includes('.')) {
      git(f.repo, 'worktree', 'add', checkout, f.branch);
      index = git(checkout, 'ls-files', '--stage');
    }
    return realGit(args, cwd, opts);
  });
  try {
    expect(await syncBranch(f.req)).toMatchObject({ updated: 0, status: { blocked: 'changed' } });
    expect(index).toBeDefined();
    expect(git(f.repo, 'rev-parse', f.branch)).toBe(before);
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(checkout, 'ls-files', '--stage')).toBe(index);
    expect(fs.readFileSync(path.join(checkout, 'base'), 'utf8')).toBe('base');
  } finally {
    spy.mockRestore();
  }
});
