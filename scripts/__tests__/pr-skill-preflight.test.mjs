/**
 * /pr pre-push checks in a throwaway Git repository (no network). The rules must hold in any
 * repository: DCO is checked only when the repository declares it, merge commits are skipped
 * as the DCO check skips them, and the default branch is never a PR source.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { preflight } from '../../apps/desktop/resources/system-skills/pr/scripts/pr-preflight.mjs';

function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-preflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git'), work = path.join(root, 'work');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'clone', '-q', remote, work);
  for (const [k, v] of [['user.name', 'Ada'], ['user.email', 'ada@example.com'], ['commit.gpgsign', 'false']]) git(work, 'config', k, v);
  const commit = (file, ...flags) => { fs.writeFileSync(path.join(work, file), file); git(work, 'add', file); git(work, 'commit', '-q', ...flags, '-m', file); };
  commit('README.md');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'remote', 'set-head', 'origin', 'main');
  return { work, git, commit };
}

test('blocks the default branch, checks DCO only when declared, and skips merge commits', (t) => {
  const { work, git, commit } = repo(t);
  assert.match(preflight(work).blocks.join('\n'), /default branch main/);

  git(work, 'checkout', '-q', '-b', 'fix');
  commit('a.txt');
  assert.deepEqual(preflight(work).blocks, [], 'no DCO file: unsigned commits are fine');

  fs.writeFileSync(path.join(work, 'DCO'), 'dco');
  git(work, 'add', 'DCO');
  git(work, 'commit', '-q', '-s', '-m', 'dco');
  assert.match(preflight(work).blocks.join('\n'), /DCO sign-off.*: [0-9a-f]{8}\./, 'the unsigned a.txt commit');

  git(work, 'reset', '-q', '--hard', 'origin/main');
  fs.writeFileSync(path.join(work, 'DCO'), 'dco');
  git(work, 'add', 'DCO');
  git(work, 'commit', '-q', '-s', '-m', 'dco');
  git(work, 'checkout', '-q', '-b', 'side', 'origin/main');
  commit('b.txt', '-s');
  git(work, 'checkout', '-q', 'fix');
  git(work, 'merge', '-q', '--no-ff', '--no-edit', 'side');
  const result = preflight(work);
  assert.deepEqual(result.blocks, [], 'a merge commit needs no sign-off');
  assert.ok(result.notes.some((n) => /not pushed/.test(n)));
});
