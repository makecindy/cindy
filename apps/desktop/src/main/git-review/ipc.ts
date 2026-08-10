/**
 * git-review IPC handlers.
 *
 * M1 exposes read-only status/diff data. Future write operations must enter
 * gitRepoWriteQueue before mutating index/HEAD/refs.
 */

import { promises as fs } from 'node:fs';

import { ipcMain, shell } from 'electron';

import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';
import { enqueueGitRepoWrite } from '../git-snapshot/gitRepoWriteQueue.js';
import { isSafeBranchBaseRef, readBranchDiff, readBranchFileDiff } from './branchReader.js';
import { commitStagedChanges, GitReviewCommitError } from './commitOps.js';
import { listBranchCommits, readCommitDiff, readCommitFileDiff } from './commitReader.js';
import { readCappedFileDiff, readDiffs } from './diffReader.js';
import { RepoContainedPathError, resolveRepoContainedRealPath } from './fsPathGuard.js';
import { isSafeGitObjectOid, isSafeGitPath, normalizeGitDiffIndexOid } from './gitPath.js';
import { readImagePreview } from './imageReader.js';
import { readMarkdownPreview } from './markdownReader.js';
import { GitReviewPushError, pushBranch } from './pushOps.js';
import { resolveReviewScope } from './scopeResolver.js';
import { readStatus } from './statusReader.js';
import { applyFileBatch, applyHunkSelection, GitReviewStageError } from './stageOps.js';
import type {
  FileDiff,
  GitReviewDeps,
  ReviewCommitDiffData,
  ReviewCommitListData,
  ReviewCommitResult,
  ReviewBranchDiffData,
  ReviewData,
  ReviewDiffReadOptions,
  ReviewDirtySummary,
  ReviewFileDiffData,
  ReviewFileDiffRequest,
  ReviewFileTarget,
  ReviewImagePreviewData,
  ReviewImagePreviewRequest,
  ReviewMarkdownPreviewData,
  ReviewMarkdownPreviewRequest,
  ReviewPushConfirmForce,
  ReviewPushResult,
  ReviewScope,
  ReviewStageAction,
  ReviewStageOperationResult,
  ReviewStatus,
} from './types.js';

export const GIT_REVIEW_INVOKE = {
  GET: 'git-review:get',
  SUMMARY: 'git-review:summary',
  COMMITS: 'git-review:commits',
  COMMIT_DIFF: 'git-review:commit-diff',
  BRANCH_DIFF: 'git-review:branch-diff',
  FILE_DIFF: 'git-review:file-diff',
  IMAGE_PREVIEW: 'git-review:image-preview',
  MARKDOWN_PREVIEW: 'git-review:markdown-preview',
  OPEN_FILE: 'git-review:open-file',
  STAGE_FILE: 'git-review:stage-file',
  UNSTAGE_FILE: 'git-review:unstage-file',
  DISCARD_FILE: 'git-review:discard-file',
  STAGE_HUNK: 'git-review:stage-hunk',
  UNSTAGE_HUNK: 'git-review:unstage-hunk',
  DISCARD_HUNK: 'git-review:discard-hunk',
  STAGE_ALL: 'git-review:stage-all',
  UNSTAGE_ALL: 'git-review:unstage-all',
  DISCARD_ALL: 'git-review:discard-all',
  COMMIT: 'git-review:commit',
  PUSH: 'git-review:push',
} as const;

export function buildDirtySummary(sessionId: string, scope: ReviewScope, status: ReviewStatus | null): ReviewDirtySummary {
  if (!status) {
    return {
      sessionId,
      disabledReason: scope.disabledReason,
      disabledMessage: scope.disabledMessage,
      totalFiles: 0,
      stagedFiles: 0,
      unstagedFiles: 0,
      untrackedFiles: 0,
      unmergedFiles: 0,
      dirty: false,
    };
  }
  return {
    sessionId,
    disabledReason: scope.disabledReason,
    disabledMessage: scope.disabledMessage,
    totalFiles: status.files.length,
    stagedFiles: status.stagedCount,
    unstagedFiles: status.unstagedCount,
    untrackedFiles: status.untrackedCount,
    unmergedFiles: status.unmergedCount,
    dirty: status.dirty,
  };
}

const defaultGitReviewDeps: GitReviewDeps = {
  resolveScope: resolveReviewScope,
  readStatus,
  readDiffs,
};

type GitReviewIpcOptions = Pick<GitReviewDeps, 'isSessionRunning'>;

