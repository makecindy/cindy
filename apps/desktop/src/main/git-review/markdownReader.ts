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

/**
 * before（diff 基线）侧内容的上限。
 * before 只服务富文本预览的块级对齐与删除块展示，不决定预览本身可用性；
 * 上限刻意低于 after：远程（device-link）响应预算 1.8MiB，双份全文会把
 * 整页预览推过 OVERSIZE 边界，得不偿失。超限时只丢删除标记。
 */
export const MARKDOWN_PREVIEW_BEFORE_MAX_BYTES = Math.floor(1.5 * 1024 * 1024);

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
  const headOid = await readCommitOid(repoRoot, 'HEAD', deps);
  // Validate the same comparison context as branch diff. The preview uses HEAD
  // content only, but a missing merge-base means the branch source itself is not
  // a valid committed diff view.
  const mergeBaseOid = await resolveBranchMergeBaseOid(repoRoot, baseRef, deps);
  if (!mergeBaseOid) throw new Error('missing merge base for branch diff');
  return headOid;
}

/**
 * branch diff 的比较基线是 merge-base（branchReader: `git diff mergeBaseOid headOid`），
 * 不是 base ref 的 tip。拿 tip 当 before 会把「分支切出后上游对同一文件的改动」
 * 误当作本分支的改动，在预览里伪造出插入 / 删除线。
 */
