/**
 * Markdown rich-preview content reader for git-review.
 *
 * Renderer never reads git or the filesystem directly. This module resolves the
 * "after" side for a Markdown diff and returns guarded UTF-8 content for the
 * review panel rich preview. Unavailable content is returned as structured data
 * so the renderer can fall back to the normal diff body.
 */

import { promises as fs, type Stats } from 'node:fs';
import path from 'node:path';

import { isReviewMarkdownPath } from '../../shared/reviewMarkdownExts.js';
import { isSafeBranchBaseRef, resolveBranchBaseCommitOid } from './branchReader.js';
import { RepoContainedPathError, repoRelativeFsPath, resolveRepoContainedRealPath } from './fsPathGuard.js';
import { isSafeGitDiffIndexOid, isSafeGitObjectOid, isSafeGitPath } from './gitPath.js';
import { runGit, runGitBuffer } from './gitRunner.js';
import type {
  FileDiff,
  ReviewMarkdownPreviewData,
  ReviewMarkdownPreviewReason,
  ReviewMarkdownPreviewRequest,
  ReviewScope,
} from './types.js';

export const MARKDOWN_PREVIEW_MAX_BYTES = Math.floor(4.4 * 1024 * 1024);

export interface MarkdownPreviewReaderDeps {
  runGit: typeof runGit;
  runGitBuffer: typeof runGitBuffer;
  lstat: (filePath: string) => Promise<Stats>;
  realpath: (filePath: string) => Promise<string>;
  stat: (filePath: string) => Promise<Stats>;
  readFile: (filePath: string) => Promise<Buffer>;
}

type MarkdownContentSpec =
  | { kind: 'worktree'; path: string }
  | { kind: 'index'; path: string; oid: string | null }
  | { kind: 'tree'; treeish: string; path: string };

function defaultDeps(): MarkdownPreviewReaderDeps {
  return {
    runGit,
    runGitBuffer,
    lstat: fs.lstat,
    realpath: fs.realpath,
    stat: fs.stat,
    readFile: fs.readFile,
  };
}

function toFsPath(repoRoot: string, gitPath: string): string {
  return repoRelativeFsPath(repoRoot, gitPath);
}

function baseDirForGitPath(repoRoot: string, gitPath: string): string {
  const pathApi = path.posix.isAbsolute(repoRoot) ? path.posix : path;
  return pathApi.dirname(toFsPath(repoRoot, gitPath));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function unavailable(
  diffId: string,
  reason: ReviewMarkdownPreviewReason,
  extra: Partial<Pick<ReviewMarkdownPreviewData, 'size' | 'baseDir' | 'error'>> = {},
): ReviewMarkdownPreviewData {
  return {
    diffId,
    content: null,
    size: extra.size ?? null,
    baseDir: extra.baseDir ?? null,
    maxBytes: MARKDOWN_PREVIEW_MAX_BYTES,
    reason,
    error: extra.error ?? null,
  };
}

function loaded(diffId: string, content: string, size: number, baseDir: string): ReviewMarkdownPreviewData {
  return {
    diffId,
    content,
    size,
    baseDir,
    maxBytes: MARKDOWN_PREVIEW_MAX_BYTES,
    reason: null,
    error: null,
  };
}

async function readCommitOid(repoRoot: string, ref: string, deps: MarkdownPreviewReaderDeps): Promise<string> {
  if (ref !== 'HEAD' && !isSafeGitObjectOid(ref) && !isSafeBranchBaseRef(ref)) throw new Error('invalid commit ref');
  const { stdout } = await deps.runGit(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: repoRoot });
  const oid = stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(oid)) throw new Error(`invalid commit oid for ${ref}`);
  return oid;
}

async function readBranchHeadOid(repoRoot: string, baseRef: string, deps: MarkdownPreviewReaderDeps): Promise<string> {
  const baseOid = await resolveBranchBaseCommitOid(repoRoot, baseRef, deps.runGit);
  const headOid = await readCommitOid(repoRoot, 'HEAD', deps);
  // Validate the same comparison context as branch diff. The preview uses HEAD
  // content only, but a missing merge-base means the branch source itself is not
  // a valid committed diff view.
  await deps.runGit(['merge-base', baseOid, headOid], { cwd: repoRoot });
  return headOid;
}