function isGitReviewDeps(value: unknown): value is GitReviewDeps {
  return Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as GitReviewDeps).resolveScope === 'function' &&
    typeof (value as GitReviewDeps).readStatus === 'function' &&
    typeof (value as GitReviewDeps).readDiffs === 'function';
}

function isResolveScopeDeps(value: unknown): value is Pick<GitReviewDeps, 'resolveScope'> {
  return Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as Pick<GitReviewDeps, 'resolveScope'>).resolveScope === 'function';
}

export async function readReviewData(
  sessionId: string,
  optionsOrDeps: ReviewDiffReadOptions | GitReviewDeps = {},
  maybeDeps?: GitReviewDeps,
): Promise<ReviewData> {
  const deps = isGitReviewDeps(optionsOrDeps) ? optionsOrDeps : maybeDeps ?? defaultGitReviewDeps;
  const options = isGitReviewDeps(optionsOrDeps) ? {} : optionsOrDeps;
  const scope = await deps.resolveScope(sessionId);
  if (scope.disabledReason || !scope.repoRoot) {
    return {
      scope,
      status: null,
      diffs: { staged: [], unstaged: [], capped: { staged: null, unstaged: null } },
      summary: buildDirtySummary(sessionId, scope, null),
    };
  }
  const status = await deps.readStatus(scope);
  const diffs = await deps.readDiffs(status.scope, status, options);
  return {
    scope: status.scope,
    status,
    diffs,
    summary: buildDirtySummary(sessionId, status.scope, status),
  };
}

export async function readReviewSummary(sessionId: string, deps: Pick<GitReviewDeps, 'resolveScope' | 'readStatus'> = {
  resolveScope: resolveReviewScope,
  readStatus,
}): Promise<ReviewDirtySummary> {
  const scope = await deps.resolveScope(sessionId);
  if (scope.disabledReason || !scope.repoRoot) return buildDirtySummary(sessionId, scope, null);
  const status = await deps.readStatus(scope);
  return buildDirtySummary(sessionId, status.scope, status);
}

export async function readReviewCommits(sessionId: string, baseRef: string | null, deps: Pick<GitReviewDeps, 'resolveScope'> = {
  resolveScope: resolveReviewScope,
}): Promise<ReviewCommitListData> {
  const scope = await deps.resolveScope(sessionId);
  return listBranchCommits(scope, baseRef);
}

export async function readReviewCommitDiff(
  sessionId: string,
  oid: string,
  optionsOrDeps: ReviewDiffReadOptions | Pick<GitReviewDeps, 'resolveScope'> = {},
  maybeDeps?: Pick<GitReviewDeps, 'resolveScope'>,
): Promise<ReviewCommitDiffData> {
  const deps = isResolveScopeDeps(optionsOrDeps) ? optionsOrDeps : maybeDeps ?? { resolveScope: resolveReviewScope };
  const options = isResolveScopeDeps(optionsOrDeps) ? {} : optionsOrDeps;
  const scope = await deps.resolveScope(sessionId);
  if (scope.disabledReason || !scope.repoRoot) return { scope, commitOid: oid, diffs: [], capped: null };
  const { commitOid, diffs, capped } = await readCommitDiff(scope, oid, options);
  return { scope, commitOid, diffs, capped };
}

export async function readReviewBranchDiff(
  sessionId: string,
  baseRef: string | null,
  optionsOrDeps: ReviewDiffReadOptions | Pick<GitReviewDeps, 'resolveScope'> = {},
  maybeDeps?: Pick<GitReviewDeps, 'resolveScope'>,
): Promise<ReviewBranchDiffData> {
  const deps = isResolveScopeDeps(optionsOrDeps) ? optionsOrDeps : maybeDeps ?? { resolveScope: resolveReviewScope };
  const options = isResolveScopeDeps(optionsOrDeps) ? {} : optionsOrDeps;
  const scope = await deps.resolveScope(sessionId);
  if (scope.disabledReason || !scope.repoRoot) {
    return {
      scope,
      baseRef: null,
      baseOid: null,
      headOid: null,
      mergeBaseOid: null,
      candidates: [],
      diffs: [],
      capped: null,
      warning: null,
    };
  }
  return readBranchDiff(scope, baseRef, options);
}

