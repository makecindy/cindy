import { promises as fs, symlinkSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// Windows 上 git 子进程明显更慢；完整 workspace 并发测试时，hunk 的多步
// stage/unstage/discard 编排会超过 30s，给真实 Git 集成用例留足余量。
vi.setConfig({ testTimeout: 60_000 });

// Windows 未开发者模式/无特权时创建文件 symlink 会 EPERM;探测一次,不可用则跳过 symlink 用例。
const canSymlink = (() => {
  const probe = path.join(os.tmpdir(), `xdt-symlink-probe-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    symlinkSync(`${probe}-target`, probe, 'file');
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
})();

import { TestDirectoryTemplate } from '../../../test/vitest/testDirectoryTemplate';
import {
  parseCommitDiffPayload,
  parseHunkPayload,
  parseImagePreviewPayload,
  parseMarkdownPreviewPayload,
  parseOpenFilePayload,
  parseTarget,
  openReviewFile,
  runReviewFileStageOperation,
  runReviewHunkStageOperation,
} from '../ipc';
import { readDiffs } from '../diffReader';
import { runGit } from '../gitRunner';
import { readStatus } from '../statusReader';
import type { FileDiff, GitReviewDeps, ReviewDiffReadOptions, ReviewScope } from '../types';

const repos: string[] = [];
const HEX_OID = '0123456789abcdef0123456789abcdef01234567';
const SHORT_HEX_OID = 'abc1234';

function baseDiff(patch: Partial<FileDiff> = {}): FileDiff {
  return {
    id: 'unstaged:file.txt',
    source: 'unstaged',
    path: 'file.txt',
    oldPath: null,
    status: 'modified',
    kind: 'text',
    size: 10,
    additions: 1,
    deletions: 0,
    isBinary: false,
    isSubmodule: false,
    isTooLarge: false,
    mode: { old: null, new: null },
    index: { oldOid: null, newOid: null },
    rawHeader: '',
    rawPatch: '',
    hunks: [{ index: 0, header: '@@ -1 +1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, section: '', lines: [], selectableLines: [], raw: '' }],
    error: null,
    ...patch,
  };
}

const repoTemplate = new TestDirectoryTemplate('xdt-git-review-ipc-', async (dir) => {
  await runGit(['init', '-b', 'main'], { cwd: dir });
  await runGit(['config', 'user.email', 'test@xdt.local'], { cwd: dir });
  await runGit(['config', 'user.name', 'XDT Test'], { cwd: dir });
  await runGit(['config', 'commit.gpgsign', 'false'], { cwd: dir });
  // 测试内容显式用 LF 断言;屏蔽全局 autocrlf=true(Windows 默认)对 checkout/apply 的换行改写。
  await runGit(['config', 'core.autocrlf', 'false'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'seed.txt'), 'seed\n');
  await runGit(['add', 'seed.txt'], { cwd: dir });
  await runGit(['commit', '--no-gpg-sign', '-m', 'seed'], { cwd: dir });
});

async function initRepo(): Promise<string> {
  const dir = await repoTemplate.createCopy();
  repos.push(dir);
  return dir;
}

function gitDeps(baseScope: ReviewScope): GitReviewDeps {
  return {
    resolveScope: vi.fn(async () => baseScope),
    readStatus,
    readDiffs,
    isSessionRunning: () => false,
  };
}

function scope(repoPath: string): ReviewScope {
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

afterEach(async () => {
  await Promise.all(repos.splice(0).map((repoPath) =>
    fs.rm(repoPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
  ));
});

afterAll(async () => {
  await repoTemplate.dispose();
});

describe('git-review IPC payload guards', () => {
  it('rejects unsafe file targets before write operations reach stageOps', () => {
    expect(() => parseTarget({ source: 'unstaged', path: '../secret.txt' })).toThrow(/\[INVALID_PARAMS\]/);
    expect(() => parseTarget({ source: 'unstaged', path: 'C:\\Users\\secret.txt' })).toThrow(/\[INVALID_PARAMS\]/);
    expect(() => parseTarget({ source: 'unstaged', path: 'file.txt', oldPath: '../old.txt' })).toThrow(/\[INVALID_PARAMS\]/);
  });

  it('rejects unsafe open-file paths before resolving the worktree file', () => {
    expect(() => parseOpenFilePayload({ sessionId: 's1', path: '../secret.txt' })).toThrow(/\[INVALID_PARAMS\]/);
    expect(() => parseOpenFilePayload({ sessionId: 's1', path: 'C:\\Users\\secret.txt' })).toThrow(/\[INVALID_PARAMS\]/);
  });

  it('rejects unsafe hunk diff paths from renderer payloads', () => {
    expect(() => parseHunkPayload({
      sessionId: 's1',
      diff: baseDiff({ path: 'docs/../secret.md' }),
      hunkIndex: 0,
    })).toThrow(/\[INVALID_PARAMS\]/);
    expect(() => parseHunkPayload({
      sessionId: 's1',
      diff: baseDiff({ oldPath: '../old.txt' }),
      hunkIndex: 0,
    })).toThrow(/\[INVALID_PARAMS\]/);
  });

  it('requires hunk ignoreWhitespace to be a strict boolean when provided', () => {
    expect(parseHunkPayload({
      sessionId: 's1',
      diff: baseDiff(),
      hunkIndex: 0,
      ignoreWhitespace: true,
    }).options).toEqual({ ignoreWhitespace: true });
    expect(() => parseHunkPayload({
      sessionId: 's1',
      diff: baseDiff(),
      hunkIndex: 0,
      ignoreWhitespace: 'true',
    })).toThrow(/\[INVALID_PARAMS\]/);
  });

  it('keeps hex diff index oids, including git abbreviations, and drops non-hex revspecs', () => {
    const image = parseImagePreviewPayload({
      sessionId: 's1',
      diff: baseDiff({
        source: 'staged',
        kind: 'binary',
        path: 'asset.png',
        index: { oldOid: SHORT_HEX_OID, newOid: HEX_OID },
      }),
    });
    const markdown = parseMarkdownPreviewPayload({
      sessionId: 's1',
      diff: baseDiff({
        path: 'README.md',
        index: { oldOid: HEX_OID, newOid: 'main:README.md' },
      }),
    });

    expect(image.request.diff.index).toEqual({ oldOid: SHORT_HEX_OID, newOid: HEX_OID });
    expect(markdown.request.diff.index).toEqual({ oldOid: HEX_OID, newOid: null });
  });

  it('rejects non-hex commit ids for commit diffs and preview requests', () => {
    expect(() => parseCommitDiffPayload({ sessionId: 's1', oid: 'HEAD' })).toThrow(/\[INVALID_PARAMS\]/);
    expect(() => parseImagePreviewPayload({
      sessionId: 's1',
      diff: baseDiff({ source: 'commit', kind: 'binary', path: 'asset.png' }),
      commitOid: 'HEAD',
    })).toThrow(/\[INVALID_PARAMS\]/);
    expect(() => parseMarkdownPreviewPayload({
      sessionId: 's1',
      diff: baseDiff({ source: 'commit', path: 'README.md' }),
      commitOid: 'feature',
    })).toThrow(/\[INVALID_PARAMS\]/);
  });
});

describe('git-review scoped open file', () => {
  it('opens safe worktree files after IPC parsing and realpath containment checks', async () => {
    const repoPath = await initRepo();
    const filePath = path.join(repoPath, 'huge.txt');
    await fs.writeFile(filePath, 'large file placeholder\n');
    const openPath = vi.fn(async () => '');
    const parsed = parseOpenFilePayload(JSON.parse(JSON.stringify({
      sessionId: 's1',
      path: 'huge.txt',
    })));

    await openReviewFile(parsed.sessionId, parsed.path, { resolveScope: vi.fn(async () => scope(repoPath)) }, openPath);

    expect(openPath).toHaveBeenCalledWith(await fs.realpath(filePath));
  });

  it('rejects missing worktree files without calling shell.openPath', async () => {
    const repoPath = await initRepo();
    const openPath = vi.fn(async () => '');
    const parsed = parseOpenFilePayload({
      sessionId: 's1',
      path: 'missing.txt',
    });

    await expect(openReviewFile(
      parsed.sessionId,
      parsed.path,
      { resolveScope: vi.fn(async () => scope(repoPath)) },
      openPath,
    )).rejects.toThrow(/\[PRECONDITION_FAILED\].*does not exist/);
    expect(openPath).not.toHaveBeenCalled();
  });

  it.skipIf(!canSymlink)('rejects symlinks that resolve outside the repository', async () => {
    const repoPath = await initRepo();
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xdt-git-review-outside-'));
    repos.push(outsideDir);
    const outsideFile = path.join(outsideDir, 'secret.txt');
    await fs.writeFile(outsideFile, 'secret\n');
    await fs.symlink(outsideFile, path.join(repoPath, 'escape.txt'));
    const openPath = vi.fn(async () => '');
    const parsed = parseOpenFilePayload({
      sessionId: 's1',
      path: 'escape.txt',
    });

    await expect(openReviewFile(
      parsed.sessionId,
      parsed.path,
      { resolveScope: vi.fn(async () => scope(repoPath)) },
      openPath,
    )).rejects.toThrow(/\[PRECONDITION_FAILED\].*outside/);
    expect(openPath).not.toHaveBeenCalled();
  });
});

describe('git-review write busy gate', () => {
  it('rejects queued writes while the session is running', async () => {
    const deps: GitReviewDeps = {
      resolveScope: vi.fn(),
      readStatus: vi.fn(),
      readDiffs: vi.fn(),
      isSessionRunning: () => true,
    };

    await expect(runReviewFileStageOperation('s1', 'stage', [
      { source: 'unstaged', path: 'file.txt', oldPath: null },
    ], deps)).rejects.toMatchObject({ code: 'SESSION_RUNNING' });
    expect(deps.resolveScope).not.toHaveBeenCalled();
  });

  it('allows normal writes when the session is idle', async () => {
    const repoPath = await initRepo();
    await fs.writeFile(path.join(repoPath, 'new.txt'), 'new\n');
    const baseScope = scope(repoPath);
    const deps: GitReviewDeps = {
      resolveScope: vi.fn(async () => baseScope),
      readStatus,
      readDiffs,
      isSessionRunning: () => false,
    };

    const result = await runReviewFileStageOperation('s1', 'stage', [
      { source: 'unstaged', path: 'new.txt', oldPath: null },
    ], deps);

    expect(result.operation.failed).toHaveLength(0);
    expect(result.operation.succeeded).toEqual(['new.txt']);
    expect((await readStatus(baseScope)).files.find((file) => file.path === 'new.txt')?.indexStatus).toBe('added');
  });

  it('stages untracked files from expanded directory entries after IPC parsing', async () => {
    const repoPath = await initRepo();
    const baseScope = scope(repoPath);
    const deps = gitDeps(baseScope);
    await fs.mkdir(path.join(repoPath, 'new-dir'), { recursive: true });
    await fs.writeFile(path.join(repoPath, 'new-dir', 'a.txt'), 'alpha\n');

    const current = await readStatus(baseScope);
    const diff = (await readDiffs(current.scope, current)).unstaged.find((item) => item.path === 'new-dir/a.txt');
    expect(diff).toMatchObject({
      path: 'new-dir/a.txt',
      oldPath: null,
      status: 'untracked',
    });

    const target = parseTarget(JSON.parse(JSON.stringify({
      source: 'unstaged',
      path: diff!.path,
      oldPath: diff!.oldPath,
    })));
    const result = await runReviewFileStageOperation('s1', 'stage', [target], deps);

    expect(result.operation.failed).toHaveLength(0);
    expect(result.operation.succeeded).toEqual(['new-dir/a.txt']);
    expect((await runGit(['status', '--porcelain', '--untracked-files=all'], { cwd: repoPath })).stdout)
      .toContain('A  new-dir/a.txt');
  });
});

describe('git-review hunk IPC roundtrip', () => {
  async function parseCurrentHunk(
    repoPath: string,
    source: 'staged' | 'unstaged',
    options: ReviewDiffReadOptions,
  ) {
    const baseScope = scope(repoPath);
    const current = await readStatus(baseScope);
    const diff = (await readDiffs(current.scope, current, options))[source][0];
    expect(diff?.hunks[0]).toBeTruthy();

    const payload = JSON.parse(JSON.stringify({
      sessionId: 's1',
      diff,
      hunkIndex: diff.hunks[0].index,
      ignoreWhitespace: options.ignoreWhitespace,
    }));
    const parsed = parseHunkPayload(payload);
    expect(parsed.diff.index).toEqual(diff.index);
    expect(parsed.diff.index.oldOid ?? parsed.diff.index.newOid).toMatch(/^[0-9a-f]{4,64}$/i);
    return { baseScope, parsed };
  }

  it('keeps abbreviated index oids fresh through hunk stage, unstage, and discard IPC parsing', async () => {
    const repoPath = await initRepo();
    const baseScope = scope(repoPath);
    const deps = gitDeps(baseScope);
    await fs.writeFile(path.join(repoPath, 'seed.txt'), 'changed\n');

    let parsed = (await parseCurrentHunk(repoPath, 'unstaged', {})).parsed;
    await runReviewHunkStageOperation('s1', 'stage', parsed.diff, parsed.hunkIndex, parsed.options, deps);
    expect((await runGit(['diff', '--cached', '--', 'seed.txt'], { cwd: repoPath })).stdout).toContain('+changed');

    parsed = (await parseCurrentHunk(repoPath, 'staged', {})).parsed;
    await runReviewHunkStageOperation('s1', 'unstage', parsed.diff, parsed.hunkIndex, parsed.options, deps);
    expect((await runGit(['diff', '--cached', '--', 'seed.txt'], { cwd: repoPath })).stdout).toBe('');
    expect((await runGit(['diff', '--', 'seed.txt'], { cwd: repoPath })).stdout).toContain('+changed');

    parsed = (await parseCurrentHunk(repoPath, 'unstaged', {})).parsed;
    await runReviewHunkStageOperation('s1', 'discard', parsed.diff, parsed.hunkIndex, parsed.options, deps);
    expect((await runGit(['diff', '--', 'seed.txt'], { cwd: repoPath })).stdout).toBe('');
    expect(await fs.readFile(path.join(repoPath, 'seed.txt'), 'utf8')).toBe('seed\n');
  });

  it('keeps hidden-whitespace hunk IPC operations fresh without dropping whitespace-only edits', async () => {
    const repoPath = await initRepo();
    const baseScope = scope(repoPath);
    const deps = gitDeps(baseScope);
    await fs.writeFile(path.join(repoPath, 'seed.txt'), 'one\nalpha\nkeep = 1;\nbeta\ngamma\n');
    await runGit(['add', 'seed.txt'], { cwd: repoPath });
    await runGit(['commit', '--no-gpg-sign', '-m', 'whitespace fixture'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'seed.txt'), 'one\nalpha\nkeep = 2;\n  beta\ngamma\n');

    let parsed = (await parseCurrentHunk(repoPath, 'unstaged', { ignoreWhitespace: true })).parsed;
    await runReviewHunkStageOperation('s1', 'stage', parsed.diff, parsed.hunkIndex, parsed.options, deps);
    expect((await runGit(['diff', '--cached', '--', 'seed.txt'], { cwd: repoPath })).stdout).toContain('+keep = 2;');
    expect((await runGit(['diff', '--', 'seed.txt'], { cwd: repoPath })).stdout).toContain('+  beta');

    parsed = (await parseCurrentHunk(repoPath, 'staged', { ignoreWhitespace: true })).parsed;
    await runReviewHunkStageOperation('s1', 'unstage', parsed.diff, parsed.hunkIndex, parsed.options, deps);
    expect((await runGit(['diff', '--cached', '--', 'seed.txt'], { cwd: repoPath })).stdout).toBe('');
    expect((await runGit(['diff', '--', 'seed.txt'], { cwd: repoPath })).stdout).toContain('+keep = 2;');
    expect((await runGit(['diff', '--', 'seed.txt'], { cwd: repoPath })).stdout).toContain('+  beta');

    parsed = (await parseCurrentHunk(repoPath, 'unstaged', { ignoreWhitespace: true })).parsed;
    await runReviewHunkStageOperation('s1', 'discard', parsed.diff, parsed.hunkIndex, parsed.options, deps);
    const worktree = await fs.readFile(path.join(repoPath, 'seed.txt'), 'utf8');
    expect(worktree).toContain('keep = 1;');
    expect(worktree).toContain('  beta');
    const remaining = (await runGit(['diff', '--', 'seed.txt'], { cwd: repoPath })).stdout;
    expect(remaining).toContain('+  beta');
    expect(remaining).not.toContain('+keep = 2;');
  });

  it('rejects modified rename hunk unstage after IPC parsing without splitting the rename', async () => {
    const repoPath = await initRepo();
    const baseScope = scope(repoPath);
    const deps = gitDeps(baseScope);
    await runGit(['config', 'diff.renames', 'false'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'seed.txt'), 'one\ntwo\nthree\n');
    await runGit(['add', 'seed.txt'], { cwd: repoPath });
    await runGit(['commit', '--no-gpg-sign', '-m', 'rename fixture'], { cwd: repoPath });
    await runGit(['mv', 'seed.txt', 'renamed.txt'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'renamed.txt'), 'one\nTWO\nthree\n');
    await runGit(['add', '-A'], { cwd: repoPath });

    const current = await readStatus(baseScope);
    const diff = (await readDiffs(current.scope, current)).staged.find((item) => item.path === 'renamed.txt');
    expect(diff).toMatchObject({
      path: 'renamed.txt',
      oldPath: 'seed.txt',
      status: 'renamed',
    });
    expect(diff?.hunks[0]).toBeTruthy();

    const payload = JSON.parse(JSON.stringify({
      sessionId: 's1',
      diff,
      hunkIndex: diff!.hunks[0].index,
    }));
    const parsed = parseHunkPayload(payload);

    await expect(runReviewHunkStageOperation(
      's1',
      'unstage',
      parsed.diff,
      parsed.hunkIndex,
      parsed.options,
      deps,
    )).rejects.toThrow(/\[PRECONDITION_FAILED\].*rename/s);

    const cachedNameStatus = (await runGit(['diff', '--cached', '--name-status', '-M'], { cwd: repoPath })).stdout;
    expect(cachedNameStatus).toContain('R');
    expect(cachedNameStatus).toContain('seed.txt');
    expect(cachedNameStatus).toContain('renamed.txt');
    expect((await runGit(['status', '--porcelain', '--renames'], { cwd: repoPath })).stdout).not.toContain('?? renamed.txt');
  });
});
