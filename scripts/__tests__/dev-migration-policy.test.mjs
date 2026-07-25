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

test('shared primary dev is blocked even without migration artifacts', () => {
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
    assert.throws(
      () => assertSharedDevMigrationPolicy(fixture.repo, ['--wait-ready']),
      /may upgrade the release database and prevent an older release from opening/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('migration artifact discovery remains available for diagnostics', () => {
  const fixture = createFixture();
  try {
    const migrationPath = path.join(fixture.drizzleDir, '0001_feature.sql');
    fs.writeFileSync(migrationPath, 'SELECT 1;\n');
    assert.deepEqual(findUnmergedMigrationArtifacts(fixture.repo).workingTree, [
      '?? apps/desktop/drizzle/0001_feature.sql',
    ]);
    git(fixture.repo, 'add', '.');
    git(fixture.repo, 'commit', '-m', 'feature migration');
    assert.deepEqual(findUnmergedMigrationArtifacts(fixture.repo).committed, [
      'apps/desktop/drizzle/0001_feature.sql',
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('passive shared dev may start without running migrations', () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(path.join(fixture.drizzleDir, '0001_feature.sql'), 'SELECT 1;\n');
    assert.doesNotThrow(() =>
      assertSharedDevMigrationPolicy(fixture.repo, ['--wait-ready', '--passive']),
    );
    assert.doesNotThrow(() =>
      assertSharedDevMigrationPolicy(fixture.repo, ['--wait-ready', '--preserve-running']),
    );
    assert.doesNotThrow(() =>
      assertSharedDevMigrationPolicy(
        fixture.repo,
        ['--wait-ready'],
        { XDT_SCHEDULER_PASSIVE: '1' },
      ),
    );
  } finally {
    fixture.cleanup();
  }
});

test('a userData override alone cannot bypass shared primary protection', () => {
  const fixture = createFixture();
  try {
    assert.throws(
      () =>
        assertSharedDevMigrationPolicy(
          fixture.repo,
          ['--wait-ready'],
          { XDT_USER_DATA_DIR: path.join(fixture.repo, 'Cindy') },
        ),
      /may upgrade the release database and prevent an older release from opening/,
    );
    assert.doesNotThrow(() =>
      assertSharedDevMigrationPolicy(
        fixture.repo,
        ['--wait-ready'],
        {
          XDT_ISOLATED: '1',
          XDT_USER_DATA_DIR: path.join(fixture.repo, 'Cindy-dev'),
        },
      ),
    );
  } finally {
    fixture.cleanup();
  }
});

test('an isolated declaration cannot point its override back to shared release userData', () => {
  const fixture = createFixture();
  try {
    const appData = String.raw`C:\Users\dev\AppData\Roaming`;
    const sharedUserData = path.win32.join(appData, 'Cindy');
    const linkedUserData = path.win32.join(appData, 'release-link');
    const env = {
      APPDATA: appData,
      XDT_ISOLATED: '1',
      XDT_USER_DATA_DIR: sharedUserData,
    };
    const windowsPathOptions = {
      platform: 'win32',
      realpath: (value) => value,
    };
    assert.throws(
      () =>
        assertSharedDevMigrationPolicy(fixture.repo, ['--wait-ready'], env, windowsPathOptions),
      /may upgrade the release database and prevent an older release from opening/,
    );
    assert.throws(
      () =>
        assertSharedDevMigrationPolicy(
          fixture.repo,
          ['--wait-ready'],
          { ...env, XDT_USER_DATA_DIR: linkedUserData },
          {
            platform: 'win32',
            realpath: (value) =>
              value.toLowerCase().endsWith('release-link') ? sharedUserData : value,
          },
        ),
      /may upgrade the release database and prevent an older release from opening/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('passive cannot bypass an isolated override targeting release userData', () => {
  const fixture = createFixture();
  try {
    const appData = String.raw`C:\Users\dev\AppData\Roaming`;
    assert.throws(
      () =>
        assertSharedDevMigrationPolicy(
          fixture.repo,
          ['--wait-ready', '--passive', '--isolated=feature'],
          {
            APPDATA: appData,
            XDT_USER_DATA_DIR: path.win32.join(appData, 'Cindy'),
          },
          { platform: 'win32', realpath: (value) => value },
        ),
      /may upgrade the release database and prevent an older release from opening/,
    );
  } finally {
    fixture.cleanup();
  }
});

test('all current and legacy release userData directories are protected', () => {
  const fixture = createFixture();
  try {
    const appData = String.raw`C:\Users\dev\AppData\Roaming`;
    for (const dirName of ['Cindy', 'CindyGlobal', 'CindyDev', 'xdt-maker']) {
      assert.throws(
        () =>
          assertSharedDevMigrationPolicy(
            fixture.repo,
            ['--wait-ready', '--isolated=feature'],
            {
              APPDATA: appData,
              XDT_USER_DATA_DIR: path.win32.join(appData, dirName),
            },
            { platform: 'win32', realpath: (value) => value },
          ),
        /may upgrade the release database and prevent an older release from opening/,
        dirName,
      );
    }
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

test('isolated dev remains allowed after migration becomes canonical on origin/main', () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(path.join(fixture.drizzleDir, '0001_feature.sql'), 'SELECT 1;\n');
    git(fixture.repo, 'add', '.');
    git(fixture.repo, 'commit', '-m', 'feature migration');
    assert.doesNotThrow(() => assertSharedDevMigrationPolicy(fixture.repo, ['--isolated=feature']));
    git(fixture.repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.doesNotThrow(() => assertSharedDevMigrationPolicy(fixture.repo, ['--isolated=feature']));
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
      /may upgrade the release database and prevent an older release from opening/,
    );
  } finally {
    fixture.cleanup();
  }
});