export async function readReviewFileDiff(
  sessionId: string,
  request: ReviewFileDiffRequest,
  deps: GitReviewDeps = { resolveScope: resolveReviewScope, readStatus, readDiffs },
): Promise<ReviewFileDiffData> {
  const scope = await deps.resolveScope(sessionId);
  if (scope.disabledReason || !scope.repoRoot) return { scope, diff: null };
  if (request.source === 'staged' || request.source === 'unstaged') {
    const status = await deps.readStatus(scope);
    const diff = await readCappedFileDiff(status.scope, status, request.source, {
      path: request.path,
      oldPath: request.oldPath ?? null,
    }, request);
    return { scope: status.scope, diff };
  }
  if (request.source === 'commit') {
    if (!request.commitOid) throwIpcError('INVALID_PARAMS', 'commitOid is required for commit file diff');
    const { diff } = await readCommitFileDiff(scope, request.commitOid, {
      path: request.path,
      oldPath: request.oldPath ?? null,
    }, request);
    return { scope, diff };
  }
  if (request.source === 'branch') {
    const diff = await readBranchFileDiff(scope, request.branchBaseRef ?? null, {
      path: request.path,
      oldPath: request.oldPath ?? null,
    }, request);
    return { scope, diff };
  }
  throwIpcError('INVALID_PARAMS', 'source must be staged, unstaged, commit, or branch');
}

export async function openReviewFile(
  sessionId: string,
  gitPath: string,
  deps: Pick<GitReviewDeps, 'resolveScope'> = { resolveScope: resolveReviewScope },
  openPath: (filePath: string) => Promise<string> = shell.openPath,
): Promise<void> {
  const scope = await deps.resolveScope(sessionId);
  if (scope.disabledReason || !scope.repoRoot) {
    throwIpcError('PRECONDITION_FAILED', 'No git repository is available for this session');
  }
  let targetReal: string;
  try {
    targetReal = (await resolveRepoContainedRealPath(scope.repoRoot, gitPath)).targetReal;
  } catch (err) {
    if (err instanceof RepoContainedPathError) throwIpcError('PRECONDITION_FAILED', err.message);
    throw err;
  }
  const stat = await fs.stat(targetReal);
  if (!stat.isFile()) {
    throwIpcError('PRECONDITION_FAILED', 'Path is not a file');
  }
  const errMsg = await openPath(targetReal);
  if (errMsg) throwIpcError('INTERNAL', errMsg);
}

export async function readReviewImagePreview(
  sessionId: string,
  request: ReviewImagePreviewRequest,
  deps: Pick<GitReviewDeps, 'resolveScope'> = { resolveScope: resolveReviewScope },
): Promise<ReviewImagePreviewData> {
  const scope = await deps.resolveScope(sessionId);
  if (scope.disabledReason || !scope.repoRoot) {
    throwIpcError('PRECONDITION_FAILED', scope.disabledMessage ?? 'git review is unavailable');
  }
  return readImagePreview(scope, request);
}

export async function readReviewMarkdownPreview(
  sessionId: string,
  request: ReviewMarkdownPreviewRequest,
  deps: Pick<GitReviewDeps, 'resolveScope'> = { resolveScope: resolveReviewScope },
): Promise<ReviewMarkdownPreviewData> {
  const scope = await deps.resolveScope(sessionId);
  if (scope.disabledReason || !scope.repoRoot) {
    throwIpcError('PRECONDITION_FAILED', scope.disabledMessage ?? 'git review is unavailable');
  }
  return readMarkdownPreview(scope, request);
}

async function runQueuedWrite<T>(
  sessionId: string,
  deps: GitReviewDeps,
  task: () => Promise<T>,
): Promise<T> {
  await assertSessionWriteAllowed(sessionId, deps);
  const scope = await deps.resolveScope(sessionId);
  if (scope.disabledReason || !scope.repoRoot) {
    throwIpcError('PRECONDITION_FAILED', scope.disabledMessage ?? 'git review is unavailable');
  }
  return enqueueGitRepoWrite(scope.repoRoot, async () => {
    await assertSessionWriteAllowed(sessionId, deps);
    return task();
  });
}

async function assertSessionWriteAllowed(sessionId: string, deps: GitReviewDeps): Promise<void> {
  if (await deps.isSessionRunning?.(sessionId)) {
    throwIpcError('SESSION_RUNNING', 'agent is running; git write operations are temporarily unavailable');
  }
}

