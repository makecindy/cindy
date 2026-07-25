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

test('shared dev rejects committed or working-tree migration artifacts before restart', () => {
  const fixture = createFixture();
  try {
    const migrationPath = path.join(fixture.drizzleDir, '0001_feature.sql');
    fs.writeFileSync(migrationPath, 'SELECT 1;\n');
    assert.throws(
      () => assertSharedDevMigrationPolicy(fixture.repo, ['--wait-ready']),
      /working tree: \?\? apps\/desktop\/drizzle\/0001_feature\.sql/,
    );
    git(fixture.repo, 'add', '.');
    git(fixture.repo, 'commit', '-m', 'feature migration');
    assert.throws(
      () => assertSharedDevMigrationPolicy(fixture.repo, ['--wait-ready']),
      /committed: apps\/desktop\/drizzle\/0001_feature\.sql/,
    );
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