async function readTreeBlobOid(
  repoRoot: string,
  treeish: string,
  gitPath: string,
  deps: MarkdownPreviewReaderDeps,
): Promise<string | null> {
  try {
    const { stdout } = await deps.runGit(['rev-parse', '--verify', `${treeish}:${gitPath}`], { cwd: repoRoot });
    const oid = stdout.trim().split(/\r?\n/).at(-1) ?? '';
    return isSafeGitObjectOid(oid) ? oid : null;
  } catch {
    return null;
  }
}

async function readIndexBlobOid(
  repoRoot: string,
  gitPath: string,
  deps: MarkdownPreviewReaderDeps,
): Promise<string | null> {
  try {
    const { stdout } = await deps.runGit(['ls-files', '-s', '--', `:(top,literal)${gitPath}`], { cwd: repoRoot });
    const first = stdout.split(/\r?\n/).find(Boolean);
    const oid = first?.trim().split(/\s+/)[1] ?? null;
    return isSafeGitObjectOid(oid) ? oid : null;
  } catch {
    return null;
  }
}

async function readBlobSize(repoRoot: string, oid: string, deps: MarkdownPreviewReaderDeps): Promise<number> {
  if (!isSafeGitDiffIndexOid(oid)) throw new Error(`invalid blob oid: ${oid}`);
  const { stdout } = await deps.runGit(['cat-file', '-s', '--end-of-options', oid], { cwd: repoRoot });
  const size = Number(stdout.trim());
  if (!Number.isFinite(size) || size < 0) throw new Error(`invalid blob size for ${oid}`);
  return size;
}

async function readWorktreeMarkdown(
  repoRoot: string,
  diff: FileDiff,
  gitPath: string,
  deps: MarkdownPreviewReaderDeps,
): Promise<ReviewMarkdownPreviewData> {
  const baseDir = baseDirForGitPath(repoRoot, gitPath);
  try {
    const fsPath = toFsPath(repoRoot, gitPath);
    const linkStat = await deps.lstat(fsPath);
    if (linkStat.isSymbolicLink()) {
      return unavailable(diff.id, 'unsupported-kind', { baseDir, error: 'markdown symlink preview is unavailable' });
    }
    const { targetReal } = await resolveRepoContainedRealPath(repoRoot, gitPath, { realpath: deps.realpath });
    const stat = await deps.stat(targetReal);
    if (!stat.isFile()) return unavailable(diff.id, 'missing', { baseDir, error: 'markdown file is unavailable' });
    if (stat.size > MARKDOWN_PREVIEW_MAX_BYTES) return unavailable(diff.id, 'too-large', { baseDir, size: stat.size });
    const bytes = await deps.readFile(targetReal);
    if (bytes.length > MARKDOWN_PREVIEW_MAX_BYTES) return unavailable(diff.id, 'too-large', { baseDir, size: bytes.length });
    return loaded(diff.id, bytes.toString('utf8'), bytes.length, baseDir);
  } catch (err) {
    if (err instanceof RepoContainedPathError && err.kind === 'outside') {
      return unavailable(diff.id, 'unsafe-path', { baseDir, error: err.message });
    }
    return unavailable(diff.id, 'read-error', { baseDir, error: errorMessage(err) });
  }
}

async function readBlobMarkdown(
  repoRoot: string,
  diff: FileDiff,
  oid: string | null,
  gitPath: string,
  deps: MarkdownPreviewReaderDeps,
): Promise<ReviewMarkdownPreviewData> {
  const baseDir = baseDirForGitPath(repoRoot, gitPath);
  try {
    if (!oid) return unavailable(diff.id, 'missing', { baseDir, error: 'markdown blob is unavailable' });
    if (!isSafeGitDiffIndexOid(oid)) return unavailable(diff.id, 'source-missing', { baseDir, error: 'markdown blob oid is invalid' });
    const size = await readBlobSize(repoRoot, oid, deps);
    if (size > MARKDOWN_PREVIEW_MAX_BYTES) return unavailable(diff.id, 'too-large', { baseDir, size });
    const { stdout } = await deps.runGitBuffer(['cat-file', 'blob', '--end-of-options', oid], {
      cwd: repoRoot,
      maxStdoutBytes: MARKDOWN_PREVIEW_MAX_BYTES + 1,
    });
    if (stdout.length > MARKDOWN_PREVIEW_MAX_BYTES) return unavailable(diff.id, 'too-large', { baseDir, size: stdout.length });
    return loaded(diff.id, stdout.toString('utf8'), stdout.length, baseDir);
  } catch (err) {
    return unavailable(diff.id, 'read-error', { baseDir, error: errorMessage(err) });
  }
}