function mapWriteError(err: unknown): never {
  if (err instanceof GitReviewStageError || err instanceof GitReviewCommitError || err instanceof GitReviewPushError) {
    const message = messageWithDetails(err.message, err.stderr);
    if (err instanceof GitReviewStageError && err.kind === 'stale') {
      throwIpcError('STALE_DIFF', message);
    }
    if (err instanceof GitReviewPushError && err.kind === 'lease-expired') {
      throwIpcError('PUSH_LEASE_EXPIRED', message);
    }
    if (err instanceof GitReviewPushError && err.kind === 'no-remote') {
      throwIpcError('PUSH_NO_REMOTE', message);
    }
    throwIpcError('PRECONDITION_FAILED', message);
  }
  if (err instanceof Error && /\[(INVALID_PARAMS|PRECONDITION_FAILED|STALE_DIFF|PUSH_LEASE_EXPIRED|PUSH_NO_REMOTE|SESSION_RUNNING)\]/.test(err.message)) throw err;
  throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
}

function messageWithDetails(message: string, stderr?: string): string {
  const detail = stderr?.trim();
  if (!detail) return message;
  const trimmedMessage = message.trim();
  if (trimmedMessage.includes(detail) || detail.includes(trimmedMessage)) return message;
  return `${message}\n${detail}`;
}

export async function runReviewFileStageOperation(
  sessionId: string,
  action: ReviewStageAction,
  targets: ReviewFileTarget[],
  deps: GitReviewDeps = { resolveScope: resolveReviewScope, readStatus, readDiffs },
): Promise<ReviewStageOperationResult> {
  if (targets.length === 0) throwIpcError('INVALID_PARAMS', 'targets are required');
  try {
    return await runQueuedWrite(sessionId, deps, async () => {
      const scope = await deps.resolveScope(sessionId);
      const status = await deps.readStatus(scope);
      const operation = await applyFileBatch(status.scope, status, action, targets);
      const data = await readReviewData(sessionId, deps);
      return { data, operation };
    });
  } catch (err) {
    mapWriteError(err);
  }
}

export async function runReviewHunkStageOperation(
  sessionId: string,
  action: ReviewStageAction,
  diff: FileDiff,
  hunkIndex: number,
  options: ReviewDiffReadOptions = {},
  deps: GitReviewDeps = { resolveScope: resolveReviewScope, readStatus, readDiffs },
): Promise<ReviewStageOperationResult> {
  try {
    return await runQueuedWrite(sessionId, deps, async () => {
      const scope = await deps.resolveScope(sessionId);
      const status = await deps.readStatus(scope);
      const hunk = diff.hunks.find((item) => item.index === hunkIndex);
      if (!hunk) throwIpcError('INVALID_PARAMS', 'hunk not found');
      await applyHunkSelection(status.scope, status, action, diff, {
        lines: [{ hunkIndex, lineIndices: hunk.selectableLines }],
      }, options);
      const data = await readReviewData(sessionId, deps);
      return {
        data,
        operation: {
          action,
          succeeded: [diff.path],
          failed: [],
          partial: false,
        },
      };
    });
  } catch (err) {
    mapWriteError(err);
  }
}

export async function runReviewCommit(
  sessionId: string,
  message: string,
  includeUnstaged = false,
  deps: GitReviewDeps = { resolveScope: resolveReviewScope, readStatus, readDiffs },
): Promise<ReviewCommitResult> {
  try {
    return await runQueuedWrite(sessionId, deps, async () => {
      const scope = await deps.resolveScope(sessionId);
      const status = await deps.readStatus(scope);
      const commit = await commitStagedChanges(status.scope, status, message, { includeUnstaged });
      const data = await readReviewData(sessionId, deps);
      return { data, ...commit };
    });
  } catch (err) {
    mapWriteError(err);
  }
}

export async function runReviewPush(
  sessionId: string,
  confirmForce?: ReviewPushConfirmForce,
  deps: GitReviewDeps = { resolveScope: resolveReviewScope, readStatus, readDiffs },
): Promise<ReviewPushResult> {
  try {
    return await runQueuedWrite(sessionId, deps, async () => {
      const scope = await deps.resolveScope(sessionId);
      const status = await deps.readStatus(scope);
      const push = await pushBranch(status.scope, status, confirmForce);
      const data = await readReviewData(sessionId, deps);
      if (push.kind === 'needs-force') {
        return { data, ...push };
      }
      return { data, ...push, aheadBehind: data.scope.aheadBehind };
    });
  } catch (err) {
    mapWriteError(err);
  }
}

export function parseSessionId(payload: unknown): string {
  const obj = requireObject(payload);
  return requireString(obj.sessionId, 'sessionId');
}

function readOptionalBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throwIpcError('INVALID_PARAMS', `${key} must be a boolean`);
  return value;
}

