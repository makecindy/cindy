// Test value: the production migration policy must reject unreviewed personal-history
// changes while allowing only the reviewed prefix and canonical upstream additions.
// Regression: a personal checkout with a reused migration slot could otherwise start
// against a schema the application cannot safely apply. The default unit tier keeps
// one real-Git rejection smoke; these ref and history combinations need isolated Git
// repositories and therefore run only in the git-integration tier.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  assertSharedDevMigrationPolicy,
  findUnmergedMigrationArtifacts,
} from '../dev-migration-policy.mjs';

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function createFixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-dev-migration-policy-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Dev Migration Policy Test');
  git(repo, 'config', 'user.email', 'dev-migration-policy@example.invalid');
  const drizzleDir = path.join(repo, 'apps', 'desktop', 'drizzle');
  fs.mkdirSync(drizzleDir, { recursive: true });
  fs.writeFileSync(path.join(drizzleDir, '0000_init.sql'), 'SELECT 0;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial migration');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git(repo, 'switch', '-c', 'feature');
  return {
    repo,
    drizzleDir,
    cleanup: () => fs.rmSync(repo, { recursive: true, force: true }),
  };
}

test('shared dev allows branches without migration artifacts', () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(path.join(fixture.repo, 'README.md'), 'feature\n');
    git(fixture.repo, 'add', 'README.md');
    git(fixture.repo, 'commit', '-m', 'non-migration feature');
    assert.deepEqual(findUnmergedMigrationArtifacts(fixture.repo), {
      baseRef: 'origin/main',
      committed: [],
      workingTree: [],
    });
    assert.doesNotThrow(() => assertSharedDevMigrationPolicy(fixture.repo, ['--wait-ready']));
  } finally {
    fixture.cleanup();
  }
});

test('named isolated dev may run an unmerged migration', () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(path.join(fixture.drizzleDir, '0001_feature.sql'), 'SELECT 1;\n');
    assert.doesNotThrow(() =>
      assertSharedDevMigrationPolicy(fixture.repo, ['--wait-ready', '--isolated=feature']),
    );
  } finally {
    fixture.cleanup();
  }
});

test('migration becomes shared-safe only after it is canonical on origin/main', () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(path.join(fixture.drizzleDir, '0001_feature.sql'), 'SELECT 1;\n');
    git(fixture.repo, 'add', '.');
    git(fixture.repo, 'commit', '-m', 'feature migration');
    assert.throws(() => assertSharedDevMigrationPolicy(fixture.repo, []));
    git(fixture.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.doesNotThrow(() => assertSharedDevMigrationPolicy(fixture.repo, []));
  } finally {
    fixture.cleanup();
  }
});

