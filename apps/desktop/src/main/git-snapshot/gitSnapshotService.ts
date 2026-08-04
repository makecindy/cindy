/**
 * git-snapshot: minimal snapshot creation kernel.
 *
 * This main-process module turns the current dirty worktree into a commit with
 * XDT trailer metadata. It intentionally does not know about UI, IPC,
 * coordinator scheduling, rollback, or agent lifecycles.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLogger } from '../logger';
import { gitExec, GitExecError } from '../worktree/gitExec';
import {
  buildSnapshotFilePlan,
  resolveSnapshotGitPath,
  type SnapshotIncludedFile,
  type SnapshotFileFilterOptions,
  type SnapshotSkippedFile,
} from './snapshotFileFilter';
import {
  buildCindyCommitMessage,
  buildCommitMessage,
  parseSnapshotCommit,
  type SnapshotKind,
  type SnapshotMeta,
  type SnapshotTrailerSource,
} from './snapshotTrailers';
import {
  InvalidSavepointSessionIdError,
  readSavepointTip,
  savepointRefForSession,
} from './savepointRefs';

const log = createLogger('git-snapshot');

const PATHSPEC_CHUNK_SIZE = 80;
const STAGED_DIFF_TEXT_MAX_BYTES = 16_000;
const DEFAULT_LIST_SNAPSHOTS_MAX_COUNT = 2_000;
const FIELD_SEP = '\x1f';
const RECORD_SEP = '\x1e';

const LISTABLE_SNAPSHOT_KINDS: ReadonlySet<SnapshotKind> = new Set([
  'before-edit',
  'after-edit',
  'manual',
  'pre-rollback',
  'rewind-blocked',
]);

/** Git states where snapshot commits must not run because commit may finish the operation. */
export type SnapshotBlockedGitStateReason =
  | 'merge'
  | 'rebase'
  | 'cherry-pick'
  | 'revert'
  | 'conflict'
  | 'status-overflow';

/** Details for a repository state that blocks automatic snapshot commits. */
export interface SnapshotBlockedGitState {
  reason: SnapshotBlockedGitStateReason;
  marker?: string;
  markerPath?: string;
  conflictedFiles?: SnapshotSkippedFile[];
}

/** A compact view of staged changes for callers that derive snapshot labels. */
export interface StagedDiff {
  /** `git diff --cached --stat` for the files included in this snapshot. */
  diffStat: string;
  /** `git diff --cached` body, truncated when it grows too large. */
  diffText: string;
}

/** Produces the final commit label after snapshot files have been staged. */
export type SnapshotLabelFactory = (diff: StagedDiff) => string | Promise<string>;

/** How createSnapshot handles files rejected by the safety filter. */
export type SnapshotUnsafeFilePolicy = 'skip' | 'fail' | 'include';

/** Input accepted by the minimal createSnapshot kernel. */
export interface CreateSnapshotInput {
  /** Commit label or a factory used after staging when diff context is needed. */
  label: string | SnapshotLabelFactory;
  /** XDT trailer metadata written to the commit message. */
  meta: SnapshotMeta;
  /** Optional commit author override; by default Git repo/global identity is used. */
  author?: { name: string; email: string };
  /** Creates a metadata commit even when there are no staged file changes. */
  allowEmpty?: boolean;
  /** Default `skip`; `fail` blocks the snapshot when any unsafe file is present. */
  unsafeFilePolicy?: SnapshotUnsafeFilePolicy;
  /** Optional safety filter limit overrides, mainly for tests and future settings. */
  fileFilter?: Partial<SnapshotFileFilterOptions>;
}

/** Input for metadata-only snapshot marker commits that never stage worktree files. */
export interface CreateSnapshotMarkerInput {
  /** Commit label. Marker commits never need diff-derived labels. */
  label: string;
  /** XDT trailer metadata written to the commit message. */
  meta: SnapshotMeta;
  /** Optional commit author override; by default Git repo/global identity is used. */
  author?: { name: string; email: string };
}

/** Full result for callers that need to surface skipped-file details. */
export interface CreateSnapshotDetailedResult {
  commit: string | null;
  includedFiles: string[];
  skippedFiles: SnapshotSkippedFile[];
}

/** One savepoint parsed from Git history (HEAD log for legacy, hidden ref chain for shadow). */
export interface SnapshotEntry {
  commit: string;
  label: string;
  kind: SnapshotKind;
  sessionId: string;
  time: string;
  parentCount: number;
  /** Trailer generation the savepoint was written with. */
  source: SnapshotTrailerSource;
  anchor?: string;
  branch?: string;
  /** Shadow after-edit only: the turn-start savepoint this delta is based on. */
  baselineCommit?: string;
  /** Shadow only: HEAD commit at savepoint time, for audit. */
  baseHead?: string;
}

/** Filters applied while reading XDT savepoints from Git history. */
export interface ListSnapshotsOptions {
  /** When provided, only savepoints owned by this session are returned. */
  sessionId?: string;
  /** Bounds Git history traversal/output for large repositories. */
  maxCount?: number;
}