function readDiffOptions(obj: Record<string, unknown>): ReviewDiffReadOptions {
  return { ignoreWhitespace: readOptionalBoolean(obj, 'ignoreWhitespace') === true };
}

export function parseReviewDataPayload(payload: unknown): { sessionId: string; options: ReviewDiffReadOptions } {
  const obj = requireObject(payload);
  return {
    sessionId: requireString(obj.sessionId, 'sessionId'),
    options: readDiffOptions(obj),
  };
}

export function parseCommitDiffPayload(payload: unknown): { sessionId: string; oid: string; options: ReviewDiffReadOptions } {
  const obj = requireObject(payload);
  const oid = requireString(obj.oid, 'oid');
  if (!isSafeGitObjectOid(oid)) throwIpcError('INVALID_PARAMS', 'oid must be a commit hash');
  return {
    sessionId: requireString(obj.sessionId, 'sessionId'),
    oid,
    options: readDiffOptions(obj),
  };
}

export function parseCommitsPayload(payload: unknown): { sessionId: string; baseRef: string | null } {
  const obj = requireObject(payload);
  const rawBaseRef = typeof obj.baseRef === 'string' && obj.baseRef.trim() ? obj.baseRef.trim() : null;
  if (rawBaseRef && !isSafeBranchBaseRef(rawBaseRef)) {
    throwIpcError('INVALID_PARAMS', 'baseRef is invalid');
  }
  return {
    sessionId: requireString(obj.sessionId, 'sessionId'),
    baseRef: rawBaseRef,
  };
}

export function parseBranchDiffPayload(payload: unknown): { sessionId: string; baseRef: string | null; options: ReviewDiffReadOptions } {
  const obj = requireObject(payload);
  const rawBaseRef = typeof obj.baseRef === 'string' && obj.baseRef.trim() ? obj.baseRef.trim() : null;
  if (rawBaseRef && !isSafeBranchBaseRef(rawBaseRef)) {
    throwIpcError('INVALID_PARAMS', 'baseRef is invalid');
  }
  return {
    sessionId: requireString(obj.sessionId, 'sessionId'),
    baseRef: rawBaseRef,
    options: readDiffOptions(obj),
  };
}

export function parseFileDiffPayload(payload: unknown): { sessionId: string; request: ReviewFileDiffRequest } {
  const obj = requireObject(payload);
  const source = obj.source === 'staged' || obj.source === 'unstaged' || obj.source === 'commit' || obj.source === 'branch'
    ? obj.source
    : throwIpcError('INVALID_PARAMS', 'source must be staged, unstaged, commit, or branch');
  const commitOid = typeof obj.commitOid === 'string' && obj.commitOid ? obj.commitOid : null;
  const branchBaseRef = typeof obj.branchBaseRef === 'string' && obj.branchBaseRef.trim() ? obj.branchBaseRef.trim() : null;
  if (source === 'commit') {
    if (!commitOid) throwIpcError('INVALID_PARAMS', 'commitOid is required for commit file diff');
    if (!isSafeGitObjectOid(commitOid)) throwIpcError('INVALID_PARAMS', 'commitOid must be a commit hash');
  }
  if (source === 'branch' && branchBaseRef && !isSafeBranchBaseRef(branchBaseRef)) {
    throwIpcError('INVALID_PARAMS', 'branchBaseRef is invalid');
  }
  return {
    sessionId: requireString(obj.sessionId, 'sessionId'),
    request: {
      source,
      path: requireSafeGitPath(obj.path, 'path'),
      oldPath: readOptionalSafeGitPath(obj.oldPath, 'oldPath'),
      commitOid,
      branchBaseRef,
      ...readDiffOptions(obj),
    },
  };
}

export function parseOpenFilePayload(payload: unknown): { sessionId: string; path: string } {
  const obj = requireObject(payload);
  return {
    sessionId: requireString(obj.sessionId, 'sessionId'),
    path: requireSafeGitPath(obj.path, 'path'),
  };
}

