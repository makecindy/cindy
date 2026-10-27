import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyWorktree, parseWorktreeStatus } from '../repo-worktrees.mjs';

// Regression: a new worktree starts at a commit already in main. Git ancestry
// cannot establish that its owning task is finished or that removal is safe.
// The report must also retain OPEN PR and unreadable-status evidence. Unit tier;
// classifyWorktree is the same production entry used by the CLI, without I/O.
const cleanTask = {
  branch: 'feature/current-task',
  detached: false,
  dirty: 0,
  inBase: true,
  upstream: 'none',
  aheadOfUpstream: null,
  pr: null,
};

// Entry-point regression: Node resolves import.meta.url, but argv may retain a
// directory symlink (including macOS /var temp paths). The CLI must actually run.
test('the CLI works through a linked directory without requiring a repository for help', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-worktree-report-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const link = path.join(root, 'scripts');
  try {
    fs.symlinkSync(fileURLToPath(new URL('..', import.meta.url)), link, 'junction');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    t.skip(`directory links unavailable: ${error.code}`);
    return;
  }
  const output = execFileSync(process.execPath, [path.join(link, 'repo-worktrees.mjs'), '--help'], {
    cwd: root, encoding: 'utf8',
  });
  assert.match(output, /clean HEAD in base/);
  assert.match(output, /不判定任何工作区可删除/);
});

test('a clean task at the base commit reports ancestry without authorizing cleanup', () => {
  assert.equal(classifyWorktree(cleanTask), 'clean HEAD in base');
});

test('an open PR remains active even when its current HEAD is in base', () => {
  assert.equal(classifyWorktree({ ...cleanTask, pr: { state: 'OPEN' } }), 'active PR');
});

test('an open PR remains active when upstream status is unknown', () => {
  assert.equal(classifyWorktree({
    ...cleanTask,
    inBase: false,
    upstream: 'origin/feature-current-task',
    aheadOfUpstream: null,
    pr: { state: 'OPEN' },
  }), 'active PR');
});

test('unreadable status is not reported as clean', () => {
  assert.equal(classifyWorktree({ ...cleanTask, ...parseWorktreeStatus(null) }), 'status unavailable');
  assert.equal(classifyWorktree({ ...cleanTask, ...parseWorktreeStatus('') }), 'clean HEAD in base');
});

test('a feature branch with unknown upstream status is not reported as clean', () => {
  assert.equal(classifyWorktree({
    ...cleanTask,
    inBase: false,
    upstream: 'origin/feature-current-task',
    aheadOfUpstream: null,
  }), 'status unavailable');
});

test('main with unknown upstream status is not reported as clean', () => {
  assert.equal(classifyWorktree({
    ...cleanTask,
    branch: 'main',
    inBase: false,
    upstream: 'origin/main',
    aheadOfUpstream: null,
  }), 'status unavailable');
});

test('existing dirty and unpushed work remain visible', () => {
  for (const [patch, expected] of [
    [{ detached: true, dirty: 1 }, 'detached dirty danger'],
    [{ dirty: 1 }, 'HEAD merged, worktree dirty'],
    [{ dirty: 1, inBase: false }, 'dirty WIP'],
    [{ inBase: false }, 'local unpushed feature'],
    [{ inBase: false, upstream: 'origin/feature', aheadOfUpstream: 1 }, 'local unpushed feature'],
  ])
    assert.equal(classifyWorktree({ ...cleanTask, ...patch }), expected);
});
