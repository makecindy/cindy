import { promises as fs } from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 });

import { TestDirectoryTemplate } from '../../../test/vitest/testDirectoryTemplate';
import { parseGitDiff } from '../diffParser';
import { formatPatchForSelection, PatchFormatError } from '../patchFormatter';
import { runGit } from '../gitRunner';
import type { DiffSelection, FileDiff } from '../types';

const repos: string[] = [];

const repoTemplate = new TestDirectoryTemplate('xdt-git-review-patch-', async (dir) => {
  await runGit(['init', '-b', 'main'], { cwd: dir });
  await runGit(['config', 'user.email', 'test@xdt.local'], { cwd: dir });
  await runGit(['config', 'user.name', 'XDT Test'], { cwd: dir });
  await runGit(['config', 'commit.gpgsign', 'false'], { cwd: dir });
  // 测试内容显式用 LF 断言;屏蔽全局 autocrlf=true(Windows 默认)对 checkout/apply 的换行改写。
  await runGit(['config', 'core.autocrlf', 'false'], { cwd: dir });
});

function parse(raw: string, path = 'file.txt'): FileDiff {
  return parseGitDiff(raw, { source: 'unstaged', pathHint: path, kind: 'text' });
}

function select(hunkIndex: number, lineIndices: number[]): DiffSelection {
  return { lines: [{ hunkIndex, lineIndices }] };
}

async function initRepo(): Promise<string> {
  const dir = await repoTemplate.createCopy();
  repos.push(dir);
  return dir;
}

async function writeRepoFile(repoPath: string, gitPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(repoPath, gitPath)), { recursive: true });
  await fs.writeFile(path.join(repoPath, gitPath), content);
}

async function commitAll(repoPath: string, message: string): Promise<void> {
  await runGit(['add', '-A'], { cwd: repoPath });
  await runGit(['commit', '--no-gpg-sign', '-m', message], { cwd: repoPath });
}

function headerLines(patch: string): string[] {
  return patch.split('\n').filter((line) =>
    line.startsWith('diff --git ') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ '),
  );
}

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repoPath) =>
    fs.rm(repoPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
  ));
});

afterAll(async () => {
  await repoTemplate.dispose();
});

describe('git-review patchFormatter', () => {
  it('turns an unselected delete before a selected add into context', () => {
    const diff = parse([
      'diff --git a/file.txt b/file.txt',
      'index 1111111..2222222 100644',
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
      ' keep',
      '',
    ].join('\n'));

    const patch = formatPatchForSelection(diff, select(0, [1]));

    expect(patch).toContain(' old\n+new\n keep\n');
    expect(patch).toContain('@@ -1,2 +1,3 @@');
  });

  it('drops unselected add lines', () => {
    const diff = parse([
      'diff --git a/file.txt b/file.txt',
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1,2 +1,3 @@',
      ' keep',
      '+skip',
      '+take',
      '',
    ].join('\n'));

    const patch = formatPatchForSelection(diff, select(0, [2]));

    expect(patch).not.toContain('+skip');
    expect(patch).toContain('+take');
  });

  it('formats partial new files', () => {
    const diff = parse([
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,3 @@',
      '+one',
      '+two',
      '+three',
      '',
    ].join('\n'), 'new.txt');

    const patch = formatPatchForSelection(diff, select(0, [0, 2]));

    expect(patch).toContain('new file mode 100644');
    expect(patch).toContain('--- /dev/null\n+++ b/new.txt');
    expect(patch).toContain('+one\n+three\n');
    expect(patch).not.toContain('+two');
  });

  it('formats partial deleted files as modified patches', () => {
    const diff = parse([
      'diff --git a/deleted.txt b/deleted.txt',
      'deleted file mode 100644',
      '--- a/deleted.txt',
      '+++ /dev/null',
      '@@ -1,3 +0,0 @@',
      '-one',
      '-two',
      '-three',
      '',
    ].join('\n'), 'deleted.txt');

    const patch = formatPatchForSelection(diff, select(0, [1]));

    expect(patch).not.toContain('deleted file mode');
    expect(patch).toContain('--- a/deleted.txt\n+++ b/deleted.txt');
    expect(patch).toContain(' one\n-two\n three\n');
  });

  it('preserves no-newline markers and blank context lines', () => {
    const diff = parse([
      'diff --git a/file.txt b/file.txt',
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1,2 +1,2 @@',
      ' ',
      '-old',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n'));

    const patch = formatPatchForSelection(diff, select(0, [2]));

    expect(patch).toContain('\n \n old\n+new\n\\ No newline at end of file\n');
  });

  it('throws for empty selections', () => {
    const diff = parse([
      'diff --git a/file.txt b/file.txt',
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1,1 +1,2 @@',
      ' keep',
      '+skip',
      '',
    ].join('\n'));

    expect(() => formatPatchForSelection(diff, select(0, []))).toThrow(PatchFormatError);
  });

  // NTFS 文件名不允许含 \t / \n / ",这些用例只能在 POSIX 上落盘;
  // back\slash.txt 在 Windows 上会被当路径分隔符,git 侧等价 back/slash.txt,仍可跑。
  it.each([
    ['tab\tname.txt'],
    ['line\nname.txt'],
    ['quote"name.txt'],
    ['back\\slash.txt'],
  ].filter(([name]) => process.platform !== 'win32' || !/[\t\n"]/.test(name)))('quotes patch headers like git and applies selected hunks for %j', async (filePath) => {
    const repoPath = await initRepo();
    await writeRepoFile(repoPath, filePath, 'one\ntwo\n');
    await commitAll(repoPath, 'seed');
    await writeRepoFile(repoPath, filePath, 'one\nTWO\n');

    const { stdout: rawWithMeta } = await runGit([
      'diff',
      '--no-ext-diff',
      '--patch-with-raw',
      '-z',
      '--no-color',
      '--',
      filePath,
    ], { cwd: repoPath });
    const { stdout: nativePatch } = await runGit([
      'diff',
      '--no-ext-diff',
      '--patch',
      '--no-color',
      '--',
      filePath,
    ], { cwd: repoPath });
    const diff = parseGitDiff(rawWithMeta, { source: 'unstaged', kind: 'text' });
    const formatted = formatPatchForSelection(diff, select(0, diff.hunks[0].selectableLines));

    expect(headerLines(formatted)).toEqual(headerLines(nativePatch));
    await runGit(['apply', '--cached', '--unidiff-zero', '-'], { cwd: repoPath, stdin: formatted });
    expect((await runGit(['diff', '--cached', '--', filePath], { cwd: repoPath })).stdout).toContain('+TWO');
  });
});