function parsePreviewDiffPayload(value: unknown): FileDiff {
  const diff = requireObject(value, 'diff') as unknown as FileDiff;
  if (diff.source !== 'staged' && diff.source !== 'unstaged' && diff.source !== 'commit' && diff.source !== 'branch') {
    throwIpcError('INVALID_PARAMS', 'diff.source must be staged, unstaged, commit, or branch');
  }
  if (typeof diff.id !== 'string' || !diff.id) throwIpcError('INVALID_PARAMS', 'diff.id is required');
  const pathValue = requireSafeGitPath(diff.path, 'diff.path');
  const oldPath = readOptionalSafeGitPath(diff.oldPath, 'diff.oldPath');
  const rawIndex = diff.index && typeof diff.index === 'object'
    ? diff.index as { oldOid?: unknown; newOid?: unknown }
    : {};
  return {
    ...diff,
    path: pathValue,
    oldPath,
    index: {
      oldOid: normalizeGitDiffIndexOid(rawIndex.oldOid),
      newOid: normalizeGitDiffIndexOid(rawIndex.newOid),
    },
  };
}

function parseWritableDiffPayload(value: unknown): FileDiff {
  const diff = parsePreviewDiffPayload(value);
  if (diff.source !== 'staged' && diff.source !== 'unstaged') {
    throwIpcError('INVALID_PARAMS', 'diff.source must be staged or unstaged');
  }
  return diff;
}

export function parseImagePreviewPayload(payload: unknown): { sessionId: string; request: ReviewImagePreviewRequest } {
  const obj = requireObject(payload);
  const diff = parsePreviewDiffPayload(obj.diff);
  const commitOid = typeof obj.commitOid === 'string' && obj.commitOid ? obj.commitOid : null;
  const branchBaseRef = typeof obj.branchBaseRef === 'string' && obj.branchBaseRef.trim() ? obj.branchBaseRef.trim() : null;
  if (commitOid && !isSafeGitObjectOid(commitOid)) throwIpcError('INVALID_PARAMS', 'commitOid must be a commit hash');
  if (diff.source === 'commit' && !commitOid) throwIpcError('INVALID_PARAMS', 'commitOid is required for commit image preview');
  if (diff.source === 'branch') {
    if (!branchBaseRef) throwIpcError('INVALID_PARAMS', 'branchBaseRef is required for branch image preview');
    if (!isSafeBranchBaseRef(branchBaseRef)) throwIpcError('INVALID_PARAMS', 'branchBaseRef is invalid');
  }
  return {
    sessionId: requireString(obj.sessionId, 'sessionId'),
    request: {
      diff,
      commitOid,
      branchBaseRef,
    },
  };
}

export function parseMarkdownPreviewPayload(payload: unknown): { sessionId: string; request: ReviewMarkdownPreviewRequest } {
  const obj = requireObject(payload);
  const diff = parsePreviewDiffPayload(obj.diff);
  const commitOid = typeof obj.commitOid === 'string' && obj.commitOid ? obj.commitOid : null;
  const branchBaseRef = typeof obj.branchBaseRef === 'string' && obj.branchBaseRef.trim() ? obj.branchBaseRef.trim() : null;
  if (commitOid && !isSafeGitObjectOid(commitOid)) throwIpcError('INVALID_PARAMS', 'commitOid must be a commit hash');
  if (diff.source === 'commit' && !commitOid) throwIpcError('INVALID_PARAMS', 'commitOid is required for markdown preview');
  if (diff.source === 'branch') {
    if (!branchBaseRef) throwIpcError('INVALID_PARAMS', 'branchBaseRef is required for markdown preview');
    if (!isSafeBranchBaseRef(branchBaseRef)) throwIpcError('INVALID_PARAMS', 'branchBaseRef is invalid');
  }
  return {
    sessionId: requireString(obj.sessionId, 'sessionId'),
    request: {
      diff,
      commitOid,
      branchBaseRef,
    },
  };
}

function requireSafeGitPath(value: unknown, name: string): string {
  const gitPath = requireString(value, name);
  if (!isSafeGitPath(gitPath)) throwIpcError('INVALID_PARAMS', `${name} is invalid`);
  return gitPath;
}

function readOptionalSafeGitPath(value: unknown, name: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throwIpcError('INVALID_PARAMS', `${name} must be a string`);
  if (!isSafeGitPath(value)) throwIpcError('INVALID_PARAMS', `${name} is invalid`);
  return value;
}

export function parseTarget(value: unknown): ReviewFileTarget {
  const obj = requireObject(value, 'target');
  const source = obj.source === 'staged' || obj.source === 'unstaged'
    ? obj.source
    : throwIpcError('INVALID_PARAMS', 'target.source must be staged or unstaged');
  return {
    path: requireSafeGitPath(obj.path, 'target.path'),
    oldPath: readOptionalSafeGitPath(obj.oldPath, 'target.oldPath'),
    source,
  };
}