async function resolveBranchMergeBaseOid(
  repoRoot: string,
  baseRef: string,
  deps: MarkdownPreviewReaderDeps,
): Promise<string | null> {
  const baseOid = await resolveBranchBaseCommitOid(repoRoot, baseRef, deps.runGit);
  const headOid = await readCommitOid(repoRoot, 'HEAD', deps);
  const { stdout } = await deps.runGit(['merge-base', baseOid, headOid], { cwd: repoRoot });
  const mergeBaseOid = stdout.trim();
  return /^[0-9a-f]{40,64}$/i.test(mergeBaseOid) ? mergeBaseOid : null;
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

/**
 * 读取 git blob 文本的统一入口，带大小护栏。after（预览主体）与 before
 * （删除基线）共用；调用方按各自上限决定 too-large / failed 的降级方式。
 */
async function readGuardedBlobText(
  repoRoot: string,
  oid: string,
  maxBytes: number,
  deps: MarkdownPreviewReaderDeps,
): Promise<
  | { status: 'ok'; content: string; size: number }
  | { status: 'too-large'; size: number }
  | { status: 'failed'; error: string }
> {
  try {
    const size = await readBlobSize(repoRoot, oid, deps);
    if (size > maxBytes) return { status: 'too-large', size };
    const { stdout } = await deps.runGitBuffer(['cat-file', 'blob', '--end-of-options', oid], {
      cwd: repoRoot,
      maxStdoutBytes: maxBytes + 1,
    });
    if (stdout.length > maxBytes) return { status: 'too-large', size: stdout.length };
    return { status: 'ok', content: stdout.toString('utf8'), size: stdout.length };
  } catch (err) {
    return { status: 'failed', error: errorMessage(err) };
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
  if (!oid) return unavailable(diff.id, 'missing', { baseDir, error: 'markdown blob is unavailable' });
  if (!isSafeGitDiffIndexOid(oid)) return unavailable(diff.id, 'source-missing', { baseDir, error: 'markdown blob oid is invalid' });
  const result = await readGuardedBlobText(repoRoot, oid, MARKDOWN_PREVIEW_MAX_BYTES, deps);
  if (result.status === 'too-large') return unavailable(diff.id, 'too-large', { baseDir, size: result.size });
  if (result.status === 'failed') return unavailable(diff.id, 'read-error', { baseDir, error: result.error });
  return loaded(diff.id, result.content, result.size, baseDir);
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

async function readParentCommitOid(
  repoRoot: string,
  commitOid: string,
  deps: MarkdownPreviewReaderDeps,
): Promise<string | null> {
  try {
    const { stdout } = await deps.runGit(['rev-parse', '--verify', `${commitOid}^`], { cwd: repoRoot });
    const oid = stdout.trim();
    return /^[0-9a-f]{40,64}$/i.test(oid) ? oid : null;
  } catch {
    // 根提交没有 parent：没有可比基线，返回 null 让预览退化为无删除标记。
    return null;
  }
}

/**
 * 解析 before 侧对应的 blob oid。before 一律来自 git 对象（index / tree），
 * 不读 worktree（unstaged 的基线就是 index）。rename 使用 oldPath。
 */
async function resolveBeforeBlobOid(
  repoRoot: string,
  request: ReviewMarkdownPreviewRequest,
  gitPath: string,
  deps: MarkdownPreviewReaderDeps,
): Promise<string | null> {
  const { diff } = request;
  if (diff.source === 'unstaged') {
    return readIndexBlobOid(repoRoot, gitPath, deps);
  }
  if (diff.source === 'staged') {
    return readTreeBlobOid(repoRoot, 'HEAD', gitPath, deps);
  }
  if (diff.source === 'commit') {
    if (!request.commitOid || !isSafeGitObjectOid(request.commitOid)) return null;
    const parentOid = await readParentCommitOid(repoRoot, request.commitOid, deps);
    return parentOid ? readTreeBlobOid(repoRoot, parentOid, gitPath, deps) : null;
  }
  if (diff.source === 'branch') {
    if (!request.branchBaseRef) return null;
    // 优先用生成 diff 时的 merge-base **快照**：现场重算会在“审查期间 agent 又提交了 /
    // 分支被 reset / base ref 更新”时漂到另一个基线上，与界面里显示的 diff 对不上。
    // 快照非法或缺失 → 回退到现场重算（旧端行为）。
    if (request.branchMergeBaseOid && isSafeGitObjectOid(request.branchMergeBaseOid)) {
      return readTreeBlobOid(repoRoot, request.branchMergeBaseOid, gitPath, deps);
    }
    // 基线必须是 merge-base 的 tree，与 branch diff 同一套比较基准（见 helper 注释）。
    const mergeBaseOid = await resolveBranchMergeBaseOid(repoRoot, request.branchBaseRef, deps);
    return mergeBaseOid ? readTreeBlobOid(repoRoot, mergeBaseOid, gitPath, deps) : null;
  }
  return null;
}

/**
 * 读取 before（基线）侧 Markdown，供渲染侧做块级改动对齐。任何失败都降级为
 * null——只丢删除标记，绝不影响 after 预览的可用性。
 */
async function readBeforeMarkdownContent(
  repoRoot: string,
  request: ReviewMarkdownPreviewRequest,
  deps: MarkdownPreviewReaderDeps,
): Promise<string | null> {
  const { diff } = request;
  if (diff.status === 'added' || diff.status === 'untracked') return null;
  const gitPath = diff.oldPath ?? diff.path;
  if (!isSafeGitPath(gitPath)) return null;
  try {
    const oid = await resolveBeforeBlobOid(repoRoot, request, gitPath, deps);
    if (!oid) return null;
    const result = await readGuardedBlobText(
      repoRoot,
      oid,
      MARKDOWN_PREVIEW_BEFORE_MAX_BYTES,
      deps,
    );
    return result.status === 'ok' ? result.content : null;
  } catch {
    return null;
  }
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
    const after =
      'content' in spec
        ? spec
        : spec.kind === 'worktree'
          ? await readWorktreeMarkdown(scope.repoRoot, diff, spec.path, deps)
          : spec.kind === 'index'
            ? await readBlobMarkdown(scope.repoRoot, diff, spec.oid, spec.path, deps)
            : await readTreeMarkdown(scope.repoRoot, diff, spec.treeish, spec.path, deps);
    if (after.content === null) return after;
    return {
      ...after,
      beforeContent: await readBeforeMarkdownContent(scope.repoRoot, request, deps),
    };
  } catch (err) {
    return unavailable(diff.id, 'read-error', { baseDir, error: errorMessage(err) });
  }
}
