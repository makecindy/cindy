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
  MARKDOWN_PREVIEW_BEFORE_MAX_BYTES,
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
    // before 侧取自 index（对齐 diff 的 old 侧），不是后来的 worktree 内容。
    expect(preview.beforeContent).toBe('# Base\n');
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
    expect(preview.beforeContent).toBe('# Base\n');
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
    expect(preview.beforeContent).toBe('# Base\n');
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
    expect(preview.beforeContent).toBe('# Base\n');
  });

  it('anchors the branch baseline to the merge base when the base ref advances', async () => {
    await writeRepoFile('docs/readme.md', '# Base\n');
    await commitAll('add markdown');
    await runGit(['checkout', '-b', 'feature'], { cwd: repoPath });
    await writeRepoFile('docs/readme.md', '# Feature HEAD\n');
    await commitAll('modify markdown on feature');
    // 分支切出后上游又改了同一文件：base ref 的 tip 已经不是 merge-base。
    await runGit(['checkout', 'main'], { cwd: repoPath });
    await writeRepoFile('docs/readme.md', '# Upstream moved on\n');
    await commitAll('advance main');
    await runGit(['checkout', 'feature'], { cwd: repoPath });

    const branchDiff = await readBranchDiff(scope('feature'), 'main');
    const diff = branchDiff.diffs.find((item) => item.path === 'docs/readme.md');
    if (!diff) throw new Error('missing branch markdown diff');
    const preview = await readMarkdownPreview(scope('feature'), { diff, branchBaseRef: 'main' });

    // before 必须取 merge-base（# Base），而不是 base ref 的 tip
    // （# Upstream moved on）：branch diff 本身就是 merge-base..HEAD，拿 tip
    // 当基线会把上游的改动伪造成本分支的插入 / 删除。
    expect(branchDiff.mergeBaseOid).not.toBe(branchDiff.baseOid);
    expect(preview.beforeContent).toBe('# Base\n');
  });

  it('pins the branch baseline to the diff-time merge-base snapshot (regression)', async () => {
    // 快照场景：分支随后把 base 合并进来，merge-base 前进了 —— 现场重算会拿到别的
    // 基线，与界面里那份 diff 对不上；带上生成 diff 时的 merge-base OID 就固定住了。
    await writeRepoFile('docs/readme.md', '# Base\n');
    await commitAll('add markdown');
    await runGit(['checkout', '-b', 'feature'], { cwd: repoPath });
    await writeRepoFile('docs/readme.md', '# Feature\n');
    await commitAll('modify markdown on feature');
    await runGit(['checkout', 'main'], { cwd: repoPath });
    await writeRepoFile('docs/readme.md', '# Upstream moved on\n');
    await commitAll('advance main');
    await runGit(['checkout', 'feature'], { cwd: repoPath });

    const branchDiff = await readBranchDiff(scope('feature'), 'main');
    const diff = branchDiff.diffs.find((item) => item.path === 'docs/readme.md');
    if (!diff) throw new Error('missing branch markdown diff');
    const snapshot = branchDiff.mergeBaseOid;
    if (!snapshot) throw new Error('missing merge base snapshot');

    // 分支把 base 合并进来（同文件冲突用 -X ours 解）：merge-base 前进到 main 的 tip。
    await runGit(['merge', '--no-ff', '--no-gpg-sign', '-X', 'ours', '-m', 'merge main', 'main'], {
      cwd: repoPath,
    });

    // 带快照：before 仍是生成 diff 那一刻的 merge-base（# Base）。
    const pinned = await readMarkdownPreview(scope('feature'), {
      diff,
      branchBaseRef: 'main',
      branchMergeBaseOid: snapshot,
    });
    expect(pinned.beforeContent).toBe('# Base\n');

    // 不带快照（旧端 / 无快照）：现场重算 —— 基线已经漂到 # Upstream moved on。
    const drifted = await readMarkdownPreview(scope('feature'), { diff, branchBaseRef: 'main' });
    expect(drifted.beforeContent).toBe('# Upstream moved on\n');
  });

  it('keeps the snapshot baseline even after the base ref disappears (regression)', async () => {
    // base ref 被删除 / 重置后现场重算会失败（before 变 null，删除标记全丢）；
    // 带快照时基线不受当前 ref 影响 —— 这正是“快照绑定”要保证的事。
    await writeRepoFile('docs/readme.md', '# Base\n');
    await commitAll('add markdown');
    await runGit(['checkout', '-b', 'feature'], { cwd: repoPath });
    await writeRepoFile('docs/readme.md', '# Feature\n');
    await commitAll('modify markdown on feature');

    const branchDiff = await readBranchDiff(scope('feature'), 'main');
    const diff = branchDiff.diffs.find((item) => item.path === 'docs/readme.md');
    if (!diff) throw new Error('missing branch markdown diff');
    const snapshot = branchDiff.mergeBaseOid;
    if (!snapshot) throw new Error('missing merge base snapshot');

    await runGit(['branch', '-D', 'main'], { cwd: repoPath });

    const pinned = await readMarkdownPreview(scope('feature'), {
      diff,
      branchBaseRef: 'main',
      branchMergeBaseOid: snapshot,
    });
    expect(pinned.beforeContent).toBe('# Base\n');

    const withoutSnapshot = await readMarkdownPreview(scope('feature'), { diff, branchBaseRef: 'main' });
    expect(withoutSnapshot.beforeContent).toBeNull();
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

  it('resolves before content through the old path for a staged rename', async () => {
    await writeRepoFile('docs/old-name.md', '# Renamed doc\n');
    await commitAll('add old name');
    await runGit(['mv', 'docs/old-name.md', 'docs/new-name.md'], { cwd: repoPath });

    const diff = await currentDiff('staged', 'docs/new-name.md');
    const preview = await readMarkdownPreview(scope(), { diff });

    expect(diff.status).toBe('renamed');
    expect(preview.reason).toBeNull();
    expect(preview.content).toBe('# Renamed doc\n');
    expect(preview.beforeContent).toBe('# Renamed doc\n');
  });

  it('returns no before content for newly added markdown', async () => {
    await writeRepoFile('docs/new.md', '# Brand new\n');
    await runGit(['add', 'docs/new.md'], { cwd: repoPath });

    const diff = await currentDiff('staged', 'docs/new.md');
    const preview = await readMarkdownPreview(scope(), { diff });

    expect(diff.status).toBe('added');
    expect(preview.reason).toBeNull();
    expect(preview.content).toBe('# Brand new\n');
    expect(preview.beforeContent).toBeNull();
  });

  it('drops an oversized before side without losing the preview body', async () => {
    const bigBefore = 'A'.repeat(MARKDOWN_PREVIEW_BEFORE_MAX_BYTES + 1);
    const bigAfter = 'B'.repeat(MARKDOWN_PREVIEW_BEFORE_MAX_BYTES + 1);
    await writeRepoFile('docs/big.md', bigBefore);
    await commitAll('add big markdown');
    await writeRepoFile('docs/big.md', bigAfter);

    const diff = await currentDiff('unstaged', 'docs/big.md');
    const preview = await readMarkdownPreview(scope(), { diff });

    expect(preview.reason).toBeNull();
    expect(preview.content).toBe(bigAfter);
    expect(preview.beforeContent).toBeNull();
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