function parseTargets(payload: unknown): { sessionId: string; targets: ReviewFileTarget[] } {
  const obj = requireObject(payload);
  const rawTargets = obj.targets;
  if (!Array.isArray(rawTargets)) throwIpcError('INVALID_PARAMS', 'targets must be an array');
  return {
    sessionId: requireString(obj.sessionId, 'sessionId'),
    targets: rawTargets.map(parseTarget),
  };
}

export function parseHunkPayload(payload: unknown): { sessionId: string; diff: FileDiff; hunkIndex: number; options: ReviewDiffReadOptions } {
  const obj = requireObject(payload);
  const diff = parseWritableDiffPayload(obj.diff);
  if (typeof obj.hunkIndex !== 'number' || !Number.isInteger(obj.hunkIndex) || obj.hunkIndex < 0) {
    throwIpcError('INVALID_PARAMS', 'hunkIndex must be a non-negative integer');
  }
  return {
    sessionId: requireString(obj.sessionId, 'sessionId'),
    diff,
    hunkIndex: obj.hunkIndex,
    options: readDiffOptions(obj),
  };
}

function parseCommitPayload(payload: unknown): { sessionId: string; message: string; includeUnstaged: boolean } {
  const obj = requireObject(payload);
  return {
    sessionId: requireString(obj.sessionId, 'sessionId'),
    message: requireString(obj.message, 'message'),
    includeUnstaged: obj.includeUnstaged === true,
  };
}

function parsePushPayload(payload: unknown): { sessionId: string; confirmForce?: ReviewPushConfirmForce } {
  const obj = requireObject(payload);
  let confirmForce: ReviewPushConfirmForce | undefined;
  if (obj.confirmForce !== undefined) {
    const rawConfirm = requireObject(obj.confirmForce, 'confirmForce');
    confirmForce = {
      remoteRef: requireString(rawConfirm.remoteRef, 'confirmForce.remoteRef'),
      expectedOid: requireString(rawConfirm.expectedOid, 'confirmForce.expectedOid'),
    };
  }
  return {
    sessionId: requireString(obj.sessionId, 'sessionId'),
    confirmForce,
  };
}

