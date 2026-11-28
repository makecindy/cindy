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