async function readTreeMarkdown(
  repoRoot: string,
  diff: FileDiff,
  treeish: string,
  gitPath: string,
  deps: MarkdownPreviewReaderDeps,
): Promise<ReviewMarkdownPreviewData> {
  const oid = await readTreeBlobOid(repoRoot, treeish, gitPath, deps);
  return readBlobMarkdown(repoRoot, diff, oid, gitPath, deps);
}

async function resolveMarkdownContentSpec(
  repoRoot: string,
  request: ReviewMarkdownPreviewRequest,
  deps: MarkdownPreviewReaderDeps,
): Promise<MarkdownContentSpec | ReviewMarkdownPreviewData> {
  const { diff } = request;
  if (diff.source === 'unstaged') {
    return { kind: 'worktree', path: diff.path };
  }
  if (diff.source === 'staged') {
    const oid = isSafeGitDiffIndexOid(diff.index.newOid)
      ? diff.index.newOid
      : await readIndexBlobOid(repoRoot, diff.path, deps);
    return { kind: 'index', path: diff.path, oid };
  }
  if (diff.source === 'commit') {
    if (!request.commitOid) return unavailable(diff.id, 'source-missing', { error: 'commitOid is required' });
    if (!isSafeGitObjectOid(request.commitOid)) return unavailable(diff.id, 'source-missing', { error: 'commitOid is invalid' });
    return { kind: 'tree', treeish: await readCommitOid(repoRoot, request.commitOid, deps), path: diff.path };
  }
  if (diff.source === 'branch') {
    if (!request.branchBaseRef) return unavailable(diff.id, 'source-missing', { error: 'branchBaseRef is required' });
    if (isSafeGitDiffIndexOid(diff.index.newOid)) {
      return { kind: 'index', path: diff.path, oid: diff.index.newOid };
    }
    return { kind: 'tree', treeish: await readBranchHeadOid(repoRoot, request.branchBaseRef, deps), path: diff.path };
  }
  return unavailable(diff.id, 'source-missing', { error: 'unsupported review source' });
}

export function isPreviewableMarkdownDiff(
  diff: Pick<FileDiff, 'kind' | 'path' | 'status' | 'isBinary' | 'isTooLarge'>,
): boolean {
  return diff.kind === 'text' &&
    !diff.isBinary &&
    !diff.isTooLarge &&
    diff.status !== 'deleted' &&
    isReviewMarkdownPath(diff.path);
}

export async function readMarkdownPreview(
  scope: ReviewScope,
  request: ReviewMarkdownPreviewRequest,
  depsInput: Partial<MarkdownPreviewReaderDeps> = {},
): Promise<ReviewMarkdownPreviewData> {
  const deps = { ...defaultDeps(), ...depsInput };
  const { diff } = request;
  const baseDir = scope.repoRoot && isSafeGitPath(diff.path) ? baseDirForGitPath(scope.repoRoot, diff.path) : null;
  if (!scope.repoRoot) return unavailable(diff.id, 'source-missing');
  if (!isSafeGitPath(diff.path) || (diff.oldPath != null && !isSafeGitPath(diff.oldPath))) {
    return unavailable(diff.id, 'unsafe-path');
  }
  if (diff.status === 'deleted') return unavailable(diff.id, 'deleted', { baseDir });
  if (!isReviewMarkdownPath(diff.path)) return unavailable(diff.id, 'not-markdown', { baseDir });
  if (diff.kind === 'large-text' || diff.kind === 'too-large' || diff.isTooLarge) {
    return unavailable(diff.id, 'too-large', { baseDir, size: diff.size ?? null });
  }
  if (diff.kind !== 'text' || diff.isBinary) return unavailable(diff.id, 'unsupported-kind', { baseDir });

  try {
    const spec = await resolveMarkdownContentSpec(scope.repoRoot, request, deps);
    if ('content' in spec) return spec;
    if (spec.kind === 'worktree') return readWorktreeMarkdown(scope.repoRoot, diff, spec.path, deps);
    if (spec.kind === 'index') return readBlobMarkdown(scope.repoRoot, diff, spec.oid, spec.path, deps);
    return readTreeMarkdown(scope.repoRoot, diff, spec.treeish, spec.path, deps);
  } catch (err) {
    return unavailable(diff.id, 'read-error', { baseDir, error: errorMessage(err) });
  }
}
