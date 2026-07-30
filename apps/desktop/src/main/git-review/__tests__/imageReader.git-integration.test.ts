import { promises as fs } from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Windows 上 git 子进程明显更慢(每次 spawn 数百毫秒),多步 git 编排用例会超默认 5s。
vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 });

import { TestDirectoryTemplate } from '../../../test/vitest/testDirectoryTemplate';
import { readCommitDiff } from '../commitReader';
import { readBranchDiff } from '../branchReader';
import { readDiffs } from '../diffReader';
import { runGit } from '../gitRunner';
import {
  IMAGE_PREVIEW_MAX_BYTES,
  ImagePreviewDataUrlCache,
  isPreviewableRasterPath,
  readImagePreview,
  type ImagePreviewReaderDeps,
} from '../imageReader';
import { readStatus } from '../statusReader';
import type { FileDiff, ReviewScope } from '../types';

let repoPath: string;

const oldPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0xff]);
const newPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x03, 0xfe]);
const worktreePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x09, 0xf0]);

const repoTemplate = new TestDirectoryTemplate('xdt-git-review-image-', async (dir) => {
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

async function currentDiff(source: 'staged' | 'unstaged', filePath = 'asset.png'): Promise<FileDiff> {
  const status = await readStatus(scope());
  const diffs = await readDiffs(scope(), status);
  const diff = diffs[source].find((item) => item.path === filePath);
  if (!diff) throw new Error(`missing ${source} diff for ${filePath}`);
  return diff;
}

function expectDataUrl(side: { dataUrl?: string }, mime: string, bytes: Buffer): void {
  expect(side.dataUrl).toBe(`data:${mime};base64,${bytes.toString('base64')}`);
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

describe('git-review imageReader', () => {
  it('recognizes raster extensions and intentionally excludes svg', () => {
    expect(isPreviewableRasterPath('image.PNG')).toBe(true);
    expect(isPreviewableRasterPath('photo.webp')).toBe(true);
    expect(isPreviewableRasterPath('icon.svg')).toBe(false);
  });

  it('rejects repo-escaping paths from the IPC payload', async () => {
    const outsidePath = path.join(path.dirname(repoPath), `${path.basename(repoPath)}-escape.png`);
    await fs.writeFile(outsidePath, newPng);
    const diff: FileDiff = {
      id: 'unstaged:../escape.png',
      source: 'unstaged',
      path: `../${path.basename(outsidePath)}`,
      oldPath: null,
      status: 'untracked',
      kind: 'binary',
      size: newPng.length,
      additions: 0,
      deletions: 0,
      isBinary: true,
      isSubmodule: false,
      isTooLarge: false,
      mode: { old: null, new: null },
      index: { oldOid: null, newOid: null },
      rawHeader: '',
      rawPatch: '',
      hunks: [],
      error: null,
    };

    try {
      const preview = await readImagePreview(scope(), { diff });
      expect(preview.old).toBeNull();
      expect(preview.new).toBeNull();
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
  });

  it('reads unstaged modified images from index and worktree without UTF-8 conversion', async () => {
    await fs.writeFile(path.join(repoPath, 'asset.png'), oldPng);
    await commitAll('add image');
    await fs.writeFile(path.join(repoPath, 'asset.png'), newPng);

    const diff = await currentDiff('unstaged');
    const preview = await readImagePreview(scope(), { diff });

    expect(diff.kind).toBe('binary');
    expect(preview.old?.present).toBe(true);
    expect(preview.new?.present).toBe(true);
    expectDataUrl(preview.old ?? {}, 'image/png', oldPng);
    expectDataUrl(preview.new ?? {}, 'image/png', newPng);
  });

  it('reads untracked images as new-only previews', async () => {
    await fs.writeFile(path.join(repoPath, 'new image.png'), newPng);

    const diff = await currentDiff('unstaged', 'new image.png');
    const preview = await readImagePreview(scope(), { diff });

    expect(diff.status).toBe('untracked');
    expect(preview.old).toBeNull();
    expect(preview.new?.present).toBe(true);
    expectDataUrl(preview.new ?? {}, 'image/png', newPng);
  });

  it('rejects worktree image previews for symlinks that point outside the repo', async () => {
    const outsidePath = path.join(path.dirname(repoPath), `${path.basename(repoPath)}-outside.png`);
    await fs.writeFile(outsidePath, newPng);
    const linked = await tryCreateFileSymlink(outsidePath, path.join(repoPath, 'link.png'));
    if (!linked) {
      await fs.rm(outsidePath, { force: true });
      return;
    }

    try {
      const preview = await readImagePreview(scope(), {
        diff: {
          id: 'unstaged:link.png',
          source: 'unstaged',
          path: 'link.png',
          oldPath: null,
          status: 'untracked',
          kind: 'binary',
          size: newPng.length,
          additions: 0,
          deletions: 0,
          isBinary: true,
          isSubmodule: false,
          isTooLarge: false,
          mode: { old: null, new: null },
          index: { oldOid: null, newOid: null },
          rawHeader: '',
          rawPatch: '',
          hunks: [],
          error: null,
        },
      });

      expect(preview.old).toBeNull();
      expect(preview.new).toMatchObject({
        present: false,
        error: 'image symlink preview is unavailable',
      });
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
  });

  it('rejects worktree image previews through symlinked directories outside the repo', async () => {
    const outsideDir = path.join(path.dirname(repoPath), `${path.basename(repoPath)}-outside-dir`);
    await fs.mkdir(outsideDir);
    await fs.writeFile(path.join(outsideDir, 'asset.png'), newPng);
    const linked = await tryCreateFileSymlink(outsideDir, path.join(repoPath, 'linkdir'));
    if (!linked) {
      await fs.rm(outsideDir, { recursive: true, force: true });
      return;
    }

    try {
      const preview = await readImagePreview(scope(), {
        diff: {
          id: 'unstaged:linkdir/asset.png',
          source: 'unstaged',
          path: 'linkdir/asset.png',
          oldPath: null,
          status: 'untracked',
          kind: 'binary',
          size: newPng.length,
          additions: 0,
          deletions: 0,
          isBinary: true,
          isSubmodule: false,
          isTooLarge: false,
          mode: { old: null, new: null },
          index: { oldOid: null, newOid: null },
          rawHeader: '',
          rawPatch: '',
          hunks: [],
          error: null,
        },
      });

      expect(preview.old).toBeNull();
      expect(preview.new).toMatchObject({
        present: false,
        error: 'File resolves outside the repository',
      });
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('reads staged modified images from HEAD and index', async () => {
    await fs.writeFile(path.join(repoPath, 'asset.png'), oldPng);
    await commitAll('add image');
    await fs.writeFile(path.join(repoPath, 'asset.png'), newPng);
    await runGit(['add', 'asset.png'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'asset.png'), worktreePng);

    const diff = await currentDiff('staged');
    const preview = await readImagePreview(scope(), { diff });

    expect(preview.old?.oid).toEqual(expect.any(String));
    expect(preview.new?.oid).toEqual(expect.any(String));
    expectDataUrl(preview.old ?? {}, 'image/png', oldPng);
    expectDataUrl(preview.new ?? {}, 'image/png', newPng);
  });

  it('reads commit image diffs against the first parent', async () => {
    await fs.writeFile(path.join(repoPath, 'asset.png'), oldPng);
    await commitAll('add image');
    await fs.writeFile(path.join(repoPath, 'asset.png'), newPng);
    const oid = await commitAll('modify image');
    const commitDiff = await readCommitDiff(scope(), oid);
    const diff = commitDiff.diffs.find((item) => item.path === 'asset.png');
    if (!diff) throw new Error('missing commit image diff');

    const preview = await readImagePreview(scope(), { diff, commitOid: oid });

    expect(diff.kind).toBe('binary');
    expectDataUrl(preview.old ?? {}, 'image/png', oldPng);
    expectDataUrl(preview.new ?? {}, 'image/png', newPng);
  });

  it('reads branch image diffs from merge-base and HEAD, not the worktree', async () => {
    await fs.writeFile(path.join(repoPath, 'asset.png'), oldPng);
    await commitAll('add image');
    await runGit(['checkout', '-b', 'feature'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'asset.png'), newPng);
    await commitAll('modify image on feature');
    await fs.writeFile(path.join(repoPath, 'asset.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]));
    const branchDiff = await readBranchDiff(scope('feature'), 'main');
    const diff = branchDiff.diffs.find((item) => item.path === 'asset.png');
    if (!diff) throw new Error('missing branch image diff');

    const preview = await readImagePreview(scope('feature'), { diff, branchBaseRef: 'main' });

    expect(diff.source).toBe('branch');
    expect(diff.kind).toBe('binary');
    expectDataUrl(preview.old ?? {}, 'image/png', oldPng);
    expectDataUrl(preview.new ?? {}, 'image/png', newPng);
  });

  it('pins branch image preview to the diff blobs after HEAD advances', async () => {
    await fs.writeFile(path.join(repoPath, 'asset.png'), oldPng);
    await commitAll('add image');
    await runGit(['checkout', '-b', 'feature'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'asset.png'), newPng);
    await commitAll('modify image on feature');
    const branchDiff = await readBranchDiff(scope('feature'), 'main');
    const diff = branchDiff.diffs.find((item) => item.path === 'asset.png');
    if (!diff) throw new Error('missing branch image diff');
    expect(diff.index.oldOid).toMatch(/^[0-9a-f]{4,64}$/i);
    expect(diff.index.newOid).toMatch(/^[0-9a-f]{4,64}$/i);
    await fs.writeFile(path.join(repoPath, 'asset.png'), worktreePng);
    await commitAll('advance feature image again');

    const preview = await readImagePreview(scope('feature'), {
      diff,
      branchBaseRef: 'main',
    });

    expectDataUrl(preview.old ?? {}, 'image/png', oldPng);
    expectDataUrl(preview.new ?? {}, 'image/png', newPng);
  });

  it('resolves branch image preview base through the remote ref before a same-name tag', async () => {
    await fs.writeFile(path.join(repoPath, 'asset.png'), oldPng);
    const baseOid = await commitAll('add image');
    await runGit(['update-ref', 'refs/remotes/origin/main', baseOid], { cwd: repoPath });
    await runGit(['checkout', '-b', 'feature'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'asset.png'), newPng);
    await commitAll('modify image on feature');
    const { stdout: unrelatedOid } = await runGit(['commit-tree', 'HEAD^{tree}', '-m', 'unrelated tag target'], { cwd: repoPath });
    await runGit(['tag', 'origin/main', unrelatedOid.trim()], { cwd: repoPath });
    const branchDiff = await readBranchDiff(scope('feature'), 'origin/main');
    const diff = branchDiff.diffs.find((item) => item.path === 'asset.png');
    if (!diff) throw new Error('missing branch image diff');

    const preview = await readImagePreview(scope('feature'), { diff, branchBaseRef: 'origin/main' });

    expect(branchDiff.baseOid).toBe(baseOid);
    expectDataUrl(preview.old ?? {}, 'image/png', oldPng);
    expectDataUrl(preview.new ?? {}, 'image/png', newPng);
  });

  it('guards large worktree images without loading data URLs', async () => {
    const large = Buffer.alloc(IMAGE_PREVIEW_MAX_BYTES + 1, 1);
    large[0] = 0;
    await fs.writeFile(path.join(repoPath, 'large.png'), large);

    const diff = await currentDiff('unstaged', 'large.png');
    const preview = await readImagePreview(scope(), { diff });

    expect(preview.new).toMatchObject({
      present: true,
      size: IMAGE_PREVIEW_MAX_BYTES + 1,
      tooLarge: true,
    });
    expect(preview.new?.dataUrl).toBeUndefined();
  });

  it('caches oid-backed blobs by oid without re-reading binary stdout', async () => {
    const cache = new ImagePreviewDataUrlCache();
    const oid = '0123456789abcdef0123456789abcdef01234567';
    const runGitBufferMock = vi.fn(async () => ({ stdout: oldPng, stderr: '', exitCode: 0 }));
    const deps: ImagePreviewReaderDeps = {
      cache,
      runGit: vi.fn(async (args: readonly string[]) => {
        if (args[0] === 'cat-file' && args[1] === '-s') return { stdout: String(oldPng.length), stderr: '', exitCode: 0 };
        throw new Error(`unexpected git args: ${args.join(' ')}`);
      }),
      runGitBuffer: runGitBufferMock,
      lstat: vi.fn(),
      realpath: vi.fn(),
      stat: vi.fn(),
      readFile: vi.fn(),
    };
    const diff: FileDiff = {
      id: 'staged:asset.png',
      source: 'staged',
      path: 'asset.png',
      oldPath: null,
      status: 'added',
      kind: 'binary',
      size: oldPng.length,
      additions: 0,
      deletions: 0,
      isBinary: true,
      isSubmodule: false,
      isTooLarge: false,
      mode: { old: null, new: null },
      index: { oldOid: null, newOid: oid },
      rawHeader: '',
      rawPatch: '',
      hunks: [],
      error: null,
    };

    await readImagePreview(scope(), { diff }, deps);
    await readImagePreview(scope(), { diff }, deps);

    expect(runGitBufferMock).toHaveBeenCalledTimes(1);
    expect(deps.runGitBuffer).toHaveBeenCalledWith(['cat-file', 'blob', '--end-of-options', oid], expect.any(Object));
  });

  it('drops non-hex renderer-provided oids and falls back to the index lookup', async () => {
    const fallbackOid = 'fedcba9876543210fedcba9876543210fedcba98';
    const runGitBufferMock = vi.fn(async () => ({ stdout: newPng, stderr: '', exitCode: 0 }));
    const deps: ImagePreviewReaderDeps = {
      cache: new ImagePreviewDataUrlCache(),
      runGit: vi.fn(async (args: readonly string[]) => {
        if (args[0] === 'ls-files') {
          return { stdout: `100644 ${fallbackOid} 0\tasset.png\n`, stderr: '', exitCode: 0 };
        }
        if (args[0] === 'cat-file' && args[1] === '-s') return { stdout: String(newPng.length), stderr: '', exitCode: 0 };
        throw new Error(`unexpected git args: ${args.join(' ')}`);
      }),
      runGitBuffer: runGitBufferMock,
      lstat: vi.fn(),
      realpath: vi.fn(),
      stat: vi.fn(),
      readFile: vi.fn(),
    };
    const diff: FileDiff = {
      id: 'staged:asset.png',
      source: 'staged',
      path: 'asset.png',
      oldPath: null,
      status: 'added',
      kind: 'binary',
      size: newPng.length,
      additions: 0,
      deletions: 0,
      isBinary: true,
      isSubmodule: false,
      isTooLarge: false,
      mode: { old: null, new: null },
      index: { oldOid: null, newOid: 'HEAD:asset.png' },
      rawHeader: '',
      rawPatch: '',
      hunks: [],
      error: null,
    };

    const preview = await readImagePreview(scope(), { diff }, deps);

    expect(preview.new?.oid).toBe(fallbackOid);
    expect(runGitBufferMock).toHaveBeenCalledWith(['cat-file', 'blob', '--end-of-options', fallbackOid], expect.any(Object));
  });
});