export function registerGitReviewIpc(options: GitReviewIpcOptions = {}): void {
  const writeDeps: GitReviewDeps = {
    ...defaultGitReviewDeps,
    isSessionRunning: options.isSessionRunning,
  };

  ipcMain.handle(GIT_REVIEW_INVOKE.GET, async (_event, payload: unknown) => {
    try {
      const { sessionId, options } = parseReviewDataPayload(payload);
      return await readReviewData(sessionId, options);
    } catch (err) {
      if (err instanceof Error && /\[INVALID_PARAMS\]/.test(err.message)) throw err;
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle(GIT_REVIEW_INVOKE.SUMMARY, async (_event, payload: unknown) => {
    try {
      return await readReviewSummary(parseSessionId(payload));
    } catch (err) {
      if (err instanceof Error && /\[INVALID_PARAMS\]/.test(err.message)) throw err;
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle(GIT_REVIEW_INVOKE.COMMITS, async (_event, payload: unknown) => {
    try {
      const { sessionId, baseRef } = parseCommitsPayload(payload);
      return await readReviewCommits(sessionId, baseRef);
    } catch (err) {
      if (err instanceof Error && /\[INVALID_PARAMS\]/.test(err.message)) throw err;
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle(GIT_REVIEW_INVOKE.COMMIT_DIFF, async (_event, payload: unknown) => {
    try {
      const { sessionId, oid, options } = parseCommitDiffPayload(payload);
      return await readReviewCommitDiff(sessionId, oid, options);
    } catch (err) {
      if (err instanceof Error && /\[INVALID_PARAMS\]/.test(err.message)) throw err;
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle(GIT_REVIEW_INVOKE.BRANCH_DIFF, async (_event, payload: unknown) => {
    try {
      const { sessionId, baseRef, options } = parseBranchDiffPayload(payload);
      return await readReviewBranchDiff(sessionId, baseRef, options);
    } catch (err) {
      if (err instanceof Error && /\[INVALID_PARAMS\]/.test(err.message)) throw err;
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle(GIT_REVIEW_INVOKE.FILE_DIFF, async (_event, payload: unknown) => {
    try {
      const { sessionId, request } = parseFileDiffPayload(payload);
      return await readReviewFileDiff(sessionId, request);
    } catch (err) {
      if (err instanceof Error && /\[(INVALID_PARAMS|PRECONDITION_FAILED)\]/.test(err.message)) throw err;
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle(GIT_REVIEW_INVOKE.IMAGE_PREVIEW, async (_event, payload: unknown) => {
    try {
      const { sessionId, request } = parseImagePreviewPayload(payload);
      return await readReviewImagePreview(sessionId, request);
    } catch (err) {
      if (err instanceof Error && /\[(INVALID_PARAMS|PRECONDITION_FAILED)\]/.test(err.message)) throw err;
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle(GIT_REVIEW_INVOKE.MARKDOWN_PREVIEW, async (_event, payload: unknown) => {
    try {
      const { sessionId, request } = parseMarkdownPreviewPayload(payload);
      return await readReviewMarkdownPreview(sessionId, request);
    } catch (err) {
      if (err instanceof Error && /\[(INVALID_PARAMS|PRECONDITION_FAILED)\]/.test(err.message)) throw err;
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle(GIT_REVIEW_INVOKE.OPEN_FILE, async (_event, payload: unknown) => {
    try {
      const { sessionId, path: gitPath } = parseOpenFilePayload(payload);
      await openReviewFile(sessionId, gitPath);
    } catch (err) {
      if (err instanceof Error && /\[(INVALID_PARAMS|PRECONDITION_FAILED|INTERNAL)\]/.test(err.message)) throw err;
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle(GIT_REVIEW_INVOKE.STAGE_FILE, async (_event, payload: unknown) => {
    const { sessionId, targets } = parseTargets(payload);
    return runReviewFileStageOperation(sessionId, 'stage', targets.slice(0, 1), writeDeps);
  });

  ipcMain.handle(GIT_REVIEW_INVOKE.UNSTAGE_FILE, async (_event, payload: unknown) => {
    const { sessionId, targets } = parseTargets(payload);
    return runReviewFileStageOperation(sessionId, 'unstage', targets.slice(0, 1), writeDeps);
  });

  ipcMain.handle(GIT_REVIEW_INVOKE.DISCARD_FILE, async (_event, payload: unknown) => {
    const { sessionId, targets } = parseTargets(payload);
    return runReviewFileStageOperation(sessionId, 'discard', targets.slice(0, 1), writeDeps);
  });

  ipcMain.handle(GIT_REVIEW_INVOKE.STAGE_ALL, async (_event, payload: unknown) => {
    const { sessionId, targets } = parseTargets(payload);
    return runReviewFileStageOperation(sessionId, 'stage', targets, writeDeps);
  });

  ipcMain.handle(GIT_REVIEW_INVOKE.UNSTAGE_ALL, async (_event, payload: unknown) => {
    const { sessionId, targets } = parseTargets(payload);
    return runReviewFileStageOperation(sessionId, 'unstage', targets, writeDeps);
  });

  ipcMain.handle(GIT_REVIEW_INVOKE.DISCARD_ALL, async (_event, payload: unknown) => {
    const { sessionId, targets } = parseTargets(payload);
    return runReviewFileStageOperation(sessionId, 'discard', targets, writeDeps);
  });

  ipcMain.handle(GIT_REVIEW_INVOKE.STAGE_HUNK, async (_event, payload: unknown) => {
    const { sessionId, diff, hunkIndex, options } = parseHunkPayload(payload);
    return runReviewHunkStageOperation(sessionId, 'stage', diff, hunkIndex, options, writeDeps);
  });

  ipcMain.handle(GIT_REVIEW_INVOKE.UNSTAGE_HUNK, async (_event, payload: unknown) => {
    const { sessionId, diff, hunkIndex, options } = parseHunkPayload(payload);
    return runReviewHunkStageOperation(sessionId, 'unstage', diff, hunkIndex, options, writeDeps);
  });

  ipcMain.handle(GIT_REVIEW_INVOKE.DISCARD_HUNK, async (_event, payload: unknown) => {
    const { sessionId, diff, hunkIndex, options } = parseHunkPayload(payload);
    return runReviewHunkStageOperation(sessionId, 'discard', diff, hunkIndex, options, writeDeps);
  });

  ipcMain.handle(GIT_REVIEW_INVOKE.COMMIT, async (_event, payload: unknown) => {
    const { sessionId, message, includeUnstaged } = parseCommitPayload(payload);
    return runReviewCommit(sessionId, message, includeUnstaged, writeDeps);
  });

  ipcMain.handle(GIT_REVIEW_INVOKE.PUSH, async (_event, payload: unknown) => {
    const { sessionId, confirmForce } = parsePushPayload(payload);
    return runReviewPush(sessionId, confirmForce, writeDeps);
  });
}