/** Raised when the caller chooses `unsafeFilePolicy: 'fail'`. */
export class SnapshotUnsafeFilesError extends Error {
  constructor(readonly skippedFiles: readonly SnapshotSkippedFile[]) {
    super('snapshot contains files blocked by safety filter');
    this.name = 'SnapshotUnsafeFilesError';
  }
}

/** Raised when a merge/rebase/conflict state makes snapshot commits unsafe. */
export class SnapshotBlockedByGitStateError extends Error {
  constructor(readonly state: SnapshotBlockedGitState) {
    super(`snapshot blocked by in-progress git state: ${state.reason}`);
    this.name = 'SnapshotBlockedByGitStateError';
  }
}

/** Current HEAD commit hash. */
export async function getHead(repoPath: string): Promise<string> {
  const { stdout } = await gitExec(['rev-parse', 'HEAD'], repoPath);
  return stdout.trim();
}

/** Current branch name; detached HEAD falls back to `HEAD`. */
export async function getCurrentBranch(repoPath: string): Promise<string> {
  const { stdout } = await gitExec(['branch', '--show-current'], repoPath);
  return stdout.trim() || 'HEAD';
}

/** Creates a snapshot commit and returns its hash, or null when there is nothing safe to commit. */
export async function createSnapshot(
  repoPath: string,
  input: CreateSnapshotInput,
): Promise<string | null> {
  return (await createSnapshotDetailed(repoPath, input)).commit;
}

/** Creates an XDT metadata-only marker commit without staging worktree files. */
export async function createSnapshotMarker(
  repoPath: string,
  input: CreateSnapshotMarkerInput,
): Promise<string> {
  const blockedState = await detectBlockedGitState(repoPath);
  if (blockedState) {
    throw new SnapshotBlockedByGitStateError(blockedState);
  }

  return withTemporaryIndex(repoPath, async (extraEnv) => {
    const branch = input.meta.branch ?? (await getCurrentBranch(repoPath).catch(() => undefined));
    const message = buildCommitMessage(input.label, {
      ...input.meta,
      ...(branch ? { branch } : {}),
    });

    await withDisabledHooks((hooksPath) =>
      gitExec(
        [
          '-c',
          `core.hooksPath=${toGitConfigPath(hooksPath)}`,
          ...(input.author
            ? ['-c', `user.name=${input.author.name}`, '-c', `user.email=${input.author.email}`]
            : []),
          'commit',
          '--no-gpg-sign',
          '--allow-empty',
          '-m',
          message,
        ],
        repoPath,
        { extraEnv },
      ),
    );

    return getHead(repoPath);
  });
}

/** Creates a snapshot commit while preserving included/skipped file details. */
export async function createSnapshotDetailed(
  repoPath: string,
  input: CreateSnapshotInput,
): Promise<CreateSnapshotDetailedResult> {
  const blockedState = await detectBlockedGitState(repoPath);
  if (blockedState) {
    throw new SnapshotBlockedByGitStateError(blockedState);
  }

  const plan = await buildSnapshotFilePlan(repoPath, input.fileFilter);
  const skippedFiles = plan.skippedFiles;
  const conflictedFiles = skippedFiles.filter((file) => file.reason === 'conflict');
  if (conflictedFiles.length > 0) {
    throw new SnapshotBlockedByGitStateError({ reason: 'conflict', conflictedFiles });
  }

  const unsafeFilePolicy = input.unsafeFilePolicy ?? 'skip';
  if (unsafeFilePolicy === 'fail' && skippedFiles.length > 0) {
    throw new SnapshotUnsafeFilesError(skippedFiles);
  }

  const filesToCommit: SnapshotCommitFile[] =
    unsafeFilePolicy === 'include'
      ? [
          ...plan.includedFiles,
          ...skippedFiles.map((file) => ({
            path: file.path,
            ...(file.oldPath ? { oldPath: file.oldPath } : {}),
            pathsForPathspec: file.pathsForPathspec ?? [`:(literal)${file.path}`],
          })),
        ]
      : plan.includedFiles;
  const stagePathspecs = uniquePathspecs(filesToCommit.flatMap((file) => file.pathsForPathspec));
  const commitPathspecs = uniquePathspecs(filesToCommit.flatMap(commitPathspecsFor));
  const renameOldPaths = renameOldPathsToRemove(filesToCommit);

  const result = await withTemporaryIndex(repoPath, async (extraEnv) => {
    if (stagePathspecs.length > 0) {
      await withPathspecFile(stagePathspecs, (pathspecFile) =>
        gitExec(
          ['add', '-A', '--pathspec-from-file', pathspecFile, '--pathspec-file-nul'],
          repoPath,
          { extraEnv },
        ),
      );
    }
    await removeRenameOldPaths(repoPath, renameOldPaths, extraEnv);

    const hasIncludedChanges = await hasStagedChanges(repoPath, extraEnv);
    if (!hasIncludedChanges && !input.allowEmpty) {
      if (skippedFiles.length > 0) {
        log.info('[createSnapshot] all dirty files skipped by safety filter', {
          skipped: skippedFiles.length,
          reasons: summarizeSkippedReasons(skippedFiles),
        });
      } else {
        log.debug('[createSnapshot] no changes, skip');
      }
      return {
        commit: null,
        includedFiles: plan.includedFiles.map((file) => file.path),
        skippedFiles,
      };
    }

    const label =
      typeof input.label === 'function'
        ? await input.label(await collectStagedDiff(repoPath, commitPathspecs, extraEnv))
        : input.label;
    const branch = input.meta.branch ?? (await getCurrentBranch(repoPath).catch(() => undefined));
    const message = buildCommitMessage(label, {
      ...input.meta,
      ...(branch ? { branch } : {}),
    });

    await withDisabledHooks((hooksPath) =>
      gitExec(
        [
          '-c',
          `core.hooksPath=${toGitConfigPath(hooksPath)}`,
          ...(input.author
            ? ['-c', `user.name=${input.author.name}`, '-c', `user.email=${input.author.email}`]
            : []),
          'commit',
          '--no-gpg-sign',
          ...(input.allowEmpty ? ['--allow-empty'] : []),
          '-m',
          message,
        ],
        repoPath,
        { extraEnv },
      ),
    );

    const commit = await getHead(repoPath);
    await resetCommittedPaths(repoPath, commitPathspecs);
    if (skippedFiles.length > 0) {
      log.info('[createSnapshot] snapshot created with skipped files', {
        commit: commit.slice(0, 8),
        included: plan.includedFiles.length,
        skipped: skippedFiles.length,
        reasons: summarizeSkippedReasons(skippedFiles),
      });
    }
    return {
      commit,
      includedFiles: filesToCommit.map((file) => file.path),
      skippedFiles,
    };
  });
  return result;
}

