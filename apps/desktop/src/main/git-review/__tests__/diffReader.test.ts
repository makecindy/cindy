import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Windows 上 git 子进程明显更慢(每次 spawn 数百毫秒),多步 git 编排用例会超默认 5s。
vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 });

import { runGit } from '../gitRunner';
import { readStatus } from '../statusReader';
import { mapWithConcurrency, readCappedFileDiff, readDiffs, readDiffSummaryEntries, readFileDiff } from '../diffReader';
import type { ReviewScope } from '../types';

let repoPath: string;

async function initRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xdt-git-review-'));
  await runGit(['init'], { cwd: dir });
  await runGit(['config', 'user.email', 'test@xdt.local'], { cwd: dir });
  await runGit(['config', 'user.name', 'XDT Test'], { cwd: dir });
  await runGit(['config', 'commit.gpgsign', 'false'], { cwd: dir });
  // 测试内容显式用 LF 断言;屏蔽全局 autocrlf=true(Windows 默认)对 checkout/apply 的换行改写。
  await runGit(['config', 'core.autocrlf', 'false'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'seed.txt'), 'seed\n');
  await runGit(['add', 'seed.txt'], { cwd: dir });
  await runGit(['commit', '--no-gpg-sign', '-m', 'seed'], { cwd: dir });
  return dir;
}

async function tryCreateFileSymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') return false;
    throw err;
  }
}

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

beforeEach(async () => {
  repoPath = await initRepo();
});