test('stale origin/HEAD cannot replace origin/main as the migration baseline', () => {
  const fixture = createFixture();
  try {
    const migrationPath = path.join(fixture.drizzleDir, '0001_release_only.sql');
    fs.writeFileSync(migrationPath, 'SELECT 1;\n');
    git(fixture.repo, 'add', '.');
    git(fixture.repo, 'commit', '-m', 'release-only migration');
    git(fixture.repo, 'update-ref', 'refs/remotes/origin/release', 'HEAD');
    git(
      fixture.repo,
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/release',
    );

    assert.deepEqual(findUnmergedMigrationArtifacts(fixture.repo), {
      baseRef: 'origin/main',
      committed: ['apps/desktop/drizzle/0001_release_only.sql'],
      workingTree: [],
    });
    assert.throws(
      () => assertSharedDevMigrationPolicy(fixture.repo, []),
      /committed: apps\/desktop\/drizzle\/0001_release_only\.sql/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('personal startup follows upstream additions while protecting the reviewed prefix', t => {
  const fixture = createFixture();
  t.after(fixture.cleanup);
  const { repo, drizzleDir } = fixture;
  const write = (file, data) => {
    const dest = path.join(drizzleDir, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  };
  const journalFile = 'meta/_journal.json';
  const initial = { version: '6', entries: [{ idx: 0, tag: '0000_init', when: 1 }] };
  const commit = message => {
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', message);
    return git(repo, 'rev-parse', 'HEAD');
  };
  const check = () => assertSharedDevMigrationPolicy(repo, ['--shared']);
  write(journalFile, JSON.stringify(initial));
  write('meta/0000_snapshot.json', '{}');
  write('scripts/0000_init.ts', 'export {};');
  const anchor = commit('canonical migration');
  git(repo, 'branch', 'upstream', anchor);
  git(repo, 'update-ref', 'refs/remotes/origin/main', anchor);

  git(repo, 'mv', path.join(drizzleDir, '0000_init.sql'), path.join(drizzleDir, '0000_personal.sql'));
  write(journalFile, JSON.stringify({ ...initial, entries: [{ ...initial.entries[0], tag: '0000_personal' }] }));
  const sourceCommit = commit('deployed personal layout');
  const key = 'cindy.reviewedMigrationPrefix';
  const reviewed = sourceCommit + ' ' + anchor;
  assert.throws(check, /not canonical/);
  // Even a tracked include with the correct hashes cannot grant approval.
  fs.writeFileSync(path.join(repo, 'review.gitconfig'), '[cindy]\nreviewedMigrationPrefix = ' + reviewed + '\n');
  commit('candidate contains its own review');
  git(repo, 'config', '--local', 'include.path', path.join(repo, 'review.gitconfig'));
  assert.throws(check, /not canonical/);
  for (const invalid of [sourceCommit + ' main', anchor + ' ' + anchor, sourceCommit + ' ' + sourceCommit]) {
    git(repo, 'config', '--local', key, invalid);
    assert.throws(check, /not canonical/);
  }
  git(repo, 'config', '--local', key, reviewed);
  git(repo, 'config', '--local', '--add', key, reviewed);
  assert.throws(check, /not canonical/);
  git(repo, 'config', '--local', '--replace-all', key, reviewed);
  assert.doesNotThrow(check);
  assert.throws(() => assertSharedDevMigrationPolicy(repo, []), /not canonical/);

  git(repo, 'switch', 'upstream');
  const appended = structuredClone(initial);
  for (const idx of [1, 2]) {
    const number = String(idx).padStart(4, '0');
    const tag = number + '_next';
    appended.entries.push({ idx, tag, when: idx + 1 });
    write(tag + '.sql', 'SELECT 1;');
    write('scripts/' + tag + '.ts', 'export {};');
    write('meta/' + number + '_snapshot.json', '{}');
    write(journalFile, JSON.stringify(appended));
    git(repo, 'update-ref', 'refs/remotes/origin/main', commit('append ' + number));
  }
  const good = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', 'feature');
  assert.doesNotThrow(check);
  write('0000_personal.sql', 'SELECT 99;');
  assert.throws(check, /working tree:/);
  git(repo, 'restore', 'apps/desktop/drizzle/0000_personal.sql');
  for (const [name, mutation] of [
    ['missing appended SQL', () => fs.unlinkSync(path.join(drizzleDir, '0001_next.sql'))],
    ['skipped journal sequence', () => write(journalFile, JSON.stringify({
      ...appended, entries: [initial.entries[0], appended.entries[2]],
    }))],
    ['old SQL', () => write('0000_init.sql', 'SELECT 2;')],
    ['old companion', () => write('scripts/0000_init.ts', 'throw Error();')],
    ['deleted snapshot', () => fs.unlinkSync(path.join(drizzleDir, 'meta/0000_snapshot.json'))],
    ['edited journal history', () => write(journalFile, JSON.stringify({
      ...appended, entries: [{ ...initial.entries[0], when: 99 }, ...appended.entries.slice(1)],
    }))],
    ['unreviewed slot reuse', () => write('0000_extra.sql', 'SELECT 3;')],
    ['unrelated runtime file', () => write('scripts/package.json', '{}')],
  ]) {
    git(repo, 'switch', '--detach', good);
    mutation();
    git(repo, 'update-ref', 'refs/remotes/origin/main', commit(name));
    git(repo, 'switch', 'feature');
    assert.throws(check, /not canonical/, name);
  }

  git(repo, 'update-ref', 'refs/remotes/origin/main', good);
  write('0003_unreviewed.sql', 'SELECT 3;');
  commit('candidate changed');
  assert.throws(check, /not canonical/);
});
