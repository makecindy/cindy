import { promises as fs } from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Windows 上 git 子进程明显更慢(每次 spawn 数百毫秒),多步 git 编排用例会超默认 5s。
vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 });

import { TestDirectoryTemplate } from '../../../test/vitest/testDirectoryTemplate';
import { readBranchDiff } from '../branchReader';
import { readCommitDiff } from '../commitReader';
import { readDiffs } from '../diffReader';
import { runGit } from '../gitRunner';
import {
  MARKDOWN_PREVIEW_MAX_BYTES,
  isPreviewableMarkdownDiff,
  readMarkdownPreview,
  type MarkdownPreviewReaderDeps,
} from '../markdownReader';
import { readStatus } from '../statusReader';
import type { FileDiff, ReviewScope } from '../types';

let repoPath: string;

const repoTemplate = new TestDirectoryTemplate('xdt-git-review-markdown-', async (dir) => {
  await runGit(['init', '-b', 'main'], { cwd: dir });
  await runGit(['config', 'user.email', 'test@xdt.local'], { cwd: dir });
  await runGit(['config', 'user.name', 'XDT Test'], { cwd: dir });
  await runGit(['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'seed.txt'), 'seed\n');
  await runGit(['add', 'seed.txt'], { cwd: dir });
  await runGit(['commit', '--no-gpg-sign', '-m', 'seed'], { cwd: dir });
});

function scope(branch = 'main'): ReviewScope {
  return {
    sessionId: 's1',
    workdir: repoPath,
    worktreePath: repoPath,
    workingDir: repoPath,
    repoRoot: repoPath,
    branch,
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

async function commitAll(message: string): Promise<string> {
  await runGit(['add', '-A'], { cwd: repoPath });
  await runGit(['commit', '--no-gpg-sign', '-m', message], { cwd: repoPath });
  const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd: repoPath });
  return stdout.trim();
}

async function writeRepoFile(gitPath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(repoPath, gitPath)), { recursive: true });
  await fs.writeFile(path.join(repoPath, gitPath), content);
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

async function currentDiff(source: 'staged' | 'unstaged', filePath: string): Promise<FileDiff> {
  const status = await readStatus(scope());
  const diffs = await readDiffs(scope(), status);
  const diff = diffs[source].find((item) => item.path === filePath);
  if (!diff) throw new Error(`missing ${source} diff for ${filePath}`);
  return diff;
}

function fakeMarkdownDiff(patch: Partial<FileDiff> = {}): FileDiff {
  return {
    id: 'unstaged:docs/readme.md',
    source: 'unstaged',
    path: 'docs/readme.md',
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
    hunks: [],
    error: null,
    ...patch,
  };
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

describe('git-review markdownReader', () => {
  it('recognizes markdown diffs and excludes deleted/binary/large files', () => {
    expect(isPreviewableMarkdownDiff(fakeMarkdownDiff({ path: 'README.MD' }))).toBe(true);
    expect(isPreviewableMarkdownDiff(fakeMarkdownDiff({ path: 'docs/readme.txt' }))).toBe(false);
    expect(isPreviewableMarkdownDiff(fakeMarkdownDiff({ status: 'deleted' }))).toBe(false);
    expect(isPreviewableMarkdownDiff(fakeMarkdownDiff({ kind: 'binary', isBinary: true }))).toBe(false);
    expect(isPreviewableMarkdownDiff(fakeMarkdownDiff({ kind: 'large-text' }))).toBe(false);
  });

  it('reads unstaged markdown from the worktree', async () => {
    await writeRepoFile('docs/readme.md', '# Base\n');
    await commitAll('add markdown');
    await writeRepoFile('docs/readme.md', '# Worktree\n');

    const diff = await currentDiff('unstaged', 'docs/readme.md');
    const preview = await readMarkdownPreview(scope(), { diff });

    expect(preview.reason).toBeNull();
    expect(preview.content).toBe('# Worktree\n');
    expect(preview.baseDir).toBe(path.join(repoPath, 'docs'));
  });

  it('reads staged markdown from the index rather than later worktree edits', async () => {
    await writeRepoFile('docs/readme.md', '# Base\n');
    await commitAll('add markdown');
    await writeRepoFile('docs/readme.md', '# Staged\n');
    await runGit(['add', 'docs/readme.md'], { cwd: repoPath });
    await writeRepoFile('docs/readme.md', '# Worktree after staging\n');

    const diff = await currentDiff('staged', 'docs/readme.md');
    const preview = await readMarkdownPreview(scope(), { diff });

    expect(preview.reason).toBeNull();
    expect(preview.content).toBe('# Staged\n');
  });

  it('reads commit markdown from the selected commit blob, not the worktree', async () => {
    await writeRepoFile('docs/readme.md', '# Base\n');
    await commitAll('add markdown');
    await writeRepoFile('docs/readme.md', '# Commit content\n');
    const oid = await commitAll('modify markdown');
    await writeRepoFile('docs/readme.md', '# Worktree drift\n');
    const commitDiff = await readCommitDiff(scope(), oid);
    const diff = commitDiff.diffs.find((item) => item.path === 'docs/readme.md');
    if (!diff) throw new Error('missing commit markdown diff');

    const preview = await readMarkdownPreview(scope(), { diff, commitOid: oid });

    expect(diff.source).toBe('commit');
    expect(preview.reason).toBeNull();
    expect(preview.content).toBe('# Commit content\n');
  });

  it('reads branch markdown from HEAD, not the worktree', async () => {
    await writeRepoFile('docs/readme.md', '# Base\n');
    await commitAll('add markdown');
    await runGit(['checkout', '-b', 'feature'], { cwd: repoPath });
    await writeRepoFile('docs/readme.md', '# Feature HEAD\n');
    await commitAll('modify markdown on feature');
    await writeRepoFile('docs/readme.md', '# Worktree drift\n');
    const branchDiff = await readBranchDiff(scope('feature'), 'main');
    const diff = branchDiff.diffs.find((item) => item.path === 'docs/readme.md');
    if (!diff) throw new Error('missing branch markdown diff');

    const preview = await readMarkdownPreview(scope('feature'), { diff, branchBaseRef: 'main' });

    expect(diff.source).toBe('branch');
    expect(preview.reason).toBeNull();
    expect(preview.content).toBe('# Feature HEAD\n');
  });

  it('pins branch markdown preview to the diff blob after HEAD advances', async () => {
    await writeRepoFile('docs/readme.md', '# Base\n');
    await commitAll('add markdown');
    await runGit(['checkout', '-b', 'feature'], { cwd: repoPath });
    await writeRepoFile('docs/readme.md', '# Feature diff version\n');
    await commitAll('modify markdown on feature');
    const branchDiff = await readBranchDiff(scope('feature'), 'main');
    const diff = branchDiff.diffs.find((item) => item.path === 'docs/readme.md');
    if (!diff) throw new Error('missing branch markdown diff');
    expect(diff.index.newOid).toMatch(/^[0-9a-f]{4,64}$/i);
    await writeRepoFile('docs/readme.md', '# Newer HEAD version\n');
    await commitAll('advance feature again');

    const preview = await readMarkdownPreview(scope('feature'), {
      diff,
      branchBaseRef: 'main',
    });

    expect(preview.reason).toBeNull();
    expect(preview.content).toBe('# Feature diff version\n');
  });

  it('resolves branch markdown preview base through the remote ref before a same-name tag', async () => {
    await writeRepoFile('docs/readme.md', '# Base\n');
    const baseOid = await commitAll('add markdown');
    await runGit(['update-ref', 'refs/remotes/origin/main', baseOid], { cwd: repoPath });
    await runGit(['checkout', '-b', 'feature'], { cwd: repoPath });
    await writeRepoFile('docs/readme.md', '# Feature HEAD\n');
    await commitAll('modify markdown on feature');
    const { stdout: unrelatedOid } = await runGit(['commit-tree', 'HEAD^{tree}', '-m', 'unrelated tag target'], { cwd: repoPath });
    await runGit(['tag', 'origin/main', unrelatedOid.trim()], { cwd: repoPath });
    const branchDiff = await readBranchDiff(scope('feature'), 'origin/main');
    const diff = branchDiff.diffs.find((item) => item.path === 'docs/readme.md');
    if (!diff) throw new Error('missing branch markdown diff');

    const preview = await readMarkdownPreview(scope('feature'), { diff, branchBaseRef: 'origin/main' });

    expect(branchDiff.baseOid).toBe(baseOid);
    expect(preview.reason).toBeNull();
    expect(preview.content).toBe('# Feature HEAD\n');
  });

  it('returns structured fallback data for deleted and unsafe paths', async () => {
    await writeRepoFile('docs/readme.md', '# Base\n');
    await commitAll('add markdown');
    await fs.rm(path.join(repoPath, 'docs/readme.md'));
    const deleted = await currentDiff('unstaged', 'docs/readme.md');

    await expect(readMarkdownPreview(scope(), { diff: deleted })).resolves.toMatchObject({
      content: null,
      reason: 'deleted',
    });
    await expect(readMarkdownPreview(scope(), { diff: fakeMarkdownDiff({ path: '../readme.md' }) })).resolves.toMatchObject({
      content: null,
      reason: 'unsafe-path',
    });
  });

  it('rejects worktree markdown previews for symlinks that point outside the repo', async () => {
    const outsidePath = path.join(path.dirname(repoPath), `${path.basename(repoPath)}-outside.md`);
    await fs.writeFile(outsidePath, '# Outside secret\n');
    await fs.mkdir(path.join(repoPath, 'docs'), { recursive: true });
    const linked = await tryCreateFileSymlink(outsidePath, path.join(repoPath, 'docs/link.md'));
    if (!linked) {
      await fs.rm(outsidePath, { force: true });
      return;
    }

    try {
      const preview = await readMarkdownPreview(scope(), {
        diff: fakeMarkdownDiff({
          id: 'unstaged:docs/link.md',
          path: 'docs/link.md',
          status: 'untracked',
        }),
      });

      expect(preview).toMatchObject({
        content: null,
        reason: 'unsupported-kind',
        error: 'markdown symlink preview is unavailable',
      });
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
  });

  it('rejects worktree markdown previews through symlinked directories outside the repo', async () => {
    const outsideDir = path.join(path.dirname(repoPath), `${path.basename(repoPath)}-outside-dir`);
    await fs.mkdir(outsideDir);
    await fs.writeFile(path.join(outsideDir, 'notes.md'), '# Outside secret\n');
    const linked = await tryCreateFileSymlink(outsideDir, path.join(repoPath, 'linkdir'));
    if (!linked) {
      await fs.rm(outsideDir, { recursive: true, force: true });
      return;
    }

    try {
      const preview = await readMarkdownPreview(scope(), {
        diff: fakeMarkdownDiff({
          id: 'unstaged:linkdir/notes.md',
          path: 'linkdir/notes.md',
          status: 'untracked',
        }),
      });

      expect(preview).toMatchObject({
        content: null,
        reason: 'unsafe-path',
        error: 'File resolves outside the repository',
      });
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('guards oversized worktree markdown without reading the file body', async () => {
    const readFile = vi.fn();
    const deps: MarkdownPreviewReaderDeps = {
      runGit,
      runGitBuffer: vi.fn(),
      lstat: vi.fn(async () => ({
        isSymbolicLink: () => false,
      } as unknown as Awaited<ReturnType<MarkdownPreviewReaderDeps['lstat']>>)),
      realpath: vi.fn(async (filePath: string) => filePath),
      stat: vi.fn(async () => ({
        isFile: () => true,
        size: MARKDOWN_PREVIEW_MAX_BYTES + 1,
      } as unknown as Awaited<ReturnType<MarkdownPreviewReaderDeps['stat']>>)),
      readFile,
    };

    const preview = await readMarkdownPreview(scope(), { diff: fakeMarkdownDiff() }, deps);

    expect(preview).toMatchObject({
      content: null,
      reason: 'too-large',
      size: MARKDOWN_PREVIEW_MAX_BYTES + 1,
    });
    expect(readFile).not.toHaveBeenCalled();
  });
});
