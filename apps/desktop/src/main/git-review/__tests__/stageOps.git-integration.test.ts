import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 });

import { TestDirectoryTemplate } from '../../../test/vitest/testDirectoryTemplate';
import { readDiffs, readFileDiff } from '../diffReader';
import { runGit } from '../gitRunner';
import { applyFileBatch, applyHunkSelection, GitReviewStageError } from '../stageOps';
import { readStatus } from '../statusReader';
import type { DiffSelection, FileDiff, ReviewDiffReadOptions, ReviewFileTarget, ReviewScope } from '../types';

let repoPath: string;

const canLinkFile = (() => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'git-review-file-link-probe-'));
  try {
    const target = path.join(root, 'target');
    fsSync.writeFileSync(target, 'probe');
    fsSync.symlinkSync(target, path.join(root, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    fsSync.rmSync(root, { recursive: true, force: true });
  }
})();

const repoTemplate = new TestDirectoryTemplate('xdt-git-review-stage-', async (dir) => {
  await runGit(['init'], { cwd: dir });
  await runGit(['config', 'user.email', 'test@xdt.local'], { cwd: dir });
  await runGit(['config', 'user.name', 'XDT Test'], { cwd: dir });
  await runGit(['config', 'commit.gpgsign', 'false'], { cwd: dir });
  // 测试内容显式用 LF 断言;屏蔽全局 autocrlf=true(Windows 默认)对 checkout/apply 的换行改写。
  await runGit(['config', 'core.autocrlf', 'false'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'file.txt'), 'one\ntwo\nthree\n');
  await runGit(['add', 'file.txt'], { cwd: dir });
  await runGit(['commit', '--no-gpg-sign', '-m', 'seed'], { cwd: dir });
});

function scope(): ReviewScope {
  return {
    sessionId: 's1',
    workdir: repoPath,
    worktreePath: repoPath,
    workingDir: repoPath,
    repoRoot: repoPath,
    branch: 'main',
    headOid: null,
    isDetached: false,
    isUnborn: false,
    source: 'worktree',
    aheadBehind: { ahead: 0, behind: 0, upstream: null, stale: true },
    disabledReason: null,
    disabledMessage: null,
    resolutionChain: [],
  };
}

async function status() {
  return readStatus(scope());
}

async function diffs(options: ReviewDiffReadOptions = {}) {
  const current = await status();
  return readDiffs(current.scope, current, options);
}

function target(diff: FileDiff): ReviewFileTarget {
  return { path: diff.path, oldPath: diff.oldPath, source: diff.source === 'staged' ? 'staged' : 'unstaged' };
}

function selectLines(diff: FileDiff, count = 1): DiffSelection {
  const hunk = diff.hunks[0];
  return { lines: [{ hunkIndex: hunk.index, lineIndices: hunk.selectableLines.slice(0, count) }] };
}

function selectHunk(diff: FileDiff): DiffSelection {
  const hunk = diff.hunks[0];
  return { lines: [{ hunkIndex: hunk.index, lineIndices: hunk.selectableLines }] };
}

async function stageRenameThenModify(): Promise<void> {
  await runGit(['mv', 'file.txt', 'renamed.txt'], { cwd: repoPath });
  await runGit(['add', '-A'], { cwd: repoPath });
  await fs.writeFile(path.join(repoPath, 'renamed.txt'), 'one\nTWO\nthree\n');
}

async function seedWhitespaceFixture(): Promise<void> {
  await fs.writeFile(path.join(repoPath, 'file.txt'), [
    'one',
    'alpha',
    'keep = 1;',
    'beta',
    'gamma',
    'delta',
    'omega',
    '',
  ].join('\n'));
  await runGit(['add', 'file.txt'], { cwd: repoPath });
  await runGit(['commit', '--no-gpg-sign', '-m', 'whitespace fixture'], { cwd: repoPath });
}

async function writeSubstantiveAndWhitespaceChanges(): Promise<void> {
  await fs.writeFile(path.join(repoPath, 'file.txt'), [
    'one',
    'alpha',
    'keep = 2;',
    '  beta',
    'gamma',
    'delta',
    'omega',
    '',
  ].join('\n'));
}

async function tryCreateDirSymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, 'dir');
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') return false;
    throw err;
  }
}

