/** Test value: switching the real checkout must preserve bytes, Git refs and task isolation.
 * Existing branchSync tests only update refs, never switch the directory or restore a named stash.
 * Minimal inputs: two branches, dirty/staged/untracked files, an occupied checkout and a running task.
 * Tier: git-integration, real Git with disposable repositories only.
 * Measured standalone after #10696 review: 11.17s wall / 9.83s test execution; subprocess I/O stays outside unit.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createCheckoutService, type CheckoutActivity } from '../checkout';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
let root: string;
let sequence = 0;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-checkout-'));
  fs.writeFileSync(path.join(root, 'gitconfig'), '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'gitconfig'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});
afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
function git(repo: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function fixture(withSide = false) {
  const repo = path.join(root, `repo-${++sequence}`);
  fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Cindy Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(repo, 'base'), 'base\n');
  if (withSide) fs.writeFileSync(path.join(repo, 'side'), 'side\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '-m', 'base');
  git(repo, 'branch', 'feature');
  let activity: CheckoutActivity[] = [];
  const service = createCheckoutService(async () => activity);
  return {
    repo,
    service,
    activity: (next: CheckoutActivity[]) => {
      activity = next;
    },
  };
}
async function switchTo(
  f: ReturnType<typeof fixture>,
  target = 'feature',
  strategy: 'carry' | 'stash' = 'carry',
) {
  const status = await f.service.status(f.repo, target);
  return f.service.switch(f.repo, target, status.current, status.fingerprint, strategy);
}
it('switches with staged and untracked changes and undoes without losing bytes or index state', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.repo, 'base'), 'staged\n');
  git(f.repo, 'add', 'base');
  fs.writeFileSync(path.join(f.repo, 'extra'), 'untracked\n');
  const result = await switchTo(f);
  expect(result.status.current).toBe('feature');
  expect(git(f.repo, 'show', ':base')).toBe('staged');
  expect((await f.service.undo(f.repo, result.receipt!.id)).status.current).toBe('main');
  expect(fs.readFileSync(path.join(f.repo, 'extra'), 'utf8')).toBe('untracked\n');
});
it('stores a reachable named stash, restores it on undo, and offers it after a later return', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.repo, 'base'), 'saved\n');
  git(f.repo, 'add', 'base');
  fs.writeFileSync(path.join(f.repo, 'extra'), 'extra');
  const result = await switchTo(f, 'feature', 'stash');
  expect(result.status.files).toEqual([]);
  expect(git(f.repo, 'stash', 'list')).toContain('Cindy: before switching to feature');
  expect((await f.service.undo(f.repo, result.receipt!.id)).status.current).toBe('main');
  expect(git(f.repo, 'show', ':base')).toBe('saved');
  expect(fs.readFileSync(path.join(f.repo, 'extra'), 'utf8')).toBe('extra');
  expect(git(f.repo, 'stash', 'list')).toBe('');
  await switchTo(f, 'feature', 'stash');
  const returned = await switchTo(f, 'main');
  expect(returned.status.stashes).toHaveLength(1);
  expect(
    (await f.service.restore(f.repo, returned.status.stashes[0].id, 'main')).status.files,
  ).toContain('base');
});
it('blocks overlapping changes and repository operations before checkout', async () => {
  const f = fixture();
  // Remote ref syntax alone permits '-option'; the resulting local branch must not.
  await expect(f.service.status(f.repo, 'refs/remotes/origin/--detach')).rejects.toThrow();
  expect(git(f.repo, 'branch', '--show-current')).toBe('main');
  git(f.repo, 'switch', 'feature');
  fs.writeFileSync(path.join(f.repo, 'base'), 'feature\n');
  git(f.repo, 'add', '.');
  git(f.repo, '-c', 'commit.gpgsign=false', 'commit', '-m', 'feature');
  git(f.repo, 'switch', 'main');
  fs.writeFileSync(path.join(f.repo, 'base'), 'user\n');
  expect((await f.service.status(f.repo, 'feature')).carryAllowed).toBe(false);
  expect((await switchTo(f)).blocked).toBe('conflict');
  expect(fs.readFileSync(path.join(f.repo, 'base'), 'utf8')).toBe('user\n');
  fs.writeFileSync(path.join(f.repo, '.git', 'CHERRY_PICK_HEAD'), git(f.repo, 'rev-parse', 'HEAD'));
  expect((await f.service.status(f.repo)).blocked).toBe('operation');
});
// Regression: path overlap is insufficient when the index already matches the target.
// Exercise the production preflight and switch; snapshots also prove the preview is read-only.
it.each(['matching-index', 'untracked-collision', 'ignored-collision', 'ignored-only'])(
  'predicts carry using Git without changing the index or files: %s',
  async (scenario) => {
    const f = fixture();
    git(f.repo, 'switch', 'feature');
    fs.writeFileSync(path.join(f.repo, 'base'), 'target\n');
    fs.writeFileSync(path.join(f.repo, 'new-file'), 'target\n');
    git(f.repo, 'add', '.');
    git(f.repo, '-c', 'commit.gpgsign=false', 'commit', '-m', 'target');
    git(f.repo, 'switch', 'main');
    if (scenario === 'matching-index') {
      fs.writeFileSync(path.join(f.repo, 'base'), 'target\n');
      git(f.repo, 'add', 'base');
      fs.writeFileSync(path.join(f.repo, 'loose'), 'precious\n');
    } else {
      fs.writeFileSync(path.join(f.repo, 'new-file'), 'user\n');
      if (scenario !== 'ignored-only') fs.writeFileSync(path.join(f.repo, 'unrelated'), 'keep\n');
      if (scenario === 'ignored-collision' || scenario === 'ignored-only')
        fs.appendFileSync(path.join(f.repo, '.git', 'info', 'exclude'), '\nnew-file\n');
    }
    const indexTree = git(f.repo, 'write-tree');
    const index = fs.readFileSync(path.join(f.repo, '.git', 'index'));
    const bytes = fs.readFileSync(path.join(f.repo, 'base'));
    const before = await f.service.status(f.repo, 'feature');
    expect(fs.readFileSync(path.join(f.repo, '.git', 'index'))).toEqual(index);
    expect(fs.readFileSync(path.join(f.repo, 'base'))).toEqual(bytes);
    expect(before.carryAllowed).toBe(scenario === 'matching-index');
    if (scenario === 'ignored-only') {
      expect(before.files).toEqual([]);
      expect(before.blocked).toBe('conflict');
      expect(before.ignoredCollision).toEqual({ branch: 'feature', paths: ['new-file'] });
    }
    const result = await f.service.switch(
      f.repo,
      'feature',
      before.current,
      before.fingerprint,
      'carry',
    );
    if (scenario === 'matching-index') {
      expect(result.blocked).toBeUndefined();
      expect(result.status.current).toBe('feature');
      expect(git(f.repo, 'show', ':base')).toBe('target');
      expect(fs.readFileSync(path.join(f.repo, 'base'), 'utf8')).toBe('target\n');
      expect((await f.service.undo(f.repo, result.receipt!.id)).blocked).toBeUndefined();
      expect(git(f.repo, 'branch', '--show-current')).toBe('main');
      expect(git(f.repo, 'write-tree')).toBe(indexTree);
      expect(fs.readFileSync(path.join(f.repo, 'base'))).toEqual(bytes);
      expect(fs.readFileSync(path.join(f.repo, 'loose'), 'utf8')).toBe('precious\n');
      expect(git(f.repo, 'ls-files', '--others', '--exclude-standard')).toBe('loose');
    } else {
      expect(result.blocked).toBe('conflict');
      expect(result.status.current).toBe('main');
      expect(git(f.repo, 'stash', 'list')).toBe('');
      expect(fs.readFileSync(path.join(f.repo, 'new-file'), 'utf8')).toBe('user\n');
    }
  },
);
it('attributes subdirectories and symlinks to the deepest checkout, excludes SSH, and blocks occupied branches', async () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.repo, 'sub'));
  const linked = path.join(f.repo, '.cindy-worktrees', 'linked');
  git(f.repo, 'worktree', 'add', linked, 'feature');
  fs.appendFileSync(path.join(f.repo, '.git', 'info', 'exclude'), '\n.cindy-worktrees/\n');
  const alias = path.join(root, `alias-${sequence}`);
  fs.symlinkSync(path.join(f.repo, 'sub'), alias, 'junction');
  const task = (id: string, workDir: string, running: boolean): CheckoutActivity => ({
    id,
    name: id,
    workDir,
    running,
  });
  f.activity([
    task('nested', linked, true),
    { ...task('ssh', f.repo, true), remoteHostId: 'ssh' },
    task('idle', alias, false),
  ]);
  expect((await f.service.status(f.repo)).sessions.map((s) => s.id)).toEqual(['idle']);
  expect((await f.service.status(f.repo, 'feature')).blocked).toBe('occupied');
  f.activity([task('busy', alias, true)]);
  expect((await f.service.status(f.repo)).blocked).toBe('busy');
});
it('rechecks running sessions at checkout and refuses undo after an external switch', async () => {
  const f = fixture();
  const before = await f.service.status(f.repo, 'feature');
  f.activity([{ id: 'busy', name: 'busy', workDir: f.repo, running: true }]);
  expect(
    (await f.service.switch(f.repo, 'feature', before.current, before.fingerprint, 'carry'))
      .blocked,
  ).toBe('busy');
  f.activity([]);
  const result = await switchTo(f);
  git(f.repo, 'switch', '-c', 'external');
  expect((await f.service.undo(f.repo, result.receipt!.id)).blocked).toBe('changed');
  expect(git(f.repo, 'branch', '--show-current')).toBe('external');
});
it('rejects stale dirty confirmation without creating a stash', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.repo, 'extra'), 'before');
  const before = await f.service.status(f.repo, 'feature');
  fs.writeFileSync(path.join(f.repo, 'extra'), 'after');
  expect(
    (await f.service.switch(f.repo, 'feature', before.current, before.fingerprint, 'stash'))
      .blocked,
  ).toBe('changed');
  expect(git(f.repo, 'stash', 'list')).toBe('');
});
it('fetches origin/main, fast-forwards local main, and undo retains fetched commits', async () => {
  const f = fixture();
  const remote = path.join(root, `remote-${sequence}.git`);
  git(root, 'clone', '--bare', f.repo, remote);
  git(f.repo, 'remote', 'add', 'origin', remote);
  git(f.repo, 'fetch', 'origin');
  const seed = path.join(root, `seed-${sequence}`);
  git(root, 'clone', remote, seed);
  git(seed, 'config', 'user.name', 'Cindy Test');
  git(seed, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(seed, 'new'), 'new');
  git(seed, 'add', '.');
  git(seed, '-c', 'commit.gpgsign=false', 'commit', '-m', 'new');
  git(seed, 'push', 'origin', 'main');
  git(f.repo, 'switch', 'feature');
  const result = await switchTo(f, 'refs/remotes/origin/main');
  expect(result.receipt?.fetchedCommits).toBe(1);
  expect(result.status.current).toBe('main');
  const fetched = git(seed, 'rev-parse', 'HEAD');
  expect(git(f.repo, 'rev-parse', 'main')).toBe(fetched);
  await f.service.undo(f.repo, result.receipt!.id);
  expect(git(f.repo, 'rev-parse', 'main')).toBe(fetched);
  expect(git(f.repo, 'branch', '--show-current')).toBe('feature');
  const unchanged = await switchTo(f, 'refs/remotes/origin/main');
  expect(unchanged.receipt?.fetchedCommits ?? 0).toBe(0);
});

// Dialog details must describe the actual staged + unstaged diff, not just paths.
it('reports optional text counts and new/deleted file kinds for the dialog', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.repo, 'base'), 'replacement\n');
  git(f.repo, 'add', 'base');
  fs.appendFileSync(path.join(f.repo, 'base'), 'more\n');
  fs.writeFileSync(path.join(f.repo, 'new-file'), 'new\n');
  const status = await f.service.status(f.repo, 'feature');
  expect(status.fileDetails?.base).toEqual({ added: 2, removed: 1 });
  expect(status.fileDetails?.['new-file']).toEqual({ kind: 'new' });
  expect((await f.service.status(f.repo)).fileDetails).toBeUndefined();
  fs.unlinkSync(path.join(f.repo, 'base'));
  expect((await f.service.status(f.repo, 'feature')).fileDetails?.base?.kind).toBe('deleted');
});

// The preview is bounded even for path names that are also Git pathspec patterns.
it('limits line counts to the first three dirty files using literal paths', async () => {
  const f = fixture();
  const names = ['[a-z]', ...Array.from({ length: 9 }, (_, i) => String.fromCharCode(97 + i))];
  for (const name of names) fs.writeFileSync(path.join(f.repo, name), 'before\n');
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-m', 'preview files');
  for (const name of names) fs.writeFileSync(path.join(f.repo, name), 'after\nextra\n');
  const status = await f.service.status(f.repo, 'feature');
  expect(status.files).toHaveLength(10);
  expect(Object.keys(status.fileDetails ?? {}).sort()).toEqual(status.files.slice(0, 3).sort());
  for (const detail of Object.values(status.fileDetails ?? {}))
    expect(detail).toEqual({ added: 2, removed: 1 });
});

// PR #10696: carry may absorb staged content. Undo must restore both Git trees,
// not merely move HEAD; reuse matching-index above, and one repo for partial/recovery.
it('restores absorbed index and working content without touching untracked files', async () => {
  const f = fixture(true);
  git(f.repo, 'switch', 'feature');
  fs.writeFileSync(path.join(f.repo, 'base'), 'target\n');
  git(f.repo, 'commit', '-am', 'target');
  git(f.repo, 'switch', 'main');
  fs.writeFileSync(path.join(f.repo, 'loose'), 'precious\n');
  {
    fs.writeFileSync(path.join(f.repo, 'base'), 'target\n');
    git(f.repo, 'add', 'base');
    fs.writeFileSync(path.join(f.repo, 'base'), 'working\n');
    fs.writeFileSync(path.join(f.repo, 'side'), 'side changed\n');
    git(f.repo, 'add', 'side');
    const index = git(f.repo, 'write-tree');
    const bytes = fs.readFileSync(path.join(f.repo, 'base'), 'utf8');
    const switched = await switchTo(f);
    expect(switched.blocked).toBeUndefined();
    fs.writeFileSync(path.join(f.repo, 'base'), 'external edit\n');
    expect((await f.service.undo(f.repo, switched.receipt!.id)).blocked).toBe('changed');
    expect(fs.readFileSync(path.join(f.repo, 'base'), 'utf8')).toBe('external edit\n');
    fs.writeFileSync(path.join(f.repo, 'base'), bytes);
    const undone = await f.service.undo(f.repo, switched.receipt!.id);
    expect(undone.blocked).toBeUndefined();
    expect(git(f.repo, 'branch', '--show-current')).toBe('main');
    expect(git(f.repo, 'write-tree')).toBe(index);
    expect(fs.readFileSync(path.join(f.repo, 'base'), 'utf8')).toBe(bytes);
    expect(fs.readFileSync(path.join(f.repo, 'loose'), 'utf8')).toBe('precious\n');
    expect(git(f.repo, 'ls-files', '--others', '--exclude-standard')).toBe('loose');
    expect(fs.readFileSync(path.join(f.repo, 'side'), 'utf8')).toBe('side changed\n');
    git(f.repo, 'restore', '--source=HEAD', '--staged', '--worktree', '--', 'base');
  }
  // A failing checkout hook must leave the pre-switch content reachable.
  fs.writeFileSync(path.join(f.repo, 'base'), 'target\n');
  git(f.repo, 'add', 'base');
  const index = git(f.repo, 'write-tree');
  const switched = await switchTo(f);
  fs.writeFileSync(path.join(f.repo, '.git/hooks/post-checkout'), '#!/bin/sh\nexit 1\n', {
    mode: 0o755,
  });
  expect((await f.service.undo(f.repo, switched.receipt!.id)).blocked).toBe('git');
  expect(git(f.repo, 'stash', 'list')).toContain('Cindy: undo recovery');
  fs.unlinkSync(path.join(f.repo, '.git/hooks/post-checkout'));
  git(f.repo, 'switch', 'main');
  git(f.repo, 'stash', 'apply', '--index', 'stash@{0}');
  expect(git(f.repo, 'write-tree')).toBe(index);
  expect(fs.readFileSync(path.join(f.repo, 'base'), 'utf8')).toBe('target\n');
  expect(fs.readFileSync(path.join(f.repo, 'loose'), 'utf8')).toBe('precious\n');
  expect(git(f.repo, 'ls-files', '--others', '--exclude-standard')).toBe('loose');
});