/** Lists reachable XDT savepoints newest-first, ignoring rollback and non-XDT commits. */
export async function listSnapshots(
  repoPath: string,
  options: ListSnapshotsOptions = {},
): Promise<SnapshotEntry[]> {
  let stdout: string;
  try {
    const maxCount = normalizeListSnapshotsMaxCount(options.maxCount);
    ({ stdout } = await gitExec(
      [
        'log',
        `--max-count=${maxCount}`,
        `--format=%H${FIELD_SEP}%P${FIELD_SEP}%cI${FIELD_SEP}%B${RECORD_SEP}`,
      ],
      repoPath,
    ));
  } catch (err) {
    if (err instanceof GitExecError && isUnbornHeadError(err)) return [];
    throw err;
  }

  const entries: SnapshotEntry[] = [];
  for (const record of stdout.split(RECORD_SEP)) {
    const trimmed = record.replace(/^\s+/, '');
    if (!trimmed) continue;
    const [commit, parentsRaw, time, ...bodyParts] = trimmed.split(FIELD_SEP);
    if (!commit || !time) continue;
    const parsed = parseSnapshotCommit(bodyParts.join(FIELD_SEP));
    if (!parsed || !LISTABLE_SNAPSHOT_KINDS.has(parsed.kind)) continue;
    if (options.sessionId && parsed.sessionId !== options.sessionId) continue;
    const parents = parentsRaw.trim() ? parentsRaw.trim().split(/\s+/) : [];
    entries.push({
      commit: commit.trim(),
      label: parsed.label,
      kind: parsed.kind,
      sessionId: parsed.sessionId,
      time: time.trim(),
      parentCount: parents.length,
      source: parsed.source,
      ...(parsed.anchor ? { anchor: parsed.anchor } : {}),
      ...(parsed.branch ? { branch: parsed.branch } : {}),
    });
  }
  return entries;
}

/** Snapshot kinds that appear on a shadow savepoint chain and matter to readers. */
const SHADOW_LISTABLE_KINDS: ReadonlySet<SnapshotKind> = new Set([
  'turn-start',
  'after-edit',
  'pre-rollback',
  'rewind-blocked',
]);

/** Fixed identity for shadow savepoint commits so plumbing never depends on user git config. */
const SHADOW_IDENTITY_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Cindy',
  GIT_AUTHOR_EMAIL: 'savepoint@cindy.local',
  GIT_COMMITTER_NAME: 'Cindy',
  GIT_COMMITTER_EMAIL: 'savepoint@cindy.local',
};

/** Input for shadow savepoints written to the session's hidden ref chain. */
export interface CreateShadowSavepointInput {
  sessionId: string;
  /** Commit label or a factory used after staging when diff context is needed. */
  label: string | SnapshotLabelFactory;
  /** Trailer metadata; sessionId/branch/baseHead are filled in by the kernel. */
  meta: Omit<SnapshotMeta, 'sessionId' | 'branch' | 'baseHead'>;
  /**
   * Skip commit creation when the staged worktree tree equals this commit's
   * tree (used by after-edit against the turn-start baseline).
   */
  skipIfTreeEquals?: string;
  /** Optional safety filter limit overrides, mainly for tests. */
  fileFilter?: Partial<SnapshotFileFilterOptions>;
}

