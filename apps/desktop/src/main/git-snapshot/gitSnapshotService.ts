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
  type SnapshotIncludedFile,
  type SnapshotFileFilterOptions,
  type SnapshotSkippedFile,
} from './snapshotFileFilter';
import {
  buildCommitMessage,
  parseSnapshotCommit,
  type SnapshotKind,
  type SnapshotMeta,
} from './snapshotTrailers';

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
  | 'conflict';

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

/** One XDT savepoint parsed from the reachable Git history. */
export interface SnapshotEntry {
  commit: string;
  label: string;
  kind: SnapshotKind;
  sessionId: string;
  time: string;
  parentCount: number;
  anchor?: string;
  branch?: string;
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
      ...(parsed.anchor ? { anchor: parsed.anchor } : {}),
      ...(parsed.branch ? { branch: parsed.branch } : {}),
    });
  }
  return entries;
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
): Promise<StagedDiff> {
  const [diffStat, rawDiffText] = await Promise.all([
    safeGitStdoutForPathspecs(['diff', '--cached', '--stat'], repoPath, pathspecs, extraEnv),
    safeGitStdoutForPathspecs(['diff', '--cached'], repoPath, pathspecs, extraEnv),
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

function chunkPathspecArgs(pathspecs: readonly string[]): string[][] {
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

async function withPathspecFile<T>(
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