afterEach(async () => {
  await fs.rm(repoPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe('git-review diffReader', () => {
  it('reads untracked files through --no-index /dev/null', async () => {
    await fs.writeFile(path.join(repoPath, 'new file.txt'), 'hello\nworld\n');
    const status = await readStatus(scope());
    const diffs = await readDiffs(scope(), status);

    expect(diffs.unstaged[0]).toMatchObject({
      path: 'new file.txt',
      status: 'untracked',
      additions: 2,
      kind: 'text',
    });
  });

  it('expands untracked directories into file-level entries without trailing slashes', async () => {
    await fs.mkdir(path.join(repoPath, 'new-dir', 'nested'), { recursive: true });
    await fs.writeFile(path.join(repoPath, 'new-dir', 'a.txt'), 'alpha\n');
    await fs.writeFile(path.join(repoPath, 'new-dir', 'nested', 'b.txt'), 'beta\n');

    const status = await readStatus(scope());
    const diffs = await readDiffs(scope(), status);

    expect(status.files.filter((file) => file.isUntracked).map((file) => file.path).sort()).toEqual([
      'new-dir/a.txt',
      'new-dir/nested/b.txt',
    ]);
    expect(status.files.some((file) => file.path.endsWith('/'))).toBe(false);
    expect(diffs.unstaged.map((diff) => diff.path)).toEqual([
      'new-dir/a.txt',
      'new-dir/nested/b.txt',
    ]);
    expect(diffs.unstaged.every((diff) => diff.status === 'untracked')).toBe(true);
  });

  it('keeps untracked no-index patch paths repo-relative for portable git apply commands', async () => {
    const relPath = 'dir with space/new [file].txt';
    await fs.mkdir(path.dirname(path.join(repoPath, relPath)), { recursive: true });
    await fs.writeFile(path.join(repoPath, 'dir with space/.keep'), 'tracked dir\n');
    await runGit(['add', 'dir with space/.keep'], { cwd: repoPath });
    await runGit(['commit', '--no-gpg-sign', '-m', 'tracked dir'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, relPath), 'hello\nworld\n');
    const status = await readStatus(scope());
    const diffs = await readDiffs(scope(), status);

    const diff = diffs.unstaged[0];
    expect(diff).toMatchObject({
      path: relPath,
      status: 'untracked',
      additions: 2,
      kind: 'text',
    });
    expect(diff.rawPatch).toContain('--- /dev/null');
    expect(diff.rawPatch).toContain(`+++ b/${relPath}`);
    expect(diff.rawPatch).not.toContain(repoPath);
  });

  it('classifies worktree symlinks without probing the linked target content', async () => {
    const outsidePath = path.join(path.dirname(repoPath), `${path.basename(repoPath)}-large-target.txt`);
    await fs.writeFile(outsidePath, 'target\n');
    await fs.truncate(outsidePath, 80 * 1024 * 1024);
    const linked = await tryCreateFileSymlink(outsidePath, path.join(repoPath, 'link.txt'));
    if (!linked) {
      await fs.rm(outsidePath, { force: true });
      return;
    }

    try {
      const status = await readStatus(scope());
      const diffs = await readDiffs(scope(), status);
      const diff = diffs.unstaged.find((item) => item.path === 'link.txt');

      expect(diff).toMatchObject({
        path: 'link.txt',
        status: 'untracked',
        kind: 'text',
        isTooLarge: false,
      });
      expect(diff?.size).toBe(outsidePath.length);
      // git 把 symlink 目标以 POSIX 分隔符写入 blob,Windows 路径按同规则规范化后比较。
      expect(diff?.rawPatch).toContain(`+${outsidePath.split(path.sep).join('/')}`);
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
  });

  it('does not probe NUL bytes through symlinked directories outside the repo', async () => {
    await fs.mkdir(path.join(repoPath, 'tracked-dir'));
    await fs.writeFile(path.join(repoPath, 'tracked-dir', 'file.txt'), 'base\n');
    await runGit(['add', 'tracked-dir/file.txt'], { cwd: repoPath });
    await runGit(['commit', '--no-gpg-sign', '-m', 'tracked dir seed'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'tracked-dir', 'file.txt'), 'worktree\n');
    const staleStatus = await readStatus(scope());
    const staleFile = staleStatus.files.find((file) => file.path === 'tracked-dir/file.txt');
    if (!staleFile) throw new Error('missing stale tracked file');
    const outsideDir = path.join(path.dirname(repoPath), `${path.basename(repoPath)}-outside-binary`);
    await fs.mkdir(outsideDir);
    await fs.writeFile(path.join(outsideDir, 'file.txt'), Buffer.from([0, 1, 2, 3]));
    await fs.rm(path.join(repoPath, 'tracked-dir'), { recursive: true, force: true });
    const linked = await tryCreateFileSymlink(outsideDir, path.join(repoPath, 'tracked-dir'));
    if (!linked) {
      await fs.rm(outsideDir, { recursive: true, force: true });
      return;
    }

    try {
      const diff = await readFileDiff(scope(), 'unstaged', staleFile);

      expect(diff.kind).toBe('text');
      expect(diff.isBinary).toBe(false);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('does not count untracked text lines through symlinked directories outside the repo', async () => {
    await fs.mkdir(path.join(repoPath, 'new-dir'));
    await fs.writeFile(path.join(repoPath, 'new-dir', 'file.txt'), 'inside\n');
    const staleStatus = await readStatus(scope());
    const outsideDir = path.join(path.dirname(repoPath), `${path.basename(repoPath)}-outside-lines`);
    await fs.mkdir(outsideDir);
    await fs.writeFile(path.join(outsideDir, 'file.txt'), 'outside\nsecret\n');
    await fs.rm(path.join(repoPath, 'new-dir'), { recursive: true, force: true });
    const linked = await tryCreateFileSymlink(outsideDir, path.join(repoPath, 'new-dir'));
    if (!linked) {
      await fs.rm(outsideDir, { recursive: true, force: true });
      return;
    }

    try {
      const entries = await readDiffSummaryEntries(scope(), staleStatus, 'unstaged');
      const entry = entries.find((item) => item.path === 'new-dir/file.txt');

      expect(entry).toMatchObject({
        path: 'new-dir/file.txt',
        additions: 0,
      });
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('uses literal pathspecs for paths containing glob characters', async () => {
    await fs.writeFile(path.join(repoPath, 'a[1].txt'), 'base\n');
    await runGit(['add', 'a[1].txt'], { cwd: repoPath });
    await runGit(['commit', '--no-gpg-sign', '-m', 'literal'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'a[1].txt'), 'changed\n');

    const status = await readStatus(scope());
    const diffs = await readDiffs(scope(), status);

    expect(diffs.unstaged[0].path).toBe('a[1].txt');
    expect(diffs.unstaged[0].deletions).toBe(1);
    expect(diffs.unstaged[0].additions).toBe(1);
  });

  it('classifies merge=binary attributes as binary', async () => {
    await fs.writeFile(path.join(repoPath, '.gitattributes'), '*.bin merge=binary\n');
    await fs.writeFile(path.join(repoPath, 'asset.bin'), 'before\n');
    await runGit(['add', '.gitattributes', 'asset.bin'], { cwd: repoPath });
    await runGit(['commit', '--no-gpg-sign', '-m', 'binary attr'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'asset.bin'), 'after\n');

    const status = await readStatus(scope());
    const diffs = await readDiffs(scope(), status);

    expect(diffs.unstaged[0]).toMatchObject({ path: 'asset.bin', kind: 'binary', isBinary: true });
  });

  it('uses source-specific statuses for staged-added files modified again in the worktree', async () => {
    await fs.writeFile(path.join(repoPath, 'asset.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    await runGit(['add', 'asset.png'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'asset.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]));

    const status = await readStatus(scope());
    const diffs = await readDiffs(scope(), status);
    const staged = diffs.staged.find((diff) => diff.path === 'asset.png');
    const unstaged = diffs.unstaged.find((diff) => diff.path === 'asset.png');

    expect(staged).toMatchObject({
      path: 'asset.png',
      source: 'staged',
      status: 'added',
      kind: 'binary',
      isBinary: true,
    });
    expect(unstaged).toMatchObject({
      path: 'asset.png',
      source: 'unstaged',
      status: 'modified',
      kind: 'binary',
      isBinary: true,
    });
  });

  it('classifies exact merge=binary attributes in the single-file lazy path without path-name false positives', async () => {
    await fs.writeFile(path.join(repoPath, '.gitattributes'), 'foo.txt merge=binary\n');
    await fs.writeFile(path.join(repoPath, 'foo.txt'), 'before\n');
    await fs.writeFile(path.join(repoPath, 'binary'), 'plain before\n');
    await runGit(['add', '.gitattributes', 'foo.txt', 'binary'], { cwd: repoPath });
    await runGit(['commit', '--no-gpg-sign', '-m', 'exact binary attr'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'foo.txt'), 'after\n');
    await fs.writeFile(path.join(repoPath, 'binary'), 'plain after\n');

    const status = await readStatus(scope());
    const foo = await readCappedFileDiff(scope(), status, 'unstaged', {
      path: 'foo.txt',
      oldPath: null,
    });
    const plain = await readCappedFileDiff(scope(), status, 'unstaged', {
      path: 'binary',
      oldPath: null,
    });

    expect(foo).toMatchObject({ path: 'foo.txt', kind: 'binary', isBinary: true });
    expect(plain).toMatchObject({ path: 'binary', kind: 'text', isBinary: false });
    expect(plain?.rawPatch).toContain('+plain after');
  });

  it('classifies staged files by index blob size rather than later worktree edits', async () => {
    await fs.writeFile(path.join(repoPath, 'staged-size.txt'), 'base\n');
    await runGit(['add', 'staged-size.txt'], { cwd: repoPath });
    await runGit(['commit', '--no-gpg-sign', '-m', 'staged size seed'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'staged-size.txt'), 'small staged\n');
    await runGit(['add', 'staged-size.txt'], { cwd: repoPath });
    await fs.truncate(path.join(repoPath, 'staged-size.txt'), 80 * 1024 * 1024);

    const status = await readStatus(scope());
    const diffs = await readDiffs(scope(), status);
    const staged = diffs.staged.find((diff) => diff.path === 'staged-size.txt');

    expect(staged).toMatchObject({
      path: 'staged-size.txt',
      source: 'staged',
      kind: 'text',
      isTooLarge: false,
      size: 'small staged\n'.length,
    });
    expect(staged?.rawPatch).toContain('+small staged');
    expect(diffs.capped?.unstaged).toMatchObject({
      reason: 'changed-bytes',
      stats: { fileCount: 1 },
    });
  });

  // NTFS 文件名不允许包含换行,这条只能在 POSIX 上跑。
  it.skipIf(process.platform === 'win32')('falls back to a single-path index size lookup for staged paths containing line breaks', async () => {
    const weirdPath = 'line\nbreak.txt';
    await fs.writeFile(path.join(repoPath, weirdPath), 'base\n');
    await runGit(['add', weirdPath], { cwd: repoPath });
    await runGit(['commit', '--no-gpg-sign', '-m', 'line break path seed'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, weirdPath), 'staged content is longer\n');
    await runGit(['add', weirdPath], { cwd: repoPath });

    const status = await readStatus(scope());
    const entries = await readDiffSummaryEntries(scope(), status, 'staged');
    const entry = entries.find((item) => item.path === weirdPath);

    expect(entry).toMatchObject({
      path: weirdPath,
      changedBytes: 'staged content is longer\n'.length,
    });
  });

  it('preserves oldPath metadata for staged renames', async () => {
    await fs.writeFile(path.join(repoPath, 'old.txt'), 'same\n');
    await runGit(['add', 'old.txt'], { cwd: repoPath });
    await runGit(['commit', '--no-gpg-sign', '-m', 'rename seed'], { cwd: repoPath });
    await runGit(['mv', 'old.txt', 'new.txt'], { cwd: repoPath });

    const status = await readStatus(scope());
    const diffs = await readDiffs(scope(), status);

    expect(diffs.staged[0]).toMatchObject({
      path: 'new.txt',
      oldPath: 'old.txt',
      status: 'renamed',
    });
  });

  it('preserves bulk metadata for pure and modified staged renames independent of git config', async () => {
    await runGit(['config', 'diff.renames', 'false'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'old-r100.txt'), 'same\n');
    await fs.writeFile(path.join(repoPath, 'old-r9x.txt'), 'one\ntwo\nthree\n');
    await runGit(['add', 'old-r100.txt', 'old-r9x.txt'], { cwd: repoPath });
    await runGit(['commit', '--no-gpg-sign', '-m', 'rename fixtures'], { cwd: repoPath });
    await runGit(['mv', 'old-r100.txt', 'new-r100.txt'], { cwd: repoPath });
    await runGit(['mv', 'old-r9x.txt', 'new-r9x.txt'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'new-r9x.txt'), 'one\nTWO\nthree\n');
    await runGit(['add', '-A'], { cwd: repoPath });

    const status = await readStatus(scope());
    const diffs = await readDiffs(scope(), status);
    const pureRename = diffs.staged.find((diff) => diff.path === 'new-r100.txt');
    const modifiedRename = diffs.staged.find((diff) => diff.path === 'new-r9x.txt');

    expect(pureRename).toMatchObject({
      path: 'new-r100.txt',
      oldPath: 'old-r100.txt',
      status: 'renamed',
    });
    expect(modifiedRename).toMatchObject({
      path: 'new-r9x.txt',
      oldPath: 'old-r9x.txt',
      status: 'renamed',
      additions: 1,
      deletions: 1,
    });
    expect(modifiedRename?.rawPatch).toContain('rename from old-r9x.txt');
    expect(modifiedRename?.rawPatch).toContain('+TWO');
  });

  it('reads whitespace-only modified files as empty text diffs when ignoreWhitespace is enabled', async () => {
    await fs.writeFile(path.join(repoPath, 'space.txt'), 'alpha\nbeta\n');
    await runGit(['add', 'space.txt'], { cwd: repoPath });
    await runGit(['commit', '--no-gpg-sign', '-m', 'space seed'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'space.txt'), 'alpha   \nbeta\n');

    const status = await readStatus(scope());
    const diffs = await readDiffs(scope(), status, { ignoreWhitespace: true });

    expect(diffs.unstaged[0]).toMatchObject({
      path: 'space.txt',
      status: 'modified',
      kind: 'text',
      additions: 0,
      deletions: 0,
      hunks: [],
      rawPatch: '',
    });
  });

  it('keeps later patches aligned when ignoreWhitespace drops a whitespace-only patch section', async () => {
    await fs.writeFile(path.join(repoPath, 'a-space.txt'), 'alpha\n');
    await fs.writeFile(path.join(repoPath, 'b-next.txt'), 'beta\n');
    await runGit(['add', 'a-space.txt', 'b-next.txt'], { cwd: repoPath });
    await runGit(['commit', '--no-gpg-sign', '-m', 'whitespace alignment seed'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'a-space.txt'), 'alpha   \n');
    await fs.writeFile(path.join(repoPath, 'b-next.txt'), 'BETA\n');

    const status = await readStatus(scope());
    const diffs = await readDiffs(scope(), status, { ignoreWhitespace: true });
    const whitespaceOnly = diffs.unstaged.find((diff) => diff.path === 'a-space.txt');
    const substantive = diffs.unstaged.find((diff) => diff.path === 'b-next.txt');

    expect(whitespaceOnly).toMatchObject({
      path: 'a-space.txt',
      additions: 0,
      deletions: 0,
      hunks: [],
      rawPatch: '',
    });
    expect(substantive).toMatchObject({
      path: 'b-next.txt',
      additions: 1,
      deletions: 1,
    });
    expect(substantive?.rawPatch).toContain('+BETA');
    expect(substantive?.rawPatch).not.toContain('a-space.txt');
  });

  it('keeps only substantive hunks for mixed whitespace and content changes when ignoreWhitespace is enabled', async () => {
    await fs.writeFile(path.join(repoPath, 'mixed.txt'), 'alpha\nbeta\ngamma\n');
    await runGit(['add', 'mixed.txt'], { cwd: repoPath });
    await runGit(['commit', '--no-gpg-sign', '-m', 'mixed seed'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'mixed.txt'), 'alpha   \nBETA\ngamma\n');

    const status = await readStatus(scope());
    const diffs = await readDiffs(scope(), status, { ignoreWhitespace: true });

    const diff = diffs.unstaged[0];
    expect(diff).toMatchObject({
      path: 'mixed.txt',
      additions: 1,
      deletions: 1,
      kind: 'text',
    });
    expect(diff.rawPatch).toContain('+BETA');
    expect(diff.rawPatch).not.toContain('+alpha   ');
    expect(diff.rawPatch).not.toContain('-alpha');
  });

  it('limits concurrent async work for untracked and classification helpers', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const results = await mapWithConcurrency(Array.from({ length: 20 }, (_, index) => index), 8, async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return item * 2;
    });

    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(results).toEqual(Array.from({ length: 20 }, (_, index) => index * 2));
  });

  it('returns capped summary data for large unstaged worktree diffs', async () => {
    const bulkDir = path.join(repoPath, 'bulk');
    await fs.mkdir(bulkDir);
    await Promise.all(Array.from({ length: 129 }, (_, index) =>
      fs.writeFile(path.join(bulkDir, `file-${index}.txt`), `${index}\n`),
    ));

    const status = await readStatus(scope());
    const diffs = await readDiffs(scope(), status);

    expect(diffs.unstaged).toEqual([]);
    expect(diffs.capped?.unstaged).toMatchObject({
      reason: 'file-count',
      stats: {
        fileCount: 129,
        totalChangedLines: 129,
      },
    });
    expect(diffs.capped?.unstaged?.files[0]).toMatchObject({
      source: 'unstaged',
      id: 'unstaged:bulk/file-0.txt',
      path: 'bulk/file-0.txt',
      status: 'untracked',
      additions: 1,
    });
  });

  it('returns a too-large single-file card diff when capped lazy loading exceeds the file byte limit', async () => {
    await fs.writeFile(path.join(repoPath, 'huge.txt'), 'small\n');
    await runGit(['add', 'huge.txt'], { cwd: repoPath });
    await runGit(['commit', '--no-gpg-sign', '-m', 'huge seed'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'huge.txt'), `${'x'.repeat(3 * 1024 * 1024 + 1)}\n`);

    const status = await readStatus(scope());
    const diff = await readCappedFileDiff(scope(), status, 'unstaged', {
      path: 'huge.txt',
      oldPath: null,
    });

    expect(diff).toMatchObject({
      path: 'huge.txt',
      kind: 'too-large',
      isTooLarge: true,
      hunks: [],
    });
  });
});