beforeEach(async () => {
  repoPath = await repoTemplate.createCopy();
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

afterAll(async () => {
  await repoTemplate.dispose();
});

describe('git-review stageOps', () => {
  it('stages and unstages whole files', async () => {
    await fs.writeFile(path.join(repoPath, 'file.txt'), 'one\nTWO\nthree\n');
    let current = await status();
    let summary = await applyFileBatch(scope(), current, 'stage', [target((await diffs()).unstaged[0])]);
    expect(summary.failed).toHaveLength(0);
    expect((await status()).stagedCount).toBe(1);

    current = await status();
    summary = await applyFileBatch(scope(), current, 'unstage', [target((await diffs()).staged[0])]);
    expect(summary.failed).toHaveLength(0);
    expect((await status()).stagedCount).toBe(0);
    expect((await status()).unstagedCount).toBe(1);
  });

  it('stages and unstages hunks in the correct direction without losing worktree changes', async () => {
    await fs.writeFile(path.join(repoPath, 'file.txt'), 'ONE\ntwo\nthree\n');
    let current = await status();
    const unstaged = (await diffs()).unstaged[0];
    await applyHunkSelection(scope(), current, 'stage', unstaged, selectHunk(unstaged));
    expect((await runGit(['diff', '--cached', '--', 'file.txt'], { cwd: repoPath })).stdout).toContain('+ONE');

    current = await status();
    const staged = (await diffs()).staged[0];
    await applyHunkSelection(scope(), current, 'unstage', staged, selectHunk(staged));
    expect((await runGit(['diff', '--cached', '--', 'file.txt'], { cwd: repoPath })).stdout).toBe('');
    expect((await runGit(['diff', '--', 'file.txt'], { cwd: repoPath })).stdout).toContain('+ONE');
  });

  it('stages substantive hunks without dropping hidden whitespace-only edits', async () => {
    await seedWhitespaceFixture();
    await writeSubstantiveAndWhitespaceChanges();

    const current = await status();
    const unstaged = (await diffs({ ignoreWhitespace: true })).unstaged[0];
    expect(unstaged.hunks).toHaveLength(1);
    await applyHunkSelection(scope(), current, 'stage', unstaged, selectHunk(unstaged), { ignoreWhitespace: true });

    expect((await runGit(['diff', '--cached', '--', 'file.txt'], { cwd: repoPath })).stdout).toContain('+keep = 2;');
    const afterStageWorktree = (await runGit(['diff', '--', 'file.txt'], { cwd: repoPath })).stdout;
    expect(afterStageWorktree).not.toContain('+keep = 2;');
    expect(afterStageWorktree).toContain('+  beta');
  });

  it('unstages substantive hunks without dropping hidden whitespace-only edits', async () => {
    await seedWhitespaceFixture();
    await writeSubstantiveAndWhitespaceChanges();
    await runGit(['add', 'file.txt'], { cwd: repoPath });

    const current = await status();
    const staged = (await diffs({ ignoreWhitespace: true })).staged[0];
    await applyHunkSelection(scope(), current, 'unstage', staged, selectHunk(staged), { ignoreWhitespace: true });

    const cachedWhitespaceOnly = (await runGit(['diff', '--cached', '--', 'file.txt'], { cwd: repoPath })).stdout;
    expect(cachedWhitespaceOnly).not.toContain('+keep = 2;');
    expect(cachedWhitespaceOnly).toContain('+  beta');
    const worktree = (await runGit(['diff', '--', 'file.txt'], { cwd: repoPath })).stdout;
    expect(worktree).toContain('+keep = 2;');
    expect(worktree).not.toContain('+  beta');
  });

  it('discards substantive hunks without dropping hidden whitespace-only edits', async () => {
    await seedWhitespaceFixture();
    await writeSubstantiveAndWhitespaceChanges();

    const current = await status();
    const unstaged = (await diffs({ ignoreWhitespace: true })).unstaged[0];
    await applyHunkSelection(scope(), current, 'discard', unstaged, selectHunk(unstaged), { ignoreWhitespace: true });

    const afterDiscard = await fs.readFile(path.join(repoPath, 'file.txt'), 'utf8');
    expect(afterDiscard).toContain('keep = 1;');
    expect(afterDiscard).toContain('  beta');
    const remainingDiff = (await runGit(['diff', '--', 'file.txt'], { cwd: repoPath })).stdout;
    expect(remainingDiff).not.toContain('+keep = 2;');
    expect(remainingDiff).toContain('+  beta');
  });

  it('supports partial staging and partial/full unstaging of new files', async () => {
    await fs.writeFile(path.join(repoPath, 'new.txt'), 'one\ntwo\nthree\n');
    let current = await status();
    let diff = (await diffs()).unstaged.find((item) => item.path === 'new.txt')!;
    await applyHunkSelection(scope(), current, 'stage', diff, selectLines(diff, 2));
    expect((await runGit(['show', ':new.txt'], { cwd: repoPath })).stdout).toBe('one\ntwo\n');

    current = await status();
    diff = (await diffs()).staged.find((item) => item.path === 'new.txt')!;
    await applyHunkSelection(scope(), current, 'unstage', diff, selectLines(diff, 1));
    expect((await runGit(['show', ':new.txt'], { cwd: repoPath })).stdout).toBe('two\n');

    current = await status();
    diff = (await diffs()).staged.find((item) => item.path === 'new.txt')!;
    await applyHunkSelection(scope(), current, 'unstage', diff, selectLines(diff, 1));
    await expect(runGit(['show', ':new.txt'], { cwd: repoPath })).rejects.toThrow();
  });

  it('rejects untracked discard when an intermediate directory becomes an outside symlink', async () => {
    await fs.mkdir(path.join(repoPath, 'new-dir'));
    await fs.writeFile(path.join(repoPath, 'new-dir', 'file.txt'), 'inside\n');
    const current = await status();
    const staleTarget = current.files.find((file) => file.path === 'new-dir/file.txt');
    if (!staleTarget) throw new Error('missing stale untracked target');
    const outsideDir = path.join(path.dirname(repoPath), `${path.basename(repoPath)}-outside-discard`);
    await fs.mkdir(outsideDir);
    const outsideFile = path.join(outsideDir, 'file.txt');
    await fs.writeFile(outsideFile, 'outside\n');
    await fs.rm(path.join(repoPath, 'new-dir'), { recursive: true, force: true });
    const linked = await tryCreateDirSymlink(outsideDir, path.join(repoPath, 'new-dir'));
    if (!linked) {
      await fs.rm(outsideDir, { recursive: true, force: true });
      return;
    }

    try {
      const summary = await applyFileBatch(scope(), current, 'discard', [{
        path: staleTarget.path,
        oldPath: staleTarget.oldPath,
        source: 'unstaged',
      }]);

      expect(summary.succeeded).toEqual([]);
      expect(summary.failed[0]).toMatchObject({
        path: 'new-dir/file.txt',
      });
      expect(summary.failed[0]?.error).toContain('outside repository');
      await expect(fs.readFile(outsideFile, 'utf8')).resolves.toBe('outside\n');
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('stages renamed files without staging a new file at the old path', async () => {
    await runGit(['mv', 'file.txt', 'renamed.txt'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'file.txt'), 'new occupant\n');
    const current = await status();
    const diff = (await diffs()).staged.find((item) => item.path === 'renamed.txt')!;

    await applyFileBatch(scope(), current, 'stage', [target(diff)]);

    const next = await status();
    const oldPath = next.files.find((file) => file.path === 'file.txt');
    expect(oldPath?.isUntracked).toBe(true);
    expect(next.files.find((file) => file.path === 'renamed.txt')?.indexStatus).toBe('renamed');
  });

  it('continues section batches after stale targets and reports partial completion', async () => {
    await fs.writeFile(path.join(repoPath, 'first.txt'), 'first\n');
    await fs.writeFile(path.join(repoPath, 'third.txt'), 'third\n');
    const current = await status();
    const summary = await applyFileBatch(scope(), current, 'stage', [
      { path: 'first.txt', oldPath: null, source: 'unstaged' },
      { path: 'missing.txt', oldPath: null, source: 'unstaged' },
      { path: 'third.txt', oldPath: null, source: 'unstaged' },
    ]);

    expect(summary.succeeded).toEqual(['first.txt', 'third.txt']);
    expect(summary.failed[0].path).toBe('missing.txt');
    expect(summary.failed[0].error).toContain('diff is stale');
    expect(summary.partial).toBe(true);
    const next = await status();
    expect(next.files.find((file) => file.path === 'first.txt')?.indexStatus).toBe('added');
    expect(next.files.find((file) => file.path === 'third.txt')?.indexStatus).toBe('added');
  });

  it('rejects stale staged and unstaged whole-file targets', async () => {
    await fs.writeFile(path.join(repoPath, 'file.txt'), 'ONE\ntwo\nthree\n');
    await runGit(['add', 'file.txt'], { cwd: repoPath });
    let current = await status();
    await expect(applyFileBatch(scope(), current, 'stage', [
      { path: 'file.txt', oldPath: null, source: 'unstaged' },
    ])).resolves.toMatchObject({
      failed: [{ path: 'file.txt', error: expect.stringContaining('diff is stale') }],
    });

    await runGit(['reset', '-q', 'HEAD', '--', 'file.txt'], { cwd: repoPath });
    current = await status();
    await expect(applyFileBatch(scope(), current, 'unstage', [
      { path: 'file.txt', oldPath: null, source: 'staged' },
    ])).resolves.toMatchObject({
      failed: [{ path: 'file.txt', error: expect.stringContaining('diff is stale') }],
    });
  });

  it('discards unstaged file changes while preserving staged changes on the same path', async () => {
    await fs.writeFile(path.join(repoPath, 'file.txt'), 'ONE\ntwo\nthree\n');
    await runGit(['add', 'file.txt'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'file.txt'), 'ONE\nTWO\nthree\n');

    const current = await status();
    const unstaged = (await diffs()).unstaged[0];
    const summary = await applyFileBatch(scope(), current, 'discard', [target(unstaged)]);

    expect(summary.failed).toHaveLength(0);
    expect((await runGit(['diff', '--', 'file.txt'], { cwd: repoPath })).stdout).toBe('');
    expect((await runGit(['diff', '--cached', '--', 'file.txt'], { cwd: repoPath })).stdout).toContain('+ONE');
    expect(await fs.readFile(path.join(repoPath, 'file.txt'), 'utf8')).toBe('ONE\ntwo\nthree\n');
  });

  it('discards unstaged edits on top of a staged rename without touching the rename', async () => {
    await stageRenameThenModify();

    const current = await status();
    const unstaged = (await diffs()).unstaged.find((item) => item.path === 'renamed.txt')!;
    expect(unstaged.oldPath).toBe('file.txt');
    expect(unstaged.status).toBe('modified');
    const summary = await applyFileBatch(scope(), current, 'discard', [target(unstaged)]);

    expect(summary.failed).toHaveLength(0);
    expect((await runGit(['diff', '--', 'renamed.txt'], { cwd: repoPath })).stdout).toBe('');
    expect(await fs.readFile(path.join(repoPath, 'renamed.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
    const cached = (await runGit(['diff', '--cached', '--', 'file.txt', 'renamed.txt'], { cwd: repoPath })).stdout;
    expect(cached).toContain('rename from file.txt');
    expect(cached).toContain('rename to renamed.txt');
  });

  it('stages hunk and whole-file edits on top of a staged rename via the current path', async () => {
    await stageRenameThenModify();
    let current = await status();
    let unstaged = (await diffs()).unstaged.find((item) => item.path === 'renamed.txt')!;
    await applyHunkSelection(scope(), current, 'stage', unstaged, selectHunk(unstaged));

    expect((await runGit(['show', ':renamed.txt'], { cwd: repoPath })).stdout).toBe('one\nTWO\nthree\n');
    expect((await runGit(['diff', '--', 'renamed.txt'], { cwd: repoPath })).stdout).toBe('');

    await runGit(['reset', '--hard', 'HEAD'], { cwd: repoPath });
    await stageRenameThenModify();
    current = await status();
    unstaged = (await diffs()).unstaged.find((item) => item.path === 'renamed.txt')!;
    const summary = await applyFileBatch(scope(), current, 'stage', [target(unstaged)]);

    expect(summary.failed).toHaveLength(0);
    expect((await runGit(['show', ':renamed.txt'], { cwd: repoPath })).stdout).toBe('one\nTWO\nthree\n');
    expect((await runGit(['diff', '--', 'renamed.txt'], { cwd: repoPath })).stdout).toBe('');
  });

  it('discards untracked files by deleting them from the worktree', async () => {
    await fs.writeFile(path.join(repoPath, 'loose.txt'), 'loose\n');

    const current = await status();
    const unstaged = (await diffs()).unstaged.find((item) => item.path === 'loose.txt')!;
    const summary = await applyFileBatch(scope(), current, 'discard', [target(unstaged)]);

    expect(summary.failed).toHaveLength(0);
    await expect(fs.access(path.join(repoPath, 'loose.txt'))).rejects.toThrow();
    expect((await status()).files.find((file) => file.path === 'loose.txt')).toBeUndefined();
  });

  it('rejects discard writes while the repository is unborn', async () => {
    await fs.rm(repoPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xdt-git-review-stage-empty-'));
    await runGit(['init'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'loose.txt'), 'loose\n');

    const current = await status();
    expect(current.writeDisabledReasons).toContain('unborn');
    await expect(applyFileBatch(scope(), current, 'discard', [
      { path: 'loose.txt', oldPath: null, source: 'unstaged' },
    ])).rejects.toThrow(GitReviewStageError);
  });

  it('rejects partial staged rename+modified diffs', async () => {
    await runGit(['mv', 'file.txt', 'renamed.txt'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'renamed.txt'), 'ONE\ntwo\nthree\n');
    await runGit(['add', '-A'], { cwd: repoPath });
    const current = await status();
    const diff = (await diffs()).staged.find((item) => item.path === 'renamed.txt')!;

    await expect(applyHunkSelection(scope(), current, 'unstage', diff, selectLines(diff))).rejects.toThrow(GitReviewStageError);
  });

  it.skipIf(!canLinkFile)('rejects partial typechange staging while whole-file staging remains valid', async () => {
    await runGit(['config', 'core.symlinks', 'true'], { cwd: repoPath });
    await fs.rm(path.join(repoPath, 'file.txt'));
    await fs.symlink('target.txt', path.join(repoPath, 'file.txt'));

    const current = await status();
    const diff = (await diffs()).unstaged.find((item) => item.path === 'file.txt')!;
    expect(diff.mode).toMatchObject({ old: '100644', new: '120000' });
    await expect(applyHunkSelection(scope(), current, 'stage', diff, selectLines(diff))).rejects.toThrow(GitReviewStageError);

    const summary = await applyFileBatch(scope(), current, 'stage', [target(diff)]);
    expect(summary.failed).toHaveLength(0);
    expect((await runGit(['ls-files', '-s', '--', 'file.txt'], { cwd: repoPath })).stdout).toMatch(/^120000 /);
  });

  it('rejects stale patches after the diff changes', async () => {
    await fs.writeFile(path.join(repoPath, 'file.txt'), 'ONE\ntwo\nthree\n');
    const current = await status();
    const diff = (await diffs()).unstaged[0];
    await fs.writeFile(path.join(repoPath, 'file.txt'), 'ONE\nTWO\nthree\n');

    await expect(applyHunkSelection(scope(), current, 'stage', diff, selectLines(diff))).rejects.toMatchObject({
      kind: 'stale',
    });
  });

  it('rejects stale discard patches after the diff changes', async () => {
    await fs.writeFile(path.join(repoPath, 'file.txt'), 'ONE\ntwo\nthree\n');
    const current = await status();
    const diff = (await diffs()).unstaged[0];
    await fs.writeFile(path.join(repoPath, 'file.txt'), 'ONE\nTWO\nthree\n');

    await expect(applyHunkSelection(scope(), current, 'discard', diff, selectLines(diff))).rejects.toMatchObject({
      kind: 'stale',
    });
  });

  it('rejects binary and large text partial staging', async () => {
    await fs.writeFile(path.join(repoPath, 'bin.dat'), Buffer.from([0, 1, 2, 0]));
    await runGit(['add', 'bin.dat'], { cwd: repoPath });
    await runGit(['commit', '--no-gpg-sign', '-m', 'binary'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'bin.dat'), Buffer.from([0, 1, 3, 0]));
    let current = await status();
    let file = current.files.find((item) => item.path === 'bin.dat')!;
    let diff = await readFileDiff(current.scope, 'unstaged', file);
    await expect(applyHunkSelection(scope(), current, 'stage', diff, { lines: [{ hunkIndex: 0, lineIndices: [0] }] })).rejects.toThrow(GitReviewStageError);

    const large = `${'x'.repeat(5 * 1024 * 1024)}\n`;
    await fs.writeFile(path.join(repoPath, 'large.txt'), 'seed\n');
    await runGit(['add', 'large.txt'], { cwd: repoPath });
    await runGit(['commit', '--no-gpg-sign', '-m', 'large seed'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'large.txt'), large);
    current = await status();
    file = current.files.find((item) => item.path === 'large.txt')!;
    diff = await readFileDiff(current.scope, 'unstaged', file);
    await expect(applyHunkSelection(scope(), current, 'stage', diff, { lines: [{ hunkIndex: 0, lineIndices: [0] }] })).rejects.toThrow(GitReviewStageError);
  });

  it('does not treat CRLF conversion warnings as failures', async () => {
    await runGit(['config', 'core.autocrlf', 'true'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'crlf.txt'), 'line\n');
    const current = await status();
    const diff = (await diffs()).unstaged.find((item) => item.path === 'crlf.txt')!;
    const summary = await applyFileBatch(scope(), current, 'stage', [target(diff)]);

    expect(summary.failed).toHaveLength(0);
    expect((await status()).files.find((file) => file.path === 'crlf.txt')?.indexStatus).toBe('added');
  });
});