/**
 * Content-free lstat fingerprint of a safety-filtered path. ctime cannot be
 * set from userland (any write or utimes call bumps it) and the inode changes
 * on replace-by-rename, so mtime-preserving rewrites are still detected.
 */
export interface SkippedFileFingerprint {
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

/** Result of a shadow savepoint attempt. */
export interface ShadowSavepointResult {
  /** Created commit, or null when skipIfTreeEquals matched. */
  commit: string | null;
  /** Tree written from the current worktree state. */
  tree: string;
  includedFiles: string[];
  skippedFiles: SnapshotSkippedFile[];
  /**
   * lstat fingerprints (size + mtime + ctime + inode, never content) for
   * skipped paths that still exist as regular files. Turn-boundary readers
   * compare these to detect changes to files the snapshot is not allowed to
   * record.
   */
  skippedFingerprints: SkippedFileFingerprint[];
}

/**
 * Creates a shadow savepoint on refs/cindy/savepoints/<sessionId>.
 *
 * Uses plumbing only (temporary index + write-tree + commit-tree + update-ref),
 * so HEAD, the current branch, the user's index and the worktree are never
 * touched, and no git hooks run.
 */
export async function createShadowSavepoint(
  repoPath: string,
  input: CreateShadowSavepointInput,
): Promise<ShadowSavepointResult> {
  const blockedState = await detectBlockedGitState(repoPath);
  if (blockedState) {
    throw new SnapshotBlockedByGitStateError(blockedState);
  }

  const plan = await buildSnapshotFilePlan(repoPath, input.fileFilter);
  if (plan.statusTruncated) {
    // status 溢出时脏文件视图未知:空计划会拍出一个静默漏掉全部脏文件的
    // 基线/pre-rollback,读侧还会据此把未受保护的路径当成安全。失败关闭
    // (legacy 分支提交路径保留其历史上的静默降级行为,不受影响)。
    throw new SnapshotBlockedByGitStateError({ reason: 'status-overflow' });
  }
  const skippedFiles = plan.skippedFiles;
  const conflictedFiles = skippedFiles.filter((file) => file.reason === 'conflict');
  if (conflictedFiles.length > 0) {
    throw new SnapshotBlockedByGitStateError({ reason: 'conflict', conflictedFiles });
  }

  // `git add -- <path>` is fatal for a path that exists neither in the
  // worktree nor in the temporary index (seeded from HEAD) — e.g. a file the
  // user staged in their own index and then deleted from the worktree
  // (status `AD`). Partition by lstat: present paths (files, symlinks, or a
  // directory that replaced a file) go through `git add`, missing paths are
  // recorded as deletions via `update-index --force-remove`, which is a
  // silent no-op when the temporary index does not contain them either.
  // Same realpath fence as the restore side: a path whose real parent left
  // the repository (a parent segment became a symlink pointing outside) must
  // be treated as deleted — never handed to `git add`, which would either
  // refuse it or, worse, snapshot out-of-repo content.
  const skippedFingerprints = await collectSkippedFingerprints(repoPath, skippedFiles);

  const repoReal = await fs.realpath(repoPath);
  const presentFiles: SnapshotIncludedFile[] = [];
  const missingPaths: string[] = [];
  for (const file of plan.includedFiles) {
    const abs = resolveSnapshotGitPath(repoPath, file.path);
    if (!abs) continue;
    if (!(await pathExists(abs))) {
      missingPaths.push(file.path);
      continue;
    }
    const parentReal = await fs.realpath(path.dirname(abs)).catch(() => null);
    if (!parentReal || (parentReal !== repoReal && !parentReal.startsWith(repoReal + path.sep))) {
      missingPaths.push(file.path);
      continue;
    }
    presentFiles.push(file);
  }
  const stagePathspecs = uniquePathspecs(presentFiles.flatMap((file) => file.pathsForPathspec));
  const commitPathspecs = uniquePathspecs(plan.includedFiles.flatMap(commitPathspecsFor));
  const renameOldPaths = renameOldPathsToRemove(plan.includedFiles);

  return withTemporaryIndex(repoPath, async (extraEnv) => {
    if (stagePathspecs.length > 0) {
      await withPathspecFile(stagePathspecs, (pathspecFile) =>
        gitExec(
          ['add', '-A', '--pathspec-from-file', pathspecFile, '--pathspec-file-nul'],
          repoPath,
          { extraEnv },
        ),
      );
    }
    for (const chunk of chunkRawPaths(missingPaths)) {
      await gitExec(['update-index', '--force-remove', '--', ...chunk], repoPath, { extraEnv });
    }
    await removeRenameOldPaths(repoPath, renameOldPaths, extraEnv);

    const tree = (await gitExec(['write-tree'], repoPath, { extraEnv })).stdout.trim();

    if (input.skipIfTreeEquals) {
      const baselineTree = await resolveTreeOf(repoPath, input.skipIfTreeEquals);
      if (baselineTree && baselineTree === tree) {
        log.debug('[createShadowSavepoint] tree unchanged, skip', {
          sessionId: input.sessionId,
          baseline: input.skipIfTreeEquals.slice(0, 8),
        });
        return {
          commit: null,
          tree,
          includedFiles: plan.includedFiles.map((file) => file.path),
          skippedFiles,
          skippedFingerprints,
        };
      }
    }

    const label =
      typeof input.label === 'function'
        ? await input.label(
            // Diff against the turn baseline, not HEAD: the worktree stays
            // dirty across turns now, so a HEAD-based diff would describe the
            // cumulative session delta instead of this turn's changes.
            await collectStagedDiff(repoPath, commitPathspecs, extraEnv, input.skipIfTreeEquals),
          )
        : input.label;
    const [branch, baseHead, parent] = await Promise.all([
      getCurrentBranch(repoPath).catch(() => undefined),
      getHead(repoPath).catch(() => undefined),
      readSavepointTip(repoPath, input.sessionId),
    ]);
    const message = buildCindyCommitMessage(label, {
      ...input.meta,
      sessionId: input.sessionId,
      ...(branch ? { branch } : {}),
      ...(baseHead ? { baseHead } : {}),
    });

    const commit = await commitTreeToSavepointRef(repoPath, {
      sessionId: input.sessionId,
      tree,
      parent,
      message,
    });
    return {
      commit,
      tree,
      includedFiles: plan.includedFiles.map((file) => file.path),
      skippedFiles,
      skippedFingerprints,
    };
  });
}

/** lstat fingerprints (no content) for skipped paths that exist as files. */
async function collectSkippedFingerprints(
  repoPath: string,
  skippedFiles: readonly SnapshotSkippedFile[],
): Promise<SkippedFileFingerprint[]> {
  const out: SkippedFileFingerprint[] = [];
  for (const file of skippedFiles) {
    const abs = resolveSnapshotGitPath(repoPath, file.path);
    if (!abs) continue;
    const stats = await fs.lstat(abs).catch(() => null);
    if (!stats || stats.isDirectory()) continue;
    out.push({
      path: file.path,
      sizeBytes: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
      ino: stats.ino,
    });
  }
  return out;
}

/** Input for metadata-only shadow markers (gap / rollback records on the chain). */
export interface CreateShadowMarkerInput {
  sessionId: string;
  label: string;
  meta: Omit<SnapshotMeta, 'sessionId' | 'branch' | 'baseHead'>;
}

/**
 * Appends a metadata-only marker to the session's savepoint chain, reusing the
 * chain tip's tree. An empty chain gets a root marker with the empty tree —
 * a first-turn gap must survive later successful savepoints, otherwise the
 * planner would never see it and a rewind to the first message would silently
 * keep that turn's file changes.
 */
export async function createShadowMarker(
  repoPath: string,
  input: CreateShadowMarkerInput,
): Promise<string | null> {
  const parent = await readSavepointTip(repoPath, input.sessionId);
  const tree = parent ? await resolveTreeOf(repoPath, parent) : await writeEmptyTree(repoPath);
  if (!tree) {
    log.warn('[createShadowMarker] marker tree unresolved, marker skipped', {
      sessionId: input.sessionId,
    });
    return null;
  }
  const [branch, baseHead] = await Promise.all([
    getCurrentBranch(repoPath).catch(() => undefined),
    getHead(repoPath).catch(() => undefined),
  ]);
  const message = buildCindyCommitMessage(input.label, {
    ...input.meta,
    sessionId: input.sessionId,
    ...(branch ? { branch } : {}),
    ...(baseHead ? { baseHead } : {}),
  });
  return commitTreeToSavepointRef(repoPath, {
    sessionId: input.sessionId,
    tree,
    parent,
    message,
  });
}

/** Result of reading one session's shadow savepoint chain. */
export interface ListShadowSavepointsResult {
  /** Listable savepoints, newest first. */
  entries: SnapshotEntry[];
  /**
   * True when the chain holds more commits than the traversal window. Readers
   * must not treat the window as the full history (a rewind planned on a
   * truncated view would silently skip the truncated-away turns).
   */
  truncated: boolean;
}

/** Lists the session's shadow savepoint chain newest-first. Missing ref yields []. */
export async function listShadowSavepoints(
  repoPath: string,
  sessionId: string,
  options: { maxCount?: number } = {},
): Promise<ListShadowSavepointsResult> {
  let ref: string;
  try {
    ref = savepointRefForSession(sessionId);
  } catch (err) {
    if (err instanceof InvalidSavepointSessionIdError) return { entries: [], truncated: false };
    throw err;
  }

  const maxCount = normalizeListSnapshotsMaxCount(options.maxCount);
  let stdout: string;
  try {
    // Fetch one extra record purely to detect truncation.
    ({ stdout } = await gitExec(
      [
        'log',
        `--max-count=${maxCount + 1}`,
        `--format=%H${FIELD_SEP}%P${FIELD_SEP}%cI${FIELD_SEP}%B${RECORD_SEP}`,
        ref,
      ],
      repoPath,
    ));
  } catch (err) {
    if (err instanceof GitExecError && isUnbornHeadError(err)) {
      return { entries: [], truncated: false };
    }
    throw err;
  }

  const entries: SnapshotEntry[] = [];
  let rawRecordCount = 0;
  for (const record of stdout.split(RECORD_SEP)) {
    const trimmed = record.replace(/^\s+/, '');
    if (!trimmed) continue;
    rawRecordCount += 1;
    if (rawRecordCount > maxCount) break;
    const [commit, parentsRaw, time, ...bodyParts] = trimmed.split(FIELD_SEP);
    if (!commit || !time) continue;
    const parsed = parseSnapshotCommit(bodyParts.join(FIELD_SEP));
    if (!parsed || parsed.source !== 'cindy' || !SHADOW_LISTABLE_KINDS.has(parsed.kind)) continue;
    if (parsed.sessionId !== sessionId) continue;
    const parents = parentsRaw.trim() ? parentsRaw.trim().split(/\s+/) : [];
    entries.push({
      commit: commit.trim(),
      label: parsed.label,
      kind: parsed.kind,
      sessionId: parsed.sessionId,
      time: time.trim(),
      parentCount: parents.length,
      source: 'cindy',
      ...(parsed.anchor ? { anchor: parsed.anchor } : {}),
      ...(parsed.branch ? { branch: parsed.branch } : {}),
      ...(parsed.baselineCommit ? { baselineCommit: parsed.baselineCommit } : {}),
      ...(parsed.baseHead ? { baseHead: parsed.baseHead } : {}),
    });
  }
  return { entries, truncated: rawRecordCount > maxCount };
}

/**
 * Writes the current worktree state of the given repo-relative paths into a
 * tree object (used by restore preview and the restore executor). Paths are
 * literal file paths, not pathspecs. The dangling tree is gc-collectable.
 *
 * Uses update-index instead of `git add` because `git add -- <path>` is fatal
 * for a path that neither exists in the worktree nor in the index — exactly
 * the state of a file one turn created and a later turn deleted.
 */
export async function writeWorktreeTreeForPaths(
  repoPath: string,
  paths: readonly string[],
): Promise<string> {
  return withTemporaryIndex(repoPath, async (extraEnv) => {
    const repoReal = await fs.realpath(repoPath);
    const present: string[] = [];
    const absent: string[] = [];
    for (const rawPath of uniqueRawPaths(paths)) {
      const abs = resolveSnapshotGitPath(repoPath, rawPath);
      if (!abs) continue;
      // A directory means the *file* at this path is gone (e.g. a turn
      // replaced a file with a directory); update-index --add would be fatal
      // on it, and tree-wise the right record is "absent" — the directory's
      // children are their own paths in the affected set.
      const stats = await fs.lstat(abs).catch(() => null);
      if (!stats || stats.isDirectory()) {
        absent.push(rawPath);
        continue;
      }
      // A path whose real parent left the repository (a parent segment became
      // a symlink pointing outside) is also "absent" as a repo file:
      // update-index refuses paths beyond a symbolic link, and readers must
      // never act on out-of-repo content.
      const parentReal = await fs.realpath(path.dirname(abs)).catch(() => null);
      if (!parentReal || (parentReal !== repoReal && !parentReal.startsWith(repoReal + path.sep))) {
        absent.push(rawPath);
        continue;
      }
      present.push(rawPath);
    }
    // Removals first: file ↔ directory conversions leave a conflicting stale
    // entry in the HEAD-seeded index (e.g. blob `swap` vs `swap/child.txt`),
    // and update-index --add refuses D/F conflicts it did not clear itself.
    for (const chunk of chunkRawPaths(absent)) {
      await gitExec(['update-index', '--force-remove', '--', ...chunk], repoPath, { extraEnv });
    }
    for (const chunk of chunkRawPaths(present)) {
      await gitExec(['update-index', '--add', '--', ...chunk], repoPath, { extraEnv });
    }
    return (await gitExec(['write-tree'], repoPath, { extraEnv })).stdout.trim();
  });
}

/**
 * Returns the subset of the given repo paths whose *current* content the
 * snapshot safety filter excludes (sensitive / oversized / nested repo) and
 * which still exist as regular files. Readers use this to refuse building
 * worktree trees or restore plans over bytes the savepoint system is not
 * allowed to persist or protect. Returns null when the dirty-file view is
 * unknown (`git status` overflow) — callers must fail closed, not treat the
 * paths as protected.
 */
export async function listUnprotectedPaths(
  repoPath: string,
  paths: readonly string[],
): Promise<string[] | null> {
  if (paths.length === 0) return [];
  const plan = await buildSnapshotFilePlan(repoPath);
  if (plan.statusTruncated) return null;
  const skipped = new Set(plan.skippedFiles.map((file) => file.path));
  const out: string[] = [];
  for (const rawPath of uniqueRawPaths(paths)) {
    if (!skipped.has(rawPath)) continue;
    const abs = resolveSnapshotGitPath(repoPath, rawPath);
    if (!abs) continue;
    const stats = await fs.lstat(abs).catch(() => null);
    if (stats && !stats.isDirectory()) out.push(rawPath);
  }
  return out;
}

/** Writes (or reuses) the canonical empty tree object for root gap markers. */
async function writeEmptyTree(repoPath: string): Promise<string | null> {
  try {
    return await withTemporaryIndex(repoPath, async (extraEnv) => {
      await gitExec(['read-tree', '--empty'], repoPath, { extraEnv });
      return (await gitExec(['write-tree'], repoPath, { extraEnv })).stdout.trim();
    });
  } catch {
    return null;
  }
}

async function resolveTreeOf(repoPath: string, commitish: string): Promise<string | null> {
  try {
    const { stdout } = await gitExec(['rev-parse', `${commitish}^{tree}`], repoPath);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function commitTreeToSavepointRef(
  repoPath: string,
  input: { sessionId: string; tree: string; parent: string | null; message: string },
): Promise<string> {
  const { stdout } = await gitExec(
    [
      '-c',
      'commit.gpgsign=false',
      'commit-tree',
      input.tree,
      ...(input.parent ? ['-p', input.parent] : []),
      '-m',
      input.message,
    ],
    repoPath,
    { extraEnv: SHADOW_IDENTITY_ENV },
  );
  const commit = stdout.trim();
  // CAS on the chain tip: an empty old value means "must not exist yet".
  await gitExec(
    ['update-ref', savepointRefForSession(input.sessionId), commit, input.parent ?? ''],
    repoPath,
  );
  return commit;
}

function normalizeListSnapshotsMaxCount(maxCount: number | undefined): number {
  if (!Number.isFinite(maxCount) || maxCount === undefined || maxCount <= 0) {
    return DEFAULT_LIST_SNAPSHOTS_MAX_COUNT;
  }
  return Math.floor(maxCount);
}

async function collectStagedDiff(
  repoPath: string,
  pathspecs: readonly string[],
  extraEnv: Record<string, string>,
  diffBase?: string,
): Promise<StagedDiff> {
  const baseArgs = diffBase ? ['diff', '--cached', diffBase] : ['diff', '--cached'];
  const [diffStat, rawDiffText] = await Promise.all([
    safeGitStdoutForPathspecs([...baseArgs, '--stat'], repoPath, pathspecs, extraEnv),
    safeGitStdoutForPathspecs([...baseArgs], repoPath, pathspecs, extraEnv),
  ]);
  const diffText =
    rawDiffText.length > STAGED_DIFF_TEXT_MAX_BYTES
      ? `${rawDiffText.slice(0, STAGED_DIFF_TEXT_MAX_BYTES)}\n...[diff truncated]`
      : rawDiffText;
  return { diffStat, diffText };
}

async function safeGitStdout(
  args: readonly string[],
  repoPath: string,
  extraEnv: Record<string, string>,
): Promise<string> {
  try {
    const { stdout } = await gitExec(args, repoPath, { extraEnv });
    return stdout;
  } catch (err) {
    log.debug('[createSnapshot] git read failed, degrade to empty', {
      args: args.join(' '),
      error: err instanceof Error ? err.message : String(err),
    });
    return '';
  }
}

async function safeGitStdoutForPathspecs(
  baseArgs: readonly string[],
  repoPath: string,
  pathspecs: readonly string[],
  extraEnv: Record<string, string>,
): Promise<string> {
  const parts: string[] = [];
  for (const chunk of chunkPathspecArgs(pathspecs)) {
    const stdout = await safeGitStdout([...baseArgs, '--', ...chunk], repoPath, extraEnv);
    if (stdout) parts.push(stdout);
  }
  return parts.join('\n');
}

async function hasStagedChanges(
  repoPath: string,
  extraEnv: Record<string, string>,
): Promise<boolean> {
  try {
    await gitExec(['diff', '--cached', '--quiet'], repoPath, { extraEnv });
  } catch (err) {
    if (err instanceof GitExecError && err.exitCode === 1) return true;
    throw err;
  }
  return false;
}

type SnapshotCommitFile = SnapshotIncludedFile & { oldPath?: string };

const BLOCKED_GIT_STATE_MARKERS: readonly {
  reason: SnapshotBlockedGitStateReason;
  marker: string;
}[] = [
  { reason: 'merge', marker: 'MERGE_HEAD' },
  { reason: 'rebase', marker: 'rebase-merge' },
  { reason: 'rebase', marker: 'rebase-apply' },
  { reason: 'cherry-pick', marker: 'CHERRY_PICK_HEAD' },
  { reason: 'revert', marker: 'REVERT_HEAD' },
];

function commitPathspecsFor(file: SnapshotCommitFile): string[] {
  return file.oldPath
    ? [`:(literal)${file.oldPath}`, ...file.pathsForPathspec]
    : file.pathsForPathspec;
}

function renameOldPathsToRemove(files: readonly SnapshotCommitFile[]): string[] {
  const includedCurrentPaths = new Set(files.map((file) => file.path));
  return uniqueRawPaths(
    files.map((file) =>
      file.oldPath && !includedCurrentPaths.has(file.oldPath) ? file.oldPath : undefined,
    ),
  );
}

async function detectBlockedGitState(repoPath: string): Promise<SnapshotBlockedGitState | null> {
  for (const { reason, marker } of BLOCKED_GIT_STATE_MARKERS) {
    const markerPath = await resolveGitInternalPath(repoPath, marker);
    if (markerPath && (await pathExists(markerPath))) {
      return { reason, marker, markerPath };
    }
  }
  return null;
}

async function resolveGitInternalPath(repoPath: string, marker: string): Promise<string | null> {
  const { stdout } = await gitExec(['rev-parse', '--git-path', marker], repoPath);
  const gitPath = stdout.trim();
  if (!gitPath) return null;
  return path.isAbsolute(gitPath) ? gitPath : path.resolve(repoPath, gitPath);
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs.lstat(filePath).then(
    () => true,
    () => false,
  );
}

async function withTemporaryIndex<T>(
  repoPath: string,
  fn: (extraEnv: Record<string, string>) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xdt-snapshot-index-'));
  const extraEnv = { GIT_INDEX_FILE: path.join(dir, 'index') };
  try {
    await seedTemporaryIndex(repoPath, extraEnv);
    return await fn(extraEnv);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function seedTemporaryIndex(
  repoPath: string,
  extraEnv: Record<string, string>,
): Promise<void> {
  try {
    await gitExec(['read-tree', 'HEAD'], repoPath, { extraEnv });
  } catch (err) {
    if (err instanceof GitExecError && isUnbornHeadError(err)) return;
    throw err;
  }
}

async function withDisabledHooks<T>(fn: (hooksPath: string) => Promise<T>): Promise<T> {
  const hooksPath = await fs.mkdtemp(path.join(os.tmpdir(), 'xdt-snapshot-hooks-'));
  try {
    // `--no-verify` does not skip prepare-commit-msg; an empty hooksPath disables all hooks.
    return await fn(hooksPath);
  } finally {
    await fs.rm(hooksPath, { recursive: true, force: true });
  }
}

function toGitConfigPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function isUnbornHeadError(err: GitExecError): boolean {
  return /not a valid object name|unknown revision|ambiguous argument|bad revision/i.test(
    err.stderr,
  ) || /does not have any commits/i.test(err.stderr);
}

async function removeRenameOldPaths(
  repoPath: string,
  oldPaths: readonly string[],
  extraEnv: Record<string, string>,
): Promise<void> {
  for (const chunk of chunkRawPaths(oldPaths)) {
    await gitExec(['update-index', '--force-remove', '--', ...chunk], repoPath, { extraEnv });
  }
}

async function resetCommittedPaths(repoPath: string, pathspecs: readonly string[]): Promise<void> {
  for (const chunk of chunkPathspecArgs(pathspecs)) {
    await gitExec(['reset', '-q', '--', ...chunk], repoPath);
  }
}

/** Splits literal pathspecs into command-line sized chunks. */
export function chunkPathspecArgs(pathspecs: readonly string[]): string[][] {
  const unique = uniquePathspecs(pathspecs);
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += PATHSPEC_CHUNK_SIZE) {
    chunks.push(unique.slice(i, i + PATHSPEC_CHUNK_SIZE));
  }
  return chunks;
}

function uniquePathspecs(pathspecs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pathspec of pathspecs) {
    if (seen.has(pathspec)) continue;
    seen.add(pathspec);
    out.push(pathspec);
  }
  return out;
}

function chunkRawPaths(paths: readonly string[]): string[][] {
  const unique = uniqueRawPaths(paths);
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += PATHSPEC_CHUNK_SIZE) {
    chunks.push(unique.slice(i, i + PATHSPEC_CHUNK_SIZE));
  }
  return chunks;
}

function uniqueRawPaths(paths: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const rawPath of paths) {
    if (!rawPath || seen.has(rawPath)) continue;
    seen.add(rawPath);
    out.push(rawPath);
  }
  return out;
}

/** Writes NUL-separated pathspecs to a temp file for --pathspec-from-file. */
export async function withPathspecFile<T>(
  pathspecs: readonly string[],
  fn: (pathspecFile: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xdt-snapshot-pathspec-'));
  const file = path.join(dir, 'paths');
  await fs.writeFile(file, `${uniquePathspecs(pathspecs).join('\0')}\0`, 'utf8');
  try {
    return await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function summarizeSkippedReasons(
  skippedFiles: readonly SnapshotSkippedFile[],
): Record<string, number> {
  const reasons: Record<string, number> = {};
  for (const file of skippedFiles) {
    reasons[file.reason] = (reasons[file.reason] ?? 0) + 1;
  }
  return reasons;
}
