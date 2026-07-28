/**
 * git-snapshot createSnapshot kernel tests with real temporary repositories.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TestDirectoryTemplate } from '../../test/vitest/testDirectoryTemplate';
import {
  createSnapshot,
  createSnapshotDetailed,
  createSnapshotMarker,
  listSnapshots,
  SnapshotBlockedByGitStateError,
  SnapshotUnsafeFilesError,
} from '../git-snapshot/gitSnapshotService';
import { parseSnapshotCommit } from '../git-snapshot/snapshotTrailers';
import { gitExec } from '../worktree/gitExec';

let repoPath: string;
const REAL_GIT_TEST_TIMEOUT_MS = 20_000;
const originalGitLocaleEnv = {
  LC_ALL: process.env.LC_ALL,
  LANG: process.env.LANG,
  LANGUAGE: process.env.LANGUAGE,
};

const repoTemplate = new TestDirectoryTemplate('xdt-create-snapshot-', async (dir) => {
  await gitExec(['init'], dir);
  await gitExec(['config', 'user.email', 'test@xdt.local'], dir);
  await gitExec(['config', 'user.name', 'XDT Test'], dir);
  await gitExec(['config', 'commit.gpgsign', 'false'], dir);
  await gitExec(['config', 'core.autocrlf', 'false'], dir);
});

async function writeRepoFile(gitPath: string, content: string | Buffer): Promise<void> {
  const filePath = path.join(repoPath, ...gitPath.split('/'));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function commitSeed(): Promise<string> {
  await writeRepoFile('seed.txt', 'seed\n');
  await gitExec(['add', '-A'], repoPath);
  await gitExec(['commit', '--no-gpg-sign', '-m', 'seed'], repoPath);
  return head();
}

async function head(): Promise<string> {
  const { stdout } = await gitExec(['rev-parse', 'HEAD'], repoPath);
  return stdout.trim();
}

async function currentBranch(): Promise<string> {
  const { stdout } = await gitExec(['branch', '--show-current'], repoPath);
  return stdout.trim();
}

async function gitInternalPath(marker: string): Promise<string> {
  const { stdout } = await gitExec(['rev-parse', '--git-path', marker], repoPath);
  const gitPath = stdout.trim();
  return path.isAbsolute(gitPath) ? gitPath : path.resolve(repoPath, gitPath);
}

async function headMessage(): Promise<string> {
  const { stdout } = await gitExec(['log', '-1', '--format=%B'], repoPath);
  return stdout;
}

async function headChangedFiles(): Promise<string[]> {
  const { stdout } = await gitExec(['show', '--name-only', '--format=', 'HEAD'], repoPath);
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

async function headFile(gitPath: string): Promise<string> {
  const { stdout } = await gitExec(['show', `HEAD:${gitPath}`], repoPath);
  return stdout;
}

async function commitPlainEmpty(message: string): Promise<string> {
  await gitExec(['commit', '--allow-empty', '--no-gpg-sign', '-m', message], repoPath);
  return head();
}

async function statusShort(): Promise<string> {
  const { stdout } = await gitExec(['status', '--porcelain=v1'], repoPath);
  return stdout.trimEnd();
}

beforeEach(async () => {
  process.env.LC_ALL = 'C';
  process.env.LANG = 'C';
  delete process.env.LANGUAGE;
  repoPath = await repoTemplate.createCopy();
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  if (originalGitLocaleEnv.LC_ALL === undefined) delete process.env.LC_ALL;
  else process.env.LC_ALL = originalGitLocaleEnv.LC_ALL;
  if (originalGitLocaleEnv.LANG === undefined) delete process.env.LANG;
  else process.env.LANG = originalGitLocaleEnv.LANG;
  if (originalGitLocaleEnv.LANGUAGE === undefined) delete process.env.LANGUAGE;
  else process.env.LANGUAGE = originalGitLocaleEnv.LANGUAGE;
});

afterAll(async () => {
  await repoTemplate.dispose();
});

describe('createSnapshot', () => {
  it('returns null in a clean repo and does not call the label factory', async () => {
    const initialHead = await commitSeed();
    let labelCalls = 0;

    const commit = await createSnapshot(repoPath, {
      label: () => {
        labelCalls += 1;
        return 'should not be used';
      },
      meta: { sessionId: 's1', kind: 'after-edit', anchor: 'm-clean' },
    });

    expect(commit).toBeNull();
    expect(labelCalls).toBe(0);
    expect(await head()).toBe(initialHead);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('can create an empty snapshot when explicitly allowed', async () => {
    const initialHead = await commitSeed();

    const commit = await createSnapshot(repoPath, {
      label: 'empty restore point',
      meta: { sessionId: 's1', kind: 'after-edit' },
      allowEmpty: true,
    });

    expect(commit).toBeTruthy();
    expect(commit).not.toBe(initialHead);
    expect(parseSnapshotCommit(await headMessage())).toMatchObject({
      label: 'empty restore point',
      sessionId: 's1',
      kind: 'after-edit',
    });
    expect(await headChangedFiles()).toEqual([]);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('keeps staged unsafe files out of explicit empty snapshots', async () => {
    await commitSeed();
    await writeRepoFile('.env', 'SECRET=abc123\n');
    await gitExec(['add', '.env'], repoPath);

    const result = await createSnapshotDetailed(repoPath, {
      label: 'empty restore point',
      meta: { sessionId: 's1', kind: 'after-edit' },
      allowEmpty: true,
    });

    expect(result.commit).toBeTruthy();
    expect(result.skippedFiles).toMatchObject([{ path: '.env', reason: 'sensitive-path' }]);
    expect(await headChangedFiles()).toEqual([]);
    expect(await statusShort()).toContain('A  .env');
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('creates an after-edit snapshot with XDT trailers for dirty files', async () => {
    await commitSeed();
    await writeRepoFile('src/app.ts', 'export const value = 1;\n');

    const commit = await createSnapshot(repoPath, {
      label: (diff) => {
        expect(diff.diffStat).toContain('src/app.ts');
        expect(diff.diffText).toContain('export const value = 1');
        return 'after edit: add app file';
      },
      meta: { sessionId: 's1', kind: 'after-edit', anchor: 'm1' },
    });

    expect(commit).toBeTruthy();
    const parsed = parseSnapshotCommit(await headMessage());
    expect(parsed).toMatchObject({
      label: 'after edit: add app file',
      sessionId: 's1',
      kind: 'after-edit',
      anchor: 'm1',
    });
    expect(parsed?.branch).toBeTruthy();
    expect(await headChangedFiles()).toEqual(['src/app.ts']);
    expect(await statusShort()).toBe('');
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('blocks snapshots while a merge conflict is unresolved', async () => {
    await writeRepoFile('conflicted.txt', 'base\n');
    await gitExec(['add', 'conflicted.txt'], repoPath);
    await gitExec(['commit', '--no-gpg-sign', '-m', 'seed conflict fixture'], repoPath);
    const baseBranch = await currentBranch();

    await gitExec(['checkout', '-b', 'snapshot-review-side'], repoPath);
    await writeRepoFile('conflicted.txt', 'side\n');
    await gitExec(['add', 'conflicted.txt'], repoPath);
    await gitExec(['commit', '--no-gpg-sign', '-m', 'side change'], repoPath);

    await gitExec(['checkout', baseBranch], repoPath);
    await writeRepoFile('conflicted.txt', 'main\n');
    await gitExec(['add', 'conflicted.txt'], repoPath);
    await gitExec(['commit', '--no-gpg-sign', '-m', 'main change'], repoPath);
    const preMergeHead = await head();
    await expect(gitExec(['merge', 'snapshot-review-side'], repoPath)).rejects.toThrow();
    await writeRepoFile('safe.txt', 'safe\n');

    let snapshotError: unknown;
    try {
      await createSnapshotDetailed(repoPath, {
        label: 'blocked merge',
        meta: { sessionId: 's1', kind: 'after-edit' },
      });
    } catch (err) {
      snapshotError = err;
    }
    expect(snapshotError).toBeInstanceOf(SnapshotBlockedByGitStateError);
    expect((snapshotError as SnapshotBlockedByGitStateError).state).toMatchObject({
      reason: 'merge',
    });
    expect(await head()).toBe(preMergeHead);
    expect(await statusShort()).toContain('UU conflicted.txt');
    expect(await statusShort()).toContain('?? safe.txt');
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('disables prepare-commit-msg hooks for snapshot commits', async () => {
    await commitSeed();
    const hookPath = await gitInternalPath('hooks/prepare-commit-msg');
    await fs.mkdir(path.dirname(hookPath), { recursive: true });
    await fs.writeFile(
      hookPath,
      '#!/bin/sh\necho prepare-commit-msg should not run >&2\nexit 1\n',
      'utf8',
    );
    await fs.chmod(hookPath, 0o755);
    await writeRepoFile('hooked.txt', 'safe\n');

    const commit = await createSnapshot(repoPath, {
      label: 'hook-free',
      meta: { sessionId: 's1', kind: 'after-edit' },
    });

    expect(commit).toBeTruthy();
    expect(await headChangedFiles()).toEqual(['hooked.txt']);
    expect(await statusShort()).toBe('');
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('skips unsafe files while committing safe files by default', async () => {
    await commitSeed();
    await writeRepoFile('safe.txt', 'safe changed\n');
    await writeRepoFile('.env', 'SECRET=abc123\n');
    await gitExec(['add', '.env'], repoPath);

    const result = await createSnapshotDetailed(repoPath, {
      label: 'safe only',
      meta: { sessionId: 's1', kind: 'after-edit' },
    });

    expect(result.commit).toBeTruthy();
    expect(result.includedFiles).toEqual(['safe.txt']);
    expect(result.skippedFiles).toMatchObject([{ path: '.env', reason: 'sensitive-path' }]);
    expect(await headChangedFiles()).toEqual(['safe.txt']);
    expect(await statusShort()).toContain('A  .env');
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('commits the deletion side of staged renames without staging replacement files', async () => {
    await writeRepoFile('old.txt', 'old\n');
    await gitExec(['add', 'old.txt'], repoPath);
    await gitExec(['commit', '--no-gpg-sign', '-m', 'seed rename fixture'], repoPath);
    await gitExec(['mv', 'old.txt', 'new.txt'], repoPath);
    await writeRepoFile('old.txt', Buffer.alloc(64));

    const result = await createSnapshotDetailed(repoPath, {
      label: 'rename only',
      meta: { sessionId: 's1', kind: 'after-edit' },
      fileFilter: { maxFileBytes: 32 },
    });

    expect(result.commit).toBeTruthy();
    expect(result.includedFiles).toEqual(['new.txt']);
    expect(result.skippedFiles).toMatchObject([{ path: 'old.txt', reason: 'large-file' }]);
    expect(await headFile('new.txt')).toBe('old\n');
    await expect(gitExec(['show', 'HEAD:old.txt'], repoPath)).rejects.toThrow();
    expect(await statusShort()).toContain('?? old.txt');
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('preserves safe replacement files recreated at rename old paths', async () => {
    await writeRepoFile('old.txt', 'old\n');
    await gitExec(['add', 'old.txt'], repoPath);
    await gitExec(['commit', '--no-gpg-sign', '-m', 'seed replacement fixture'], repoPath);
    await gitExec(['mv', 'old.txt', 'new.txt'], repoPath);
    await writeRepoFile('old.txt', 'replacement\n');

    const result = await createSnapshotDetailed(repoPath, {
      label: 'rename with replacement',
      meta: { sessionId: 's1', kind: 'after-edit' },
    });

    expect(result.commit).toBeTruthy();
    expect(result.includedFiles).toEqual(expect.arrayContaining(['new.txt', 'old.txt']));
    expect(await headChangedFiles()).toEqual(['new.txt', 'old.txt']);
    expect(await headFile('new.txt')).toBe('old\n');
    expect(await headFile('old.txt')).toBe('replacement\n');
    expect(await statusShort()).toBe('');
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('can include unsafe files when explicitly allowed', async () => {
    await commitSeed();
    await writeRepoFile('.env', 'SECRET=abc123\n');

    const result = await createSnapshotDetailed(repoPath, {
      label: 'include unsafe',
      meta: { sessionId: 's1', kind: 'after-edit' },
      unsafeFilePolicy: 'include',
    });

    expect(result.commit).toBeTruthy();
    expect(result.includedFiles).toEqual(['.env']);
    expect(result.skippedFiles).toMatchObject([{ path: '.env', reason: 'sensitive-path' }]);
    expect(await headChangedFiles()).toEqual(['.env']);
    expect(await statusShort()).toBe('');
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('blocks the snapshot when unsafe files are configured to fail', async () => {
    const initialHead = await commitSeed();
    await writeRepoFile('seed.txt', 'seed changed\n');
    await writeRepoFile('.env', 'SECRET=abc123\n');

    await expect(
      createSnapshotDetailed(repoPath, {
        label: 'blocked',
        meta: { sessionId: 's1', kind: 'after-edit' },
        unsafeFilePolicy: 'fail',
      }),
    ).rejects.toBeInstanceOf(SnapshotUnsafeFilesError);
    expect(await head()).toBe(initialHead);
    expect(await statusShort()).toContain('?? .env');
    expect(await statusShort()).toContain(' M seed.txt');
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('creates the first commit in an unborn repository', async () => {
    await writeRepoFile('first.txt', 'first\n');

    const commit = await createSnapshot(repoPath, {
      label: 'initial snapshot',
      meta: { sessionId: 's1', kind: 'after-edit' },
    });

    expect(commit).toBeTruthy();
    expect(await head()).toBe(commit);
    expect(parseSnapshotCommit(await headMessage())).toMatchObject({
      label: 'initial snapshot',
      sessionId: 's1',
      kind: 'after-edit',
    });
    expect(await headChangedFiles()).toEqual(['first.txt']);
    expect(await statusShort()).toBe('');
  }, REAL_GIT_TEST_TIMEOUT_MS);
});

describe('listSnapshots', () => {
  it('filters by session and keeps reachable history newest-first', async () => {
    const s1Old = await createSnapshotMarker(repoPath, {
      label: 's1 old',
      meta: { sessionId: 's1', kind: 'after-edit', anchor: 'm1' },
    });
    await createSnapshotMarker(repoPath, {
      label: 's2 savepoint',
      meta: { sessionId: 's2', kind: 'after-edit', anchor: 'm2' },
    });
    const s1New = await createSnapshotMarker(repoPath, {
      label: 's1 new',
      meta: { sessionId: 's1', kind: 'manual', anchor: 'm3' },
    });

    const snapshots = await listSnapshots(repoPath, { sessionId: 's1' });

    expect(snapshots.map((snapshot) => snapshot.commit)).toEqual([s1New, s1Old]);
    expect(snapshots.map((snapshot) => snapshot.label)).toEqual(['s1 new', 's1 old']);
    expect(snapshots.every((snapshot) => snapshot.sessionId === 's1')).toBe(true);
    expect(snapshots[0]).toMatchObject({ kind: 'manual', anchor: 'm3' });
    expect(snapshots[0]?.branch).toBeTruthy();
    expect(snapshots[0]?.time).toMatch(/T/);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('lists metadata-only dirty-start rewind markers without committing dirty files', async () => {
    await commitSeed();
    await writeRepoFile('dirty.txt', 'not committed\n');

    const marker = await createSnapshotMarker(repoPath, {
      label: 'dirty start',
      meta: { sessionId: 's1', kind: 'rewind-blocked', anchor: 'm1' },
    });

    const snapshots = await listSnapshots(repoPath, { sessionId: 's1' });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      commit: marker,
      label: 'dirty start',
      kind: 'rewind-blocked',
      anchor: 'm1',
    });
    expect(await headChangedFiles()).toEqual([]);
    expect(await statusShort()).toBe('?? dirty.txt');
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('ignores rollback and non-XDT commits', async () => {
    const savepoint = await createSnapshotMarker(repoPath, {
      label: 'savepoint',
      meta: { sessionId: 's1', kind: 'after-edit', anchor: 'm1' },
    });
    await commitPlainEmpty('user commit');
    await createSnapshotMarker(repoPath, {
      label: 'rollback',
      meta: { sessionId: 's1', kind: 'rollback', rollbackId: 'rb1', reverts: [savepoint] },
    });
    await createSnapshotMarker(repoPath, {
      label: 'rollback undo',
      meta: { sessionId: 's1', kind: 'rollback-undo', rollbackId: 'rb1' },
    });

    const snapshots = await listSnapshots(repoPath, { sessionId: 's1' });

    expect(snapshots.map((snapshot) => snapshot.commit)).toEqual([savepoint]);
    expect(snapshots[0]).toMatchObject({ label: 'savepoint', kind: 'after-edit' });
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('bounds history traversal with maxCount', async () => {
    const oldSnapshot = await createSnapshotMarker(repoPath, {
      label: 'old snapshot',
      meta: { sessionId: 's1', kind: 'after-edit', anchor: 'm1' },
    });
    const newSnapshot = await createSnapshotMarker(repoPath, {
      label: 'new snapshot',
      meta: { sessionId: 's1', kind: 'after-edit', anchor: 'm2' },
    });

    const snapshots = await listSnapshots(repoPath, { sessionId: 's1', maxCount: 1 });

    expect(snapshots.map((snapshot) => snapshot.commit)).toEqual([newSnapshot]);
    expect(snapshots.map((snapshot) => snapshot.commit)).not.toContain(oldSnapshot);
  }, REAL_GIT_TEST_TIMEOUT_MS);

  it('returns an empty list for unborn repositories', async () => {
    expect(await listSnapshots(repoPath, { sessionId: 's1' })).toEqual([]);
  }, REAL_GIT_TEST_TIMEOUT_MS);
});
